import { JenkinsBuild, JenkinsQualityListResult, SonicDevicePool } from '../../services/api';
import { QualityStartModal } from './QualityStartModal';
import {
  BUSINESS_FLOW_FEATURE_GROUPS,
  MONKEY_DURATION_OPTIONS,
  QUALITY_SUITE_GROUPS,
  STUTTER_SCENARIO_OPTIONS,
  publishChannelLabel,
  shouldUseInstalledProductionApp,
} from './qualityOptions';
import { useQualityDeviceSelection } from './useQualityDeviceSelection';
import { useQualityStartModal } from './useQualityStartModal';
import { useQualityTrigger } from './useQualityTrigger';

interface QualityStartModalContainerProps {
  modal: ReturnType<typeof useQualityStartModal>;
  builds: JenkinsBuild[];
  devicePools: SonicDevicePool[];
  canUseQuality: boolean;
  qualityData?: JenkinsQualityListResult | null;
  refreshSection: () => Promise<unknown>;
  refreshUntilUpdated: (previousLatest?: number | string) => Promise<void>;
}

export function QualityStartModalContainer({
  modal,
  builds,
  devicePools,
  canUseQuality,
  qualityData,
  refreshSection,
  refreshUntilUpdated,
}: QualityStartModalContainerProps) {
  const {
    availablePools,
    selectedPool,
    availableDevices,
  } = useQualityDeviceSelection({
    pools: devicePools,
    selectedPoolValue: modal.devicePool,
    modalOpen: modal.open,
    setDeviceUdids: modal.setDeviceUdids,
  });
  const { triggerQuality } = useQualityTrigger({
    canUseQuality,
    form: modal,
    selectedPool,
    availableDevices,
    qualityData,
    onSubmittingChange: modal.setSubmitting,
    onSubmitMessageChange: modal.setSubmitMessage,
    onSubmitted: modal.close,
    refreshSection,
    refreshUntilUpdated,
  });

  return (
    <QualityStartModal
      open={modal.open}
      submitting={modal.submitting}
      submitMessage={modal.submitMessage}
      builds={builds}
      selectedBuild={modal.build}
      qualitySuite={modal.suite}
      qualitySuiteGroups={QUALITY_SUITE_GROUPS}
      durationOptions={MONKEY_DURATION_OPTIONS}
      durationSeconds={modal.durationSeconds}
      stutterScenarioOptions={STUTTER_SCENARIO_OPTIONS}
      stutterScenario={modal.stutterScenario}
      businessFlowFeatureGroups={BUSINESS_FLOW_FEATURE_GROUPS}
      businessFlowFeatures={modal.businessFlowFeatures}
      skipInstall={modal.skipInstall}
      availableDevicePools={availablePools}
      availableDevices={availableDevices}
      selectedDeviceUdids={modal.deviceUdids}
      publishChannelLabel={publishChannelLabel}
      shouldUseInstalledProductionApp={shouldUseInstalledProductionApp}
      onBuildChange={modal.setBuild}
      onQualitySuiteChange={modal.setSuite}
      onDurationChange={modal.setDurationSeconds}
      onStutterScenarioChange={modal.setStutterScenario}
      onBusinessFlowFeaturesChange={modal.setBusinessFlowFeatures}
      onSkipInstallChange={modal.setSkipInstall}
      onDeviceUdidsChange={modal.setDeviceUdids}
      onSubmit={triggerQuality}
      onClose={modal.close}
    />
  );
}
