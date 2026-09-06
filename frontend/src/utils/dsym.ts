import type { DSYMInfo } from '../types';
import { authUtils } from './auth';

function normalizedName(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function isMainAppDSYM(dsym: DSYMInfo, appVersion?: string | null): boolean {
  const activeProductLine = authUtils.getActiveProductLine();
  if (activeProductLine?.id === 'nn' && dsym.appName.trim().toUpperCase() === 'NNIM') return true;
  if (normalizedName(activeProductLine?.name) === normalizedName(dsym.appName)) return true;
  const hasRelatedVersions = Array.isArray(dsym.relatedAppVersions) && dsym.relatedAppVersions.length > 0;
  return !hasRelatedVersions && (!appVersion || dsym.version.trim() === appVersion.trim());
}

export function isComponentDSYM(dsym: DSYMInfo, appVersion?: string | null): boolean {
  return !isMainAppDSYM(dsym, appVersion);
}

export function extractAppVersionFromCrashLog(crashLog: string): string | null {
  const trimmed = crashLog.trim();
  if (trimmed.startsWith('{')) {
    const candidates = [crashLog.split(/\r?\n/, 1)[0], crashLog];
    for (const candidate of candidates) {
      try {
        const json = JSON.parse(candidate);
        const version = json.app_version || json.bundleShortVersion || json.bundle_version;
        if (version) return String(version).trim();
      } catch {
        // 继续尝试文本格式。
      }
    }
  }

  const directVersion = crashLog.match(/^Version:\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/m)?.[1]
    || crashLog.match(/CFBundleShortVersionString:\s+([^\s\n]+)/)?.[1]
    || crashLog.match(/App Version:\s+([^\s\n]+)/)?.[1];
  if (directVersion) return directVersion.trim();

  const processName = [
    crashLog.match(/^Process:\s+([^\s\[]+)/im)?.[1],
    crashLog.match(/^Command:\s+([^\s]+)/im)?.[1],
    crashLog.match(/^Path:\s+.*\/([^/]+)\.app\/([^/\s]+)$/im)?.[2],
  ].find(Boolean)?.trim();
  const imageLines = (crashLog.split(/Binary Images:/i)[1] || '')
    .split(/\r?\n/)
    .filter((line) => /^\s*0x[0-9a-f]+\s+-\s+0x[0-9a-f]+/i.test(line));
  const matchingLine = processName
    ? imageLines.find((line) => {
      const imageName = line.match(/^\s*0x[0-9a-f]+\s+-\s+0x[0-9a-f]+\s+(\S+)/i)?.[1];
      return imageName === processName || line.includes(`/${processName}.app/${processName}`);
    })
    : imageLines.find((line) => /\/[^/\s]+\.app\/[^/\s]+/i.test(line));
  return matchingLine?.match(/\((\d+(?:\.\d+){1,3}(?:[-+][^\s)]+)?)\)\s*$/)?.[1]?.trim() || null;
}
