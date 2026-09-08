import { formatBuildTime, formatSeconds } from './cicdFormatters';
import { openExternalUrl } from './cicdUrlUtils';
import { publishChannelLabel, qualitySuiteLabel } from './qualityOptions';
import {
  isQualityBuildEffectivelyRunning,
  progressElapsedSeconds,
  progressPercent,
  progressRemainingSeconds,
  progressStatus,
  qualityPhaseLabel,
  qualityResultTag,
} from './qualityStatus';
import { QualitySection } from './QualitySection';
import type { CicdPageController } from './useCicdPageController';

interface QualitySectionContainerProps {
  controller: CicdPageController;
}

export function QualitySectionContainer({
  controller,
}: QualitySectionContainerProps) {
  const {
    permissions,
    releaseBuilds,
    qualityBuilds,
    qualityDevicePools,
    qualityReportModal,
    derivedOptions,
    pageActions,
  } = controller;

  return (
    <QualitySection
      error={qualityBuilds.error}
      data={qualityBuilds.data}
      devicePoolStatus={qualityDevicePools.status}
      devicePools={qualityDevicePools.pools}
      devicePoolError={qualityDevicePools.loadError}
      canAdmin={permissions.canAdminCicd}
      unassignedTargetPool={qualityDevicePools.unassignedTargetPool}
      addingDevicePool={qualityDevicePools.adding}
      jobLoading={qualityBuilds.loading}
      sourceLoading={releaseBuilds.loading}
      isAdmin={permissions.isAdmin}
      canUseQuality={permissions.canUseQuality}
      canOpenQualityModal={derivedOptions.canOpenQualityModal}
      stoppingQualityBuild={qualityBuilds.stoppingBuild}
      publishChannelLabel={publishChannelLabel}
      qualitySuiteLabel={qualitySuiteLabel}
      qualityPhaseLabel={qualityPhaseLabel}
      qualityResultTag={qualityResultTag}
      isQualityBuildEffectivelyRunning={isQualityBuildEffectivelyRunning}
      progressPercent={progressPercent}
      progressStatus={progressStatus}
      progressElapsedSeconds={progressElapsedSeconds}
      progressRemainingSeconds={progressRemainingSeconds}
      formatSeconds={formatSeconds}
      formatBuildTime={formatBuildTime}
      onUnassignedTargetPoolChange={qualityDevicePools.setUnassignedTargetPool}
      onAddUnassignedDevices={qualityDevicePools.addUnassignedDevicesToPool}
      onOpenUrl={openExternalUrl}
      onOpenQualityModal={pageActions.openQualityModal}
      onOpenQualityReport={(record) => { void qualityReportModal.open(record); }}
      onStopQualityBuild={qualityBuilds.stopBuild}
    />
  );
}
