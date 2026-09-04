import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  compileDeviceReplayFlow,
  DeviceReplayFlowDsl,
  ReplayFlowCondition,
  ReplayFlowNode,
  ReplayFlowTarget,
  validateDeviceReplayFlow,
} from './DeviceReplayFlow';
import { DeviceControlError, deviceControlService } from './DeviceControlService';
import { inspectReplayTarget, screenSizeFromSource } from './DeviceRecordingLocator';
import { deviceRecordingService, replaySourceSimilarity } from './DeviceRecordingService';
import logger from '../utils/logger';

export type ReplayFlowRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ReplayFlowNodeRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ReplayFlowRuntimeEvidence {
  id: string;
  phase: 'before' | 'after';
  createdAt: string;
  sourceUrl?: string;
  screenshotUrl?: string;
  sourceBytes?: number;
  screenshotBytes?: number;
  sourceHash?: string;
  screenshotHash?: string;
  captureError?: string;
}

interface InternalReplayFlowRuntimeEvidence extends ReplayFlowRuntimeEvidence {
  sourceFile?: string;
  screenshotFile?: string;
}

export interface ReplayFlowLocatorEvidence {
  strategy: 'semantic' | 'coordinate' | 'coordinate-fallback';
  recordedCoordinate?: { x: number; y: number };
  resolvedPoint: { x: number; y: number };
  matchedType?: string;
  matchedIdentifier?: string;
  matchedName?: string;
  matchedLabel?: string;
  matchedValue?: string;
  semanticScore?: number;
  distance?: number;
}

export interface ReplayFlowConditionEvidence {
  matched: boolean;
  kind: string;
  actual?: string | number | boolean;
  expected?: string | number | boolean;
  elapsedMs: number;
}

export interface ReplayFlowSwipeEvidence {
  recordedStart: { x: number; y: number };
  recordedEnd: { x: number; y: number };
  resolvedStart: { x: number; y: number };
  resolvedEnd: { x: number; y: number };
  durationMs: number;
  startLocator?: ReplayFlowLocatorEvidence;
  endLocator?: ReplayFlowLocatorEvidence;
}

export interface ReplayFlowNodeRun {
  sequence: number;
  nodeId: string;
  nodeType: ReplayFlowNode['type'];
  status: ReplayFlowNodeRunStatus;
  attempts: number;
  outcome?: string;
  nextNodeId?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  errorCode?: string;
  error?: string;
  locator?: ReplayFlowLocatorEvidence;
  swipe?: ReplayFlowSwipeEvidence;
  condition?: ReplayFlowConditionEvidence;
  evidence: ReplayFlowRuntimeEvidence[];
}

export interface ReplayFlowRun {
  id: string;
  flowId: string;
  flowName: string;
  schemaVersion: string;
  owner: string;
  status: ReplayFlowRunStatus;
  inputNames: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  currentNodeId?: string;
  stopRequestedAt?: string;
  result?: 'success' | 'failure';
  errorCode?: string;
  error?: string;
  device?: { udid: string; name: string; osVersion?: string };
  nodes: ReplayFlowNodeRun[];
}

interface InternalReplayFlowNodeRun extends Omit<ReplayFlowNodeRun, 'evidence'> {
  evidence: InternalReplayFlowRuntimeEvidence[];
}

interface InternalReplayFlowRun extends Omit<ReplayFlowRun, 'nodes'> {
  directory: string;
  flow: DeviceReplayFlowDsl;
  inputs: Record<string, string>;
  isAdmin: boolean;
  nodes: InternalReplayFlowNodeRun[];
  abortController: AbortController;
}

export interface DeviceReplayRuntimeAdapter {
  getStatus(): {
    phase: string;
    device?: { udid: string; name: string; osVersion?: string };
    windowSize?: { width: number; height: number };
  };
  source(actor: string, isAdmin: boolean): Promise<string>;
  screenshot(actor: string, isAdmin: boolean): Promise<Buffer>;
  tap(x: number, y: number, actor: string, isAdmin: boolean): Promise<unknown>;
  swipe(startX: number, startY: number, endX: number, endY: number, durationMs: number, actor: string, isAdmin: boolean): Promise<unknown>;
  input(text: string, actor: string, isAdmin: boolean): Promise<unknown>;
  keyboard(key: 'Search' | 'Return' | 'Done' | 'Dismiss', actor: string, isAdmin: boolean): Promise<unknown>;
  snapshotSource(flow: DeviceReplayFlowDsl, snapshotId: string, actor: string, isAdmin: boolean): Promise<string>;
}

interface ExecutionContext {
  run: InternalReplayFlowRun;
  previousResult: string;
  retryCount: number;
  elementText: string;
  expectedSources: Map<string, string>;
}

interface ConditionState {
  startedAt: number;
  stableSources: Map<string, { hash: string; since: number }>;
}

