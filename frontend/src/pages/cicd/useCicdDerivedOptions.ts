import { useMemo } from 'react';

import type { JenkinsBuildListResult } from '../../services/api';
import {
  buildBuildBranchFilterOptions,
  buildPublishBranchOptions,
  buildPublishGateBuildOptions,
  buildReleaseBaseBranchOptions,
} from './cicdBranchOptions';
import { getBuildStats } from './cicdStats';
import { DEPLOY_TARGET_OPTIONS, filterDeployTargetOptions } from './qualityOptions';
import type { DeployTarget } from './qualityOptions';

interface UseCicdDerivedOptionsParams {
  branches: string[];
  data?: JenkinsBuildListResult | null;
  deployTarget: DeployTarget;
  publishBranch: string;
  canUseQuality: boolean;
  canPublishAppStore: boolean;
  canPublishPgyerOrTestFlight: boolean;
  loading: boolean;
}

export function useCicdDerivedOptions({
  branches,
  data,
  deployTarget,
  publishBranch,
  canUseQuality,
  canPublishAppStore,
  canPublishPgyerOrTestFlight,
  loading,
}: UseCicdDerivedOptionsParams) {
  const availableDeployTargetOptions = useMemo(
    () => filterDeployTargetOptions(DEPLOY_TARGET_OPTIONS, { canPublishAppStore, canPublishPgyerOrTestFlight }),
    [canPublishAppStore, canPublishPgyerOrTestFlight],
  );
  const firstAvailableDeployTarget = availableDeployTargetOptions[0]?.value;
  const stats = useMemo(() => getBuildStats(data), [data]);
  const canOpenQualityModal = canUseQuality && (data?.builds || []).length > 0 && !loading;
  const publishBranchOptions = useMemo(
    () => buildPublishBranchOptions(branches),
    [branches],
  );
  const buildBranchFilterOptions = useMemo(
    () => buildBuildBranchFilterOptions(branches, data?.builds),
    [branches, data?.builds],
  );
  const publishGateBuildOptions = useMemo(
    () => buildPublishGateBuildOptions(data?.builds, deployTarget, publishBranch),
    [data?.builds, deployTarget, publishBranch],
  );
  const releaseBaseBranchOptions = useMemo(
    () => buildReleaseBaseBranchOptions(branches),
    [branches],
  );

  return {
    stats,
    availableDeployTargetOptions,
    firstAvailableDeployTarget,
    canOpenQualityModal,
    publishBranchOptions,
    buildBranchFilterOptions,
    publishGateBuildOptions,
    releaseBaseBranchOptions,
  };
}
