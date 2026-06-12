import { Router, Request, Response } from 'express';
import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import podDepsResolver from '../services/PodDependencyResolver';

const router = Router();
const execFileAsync = promisify(execFile);

const JENKINS_BASE_URL = (process.env.JENKINS_BASE_URL || 'http://10.1.3.177:8080').replace(/\/$/, '');
const DEFAULT_JOB_NAME = process.env.JENKINS_NN_JOB || 'nn';
const DEFAULT_REPO_URL = process.env.JENKINS_NN_REPO_URL || 'http://git.leigod.top/nn_ios/nnios.git';
const DEPLOY_TARGETS = new Set(['Pgyer', 'TestFlight', 'AppStore']);

interface ThirdSdkDependency {
  name: string;
  version: string;
  source: string;
}

function encodeJobPath(jobName: string) {
  return jobName
    .split('/')
    .filter(Boolean)
    .map((part) => `job/${encodeURIComponent(part)}`)
    .join('/');
}

function buildAuthConfig() {
  const username = process.env.JENKINS_USER || '';
  const token = process.env.JENKINS_TOKEN || '';
  if (!username || !token) {
    return {};
  }
  return {
    auth: {
      username,
      password: token,
    },
  };
}

async function getCrumb() {
  try {
    const response = await axios.get(`${JENKINS_BASE_URL}/crumbIssuer/api/json`, {
      timeout: 10000,
      ...buildAuthConfig(),
    });
    if (response.data?.crumbRequestField && response.data?.crumb) {
      const cookie = (response.headers['set-cookie'] || [])
        .map((item: string) => item.split(';')[0])
        .filter(Boolean)
        .join('; ');
      return {
        headers: {
          [response.data.crumbRequestField]: response.data.crumb,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      };
    }
  } catch {
    // Jenkins 可能未启用 crumb issuer，触发构建时再按实际响应处理。
  }
  return { headers: {} };
}

function normalizeJenkinsUrl(url?: string) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    const base = new URL(JENKINS_BASE_URL);
    parsed.protocol = base.protocol;
    parsed.host = base.host;
    return parsed.toString();
  } catch {
    return url;
  }
}

function parseBuildDescription(description?: string | null) {
  const text = (description || '').trim();
  const match = text.match(/^([^,，]+)[,，]\s*(.+)$/);
  if (!match) {
    return {
      publishChannel: text || '',
      buildNumber: '',
    };
  }
  return {
    publishChannel: match[1].trim(),
    buildNumber: match[2].trim(),
  };
}

function normalizeDeployTarget(value?: string) {
  const text = (value || '').replace(/[,，]/g, '').trim();
  if (!text) return '';
  if (/pgyer|蒲公英/i.test(text)) return 'Pgyer';
  if (/test\s*flight/i.test(text)) return 'TestFlight';
  if (/app\s*store|苹果商店/i.test(text)) return 'AppStore';
  return text;
}

function isReleaseBranch(branch: string) {
  return /^(?:origin\/)?release\/\d+(?:\.\d+){2,}$/.test(branch.trim());
}

