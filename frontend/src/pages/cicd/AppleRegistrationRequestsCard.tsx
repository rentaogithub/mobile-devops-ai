import { Button, Card, Space, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { AppleDeviceRegistrationRequest } from '../../services/api';

const { Text } = Typography;

interface AppleRegistrationRequestsCardProps {
  requests: AppleDeviceRegistrationRequest[];
  loading?: boolean;
  approvingRequestId?: string;
  onRefresh: () => void;
  onApprove: (id: string) => void;
}

export function AppleRegistrationRequestsCard({
  requests,
  loading,
  approvingRequestId,
  onRefresh,
  onApprove,
}: AppleRegistrationRequestsCardProps) {
  const pendingCount = requests.filter((request) => request.status === 'pending').length;

  return (
    <Card
      title={(
        <Space>
          <span>设备注册申请</span>
          <Tag>{pendingCount} 个待审批</Tag>
        </Space>
      )}
      extra={(
        <Button icon={<ReloadOutlined />} onClick={onRefresh} loading={loading}>
          刷新申请
        </Button>
      )}
    >
      <Table<AppleDeviceRegistrationRequest>
        rowKey="id"
        loading={loading}
        dataSource={requests}
        tableLayout="fixed"
        pagination={{ pageSize: 5, showSizeChanger: false }}
        columns={[
          {
            title: '设备名称',
            dataIndex: 'name',
            key: 'name',
            width: 180,
            ellipsis: true,
            render: (value?: string) => value || <Text type="secondary">-</Text>,
          },
          {
            title: 'Identifier',
            dataIndex: 'udid',
            key: 'udid',
            width: 270,
            ellipsis: true,
            render: (value?: string) => value ? <Text code copyable title={value}>{value}</Text> : <Text type="secondary">-</Text>,
          },
          {
            title: '设备信息',
            key: 'source',
            width: 180,
            render: (_, record) => [record.source?.product, record.source?.version].filter(Boolean).join(' / ') || <Text type="secondary">-</Text>,
          },
          {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            width: 120,
            render: (value: AppleDeviceRegistrationRequest['status']) => (
              value === 'pending' ? <Tag color="orange">待审批</Tag> : (value === 'registered' ? <Tag color="green">已注册</Tag> : <Tag>已驳回</Tag>)
            ),
          },
          {
            title: '操作',
            key: 'actions',
            width: 150,
            render: (_, record) => (
              record.status === 'pending' ? (
                <Button
                  size="small"
                  type="primary"
                  loading={approvingRequestId === record.id}
                  onClick={() => onApprove(record.id)}
                >
                  批准并注册
                </Button>
              ) : (
                <Text type="secondary">{record.message || '-'}</Text>
              )
            ),
          },
        ]}
      />
    </Card>
  );
}
