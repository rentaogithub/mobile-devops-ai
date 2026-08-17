import { JenkinsBuild } from '../../services/api';
import { getHighestReleaseBranch, getReleaseVersionText } from './cicdFormatters';
import { DeployTarget } from './qualityOptions';

export function buildPgyerPublishDefaults(build: JenkinsBuild) {
  const branch = build.branchName || 'develop';
  return {
    deployTarget: 'Pgyer' as DeployTarget,
    branch,
    appVersion: build.appVersion || getReleaseVersionText(branch),
    gateBuildNumber: undefined as number | undefined,
    gateOverrideReason: '',
    releaseNotes: '',
  };
}

export function buildPublishModalDefaults(params: {
  deployTarget: DeployTarget;
  firstAvailableDeployTarget?: DeployTarget;
  availableDeployTargets: Array<{ value: DeployTarget }>;
  branches: string[];
  currentBranch: string;
  currentReleaseNotes: string;
}) {
  const nextDeployTarget = params.availableDeployTargets.some((option) => option.value === params.deployTarget)
    ? params.deployTarget
    : params.firstAvailableDeployTarget;
  const nextBranch = nextDeployTarget !== 'Pgyer' ? getHighestReleaseBranch(params.branches) : params.currentBranch;
  return {
    deployTarget: nextDeployTarget,
    branch: nextBranch,
    appVersion: getReleaseVersionText(nextBranch),
    gateBuildNumber: undefined as number | undefined,
    gateOverrideReason: '',
    releaseNotes: nextDeployTarget !== 'TestFlight' ? '' : params.currentReleaseNotes,
  };
}
