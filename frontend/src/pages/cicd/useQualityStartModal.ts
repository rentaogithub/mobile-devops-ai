import { useState } from 'react';

import { JenkinsBuild, JenkinsQualitySuite, QualityDevicePool } from '../../services/api';
import {
  DEFAULT_BUSINESS_FLOW_FEATURES,
  DEFAULT_MONKEY_DURATION_SECONDS,
  DEFAULT_QUALITY_SUITE,
  DEFAULT_STUTTER_SCENARIO,
  buildQualityModalDefaults,
} from './qualityFormDefaults';
import { DEVELOPMENT_BUNDLE_ID, InstalledAppBundleId } from './qualityOptions';

interface OpenQualityStartModalParams {
  selectedBuild?: JenkinsBuild;
  builds?: JenkinsBuild[];
  pools: QualityDevicePool[];
}

export function useQualityStartModal() {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState('');
  const [build, setBuild] = useState<JenkinsBuild | null>(null);
  const [suite, setSuite] = useState<JenkinsQualitySuite>(DEFAULT_QUALITY_SUITE);
  const [durationSeconds, setDurationSeconds] = useState(DEFAULT_MONKEY_DURATION_SECONDS);
  const [stutterScenario, setStutterScenario] = useState(DEFAULT_STUTTER_SCENARIO);
  const [businessFlowFeatures, setBusinessFlowFeatures] = useState<string[]>(DEFAULT_BUSINESS_FLOW_FEATURES);
  const [replayFlowAssetId, setReplayFlowAssetId] = useState('');
  const [replayFlowVersionId, setReplayFlowVersionId] = useState('');
  const [replayFlowInputs, setReplayFlowInputs] = useState<Record<string, string>>({});
  const [devicePool, setDevicePool] = useState('ios-default');
  const [deviceUdids, setDeviceUdids] = useState<string[]>([]);
  const [skipInstall, setSkipInstall] = useState(false);
  const [installedAppBundleId, setInstalledAppBundleId] = useState<InstalledAppBundleId>(DEVELOPMENT_BUNDLE_ID);

  const openWithDefaults = ({ selectedBuild, builds, pools }: OpenQualityStartModalParams) => {
    const defaults = buildQualityModalDefaults({ build: selectedBuild, builds, pools });
    setSubmitMessage('');
    setBuild(defaults.build);
    setSuite(defaults.suite);
    setDurationSeconds(defaults.durationSeconds);
    setStutterScenario(defaults.stutterScenario);
    setBusinessFlowFeatures(defaults.businessFlowFeatures);
    setReplayFlowAssetId('');
    setReplayFlowVersionId('');
    setReplayFlowInputs({});
    setDevicePool(defaults.devicePool);
    setDeviceUdids(defaults.deviceUdids);
    setSkipInstall(defaults.skipInstall);
    setInstalledAppBundleId(defaults.installedAppBundleId);
    setOpen(true);
  };

  const close = () => {
    setSubmitMessage('');
    setOpen(false);
  };

  return {
    open,
    submitting,
    submitMessage,
    build,
    suite,
    durationSeconds,
    stutterScenario,
    businessFlowFeatures,
    replayFlowAssetId,
    replayFlowVersionId,
    replayFlowInputs,
    devicePool,
    deviceUdids,
    skipInstall,
    installedAppBundleId,
    setOpen,
    setSubmitting,
    setSubmitMessage,
    setBuild,
    setSuite,
    setDurationSeconds,
    setStutterScenario,
    setBusinessFlowFeatures,
    setReplayFlowAssetId,
    setReplayFlowVersionId,
    setReplayFlowInputs,
    setDevicePool,
    setDeviceUdids,
    setSkipInstall,
    setInstalledAppBundleId,
    openWithDefaults,
    close,
  };
}
