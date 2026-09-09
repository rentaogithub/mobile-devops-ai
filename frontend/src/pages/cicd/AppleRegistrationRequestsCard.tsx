import { Alert, Button, Card, Space, Table, Tag, Typography } from 'antd';
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
      <Alert showIcon type="info" message="新设备先提交申请，由管理员点击“批准并注册”后才写入 Apple。Apple 中已存在的设备不会重复申请，请在设备列表查看。" style={{ marginBottom: 12 }} />
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
            title: '申请 / 审核记录',
            key: 'approval',
            width: 190,
            render: (_, record) => (
              <Space direction="vertical" size={2}>
                <Text type="secondary">申请：{new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })}</Text>
                {record.approvedAt && <Text type="secondary">审核：{record.approvedBy || '未记录审核人'} · {new Date(record.approvedAt).toLocaleString('zh-CN', { hour12: false })}</Text>}
              </Space>
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
