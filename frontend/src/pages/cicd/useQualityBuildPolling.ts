import { useEffect, useRef } from 'react';

import { CICDSection } from './CicdPageHeader';
import { usePollingEffect } from './usePollingEffect';

interface UseQualityBuildPollingParams {
  activeSection: CICDSection;
  hasRunningQualityBuild: boolean;
  refreshQualitySection: (options?: { silent?: boolean }) => Promise<unknown>;
  loadDevicePools: () => Promise<unknown>;
}

export function useQualityBuildPolling({
  activeSection,
  hasRunningQualityBuild,
  refreshQualitySection,
  loadDevicePools,
}: UseQualityBuildPollingParams) {
  const previousHasRunningQualityBuildRef = useRef(false);

  usePollingEffect(
    activeSection === 'quality' && hasRunningQualityBuild,
    5000,
    () => { refreshQualitySection({ silent: true }); },
    [activeSection, hasRunningQualityBuild],
  );

  usePollingEffect(
    activeSection === 'quality',
    hasRunningQualityBuild ? 5000 : 15000,
    () => { loadDevicePools(); },
    [activeSection, hasRunningQualityBuild],
  );

  useEffect(() => {
    const previous = previousHasRunningQualityBuildRef.current;
    previousHasRunningQualityBuildRef.current = hasRunningQualityBuild;
    if (activeSection === 'quality' && previous && !hasRunningQualityBuild) {
      loadDevicePools();
    }
  }, [activeSection, hasRunningQualityBuild]);
}
