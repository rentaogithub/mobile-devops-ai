import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DeviceControlError, DeviceControlStatus, deviceControlService } from './DeviceControlService';
import { enrichRecordingAction, RecordingAction, resolveReplayTapPoint, screenSizeFromSource } from './DeviceRecordingLocator';
import logger from '../utils/logger';
import { currentProjectId } from './ProductLineContext';

export type RecordingStepOrigin = 'platform' | 'annotated';
export type RecordingStepStatus = 'pending' | 'ready' | 'failed';
export type RecordingObservationStatus = 'pending' | 'ready' | 'failed';

export interface RecordingSnapshot {
  id: string;
  createdAt: string;
  screenshotUrl: string;
  sourceUrl: string;
  screenshotBytes: number;
  sourceBytes: number;
  screenshotHash: string;
  sourceHash: string;
}

interface InternalRecordingSnapshot extends RecordingSnapshot {
  screenshotFile: string;
  sourceFile: string;
}

export interface RecordingStep {
  id: string;
  index: number;
  origin: RecordingStepOrigin;
  status: RecordingStepStatus;
  included: boolean;
  noiseLikely: boolean;
  summary: string;
  createdAt: string;
  action: RecordingAction;
  beforeSnapshot?: RecordingSnapshot;
  afterSnapshot?: RecordingSnapshot;
  sourceDiff?: {
    addedCount: number;
    removedCount: number;
    addedLabels: string[];
    removedLabels: string[];
  };
  error?: string;
}

export interface RecordingObservation {
  id: string;
  index: number;
  kind: 'external_change';
  status: RecordingObservationStatus;
  included: boolean;
  promotedStepId?: string;
  noiseLikely: boolean;
  summary: string;
  createdAt: string;
  beforeSnapshot?: RecordingSnapshot;
  afterSnapshot?: RecordingSnapshot;
  sourceDiff?: RecordingStep['sourceDiff'];
  suggestedAction?: 'tap' | 'input' | 'ignore';
  suggestionReason?: string;
  logicalGroupId?: string;
  collapsedIntoObservationId?: string;
  collapsedObservationCount?: number;
  error?: string;
}

interface InternalRecordingStep extends Omit<RecordingStep, 'beforeSnapshot' | 'afterSnapshot'> {
  beforeSnapshotId?: string;
  afterSnapshotId?: string;
}

interface InternalRecordingObservation extends Omit<RecordingObservation, 'beforeSnapshot' | 'afterSnapshot'> {
  beforeSnapshotId?: string;
  afterSnapshotId?: string;
}

export interface DeviceRecording {
  id: string;
  projectId: string;
  title: string;
  owner: string;
  status: 'recording' | 'stopped';
  createdAt: string;
  stoppedAt?: string;
  device?: DeviceControlStatus['device'];
  initialSnapshot?: RecordingSnapshot;
  steps: RecordingStep[];
  observations: RecordingObservation[];
  selectedCount: number;
  candidateSelectedCount: number;
}

interface InternalDeviceRecording extends Omit<DeviceRecording, 'initialSnapshot' | 'steps' | 'observations' | 'selectedCount' | 'candidateSelectedCount'> {
  directory: string;
  initialSnapshotId?: string;
  lastSnapshotId?: string;
  snapshots: InternalRecordingSnapshot[];
  steps: InternalRecordingStep[];
  observations: InternalRecordingObservation[];
}

export interface ObservationActionAnnotation {
  type: 'tap' | 'swipe' | 'input';
  point?: { x: number; y: number };
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  durationMs?: number;
}

function sha1(value: Buffer | string) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function labelSet(source: string) {
  const values = new Set<string>();
  const regex = /(?:label|name|value)="([^"]{1,120})"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) && values.size < 2000) {
    const value = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
    if (value && !/^(true|false|null|\d+)$/.test(value)) values.add(value);
  }
  return values;
}

function sourceDiff(before: string, after: string) {
  const beforeLabels = labelSet(before);
  const afterLabels = labelSet(after);
  const added = [...afterLabels].filter((value) => !beforeLabels.has(value));
  const removed = [...beforeLabels].filter((value) => !afterLabels.has(value));
  return {
    addedCount: added.length,
    removedCount: removed.length,
    addedLabels: added.slice(0, 4),
    removedLabels: removed.slice(0, 4),
  };
}

export function replaySourceSimilarity(expected: string, actual: string) {
  const expectedLabels = labelSet(expected);
  const actualLabels = labelSet(actual);
  if (!expectedLabels.size) return expected === actual ? 1 : 0;
  let intersection = 0;
  expectedLabels.forEach((label) => {
    if (actualLabels.has(label)) intersection += 1;
  });
  return intersection / expectedLabels.size;
}

export function replayPreconditionStatus(
  expectedSource: string,
  currentSource: string,
  expectedTarget: string | undefined,
  isFirstReplayStep: boolean,
  sourceThreshold: number,
  initialSourceThreshold: number,
) {
  const score = replaySourceSimilarity(expectedSource, currentSource);
  const targetReady = !expectedTarget || labelSet(currentSource).has(expectedTarget);
  // The first replay step is an entry-point check. Dynamic labels such as member
  // counts and avatars make a whole-page comparison unstable, so a visible
  // target plus a lower source threshold is enough. Later steps remain strict:
  // they are the synchronization barrier for network-driven page transitions.
  const requiredThreshold = isFirstReplayStep
    ? expectedTarget
      ? initialSourceThreshold
      : Math.max(initialSourceThreshold, 0.5)
    : sourceThreshold;
  return {
    score,
    targetReady,
    requiredThreshold,
    ready: targetReady && score >= requiredThreshold,
  };
}

