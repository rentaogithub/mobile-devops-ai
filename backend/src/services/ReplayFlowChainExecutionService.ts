import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DeviceControlError } from './DeviceControlService';
import {
  DeviceReplayFlowExecutionService,
  ReplayFlowRun,
  deviceReplayFlowExecutionService,
} from './DeviceReplayFlowExecutionService';
import { ReplayFlowAsset, ReplayFlowAssetService, replayFlowAssetService } from './ReplayFlowAssetService';
import logger from '../utils/logger';
import { currentProjectId } from './ProductLineContext';

export type ReplayFlowChainPhase = 'pre' | 'main' | 'post';
export type ReplayFlowChainPhaseStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
export type ReplayFlowChainRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ReplayFlowChainPhaseRun {
  phase: ReplayFlowChainPhase;
  assetId: string;
  assetName: string;
  status: ReplayFlowChainPhaseStatus;
  replayRunId?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  errorCode?: string;
  error?: string;
}

export interface ReplayFlowChainRun {
  id: string;
  projectId: string;
  mainAssetId: string;
  mainAssetName: string;
  owner: string;
  status: ReplayFlowChainRunStatus;
  inputNames: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  stopRequestedAt?: string;
  currentPhase?: ReplayFlowChainPhase;
  result?: 'success' | 'failure';
  errorCode?: string;
  error?: string;
  device?: ReplayFlowRun['device'];
  phases: ReplayFlowChainPhaseRun[];
}

interface InternalReplayFlowChainRun extends ReplayFlowChainRun {
  directory: string;
  inputs: Record<string, unknown>;
  isAdmin: boolean;
  activeReplayRunId?: string;
}

function publicRun(run: InternalReplayFlowChainRun): ReplayFlowChainRun {
  const {
    directory: _directory,
    inputs: _inputs,
    isAdmin: _isAdmin,
    activeReplayRunId: _activeReplayRunId,
    ...result
  } = run;
  return { ...result, inputNames: [...run.inputNames], phases: run.phases.map((phase) => ({ ...phase })) };
}

function phaseStatus(run: ReplayFlowRun): ReplayFlowChainPhaseStatus {
  if (run.status === 'succeeded') return 'succeeded';
  if (run.status === 'cancelled') return 'cancelled';
  return 'failed';
}

export class ReplayFlowChainExecutionService {
  private runs = new Map<string, InternalReplayFlowChainRun>();
  private completions = new Map<string, Promise<void>>();
  private activeChainRunIds = new Map<string, string>();

  constructor(
    private assets: ReplayFlowAssetService = replayFlowAssetService,
    private replayExecutor: Pick<DeviceReplayFlowExecutionService, 'start' | 'waitForCompletion' | 'stop'> = deviceReplayFlowExecutionService,
    private runRoot = path.resolve(process.env.REPLAY_FLOW_CHAIN_RUN_DIR || path.join(process.cwd(), '../nn-ios-platform-data/replay-flow-chain-runs')),
  ) {}

  private currentRunRoot() {
    const projectId = currentProjectId();
    return projectId === 'nn-ios' ? this.runRoot : path.join(this.runRoot, projectId.replace(/[^A-Za-z0-9_.-]/g, '_'));
  }

  start(mainAssetId: string, suppliedInputs: Record<string, unknown>, actor: string, isAdmin: boolean) {
    const projectId = currentProjectId();
    const activeChainRunId = this.activeChainRunIds.get(projectId) || '';
    const active = activeChainRunId ? this.runs.get(activeChainRunId) : undefined;
    if (active && (active.status === 'queued' || active.status === 'running')) {
      throw new DeviceControlError(`真机正在执行任务 ${active.mainAssetName}`, 409);
    }
    this.activeChainRunIds.delete(projectId);
    const main = this.executableAsset(mainAssetId, '主流程');
    const pre = main.preFlowAssetId ? this.executableAsset(main.preFlowAssetId, '前置流程') : undefined;
    const post = main.postFlowAssetId ? this.executableAsset(main.postFlowAssetId, '后置流程') : undefined;
    const id = crypto.randomUUID();
    const directory = path.join(this.currentRunRoot(), id);
    fs.mkdirSync(directory, { recursive: true });
    const phases: ReplayFlowChainPhaseRun[] = [];
    if (pre) phases.push(this.pendingPhase('pre', pre));
    phases.push(this.pendingPhase('main', main));
    if (post) phases.push(this.pendingPhase('post', post));
    const run: InternalReplayFlowChainRun = {
      id,
      projectId,
      mainAssetId: main.id,
      mainAssetName: main.name,
      owner: actor,
      status: 'queued',
      inputNames: Object.keys(suppliedInputs || {}),
      createdAt: new Date().toISOString(),
      phases,
      directory,
      inputs: { ...(suppliedInputs || {}) },
      isAdmin,
    };
    this.runs.set(id, run);
    this.activeChainRunIds.set(projectId, id);
    this.persist(run);
    const completion = Promise.resolve()
      .then(() => this.execute(run))
      .catch((error) => {
        logger.error('组合回放任务未处理异常', { runId: id, error: error?.message });
      });
    this.completions.set(id, completion);
    completion.finally(() => {
      if (this.activeChainRunIds.get(projectId) === id) this.activeChainRunIds.delete(projectId);
    });
    return publicRun(run);
  }

