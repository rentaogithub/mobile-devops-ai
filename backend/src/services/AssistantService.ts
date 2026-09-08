import { AssistantInputMessage, AssistantModelResult, AssistantModelState, assistantModelGateway } from './AssistantModelGateway';
import { assistantAuditService } from './AssistantAuditService';
import { AssistantTool, AssistantToolContext, assistantToolRegistry } from './AssistantToolRegistry';
import { PlatformUser } from './AuthService';
import { currentProjectId } from './ProductLineContext';

export interface AssistantEvent {
  type: 'assistant.delta' | 'tool.proposed' | 'tool.started' | 'tool.progress' | 'tool.completed' | 'tool.failed' | 'assistant.completed';
  [key: string]: unknown;
}

interface PendingAction {
  id: string;
  userId: string;
  projectId: string;
  tool: AssistantTool;
  args: Record<string, unknown>;
  callId: string;
  state: AssistantModelState;
  approvalCount: number;
  expiresAt: number;
}

const MAX_ITERATIONS = 8;
const ACTION_TTL_MS = 15 * 60 * 1000;
const SENSITIVE_KEY = /password|token|secret|authorization|cookie|api[_-]?key/i;

function redactSensitiveText(value: string) {
  return value
    .replace(
      /(\bauthorization\b\s*[:=]\s*)(?:Bearer\s+)?[A-Za-z0-9._~+/=-]+/gi,
      '$1[redacted]',
    )
    .replace(
      /(\b(?:access[_-]?token|refresh[_-]?token|token|cookie|password|passwd|secret|api[_-]?key)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,&\s}\]]+)/gi,
      '$1[redacted]',
    )
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]');
}

export function sanitizeToolOutput(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') {
    const redacted = redactSensitiveText(value);
    return redacted.length > 20_000 ? `${redacted.slice(0, 20_000)}…` : redacted;
  }
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => sanitizeToolOutput(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeToolOutput(item, depth + 1),
    ]));
  }
  return value;
}

export class AssistantService {
  private readonly pending = new Map<string, PendingAction>();

  capabilities(user: PlatformUser) {
    return assistantToolRegistry.listForUser(user).map((tool) => ({
      name: tool.name,
      domain: tool.domain,
      description: tool.description,
      role: tool.role,
      riskLevel: tool.riskLevel,
      approvalsRequired: tool.approvalsRequired,
    }));
  }

  async turn(user: PlatformUser, rawMessages: unknown, emit: (event: AssistantEvent) => void) {
    const messages = this.normalizeMessages(rawMessages);
    const tools = assistantToolRegistry.listForUser(user);
    if (tools.length === 0) throw new Error('当前账号没有可用能力');
    let result: AssistantModelResult;
    try {
      result = await assistantModelGateway.start(messages, tools);
    } catch (error: any) {
      this.emitGuidance(user, messages, tools, emit, error);
      return;
    }
    await this.processModelResult(user, result, emit, 0);
  }

