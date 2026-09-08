import { JenkinsBuild, JenkinsQualitySuite, QualityDevicePool } from '../../services/api';
import { defaultQualityDeviceUdids } from './devicePoolUtils';
import { shouldUseInstalledProductionApp } from './qualityOptions';

export const DEFAULT_QUALITY_SUITE: JenkinsQualitySuite = 'monkey';
export const DEFAULT_MONKEY_DURATION_SECONDS = 14400;
export const DEFAULT_STUTTER_SCENARIO = 'community';
export const DEFAULT_BUSINESS_FLOW_FEATURES = ['community/root', 'community/search', 'community/home'];

export function pickFallbackQualityBuild(builds?: JenkinsBuild[], preferredBuild?: JenkinsBuild) {
  return preferredBuild || builds?.find((item) => item.result === 'SUCCESS') || builds?.[0] || null;
}

export function pickDefaultQualityDevicePool(pools: QualityDevicePool[]) {
  return pools.find((pool) => (pool.stats?.idle || 0) > 0)?.value || pools[0]?.value || 'ios-default';
}

export function buildQualityModalDefaults(params: {
  build?: JenkinsBuild;
  builds?: JenkinsBuild[];
  pools: QualityDevicePool[];
}) {
  const fallbackBuild = pickFallbackQualityBuild(params.builds, params.build);
  const devicePool = pickDefaultQualityDevicePool(params.pools);
  return {
    build: fallbackBuild,
    suite: DEFAULT_QUALITY_SUITE,
    durationSeconds: DEFAULT_MONKEY_DURATION_SECONDS,
    stutterScenario: DEFAULT_STUTTER_SCENARIO,
    businessFlowFeatures: [...DEFAULT_BUSINESS_FLOW_FEATURES],
    devicePool,
    deviceUdids: defaultQualityDeviceUdids(params.pools, devicePool),
    skipInstall: shouldUseInstalledProductionApp(fallbackBuild),
  };
}
