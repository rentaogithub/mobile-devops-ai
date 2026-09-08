import fs from 'fs';
import path from 'path';
import { assistantCapabilityDatasetService } from './AssistantCapabilityDatasetService';
import { currentProductLineId } from './ProductLineContext';

export type KnowledgeIntent = 'api' | 'route' | 'cross_platform' | undefined;

export interface AssistantSemanticAction {
  toolName: string;
  args: Record<string, unknown>;
  completionText: string;
}

export interface SemanticQuery {
  raw: string;
  cleaned: string;
  tokens: string[];
}

interface BusinessTerm {
  key: string;
  aliases: string[];
  codeTerms: string[];
  boost: number;
  pattern: RegExp;
}

interface SearchMissInput {
  toolName: string;
  rawQuery: string;
  cleanedQuery: string;
  tokens: string[];
  productLineId?: string;
}

interface AssistantResolutionInput {
  rawInput: string;
  mode: 'deterministic' | 'model_fallback';
  toolName?: string;
  availableToolCount?: number;
  productLineId?: string;
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '..', 'nn-ios-platform-data');

function semanticDir() {
  return process.env.ASSISTANT_SEMANTIC_DIR || path.join(DATA_DIR, 'assistant-semantic');
}

function searchMissesFile() {
  return path.join(semanticDir(), 'search-misses.jsonl');
}

function resolutionsFile() {
  return path.join(semanticDir(), 'resolutions.jsonl');
}

const BUSINESS_TERMS: BusinessTerm[] = [
  {
    key: '带玩主页',
    aliases: ['带玩用户主页', '陪玩主页', '游戏主页'],
    codeTerms: ['gameProfile', 'game/profile', 'profile', 'userId'],
    boost: 85,
    pattern: /带玩主页|带玩用户主页|陪玩主页|game\s*profile|game\/profile/i,
  },
  {
    key: '活动页',
    aliases: ['活动页面', '运营活动', '活动路由'],
    codeTerms: ['actives', 'activityId'],
    boost: 75,
    pattern: /活动页|活动页面|运营活动|actives|activityId/i,
  },
  {
    key: '兑换页',
    aliases: ['口令兑换', 'CDK兑换', '兑换页面'],
    codeTerms: ['redeem', 'cdk', 'type'],
    boost: 75,
    pattern: /兑换页|口令兑换|cdk兑换|redeem/i,
  },
  {
    key: '明明鼠聊天',
    aliases: ['打开明明鼠聊天', '明明鼠', '鼠聊天'],
    codeTerms: ['inboxMsg', 'inbox-msg', 'chat/c2c/inbox-msg'],
    boost: 85,
    pattern: /明明鼠聊天|明明鼠|鼠聊天|inbox-?msg/i,
  },
  {
    key: '私聊',
    aliases: ['聊天', '私聊首页', '私聊好友页面', '好友页面'],
    codeTerms: ['chat', 'c2c', 'friends'],
    boost: 70,
    pattern: /私聊|聊天|好友页面|好友页|chat|c2c|friends/i,
  },
  {
    key: '进房',
    aliases: ['进入房间', '进入语音房', '加入房间', '加入语音房', '入房', '房间'],
    codeTerms: ['joinRoom', 'enterRoom', 'JoinRoomWithAuth', 'EnterRoomAfter', 'room'],
    boost: 80,
    pattern: /进房|进入房|入房|join\s*room|enter\s*room/i,
  },
  {
    key: '退房',
    aliases: ['离房', '离开房间', '退出房间', '退语音房', '房间'],
    codeTerms: ['leaveRoom', 'exitRoom', 'LeaveRoom', 'room'],
    boost: 80,
    pattern: /退房|离房|退出房|leave\s*room|exit\s*room/i,
  },
  {
    key: '语音房',
    aliases: ['房间', '开黑房', '频道房间', '语音'],
    codeTerms: ['voiceRoom', 'voice_room', 'rtc', 'room', 'channelRoom'],
    boost: 70,
    pattern: /语音房|voice\s*room|voice_room/i,
  },
  {
    key: '登录',
    aliases: ['登陆', '授权', '鉴权', '账号登录'],
    codeTerms: ['login', 'auth', 'token', 'passport'],
    boost: 60,
    pattern: /登录|登陆|login/i,
  },
  {
    key: '支付',
    aliases: ['充值', '下单', '订单', '收银台'],
    codeTerms: ['pay', 'payment', 'order', 'cashier'],
    boost: 60,
    pattern: /支付|充值|下单|订单|pay|payment|order/i,
  },
  {
    key: 'IM',
    aliases: ['聊天', '会话', '消息', '私聊'],
    codeTerms: ['im', 'chat', 'message', 'conversation'],
    boost: 55,
    pattern: /\bim\b|聊天|会话|消息|私聊|chat|message/i,
  },
];

