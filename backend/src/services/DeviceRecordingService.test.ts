import {
  compactReplayInputSteps,
  recordingObservationSuggestion,
  replayActionPreconditionStatus,
  replayPreconditionStatus,
} from './DeviceRecordingService';

function source(...labels: string[]) {
  return `<App>${labels.map((label) => `<XCUIElementTypeStaticText label="${label}"/>`).join('')}</App>`;
}

describe('replayPreconditionStatus', () => {
  const expected = source('搜索社区、用户名称/ID', '社区 A', '成员 100', '在线 20');
  const dynamicPage = source('搜索社区、用户名称/ID', '社区 A');

  test('首个回放步骤在目标存在时允许较低的动态页面匹配度', () => {
    expect(replayPreconditionStatus(expected, dynamicPage, '搜索社区、用户名称/ID', true, 0.72, 0.4)).toEqual({
      score: 0.5,
      targetReady: true,
      requiredThreshold: 0.4,
      ready: true,
    });
  });

  test('首个回放步骤不会在错误页面上仅凭相似度开始', () => {
    const wrongPage = source('社区 A', '成员 100', '在线 20');
    const status = replayPreconditionStatus(expected, wrongPage, '搜索社区、用户名称/ID', true, 0.72, 0.4);
    expect(status.targetReady).toBe(false);
    expect(status.ready).toBe(false);
  });

  test('后续步骤仍按严格阈值等待网络页面就绪', () => {
    const status = replayPreconditionStatus(expected, dynamicPage, '搜索社区、用户名称/ID', false, 0.72, 0.4);
    expect(status.requiredThreshold).toBe(0.72);
    expect(status.ready).toBe(false);
  });

  test('后续步骤只有目标和页面匹配度同时满足才继续', () => {
    const status = replayPreconditionStatus(expected, expected, '搜索社区、用户名称/ID', false, 0.72, 0.4);
    expect(status.ready).toBe(true);
  });
});

describe('compactReplayInputSteps', () => {
  const inputStep = (id: string, beforeSnapshotId: string, afterSnapshotId: string) => ({
    id,
    index: Number(id),
    origin: 'annotated' as const,
    status: 'ready' as const,
    included: true,
    noiseLikely: false,
    summary: `input ${id}`,
    createdAt: `2026-08-17T11:18:5${id}.000Z`,
    action: {
      type: 'input',
      params: { value: '${INPUT}' },
      target: { type: 'XCUIElementTypeTextField', placeholder: '搜索社区、用户名称/ID' },
    },
    beforeSnapshotId,
    afterSnapshotId,
  });

  test('合并同一输入框且证据首尾相接的重复补标输入', () => {
    const first = inputStep('1', 'before', 'typed');
    const duplicate = inputStep('2', 'typed', 'results');
    const plan = compactReplayInputSteps([first, duplicate]);
    expect(plan.executable.map((step) => step.id)).toEqual(['1']);
    expect(plan.skipped.map((step) => step.id)).toEqual(['2']);
  });

  test('不合并证据不连续的两次输入', () => {
    const plan = compactReplayInputSteps([
      inputStep('1', 'before-a', 'after-a'),
      inputStep('2', 'before-b', 'after-b'),
    ]);
    expect(plan.executable).toHaveLength(2);
    expect(plan.skipped).toHaveLength(0);
  });

  test('输入法产生两段输入证据时保留后续搜索与结果点击', () => {
    const searchTap = {
      id: '3',
      index: 3,
      origin: 'annotated' as const,
      status: 'ready' as const,
      included: true,
      noiseLikely: false,
      summary: '点击搜索',
      createdAt: '2026-09-03T00:00:03.000Z',
      action: { type: 'tap', params: { x: 371, y: 84 }, target: { name: '搜索' } },
      beforeSnapshotId: 'committed',
      afterSnapshotId: 'results',
    };
    const resultTap = {
      ...searchTap,
      id: '4',
      index: 4,
      summary: '点击搜索结果',
      action: { type: 'tap', params: { x: 180, y: 400 }, target: { name: '王者荣耀' } },
      beforeSnapshotId: 'results',
      afterSnapshotId: 'community',
    };
    const plan = compactReplayInputSteps([
      inputStep('1', 'search-page', 'composing'),
      inputStep('2', 'composing', 'committed'),
      searchTap,
      resultTap,
    ]);

    expect(plan.executable.map((step) => step.action.type)).toEqual(['input', 'tap', 'tap']);
    expect(plan.executable.map((step) => step.id)).toEqual(['1', '3', '4']);
    expect(plan.skipped.map((step) => step.id)).toEqual(['2']);
  });
});

