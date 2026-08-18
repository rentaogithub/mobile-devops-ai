import { CicdPageHeader, getCicdPageMeta } from './CicdPageHeader';
import type { CicdPageController } from './useCicdPageController';

interface CicdPageHeaderContainerProps {
  controller: CicdPageController;
}

export function CicdPageHeaderContainer({
  controller,
}: CicdPageHeaderContainerProps) {
  const {
    activeSection,
    permissions,
    releaseBuilds,
    releasePublishModal,
    releaseBranchModal,
    cicdHealth,
    qualityBuilds,
    qualityDevicePools,
    derivedOptions,
    pageActions,
  } = controller;
  const {
    canCreateReleaseBranch,
    canOperateCicd,
    canAdminCicd,
    canUseQuality,
  } = permissions;
  const pageMeta = getCicdPageMeta(activeSection);

  return (
    <CicdPageHeader
      activeSection={activeSection}
      title={pageMeta.title}
      description={pageMeta.description}
      cicdHealth={cicdHealth.health}
      cicdHealthLoading={cicdHealth.loading}
      canCreateReleaseBranch={canCreateReleaseBranch}
      canOperateCicd={canOperateCicd}
      canAdminCicd={canAdminCicd}
      canUseQuality={canUseQuality}
      canOpenQualityModal={derivedOptions.canOpenQualityModal}
      loading={releaseBuilds.loading}
      publishing={releasePublishModal.publishing}
      qualityLoading={qualityBuilds.loading}
      qualityJobSyncing={qualityBuilds.jobSyncing}
      onToggleHealth={cicdHealth.toggleHealth}
      onOpenReleaseBranchModal={releaseBranchModal.openModal}
      onRefreshBuilds={() => releaseBuilds.loadBuilds()}
      onOpenPublishModal={pageActions.openPublishModal}
      onSyncQualityJobConfig={qualityBuilds.syncJobConfig}
      onOpenDevicePoolModal={qualityDevicePools.openModal}
      onRefreshQuality={() => qualityBuilds.refreshSection()}
      onOpenQualityModal={() => pageActions.openQualityModal()}
    />
  );
}
