import { AssistantInputMessage, AssistantModelResult, AssistantModelState, assistantModelGateway } from './AssistantModelGateway';
import { assistantAuditService } from './AssistantAuditService';
import { AssistantTool, AssistantToolContext, assistantToolRegistry } from './AssistantToolRegistry';
import { PlatformUser } from './AuthService';

export interface AssistantEvent {
  type: 'assistant.delta' | 'tool.proposed' | 'tool.started' | 'tool.progress' | 'tool.completed' | 'tool.failed' | 'assistant.completed';
  [key: string]: unknown;
}

interface PendingAction {
  id: string;
  userId: string;
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
    const result = await assistantModelGateway.start(messages, tools);
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
    if (!pending || pending.userId !== user.id) throw new Error('待确认操作不存在、已过期或不属于当前用户');
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
    if (!pending || pending.userId !== user.id) throw new Error('待确认操作不存在、已过期或不属于当前用户');
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
        const next = await assistantModelGateway.continue(initial.state, call.callId, duplicateResult, assistantToolRegistry.listForUser(user));
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
        id: audit.id, userId: user.id, tool, args, callId: call.callId, state: initial.state,
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
    const next = await assistantModelGateway.continue(initial.state, call.callId, output, assistantToolRegistry.listForUser(user));
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