describe('replayActionPreconditionStatus', () => {
  const searchAction = {
    type: 'tap',
    params: { x: 371, y: 84 },
    screenSize: { width: 402, height: 874 },
    normalizedPoint: { x: 0.922886, y: 0.09611 },
    target: {
      type: 'XCUIElementTypeStaticText',
      name: '搜索',
      label: '搜索',
      value: '搜索',
      rect: { x: 358, y: 76, width: 28, height: 20 },
      relativePoint: { x: 0.5, y: 0.5 },
      depth: 11,
      locators: [{ strategy: 'predicate' as const, value: "type == 'XCUIElementTypeStaticText' AND name == '搜索'", score: 84 }],
    },
  };

  test('输入法联想导致整页 Source 改变时，只要搜索按钮可用就继续回放', () => {
    const expected = '<XCUIElementTypeApplication width="402" height="874"><XCUIElementTypeKeyboard/><XCUIElementTypeStaticText name="搜索" label="搜索" value="搜索" x="358" y="76" width="28" height="20" visible="true" enabled="true"/></XCUIElementTypeApplication>';
    const withDifferentCandidates = '<XCUIElementTypeApplication width="402" height="874"><XCUIElementTypeKeyboard/><XCUIElementTypeButton label="王者" x="10" y="600" width="60" height="30"/><XCUIElementTypeStaticText name="搜索" label="搜索" value="搜索" x="358" y="76" width="28" height="20" visible="true" enabled="true"/></XCUIElementTypeApplication>';
    const status = replayActionPreconditionStatus(expected, withDifferentCandidates, searchAction, false, 0.72, 0.4);

    expect(status.strategy).toBe('semantic-target');
    expect(status.targetReady).toBe(true);
    expect(status.ready).toBe(true);
  });

  test('语义目标尚未出现时不会因页面相似而提前点击', () => {
    const expected = '<XCUIElementTypeApplication width="402" height="874"><XCUIElementTypeStaticText name="搜索" label="搜索" x="358" y="76" width="28" height="20"/></XCUIElementTypeApplication>';
    const loading = '<XCUIElementTypeApplication width="402" height="874"><XCUIElementTypeStaticText name="加载中" label="加载中" x="150" y="300" width="80" height="20"/></XCUIElementTypeApplication>';
    const status = replayActionPreconditionStatus(expected, loading, searchAction, false, 0.72, 0.4);

    expect(status.strategy).toBe('semantic-target');
    expect(status.targetReady).toBe(false);
    expect(status.ready).toBe(false);
  });
});

describe('recordingObservationSuggestion', () => {
  test('键盘保持显示且输入框内容变化时识别为同一个 Input 会话', () => {
    const before = '<XCUIElementTypeApplication><XCUIElementTypeTextField placeholderValue="搜索" value="ying"/><XCUIElementTypeKeyboard/></XCUIElementTypeApplication>';
    const after = '<XCUIElementTypeApplication><XCUIElementTypeTextField placeholderValue="搜索" value="ying xin"/><XCUIElementTypeKeyboard/></XCUIElementTypeApplication>';

    expect(recordingObservationSuggestion(before, after, { addedCount: 2, removedCount: 1 }).action).toBe('input');
  });

  test('键盘收起并出现结果时识别为提交点击', () => {
    const before = '<XCUIElementTypeApplication><XCUIElementTypeTextField placeholderValue="搜索" value="英雄联盟"/><XCUIElementTypeKeyboard/></XCUIElementTypeApplication>';
    const after = '<XCUIElementTypeApplication><XCUIElementTypeStaticText label="英雄联盟"/></XCUIElementTypeApplication>';

    expect(recordingObservationSuggestion(before, after, { addedCount: 4, removedCount: 3 })).toMatchObject({ action: 'tap' });
  });

  test('没有标签增删的 Source 抖动自动忽略', () => {
    expect(recordingObservationSuggestion('<App focused="true"/>', '<App focused="false"/>', { addedCount: 0, removedCount: 0 }).action).toBe('ignore');
  });
});
