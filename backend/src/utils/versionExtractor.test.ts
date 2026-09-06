import { extractVersionFromCrashLog } from './versionExtractor';

describe('extractVersionFromCrashLog', () => {
  it('从当前进程对应的 Binary Image 提取版本', () => {
    const crashLog = `Process: OtherApp [123]
Command: OtherApp
Binary Images:
0x1000 - 0x1fff Component arm64 <11111111111111111111111111111111> /tmp/Component.framework/Component (9.9.9)
0x2000 - 0x2fff OtherApp arm64 <22222222222222222222222222222222> /tmp/OtherApp.app/OtherApp (2.3.4)`;

    expect(extractVersionFromCrashLog(crashLog)).toBe('2.3.4');
  });

  it('没有 Process 字段时使用 .app 可执行文件', () => {
    const crashLog = `Binary Images:
0x1000 - 0x1fff SharedKit arm64 <11111111111111111111111111111111> /tmp/SharedKit.framework/SharedKit (7.0.0)
0x2000 - 0x2fff ProductB arm64 <22222222222222222222222222222222> /tmp/ProductB.app/ProductB (3.1.0)`;

    expect(extractVersionFromCrashLog(crashLog)).toBe('3.1.0');
  });
});
