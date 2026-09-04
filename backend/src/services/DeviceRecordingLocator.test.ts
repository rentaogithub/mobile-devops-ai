import { enrichRecordingAction, resolveReplayTapPoint, screenSizeFromSource, targetAtPoint } from './DeviceRecordingLocator';

const source = `<?xml version="1.0" encoding="UTF-8"?>
<XCUIElementTypeApplication type="XCUIElementTypeApplication" x="0" y="0" width="402" height="874" visible="true" enabled="true">
  <XCUIElementTypeWindow type="XCUIElementTypeWindow" x="0" y="0" width="402" height="874" visible="true" enabled="true">
    <XCUIElementTypeOther type="XCUIElementTypeOther" x="0" y="0" width="402" height="874" visible="true" enabled="true">
      <XCUIElementTypeButton type="XCUIElementTypeButton" name="community.switch.button" label="切换社区" x="300" y="60" width="90" height="44" visible="true" enabled="true" hittable="true" />
      <XCUIElementTypeTable type="XCUIElementTypeTable" name="community.list" x="0" y="120" width="402" height="700" visible="true" enabled="true" hittable="true" />
    </XCUIElementTypeOther>
  </XCUIElementTypeWindow>
</XCUIElementTypeApplication>`;

describe('DeviceRecordingLocator', () => {
  test('reads the logical screen size from WDA source', () => {
    expect(screenSizeFromSource(source)).toEqual({ width: 402, height: 874 });
  });

  test('uses the smallest actionable WDA node and stores relative coordinates', () => {
    const target = targetAtPoint(source, { x: 345, y: 82 }, { width: 402, height: 874 });

    expect(target?.type).toBe('XCUIElementTypeButton');
    expect(target?.name).toBe('community.switch.button');
    expect(target?.relativePoint).toEqual({ x: 0.5, y: 0.5 });
    expect(target?.locators[0]).toEqual({
      strategy: 'accessibilityId',
      value: 'community.switch.button',
      score: 92,
    });
  });

  test('enriches both swipe endpoints without changing raw parameters', () => {
    const action = enrichRecordingAction({
      type: 'swipe',
      params: {
        start: { x: 200, y: 700 },
        end: { x: 200, y: 200 },
        durationMs: 420,
      },
    }, source, { width: 402, height: 874 });

    expect(action.params.durationMs).toBe(420);
    expect(action.normalizedStart).toEqual({ x: 0.497512, y: 0.800915 });
    expect(action.normalizedEnd).toEqual({ x: 0.497512, y: 0.228833 });
    expect(action.startTarget?.type).toBe('XCUIElementTypeTable');
    expect(action.endTarget?.type).toBe('XCUIElementTypeTable');
  });

  test('prefers a named accessible active-page container over an overlapping stale button', () => {
    const overlappingSource = `<?xml version="1.0" encoding="UTF-8"?>
<XCUIElementTypeApplication type="XCUIElementTypeApplication" x="0" y="0" width="402" height="874" visible="true" enabled="true">
  <XCUIElementTypeWindow type="XCUIElementTypeWindow" x="0" y="0" width="402" height="874" visible="true" enabled="true">
    <XCUIElementTypeWebView type="XCUIElementTypeWebView" x="0" y="0" width="402" height="874" visible="true" enabled="true">
      <XCUIElementTypeButton type="XCUIElementTypeButton" name="任务中心" label="任务中心" x="108" y="62" width="119" height="48" visible="true" enabled="true" accessible="true" />
    </XCUIElementTypeWebView>
    <XCUIElementTypeTable type="XCUIElementTypeTable" x="0" y="0" width="402" height="874" visible="true" enabled="true">
      <XCUIElementTypeOther type="XCUIElementTypeOther" name="搜索社区、用户名称/ID" label="搜索社区、用户名称/ID" x="56" y="87" width="262" height="20" visible="true" enabled="true" accessible="true" />
    </XCUIElementTypeTable>
  </XCUIElementTypeWindow>
</XCUIElementTypeApplication>`;

    const target = targetAtPoint(overlappingSource, { x: 192, y: 95 }, { width: 402, height: 874 });

    expect(target?.type).toBe('XCUIElementTypeOther');
    expect(target?.name).toBe('搜索社区、用户名称/ID');
    expect(target?.locators[0]).toEqual({
      strategy: 'predicate',
      value: "type == 'XCUIElementTypeOther' AND name == '搜索社区、用户名称/ID'",
      score: 84,
    });
  });

  test('attaches the single visible input field to a parameterized input action', () => {
    const inputSource = `<?xml version="1.0" encoding="UTF-8"?>
<XCUIElementTypeApplication type="XCUIElementTypeApplication" x="0" y="0" width="402" height="874" visible="true" enabled="true">
  <XCUIElementTypeTextField type="XCUIElementTypeTextField" value="搜索社区、用户名称/ID" label="" enabled="true" visible="true" accessible="true" x="80" y="68" width="238" height="36" placeholderValue="搜索社区、用户名称/ID" />
</XCUIElementTypeApplication>`;

    const action = enrichRecordingAction({
      type: 'input',
      params: { value: '${INPUT}', length: 8 },
    }, inputSource, { width: 402, height: 874 });

    expect(action.target?.type).toBe('XCUIElementTypeTextField');
    expect(action.target?.placeholder).toBe('搜索社区、用户名称/ID');
    expect(action.target?.relativePoint).toEqual({ x: 0.5, y: 0.5 });
    expect(action.target?.locators[0]).toEqual({
      strategy: 'predicate',
      value: "type == 'XCUIElementTypeTextField' AND placeholderValue == '搜索社区、用户名称/ID'",
      score: 84,
    });
  });

  test('回放点击同时使用目标文本和录制坐标，不会从取消偏到扬声器', () => {
    const toolbarSource = `<?xml version="1.0" encoding="UTF-8"?>
<XCUIElementTypeApplication type="XCUIElementTypeApplication" x="0" y="0" width="402" height="874" visible="true" enabled="true">
  <XCUIElementTypeCell type="XCUIElementTypeCell" x="248" y="744" width="63" height="80" visible="true" enabled="true">
    <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="扬声器关" label="扬声器关" value="扬声器关" x="255" y="807" width="49" height="17" visible="true" enabled="true" accessible="true" />
  </XCUIElementTypeCell>
  <XCUIElementTypeCell type="XCUIElementTypeCell" x="326" y="744" width="64" height="80" visible="true" enabled="true">
    <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="取消" label="取消" value="取消" x="346" y="807" width="24" height="17" visible="true" enabled="true" accessible="true" />
  </XCUIElementTypeCell>
</XCUIElementTypeApplication>`;
    const recorded = enrichRecordingAction({ type: 'tap', params: { x: 358, y: 815 } }, toolbarSource, { width: 402, height: 874 });
    expect(recorded.target?.contextLabels).toContain('取消');
    // 即使坐标降级值因旧版留白换算问题偏到了扬声器，已录制的“取消”语义仍能校正点击。
    recorded.params = { x: 261, y: 775 };
    recorded.normalizedPoint = { x: 261 / 402, y: 775 / 874 };

    const resolved = resolveReplayTapPoint(recorded, toolbarSource, { width: 402, height: 874 });

    expect(resolved?.strategy).toBe('semantic');
    expect(resolved?.matchedTarget?.name).toBe('取消');
    expect(resolved?.point.x).toBeGreaterThanOrEqual(346);
    expect(resolved?.point.x).toBeLessThanOrEqual(370);
  });

  test('同名目标存在多个时用录制坐标选择最近的一个', () => {
    const duplicateSource = `<?xml version="1.0" encoding="UTF-8"?>
<XCUIElementTypeApplication type="XCUIElementTypeApplication" x="0" y="0" width="402" height="874" visible="true" enabled="true">
  <XCUIElementTypeButton type="XCUIElementTypeButton" name="取消" label="取消" x="20" y="60" width="50" height="40" visible="true" enabled="true" />
  <XCUIElementTypeButton type="XCUIElementTypeButton" name="取消" label="取消" x="326" y="744" width="64" height="80" visible="true" enabled="true" />
</XCUIElementTypeApplication>`;
    const recorded = enrichRecordingAction({ type: 'tap', params: { x: 358, y: 784 } }, duplicateSource, { width: 402, height: 874 });

    const resolved = resolveReplayTapPoint(recorded, duplicateSource, { width: 402, height: 874 });

    expect(resolved?.strategy).toBe('semantic');
    expect(resolved?.point.y).toBeGreaterThan(744);
  });
});
