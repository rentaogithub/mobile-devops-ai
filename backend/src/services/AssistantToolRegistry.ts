import { extractCrashInfo } from '../utils/crashLogParser';
import { PlatformRole, PlatformUser } from './AuthService';
import { assistantAttachmentService } from './AssistantAttachmentService';
import historyService from './HistoryService';
import { jenkinsAssistantService } from './JenkinsAssistantService';
import { qualityGateService } from './QualityGateService';
import sentryIssueService from './SentryIssueService';
import { StorageService } from './StorageService';
import { SymbolizerService } from './SymbolizerService';
import { changeImpactService } from './ChangeImpactService';
import { workflowAIService } from './WorkflowAIService';
import { workflowService } from './WorkflowService';
import { assistantInsightService } from './AssistantInsightService';
import { apiRouteSearchService } from './ApiRouteSearchService';
import { currentProjectId } from './ProductLineContext';
import { operationalLogService } from './OperationalLogService';
import { platformConfigService } from './PlatformConfigService';
import { isMainAppDSYM } from './DSYMMatcherService';
import { extractVersionFromCrashLog } from '../utils/versionExtractor';

export type AssistantRiskLevel = 'read' | 'confirm' | 'high';

export interface AssistantToolContext {
  user: PlatformUser;
}

export interface AssistantSecretInput {
  name: string;
  label: string;
  description?: string;
  required: boolean;
}

export interface AssistantTool {
  name: string;
  domain: 'crash' | 'cicd' | 'quality' | 'workflow' | 'logs' | 'pods' | 'api' | 'platform';
  description: string;
  parameters: Record<string, unknown>;
  role: PlatformRole;
  allowedRoles?: PlatformRole[];
  canExecute?: (args: Record<string, unknown>, context: AssistantToolContext) => true | string;
  riskLevel: AssistantRiskLevel;
  approvalsRequired: number;
  timeoutMs: number;
  idempotent?: boolean;
  secretInputs?: (args: any) => AssistantSecretInput[];
  preview?: (args: any, context: AssistantToolContext) => unknown | Promise<unknown>;
  execute: (args: any, context: AssistantToolContext) => unknown | Promise<unknown>;
}

const symbolizer = new SymbolizerService();
const ROLE_LABELS: Record<PlatformRole, string> = {
  guest: '游客',
  tester: '测试',
  developer: '研发',
  product: '产品运营',
  admin: '管理员',
};

function allowedRolesFor(tool: AssistantTool): PlatformRole[] {
  if (tool.allowedRoles?.length) return tool.allowedRoles;
  if (tool.role === 'guest') return ['guest', 'tester', 'developer', 'product', 'admin'];
  if (tool.role === 'tester') return ['tester', 'developer', 'admin'];
  if (tool.role === 'developer') return ['developer', 'admin'];
  if (tool.role === 'product') return ['product', 'admin'];
  return ['admin'];
}

function hasToolRole(user: PlatformUser, tool: AssistantTool) {
  return Boolean(user.active) && allowedRolesFor(tool).includes(user.role);
}

