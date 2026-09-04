import fs from 'fs';
import os from 'os';
import path from 'path';
import { DeviceReplayFlowDsl } from './DeviceReplayFlow';
import {
  DeviceReplayFlowExecutionService,
  DeviceReplayRuntimeAdapter,
} from './DeviceReplayFlowExecutionService';

const homeSource = `<?xml version="1.0"?>
<XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" enabled="true" x="0" y="0" width="390" height="844">
  <XCUIElementTypeWindow type="XCUIElementTypeWindow" visible="true" enabled="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeTextField type="XCUIElementTypeTextField" name="community_search" label="搜索社区" placeholderValue="搜索" visible="true" enabled="true" focused="true" x="20" y="80" width="350" height="44"/>
  </XCUIElementTypeWindow>
</XCUIElementTypeApplication>`;

const resultSource = `<?xml version="1.0"?>
<XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" enabled="true" x="0" y="0" width="390" height="844">
  <XCUIElementTypeWindow type="XCUIElementTypeWindow" visible="true" enabled="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeTextField type="XCUIElementTypeTextField" name="community_search" label="搜索社区" placeholderValue="搜索" value="王者" visible="true" enabled="true" x="20" y="80" width="350" height="44"/>
    <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="result_title" label="王者荣耀" value="王者荣耀" visible="true" enabled="true" x="20" y="150" width="200" height="40"/>
  </XCUIElementTypeWindow>
</XCUIElementTypeApplication>`;

class FakeAdapter implements DeviceReplayRuntimeAdapter {
  sourceValue = homeSource;
  actions: string[] = [];
  tapFailures = 0;

  getStatus() {
    return {
      phase: 'connected',
      device: { udid: 'fake-udid', name: 'Fake iPhone', osVersion: '18.0' },
      windowSize: { width: 390, height: 844 },
    };
  }

  async source() {
    return this.sourceValue;
  }

  async screenshot() {
    return Buffer.from(`png:${this.sourceValue.length}`);
  }

  async tap(x: number, y: number) {
    this.actions.push(`tap:${x},${y}`);
    if (this.tapFailures > 0) {
      this.tapFailures -= 1;
      throw new Error('模拟点击失败');
    }
  }

  async swipe(startX: number, startY: number, endX: number, endY: number) {
    this.actions.push(`swipe:${startX},${startY},${endX},${endY}`);
  }

  async input(text: string) {
    this.actions.push(`input:${text}`);
    this.sourceValue = resultSource;
  }

  async keyboard(key: 'Search' | 'Return' | 'Done' | 'Dismiss') {
    this.actions.push(`keyboard:${key}`);
  }

  async snapshotSource() {
    return resultSource;
  }
}

function successFlow(): DeviceReplayFlowDsl {
  return {
    schemaVersion: '1.0',
    id: 'execute-search',
    name: '执行搜索流程',
    inputs: {
      keyword: { type: 'string', required: true },
      fieldLabel: { type: 'string', required: true },
    },
    nodes: [
      { id: 'start', type: 'start', next: 'input' },
      {
        id: 'input',
        type: 'input',
        target: { accessibilityId: 'community_search', label: '${fieldLabel}', coordinate: { x: 0.5, y: 0.12 } },
        value: '${keyword}',
        next: 'wait_result',
        onFailure: 'failed',
      },
      {
        id: 'wait_result',
        type: 'wait',
        timeoutMs: 1000,
        condition: { kind: 'element', operator: 'visible', target: { label: '王者荣耀' } },
        onSuccess: 'check_text',
        onTimeout: 'failed',
      },
      {
        id: 'check_text',
        type: 'condition',
        condition: { kind: 'text', operator: 'equals', target: { accessibilityId: 'result_title' }, value: '王者荣耀' },
        onTrue: 'assert_keyboard',
        onFalse: 'failed',
      },
      {
        id: 'assert_keyboard',
        type: 'assertion',
        condition: { kind: 'keyboard', operator: 'hidden' },
        onPassed: 'success',
        onFailed: 'failed',
      },
      { id: 'success', type: 'end', result: 'success' },
      { id: 'failed', type: 'end', result: 'failure' },
    ],
  };
}

