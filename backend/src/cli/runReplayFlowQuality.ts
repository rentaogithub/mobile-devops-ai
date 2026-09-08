import '../config/env';
import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import path from 'path';
import { closeDatabase } from '../database';
import { deviceRecordingService } from '../services/DeviceRecordingService';
import {
  DeviceReplayFlowExecutionService,
  DeviceReplayRuntimeAdapter,
  ReplayFlowRun,
} from '../services/DeviceReplayFlowExecutionService';
import { DeviceReplayFlowDsl } from '../services/DeviceReplayFlow';
import { replayFlowAssetService } from '../services/ReplayFlowAssetService';
import {
  ReplayFlowQualityExecutionManifest,
  ReplayFlowQualityManifestPhase,
  replayFlowQualityService,
} from '../services/ReplayFlowQualityService';
import { workflowService } from '../services/WorkflowService';

type QualityStatus = 'passed' | 'failed' | 'infra_failed' | 'cancelled';

interface PhaseReport {
  phase: ReplayFlowQualityManifestPhase['phase'];
  assetId: string;
  assetName: string;
  versionId: string;
  versionNumber: number;
  status: ReplayFlowRun['status'] | 'skipped';
  run?: ReplayFlowRun;
  evidenceDirectory?: string;
  errorCode?: string;
  error?: string;
}

interface IterationReport {
  iteration: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'infra_failed';
  phases: PhaseReport[];
}

function valueOf<T = unknown>(response: any): T {
  return (response?.data?.value !== undefined ? response.data.value : response?.data) as T;
}

class WdaReplayRuntimeAdapter implements DeviceReplayRuntimeAdapter {
  private client: AxiosInstance;
  private sessionId = '';
  private windowSize?: { width: number; height: number };

  constructor(private baseUrl: string, private device: { udid: string; name: string; osVersion?: string }) {
    this.client = axios.create({ baseURL: baseUrl.replace(/\/+$/, ''), timeout: 15000 });
  }