function actionSemanticTarget(action: RecordingAction) {
  if (action.type !== 'tap' && action.type !== 'input') return undefined;
  const target = action.target;
  if (!target) return undefined;
  const accessibilityId = target.locators.find((locator) => locator.strategy === 'accessibilityId')?.value;
  const values = [
    accessibilityId,
    target.name,
    target.label,
    target.value,
    target.placeholder,
    ...(target.contextLabels || []),
  ];
  return values.some((value) => String(value || '').trim()) ? target : undefined;
}

export function replayActionPreconditionStatus(
  expectedSource: string,
  currentSource: string,
  action: RecordingAction,
  isFirstReplayStep: boolean,
  sourceThreshold: number,
  initialSourceThreshold: number,
) {
  const target = actionSemanticTarget(action);
  const screen = screenSizeFromSource(currentSource) || action.screenSize;
  if (target && screen) {
    const resolved = resolveReplayTapPoint(action, currentSource, screen);
    const targetReady = resolved?.strategy === 'semantic';
    return {
      score: replaySourceSimilarity(expectedSource, currentSource),
      targetReady,
      requiredThreshold: 0,
      ready: targetReady,
      strategy: 'semantic-target' as const,
    };
  }
  return {
    ...replayPreconditionStatus(
      expectedSource,
      currentSource,
      undefined,
      isFirstReplayStep,
      sourceThreshold,
      initialSourceThreshold,
    ),
    strategy: 'snapshot' as const,
  };
}

type CompactableReplayStep = {
  origin: RecordingStepOrigin;
  action: {
    type: string;
    target?: { placeholder?: string; name?: string; label?: string };
    startTarget?: { placeholder?: string; name?: string; label?: string };
  };
  beforeSnapshotId?: string;
  afterSnapshotId?: string;
};

function replayInputTarget(step: CompactableReplayStep) {
  const target = step.action.target || step.action.startTarget;
  return String(target?.placeholder || target?.name || target?.label || '').trim();
}

function duplicateAnnotatedReplayInput(left: CompactableReplayStep | undefined, right: CompactableReplayStep) {
  return Boolean(
    left
    && left.origin === 'annotated'
    && right.origin === 'annotated'
    && left.action.type === 'input'
    && right.action.type === 'input'
    && left.afterSnapshotId
    && left.afterSnapshotId === right.beforeSnapshotId
    && replayInputTarget(left)
    && replayInputTarget(left) === replayInputTarget(right),
  );
}

export function compactReplayInputSteps<T extends CompactableReplayStep>(steps: T[]) {
  const executable: T[] = [];
  const skipped: T[] = [];
  for (const step of steps) {
    const previous = executable[executable.length - 1];
    const duplicateAnnotatedInput = duplicateAnnotatedReplayInput(previous, step);
    if (duplicateAnnotatedInput) {
      skipped.push(step);
    } else {
      executable.push(step);
    }
  }
  return { executable, skipped };
}

function inferredSummary(diff: ReturnType<typeof sourceDiff>, sourceChanged: boolean, screenshotChanged: boolean) {
  if (!sourceChanged && screenshotChanged) return '仅画面发生变化，可能是动画、倒计时或滚动惯性';
  if (!sourceChanged) return '未检测到稳定页面变化';
  const parts: string[] = [];
  if (diff.addedLabels.length) parts.push(`出现「${diff.addedLabels.join('、')}」`);
  if (diff.removedLabels.length) parts.push(`消失「${diff.removedLabels.join('、')}」`);
  if (!parts.length) parts.push(`WDA 树变化：新增 ${diff.addedCount}，移除 ${diff.removedCount}`);
  return parts.join('；');
}

function inputFieldState(source: string) {
  const fields: string[] = [];
  const regex = /<XCUIElementType(?:TextField|SecureTextField|TextView)\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source))) {
    const attributes = match[1];
    const value = attributes.match(/\bvalue="([^"]*)"/)?.[1] || '';
    const placeholder = attributes.match(/\bplaceholderValue="([^"]*)"/)?.[1] || '';
    fields.push(`${placeholder}\u0000${value}`);
  }
  return fields.join('\u0001');
}

