import fs from 'fs';
import path from 'path';
import { getDatabase, getDatabasePath } from '../database';
import { platformConfigService } from './PlatformConfigService';
import { StorageService } from './StorageService';
import logger from '../utils/logger';

type SyncSource = 'jenkins' | 'quality' | 'dsym' | 'pods' | 'sentry';

interface OperationStatus {
  source: SyncSource;
  running: boolean;
  lastStartedAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  durationMs?: number;
  itemCount?: number;
}

const SYNC_SOURCES: SyncSource[] = ['jenkins', 'quality', 'dsym', 'pods', 'sentry'];

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function directorySize(target: string): number {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (stat.isFile()) return stat.size;
  return fs.readdirSync(target).reduce((total, name) => {
    try {
      return total + directorySize(path.join(target, name));
    } catch {
      return total;
    }
  }, 0);
}

export class PlatformOperationsService {
  private baseUrl = 'http://127.0.0.1:3000';
  private syncTimer: NodeJS.Timeout | null = null;
  private backupTimer: NodeJS.Timeout | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private readonly statuses = new Map<SyncSource, OperationStatus>(
    SYNC_SOURCES.map((source) => [source, { source, running: false }])
  );
  private lastBackup?: { path: string; size: number; createdAt: string };

  start(port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    if (process.env.WORKFLOW_SYNC_ENABLED !== 'false') {
      const intervalMs = numberEnv('WORKFLOW_SYNC_INTERVAL_MINUTES', 10) * 60 * 1000;
      this.startupTimer = setTimeout(() => void this.runAllSyncs(), 15_000);
      this.syncTimer = setInterval(() => void this.runAllSyncs(), intervalMs);
      this.startupTimer.unref?.();
      this.syncTimer.unref?.();
      logger.info('Workflow 后台同步已启动', { intervalMinutes: intervalMs / 60_000 });
    }

    if (process.env.WORKFLOW_BACKUP_ENABLED !== 'false') {
      const intervalMs = numberEnv('WORKFLOW_BACKUP_INTERVAL_HOURS', 24) * 60 * 60 * 1000;
      this.backupTimer = setInterval(() => void this.backupDatabase(), intervalMs);
      this.backupTimer.unref?.();
    }

    const checkpointMs = numberEnv('WORKFLOW_WAL_CHECKPOINT_HOURS', 6) * 60 * 60 * 1000;
    this.checkpointTimer = setInterval(() => this.checkpointWal(), checkpointMs);
    this.checkpointTimer.unref?.();
  }

  stop() {
    [this.syncTimer, this.backupTimer, this.checkpointTimer, this.startupTimer].forEach((timer) => {
      if (timer) clearInterval(timer);
    });
    this.syncTimer = null;
    this.backupTimer = null;
    this.checkpointTimer = null;
    this.startupTimer = null;
  }

  getSyncStatus() {
    return {
      enabled: process.env.WORKFLOW_SYNC_ENABLED !== 'false',
      intervalMinutes: numberEnv('WORKFLOW_SYNC_INTERVAL_MINUTES', 10),
      sources: SYNC_SOURCES.map((source) => this.statuses.get(source)),
    };
  }

  async runAllSyncs() {
    for (const source of SYNC_SOURCES) {
      await this.runSync(source);
    }
    return this.getSyncStatus();
  }

  async runSync(source: SyncSource) {
    if (!SYNC_SOURCES.includes(source)) throw new Error(`不支持的同步源: ${source}`);
    const status = this.statuses.get(source)!;
    if (status.running) return status;
    status.running = true;
    status.lastStartedAt = new Date().toISOString();
    const startedAt = Date.now();
    try {
      const request = this.syncRequest(source);
      const response = await this.fetchJson(request.path, request.init, request.timeoutMs);
      status.lastSuccessAt = new Date().toISOString();
      status.lastError = undefined;
      status.itemCount = this.extractItemCount(response);
    } catch (error: any) {
      status.lastErrorAt = new Date().toISOString();
      status.lastError = error?.message || String(error);
      logger.warn('Workflow 后台同步失败', { source, error: status.lastError });
    } finally {
      status.running = false;
      status.durationMs = Date.now() - startedAt;
    }
    return status;
  }

