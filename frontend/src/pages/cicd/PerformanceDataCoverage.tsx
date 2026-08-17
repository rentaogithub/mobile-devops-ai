import { Alert, Space, Tag, Typography } from 'antd';
import { JenkinsQualityBuild } from '../../services/api';
import { QualityReportKind } from './qualityOptions';

const { Text } = Typography;
type QualityPerformanceAnalysis = NonNullable<NonNullable<JenkinsQualityBuild['qualitySummary']>['performanceAnalysis']>;

interface PerformanceDataCoverageProps {
  analysis: QualityPerformanceAnalysis;
  reportKind?: QualityReportKind;
}

export function PerformanceDataCoverage({ analysis, reportKind = 'generic' }: PerformanceDataCoverageProps) {
  const sampleCount = analysis.samples?.sampleCount || 0;
  const includeStutterMetrics = reportKind !== 'monkey';
  const hasCpu = analysis.samples?.cpu?.avg !== null && analysis.samples?.cpu?.avg !== undefined;
  const hasMemory = analysis.samples?.memoryMB?.avg !== null && analysis.samples?.memoryMB?.avg !== undefined;
  const hasFps = analysis.samples?.fps?.avg !== null && analysis.samples?.fps?.avg !== undefined;
  const hasInteractionStutter = !!analysis.stutter?.enabled;
  const hasFrameStutter = !!analysis.frameStutter?.available;
  const hasStackAnalysis = !!analysis.stackAnalysis?.available;
  const missing = [
    includeStutterMetrics && !hasFps ? 'FPS' : '',
    includeStutterMetrics && !hasInteractionStutter ? '交互卡顿' : '',
    includeStutterMetrics && !hasFrameStutter ? '帧级卡顿' : '',
    includeStutterMetrics && analysis.stutter?.severeActionCount && !hasStackAnalysis ? '调用栈' : '',
  ].filter(Boolean);

  return (
    <Alert
      showIcon
      type={missing.length > 0 ? 'info' : 'success'}
      message="数据覆盖"
      description={(
        <Space direction="vertical" size={6}>
          <Space wrap>
            <Tag color={hasCpu ? 'green' : 'default'}>CPU {hasCpu ? '已采集' : '未采集'}</Tag>
            <Tag color={hasMemory ? 'green' : 'default'}>内存 {hasMemory ? '已采集' : '未采集'}</Tag>
            {includeStutterMetrics && <Tag color={hasFps ? 'green' : 'gold'}>FPS {hasFps ? '已采集' : '未采集'}</Tag>}
            {includeStutterMetrics && <Tag color={hasInteractionStutter ? 'green' : 'gold'}>交互卡顿 {hasInteractionStutter ? '已检测' : '未接入'}</Tag>}
            {includeStutterMetrics && <Tag color={hasFrameStutter ? 'green' : 'gold'}>帧级卡顿 {hasFrameStutter ? '已解析' : '未解析'}</Tag>}
            {includeStutterMetrics && <Tag color={hasStackAnalysis ? 'green' : 'gold'}>调用栈 {hasStackAnalysis ? '已匹配' : '未匹配'}</Tag>}
            {sampleCount > 0 && <Tag>样本 {sampleCount} 条</Tag>}
          </Space>
          {missing.length > 0 && (
            <Text type="secondary">
              {reportKind === 'monkey'
                ? 'Monkey 性能报告仅展示启动、CPU 和内存基础数据；卡顿、帧率和调用栈分析请使用卡顿检测任务。'
                : sampleCount > 0
                ? '本次已有进程采样，可分析 CPU/内存趋势；FPS 和精准帧级卡顿依赖 xctrace Animation Hitches/Frame 明细表。'
                : '本次 xctrace Trace 已采集，但未导出 CPU/内存明细；后续任务会同时启动侧路采样补齐 CPU/内存。'}
            </Text>
          )}
        </Space>
      )}
    />
  );
}