function normalizeBranchName(branch: string) {
  return branch.trim().replace(/^origin\//, '');
}

function toJenkinsBranch(branch: string) {
  const trimmed = branch.trim();
  if (!trimmed || trimmed.startsWith('origin/') || trimmed.startsWith('refs/')) {
    return trimmed;
  }
  return `origin/${trimmed}`;
}

function extractErrorMessage(error: any, fallback: string) {
  const data = error.response?.data;
  if (typeof data === 'string') {
    const text = data
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text || error.message || fallback;
  }
  return data?.message || data?.error || error.message || fallback;
}

function getGitCredentials() {
  return {
    username: process.env.GIT_USERNAME || undefined,
    password: process.env.GIT_PASSWORD || undefined,
  };
}

function parseConsoleMetadata(consoleText: string) {
  const appVersion =
    consoleText.match(/版本号[:：]\s*([0-9]+(?:\.[0-9]+)+)/)?.[1] ||
    consoleText.match(/显示版本[:：]\s*([0-9]+(?:\.[0-9]+)+)/)?.[1] ||
    consoleText.match(/MARKETING_VERSION:\s*[^→\n]*→\s*([0-9]+(?:\.[0-9]+)+)/)?.[1] ||
    '';
  const publishChannel = normalizeDeployTarget(
    consoleText.match(/发布渠道[:：]\s*([^\n\r]+)/)?.[1],
  );
  const buildNumber =
    consoleText.match(/build\s*\[?([0-9]+)\]?/i)?.[1] ||
    consoleText.match(/构建号[:：]\s*([0-9]+)/)?.[1] ||
    '';
  const packageUrl =
    consoleText.match(/蒲公英链接[:：]\s*(https?:\/\/\S+)/)?.[1] ||
    consoleText.match(/蒲公英版本[:：].*?\((https?:\/\/[^)\s]+)/)?.[1] ||
    consoleText.match(/build\s*\[[0-9]+\]\((https?:\/\/[^)\s]+)\)/i)?.[1] ||
    '';
  const archivePath = (
    consoleText.match(/-archivePath\s+(.+?\.xcarchive)/)?.[1] ||
    consoleText.match(/archivePath\s+(.+?\.xcarchive)/)?.[1] ||
    ''
  ).replace(/\\/g, '').trim();
  const archiveRelativePath = archivePath.match(/\/Archives\/(.+)$/)?.[1] || '';
  const archiveUrl = archiveRelativePath
    ? `smb://10.1.3.177/Archives/${encodeURI(archiveRelativePath)}`
    : '';

  return {
    appVersion,
    publishChannel,
    commitHash: parseCheckoutRevision(consoleText),
    buildNumber,
    packageUrl,
    channelQrUrl: publishChannel === 'Pgyer' ? packageUrl : '',
    archiveUrl,
  };
}

function parseCheckoutRevision(consoleText: string) {
  return (
    consoleText.match(/Checking out Revision\s+([0-9a-f]{7,40})/i)?.[1] ||
    consoleText.match(/git checkout -f\s+([0-9a-f]{7,40})/i)?.[1] ||
    consoleText.match(/git rev-list --no-walk\s+([0-9a-f]{7,40})/i)?.[1] ||
    ''
  );
}

async function fetchBuildConsoleMetadata(jobPath: string, buildNumber: number) {
  try {
    const response = await axios.get(`${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/consoleText`, {
      timeout: 15000,
      ...buildAuthConfig(),
    });
    return parseConsoleMetadata(String(response.data || ''));
  } catch {
    return {
      appVersion: '',
      publishChannel: '',
      commitHash: '',
      buildNumber: '',
      packageUrl: '',
      channelQrUrl: '',
      archiveUrl: '',
    };
  }
}