export function recordingObservationSuggestion(
  beforeSource: string,
  afterSource: string,
  diff: Pick<NonNullable<RecordingObservation['sourceDiff']>, 'addedCount' | 'removedCount'>,
) {
  if (diff.addedCount === 0 && diff.removedCount === 0) {
    return {
      action: 'ignore' as const,
      reason: '页面标签没有变化，属于动画、焦点或 Source 属性抖动',
    };
  }
  const keyboardBefore = /<XCUIElementTypeKeyboard\b/.test(beforeSource);
  const keyboardAfter = /<XCUIElementTypeKeyboard\b/.test(afterSource);
  if (keyboardBefore && keyboardAfter && inputFieldState(beforeSource) !== inputFieldState(afterSource)) {
    return {
      action: 'input' as const,
      reason: '同一输入会话中的拼音、联想和文字上屏，合并为一个参数化 Input',
    };
  }
  if (!keyboardBefore && keyboardAfter) {
    return {
      action: 'tap' as const,
      reason: '点击后进入输入态，建议标记触发输入页或聚焦输入框的 Tap',
    };
  }
  if (keyboardBefore && !keyboardAfter) {
    return {
      action: 'tap' as const,
      reason: '键盘收起并发生页面跳转，建议标记搜索、确认或提交按钮的 Tap',
    };
  }
  return {
    action: 'tap' as const,
    reason: '页面发生明确跳转，建议从变化前截图标记触发跳转的 Tap；如实际为滑动可手动切换',
  };
}

export class DeviceRecordingService {
  private recordings = new Map<string, InternalDeviceRecording>();
  private currentRecordingIds = new Map<string, string>();
  private captureQueue: Promise<void> = Promise.resolve();

  private rootDirectory() {
    const base = path.resolve(
      process.env.DEVICE_RECORDING_DIR || path.join(process.cwd(), '../nn-ios-platform-data/device-recordings'),
    );
    const projectId = currentProjectId();
    return projectId === 'nn-ios' ? base : path.join(base, projectId.replace(/[^A-Za-z0-9_.-]/g, '_'));
  }

  async start(title: string, actor: string, isAdmin: boolean) {
    const current = this.currentRecording();
    if (current?.status === 'recording') {
      if (current.owner === actor || isAdmin) return this.publicRecording(current);
      throw new DeviceControlError(`录制正由 ${current.owner} 进行`, 409);
    }
    const deviceStatus = deviceControlService.getStatus();
    if (deviceStatus.phase !== 'connected' || !deviceStatus.device) {
      throw new DeviceControlError('请先连接真机操作台，再开始录制', 409);
    }
    deviceControlService.assertAccess(actor, isAdmin);

    const id = crypto.randomUUID();
    const directory = path.join(this.rootDirectory(), id);
    fs.mkdirSync(path.join(directory, 'snapshots'), { recursive: true });
    const recording: InternalDeviceRecording = {
      id,
      projectId: currentProjectId(),
      title: String(title || '').trim().slice(0, 100) || `真机路径 ${new Date().toLocaleString('zh-CN')}`,
      owner: actor,
      status: 'recording',
      createdAt: new Date().toISOString(),
      device: deviceStatus.device,
      directory,
      snapshots: [],
      steps: [],
      observations: [],
    };
    this.recordings.set(id, recording);
    this.currentRecordingIds.set(currentProjectId(), id);
    try {
      const initial = await this.captureSnapshot(recording, actor, isAdmin);
      recording.initialSnapshotId = initial.id;
      recording.lastSnapshotId = initial.id;
      this.persist(recording);
    } catch (error) {
      this.recordings.delete(id);
      this.currentRecordingIds.delete(currentProjectId());
      throw error;
    }
    logger.info('真机路径录制已开始', { recordingId: id, owner: actor, device: deviceStatus.device.udid });
    return this.publicRecording(recording);
  }

  async stop(actor: string, isAdmin: boolean) {
    const recording = this.requireCurrent(actor, isAdmin);
    await this.captureQueue;
    recording.status = 'stopped';
    recording.stoppedAt = new Date().toISOString();
    this.persist(recording);
    this.currentRecordingIds.delete(currentProjectId());
    logger.info('真机路径录制已停止', { recordingId: recording.id, owner: actor, steps: recording.steps.length });
    return this.publicRecording(recording);
  }

  getCurrent(actor: string, isAdmin: boolean) {
    const current = this.currentRecording();
    if (!current) return null;
    this.assertRecordingAccess(current, actor, isAdmin);
    return this.publicRecording(current);
  }

