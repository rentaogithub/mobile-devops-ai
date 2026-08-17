import { Button, Card, Popconfirm, Progress, Space, Table, Tag, Typography } from 'antd';
import { FileTextOutlined, RocketOutlined, StopOutlined } from '@ant-design/icons';
import { ReactNode } from 'react';
import { JenkinsQualityBuild } from '../../services/api';

const { Text } = Typography;

interface QualityBuildTableProps {
  jobFullName?: string;
  jobBuildable?: boolean;
  loading?: boolean;
  sourceLoading?: boolean;
  builds: JenkinsQualityBuild[];
  isAdmin?: boolean;
  canUseQuality?: boolean;
  canOpenQualityModal?: boolean;
  stoppingQualityBuild?: number | null;
  publishChannelLabel: (channel?: string) => string;
  qualitySuiteLabel: (summary?: JenkinsQualityBuild['qualitySummary']) => string;
  qualityPhaseLabel: (build: JenkinsQualityBuild) => string;
  qualityResultTag: (build: JenkinsQualityBuild) => ReactNode;
  isQualityBuildEffectivelyRunning: (build: JenkinsQualityBuild) => boolean;
  progressPercent: (build: JenkinsQualityBuild) => number;
  progressStatus: (build: JenkinsQualityBuild) => 'success' | 'exception' | 'normal' | 'active';
  progressElapsedSeconds: (build: JenkinsQualityBuild) => number;
  progressRemainingSeconds: (build: JenkinsQualityBuild) => number | null | undefined;
  formatSeconds: (value?: number | null) => string;
  formatBuildTime: (timestamp: number) => ReactNode;
  onOpenUrl: (url?: string) => void;
  onOpenQualityModal: (build?: JenkinsQualityBuild) => void;
  onOpenQualityReport: (build: JenkinsQualityBuild) => void;
  onStopQualityBuild: (buildNumber: number, deviceUdid?: string) => void;
}