async function fetchThirdSdkDependencies(branch: string, revision?: string): Promise<{
  branch: string;
  revision?: string;
  dependencies: ThirdSdkDependency[];
  missingFiles: string[];
  error?: string;
}> {
  try {
    const normalizedBranch = normalizeBranchName(branch || 'develop') || 'develop';
    const normalizedRevision = revision && /^[0-9a-f]{7,40}$/i.test(revision) ? revision : undefined;
    const index = await podDepsResolver.loadNniosIndex(normalizedBranch, getGitCredentials(), undefined, normalizedRevision);
    const dependencies = index.sources
      .filter((item) => item.sourceFile === 'third_sdk.rb')
      .map((item) => ({
        name: item.podName,
        version: item.version || item.tag || item.branch || item.commit || item.pathRef || '-',
        source: item.raw,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      branch: index.branch,
      revision: normalizedRevision,
      dependencies,
      missingFiles: index.missingFiles.filter((file) => file === 'third_sdk.rb'),
    };
  } catch (error: any) {
    return {
      branch: normalizeBranchName(branch || 'develop') || 'develop',
      revision,
      dependencies: [],
      missingFiles: [],
      error: error.message || '读取 third_sdk.rb 失败',
    };
  }
}

async function fetchBuildParameters(jobPath: string, buildNumber: number) {
  try {
    const response = await axios.get(`${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/api/json`, {
      timeout: 10000,
      params: {
        tree: 'actions[parameters[name,value]]',
      },
      ...buildAuthConfig(),
    });
    const parameters = (response.data?.actions || [])
      .flatMap((action: any) => Array.isArray(action.parameters) ? action.parameters : []);
    const getParam = (name: string) => parameters.find((item: any) => item.name === name)?.value;
    return {
      branchName: String(getParam('branch') || '').replace(/^origin\//, ''),
    };
  } catch {
    return {
      branchName: '',
    };
  }
}

router.get('/nn/branches', async (_req: Request, res: Response) => {
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', DEFAULT_REPO_URL], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    const branches = stdout
      .split('\n')
      .map((line) => line.match(/refs\/heads\/(.+)$/)?.[1])
      .filter((branch): branch is string => Boolean(branch))
      .filter((branch) => !branch.includes('HEAD'))
      .sort((a, b) => {
        if (a === 'develop') return -1;
        if (b === 'develop') return 1;
        if (a.startsWith('release/') && !b.startsWith('release/')) return -1;
        if (!a.startsWith('release/') && b.startsWith('release/')) return 1;
        return b.localeCompare(a);
      });

    res.json({
      success: true,
      data: branches,
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: error.message || '查询 Jenkins 分支列表失败',
    });
  }
});

router.get('/nn/builds', async (req: Request, res: Response) => {
  try {
    const jobPath = encodeJobPath(DEFAULT_JOB_NAME);
    const deployTargetFilter = normalizeDeployTarget(String(req.query.deployTarget || ''));
    const tree = [
      'displayName',
      'fullName',
      'url',
      'buildable',
      'color',
      'lastBuild[number,result,timestamp,duration,building,url,description]',
      'builds[number,result,timestamp,duration,building,url,description]{0,30}',
    ].join(',');
    const response = await axios.get(`${JENKINS_BASE_URL}/${jobPath}/api/json`, {
      timeout: 30000,
      params: { tree },
      ...buildAuthConfig(),
    });

    const job = response.data || {};
    const rawBuilds = Array.isArray(job.builds) ? job.builds : [];
    const buildsWithMetadata = await Promise.all(rawBuilds.map(async (build: any) => {
      const descriptionMetadata = parseBuildDescription(build.description);
      const [consoleMetadata, buildParameters] = await Promise.all([
        fetchBuildConsoleMetadata(jobPath, build.number),
        fetchBuildParameters(jobPath, build.number),
      ]);
      return {
        ...build,
        url: normalizeJenkinsUrl(build.url),
        branchName: buildParameters.branchName,
        publishChannel: consoleMetadata.publishChannel || normalizeDeployTarget(descriptionMetadata.publishChannel),
        commitHash: consoleMetadata.commitHash,
        buildNumber: consoleMetadata.buildNumber || descriptionMetadata.buildNumber,
        appVersion: consoleMetadata.appVersion,
        packageUrl: consoleMetadata.packageUrl,
        channelQrUrl: consoleMetadata.channelQrUrl,
        archiveUrl: consoleMetadata.archiveUrl,
      };
    }));
    const builds = deployTargetFilter
      ? buildsWithMetadata.filter((build: any) => normalizeDeployTarget(build.publishChannel) === deployTargetFilter)
      : buildsWithMetadata;
    const running = builds.filter((build: any) => build.building).length;
    const success = builds.filter((build: any) => build.result === 'SUCCESS').length;
    const finished = builds.filter((build: any) => !build.building && build.result).length;
    const lastBuild = job.lastBuild
      ? {
          ...job.lastBuild,
          url: normalizeJenkinsUrl(job.lastBuild.url),
          ...parseBuildDescription(job.lastBuild.description),
        }
      : job.lastBuild;

    res.json({
      success: true,
      data: {
        job: {
          name: job.displayName || DEFAULT_JOB_NAME,
          fullName: job.fullName || DEFAULT_JOB_NAME,
          url: normalizeJenkinsUrl(job.url) || `${JENKINS_BASE_URL}/${jobPath}/`,
          buildable: job.buildable !== false,
          color: job.color,
          lastBuild,
        },
        stats: {
          total: builds.length,
          running,
          latestBuild: job.lastBuild?.number || '-',
          successRate: finished > 0 ? `${Math.round((success / finished) * 100)}%` : '-',
        },
        builds,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: error.response?.data?.message || error.message || '查询 Jenkins 构建列表失败',
    });
  }
});

router.get('/nn/builds/:number/log', async (req: Request, res: Response) => {
  try {
    const jobPath = encodeJobPath(DEFAULT_JOB_NAME);
    const buildNumber = Number(req.params.number);
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) {
      res.status(400).json({
        success: false,
        error: '构建号无效',
      });
      return;
    }

    const response = await axios.get(`${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/consoleText`, {
      timeout: 30000,
      responseType: 'text',
      ...buildAuthConfig(),
    });
    const log = String(response.data || '');
    const buildParameters = await fetchBuildParameters(jobPath, buildNumber);
    const checkoutRevision = parseCheckoutRevision(log);
    const thirdSdk = await fetchThirdSdkDependencies(buildParameters.branchName || 'develop', checkoutRevision);

    res.json({
      success: true,
      data: {
        jobName: DEFAULT_JOB_NAME,
        buildNumber,
        log,
        thirdSdkBranch: thirdSdk.branch,
        thirdSdkRevision: thirdSdk.revision,
        thirdSdkDependencies: thirdSdk.dependencies,
        thirdSdkMissingFiles: thirdSdk.missingFiles,
        thirdSdkError: thirdSdk.error,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '获取 Jenkins 打包日志失败'),
      status: error.response?.status,
    });
  }
});

router.post('/nn/build', async (req: Request, res: Response) => {
  try {
    const jobPath = encodeJobPath(DEFAULT_JOB_NAME);
    const deployTarget = String(req.body?.deployTarget || 'Pgyer');
    const verificationPassword = String(req.body?.verificationPassword || '');
    const branch = normalizeBranchName(String(req.body?.branch || 'develop'));
    const jenkinsBranch = toJenkinsBranch(branch);

    if (!DEPLOY_TARGETS.has(deployTarget)) {
      res.status(400).json({
        success: false,
        error: '发布渠道无效',
      });
      return;
    }
    if (deployTarget !== 'Pgyer' && !isReleaseBranch(branch)) {
      res.status(400).json({
        success: false,
        error: 'TestFlight / 苹果商店只能选择 release/x.x.x 格式分支',
      });
      return;
    }
    if (deployTarget !== 'Pgyer' && !verificationPassword.trim()) {
      res.status(400).json({
        success: false,
        error: 'TestFlight / 苹果商店发布需要填写验证密码',
      });
      return;
    }

    const crumb = await getCrumb();
    const params = new URLSearchParams({
      branch,
      DEPLOY_TARGET: deployTarget,
      VERIFICATION_PASSWORD: verificationPassword,
      NOTIFY_WECHAT_ON_SUCCESS: 'true',
      FORCE_PRIVATE_POD_UPDATE: 'false',
    });
    params.set('branch', jenkinsBranch);

    await axios.post(`${JENKINS_BASE_URL}/${jobPath}/buildWithParameters`, params.toString(), {
      timeout: 30000,
      headers: {
        ...crumb.headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      ...buildAuthConfig(),
    });

    res.json({
      success: true,
      data: {
        jobName: DEFAULT_JOB_NAME,
        deployTarget,
        branch,
        jenkinsBranch,
        url: `${JENKINS_BASE_URL}/${jobPath}/`,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '触发 Jenkins 发布失败'),
      status: error.response?.status,
    });
  }
});

router.post('/nn/builds/:number/stop', async (req: Request, res: Response) => {
  try {
    const jobPath = encodeJobPath(DEFAULT_JOB_NAME);
    const buildNumber = Number(req.params.number);
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) {
      res.status(400).json({
        success: false,
        error: '构建号无效',
      });
      return;
    }

    const crumb = await getCrumb();
    await axios.post(`${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/stop`, null, {
      timeout: 30000,
      headers: {
        ...crumb.headers,
      },
      ...buildAuthConfig(),
    });

    res.json({
      success: true,
      data: {
        jobName: DEFAULT_JOB_NAME,
        buildNumber,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '取消 Jenkins 构建失败'),
      status: error.response?.status,
    });
  }
});

export default router;
