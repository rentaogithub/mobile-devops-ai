import { createHash, randomUUID } from 'crypto';
import { getDatabase } from '../database';
import { currentProjectId } from './ProductLineContext';
import { DeviceRecording } from './DeviceRecordingService';
import {
  compileDeviceReplayFlow,
  CompiledDeviceReplayFlow,
  DeviceReplayFlowDsl,
  replayFlowTemplateFromRecording,
  validateDeviceReplayFlow,
} from './DeviceReplayFlow';

export type ReplayFlowAssetStatus = 'draft' | 'published' | 'archived';

export class ReplayFlowAssetError extends Error {
  constructor(message: string, public statusCode = 400, public code = 'REPLAY_FLOW_ASSET_ERROR') {
    super(message);
  }
}

export interface ReplayFlowDraft {
  id: string;
  assetId: string;
  revision: number;
  flow: DeviceReplayFlowDsl;
  validation: ReturnType<typeof validateDeviceReplayFlow>;
  sourceRecordingId?: string;
  sourceFingerprint: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReplayFlowAssetSummary {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  owner: string;
  status: ReplayFlowAssetStatus;
  sourceRecordingId?: string;
  sourceFingerprint: string;
  currentDraftId?: string;
  latestVersionId?: string;
  latestVersionNumber?: number;
  preFlowVersionId?: string;
  preFlowAssetId?: string;
  preFlowAssetName?: string;
  preFlowVersionNumber?: number;
  postFlowVersionId?: string;
  postFlowAssetId?: string;
  postFlowAssetName?: string;
  postFlowVersionNumber?: number;
  creationCompleted: boolean;
  completedAt?: string;
  revision: number;
  nodeCount: number;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ReplayFlowAsset extends ReplayFlowAssetSummary {
  draft: ReplayFlowDraft;
  versions: ReplayFlowVersionSummary[];
  auditEvents: ReplayFlowAuditEvent[];
}

export interface ReplayFlowAuditEvent {
  id: string;
  assetId: string;
  eventType: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ReplayFlowVersionSummary {
  id: string;
  assetId: string;
  assetName: string;
  versionNumber: number;
  createdBy: string;
  createdAt: string;
  releaseNotes?: string;
}

export interface ReplayFlowVersion extends ReplayFlowVersionSummary {
  projectId: string;
  flow: DeviceReplayFlowDsl;
  compiled: CompiledDeviceReplayFlow;
  sourceRecordingId?: string;
  sourceFingerprint: string;
}

export interface ReplayFlowSourcePreview {
  recording: {
    id: string;
    title: string;
    status: DeviceRecording['status'];
    owner: string;
    createdAt: string;
    stoppedAt?: string;
    device?: DeviceRecording['device'];
    selectedCount: number;
  };
  selectedSteps: Array<{
    id: string;
    index: number;
    origin: string;
    actionType: string;
    summary: string;
    targetSummary?: string;
  }>;
  sourceFingerprint: string;
  storedSourceFingerprint?: string;
  sourceChanged: boolean;
  flow: DeviceReplayFlowDsl;
  validation: ReturnType<typeof validateDeviceReplayFlow>;
}

function now() {
  return new Date().toISOString();
}

function text(value: unknown, maxLength: number) {
  return String(value || '').trim().slice(0, maxLength);
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return value ? JSON.parse(String(value)) as T : fallback;
  } catch {
    return fallback;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        const item = (value as Record<string, unknown>)[key];
        if (item !== undefined) result[key] = canonicalize(item);
        return result;
      }, {});
  }
  return value;
}

export function recordingSourceFingerprint(recording: DeviceRecording) {
  const selectedSteps = recording.steps
    .filter((step) => step.status === 'ready' && step.included)
    .sort((left, right) => left.index - right.index)
    .map((step) => ({
      id: step.id,
      index: step.index,
      origin: step.origin,
      action: step.action,
    }));
  return createHash('sha256').update(JSON.stringify(canonicalize({
    recordingId: recording.id,
    deviceUdid: recording.device?.udid || '',
    selectedSteps,
  }))).digest('hex');
}

