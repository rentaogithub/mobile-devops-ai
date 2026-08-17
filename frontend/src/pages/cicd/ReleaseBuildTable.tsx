import { Button, Card, Popconfirm, QRCode, Select, Space, Table, Tag, Typography } from 'antd';
import { FileTextOutlined, PlayCircleOutlined, RocketOutlined, StopOutlined } from '@ant-design/icons';
import { JenkinsBuild } from '../../services/api';

const { Text } = Typography;

type DeployTarget = 'Pgyer' | 'TestFlight' | 'AppStore';

interface ReleaseBuildTableProps {
  jobFullName?: string;
  jobBuildable?: boolean;
  loading?: boolean;
  builds: JenkinsBuild[];
  isAdmin?: boolean;
  canUseQuality?: boolean;
  canPublishPgyerOrTestFlight?: boolean;
  canPublishAppStore?: boolean;
  stoppingBuild?: number | null;
  cancelingAppStoreReview?: number | null;
  filterBranchName: string;
  filterDeployTarget: DeployTarget | '';
  branchLoading?: boolean;
  branchOptions: Array<{ value: string; label: string }>;
  deployTargetOptions: Array<{ label: string; value: DeployTarget }>;
  publishChannelLabel: (channel?: string) => string;
  getChannelBuildNumber: (build: JenkinsBuild) => string;
  formatBuildTime: (timestamp: number) => React.ReactNode;
  formatDuration: (duration: number, building: boolean) => React.ReactNode;
  renderBuildStatus: (build: JenkinsBuild) => React.ReactNode;
  onBranchFilterChange: (branchName: string) => void;
  onDeployTargetFilterChange: (target: DeployTarget | '') => void;
  onOpenUrl: (url?: string) => void;
  onShowBuildLog: (build: JenkinsBuild) => void;
  onOpenQuality: (build: JenkinsBuild) => void;
  onOpenPgyerPublish: (build: JenkinsBuild) => void;
  onCancelAppStoreReview: (buildNumber: number) => void;
  onStopBuild: (buildNumber: number) => void;
  onQrPreview: (preview: { url: string; channel?: string; buildNumber?: string; branchName?: string }) => void;
}

