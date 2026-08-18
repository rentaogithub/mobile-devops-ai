import { useState } from 'react';

import type { CICDSection } from './CicdPageHeader';
import type { useBuildLogModal } from './useBuildLogModal';
import { useCicdDerivedOptions } from './useCicdDerivedOptions';
import { useCicdHealth } from './useCicdHealth';
import type { DeployTarget } from './qualityOptions';
import { useReleaseBranches } from './useReleaseBranches';
import { useReleaseBuildPolling } from './useReleaseBuildPolling';
import { useReleaseBuilds } from './useReleaseBuilds';
import { useReleasePublishController } from './useReleasePublishController';
import { useReleasePublishModal } from './useReleasePublishModal';
import { useReleasePublishSync } from './useReleasePublishSync';

interface UseCicdReleaseControllerParams {
  activeSection: CICDSection;
  canPublishPgyerOrTestFlight: boolean;
  canUseQuality: boolean;
  canPublishAppStore: boolean;
  canOperateCicd: boolean;
  buildLogModal: ReturnType<typeof useBuildLogModal>;
}

export function useCicdReleaseController({
  activeSection,
  canPublishPgyerOrTestFlight,
  canUseQuality,
  canPublishAppStore,
  canOperateCicd,
  buildLogModal,
}: UseCicdReleaseControllerParams) {
  const [filterDeployTarget, setFilterDeployTarget] = useState<DeployTarget | ''>('');
  const [filterBranchName, setFilterBranchName] = useState('');
  const releasePublishModal = useReleasePublishModal();
  const {
    open: publishModalOpen,
    deployTarget,
    publishBranch,
    setPublishBranch,
  } = releasePublishModal;

  const cicdHealth = useCicdHealth(activeSection === 'release' && canOperateCicd);
  const releaseBuilds = useReleaseBuilds({
    canUseQuality,
    filterDeployTarget,
    filterBranchName,
    onAppStoreReleaseUpdate: buildLogModal.updateSelectedBuildAppStoreRelease,
  });
  const releaseBranches = useReleaseBranches({
    deployTarget,
    onPublishBranchChange: setPublishBranch,
  });
  const derivedOptions = useCicdDerivedOptions({
    branches: releaseBranches.branches,
    data: releaseBuilds.data,
    deployTarget,
    publishBranch,
    canUseQuality,
    canPublishAppStore,
    canPublishPgyerOrTestFlight,
    loading: releaseBuilds.loading,
  });

  useReleasePublishSync({
    publishModalOpen,
    branches: releaseBranches.branches,
    deployTarget,
    availableDeployTargetOptions: derivedOptions.availableDeployTargetOptions,
    firstAvailableDeployTarget: derivedOptions.firstAvailableDeployTarget,
    loadBranches: releaseBranches.loadBranches,
    syncReleaseBranchFromBranches: releasePublishModal.syncReleaseBranchFromBranches,
    syncAvailableTargets: releasePublishModal.syncAvailableTargets,
  });

  useReleaseBuildPolling({
    active: activeSection === 'release',
    data: releaseBuilds.data,
    filterDeployTarget,
    filterBranchName,
    loadBuilds: releaseBuilds.loadBuilds,
  });

  const releasePublishController = useReleasePublishController({
    modal: releasePublishModal,
    canOperateCicd,
    canPublishPgyerOrTestFlight,
    canPublishAppStore,
    data: releaseBuilds.data,
    filterDeployTarget,
    onFilterDeployTargetChange: setFilterDeployTarget,
    refreshBuildsUntilUpdated: releaseBuilds.refreshBuildsUntilUpdated,
  });

  return {
    cicdHealth,
    releaseBuilds,
    releaseBranches,
    releasePublishModal,
    releasePublishController,
    derivedOptions,
    filters: {
      deployTarget: filterDeployTarget,
      branchName: filterBranchName,
      setDeployTarget: setFilterDeployTarget,
      setBranchName: setFilterBranchName,
    },
  };
}