  private syncRequest(source: SyncSource) {
    if (source === 'jenkins') return { path: '/api/jenkins/nn/builds', timeoutMs: 45_000 };
    if (source === 'quality') return { path: '/api/jenkins/nn/quality/builds', timeoutMs: 45_000 };
    if (source === 'dsym') return { path: '/api/dsym/list', timeoutMs: 30_000 };
    if (source === 'pods') return { path: '/api/pods/list', timeoutMs: 30_000 };
    return {
      path: '/api/sentry-analysis/issues',
      timeoutMs: 120_000,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: '24h', limit: 20 }),
      } as RequestInit,
    };
  }

  private async fetchJson(relativePath: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${relativePath}`, { ...init, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) throw new Error(`${relativePath} -> HTTP ${response.status}: ${text.slice(0, 200)}`);
      const parsed = text ? JSON.parse(text) : {};
      if (parsed?.success === false) throw new Error(parsed.error || `${relativePath} 同步失败`);
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  private extractItemCount(response: any) {
    const data = response?.data;
    if (Array.isArray(data)) return data.length;
    for (const value of [data?.builds, data?.issues, data?.items, data?.dsyms, data?.components]) {
      if (Array.isArray(value)) return value.length;
    }
    return Number(data?.total) || undefined;
  }

  readiness() {
    try {
      getDatabase().prepare('SELECT 1 AS ok').get();
      const dbPath = getDatabasePath();
      const stat = fs.statSync(dbPath);
      return { ready: true, database: 'connected', databasePath: dbPath, databaseSize: stat.size, checkedAt: new Date().toISOString() };
    } catch (error: any) {
      return { ready: false, database: 'unavailable', error: error?.message || String(error), checkedAt: new Date().toISOString() };
    }
  }

  async dependencies() {
    const probes = await Promise.all([
      this.probe('jenkins', '/api/jenkins/nn/builds', 20_000),
      this.probe('sonic', '/api/jenkins/nn/quality/sonic/status', 10_000),
      this.probe('devices', '/api/jenkins/nn/quality/sonic/device-pools/status', 15_000),
      this.probe('sentry', `/sentry/api/0/projects/${process.env.SENTRY_ORG || 'sentry'}/${process.env.SENTRY_PROJECT || 'nn-ios'}/issues/?limit=1`, 15_000),
    ]);
    const dependencies: Record<string, any> = Object.fromEntries(probes.map((item) => [item.name, item]));
    dependencies.openai = {
      name: 'openai',
      required: true,
      configured: platformConfigService.status().aiApiKeyConfigured,
      status: platformConfigService.status().aiApiKeyConfigured ? 'configured' : 'unconfigured',
    };
    dependencies.xcuiTestRunner = {
      name: 'xcuiTestRunner',
      required: false,
      configured: Boolean(process.env.WORKFLOW_XCUITEST_RUNNER_URL),
      status: process.env.WORKFLOW_XCUITEST_RUNNER_URL ? 'configured' : 'optional_unconfigured',
    };
    const degraded = Object.values(dependencies).filter((item: any) =>
      ['down', 'degraded', 'unconfigured'].includes(item.status)
    );
    return { status: degraded.length ? 'degraded' : 'healthy', dependencies, checkedAt: new Date().toISOString() };
  }

  private async probe(name: string, endpoint: string, timeoutMs: number) {
    const startedAt = Date.now();
    try {
      const result = await this.fetchJson(endpoint, {}, timeoutMs);
      let status = 'up';
      if (name === 'sonic' && result?.data?.reachable === false) status = 'down';
      if (name === 'devices' && !result?.data?.pools?.some((pool: any) => Number(pool?.stats?.online) > 0)) status = 'degraded';
      return {
        name,
        status,
        latencyMs: Date.now() - startedAt,
        detail: this.summarizeDependency(name, result),
      };
    } catch (error: any) {
      return { name, status: 'down', latencyMs: Date.now() - startedAt, error: error?.message || String(error) };
    }
  }

  private summarizeDependency(name: string, result: any) {
    const data = result?.data;
    if (name === 'jenkins') {
      const builds = Array.isArray(data?.builds) ? data.builds : [];
      const latest = builds[0] || data?.job?.lastBuild || {};
      return {
        reachable: true,
        buildCount: Number(data?.stats?.total ?? builds.length),
        latestBuild: data?.stats?.latestBuild ?? latest?.number ?? null,
        latestResult: latest?.result || null,
        running: Number(data?.stats?.running || 0),
        successRate: data?.stats?.successRate || null,
      };
    }
    if (name === 'sonic') {
      return {
        reachable: Boolean(data?.reachable),
        configured: Boolean(data?.configured),
        tokenConfigured: Boolean(data?.tokenConfigured),
        message: String(data?.message || ''),
      };
    }
    if (name === 'devices') {
      const pools = Array.isArray(data?.pools) ? data.pools : [];
      const totals = pools.reduce((summary: any, pool: any) => {
        const stats = pool?.stats || {};
        summary.total += Number(stats.total || 0);
        summary.online += Number(stats.online || 0);
        summary.idle += Number(stats.idle || 0);
        summary.busy += Number(stats.busy || 0);
        summary.offline += Number(stats.offline || 0);
        return summary;
      }, { total: 0, online: 0, idle: 0, busy: 0, offline: 0 });
      return {
        reachable: data?.detector?.available !== false,
        poolCount: pools.length,
        detectedCount: Array.isArray(data?.detectedDevices) ? data.detectedDevices.length : 0,
        ...totals,
        detectorError: data?.detector?.error || undefined,
      };
    }
    if (name === 'sentry') {
      const issues = Array.isArray(data) ? data : Array.isArray(result) ? result : [];
      return { reachable: true, issueCount: issues.length };
    }
    return { reachable: true };
  }

  async backupDatabase() {
    const dbPath = getDatabasePath();
    const backupDir = process.env.WORKFLOW_BACKUP_DIR || path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(backupDir, `database-${stamp}.sqlite`);
    await getDatabase().backup(destination);
    this.checkpointWal();
    this.pruneBackups(backupDir);
    const stat = fs.statSync(destination);
    this.lastBackup = { path: destination, size: stat.size, createdAt: new Date().toISOString() };
    logger.info('Workflow 数据库备份完成', this.lastBackup);
    return this.lastBackup;
  }

  private pruneBackups(backupDir: string) {
    const cutoff = Date.now() - numberEnv('WORKFLOW_BACKUP_RETENTION_DAYS', 7) * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(backupDir)) {
      const filePath = path.join(backupDir, name);
      try {
        if (name.startsWith('database-') && fs.statSync(filePath).mtimeMs < cutoff) fs.rmSync(filePath, { force: true });
      } catch {
        // 单个备份清理失败不影响新备份。
      }
    }
  }

  checkpointWal() {
    try {
      return getDatabase().pragma('wal_checkpoint(PASSIVE)');
    } catch (error: any) {
      logger.warn('SQLite WAL checkpoint 失败', { error: error?.message || String(error) });
      return [];
    }
  }

  storageReport() {
    const dbPath = getDatabasePath();
    const root = path.dirname(dbPath);
    const dsymDir = process.env.DSYM_DIR || path.join(root, 'dsyms');
    const backupDir = process.env.WORKFLOW_BACKUP_DIR || path.join(root, 'backups');
    const candidates = this.retentionCandidates();
    return {
      root,
      totalSize: directorySize(root),
      database: { path: dbPath, size: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0 },
      walSize: fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0,
      dsyms: { path: dsymDir, size: directorySize(dsymDir), count: fs.existsSync(dsymDir) ? fs.readdirSync(dsymDir).length : 0 },
      backups: { path: backupDir, size: directorySize(backupDir), count: fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0, lastBackup: this.lastBackup },
      retention: candidates,
    };
  }

  retentionCandidates() {
    const db = getDatabase();
    const dsymDays = numberEnv('DSYM_RETENTION_DAYS', 90);
    const eventDays = numberEnv('WORKFLOW_EVENT_RETENTION_DAYS', 180);
    const gateDays = numberEnv('WORKFLOW_GATE_RETENTION_DAYS', 365);
    const dsymCutoff = Date.now() - dsymDays * 24 * 60 * 60 * 1000;
    const keepLatest = numberEnv('DSYM_RETENTION_KEEP_LATEST_PER_APP', 5);
    const rows = db.prepare('SELECT uuid, app_name, version, file_path, file_size, upload_time FROM dsym_info ORDER BY app_name, upload_time DESC').all() as any[];
    const appCounts = new Map<string, number>();
    const dsymCandidates = rows.filter((row) => {
      const count = appCounts.get(row.app_name) || 0;
      appCounts.set(row.app_name, count + 1);
      if (count < keepLatest) return false;
      let timestamp = Date.parse(String(row.upload_time || ''));
      try { timestamp = fs.statSync(row.file_path).mtimeMs; } catch { /* 使用 DB 时间 */ }
      return Number.isFinite(timestamp) && timestamp < dsymCutoff;
    }).map((row) => ({ uuid: row.uuid, appName: row.app_name, version: row.version, filePath: row.file_path, fileSize: row.file_size }));
    return {
      policy: { dsymDays, eventDays, gateDays, keepLatest, deletionEnabled: process.env.WORKFLOW_RETENTION_ALLOW_DELETE === 'true' },
      dsymCandidates,
      eventCount: Number((db.prepare("SELECT count(*) AS count FROM workflow_events WHERE occurred_at < datetime('now', ?)").get(`-${eventDays} days`) as any)?.count || 0),
      gateCount: Number((db.prepare("SELECT count(*) AS count FROM workflow_release_gates WHERE created_at < datetime('now', ?)").get(`-${gateDays} days`) as any)?.count || 0),
    };
  }

  async applyRetention(confirm: string) {
    if (process.env.WORKFLOW_RETENTION_ALLOW_DELETE !== 'true') throw new Error('保留策略当前为只读预览；设置 WORKFLOW_RETENTION_ALLOW_DELETE=true 后才能执行');
    if (confirm !== 'DELETE_EXPIRED_DATA') throw new Error('缺少保留策略执行确认');
    const candidates = this.retentionCandidates();
    const storage = new StorageService();
    let freedSpace = 0;
    for (const candidate of candidates.dsymCandidates) {
      await storage.deleteDSYM(candidate.uuid);
      freedSpace += Number(candidate.fileSize || 0);
    }
    const db = getDatabase();
    const deletedEvents = db.prepare("DELETE FROM workflow_events WHERE occurred_at < datetime('now', ?)").run(`-${candidates.policy.eventDays} days`).changes;
    const deletedGates = db.prepare("DELETE FROM workflow_release_gates WHERE created_at < datetime('now', ?)").run(`-${candidates.policy.gateDays} days`).changes;
    this.checkpointWal();
    return { deletedDsyms: candidates.dsymCandidates.length, deletedEvents, deletedGates, freedSpace };
  }

  compactWorkflowPayloads() {
    const db = getDatabase();
    const compactComponent = (component: any) => component && typeof component === 'object' ? {
      id: component.id,
      name: component.name,
      version: component.version,
      summary: String(component.summary || '').slice(0, 500),
      homepage: component.homepage,
      sourceZipUrl: component.sourceZipUrl || component.source_zip_url || component.download_url || component.zip_url,
      status: component.status,
      uploadTime: component.uploadTime || component.upload_time,
      packageType: component.packageType || component.package_type,
      buildId: component.buildId || component.build_id || component.buildNumber,
      branch: component.branch || component.target_branch || component.targetBranch,
    } : component;

    let tasksUpdated = 0;
    const tasks = db.prepare("SELECT id, result_json FROM workflow_tasks WHERE suite = 'pods'").all() as any[];
    const updateTask = db.prepare('UPDATE workflow_tasks SET result_json = ?, updated_at = ? WHERE id = ?');
    for (const task of tasks) {
      try {
        const result = JSON.parse(task.result_json || '{}');
        if (!result.component) continue;
        updateTask.run(JSON.stringify({ ...result, component: compactComponent(result.component) }), new Date().toISOString(), task.id);
        tasksUpdated += 1;
      } catch {
        // 跳过损坏的历史 JSON。
      }
    }

    let artifactsUpdated = 0;
    const artifacts = db.prepare("SELECT id, metadata_json FROM workflow_artifacts WHERE artifact_type = 'pod_component'").all() as any[];
    const updateArtifact = db.prepare('UPDATE workflow_artifacts SET metadata_json = ?, updated_at = ? WHERE id = ?');
    for (const artifact of artifacts) {
      try {
        const metadata = JSON.parse(artifact.metadata_json || '{}');
        if (!metadata.component) continue;
        updateArtifact.run(JSON.stringify({ ...metadata, component: compactComponent(metadata.component) }), new Date().toISOString(), artifact.id);
        artifactsUpdated += 1;
      } catch {
        // 跳过损坏的历史 JSON。
      }
    }
    this.checkpointWal();
    return { tasksUpdated, artifactsUpdated };
  }
}

export const platformOperationsService = new PlatformOperationsService();
