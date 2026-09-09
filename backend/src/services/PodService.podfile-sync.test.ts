import fs from 'fs';
import os from 'os';
import path from 'path';
import { PodService } from './PodService';

describe('PodService Podfile sync helpers', () => {
  const service = new PodService() as any;

  it('uses Podfile as the only publish main repo dependency file', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'podfile-sync-'));
    try {
      fs.writeFileSync(path.join(temp, 'Podfile'), "target 'App' do\nend\n", 'utf-8');
      fs.mkdirSync(path.join(temp, 'Legacy'));
      fs.writeFileSync(path.join(temp, 'Legacy', 'third_sdk.rb'), "pod 'OldSDK', '1.0.0'\n", 'utf-8');

      expect(service.mainRepoDependencyFiles(temp)).toEqual(['Podfile']);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('replaces only the version of an existing Podfile component declaration', () => {
    const original = [
      "target 'App' do",
      '  # 内部组件',
      "  pod 'NNRtc', '3.0.0'",
      '  # 外部组件',
      "  pod 'ActiveLabel', '1.0.0'",
      "  pod 'Alamofire', '5.12.0'",
      'end',
      '',
    ].join('\n');

    const result = service.updatePodVersionInRuby(original, 'ActiveLabel', '1.1.0');

    expect(result.changed).toBe(true);
    expect(result.content).toContain("  pod 'ActiveLabel', '1.1.0'");
    expect(result.content).not.toContain("  pod 'ActiveLabel', '1.0.0'");
    expect(result.content.split('\n').filter((line: string) => line.includes("'ActiveLabel'"))).toHaveLength(1);
  });

  it('appends a missing component declaration inside def third_sdk', () => {
    const original = [
      "target 'App' do",
      '  third_sdk',
      'end',
      '',
      'def third_sdk',
      '  # 外部组件',
      "  pod 'Alamofire', '5.12.0'",
      'end',
      '',
    ].join('\n');

    const result = service.appendPodToThirdSdkDef(original, 'ActiveLabel', '1.1.0');

    expect(result.changed).toBe(true);
    expect(result.content).toContain("  pod   'ActiveLabel', '1.1.0'\nend");
    expect(result.content.indexOf("  pod   'ActiveLabel', '1.1.0'")).toBeGreaterThan(result.content.indexOf('def third_sdk'));
    expect(result.content.indexOf("  pod   'ActiveLabel', '1.1.0'")).toBeLessThan(result.content.lastIndexOf('end'));
  });

  it('does not add a version to a declaration that has no version argument', () => {
    const original = [
      "target 'App' do",
      "  pod 'ActiveLabel'",
      'end',
      '',
    ].join('\n');

    const result = service.updatePodVersionInRuby(original, 'ActiveLabel', '1.1.0');

    expect(result.changed).toBe(false);
    expect(result.content).toBe(original);
  });

  it('does not append a missing component declaration without def third_sdk', () => {
    const original = [
      "target 'App' do",
      '  # 外部组件',
      "  pod 'Alamofire', '5.12.0'",
      'end',
      '',
    ].join('\n');

    const result = service.appendPodToThirdSdkDef(original, 'ActiveLabel', '1.1.0');

    expect(result.changed).toBe(false);
    expect(result.content).toBe(original);
  });
});