interface ConditionEvaluation {
  matched: boolean;
  kind: string;
  actual?: string | number | boolean;
  expected?: string | number | boolean;
}

class ReplayFlowRuntimeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ReplayFlowRuntimeError';
  }
}

const defaultAdapter: DeviceReplayRuntimeAdapter = {
  getStatus: () => deviceControlService.getStatus(),
  source: (actor, isAdmin) => deviceControlService.source(actor, isAdmin),
  screenshot: (actor, isAdmin) => deviceControlService.screenshot(actor, isAdmin),
  tap: (x, y, actor, isAdmin) => deviceControlService.tap(x, y, actor, isAdmin),
  swipe: (startX, startY, endX, endY, durationMs, actor, isAdmin) => (
    deviceControlService.swipe(startX, startY, endX, endY, durationMs, actor, isAdmin)
  ),
  input: (text, actor, isAdmin) => deviceControlService.input(text, actor, isAdmin),
  keyboard: (key, actor, isAdmin) => deviceControlService.keyboard(key, actor, isAdmin),
  snapshotSource: async (flow, snapshotId, actor, isAdmin) => {
    if (flow.source?.type !== 'recording') {
      throw new ReplayFlowRuntimeError('SNAPSHOT_SOURCE_UNAVAILABLE', `流程未绑定录制，无法读取快照 ${snapshotId}`);
    }
    const file = deviceRecordingService.evidenceFile(flow.source.recordingId, snapshotId, 'source', actor, isAdmin);
    return fs.readFileSync(file, 'utf8');
  },
};

function sha1(value: Buffer | string) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function safePathPart(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'node';
}

function temporalCondition(condition: ReplayFlowCondition): boolean {
  if ('all' in condition) return condition.all.some(temporalCondition);
  if ('any' in condition) return condition.any.some(temporalCondition);
  if ('not' in condition) return temporalCondition(condition.not);
  return condition.kind === 'delay' || condition.kind === 'page_stable';
}

function conditionKind(condition: ReplayFlowCondition): string {
  if ('all' in condition) return 'all';
  if ('any' in condition) return 'any';
  if ('not' in condition) return 'not';
  return condition.kind;
}

export class DeviceReplayFlowExecutionService {
  private runs = new Map<string, InternalReplayFlowRun>();
  private completions = new Map<string, Promise<void>>();
  private activeRunId = '';

  constructor(
    private adapter: DeviceReplayRuntimeAdapter = defaultAdapter,
    private runRoot = path.resolve(process.env.DEVICE_REPLAY_RUN_DIR || path.join(process.cwd(), '../nn-ios-platform-data/device-replay-runs')),
  ) {}

  start(flow: DeviceReplayFlowDsl, suppliedInputs: Record<string, unknown>, actor: string, isAdmin: boolean) {
    const validation = validateDeviceReplayFlow(flow);
    if (!validation.valid) {
      throw new DeviceControlError(`流程校验失败：${validation.errors.map((item) => item.message).join('；')}`, 422);
    }
    compileDeviceReplayFlow(flow);
    if (this.activeRunId) {
      const active = this.runs.get(this.activeRunId);
      if (active && (active.status === 'queued' || active.status === 'running')) {
        throw new DeviceControlError(`真机正在执行流程 ${active.flowName}`, 409);
      }
      this.activeRunId = '';
    }
    const status = this.adapter.getStatus();
    if (status.phase !== 'connected' || !status.device) throw new DeviceControlError('请先连接真机操作台，再执行流程', 409);
    const inputs = this.resolveInputs(flow, suppliedInputs || {});
    const id = crypto.randomUUID();
    const directory = path.join(this.runRoot, id);
    fs.mkdirSync(path.join(directory, 'evidence'), { recursive: true });
    const run: InternalReplayFlowRun = {
      id,
      flowId: flow.id,
      flowName: flow.name,
      schemaVersion: flow.schemaVersion,
      owner: actor,
      status: 'queued',
      inputNames: Object.keys(inputs),
      createdAt: new Date().toISOString(),
      device: status.device,
      nodes: [],
      directory,
      flow,
      inputs,
      isAdmin,
      abortController: new AbortController(),
    };
    this.runs.set(id, run);
    this.activeRunId = id;
    this.persist(run);
    const completion = Promise.resolve()
      .then(() => this.execute(run))
      .catch((error) => {
        logger.error('回放流程未处理异常', { runId: run.id, error: error?.message });
      });
    this.completions.set(id, completion);
    completion.finally(() => {
      if (this.activeRunId === id) this.activeRunId = '';
    });
    return this.publicRun(run);
  }

  getRun(runId: string, actor: string, isAdmin: boolean) {
    const run = this.findRun(runId);
    if (!run) throw new DeviceControlError('回放运行记录不存在', 404);
    this.assertAccess(run, actor, isAdmin);
    return this.publicRun(run);
  }

