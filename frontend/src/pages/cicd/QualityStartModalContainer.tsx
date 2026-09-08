import { useEffect, useMemo, useState } from 'react';
import { message } from 'antd';
import {
  deviceControlApi,
  JenkinsBuild,
  JenkinsQualityListResult,
  QualityDevicePool,
  ReplayFlowAssetSummary,
  ReplayFlowVersion,
  ReplayFlowVersionSummary,
} from '../../services/api';
import { QualityStartModal, ReplayFlowQualityInputField } from './QualityStartModal';
import {
  BUSINESS_FLOW_FEATURE_GROUPS,
  INSTALLED_APP_BUNDLE_OPTIONS,
  installedAppBundleIdForBuild,
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
  devicePools: QualityDevicePool[];
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
  const [replayFlowLoading, setReplayFlowLoading] = useState(false);
  const [replayFlowAssets, setReplayFlowAssets] = useState<ReplayFlowAssetSummary[]>([]);
  const [publishedVersions, setPublishedVersions] = useState<ReplayFlowVersionSummary[]>([]);
  const [selectedReplayChain, setSelectedReplayChain] = useState<Array<{ phase: 'pre' | 'main' | 'post'; version: ReplayFlowVersion }>>([]);

  useEffect(() => {
    if (!modal.open) return;
    let cancelled = false;
    setReplayFlowLoading(true);
    Promise.all([
      deviceControlApi.listReplayFlowAssets({ status: 'published', limit: 500 }),
      deviceControlApi.listPublishedReplayFlowVersions(),
    ])
      .then(([assetResponse, versionResponse]) => {
        if (cancelled) return;
        const assets = (assetResponse.data?.assets || []).filter((asset) => Boolean(asset.latestVersionId));
        const versions = versionResponse.data?.versions || [];
        setReplayFlowAssets(assets);
        setPublishedVersions(versions);
        const current = assets.find((asset) => asset.id === modal.replayFlowAssetId) || assets[0];
        if (current && current.id !== modal.replayFlowAssetId) {
          modal.setReplayFlowAssetId(current.id);
          modal.setReplayFlowVersionId(current.latestVersionId || '');
          modal.setReplayFlowInputs({});
        }
      })
      .catch((error: any) => {
        if (!cancelled) message.error(error?.error || error?.message || '加载回放中心任务失败');
      })
      .finally(() => {
        if (!cancelled) setReplayFlowLoading(false);
      });
    return () => { cancelled = true; };
  }, [modal.open]);

  useEffect(() => {
    if (!modal.open || modal.suite !== 'replay_flow' || !modal.replayFlowAssetId || !modal.replayFlowVersionId) {
      setSelectedReplayChain([]);
      return;
    }
    let cancelled = false;
    setReplayFlowLoading(true);
    deviceControlApi.getReplayFlowAsset(modal.replayFlowAssetId)
      .then(async (assetResponse) => {
        const asset = assetResponse.data!.asset;
        const phaseRequests: Array<Promise<{ phase: 'pre' | 'main' | 'post'; version: ReplayFlowVersion }>> = [];
        if (asset.preFlowVersionId) {
          phaseRequests.push(deviceControlApi.getReplayFlowVersion(asset.preFlowVersionId).then((response) => ({ phase: 'pre' as const, version: response.data!.version })));
        }
        phaseRequests.push(deviceControlApi.getReplayFlowVersion(modal.replayFlowVersionId).then((response) => ({ phase: 'main' as const, version: response.data!.version })));
        if (asset.postFlowVersionId) {
          phaseRequests.push(deviceControlApi.getReplayFlowVersion(asset.postFlowVersionId).then((response) => ({ phase: 'post' as const, version: response.data!.version })));
        }
        const chain = await Promise.all(phaseRequests);
        if (cancelled) return;
        setSelectedReplayChain(chain);
        const defaults: Record<string, string> = {};
        chain.forEach(({ version }) => {
          Object.entries(version.flow.inputs || {}).forEach(([name, definition]) => {
            if (modal.replayFlowInputs[name] === undefined && defaults[name] === undefined && definition.default !== undefined) {
              defaults[name] = definition.default;
            }
          });
        });
        if (Object.keys(defaults).length > 0) modal.setReplayFlowInputs({ ...defaults, ...modal.replayFlowInputs });
      })
      .catch((error: any) => {
        if (!cancelled) message.error(error?.error || error?.message || '加载回放任务版本链失败');
      })
      .finally(() => {
        if (!cancelled) setReplayFlowLoading(false);
      });
    return () => { cancelled = true; };
  }, [modal.open, modal.suite, modal.replayFlowAssetId, modal.replayFlowVersionId]);

  const replayFlowVersions = useMemo(
    () => publishedVersions.filter((version) => version.assetId === modal.replayFlowAssetId),
    [publishedVersions, modal.replayFlowAssetId],
  );
  const replayFlowInputFields = useMemo(() => {
    const fields = new Map<string, ReplayFlowQualityInputField>();
    selectedReplayChain.forEach(({ version }) => {
      Object.entries(version.flow.inputs || {}).forEach(([name, definition]) => {
        const current = fields.get(name);
        fields.set(name, {
          name,
          required: Boolean(definition.required || current?.required),
          defaultValue: current?.defaultValue ?? definition.default,
          description: current?.description || definition.description,
          usedBy: [...(current?.usedBy || []), `${version.assetName} v${version.versionNumber}`],
        });
      });
    });
    return [...fields.values()];
  }, [selectedReplayChain]);
  const replayFlowChainLabels = selectedReplayChain.map(({ phase, version }) => (
    `${phase === 'pre' ? '前置' : phase === 'post' ? '后置' : '主流程'}：${version.assetName} v${version.versionNumber}`
  ));
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
    form: {
      ...modal,
      replayFlowRequiredInputNames: replayFlowInputFields
        .filter((field) => field.required && !field.defaultValue)
        .map((field) => field.name),
    },
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
      replayFlowLoading={replayFlowLoading}
      replayFlowAssets={replayFlowAssets}
      replayFlowVersions={replayFlowVersions}
      replayFlowAssetId={modal.replayFlowAssetId}
      replayFlowVersionId={modal.replayFlowVersionId}
      replayFlowChainLabels={replayFlowChainLabels}
      replayFlowInputFields={replayFlowInputFields}
      replayFlowInputs={modal.replayFlowInputs}
      skipInstall={modal.skipInstall}
      installedAppBundleId={modal.installedAppBundleId}
      installedAppBundleOptions={INSTALLED_APP_BUNDLE_OPTIONS}
      availableDevicePools={availablePools}
      availableDevices={availableDevices}
      selectedDeviceUdids={modal.deviceUdids}
      publishChannelLabel={publishChannelLabel}
      shouldUseInstalledProductionApp={shouldUseInstalledProductionApp}
      onBuildChange={(build) => {
        modal.setBuild(build);
        modal.setInstalledAppBundleId(installedAppBundleIdForBuild(build));
      }}
      onQualitySuiteChange={modal.setSuite}
      onDurationChange={modal.setDurationSeconds}
      onStutterScenarioChange={modal.setStutterScenario}
      onBusinessFlowFeaturesChange={modal.setBusinessFlowFeatures}
      onReplayFlowAssetChange={(assetId) => {
        const asset = replayFlowAssets.find((item) => item.id === assetId);
        modal.setReplayFlowAssetId(assetId);
        modal.setReplayFlowVersionId(asset?.latestVersionId || '');
        modal.setReplayFlowInputs({});
      }}
      onReplayFlowVersionChange={(versionId) => {
        modal.setReplayFlowVersionId(versionId);
        modal.setReplayFlowInputs({});
      }}
      onReplayFlowInputChange={(name, value) => modal.setReplayFlowInputs({ ...modal.replayFlowInputs, [name]: value })}
      onSkipInstallChange={modal.setSkipInstall}
      onInstalledAppBundleIdChange={modal.setInstalledAppBundleId}
      onDeviceUdidsChange={modal.setDeviceUdids}
      onSubmit={triggerQuality}
      onClose={modal.close}
    />
  );
}
