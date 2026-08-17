import { useEffect, useMemo, useRef } from 'react';

import { JenkinsBuildListResult } from '../../services/api';
import {
  buildPendingAppStoreReleaseKey,
  buildPendingTestFlightDistributionKey,
  buildRunningBuildNumbersKey,
  isPendingAppStoreRelease,
  isPendingTestFlightDistribution,
} from './cicdBuildUtils';
import { DeployTarget } from './qualityOptions';
import { usePollingEffect } from './usePollingEffect';

interface UseReleaseBuildPollingParams {
  active: boolean;
  data?: JenkinsBuildListResult | null;
  filterDeployTarget: DeployTarget | '';
  filterBranchName: string;
  loadBuilds: (target?: DeployTarget | '', options?: { silent?: boolean }, branch?: string) => Promise<JenkinsBuildListResult | null>;
}

export function useReleaseBuildPolling({
  active,
  data,
  filterDeployTarget,
  filterBranchName,
  loadBuilds,
}: UseReleaseBuildPollingParams) {
  const pollingRef = useRef(false);
  const previousHasRunningBuildRef = useRef(false);

  const hasRunningBuild = useMemo(
    () => (data?.builds || []).some((build) => build.building),
    [data],
  );
  const runningBuildNumbersKey = useMemo(
    () => buildRunningBuildNumbersKey(data?.builds),
    [data],
  );
  const hasPendingTestFlightDistribution = useMemo(
    () => (data?.builds || []).some(isPendingTestFlightDistribution),
    [data],
  );
  const pendingTestFlightDistributionKey = useMemo(
    () => buildPendingTestFlightDistributionKey(data?.builds),
    [data],
  );
  const hasPendingAppStoreRelease = useMemo(
    () => (data?.builds || []).some(isPendingAppStoreRelease),
    [data],
  );
  const pendingAppStoreReleaseKey = useMemo(
    () => buildPendingAppStoreReleaseKey(data?.builds),
    [data],
  );

  usePollingEffect(
    active && (hasRunningBuild || hasPendingTestFlightDistribution || hasPendingAppStoreRelease),
    5000,
    () => {
      if (pollingRef.current) {
        return;
      }
      pollingRef.current = true;
      loadBuilds(filterDeployTarget, { silent: true }, filterBranchName)
        .finally(() => {
          pollingRef.current = false;
        });
    },
    [
      active,
      hasRunningBuild,
      hasPendingTestFlightDistribution,
      hasPendingAppStoreRelease,
      runningBuildNumbersKey,
      pendingTestFlightDistributionKey,
      pendingAppStoreReleaseKey,
      filterDeployTarget,
      filterBranchName,
    ],
  );

  useEffect(() => {
    const previous = previousHasRunningBuildRef.current;
    previousHasRunningBuildRef.current = hasRunningBuild;
    if (active && previous && !hasRunningBuild) {
      loadBuilds(filterDeployTarget, { silent: true }, filterBranchName);
    }
  }, [active, hasRunningBuild, filterDeployTarget, filterBranchName]);

  return { hasRunningBuild };
}