  list(actor: string, isAdmin: boolean, filters: { status?: string; limit?: number } = {}) {
    this.loadPersistedRuns();
    const status = String(filters.status || '');
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    return [...this.runs.values()]
      .filter((run) => run.projectId === currentProjectId() && (isAdmin || run.owner === actor) && (!status || status === 'all' || run.status === status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(publicRun);
  }

  get(runId: string, actor: string, isAdmin: boolean) {
    const run = this.findRun(runId);
    if (!run) throw new DeviceControlError('回放执行任务不存在', 404);
    this.assertAccess(run, actor, isAdmin);
    return publicRun(run);
  }

  stop(runId: string, actor: string, isAdmin: boolean) {
    const run = this.findRun(runId);
    if (!run) throw new DeviceControlError('回放执行任务不存在', 404);
    this.assertAccess(run, actor, isAdmin);
    if (run.status !== 'queued' && run.status !== 'running') return publicRun(run);
    run.stopRequestedAt = new Date().toISOString();
    if (run.activeReplayRunId) {
      this.replayExecutor.stop(run.activeReplayRunId, actor, isAdmin);
    }
    this.persist(run);
    return publicRun(run);
  }

  async waitForCompletion(runId: string) {
    await this.completions.get(runId);
    const run = this.runs.get(runId);
    if (!run) throw new DeviceControlError('回放执行任务不存在', 404);
    return publicRun(run);
  }

  private async execute(run: InternalReplayFlowChainRun) {
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    this.persist(run);
    let allowMain = true;
    try {
      for (const phase of run.phases) {
        if (phase.phase === 'main' && (!allowMain || Boolean(run.stopRequestedAt))) {
          this.skipPhase(phase, allowMain ? '任务已终止' : '前置流程失败');
          continue;
        }
        if (phase.phase === 'pre' && run.stopRequestedAt) {
          this.skipPhase(phase, '任务已终止');
          allowMain = false;
          continue;
        }
        try {
          const asset = this.executableAsset(phase.assetId, phase.phase === 'pre' ? '前置流程' : phase.phase === 'post' ? '后置流程' : '主流程');
          await this.executePhase(run, phase, asset);
        } catch (error: any) {
          phase.status = run.stopRequestedAt ? 'cancelled' : 'failed';
          phase.errorCode = error?.code || 'CHAIN_PHASE_UNAVAILABLE';
          phase.error = error?.message || '阶段当前不可执行';
          this.finishPhase(phase);
          this.persist(run);
        }
        if (phase.phase === 'pre' && phase.status !== 'succeeded') allowMain = false;
      }
    } catch (error: any) {
      const activePhase = run.phases.find((phase) => phase.status === 'running');
      if (activePhase) {
        activePhase.status = run.stopRequestedAt ? 'cancelled' : 'failed';
        activePhase.errorCode = error?.code || 'CHAIN_PHASE_ERROR';
        activePhase.error = error?.message || '阶段执行失败';
        this.finishPhase(activePhase);
      }
      logger.error('组合回放阶段执行失败', { runId: run.id, error: error?.message });
    } finally {
      run.activeReplayRunId = undefined;
      run.currentPhase = undefined;
      const failed = run.phases.find((phase) => phase.status === 'failed');
      const cancelled = Boolean(run.stopRequestedAt) || run.phases.some((phase) => phase.status === 'cancelled');
      if (cancelled) {
        run.status = 'cancelled';
        run.result = 'failure';
        run.errorCode = 'CHAIN_RUN_CANCELLED';
        run.error = '回放执行任务已由用户终止';
      } else if (failed) {
        run.status = 'failed';
        run.result = 'failure';
        run.errorCode = failed.errorCode || 'CHAIN_PHASE_FAILED';
        run.error = `${this.phaseLabel(failed.phase)}失败：${failed.error || '未知错误'}`;
      } else {
        run.status = 'succeeded';
        run.result = 'success';
      }
      run.finishedAt = new Date().toISOString();
      run.durationMs = run.startedAt ? Date.now() - Date.parse(run.startedAt) : undefined;
      this.persist(run);
    }
  }

  private async executePhase(run: InternalReplayFlowChainRun, phase: ReplayFlowChainPhaseRun, asset: ReplayFlowAsset) {
    phase.status = 'running';
    phase.startedAt = new Date().toISOString();
    run.currentPhase = phase.phase;
    this.persist(run);
    try {
      const started = this.replayExecutor.start(asset.draft.flow, run.inputs, run.owner, run.isAdmin);
      phase.replayRunId = started.id;
      run.activeReplayRunId = started.id;
      run.device = run.device || started.device;
      this.persist(run);
      const completed = await this.replayExecutor.waitForCompletion(started.id);
      phase.status = phaseStatus(completed);
      phase.errorCode = completed.errorCode;
      phase.error = completed.error;
    } catch (error: any) {
      phase.status = run.stopRequestedAt ? 'cancelled' : 'failed';
      phase.errorCode = error?.code || 'CHAIN_PHASE_START_FAILED';
      phase.error = error?.message || '阶段无法启动';
    } finally {
      run.activeReplayRunId = undefined;
      this.finishPhase(phase);
      this.persist(run);
    }
  }

  private executableAsset(assetId: string, label: string) {
    const asset = this.assets.get(assetId);
    if (asset.status === 'archived' || !asset.creationCompleted) {
      throw new DeviceControlError(`${label}「${asset.name}」当前不可执行`, 409);
    }
    if (!asset.draft.validation.valid) {
      throw new DeviceControlError(`${label}「${asset.name}」校验未通过`, 422);
    }
    return asset;
  }

  private pendingPhase(phase: ReplayFlowChainPhase, asset: ReplayFlowAsset): ReplayFlowChainPhaseRun {
    return { phase, assetId: asset.id, assetName: asset.name, status: 'pending' };
  }

  private skipPhase(phase: ReplayFlowChainPhaseRun, reason: string) {
    phase.status = 'skipped';
    phase.error = reason;
    phase.finishedAt = new Date().toISOString();
    phase.durationMs = 0;
  }

  private finishPhase(phase: ReplayFlowChainPhaseRun) {
    phase.finishedAt = new Date().toISOString();
    phase.durationMs = phase.startedAt ? Date.now() - Date.parse(phase.startedAt) : 0;
  }

  private phaseLabel(phase: ReplayFlowChainPhase) {
    return phase === 'pre' ? '前置流程' : phase === 'post' ? '后置流程' : '主流程';
  }

  private persist(run: InternalReplayFlowChainRun) {
    fs.mkdirSync(run.directory, { recursive: true });
    const file = path.join(run.directory, 'run.json');
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(publicRun(run), null, 2), 'utf8');
    fs.renameSync(temporary, file);
  }

  private loadPersistedRuns() {
    const runRoot = this.currentRunRoot();
    if (!fs.existsSync(runRoot)) return;
    for (const entry of fs.readdirSync(runRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !this.runs.has(entry.name)) this.findRun(entry.name);
    }
  }

  private findRun(runId: string) {
    const cached = this.runs.get(runId);
    if (cached) return cached.projectId === currentProjectId() ? cached : undefined;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(runId)) return undefined;
    const directory = path.join(this.currentRunRoot(), runId);
    const file = path.join(directory, 'run.json');
    if (!fs.existsSync(file)) return undefined;
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as ReplayFlowChainRun;
      stored.projectId ||= currentProjectId();
      if (stored.projectId !== currentProjectId()) return undefined;
      if (stored.status === 'queued' || stored.status === 'running') {
        stored.status = 'failed';
        stored.result = 'failure';
        stored.errorCode = 'PROCESS_INTERRUPTED';
        stored.error = '后端进程重启，原回放执行任务无法继续';
        stored.finishedAt = new Date().toISOString();
        stored.phases = stored.phases.map((phase) => phase.status === 'running' || phase.status === 'pending' ? {
          ...phase,
          status: phase.status === 'running' ? 'failed' : 'skipped',
          errorCode: phase.status === 'running' ? 'PROCESS_INTERRUPTED' : phase.errorCode,
          error: phase.status === 'running' ? stored.error : '进程重启后未执行',
          finishedAt: stored.finishedAt,
        } : phase);
      }
      const run: InternalReplayFlowChainRun = {
        ...stored,
        directory,
        inputs: {},
        isAdmin: false,
      };
      this.runs.set(runId, run);
      if (stored.errorCode === 'PROCESS_INTERRUPTED') this.persist(run);
      return run;
    } catch (error: any) {
      logger.warn('读取组合回放任务失败', { runId, error: error?.message });
      return undefined;
    }
  }

  private assertAccess(run: InternalReplayFlowChainRun, actor: string, isAdmin: boolean) {
    if (isAdmin || run.owner === actor) return;
    throw new DeviceControlError(`回放执行任务属于 ${run.owner}`, 403);
  }
}

export const replayFlowChainExecutionService = new ReplayFlowChainExecutionService();
