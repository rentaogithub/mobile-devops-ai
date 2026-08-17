import { useState } from 'react';

import { JenkinsBuild, JenkinsQualitySuite, SonicDevicePool } from '../../services/api';
import {
  DEFAULT_BUSINESS_FLOW_FEATURES,
  DEFAULT_MONKEY_DURATION_SECONDS,
  DEFAULT_QUALITY_SUITE,
  DEFAULT_STUTTER_SCENARIO,
  buildQualityModalDefaults,
} from './qualityFormDefaults';

interface OpenQualityStartModalParams {
  selectedBuild?: JenkinsBuild;
  builds?: JenkinsBuild[];
  pools: SonicDevicePool[];
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
  const [devicePool, setDevicePool] = useState('ios-default');
  const [deviceUdids, setDeviceUdids] = useState<string[]>([]);
  const [skipInstall, setSkipInstall] = useState(false);

  const openWithDefaults = ({ selectedBuild, builds, pools }: OpenQualityStartModalParams) => {
    const defaults = buildQualityModalDefaults({ build: selectedBuild, builds, pools });
    setSubmitMessage('');
    setBuild(defaults.build);
    setSuite(defaults.suite);
    setDurationSeconds(defaults.durationSeconds);
    setStutterScenario(defaults.stutterScenario);
    setBusinessFlowFeatures(defaults.businessFlowFeatures);
    setDevicePool(defaults.devicePool);
    setDeviceUdids(defaults.deviceUdids);
    setSkipInstall(defaults.skipInstall);
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
    devicePool,
    deviceUdids,
    skipInstall,
    setOpen,
    setSubmitting,
    setSubmitMessage,
    setBuild,
    setSuite,
    setDurationSeconds,
    setStutterScenario,
    setBusinessFlowFeatures,
    setDevicePool,
    setDeviceUdids,
    setSkipInstall,
    openWithDefaults,
    close,
  };
}
