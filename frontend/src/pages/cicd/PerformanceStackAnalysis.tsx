import { Alert, Collapse, Space, Tag, Typography } from 'antd';
import { JenkinsQualityBuild } from '../../services/api';

const { Text } = Typography;
type QualityPerformanceAnalysis = NonNullable<NonNullable<JenkinsQualityBuild['qualitySummary']>['performanceAnalysis']>;

interface PerformanceStackAnalysisProps {
  analysis: QualityPerformanceAnalysis;
  eventTypeLabel: (type?: string) => string;
}

export function PerformanceStackAnalysis({ analysis, eventTypeLabel }: PerformanceStackAnalysisProps) {
  const stackAnalysis = analysis.stackAnalysis;
  if (!stackAnalysis?.enabled && !analysis.stutter?.severeActionCount) return null;
  const samples = stackAnalysis?.samples || [];
  const hasFrames = samples.some((sample) => (sample.matchedFrames || []).length > 0);
  return (
    <Alert
      showIcon
      type={hasFrames ? 'success' : 'info'}
      message={hasFrames ? '卡顿调用栈已匹配' : '卡顿调用栈未匹配'}
      description={(
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Text type="secondary">
            {stackAnalysis?.message || '严重交互卡顿需要 Time Profiler Trace 才能定位调用栈。'}
          </Text>
          {stackAnalysis?.template && <Tag>Trace 模板 {stackAnalysis.template}</Tag>}
          {samples.length > 0 && (
            <Collapse
              size="small"
              items={samples.slice(0, 6).map((sample, index) => ({
                key: `${sample.index || index}-${sample.actionDurationMs || 0}`,
                label: `#${sample.index || '-'} ${eventTypeLabel(sample.type)} ${sample.actionDurationMs || '-'}ms${sample.elapsedSeconds ? ` / ${Math.round(sample.elapsedSeconds)}s` : ''}`,
                children: (
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    {sample.page?.summary?.text?.length ? (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        页面线索：{sample.page.summary.text.slice(0, 6).join(' / ')}
                      </Text>
                    ) : null}
                    {(sample.matchedFrames || []).length > 0 ? (
                      <pre
                        style={{
                          margin: 0,
                          maxHeight: 300,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          fontSize: 12,
                          lineHeight: 1.5,
                          background: '#fafafa',
                          padding: 12,
                          border: '1px solid #f0f0f0',
                          borderRadius: 4,
                        }}
                      >
                        {(sample.matchedFrames || []).slice(0, 12).map((frame, frameIndex) => (
                          `${frameIndex + 1}. [${frame.schema || 'stack'}:${frame.row || '-'}] ${frame.frame || ''}`
                        )).join('\n')}
                      </pre>
                    ) : (
                      <Text type="secondary">{sample.message || '未匹配到该卡顿时间点的调用栈。'}</Text>
                    )}
                  </Space>
                ),
              }))}
            />
          )}
        </Space>
      )}
    />
  );
}
