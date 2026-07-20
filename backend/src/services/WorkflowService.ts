import { randomUUID, createHash } from 'crypto';
import { getDatabase } from '../database';

const DEFAULT_PROJECT_ID = 'nn-ios';

type JsonObject = Record<string, any>;

function now() {
  return new Date().toISOString();
}

function json(value: unknown, fallback: unknown) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeText(value: unknown, maxLength = 1000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function id(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function sha1(value: string) {
  return createHash('sha1').update(value).digest('hex');
}

function normalizeSeverity(value: unknown) {
  const severity = normalizeText(value, 30).toLowerCase();
  if (['blocker', 'critical', 'high', 'medium', 'low', 'info'].includes(severity)) return severity;
  return 'medium';
}

function artifactFromRow(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    artifactType: row.artifact_type,
    name: row.name,
    version: row.version,
    buildNumber: row.build_number,
    commitHash: row.commit_hash,
    branch: row.branch,
    uri: row.uri,
    checksum: row.checksum,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskFromRow(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    taskType: row.task_type,
    suite: row.suite,
    status: row.status,
    source: row.source,
    externalId: row.external_id,
    externalUrl: row.external_url,
    buildNumber: row.build_number,
    commitHash: row.commit_hash,
    branch: row.branch,
    artifactId: row.artifact_id,
    deviceUdid: row.device_udid,
    progress: row.progress,
    config: parseJson(row.config_json, {}),
    result: parseJson(row.result_json, {}),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function issueFromRow(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    fingerprint: row.fingerprint,
    source: row.source,
    sourceRef: row.source_ref,
    category: row.category,
    severity: row.severity,
    status: row.status,
    title: row.title,
    summary: row.summary,
    module: row.module,
    ownerHint: row.owner_hint,
    businessDomain: row.business_domain,
    businessPath: row.business_path,
    taskId: row.task_id,
    artifactId: row.artifact_id,
    buildNumber: row.build_number,
    commitHash: row.commit_hash,
    evidence: parseJson(row.evidence_json, []),
    metadata: parseJson(row.metadata_json, {}),
    occurrenceCount: row.occurrence_count,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkflowService {
  createArtifact(input: JsonObject) {
    const db = getDatabase();
    const timestamp = now();
    const artifactId = normalizeText(input.id, 160) || id('artifact');
    db.prepare(`
      INSERT INTO workflow_artifacts (
        id, project_id, artifact_type, name, version, build_number, commit_hash,
        branch, uri, checksum, metadata_json, created_at, updated_at
      ) VALUES (
        @id, @projectId, @artifactType, @name, @version, @buildNumber, @commitHash,
        @branch, @uri, @checksum, @metadataJson, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        artifact_type = excluded.artifact_type,
        name = excluded.name,
        version = COALESCE(excluded.version, workflow_artifacts.version),
        build_number = COALESCE(excluded.build_number, workflow_artifacts.build_number),
        commit_hash = COALESCE(excluded.commit_hash, workflow_artifacts.commit_hash),
        branch = COALESCE(excluded.branch, workflow_artifacts.branch),
        uri = COALESCE(excluded.uri, workflow_artifacts.uri),
        checksum = COALESCE(excluded.checksum, workflow_artifacts.checksum),
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run({
      id: artifactId,
      projectId: normalizeText(input.projectId, 120) || DEFAULT_PROJECT_ID,
      artifactType: normalizeText(input.artifactType, 80) || 'unknown',
      name: normalizeText(input.name, 240) || artifactId,
      version: normalizeText(input.version, 120) || null,
      buildNumber: normalizeText(input.buildNumber, 120) || null,
      commitHash: normalizeText(input.commitHash, 120) || null,
      branch: normalizeText(input.branch, 240) || null,
      uri: normalizeText(input.uri, 2000) || null,
      checksum: normalizeText(input.checksum, 240) || null,
      metadataJson: json(input.metadata, {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.recordEvent({
      projectId: input.projectId,
      eventType: 'artifact.upserted',
      entityType: 'artifact',
      entityId: artifactId,
      payload: { artifactType: input.artifactType, buildNumber: input.buildNumber },
    });
    if (input.commitHash) {
      this.addRelation({ projectId: input.projectId, fromType: 'commit', fromId: normalizeText(input.commitHash, 120), relation: 'produced', toType: 'artifact', toId: artifactId });
    }
    if (input.buildNumber) {
      this.addRelation({ projectId: input.projectId, fromType: 'build', fromId: normalizeText(input.buildNumber, 120), relation: 'contains', toType: 'artifact', toId: artifactId });
    }
    return this.getArtifact(artifactId);
  }

  getArtifact(artifactId: string) {
    return artifactFromRow(getDatabase().prepare('SELECT * FROM workflow_artifacts WHERE id = ?').get(artifactId));
  }

  listArtifacts(filters: JsonObject = {}) {
    const clauses = ['project_id = @projectId'];
    const params: JsonObject = { projectId: normalizeText(filters.projectId, 120) || DEFAULT_PROJECT_ID };
    if (filters.buildNumber) {
      clauses.push('build_number = @buildNumber');
      params.buildNumber = normalizeText(filters.buildNumber, 120);
    }
    if (filters.commitHash) {
      clauses.push('commit_hash = @commitHash');
      params.commitHash = normalizeText(filters.commitHash, 120);
    }
    if (filters.artifactType) {
      clauses.push('artifact_type = @artifactType');
      params.artifactType = normalizeText(filters.artifactType, 80);
    }
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    return (getDatabase().prepare(`
      SELECT * FROM workflow_artifacts
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `).all(params) as any[]).map(artifactFromRow);
  }

  upsertTask(input: JsonObject) {
    const db = getDatabase();
    const timestamp = now();
    const taskId = normalizeText(input.id, 180) || id('task');
    const previous = db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(taskId) as any;
    const status = normalizeText(input.status, 60) || previous?.status || 'created';
    const startedAt = input.startedAt || previous?.started_at || (['running', 'installing', 'preparing'].includes(status) ? timestamp : null);
    const finishedAt = input.finishedAt || previous?.finished_at || (['passed', 'failed', 'canceled', 'completed', 'unstable'].includes(status) ? timestamp : null);
    db.prepare(`
      INSERT INTO workflow_tasks (
        id, project_id, task_type, suite, status, source, external_id, external_url,
        build_number, commit_hash, branch, artifact_id, device_udid, progress,
        config_json, result_json, started_at, finished_at, created_at, updated_at
      ) VALUES (
        @id, @projectId, @taskType, @suite, @status, @source, @externalId, @externalUrl,
        @buildNumber, @commitHash, @branch, @artifactId, @deviceUdid, @progress,
        @configJson, @resultJson, @startedAt, @finishedAt, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        suite = COALESCE(excluded.suite, workflow_tasks.suite),
        external_id = COALESCE(excluded.external_id, workflow_tasks.external_id),
        external_url = COALESCE(excluded.external_url, workflow_tasks.external_url),
        build_number = COALESCE(excluded.build_number, workflow_tasks.build_number),
        commit_hash = COALESCE(excluded.commit_hash, workflow_tasks.commit_hash),
        branch = COALESCE(excluded.branch, workflow_tasks.branch),
        artifact_id = COALESCE(excluded.artifact_id, workflow_tasks.artifact_id),
        device_udid = COALESCE(excluded.device_udid, workflow_tasks.device_udid),
        progress = excluded.progress,
        config_json = excluded.config_json,
        result_json = excluded.result_json,
        started_at = COALESCE(excluded.started_at, workflow_tasks.started_at),
        finished_at = COALESCE(excluded.finished_at, workflow_tasks.finished_at),
        updated_at = excluded.updated_at
    `).run({
      id: taskId,
      projectId: normalizeText(input.projectId, 120) || previous?.project_id || DEFAULT_PROJECT_ID,
      taskType: normalizeText(input.taskType, 100) || previous?.task_type || 'ios_quality',
      suite: normalizeText(input.suite, 80) || previous?.suite || null,
      status,
      source: normalizeText(input.source, 80) || previous?.source || 'platform',
      externalId: normalizeText(input.externalId, 240) || previous?.external_id || null,
      externalUrl: normalizeText(input.externalUrl, 2000) || previous?.external_url || null,
      buildNumber: normalizeText(input.buildNumber, 120) || previous?.build_number || null,
      commitHash: normalizeText(input.commitHash, 120) || previous?.commit_hash || null,
      branch: normalizeText(input.branch, 240) || previous?.branch || null,
      artifactId: normalizeText(input.artifactId, 180) || previous?.artifact_id || null,
      deviceUdid: normalizeText(input.deviceUdid, 240) || previous?.device_udid || null,
      progress: Math.min(Math.max(Number(input.progress ?? previous?.progress ?? 0), 0), 100),
      configJson: json(input.config ?? parseJson(previous?.config_json, {}), {}),
      resultJson: json(input.result ?? parseJson(previous?.result_json, {}), {}),
      startedAt,
      finishedAt,
      createdAt: previous?.created_at || timestamp,
      updatedAt: timestamp,
    });
    if (!previous || previous.status !== status) {
      this.recordEvent({
        projectId: input.projectId,
        eventType: previous ? 'task.status_changed' : 'task.created',
        entityType: 'task',
        entityId: taskId,
        payload: { from: previous?.status, to: status, suite: input.suite },
      });
    }
    const artifactId = normalizeText(input.artifactId, 180) || previous?.artifact_id;
    const buildNumber = normalizeText(input.buildNumber, 120) || previous?.build_number;
    if (artifactId) {
      this.addRelation({ projectId: input.projectId, fromType: 'artifact', fromId: artifactId, relation: 'tested_by', toType: 'task', toId: taskId });
    }
    if (buildNumber) {
      this.addRelation({ projectId: input.projectId, fromType: 'build', fromId: buildNumber, relation: 'verified_by', toType: 'task', toId: taskId });
    }
    return this.getTask(taskId);
  }

  getTask(taskId: string) {
    return taskFromRow(getDatabase().prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(taskId));
  }

  listTasks(filters: JsonObject = {}) {
    const clauses = ['project_id = @projectId'];
    const params: JsonObject = { projectId: normalizeText(filters.projectId, 120) || DEFAULT_PROJECT_ID };
    for (const [field, column, max] of [
      ['status', 'status', 60],
      ['suite', 'suite', 80],
      ['buildNumber', 'build_number', 120],
      ['taskType', 'task_type', 100],
    ] as const) {
      if (filters[field]) {
        clauses.push(`${column} = @${field}`);
        params[field] = normalizeText(filters[field], max);
      }
    }
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    return (getDatabase().prepare(`
      SELECT * FROM workflow_tasks WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC LIMIT ${limit}
    `).all(params) as any[]).map(taskFromRow);
  }

  upsertIssue(input: JsonObject) {
    const db = getDatabase();
    const timestamp = normalizeText(input.lastSeen, 80) || now();
    const projectId = normalizeText(input.projectId, 120) || DEFAULT_PROJECT_ID;
    const fingerprintSource = normalizeText(input.fingerprint, 300) || [
      input.source,
      input.category,
      input.title,
      input.module,
      input.businessDomain,
      input.businessPath,
    ].map((item) => normalizeText(item, 300).toLowerCase()).join('|');
    const fingerprint = fingerprintSource.length === 40 && /^[a-f0-9]+$/i.test(fingerprintSource)
      ? fingerprintSource
      : sha1(fingerprintSource);
    const previous = db.prepare('SELECT * FROM workflow_issues WHERE project_id = ? AND fingerprint = ?').get(projectId, fingerprint) as any;
    const issueId = previous?.id || normalizeText(input.id, 180) || id('issue');
    const previousEvidence = parseJson<any[]>(previous?.evidence_json, []);
    const evidence = Array.isArray(input.evidence)
      ? Array.from(new Map(
          [...previousEvidence, ...input.evidence].map((item) => [json(item, {}), item])
        ).values()).slice(-50)
      : previousEvidence;
    const previousMetadata = parseJson<JsonObject>(previous?.metadata_json, {});
    const metadata = { ...previousMetadata, ...(input.metadata || {}) };

    db.prepare(`
      INSERT INTO workflow_issues (
        id, project_id, fingerprint, source, source_ref, category, severity, status,
        title, summary, module, owner_hint, business_domain, business_path, task_id,
        artifact_id, build_number, commit_hash, evidence_json, metadata_json,
        occurrence_count, first_seen, last_seen, created_at, updated_at
      ) VALUES (
        @id, @projectId, @fingerprint, @source, @sourceRef, @category, @severity, @status,
        @title, @summary, @module, @ownerHint, @businessDomain, @businessPath, @taskId,
        @artifactId, @buildNumber, @commitHash, @evidenceJson, @metadataJson,
        @occurrenceCount, @firstSeen, @lastSeen, @createdAt, @updatedAt
      )
      ON CONFLICT(project_id, fingerprint) DO UPDATE SET
        source_ref = COALESCE(excluded.source_ref, workflow_issues.source_ref),
        severity = excluded.severity,
        status = CASE
          WHEN workflow_issues.status = 'ignored' THEN 'ignored'
          WHEN workflow_issues.status = 'resolved' AND excluded.last_seen > workflow_issues.last_seen THEN 'reopened'
          WHEN workflow_issues.status = 'resolved' THEN 'resolved'
          ELSE excluded.status
        END,
        title = excluded.title,
        summary = COALESCE(excluded.summary, workflow_issues.summary),
        module = COALESCE(excluded.module, workflow_issues.module),
        owner_hint = COALESCE(excluded.owner_hint, workflow_issues.owner_hint),
        business_domain = COALESCE(excluded.business_domain, workflow_issues.business_domain),
        business_path = COALESCE(excluded.business_path, workflow_issues.business_path),
        task_id = COALESCE(excluded.task_id, workflow_issues.task_id),
        artifact_id = COALESCE(excluded.artifact_id, workflow_issues.artifact_id),
        build_number = COALESCE(excluded.build_number, workflow_issues.build_number),
        commit_hash = COALESCE(excluded.commit_hash, workflow_issues.commit_hash),
        evidence_json = excluded.evidence_json,
        metadata_json = excluded.metadata_json,
        occurrence_count = CASE
          WHEN excluded.source_ref = workflow_issues.source_ref AND excluded.last_seen = workflow_issues.last_seen
          THEN workflow_issues.occurrence_count
          ELSE workflow_issues.occurrence_count + 1
        END,
        last_seen = excluded.last_seen,
        updated_at = excluded.updated_at
    `).run({
      id: issueId,
      projectId,
      fingerprint,
      source: normalizeText(input.source, 80) || 'platform',
      sourceRef: normalizeText(input.sourceRef, 500) || null,
      category: normalizeText(input.category, 100) || 'unknown',
      severity: normalizeSeverity(input.severity),
      status: normalizeText(input.status, 50) || 'open',
      title: normalizeText(input.title, 500) || '未命名问题',
      summary: normalizeText(input.summary, 4000) || null,
      module: normalizeText(input.module, 240) || null,
      ownerHint: normalizeText(input.ownerHint, 240) || null,
      businessDomain: normalizeText(input.businessDomain, 120) || null,
      businessPath: normalizeText(input.businessPath, 240) || null,
      taskId: normalizeText(input.taskId, 180) || null,
      artifactId: normalizeText(input.artifactId, 180) || null,
      buildNumber: normalizeText(input.buildNumber, 120) || null,
      commitHash: normalizeText(input.commitHash, 120) || null,
      evidenceJson: json(evidence, []),
      metadataJson: json(metadata, {}),
      occurrenceCount: previous?.occurrence_count || 1,
      firstSeen: previous?.first_seen || normalizeText(input.firstSeen, 80) || timestamp,
      lastSeen: timestamp,
      createdAt: previous?.created_at || timestamp,
      updatedAt: timestamp,
    });
    if (!previous) {
      this.recordEvent({ projectId, eventType: 'issue.created', entityType: 'issue', entityId: issueId, payload: { category: input.category, severity: input.severity } });
    }
    if (input.taskId) {
      this.addRelation({ projectId, fromType: 'task', fromId: normalizeText(input.taskId, 180), relation: 'discovered', toType: 'issue', toId: issueId });
    }
    if (input.artifactId) {
      this.addRelation({ projectId, fromType: 'artifact', fromId: normalizeText(input.artifactId, 180), relation: 'has_issue', toType: 'issue', toId: issueId });
    }
    if (input.buildNumber) {
      this.addRelation({ projectId, fromType: 'build', fromId: normalizeText(input.buildNumber, 120), relation: 'has_issue', toType: 'issue', toId: issueId });
    }
    return this.getIssue(issueId);
  }

  getIssue(issueId: string) {
    return issueFromRow(getDatabase().prepare('SELECT * FROM workflow_issues WHERE id = ?').get(issueId));
  }

  listIssues(filters: JsonObject = {}) {
    const clauses = ['project_id = @projectId'];
    const params: JsonObject = { projectId: normalizeText(filters.projectId, 120) || DEFAULT_PROJECT_ID };
    for (const [field, column, max] of [
      ['status', 'status', 50],
      ['severity', 'severity', 30],
      ['category', 'category', 100],
      ['buildNumber', 'build_number', 120],
      ['businessDomain', 'business_domain', 120],
    ] as const) {
      if (filters[field]) {
        clauses.push(`${column} = @${field}`);
        params[field] = normalizeText(filters[field], max);
      }
    }
    if (filters.query) {
      clauses.push('(title LIKE @query OR summary LIKE @query OR module LIKE @query OR business_path LIKE @query)');
      params.query = `%${normalizeText(filters.query, 200)}%`;
    }
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    return (getDatabase().prepare(`
      SELECT * FROM workflow_issues WHERE ${clauses.join(' AND ')}
      ORDER BY
        CASE severity WHEN 'blocker' THEN 0 WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        last_seen DESC
      LIMIT ${limit}
    `).all(params) as any[]).map(issueFromRow);
  }

  updateIssue(issueId: string, input: JsonObject) {
    const issue = this.getIssue(issueId);
    if (!issue) return null;
    const status = normalizeText(input.status, 50) || issue.status;
    const severity = input.severity ? normalizeSeverity(input.severity) : issue.severity;
    const updatedAt = now();
    getDatabase().prepare(`
      UPDATE workflow_issues SET
        status = @status,
        severity = @severity,
        summary = @summary,
        module = @module,
        owner_hint = @ownerHint,
        updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id: issueId,
      status,
      severity,
      summary: input.summary === undefined ? issue.summary : normalizeText(input.summary, 4000),
      module: input.module === undefined ? issue.module : normalizeText(input.module, 240),
      ownerHint: input.ownerHint === undefined ? issue.ownerHint : normalizeText(input.ownerHint, 240),
      updatedAt,
    });
    this.recordEvent({
      projectId: issue.projectId,
      eventType: 'issue.updated',
      entityType: 'issue',
      entityId: issueId,
      payload: { status, severity },
    });
    return this.getIssue(issueId);
  }

  addRelation(input: JsonObject) {
    const projectId = normalizeText(input.projectId, 120) || DEFAULT_PROJECT_ID;
    const createdAt = now();
    getDatabase().prepare(`
      INSERT INTO workflow_relations (
        project_id, from_type, from_id, relation, to_type, to_id, metadata_json, created_at
      ) VALUES (@projectId, @fromType, @fromId, @relation, @toType, @toId, @metadataJson, @createdAt)
      ON CONFLICT(project_id, from_type, from_id, relation, to_type, to_id)
      DO UPDATE SET metadata_json = excluded.metadata_json
    `).run({
      projectId,
      fromType: normalizeText(input.fromType, 80),
      fromId: normalizeText(input.fromId, 240),
      relation: normalizeText(input.relation, 120),
      toType: normalizeText(input.toType, 80),
      toId: normalizeText(input.toId, 240),
      metadataJson: json(input.metadata, {}),
      createdAt,
    });
    return { success: true };
  }

  listRelations(entityType: string, entityId: string) {
    return (getDatabase().prepare(`
      SELECT * FROM workflow_relations
      WHERE project_id = ? AND ((from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?))
      ORDER BY created_at DESC
    `).all(DEFAULT_PROJECT_ID, entityType, entityId, entityType, entityId) as any[]).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      fromType: row.from_type,
      fromId: row.from_id,
      relation: row.relation,
      toType: row.to_type,
      toId: row.to_id,
      metadata: parseJson(row.metadata_json, {}),
      createdAt: row.created_at,
    }));
  }

  recordEvent(input: JsonObject) {
    const eventId = normalizeText(input.id, 180) || id('event');
    const occurredAt = normalizeText(input.occurredAt, 80) || now();
    getDatabase().prepare(`
      INSERT OR IGNORE INTO workflow_events (
        id, project_id, event_type, entity_type, entity_id, payload_json, occurred_at, created_at
      ) VALUES (@id, @projectId, @eventType, @entityType, @entityId, @payloadJson, @occurredAt, @createdAt)
    `).run({
      id: eventId,
      projectId: normalizeText(input.projectId, 120) || DEFAULT_PROJECT_ID,
      eventType: normalizeText(input.eventType, 120) || 'unknown',
      entityType: normalizeText(input.entityType, 80) || 'unknown',
      entityId: normalizeText(input.entityId, 240) || 'unknown',
      payloadJson: json(input.payload, {}),
      occurredAt,
      createdAt: now(),
    });
    return { id: eventId, occurredAt };
  }

  listEvents(filters: JsonObject = {}) {
    const clauses = ['project_id = @projectId'];
    const params: JsonObject = { projectId: normalizeText(filters.projectId, 120) || DEFAULT_PROJECT_ID };
    if (filters.entityType) {
      clauses.push('entity_type = @entityType');
      params.entityType = normalizeText(filters.entityType, 80);
    }
    if (filters.entityId) {
      clauses.push('entity_id = @entityId');
      params.entityId = normalizeText(filters.entityId, 240);
    }
    if (filters.eventType) {
      clauses.push('event_type = @eventType');
      params.eventType = normalizeText(filters.eventType, 120);
    }
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    return (getDatabase().prepare(`
      SELECT * FROM workflow_events WHERE ${clauses.join(' AND ')}
      ORDER BY occurred_at DESC LIMIT ${limit}
    `).all(params) as any[]).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      eventType: row.event_type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      payload: parseJson(row.payload_json, {}),
      occurredAt: row.occurred_at,
    }));
  }

  upsertBaseline(input: JsonObject) {
    const timestamp = now();
    const projectId = normalizeText(input.projectId, 120) || DEFAULT_PROJECT_ID;
    const metric = normalizeText(input.metric, 120);
    const scope = normalizeText(input.scope, 160) || 'app';
    const branch = normalizeText(input.branch, 240) || '*';
    const existing = getDatabase().prepare(`
      SELECT * FROM workflow_quality_baselines
      WHERE project_id = ? AND metric = ? AND scope = ? AND branch = ?
    `).get(projectId, metric, scope, branch) as any;
    const baselineId = existing?.id || id('baseline');
    const value = Number(input.value);
    if (!metric || !Number.isFinite(value)) throw new Error('metric 和有效 value 不能为空');
    getDatabase().prepare(`
      INSERT INTO workflow_quality_baselines (
        id, project_id, metric, scope, branch, value, unit, sample_size, task_id,
        metadata_json, created_at, updated_at
      ) VALUES (
        @id, @projectId, @metric, @scope, @branch, @value, @unit, @sampleSize, @taskId,
        @metadataJson, @createdAt, @updatedAt
      )
      ON CONFLICT(project_id, metric, scope, branch) DO UPDATE SET
        value = excluded.value,
        unit = excluded.unit,
        sample_size = excluded.sample_size,
        task_id = excluded.task_id,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run({
      id: baselineId,
      projectId,
      metric,
      scope,
      branch,
      value,
      unit: normalizeText(input.unit, 80) || null,
      sampleSize: Math.max(Number(input.sampleSize) || 1, 1),
      taskId: normalizeText(input.taskId, 180) || null,
      metadataJson: json(input.metadata, {}),
      createdAt: existing?.created_at || timestamp,
      updatedAt: timestamp,
    });
    return this.getBaseline(metric, scope, branch, projectId);
  }

  getBaseline(metric: string, scope = 'app', branch = '*', projectId = DEFAULT_PROJECT_ID) {
    const row = getDatabase().prepare(`
      SELECT * FROM workflow_quality_baselines
      WHERE project_id = ? AND metric = ? AND scope = ? AND branch IN (?, '*')
      ORDER BY CASE WHEN branch = ? THEN 0 ELSE 1 END LIMIT 1
    `).get(projectId, metric, scope, branch, branch) as any;
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      metric: row.metric,
      scope: row.scope,
      branch: row.branch,
      value: row.value,
      unit: row.unit,
      sampleSize: row.sample_size,
      taskId: row.task_id,
      metadata: parseJson(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listBaselines(projectId = DEFAULT_PROJECT_ID) {
    return (getDatabase().prepare(`
      SELECT * FROM workflow_quality_baselines WHERE project_id = ? ORDER BY metric, scope, branch
    `).all(projectId) as any[]).map((row) => this.getBaseline(row.metric, row.scope, row.branch, projectId));
  }

  saveReleaseGate(input: JsonObject) {
    const gateId = normalizeText(input.id, 180) || id('gate');
    const existing = this.getReleaseGate(gateId);
    getDatabase().prepare(`
      INSERT INTO workflow_release_gates (
        id, project_id, build_number, commit_hash, branch, status, score, policy_json, result_json, created_at
      ) VALUES (@id, @projectId, @buildNumber, @commitHash, @branch, @status, @score, @policyJson, @resultJson, @createdAt)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        score = excluded.score,
        policy_json = excluded.policy_json,
        result_json = excluded.result_json
    `).run({
      id: gateId,
      projectId: normalizeText(input.projectId, 120) || DEFAULT_PROJECT_ID,
      buildNumber: normalizeText(input.buildNumber, 120),
      commitHash: normalizeText(input.commitHash, 120) || null,
      branch: normalizeText(input.branch, 240) || null,
      status: normalizeText(input.status, 50),
      score: Math.min(Math.max(Number(input.score) || 0, 0), 100),
      policyJson: json(input.policy, {}),
      resultJson: json(input.result, {}),
      createdAt: now(),
    });
    if (!existing) {
      this.recordEvent({ eventType: 'release_gate.evaluated', entityType: 'build', entityId: normalizeText(input.buildNumber, 120), payload: { gateId, status: input.status, score: input.score } });
    }
    return this.getReleaseGate(gateId);
  }

  getReleaseGate(gateId: string) {
    const row = getDatabase().prepare('SELECT * FROM workflow_release_gates WHERE id = ?').get(gateId) as any;
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      buildNumber: row.build_number,
      commitHash: row.commit_hash,
      branch: row.branch,
      status: row.status,
      score: row.score,
      policy: parseJson(row.policy_json, {}),
      result: parseJson(row.result_json, {}),
      createdAt: row.created_at,
    };
  }

  listReleaseGates(projectId = DEFAULT_PROJECT_ID, limit = 50) {
    return (getDatabase().prepare(`
      SELECT id FROM workflow_release_gates WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(projectId, Math.min(Math.max(limit, 1), 200)) as any[]).map((row) => this.getReleaseGate(row.id));
  }

  createRegressionCandidate(input: JsonObject) {
    const timestamp = now();
    const candidateId = normalizeText(input.id, 180) || id('regression');
    getDatabase().prepare(`
      INSERT INTO workflow_regression_candidates (
        id, project_id, issue_id, source_task_id, title, suite, business_domain,
        business_path, preconditions_json, steps_json, assertions_json, confidence,
        status, generated_code, metadata_json, created_at, updated_at
      ) VALUES (
        @id, @projectId, @issueId, @sourceTaskId, @title, @suite, @businessDomain,
        @businessPath, @preconditionsJson, @stepsJson, @assertionsJson, @confidence,
        @status, @generatedCode, @metadataJson, @createdAt, @updatedAt
      )
    `).run({
      id: candidateId,
      projectId: normalizeText(input.projectId, 120) || DEFAULT_PROJECT_ID,
      issueId: normalizeText(input.issueId, 180) || null,
      sourceTaskId: normalizeText(input.sourceTaskId, 180) || null,
      title: normalizeText(input.title, 500) || 'Monkey 回归候选',
      suite: normalizeText(input.suite, 80) || 'xcuitest',
      businessDomain: normalizeText(input.businessDomain, 120) || null,
      businessPath: normalizeText(input.businessPath, 240) || null,
      preconditionsJson: json(input.preconditions, []),
      stepsJson: json(input.steps, []),
      assertionsJson: json(input.assertions, []),
      confidence: Math.min(Math.max(Number(input.confidence) || 0.5, 0), 1),
      status: normalizeText(input.status, 50) || 'proposed',
      generatedCode: input.generatedCode ? String(input.generatedCode) : null,
      metadataJson: json(input.metadata, {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.recordEvent({ eventType: 'regression_candidate.created', entityType: 'regression_candidate', entityId: candidateId, payload: { issueId: input.issueId, businessPath: input.businessPath } });
    return this.getRegressionCandidate(candidateId);
  }

  getRegressionCandidate(candidateId: string) {
    const row = getDatabase().prepare('SELECT * FROM workflow_regression_candidates WHERE id = ?').get(candidateId) as any;
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      issueId: row.issue_id,
      sourceTaskId: row.source_task_id,
      title: row.title,
      suite: row.suite,
      businessDomain: row.business_domain,
      businessPath: row.business_path,
      preconditions: parseJson(row.preconditions_json, []),
      steps: parseJson(row.steps_json, []),
      assertions: parseJson(row.assertions_json, []),
      confidence: row.confidence,
      status: row.status,
      generatedCode: row.generated_code,
      metadata: parseJson(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  updateRegressionCandidate(candidateId: string, input: JsonObject) {
    const candidate = this.getRegressionCandidate(candidateId);
    if (!candidate) return null;
    const metadata = { ...(candidate.metadata || {}), ...(input.metadata || {}) };
    const updatedAt = now();
    getDatabase().prepare(`
      UPDATE workflow_regression_candidates SET
        title = @title,
        status = @status,
        generated_code = @generatedCode,
        metadata_json = @metadataJson,
        updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id: candidateId,
      title: input.title === undefined ? candidate.title : normalizeText(input.title, 500),
      status: normalizeText(input.status, 50) || candidate.status,
      generatedCode: input.generatedCode === undefined ? candidate.generatedCode : String(input.generatedCode || ''),
      metadataJson: json(metadata, {}),
      updatedAt,
    });
    this.recordEvent({
      projectId: candidate.projectId,
      eventType: 'regression_candidate.updated',
      entityType: 'regression_candidate',
      entityId: candidateId,
      payload: { status: input.status || candidate.status, metadata: input.metadata || {} },
    });
    return this.getRegressionCandidate(candidateId);
  }

  listRegressionCandidates(projectId = DEFAULT_PROJECT_ID) {
    return (getDatabase().prepare(`
      SELECT id FROM workflow_regression_candidates WHERE project_id = ? ORDER BY updated_at DESC
    `).all(projectId) as any[]).map((row) => this.getRegressionCandidate(row.id));
  }

  saveKnowledge(input: JsonObject) {
    const timestamp = now();
    const entryId = normalizeText(input.id, 180) || id('knowledge');
    getDatabase().prepare(`
      INSERT INTO workflow_knowledge_entries (
        id, project_id, kind, fingerprint, title, summary, tags_json, source_refs_json,
        content_json, confidence, use_count, created_at, updated_at
      ) VALUES (
        @id, @projectId, @kind, @fingerprint, @title, @summary, @tagsJson, @sourceRefsJson,
        @contentJson, @confidence, @useCount, @createdAt, @updatedAt
      )
    `).run({
      id: entryId,
      projectId: normalizeText(input.projectId, 120) || DEFAULT_PROJECT_ID,
      kind: normalizeText(input.kind, 100) || 'engineering_note',
      fingerprint: normalizeText(input.fingerprint, 160) || null,
      title: normalizeText(input.title, 500),
      summary: normalizeText(input.summary, 5000),
      tagsJson: json(input.tags, []),
      sourceRefsJson: json(input.sourceRefs, []),
      contentJson: json(input.content, {}),
      confidence: Math.min(Math.max(Number(input.confidence) || 0.5, 0), 1),
      useCount: Math.max(Number(input.useCount) || 0, 0),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return this.getKnowledge(entryId);
  }

  getKnowledge(entryId: string) {
    const row = getDatabase().prepare('SELECT * FROM workflow_knowledge_entries WHERE id = ?').get(entryId) as any;
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      fingerprint: row.fingerprint,
      title: row.title,
      summary: row.summary,
      tags: parseJson(row.tags_json, []),
      sourceRefs: parseJson(row.source_refs_json, []),
      content: parseJson(row.content_json, {}),
      confidence: row.confidence,
      useCount: row.use_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listKnowledge(filters: JsonObject = {}) {
    const clauses = ['project_id = @projectId'];
    const params: JsonObject = { projectId: normalizeText(filters.projectId, 120) || DEFAULT_PROJECT_ID };
    if (filters.kind) {
      clauses.push('kind = @kind');
      params.kind = normalizeText(filters.kind, 100);
    }
    if (filters.query) {
      clauses.push('(title LIKE @query OR summary LIKE @query OR tags_json LIKE @query)');
      params.query = `%${normalizeText(filters.query, 200)}%`;
    }
    return (getDatabase().prepare(`
      SELECT id FROM workflow_knowledge_entries WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT 200
    `).all(params) as any[]).map((row) => this.getKnowledge(row.id));
  }

  recordAIEvaluation(input: JsonObject) {
    const evaluationId = normalizeText(input.id, 180) || id('ai_eval');
    getDatabase().prepare(`
      INSERT INTO workflow_ai_evaluations (
        id, project_id, capability, model, prompt_version, input_ref, output_json,
        score, accepted, latency_ms, token_usage, cost, notes, created_at
      ) VALUES (
        @id, @projectId, @capability, @model, @promptVersion, @inputRef, @outputJson,
        @score, @accepted, @latencyMs, @tokenUsage, @cost, @notes, @createdAt
      )
    `).run({
      id: evaluationId,
      projectId: normalizeText(input.projectId, 120) || DEFAULT_PROJECT_ID,
      capability: normalizeText(input.capability, 120),
      model: normalizeText(input.model, 120) || null,
      promptVersion: normalizeText(input.promptVersion, 120) || null,
      inputRef: normalizeText(input.inputRef, 500) || null,
      outputJson: json(input.output, {}),
      score: input.score === undefined ? null : Number(input.score),
      accepted: input.accepted === undefined ? null : input.accepted ? 1 : 0,
      latencyMs: input.latencyMs === undefined ? null : Number(input.latencyMs),
      tokenUsage: input.tokenUsage === undefined ? null : Number(input.tokenUsage),
      cost: input.cost === undefined ? null : Number(input.cost),
      notes: normalizeText(input.notes, 4000) || null,
      createdAt: now(),
    });
    return { id: evaluationId };
  }

  listAIEvaluations(projectId = DEFAULT_PROJECT_ID) {
    return (getDatabase().prepare(`
      SELECT * FROM workflow_ai_evaluations WHERE project_id = ? ORDER BY created_at DESC LIMIT 200
    `).all(projectId) as any[]).map((row) => ({
      id: row.id,
      capability: row.capability,
      model: row.model,
      promptVersion: row.prompt_version,
      inputRef: row.input_ref,
      output: parseJson(row.output_json, {}),
      score: row.score,
      accepted: row.accepted === null ? null : Boolean(row.accepted),
      latencyMs: row.latency_ms,
      tokenUsage: row.token_usage,
      cost: row.cost,
      notes: row.notes,
      createdAt: row.created_at,
    }));
  }

  updateAIEvaluation(evaluationId: string, input: JsonObject) {
    const existing = getDatabase().prepare('SELECT id FROM workflow_ai_evaluations WHERE id = ?').get(evaluationId);
    if (!existing) return null;
    getDatabase().prepare(`
      UPDATE workflow_ai_evaluations SET
        score = COALESCE(@score, score),
        accepted = COALESCE(@accepted, accepted),
        notes = COALESCE(@notes, notes)
      WHERE id = @id
    `).run({
      id: evaluationId,
      score: input.score === undefined ? null : Number(input.score),
      accepted: input.accepted === undefined ? null : input.accepted ? 1 : 0,
      notes: input.notes === undefined ? null : normalizeText(input.notes, 4000),
    });
    return this.listAIEvaluations().find((item: any) => item.id === evaluationId) || null;
  }

  addReleaseObservation(input: JsonObject) {
    const observationId = normalizeText(input.id, 180) || id('observation');
    getDatabase().prepare(`
      INSERT INTO workflow_release_observations (
        id, project_id, release_version, build_number, channel, metric, value,
        baseline_value, status, observed_at, metadata_json, created_at
      ) VALUES (
        @id, @projectId, @releaseVersion, @buildNumber, @channel, @metric, @value,
        @baselineValue, @status, @observedAt, @metadataJson, @createdAt
      )
    `).run({
      id: observationId,
      projectId: normalizeText(input.projectId, 120) || DEFAULT_PROJECT_ID,
      releaseVersion: normalizeText(input.releaseVersion, 120),
      buildNumber: normalizeText(input.buildNumber, 120) || null,
      channel: normalizeText(input.channel, 80) || null,
      metric: normalizeText(input.metric, 120),
      value: Number(input.value),
      baselineValue: input.baselineValue === undefined ? null : Number(input.baselineValue),
      status: normalizeText(input.status, 50) || 'normal',
      observedAt: normalizeText(input.observedAt, 80) || now(),
      metadataJson: json(input.metadata, {}),
      createdAt: now(),
    });
    return { id: observationId };
  }

  listReleaseObservations(projectId = DEFAULT_PROJECT_ID, releaseVersion?: string) {
    const rows = releaseVersion
      ? getDatabase().prepare(`SELECT * FROM workflow_release_observations WHERE project_id = ? AND release_version = ? ORDER BY observed_at DESC LIMIT 500`).all(projectId, releaseVersion)
      : getDatabase().prepare(`SELECT * FROM workflow_release_observations WHERE project_id = ? ORDER BY observed_at DESC LIMIT 500`).all(projectId);
    return (rows as any[]).map((row) => ({
      id: row.id,
      releaseVersion: row.release_version,
      buildNumber: row.build_number,
      channel: row.channel,
      metric: row.metric,
      value: row.value,
      baselineValue: row.baseline_value,
      status: row.status,
      observedAt: row.observed_at,
      metadata: parseJson(row.metadata_json, {}),
    }));
  }

  overview(projectId = DEFAULT_PROJECT_ID) {
    const db = getDatabase();
    const scalar = (sql: string, params: any[] = []) => Number((db.prepare(sql).get(...params) as any)?.count || 0);
    const tasksByStatus = db.prepare(`
      SELECT status, COUNT(*) AS count FROM workflow_tasks WHERE project_id = ? GROUP BY status
    `).all(projectId) as any[];
    const issuesBySeverity = db.prepare(`
      SELECT severity, COUNT(*) AS count FROM workflow_issues WHERE project_id = ? AND status NOT IN ('resolved', 'ignored') GROUP BY severity
    `).all(projectId) as any[];
    const latestGate = db.prepare(`
      SELECT id FROM workflow_release_gates WHERE project_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(projectId) as any;
    return {
      projectId,
      artifacts: scalar('SELECT COUNT(*) AS count FROM workflow_artifacts WHERE project_id = ?', [projectId]),
      tasks: scalar('SELECT COUNT(*) AS count FROM workflow_tasks WHERE project_id = ?', [projectId]),
      activeTasks: scalar(`SELECT COUNT(*) AS count FROM workflow_tasks WHERE project_id = ? AND status IN ('created','queued','preparing','installing','running','collecting','analyzing','reporting')`, [projectId]),
      openIssues: scalar(`SELECT COUNT(*) AS count FROM workflow_issues WHERE project_id = ? AND status NOT IN ('resolved','ignored')`, [projectId]),
      regressionCandidates: scalar('SELECT COUNT(*) AS count FROM workflow_regression_candidates WHERE project_id = ?', [projectId]),
      knowledgeEntries: scalar('SELECT COUNT(*) AS count FROM workflow_knowledge_entries WHERE project_id = ?', [projectId]),
      tasksByStatus: Object.fromEntries(tasksByStatus.map((item) => [item.status, item.count])),
      issuesBySeverity: Object.fromEntries(issuesBySeverity.map((item) => [item.severity, item.count])),
      latestGate: latestGate ? this.getReleaseGate(latestGate.id) : null,
      latestTasks: this.listTasks({ projectId, limit: 8 }),
      latestIssues: this.listIssues({ projectId, limit: 8 }),
    };
  }
}

export const workflowService = new WorkflowService();
