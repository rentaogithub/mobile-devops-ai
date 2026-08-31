import axios from 'axios';
import { randomUUID } from 'crypto';
import { getJenkinsBaseUrl } from '../config/externalServices';
import aiAnalysisService from './AIAnalysisService';
import { qualityGateService } from './QualityGateService';
import { workflowIntegrationService } from './WorkflowIntegrationService';
import { workflowService } from './WorkflowService';

function encodeJobPath(jobName: string) {
  return jobName.split('/').filter(Boolean).map((part) => `job/${encodeURIComponent(part)}`).join('/');
}

function normalizeBranchName(branch: string) {
  return String(branch || '').trim().replace(/^origin\//, '');
}

function toJenkinsBranch(branch: string) {
  const trimmed = String(branch || '').trim();
  if (!trimmed || trimmed.startsWith('origin/') || trimmed.startsWith('refs/')) return trimmed;
  return `origin/${trimmed}`;
}

function isReleaseBranch(branch: string) {
  return /^(?:origin\/)?release\/\d+(?:\.\d+){2,}$/.test(String(branch || '').trim());
}

function normalizeReleaseNotes(value?: string) {
  return String(value || '').trim();
}

function normalizeQualitySuite(value: string) {
  const text = String(value || 'smoke').trim();
  if (/monkey|随机|猴子/i.test(text)) return 'monkey';
  if (/卡顿|stutter|hitch|jank/i.test(text)) return 'stutter';
  if (/business[_-]?flow|业务.*编排|自定义.*质检|自定义.*测试/i.test(text)) return 'business_flow';
  if (/冒烟|smoke/i.test(text)) return 'smoke';
  if (/^im$|im\s*基础/i.test(text)) return 'im';
  if (/^rtc$|rtc\s*基础/i.test(text)) return 'rtc';
  if (/全量|full/i.test(text)) return 'full';
  return text.toLowerCase();
}

function requiredReleaseGateSuites() {
  return String(process.env.RELEASE_GATE_REQUIRED_SUITES || 'smoke')
    .split(',')
    .map((item) => normalizeQualitySuite(item))
    .filter(Boolean);
}

function normalizeDeployTarget(value?: string) {
  const text = String(value || '').replace(/[,，]/g, '').trim();
  if (/pgyer|蒲公英/i.test(text)) return 'Pgyer';
  if (/test\s*flight/i.test(text)) return 'TestFlight';
  if (/app\s*store|苹果商店/i.test(text)) return 'AppStore';
  return text;
}

function parseConsoleMetadata(consoleText: string) {
  const plain = String(consoleText || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  const appVersion =
    plain.match(/ASC_VERSION\s*=\s*([0-9]+(?:\.[0-9]+)+)/)?.[1] ||
    plain.match(/APP版本信息[:：]?[\s\S]{0,160}(?:^|\n)\s*版本号[:：]\s*([0-9]+(?:\.[0-9]+)+)/m)?.[1] ||
    plain.match(/(?:^|\n)\s*显示版本[:：]\s*([0-9]+(?:\.[0-9]+)+)/m)?.[1] ||
    plain.match(/(?:^|\n)\s*版本号[:：]\s*([0-9]+(?:\.[0-9]+)+)/m)?.[1] ||
    plain.match(/MARKETING_VERSION:\s*[^→\n]*→\s*([0-9]+(?:\.[0-9]+)+)/)?.[1] ||
    '';
  const commitHash =
    plain.match(/最终源码Commit[:：]\s*([0-9a-f]{7,40})/i)?.[1] ||
    plain.match(/"source_synced_commit"\s*:\s*"([0-9a-f]{7,40})"/i)?.[1] ||
    plain.match(/"source_remote_commit"\s*:\s*"([0-9a-f]{7,40})"/i)?.[1] ||
    plain.match(/Checking out Revision\s+([0-9a-f]{7,40})/i)?.[1] ||
    plain.match(/git checkout -f\s+([0-9a-f]{7,40})/i)?.[1] ||
    plain.match(/git rev-list --no-walk\s+([0-9a-f]{7,40})/i)?.[1] ||
    '';
  const publishChannel = normalizeDeployTarget(plain.match(/发布渠道[:：]\s*([^\n\r]+)/)?.[1]);
  const packageUrl =
    plain.match(/蒲公英链接[:：]\s*(https?:\/\/\S+)/)?.[1] ||
    plain.match(/蒲公英版本[:：].*?\((https?:\/\/[^)\s]+)/)?.[1] ||
    plain.match(/build\s*\[[0-9]+\]\((https?:\/\/[^)\s]+)\)/i)?.[1] ||
    '';
  return { appVersion, commitHash, publishChannel, packageUrl };
}

export class JenkinsReleaseError extends Error {
  constructor(message: string, public readonly statusCode = 409, public readonly data?: unknown) {
    super(message);
    this.name = 'JenkinsReleaseError';
  }
}

export class JenkinsAssistantService {
  private readonly baseUrl = getJenkinsBaseUrl().replace(/\/$/, '');
  private readonly jobName = process.env.JENKINS_NN_JOB || 'nn';
  private readonly qualityJobName = process.env.JENKINS_NN_QA_JOB || 'nn-auto-quality';

  private authConfig() {
    const username = process.env.JENKINS_USER || '';
    const token = process.env.JENKINS_TOKEN || '';
    return username && token ? { auth: { username, password: token } } : {};
  }

  private async crumbHeaders() {
    try {
      const response = await axios.get(`${this.baseUrl}/crumbIssuer/api/json`, { timeout: 10_000, ...this.authConfig() });
      if (response.data?.crumbRequestField && response.data?.crumb) {
        const cookie = (response.headers['set-cookie'] || [])
          .map((item: string) => item.split(';')[0])
          .filter(Boolean)
          .join('; ');
        return {
          [response.data.crumbRequestField]: response.data.crumb,
          ...(cookie ? { Cookie: cookie } : {}),
        };
      }
    } catch {
      // Jenkins may have CSRF crumbs disabled.
    }
    return {};
  }

  private async buildConsoleMetadata(jobPath: string, buildNumber: number) {
    // 构建列表需要从控制台日志补充蒲公英安装地址和版本元数据。
    try {
      const response = await axios.get(`${this.baseUrl}/${jobPath}/${buildNumber}/consoleText`, {
        timeout: 8_000,
        responseType: 'text',
        ...this.authConfig(),
      });
      return parseConsoleMetadata(String(response.data || ''));
    } catch {
      return parseConsoleMetadata('');
    }
  }

  async listBuilds(limit = 10, quality = false) {
    const jobName = quality ? this.qualityJobName : this.jobName;
    const jobPath = encodeJobPath(jobName);
    const tree = `builds[number,result,building,timestamp,duration,url,displayName,description,actions[parameters[name,value]]]{0,${Math.min(Math.max(limit, 1), 30)}}`;
    const response = await axios.get(`${this.baseUrl}/${jobPath}/api/json`, {
      params: { tree }, timeout: 20_000, ...this.authConfig(),
    });
    return Promise.all((response.data?.builds || []).map(async (build: any) => {
      const parameters = (build.actions || []).flatMap((action: any) => action.parameters || []);
      const parameter = (name: string) => parameters.find((item: any) => item.name === name)?.value;
      const metadata = quality ? parseConsoleMetadata('') : await this.buildConsoleMetadata(jobPath, Number(build.number));
      const deployTarget = normalizeDeployTarget(String(parameter('DEPLOY_TARGET') || metadata.publishChannel || ''));
      return {
        number: build.number,
        result: build.result,
        building: Boolean(build.building),
        branchName: normalizeBranchName(String(parameter('branch') || parameter('BRANCH') || '')),
        deployTarget,
        suite: String(parameter('TEST_SUITE') || parameter('REQUESTED_TEST_SUITE') || ''),
        sourceBuildNumber: parameter('SOURCE_BUILD_NUMBER') || undefined,
        appVersion: metadata.appVersion || undefined,
        commitHash: metadata.commitHash || undefined,
        packageUrl: metadata.packageUrl || undefined,
        channelQrUrl: deployTarget === 'Pgyer' ? metadata.packageUrl || undefined : undefined,
        timestamp: build.timestamp,
        duration: build.duration,
        url: build.url,
        displayName: build.displayName,
        description: build.description,
      };
    }));
  }

  async getBuildLog(buildNumber: number, quality = false) {
    const jobName = quality ? this.qualityJobName : this.jobName;
    const response = await axios.get(`${this.baseUrl}/${encodeJobPath(jobName)}/${buildNumber}/consoleText`, {
      timeout: 30_000,
      responseType: 'text',
      ...this.authConfig(),
    });
    const log = String(response.data || '');
    return { buildNumber, quality, truncated: log.length > 20_000, log: log.slice(-20_000) };
  }

  async getBuildSnapshot(buildNumber: number, quality = false) {
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) throw new Error('构建号无效');
    const jobName = quality ? this.qualityJobName : this.jobName;
    const jobPath = encodeJobPath(jobName);
    const [buildResponse, consoleResponse] = await Promise.all([
      axios.get(`${this.baseUrl}/${jobPath}/${buildNumber}/api/json`, {
        timeout: 20_000,
        params: { tree: 'number,result,building,timestamp,duration,description,url,actions[parameters[name,value]]' },
        ...this.authConfig(),
      }),
      axios.get(`${this.baseUrl}/${jobPath}/${buildNumber}/consoleText`, {
        timeout: 30_000,
        responseType: 'text',
        ...this.authConfig(),
      }).catch(() => ({ data: '' })),
    ]);
    const build = buildResponse.data || {};
    const parameters = (build.actions || []).flatMap((action: any) => action.parameters || []);
    const parameter = (name: string) => parameters.find((item: any) => item.name === name)?.value;
    const log = String(consoleResponse.data || '');
    const metadata = parseConsoleMetadata(log);
    const deployTarget = normalizeDeployTarget(String(parameter('DEPLOY_TARGET') || metadata.publishChannel || ''));
    return {
      jobName,
      number: Number(build.number || buildNumber),
      result: build.result || null,
      building: Boolean(build.building),
      timestamp: build.timestamp,
      duration: build.duration,
      description: build.description,
      url: build.url,
      branchName: normalizeBranchName(String(parameter('branch') || parameter('BRANCH') || '')),
      deployTarget,
      suite: normalizeQualitySuite(String(parameter('TEST_SUITE') || parameter('REQUESTED_TEST_SUITE') || '')),
      sourceBuildNumber: Number(parameter('SOURCE_BUILD_NUMBER')) || undefined,
      appVersion: String(parameter('APP_VERSION') || metadata.appVersion || ''),
      commitHash: String(parameter('COMMIT_HASH') || metadata.commitHash || ''),
      packageUrl: metadata.packageUrl || undefined,
      channelQrUrl: deployTarget === 'Pgyer' ? metadata.packageUrl || undefined : undefined,
      devicePool: String(parameter('DEVICE_POOL') || ''),
      durationMinutes: Number(parameter('MONKEY_DURATION_SECONDS')) > 0
        ? Math.ceil(Number(parameter('MONKEY_DURATION_SECONDS')) / 60)
        : undefined,
      log: log.slice(-20_000),
      logTruncated: log.length > 20_000,
    };
  }

  async analyzeBuildFailure(buildNumber: number) {
    const build = await this.getBuildSnapshot(buildNumber, false);
    const result = String(build.result || '').toUpperCase();
    if (result && result !== 'FAILURE' && !/Finished:\s+FAILURE|fastlane finished with errors|构建失败|上传失败/i.test(build.log)) {
      throw new Error('当前构建不是失败状态，无需失败分析');
    }
    const analysis = await aiAnalysisService.analyzeBuildFailureLog({
      log: build.log,
      buildNumber,
      branchName: build.branchName,
      publishChannel: build.deployTarget,
      appVersion: build.appVersion,
      commitHash: build.commitHash,
    });
    workflowIntegrationService.recordBuildFailure(build, analysis);
    return {
      kind: 'build_failure_diagnosis',
      build: { ...build, log: undefined },
      analysis,
      nextActions: [
        ...(build.deployTarget === 'Pgyer' ? ['确认修复后可重试普通构建'] : []),
        '构建重新完成后使用构建验证确认状态和质量门禁',
      ],
    };
  }

  async verifyBuild(buildNumber: number, quality = false) {
    const build = await this.getBuildSnapshot(buildNumber, quality);
    const result = String(build.result || '').toUpperCase();
    const status = build.building ? 'running'
      : result === 'SUCCESS' ? 'passed'
        : result === 'FAILURE' ? 'failed'
          : result === 'ABORTED' ? 'canceled'
            : result === 'UNSTABLE' ? 'unstable' : 'unknown';
    if (!quality && status !== 'passed') workflowIntegrationService.syncJenkinsBuild(build);
    let releaseGate: any;
    let releaseGateError = '';
    if (!quality && status === 'passed') {
      try {
        releaseGate = (await this.previewReleaseGate({ gateBuildNumber: buildNumber, branch: build.branchName })).releaseGate;
      } catch (error: any) {
        releaseGateError = error?.message || '发布门禁读取失败';
      }
    }
    const passed = status === 'passed' && releaseGate?.status !== 'blocked';
    return {
      kind: 'build_verification',
      quality,
      status,
      passed,
      build: { ...build, log: undefined },
      releaseGate,
      releaseGateError: releaseGateError || undefined,
      nextActions: status === 'running'
        ? ['稍后再次验证任务状态']
        : status === 'failed'
          ? [quality ? '查看质检日志并按原参数重跑任务' : '执行构建失败分析，修复后重试构建']
          : releaseGate?.status === 'blocked'
            ? ['处理质量门禁阻断项后重新验证']
            : ['验证通过，可进入下一阶段'],
    };
  }

  async retryBuild(buildNumber: number) {
    const source = await this.getBuildSnapshot(buildNumber, false);
    if (source.building) throw new Error('源构建仍在运行，不能重复触发');
    if (!source.branchName) throw new Error('无法从源构建读取分支');
    if (source.deployTarget && source.deployTarget !== 'Pgyer') {
      throw new Error('TestFlight / AppStore 必须通过受控发布工具重新执行');
    }
    const result = await this.triggerRelease({
      branch: source.branchName,
      deployTarget: 'Pgyer',
      requireReleaseGate: false,
    });
    return { kind: 'build_retry', retryOf: buildNumber, source: { branchName: source.branchName, deployTarget: 'Pgyer' }, ...result };
  }

  async triggerBuild(branch: string) {
    const result = await this.triggerRelease({ branch, deployTarget: 'Pgyer', requireReleaseGate: false });
    return {
      ...result,
      kind: 'build_submission',
      quickActions: [
        { label: '跟踪构建', prompt: `查询 ${result.branch} 最近的 Jenkins 构建并跟踪 Pgyer 构建进度` },
      ],
    };
  }

  async getBuildSubmissionStatus(input: {
    queueUrl?: string;
    buildNumber?: number;
    branch?: string;
    deployTarget?: string;
    submittedAt?: string;
  }) {
    let buildNumber = Number(input.buildNumber || 0) || undefined;
    let queueState: any;
    let queueExpired = false;
    if (!buildNumber && input.queueUrl) {
      const base = new URL(`${this.baseUrl}/`);
      const queue = new URL(String(input.queueUrl), base);
      const queuePrefix = `${base.pathname.replace(/\/$/, '')}/queue/item/`;
      if (queue.origin !== base.origin || !queue.pathname.startsWith(queuePrefix)) {
        throw new Error('Jenkins 队列地址不在允许范围内');
      }
      queue.pathname = `${queue.pathname.replace(/\/$/, '')}/api/json`;
      try {
        const response = await axios.get(queue.toString(), { timeout: 10_000, ...this.authConfig() });
        queueState = response.data || {};
      } catch (error: any) {
        if (error?.response?.status !== 404) throw error;
        queueExpired = true;
        queueState = {};
      }
      if (queueState.cancelled) {
        return {
          kind: 'build_submission_status', phase: 'canceled', terminal: true,
          result: 'ABORTED', message: queueState.why || '任务已在 Jenkins 队列中取消',
          branch: input.branch, deployTarget: input.deployTarget,
        };
      }
      buildNumber = Number(queueState.executable?.number || 0) || undefined;
      if (!buildNumber && !queueExpired) {
        return {
          kind: 'build_submission_status', phase: 'queued', terminal: false,
          message: queueState.why || '已进入 Jenkins 队列，等待分配构建号',
          branch: input.branch, deployTarget: input.deployTarget,
          queueBlocked: Boolean(queueState.blocked),
        };
      }
    }
    if (!buildNumber && input.branch && input.submittedAt) {
      buildNumber = await this.findRecentBuildNumber(input.branch, input.submittedAt);
    }
    if (!buildNumber) {
      return {
        kind: 'build_submission_status', phase: 'queued', terminal: false,
        message: '已提交 Jenkins，等待分配构建号',
        branch: input.branch, deployTarget: input.deployTarget,
      };
    }

    const build = await this.getBuildSnapshot(buildNumber, false);
    const result = String(build.result || '').toUpperCase();
    const phase = build.building ? 'running'
      : result === 'SUCCESS' ? 'success'
        : result === 'FAILURE' ? 'failed'
          : result === 'ABORTED' ? 'canceled'
            : result === 'UNSTABLE' ? 'unstable' : 'queued';
    return {
      kind: 'build_submission_status',
      phase,
      terminal: ['success', 'failed', 'canceled', 'unstable'].includes(phase),
      message: phase === 'running' ? `Jenkins 构建 #${buildNumber} 正在执行`
        : phase === 'success' ? `Jenkins 构建 #${buildNumber} 发布成功`
          : phase === 'failed' ? `Jenkins 构建 #${buildNumber} 发布失败`
            : phase === 'canceled' ? `Jenkins 构建 #${buildNumber} 已取消`
              : phase === 'unstable' ? `Jenkins 构建 #${buildNumber} 状态不稳定` : '等待 Jenkins 开始构建',
      buildNumber,
      result: build.result,
      building: build.building,
      branch: build.branchName || input.branch,
      deployTarget: build.deployTarget || input.deployTarget,
      timestamp: build.timestamp,
      duration: build.duration,
      url: build.url,
      packageUrl: build.packageUrl,
      channelQrUrl: build.channelQrUrl,
    };
  }

  private async findRecentBuildNumber(branch: string, submittedAt: string) {
    const submittedTimestamp = Date.parse(submittedAt);
    if (!Number.isFinite(submittedTimestamp)) return undefined;
    const jobPath = encodeJobPath(this.jobName);
    const response = await axios.get(`${this.baseUrl}/${jobPath}/api/json`, {
      timeout: 10_000,
      params: { tree: 'builds[number,result,building,timestamp,actions[parameters[name,value]]]{0,15}' },
      ...this.authConfig(),
    });
    const targetBranch = normalizeBranchName(branch);
    const builds = Array.isArray(response.data?.builds) ? response.data.builds : [];
    const match = builds.find((build: any) => {
      const parameters = (build.actions || []).flatMap((action: any) => action.parameters || []);
      const parameterBranch = parameters.find((item: any) => ['branch', 'BRANCH'].includes(item.name))?.value;
      return normalizeBranchName(String(parameterBranch || '')) === targetBranch
        && Number(build.timestamp || 0) >= submittedTimestamp - 60_000;
    });
    return Number(match?.number || 0) || undefined;
  }

  async retryQualityBuild(buildNumber: number) {
    const source = await this.getBuildSnapshot(buildNumber, true);
    if (source.building) throw new Error('质检任务仍在运行，不能重复触发');
    const allowedSuites = ['smoke', 'login', 'im', 'rtc', 'monkey', 'stutter', 'full'];
    if (!source.sourceBuildNumber) throw new Error('无法从质检任务读取源构建号');
    if (!allowedSuites.includes(source.suite)) throw new Error(`不支持重跑质检套件：${source.suite || 'unknown'}`);
    const result = await this.triggerQuality({
      sourceBuildNumber: source.sourceBuildNumber,
      suite: source.suite as 'smoke' | 'login' | 'im' | 'rtc' | 'monkey' | 'stutter' | 'full',
      branch: source.branchName,
      commitHash: source.commitHash,
      appVersion: source.appVersion,
      devicePool: source.devicePool || undefined,
      durationMinutes: source.durationMinutes,
    });
    return { kind: 'quality_retry', retryOf: buildNumber, source: { suite: source.suite, sourceBuildNumber: source.sourceBuildNumber }, task: result };
  }

  async loadReleaseGateBuild(buildNumber: number): Promise<any> {
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) {
      throw new JenkinsReleaseError('质量门禁源构建无效', 400);
    }
    const jobPath = encodeJobPath(this.jobName);
    const [buildResponse, consoleResponse] = await Promise.all([
      axios.get(`${this.baseUrl}/${jobPath}/${buildNumber}/api/json`, {
        timeout: 10_000,
        params: { tree: 'number,result,building,timestamp,duration,description,url,actions[parameters[name,value]]' },
        ...this.authConfig(),
      }),
      axios.get(`${this.baseUrl}/${jobPath}/${buildNumber}/consoleText`, {
        timeout: 10_000,
        responseType: 'text',
        ...this.authConfig(),
      }).catch(() => ({ data: '' })),
    ]);
    const parameters = (buildResponse.data?.actions || [])
      .flatMap((action: any) => Array.isArray(action.parameters) ? action.parameters : []);
    const parameter = (name: string) => parameters.find((item: any) => item.name === name)?.value;
    const metadata = parseConsoleMetadata(String(consoleResponse.data || ''));
    return {
      ...(buildResponse.data || {}),
      branchName: normalizeBranchName(String(parameter('branch') || '')),
      appVersion: metadata.appVersion,
      commitHash: metadata.commitHash,
      url: buildResponse.data?.url,
    };
  }

  async previewReleaseGate(input: { gateBuildNumber: number; branch?: string }): Promise<any> {
    const branch = normalizeBranchName(input.branch || '');
    const build = await this.loadReleaseGateBuild(Number(input.gateBuildNumber));
    workflowIntegrationService.syncJenkinsBuild(build);
    const releaseGate = qualityGateService.preview({
      projectId: 'nn-ios',
      buildNumber: String(input.gateBuildNumber),
      buildStatus: build.result,
      branch: branch || build.branchName,
      commitHash: build.commitHash,
      appVersion: build.appVersion,
      policy: { requiredSuites: requiredReleaseGateSuites() },
    });
    const blockers = Array.isArray((releaseGate?.result as any)?.blockers)
      ? (releaseGate?.result as any).blockers
      : [];
    return {
      build,
      releaseGate,
      missingSuites: blockers
        .filter((item: any) => item.code === 'required_suite_missing')
        .map((item: any) => item.suite),
    };
  }

  async triggerRelease(input: {
    branch: string;
    deployTarget: 'Pgyer' | 'TestFlight' | 'AppStore';
    appVersion?: string;
    gateBuildNumber?: number;
    releaseGateOverrideReason?: string;
    verificationPassword?: string;
    testFlightWhatsNew?: string;
    requireReleaseGate?: boolean;
  }): Promise<any> {
    const branch = normalizeBranchName(input.branch);
    if (!branch) throw new Error('branch 不能为空');
    if (!['Pgyer', 'TestFlight', 'AppStore'].includes(input.deployTarget)) {
      throw new JenkinsReleaseError('发布渠道无效', 400);
    }
    if (input.deployTarget !== 'Pgyer' && !isReleaseBranch(branch)) {
      throw new JenkinsReleaseError('TestFlight / AppStore 仅允许 release/x.x.x 分支', 400);
    }
    if (input.deployTarget !== 'Pgyer' && !String(input.verificationPassword || '').trim()) {
      throw new JenkinsReleaseError('TestFlight / AppStore 发布需要验证密码', 400);
    }
    const releaseNotes = normalizeReleaseNotes(input.testFlightWhatsNew);
    if (input.deployTarget !== 'Pgyer' && releaseNotes.length <= 4) {
      throw new JenkinsReleaseError('TestFlight / AppStore 发布文案必填，且必须超过 4 个字', 400);
    }
    const releaseBranchVersion = isReleaseBranch(branch) ? branch.replace(/^release\//, '') : '';
    const requestedAppVersion = String(input.appVersion || releaseBranchVersion).trim();
    if (input.deployTarget !== 'Pgyer' && releaseBranchVersion && requestedAppVersion && requestedAppVersion !== releaseBranchVersion) {
      throw new JenkinsReleaseError(`发布版本 ${requestedAppVersion} 与发布分支版本 ${releaseBranchVersion} 不一致`, 400);
    }
    const gateBuildNumber = input.gateBuildNumber === undefined ? undefined : Number(input.gateBuildNumber);
    if (input.requireReleaseGate && !gateBuildNumber) {
      throw new JenkinsReleaseError('当前发布必须选择成功构建作为质量门禁来源', 400);
    }
    if (gateBuildNumber !== undefined && (!Number.isFinite(gateBuildNumber) || gateBuildNumber <= 0)) {
      throw new JenkinsReleaseError('质量门禁源构建无效', 400);
    }

    let releaseGate: any;
    if (gateBuildNumber) {
      const gateBuild = await this.loadReleaseGateBuild(gateBuildNumber);
      workflowIntegrationService.syncJenkinsBuild(gateBuild);
      if (gateBuild.building || String(gateBuild.result || '').toUpperCase() !== 'SUCCESS') {
        throw new JenkinsReleaseError(`源构建 #${gateBuildNumber} 尚未成功完成，不允许发布`);
      }
      releaseGate = qualityGateService.evaluate({
        projectId: 'nn-ios',
        buildNumber: String(gateBuildNumber),
        buildStatus: gateBuild.result,
        branch,
        commitHash: gateBuild.commitHash,
        appVersion: gateBuild.appVersion,
        policy: { requiredSuites: requiredReleaseGateSuites() },
      });
      if (releaseGate?.status === 'blocked') {
        throw new JenkinsReleaseError((releaseGate.result as any)?.summary || '发布被质量门禁阻断', 409, { releaseGate });
      }
      const overrideReason = String(input.releaseGateOverrideReason || '').trim();
      if (input.deployTarget !== 'Pgyer' && releaseGate?.status === 'warning' && !overrideReason) {
        throw new JenkinsReleaseError('质量门禁存在警告，TestFlight / AppStore 发布需要填写人工放行原因', 409, { releaseGate, requiresOverride: true });
      }
      if (releaseGate?.status === 'warning' && overrideReason) {
        workflowService.recordEvent({
          eventType: 'release_gate.overridden',
          entityType: 'release_gate',
          entityId: String(releaseGate.id),
          payload: { buildNumber: String(gateBuildNumber), branch, deployTarget: input.deployTarget, reason: overrideReason },
        });
      }
    }

    const headers = await this.crumbHeaders();
    const appVersion = requestedAppVersion;
    const params = new URLSearchParams({
      branch: toJenkinsBranch(branch),
      DEPLOY_TARGET: input.deployTarget,
      APP_VERSION: appVersion,
      VERIFICATION_PASSWORD: String(input.verificationPassword || ''),
      NOTIFY_WECHAT_ON_SUCCESS: 'true',
      FORCE_PRIVATE_POD_UPDATE: 'false',
      RELEASE_GATE_ID: String(releaseGate?.id || ''),
      RELEASE_GATE_STATUS: String(releaseGate?.status || ''),
      SOURCE_BUILD_NUMBER: gateBuildNumber ? String(gateBuildNumber) : '',
      RELEASE_GATE_OVERRIDE_REASON: gateBuildNumber ? String(input.releaseGateOverrideReason || '').trim() : '',
      TESTFLIGHT_WHATS_NEW: input.deployTarget !== 'Pgyer' ? releaseNotes : '',
    });
    const response = await axios.post(`${this.baseUrl}/${encodeJobPath(this.jobName)}/buildWithParameters`, params.toString(), {
      timeout: 30_000,
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      validateStatus: (status) => status >= 200 && status < 400,
      ...this.authConfig(),
    });
    return {
      kind: 'release_submission',
      jobName: this.jobName,
      branch,
      jenkinsBranch: toJenkinsBranch(branch),
      deployTarget: input.deployTarget,
      appVersion,
      sourceBuildNumber: gateBuildNumber,
      releaseGate,
      queueUrl: response.headers.location || null,
      submittedAt: new Date().toISOString(),
      url: `${this.baseUrl}/${encodeJobPath(this.jobName)}/`,
      quickActions: [
        { label: '跟踪发布', prompt: `查询 ${branch} 最近的 Jenkins 构建并跟踪 ${input.deployTarget} 发布进度` },
        ...(isReleaseBranch(branch) ? [{ label: '发布后验证', prompt: `发布完成后验证版本 ${branch.replace(/^release\//, '')} 的 Crash 和质量健康度` }] : []),
      ],
    };
  }

  async triggerQuality(input: {
    sourceBuildNumber: number;
    suite: 'smoke' | 'login' | 'im' | 'rtc' | 'monkey' | 'stutter' | 'full';
    branch?: string;
    commitHash?: string;
    appVersion?: string;
    devicePool?: string;
    durationMinutes?: number;
  }) {
    if (!Number.isFinite(input.sourceBuildNumber) || input.sourceBuildNumber <= 0) throw new Error('源构建号无效');
    const suite = input.suite || 'smoke';
    const taskId = `task_${randomUUID()}`;
    workflowService.upsertTask({
      id: taskId,
      taskType: `ios_${suite}`,
      suite,
      status: 'created',
      source: 'jenkins',
      buildNumber: String(input.sourceBuildNumber),
      branch: input.branch,
      commitHash: input.commitHash,
      config: input,
    });

    const headers = await this.crumbHeaders();
    const params = new URLSearchParams({
      SOURCE_JOB: this.jobName,
      SOURCE_BUILD_NUMBER: String(input.sourceBuildNumber),
      BRANCH: String(input.branch || ''),
      COMMIT_HASH: String(input.commitHash || ''),
      APP_VERSION: String(input.appVersion || ''),
      TEST_SUITE: suite,
      REQUESTED_TEST_SUITE: suite,
      RUN_MONKEY: suite === 'monkey' ? '1' : '0',
      DEVICE_POOL: String(input.devicePool || 'ios-default'),
      QUALITY_TASK_TYPE: `ios_${suite}`,
      PLATFORM_TASK_ID: taskId,
      MONKEY_DURATION_SECONDS: String(Math.max(60, Number(input.durationMinutes || 120) * 60)),
      MONKEY_GUARDED_ACTION_POLICY: 'read_only',
    });
    const response = await axios.post(`${this.baseUrl}/${encodeJobPath(this.qualityJobName)}/buildWithParameters`, params.toString(), {
      timeout: 30_000,
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      validateStatus: (status) => status >= 200 && status < 400,
      ...this.authConfig(),
    });
    return workflowService.upsertTask({
      id: taskId,
      taskType: `ios_${suite}`,
      suite,
      status: 'queued',
      source: 'jenkins',
      externalId: String(response.headers.location || ''),
      externalUrl: String(response.headers.location || ''),
      buildNumber: String(input.sourceBuildNumber),
      branch: input.branch,
      commitHash: input.commitHash,
      config: input,
    });
  }

  async stopBuild(buildNumber: number, quality = false) {
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) throw new Error('构建号无效');
    const jobName = quality ? this.qualityJobName : this.jobName;
    const headers = await this.crumbHeaders();
    await axios.post(`${this.baseUrl}/${encodeJobPath(jobName)}/${buildNumber}/stop`, null, {
      timeout: 30_000, headers, ...this.authConfig(),
    });
    return { jobName, buildNumber, status: 'stopping' };
  }
}

export const jenkinsAssistantService = new JenkinsAssistantService();
