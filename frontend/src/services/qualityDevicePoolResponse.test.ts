import { describe, expect, it } from 'vitest';
import { assertQualityDevicePoolResponse } from './qualityDevicePoolResponse';

describe('device-pool response validation', () => {
  it('rejects HTTP 200 HTML instead of treating it as an empty pool list', () => {
    for (const kind of ['list', 'status'] as const) {
      expect(() => assertQualityDevicePoolResponse('<!doctype html><html></html>', kind)).toThrow('前后端版本一致');
      expect(() => assertQualityDevicePoolResponse({ success: true }, kind)).toThrow('缺少配置数据');
    }
  });
  it('preserves server errors and rejects unsuccessful responses', () => {
    expect(() => assertQualityDevicePoolResponse({ success: false, error: '设备检测失败' }, 'status')).toThrow('设备检测失败');
  });
  it('accepts real empty and populated configuration responses', () => {
    for (const pools of [[], [{ label: 'USB iPhone', value: 'ios-default' }]]) {
      expect(() => assertQualityDevicePoolResponse({ success: true, data: pools }, 'list')).not.toThrow();
      expect(() => assertQualityDevicePoolResponse({ success: true, data: { pools } }, 'status')).not.toThrow();
    }
  });
});
