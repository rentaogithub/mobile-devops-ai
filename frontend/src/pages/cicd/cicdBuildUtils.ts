import { JenkinsBuild } from '../../services/api';

export function canAnalyzeBuildFailure(build?: JenkinsBuild, log?: string) {
  if (!build) return false;
  if (build.result === 'FAILURE') return true;
  if (build.result === 'SUCCESS') return false;
  return /Finished:\s+FAILURE|fastlane finished with errors|构建失败|上传失败/i.test(log || '');
}

export function isPendingTestFlightDistribution(build: JenkinsBuild) {
  return build.publishChannel === 'TestFlight' &&
    build.result === 'SUCCESS' &&
    (!build.testFlightDistribution || ['waiting_processing', 'uploaded', 'ready_for_submission', 'in_beta_review'].includes(String(build.testFlightDistribution.status || '')));
}

export function isPendingAppStoreRelease(build: JenkinsBuild) {
  return build.publishChannel === 'AppStore' &&
    build.result === 'SUCCESS' &&
    (!build.appStoreRelease || ['waiting_processing', 'uploaded', 'ready_for_review', 'waiting_for_review', 'in_review', 'pending_release', 'ready_for_distribution'].includes(String(build.appStoreRelease.status || '')));
}

export function buildRunningBuildNumbersKey(builds?: JenkinsBuild[]) {
  return (builds || [])
    .filter((build) => build.building)
    .map((build) => String(build.number))
    .sort()
    .join(',');
}

export function buildPendingTestFlightDistributionKey(builds?: JenkinsBuild[]) {
  return (builds || [])
    .filter(isPendingTestFlightDistribution)
    .map((build) => `${build.number}:${build.testFlightDistribution?.status || 'pending'}`)
    .sort()
    .join(',');
}

export function buildPendingAppStoreReleaseKey(builds?: JenkinsBuild[]) {
  return (builds || [])
    .filter(isPendingAppStoreRelease)
    .map((build) => `${build.number}:${build.appStoreRelease?.status || 'pending'}`)
    .sort()
    .join(',');
}

export function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}
