import { Alert, Empty, Space, Table, Tag, Typography } from 'antd';
import { JenkinsQualityArtifactPreview, JenkinsQualityBuild } from '../../services/api';

const { Text } = Typography;

function parseJsonPreview<T>(preview?: JenkinsQualityArtifactPreview | null): T | null {
  if (!preview?.content) return null;
  try {
    return JSON.parse(preview.content) as T;
  } catch {
    return null;
  }
}

interface BusinessFlowReportSummaryProps {
  summary?: NonNullable<JenkinsQualityBuild['qualitySummary']>['businessFlow'];
  preview: (JenkinsQualityArtifactPreview & { title: string }) | null;
  loading: boolean;
  formatMilliseconds: (value?: number | string | null) => string;
}

export function BusinessFlowReportSummary({
  summary,
  preview,
  loading,
  formatMilliseconds,
}: BusinessFlowReportSummaryProps) {
  type BusinessFlowReport = NonNullable<JenkinsQualityBuild['qualitySummary']>['businessFlow'];
  if (loading) {
    return <Alert showIcon type="info" message="正在加载业务编排报告..." />;
  }
  const report = parseJsonPreview<BusinessFlowReport>(preview) || summary;
  if (!report) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次任务没有业务编排报告" />;
  }
  const steps = report.steps || [];
  const isPassed = String(report.status || '').toLowerCase() === 'passed';
  const statusColor = isPassed ? 'green' : 'red';
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        showIcon
        type={isPassed ? 'success' : 'warning'}
        message={isPassed ? '业务编排执行完成' : '业务编排存在异常'}
        description={report.message || '未提供执行说明'}
      />
      <Space wrap>
        <Tag color={statusColor}>{report.status || 'unknown'}</Tag>
        <Tag>通过 {report.passedSteps || 0}/{report.totalSteps || steps.length || 0} 步</Tag>
        {report.durationMs !== undefined && <Tag>耗时 {formatMilliseconds(report.durationMs)}</Tag>}
        {report.riskPolicy && <Tag color="blue">风险策略 {report.riskPolicy}</Tag>}
        {report.stopOnFailure !== undefined && <Tag>{report.stopOnFailure ? '失败即停' : '失败后继续'}</Tag>}
      </Space>
      {report.issues?.length ? (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Text strong>问题摘要</Text>
          {report.issues.slice(0, 6).map((issue, index) => (
            <Alert
              key={`${issue.stepId || index}-${issue.message || ''}`}
              type={issue.severity === 'failed' ? 'error' : 'warning'}
              showIcon
              message={issue.message || issue.path || '业务步骤异常'}
            />
          ))}
        </Space>
      ) : null}
      <Table
        size="small"
        rowKey={(record: any) => record.id || record.index}
        pagination={false}
        dataSource={steps}
        columns={[
          {
            title: '步骤',
            key: 'label',
            width: 180,
            render: (_: unknown, record: any) => (
              <Space direction="vertical" size={0}>
                <Text>{record.label || record.id || '-'}</Text>
                {record.path && <Text type="secondary" style={{ fontSize: 12 }}>{record.path}</Text>}
              </Space>
            ),
          },
          {
            title: '业务域',
            dataIndex: 'domain',
            key: 'domain',
            width: 110,
            render: (value: string) => value ? <Tag>{value}</Tag> : <Text type="secondary">-</Text>,
          },
          {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            width: 100,
            render: (value: string) => <Tag color={value === 'passed' ? 'green' : (value === 'failed' ? 'red' : 'default')}>{value || '-'}</Tag>,
          },
          {
            title: '风险',
            key: 'risk',
            width: 120,
            render: (_: unknown, record: any) => (
              <Space size={4} wrap>
                {record.riskLevel && <Tag color={record.riskLevel === 'normal' ? 'default' : 'orange'}>{record.riskLevel}</Tag>}
                {record.guarded && <Tag color="blue">已保护</Tag>}
              </Space>
            ),
          },
          {
            title: '耗时',
            dataIndex: 'durationMs',
            key: 'durationMs',
            width: 110,
            render: (value: number) => value ? formatMilliseconds(value) : '-',
          },
          {
            title: '结果',
            key: 'message',
            render: (_: unknown, record: any) => (
              <Space direction="vertical" size={0}>
                <Text>{record.message || '-'}</Text>
                {record.lastAction && <Text type="secondary" style={{ fontSize: 12 }}>最后动作：{record.lastAction}</Text>}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}
