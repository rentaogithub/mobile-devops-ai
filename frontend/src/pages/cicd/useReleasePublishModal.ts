import { useEffect, useState } from 'react';
import { message } from 'antd';

import { JenkinsBuild } from '../../services/api';
import { getHighestReleaseBranch, getReleaseVersionText } from './cicdFormatters';
import { buildPgyerPublishDefaults, buildPublishModalDefaults } from './releaseFormDefaults';
import { DeployTarget } from './qualityOptions';

interface OpenReleasePublishModalParams {
  deployTarget: DeployTarget;
  firstAvailableDeployTarget?: DeployTarget;
  availableDeployTargets: Array<{ label: string; value: DeployTarget }>;
  branches: string[];
  canOperateCicd: boolean;
}

export function useReleasePublishModal() {
  const [open, setOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [deployTarget, setDeployTarget] = useState<DeployTarget>('Pgyer');
  const [publishBranch, setPublishBranch] = useState('develop');
  const [publishAppVersion, setPublishAppVersion] = useState('');
  const [verificationPassword, setVerificationPassword] = useState('');
  const [gateBuildNumber, setGateBuildNumber] = useState<number>();
  const [gateOverrideReason, setGateOverrideReason] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');

  const autoPublishAppVersion = getReleaseVersionText(publishBranch);
  const resolvedPublishAppVersion = autoPublishAppVersion || publishAppVersion.trim();

  const syncAvailableTargets = (
    availableDeployTargets: Array<{ label: string; value: DeployTarget }>,
    firstAvailableDeployTarget?: DeployTarget,
  ) => {
    if (!firstAvailableDeployTarget) return;
    if (!availableDeployTargets.some((option) => option.value === deployTarget)) {
      setDeployTarget(firstAvailableDeployTarget);
    }
  };

  const syncReleaseBranchFromBranches = (branches: string[]) => {
    if (deployTarget !== 'Pgyer' && branches.length > 0) {
      const nextBranch = getHighestReleaseBranch(branches);
      setPublishBranch(nextBranch);
      setPublishAppVersion(getReleaseVersionText(nextBranch));
      setGateBuildNumber(undefined);
    }
  };

  useEffect(() => {
    setPublishAppVersion(getReleaseVersionText(publishBranch));
  }, [publishBranch]);

  const openForPgyerBuild = (build: JenkinsBuild) => {
    const defaults = buildPgyerPublishDefaults(build);
    setDeployTarget(defaults.deployTarget);
    setVerificationPassword('');
    setPublishBranch(defaults.branch);
    setPublishAppVersion(defaults.appVersion);
    setGateBuildNumber(defaults.gateBuildNumber);
    setGateOverrideReason(defaults.gateOverrideReason);
    setReleaseNotes(defaults.releaseNotes);
    setOpen(true);
  };

  const openWithDefaults = ({
    deployTarget: currentDeployTarget,
    firstAvailableDeployTarget,
    availableDeployTargets,
    branches,
    canOperateCicd,
  }: OpenReleasePublishModalParams) => {
    if (!canOperateCicd) {
      message.warning('发布需要测试、研发、产品运营或管理员权限');
      return;
    }
    const defaults = buildPublishModalDefaults({
      deployTarget: currentDeployTarget,
      firstAvailableDeployTarget,
      availableDeployTargets,
      branches,
      currentBranch: publishBranch,
      currentReleaseNotes: releaseNotes,
    });
    if (defaults.deployTarget) {
      setDeployTarget(defaults.deployTarget);
    }
    if (defaults.deployTarget !== 'Pgyer') {
      setPublishBranch(defaults.branch);
    }
    setPublishAppVersion(defaults.appVersion);
    setGateBuildNumber(defaults.gateBuildNumber);
    setGateOverrideReason(defaults.gateOverrideReason);
    setReleaseNotes(defaults.releaseNotes);
    setOpen(true);
  };

  const resetAfterPublish = () => {
    setOpen(false);
    setVerificationPassword('');
    setGateOverrideReason('');
    setReleaseNotes('');
  };

  return {
    open,
    publishing,
    deployTarget,
    publishBranch,
    publishAppVersion,
    verificationPassword,
    gateBuildNumber,
    gateOverrideReason,
    releaseNotes,
    resolvedPublishAppVersion,
    setOpen,
    setPublishing,
    setDeployTarget,
    setPublishBranch,
    setPublishAppVersion,
    setVerificationPassword,
    setGateBuildNumber,
    setGateOverrideReason,
    setReleaseNotes,
    openForPgyerBuild,
    openWithDefaults,
    resetAfterPublish,
    syncAvailableTargets,
    syncReleaseBranchFromBranches,
  };
}