  stop(runId: string, actor: string, isAdmin: boolean) {
    const run = this.findRun(runId);
    if (!run) throw new DeviceControlError('回放运行记录不存在', 404);
    this.assertAccess(run, actor, isAdmin);
    if (run.status !== 'queued' && run.status !== 'running') return this.publicRun(run);
    run.stopRequestedAt = new Date().toISOString();
    run.abortController.abort();
    this.persist(run);
    return this.publicRun(run);
  }

  async waitForCompletion(runId: string) {
    await this.completions.get(runId);
    const run = this.runs.get(runId);
    if (!run) throw new DeviceControlError('回放运行记录不存在', 404);
    return this.publicRun(run);
  }

  evidenceFile(runId: string, evidenceId: string, kind: 'source' | 'screenshot', actor: string, isAdmin: boolean) {
    const run = this.findRun(runId);
    if (!run) throw new DeviceControlError('回放运行记录不存在', 404);
    this.assertAccess(run, actor, isAdmin);
    const evidence = run.nodes.flatMap((node) => node.evidence).find((item) => item.id === evidenceId);
    const file = kind === 'source' ? evidence?.sourceFile : evidence?.screenshotFile;
    if (!file || !fs.existsSync(file)) throw new DeviceControlError('回放证据不存在', 404);
    return file;
  }

  private resolveInputs(flow: DeviceReplayFlowDsl, suppliedInputs: Record<string, unknown>) {
    const values: Record<string, string> = {};
    Object.entries(flow.inputs || {}).forEach(([name, definition]) => {
      const supplied = suppliedInputs[name];
      const value = supplied === undefined || supplied === null ? definition.default : String(supplied);
      if (definition.required && (value === undefined || value === '')) {
        throw new DeviceControlError(`流程参数 ${name} 必填`, 422);
      }
      if (value !== undefined) {
        if (value.length > 2000) throw new DeviceControlError(`流程参数 ${name} 不能超过 2000 个字符`, 422);
        values[name] = value;
      }
    });
    return values;
  }

