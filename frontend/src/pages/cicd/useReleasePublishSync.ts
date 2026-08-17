import { useEffect } from 'react';

import { DeployTarget } from './qualityOptions';

interface UseReleasePublishSyncParams {
  publishModalOpen: boolean;
  branches: string[];
  deployTarget: DeployTarget;
  availableDeployTargetOptions: Array<{ label: string; value: DeployTarget }>;
  firstAvailableDeployTarget?: DeployTarget;
  loadBranches: () => Promise<string[]>;
  syncReleaseBranchFromBranches: (branches: string[]) => void;
  syncAvailableTargets: (
    availableDeployTargets: Array<{ label: string; value: DeployTarget }>,
    firstAvailableDeployTarget?: DeployTarget,
  ) => void;
}

export function useReleasePublishSync({
  publishModalOpen,
  branches,
  deployTarget,
  availableDeployTargetOptions,
  firstAvailableDeployTarget,
  loadBranches,
  syncReleaseBranchFromBranches,
  syncAvailableTargets,
}: UseReleasePublishSyncParams) {
  useEffect(() => {
    if (publishModalOpen && branches.length === 0) {
      loadBranches();
    }
  }, [publishModalOpen]);

  useEffect(() => {
    syncReleaseBranchFromBranches(branches);
  }, [deployTarget, branches]);

  useEffect(() => {
    syncAvailableTargets(availableDeployTargetOptions, firstAvailableDeployTarget);
  }, [availableDeployTargetOptions, deployTarget, firstAvailableDeployTarget]);
}
