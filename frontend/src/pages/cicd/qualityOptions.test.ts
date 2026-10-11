import { describe, expect, it } from 'vitest';
import { INSTALLED_APP_BUNDLE_OPTIONS, installedAppBundleIdForBuild } from './qualityOptions';

describe('installedAppBundleIdForBuild', () => {
  it('蒲公英和开发构建使用开发 Bundle ID', () => {
    expect(installedAppBundleIdForBuild({ publishChannel: 'Pgyer' } as any)).toBe('com.example.mobileapp.dev');
    expect(installedAppBundleIdForBuild({ branchName: 'develop' } as any)).toBe('com.example.mobileapp.dev');
  });

  it('TestFlight 和 App Store 构建使用生产 Bundle ID', () => {
    expect(installedAppBundleIdForBuild({ publishChannel: 'TestFlight' } as any)).toBe('com.example.mobileapp');
    expect(installedAppBundleIdForBuild({ publishChannel: 'AppStore' } as any)).toBe('com.example.mobileapp');
  });
});

describe('INSTALLED_APP_BUNDLE_OPTIONS', () => {
  it('只提供开发和生产两个受控 Bundle ID', () => {
    expect(INSTALLED_APP_BUNDLE_OPTIONS.map((option) => option.value)).toEqual([
      'com.example.mobileapp.dev',
      'com.example.mobileapp',
    ]);
  });
});