  async connect() {
    await this.client.get('/status');
    const response = await this.client.post('/session', { capabilities: { alwaysMatch: {}, firstMatch: [{}] } });
    const value = valueOf<any>(response);
    this.sessionId = String(response.data?.sessionId || value?.sessionId || '');
    if (!this.sessionId) throw new Error('WDA 未返回 sessionId');
    try {
      await this.sessionRequest('POST', '/appium/settings', { settings: { waitForIdleTimeout: 0, animationCoolOffTimeout: 0 } });
    } catch {
      // 旧版 WDA 可能不支持该设置，不影响回放。
    }
    const size = valueOf<any>(await this.sessionRequest('GET', '/window/size'));
    const width = Number(size?.width);
    const height = Number(size?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('WDA 未返回有效的设备分辨率');
    this.windowSize = { width, height };
  }

  async disconnect() {
    if (!this.sessionId) return;
    try {
      await this.client.delete(`/session/${encodeURIComponent(this.sessionId)}`, { timeout: 5000 });
    } catch {
      // Jenkins 收尾会继续清理 WDA。
    }
    this.sessionId = '';
  }

  getStatus() {
    return { phase: this.sessionId ? 'connected' : 'idle', device: this.sessionId ? this.device : undefined, windowSize: this.windowSize };
  }

  async source() {
    return String(valueOf(await this.sessionRequest('GET', '/source')) || '');
  }

  async screenshot() {
    const encoded = String(valueOf(await this.sessionRequest('GET', '/screenshot')) || '');
    if (!encoded) throw new Error('WDA 未返回截图');
    return Buffer.from(encoded, 'base64');
  }

  async tap(x: number, y: number) {
    try {
      return await this.sessionRequest('POST', '/wda/tap/0', { x: Math.round(x), y: Math.round(y) });
    } catch {
      return this.sessionRequest('POST', '/actions', {
        actions: [{
          type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(x), y: Math.round(y) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 80 },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      });
    }
  }

  async swipe(startX: number, startY: number, endX: number, endY: number, durationMs: number) {
    return this.sessionRequest('POST', '/actions', {
      actions: [{
        type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(startX), y: Math.round(startY) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: Math.max(100, Math.round(durationMs)), origin: 'viewport', x: Math.round(endX), y: Math.round(endY) },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
  }

  async input(text: string) {
    return this.firstSupported(['/element/active/value', '/keys', '/wda/keys'], { value: Array.from(text), text });
  }

  async keyboard(key: 'Search' | 'Return' | 'Done' | 'Dismiss') {
    if (key === 'Dismiss') return this.firstSupported(['/wda/keyboard/dismiss', '/wda/keyboard/dismissWithKey'], {});
    return this.firstSupported(['/element/active/value', '/keys', '/wda/keys'], { value: ['\n'], text: '\n' });
  }

  async snapshotSource(flow: DeviceReplayFlowDsl, snapshotId: string) {
    if (flow.source?.type !== 'recording') throw new Error(`流程未绑定录制，无法读取快照 ${snapshotId}`);
    const file = deviceRecordingService.evidenceFile(flow.source.recordingId, snapshotId, 'source', 'jenkins', true);
    return fs.readFileSync(file, 'utf8');
  }

  private sessionRequest(method: string, endpoint: string, body?: unknown) {
    if (!this.sessionId) throw new Error('WDA 会话未建立');
    return this.client.request({ method, url: `/session/${encodeURIComponent(this.sessionId)}${endpoint}`, data: body });
  }

  private async firstSupported(endpoints: string[], body: unknown) {
    let lastError: unknown;
    for (const endpoint of endpoints) {
      try {
        return await this.sessionRequest('POST', endpoint, body);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('WDA 操作失败');
  }
}

function writeReport(reportPath: string, report: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

function writeReplayProgress(params: {
  progressFile: string;
  startedAtMs: number;
  durationSeconds: number;
  completedIterations: number;
  message: string;
}) {
  if (!params.progressFile) return;
  try {
    const current = fs.existsSync(params.progressFile)
      ? JSON.parse(fs.readFileSync(params.progressFile, 'utf8'))
      : {};
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - params.startedAtMs) / 1000));
    const remainingSeconds = Math.max(0, params.durationSeconds - elapsedSeconds);
    const progressPercent = params.durationSeconds > 0
      ? Math.min(99, Math.max(0, Number(((elapsedSeconds / params.durationSeconds) * 100).toFixed(2))))
      : Number(current.progressPercent || 0);
    const next = {
      ...current,
      status: 'running',
      phase: 'replayFlow',
      message: params.message,
      updatedAt: Date.now(),
      elapsedSeconds,
      remainingSeconds,
      executedEvents: params.completedIterations,
      requestedDurationSeconds: params.durationSeconds,
      progressPercent,
    };
    const temporary = `${params.progressFile}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(params.progressFile), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(temporary, params.progressFile);
  } catch {
    // 进度心跳不得影响真机回放主链路。
  }
}

function isInfrastructureFailure(errorCode?: string, message?: string) {
  return /WDA_|ECONN|socket|session|device.*(locked|disconnect)|设备.*(锁定|断开)|WDA.*(失败|中断|超时)|固化清单不一致/i.test(`${errorCode || ''} ${message || ''}`);
}

function evidenceBundleId(runRoot: string, runId: string, evidenceId?: string) {
  if (!evidenceId) return '';
  const sourcePath = path.join(runRoot, runId, 'evidence', `${evidenceId}.xml`);
  if (!fs.existsSync(sourcePath)) return '';
  const source = fs.readFileSync(sourcePath, 'utf8');
  return source.match(/<XCUIElementTypeApplication\b[^>]*\bbundleId="([^"]+)"/)?.[1] || '';
}

function summarizeRunFailure(run: ReplayFlowRun, runRoot: string) {
  const failedNode = [...run.nodes].reverse().find((node) => node.status === 'failed' && node.nodeType !== 'end')
    || [...run.nodes].reverse().find((node) => node.status === 'failed');
  if (!failedNode) {
    return { errorCode: run.errorCode || 'REPLAY_FLOW_FAILED', error: run.error || '回放流程执行失败' };
  }
  const before = [...failedNode.evidence].reverse().find((item) => item.phase === 'before');
  const after = [...failedNode.evidence].reverse().find((item) => item.phase === 'after');
  const beforeBundleId = evidenceBundleId(runRoot, run.id, before?.id);
  const afterBundleId = evidenceBundleId(runRoot, run.id, after?.id);
  if (beforeBundleId && afterBundleId === 'com.apple.springboard' && beforeBundleId !== afterBundleId) {
    return {
      errorCode: 'APP_TERMINATED',
      error: `目标 App ${beforeBundleId} 在节点 ${failedNode.nodeId}（${failedNode.nodeType}）执行期间退出到系统桌面`,
      nodeId: failedNode.nodeId,
      nodeType: failedNode.nodeType,
      beforeBundleId,
      afterBundleId,
    };
  }
  return {
    errorCode: failedNode.errorCode || run.errorCode || 'REPLAY_FLOW_FAILED',
    error: failedNode.error || run.error || `节点 ${failedNode.nodeId} 执行失败`,
    nodeId: failedNode.nodeId,
    nodeType: failedNode.nodeType,
    beforeBundleId,
    afterBundleId,
  };
}

async function main() {
  const taskId = String(process.env.PLATFORM_TASK_ID || '').trim();
  const expectedManifestId = String(process.env.REPLAY_FLOW_EXECUTION_MANIFEST_ID || '').trim();
  const reportPath = path.resolve(process.env.REPLAY_FLOW_REPORT_FILE || path.join(process.cwd(), 'replay-flow-report.json'));
  const runRoot = path.resolve(process.env.REPLAY_FLOW_RUN_DIR || path.join(path.dirname(reportPath), 'replay-flow-runs'));
  const startedAt = new Date().toISOString();
  let adapter: WdaReplayRuntimeAdapter | undefined;
  const iterations: IterationReport[] = [];
  try {
    if (!taskId) throw new Error('PLATFORM_TASK_ID 为空，无法读取固化回放清单');
    const task = workflowService.getTask(taskId);
    if (!task) throw new Error(`质检任务 ${taskId} 不存在`);
    const taskConfig = task.config as Record<string, any>;
    const configuration = taskConfig.replayFlowExecution as { manifest?: ReplayFlowQualityExecutionManifest } | undefined;
    const manifest = configuration?.manifest;
    if (!manifest) throw new Error(`质检任务 ${taskId} 不包含回放执行清单`);
    if (expectedManifestId && manifest.id !== expectedManifestId) throw new Error('回放执行清单 ID 与 Jenkins 任务不一致');
    const configuredDuration = Number(process.env.REPLAY_FLOW_DURATION_SECONDS || manifest.durationSeconds);
    const durationSeconds = Number.isFinite(configuredDuration) && configuredDuration > 0 ? configuredDuration : manifest.durationSeconds;
    const progressFile = String(process.env.QUALITY_PROGRESS_FILE || '').trim();
    const replayStartedAtMs = Date.now();
    const updateProgress = (message: string, completedIterations = iterations.length) => writeReplayProgress({
      progressFile,
      startedAtMs: replayStartedAtMs,
      durationSeconds,
      completedIterations,
      message,
    });
    const stopOnFailure = String(process.env.REPLAY_FLOW_STOP_ON_FAILURE || (manifest.stopOnFailure ? '1' : '0')) !== '0';
    const wdaUrl = String(process.env.WDA_URL || taskConfig.wdaUrl || 'http://127.0.0.1:8100');
    const udid = String(process.env.DEVICE_UDID || task.deviceUdid || 'ios-device');
    adapter = new WdaReplayRuntimeAdapter(wdaUrl, { udid, name: String(process.env.DEVICE_NAME || udid) });
    await adapter.connect();
    const executor = new DeviceReplayFlowExecutionService(adapter, runRoot);
    const runtimeInputs = replayFlowQualityService.readRuntimeInputs(manifest.id);
    const deadline = Date.now() + durationSeconds * 1000;
    let iterationNumber = 0;
    let overallStatus: QualityStatus = 'passed';
    let infrastructureFailureCount = 0;
    updateProgress('回放执行器已就绪，准备开始第 1 轮');

    while (Date.now() < deadline) {
      iterationNumber += 1;
      const iterationStarted = Date.now();
      const phases: PhaseReport[] = [];
      let iterationFailed = false;
      let iterationInfraFailed = false;
      let preFailed = false;
      updateProgress(`第 ${iterationNumber} 轮开始执行`);
      for (const phase of manifest.phases) {
        if (phase.phase === 'main' && preFailed) {
          phases.push({ ...phase, status: 'skipped', error: '前置流程失败' });
          iterationFailed = true;
          continue;
        }
        try {
          const phaseLabel = phase.phase === 'pre' ? '前置' : phase.phase === 'post' ? '后置' : '主';
          updateProgress(`第 ${iterationNumber} 轮：执行${phaseLabel}流程“${phase.assetName}”`);
          const version = replayFlowAssetService.getVersion(phase.versionId);
          if (version.assetId !== phase.assetId || version.versionNumber !== phase.versionNumber) {
            throw new Error(`${phase.assetName} 版本与固化清单不一致`);
          }
          const started = executor.start(version.flow, runtimeInputs, 'jenkins', true);
          const run = await executor.waitForCompletion(started.id);
          const failure = run.status === 'succeeded' ? undefined : summarizeRunFailure(run, runRoot);
          phases.push({
            ...phase,
            status: run.status,
            run,
            evidenceDirectory: path.posix.join('replay-flow-runs', run.id, 'evidence'),
            errorCode: failure?.errorCode,
            error: failure?.error,
          });
          if (run.status !== 'succeeded') {
            iterationFailed = true;
            if (isInfrastructureFailure(failure?.errorCode || run.errorCode, failure?.error || run.error)) iterationInfraFailed = true;
            if (phase.phase === 'pre') preFailed = true;
          }
        } catch (error: any) {
          phases.push({ ...phase, status: 'failed', error: error?.message || '回放阶段执行失败' });
          iterationFailed = true;
          if (isInfrastructureFailure(error?.code, error?.message) || /version|manifest|版本|清单/i.test(String(error?.message || ''))) iterationInfraFailed = true;
          if (phase.phase === 'pre') preFailed = true;
        }
      }
      iterations.push({
        iteration: iterationNumber,
        startedAt: new Date(iterationStarted).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - iterationStarted,
        status: iterationInfraFailed ? 'infra_failed' : iterationFailed ? 'failed' : 'passed',
        phases,
      });
      updateProgress(
        iterationFailed
          ? `第 ${iterationNumber} 轮执行失败，正在生成证据和报告`
          : `已完成 ${iterationNumber} 轮，准备下一轮`,
        iterationNumber,
      );
      if (iterationFailed) {
        if (iterationInfraFailed) infrastructureFailureCount += 1;
        overallStatus = infrastructureFailureCount > 0 ? 'infra_failed' : 'failed';
        if (stopOnFailure) break;
      }
    }

    const failedIteration = [...iterations].reverse().find((iteration) => iteration.status !== 'passed');
    const failedPhase = failedIteration?.phases.find((phase) => phase.status === 'failed' || phase.status === 'cancelled');
    const failedNode = failedPhase?.run
      ? [...failedPhase.run.nodes].reverse().find((node) => node.status === 'failed' && node.nodeType !== 'end')
      : undefined;
    const failure = failedIteration && failedPhase ? {
      iteration: failedIteration.iteration,
      phase: failedPhase.phase,
      assetId: failedPhase.assetId,
      assetName: failedPhase.assetName,
      versionId: failedPhase.versionId,
      nodeId: failedNode?.nodeId,
      nodeType: failedNode?.nodeType,
      errorCode: failedPhase.errorCode || failedNode?.errorCode || failedPhase.run?.errorCode,
      error: failedPhase.error || failedNode?.error || failedPhase.run?.error || '回放阶段执行失败',
    } : undefined;
    writeReport(reportPath, {
      schemaVersion: '1.0', manifest, status: overallStatus, startedAt, finishedAt: new Date().toISOString(),
      durationSeconds, stopOnFailure, iterationCount: iterations.length,
      ...(failure ? { errorCode: failure.errorCode, error: `第 ${failure.iteration} 轮${failure.phase === 'pre' ? '前置' : failure.phase === 'post' ? '后置' : '主'}流程“${failure.assetName}”失败：${failure.error}`, failure } : {}),
      iterations,
    });
    updateProgress(overallStatus === 'passed' ? '回放执行完成，正在生成质检报告' : '回放执行失败，正在收集证据', iterations.length);
    if (overallStatus !== 'passed') process.exitCode = 1;
  } catch (error: any) {
    writeReport(reportPath, {
      schemaVersion: '1.0', status: 'infra_failed', startedAt, finishedAt: new Date().toISOString(),
      error: error?.message || '回放任务质检执行器异常', iterations,
    });
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 2;
  } finally {
    await adapter?.disconnect();
    closeDatabase();
  }
}

void main();
