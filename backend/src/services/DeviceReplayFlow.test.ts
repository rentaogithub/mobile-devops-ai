import {
  compileDeviceReplayFlow,
  DEVICE_REPLAY_FLOW_JSON_SCHEMA,
  DeviceReplayFlowDsl,
  replayFlowTemplateFromRecording,
  validateDeviceReplayFlow,
} from './DeviceReplayFlow';
import { DeviceRecording } from './DeviceRecordingService';

function validFlow(): DeviceReplayFlowDsl {
  return {
    schemaVersion: '1.0',
    id: 'search-community',
    name: '搜索社区',
    inputs: { keyword: { type: 'string', required: true } },
    nodes: [
      { id: 'start', type: 'start', next: 'input_keyword' },
      {
        id: 'input_keyword',
        type: 'input',
        value: '${keyword}',
        target: { label: '搜索社区、用户名称/ID' },
        next: 'wait_result',
        onFailure: 'failed',
      },
      {
        id: 'wait_result',
        type: 'wait',
        condition: { kind: 'element', operator: 'exists', target: { text: '王者荣耀' } },
        onSuccess: 'success',
        onTimeout: 'failed',
      },
      { id: 'success', type: 'end', result: 'success' },
      { id: 'failed', type: 'end', result: 'failure' },
    ],
  };
}