function roleListText(roles: PlatformRole[]) {
  return roles.map((role) => ROLE_LABELS[role] || role).join('、');
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function compactHistory(record: any, includeLogs = false) {
  return {
    id: record.id,
    appVersion: record.appVersion,
    crashType: record.crashType,
    crashReason: record.crashReason,
    crashModule: record.crashModule,
    crashLocation: record.crashLocation,
    isFixed: record.isFixed,
    fixedVersion: record.fixedVersion,
    fixedRemark: record.fixedRemark,
    createdAt: record.createdAt,
    hasAIAnalysis: Boolean(record.aiAnalysis),
    aiAnalysis: record.aiAnalysis,
    ...(includeLogs ? {
      originalLog: String(record.originalLog || '').slice(0, 12_000),
      symbolicatedLog: String(record.symbolicatedLog || '').slice(0, 20_000),
    } : {}),
  };
}

async function symbolicateAttachment(args: { attachmentId: string; uuids?: string[] }, context: AssistantToolContext) {
  const storage = new StorageService();
  const crashLog = assistantAttachmentService.readText(args.attachmentId, context.user.id);
  let uuids = Array.isArray(args.uuids) ? args.uuids.map(String).filter(Boolean) : [];
  if (uuids.length === 0) {
    const parsed = symbolizer.parseCrashLog(crashLog);
    if (parsed.uuid) uuids = [parsed.uuid];
  }
  if (uuids.length === 0) throw new Error('无法从日志提取 UUID，请明确指定 uuids');
  const dsymInfos = [];
  for (const uuid of uuids) {
    const info = await storage.findByUUID(uuid);
    if (!info) throw new Error(`未找到 UUID ${uuid} 对应的 dSYM`);
    dsymInfos.push(info);
  }
  const result = await symbolizer.symbolicateWithMultipleDSYMs(crashLog, dsymInfos.map((item) => item.filePath));
  const crashVersion = extractVersionFromCrashLog(crashLog);
  const main = dsymInfos.find((item) => isMainAppDSYM(item, crashVersion)) || dsymInfos[0];
  const crashInfo = extractCrashInfo(crashLog, result.symbolicatedLog);
  const history = await historyService.saveHistory({
    appVersion: main?.version || 'Unknown',
    crashType: crashInfo.crashType,
    crashReason: crashInfo.crashReason,
    lastStackCall: crashInfo.lastStackCall,
    crashModule: crashInfo.crashModule,
    crashLocation: crashInfo.crashLocation,
    originalLog: crashLog,
    symbolicatedLog: result.symbolicatedLog,
    usedUuids: uuids,
  });
  return { historyId: history.id, appVersion: history.appVersion, warning: result.warning, symbolicatedLog: result.symbolicatedLog.slice(0, 20_000) };
}

const tools: AssistantTool[] = [
  {
    name: 'platform_cross_system_diagnosis', domain: 'platform', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 180_000,
    description: '跨系统诊断用户或版本问题：输入 UID、DeviceID、构建号或版本，自动关联 Sentry、Jenkins、质检、反馈日志和发布门禁，输出证据、可能原因与处理建议。',
    parameters: objectSchema({
      uid: { type: 'string' }, deviceId: { type: 'string' }, buildNumber: { type: 'number' }, appVersion: { type: 'string' }, crashTime: { type: 'string' }, keyword: { type: 'string' },
    }),
    execute: (args) => assistantInsightService.diagnoseCrossSystem(args),
  },
  {
    name: 'logs_search', domain: 'logs', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 180_000,
    description: '按 UID、DeviceID、时间范围和关键词查询反馈日志；提供 crashTime 时自动对齐崩溃发生前后时间窗。',
    parameters: objectSchema({
      uid: { type: 'string' }, deviceId: { type: 'string' }, keyword: { type: 'string' }, startTime: { type: 'string' }, endTime: { type: 'string' }, crashTime: { type: 'string' }, windowMinutes: { type: 'number', minimum: 1, maximum: 1440 }, limit: { type: 'number', minimum: 1, maximum: 10 },
    }),
    execute: (args) => operationalLogService.search(args),
  },
  {
    name: 'api_search', domain: 'api', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 20_000,
    description: '用自然语言搜索平台已同步的 API 文档，返回服务、方法、路径、用途、参数数量和已有调用样本数量。',
    parameters: objectSchema({ keyword: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 100 } }, ['keyword']),
    execute: (args) => apiRouteSearchService.searchApi(args.keyword, args.limit || 30),
  },
  {
    name: 'routes_search', domain: 'api', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 30_000,
    description: '用自然语言搜索当前产品线主仓库中的 App 路由、Scheme、Universal Link 和 JSBridge 入口，返回源码位置、模块与跨端兼容性提示。',
    parameters: objectSchema({ keyword: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 100 } }, ['keyword']),
    execute: (args) => apiRouteSearchService.searchRoutes(args.keyword, args.limit || 30),
  },
  {
    name: 'pods_analyze_impact', domain: 'pods', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 60_000,
    description: '查询 CocoaPods 组件版本、直接依赖、内部依赖方和升级验证范围，不执行发布、替换或删除。',
    parameters: objectSchema({ name: { type: 'string' }, version: { type: 'string' } }, ['name']),
    execute: (args) => assistantInsightService.analyzePodImpact(args.name, args.version),
  },
  {
    name: 'workflow_overview', domain: 'workflow', role: 'admin', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 10_000,
    description: '获取移动研发质量中心概览、最新任务和最新问题。',
    parameters: objectSchema({ projectId: { type: 'string', description: '项目 ID，默认使用当前产品线' } }),
    execute: () => workflowService.overview(currentProjectId()),
  },
  {
    name: 'workflow_list_issues', domain: 'workflow', role: 'admin', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 10_000,
    description: '查询质量中心 Issue，可按状态、严重等级和来源过滤。',
    parameters: objectSchema({
      status: { type: 'string' }, severity: { type: 'string' }, source: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 100 },
    }),
    execute: (args) => workflowService.listIssues({ ...args, limit: args.limit || 20 }),
  },
  {
    name: 'workflow_get_issue', domain: 'workflow', role: 'admin', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 10_000,
    description: '读取指定质量 Issue 的详情、关系和事件。',
    parameters: objectSchema({ issueId: { type: 'string' } }, ['issueId']),
    execute: (args) => {
      const issue = workflowService.getIssue(args.issueId);
      if (!issue) throw new Error('Issue 不存在');
      return { issue, relations: workflowService.listRelations('issue', issue.id), events: workflowService.listEvents({ entityType: 'issue', entityId: issue.id }) };
    },
  },
  {
    name: 'workflow_list_tasks', domain: 'workflow', role: 'admin', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 10_000,
    description: '查询构建、质检和回归任务。',
    parameters: objectSchema({ status: { type: 'string' }, suite: { type: 'string' }, source: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 100 } }),
    execute: (args) => workflowService.listTasks({ ...args, limit: args.limit || 20 }),
  },
  {
    name: 'workflow_verify_task', domain: 'workflow', role: 'admin', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 10_000,
    description: '验证平台任务是否完成、是否通过，并返回关联问题和下一步建议。',
    parameters: objectSchema({ taskId: { type: 'string' } }, ['taskId']),
    execute: (args) => {
      const task = workflowService.getTask(args.taskId);
      if (!task) throw new Error('任务不存在');
      const relations = workflowService.listRelations('task', task.id);
      const issues = relations
        .filter((relation: any) => relation.toType === 'issue')
        .map((relation: any) => workflowService.getIssue(relation.toId))
        .filter(Boolean);
      const status = String(task.status || '').toLowerCase();
      const passed = ['passed', 'success'].includes(status) || (status === 'completed' && (task.result as any)?.passed !== false);
      const terminal = ['passed', 'success', 'failed', 'failure', 'canceled', 'aborted', 'completed'].includes(status);
      return {
        kind: 'task_verification', task, issues, terminal, passed,
        nextActions: !terminal ? ['任务仍在执行，稍后再次验证'] : passed ? ['任务验证通过'] : ['查看失败问题，修复后重跑对应质检任务'],
      };
    },
  },
  {
    name: 'workflow_change_impact', domain: 'workflow', role: 'tester', riskLevel: 'confirm', approvalsRequired: 1, timeoutMs: 60_000,
    description: '根据仓库、Base/Head Ref 或文件列表执行变更影响分析。',
    parameters: objectSchema({ repoPath: { type: 'string' }, baseRef: { type: 'string' }, headRef: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }),
    preview: (args) => ({ title: '执行变更影响分析', repoPath: args.repoPath, baseRef: args.baseRef, headRef: args.headRef, fileCount: args.files?.length || 0 }),
    execute: (args) => changeImpactService.analyze(args),
  },
  {
    name: 'workflow_release_gate_preview', domain: 'workflow', role: 'admin', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 10_000,
    description: '根据构建状态、分支、Commit 和应用版本预览发布质量门禁，不触发发布。',
    parameters: objectSchema({
      buildNumber: { type: 'string' }, buildStatus: { type: 'string' }, branch: { type: 'string' }, commitHash: { type: 'string' }, appVersion: { type: 'string' },
    }, ['buildNumber']),
    execute: (args) => qualityGateService.preview({ ...args, projectId: currentProjectId() }),
  },
  {
    name: 'workflow_verify_release_health', domain: 'workflow', role: 'admin', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 10_000,
    description: '发布后验证指定版本的 Crash、性能和质量观察指标，给出是否健康及后续建议。',
    parameters: objectSchema({ releaseVersion: { type: 'string' } }, ['releaseVersion']),
    execute: (args) => ({ kind: 'release_health_verification', ...qualityGateService.evaluateReleaseHealth(currentProjectId(), args.releaseVersion) }),
  },
  {
    name: 'task_track', domain: 'workflow', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 60_000,
    description: '统一跟踪 Jenkins 构建、自动质检或 Workflow 异步任务，返回当前状态、是否结束、失败项和下一步快捷操作。',
    parameters: objectSchema({ taskType: { type: 'string', enum: ['build', 'quality', 'workflow'] }, id: { type: 'string' } }, ['taskType', 'id']),
    execute: (args) => assistantInsightService.trackTask(args),
  },
  {
    name: 'workflow_create_regression_candidate', domain: 'workflow', role: 'tester', riskLevel: 'confirm', approvalsRequired: 1, timeoutMs: 20_000,
    description: '将指定 Issue 转换为确定性回归候选。',
    parameters: objectSchema({ issueId: { type: 'string' } }, ['issueId']),
    preview: (args) => ({ title: '生成回归候选', issueId: args.issueId }),
    execute: (args) => workflowAIService.proposeRegressionCandidate(args.issueId),
  },
  {
    name: 'workflow_generate_xcuitest', domain: 'workflow', role: 'tester', riskLevel: 'confirm', approvalsRequired: 1, timeoutMs: 120_000,
    description: '根据已有回归候选生成安全的 XCUITest 代码。',
    parameters: objectSchema({ candidateId: { type: 'string' } }, ['candidateId']),
    preview: (args) => ({ title: '生成 XCUITest', candidateId: args.candidateId }),
    execute: (args) => workflowAIService.generateXCUITest(args.candidateId),
  },
  {
    name: 'crash_list_history', domain: 'crash', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 10_000,
    description: '查询平台已有 Crash 符号化历史记录。',
    parameters: objectSchema({ version: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 100 } }),
    execute: (args) => {
      const records = args.version
        ? historyService.getHistoryByVersion(args.version)
        : Object.values(historyService.getAllHistoryGroupedByVersion()).flat();
      return records.slice(0, args.limit || 20).map((record) => compactHistory(record));
    },
  },
  {
    name: 'crash_get_history', domain: 'crash', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 10_000,
    description: '读取指定 Crash 历史详情和截断后的日志。',
    parameters: objectSchema({ historyId: { type: 'number' } }, ['historyId']),
    execute: (args) => compactHistory(historyService.getHistoryById(args.historyId), true),
  },
  {
    name: 'crash_analyze_history', domain: 'crash', role: 'tester', riskLevel: 'confirm', approvalsRequired: 1, timeoutMs: 120_000,
    description: '对指定的已符号化 Crash 历史执行 AI 分析并保存结果。',
    parameters: objectSchema({ historyId: { type: 'number' } }, ['historyId']),
    preview: (args) => ({ title: 'AI 分析 Crash', historyId: args.historyId }),
    execute: (args) => historyService.analyzeHistory(args.historyId, ''),
  },
  {
    name: 'crash_symbolicate_attachment', domain: 'crash', role: 'tester', riskLevel: 'confirm', approvalsRequired: 1, timeoutMs: 180_000,
    description: '使用平台已有 dSYM 符号化本次会话上传的 .crash/.ips 附件。',
    parameters: objectSchema({ attachmentId: { type: 'string' }, uuids: { type: 'array', items: { type: 'string' } } }, ['attachmentId']),
    preview: (args, context) => {
      const attachment = assistantAttachmentService.get(args.attachmentId, context.user.id);
      return { title: '符号化崩溃附件', attachment: attachment ? { name: attachment.originalName, size: attachment.size, sha256: attachment.sha256 } : null, uuids: args.uuids || [] };
    },
    execute: symbolicateAttachment,
  },
  {
    name: 'crash_compare_versions', domain: 'crash', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 180_000,
    description: '比较两个 App 版本的 Sentry 崩溃问题数、事件数、影响用户和新增问题。',
    parameters: objectSchema({ versionA: { type: 'string' }, versionB: { type: 'string' }, period: { type: 'string', enum: ['24h', '7d', '14d'] } }, ['versionA', 'versionB']),
    execute: (args) => assistantInsightService.compareCrashVersions(args.versionA, args.versionB, args.period || '14d'),
  },
  {
    name: 'dsym_diagnose_missing', domain: 'crash', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 20_000,
    description: '按 UUID 或 App 版本诊断平台是否缺少 dSYM，并列出匹配架构、构建号和版本库存；不执行上传或删除。',
    parameters: objectSchema({ uuid: { type: 'string' }, appVersion: { type: 'string' }, appName: { type: 'string' } }),
    execute: (args) => assistantInsightService.diagnoseDSYM(args),
  },
  {
    name: 'sentry_list_issues', domain: 'crash', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 120_000,
    description: '查询 Sentry 最近的线上 Crash Issue。不要用此工具按 UID 或 DeviceID 查询；用户或设备查询必须使用 sentry_find_user_issues。',
    parameters: objectSchema({ period: { type: 'string', enum: ['24h', '7d', '14d'] }, limit: { type: 'number', minimum: 1, maximum: 20 }, query: { type: 'string' } }),
    execute: (args) => {
      const query = String(args.query || '').trim();
      if (/^\d{6,}$/.test(query)) {
        return sentryIssueService.listIssuesByIdentifier({
          identifier: query,
          identifierType: 'uid',
          period: '7d',
          limit: args.limit || 20,
        });
      }
      return sentryIssueService.listNewIssues({ period: args.period || '24h', limit: args.limit || 10, query: args.query, enrichVersions: true });
    },
  },
  {
    name: 'sentry_find_user_issues', domain: 'crash', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 120_000,
    description: '按 UID 或 DeviceID 精确查询用户最近的 Sentry 崩溃问题。用户说“这个用户/UID”时 identifierType 必须为 uid；默认查询最近 7 天。',
    parameters: objectSchema({
      identifier: { type: 'string' },
      identifierType: { type: 'string', enum: ['uid', 'deviceId'] },
      period: { type: 'string', enum: ['24h', '7d', '14d'] },
      limit: { type: 'number', minimum: 1, maximum: 20 },
    }, ['identifier']),
    execute: (args) => sentryIssueService.listIssuesByIdentifier({
      identifier: args.identifier,
      identifierType: args.identifierType || 'uid',
      period: args.period || '7d',
      limit: args.limit || 20,
    }),
  },
  {
    name: 'sentry_get_issue_context', domain: 'crash', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 120_000,
    description: '读取指定 Sentry Issue 最新事件的诊断上下文。',
    parameters: objectSchema({ issueId: { type: 'string' } }, ['issueId']),
    execute: async (args) => {
      const [issueResult, eventResult] = await Promise.allSettled([
        sentryIssueService.getIssue(args.issueId, { enrichVersions: true }),
        sentryIssueService.getLatestEvent(args.issueId),
      ]);
      const event = eventResult.status === 'fulfilled' ? eventResult.value : undefined;
      const issue = issueResult.status === 'fulfilled' && issueResult.value
        ? issueResult.value
        : event
          ? {
            id: String(args.issueId),
            title: event.title || event.metadata?.type || 'Sentry Issue',
            eventId: event.id,
          }
          : undefined;
      if (!issue) {
        const failure = eventResult.status === 'rejected' ? eventResult.reason : issueResult.status === 'rejected' ? issueResult.reason : undefined;
        throw failure instanceof Error ? failure : new Error('Sentry Issue 不存在');
      }
      return { issue, analysisLog: sentryIssueService.buildAnalysisLog(issue, event).slice(0, 20_000) };
    },
  },
  {
    name: 'cicd_list_builds', domain: 'cicd', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 30_000,
    description: '实时查询 Jenkins 主工程最近构建。',
    parameters: objectSchema({ limit: { type: 'number', minimum: 1, maximum: 30 } }),
    execute: (args) => jenkinsAssistantService.listBuilds(args.limit || 10, false),
  },
  {
    name: 'cicd_get_build_log', domain: 'cicd', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 40_000,
    description: '获取 Jenkins 构建控制台日志的末尾部分。',
    parameters: objectSchema({ buildNumber: { type: 'number' } }, ['buildNumber']),
    execute: (args) => jenkinsAssistantService.getBuildLog(args.buildNumber, false),
  },
  {
    name: 'cicd_analyze_build_failure', domain: 'cicd', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 120_000,
    description: '读取 Jenkins 失败构建、定位失败阶段和根因，并给出证据、处理方和修复建议。',
    parameters: objectSchema({ buildNumber: { type: 'number' } }, ['buildNumber']),
    execute: (args) => jenkinsAssistantService.analyzeBuildFailure(args.buildNumber),
  },
  {
    name: 'cicd_verify_build', domain: 'cicd', role: 'guest', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 60_000,
    description: '验证 Jenkins 构建或质检任务的最新状态；主工程成功时同时检查发布质量门禁。',
    parameters: objectSchema({ buildNumber: { type: 'number' }, jobType: { type: 'string', enum: ['cicd', 'quality'] } }, ['buildNumber']),
    execute: (args) => jenkinsAssistantService.verifyBuild(args.buildNumber, args.jobType === 'quality'),
  },
  {
    name: 'cicd_trigger_build', domain: 'cicd', role: 'tester', riskLevel: 'confirm', approvalsRequired: 1, timeoutMs: 60_000, idempotent: true,
    description: '为指定 Git 分支触发一次普通 Jenkins Pgyer 构建。适用于“发包”、“打包”或“发布某分支的包”；不用于 TestFlight/App Store。',
    parameters: objectSchema({ branch: { type: 'string', minLength: 1, maxLength: 160 } }, ['branch']),
    preview: (args) => ({
      title: '构建 Pgyer 安装包',
      branch: args.branch,
      deployTarget: 'Pgyer',
      description: '确认后将触发 Jenkins 主工程构建。',
    }),
    execute: (args) => jenkinsAssistantService.triggerBuild(args.branch),
  },
  {
    name: 'cicd_retry_build', domain: 'cicd', role: 'tester', riskLevel: 'confirm', approvalsRequired: 1, timeoutMs: 60_000, idempotent: true,
    description: '按失败构建的原分支重新触发普通 Pgyer 构建；Apple 发布必须使用受控发布工具。',
    parameters: objectSchema({ buildNumber: { type: 'number' } }, ['buildNumber']),
    preview: async (args) => {
      const { log, ...source } = await jenkinsAssistantService.getBuildSnapshot(args.buildNumber, false);
      return { title: '重试普通构建', source };
    },
    execute: (args) => jenkinsAssistantService.retryBuild(args.buildNumber),
  },
  {
    name: 'cicd_trigger_release', domain: 'cicd', role: 'admin', allowedRoles: ['tester', 'developer', 'product', 'admin'], riskLevel: 'high', approvalsRequired: 2, timeoutMs: 60_000, idempotent: true,
    description: '触发 Jenkins 受控发布。测试/研发/管理员只能发布 Pgyer、TestFlight；产品运营/管理员可以发布 AppStore。必须指定质量门禁源构建并二次确认；Apple 渠道验证密码在审批界面单独输入，不进入模型上下文。',
    parameters: objectSchema({
      branch: { type: 'string' }, deployTarget: { type: 'string', enum: ['Pgyer', 'TestFlight', 'AppStore'] }, gateBuildNumber: { type: 'number' }, releaseGateOverrideReason: { type: 'string' },
    }, ['branch', 'deployTarget', 'gateBuildNumber']),
    canExecute: (args, context) => {
      const deployTarget = String(args.deployTarget || '');
      if (deployTarget === 'AppStore') {
        return ['product', 'admin'].includes(context.user.role) || '苹果商店包发布需要产品运营或管理员权限';
      }
      if (deployTarget === 'Pgyer' || deployTarget === 'TestFlight') {
        return ['tester', 'developer', 'admin'].includes(context.user.role) || '蒲公英 / TestFlight 发布需要测试、研发或管理员权限';
      }
      return '发布渠道无效';
    },
    secretInputs: (args) => args.deployTarget === 'Pgyer' || platformConfigService.get('RELEASE_VERIFY_PASSWORD') ? [] : [{
      name: 'verificationPassword',
      label: 'Apple 发布验证密码',
      description: '仅随最终审批直接提交到执行服务，不发送给模型，也不写入审计。',
      required: true,
    }],
    preview: async (args) => ({
      title: '触发 Jenkins 发布',
      branch: args.branch,
      deployTarget: args.deployTarget,
      gateBuildNumber: args.gateBuildNumber,
      releaseGateOverrideReason: args.releaseGateOverrideReason,
      gate: await jenkinsAssistantService.previewReleaseGate({ gateBuildNumber: args.gateBuildNumber, branch: args.branch }),
    }),
    execute: (args) => jenkinsAssistantService.triggerRelease({ ...args, requireReleaseGate: true }),
  },
  {
    name: 'cicd_stop_build', domain: 'cicd', role: 'admin', riskLevel: 'high', approvalsRequired: 2, timeoutMs: 45_000, idempotent: true,
    description: '停止正在运行的 Jenkins 主工程构建。',
    parameters: objectSchema({ buildNumber: { type: 'number' } }, ['buildNumber']),
    preview: (args) => ({ title: '停止 Jenkins 构建', buildNumber: args.buildNumber }),
    execute: (args) => jenkinsAssistantService.stopBuild(args.buildNumber, false),
  },
  {
    name: 'quality_list_tasks', domain: 'quality', role: 'tester', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 30_000,
    description: '实时查询 Jenkins 自动质检最近任务。',
    parameters: objectSchema({ limit: { type: 'number', minimum: 1, maximum: 30 } }),
    execute: (args) => jenkinsAssistantService.listBuilds(args.limit || 10, true),
  },
  {
    name: 'quality_daily_report', domain: 'quality', role: 'tester', riskLevel: 'read', approvalsRequired: 0, timeoutMs: 180_000,
    description: '汇总指定时间范围内的 Crash、Jenkins 构建成功率、自动质检失败和质量中心高风险，生成质量日报。',
    parameters: objectSchema({ hours: { type: 'number', minimum: 1, maximum: 168 } }),
    execute: (args) => assistantInsightService.qualityDailyReport(args.hours || 24),
  },
  {
    name: 'quality_create_task', domain: 'quality', role: 'tester', riskLevel: 'confirm', approvalsRequired: 1, timeoutMs: 60_000, idempotent: true,
    description: '基于指定主工程构建创建 smoke、登录、IM、RTC、Monkey、卡顿或全量质检任务。',
    parameters: objectSchema({
      sourceBuildNumber: { type: 'number' }, suite: { type: 'string', enum: ['smoke', 'login', 'im', 'rtc', 'monkey', 'stutter', 'full'] }, branch: { type: 'string' }, commitHash: { type: 'string' }, appVersion: { type: 'string' }, devicePool: { type: 'string' }, durationMinutes: { type: 'number', minimum: 1, maximum: 480 },
    }, ['sourceBuildNumber', 'suite']),
    preview: (args) => ({ title: '创建自动质检任务', sourceBuildNumber: args.sourceBuildNumber, suite: args.suite, branch: args.branch, devicePool: args.devicePool || 'ios-default', durationMinutes: args.durationMinutes }),
    execute: async (args) => {
      const task = await jenkinsAssistantService.triggerQuality(args);
      return {
        kind: 'quality_task_created',
        task,
        quickActions: [{ label: '跟踪任务', prompt: `继续跟踪 Workflow 任务 ${task?.id}` }],
      };
    },
  },
  {
    name: 'quality_retry_task', domain: 'quality', role: 'tester', riskLevel: 'confirm', approvalsRequired: 1, timeoutMs: 60_000, idempotent: true,
    description: '读取失败质检任务的原始参数并重跑相同测试套件。',
    parameters: objectSchema({ buildNumber: { type: 'number' } }, ['buildNumber']),
    preview: async (args) => {
      const { log, ...source } = await jenkinsAssistantService.getBuildSnapshot(args.buildNumber, true);
      return { title: '重跑质检任务', source };
    },
    execute: (args) => jenkinsAssistantService.retryQualityBuild(args.buildNumber),
  },
  {
    name: 'quality_stop_task', domain: 'quality', role: 'admin', riskLevel: 'high', approvalsRequired: 2, timeoutMs: 45_000, idempotent: true,
    description: '停止正在运行的 Jenkins 自动质检任务。',
    parameters: objectSchema({ buildNumber: { type: 'number' } }, ['buildNumber']),
    preview: (args) => ({ title: '停止自动质检任务', buildNumber: args.buildNumber }),
    execute: (args) => jenkinsAssistantService.stopBuild(args.buildNumber, true),
  },
];