  async decide(
    user: PlatformUser,
    actionId: string,
    decision: 'approve' | 'reject',
    emit: (event: AssistantEvent) => void,
    secretInputs: Record<string, unknown> = {},
  ) {
    this.cleanupExpired();
    const pending = this.pending.get(actionId);
    if (!pending || pending.userId !== user.id || pending.projectId !== currentProjectId()) throw new Error('待确认操作不存在、已过期或不属于当前产品线');
    if (decision === 'reject') {
      this.pending.delete(actionId);
      assistantAuditService.update(actionId, { status: 'rejected', completed: true });
      emit({ type: 'tool.completed', actionId, toolName: pending.tool.name, status: 'rejected' });
      const result = await assistantModelGateway.continue(pending.state, pending.callId, { status: 'rejected_by_user' }, assistantToolRegistry.listForUser(user));
      await this.processModelResult(user, result, emit, 0);
      return;
    }

    const secretDefinitions = pending.tool.secretInputs?.(pending.args) || [];
    const isFinalApproval = pending.approvalCount + 1 >= pending.tool.approvalsRequired;
    if (isFinalApproval) {
      const missing = secretDefinitions.filter((field) => field.required && !String(secretInputs[field.name] || '').trim());
      if (missing.length > 0) {
        emit({
          type: 'tool.proposed', actionId, toolName: pending.tool.name, domain: pending.tool.domain,
          riskLevel: pending.tool.riskLevel, preview: assistantAuditService.get(actionId)?.preview,
          confirmationStep: pending.approvalCount + 1, confirmationsRequired: pending.tool.approvalsRequired,
          secretInputs: secretDefinitions, message: `请填写：${missing.map((field) => field.label).join('、')}`,
        });
        emit({ type: 'assistant.completed', status: 'awaiting_confirmation', actionId });
        return;
      }
    }

    pending.approvalCount += 1;
    assistantAuditService.update(actionId, { status: 'awaiting_confirmation', approvalCount: pending.approvalCount });
    if (pending.approvalCount < pending.tool.approvalsRequired) {
      emit({
        type: 'tool.proposed', actionId, toolName: pending.tool.name, domain: pending.tool.domain,
        riskLevel: pending.tool.riskLevel, preview: assistantAuditService.get(actionId)?.preview,
        confirmationStep: pending.approvalCount + 1, confirmationsRequired: pending.tool.approvalsRequired,
        secretInputs: secretDefinitions,
      });
      return;
    }

    this.pending.delete(actionId);
    const executionArgs = { ...pending.args };
    for (const field of secretDefinitions) {
      const value = String(secretInputs[field.name] || '');
      if (value) executionArgs[field.name] = value;
    }
    const output = await this.executeAudited(actionId, pending.tool, executionArgs, { user }, emit);
    const result = await assistantModelGateway.continue(pending.state, pending.callId, output, assistantToolRegistry.listForUser(user));
    await this.processModelResult(user, result, emit, 0);
  }

  cancel(user: PlatformUser, actionId: string) {
    this.cleanupExpired();
    const pending = this.pending.get(actionId);
    if (!pending || pending.userId !== user.id || pending.projectId !== currentProjectId()) throw new Error('待确认操作不存在、已过期或不属于当前产品线');
    this.pending.delete(actionId);
    return assistantAuditService.update(actionId, { status: 'canceled', completed: true });
  }

  private async processModelResult(user: PlatformUser, initial: AssistantModelResult, emit: (event: AssistantEvent) => void, iteration: number): Promise<void> {
    if (iteration >= MAX_ITERATIONS) throw new Error('Agent 连续工具调用次数超过安全限制');
    if (initial.text) this.emitText(initial.text, emit);
    const call = initial.calls[0];
    if (!call) {
      emit({ type: 'assistant.completed', status: 'completed' });
      return;
    }

    const tool = assistantToolRegistry.assertAllowed(call.name, user);
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      throw new Error(`工具 ${call.name} 参数不是合法 JSON`);
    }
    assistantToolRegistry.validate(tool, args);
    const context = { user };
    assistantToolRegistry.assertExecutable(tool, args, context);
    const preview = tool.preview ? await tool.preview(args, context) : { title: tool.description };
    const idempotencyKey = tool.idempotent ? assistantAuditService.idempotencyKey(user, tool.name, args) : undefined;

    if (idempotencyKey) {
      const previous = assistantAuditService.findRecentDuplicate(idempotencyKey);
      if (previous) {
        const duplicateResult = previous.status === 'completed'
          ? previous.result
          : { status: 'already_in_progress', actionId: previous.id, actionStatus: previous.status };
        emit({ type: 'tool.completed', actionId: previous.id, toolName: tool.name, status: 'deduplicated', result: duplicateResult });
        const availableTools = assistantToolRegistry.listForUser(user);
        const next = await this.continueModelOrGuide(user, this.latestMessagesFromState(initial.state), availableTools, initial.state, call.callId, duplicateResult, emit);
        if (!next) return;
        await this.processModelResult(user, next, emit, iteration + 1);
        return;
      }
    }

    const audit = assistantAuditService.create({
      user, toolName: tool.name, domain: tool.domain, riskLevel: tool.riskLevel,
      status: tool.approvalsRequired ? 'awaiting_confirmation' : 'created', arguments: args,
      preview, approvalsRequired: tool.approvalsRequired, idempotencyKey,
    });
    if (!audit) throw new Error('创建操作审计失败');