describe('DeviceReplayFlow DSL v1', () => {
  test('导出低代码编辑器可用的完整 JSON Schema', () => {
    const schema = DEVICE_REPLAY_FLOW_JSON_SCHEMA;
    const nodeRefs = schema.properties.nodes.items.oneOf.map((item) => item.$ref);

    expect(schema.$defs.condition.oneOf).toHaveLength(10);
    expect(schema.$defs.condition.oneOf[0].properties.all.items.$ref).toBe('#/$defs/condition');
    expect(nodeRefs).toEqual(expect.arrayContaining([
      '#/$defs/tapNode', '#/$defs/inputNode', '#/$defs/waitNode',
    ]));
    expect(schema.$defs.tapNode.properties.type.const).toBe('tap');
    expect(schema.$defs.inputNode.properties.value.type).toBe('string');
    expect(schema.$defs.waitNode.properties.condition.$ref).toBe('#/$defs/condition');
    expect(schema.$defs.condition.oneOf.some((condition) => (
      (condition as any).properties?.kind?.const === 'delay'
    ))).toBe(true);
  });

  test('校验并编译有效的条件回放流程', () => {
    const flow = validFlow();
    const validation = validateDeviceReplayFlow(flow);
    const compiled = compileDeviceReplayFlow(flow);

    expect(validation).toEqual({ valid: true, errors: [], warnings: [] });
    expect(compiled.entryNodeId).toBe('start');
    expect(compiled.nodes.wait_result.edges).toEqual([
      { outcome: 'success', to: 'success' },
      { outcome: 'timeout', to: 'failed' },
    ]);
    expect(compiled.order).toEqual(['start', 'input_keyword', 'wait_result', 'success', 'failed']);
  });

  test('拒绝自由环路、缺失跳转和未声明变量', () => {
    const flow = validFlow() as any;
    flow.nodes[0].next = 'input_keyword';
    flow.nodes[1].next = 'input_keyword';
    flow.nodes[1].value = '${missing}';
    delete flow.nodes[2].onTimeout;

    const validation = validateDeviceReplayFlow(flow);

    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
      'FREE_CYCLE', 'EDGE_REQUIRED', 'UNDECLARED_VARIABLE',
    ]));
  });

  test('纯坐标目标可编译但会给出不稳定警告', () => {
    const flow = validFlow();
    const input = flow.nodes.find((node) => node.id === 'input_keyword') as any;
    input.target = { coordinate: { x: 0.5, y: 0.2 } };

    const validation = validateDeviceReplayFlow(flow);

    expect(validation.valid).toBe(true);
    expect(validation.warnings.map((warning) => warning.code)).toContain('COORDINATE_ONLY_TARGET');
  });

  test('支持受控固定等待，并拒绝非法操作符和策略参数', () => {
    const delayFlow = validFlow();
    const delayWait = delayFlow.nodes.find((node) => node.id === 'wait_result') as any;
    delayWait.condition = { kind: 'delay', durationMs: 500 };
    expect(validateDeviceReplayFlow(delayFlow).valid).toBe(true);

    const invalidFlow = validFlow() as any;
    const input = invalidFlow.nodes.find((node: any) => node.id === 'input_keyword');
    const wait = invalidFlow.nodes.find((node: any) => node.id === 'wait_result');
    input.retry = { maxAttempts: 2, intervalMs: 70000, backoff: 'exponential' };
    wait.condition = {
      kind: 'element',
      operator: 'clickable',
      target: { coordinate: { x: '0.5', y: 0.2 } },
    };

    const validation = validateDeviceReplayFlow(invalidFlow);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
      'RETRY_INTERVAL_RANGE', 'RETRY_BACKOFF', 'CONDITION_OPERATOR', 'COORDINATE_REQUIRED',
    ]));
  });

  test('将旧录制升级为可校验的线性 DSL，并合并连续重复输入', () => {
    const target = {
      type: 'XCUIElementTypeTextField',
      placeholder: '搜索',
      rect: { x: 20, y: 50, width: 200, height: 40 },
      relativePoint: { x: 0.5, y: 0.5 },
      depth: 5,
      locators: [{ strategy: 'predicate' as const, value: "placeholderValue == '搜索'", score: 84 }],
    };
    const recording: DeviceRecording = {
      id: 'recording-id',
      projectId: 'nn-ios',
      title: '搜索路径',
      owner: 'admin',
      status: 'stopped',
      createdAt: '2026-08-18T00:00:00.000Z',
      steps: [
        {
          id: 'tap-step', index: 1, origin: 'annotated', status: 'ready', included: true, noiseLikely: false,
          summary: '点击搜索', createdAt: '2026-08-18T00:00:01.000Z',
          action: { type: 'tap', params: { x: 100, y: 70 }, normalizedPoint: { x: 0.25, y: 0.08 }, target },
          beforeSnapshot: { id: 's0', createdAt: '', screenshotUrl: '', sourceUrl: '', screenshotBytes: 1, sourceBytes: 1, screenshotHash: '', sourceHash: '' },
          afterSnapshot: { id: 's1', createdAt: '', screenshotUrl: '', sourceUrl: '', screenshotBytes: 1, sourceBytes: 1, screenshotHash: '', sourceHash: '' },
        },
        {
          id: 'input-step', index: 2, origin: 'annotated', status: 'ready', included: true, noiseLikely: false,
          summary: '输入', createdAt: '2026-08-18T00:00:02.000Z',
          action: { type: 'input', params: { value: '${INPUT}' }, target },
          beforeSnapshot: { id: 's1', createdAt: '', screenshotUrl: '', sourceUrl: '', screenshotBytes: 1, sourceBytes: 1, screenshotHash: '', sourceHash: '' },
          afterSnapshot: { id: 's2', createdAt: '', screenshotUrl: '', sourceUrl: '', screenshotBytes: 1, sourceBytes: 1, screenshotHash: '', sourceHash: '' },
        },
        {
          id: 'duplicate-input', index: 3, origin: 'annotated', status: 'ready', included: true, noiseLikely: false,
          summary: '重复输入', createdAt: '2026-08-18T00:00:03.000Z',
          action: { type: 'input', params: { value: '${INPUT}' }, target },
          beforeSnapshot: { id: 's2', createdAt: '', screenshotUrl: '', sourceUrl: '', screenshotBytes: 1, sourceBytes: 1, screenshotHash: '', sourceHash: '' },
          afterSnapshot: { id: 's3', createdAt: '', screenshotUrl: '', sourceUrl: '', screenshotBytes: 1, sourceBytes: 1, screenshotHash: '', sourceHash: '' },
        },
      ],
      observations: [], selectedCount: 3, candidateSelectedCount: 0,
    };

    const template = replayFlowTemplateFromRecording(recording);
    const validation = validateDeviceReplayFlow(template);

    expect(validation.valid).toBe(true);
    expect(template.nodes.filter((node) => node.type === 'input')).toHaveLength(1);
    expect(template.nodes.map((node) => node.id)).toContain('failure_end');
    expect(template.inputs?.INPUT.required).toBe(true);
  });

  test('输入后的语义点击不被整页快照相似度拦截', () => {
    const inputTarget = {
      type: 'XCUIElementTypeTextField',
      placeholder: '搜索社区、用户名称/ID',
      rect: { x: 80, y: 68, width: 238, height: 36 },
      relativePoint: { x: 0.5, y: 0.5 },
      depth: 11,
      locators: [{ strategy: 'predicate' as const, value: "type == 'XCUIElementTypeTextField'", score: 84 }],
    };
    const searchTarget = {
      type: 'XCUIElementTypeStaticText',
      name: '搜索',
      label: '搜索',
      value: '搜索',
      rect: { x: 358, y: 76, width: 28, height: 20 },
      relativePoint: { x: 0.5, y: 0.5 },
      depth: 11,
      locators: [{ strategy: 'predicate' as const, value: "type == 'XCUIElementTypeStaticText' AND name == '搜索'", score: 84 }],
    };
    const snapshot = (id: string) => ({
      id, createdAt: '', screenshotUrl: '', sourceUrl: '', screenshotBytes: 1, sourceBytes: 1, screenshotHash: '', sourceHash: '',
    });
    const recording: DeviceRecording = {
      id: 'search-recording',
      projectId: 'nn-ios',
      title: '社区搜索',
      owner: 'admin',
      status: 'stopped',
      createdAt: '2026-09-01T00:00:00.000Z',
      steps: [
        {
          id: 'input-step', index: 1, origin: 'annotated', status: 'ready', included: true, noiseLikely: false,
          summary: '输入搜索内容', createdAt: '2026-09-01T00:00:01.000Z',
          action: { type: 'input', params: { value: '${INPUT}' }, target: inputTarget },
          beforeSnapshot: snapshot('before-input'), afterSnapshot: snapshot('after-input'),
        },
        {
          id: 'search-tap', index: 2, origin: 'annotated', status: 'ready', included: true, noiseLikely: false,
          summary: '点击右上角搜索', createdAt: '2026-09-01T00:00:02.000Z',
          action: { type: 'tap', params: { x: 371, y: 84 }, normalizedPoint: { x: 0.922886, y: 0.09611 }, target: searchTarget },
          beforeSnapshot: snapshot('after-input'), afterSnapshot: snapshot('search-results'),
        },
      ],
      observations: [], selectedCount: 2, candidateSelectedCount: 0,
    };

    const template = replayFlowTemplateFromRecording(recording);
    const inputNode = template.nodes.find((node) => node.type === 'input');
    const searchNode = template.nodes.find((node) => node.type === 'tap');

    expect(inputNode?.precondition).toEqual({
      kind: 'element', operator: 'enabled',
      target: expect.objectContaining({ type: 'XCUIElementTypeTextField', placeholder: '搜索社区、用户名称/ID' }),
    });
    expect(searchNode?.precondition).toEqual({
      kind: 'element', operator: 'enabled',
      target: expect.objectContaining({ type: 'XCUIElementTypeStaticText', name: '搜索', label: '搜索' }),
    });
    expect(validateDeviceReplayFlow(template).valid).toBe(true);
  });

  test('搜索提交与结果点击之间自动生成 15 秒可编辑等待节点', () => {
    const snapshot = (id: string) => ({
      id, createdAt: '', screenshotUrl: '', sourceUrl: '', screenshotBytes: 1, sourceBytes: 1, screenshotHash: '', sourceHash: '',
    });
    const searchTarget = {
      type: 'XCUIElementTypeStaticText', name: '搜索', label: '搜索', value: '搜索',
      rect: { x: 358, y: 76, width: 28, height: 20 }, relativePoint: { x: 0.5, y: 0.5 }, depth: 11,
      locators: [{ strategy: 'predicate' as const, value: "name == '搜索'", score: 84 }],
    };
    const resultTarget = {
      type: 'XCUIElementTypeStaticText', name: '英雄联盟', label: '英雄联盟', value: '英雄联盟',
      rect: { x: 160, y: 350, width: 100, height: 30 }, relativePoint: { x: 0.5, y: 0.5 }, depth: 10,
      locators: [{ strategy: 'predicate' as const, value: "name == '英雄联盟'", score: 84 }],
    };
    const recording: DeviceRecording = {
      id: 'search-with-result', projectId: 'nn-ios', title: '搜索并进入社区', owner: 'admin', status: 'stopped', createdAt: '',
      observations: [], selectedCount: 2, candidateSelectedCount: 0,
      steps: [
        {
          id: 'search-tap', index: 1, origin: 'annotated', status: 'ready', included: true, noiseLikely: false,
          summary: '点击搜索', createdAt: '', action: { type: 'tap', params: { x: 371, y: 84 }, normalizedPoint: { x: 0.92, y: 0.1 }, target: searchTarget },
          beforeSnapshot: snapshot('typed'), afterSnapshot: snapshot('results'),
        },
        {
          id: 'result-tap', index: 2, origin: 'annotated', status: 'ready', included: true, noiseLikely: false,
          summary: '点击英雄联盟', createdAt: '', action: { type: 'tap', params: { x: 200, y: 365 }, normalizedPoint: { x: 0.5, y: 0.42 }, target: resultTarget },
          beforeSnapshot: snapshot('results'), afterSnapshot: snapshot('community'),
        },
      ],
    };

    const template = replayFlowTemplateFromRecording(recording);
    const wait = template.nodes.find((node) => node.type === 'wait');
    const search = template.nodes.find((node) => node.type === 'tap' && node.name === '点击搜索');
    const result = template.nodes.find((node) => node.type === 'tap' && node.name === '点击英雄联盟');

    expect(wait).toMatchObject({
      timeoutMs: 15000,
      condition: { kind: 'element', operator: 'exists', target: expect.objectContaining({ name: '英雄联盟' }) },
      onSuccess: result?.id,
      onTimeout: 'failure_end',
    });
    expect((search as any)?.next).toBe(wait?.id);
    expect(validateDeviceReplayFlow(template).valid).toBe(true);
  });
});