const FILLER_PATTERN = /帮我|请|看下|查下|搜下|查询下|搜索下|查一下|搜一下|查询一下|看一下|一下|下|的|和|与|相关|文档|调用示例|负责人|有哪些|是什么|干什么|怎么用|如何用|说明|定义/g;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendJsonl(filePath: string, value: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function readJsonl(filePath: string, limit = 200) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

export class BusinessSemanticService {
  normalize(value: string) {
    return value.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, '');
  }

  cleanKeyword(value: string, stopWords: string[] = []) {
    let keyword = String(value || '');
    for (const word of stopWords) {
      keyword = keyword.replace(new RegExp(escapeRegExp(word), 'ig'), ' ');
    }
    return keyword
      .replace(FILLER_PATTERN, ' ')
      .replace(/[，。！？、:：#]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  expandTerms(value: string) {
    const text = String(value || '');
    const terms: string[] = [];
    for (const term of BUSINESS_TERMS) {
      if (!term.pattern.test(text)) continue;
      terms.push(term.key, ...term.aliases, ...term.codeTerms);
    }
    return terms;
  }

  query(rawKeyword: string, stopWords: string[] = []): SemanticQuery {
    const cleaned = this.cleanKeyword(rawKeyword, stopWords);
    const pieces = [
      ...cleaned.split(/[\s,，/]+/),
      ...this.expandTerms(rawKeyword),
      ...this.expandTerms(cleaned),
    ];
    const tokens = Array.from(new Set([
      this.normalize(cleaned),
      ...pieces.map((item) => this.normalize(item)),
    ].filter((item) => item.length >= 1)));
    return { raw: rawKeyword, cleaned, tokens };
  }

  matches(text: string, query: SemanticQuery) {
    const normalized = this.normalize(text);
    return query.tokens.length > 0 && query.tokens.some((token) => normalized.includes(token));
  }

  score(text: string, query: SemanticQuery, fieldWeight = 1) {
    const normalized = this.normalize(text);
    const normalizedKeyword = this.normalize(query.cleaned || query.raw);
    let score = normalizedKeyword && normalized.includes(normalizedKeyword) ? normalizedKeyword.length * 8 : 0;
    for (const token of query.tokens) {
      if (normalized.includes(token)) score += Math.min(token.length, 20);
    }
    for (const term of BUSINESS_TERMS) {
      if (term.pattern.test(query.raw) || term.pattern.test(query.cleaned)) {
        const strongCodeTermMatched = term.codeTerms
          .filter((codeTerm) => this.normalize(codeTerm).length > 4)
          .some((codeTerm) => normalized.includes(this.normalize(codeTerm)));
        if (term.pattern.test(text) || strongCodeTermMatched) {
          score += term.boost;
        }
      }
    }
    return score * fieldWeight;
  }

  scoreFields(query: SemanticQuery, fields: Array<{ value: string; weight: number }>) {
    return fields.reduce((total, field) => total + this.score(field.value, query, field.weight), 0);
  }

  classifyKnowledgeIntent(content: string): KnowledgeIntent {
    if (/\b(?:get|set|open|close|show|hide|fetch|query|request|navigate|share)[A-Z][A-Za-z0-9_]{2,}\b/.test(content)
      && /(是什么|干什么|怎么用|如何用|入参|参数|返回|说明|定义|能力|调用)/i.test(content)) {
      return 'cross_platform';
    }
    if (/(跨端|js\s*sdk|jssdk|js\s*bridge|bridge|webview|hybrid|h5|universal\s*link|scheme).*(搜索|查询|查找|有哪些|能力|兼容)|(?:搜索|查询|查找|有哪些).*(跨端|js\s*sdk|jssdk|js\s*bridge|bridge|webview|hybrid|h5|universal\s*link|scheme)/i.test(content)) {
      return 'cross_platform';
    }
    if (/(跨端|js\s*sdk|jssdk|js\s*bridge|bridge|webview|hybrid|h5|universal\s*link|scheme)/i.test(content)
      && /(跳转|打开|获取|读取|唤起|分享|调用|页面|token|登录态|能力)/i.test(content)) {
      return 'cross_platform';
    }
    if (/(api|接口|后端服务|服务端).*(搜索|查询|查找|有哪些)|(?:搜索|查询|查找).*(api|接口|后端服务|服务端)/i.test(content)) {
      return 'api';
    }
    if (/(路由|route|页面跳转|deeplink|deep\s*link).*(搜索|查询|查找|打开|跳转|有哪些)|(?:搜索|查询|查找|打开|跳转).*(路由|route|页面跳转|deeplink|deep\s*link)/i.test(content)) {
      return 'route';
    }
    const datasetIntent = assistantCapabilityDatasetService.inferKnowledgeIntent(content);
    if (datasetIntent === 'route' || datasetIntent === 'cross_platform') return datasetIntent;

    if (/(带玩主页|带玩用户主页|陪玩主页|个人主页|用户主页|webview|下载页面|下载页|打开私聊|私聊首页|私聊好友页面|好友页面|明明鼠聊天|明明鼠|鼠聊天|活动页|活动页面|兑换页|口令兑换|cdk兑换|game\s*profile|game\/profile|personal\/profile|chat\/c2c|inbox-?msg|actives|redeem)/i.test(content)) {
      return 'route';
    }
    return undefined;
  }

  resolveAssistantAction(content: string, availableToolNames: string[]): AssistantSemanticAction | undefined {
    const toolSet = new Set(availableToolNames);
    const hasTool = (name: string) => toolSet.has(name);
    const buildNumber = this.extractBuildNumber(content);
    const uid = this.extractUid(content);
    const deviceId = this.extractDeviceId(content);
    const identifier = uid || deviceId;
    const appVersions = this.extractAppVersions(content);
    const period = this.extractPeriod(content);
    const historyId = this.extractNumericId(content, ['historyId', '历史']);
    const issueId = this.extractEntityId(content, ['issue', 'Issue']);
    const sentryIssueId = this.extractEntityId(content, ['sentry', 'Sentry', '崩溃', 'crash']);
    const workflowTaskId = this.extractEntityId(content, ['workflow', '任务', 'task']);
    const branch = this.extractBranch(content);

    if (buildNumber && /(交付诊断|交付链路|交付就绪|交付证据|缺哪些证据)/.test(content) && hasTool('workflow_delivery_readiness')) {
      return { toolName: 'workflow_delivery_readiness', args: { buildNumber: String(buildNumber) }, completionText: `已诊断构建 #${buildNumber} 的交付证据，请查看阻断项与下一步动作；正式发布仍需实时复核。` };
    }

    const feedbackLogIntent = /(反馈日志|用户.{0,20}日志|日志.{0,20}用户)/i.test(content)
      && !/(崩溃|crash|jenkins|构建|后端日志)/i.test(content);
    const explicitTimeRange = /(\d{4}[-/年]\d{1,2}|今天|昨天|前天|过去\s*\d+\s*(?:小时|天)|近\s*\d+\s*(?:小时|天))/i.test(content);
    const diagnosisIntent = /(排障|排查|诊断|定位|原因|根因|为什么|异常|问题|不一致|不一样|失败原因|闭环)/i.test(content);
    if (diagnosisIntent && (identifier || appVersions[0] || /(跨系统|全链路|关联)/i.test(content)) && hasTool('platform_cross_system_diagnosis') && /(跨系统|全链路|关联|Crash|crash|崩溃|日志|质检|构建|任务|用户|设备|版本)/i.test(content)) {
      return {
        toolName: 'platform_cross_system_diagnosis',
        args: {
          ...(uid ? { uid } : {}),
          ...(deviceId && !uid ? { deviceId } : {}),
          ...(buildNumber ? { buildNumber } : {}),
          ...(appVersions[0] ? { appVersion: appVersions[0] } : {}),
        },
        completionText: '已发起跨系统诊断，将关联 Crash、日志、构建、质检和质量中心证据。',
      };
    }

    if (uid && feedbackLogIntent && !explicitTimeRange && hasTool('logs_search')) {
      return { toolName: 'logs_search', args: { uid, limit: 10 }, completionText: `已查询用户 ${uid} 最新可用的反馈日志。` };
    }
    if ((uid || deviceId) && /(反馈日志|日志)/i.test(content) && hasTool('logs_search')) {
      return { toolName: 'logs_search', args: { ...(uid ? { uid } : { deviceId }), limit: 10 }, completionText: '已查询匹配的反馈日志。' };
    }

    if (identifier && /(崩溃|crash|sentry|闪退)/i.test(content) && hasTool('sentry_find_user_issues')) {
      return {
        toolName: 'sentry_find_user_issues',
        args: { identifier, identifierType: uid ? 'uid' : 'deviceId', period, limit: 20 },
        completionText: `已按${uid ? ' UID' : ' DeviceID'} 查询最近 Sentry 崩溃问题。`,
      };
    }
    if (sentryIssueId && /(上下文|详情|最新事件|原始日志|诊断上下文)/i.test(content) && hasTool('sentry_get_issue_context')) {
      return { toolName: 'sentry_get_issue_context', args: { issueId: sentryIssueId }, completionText: `已读取 Sentry Issue ${sentryIssueId} 的诊断上下文。` };
    }
    if (/(crash|崩溃|闪退).*(对比|比较)|(对比|比较).*(crash|崩溃|闪退)/i.test(content) && appVersions.length >= 2 && hasTool('crash_compare_versions')) {
      return { toolName: 'crash_compare_versions', args: { versionA: appVersions[0], versionB: appVersions[1], period }, completionText: `已对比 ${appVersions[0]} 与 ${appVersions[1]} 的 Crash 趋势。` };
    }
    if (historyId && /(分析|AI|根因)/i.test(content) && hasTool('crash_analyze_history')) {
      return { toolName: 'crash_analyze_history', args: { historyId }, completionText: `已准备分析 Crash 历史 #${historyId}。` };
    }
    if (historyId && /(历史|history|详情|日志)/i.test(content) && hasTool('crash_get_history')) {
      return { toolName: 'crash_get_history', args: { historyId }, completionText: `已读取 Crash 历史 #${historyId}。` };
    }
    if (/(crash|崩溃|闪退).*(历史|记录|列表)|(?:历史|记录|列表).*(crash|崩溃|闪退)/i.test(content) && hasTool('crash_list_history')) {
      return { toolName: 'crash_list_history', args: { ...(appVersions[0] ? { version: appVersions[0] } : {}), limit: 20 }, completionText: '已查询 Crash 符号化历史。' };
    }
    if (/(上传|附件|本次).*(符号化|symbolicate)|(?:符号化|symbolicate).*(附件|上传|本次)/i.test(content) && hasTool('crash_symbolicate_attachment')) {
      const attachmentId = this.extractEntityId(content, ['attachmentId', '附件']);
      if (attachmentId) return { toolName: 'crash_symbolicate_attachment', args: { attachmentId }, completionText: '已准备符号化会话附件。' };
    }
    const uuid = content.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0];
    if (/(dsym|符号表|符号化|uuid)/i.test(content) && (uuid || appVersions[0]) && hasTool('dsym_diagnose_missing')) {
      return { toolName: 'dsym_diagnose_missing', args: { ...(uuid ? { uuid } : {}), ...(appVersions[0] ? { appVersion: appVersions[0] } : {}) }, completionText: '已诊断 dSYM 库存与匹配情况。' };
    }
    if (/(sentry|线上|crash|崩溃|闪退).*(最近|新增|列表|查询|查看)|(?:最近|新增|列表|查询|查看).*(sentry|线上|crash|崩溃|闪退)/i.test(content) && hasTool('sentry_list_issues')) {
      return { toolName: 'sentry_list_issues', args: { period, limit: 10, ...(this.extractFreeKeyword(content, ['sentry', '线上', 'crash', '崩溃', '闪退', '最近', '新增', '列表', '查询', '查看']) ? { query: this.extractFreeKeyword(content, ['sentry', '线上', 'crash', '崩溃', '闪退', '最近', '新增', '列表', '查询', '查看']) } : {}) }, completionText: '已查询最近线上 Crash Issue。' };
    }

    if (/(日报|质量情况|今日质量|最近质量|质量汇总)/i.test(content) && hasTool('quality_daily_report')) {
      return { toolName: 'quality_daily_report', args: { hours: this.extractHours(content) || 24 }, completionText: '已生成移动端质量日报。' };
    }
    if (/(最近|列表|查询|查看).*(构建|jenkins|打包)|(?:构建|jenkins|打包).*(最近|列表)/i.test(content) && !/日志|失败原因|分析|验证|状态/.test(content) && hasTool('cicd_list_builds')) {
      return { toolName: 'cicd_list_builds', args: { limit: 10 }, completionText: '已查询最近 Jenkins 主工程构建。' };
    }
    if (buildNumber && /(停止|终止|取消|中止).*(构建|jenkins|打包)|(?:构建|jenkins|打包).*(停止|终止|取消|中止)/i.test(content) && hasTool('cicd_stop_build')) {
      return { toolName: 'cicd_stop_build', args: { buildNumber }, completionText: `已准备停止构建 #${buildNumber}。` };
    }
    if (buildNumber && /(重试|重跑|重新构建|重新打包).*(构建|jenkins|打包)|(?:构建|jenkins|打包).*(重试|重跑|重新构建|重新打包)/i.test(content) && hasTool('cicd_retry_build')) {
      return { toolName: 'cicd_retry_build', args: { buildNumber }, completionText: `已准备重试构建 #${buildNumber}。` };
    }
    if (buildNumber && /(构建|jenkins|打包).*(日志|console|控制台)|(?:日志|console|控制台).*(构建|jenkins|打包)/i.test(content) && hasTool('cicd_get_build_log')) {
      return { toolName: 'cicd_get_build_log', args: { buildNumber }, completionText: `已读取构建 #${buildNumber} 的控制台日志。` };
    }
    if (buildNumber && /(失败|报错|错误|根因|原因|分析|定位)/i.test(content) && /(构建|jenkins|打包)/i.test(content) && hasTool('cicd_analyze_build_failure')) {
      return { toolName: 'cicd_analyze_build_failure', args: { buildNumber }, completionText: `已分析构建 #${buildNumber} 的失败原因。` };
    }
    if (buildNumber && /(验证|状态|是否成功|是否完成|结果)/i.test(content) && /(构建|jenkins|打包|质检)/i.test(content) && hasTool('cicd_verify_build')) {
      return { toolName: 'cicd_verify_build', args: { buildNumber, jobType: /质检|quality/i.test(content) ? 'quality' : 'cicd' }, completionText: `已验证任务 #${buildNumber} 的最新状态。` };
    }
    const deployTarget = this.extractDeployTarget(content);
    if (branch && deployTarget && buildNumber && /(发布|提审|test\s*flight|app\s*store|苹果商店)/i.test(content) && hasTool('cicd_trigger_release')) {
      return { toolName: 'cicd_trigger_release', args: { branch, deployTarget, gateBuildNumber: buildNumber }, completionText: `已准备发布 ${branch} 到 ${deployTarget}。` };
    }
    if (branch && /(发包|打包|出包|构建|发布)/i.test(content) && !/(查询|查看|历史|最近|列表|状态|日志|详情|test\s*flight|app\s*store|苹果商店)/i.test(content) && hasTool('cicd_trigger_build')) {
      return { toolName: 'cicd_trigger_build', args: { branch }, completionText: `已提交 ${branch} 分支的 Pgyer 构建任务，可继续跟踪构建状态。` };
    }

    if (/(最近|列表|查询|查看).*(质检|自动化测试|quality)|(?:质检|自动化测试|quality).*(最近|列表)/i.test(content) && hasTool('quality_list_tasks')) {
      return { toolName: 'quality_list_tasks', args: { limit: 10 }, completionText: '已查询最近自动质检任务。' };
    }
    if (buildNumber && /(停止|终止|取消|中止).*(质检|自动化测试|quality)|(?:质检|自动化测试|quality).*(停止|终止|取消|中止)/i.test(content) && hasTool('quality_stop_task')) {
      return { toolName: 'quality_stop_task', args: { buildNumber }, completionText: `已准备停止质检任务 #${buildNumber}。` };
    }
    if (buildNumber && /(重跑|重试|重新执行).*(质检|自动化测试|quality)|(?:质检|自动化测试|quality).*(重跑|重试|重新执行)/i.test(content) && hasTool('quality_retry_task')) {
      return { toolName: 'quality_retry_task', args: { buildNumber }, completionText: `已准备重跑质检任务 #${buildNumber}。` };
    }
    if (buildNumber && /(创建|发起|启动|跑|执行).*(质检|自动化测试|smoke|monkey|卡顿|登录|IM|RTC)/i.test(content) && hasTool('quality_create_task')) {
      return { toolName: 'quality_create_task', args: { sourceBuildNumber: buildNumber, suite: this.extractQualitySuite(content) }, completionText: `已准备基于构建 #${buildNumber} 创建质检任务。` };
    }

    if (/(质量中心|workflow).*(概览|总览|首页|最新)|(?:概览|总览).*(质量中心|workflow)/i.test(content) && hasTool('workflow_overview')) {
      return { toolName: 'workflow_overview', args: {}, completionText: '已读取质量中心概览。' };
    }
    if (issueId && /(详情|上下文|关系|事件|读取)/i.test(content) && hasTool('workflow_get_issue')) {
      return { toolName: 'workflow_get_issue', args: { issueId }, completionText: `已读取质量 Issue ${issueId} 详情。` };
    }
    if (/(issue|问题).*(列表|查询|查看|高风险|未关闭|阻塞)|(?:列表|查询|查看|高风险|未关闭|阻塞).*(issue|问题)/i.test(content) && hasTool('workflow_list_issues')) {
      return { toolName: 'workflow_list_issues', args: { limit: 20, ...(this.extractSeverity(content) ? { severity: this.extractSeverity(content) } : {}), ...(this.extractStatus(content) ? { status: this.extractStatus(content) } : {}) }, completionText: '已查询质量中心 Issue。' };
    }
    if (/(任务|task).*(列表|查询|查看|回归|构建|质检)|(?:列表|查询|查看).*(任务|task)/i.test(content) && hasTool('workflow_list_tasks')) {
      return { toolName: 'workflow_list_tasks', args: { limit: 20, ...(this.extractStatus(content) ? { status: this.extractStatus(content) } : {}) }, completionText: '已查询质量中心任务。' };
    }
    if (workflowTaskId && /(验证|是否完成|是否通过|状态)/i.test(content) && hasTool('workflow_verify_task')) {
      return { toolName: 'workflow_verify_task', args: { taskId: workflowTaskId }, completionText: `已验证 Workflow 任务 ${workflowTaskId}。` };
    }
    if (buildNumber && /(门禁|发布检查|release gate|质量门禁|预览)/i.test(content) && hasTool('workflow_release_gate_preview')) {
      return { toolName: 'workflow_release_gate_preview', args: { buildNumber: String(buildNumber), ...(branch ? { branch } : {}), ...(appVersions[0] ? { appVersion: appVersions[0] } : {}) }, completionText: `已预览构建 #${buildNumber} 的发布质量门禁。` };
    }
    if (appVersions[0] && /(发布后|线上健康|版本健康|健康度|release health)/i.test(content) && hasTool('workflow_verify_release_health')) {
      return { toolName: 'workflow_verify_release_health', args: { releaseVersion: appVersions[0] }, completionText: `已验证版本 ${appVersions[0]} 发布后健康度。` };
    }
    if (workflowTaskId && /(跟踪|状态|进度|是否完成|验证)/i.test(content) && hasTool('task_track')) {
      return { toolName: 'task_track', args: { taskType: /质检|quality/i.test(content) ? 'quality' : /构建|jenkins|build/i.test(content) ? 'build' : 'workflow', id: workflowTaskId }, completionText: `已跟踪任务 ${workflowTaskId} 的最新状态。` };
    }
    if (issueId && /(回归候选|转回归|生成回归|回归用例)/i.test(content) && hasTool('workflow_create_regression_candidate')) {
      return { toolName: 'workflow_create_regression_candidate', args: { issueId }, completionText: `已准备将 Issue ${issueId} 转为回归候选。` };
    }
    const candidateId = this.extractEntityId(content, ['candidate', '候选']);
    if (candidateId && /(xcuitest|ui\s*test|自动化代码|生成测试)/i.test(content) && hasTool('workflow_generate_xcuitest')) {
      return { toolName: 'workflow_generate_xcuitest', args: { candidateId }, completionText: `已准备为回归候选 ${candidateId} 生成 XCUITest。` };
    }
    if (/(变更影响|影响分析|改动影响|diff|base|head)/i.test(content) && hasTool('workflow_change_impact')) {
      const refs = this.extractRefs(content);
      return { toolName: 'workflow_change_impact', args: refs, completionText: '已准备执行变更影响分析。' };
    }

    if (/(能力目录|服务能力|平台能力|能做什么|可以做什么|支持什么|有哪些能力|能力清单|查询能力)/i.test(content) && hasTool('assistant_capability_search')) {
      const keyword = this.cleanKeyword(content, ['AI', 'ai', '会话', '执行中心', '能力目录', '服务能力', '平台能力', '能做什么', '可以做什么', '支持什么', '有哪些能力', '能力清单', '查询能力']);
      return {
        toolName: 'assistant_capability_search',
        args: {
          keyword,
          limit: 30,
        },
        completionText: '已查询 AI 会话执行中心的全服务能力目录。',
      };
    }

    const knowledgeIntent = this.classifyKnowledgeIntent(content);
    if (knowledgeIntent === 'cross_platform' && hasTool('cross_platform_search')) {
      return { toolName: 'cross_platform_search', args: { keyword: this.extractKeyword(content, ['app', '跨端能力', '跨端', '能力', 'js sdk', 'jssdk', 'jsbridge', 'bridge', 'webview', 'hybrid', 'h5', 'universal link', 'scheme', '路由', 'route', '页面跳转', 'deeplink', 'deep link', '搜索', '查询', '查找', '有哪些', '兼容', '入口']), limit: 30 }, completionText: '已提取相关跨端能力说明。' };
    }
    if (knowledgeIntent === 'api' && hasTool('api_search')) {
      return { toolName: 'api_search', args: { keyword: this.extractKeyword(content, ['api', '接口', '后端服务', '服务端', '搜索', '查询', '查找', '有哪些']), limit: 30 }, completionText: '已搜索相关 API 文档。' };
    }
    if (knowledgeIntent === 'route' && hasTool('routes_search')) {
      return { toolName: 'routes_search', args: { keyword: this.extractKeyword(content, ['app', '路由', 'route', '页面跳转', 'deeplink', 'deep link', 'jsbridge', 'bridge', 'webview', 'hybrid', 'h5', '搜索', '查询', '查找', '有哪些', '入口']), limit: 30 }, completionText: '已提取相关路由能力说明。' };
    }

    const podName = this.extractPodName(content);
    if (podName && /(影响|依赖|升级|版本|范围|分析)/i.test(content) && hasTool('pods_analyze_impact')) {
      return { toolName: 'pods_analyze_impact', args: { name: podName, ...(appVersions[0] ? { version: appVersions[0] } : {}) }, completionText: `已分析 ${podName} 的依赖影响范围。` };
    }
    return undefined;
  }

  extractKeyword(content: string, stopWords: string[]) {
    const keyword = this.cleanKeyword(content, stopWords);
    return keyword || String(content || '').slice(0, 80);
  }

  extractBuildNumber(content: string) {
    const match = content.match(/(?:构建|build|jenkins|打包|任务|#)\s*#?\s*(\d{2,8})/i) || content.match(/#\s*(\d{2,8})/);
    return match ? Number(match[1]) : undefined;
  }

  extractUid(content: string) {
    return content.match(/(?:用户|uid|UID)\s*[:：#]?\s*(\d{6,12})/i)?.[1] || (/^\d{6,12}$/.test(content.trim()) ? content.trim() : undefined);
  }

  extractDeviceId(content: string) {
    return content.match(/(?:deviceId|deviceID|设备\s*ID|设备)\s*[:：#]?\s*([A-Za-z0-9._:-]{6,80})/i)?.[1];
  }

  extractNumericId(content: string, labels: string[]) {
    for (const label of labels) {
      const match = content.match(new RegExp(`${escapeRegExp(label)}\\s*[:：#]?\\s*(\\d{1,10})`, 'i'));
      if (match) return Number(match[1]);
    }
    return undefined;
  }

  extractEntityId(content: string, labels: string[]) {
    for (const label of labels) {
      const match = content.match(new RegExp(`${escapeRegExp(label)}\\s*[:：#]?\\s*([A-Za-z0-9._:-]{2,120})`, 'i'));
      if (match) return match[1];
    }
    return undefined;
  }

  extractBranch(content: string) {
    return content.match(/(?:origin\/)?(develop|master|main|(?:release|feature|hotfix|bugfix)\/[A-Za-z0-9._/-]+)/i)?.[1];
  }

  extractDeployTarget(content: string): 'Pgyer' | 'TestFlight' | 'AppStore' | undefined {
    if (/app\s*store|苹果商店|商店包/i.test(content)) return 'AppStore';
    if (/test\s*flight|tf/i.test(content)) return 'TestFlight';
    if (/pgyer|蒲公英/i.test(content)) return 'Pgyer';
    return undefined;
  }

  extractSeverity(content: string) {
    if (/critical|严重|致命|阻塞/i.test(content)) return 'critical';
    if (/high|高风险|高危/i.test(content)) return 'high';
    if (/medium|中风险/i.test(content)) return 'medium';
    if (/low|低风险/i.test(content)) return 'low';
    return undefined;
  }

  extractStatus(content: string) {
    if (/未关闭|打开|待处理|open/i.test(content)) return 'open';
    if (/已关闭|完成|closed|done|completed/i.test(content)) return 'closed';
    if (/失败|failed|failure/i.test(content)) return 'failed';
    if (/运行中|执行中|running/i.test(content)) return 'running';
    return undefined;
  }

  extractRefs(content: string) {
    const baseRef = content.match(/base(?:Ref)?\s*[:：=]\s*([A-Za-z0-9._/-]+)/i)?.[1];
    const headRef = content.match(/head(?:Ref)?\s*[:：=]\s*([A-Za-z0-9._/-]+)/i)?.[1];
    const repoPath = content.match(/repo(?:Path)?\s*[:：=]\s*([^\s，。]+)/i)?.[1];
    return { ...(repoPath ? { repoPath } : {}), ...(baseRef ? { baseRef } : {}), ...(headRef ? { headRef } : {}) };
  }

  extractFreeKeyword(content: string, stopWords: string[]) {
    const keyword = this.extractKeyword(content, stopWords);
    return keyword.length >= 2 ? keyword : '';
  }

  extractPodName(content: string) {
    return content.match(/(?:pod|pods|组件|库)\s*[:：#]?\s*([A-Za-z][A-Za-z0-9_.-]{2,80})/i)?.[1]
      || content.match(/\b([A-Z][A-Za-z0-9_.-]{2,80})\b/)?.[1];
  }

  extractAppVersions(content: string) {
    return Array.from(new Set((content.match(/\b\d+\.\d+(?:\.\d+)?(?:\.\d+)?\b/g) || []).slice(0, 4)));
  }

  extractPeriod(content: string): '24h' | '7d' | '14d' {
    if (/14\s*天|两周|2\s*周|14d/i.test(content)) return '14d';
    if (/7\s*天|一周|1\s*周|7d|最近/i.test(content)) return '7d';
    return '24h';
  }

  extractHours(content: string) {
    const hourMatch = content.match(/(?:过去|近|最近)?\s*(\d{1,3})\s*(?:小时|h)/i);
    if (hourMatch) return Math.min(168, Math.max(1, Number(hourMatch[1])));
    const dayMatch = content.match(/(?:过去|近|最近)?\s*(\d{1,2})\s*天/i);
    if (dayMatch) return Math.min(168, Math.max(1, Number(dayMatch[1]) * 24));
    if (/今天|今日/.test(content)) return 24;
    return undefined;
  }

  extractQualitySuite(content: string) {
    if (/monkey/i.test(content)) return 'monkey';
    if (/卡顿|stutter/i.test(content)) return 'stutter';
    if (/登录|login/i.test(content)) return 'login';
    if (/\bim\b|聊天/i.test(content)) return 'im';
    if (/\brtc\b|音视频|房间/i.test(content)) return 'rtc';
    if (/全量|full/i.test(content)) return 'full';
    return 'smoke';
  }

  recordSearchMiss(input: SearchMissInput) {
    try {
      appendJsonl(searchMissesFile(), {
        ...input,
        productLineId: input.productLineId || currentProductLineId(),
        createdAt: new Date().toISOString(),
      });
    } catch {
      // 语义反哺记录失败不能影响主查询链路。
    }
  }

  recordAssistantResolution(input: AssistantResolutionInput) {
    try {
      appendJsonl(resolutionsFile(), {
        ...input,
        rawInput: String(input.rawInput || '').slice(0, 1000),
        productLineId: input.productLineId || currentProductLineId(),
        createdAt: new Date().toISOString(),
      });
    } catch {
      // 语义观测记录失败不能影响主会话链路。
    }
  }

  semanticStats(limit = 50) {
    const resolutions = readJsonl(resolutionsFile(), 1000);
    const misses = readJsonl(searchMissesFile(), 1000);
    const toolCounts = new Map<string, number>();
    for (const item of resolutions) {
      if (item.toolName) toolCounts.set(item.toolName, (toolCounts.get(item.toolName) || 0) + 1);
    }
    return {
      totals: {
        resolutions: resolutions.length,
        deterministic: resolutions.filter((item) => item.mode === 'deterministic').length,
        modelFallback: resolutions.filter((item) => item.mode === 'model_fallback').length,
        searchMisses: misses.length,
      },
      topTools: Array.from(toolCounts.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 20)
        .map(([toolName, count]) => ({ toolName, count })),
      recentResolutions: resolutions.slice(-limit).reverse(),
      recentSearchMisses: misses.slice(-limit).reverse(),
    };
  }
}

export const businessSemanticService = new BusinessSemanticService();