    if (tool.approvalsRequired > 0) {
      this.pending.set(audit.id, {
        id: audit.id, userId: user.id, projectId: currentProjectId(), tool, args, callId: call.callId, state: initial.state,
        approvalCount: 0, expiresAt: Date.now() + ACTION_TTL_MS,
      });
      emit({
        type: 'tool.proposed', actionId: audit.id, toolName: tool.name, domain: tool.domain,
        riskLevel: tool.riskLevel, preview, confirmationStep: 1, confirmationsRequired: tool.approvalsRequired,
        secretInputs: tool.secretInputs?.(args) || [],
        expiresAt: new Date(Date.now() + ACTION_TTL_MS).toISOString(),
      });
      emit({ type: 'assistant.completed', status: 'awaiting_confirmation', actionId: audit.id });
      return;
    }

    const output = await this.executeAudited(audit.id, tool, args, context, emit);
    const availableTools = assistantToolRegistry.listForUser(user);
    const next = await this.continueModelOrGuide(user, this.latestMessagesFromState(initial.state), availableTools, initial.state, call.callId, output, emit);
    if (!next) return;
    await this.processModelResult(user, next, emit, iteration + 1);
  }

  private async executeAudited(actionId: string, tool: AssistantTool, args: Record<string, unknown>, context: AssistantToolContext, emit: (event: AssistantEvent) => void) {
    const startedAt = Date.now();
    assistantAuditService.update(actionId, { status: 'running' });
    emit({ type: 'tool.started', actionId, toolName: tool.name, domain: tool.domain });
    emit({ type: 'tool.progress', actionId, toolName: tool.name, progress: 10, message: '已通过权限和参数校验' });
    try {
      const rawResult = await this.withTimeout(Promise.resolve(tool.execute(args, context)), tool.timeoutMs);
      const result = sanitizeToolOutput(rawResult);
      const durationMs = Date.now() - startedAt;
      assistantAuditService.update(actionId, { status: 'completed', result, durationMs, completed: true });
      emit({ type: 'tool.progress', actionId, toolName: tool.name, progress: 100, message: '执行完成' });
      emit({ type: 'tool.completed', actionId, toolName: tool.name, domain: tool.domain, status: 'completed', result });
      return result;
    } catch (error: any) {
      const durationMs = Date.now() - startedAt;
      assistantAuditService.update(actionId, { status: 'failed', error: error?.message || String(error), durationMs, completed: true });
      emit({ type: 'tool.failed', actionId, toolName: tool.name, domain: tool.domain, error: error?.message || String(error) });
      return { status: 'failed', error: error?.message || String(error) };
    }
  }

  private normalizeMessages(raw: unknown): AssistantInputMessage[] {
    if (!Array.isArray(raw)) throw new Error('messages 必须是数组');
    return raw.slice(-20).map((item: any): AssistantInputMessage => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: String(item?.content || '').trim().slice(0, 8_000),
    })).filter((item) => item.content);
  }

  private emitText(value: string, emit: (event: AssistantEvent) => void) {
    const text = value.slice(0, 20_000);
    for (let index = 0; index < text.length; index += 24) {
      emit({ type: 'assistant.delta', delta: text.slice(index, index + 24) });
    }
  }

  private async continueModelOrGuide(
    user: PlatformUser,
    messages: AssistantInputMessage[],
    tools: AssistantTool[],
    state: AssistantModelState,
    callId: string,
    output: unknown,
    emit: (event: AssistantEvent) => void,
  ) {
    try {
      return await assistantModelGateway.continue(state, callId, output, tools);
    } catch (error: any) {
      this.emitGuidance(user, messages, tools, emit, error);
      return undefined;
    }
  }

  private latestMessagesFromState(state: AssistantModelState): AssistantInputMessage[] {
    if (state.style !== 'chat_completions') return [];
    return state.messages
      .filter((message) => message?.role === 'user' || message?.role === 'assistant')
      .map((message): AssistantInputMessage => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content || ''),
      }))
      .filter((message) => message.content);
  }

  private emitGuidance(user: PlatformUser, messages: AssistantInputMessage[], tools: AssistantTool[], emit: (event: AssistantEvent) => void, error?: any) {
    const latestInput = String([...messages].reverse().find((message) => message.role === 'user')?.content || '').trim();
    const suggestions = this.guidanceSuggestions(tools, user.role);
    emit({
      type: 'tool.completed',
      toolName: 'assistant_guidance',
      domain: 'platform',
      status: 'completed',
      result: {
        kind: 'assistant_guidance',
        title: '我还没匹配到明确的平台能力',
        summary: latestInput
          ? `这句话暂时没有稳定匹配到可执行能力：${latestInput}`
          : '这次输入暂时没有稳定匹配到可执行能力。',
        hints: [
          '可以补充对象类型，例如 UID、构建号、版本号、Issue ID、API 名称或 JSBridge 方法名。',
          '可以加上动作，例如查询、分析、对比、验证、创建、重跑、发布。',
          '跨端能力可以直接说“获取 token 的 jsbridge”或“跳转到其它 H5 页面”。',
        ],
        suggestions,
        reason: this.friendlyModelError(error),
      },
    });
    emit({ type: 'assistant.completed', status: 'completed' });
  }

  private guidanceSuggestions(tools: AssistantTool[], role: PlatformUser['role']) {
    const toolNames = new Set(tools.map((tool) => tool.name));
    const toolDomains = new Set(tools.map((tool) => tool.domain));
    const suggestions = [
      { text: '查看 AI 会话执行中心有哪些能力', toolName: 'assistant_capability_search' },
      { text: '查询平台已同步的服务能力目录', toolName: 'assistant_capability_search' },
      { text: '查询获取 token 的 jsbridge', toolName: 'cross_platform_search' },
      { text: 'getCommunityChannelInfo 是什么', toolName: 'cross_platform_search' },
      { text: '跳转到其它 H5 页面的能力', toolName: 'cross_platform_search' },
      { text: '搜索登录相关 API 定义和使用', toolName: 'api_search' },
      { text: '搜索社区频道相关 API 定义', toolName: 'api_search' },
      { text: '查询打开私聊页面的路由说明', toolName: 'routes_search' },
      { text: '查询社区大厅闲聊的路由定义', toolName: 'routes_search' },
      { text: '查询 UID 131088950 最近的 Sentry 崩溃', toolName: 'sentry_find_user_issues' },
      { text: '查询最近 24 小时新增线上 Crash', toolName: 'sentry_list_issues' },
      { text: '查询用户 131088950 的最近反馈日志', toolName: 'logs_search' },
      { text: '查看质量中心概览、最新任务和最新问题', toolName: 'workflow_overview' },
      { text: '诊断构建 #12345 的交付链路，还缺哪些证据', toolName: 'workflow_delivery_readiness' },
      { text: '查询质量中心高风险未关闭 Issue', toolName: 'workflow_list_issues' },
      { text: '查询最近 Jenkins 主工程构建', toolName: 'cicd_list_builds' },
      { text: '分析构建 #12345 失败原因', toolName: 'cicd_analyze_build_failure' },
      { text: '生成过去 24 小时移动端质量日报', toolName: 'quality_daily_report', roles: ['tester', 'developer', 'admin'] },
      { text: '分析 NNRtc 组件升级影响范围', toolName: 'pods_analyze_impact', domains: ['pods'] },
    ];
    return this.sampleSuggestions(suggestions
      .filter((item) => (toolNames.has(item.toolName) || item.domains?.some((domain) => toolDomains.has(domain as any)))
        && (!item.roles || item.roles.includes(role)))
      .map((item) => item.text), 6);
  }

  private sampleSuggestions(items: string[], limit: number) {
    return Array.from(new Set(items))
      .map((text) => ({ text, sort: Math.random() }))
      .sort((left, right) => left.sort - right.sort)
      .slice(0, limit)
      .map((item) => item.text);
  }

  private friendlyModelError(error?: any) {
    const message = String(error?.message || error || '');
    if (!message) return undefined;
    if (/status code 5\d\d|HTTP\s*5\d\d|ECONN|timeout|timed out|network/i.test(message)) {
      return '外部 AI 服务暂时不可用，已切换为平台能力引导。';
    }
    return '当前语义没有命中稳定能力，已给出可执行问法。';
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`工具执行超过 ${timeoutMs}ms`)), timeoutMs);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  private cleanupExpired() {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.expiresAt > Date.now()) continue;
      this.pending.delete(id);
      assistantAuditService.update(id, { status: 'expired', completed: true });
    }
  }
}

export const assistantService = new AssistantService();
