import { Typography, Card, Row, Col, Input, Button, Space, DatePicker, Select, Table, Tag, Empty } from 'antd';
import {
  FileSearchOutlined,
  SearchOutlined,
  ReloadOutlined,
  DownloadOutlined,
} from '@ant-design/icons';

const { Title, Paragraph } = Typography;
const { RangePicker } = DatePicker;

const logColumns = [
  { title: '时间', dataIndex: 'timestamp', key: 'timestamp', width: 180 },
  {
    title: '级别',
    dataIndex: 'level',
    key: 'level',
    width: 100,
    render: (level: string) => {
      const colorMap: Record<string, string> = {
        ERROR: 'red', WARN: 'orange', INFO: 'blue', DEBUG: 'default',
      };
      return <Tag color={colorMap[level] || 'default'}>{level}</Tag>;
    },
  },
  { title: '模块', dataIndex: 'module', key: 'module', width: 150 },
  { title: '内容', dataIndex: 'message', key: 'message', ellipsis: true },
];

export default function LogsPage() {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <Title level={4}>
          <FileSearchOutlined style={{ marginRight: 8, color: '#faad14' }} />
          日志分析
        </Title>
        <Paragraph type="secondary">
          收集和分析应用运行日志，支持日志检索、统计分析和异常告警
        </Paragraph>
      </div>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {[
          { label: '今日日志', value: 0, color: '#1677ff' },
          { label: 'ERROR', value: 0, color: '#ff4d4f' },
          { label: 'WARN', value: 0, color: '#faad14' },
          { label: 'INFO', value: 0, color: '#52c41a' },
        ].map((stat) => (
          <Col xs={12} sm={6} key={stat.label}>
            <Card size="small" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 'bold', color: stat.color }}>{stat.value}</div>
              <div style={{ color: '#999', fontSize: 13 }}>{stat.label}</div>
            </Card>
          </Col>
        ))}
      </Row>

      <Card>
        <Space wrap style={{ marginBottom: 16, width: '100%' }}>
          <Input placeholder="搜索日志内容..." prefix={<SearchOutlined />} style={{ width: 300 }} />
          <Select placeholder="日志级别" style={{ width: 120 }} allowClear
            options={[
              { value: 'ERROR', label: 'ERROR' },
              { value: 'WARN', label: 'WARN' },
              { value: 'INFO', label: 'INFO' },
              { value: 'DEBUG', label: 'DEBUG' },
            ]}
          />
          <RangePicker showTime />
          <Button icon={<ReloadOutlined />}>刷新</Button>
          <Button icon={<DownloadOutlined />}>导出</Button>
        </Space>
        <Empty description="暂无日志数据，请先配置日志采集源">
          <Button type="primary">配置日志源</Button>
        </Empty>
        <Table columns={logColumns} dataSource={[]} style={{ display: 'none' }} />
      </Card>
    </div>
  );
}
