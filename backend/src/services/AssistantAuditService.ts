import { createHash, randomUUID } from 'crypto';
import { getDatabase } from '../database';
import { PlatformUser } from './AuthService';

const REDACT_KEY = /password|token|secret|authorization|cookie|api[_-]?key/i;

function now() {
  return new Date().toISOString();
}

export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (typeof value === 'string') return value.length > 1200 ? `${value.slice(0, 1200)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeForAudit(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 60).map(([key, item]) => [
      key,
      REDACT_KEY.test(key) ? '[redacted]' : sanitizeForAudit(item, depth + 1),
    ]));
  }
  return value;
}

function parseJson(value: unknown, fallback: unknown) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export class AssistantAuditService {
  create(input: {
    user: PlatformUser;
    toolName: string;
    domain: string;
    riskLevel: string;
    status: string;
    arguments: unknown;
    preview?: unknown;
    approvalsRequired?: number;
    idempotencyKey?: string;
  }) {
    const id = `action_${randomUUID()}`;
    const timestamp = now();
    getDatabase().prepare(`
      INSERT INTO assistant_action_audits (
        id, user_id, username, tool_name, domain, risk_level, status,
        arguments_json, preview_json, approval_count, approvals_required,
        idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      id,
      input.user.id,
      input.user.username,
      input.toolName,
      input.domain,
      input.riskLevel,
      input.status,
      JSON.stringify(sanitizeForAudit(input.arguments) || {}),
      JSON.stringify(sanitizeForAudit(input.preview) || {}),
      input.approvalsRequired || 0,
      input.idempotencyKey || null,
      timestamp,
      timestamp,
    );
    return this.get(id);
  }

  update(id: string, patch: Record<string, unknown>) {
    const fields: string[] = ['updated_at = @updatedAt'];
    const params: Record<string, unknown> = { id, updatedAt: now() };
    const mapping: Record<string, string> = {
      status: 'status', error: 'error', approvalCount: 'approval_count', durationMs: 'duration_ms',
      relatedEntityType: 'related_entity_type', relatedEntityId: 'related_entity_id',
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (patch[key] !== undefined) {
        fields.push(`${column} = @${key}`);
        params[key] = patch[key];
      }
    }
    if (patch.result !== undefined) {
      fields.push('result_json = @resultJson');
      params.resultJson = JSON.stringify(sanitizeForAudit(patch.result));
    }
    if (patch.preview !== undefined) {
      fields.push('preview_json = @previewJson');
      params.previewJson = JSON.stringify(sanitizeForAudit(patch.preview));
    }
    if (patch.completed === true) {
      fields.push('completed_at = @completedAt');
      params.completedAt = now();
    }
    getDatabase().prepare(`UPDATE assistant_action_audits SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return this.get(id);
  }

  get(id: string) {
    const row = getDatabase().prepare('SELECT * FROM assistant_action_audits WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      username: row.username,
      toolName: row.tool_name,
      domain: row.domain,
      riskLevel: row.risk_level,
      status: row.status,
      arguments: parseJson(row.arguments_json, {}),
      preview: parseJson(row.preview_json, {}),
      result: parseJson(row.result_json, null),
      error: row.error,
      approvalCount: row.approval_count,
      approvalsRequired: row.approvals_required,
      relatedEntityType: row.related_entity_type,
      relatedEntityId: row.related_entity_id,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  list(limit = 100) {
    return (getDatabase().prepare(`SELECT id FROM assistant_action_audits ORDER BY created_at DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 500)) as any[])
      .map((row) => this.get(row.id));
  }

  idempotencyKey(user: PlatformUser, toolName: string, args: unknown) {
    return createHash('sha256').update(`${user.id}:${toolName}:${JSON.stringify(sanitizeForAudit(args))}`).digest('hex');
  }

  findRecentSuccess(idempotencyKey: string, seconds = 120) {
    const threshold = new Date(Date.now() - seconds * 1000).toISOString();
    const row = getDatabase().prepare(`
      SELECT id FROM assistant_action_audits
      WHERE idempotency_key = ? AND status = 'completed' AND created_at > ?
      ORDER BY created_at DESC LIMIT 1
    `).get(idempotencyKey, threshold) as any;
    return row ? this.get(row.id) : null;
  }

  findRecentDuplicate(idempotencyKey: string, seconds = 120) {
    const threshold = new Date(Date.now() - seconds * 1000).toISOString();
    const row = getDatabase().prepare(`
      SELECT id FROM assistant_action_audits
      WHERE idempotency_key = ?
        AND status IN ('created', 'awaiting_confirmation', 'running', 'completed')
        AND created_at > ?
      ORDER BY created_at DESC LIMIT 1
    `).get(idempotencyKey, threshold) as any;
    return row ? this.get(row.id) : null;
  }
}

export const assistantAuditService = new AssistantAuditService();
