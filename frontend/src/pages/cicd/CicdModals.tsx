import { normalizeOpenUrl, openExternalUrl } from './cicdUrlUtils';
import { BuildLogModalContainer } from './BuildLogModalContainer';
import { DevicePoolModalContainer } from './DevicePoolModalContainer';
import { InstallQrModal } from './InstallQrModal';
import { QualityReportModalContainer } from './QualityReportModalContainer';
import { QualityStartModalContainer } from './QualityStartModalContainer';
import { ReleaseBranchModalContainer } from './ReleaseBranchModalContainer';
import { ReleasePublishModalContainer } from './ReleasePublishModalContainer';
import type { CicdPageController } from './useCicdPageController';

interface CicdModalsProps {
  controller: CicdPageController;
}

export function CicdModals({
  controller,
}: CicdModalsProps) {
  const {
    permissions,
    releaseBuilds,
    releaseBranches,
    releasePublishModal,
    releasePublishController,
    releaseBranchModal,
    buildLogModal,
    qualityBuilds,
    qualityStartModal,
    qualityDevicePools,
    qualityReportModal,
    derivedOptions,
    pageActions,
    qrPreview,
    setQrPreview,
  } = controller;
  const {
    canOperateCicd,
    canPublishPgyerOrTestFlight,
    canPublishAppStore,
    canUseQuality,
  } = permissions;
  const {
    availableDeployTargetOptions,
    publishBranchOptions,
    publishGateBuildOptions,
    releaseBaseBranchOptions,
  } = derivedOptions;
  const sourceBuilds = releaseBuilds.data?.builds || [];

  return (
    <>
      <ReleaseBranchModalContainer
        modal={releaseBranchModal}
        baseBranchOptions={releaseBaseBranchOptions}
        branchLoading={releaseBranches.loading}
        onRefreshBranches={releaseBranches.loadBranches}
      />

      <ReleasePublishModalContainer
        modal={releasePublishModal}
        validation={releasePublishController.validation}
        releasePreflightBlocked={releasePublishController.validationState.releasePreflightBlocked}
        appStoreGatePending={releasePublishController.validationState.appStoreGatePending}
        appStoreGateBlocked={releasePublishController.validationState.appStoreGateBlocked}
        appStoreGateWarningNeedsReason={releasePublishController.validationState.appStoreGateWarningNeedsReason}
        canOperateCicd={canOperateCicd}
        canPublishPgyerOrTestFlight={canPublishPgyerOrTestFlight}
        canPublishAppStore={canPublishAppStore}
        deployTargetOptions={availableDeployTargetOptions}
        publishBranchOptions={publishBranchOptions}
        branchLoading={releaseBranches.loading}
        branches={releaseBranches.branches}
        gateBuildOptions={publishGateBuildOptions}
        sourceBuilds={sourceBuilds}
        onPublish={releasePublishController.publish}
        onRefreshBranches={releaseBranches.loadBranches}
        onOpenUrl={openExternalUrl}
        onRunMissingSuite={pageActions.runMissingQualitySuite}
      />

      <QualityStartModalContainer
        modal={qualityStartModal}
        builds={sourceBuilds}
        devicePools={qualityDevicePools.pools}
        canUseQuality={Boolean(canUseQuality)}
        qualityData={qualityBuilds.data}
        refreshSection={qualityBuilds.refreshSection}
        refreshUntilUpdated={qualityBuilds.refreshUntilUpdated}
      />

      <QualityReportModalContainer modal={qualityReportModal} />

      <DevicePoolModalContainer
        pools={qualityDevicePools}
        hasRunningQualityBuild={qualityBuilds.hasRunningBuild}
        cleaningQualityWda={qualityBuilds.cleaningWda}
        onCleanupWda={() => qualityBuilds.cleanupWda()}
      />

      <BuildLogModalContainer
        modal={buildLogModal}
        canPublishAppStore={canPublishAppStore}
        cancelingAppStoreReview={releaseBuilds.cancelingAppStoreReview}
        onCancelAppStoreReview={releaseBuilds.cancelAppStoreReview}
      />

      <InstallQrModal
        preview={qrPreview}
        normalizeUrl={normalizeOpenUrl}
        onOpenUrl={openExternalUrl}
        onClose={() => setQrPreview(null)}
      />
    </>
  );
}
