import { Typography, Card, Row, Col, Button, Space, Empty } from 'antd';
import {
  RocketOutlined,
  PlusOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';

const { Title, Paragraph } = Typography;

export default function CICDPage() {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <Title level={4}>
          <RocketOutlined style={{ marginRight: 8, color: '#722ed1' }} />
          CI/CD 管理
        </Title>
        <Paragraph type="secondary">
          配置和管理持续集成与持续部署流水线，自动化构建、测试和发布流程
        </Paragraph>
      </div>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {[
          { label: '总流水线', value: 0, color: '#1677ff' },
          { label: '运行中', value: 0, color: '#52c41a' },
          { label: '今日构建', value: 0, color: '#722ed1' },
          { label: '成功率', value: '-', color: '#faad14' },
        ].map((stat) => (
          <Col xs={12} sm={6} key={stat.label}>
            <Card size="small" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 'bold', color: stat.color }}>{stat.value}</div>
              <div style={{ color: '#999', fontSize: 13 }}>{stat.label}</div>
            </Card>
          </Col>
        ))}
      </Row>

      <Card
        title="流水线列表"
        extra={
          <Space>
            <Button icon={<PlayCircleOutlined />}>手动触发</Button>
            <Button type="primary" icon={<PlusOutlined />}>新建流水线</Button>
          </Space>
        }
      >
        <Empty description="暂无流水线配置">
          <Button type="primary">创建第一条流水线</Button>
        </Empty>
      </Card>
    </div>
  );
}
