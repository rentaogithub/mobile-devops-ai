import type { CICDSection } from './CicdPageHeader';
import { useQualityBuildPolling } from './useQualityBuildPolling';
import { useQualityBuilds } from './useQualityBuilds';
import { useQualityDevicePools } from './useQualityDevicePools';
import { useQualityReportModal } from './useQualityReportModal';
import { useQualityReportSync } from './useQualityReportSync';
import { useQualityStartModal } from './useQualityStartModal';
import type { JenkinsBuildListResult } from '../../services/api';
import type { DeployTarget } from './qualityOptions';

interface UseCicdQualityControllerParams {
  activeSection: CICDSection;
  canAdminCicd: boolean;
  canUseQuality: boolean;
  loadReleaseBuilds: (target?: DeployTarget | '', options?: { silent?: boolean }, branch?: string) => Promise<JenkinsBuildListResult | null>;
}

export function useCicdQualityController({
  activeSection,
  canAdminCicd,
  canUseQuality,
  loadReleaseBuilds,
}: UseCicdQualityControllerParams) {
  const qualityStartModal = useQualityStartModal();
  const qualityDevicePools = useQualityDevicePools({
    canAdmin: canAdminCicd,
    selectedPoolValue: qualityStartModal.devicePool,
    onSelectedPoolChange: qualityStartModal.setDevicePool,
  });
  const qualityBuilds = useQualityBuilds({
    canAdmin: canAdminCicd,
    canUseQuality,
    refreshSourceBuilds: () => loadReleaseBuilds('', { silent: true }, ''),
    refreshDevicePools: qualityDevicePools.loadPools,
  });
  const qualityReportModal = useQualityReportModal({ loadQualityBuilds: qualityBuilds.loadBuilds });

  useQualityReportSync({
    build: qualityReportModal.build,
    qualityData: qualityBuilds.data,
    setBuild: qualityReportModal.setBuild,
    loadQualityBuilds: qualityBuilds.loadBuilds,
    loadLogDigest: qualityReportModal.loadLogDigest,
  });

  useQualityBuildPolling({
    activeSection,
    hasRunningQualityBuild: qualityBuilds.hasRunningBuild,
    refreshQualitySection: qualityBuilds.refreshSection,
    loadDevicePools: qualityDevicePools.loadPools,
  });

  return {
    qualityStartModal,
    qualityDevicePools,
    qualityBuilds,
    qualityReportModal,
  };
}
