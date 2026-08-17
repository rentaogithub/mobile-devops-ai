import { Button, Space } from 'antd';
import { FileTextOutlined } from '@ant-design/icons';
import { JenkinsQualityArtifactPreview, JenkinsQualityBuild } from '../../services/api';
import { QualitySummaryView } from './qualityReportTypes';

interface QualityReportToolbarProps {
  build: JenkinsQualityBuild;
  activeView: QualitySummaryView;
  isMonkeyReport: boolean;
  isStutterReport: boolean;
  isBusinessFlowReport: boolean;
  performanceButtonLabel: string;
  performanceLoading?: boolean;
  artifactPreview: (JenkinsQualityArtifactPreview & { title: string }) | null;
  artifactPreviewLoading?: boolean;
  onOpenSummary: (url?: string) => void;
  onOpenPerformance: (url?: string) => void;
  onOpenBusinessFlow: (url?: string) => void;
  onOpenMonkey: (url?: string) => void;
  onOpenCrash: () => void;
  onOpenLog: () => void;
  onOpenEvidence: () => void;
}

export function QualityReportToolbar({
  build,
  activeView,
  isMonkeyReport,
  isStutterReport: _isStutterReport,
  isBusinessFlowReport,
  performanceButtonLabel,
  performanceLoading,
  artifactPreview,
  artifactPreviewLoading,
  onOpenSummary,
  onOpenPerformance,
  onOpenBusinessFlow,
  onOpenMonkey,
  onOpenCrash,
  onOpenLog,
  onOpenEvidence,
}: QualityReportToolbarProps) {
  const artifacts = build.qualitySummary?.artifacts;

  return (
    <Space wrap>
      {artifacts?.summaryUrl && (
        <Button
          size="small"
          type="link"
          onClick={() => onOpenSummary(artifacts.summaryUrl)}
        >
          summary.json
        </Button>
      )}
      <Button
        style={{ display: isBusinessFlowReport ? 'none' : undefined }}
        disabled={!build.qualitySummary?.performanceAnalysis && !artifacts?.performanceSamplesUrl && !artifacts?.performanceTraceUrl}
        loading={performanceLoading}
        type={activeView === 'performance' ? 'primary' : 'default'}
        onClick={() => onOpenPerformance(artifacts?.performanceSamplesUrl)}
      >
        {performanceButtonLabel}
      </Button>
      {isBusinessFlowReport && (
        <Button
          disabled={!build.qualitySummary?.businessFlow && !artifacts?.businessFlowReportUrl}
          loading={artifactPreviewLoading && artifactPreview?.title === '业务编排报告'}
          type={activeView === 'business_flow' ? 'primary' : 'default'}
          onClick={() => onOpenBusinessFlow(artifacts?.businessFlowReportUrl)}
        >
          业务编排
        </Button>
      )}
      {isMonkeyReport && (
        <Button
          disabled={!artifacts?.monkeyReportUrl}
          loading={artifactPreviewLoading && artifactPreview?.title === 'Monkey 报告'}
          type={activeView === 'monkey' ? 'primary' : 'default'}
          onClick={() => onOpenMonkey(artifacts?.monkeyReportUrl)}
        >
          Monkey 报告
        </Button>
      )}
      <Button
        disabled={!build.qualitySummary?.exceptionAnalysis}
        type={activeView === 'crash' ? 'primary' : 'default'}
        onClick={onOpenCrash}
      >
        崩溃分析
      </Button>
      <Button
        icon={<FileTextOutlined />}
        disabled={!artifacts?.qualityLogUrl}
        type={activeView === 'log' ? 'primary' : 'default'}
        onClick={onOpenLog}
      >
        质检日志
      </Button>
      {(isMonkeyReport || isBusinessFlowReport) && (
        <Button
          disabled={!artifacts?.screenshotUrl}
          type={activeView === 'evidence' ? 'primary' : 'default'}
          onClick={onOpenEvidence}
        >
          现场证据
        </Button>
      )}
    </Space>
  );
}
