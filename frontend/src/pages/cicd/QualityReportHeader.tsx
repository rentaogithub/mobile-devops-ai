import { Alert, Button, Space, Tag } from 'antd';
import { JenkinsQualityBuild } from '../../services/api';

interface QualityReportHeaderProps {
  build: JenkinsQualityBuild;
  statusMeta: {
    type: 'success' | 'info' | 'warning' | 'error';
    message: string;
  };
  stutterScenarioLabel: (value?: string) => string;
  formatQualityDuration: (build: JenkinsQualityBuild) => string;
  formatMonkeyExecutionSummary: (build: JenkinsQualityBuild) => string;
  onOpenUrl: (url?: string) => void;
}

export function QualityReportHeader({
  build,
  statusMeta,
  stutterScenarioLabel,
  formatQualityDuration,
  formatMonkeyExecutionSummary,
  onOpenUrl,
}: QualityReportHeaderProps) {
  return (
    <Alert
      type={statusMeta.type}
      showIcon
      message={build.qualitySummary?.message || statusMeta.message}
      description={(
        <Space wrap>
          {build.qualitySummary?.sourceBuildNumber && <Tag color="blue">来源构建 #{build.qualitySummary.sourceBuildNumber}</Tag>}
          {build.qualitySummary?.appVersion && <Tag color="purple">APP {build.qualitySummary.appVersion}</Tag>}
          {build.qualitySummary?.testSuite && <Tag>套件 {build.qualitySummary.testSuite}</Tag>}
          {build.qualitySummary?.testSuite === 'stutter' && build.qualitySummary?.stutterScenario && (
            <Tag color="magenta">场景 {stutterScenarioLabel(build.qualitySummary.stutterScenario)}</Tag>
          )}
          {build.qualitySummary?.testSuite === 'business_flow' && build.qualitySummary?.businessFlow && (
            <Tag color="blue">
              步骤 {build.qualitySummary.businessFlow.passedSteps || 0}/{build.qualitySummary.businessFlow.totalSteps || 0}
            </Tag>
          )}
          <Tag>耗时 {formatQualityDuration(build)}</Tag>
          {build.qualitySummary?.monkeyStatus && (
            <Tag color={build.qualitySummary.monkeyStatus === 'passed' ? 'green' : 'red'}>
              Monkey {formatMonkeyExecutionSummary(build)}
            </Tag>
          )}
          <Button type="link" size="small" onClick={() => onOpenUrl(build.url)}>
            Jenkins #{build.number}
          </Button>
        </Space>
      )}
    />
  );
}
