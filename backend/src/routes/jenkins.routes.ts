import '../config/env';
import { Router, Request, Response } from 'express';
import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import podDepsResolver from '../services/PodDependencyResolver';

const router = Router();
const execFileAsync = promisify(execFile);

const JENKINS_BASE_URL = (process.env.JENKINS_BASE_URL || 'http://10.1.3.177:8080').replace(/\/$/, '');
const DEFAULT_JOB_NAME = process.env.JENKINS_NN_JOB || 'nn';
const DEFAULT_QA_JOB_NAME = process.env.JENKINS_NN_QA_JOB || 'nn-auto-quality';
const DEFAULT_REPO_URL = process.env.JENKINS_NN_REPO_URL || 'http://git.leigod.top/nn_ios/nnios.git';
const DEPLOY_TARGETS = new Set(['Pgyer', 'TestFlight', 'AppStore']);
const QA_TEST_SUITES = new Set(['smoke', 'login', 'im', 'rtc', 'monkey', 'full']);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '..', 'nn-ios-platform-data');
const QUALITY_DEVICE_POOLS_CONFIG_PATH = path.join(DATA_DIR, 'quality-device-pools.json');
const LEGACY_SONIC_DEVICE_POOLS_CONFIG_PATH = path.join(DATA_DIR, 'sonic-device-pools.json');

const ENV_FILE_CANDIDATES = [
  path.resolve(process.cwd(), 'backend/.env'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../backend/.env'),
];

function readEnvFileValue(key: string): string {
  for (const envFile of ENV_FILE_CANDIDATES) {
    if (!fs.existsSync(envFile)) continue;
    const lines = fs.readFileSync(envFile, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const equalIndex = trimmed.indexOf('=');
      if (equalIndex <= 0) continue;
      if (trimmed.slice(0, equalIndex).trim() !== key) continue;
      return trimmed.slice(equalIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return '';
}

function getRuntimeEnv(key: string): string {
  return process.env[key] || readEnvFileValue(key);
}

function normalizeQualitySuite(value?: string) {
  const text = String(value || 'smoke').trim();
  const lower = text.toLowerCase();
  if (/monkey|随机|猴子/i.test(text)) return 'monkey';
  if (/冒烟|smoke/i.test(text)) return 'smoke';
  if (/登录|login/i.test(text)) return 'login';
  if (/^im$|im\s*基础/i.test(text)) return 'im';
  if (/^rtc$|rtc\s*基础/i.test(text)) return 'rtc';
  if (/全量|full/i.test(text)) return 'full';
  return lower;
}

function getSonicConfig() {
  const apiBase = (getRuntimeEnv('SONIC_API_BASE') || 'http://10.1.3.177:5173/sonic-api').replace(/\/$/, '');
  return {
    apiBase,
    webUrl: (getRuntimeEnv('SONIC_WEB_URL') || 'http://10.1.3.177:5173/sonic-admin').replace(/\/$/, ''),
    apiProxyTarget: (getRuntimeEnv('SONIC_API_PROXY_TARGET') || 'http://127.0.0.1:8094').replace(/\/$/, ''),
    webProxyTarget: (getRuntimeEnv('SONIC_WEB_PROXY_TARGET') || 'http://127.0.0.1:3002').replace(/\/$/, ''),
    token: getRuntimeEnv('SONIC_TOKEN') || '',
    projectId: getRuntimeEnv('SONIC_PROJECT_ID') || 'nn-ios',
    testPlanId: getRuntimeEnv('SONIC_TEST_PLAN_ID') || 'smoke',
  };
}

function getPlatformRootDir() {
  const configured = String(getRuntimeEnv('NN_IOS_PLATFORM_DIR') || '').trim();
  if (configured) return configured;

  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), '..'),
  ];
  const matched = candidates.find((candidate) => (
    fs.existsSync(path.join(candidate, 'scripts/sonic/ios-quality.sh'))
  ));
  return matched || process.cwd();
}

function getConnectionErrorMessage(error: any) {
  const code = error?.code ? ` ${error.code}` : '';
  return error?.message ? `${error.message}${code}` : '连接失败';
}

interface QualityDevicePool {
  label: string;
  value: string;
  description: string;
  deviceId?: string;
  groupId?: string;
}

const DEFAULT_QUALITY_DEVICE_POOLS: QualityDevicePool[] = [
  {
    label: 'iOS 默认设备池',
    value: 'ios-default',
    description: '打包机当前可用 USB iOS 真机，适合日常冒烟质检。',
  },
  {
    label: 'iPhone 新系统池',
    value: 'ios-latest',
    description: '较新 iOS 系统真机，适合新系统兼容性检查。',
  },
  {
    label: 'iPhone 兼容性池',
    value: 'ios-compat',
    description: '覆盖较旧机型或系统版本，适合发布前兼容性回归。',
  },
];

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

function normalizeQualityDevicePool(pool: any): QualityDevicePool | null {
  const label = String(pool?.label || '').trim();
  const value = String(pool?.value || '').trim();
  if (!label || !value) return null;
  return {
    label,
    value,
    description: String(pool?.description || '用于打包机本机 iOS 真机质检调度。').trim(),
    deviceId: pool?.deviceId ? String(pool.deviceId).trim() : undefined,
    groupId: pool?.groupId ? String(pool.groupId).trim() : undefined,
  };
}

function getQualityDevicePools() {
  try {
    const configPath = fs.existsSync(QUALITY_DEVICE_POOLS_CONFIG_PATH)
      ? QUALITY_DEVICE_POOLS_CONFIG_PATH
      : LEGACY_SONIC_DEVICE_POOLS_CONFIG_PATH;
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const savedPools = (Array.isArray(config?.devicePools) ? config.devicePools : [])
        .map(normalizeQualityDevicePool)
        .filter(Boolean) as QualityDevicePool[];
      if (savedPools.length > 0) {
        return savedPools;
      }
    }
  } catch {
    // 配置文件损坏时回退到环境变量或默认配置。
  }

  const raw = String(process.env.SONIC_DEVICE_POOLS_JSON || '').trim();
  if (!raw) return DEFAULT_QUALITY_DEVICE_POOLS;

  try {
    const parsed = JSON.parse(raw);
    const pools = (Array.isArray(parsed) ? parsed : [])
      .map(normalizeQualityDevicePool)
      .filter(Boolean) as QualityDevicePool[];
    return pools.length > 0 ? pools : DEFAULT_QUALITY_DEVICE_POOLS;
  } catch {
    return DEFAULT_QUALITY_DEVICE_POOLS;
  }
}