export function QualityBuildTable({
  jobFullName,
  jobBuildable,
  loading,
  sourceLoading,
  builds,
  isAdmin,
  canUseQuality,
  canOpenQualityModal,
  stoppingQualityBuild,
  publishChannelLabel,
  qualitySuiteLabel,
  qualityPhaseLabel,
  qualityResultTag,
  isQualityBuildEffectivelyRunning,
  progressPercent,
  progressStatus,
  progressElapsedSeconds,
  progressRemainingSeconds,
  formatSeconds,
  formatBuildTime,
  onOpenUrl,
  onOpenQualityModal,
  onOpenQualityReport,
  onStopQualityBuild,
}: QualityBuildTableProps) {
  return (
    <Card
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
          <Space>
            <span>质检任务列表</span>
            {jobFullName && <Tag color="blue">{jobFullName}</Tag>}
            {jobBuildable === false && <Tag color="red">不可构建</Tag>}
          </Space>
          {canUseQuality && (
            <Button type="primary" icon={<RocketOutlined />} onClick={() => onOpenQualityModal()} loading={sourceLoading} disabled={!canOpenQualityModal}>
              新建质检
            </Button>
          )}
        </div>
      }
    >
      <Table<JenkinsQualityBuild>
        rowKey="number"
        loading={loading}
        dataSource={builds}
        tableLayout="fixed"
        scroll={{ x: 1480 }}
        pagination={{ pageSize: 10, showSizeChanger: false }}
        columns={[
          {
            title: '质检任务',
            dataIndex: 'number',
            key: 'number',
            width: 120,
            render: (number: number, record) => isAdmin ? (
              <Button type="link" onClick={() => onOpenUrl(record.url)}>
                #{number}
              </Button>
            ) : <Text>#{number}</Text>,
          },
          {
            title: '来源构建',
            key: 'sourceBuildNumber',
            width: 110,
            render: (_, record) => record.qualitySummary?.sourceBuildNumber ? (
              <Tag color="blue">#{record.qualitySummary.sourceBuildNumber}</Tag>
            ) : <Text type="secondary">-</Text>,
          },
          {
            title: '发布渠道',
            key: 'publishChannel',
            width: 110,
            render: (_, record) => record.qualitySummary?.publishChannel ? (
              <Tag>{publishChannelLabel(record.qualitySummary.publishChannel)}</Tag>
            ) : <Text type="secondary">-</Text>,
          },
          {
            title: 'APP版本',
            key: 'appVersion',
            width: 110,
            render: (_, record) => record.qualitySummary?.appVersion ? (
              <Tag color="purple">{record.qualitySummary.appVersion}</Tag>
            ) : <Text type="secondary">-</Text>,
          },
          {
            title: '测试套件',
            key: 'testSuite',
            width: 140,
            render: (_, record) => {
              const label = qualitySuiteLabel(record.qualitySummary);
              if (label === '-') return <Text type="secondary">-</Text>;
              const suite = record.qualitySummary?.testSuite;
              return <Tag color={suite === 'stutter' ? 'orange' : (suite === 'business_flow' ? 'blue' : 'default')}>{label}</Tag>;
            },
          },
          {
            title: '设备',
            key: 'device',
            width: 180,
            ellipsis: true,
            render: (_, record) => (
              <Space direction="vertical" size={0}>
                <Text>{record.qualitySummary?.devicePoolLabel || record.qualitySummary?.devicePool || '-'}</Text>
                {record.qualitySummary?.deviceUdid && (
                  <Text type="secondary" style={{ fontSize: 12 }} title={record.qualitySummary.deviceUdid}>
                    {record.qualitySummary.deviceUdid.slice(0, 12)}...
                  </Text>
                )}
              </Space>
            ),
          },
          {
            title: '状态',
            key: 'result',
            width: 140,
            render: (_, record) => {
              const phaseLabel = qualityPhaseLabel(record);
              return (
                <Space direction="vertical" size={2}>
                  {qualityResultTag(record)}
                  {phaseLabel && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {isQualityBuildEffectivelyRunning(record) ? '当前阶段' : '阶段'}：{phaseLabel}
                    </Text>
                  )}
                </Space>
              );
            },
          },
          {
            title: '进度',
            key: 'progress',
            width: 230,
            render: (_, record) => {
              const progress = record.qualitySummary?.progress;
              if (!record.building && !progress) {
                return <Text type="secondary">-</Text>;
              }
              const percent = progressPercent(record);
              const perf = progress?.recentPerformance;
              const remainingSeconds = progressRemainingSeconds(record);
              const requestedDurationSeconds = Number(progress?.requestedDurationSeconds || 0);
              const summaryStatus = String(record.qualitySummary?.status || '').toLowerCase();
              const isPassed = ['passed', 'success'].includes(summaryStatus);
              const progressMessage = isPassed ? '质检完成' : progress?.message;
              const elapsedLabel = formatSeconds(progressElapsedSeconds(record));
              const planLabel = requestedDurationSeconds > 0 ? formatSeconds(requestedDurationSeconds) : '';
              return (
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Progress percent={percent} size="small" status={progressStatus(record)} />
                  {progressMessage && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {!isPassed && qualityPhaseLabel(record) ? `${qualityPhaseLabel(record)}：` : ''}{progressMessage}
                    </Text>
                  )}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {progress?.executedEvents || 0} 次 / 已运行 {elapsedLabel}
                    {planLabel ? ` / 计划 ${planLabel}` : ''}
                    {remainingSeconds !== null && remainingSeconds !== undefined ? ` / 剩余 ${formatSeconds(remainingSeconds)}` : ''}
                  </Text>
                  {(perf?.cpu !== null && perf?.cpu !== undefined) || (perf?.memoryMB !== null && perf?.memoryMB !== undefined) || (perf?.fps !== null && perf?.fps !== undefined) ? (
                    <Space size={4} wrap>
                      {perf?.cpu !== null && perf?.cpu !== undefined && <Tag>CPU {perf.cpu}%</Tag>}
                      {perf?.memoryMB !== null && perf?.memoryMB !== undefined && <Tag>内存 {perf.memoryMB}MB</Tag>}
                      {perf?.fps !== null && perf?.fps !== undefined && <Tag>FPS {perf.fps}</Tag>}
                    </Space>
                  ) : null}
                </Space>
              );
            },
          },
          {
            title: '开始时间',
            dataIndex: 'timestamp',
            key: 'timestamp',
            width: 180,
            render: formatBuildTime,
          },
          {
            title: '操作',
            key: 'action',
            width: 180,
            render: (_, record) => (
              <Space size={8}>
                <Button
                  size="small"
                  icon={<FileTextOutlined />}
                  onClick={() => onOpenQualityReport(record)}
                >
                  报告
                </Button>
                {isQualityBuildEffectivelyRunning(record) && canUseQuality && (
                  <Popconfirm
                    title="停止质检任务？"
                    description={`确定要停止 #${record.number} 吗？`}
                    okText="停止"
                    cancelText="关闭"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => onStopQualityBuild(record.number, record.qualitySummary?.deviceUdid)}
                  >
                    <Button
                      size="small"
                      danger
                      icon={<StopOutlined />}
                      loading={stoppingQualityBuild === record.number}
                    >
                      停止
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}