describe('DeviceReplayFlowExecutionService', () => {
  let rootDirectory: string;

  beforeEach(() => {
    rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'device-replay-flow-test-'));
  });

  afterEach(() => {
    fs.rmSync(rootDirectory, { recursive: true, force: true });
  });

  test('按状态执行 Input、Wait、Condition 和 Assertion，并保留节点证据', async () => {
    const adapter = new FakeAdapter();
    const service = new DeviceReplayFlowExecutionService(adapter, rootDirectory);
    const started = service.start(successFlow(), { keyword: '王者', fieldLabel: '搜索社区' }, 'tester', false);
    const run = await service.waitForCompletion(started.id);

    expect(run.status).toBe('succeeded');
    expect(run.result).toBe('success');
    expect(adapter.actions).toEqual(expect.arrayContaining(['input:王者']));
    expect(adapter.actions.some((action) => action.startsWith('tap:195,'))).toBe(true);
    expect(run.nodes.map((node) => `${node.nodeId}:${node.outcome}`)).toEqual([
      'start:next',
      'input:success',
      'wait_result:success',
      'check_text:true',
      'assert_keyboard:passed',
      'success:success',
    ]);
    expect(run.nodes.find((node) => node.nodeId === 'input')?.locator?.strategy).toBe('semantic');
    expect(run.nodes.find((node) => node.nodeId === 'wait_result')?.evidence).toHaveLength(2);
    expect(fs.readFileSync(path.join(rootDirectory, run.id, 'run.json'), 'utf8')).not.toContain('"王者"');

    const reloadedService = new DeviceReplayFlowExecutionService(adapter, rootDirectory);
    const reloaded = reloadedService.getRun(run.id, 'tester', false);
    const evidence = reloaded.nodes.find((node) => node.nodeId === 'input')!.evidence[0];
    expect(reloaded.status).toBe('succeeded');
    expect(fs.existsSync(reloadedService.evidenceFile(run.id, evidence.id, 'source', 'tester', false))).toBe(true);
  });

  test('动作失败后按有限策略重试', async () => {
    const adapter = new FakeAdapter();
    adapter.tapFailures = 1;
    const service = new DeviceReplayFlowExecutionService(adapter, rootDirectory);
    const flow: DeviceReplayFlowDsl = {
      schemaVersion: '1.0',
      id: 'retry-tap',
      name: '重试点击',
      nodes: [
        { id: 'start', type: 'start', next: 'tap' },
        {
          id: 'tap', type: 'tap', target: { coordinate: { x: 0.5, y: 0.5 } }, next: 'success', onFailure: 'failed',
          retry: { maxAttempts: 2, intervalMs: 0, backoff: 'fixed' },
        },
        { id: 'success', type: 'end', result: 'success' },
        { id: 'failed', type: 'end', result: 'failure' },
      ],
    };

    const started = service.start(flow, {}, 'tester', false);
    const run = await service.waitForCompletion(started.id);

    expect(run.status).toBe('succeeded');
    expect(run.nodes.find((node) => node.nodeId === 'tap')).toMatchObject({
      attempts: 2, status: 'succeeded', outcome: 'success', error: undefined, errorCode: undefined,
    });
    expect(adapter.actions.filter((action) => action.startsWith('tap:'))).toHaveLength(2);
  });

  test('执行归一化 Swipe 和键盘白名单指令', async () => {
    const adapter = new FakeAdapter();
    const service = new DeviceReplayFlowExecutionService(adapter, rootDirectory);
    const flow: DeviceReplayFlowDsl = {
      schemaVersion: '1.0',
      id: 'swipe-keyboard',
      name: '滑动并搜索',
      nodes: [
        { id: 'start', type: 'start', next: 'swipe' },
        {
          id: 'swipe', type: 'swipe', start: { x: 0.1, y: 0.8 }, end: { x: 0.9, y: 0.2 },
          durationMs: 400, next: 'search', onFailure: 'failed',
        },
        { id: 'search', type: 'keyboard', key: 'Search', next: 'success', onFailure: 'failed' },
        { id: 'success', type: 'end', result: 'success' },
        { id: 'failed', type: 'end', result: 'failure' },
      ],
    };

    const started = service.start(flow, {}, 'tester', false);
    const run = await service.waitForCompletion(started.id);

    expect(run.status).toBe('succeeded');
    expect(adapter.actions).toContain('swipe:39,675,351,169');
    expect(adapter.actions).toContain('keyboard:Search');
    expect(run.nodes.find((node) => node.nodeId === 'swipe')?.swipe).toMatchObject({
      recordedStart: { x: 0.1, y: 0.8 },
      recordedEnd: { x: 0.9, y: 0.2 },
      resolvedStart: { x: 39, y: 675 },
      resolvedEnd: { x: 351, y: 169 },
      durationMs: 400,
    });
  });

  test('等待超时时进入 onTimeout 失败分支', async () => {
    const adapter = new FakeAdapter();
    const service = new DeviceReplayFlowExecutionService(adapter, rootDirectory);
    const flow: DeviceReplayFlowDsl = {
      schemaVersion: '1.0',
      id: 'wait-timeout',
      name: '等待超时',
      nodes: [
        { id: 'start', type: 'start', next: 'wait' },
        {
          id: 'wait', type: 'wait', timeoutMs: 120,
          condition: { kind: 'element', operator: 'exists', target: { label: '不会出现' } },
          onSuccess: 'success', onTimeout: 'failed',
        },
        { id: 'success', type: 'end', result: 'success' },
        { id: 'failed', type: 'end', result: 'failure', message: '搜索结果未出现' },
      ],
    };

    const started = service.start(flow, {}, 'tester', false);
    const run = await service.waitForCompletion(started.id);

    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('FLOW_FAILURE_END');
    expect(run.nodes.find((node) => node.nodeId === 'wait')).toMatchObject({
      status: 'failed', outcome: 'timeout', errorCode: 'NODE_TIMEOUT', nextNodeId: 'failed',
    });
  });

  test('支持人工终止正在等待的流程', async () => {
    const adapter = new FakeAdapter();
    const service = new DeviceReplayFlowExecutionService(adapter, rootDirectory);
    const flow: DeviceReplayFlowDsl = {
      schemaVersion: '1.0',
      id: 'cancel-delay',
      name: '终止回放',
      nodes: [
        { id: 'start', type: 'start', next: 'delay' },
        {
          id: 'delay', type: 'wait', timeoutMs: 2000,
          condition: { kind: 'delay', durationMs: 1000 },
          onSuccess: 'success', onTimeout: 'failed',
        },
        { id: 'success', type: 'end', result: 'success' },
        { id: 'failed', type: 'end', result: 'failure' },
      ],
    };

    const started = service.start(flow, {}, 'tester', false);
    service.stop(started.id, 'tester', false);
    const run = await service.waitForCompletion(started.id);

    expect(run.status).toBe('cancelled');
    expect(run.errorCode).toBe('RUN_CANCELLED');
    expect(run.stopRequestedAt).toBeTruthy();
  });
});
