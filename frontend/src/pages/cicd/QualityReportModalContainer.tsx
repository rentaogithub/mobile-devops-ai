import { openPerformanceTrace, openExternalUrl } from './cicdUrlUtils';
import { QualityReportModal } from './QualityReportModal';
import {
  formatMilliseconds,
  formatSeconds,
} from './cicdFormatters';
import {
  formatMonkeyExecutionSummary,
  formatQualityDuration,
  hasQualityReportArtifact,
  isQualityBuildEffectivelyRunning,
  qualitySummaryStatusMeta,
} from './qualityStatus';
import { getQualityReportDisplayMeta } from './qualityReportUtils';
import { stutterScenarioLabel } from './qualityOptions';
import type { useQualityReportModal } from './useQualityReportModal';

interface QualityReportModalContainerProps {
  modal: ReturnType<typeof useQualityReportModal>;
}

export function QualityReportModalContainer({ modal }: QualityReportModalContainerProps) {
  const meta = getQualityReportDisplayMeta(modal.build);
  return (
    <QualityReportModal
      build={modal.build}
      title={meta.title}
      activeView={modal.activeView}
      isMonkeyReport={meta.isMonkeyReport}
      isStutterReport={meta.isStutterReport}
      isBusinessFlowReport={meta.isBusinessFlowReport}
      reportKind={meta.kind}
      performanceButtonLabel={meta.performanceButtonLabel}
      performanceLoading={modal.performanceLoading}
      artifactPreview={modal.artifactPreview}
      artifactPreviewLoading={modal.artifactPreviewLoading}
      logDigest={modal.logDigest}
      logDigestLoading={modal.logDigestLoading}
      performanceSamples={modal.performanceSamples}
      statusMeta={modal.build ? qualitySummaryStatusMeta(modal.build) : null}
      stutterScenarioLabel={stutterScenarioLabel}
      formatQualityDuration={formatQualityDuration}
      formatMonkeyExecutionSummary={formatMonkeyExecutionSummary}
      formatMilliseconds={formatMilliseconds}
      formatSeconds={formatSeconds}
      isRunning={isQualityBuildEffectivelyRunning}
      hasArtifact={hasQualityReportArtifact}
      onOpenUrl={openExternalUrl}
      onOpenTrace={openPerformanceTrace}
      onClose={modal.close}
      onSetActiveView={modal.setActiveView}
      onSetArtifactPreview={modal.setArtifactPreview}
      onSetPerformanceSamples={modal.setPerformanceSamples}
      onPreviewArtifact={modal.previewArtifact}
      onOpenPerformance={modal.openPerformance}
    />
  );
}