function validateType(value: unknown, type: string) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

export class AssistantToolRegistry {
  listForUser(user: PlatformUser) {
    return tools.filter((tool) => hasToolRole(user, tool));
  }

  get(name: string) {
    return tools.find((tool) => tool.name === name);
  }

  assertAllowed(name: string, user: PlatformUser) {
    const tool = this.get(name);
    if (!tool) throw new Error(`未注册工具：${name}`);
    if (!hasToolRole(user, tool)) throw new Error(`当前角色无权调用 ${name}，需要 ${roleListText(allowedRolesFor(tool))} 权限`);
    return tool;
  }

  assertExecutable(tool: AssistantTool, args: Record<string, unknown>, context: AssistantToolContext) {
    const result = tool.canExecute?.(args, context) ?? true;
    if (result !== true) throw new Error(result);
  }

  validate(tool: AssistantTool, args: Record<string, unknown>) {
    const schema = tool.parameters as any;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
    for (const key of schema.required || []) {
      if (args[key] === undefined || args[key] === null || args[key] === '') throw new Error(`缺少参数：${key}`);
    }
    const allowed = new Set(Object.keys(schema.properties || {}));
    for (const [key, value] of Object.entries(args)) {
      if (!allowed.has(key)) throw new Error(`不允许的参数：${key}`);
      const rule = schema.properties[key];
      if (value === undefined || value === null) continue;
      if (rule.type && !validateType(value, rule.type)) throw new Error(`参数 ${key} 类型应为 ${rule.type}`);
      if (rule.enum && !rule.enum.includes(value)) throw new Error(`参数 ${key} 不在允许范围内`);
      if (typeof value === 'number' && rule.minimum !== undefined && value < rule.minimum) throw new Error(`参数 ${key} 小于最小值`);
      if (typeof value === 'number' && rule.maximum !== undefined && value > rule.maximum) throw new Error(`参数 ${key} 大于最大值`);
      if (Array.isArray(value) && rule.items?.type && value.some((item) => !validateType(item, rule.items.type))) throw new Error(`参数 ${key} 数组元素类型无效`);
    }
    return args;
  }
}

export const assistantToolRegistry = new AssistantToolRegistry();