function legacyRecordingSourceFingerprint(recording: DeviceRecording) {
  const selectedSteps = recording.steps
    .filter((step) => step.status === 'ready' && step.included)
    .sort((left, right) => left.index - right.index)
    .map((step) => ({
      id: step.id,
      index: step.index,
      origin: step.origin,
      action: step.action,
      before: step.beforeSnapshot ? {
        sourceHash: step.beforeSnapshot.sourceHash,
        screenshotHash: step.beforeSnapshot.screenshotHash,
      } : null,
      after: step.afterSnapshot ? {
        sourceHash: step.afterSnapshot.sourceHash,
        screenshotHash: step.afterSnapshot.screenshotHash,
      } : null,
    }));
  return createHash('sha256').update(JSON.stringify(canonicalize({
    recordingId: recording.id,
    deviceUdid: recording.device?.udid || '',
    selectedSteps,
  }))).digest('hex');
}

function targetSummary(recording: DeviceRecording, stepId: string) {
  const target = recording.steps.find((step) => step.id === stepId)?.action.target;
  if (!target) return undefined;
  return target.label || target.name || target.value || target.placeholder || target.type;
}

function draftFromRow(row: any): ReplayFlowDraft {
  return {
    id: row.id,
    assetId: row.asset_id,
    revision: Number(row.revision) || 1,
    flow: parseJson<DeviceReplayFlowDsl>(row.dsl_json, { schemaVersion: '1.0', id: row.asset_id, name: '', nodes: [] }),
    validation: parseJson(row.validation_json, { valid: false, errors: [], warnings: [] }),
    sourceRecordingId: row.source_recording_id || undefined,
    sourceFingerprint: row.source_fingerprint,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function summaryFromRow(row: any): ReplayFlowAssetSummary {
  const flow = parseJson<DeviceReplayFlowDsl>(row.dsl_json, { schemaVersion: '1.0', id: row.id, name: row.name, nodes: [] });
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description || undefined,
    owner: row.owner,
    status: row.status,
    sourceRecordingId: row.source_recording_id || undefined,
    sourceFingerprint: row.source_fingerprint,
    currentDraftId: row.current_draft_id || undefined,
    latestVersionId: row.latest_version_id || undefined,
    latestVersionNumber: row.latest_version_number === null || row.latest_version_number === undefined ? undefined : Number(row.latest_version_number),
    preFlowVersionId: row.pre_flow_version_id || undefined,
    preFlowAssetId: row.pre_flow_asset_id || undefined,
    preFlowAssetName: row.pre_flow_asset_name || undefined,
    preFlowVersionNumber: row.pre_flow_version_number === null || row.pre_flow_version_number === undefined ? undefined : Number(row.pre_flow_version_number),
    postFlowVersionId: row.post_flow_version_id || undefined,
    postFlowAssetId: row.post_flow_asset_id || undefined,
    postFlowAssetName: row.post_flow_asset_name || undefined,
    postFlowVersionNumber: row.post_flow_version_number === null || row.post_flow_version_number === undefined ? undefined : Number(row.post_flow_version_number),
    creationCompleted: row.creation_completed === undefined ? true : Boolean(row.creation_completed),
    completedAt: row.completed_at || undefined,
    revision: Number(row.revision) || 1,
    nodeCount: Array.isArray(flow.nodes) ? flow.nodes.length : 0,
    versionCount: Number(row.version_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at || undefined,
  };
}

const ASSET_SELECT = `
  SELECT a.*, d.revision, d.dsl_json,
    latest.version_number AS latest_version_number,
    pre_version.asset_id AS pre_flow_asset_id,
    pre_asset.name AS pre_flow_asset_name,
    pre_version.version_number AS pre_flow_version_number,
    post_version.asset_id AS post_flow_asset_id,
    post_asset.name AS post_flow_asset_name,
    post_version.version_number AS post_flow_version_number,
    (SELECT COUNT(*) FROM replay_flow_versions v WHERE v.asset_id = a.id) AS version_count
  FROM replay_flow_assets a
  JOIN replay_flow_drafts d ON d.id = a.current_draft_id
  LEFT JOIN replay_flow_versions latest ON latest.id = a.latest_version_id
  LEFT JOIN replay_flow_versions pre_version ON pre_version.id = a.pre_flow_version_id
  LEFT JOIN replay_flow_assets pre_asset ON pre_asset.id = pre_version.asset_id
  LEFT JOIN replay_flow_versions post_version ON post_version.id = a.post_flow_version_id
  LEFT JOIN replay_flow_assets post_asset ON post_asset.id = post_version.asset_id
`;

export class ReplayFlowAssetService {
  sourcePreview(recording: DeviceRecording, assetId?: string): ReplayFlowSourcePreview {
    if (recording.status !== 'stopped') {
      throw new ReplayFlowAssetError('请先停止录制，再预览编排来源', 409, 'RECORDING_NOT_STOPPED');
    }
    const selectedSteps = recording.steps
      .filter((step) => step.status === 'ready' && step.included)
      .sort((left, right) => left.index - right.index);
    if (!selectedSteps.length) {
      throw new ReplayFlowAssetError('当前录制没有已选择的可回放步骤', 400, 'RECORDING_HAS_NO_SELECTED_STEPS');
    }
    const asset = assetId ? this.get(assetId) : undefined;
    const fingerprint = recordingSourceFingerprint(recording);
    const legacyFingerprint = legacyRecordingSourceFingerprint(recording);
    const generated = replayFlowTemplateFromRecording(recording);
    const flow: DeviceReplayFlowDsl = asset ? {
      ...generated,
      id: asset.id,
      name: asset.name,
      description: asset.description,
    } : generated;
    return {
      recording: {
        id: recording.id,
        title: recording.title,
        status: recording.status,
        owner: recording.owner,
        createdAt: recording.createdAt,
        stoppedAt: recording.stoppedAt,
        device: recording.device,
        selectedCount: selectedSteps.length,
      },
      selectedSteps: selectedSteps.map((step) => ({
        id: step.id,
        index: step.index,
        origin: step.origin,
        actionType: step.action.type,
        summary: step.summary,
        targetSummary: targetSummary(recording, step.id),
      })),
      sourceFingerprint: fingerprint,
      storedSourceFingerprint: asset?.sourceFingerprint,
      sourceChanged: Boolean(asset && asset.sourceFingerprint !== fingerprint && asset.sourceFingerprint !== legacyFingerprint),
      flow,
      validation: validateDeviceReplayFlow(flow),
    };
  }

  createFromRecording(recording: DeviceRecording, actor: string, input: { name?: string; description?: string; creationMode?: boolean } = {}) {
    if (recording.status !== 'stopped') {
      throw new ReplayFlowAssetError('请先停止录制，再保存为回放流程', 409, 'RECORDING_NOT_STOPPED');
    }
    if (recording.selectedCount <= 0) {
      throw new ReplayFlowAssetError('请至少选择一条可回放步骤', 400, 'NO_REPLAYABLE_STEPS');
    }
    const flow = replayFlowTemplateFromRecording(recording);
    const validation = validateDeviceReplayFlow(flow);
    if (!validation.valid) {
      throw new ReplayFlowAssetError('当前录制生成的流程未通过校验，请先调整步骤', 400, 'FLOW_VALIDATION_FAILED');
    }
    const assetId = `flow_${randomUUID()}`;
    const draftId = `draft_${randomUUID()}`;
    const timestamp = now();
    const name = text(input.name, 160) || flow.name || `${recording.title} 回放流程`;
    const description = text(input.description, 1000) || flow.description || '';
    const fingerprint = recordingSourceFingerprint(recording);
    const storedFlow: DeviceReplayFlowDsl = { ...flow, id: assetId, name, description };
    const creationCompleted = input.creationMode ? 0 : 1;
    const db = getDatabase();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO replay_flow_assets (
          id, project_id, name, description, owner, status, source_recording_id,
          source_fingerprint, current_draft_id, creation_completed, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, NULL, ?, ?, ?, ?)
      `).run(
        assetId,
        currentProjectId(),
        name,
        description || null,
        actor,
        recording.id,
        fingerprint,
        creationCompleted,
        creationCompleted ? timestamp : null,
        timestamp,
        timestamp,
      );
      db.prepare(`
        INSERT INTO replay_flow_drafts (
          id, asset_id, revision, dsl_json, validation_json, source_recording_id,
          source_fingerprint, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        draftId,
        assetId,
        JSON.stringify(storedFlow),
        JSON.stringify(validation),
        recording.id,
        fingerprint,
        actor,
        actor,
        timestamp,
        timestamp,
      );
      db.prepare('UPDATE replay_flow_assets SET current_draft_id = ? WHERE id = ?').run(draftId, assetId);
      this.recordAudit(assetId, 'flow.created_from_recording', actor, {
        recordingId: recording.id,
        fingerprint,
        selectedCount: recording.selectedCount,
        creationMode: Boolean(input.creationMode),
      });
    })();
    return this.get(assetId);
  }

  list(filters: { search?: string; status?: string; limit?: number } = {}) {
    const clauses: string[] = ['a.project_id = @projectId'];
    const params: Record<string, unknown> = { projectId: currentProjectId() };
    const search = text(filters.search, 160);
    if (search) {
      clauses.push('(a.name LIKE @search OR a.description LIKE @search OR a.source_recording_id LIKE @search)');
      params.search = `%${search}%`;
    }
    const status = text(filters.status, 30);
    if (status && status !== 'all') {
      clauses.push('a.status = @status');
      params.status = status;
    } else if (!status) {
      clauses.push("a.status <> 'archived'");
    }
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return (getDatabase().prepare(`${ASSET_SELECT} ${where} ORDER BY a.updated_at DESC LIMIT ${limit}`).all(params) as any[])
      .map(summaryFromRow);
  }

  get(assetId: string): ReplayFlowAsset {
    const row = getDatabase().prepare(`${ASSET_SELECT} WHERE a.id = ? AND a.project_id = ?`).get(assetId, currentProjectId()) as any;
    if (!row) throw new ReplayFlowAssetError('回放流程不存在', 404, 'FLOW_ASSET_NOT_FOUND');
    const draftRow = getDatabase().prepare('SELECT * FROM replay_flow_drafts WHERE id = ?').get(row.current_draft_id) as any;
    const versions = (getDatabase().prepare(`
      SELECT v.id, v.asset_id, a.name AS asset_name, v.version_number, v.dsl_json, v.release_notes, v.created_by, v.created_at
      FROM replay_flow_versions v
      JOIN replay_flow_assets a ON a.id = v.asset_id
      WHERE v.asset_id = ? ORDER BY v.version_number DESC
    `).all(assetId) as any[]).map((item) => ({
      id: item.id,
      assetId: item.asset_id,
      assetName: parseJson<DeviceReplayFlowDsl>(item.dsl_json, { name: item.asset_name } as DeviceReplayFlowDsl).name || item.asset_name,
      versionNumber: Number(item.version_number),
      releaseNotes: item.release_notes || undefined,
      createdBy: item.created_by,
      createdAt: item.created_at,
    }));
    return { ...summaryFromRow(row), draft: draftFromRow(draftRow), versions, auditEvents: this.listAuditEvents(assetId) };
  }

  listAuditEvents(assetId: string, limit = 100): ReplayFlowAuditEvent[] {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return (getDatabase().prepare(`
      SELECT * FROM replay_flow_audit_events
      WHERE asset_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ${safeLimit}
    `).all(assetId) as any[]).map((row) => ({
      id: row.id,
      assetId: row.asset_id,
      eventType: row.event_type,
      actor: row.actor,
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
      createdAt: row.created_at,
    }));
  }

  getVersion(versionId: string): ReplayFlowVersion {
    const row = getDatabase().prepare(`
      SELECT v.*, a.name AS asset_name, a.project_id
      FROM replay_flow_versions v
      JOIN replay_flow_assets a ON a.id = v.asset_id
      WHERE v.id = ?
    `).get(versionId) as any;
    if (!row) throw new ReplayFlowAssetError('回放流程发布版本不存在', 404, 'FLOW_VERSION_NOT_FOUND');
    const flow = parseJson<DeviceReplayFlowDsl>(row.dsl_json, { schemaVersion: '1.0', id: row.asset_id, name: row.asset_name, nodes: [] });
    return {
      id: row.id,
      assetId: row.asset_id,
      assetName: flow.name || row.asset_name,
      projectId: row.project_id,
      versionNumber: Number(row.version_number),
      flow,
      compiled: parseJson<CompiledDeviceReplayFlow>(row.compiled_json, {} as CompiledDeviceReplayFlow),
      sourceRecordingId: row.source_recording_id || undefined,
      sourceFingerprint: row.source_fingerprint,
      releaseNotes: row.release_notes || undefined,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  listPublishedVersions(projectId = 'nn-ios'): ReplayFlowVersionSummary[] {
    return (getDatabase().prepare(`
      SELECT v.id, v.asset_id, a.name AS asset_name, v.version_number, v.dsl_json,
             v.release_notes, v.created_by, v.created_at
      FROM replay_flow_versions v
      JOIN replay_flow_assets a ON a.id = v.asset_id
      WHERE a.project_id = ? AND a.status = 'published'
      ORDER BY a.name ASC, v.version_number DESC
    `).all(projectId) as any[]).map((row) => ({
      id: row.id,
      assetId: row.asset_id,
      assetName: parseJson<DeviceReplayFlowDsl>(row.dsl_json, { name: row.asset_name } as DeviceReplayFlowDsl).name || row.asset_name,
      versionNumber: Number(row.version_number),
      releaseNotes: row.release_notes || undefined,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
  }

  publish(assetId: string, actor: string, input: { expectedRevision?: number; releaseNotes?: string } = {}) {
    const asset = this.get(assetId);
    if (asset.status === 'archived') {
      throw new ReplayFlowAssetError('归档流程不能发布', 409, 'FLOW_ASSET_ARCHIVED');
    }
    if (!asset.creationCompleted) {
      throw new ReplayFlowAssetError('请先完成流程创建再发布', 409, 'FLOW_CREATION_INCOMPLETE');
    }
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== asset.draft.revision) {
      throw new ReplayFlowAssetError(`草稿版本已更新，当前 revision 为 ${asset.draft.revision}`, 409, 'FLOW_DRAFT_CONFLICT');
    }
    if (!asset.draft.validation.valid) {
      throw new ReplayFlowAssetError('流程校验未通过，不能发布', 422, 'FLOW_VALIDATION_FAILED');
    }
    const compiled = compileDeviceReplayFlow(asset.draft.flow);
    const versionId = `version_${randomUUID()}`;
    const timestamp = now();
    const releaseNotes = text(input.releaseNotes, 1000);
    const db = getDatabase();
    let versionNumber = 1;
    db.transaction(() => {
      const latest = db.prepare('SELECT COALESCE(MAX(version_number), 0) AS value FROM replay_flow_versions WHERE asset_id = ?').get(assetId) as any;
      versionNumber = Number(latest?.value || 0) + 1;
      db.prepare(`
        INSERT INTO replay_flow_versions (
          id, asset_id, version_number, dsl_json, compiled_json, source_recording_id,
          source_fingerprint, release_notes, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId,
        assetId,
        versionNumber,
        JSON.stringify(asset.draft.flow),
        JSON.stringify(compiled),
        asset.draft.sourceRecordingId || null,
        asset.draft.sourceFingerprint,
        releaseNotes || null,
        actor,
        timestamp,
      );
      db.prepare(`
        UPDATE replay_flow_assets
        SET status = 'published', latest_version_id = ?, updated_at = ?
        WHERE id = ?
      `).run(versionId, timestamp, assetId);
      this.recordAudit(assetId, 'flow.published', actor, { versionId, versionNumber, revision: asset.draft.revision });
    })();
    return { asset: this.get(assetId), version: this.getVersion(versionId) };
  }

  saveDraft(assetId: string, actor: string, input: { expectedRevision?: number; flow?: DeviceReplayFlowDsl; name?: string; description?: string }) {
    const asset = this.get(assetId);
    if (asset.status === 'archived') {
      throw new ReplayFlowAssetError('归档流程不能继续编辑', 409, 'FLOW_ASSET_ARCHIVED');
    }
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== asset.draft.revision) {
      throw new ReplayFlowAssetError(`草稿版本已更新，当前 revision 为 ${asset.draft.revision}`, 409, 'FLOW_DRAFT_CONFLICT');
    }
    const name = text(input.name, 160) || asset.name;
    const description = input.description === undefined ? (asset.description || '') : text(input.description, 1000);
    const flow = input.flow ? { ...input.flow, id: asset.id, name, description } : { ...asset.draft.flow, name, description };
    const validation = validateDeviceReplayFlow(flow);
    const timestamp = now();
    const nextRevision = asset.draft.revision + 1;
    getDatabase().transaction(() => {
      getDatabase().prepare(`
        UPDATE replay_flow_drafts
        SET revision = ?, dsl_json = ?, validation_json = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
      `).run(nextRevision, JSON.stringify(flow), JSON.stringify(validation), actor, timestamp, asset.draft.id);
      getDatabase().prepare(`
        UPDATE replay_flow_assets SET name = ?, description = ?, updated_at = ? WHERE id = ?
      `).run(name, description || null, timestamp, assetId);
      this.recordAudit(assetId, 'flow.draft_saved', actor, { revision: nextRevision, valid: validation.valid });
    })();
    return this.get(assetId);
  }

  resetFromRecording(assetId: string, recording: DeviceRecording, actor: string, expectedRevision?: number) {
    const asset = this.get(assetId);
    if (asset.status === 'archived') {
      throw new ReplayFlowAssetError('归档流程不能从录制重置', 409, 'FLOW_ASSET_ARCHIVED');
    }
    if (!asset.sourceRecordingId || asset.sourceRecordingId !== recording.id) {
      throw new ReplayFlowAssetError('当前录制不是该流程的确认来源', 409, 'FLOW_SOURCE_RECORDING_MISMATCH');
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision !== asset.draft.revision) {
      throw new ReplayFlowAssetError(`草稿版本已更新，当前 revision 为 ${asset.draft.revision}`, 409, 'FLOW_DRAFT_CONFLICT');
    }
    const preview = this.sourcePreview(recording, assetId);
    if (!preview.validation.valid) {
      throw new ReplayFlowAssetError('录制来源生成的流程未通过校验', 422, 'FLOW_VALIDATION_FAILED');
    }
    const timestamp = now();
    const nextRevision = asset.draft.revision + 1;
    getDatabase().transaction(() => {
      getDatabase().prepare(`
        UPDATE replay_flow_drafts
        SET revision = ?, dsl_json = ?, validation_json = ?, source_recording_id = ?,
            source_fingerprint = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
      `).run(
        nextRevision,
        JSON.stringify(preview.flow),
        JSON.stringify(preview.validation),
        recording.id,
        preview.sourceFingerprint,
        actor,
        timestamp,
        asset.draft.id,
      );
      getDatabase().prepare(`
        UPDATE replay_flow_assets
        SET source_recording_id = ?, source_fingerprint = ?, updated_at = ?
        WHERE id = ?
      `).run(recording.id, preview.sourceFingerprint, timestamp, assetId);
      this.recordAudit(assetId, 'flow.reset_from_recording', actor, {
        recordingId: recording.id,
        previousFingerprint: asset.sourceFingerprint,
        sourceFingerprint: preview.sourceFingerprint,
        revision: nextRevision,
      });
    })();
    return this.get(assetId);
  }

  copy(assetId: string, actor: string, requestedName?: string) {
    const source = this.get(assetId);
    const newAssetId = `flow_${randomUUID()}`;
    const newDraftId = `draft_${randomUUID()}`;
    const timestamp = now();
    const name = text(requestedName, 160) || `${source.name} 副本`;
    const flow = { ...source.draft.flow, id: newAssetId, name };
    const validation = validateDeviceReplayFlow(flow);
    getDatabase().transaction(() => {
      getDatabase().prepare(`
        INSERT INTO replay_flow_assets (
          id, project_id, name, description, owner, status, source_recording_id,
          source_fingerprint, current_draft_id, pre_flow_version_id, post_flow_version_id,
          creation_completed, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, NULL, ?, ?, 1, ?, ?, ?)
      `).run(
        newAssetId,
        source.projectId,
        name,
        source.description || null,
        actor,
        source.sourceRecordingId || null,
        source.sourceFingerprint,
        source.preFlowVersionId || null,
        source.postFlowVersionId || null,
        timestamp,
        timestamp,
        timestamp,
      );
      getDatabase().prepare(`
        INSERT INTO replay_flow_drafts (
          id, asset_id, revision, dsl_json, validation_json, source_recording_id,
          source_fingerprint, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newDraftId,
        newAssetId,
        JSON.stringify(flow),
        JSON.stringify(validation),
        source.sourceRecordingId || null,
        source.sourceFingerprint,
        actor,
        actor,
        timestamp,
        timestamp,
      );
      getDatabase().prepare('UPDATE replay_flow_assets SET current_draft_id = ? WHERE id = ?').run(newDraftId, newAssetId);
      this.recordAudit(newAssetId, 'flow.copied', actor, { sourceAssetId: source.id });
    })();
    return this.get(newAssetId);
  }

  copyVersion(versionId: string, actor: string, requestedName?: string) {
    const version = this.getVersion(versionId);
    const newAssetId = `flow_${randomUUID()}`;
    const newDraftId = `draft_${randomUUID()}`;
    const timestamp = now();
    const name = text(requestedName, 160) || `${version.assetName} v${version.versionNumber} 副本`;
    const description = text(version.flow.description, 1000);
    const flow: DeviceReplayFlowDsl = { ...version.flow, id: newAssetId, name, description };
    const validation = validateDeviceReplayFlow(flow);
    const db = getDatabase();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO replay_flow_assets (
          id, project_id, name, description, owner, status, source_recording_id,
          source_fingerprint, current_draft_id, creation_completed, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, NULL, 1, ?, ?, ?)
      `).run(
        newAssetId,
        version.projectId,
        name,
        description || null,
        actor,
        version.sourceRecordingId || null,
        version.sourceFingerprint,
        timestamp,
        timestamp,
        timestamp,
      );
      db.prepare(`
        INSERT INTO replay_flow_drafts (
          id, asset_id, revision, dsl_json, validation_json, source_recording_id,
          source_fingerprint, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newDraftId,
        newAssetId,
        JSON.stringify(flow),
        JSON.stringify(validation),
        version.sourceRecordingId || null,
        version.sourceFingerprint,
        actor,
        actor,
        timestamp,
        timestamp,
      );
      db.prepare('UPDATE replay_flow_assets SET current_draft_id = ? WHERE id = ?').run(newDraftId, newAssetId);
      this.recordAudit(newAssetId, 'flow.version_copied', actor, {
        sourceAssetId: version.assetId,
        sourceVersionId: version.id,
        sourceVersionNumber: version.versionNumber,
      });
    })();
    return this.get(newAssetId);
  }

  rollbackToVersion(versionId: string, actor: string, expectedRevision?: number) {
    const version = this.getVersion(versionId);
    const asset = this.get(version.assetId);
    if (asset.status === 'archived') {
      throw new ReplayFlowAssetError('归档流程不能回滚版本', 409, 'FLOW_ASSET_ARCHIVED');
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision !== asset.draft.revision) {
      throw new ReplayFlowAssetError(`草稿版本已更新，当前 revision 为 ${asset.draft.revision}`, 409, 'FLOW_DRAFT_CONFLICT');
    }
    const name = text(version.flow.name, 160) || asset.name;
    const description = text(version.flow.description, 1000);
    const flow: DeviceReplayFlowDsl = { ...version.flow, id: asset.id, name, description };
    const validation = validateDeviceReplayFlow(flow);
    if (!validation.valid) {
      throw new ReplayFlowAssetError('历史版本校验未通过，不能生成回滚草稿', 422, 'FLOW_VALIDATION_FAILED');
    }
    const timestamp = now();
    const nextRevision = asset.draft.revision + 1;
    const db = getDatabase();
    db.transaction(() => {
      db.prepare(`
        UPDATE replay_flow_drafts
        SET revision = ?, dsl_json = ?, validation_json = ?, source_recording_id = ?,
            source_fingerprint = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
      `).run(
        nextRevision,
        JSON.stringify(flow),
        JSON.stringify(validation),
        version.sourceRecordingId || null,
        version.sourceFingerprint,
        actor,
        timestamp,
        asset.draft.id,
      );
      db.prepare(`
        UPDATE replay_flow_assets
        SET name = ?, description = ?, source_recording_id = ?, source_fingerprint = ?, updated_at = ?
        WHERE id = ?
      `).run(
        name,
        description || null,
        version.sourceRecordingId || null,
        version.sourceFingerprint,
        timestamp,
        asset.id,
      );
      this.recordAudit(asset.id, 'flow.version_rolled_back_to_draft', actor, {
        sourceVersionId: version.id,
        sourceVersionNumber: version.versionNumber,
        revision: nextRevision,
      });
    })();
    return this.get(asset.id);
  }

  completeCreation(assetId: string, actor: string) {
    const asset = this.get(assetId);
    if (asset.status === 'archived') {
      throw new ReplayFlowAssetError('归档流程不能完成创建', 409, 'FLOW_ASSET_ARCHIVED');
    }
    if (!asset.draft.validation.valid) {
      throw new ReplayFlowAssetError('流程校验未通过，请先修复编排错误', 400, 'FLOW_VALIDATION_FAILED');
    }
    if (asset.creationCompleted) return asset;
    const timestamp = now();
    getDatabase().prepare(`
      UPDATE replay_flow_assets
      SET creation_completed = 1, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(timestamp, timestamp, assetId);
    this.recordAudit(assetId, 'flow.creation_completed', actor, { revision: asset.draft.revision });
    return this.get(assetId);
  }

  updateExecutionChain(assetId: string, actor: string, input: { preFlowVersionId?: string | null; postFlowVersionId?: string | null }) {
    const asset = this.get(assetId);
    if (asset.status === 'archived') {
      throw new ReplayFlowAssetError('归档流程不能配置执行链', 409, 'FLOW_ASSET_ARCHIVED');
    }
    if (!asset.creationCompleted) {
      throw new ReplayFlowAssetError('请先完成当前流程创建，再配置前置或后置流程', 409, 'FLOW_CREATION_INCOMPLETE');
    }
    const preFlowVersionId = text(input.preFlowVersionId, 120) || undefined;
    const postFlowVersionId = text(input.postFlowVersionId, 120) || undefined;
    const references = [preFlowVersionId, postFlowVersionId].map((versionId) => versionId ? this.getVersion(versionId) : undefined);
    references.forEach((version) => {
      if (!version) return;
      if (version.assetId === assetId) {
        throw new ReplayFlowAssetError('前置或后置流程不能引用自己', 409, 'FLOW_CHAIN_SELF_REFERENCE');
      }
      const reference = this.get(version.assetId);
      if (reference.projectId !== asset.projectId) {
        throw new ReplayFlowAssetError('只能引用同一项目的回放流程', 409, 'FLOW_CHAIN_PROJECT_MISMATCH');
      }
      if (reference.status !== 'published') {
        throw new ReplayFlowAssetError(`流程「${reference.name}」不是可用的已发布流程`, 409, 'FLOW_CHAIN_REFERENCE_UNAVAILABLE');
      }
    });
    this.assertAcyclic(assetId, references[0]?.assetId, references[1]?.assetId);
    const timestamp = now();
    getDatabase().prepare(`
      UPDATE replay_flow_assets
      SET pre_flow_version_id = ?, post_flow_version_id = ?,
          pre_flow_asset_id = NULL, post_flow_asset_id = NULL, updated_at = ?
      WHERE id = ?
    `).run(preFlowVersionId || null, postFlowVersionId || null, timestamp, assetId);
    this.recordAudit(assetId, 'flow.execution_chain_updated', actor, { preFlowVersionId, postFlowVersionId });
    return this.get(assetId);
  }

  setArchived(assetId: string, actor: string, archived: boolean) {
    const asset = this.get(assetId);
    if (archived) {
      const dependent = getDatabase().prepare(`
        SELECT dependent.name
        FROM replay_flow_assets dependent
        LEFT JOIN replay_flow_versions pre ON pre.id = dependent.pre_flow_version_id
        LEFT JOIN replay_flow_versions post ON post.id = dependent.post_flow_version_id
        WHERE dependent.project_id = ? AND dependent.status <> 'archived' AND dependent.id <> ?
          AND (pre.asset_id = ? OR post.asset_id = ?)
        LIMIT 1
      `).get(currentProjectId(), assetId, assetId, assetId) as any;
      if (dependent) {
        throw new ReplayFlowAssetError(`流程「${dependent.name}」仍在引用当前流程，请先解除执行链配置`, 409, 'FLOW_CHAIN_REFERENCE_IN_USE');
      }
    }
    const timestamp = now();
    const status: ReplayFlowAssetStatus = archived ? 'archived' : (asset.latestVersionId ? 'published' : 'draft');
    getDatabase().prepare(`
      UPDATE replay_flow_assets SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?
    `).run(status, archived ? timestamp : null, timestamp, assetId);
    this.recordAudit(assetId, archived ? 'flow.archived' : 'flow.restored', actor, {});
    return this.get(assetId);
  }

  private assertAcyclic(assetId: string, preFlowAssetId?: string, postFlowAssetId?: string) {
    const rows = getDatabase().prepare(`
      SELECT a.id, pre.asset_id AS pre_flow_asset_id, post.asset_id AS post_flow_asset_id
      FROM replay_flow_assets a
      LEFT JOIN replay_flow_versions pre ON pre.id = a.pre_flow_version_id
      LEFT JOIN replay_flow_versions post ON post.id = a.post_flow_version_id
      WHERE a.project_id = ? AND a.status <> 'archived'
    `).all(currentProjectId()) as Array<{ id: string; pre_flow_asset_id?: string; post_flow_asset_id?: string }>;
    const graph = new Map(rows.map((row) => [row.id, [row.pre_flow_asset_id, row.post_flow_asset_id].filter(Boolean) as string[]]));
    graph.set(assetId, [preFlowAssetId, postFlowAssetId].filter(Boolean) as string[]);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const target of graph.get(id) || []) {
        if (visit(target)) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    if (visit(assetId)) {
      throw new ReplayFlowAssetError('当前配置会形成前置/后置流程循环引用', 409, 'FLOW_CHAIN_CYCLE');
    }
  }

  private recordAudit(assetId: string, eventType: string, actor: string, payload: Record<string, unknown>) {
    getDatabase().prepare(`
      INSERT INTO replay_flow_audit_events (id, asset_id, event_type, actor, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`event_${randomUUID()}`, assetId, eventType, actor, JSON.stringify(payload), now());
  }
}

export const replayFlowAssetService = new ReplayFlowAssetService();
