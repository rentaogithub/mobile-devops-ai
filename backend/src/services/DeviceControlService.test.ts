import { deviceControlPortCandidates, wdaStartupDiagnostic } from './DeviceControlService';

describe('WDA 启动诊断', () => {
  test('将设备锁屏、开发者模式和签名错误转为可操作提示', () => {
    expect(wdaStartupDiagnostic(
      'Xcode cannot launch WebDriverAgentRunner because the device is locked. Unlock 测试 iPhone to Continue',
      '测试 iPhone',
    )).toContain('设备已锁定');
    expect(wdaStartupDiagnostic('Developer Mode is disabled', 'iPhone')).toContain('开发者模式');
    expect(wdaStartupDiagnostic('Signing for WebDriverAgentRunner requires a development team', 'iPhone')).toContain('WDA 签名');
  });

  test('无明确特征时不误报', () => {
    expect(wdaStartupDiagnostic('CompileC WebDriverAgentLib')).toBe('');
  });
});

describe('WDA 本地端口候选', () => {
  test('从首选端口起按顺序生成有界候选', () => {
    expect(deviceControlPortCandidates(8200, 4)).toEqual([8200, 8201, 8202, 8203]);
    expect(deviceControlPortCandidates(65535, 2)).toEqual([65535, 1024]);
  });

  test('将非法端口和数量限制在安全范围', () => {
    expect(deviceControlPortCandidates(80, 0)).toEqual([1024]);
    expect(deviceControlPortCandidates(70000, 2)).toEqual([65535, 1024]);
  });
});
