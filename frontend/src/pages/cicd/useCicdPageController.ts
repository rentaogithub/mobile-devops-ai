import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { CICDSection, getCicdSectionFromPath } from './CicdPageHeader';
import { getCicdPermissions } from './cicdPermissions';
import { useAppleDeviceRegistration } from './useAppleDeviceRegistration';
import { useBuildLogModal } from './useBuildLogModal';
import { useCicdQualityController } from './useCicdQualityController';
import { useCicdReleaseController } from './useCicdReleaseController';
import { useCicdPageActions } from './useCicdPageActions';
import { useCicdPageRouting } from './useCicdPageRouting';
import { useReleaseBranchModal } from './useReleaseBranchModal';

export function useCicdPageController() {
  const location = useLocation();
  const navigate = useNavigate();
  const initialSection: CICDSection = getCicdSectionFromPath(location.pathname);
  const [activeSection, setActiveSection] = useState<CICDSection>(initialSection);
  const [qrPreview, setQrPreview] = useState<{ url: string; channel?: string; buildNumber?: string; branchName?: string } | null>(null);
  const buildLogModal = useBuildLogModal();
  const permissions = getCicdPermissions();
  const {
    canPublishPgyerOrTestFlight,
    canUseQuality,
    canPublishAppStore,
    canOperateCicd,
    canAdminCicd,
    canCreateReleaseBranch,
  } = permissions;

  const {
    cicdHealth,
    releaseBuilds,
    releaseBranches,
    releasePublishModal,
    releasePublishController,
    derivedOptions,
    filters,
  } = useCicdReleaseController({
    activeSection,
    canPublishPgyerOrTestFlight,
    canUseQuality,
    canPublishAppStore,
    canOperateCicd,
    buildLogModal,
  });
  const {
    qualityStartModal,
    qualityDevicePools,
    qualityBuilds,
    qualityReportModal,
  } = useCicdQualityController({
    activeSection,
    canAdminCicd,
    canUseQuality,
    loadReleaseBuilds: releaseBuilds.loadBuilds,
  });
  const appleDeviceRegistration = useAppleDeviceRegistration({
    active: activeSection === 'devices',
    canAdmin: canAdminCicd,
  });

  const pageActions = useCicdPageActions({
    canOperateCicd,
    canUseQuality,
    deployTarget: releasePublishModal.deployTarget,
    firstAvailableDeployTarget: derivedOptions.firstAvailableDeployTarget,
    availableDeployTargetOptions: derivedOptions.availableDeployTargetOptions,
    branches: releaseBranches.branches,
    releasePublishModal,
    qualityStartModal,
    releaseBuilds: releaseBuilds.data?.builds,
    qualityDevicePools: qualityDevicePools.pools,
    closePublishModal: () => releasePublishModal.setOpen(false),
  });

  useCicdPageRouting({
    pathname: location.pathname,
    search: location.search,
    navigate,
    activeSection,
    setActiveSection,
    canUseQuality,
    builds: releaseBuilds.data,
    branches: releaseBranches.branches,
    loadBuilds: releaseBuilds.loadBuilds,
    loadBranches: releaseBranches.loadBranches,
    refreshQualitySection: qualityBuilds.refreshSection,
    refreshDevicesSection: appleDeviceRegistration.refreshSection,
    clearQualityError: qualityBuilds.clearError,
    showBuildLog: buildLogModal.showBuildLog,
  });

  const releaseBranchModal = useReleaseBranchModal({
    canCreateReleaseBranch,
    baseBranchOptions: derivedOptions.releaseBaseBranchOptions,
    loadBranches: releaseBranches.loadBranches,
    onCreated: releasePublishModal.setPublishBranch,
  });

  return {
    activeSection,
    permissions,
    releaseBuilds,
    releaseBranches,
    releasePublishModal,
    releasePublishController,
    releaseBranchModal,
    cicdHealth,
    buildLogModal,
    qualityBuilds,
    qualityStartModal,
    qualityDevicePools,
    qualityReportModal,
    appleDeviceRegistration,
    derivedOptions,
    pageActions,
    filters,
    qrPreview,
    setQrPreview,
  };
}

export type CicdPageController = ReturnType<typeof useCicdPageController>;
