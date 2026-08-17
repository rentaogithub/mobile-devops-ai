import { useEffect } from 'react';

import { JenkinsQualityBuild, JenkinsQualityListResult } from '../../services/api';
import { hasQualityReportArtifact } from './qualityStatus';
import { usePollingEffect } from './usePollingEffect';

interface UseQualityReportSyncParams {
  build?: JenkinsQualityBuild | null;
  qualityData?: JenkinsQualityListResult | null;
  setBuild: (build: JenkinsQualityBuild) => void;
  loadQualityBuilds: (options?: { silent?: boolean }) => Promise<JenkinsQualityListResult | null>;
  loadLogDigest: (url?: string) => Promise<void>;
}

export function useQualityReportSync({
  build,
  qualityData,
  setBuild,
  loadQualityBuilds,
  loadLogDigest,
}: UseQualityReportSyncParams) {
  useEffect(() => {
    if (!build) return;
    const latestBuild = qualityData?.builds?.find((item) => item.number === build.number);
    if (!latestBuild || latestBuild === build) return;
    setBuild(latestBuild);
  }, [qualityData, build?.number, setBuild]);

  usePollingEffect(
    Boolean(build && !hasQualityReportArtifact(build)),
    3000,
    () => { loadQualityBuilds({ silent: true }); },
    [
      build?.number,
      build?.building,
      build?.result,
      build?.qualitySummary?.artifacts,
    ],
  );

  useEffect(() => {
    if (!build) {
      loadLogDigest();
      return;
    }
    loadLogDigest(build.qualitySummary?.artifacts?.qualityLogUrl);
  }, [
    build?.number,
    build?.qualitySummary?.testSuite,
    build?.qualitySummary?.artifacts?.qualityLogUrl,
  ]);
}
