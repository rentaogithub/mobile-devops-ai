import { JenkinsBuild } from '../../services/api';

export function isReleaseBranch(branch: string) {
  return /^(?:origin\/)?release\/\d+(?:\.\d+){2,}$/.test(branch.trim());
}

export function releaseNotesLength(value: string) {
  return value.trim().length;
}

export function getReleaseVersion(branch: string) {
  const match = branch.trim().replace(/^origin\//, '').match(/^release\/(\d+(?:\.\d+){2,})$/);
  return match ? match[1].split('.').map((item) => Number(item)) : [];
}

export function getReleaseVersionText(branch: string) {
  const match = branch.trim().replace(/^origin\//, '').match(/^release\/(\d+(?:\.\d+){2,})$/);
  return match?.[1] || '';
}

export function getBranchVersion(branch: string) {
  const match = branch.trim().replace(/^origin\//, '').match(/^(?:release|feature)\/(\d+(?:\.\d+){2,})(?:[_/-].*)?$/);
  return match ? match[1].split('.').map((item) => Number(item)) : [];
}

export function compareReleaseBranches(a: string, b: string) {
  const av = getReleaseVersion(a);
  const bv = getReleaseVersion(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (av[i] || 0) - (bv[i] || 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

export function compareBranchVersionsDesc(a: string, b: string) {
  const av = getBranchVersion(a);
  const bv = getBranchVersion(b);
  const hasVersionA = av.length > 0;
  const hasVersionB = bv.length > 0;
  if (hasVersionA && hasVersionB) {
    const len = Math.max(av.length, bv.length);
    for (let i = 0; i < len; i += 1) {
      const diff = (bv[i] || 0) - (av[i] || 0);
      if (diff !== 0) return diff;
    }
  } else if (hasVersionA) {
    return -1;
  } else if (hasVersionB) {
    return 1;
  }
  return a.localeCompare(b);
}

export function compareBranchOptions(a: string, b: string) {
  const normalizedA = a.trim().replace(/^origin\//, '');
  const normalizedB = b.trim().replace(/^origin\//, '');
  if (normalizedA === 'develop') return -1;
  if (normalizedB === 'develop') return 1;
  const aIsRelease = isReleaseBranch(normalizedA);
  const bIsRelease = isReleaseBranch(normalizedB);
  if (aIsRelease && bIsRelease) return compareReleaseBranches(normalizedB, normalizedA);
  if (aIsRelease) return -1;
  if (bIsRelease) return 1;
  const aIsFeature = normalizedA.startsWith('feature/');
  const bIsFeature = normalizedB.startsWith('feature/');
  if (aIsFeature && bIsFeature) return compareBranchVersionsDesc(normalizedA, normalizedB);
  return normalizedA.localeCompare(normalizedB);
}

export function isSameBranch(a: string, b: string) {
  return a.trim().replace(/^origin\//, '') === b.trim().replace(/^origin\//, '');
}

export function getHighestReleaseBranch(list: string[]) {
  return list.filter(isReleaseBranch).sort(compareReleaseBranches).at(-1) || '';
}

export function getLatestReleaseBranches(list: string[], limit = 2) {
  return list
    .map((branch) => branch.trim().replace(/^origin\//, ''))
    .filter(isReleaseBranch)
    .sort(compareReleaseBranches)
    .slice(-limit)
    .reverse();
}

export function formatBuildTime(timestamp: number) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString();
}

export function formatDuration(duration: number, building: boolean) {
  if (!duration && building) return '运行中';
  if (!duration) return '-';
  const seconds = Math.round(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}分${restSeconds}秒` : `${restSeconds}秒`;
}

export function formatMilliseconds(value?: number | string | null) {
  if (value === undefined || value === null || value === '') return '-';
  const ms = Number(value);
  if (!Number.isFinite(ms)) return '-';
  if (ms >= 1000) {
    return `${ms}ms (${(ms / 1000).toFixed(2)}秒)`;
  }
  return `${ms}ms`;
}

export function formatSeconds(value?: number | null) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '-';
  const seconds = Math.max(0, Math.floor(Number(value)));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}时${minutes}分`;
  if (minutes > 0) return `${minutes}分${rest}秒`;
  return `${rest}秒`;
}

export function getChannelBuildNumber(build: JenkinsBuild) {
  const rawBuildNumber = String(build.buildNumber || '').trim();
  const channelBuildNumber = rawBuildNumber.match(/[0-9]+$/)?.[0] || rawBuildNumber;
  if (!channelBuildNumber) return '';
  if (channelBuildNumber === String(build.number)) return '';
  return channelBuildNumber;
}
