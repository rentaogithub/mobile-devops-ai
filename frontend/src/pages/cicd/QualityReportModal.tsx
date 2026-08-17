import { Alert, Button, Card, Empty, Modal, Space, Tag, Typography } from 'antd';
import {
  JenkinsQualityArtifactPreview,
  JenkinsQualityBuild,
  JenkinsQualityPerformanceSamples,
} from '../../services/api';
import { BusinessFlowReportSummary } from './BusinessFlowReportSummary';
import { CrashAnalysisSummary } from './CrashAnalysisSummary';
import { MonkeyReportSummary } from './MonkeyReportSummary';
import { PerformanceSamplesChart } from './PerformanceSamplesChart';
import { PerformanceAnalysisSummary, PerformanceDiagnostics, StutterReportSummary } from './PerformanceReportPanels';
import { QualityArtifactPreviewCard } from './QualityArtifactPreviewCard';
import { QualityEvidenceCard } from './QualityEvidenceCard';
import { QualityLogDigest } from './QualityLogDigest';
import { QualityLogSection } from './QualityLogSection';
import { QualityReportFooter } from './QualityReportFooter';
import { QualityReportHeader } from './QualityReportHeader';
import { QualityReportMissingArtifactAlert } from './QualityReportMissingArtifactAlert';
import { QualityReportSectionCard } from './QualityReportSectionCard';
import { QualityReportToolbar } from './QualityReportToolbar';
import { QualityReportKind } from './qualityOptions';
import { QualitySummaryView } from './qualityReportTypes';

const { Text } = Typography;

interface QualityReportModalProps {
  build: JenkinsQualityBuild | null;
  title: string;
  activeView: QualitySummaryView;
  isMonkeyReport: boolean;
  isStutterReport: boolean;
  isBusinessFlowReport: boolean;
  reportKind: QualityReportKind;
  performanceButtonLabel: string;
  performanceLoading?: boolean;
  artifactPreview: (JenkinsQualityArtifactPreview & { title: string }) | null;
  artifactPreviewLoading?: boolean;
  logDigest: JenkinsQualityArtifactPreview | null;
  logDigestLoading?: boolean;
  performanceSamples: JenkinsQualityPerformanceSamples | null;
  statusMeta: { type: 'success' | 'error' | 'warning' | 'info'; message: string } | null;
  stutterScenarioLabel: (value?: string) => string;
  formatQualityDuration: (build: JenkinsQualityBuild) => string;
  formatMonkeyExecutionSummary: (build: JenkinsQualityBuild) => string;
  formatMilliseconds: (value?: number | string | null) => string;
  formatSeconds: (value?: number | null) => string;
  isRunning: (build: JenkinsQualityBuild) => boolean;
  hasArtifact: (build?: JenkinsQualityBuild | null) => boolean;
  onOpenUrl: (url?: string) => void;
  onOpenTrace: (url?: string) => void;
  onClose: () => void;
  onSetActiveView: (view: QualitySummaryView) => void;
  onSetArtifactPreview: (preview: (JenkinsQualityArtifactPreview & { title: string }) | null) => void;
  onSetPerformanceSamples: (samples: JenkinsQualityPerformanceSamples | null) => void;
  onPreviewArtifact: (title: string, url?: string) => void;
  onOpenPerformance: () => void;
}

