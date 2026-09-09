import { componentLibraryService, currentComponentCatalogProductLineId } from './ComponentLibraryService';
import { jenkinsAssistantService } from './JenkinsAssistantService';
import { operationalLogService } from './OperationalLogService';
import sentryIssueService from './SentryIssueService';
import { StorageService } from './StorageService';
import { workflowService } from './WorkflowService';
import { currentProductLineId, currentProjectId } from './ProductLineContext';
import { getDatabase } from '../database';

function escapeQuery(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function issueCount(issue: any) {
  const count = Number(issue?.count || 0);
  return Number.isFinite(count) ? count : 0;
}

function issueUserCount(issue: any) {
  const count = Number(issue?.userCount || 0);
  return Number.isFinite(count) ? count : 0;
}

function issueKey(issue: any) {
  return `${String(issue?.title || '').trim().toLowerCase()}|${String(issue?.culprit || '').trim().toLowerCase()}`;
}

function parsePodDependencies(content: string) {
  const dependencies: Array<{ name: string; requirement: string }> = [];
  const pattern = /\.dependency\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/g;
  let match = pattern.exec(content);
  while (match) {
    dependencies.push({ name: match[1], requirement: match[2] || '任意版本' });
    match = pattern.exec(content);
  }
  return dependencies;
}

function isRecent(value: unknown, since: number) {
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(timestamp) && timestamp >= since;
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, source: string): Promise<PromiseSettledResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${source} 查询超时`)), timeoutMs);
      }),
    ]);
    return { status: 'fulfilled', value };
  } catch (reason) {
    return { status: 'rejected', reason };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class AssistantInsightService {
  async compareCrashVersions(versionA: string, versionB: string, period: '24h' | '7d' | '14d' = '14d') {
    const [left, right] = await Promise.all([
      sentryIssueService.listNewIssues({ period, limit: 20, query: `is:unresolved release:"${escapeQuery(versionA)}"`, enrichVersions: true }),
      sentryIssueService.listNewIssues({ period, limit: 20, query: `is:unresolved release:"${escapeQuery(versionB)}"`, enrichVersions: true }),
    ]);
    const leftKeys = new Set(left.map(issueKey));
    const newIssues = right.filter((issue) => !leftKeys.has(issueKey(issue)));
    const summarize = (version: string, issues: any[]) => ({
      version,
      issueCount: issues.length,
      eventCount: issues.reduce((sum, issue) => sum + issueCount(issue), 0),
      affectedUsers: issues.reduce((sum, issue) => sum + issueUserCount(issue), 0),
      topIssue: issues.slice().sort((a, b) => issueCount(b) - issueCount(a))[0]?.title || '-',
    });
    const comparison = [summarize(versionA, left), summarize(versionB, right)];
    const eventDelta = comparison[1].eventCount - comparison[0].eventCount;
    return {
      kind: 'crash_version_comparison',
      period,
      versions: comparison,
      newIssues: newIssues.slice(0, 10),
      conclusion: eventDelta > 0
        ? `${versionB} 的崩溃事件比 ${versionA} 多 ${eventDelta} 次，并新增 ${newIssues.length} 个问题。`
        : `${versionB} 的崩溃事件未高于 ${versionA}，新增 ${newIssues.length} 个问题。`,
      quickActions: newIssues.slice(0, 3).map((issue) => ({ label: `查看 #${issue.id}`, prompt: `查看 Sentry Issue ${issue.id} 的崩溃详情并分析根因` })),
    };
  }

  async diagnoseDSYM(input: { uuid?: string; appVersion?: string; appName?: string }) {
    const storage = new StorageService();
    const uuid = String(input.uuid || '').trim().toUpperCase().replace(/-/g, '');
    const appVersion = String(input.appVersion || '').trim();
    const appName = String(input.appName || '').trim().toLowerCase();
    if (!uuid && !appVersion) throw new Error('dSYM 诊断至少需要 UUID 或应用版本');
    const all = await storage.getAllDSYMs();
    const normalizeUUID = (value: string) => String(value || '').toUpperCase().replace(/-/g, '');
    const matches = all.filter((item) => {
      if (uuid && normalizeUUID(item.uuid) !== uuid) return false;
      if (appVersion && item.version !== appVersion && !(item.relatedAppVersions || []).includes(appVersion)) return false;
      if (appName && !item.appName.toLowerCase().includes(appName)) return false;
      return true;
    });
    const versionInventory = appVersion
      ? all.filter((item) => item.version === appVersion || (item.relatedAppVersions || []).includes(appVersion))
      : [];
    const missing = matches.length === 0;
    return {
      kind: 'dsym_diagnosis',
      status: missing ? 'missing' : 'available',
      query: { uuid: input.uuid || undefined, appVersion: appVersion || undefined, appName: input.appName || undefined },
      matches: matches.slice(0, 30).map((item) => ({
        uuid: item.uuid,
        appName: item.appName,
        version: item.version,
        buildNumber: item.buildNumber,
        architecture: item.architecture,
        uploadTime: item.uploadTime,
        relatedAppVersions: item.relatedAppVersions,
      })),
      versionInventory: versionInventory.slice(0, 30).map((item) => ({ uuid: item.uuid, appName: item.appName, version: item.version, architecture: item.architecture })),
      conclusion: missing
        ? `平台未找到${uuid ? ` UUID ${input.uuid}` : ''}${appVersion ? ` 版本 ${appVersion}` : ''}对应的 dSYM。`
        : `已找到 ${matches.length} 个匹配的 dSYM。`,
      quickActions: missing && appVersion ? [{ label: '查构建产物', prompt: `查询版本 ${appVersion} 最近的 Jenkins 构建，确认是否生成并归档 dSYM` }] : [],
    };
  }

  async analyzePodImpact(name: string, version?: string) {
    const rows = getDatabase().prepare(`
      SELECT * FROM pods_components
      WHERE product_line_id = ?
      ORDER BY upload_time DESC
    `).all(currentComponentCatalogProductLineId()) as any[];
    const all = rows.map((row) => ({
      name: String(row.name || ''),
      version: String(row.version || ''),
      status: String(row.status || ''),
      package_type: row.package_type ? String(row.package_type) : undefined,
      nnios_branch: row.nnios_branch ? String(row.nnios_branch) : undefined,
      podspec_content: String(row.podspec_content || ''),
    }));
    const versions = all.filter((item) => item.name === name).map((item) => item.version).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    const target = version ? all.find((item) => item.name === name && item.version === version) : all.find((item) => item.name === name && item.version === versions[0]);
    if (!target) throw new Error(`未找到组件 ${name}${version ? ` ${version}` : ''}`);
    const dependencies = parsePodDependencies(target.podspec_content || '');
    const dependents = all.flatMap((component) => {
      const matched = parsePodDependencies(component.podspec_content || '').filter((dependency) => dependency.name.split('/')[0] === name.split('/')[0]);
      return matched.length > 0 ? matched.map((dependency) => ({ component: component.name, version: component.version, requirement: dependency.requirement })) : [];
    });
    const latestVersion = versions[0] || target.version;
    return {
      kind: 'pods_impact',
      componentLibrary: componentLibraryService.status(),
      component: { name: target.name, version: target.version, status: target.status, packageType: target.package_type, branch: target.nnios_branch },
      latestVersion,
      upgradeAvailable: latestVersion !== target.version,
      dependencies,
      dependents: dependents.slice(0, 100),
      risks: [
        ...(dependents.length > 0 ? [`${dependents.length} 个内部组件直接依赖 ${name}`] : []),
        ...(dependencies.length > 0 ? [`目标版本包含 ${dependencies.length} 个直接依赖，需要验证版本解析`] : []),
        ...(target.status !== 'published' ? [`当前组件状态为 ${target.status}`] : []),
        '二进制兼容性、资源 Bundle 和最低系统版本仍需通过构建与 smoke 质检验证',
      ],
      recommendedChecks: ['Pod 依赖解析', '主工程编译', '启动 smoke', ...(dependents.length > 0 ? ['依赖方核心流程回归'] : [])],
      quickActions: [{ label: '查看验证范围', prompt: `分析 ${name} 从 ${target.version} 升级到 ${latestVersion} 对主工程的升级风险和建议质检范围` }],
    };
  }

  async qualityDailyReport(hours = 24) {
    const since = Date.now() - Math.min(Math.max(hours, 1), 168) * 60 * 60_000;
    const sourceTimeoutMs = Math.min(Math.max(Number(process.env.ASSISTANT_REPORT_SOURCE_TIMEOUT || 15_000), 1_000), 30_000);
    const [buildsResult, qualityResult, crashResult] = await Promise.all([
      settleWithin(jenkinsAssistantService.listBuilds(20, false), sourceTimeoutMs, 'Jenkins 构建'),
      settleWithin(jenkinsAssistantService.listBuilds(20, true), sourceTimeoutMs, 'Jenkins 质检'),
      settleWithin(sentryIssueService.listNewIssues({ period: hours <= 24 ? '24h' : '7d', limit: 20, enrichVersions: true }), sourceTimeoutMs, 'Sentry Crash'),
    ]);
    const builds = buildsResult.status === 'fulfilled' ? buildsResult.value.filter((item: any) => isRecent(item.timestamp, since)) : [];
    const quality = qualityResult.status === 'fulfilled' ? qualityResult.value.filter((item: any) => isRecent(item.timestamp, since)) : [];
    const crashes = crashResult.status === 'fulfilled' ? crashResult.value.filter((item: any) => isRecent(item.lastSeen || item.firstSeen, since)) : [];
    const tasks = workflowService.listTasks({ limit: 100 }).filter((item: any) => isRecent(item.updatedAt || item.createdAt, since));
    const issues = workflowService.listIssues({ limit: 100 }).filter((item: any) => isRecent(item.lastSeen || item.updatedAt || item.createdAt, since));
    const buildFailures = builds.filter((item: any) => /FAILURE|ABORTED|UNSTABLE/i.test(String(item.result || '')));
    const qualityFailures = quality.filter((item: any) => /FAILURE|ABORTED|UNSTABLE/i.test(String(item.result || '')));
    const highIssues = issues.filter((item: any) => ['blocker', 'critical', 'high'].includes(String(item.severity || '').toLowerCase()));
    const risks = [
      ...buildFailures.slice(0, 3).map((item: any) => ({ type: 'build', id: item.number, title: `构建 #${item.number} ${item.result}`, severity: 'high' })),
      ...qualityFailures.slice(0, 3).map((item: any) => ({ type: 'quality', id: item.number, title: `质检 #${item.number} ${item.result}`, severity: 'high' })),
      ...highIssues.slice(0, 5).map((item: any) => ({ type: item.source || 'issue', id: item.id, title: item.title, severity: item.severity })),
      ...crashes.slice(0, 5).map((item: any) => ({ type: 'crash', id: item.id, title: item.title, severity: item.level || 'error', count: item.count })),
    ].slice(0, 12);
    const sourceErrors: Record<string, string> = {};
    for (const [name, result] of Object.entries({ jenkins: buildsResult, quality: qualityResult, sentry: crashResult })) {
      if (result.status === 'rejected') {
        sourceErrors[name] = result.reason instanceof Error ? result.reason.message : String(result.reason);
      }
    }
    return {
      kind: 'quality_daily_report',
      hours,
      generatedAt: new Date().toISOString(),
      metrics: {
        builds: builds.length,
        buildSuccessRate: builds.length ? Math.round((builds.length - buildFailures.length) * 100 / builds.length) : null,
        qualityTasks: quality.length || tasks.length,
        qualityFailures: qualityFailures.length,
        newCrashIssues: crashes.length,
        crashEvents: crashes.reduce((sum, item) => sum + issueCount(item), 0),
        openHighRisks: highIssues.length,
      },
      risks,
      sourceStatus: {
        jenkins: buildsResult.status,
        quality: qualityResult.status,
        sentry: crashResult.status,
      },
      sourceErrors,
      conclusion: risks.length > 0 ? `过去 ${hours} 小时发现 ${risks.length} 项优先关注风险。` : `过去 ${hours} 小时未发现高优先级风险。`,
      quickActions: [
        ...(buildFailures[0] ? [{ label: `分析构建 #${buildFailures[0].number}`, prompt: `分析 Jenkins 构建 #${buildFailures[0].number} 的失败原因` }] : []),
        ...(crashes[0] ? [{ label: `查看 Crash #${crashes[0].id}`, prompt: `查看 Sentry Issue ${crashes[0].id} 的详情并分析` }] : []),
      ],
    };
  }

  async diagnoseCrossSystem(input: { uid?: string; deviceId?: string; buildNumber?: number; appVersion?: string; crashTime?: string; keyword?: string }) {
    const uid = String(input.uid || '').trim();
    const deviceId = String(input.deviceId || '').trim();
    const buildNumber = Number(input.buildNumber || 0);
    const appVersion = String(input.appVersion || '').trim();
    if (!uid && !deviceId && !buildNumber && !appVersion) throw new Error('跨系统诊断至少需要 UID、DeviceID、构建号或版本之一');

    const jobs: Record<string, Promise<any>> = {};
    if (uid || deviceId) {
      jobs.crashes = sentryIssueService.listIssuesByIdentifier({ identifier: uid || deviceId, identifierType: uid ? 'uid' : 'deviceId', period: '7d', limit: 10 });
      jobs.logs = operationalLogService.search({ uid: uid || undefined, deviceId: deviceId || undefined, crashTime: input.crashTime, keyword: input.keyword || 'error', limit: 3 });
    } else if (appVersion) {
      jobs.crashes = sentryIssueService.listNewIssues({ period: '7d', limit: 10, query: `is:unresolved release:"${escapeQuery(appVersion)}"`, enrichVersions: true });
    }
    if (buildNumber > 0) jobs.build = jenkinsAssistantService.getBuildSnapshot(buildNumber, false);
    const results = Object.fromEntries(await Promise.all(Object.entries(jobs).map(async ([key, promise]) => {
      try {
        return [key, { status: 'fulfilled', value: await promise }];
      } catch (error) {
        return [key, { status: 'rejected', reason: error instanceof Error ? error.message : String(error) }];
      }
    })));
    const crashes = results.crashes?.status === 'fulfilled' ? results.crashes.value : [];
    const logs = results.logs?.status === 'fulfilled' ? results.logs.value : undefined;
    const build = results.build?.status === 'fulfilled' ? results.build.value : undefined;
    const workflowTasks = buildNumber > 0 ? workflowService.listTasks({ buildNumber: String(buildNumber), limit: 20 }) : [];
    const workflowIssues = buildNumber > 0
      ? workflowService.listIssues({ buildNumber: String(buildNumber), limit: 20 })
      : appVersion ? workflowService.listIssues({ query: appVersion, limit: 20 }) : [];
    const releaseGates = workflowService.listReleaseGates(currentProjectId(), 20).filter((gate: any) => !buildNumber || String(gate.buildNumber) === String(buildNumber));
    const possibleCauses: Array<{ rank: number; cause: string; evidence: string }> = [];
    if (build && /FAILURE|UNSTABLE|ABORTED/i.test(String(build.result || ''))) possibleCauses.push({ rank: 1, cause: '构建或发布链路失败', evidence: `Jenkins #${build.number} 状态为 ${build.result}` });
    if (crashes.length > 0) possibleCauses.push({ rank: possibleCauses.length + 1, cause: '线上 Crash 回归', evidence: `Sentry 命中 ${crashes.length} 个问题，共 ${crashes.reduce((sum: number, issue: any) => sum + issueCount(issue), 0)} 次事件` });
    if ((logs?.matchCount || 0) > 0) possibleCauses.push({ rank: possibleCauses.length + 1, cause: '客户端日志异常', evidence: `反馈日志在目标时间窗命中 ${logs.matchCount} 行异常信息` });
    if (workflowIssues.length > 0) possibleCauses.push({ rank: possibleCauses.length + 1, cause: '质量中心已有相关问题', evidence: `关联 ${workflowIssues.length} 个 Issue` });
    return {
      kind: 'cross_system_diagnosis',
      input: { uid: uid || undefined, deviceId: deviceId || undefined, buildNumber: buildNumber || undefined, appVersion: appVersion || undefined, crashTime: input.crashTime },
      summary: { crashIssues: crashes.length, logMatches: logs?.matchCount || 0, workflowTasks: workflowTasks.length, workflowIssues: workflowIssues.length, releaseGates: releaseGates.length },
      possibleCauses,
      build: build ? { ...build, log: undefined } : undefined,
      crashes: crashes.slice(0, 10),
      logMatches: logs?.matches?.slice(0, 20) || [],
      workflowTasks: workflowTasks.slice(0, 10),
      workflowIssues: workflowIssues.slice(0, 10),
      releaseGates: releaseGates.slice(0, 5),
      sourceErrors: Object.fromEntries(Object.entries(results).filter(([, result]: any) => result.status === 'rejected').map(([key, result]: any) => [key, result.reason])),
      nextActions: [
        ...(build && /FAILURE/i.test(String(build.result || '')) ? [`分析构建 #${build.number} 失败原因`] : []),
        ...(crashes[0] ? [`查看 Sentry Issue ${crashes[0].id} 崩溃详情`] : []),
        ...(workflowTasks.some((task: any) => ['failed', 'failure'].includes(String(task.status || '').toLowerCase())) ? ['查看失败质检项并按原参数重跑'] : []),
      ],
      quickActions: [
        ...(build && /FAILURE/i.test(String(build.result || '')) ? [{ label: '分析构建失败', prompt: `分析 Jenkins 构建 #${build.number} 的失败原因` }] : []),
        ...(crashes[0] ? [{ label: '查看首要 Crash', prompt: `查看 Sentry Issue ${crashes[0].id} 的崩溃详情并定位根因` }] : []),
        ...(uid || deviceId ? [{ label: '扩大日志时间窗', prompt: `查询${uid ? `用户 ${uid}` : `设备 ${deviceId}`}前后 30 分钟的异常日志` }] : []),
      ],
    };
  }

  async trackTask(input: { taskType: 'build' | 'quality' | 'workflow'; id: string }) {
    if (input.taskType === 'build' || input.taskType === 'quality') {
      const buildNumber = Number(input.id);
      if (!Number.isFinite(buildNumber) || buildNumber <= 0) throw new Error('任务构建号无效');
      const verification = await jenkinsAssistantService.verifyBuild(buildNumber, input.taskType === 'quality');
      const terminal = ['passed', 'failed', 'canceled', 'unstable'].includes(String(verification.status || ''));
      return { kind: 'task_tracking', taskType: input.taskType, id: input.id, terminal, status: verification.status, verification, quickActions: verification.nextActions?.map((prompt: string) => ({ label: prompt.slice(0, 12), prompt: `${prompt}；任务为 ${input.taskType} #${input.id}` })) || [] };
    }
    const task = workflowService.getTask(input.id);
    if (!task) throw new Error('Workflow 任务不存在');
    const status = String(task.status || '').toLowerCase();
    const terminal = ['passed', 'success', 'failed', 'failure', 'canceled', 'aborted', 'completed'].includes(status);
    const relations = workflowService.listRelations('task', task.id);
    const issues = relations.filter((relation: any) => relation.toType === 'issue').map((relation: any) => workflowService.getIssue(relation.toId)).filter(Boolean);
    return {
      kind: 'task_tracking', taskType: 'workflow', id: input.id, terminal, status: task.status, task, issues,
      quickActions: !terminal ? [{ label: '继续跟踪', prompt: `继续跟踪 Workflow 任务 ${input.id}` }] : status === 'failed' ? [{ label: '查看失败项', prompt: `查看 Workflow 任务 ${input.id} 的失败问题和重跑建议` }] : [],
    };
  }
}

export const assistantInsightService = new AssistantInsightService();
