import {
  formatBuildTime,
  formatDuration,
  getChannelBuildNumber,
} from './cicdFormatters';
import { openExternalUrl } from './cicdUrlUtils';
import { DEPLOY_TARGET_OPTIONS, publishChannelLabel } from './qualityOptions';
import { buildStatusTags } from './qualityStatus';
import { ReleaseSection } from './ReleaseSection';
import type { CicdPageController } from './useCicdPageController';

interface ReleaseSectionContainerProps {
  controller: CicdPageController;
}

export function ReleaseSectionContainer({
  controller,
}: ReleaseSectionContainerProps) {
  const {
    releaseBuilds,
    releaseBranches,
    permissions,
    derivedOptions,
    filters,
    pageActions,
    buildLogModal,
    setQrPreview,
  } = controller;

  return (
    <ReleaseSection
      error={releaseBuilds.error}
      data={releaseBuilds.data}
      stats={derivedOptions.stats}
      loading={releaseBuilds.loading}
      builds={releaseBuilds.data?.builds || []}
      isAdmin={permissions.isAdmin}
      canUseQuality={permissions.canUseQuality}
      canPublishPgyerOrTestFlight={permissions.canPublishPgyerOrTestFlight}
      canPublishAppStore={permissions.canPublishAppStore}
      stoppingBuild={releaseBuilds.stoppingBuild}
      cancelingAppStoreReview={releaseBuilds.cancelingAppStoreReview}
      filterBranchName={filters.branchName}
      filterDeployTarget={filters.deployTarget}
      branchLoading={releaseBranches.loading}
      branchOptions={derivedOptions.buildBranchFilterOptions}
      deployTargetOptions={DEPLOY_TARGET_OPTIONS}
      publishChannelLabel={publishChannelLabel}
      getChannelBuildNumber={getChannelBuildNumber}
      formatBuildTime={formatBuildTime}
      formatDuration={formatDuration}
      renderBuildStatus={buildStatusTags}
      onBranchFilterChange={(nextBranch) => {
        filters.setBranchName(nextBranch);
        releaseBuilds.loadBuilds(filters.deployTarget, undefined, nextBranch);
      }}
      onDeployTargetFilterChange={(value) => {
        filters.setDeployTarget(value);
        releaseBuilds.loadBuilds(value, undefined, filters.branchName);
      }}
      onOpenUrl={openExternalUrl}
      onShowBuildLog={buildLogModal.showBuildLog}
      onOpenQuality={pageActions.openQualityModal}
      onOpenPgyerPublish={pageActions.openPgyerPublish}
      onCancelAppStoreReview={releaseBuilds.cancelAppStoreReview}
      onStopBuild={releaseBuilds.stopBuild}
      onQrPreview={setQrPreview}
    />
  );
}