export function QualityReportModal({
  build,
  title,
  activeView,
  isMonkeyReport,
  isStutterReport,
  isBusinessFlowReport,
  reportKind,
  performanceButtonLabel,
  performanceLoading,
  artifactPreview,
  artifactPreviewLoading,
  logDigest,
  logDigestLoading,
  performanceSamples,
  statusMeta,
  stutterScenarioLabel,
  formatQualityDuration,
  formatMonkeyExecutionSummary,
  formatMilliseconds,
  formatSeconds,
  isRunning,
  hasArtifact,
  onOpenUrl,
  onOpenTrace,
  onClose,
  onSetActiveView,
  onSetArtifactPreview,
  onSetPerformanceSamples,
  onPreviewArtifact,
  onOpenPerformance,
}: QualityReportModalProps) {
  return (
    <Modal
      title={build ? `质检报告 - #${build.number}` : '质检报告'}
      open={!!build}
      width="78vw"
      footer={(
        <QualityReportFooter
          qualityLogUrl={build?.qualitySummary?.artifacts?.qualityLogUrl}
          junitUrl={build?.qualitySummary?.artifacts?.junitUrl}
          onOpenUrl={onOpenUrl}
          onClose={onClose}
        />
      )}
      onCancel={onClose}
    >
      {build && statusMeta && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <QualityReportHeader
            build={build}
            statusMeta={statusMeta}
            stutterScenarioLabel={stutterScenarioLabel}
            formatQualityDuration={formatQualityDuration}
            formatMonkeyExecutionSummary={formatMonkeyExecutionSummary}
            onOpenUrl={onOpenUrl}
          />

          <Card size="small" title={title}>
            <QualityReportToolbar
              build={build}
              activeView={activeView}
              isMonkeyReport={isMonkeyReport}
              isStutterReport={isStutterReport}
              isBusinessFlowReport={isBusinessFlowReport}
              performanceButtonLabel={performanceButtonLabel}
              performanceLoading={performanceLoading}
              artifactPreview={artifactPreview}
              artifactPreviewLoading={artifactPreviewLoading}
              onOpenSummary={(url) => {
                onSetActiveView('summary');
                onPreviewArtifact('summary.json', url);
              }}
              onOpenPerformance={onOpenPerformance}
              onOpenBusinessFlow={(url) => {
                onSetActiveView('business_flow');
                onPreviewArtifact('业务编排报告', url);
              }}
              onOpenMonkey={(url) => {
                onSetActiveView('monkey');
                onPreviewArtifact('Monkey 报告', url);
              }}
              onOpenCrash={() => {
                onSetActiveView('crash');
                onSetArtifactPreview(null);
              }}
              onOpenLog={() => {
                onSetActiveView('log');
                onSetArtifactPreview(null);
              }}
              onOpenEvidence={() => {
                onSetActiveView('evidence');
                onSetArtifactPreview(null);
              }}
            />
            {activeView === 'log' && (
              <QualityLogSection>
                <QualityLogDigest
                  preview={logDigest}
                  loading={!!logDigestLoading}
                />
              </QualityLogSection>
            )}
            {activeView === 'crash' && (
              <QualityReportSectionCard title="崩溃分析">
                <CrashAnalysisSummary
                  analysis={build.qualitySummary?.exceptionAnalysis}
                  crashReportsUrl={build.qualitySummary?.artifacts?.crashReportsUrl}
                />
              </QualityReportSectionCard>
            )}
            {activeView === 'business_flow' && isBusinessFlowReport && (
              <QualityReportSectionCard
                title="业务编排"
                extra={build.qualitySummary?.artifacts?.businessFlowReportUrl && (
                  <Button size="small" type="link" onClick={() => onOpenUrl(build.qualitySummary?.artifacts?.businessFlowReportUrl)}>
                    原始 JSON
                  </Button>
                )}
              >
                <BusinessFlowReportSummary
                  summary={build.qualitySummary?.businessFlow}
                  preview={artifactPreview}
                  loading={!!artifactPreviewLoading}
                  formatMilliseconds={formatMilliseconds}
                />
              </QualityReportSectionCard>
            )}
            {activeView === 'monkey' && isMonkeyReport && (
              <QualityReportSectionCard
                title="Monkey 报告"
                extra={artifactPreview?.url && (
                  <Button size="small" type="link" onClick={() => onOpenUrl(artifactPreview.url)}>
                    打开原文件
                  </Button>
                )}
              >
                <MonkeyReportSummary
                  preview={artifactPreview}
                  loading={!!artifactPreviewLoading}
                  formatSeconds={formatSeconds}
                />
              </QualityReportSectionCard>
            )}
            {activeView === 'summary' && (
              <QualityArtifactPreviewCard
                preview={artifactPreview}
                onOpenUrl={onOpenUrl}
                onClose={() => onSetArtifactPreview(null)}
              />
            )}
            {activeView === 'evidence' && (isMonkeyReport || isBusinessFlowReport) && (
              <QualityEvidenceCard screenshotUrl={build.qualitySummary?.artifacts?.screenshotUrl} />
            )}
            {activeView === 'performance' && (
              <QualityReportSectionCard
                title={(
                  <Space>
                    <Text>{performanceButtonLabel}</Text>
                    {performanceSamples && <Tag>jsonl</Tag>}
                  </Space>
                )}
                extra={(
                  <Space>
                    {!isStutterReport && performanceSamples?.url && (
                      <Button size="small" type="link" onClick={() => onOpenUrl(performanceSamples.url)}>
                        采样原文件
                      </Button>
                    )}
                    {build.qualitySummary?.artifacts?.performanceTraceUrl && (
                      <Button size="small" type="link" onClick={() => onOpenTrace(build.qualitySummary?.artifacts?.performanceTraceUrl)}>
                        下载 Trace
                      </Button>
                    )}
                    <Button size="small" type="text" onClick={() => {
                      onSetPerformanceSamples(null);
                      onSetActiveView('log');
                    }}>
                      收起
                    </Button>
                  </Space>
                )}
              >
                {isStutterReport ? (
                  <StutterReportSummary
                    analysis={build.qualitySummary?.performanceAnalysis}
                  />
                ) : (
                  <Space direction="vertical" size={16} style={{ width: '100%' }}>
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      <Text strong>{isMonkeyReport ? '结论' : '分析总结'}</Text>
                      <PerformanceAnalysisSummary
                        analysis={build.qualitySummary?.performanceAnalysis}
                        reportKind={reportKind}
                      />
                    </Space>
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      <Text strong>{isMonkeyReport ? '性能观察' : '性能诊断'}</Text>
                      <PerformanceDiagnostics
                        samples={performanceSamples}
                        analysis={build.qualitySummary?.performanceAnalysis}
                        loading={!!performanceLoading}
                        reportKind={reportKind}
                      />
                    </Space>
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      <Text strong>{isMonkeyReport ? '性能趋势' : '性能分析图'}</Text>
                      {performanceLoading ? (
                        <Alert showIcon type="info" message="正在加载性能采样..." />
                      ) : performanceSamples?.samples?.length ? (
                        <PerformanceSamplesChart
                          data={performanceSamples}
                          reportKind={reportKind}
                          formatSeconds={formatSeconds}
                        />
                      ) : build.qualitySummary?.performanceAnalysis?.trace?.available ? (
                        <Alert
                          showIcon
                          type="info"
                          message={isMonkeyReport ? 'Trace 已采集，暂无 CPU / 内存趋势' : 'Trace 已采集，暂无可绘制指标'}
                          description={isMonkeyReport
                            ? 'Monkey 测试不需要 FPS/帧级卡顿数据；当前缺少 CPU / 内存采样明细，所以无法绘制基础趋势。可下载 Trace 用 Instruments 查看原始录制。'
                            : (isStutterReport
                              ? '当前 xctrace 导出结果没有 CPU、内存或 FPS 明细行，可下载 Trace 用 Instruments 打开继续分析。'
                              : '当前 xctrace 导出结果没有 CPU、内存明细行，可下载 Trace 用 Instruments 打开继续分析。')}
                        />
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未采集到性能样本" />
                      )}
                    </Space>
                  </Space>
                )}
              </QualityReportSectionCard>
            )}
            <QualityReportMissingArtifactAlert
              build={build}
              isRunning={isRunning}
              hasArtifact={hasArtifact}
            />
          </Card>
        </Space>
      )}
    </Modal>
  );
}