  private interpolate(value: string, context: ExecutionContext) {
    const runtimeValues: Record<string, string> = {
      ...context.run.inputs,
      'previous.result': context.previousResult,
      retryCount: String(context.retryCount),
      'element.text': context.elementText,
    };
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g, (_match, name: string) => {
      if (!(name in runtimeValues)) throw new ReplayFlowRuntimeError('VARIABLE_MISSING', `运行时变量 ${name} 不存在`);
      return runtimeValues[name];
    });
  }

  private interpolateTarget(target: ReplayFlowTarget, context: ExecutionContext): ReplayFlowTarget {
    const text = (value: string | undefined) => value === undefined ? undefined : this.interpolate(value, context);
    return {
      ...target,
      accessibilityId: text(target.accessibilityId),
      name: text(target.name),
      label: text(target.label),
      text: text(target.text),
      placeholder: text(target.placeholder),
      type: text(target.type),
      contextLabels: target.contextLabels?.map((value) => this.interpolate(value, context)),
    };
  }

  private async execute(run: InternalReplayFlowRun) {
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    this.persist(run);
    const compiled = compileDeviceReplayFlow(run.flow);
    const context: ExecutionContext = {
      run,
      previousResult: '',
      retryCount: 0,
      elementText: '',
      expectedSources: new Map(),
    };
    let currentNodeId = compiled.entryNodeId;
    let transitions = 0;
    try {
      while (currentNodeId) {
        this.assertNotCancelled(run);
        transitions += 1;
        if (transitions > 10000) throw new ReplayFlowRuntimeError('TRANSITION_LIMIT', '流程跳转次数超过安全上限');
        const node = compiled.nodes[currentNodeId]?.node;
        if (!node) throw new ReplayFlowRuntimeError('NODE_NOT_FOUND', `运行时找不到节点 ${currentNodeId}`);
        run.currentNodeId = currentNodeId;
        this.persist(run);
        const result = await this.executeNode(node, context);
        context.previousResult = result.outcome;
        if (node.type === 'end') {
          run.result = node.result;
          if (node.result === 'success') {
            run.status = 'succeeded';
          } else {
            run.status = 'failed';
            run.errorCode = 'FLOW_FAILURE_END';
            run.error = node.message || '流程进入失败结束节点';
          }
          break;
        }
        currentNodeId = result.nextNodeId || '';
      }
    } catch (error: any) {
      const cancelled = run.abortController.signal.aborted || error?.code === 'RUN_CANCELLED';
      run.status = cancelled ? 'cancelled' : 'failed';
      run.result = 'failure';
      run.errorCode = cancelled ? 'RUN_CANCELLED' : (error?.code || 'RUNTIME_ERROR');
      run.error = cancelled ? '回放已由用户终止' : (error?.message || '流程执行失败');
      const activeNode = run.nodes[run.nodes.length - 1];
      if (activeNode?.status === 'running') {
        activeNode.status = cancelled ? 'cancelled' : 'failed';
        activeNode.errorCode = run.errorCode;
        activeNode.error = run.error;
        this.finishNode(activeNode);
      }
    } finally {
      run.currentNodeId = undefined;
      run.finishedAt = new Date().toISOString();
      run.durationMs = run.startedAt ? Date.now() - Date.parse(run.startedAt) : undefined;
      this.persist(run);
      logger.info('状态驱动回放流程结束', {
        runId: run.id,
        flowId: run.flowId,
        status: run.status,
        errorCode: run.errorCode,
        durationMs: run.durationMs,
      });
    }
  }

  private async executeNode(node: ReplayFlowNode, context: ExecutionContext) {
    const record: InternalReplayFlowNodeRun = {
      sequence: context.run.nodes.length + 1,
      nodeId: node.id,
      nodeType: node.type,
      status: 'running',
      attempts: 0,
      startedAt: new Date().toISOString(),
      evidence: [],
    };
    context.run.nodes.push(record);
    this.persist(context.run);
    try {
      if (node.type === 'start') return this.completeNode(record, 'next', node.next);
      if (node.type === 'end') {
        return this.completeNode(record, node.result, undefined, node.result === 'failure' ? 'failed' : 'succeeded');
      }
      if (node.type === 'tap' || node.type === 'swipe' || node.type === 'input' || node.type === 'keyboard') {
        return await this.executeActionNode(node, context, record);
      }
      record.attempts = 1;
      record.evidence.push(await this.captureEvidence(context.run, node.id, 1, 'before'));
      if (node.type === 'wait') {
        try {
          const condition = await this.waitForCondition(node.condition, node.timeoutMs || 15000, context);
          record.condition = condition;
          return this.completeNode(record, 'success', node.onSuccess);
        } catch (error: any) {
          if (error?.code === 'NODE_TIMEOUT') {
            record.errorCode = error.code;
            record.error = error.message;
            return this.completeNode(record, 'timeout', node.onTimeout, 'failed');
          }
          if (node.onError) {
            record.errorCode = error?.code || 'CONDITION_ERROR';
            record.error = error?.message || '等待条件执行失败';
            return this.completeNode(record, 'error', node.onError, 'failed');
          }
          throw error;
        } finally {
          record.evidence.push(await this.captureEvidence(context.run, node.id, 1, 'after'));
        }
      }
      if (node.type === 'condition') {
        try {
          const condition = temporalCondition(node.condition)
            ? await this.waitForCondition(node.condition, node.timeoutMs || 15000, context)
            : await this.evaluateOnce(node.condition, context);
          record.condition = condition;
          return this.completeNode(record, condition.matched ? 'true' : 'false', condition.matched ? node.onTrue : node.onFalse);
        } catch (error: any) {
          if (error?.code === 'NODE_TIMEOUT') {
            record.errorCode = error.code;
            record.error = error.message;
            return this.completeNode(record, 'timeout', node.onTimeout || node.onFalse, 'failed');
          }
          if (node.onError) {
            record.errorCode = error?.code || 'CONDITION_ERROR';
            record.error = error?.message || '条件执行失败';
            return this.completeNode(record, 'error', node.onError, 'failed');
          }
          throw error;
        } finally {
          record.evidence.push(await this.captureEvidence(context.run, node.id, 1, 'after'));
        }
      }
      try {
        const condition = temporalCondition(node.condition)
          ? await this.waitForCondition(node.condition, node.timeoutMs || 15000, context)
          : await this.evaluateOnce(node.condition, context);
        record.condition = condition;
        return this.completeNode(record, condition.matched ? 'passed' : 'failed', condition.matched ? node.onPassed : node.onFailed, condition.matched ? 'succeeded' : 'failed');
      } catch (error: any) {
        if (error?.code === 'NODE_TIMEOUT') {
          record.errorCode = error.code;
          record.error = error.message;
          return this.completeNode(record, 'failed', node.onFailed, 'failed');
        }
        if (node.onError) {
          record.errorCode = error?.code || 'CONDITION_ERROR';
          record.error = error?.message || '断言执行失败';
          return this.completeNode(record, 'error', node.onError, 'failed');
        }
        throw error;
      } finally {
        record.evidence.push(await this.captureEvidence(context.run, node.id, 1, 'after'));
      }
    } catch (error) {
      if (record.status === 'running') {
        record.status = context.run.abortController.signal.aborted ? 'cancelled' : 'failed';
        record.errorCode = (error as any)?.code || 'NODE_ERROR';
        record.error = (error as any)?.message || '节点执行失败';
        this.finishNode(record);
      }
      throw error;
    } finally {
      this.persist(context.run);
    }
  }

  private async executeActionNode(
    node: Extract<ReplayFlowNode, { type: 'tap' | 'swipe' | 'input' | 'keyboard' }>,
    context: ExecutionContext,
    record: InternalReplayFlowNodeRun,
  ) {
    const maxAttempts = node.retry?.maxAttempts || 1;
    let lastError: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.assertNotCancelled(context.run);
      record.attempts = attempt;
      context.retryCount = attempt - 1;
      record.evidence.push(await this.captureEvidence(context.run, node.id, attempt, 'before'));
      try {
        if (node.precondition) await this.waitForCondition(node.precondition, node.timeoutMs || 15000, context);
        await this.withTimeout(
          this.performAction(node, context, record),
          node.timeoutMs || 15000,
          context.run,
          'ACTION_TIMEOUT',
          `节点 ${node.id} 动作执行超时`,
        );
        if (node.postcondition) await this.waitForCondition(node.postcondition, node.timeoutMs || 15000, context);
        record.evidence.push(await this.captureEvidence(context.run, node.id, attempt, 'after'));
        record.errorCode = undefined;
        record.error = undefined;
        return this.completeNode(record, 'success', node.next);
      } catch (error: any) {
        lastError = error;
        record.errorCode = error?.code || 'ACTION_FAILED';
        record.error = error?.message || '动作执行失败';
        record.evidence.push(await this.captureEvidence(context.run, node.id, attempt, 'after'));
        if (context.run.abortController.signal.aborted) throw error;
        if (attempt < maxAttempts) {
          const interval = Math.max(0, node.retry?.intervalMs || 0);
          const multiplier = node.retry?.backoff === 'linear' ? attempt : 1;
          await this.sleep(interval * multiplier, context.run);
        }
      }
    }
    if (node.onFailure) return this.completeNode(record, 'failure', node.onFailure, 'failed');
    throw lastError || new ReplayFlowRuntimeError('ACTION_FAILED', `节点 ${node.id} 执行失败`);
  }

  private async performAction(
    node: Extract<ReplayFlowNode, { type: 'tap' | 'swipe' | 'input' | 'keyboard' }>,
    context: ExecutionContext,
    record: InternalReplayFlowNodeRun,
  ) {
    const actor = context.run.owner;
    const isAdmin = context.run.isAdmin;
    if (node.type === 'tap') {
      const resolved = await this.resolveTarget(node.target, context, true);
      record.locator = resolved.evidence;
      await this.adapter.tap(resolved.point.x, resolved.point.y, actor, isAdmin);
      return;
    }
    if (node.type === 'swipe') {
      const source = await this.readSource(context, node.timeoutMs || 15000);
      const screen = this.screenSize(source);
      const startResolved = node.startTarget
        ? await this.resolveTarget(node.startTarget, context, false, source)
        : undefined;
      const endResolved = node.endTarget
        ? await this.resolveTarget(node.endTarget, context, false, source)
        : undefined;
      const start = startResolved?.point
        || { x: Math.round(node.start.x * screen.width), y: Math.round(node.start.y * screen.height) };
      const end = endResolved?.point
        || { x: Math.round(node.end.x * screen.width), y: Math.round(node.end.y * screen.height) };
      const durationMs = node.durationMs || 350;
      record.swipe = {
        recordedStart: node.start,
        recordedEnd: node.end,
        resolvedStart: start,
        resolvedEnd: end,
        durationMs,
        startLocator: startResolved?.evidence,
        endLocator: endResolved?.evidence,
      };
      await this.adapter.swipe(start.x, start.y, end.x, end.y, durationMs, actor, isAdmin);
      return;
    }
    if (node.type === 'input') {
      if (node.target) {
        const resolved = await this.resolveTarget(node.target, context, true);
        record.locator = resolved.evidence;
        await this.adapter.tap(resolved.point.x, resolved.point.y, actor, isAdmin);
      }
      await this.adapter.input(this.interpolate(node.value, context), actor, isAdmin);
      return;
    }
    await this.adapter.keyboard(node.key, actor, isAdmin);
  }

  private async resolveTarget(target: ReplayFlowTarget, context: ExecutionContext, enabledOnly: boolean, suppliedSource?: string) {
    const source = suppliedSource || await this.readSource(context, 15000);
    const screen = this.screenSize(source);
    const resolvedTarget = this.interpolateTarget(target, context);
    const match = inspectReplayTarget(source, resolvedTarget, screen, { visibleOnly: true, enabledOnly });
    if (match) {
      context.elementText = match.value || match.label || match.name || '';
      return {
        point: match.point,
        evidence: {
          strategy: match.strategy,
          recordedCoordinate: resolvedTarget.coordinate,
          resolvedPoint: match.point,
          matchedType: match.type,
          matchedIdentifier: match.identifier,
          matchedName: match.name,
          matchedLabel: match.label,
          matchedValue: match.value,
          semanticScore: match.semanticScore,
          distance: match.distance,
        } as ReplayFlowLocatorEvidence,
      };
    }
    if (resolvedTarget.coordinate) {
      const point = {
        x: Math.round(resolvedTarget.coordinate.x * screen.width),
        y: Math.round(resolvedTarget.coordinate.y * screen.height),
      };
      return {
        point,
        evidence: {
          strategy: 'coordinate-fallback',
          recordedCoordinate: resolvedTarget.coordinate,
          resolvedPoint: point,
        } as ReplayFlowLocatorEvidence,
      };
    }
    throw new ReplayFlowRuntimeError('TARGET_NOT_FOUND', '未在当前 WDA Source 中找到目标控件');
  }

  private async waitForCondition(condition: ReplayFlowCondition, timeoutMs: number, context: ExecutionContext) {
    const startedAt = Date.now();
    const state: ConditionState = { startedAt, stableSources: new Map() };
    let lastEvaluation: ConditionEvaluation | undefined;
    let lastError: unknown;
    const pollMs = Math.min(Math.max(Number(process.env.DEVICE_REPLAY_FLOW_POLL_MS) || 300, 100), 2000);
    while (Date.now() - startedAt <= timeoutMs) {
      this.assertNotCancelled(context.run);
      try {
        const source = this.conditionNeedsSource(condition)
          ? await this.readSource(context, Math.min(15000, Math.max(timeoutMs - (Date.now() - startedAt), 100)))
          : '';
        lastEvaluation = await this.evaluateCondition(condition, source, context, state, '$');
        if (lastEvaluation.matched) {
          return { ...lastEvaluation, elapsedMs: Date.now() - startedAt } as ReplayFlowConditionEvidence;
        }
      } catch (error) {
        if ((error as any)?.code === 'RUN_CANCELLED') throw error;
        lastError = error;
      }
      await this.sleep(Math.min(pollMs, Math.max(timeoutMs - (Date.now() - startedAt), 0)), context.run);
    }
    const detail = lastError instanceof Error ? `：${lastError.message}` : '';
    const actual = lastEvaluation?.actual === undefined ? '' : `，实际值 ${String(lastEvaluation.actual)}`;
    throw new ReplayFlowRuntimeError('NODE_TIMEOUT', `等待 ${conditionKind(condition)} 条件超时${actual}${detail}`);
  }

  private async evaluateOnce(condition: ReplayFlowCondition, context: ExecutionContext) {
    const startedAt = Date.now();
    const source = await this.readSource(context, 15000);
    const evaluation = await this.evaluateCondition(condition, source, context, { startedAt, stableSources: new Map() }, '$');
    return { ...evaluation, elapsedMs: Date.now() - startedAt } as ReplayFlowConditionEvidence;
  }

  private async evaluateCondition(
    condition: ReplayFlowCondition,
    source: string,
    context: ExecutionContext,
    state: ConditionState,
    pathKey: string,
  ): Promise<ConditionEvaluation> {
    if ('all' in condition) {
      const results = await Promise.all(condition.all.map((item, index) => this.evaluateCondition(item, source, context, state, `${pathKey}.all.${index}`)));
      return { matched: results.every((item) => item.matched), kind: 'all', actual: results.filter((item) => item.matched).length, expected: results.length };
    }
    if ('any' in condition) {
      const results = await Promise.all(condition.any.map((item, index) => this.evaluateCondition(item, source, context, state, `${pathKey}.any.${index}`)));
      return { matched: results.some((item) => item.matched), kind: 'any', actual: results.filter((item) => item.matched).length, expected: 1 };
    }
    if ('not' in condition) {
      const result = await this.evaluateCondition(condition.not, source, context, state, `${pathKey}.not`);
      return { matched: !result.matched, kind: 'not', actual: result.matched, expected: false };
    }
    if (condition.kind === 'delay') {
      const elapsed = Date.now() - state.startedAt;
      return { matched: elapsed >= condition.durationMs, kind: condition.kind, actual: elapsed, expected: condition.durationMs };
    }
    if (condition.kind === 'page_stable') {
      const durationMs = condition.durationMs || 800;
      const hash = sha1(source);
      const previous = state.stableSources.get(pathKey);
      if (!previous || previous.hash !== hash) state.stableSources.set(pathKey, { hash, since: Date.now() });
      const since = state.stableSources.get(pathKey)!.since;
      const stableMs = Date.now() - since;
      return { matched: stableMs >= durationMs, kind: condition.kind, actual: stableMs, expected: durationMs };
    }
    if (condition.kind === 'keyboard') {
      const visible = /<XCUIElementTypeKeyboard\b/.test(source);
      return { matched: condition.operator === 'visible' ? visible : !visible, kind: condition.kind, actual: visible, expected: condition.operator === 'visible' };
    }
    if (condition.kind === 'app') {
      const applicationTag = source.match(/<XCUIElementTypeApplication\b([^>]*)>/)?.[1] || '';
      const foreground = Boolean(applicationTag) && !/visible="(?:false|0)"/.test(applicationTag);
      return { matched: condition.operator === 'foreground' ? foreground : !foreground, kind: condition.kind, actual: foreground, expected: condition.operator === 'foreground' };
    }
    if (condition.kind === 'snapshot_similarity') {
      let expectedSource = context.expectedSources.get(condition.snapshotId);
      if (!expectedSource) {
        expectedSource = await this.adapter.snapshotSource(context.run.flow, condition.snapshotId, context.run.owner, context.run.isAdmin);
        context.expectedSources.set(condition.snapshotId, expectedSource);
      }
      const score = replaySourceSimilarity(expectedSource, source);
      const threshold = condition.threshold ?? 0.72;
      return { matched: score >= threshold, kind: condition.kind, actual: Number(score.toFixed(4)), expected: threshold };
    }
    const screen = this.screenSize(source);
    const match = inspectReplayTarget(source, this.interpolateTarget(condition.target, context), screen);
    if (match) context.elementText = match.value || match.label || match.name || '';
    if (condition.kind === 'element') {
      let matched = false;
      if (condition.operator === 'exists') matched = Boolean(match);
      else if (condition.operator === 'not_exists') matched = !match;
      else if (condition.operator === 'visible') matched = Boolean(match?.visible);
      else if (condition.operator === 'not_visible') matched = !match || !match.visible;
      else if (condition.operator === 'enabled') matched = Boolean(match?.enabled);
      else matched = Boolean(match) && !match!.enabled;
      return { matched, kind: condition.kind, actual: Boolean(match), expected: condition.operator };
    }
    const actual = match?.value || match?.label || match?.name || '';
    const expected = this.interpolate(condition.value, context);
    let matched = false;
    if (condition.operator === 'equals') matched = actual === expected;
    else if (condition.operator === 'contains') matched = actual.includes(expected);
    else matched = !actual.includes(expected);
    return { matched, kind: condition.kind, actual, expected };
  }

  private async readSource(context: ExecutionContext, timeoutMs: number) {
    return this.withTimeout(
      this.adapter.source(context.run.owner, context.run.isAdmin),
      timeoutMs,
      context.run,
      'WDA_SOURCE_TIMEOUT',
      '读取 WDA Source 超时',
    );
  }

  private screenSize(source: string) {
    const size = screenSizeFromSource(source) || this.adapter.getStatus().windowSize;
    if (!size) throw new ReplayFlowRuntimeError('WINDOW_SIZE_UNAVAILABLE', '无法确定真机屏幕尺寸');
    return size;
  }

  private async captureEvidence(
    run: InternalReplayFlowRun,
    nodeId: string,
    attempt: number,
    phase: 'before' | 'after',
  ): Promise<InternalReplayFlowRuntimeEvidence> {
    const id = `${safePathPart(nodeId)}-${attempt}-${phase}-${crypto.randomUUID().slice(0, 8)}`;
    const evidence: InternalReplayFlowRuntimeEvidence = { id, phase, createdAt: new Date().toISOString() };
    try {
      const source = await this.adapter.source(run.owner, run.isAdmin);
      const screenshot = await this.adapter.screenshot(run.owner, run.isAdmin);
      const sourceFile = path.join(run.directory, 'evidence', `${id}.xml`);
      const screenshotFile = path.join(run.directory, 'evidence', `${id}.png`);
      fs.writeFileSync(sourceFile, source, 'utf8');
      fs.writeFileSync(screenshotFile, screenshot);
      evidence.sourceFile = sourceFile;
      evidence.screenshotFile = screenshotFile;
      evidence.sourceBytes = Buffer.byteLength(source);
      evidence.screenshotBytes = screenshot.length;
      evidence.sourceHash = sha1(source);
      evidence.screenshotHash = sha1(screenshot);
      evidence.sourceUrl = `/api/device-control/replay-flows/runs/${encodeURIComponent(run.id)}/evidence/${encodeURIComponent(id)}/source`;
      evidence.screenshotUrl = `/api/device-control/replay-flows/runs/${encodeURIComponent(run.id)}/evidence/${encodeURIComponent(id)}/screenshot`;
    } catch (error: any) {
      evidence.captureError = error?.message || '证据采集失败';
    }
    return evidence;
  }

  private completeNode(
    record: InternalReplayFlowNodeRun,
    outcome: string,
    nextNodeId?: string,
    status: ReplayFlowNodeRunStatus = 'succeeded',
  ) {
    record.status = status;
    record.outcome = outcome;
    record.nextNodeId = nextNodeId;
    this.finishNode(record);
    return { outcome, nextNodeId };
  }

  private finishNode(record: InternalReplayFlowNodeRun) {
    record.finishedAt = new Date().toISOString();
    record.durationMs = Date.now() - Date.parse(record.startedAt);
  }

  private assertNotCancelled(run: InternalReplayFlowRun) {
    if (run.abortController.signal.aborted) throw new ReplayFlowRuntimeError('RUN_CANCELLED', '回放已由用户终止');
  }

  private sleep(ms: number, run: InternalReplayFlowRun) {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        run.abortController.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ReplayFlowRuntimeError('RUN_CANCELLED', '回放已由用户终止'));
      };
      run.abortController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, run: InternalReplayFlowRun, code: string, message: string) {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run.abortController.signal.removeEventListener('abort', onAbort);
        callback();
      };
      const timer = setTimeout(() => finish(() => reject(new ReplayFlowRuntimeError(code, message))), timeoutMs);
      const onAbort = () => finish(() => reject(new ReplayFlowRuntimeError('RUN_CANCELLED', '回放已由用户终止')));
      run.abortController.signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  private conditionNeedsSource(condition: ReplayFlowCondition): boolean {
    if ('all' in condition) return condition.all.some((item) => this.conditionNeedsSource(item));
    if ('any' in condition) return condition.any.some((item) => this.conditionNeedsSource(item));
    if ('not' in condition) return this.conditionNeedsSource(condition.not);
    return condition.kind !== 'delay';
  }

  private publicRun(run: InternalReplayFlowRun): ReplayFlowRun {
    return {
      id: run.id,
      flowId: run.flowId,
      flowName: run.flowName,
      schemaVersion: run.schemaVersion,
      owner: run.owner,
      status: run.status,
      inputNames: [...run.inputNames],
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      currentNodeId: run.currentNodeId,
      stopRequestedAt: run.stopRequestedAt,
      result: run.result,
      errorCode: run.errorCode,
      error: run.error,
      device: run.device,
      nodes: run.nodes.map((node) => ({
        ...node,
        evidence: node.evidence.map(({ sourceFile: _sourceFile, screenshotFile: _screenshotFile, ...evidence }) => evidence),
      })),
    };
  }

  private persist(run: InternalReplayFlowRun) {
    fs.mkdirSync(run.directory, { recursive: true });
    const file = path.join(run.directory, 'run.json');
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.publicRun(run), null, 2), 'utf8');
    fs.renameSync(temp, file);
  }

  private findRun(runId: string) {
    const cached = this.runs.get(runId);
    if (cached) return cached;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(runId)) return undefined;
    const directory = path.join(this.runRoot, runId);
    const file = path.join(directory, 'run.json');
    if (!fs.existsSync(file)) return undefined;
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as ReplayFlowRun;
      if (stored.status === 'queued' || stored.status === 'running') {
        stored.status = 'failed';
        stored.result = 'failure';
        stored.errorCode = 'PROCESS_INTERRUPTED';
        stored.error = '后端进程重启，原回放无法继续';
        stored.finishedAt = new Date().toISOString();
        stored.nodes = stored.nodes.map((node) => node.status === 'running' ? {
          ...node,
          status: 'failed',
          errorCode: 'PROCESS_INTERRUPTED',
          error: stored.error,
          finishedAt: stored.finishedAt,
          durationMs: Date.now() - Date.parse(node.startedAt),
        } : node);
      }
      const run: InternalReplayFlowRun = {
        ...stored,
        directory,
        flow: { schemaVersion: '1.0', id: stored.flowId, name: stored.flowName, nodes: [] },
        inputs: {},
        isAdmin: false,
        abortController: new AbortController(),
        nodes: stored.nodes.map((node) => ({
          ...node,
          evidence: node.evidence.map((evidence) => ({
            ...evidence,
            sourceFile: evidence.sourceUrl ? path.join(directory, 'evidence', `${evidence.id}.xml`) : undefined,
            screenshotFile: evidence.screenshotUrl ? path.join(directory, 'evidence', `${evidence.id}.png`) : undefined,
          })),
        })),
      };
      this.runs.set(runId, run);
      if (stored.errorCode === 'PROCESS_INTERRUPTED') this.persist(run);
      return run;
    } catch (error: any) {
      logger.warn('读取回放运行记录失败', { runId, error: error?.message });
      return undefined;
    }
  }

  private assertAccess(run: InternalReplayFlowRun, actor: string, isAdmin: boolean) {
    if (run.owner === actor || isAdmin) return;
    throw new DeviceControlError(`回放运行记录属于 ${run.owner}`, 403);
  }
}

export const deviceReplayFlowExecutionService = new DeviceReplayFlowExecutionService();
