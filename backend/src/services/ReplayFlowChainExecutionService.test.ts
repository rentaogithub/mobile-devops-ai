import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, initializeDatabase } from '../database';
import { DeviceRecording } from './DeviceRecordingService';
import { ReplayFlowRun } from './DeviceReplayFlowExecutionService';
import { ReplayFlowAssetService } from './ReplayFlowAssetService';
import { ReplayFlowChainExecutionService } from './ReplayFlowChainExecutionService';

function recording(id: string, title: string): DeviceRecording {
  return {
    id,
    projectId: 'nn-ios',
    title,
    owner: 'admin',
    status: 'stopped',
    createdAt: '2026-09-03T00:00:00.000Z',
    stoppedAt: '2026-09-03T00:01:00.000Z',
    device: { udid: 'device-1', name: 'iPhone', osVersion: '18.0', connected: true },
    selectedCount: 1,
    candidateSelectedCount: 0,
    observations: [],
    steps: [{
      id: `${id}-step`,
      index: 1,
      origin: 'platform',
      status: 'ready',
      included: true,
      noiseLikely: false,
      summary: title,
      createdAt: '2026-09-03T00:00:01.000Z',
      action: {
        type: 'tap',
        params: { x: 100, y: 200 },
        normalizedPoint: { x: 0.5, y: 0.25 },
        target: { type: 'XCUIElementTypeButton', name: title, rect: { x: 80, y: 180, width: 40, height: 40 }, relativePoint: { x: 0.5, y: 0.5 }, depth: 4, locators: [] },
      },
    }],
  };
}

class FakeReplayExecutor {
  sequence = 0;
  order: string[] = [];
  flowNames: string[] = [];
  failedFlowIds = new Set<string>();
  runs = new Map<string, ReplayFlowRun>();

  start(flow: any, _inputs: Record<string, unknown>, actor: string) {
    const id = `run-${++this.sequence}`;
    this.order.push(flow.id);
    this.flowNames.push(flow.name);
    const failed = this.failedFlowIds.has(flow.id);
    const run: ReplayFlowRun = {
      id,
      projectId: 'nn-ios',
      flowId: flow.id,
      flowName: flow.name,
      schemaVersion: flow.schemaVersion,
      owner: actor,
      status: failed ? 'failed' : 'succeeded',
      result: failed ? 'failure' : 'success',
      errorCode: failed ? 'SIMULATED_FAILURE' : undefined,
      error: failed ? '模拟失败' : undefined,
      inputNames: [],
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      device: { udid: 'device-1', name: 'iPhone' },
      nodes: [],
    };
    this.runs.set(id, run);
    return run;
  }

  async waitForCompletion(runId: string) {
    return this.runs.get(runId)!;
  }

  stop(runId: string) {
    const run = this.runs.get(runId)!;
    run.status = 'cancelled';
    run.result = 'failure';
    run.errorCode = 'RUN_CANCELLED';
    return run;
  }
}

describe('ReplayFlowChainExecutionService', () => {
  let directory = '';
  let runDirectory = '';
  let assets: ReplayFlowAssetService;
  let executor: FakeReplayExecutor;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-flow-chain-'));
    runDirectory = path.join(directory, 'runs');
    closeDatabase();
    process.env.DB_PATH = path.join(directory, 'database.sqlite');
    initializeDatabase();
    assets = new ReplayFlowAssetService();
    executor = new FakeReplayExecutor();
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function configuredAssets() {
    const pre = assets.createFromRecording(recording('recording-pre', '登录准备'), 'admin');
    const main = assets.createFromRecording(recording('recording-main', '社区搜索'), 'admin');
    const post = assets.createFromRecording(recording('recording-post', '退出清理'), 'admin');
    const preVersion = assets.publish(pre.id, 'admin', { expectedRevision: pre.draft.revision }).version;
    const postVersion = assets.publish(post.id, 'admin', { expectedRevision: post.draft.revision }).version;
    assets.updateExecutionChain(main.id, 'admin', { preFlowVersionId: preVersion.id, postFlowVersionId: postVersion.id });
    return { pre, main, post, preVersion, postVersion };
  }

  test('按前置、主流程、后置顺序执行并且不持久化参数值', async () => {
    const { pre, main, post } = configuredAssets();
    const service = new ReplayFlowChainExecutionService(assets, executor, runDirectory);
    const started = service.start(main.id, { keyword: '绝密搜索词' }, 'admin', true);
    const run = await service.waitForCompletion(started.id);

    expect(run.status).toBe('succeeded');
    expect(executor.order).toEqual([pre.id, main.id, post.id]);
    expect(run.phases.map((phase) => `${phase.phase}:${phase.status}`)).toEqual([
      'pre:succeeded', 'main:succeeded', 'post:succeeded',
    ]);
    expect(fs.readFileSync(path.join(runDirectory, run.id, 'run.json'), 'utf8')).not.toContain('绝密搜索词');
    expect(run.inputNames).toEqual(['keyword']);
  });

  test('前置失败时跳过主流程但仍执行后置清理', async () => {
    const { pre, main, post } = configuredAssets();
    executor.failedFlowIds.add(pre.id);
    const service = new ReplayFlowChainExecutionService(assets, executor, runDirectory);
    const run = await service.waitForCompletion(service.start(main.id, {}, 'admin', true).id);

    expect(run.status).toBe('failed');
    expect(executor.order).toEqual([pre.id, post.id]);
    expect(run.phases.map((phase) => `${phase.phase}:${phase.status}`)).toEqual([
      'pre:failed', 'main:skipped', 'post:succeeded',
    ]);
  });

  test('主流程失败时仍执行后置清理', async () => {
    const { pre, main, post } = configuredAssets();
    executor.failedFlowIds.add(main.id);
    const service = new ReplayFlowChainExecutionService(assets, executor, runDirectory);
    const run = await service.waitForCompletion(service.start(main.id, {}, 'admin', true).id);

    expect(run.status).toBe('failed');
    expect(executor.order).toEqual([pre.id, main.id, post.id]);
    expect(run.phases[2]).toMatchObject({ phase: 'post', status: 'succeeded' });
  });

  test('前置和后置执行固定发布版本而不是后续草稿', async () => {
    const { pre, main, preVersion } = configuredAssets();
    const publishedName = preVersion.flow.name;
    assets.saveDraft(pre.id, 'admin', { expectedRevision: pre.draft.revision, name: '登录准备-未发布修改' });
    const service = new ReplayFlowChainExecutionService(assets, executor, runDirectory);

    await service.waitForCompletion(service.start(main.id, {}, 'admin', true).id);

    expect(executor.flowNames[0]).toBe(publishedName);
    expect(executor.flowNames[0]).not.toBe('登录准备-未发布修改');
  });
});
