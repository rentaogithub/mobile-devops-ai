import { Typography, Card, Table, Tag, Button, Space, Input, Empty } from 'antd';
import {
  NodeIndexOutlined,
  SearchOutlined,
  PlusOutlined,
  ExportOutlined,
  ImportOutlined,
} from '@ant-design/icons';

const { Title, Paragraph } = Typography;

const routeColumns = [
  { title: '路由路径', dataIndex: 'path', key: 'path', render: (t: string) => <code>{t}</code> },
  { title: '模块', dataIndex: 'module', key: 'module' },
  { title: '目标页面', dataIndex: 'target', key: 'target' },
  {
    title: '类型',
    dataIndex: 'type',
    key: 'type',
    render: (type: string) => {
      const colorMap: Record<string, string> = { native: 'blue', h5: 'green', hybrid: 'purple' };
      return <Tag color={colorMap[type] || 'default'}>{type}</Tag>;
    },
  },
  {
    title: '状态',
    dataIndex: 'status',
    key: 'status',
    render: (s: string) => <Tag color={s === '启用' ? 'green' : 'red'}>{s}</Tag>,
  },
  {
    title: '操作',
    key: 'action',
    render: () => (
      <Space>
        <Button type="link" size="small">编辑</Button>
        <Button type="link" size="small">测试跳转</Button>
      </Space>
    ),
  },
];

export default function RoutesPage() {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <Title level={4}>
          <NodeIndexOutlined style={{ marginRight: 8, color: '#13c2c2' }} />
          路由管理
        </Title>
        <Paragraph type="secondary">
          管理 App 内路由配置，支持路由注册、跳转测试和路由表可视化
        </Paragraph>
      </div>

      <Card>
        <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
          <Space>
            <Input placeholder="搜索路由..." prefix={<SearchOutlined />} style={{ width: 300 }} />
          </Space>
          <Space>
            <Button icon={<ImportOutlined />}>导入路由表</Button>
            <Button icon={<ExportOutlined />}>导出路由表</Button>
            <Button type="primary" icon={<PlusOutlined />}>添加路由</Button>
          </Space>
        </Space>
        <Empty description="暂无路由配置，请导入或手动添加路由">
          <Button type="primary">导入路由表</Button>
        </Empty>
        <Table columns={routeColumns} dataSource={[]} style={{ display: 'none' }} />
      </Card>
    </div>
  );
}
