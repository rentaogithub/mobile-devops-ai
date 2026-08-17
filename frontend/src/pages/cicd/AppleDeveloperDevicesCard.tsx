import { Alert, Button, Card, Input, Space, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { AppleDeveloperDevice } from '../../services/api';

const { Text } = Typography;

interface AppleDeveloperDevicesCardProps {
  total?: number;
  devices: AppleDeveloperDevice[];
  loading?: boolean;
  error?: string;
  keyword: string;
  onKeywordChange: (value: string) => void;
  onRefresh: () => void;
}

export function AppleDeveloperDevicesCard({
  total,
  devices,
  loading,
  error,
  keyword,
  onKeywordChange,
  onRefresh,
}: AppleDeveloperDevicesCardProps) {
  return (
    <Card
      title={(
        <Space>
          <span>Apple Developer 设备列表</span>
          <Tag color="blue">iPhone</Tag>
          <Tag>{total || 0} 台</Tag>
          {keyword.trim() && <Tag color="green">匹配 {devices.length} 台</Tag>}
        </Space>
      )}
      extra={(
        <Button icon={<ReloadOutlined />} onClick={onRefresh} loading={loading}>
          刷新列表
        </Button>
      )}
    >
      {error && (
        <Alert
          showIcon
          type="warning"
          message="暂未拉取到 Apple Developer 设备列表"
          description={(
            <Space direction="vertical" size={4}>
              <Text>{error}</Text>
              <Text type="secondary">
                设备列表来自 Apple Developer 的 Certificates, Identifiers &amp; Profiles 设备接口；当前 key 鉴权通过前，列表会保持为空。
              </Text>
            </Space>
          )}
          style={{ marginBottom: 12 }}
        />
      )}
      <Input.Search
        allowClear
        value={keyword}
        onChange={(event) => onKeywordChange(event.target.value)}
        placeholder="搜索 UDID、设备名称或型号"
        style={{ maxWidth: 420, marginBottom: 12 }}
      />
      <Table<AppleDeveloperDevice>
        rowKey={(record) => record.id || record.udid}
        loading={loading && !error}
        dataSource={devices}
        tableLayout="fixed"
        scroll={{ x: 980 }}
        pagination={{ pageSize: 10, showSizeChanger: false }}
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
            title: '类型',
            dataIndex: 'deviceClass',
            key: 'deviceClass',
            width: 120,
            render: (value: string | undefined, record) => value || record.platform || <Text type="secondary">-</Text>,
          },
          {
            title: '型号',
            dataIndex: 'model',
            key: 'model',
            width: 140,
            ellipsis: true,
            render: (value?: string) => value || <Text type="secondary">-</Text>,
          },
          {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            width: 110,
            render: (value?: string) => value ? <Tag color={value === 'ENABLED' ? 'green' : 'default'}>{value}</Tag> : <Text type="secondary">-</Text>,
          },
          {
            title: '注册时间',
            dataIndex: 'addedDate',
            key: 'addedDate',
            width: 140,
            render: (value?: string) => value || <Text type="secondary">-</Text>,
          },
        ]}
      />
    </Card>
  );
}
