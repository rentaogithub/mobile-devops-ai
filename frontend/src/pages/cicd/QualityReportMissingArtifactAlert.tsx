import { Alert } from 'antd';
import { JenkinsQualityBuild } from '../../services/api';

interface QualityReportMissingArtifactAlertProps {
  build: JenkinsQualityBuild;
  isRunning: (build: JenkinsQualityBuild) => boolean;
  hasArtifact: (build: JenkinsQualityBuild) => boolean;
}

export function QualityReportMissingArtifactAlert({
  build,
  isRunning,
  hasArtifact,
}: QualityReportMissingArtifactAlertProps) {
  if (hasArtifact(build)) return null;

  const running = isRunning(build);

  return (
    <Alert
      type={running ? 'info' : 'warning'}
      showIcon
      style={{ marginTop: 16 }}
      message={running ? '质检汇总生成中' : '当前任务暂未发现可展示的质检文件'}
      description={running
        ? '任务仍在执行或收尾，报告文件生成后会自动刷新展示。'
        : '如果任务刚结束，报告文件可能仍在归档，页面会继续自动刷新；也可以打开 Jenkins 控制台查看原始日志。'}
    />
  );
}