  getLatest(actor: string, isAdmin: boolean) {
    const root = this.rootDirectory();
    if (!fs.existsSync(root)) return null;
    const recordings = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.findRecording(entry.name))
      .filter((recording): recording is InternalDeviceRecording => Boolean(recording))
      .filter((recording) => recording.owner === actor || isAdmin)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return recordings[0] ? this.publicRecording(recordings[0]) : null;
  }

  getRecording(id: string, actor: string, isAdmin: boolean) {
    const recording = this.findRecording(id);
    if (!recording) throw new DeviceControlError('录制不存在', 404);
    this.assertRecordingAccess(recording, actor, isAdmin);
    return this.publicRecording(recording);
  }

  notePlatformAction(actor: string, isAdmin: boolean, action: Pick<RecordingAction, 'type' | 'params'>, summary: string) {
    const recording = this.currentRecording();
    if (!recording || recording.status !== 'recording') return null;
    this.assertRecordingAccess(recording, actor, isAdmin);
    const before = this.snapshot(recording, recording.lastSnapshotId);
    const source = before ? fs.readFileSync(before.sourceFile, 'utf8') : '';
    const windowSize = deviceControlService.getStatus().windowSize;
    const enrichedAction = source && windowSize ? enrichRecordingAction(action, source, windowSize) : action;
    return this.createStep(recording, actor, isAdmin, enrichedAction, summary, 260);
  }

  observeDeviceChange(actor: string, isAdmin: boolean) {
    const recording = this.requireCurrent(actor, isAdmin);
    const hasPendingPlatformStep = recording.steps.some((step) => step.status === 'pending');
    if (hasPendingPlatformStep) return this.publicRecording(recording);
    const hasPendingObservation = recording.observations.some((observation) => observation.status === 'pending');
    if (hasPendingObservation) return this.publicRecording(recording);
    this.createObservation(recording, actor, isAdmin);
    return this.publicRecording(recording);
  }

  updateStep(recordingId: string, stepId: string, included: boolean, actor: string, isAdmin: boolean) {
    const recording = this.findRecording(recordingId);
    if (!recording) throw new DeviceControlError('录制不存在', 404);
    this.assertRecordingAccess(recording, actor, isAdmin);
    const step = recording.steps.find((item) => item.id === stepId);
    if (!step) throw new DeviceControlError('候选步骤不存在', 404);
    step.included = Boolean(included);
    this.persist(recording);
    return this.publicRecording(recording);
  }

  updateObservation(recordingId: string, observationId: string, included: boolean, actor: string, isAdmin: boolean) {
    const recording = this.findRecording(recordingId);
    if (!recording) throw new DeviceControlError('录制不存在', 404);
    this.assertRecordingAccess(recording, actor, isAdmin);
    const observation = recording.observations.find((item) => item.id === observationId);
    if (!observation) throw new DeviceControlError('手机操作候选不存在', 404);
    observation.included = Boolean(included);
    this.persist(recording);
    return this.publicRecording(recording);
  }

  promoteObservation(
    recordingId: string,
    observationId: string,
    annotation: ObservationActionAnnotation,
    actor: string,
    isAdmin: boolean,
  ) {
    const recording = this.findRecording(recordingId);
    if (!recording) throw new DeviceControlError('录制不存在', 404);
    this.assertRecordingAccess(recording, actor, isAdmin);
    const observation = recording.observations.find((item) => item.id === observationId);
    if (!observation) throw new DeviceControlError('手机操作候选不存在', 404);
    if (observation.status !== 'ready') throw new DeviceControlError('候选证据尚未采集完成', 409);
    const before = this.snapshot(recording, observation.beforeSnapshotId);
    if (!before) throw new DeviceControlError('候选缺少操作前 Source', 409);
    const source = fs.readFileSync(before.sourceFile, 'utf8');
    const screen = screenSizeFromSource(source);
    if (!screen) throw new DeviceControlError('无法识别录制画面的逻辑尺寸', 422);
    const clampPoint = (point: { x: number; y: number } | undefined) => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
      return {
        x: Math.round(Math.min(Math.max(point.x, 0), 1) * screen.width),
        y: Math.round(Math.min(Math.max(point.y, 0), 1) * screen.height),
      };
    };
    let action: Pick<RecordingAction, 'type' | 'params'>;
    let summary: string;
    if (annotation.type === 'tap') {
      const point = clampPoint(annotation.point);
      if (!point) throw new DeviceControlError('请在变化前截图上标记点击位置', 422);
      action = { type: 'tap', params: point };
      summary = `补标点击 (${point.x}, ${point.y})`;
    } else if (annotation.type === 'swipe') {
      const start = clampPoint(annotation.start);
      const end = clampPoint(annotation.end);
      if (!start || !end) throw new DeviceControlError('请在变化前截图上拖出滑动路径', 422);
      const durationMs = Math.min(Math.max(Math.round(annotation.durationMs || 350), 100), 3000);
      action = { type: 'swipe', params: { start, end, durationMs } };
      summary = `补标滑动 (${start.x}, ${start.y}) → (${end.x}, ${end.y})`;
    } else {
      action = { type: 'input', params: { value: '${INPUT}', length: 0 } };
      summary = '补标参数化文本输入';
    }
    const enrichedAction = enrichRecordingAction(action, source, screen);
    const existingStep = observation.promotedStepId
      ? recording.steps.find((item) => item.id === observation.promotedStepId)
      : undefined;
    if (existingStep) {
      existingStep.action = enrichedAction;
      existingStep.summary = summary;
      existingStep.included = true;
    } else {
      const step: InternalRecordingStep = {
        id: crypto.randomUUID(),
        index: recording.steps.length + 1,
        origin: 'annotated',
        status: 'ready',
        included: true,
        noiseLikely: false,
        summary,
        createdAt: new Date().toISOString(),
        action: enrichedAction,
        beforeSnapshotId: observation.beforeSnapshotId,
        afterSnapshotId: observation.afterSnapshotId,
        sourceDiff: observation.sourceDiff,
      };
      const previousStep = recording.steps[recording.steps.length - 1];
      if (duplicateAnnotatedReplayInput(previousStep, step)) {
        previousStep.afterSnapshotId = step.afterSnapshotId;
        previousStep.sourceDiff = step.sourceDiff;
        previousStep.included = true;
        previousStep.summary = '补标参数化文本输入（已合并输入法中间态）';
        observation.promotedStepId = previousStep.id;
      } else {
        recording.steps.push(step);
        observation.promotedStepId = step.id;
      }
    }
    observation.included = false;
    this.reindexSteps(recording);
    this.persist(recording);
    return this.publicRecording(recording);
  }

  async replay(recordingId: string, inputValue: string, actor: string, isAdmin: boolean) {
    const recording = this.findRecording(recordingId);
    if (!recording) throw new DeviceControlError('录制不存在', 404);
    this.assertRecordingAccess(recording, actor, isAdmin);
    this.reindexSteps(recording);
    const selectedSteps = recording.steps.filter((step) => step.included && step.status === 'ready');
    if (!selectedSteps.length) throw new DeviceControlError('没有已选择的可回放步骤', 422);
    if (selectedSteps.some((step) => step.action.type === 'input') && !inputValue) {
      throw new DeviceControlError('回放包含参数化输入，请填写本次输入值', 422);
    }
    const { executable: steps, skipped } = compactReplayInputSteps(selectedSteps);
    if (skipped.length) {
      logger.info('回放自动合并连续重复输入', {
        recordingId,
        actor,
        skippedStepIndexes: skipped.map((step) => step.index),
      });
    }
    const results: Array<{ stepId: string; index: number; type: string; summary: string }> = [];
    for (const [position, step] of steps.entries()) {
      await this.waitForReplayPrecondition(recording, step, position === 0, actor, isAdmin);
      const params = step.action.params || {};
      if (step.action.type === 'tap') {
        const x = Number(params.x);
        const y = Number(params.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new DeviceControlError(`步骤 #${step.index} 缺少点击坐标`, 422);
        const currentSource = await deviceControlService.source(actor, isAdmin);
        const currentScreen = screenSizeFromSource(currentSource)
          || step.action.screenSize
          || deviceControlService.getStatus().windowSize;
        const resolved = currentScreen
          ? resolveReplayTapPoint(step.action, currentSource, currentScreen)
          : undefined;
        const point = resolved?.point || { x, y };
        logger.info('回放点击目标已解析', {
          recordingId,
          stepIndex: step.index,
          strategy: resolved?.strategy || 'raw-coordinate',
          recordedPoint: { x, y },
          resolvedPoint: point,
          recordedTarget: step.action.target?.name || step.action.target?.label || step.action.target?.value,
          matchedTarget: resolved?.matchedTarget?.name || resolved?.matchedTarget?.label || resolved?.matchedTarget?.value,
          distance: resolved?.distance,
        });
        await deviceControlService.tap(point.x, point.y, actor, isAdmin);
      } else if (step.action.type === 'swipe') {
        const start = params.start as { x?: unknown; y?: unknown } | undefined;
        const end = params.end as { x?: unknown; y?: unknown } | undefined;
        const startX = Number(start?.x);
        const startY = Number(start?.y);
        const endX = Number(end?.x);
        const endY = Number(end?.y);
        if (![startX, startY, endX, endY].every(Number.isFinite)) {
          throw new DeviceControlError(`步骤 #${step.index} 缺少滑动路径`, 422);
        }
        await deviceControlService.swipe(startX, startY, endX, endY, Number(params.durationMs) || 350, actor, isAdmin);
      } else if (step.action.type === 'input') {
        const currentSource = await deviceControlService.source(actor, isAdmin);
        const currentScreen = screenSizeFromSource(currentSource)
          || step.action.screenSize
          || deviceControlService.getStatus().windowSize;
        const resolved = currentScreen
          ? resolveReplayTapPoint(step.action, currentSource, currentScreen)
          : undefined;
        if (resolved?.strategy === 'semantic') {
          await deviceControlService.tap(resolved.point.x, resolved.point.y, actor, isAdmin);
          await new Promise<void>((resolve) => setTimeout(resolve, 120));
        }
        await deviceControlService.input(inputValue, actor, isAdmin);
      } else {
        throw new DeviceControlError(`步骤 #${step.index} 的动作类型暂不支持回放`, 422);
      }
      results.push({ stepId: step.id, index: step.index, type: step.action.type, summary: step.summary });
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    logger.info('真机路径回放完成', {
      recordingId,
      actor,
      selectedCount: selectedSteps.length,
      executedCount: results.length,
      skippedCount: skipped.length,
    });
    return {
      recordingId,
      selectedCount: selectedSteps.length,
      executedCount: results.length,
      skippedCount: skipped.length,
      skipped: skipped.map((step) => ({
        stepId: step.id,
        index: step.index,
        type: step.action.type,
        summary: step.summary,
        reason: '与前一条参数化输入目标相同且证据首尾相接',
      })),
      results,
    };
  }

  private async waitForReplayPrecondition(
    recording: InternalDeviceRecording,
    step: InternalRecordingStep,
    isFirstReplayStep: boolean,
    actor: string,
    isAdmin: boolean,
  ) {
    const before = this.snapshot(recording, step.beforeSnapshotId);
    if (!before || !fs.existsSync(before.sourceFile)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 800));
      return;
    }
    const expectedSource = fs.readFileSync(before.sourceFile, 'utf8');
    const target = step.action.target || step.action.startTarget;
    const expectedTarget = target?.name || target?.label || target?.placeholder || target?.value;
    const timeoutMs = Math.max(3000, Number(process.env.DEVICE_REPLAY_PRECONDITION_TIMEOUT_MS) || 15000);
    const threshold = Math.min(Math.max(Number(process.env.DEVICE_REPLAY_SOURCE_MATCH_THRESHOLD) || 0.72, 0.4), 0.98);
    const initialThreshold = Math.min(
      Math.max(Number(process.env.DEVICE_REPLAY_INITIAL_SOURCE_MATCH_THRESHOLD) || 0.4, 0.2),
      threshold,
    );
    const startedAt = Date.now();
    let bestScore = 0;
    let targetSeen = false;
    let lastError: unknown;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const currentSource = await deviceControlService.source(actor, isAdmin);
        const status = replayActionPreconditionStatus(
          expectedSource,
          currentSource,
          step.action,
          isFirstReplayStep,
          threshold,
          initialThreshold,
        );
        bestScore = Math.max(bestScore, status.score);
        targetSeen ||= status.targetReady;
        if (status.ready) {
          logger.info('回放页面前置条件已满足', {
            recordingId: recording.id,
            stepIndex: step.index,
            replayPosition: isFirstReplayStep ? 'initial' : 'subsequent',
            score: Number(status.score.toFixed(3)),
            requiredScore: Number(status.requiredThreshold.toFixed(3)),
            strategy: status.strategy,
            target: expectedTarget,
            targetReady: status.targetReady,
          });
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    const detail = lastError instanceof Error ? `，WDA错误：${lastError.message}` : '';
    const targetDetail = expectedTarget ? `，目标控件${targetSeen ? '已出现' : '未出现'}` : '';
    throw new DeviceControlError(
      `步骤 #${step.index} 的页面条件未满足，已等待 ${Math.round(timeoutMs / 1000)} 秒（最佳匹配 ${Math.round(bestScore * 100)}%${targetDetail}）${detail}`,
      409,
    );
  }

  evidenceFile(recordingId: string, snapshotId: string, kind: 'screenshot' | 'source', actor: string, isAdmin: boolean) {
    const recording = this.findRecording(recordingId);
    if (!recording) throw new DeviceControlError('录制不存在', 404);
    this.assertRecordingAccess(recording, actor, isAdmin);
    const snapshot = recording.snapshots.find((item) => item.id === snapshotId);
    if (!snapshot) throw new DeviceControlError('录制证据不存在', 404);
    return kind === 'screenshot' ? snapshot.screenshotFile : snapshot.sourceFile;
  }

  private createStep(
    recording: InternalDeviceRecording,
    actor: string,
    isAdmin: boolean,
    action: InternalRecordingStep['action'],
    summary: string,
    delayMs: number,
  ) {
    const step: InternalRecordingStep = {
      id: crypto.randomUUID(),
      index: recording.steps.length + 1,
      origin: 'platform',
      status: 'pending',
      included: true,
      noiseLikely: false,
      summary,
      createdAt: new Date().toISOString(),
      action,
      beforeSnapshotId: recording.lastSnapshotId,
    };
    recording.steps.push(step);
    this.persist(recording);
    this.captureQueue = this.captureQueue
      .then(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        const before = this.snapshot(recording, step.beforeSnapshotId);
        const after = await this.captureSnapshot(recording, actor, isAdmin);
        step.afterSnapshotId = after.id;
        recording.lastSnapshotId = after.id;
        if (before) {
          const beforeSource = fs.readFileSync(before.sourceFile, 'utf8');
          const afterSource = fs.readFileSync(after.sourceFile, 'utf8');
          const diff = sourceDiff(beforeSource, afterSource);
          step.sourceDiff = diff;
        }
        step.status = 'ready';
        this.persist(recording);
      })
      .catch((error: any) => {
        step.status = 'failed';
        step.included = false;
        step.error = error?.message || '采集步骤证据失败';
        this.persist(recording);
        logger.warn('采集录制步骤证据失败', { recordingId: recording.id, stepId: step.id, error: step.error });
      });
    return this.publicRecording(recording);
  }

  private createObservation(recording: InternalDeviceRecording, actor: string, isAdmin: boolean) {
    const observation: InternalRecordingObservation = {
      id: crypto.randomUUID(),
      index: recording.observations.length + 1,
      kind: 'external_change',
      status: 'pending',
      included: true,
      noiseLikely: false,
      summary: '正在分析平台指令之外的页面变化…',
      createdAt: new Date().toISOString(),
      beforeSnapshotId: recording.lastSnapshotId,
    };
    recording.observations.push(observation);
    this.persist(recording);
    this.captureQueue = this.captureQueue
      .then(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        const before = this.snapshot(recording, observation.beforeSnapshotId);
        const after = await this.captureSnapshot(recording, actor, isAdmin);
        observation.afterSnapshotId = after.id;
        recording.lastSnapshotId = after.id;
        if (!before) {
          observation.status = 'ready';
          this.persist(recording);
          return;
        }
        const beforeSource = fs.readFileSync(before.sourceFile, 'utf8');
        const afterSource = fs.readFileSync(after.sourceFile, 'utf8');
        const diff = sourceDiff(beforeSource, afterSource);
        const sourceChanged = before.sourceHash !== after.sourceHash;
        const screenshotChanged = before.screenshotHash !== after.screenshotHash;
        if (!sourceChanged && !screenshotChanged) {
          recording.observations = recording.observations.filter((item) => item.id !== observation.id);
          this.reindexObservations(recording);
          this.persist(recording);
          return;
        }
        const suggestion = recordingObservationSuggestion(beforeSource, afterSource, diff);
        observation.sourceDiff = diff;
        observation.suggestedAction = suggestion.action;
        observation.suggestionReason = suggestion.reason;
        observation.noiseLikely = !sourceChanged || suggestion.action === 'ignore';
        observation.included = !observation.noiseLikely;
        observation.summary = inferredSummary(diff, sourceChanged, screenshotChanged);
        observation.status = 'ready';
        this.persist(recording);
      })
      .catch((error: any) => {
        observation.status = 'failed';
        observation.error = error?.message || '采集外部变化证据失败';
        this.persist(recording);
        logger.warn('采集平台外页面变化失败', {
          recordingId: recording.id,
          observationId: observation.id,
          error: observation.error,
        });
      });
  }

  private async captureSnapshot(recording: InternalDeviceRecording, actor: string, isAdmin: boolean) {
    const id = crypto.randomUUID();
    const source = await deviceControlService.source(actor, isAdmin);
    const screenshot = await deviceControlService.screenshot(actor, isAdmin);
    const sourceFile = path.join(recording.directory, 'snapshots', `${id}.xml`);
    const screenshotFile = path.join(recording.directory, 'snapshots', `${id}.png`);
    fs.writeFileSync(sourceFile, source, 'utf8');
    fs.writeFileSync(screenshotFile, screenshot);
    const snapshot: InternalRecordingSnapshot = {
      id,
      createdAt: new Date().toISOString(),
      screenshotUrl: `/api/device-control/recordings/${encodeURIComponent(recording.id)}/evidence/${encodeURIComponent(id)}/screenshot`,
      sourceUrl: `/api/device-control/recordings/${encodeURIComponent(recording.id)}/evidence/${encodeURIComponent(id)}/source`,
      screenshotBytes: screenshot.length,
      sourceBytes: Buffer.byteLength(source),
      screenshotHash: sha1(screenshot),
      sourceHash: sha1(source),
      screenshotFile,
      sourceFile,
    };
    recording.snapshots.push(snapshot);
    return snapshot;
  }

  private publicRecording(recording: InternalDeviceRecording): DeviceRecording {
    this.reindexSteps(recording);
    const logicalObservations: Array<InternalRecordingObservation & {
      suggestedAction: 'tap' | 'input' | 'ignore';
      suggestionReason: string;
      logicalGroupId: string;
      collapsedIntoObservationId?: string;
      collapsedObservationCount: number;
    }> = [];
    let activeInputGroup: { observationId: string; groupId: string; afterSnapshotId?: string } | undefined;
    for (const observation of recording.observations) {
      const before = this.snapshot(recording, observation.beforeSnapshotId);
      const after = this.snapshot(recording, observation.afterSnapshotId);
      let suggestedAction = observation.suggestedAction || 'tap';
      let suggestionReason = observation.suggestionReason || '请根据前后证据确认实际操作';
      if ((!observation.suggestedAction || !observation.suggestionReason)
        && before && after && fs.existsSync(before.sourceFile) && fs.existsSync(after.sourceFile) && observation.sourceDiff) {
        const suggestion = recordingObservationSuggestion(
          fs.readFileSync(before.sourceFile, 'utf8'),
          fs.readFileSync(after.sourceFile, 'utf8'),
          observation.sourceDiff,
        );
        suggestedAction = suggestion.action;
        suggestionReason = suggestion.reason;
        observation.suggestedAction = suggestion.action;
        observation.suggestionReason = suggestion.reason;
      }
      let logicalGroupId = observation.id;
      let collapsedIntoObservationId: string | undefined;
      if (suggestedAction === 'input') {
        if (activeInputGroup && activeInputGroup.afterSnapshotId === observation.beforeSnapshotId) {
          logicalGroupId = activeInputGroup.groupId;
          collapsedIntoObservationId = activeInputGroup.observationId;
          activeInputGroup.afterSnapshotId = observation.afterSnapshotId;
        } else {
          logicalGroupId = `input-${observation.id}`;
          activeInputGroup = { observationId: observation.id, groupId: logicalGroupId, afterSnapshotId: observation.afterSnapshotId };
        }
      } else {
        activeInputGroup = undefined;
      }
      logicalObservations.push({
        ...observation,
        suggestedAction,
        suggestionReason,
        logicalGroupId,
        collapsedIntoObservationId,
        collapsedObservationCount: 1,
      });
    }
    const groupCounts = new Map<string, number>();
    logicalObservations.forEach((observation) => {
      groupCounts.set(observation.logicalGroupId, (groupCounts.get(observation.logicalGroupId) || 0) + 1);
    });
    logicalObservations.forEach((observation) => {
      observation.collapsedObservationCount = groupCounts.get(observation.logicalGroupId) || 1;
    });
    return {
      id: recording.id,
      projectId: recording.projectId,
      title: recording.title,
      owner: recording.owner,
      status: recording.status,
      createdAt: recording.createdAt,
      stoppedAt: recording.stoppedAt,
      device: recording.device,
      initialSnapshot: this.publicSnapshot(this.snapshot(recording, recording.initialSnapshotId)),
      steps: recording.steps.map((step) => {
        const { beforeSnapshotId, afterSnapshotId, ...publicStep } = step;
        return {
          ...publicStep,
          beforeSnapshot: this.publicSnapshot(this.snapshot(recording, beforeSnapshotId)),
          afterSnapshot: this.publicSnapshot(this.snapshot(recording, afterSnapshotId)),
        };
      }),
      observations: logicalObservations.map((observation) => {
        const { beforeSnapshotId, afterSnapshotId, ...publicObservation } = observation;
        return {
          ...publicObservation,
          included: observation.included
            && observation.suggestedAction !== 'ignore'
            && !observation.collapsedIntoObservationId,
          beforeSnapshot: this.publicSnapshot(this.snapshot(recording, beforeSnapshotId)),
          afterSnapshot: this.publicSnapshot(this.snapshot(recording, afterSnapshotId)),
        };
      }),
      selectedCount: recording.steps.filter((step) => step.included).length,
      candidateSelectedCount: logicalObservations.filter((observation) => (
        observation.included
        && observation.suggestedAction !== 'ignore'
        && !observation.collapsedIntoObservationId
      )).length,
    };
  }

  private publicSnapshot(snapshot?: InternalRecordingSnapshot) {
    if (!snapshot) return undefined;
    const { screenshotFile: _screenshotFile, sourceFile: _sourceFile, ...publicSnapshot } = snapshot;
    return publicSnapshot;
  }

  private snapshot(recording: InternalDeviceRecording, id?: string) {
    return id ? recording.snapshots.find((item) => item.id === id) : undefined;
  }

  private currentRecording() {
    const id = this.currentRecordingIds.get(currentProjectId());
    const recording = id ? this.recordings.get(id) : undefined;
    return recording?.projectId === currentProjectId() ? recording : undefined;
  }

  private requireCurrent(actor: string, isAdmin: boolean) {
    const recording = this.currentRecording();
    if (!recording || recording.status !== 'recording') throw new DeviceControlError('当前没有正在进行的录制', 409);
    this.assertRecordingAccess(recording, actor, isAdmin);
    return recording;
  }

  private assertRecordingAccess(recording: InternalDeviceRecording, actor: string, isAdmin: boolean) {
    if (recording.owner === actor || isAdmin) return;
    throw new DeviceControlError(`录制属于 ${recording.owner}`, 403);
  }

  private reindexSteps(recording: InternalDeviceRecording) {
    recording.steps.sort((left, right) => {
      const leftTime = this.snapshot(recording, left.beforeSnapshotId)?.createdAt || left.createdAt;
      const rightTime = this.snapshot(recording, right.beforeSnapshotId)?.createdAt || right.createdAt;
      return leftTime.localeCompare(rightTime) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    });
    recording.steps.forEach((step, index) => { step.index = index + 1; });
  }

  private reindexObservations(recording: InternalDeviceRecording) {
    recording.observations.forEach((observation, index) => { observation.index = index + 1; });
  }

  private persist(recording: InternalDeviceRecording) {
    fs.mkdirSync(recording.directory, { recursive: true });
    const file = path.join(recording.directory, 'recording.json');
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(recording, null, 2), 'utf8');
    fs.renameSync(temp, file);
  }

  private findRecording(id: string) {
    const cached = this.recordings.get(id);
    if (cached) return cached.projectId === currentProjectId() ? cached : undefined;
    const directory = path.join(this.rootDirectory(), id);
    const file = path.join(directory, 'recording.json');
    if (!fs.existsSync(file)) return undefined;
    try {
      const rawRecording = JSON.parse(fs.readFileSync(file, 'utf8')) as Omit<InternalDeviceRecording, 'steps' | 'observations'> & {
        observations?: InternalRecordingObservation[];
        steps: Array<Omit<InternalRecordingStep, 'origin'> & { origin?: 'platform' | 'annotated' | 'device' }>;
      };
      const legacyDeviceSteps = rawRecording.steps.filter((step) => step.origin === 'device');
      const recording: InternalDeviceRecording = {
        ...rawRecording,
        projectId: rawRecording.projectId || currentProjectId(),
        directory,
        steps: rawRecording.steps
        .filter((step) => step.origin !== 'device')
          .map((step) => ({ ...step, origin: step.origin === 'annotated' ? 'annotated' as const : 'platform' as const })),
        observations: (rawRecording.observations || legacyDeviceSteps.map((step, index) => ({
          id: step.id,
          index: index + 1,
          kind: 'external_change' as const,
          status: step.status,
          included: !step.noiseLikely,
          noiseLikely: step.noiseLikely,
          summary: step.summary,
          createdAt: step.createdAt,
          beforeSnapshotId: step.beforeSnapshotId,
          afterSnapshotId: step.afterSnapshotId,
          sourceDiff: step.sourceDiff,
          error: step.error,
        }))).map((observation) => ({
          ...observation,
          included: observation.included ?? !observation.noiseLikely,
        })),
      };
      if (recording.projectId !== currentProjectId()) return undefined;
      this.reindexSteps(recording);
      this.reindexObservations(recording);
      this.recordings.set(id, recording);
      return recording;
    } catch (error: any) {
      logger.warn('读取真机路径录制失败', { recordingId: id, error: error?.message });
      return undefined;
    }
  }
}

export const deviceRecordingService = new DeviceRecordingService();
