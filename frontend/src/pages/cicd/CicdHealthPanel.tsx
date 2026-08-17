import { Card, Col, Row, Space, Tag, Typography } from 'antd';
import { JenkinsCicdHealthResult } from '../../services/api';

const { Text } = Typography;

function statusTag(status?: string) {
  if (status === 'passed') return <Tag color="success">通过</Tag>;
  if (status === 'warning') return <Tag color="warning">提醒</Tag>;
  if (status === 'blocked') return <Tag color="error">阻断</Tag>;
  return <Tag>检查</Tag>;
}

export function cicdHealthStatusTag(health?: JenkinsCicdHealthResult | null) {
  if (!health) return <Tag>未检查</Tag>;
  if (health.blockers.length > 0) return <Tag color="error">异常</Tag>;
  if (health.warnings.length > 0) return <Tag color="warning">需关注</Tag>;
  return <Tag color="success">正常</Tag>;
}

interface CicdHealthPanelProps {
  health: JenkinsCicdHealthResult | null;
  loading?: boolean;
}

export function CicdHealthPanel({ health, loading }: CicdHealthPanelProps) {
  return (
    <Card size="small" style={{ marginBottom: 16 }}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space wrap>
          <Text strong>CI/CD 健康检查</Text>
          {cicdHealthStatusTag(health)}
          {health?.checkedAt && (
            <Text type="secondary">
              {new Date(health.checkedAt).toLocaleString('zh-CN')}
            </Text>
          )}
        </Space>
        {health?.checks?.length ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {health.checks.map((check) => (
              <Row key={check.key} gutter={8} align="top">
                <Col flex="64px">{statusTag(check.status)}</Col>
                <Col flex="128px"><Text>{check.label}</Text></Col>
                <Col flex="auto">
                  <Text type={check.status === 'blocked' ? 'danger' : check.status === 'warning' ? 'secondary' : undefined}>
                    {check.message}
                  </Text>
                </Col>
              </Row>
            ))}
          </Space>
        ) : (
          <Text type="secondary">{loading ? '正在检查...' : '暂无检查结果'}</Text>
        )}
      </Space>
    </Card>
  );
}
