import { BuildLogModal } from './BuildLogModal';
import { getChannelBuildNumber } from './cicdFormatters';
import { shouldUseInstalledProductionApp } from './qualityOptions';
import type { useBuildLogModal } from './useBuildLogModal';

interface BuildLogModalContainerProps {
  modal: ReturnType<typeof useBuildLogModal>;
  canPublishAppStore?: boolean;
  cancelingAppStoreReview?: number | null;
  onCancelAppStoreReview: (buildNumber: number) => void;
}

export function BuildLogModalContainer({
  modal,
  canPublishAppStore,
  cancelingAppStoreReview,
  onCancelAppStoreReview,
}: BuildLogModalContainerProps) {
  return (
    <BuildLogModal
      open={modal.open}
      selectedBuildLog={modal.selectedBuildLog}
      logLoading={modal.loading}
      canPublishAppStore={canPublishAppStore}
      cancelingAppStoreReview={cancelingAppStoreReview}
      buildFailureAnalysis={modal.buildFailureAnalysis}
      buildFailureAnalysisLoading={modal.buildFailureAnalysisLoading}
      packageSizeAnalysis={modal.packageSizeAnalysis}
      packageSizeLoading={modal.packageSizeLoading}
      packageSizeError={modal.packageSizeError}
      getChannelBuildNumber={getChannelBuildNumber}
      shouldUseInstalledProductionApp={shouldUseInstalledProductionApp}
      onClose={modal.closeBuildLog}
      onDownloadLog={modal.downloadBuildLog}
      onCancelAppStoreReview={onCancelAppStoreReview}
      onEnsureBuildFailureAnalysis={modal.ensureBuildFailureAnalysis}
      onAnalyzeBuildFailure={modal.analyzeSelectedBuildFailure}
      onEnsurePackageSizeAnalysis={modal.ensurePackageSizeAnalysis}
    />
  );
}