function findQualityDevicePool(value: string) {
  return getQualityDevicePools().find((pool) => pool.value === value);
}

function saveQualityDevicePools(pools: QualityDevicePool[]) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(QUALITY_DEVICE_POOLS_CONFIG_PATH, JSON.stringify({
    devicePools: pools,
    updatedAt: new Date().toISOString(),
  }, null, 2));
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

function buildJenkinsArtifactUrl(jobPath: string, buildNumber: number, relativePath: string) {
  const encodedPath = relativePath
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/artifact/${encodedPath}`;
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
  const plainConsoleText = consoleText.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  const appVersion =
    plainConsoleText.match(/ASC_VERSION\s*=\s*([0-9]+(?:\.[0-9]+)+)/)?.[1] ||
    plainConsoleText.match(/版本号[:：]\s*([0-9]+(?:\.[0-9]+)+)/)?.[1] ||
    plainConsoleText.match(/显示版本[:：]\s*([0-9]+(?:\.[0-9]+)+)/)?.[1] ||
    plainConsoleText.match(/MARKETING_VERSION:\s*[^→\n]*→\s*([0-9]+(?:\.[0-9]+)+)/)?.[1] ||
    '';
  const publishChannel = normalizeDeployTarget(
    plainConsoleText.match(/发布渠道[:：]\s*([^\n\r]+)/)?.[1],
  );
  const packageUrl =
    plainConsoleText.match(/蒲公英链接[:：]\s*(https?:\/\/\S+)/)?.[1] ||
    plainConsoleText.match(/蒲公英版本[:：].*?\((https?:\/\/[^)\s]+)/)?.[1] ||
    plainConsoleText.match(/build\s*\[[0-9]+\]\((https?:\/\/[^)\s]+)\)/i)?.[1] ||
    '';
  const installPackageUrl = (
    plainConsoleText.match(/IPA\s*构建成功[:：]\s*(\/[^\r\n]+?\.ipa)\b/i)?.[1] ||
    plainConsoleText.match(/Successfully exported and signed the ipa file:\s*\r?\n\s*(\/[^\r\n]+?\.ipa)\b/i)?.[1] ||
    plainConsoleText.match(/发现IPA文件[:：]\s*([^\r\n]+?\.ipa)\b/i)?.[1] ||
    plainConsoleText.match(/IPA文件[:：]\s*([^\r\n]+?\.ipa)\b/i)?.[1] ||
    ''
  ).trim();
  const buildNumber =
    plainConsoleText.match(/CHANNEL_BUILD_NUMBER\s*=\s*([0-9]+)/)?.[1] ||
    plainConsoleText.match(/渠道构建号[:：]\s*([0-9]+)/)?.[1] ||
    plainConsoleText.match(/(?:蒲公英|Pgyer|TestFlight|AppStore|苹果商店)\s*构建号[:：]\s*([0-9]+)/i)?.[1] ||
    plainConsoleText.match(/CURRENT_PROJECT_VERSION:\s*[^→\n]*→\s*([0-9]+)/)?.[1] ||
    (packageUrl ? plainConsoleText.match(/build\s*\[([0-9]+)\]\((https?:\/\/[^)\s]+)\)/i)?.[1] : '') ||
    '';
  const archivePath = (
    plainConsoleText.match(/-archivePath\s+(.+?\.xcarchive)/)?.[1] ||
    plainConsoleText.match(/archivePath\s+(.+?\.xcarchive)/)?.[1] ||
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
    installPackageUrl,
    channelQrUrl: publishChannel === 'Pgyer' ? packageUrl : '',
    xcarchivePath: archivePath,
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
      installPackageUrl: '',
      channelQrUrl: '',
      xcarchivePath: '',
      archiveUrl: '',
    };
  }
}

function parseQualityConsoleSummary(consoleText: string) {
  const plain = consoleText.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  const toNumber = (value?: string) => {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const sourceBuildNumber = plain.match(/源构建:\s*([^\n\r]+)/)?.[1]?.trim() || '';
  const branch = plain.match(/分支:\s*([^\n\r]+)/)?.[1]?.trim() || '';
  const commitHash = plain.match(/Commit:\s*([0-9a-f]{7,40})/i)?.[1]?.trim() || '';
  const appVersion = plain.match(/APP版本:\s*([^\n\r]+)/)?.[1]?.trim() || '';
  const testSuite = plain.match(/测试套件:\s*([^\n\r]+)/)?.[1]?.trim() || '';
  const devicePoolMatch = plain.match(/设备池:\s*([^\n\r]+)/)?.[1]?.trim() || '';
  const deviceUdid = plain.match(/使用设备:\s*([^\n\r]+)/)?.[1]?.trim() || '';
  const launchDurationMs = toNumber(plain.match(/启动命令耗时:\s*(\d+)ms/i)?.[1]);
  const coldStartReadyMs = toNumber(plain.match(/冷启动稳定耗时:\s*(\d+)ms/i)?.[1]);
  const coldStartWaitSeconds = toNumber(plain.match(/稳定等待\s*(\d+)s/i)?.[1]);
  const monkeyMatch = plain.match(/Monkey 结果:\s*([^，,\n\r]+)[，,]\s*执行\s*(\d+)\/(\d+)\s*次[，,]?\s*([^\n\r]*)/i);
  const bundleId = (
    plain.match(/启动 App:\s*([^\n\r]+)/)?.[1]?.trim() ||
    plain.match(/Launched application with\s+([^\s]+)\s+bundle identifier/i)?.[1]?.trim() ||
    ''
  );
  const message = plain.match(/ERROR:\s*([^\n\r]+)/)?.[1]?.trim() || (
    /Finished:\s+SUCCESS/.test(plain) ? '安装和启动成功' : ''
  );
  const status = /Finished:\s+SUCCESS/.test(plain)
    ? 'passed'
    : (/Finished:\s+FAILURE|ERROR:/i.test(plain) ? 'failed' : '');

  return {
    status,
    message,
    sourceBuildNumber,
    branch,
    commitHash,
    appVersion,
    testSuite,
    devicePool: '',
    devicePoolLabel: devicePoolMatch.replace(/\s*\([^)]+\)\s*$/, ''),
    deviceUdid,
    bundleId,
    launchMethod: /Launched application with/i.test(plain) ? 'devicectl' : '',
    launchDurationMs,
    coldStartReadyMs,
    coldStartWaitSeconds,
    monkeyStatus: monkeyMatch?.[1]?.trim() || '',
    monkeyExecutedEvents: toNumber(monkeyMatch?.[2]),
    monkeyEventCount: toNumber(monkeyMatch?.[3]),
    monkeyMessage: monkeyMatch?.[4]?.trim() || '',
  };
}

async function fetchQualityConsoleSummary(jobPath: string, buildNumber: number) {
  const response = await axios.get(`${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/consoleText`, {
    timeout: 10000,
    responseType: 'text',
    ...buildAuthConfig(),
  });
  return parseQualityConsoleSummary(String(response.data || ''));
}

async function fetchQualitySummary(jobPath: string, build: any) {
  const buildNumber = Number(build.number);
  const artifacts = Array.isArray(build.artifacts) ? build.artifacts : [];
  const summaryArtifact = artifacts.find((artifact: any) => String(artifact?.relativePath || '').endsWith('/summary.json'));
  let consoleSummary: any | null = null;

  if (summaryArtifact?.relativePath) {
    const summaryUrl = buildJenkinsArtifactUrl(jobPath, buildNumber, summaryArtifact.relativePath);
    try {
      try {
        consoleSummary = await fetchQualityConsoleSummary(jobPath, buildNumber);
      } catch {
        consoleSummary = null;
      }
      const response = await axios.get(summaryUrl, {
        timeout: 10000,
        responseType: 'json',
        ...buildAuthConfig(),
      });
      const summary = response.data || {};
      const summaryDir = path.posix.dirname(summaryArtifact.relativePath);
      const artifactRel = (name?: string) => (name ? path.posix.join(summaryDir, name) : '');
      const artifactUrl = (name?: string) => (name ? buildJenkinsArtifactUrl(jobPath, buildNumber, artifactRel(name)) : '');
      const mergedSummary = {
        ...(consoleSummary || {}),
        ...summary,
      };
      return {
        ...mergedSummary,
        artifacts: {
          summaryUrl,
          screenshotUrl: artifactUrl(summary.artifacts?.screenshot || 'screenshot.png'),
          deviceLogUrl: artifactUrl(summary.artifacts?.deviceLog || 'device.log'),
          processesUrl: artifactUrl(summary.artifacts?.processes || 'processes.json'),
          monkeyReportUrl: artifactUrl(summary.artifacts?.monkeyReport),
          junitUrl: artifactUrl(summary.artifacts?.junit || 'junit.xml'),
          qualityLogUrl: artifactUrl(summary.artifacts?.qualityLog || 'quality.log'),
        },
      };
    } catch {
      // summary artifact 读取失败时继续走 console 兜底。
    }
  }

  try {
    return {
      ...(consoleSummary || await fetchQualityConsoleSummary(jobPath, buildNumber)),
      artifacts: {},
    };
  } catch {
    return {
      status: build.result === 'SUCCESS' ? 'passed' : (build.result === 'FAILURE' ? 'failed' : ''),
      message: build.result === 'SUCCESS' ? '质检成功' : '',
      artifacts: {},
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

async function resolveChannelBuildNumber(
  publishChannel: string,
  currentBuildNumber: string,
  jenkinsBuildNumber: number,
) {
  const normalizedChannel = normalizeDeployTarget(publishChannel);
  const normalizedCurrent = String(currentBuildNumber || '').trim();
  if (normalizedChannel === 'Pgyer') {
    return normalizedCurrent;
  }
  if (normalizedChannel !== 'AppStore' && normalizedChannel !== 'TestFlight') {
    return normalizedCurrent === String(jenkinsBuildNumber) ? '' : normalizedCurrent;
  }

  return normalizedCurrent === String(jenkinsBuildNumber) ? '' : normalizedCurrent;
}

async function fetchJenkinsJobJson(jobPath: string, tree?: string) {
  const url = `${JENKINS_BASE_URL}/${jobPath}/api/json`;
  if (tree) {
    try {
      return await axios.get(url, {
        timeout: 30000,
        params: { tree },
        ...buildAuthConfig(),
      });
    } catch (error: any) {
      if (!error.response || error.response.status >= 500 || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
        return axios.get(url, {
          timeout: 30000,
          ...buildAuthConfig(),
        });
      }
      throw error;
    }
  }
  return axios.get(url, {
    timeout: 30000,
    ...buildAuthConfig(),
  });
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
    const response = await fetchJenkinsJobJson(jobPath, tree);

    const job = response.data || {};
    const rawBuilds = Array.isArray(job.builds) ? job.builds : [];
    const buildsWithMetadata = await Promise.all(rawBuilds.map(async (build: any) => {
      const descriptionMetadata = parseBuildDescription(build.description);
      const [consoleMetadata, buildParameters] = await Promise.all([
        fetchBuildConsoleMetadata(jobPath, build.number),
        fetchBuildParameters(jobPath, build.number),
      ]);
      const publishChannel = consoleMetadata.publishChannel || normalizeDeployTarget(descriptionMetadata.publishChannel);
      const appVersion = consoleMetadata.appVersion;
      const buildNumber = await resolveChannelBuildNumber(
        publishChannel,
        consoleMetadata.buildNumber || descriptionMetadata.buildNumber,
        build.number,
      );
      return {
        ...build,
        url: normalizeJenkinsUrl(build.url),
        branchName: buildParameters.branchName,
        publishChannel,
        commitHash: consoleMetadata.commitHash,
        buildNumber,
        appVersion,
        packageUrl: consoleMetadata.packageUrl,
        installPackageUrl: consoleMetadata.installPackageUrl,
        channelQrUrl: consoleMetadata.channelQrUrl,
        xcarchivePath: consoleMetadata.xcarchivePath,
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
      error: extractErrorMessage(error, '查询 Jenkins 构建列表失败'),
      status: error.response?.status,
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

router.get('/nn/quality/builds', async (_req: Request, res: Response) => {
  try {
    const jobPath = encodeJobPath(DEFAULT_QA_JOB_NAME);
    const tree = [
      'displayName',
      'fullName',
      'url',
      'buildable',
      'color',
      'lastBuild[number,result,timestamp,duration,building,url,description]',
      'builds[number,result,timestamp,duration,building,url,description,artifacts[fileName,relativePath]]{0,20}',
    ].join(',');
    const response = await fetchJenkinsJobJson(jobPath, tree);
    const job = response.data || {};
    const builds = await Promise.all((Array.isArray(job.builds) ? job.builds : []).map(async (build: any) => {
      const qualitySummary = await fetchQualitySummary(jobPath, build);
      return {
        ...build,
        url: normalizeJenkinsUrl(build.url),
        qualitySummary,
      };
    }));
    const running = builds.filter((build: any) => build.building).length;
    const success = builds.filter((build: any) => build.result === 'SUCCESS').length;
    const finished = builds.filter((build: any) => !build.building && build.result).length;

    res.json({
      success: true,
      data: {
        job: {
          name: job.displayName || DEFAULT_QA_JOB_NAME,
          fullName: job.fullName || DEFAULT_QA_JOB_NAME,
          url: normalizeJenkinsUrl(job.url) || `${JENKINS_BASE_URL}/${jobPath}/`,
          buildable: job.buildable !== false,
          color: job.color,
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
    if (error.response?.status === 404) {
      res.status(404).json({
        success: false,
        error: `未找到 Jenkins 自动质检 Job：${DEFAULT_QA_JOB_NAME}，请先在 Jenkins 中创建或通过 JENKINS_NN_QA_JOB 配置正确 Job 名称`,
        status: 404,
      });
      return;
    }
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '查询 Jenkins 自动质检列表失败'),
      status: error.response?.status,
    });
  }
});

router.get('/nn/quality/sonic/status', async (_req: Request, res: Response) => {
  const sonicConfig = getSonicConfig();
  const configured = Boolean(sonicConfig.apiBase);
  const status = {
    configured,
    apiBase: sonicConfig.apiBase || '',
    webUrl: sonicConfig.webUrl || '',
    apiProxyTarget: sonicConfig.apiProxyTarget || '',
    webProxyTarget: sonicConfig.webProxyTarget || '',
    tokenConfigured: Boolean(sonicConfig.token),
    projectId: sonicConfig.projectId || '',
    testPlanId: sonicConfig.testPlanId || '',
    reachable: false,
    message: configured
      ? (sonicConfig.token ? 'Sonic 已配置，等待连通性检测' : 'Sonic API 已配置，Token 未配置')
      : '未配置 SONIC_API_BASE',
  };

  if (!configured) {
    res.json({
      success: true,
      data: status,
    });
    return;
  }

  try {
    const apiTargetResponse = await axios.get(`${sonicConfig.apiProxyTarget}/`, {
      timeout: 5000,
      validateStatus: () => true,
    });
    const webTargetResponse = await axios.get(`${sonicConfig.webProxyTarget}/`, {
      timeout: 5000,
      validateStatus: () => true,
    });
    const response = await axios.get(`${sonicConfig.apiBase}/`, {
      timeout: 5000,
      headers: sonicConfig.token ? {
        Authorization: `Bearer ${sonicConfig.token}`,
      } : undefined,
      validateStatus: () => true,
    });
    res.json({
      success: true,
      data: {
        ...status,
        reachable: response.status >= 200 && response.status < 500,
        message: `Sonic API ${response.status}，代理目标 API ${apiTargetResponse.status}，Web ${webTargetResponse.status}`,
      },
    });
  } catch (error: any) {
    const targetMessage = getConnectionErrorMessage(error);
    res.json({
      success: true,
      data: {
        ...status,
        reachable: false,
        message: `Sonic 代理目标未启动或不可达：${targetMessage}。请确认 Sonic Server(API ${sonicConfig.apiProxyTarget}) 和 Sonic Web(${sonicConfig.webProxyTarget}) 已启动。`,
      },
    });
  }
});

router.get('/nn/quality/sonic/device-pools', async (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: getQualityDevicePools(),
  });
});

router.put('/nn/quality/sonic/device-pools', async (req: Request, res: Response) => {
  try {
    const pools = (Array.isArray(req.body?.devicePools) ? req.body.devicePools : [])
      .map(normalizeQualityDevicePool)
      .filter(Boolean) as QualityDevicePool[];

    if (pools.length === 0) {
      res.status(400).json({
        success: false,
        error: '至少需要配置一个质检设备池',
      });
      return;
    }

    const values = new Set<string>();
    for (const pool of pools) {
      if (values.has(pool.value)) {
        res.status(400).json({
          success: false,
          error: `设备池 value 重复：${pool.value}`,
        });
        return;
      }
      values.add(pool.value);
    }

    saveQualityDevicePools(pools);

    res.json({
      success: true,
      data: pools,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || '保存质检设备池失败',
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

router.post('/nn/quality', async (req: Request, res: Response) => {
  try {
    const jobPath = encodeJobPath(DEFAULT_QA_JOB_NAME);
    const sonicConfig = getSonicConfig();
    const buildNumber = String(req.body?.buildNumber || '').trim();
    const branch = normalizeBranchName(String(req.body?.branch || ''));
    const commitHash = String(req.body?.commitHash || '').trim();
    const appVersion = String(req.body?.appVersion || '').trim();
    const packageUrl = String(req.body?.packageUrl || '').trim();
    const xcarchivePath = String(req.body?.xcarchivePath || '').trim();
    const archiveUrl = String(req.body?.archiveUrl || '').trim();
    const rawTestSuite = String(req.body?.testSuite || 'smoke').trim();
    const testSuite = normalizeQualitySuite(rawTestSuite);
    const jenkinsTestSuite = testSuite === 'monkey' ? 'smoke' : testSuite;
    const devicePool = String(req.body?.devicePool || 'ios-default').trim();

    if (!buildNumber) {
      res.status(400).json({
        success: false,
        error: '请选择需要质检的构建',
      });
      return;
    }
    if (!QA_TEST_SUITES.has(testSuite)) {
      res.status(400).json({
        success: false,
        error: `质检套件无效：${rawTestSuite || '-'}，可选值：${Array.from(QA_TEST_SUITES).join(', ')}`,
      });
      return;
    }
    const selectedDevicePool = findQualityDevicePool(devicePool);
    if (!selectedDevicePool) {
      res.status(400).json({
        success: false,
        error: '设备池无效，请在平台质检设备池配置中选择',
      });
      return;
    }

    const devicePoolLabel = testSuite === 'monkey'
      ? `${selectedDevicePool.label} [suite:monkey]`
      : selectedDevicePool.label;
    const crumb = await getCrumb();
    const params = new URLSearchParams({
      SOURCE_JOB: DEFAULT_JOB_NAME,
      SOURCE_BUILD_NUMBER: buildNumber,
      BRANCH: branch,
      COMMIT_HASH: commitHash,
      APP_VERSION: appVersion,
      PACKAGE_URL: packageUrl,
      XCARCHIVE_PATH: xcarchivePath,
      ARCHIVE_URL: archiveUrl,
      TEST_SUITE: jenkinsTestSuite,
      REQUESTED_TEST_SUITE: testSuite,
      RUN_MONKEY: testSuite === 'monkey' ? '1' : '0',
      DEVICE_POOL: devicePool,
      DEVICE_POOL_LABEL: devicePoolLabel,
      DEVICE_UDID: selectedDevicePool.deviceId || selectedDevicePool.groupId || '',
      DEVICE_SELECTOR: selectedDevicePool.deviceId || selectedDevicePool.groupId || '',
      DEVICE_CLOUD: 'LocalMac',
      QUALITY_RUNNER: testSuite === 'monkey' ? 'local-ios-device-monkey' : 'local-ios-device',
      QA_RUNNER_MODE: testSuite === 'monkey' ? 'local-usb-monkey' : 'local-usb',
      APP_BUNDLE_ID: getRuntimeEnv('QA_APP_BUNDLE_ID') || 'com.nndev.im',
      WDA_URL: getRuntimeEnv('QA_WDA_URL') || 'http://127.0.0.1:8100',
      MONKEY_EVENT_COUNT: getRuntimeEnv('QA_MONKEY_EVENT_COUNT') || '30',
      MONKEY_INTERVAL_SECONDS: getRuntimeEnv('QA_MONKEY_INTERVAL_SECONDS') || '0.35',
      NN_IOS_PLATFORM_DIR: getPlatformRootDir(),
      // 兼容仍在使用旧 Jenkins 参数或 Sonic 任务脚本的环境。
      SONIC_DEVICE_GROUP_ID: selectedDevicePool.groupId || '',
      SONIC_API_BASE: sonicConfig.apiBase,
      SONIC_PROJECT_ID: sonicConfig.projectId,
      SONIC_TEST_PLAN_ID: sonicConfig.testPlanId,
    });

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
        jobName: DEFAULT_QA_JOB_NAME,
        sourceBuildNumber: buildNumber,
        testSuite,
        devicePool,
        url: `${JENKINS_BASE_URL}/${jobPath}/`,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '触发 Jenkins 自动质检失败'),
      status: error.response?.status,
    });
  }
});

export default router;