export function ReleaseBuildTable({
  jobFullName,
  jobBuildable,
  loading,
  builds,
  isAdmin,
  canUseQuality,
  canPublishPgyerOrTestFlight,
  canPublishAppStore,
  stoppingBuild,
  cancelingAppStoreReview,
  filterBranchName,
  filterDeployTarget,
  branchLoading,
  branchOptions,
  deployTargetOptions,
  publishChannelLabel,
  getChannelBuildNumber,
  formatBuildTime,
  formatDuration,
  renderBuildStatus,
  onBranchFilterChange,
  onDeployTargetFilterChange,
  onOpenUrl,
  onShowBuildLog,
  onOpenQuality,
  onOpenPgyerPublish,
  onCancelAppStoreReview,
  onStopBuild,
  onQrPreview,
}: ReleaseBuildTableProps) {
  return (
    <Card
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
          <Space>
            <span>构建列表</span>
            {jobFullName && <Tag color="blue">{jobFullName}</Tag>}
            {jobBuildable === false && <Tag color="red">不可构建</Tag>}
          </Space>
          <Space wrap>
            <Text type="secondary">分支名</Text>
            <Select
              size="small"
              showSearch
              allowClear
              value={filterBranchName}
              style={{ width: 260 }}
              options={branchOptions}
              optionFilterProp="label"
              listHeight={360}
              filterOption={(input, option) => String(option?.label || '').toLowerCase().includes(input.trim().toLowerCase())}
              loading={branchLoading}
              onChange={(value) => onBranchFilterChange(value || '')}
            />
            <Text type="secondary">发布渠道</Text>
            <Select
              size="small"
              value={filterDeployTarget}
              style={{ width: 130 }}
              options={[
                { label: '全部', value: '' },
                ...deployTargetOptions,
              ]}
              onChange={onDeployTargetFilterChange}
            />
          </Space>
        </div>
      }
    >
      <Table<JenkinsBuild>
        rowKey="number"
        loading={loading}
        dataSource={builds}
        tableLayout="fixed"
        scroll={{ x: 1290 }}
        pagination={{ pageSize: 10, showSizeChanger: false }}
        columns={[
          {
            title: '构建/渠道号',
            dataIndex: 'number',
            key: 'number',
            width: 140,
            render: (number: number, record) => {
              const channelBuildNumber = getChannelBuildNumber(record);
              return (
                <Space size={0} wrap={false}>
                  {isAdmin ? (
                    <Button type="link" style={{ padding: 0 }} onClick={() => onOpenUrl(record.url)}>
                      #{number}
                    </Button>
                  ) : <Text>#{number}</Text>}
                  {channelBuildNumber && <Text>，{channelBuildNumber}</Text>}
                </Space>
              );
            },
          },
          {
            title: '发布渠道',
            dataIndex: 'publishChannel',
            key: 'publishChannel',
            width: 120,
            render: (value?: string) => value ? <Tag color="blue">{publishChannelLabel(value)}</Tag> : <Text type="secondary">-</Text>,
          },
          {
            title: '分支名',
            dataIndex: 'branchName',
            key: 'branchName',
            width: 150,
            ellipsis: true,
            render: (value?: string) => value ? <Tag>{value}</Tag> : <Text type="secondary">-</Text>,
          },
          {
            title: 'Commit Hash',
            dataIndex: 'commitHash',
            key: 'commitHash',
            width: 130,
            render: (value?: string) => value ? <Text code title={value}>{value.slice(0, 6)}</Text> : <Text type="secondary">-</Text>,
          },
          {
            title: 'APP版本',
            dataIndex: 'appVersion',
            key: 'appVersion',
            width: 120,
            render: (value?: string) => value ? <Tag color="purple">{value}</Tag> : <Text type="secondary">-</Text>,
          },
          {
            title: '扫码安装',
            dataIndex: 'channelQrUrl',
            key: 'channelQrUrl',
            width: 110,
            render: (value: string | undefined, record) => value ? (
              <button
                type="button"
                onClick={() => onQrPreview({
                  url: value,
                  channel: record.publishChannel,
                  buildNumber: getChannelBuildNumber(record),
                  branchName: record.branchName,
                })}
                style={{
                  width: 64,
                  height: 64,
                  padding: 0,
                  border: '1px solid #f0f0f0',
                  borderRadius: 4,
                  background: '#fff',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                title="打开二维码地址"
              >
                <QRCode value={value} size={56} bordered={false} />
              </button>
            ) : <Text type="secondary">-</Text>,
          },
          {
            title: '状态',
            key: 'result',
            width: 150,
            render: (_, record) => renderBuildStatus(record),
          },
          {
            title: '开始时间',
            dataIndex: 'timestamp',
            key: 'timestamp',
            width: 170,
            render: formatBuildTime,
          },
          {
            title: '耗时',
            key: 'duration',
            width: 100,
            render: (_, record) => formatDuration(record.duration, record.building),
          },
          {
            title: '操作',
            key: 'action',
            width: 220,
            render: (_, record) => (
              <Space size={8}>
                <Button size="small" icon={<FileTextOutlined />} onClick={() => onShowBuildLog(record)}>
                  详情
                </Button>
                {canUseQuality && (
                  <Button size="small" icon={<RocketOutlined />} onClick={() => onOpenQuality(record)}>
                    质检
                  </Button>
                )}
                {record.publishChannel === 'Pgyer' && canPublishPgyerOrTestFlight && (
                  <Button size="small" type="primary" ghost icon={<PlayCircleOutlined />} onClick={() => onOpenPgyerPublish(record)}>
                    发布
                  </Button>
                )}
                {canPublishAppStore && record.publishChannel === 'AppStore' && ['waiting_for_review', 'in_review'].includes(String(record.appStoreRelease?.status || '')) && (
                  <Popconfirm
                    title="停止 App Store 审核？"
                    description={`确定停止 #${record.number} / ${getChannelBuildNumber(record) || '-'} 的 App Store 审核吗？停止后需要重新提交审核。`}
                    okText="停止审核"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => onCancelAppStoreReview(record.number)}
                  >
                    <Button
                      size="small"
                      danger
                      loading={cancelingAppStoreReview === record.number}
                    >
                      停止审核
                    </Button>
                  </Popconfirm>
                )}
                {record.building && canUseQuality && (
                  <Popconfirm
                    title="取消构建？"
                    description={`确定要取消 #${record.number} 吗？`}
                    okText="取消构建"
                    cancelText="关闭"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => onStopBuild(record.number)}
                  >
                    <Button
                      size="small"
                      danger
                      icon={<StopOutlined />}
                      loading={stoppingBuild === record.number}
                    >
                      取消
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
