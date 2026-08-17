import { JenkinsBuild } from '../../services/api';
import { DeployTarget } from './qualityOptions';
import { compareBranchOptions, getLatestReleaseBranches, isSameBranch } from './cicdFormatters';

export function buildPublishBranchOptions(branches: string[]) {
  return [...branches].sort(compareBranchOptions).map((branch) => ({ value: branch, label: branch }));
}

export function buildBuildBranchFilterOptions(branches: string[], builds?: JenkinsBuild[]) {
  const branchNames = Array.from(new Set([
    ...branches,
    ...(builds || []).map((build) => String(build.branchName || '').trim()),
  ].filter(Boolean)));
  return [
    { label: '全部', value: '' },
    ...branchNames.sort(compareBranchOptions).map((branch) => ({ label: branch, value: branch })),
  ];
}

export function buildPublishGateBuildOptions(builds: JenkinsBuild[] | undefined, deployTarget: DeployTarget, publishBranch: string) {
  const branchBuilds = (builds || [])
    .filter((build) => build.result === 'SUCCESS' && isSameBranch(build.branchName || '', publishBranch))
    .sort((a, b) => Number(b.number || 0) - Number(a.number || 0));
  const candidates = deployTarget === 'AppStore'
    ? branchBuilds
      .filter((build) => build.publishChannel === 'TestFlight')
      .slice(0, 1)
    : branchBuilds;
  return candidates.map((build) => ({
    value: build.number,
    label: `#${build.number} · ${build.appVersion || '-'} · ${build.publishChannel || '-'} · ${build.commitHash?.slice(0, 8) || '-'}`,
  }));
}

export function buildReleaseBaseBranchOptions(branches: string[]) {
  const items = ['develop', ...getLatestReleaseBranches(branches, 2)];
  return Array.from(new Set(items)).map((branch) => ({ value: branch, label: branch }));
}
