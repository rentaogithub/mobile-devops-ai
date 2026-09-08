import { assertApplicationServices, hasCurrentApplicationServices } from './ApplicationCapabilityService';
import axios from 'axios';
import { createHash, randomUUID } from 'crypto';
import { getDatabase } from '../database';
import { getJenkinsConfig } from '../config/externalServices';
import { currentApplication } from './ProductLineContext';
import { workflowService } from './WorkflowService';

export interface AndroidRun {
  id: string; applicationId: string; requestKey: string; kind: 'build' | 'smoke'; status: string;
  jobName: string; queueUrl?: string; buildNumber?: number;
  config: any; result: any; createdAt: string; updatedAt: string;
}
export interface AndroidTransport {
  get(baseUrl: string, path: string, binary?: boolean): Promise<any>;
  post(baseUrl: string, path: string, parameters: Record<string, string>): Promise<{ location?: string }>;
}
const transport: AndroidTransport = {
  async get(baseUrl, path, binary = false) {
    const { username, token, baseUrl: currentBase } = getJenkinsConfig();
    if (currentBase.replace(/\/$/, '') !== baseUrl) throw new Error('Jenkins 地址已改变，请恢复原地址后追踪历史任务');
    const result = await axios.get(`${baseUrl}/${path}`, { auth: username && token ? { username, password: token } : undefined,
      timeout: binary ? 120_000 : 20_000, maxRedirects: 0, maxContentLength: binary ? 512 * 1024 * 1024 : 2 * 1024 * 1024,
      responseType: binary ? 'arraybuffer' : 'json' });
    return result.data;
  },
  async post(baseUrl, path, parameters) {
    const { username, token, baseUrl: currentBase } = getJenkinsConfig();
    if (currentBase.replace(/\/$/, '') !== baseUrl) throw new Error('Jenkins 地址已改变');
    // API token authentication is required; Jenkins API tokens are exempt from crumbs.
    if (!username || !token) throw new Error('请配置产品线 Jenkins 用户与 API Token');
    const result = await axios.post(`${baseUrl}/${path}`, new URLSearchParams(parameters), {
      auth: { username, password: token }, timeout: 20_000, maxRedirects: 0,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return { location: result.headers.location };
  },
};
class AndroidEvidenceError extends Error {}
const terminal = new Set(['passed', 'failed', 'canceled', 'invalid_evidence']);
const jobPath = (name: string) => name.split('/').map((part) => `job/${encodeURIComponent(part)}`).join('/');
function fromRow(row: any): AndroidRun {
  return { id: row.id, applicationId: row.application_id, requestKey: row.request_key, kind: row.kind, status: row.status,
    jobName: row.job_name, queueUrl: row.queue_url || undefined, buildNumber: row.build_number || undefined,
    config: JSON.parse(row.config_json), result: JSON.parse(row.result_json), createdAt: row.created_at, updatedAt: row.updated_at };
}
function appContext() {
  const app = currentApplication();
  if (!app || app.platform !== 'android' || !app.active) throw new Error('请选择已启用的 Android 应用');
  return app;
}
function exactParameters(build: any, id: string) {
  return (build.actions || []).flatMap((a: any) => a.parameters || []).some((p: any) => p.name === 'PLATFORM_REQUEST_ID' && p.value === id);
}
function artifactPath(value: unknown) {
  if (typeof value !== 'string' || !/^[\w./-]+$/.test(value) || value.startsWith('/') || value.split('/').some((p) => !p || p === '..' || p === '.')) throw new Error('产物路径无效');
  return value.split('/').map(encodeURIComponent).join('/');
}

export class AndroidDeliveryService {
  constructor(private client: AndroidTransport = transport) {}
  readiness() {
    const app = appContext();
    const jenkins = getJenkinsConfig();
    const buildEnabled = hasCurrentApplicationServices('jenkins');
    const qualityEnabled = buildEnabled && hasCurrentApplicationServices('quality', 'devices');
    const required: (keyof typeof app.config)[] = buildEnabled ? ['repositoryUrl', 'buildJob', 'buildVariant', 'apkPath'] : [];
    if (qualityEnabled) required.push('qualityJob', 'deviceSerial');
    const missing: string[] = required.filter((key) => !app.config[key]);
    if (buildEnabled && !jenkins.baseUrl) missing.push('jenkinsBaseUrl');
    if (buildEnabled && (!jenkins.username || !jenkins.token)) missing.push('jenkinsApiCredentials');
    return { application: app, buildEnabled, qualityEnabled, configurationRevision: createHash('sha256').update(JSON.stringify({ id: app.id, packageId: app.packageId, config: app.config, baseUrl: jenkins.baseUrl, buildEnabled, qualityEnabled })).digest('hex'), configured: buildEnabled && missing.length === 0, missing, acceptance: 'pending_external_validation',
      supported: [...(buildEnabled ? ['apk'] : []), ...(qualityEnabled ? ['adb-launch-smoke', 'internal-download'] : [])], pending: ['aab', 'store-release', 'r8-ndk-symbols', 'performance'] };
  }
  list() {
    assertApplicationServices('jenkins');
    return (getDatabase().prepare('SELECT * FROM android_delivery_runs WHERE application_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100').all(appContext().id) as any[]).map(fromRow);
  }
  get(id: string) {
    const row = getDatabase().prepare('SELECT * FROM android_delivery_runs WHERE id = ? AND application_id = ?').get(id, appContext().id);
    if (!row) throw new Error('Android 任务不存在或不属于当前应用');
    return fromRow(row);
  }
  private save(run: AndroidRun) {
    run.updatedAt = new Date().toISOString();
    getDatabase().transaction(() => {
      getDatabase().prepare('UPDATE android_delivery_runs SET status = ?, queue_url = ?, build_number = ?, result_json = ?, updated_at = ? WHERE id = ? AND application_id = ?')
        .run(run.status, run.queueUrl || null, run.buildNumber || null, JSON.stringify(run.result), run.updatedAt, run.id, appContext().id);
      workflowService.upsertTask({ id: run.id, taskType: `android_${run.kind}`, source: 'jenkins', status: run.status,
        suite: run.kind === 'smoke' ? 'android-launch-smoke' : undefined, commitHash: run.config.commit,
        buildNumber: run.config.sourceRunId || run.id, externalId: run.buildNumber ? `${run.jobName}#${run.buildNumber}` : undefined,
        artifactId: run.config.sourceRunId ? `apk:${run.config.sourceRunId}` : undefined,
        config: { applicationId: run.applicationId, platform: 'android', ...run.config }, result: run.result });
    })();
    return run;
  }
  async trigger(input: { kind: 'build' | 'smoke'; requestKey: string; commit?: string; sourceRunId?: string; configurationRevision?: string }) {
    const app = appContext();
    assertApplicationServices('jenkins', ...(input.kind === 'smoke' ? ['quality', 'devices'] as const : []));
    if (!['build', 'smoke'].includes(input.kind) || typeof input.requestKey !== 'string' || !/^[\w-]{8,100}$/.test(input.requestKey || '')) throw new Error('需要有效的任务类型和稳定的请求键（8-100 位）');
    const commit = String(input.commit || '').toLowerCase();
    const old = getDatabase().prepare('SELECT * FROM android_delivery_runs WHERE application_id = ? AND request_key = ?').get(app.id, input.requestKey);
    if (old) {
      const previous = fromRow(old);
      if (previous.kind !== input.kind || (input.kind === 'build' ? previous.config.commit !== commit : previous.config.sourceRunId !== input.sourceRunId)) throw new Error('请求键已用于不同参数');
      return previous;
    }
    const pendingRuns = (getDatabase().prepare("SELECT * FROM android_delivery_runs WHERE application_id = ? AND kind = ? AND status NOT IN ('passed','failed','canceled','invalid_evidence')").all(app.id, input.kind) as any[]).map(fromRow);
    const active = pendingRuns.find((run) =>
      (input.kind === 'build' ? run.config.commit === commit : run.config.sourceRunId === input.sourceRunId));
    if (active) throw new Error(`已有相同目标的未结束任务 ${active.id}，请先同步或取消原任务`);
    const ready = this.readiness();
    if (input.configurationRevision && input.configurationRevision !== ready.configurationRevision) throw new Error('应用执行配置已变化，请刷新并重新确认目标 Job 与设备');
    const needed = input.kind === 'build' ? ['repositoryUrl', 'buildJob', 'buildVariant', 'apkPath', 'jenkinsBaseUrl', 'jenkinsApiCredentials'] : ['qualityJob', 'deviceSerial', 'jenkinsBaseUrl', 'jenkinsApiCredentials'];
    const missing = ready.missing.filter((key) => needed.includes(key));
    if (missing.length) throw new Error(`接入配置缺失：${missing.join('、')}`);
    if (input.kind === 'build' && !/^[a-f0-9]{40}$/.test(commit)) throw new Error('构建必须指定完整的 40 位 Git Commit');
    const source = input.kind === 'smoke' ? this.get(input.sourceRunId || '') : undefined;
    if (source && (source.kind !== 'build' || source.status !== 'passed' || !source.result.manifest)) throw new Error('Smoke 必须关联证据有效的 APK 构建');
    const baseUrl = getJenkinsConfig().baseUrl.replace(/\/$/, '');
    if (source && source.config.baseUrl !== baseUrl) throw new Error('源构建与当前 Jenkins 地址不一致');
    const timestamp = new Date().toISOString();
    const run: AndroidRun = { id: randomUUID(), applicationId: app.id, requestKey: input.requestKey, kind: input.kind,
      status: 'dispatch_unknown', jobName: input.kind === 'build' ? app.config.buildJob : app.config.qualityJob,
      config: { ...app.config, baseUrl, packageId: app.packageId, commit: source?.config.commit || commit,
        ...(source ? { sourceRunId: source.id, sourceJob: source.jobName, sourceBuild: source.buildNumber, sourceManifest: source.result.manifest } : {}) },
      result: {}, createdAt: timestamp, updatedAt: timestamp };
    // Persist before external submission; a timeout must never cause automatic resubmission.
    getDatabase().prepare(`INSERT INTO android_delivery_runs (id,application_id,request_key,kind,status,job_name,config_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(run.id, app.id, input.requestKey, run.kind, run.status, run.jobName, JSON.stringify(run.config), timestamp, timestamp);
    this.save(run);
    const parameters: Record<string, string> = { PLATFORM_REQUEST_ID: run.id, APPLICATION_ID: app.id, PACKAGE_ID: app.packageId, COMMIT: run.config.commit };
    if (source) Object.assign(parameters, { SOURCE_RUN_ID: source.id, SOURCE_JOB: source.jobName, SOURCE_BUILD: String(source.buildNumber),
      APK_PATH: source.result.manifest.apkPath, APK_SHA256: source.result.manifest.sha256, VERSION_CODE: source.result.manifest.versionCode,
      VERSION_NAME: source.result.manifest.versionName, DEVICE_SERIAL: app.config.deviceSerial });
    else Object.assign(parameters, { REPOSITORY_URL: app.config.repositoryUrl, BUILD_VARIANT: app.config.buildVariant, APK_PATH: app.config.apkPath });
    try {
      const response = await this.client.post(baseUrl, `${jobPath(run.jobName)}/buildWithParameters`, parameters);
      if (response.location) {
        const location = new URL(response.location, `${baseUrl}/`);
        const prefix = new URL(`${baseUrl}/queue/item/`);
        if (location.origin === prefix.origin && location.pathname.startsWith(prefix.pathname) && /^\d+\/$/.test(location.pathname.slice(prefix.pathname.length))) {
          run.queueUrl = location.pathname.slice(new URL(`${baseUrl}/`).pathname.length);
          run.status = 'queued';
        }
      }
    } catch { run.result.message = '提交响应不明；请同步原任务，禁止盲目重试'; }
    return this.save(run);
  }
  async refresh(id: string) {
    const run = this.get(id);
    assertApplicationServices('jenkins', ...(run.kind === 'smoke' ? ['quality', 'devices'] as const : []));
    if (terminal.has(run.status)) return run;
    const root = jobPath(run.jobName);
    try {
      if (!run.buildNumber && !run.queueUrl) {
        const queue = await this.client.get(run.config.baseUrl, 'queue/api/json?tree=items[id,task[url],actions[parameters[name,value]]]');
        const matches = (queue.items || []).filter((item: any) => exactParameters(item, run.id) && item.task?.url?.replace(/\/$/, '') === `${run.config.baseUrl}/${root}`);
        if (matches.length > 1) throw new Error('同一请求出现多个队列任务，需人工核验');
        if (matches.length === 1 && Number.isSafeInteger(matches[0].id) && matches[0].id > 0) run.queueUrl = `queue/item/${matches[0].id}/`;
      }
      if (!run.buildNumber && run.queueUrl) {
        try {
          const queue = await this.client.get(run.config.baseUrl, `${run.queueUrl}api/json`);
          if (!exactParameters(queue, run.id)) throw new Error('队列请求标识不匹配');
          if (queue.cancelled) { run.status = 'canceled'; return this.save(run); }
          if (Number.isSafeInteger(queue.executable?.number) && queue.executable.number > 0) run.buildNumber = queue.executable.number;
        } catch { /* Queue entries expire; recover by exact request ID below. */ }
      }
      if (!run.buildNumber) {
        const recent = await this.client.get(run.config.baseUrl, `${root}/api/json?tree=builds[number,actions[parameters[name,value]]]{0,100}`);
        const matches = (recent.builds || []).filter((build: any) => exactParameters(build, run.id));
        if (matches.length > 1) throw new Error('同一请求出现多个 Jenkins 构建，需人工核验');
        if (matches.length === 1 && Number.isSafeInteger(matches[0].number) && matches[0].number > 0) run.buildNumber = matches[0].number;
        else {
          run.result.message = '尚未找到对应构建；保留原请求，不自动重试';
          if (Date.now() - Date.parse(run.createdAt) > 45 * 60_000) run.status = 'timed_out';
          return this.save(run);
        }
      }
      const build = await this.client.get(run.config.baseUrl, `${root}/${run.buildNumber}/api/json`);
      if (!exactParameters(build, run.id)) throw new Error('构建请求标识不匹配');
      if (build.building) {
        run.status = Date.now() - Date.parse(run.createdAt) > 45 * 60_000 ? 'timed_out' : 'running';
        return this.save(run);
      }
      if (build.result !== 'SUCCESS') {
        run.status = build.result === 'ABORTED' ? 'canceled' : 'failed';
        run.result.message = `Jenkins 结果：${String(build.result || 'UNKNOWN').slice(0, 60)}`;
        if (run.kind === 'smoke' && build.result !== 'ABORTED') {
          try {
            const m = await this.client.get(run.config.baseUrl, `${root}/${run.buildNumber}/artifact/mobile-quality.json`);
            this.validateManifest(run, m, false);
            const logs = await this.verifySmokeEvidence(run, m);
            run.result.manifest = m;
            if (m.crashDetected || m.anrDetected) workflowService.upsertIssue({
              source: 'android-smoke', category: m.anrDetected ? 'android_anr' : 'android_crash', severity: 'high',
              fingerprint: `${run.id}:${m.anrDetected ? 'anr' : 'crash'}`, title: m.anrDetected ? 'Android 启动 Smoke 检测到 ANR' : 'Android 启动 Smoke 检测到 Crash',
              taskId: run.id, artifactId: `apk:${run.config.sourceRunId}`, buildNumber: run.config.sourceRunId, commitHash: run.config.commit,
              evidence: [{ runId: run.id, sha256: m.sha256, log: logs.slice(0, 100_000), symbolication: 'raw' }],
            });
          } catch { run.result.evidenceWarning = '失败任务的证据不完整，不能进行 Crash/ANR 归因'; }
        }
        return this.save(run);
      }
      const manifest = await this.client.get(run.config.baseUrl, `${root}/${run.buildNumber}/artifact/${run.kind === 'build' ? 'mobile-delivery.json' : 'mobile-quality.json'}`);
      try { this.validateManifest(run, manifest); }
      catch (error: any) { run.status = 'invalid_evidence'; run.result.message = error.message; return this.save(run); }
      if (run.kind === 'smoke') await this.verifySmokeEvidence(run, manifest);
      run.result = { manifest };
      run.status = 'passed';
      if (run.kind === 'build') workflowService.createArtifact({ id: `apk:${run.id}`, artifactType: 'android_apk', name: run.config.packageId,
        version: manifest.versionName, buildNumber: run.id, commitHash: manifest.commit, checksum: manifest.sha256,
        uri: `/api/android/runs/${run.id}/download`, metadata: { platform: 'android', applicationId: run.applicationId, jobName: run.jobName, jenkinsBuildNumber: run.buildNumber, ...manifest } });
      return this.save(run);
    } catch (error) {
      if (error instanceof AndroidEvidenceError) { run.status = 'invalid_evidence'; run.result.message = error.message; return this.save(run); }
      run.result.message = 'Jenkins 状态或证据读取失败，当前状态未验证；请稍后同步';
      if (Date.now() - Date.parse(run.createdAt) > 45 * 60_000) run.status = 'timed_out';
      return this.save(run);
    }
  }
  validateManifest(run: AndroidRun, m: any, requirePass = true) {
    if (!m || m.schemaVersion !== 1 || m.kind !== run.kind || m.requestId !== run.id || m.applicationId !== run.applicationId || m.packageId !== run.config.packageId || m.commit !== run.config.commit) throw new Error('证据身份与应用、请求或 Commit 不匹配');
    if (run.kind === 'build') {
      if (m.apkPath !== run.config.apkPath || !/^[a-f0-9]{64}$/.test(m.sha256 || '') || typeof m.versionCode !== 'string' || !/^[1-9]\d{0,9}$/.test(m.versionCode || '') || typeof m.versionName !== 'string' || !m.versionName || m.versionName.length > 120) throw new Error('APK 路径、版本或 SHA256 证据缺失');
      artifactPath(m.apkPath);
    } else {
      const source = run.config.sourceManifest;
      if (m.sourceRunId !== run.config.sourceRunId || m.sha256 !== source.sha256 || m.sourceBuild !== run.config.sourceBuild || m.sourceJob !== run.config.sourceJob || m.deviceSerial !== run.config.deviceSerial || m.installedPackageId !== run.config.packageId || m.installedVersionCode !== source.versionCode || m.installedVersionName !== source.versionName) throw new Error('Smoke 的源产物、实际安装版本、启动或 Crash/ANR 证据不通过');
      if (['passed', 'launchPassed', 'crashDetected', 'anrDetected'].some((key) => typeof m[key] !== 'boolean') || m.passed !== (m.launchPassed && !m.crashDetected && !m.anrDetected) || (requirePass && !m.passed)) throw new Error('Smoke 启动、Crash 或 ANR 证据不通过');
      if (!m.evidence || !m.evidence.logcat || !m.evidence.screenshot || !m.evidence.packageDump) throw new Error('Smoke 缺少日志、截图或安装信息');
      if (Object.keys(m.evidence).sort().join(',') !== 'logcat,packageDump,screenshot') throw new Error('Smoke 证据类型无效');
      Object.values(m.evidence).forEach(artifactPath);
      if (!m.evidenceSha256 || Object.keys(m.evidence).some((key) => !/^[a-f0-9]{64}$/.test(m.evidenceSha256[key] || ''))) throw new Error('Smoke 证据缺少校验值');
    }
  }
  private async verifySmokeEvidence(run: AndroidRun, manifest: any) {
    let logs = '';
    for (const key of ['logcat', 'screenshot', 'packageDump']) {
      const bytes = Buffer.from(await this.client.get(run.config.baseUrl, `${jobPath(run.jobName)}/${run.buildNumber}/artifact/${artifactPath(manifest.evidence[key])}`, true));
      if (!bytes.length || bytes.length > 20 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== manifest.evidenceSha256[key]) throw new AndroidEvidenceError('Smoke 证据文件缺失或校验失败');
      if (key === 'screenshot' && !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new AndroidEvidenceError('Smoke 截图不是有效 PNG');
      if (key === 'logcat') logs = bytes.toString('utf8');
    }
    return logs;
  }
  issues() { assertApplicationServices('quality'); return workflowService.listIssues({ limit: 100 }).filter((issue) => issue?.source === 'android-smoke'); }
  resolveIssue(id: string, smokeId: string) {
    assertApplicationServices('quality');
    const issue = workflowService.getIssue(id);
    const smoke = this.get(smokeId);
    if (!issue || issue.source !== 'android-smoke' || smoke.kind !== 'smoke' || smoke.status !== 'passed' || smoke.config.sourceRunId !== issue.buildNumber || smoke.createdAt <= issue.lastSeen) throw new Error('需要问题发生后、相同 APK 的通过 Smoke 作为复核证据');
    return getDatabase().transaction(() => {
      workflowService.addRelation({ fromType: 'issue', fromId: id, relation: 'verified_by', toType: 'task', toId: smokeId });
      workflowService.recordEvent({ eventType: 'android.issue_verified', entityType: 'issue', entityId: id, payload: { verifiedBySmoke: smokeId } });
      return workflowService.updateIssue(id, { status: 'resolved' });
    })();
  }
  gate(id: string) {
    assertApplicationServices('jenkins', 'quality', 'devices');
    const build = this.get(id);
    const rows = getDatabase().prepare("SELECT * FROM android_delivery_runs WHERE application_id = ? AND kind = 'smoke' ORDER BY created_at DESC, rowid DESC").all(appContext().id) as any[];
    const smoke = rows.map(fromRow).find((item) => item.config.sourceRunId === id);
    const openIssue = getDatabase().prepare("SELECT 1 FROM workflow_issues WHERE project_id = ? AND build_number = ? AND source = 'android-smoke' AND status != 'resolved' LIMIT 1").get(appContext().projectId, id);
    const passed = !openIssue && build.kind === 'build' && build.status === 'passed' && smoke?.status === 'passed';
    return { passed: Boolean(passed), buildRunId: id, smokeRunId: smoke?.id, reason: passed ? '固定 APK 构建与最近一次安装启动 Smoke 已通过；仅限内部测试分发' : '需要构建证据、最近一次同源 Smoke 通过且无未解决的 Crash/ANR；未知或失败均阻止下载' };
  }
  async download(id: string) {
    if (!this.gate(id).passed) throw new Error('APK 下载门禁未通过');
    const build = this.get(id);
    const bytes = Buffer.from(await this.client.get(build.config.baseUrl, `${jobPath(build.jobName)}/${build.buildNumber}/artifact/${artifactPath(build.result.manifest.apkPath)}`, true));
    if (createHash('sha256').update(bytes).digest('hex') !== build.result.manifest.sha256) throw new Error('APK SHA256 不匹配，已阻止下载');
    if (!this.gate(id).passed) throw new Error('下载期间门禁状态发生变化');
    workflowService.recordEvent({ eventType: 'android.internal_download', entityType: 'artifact', entityId: `apk:${id}`, payload: { sha256: build.result.manifest.sha256 } });
    return bytes;
  }
  async cancel(id: string) {
    assertApplicationServices('jenkins');
    const run = this.get(id);
    if (terminal.has(run.status)) return run;
    if (!run.buildNumber && !run.queueUrl) throw new Error('提交状态未知，请先同步找到准确任务后再取消');
    try {
      await this.client.post(run.config.baseUrl, run.buildNumber ? `${jobPath(run.jobName)}/${run.buildNumber}/stop` : 'queue/cancelItem', run.buildNumber ? {} : { id: run.queueUrl!.split('/').filter(Boolean).pop()! });
      run.status = 'cancel_requested'; run.result.message = '已请求取消，需同步确认 Jenkins 终态';
    } catch { run.result.message = '取消响应不明，请同步确认'; }
    return this.save(run);
  }
}
export const androidDeliveryService = new AndroidDeliveryService();
