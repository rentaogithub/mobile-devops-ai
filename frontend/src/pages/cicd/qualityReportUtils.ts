import { JenkinsQualityBuild } from '../../services/api';
import { getQualityReportKind, getQualityReportTitle } from './qualityOptions';

export function isBusinessFlowQualityBuild(build?: JenkinsQualityBuild | null) {
  return build?.qualitySummary?.testSuite === 'business_flow';
}

export function getBusinessFlowReportUrl(build?: JenkinsQualityBuild | null) {
  return build?.qualitySummary?.artifacts?.businessFlowReportUrl;
}

export function hasPerformanceReport(build?: JenkinsQualityBuild | null) {
  return Boolean(
    build?.qualitySummary?.performanceAnalysis ||
    build?.qualitySummary?.artifacts?.performanceSamplesUrl ||
    build?.qualitySummary?.artifacts?.performanceTraceUrl
  );
}

export function getPerformanceSamplesUrl(build?: JenkinsQualityBuild | null) {
  return build?.qualitySummary?.artifacts?.performanceSamplesUrl;
}

export function getQualityReportDisplayMeta(build?: JenkinsQualityBuild | null) {
  const kind = getQualityReportKind(build);
  return {
    kind,
    title: getQualityReportTitle(build),
    isMonkeyReport: kind === 'monkey',
    isStutterReport: kind === 'stutter',
    isBusinessFlowReport: kind === 'business_flow',
    performanceButtonLabel: kind === 'stutter' ? '卡顿报告' : '性能报告',
  };
}
