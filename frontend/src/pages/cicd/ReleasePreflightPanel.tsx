import { Card, Col, Row, Space, Tag, Typography } from 'antd';
import { JenkinsReleasePreflightResult } from '../../services/api';

const { Text } = Typography;

function releasePreflightStatusTag(status?: string) {
  if (status === 'passed') return <Tag color="success">通过</Tag>;
  if (status === 'warning') return <Tag color="warning">提醒</Tag>;
  if (status === 'blocked') return <Tag color="error">阻断</Tag>;
  return <Tag>检查</Tag>;
}

interface ReleasePreflightPanelProps {
  loading?: boolean;
  preflight?: JenkinsReleasePreflightResult | null;
  error?: string;
}

export function ReleasePreflightPanel({ loading, preflight, error }: ReleasePreflightPanelProps) {
  if (!loading && !preflight && !error) return null;

  return (
    <Card size="small" style={{ marginTop: 8 }}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap>
          <Text strong>发布前预检</Text>
          {loading ? <Tag color="processing">检查中</Tag> : preflight?.passed ? <Tag color="success">可发布</Tag> : <Tag color="error">需处理</Tag>}
        </Space>
        {error && !preflight && (
          <Text type="danger">{error}</Text>
        )}
        {(preflight?.checks || []).map((check) => (
          <Row key={check.key} gutter={8} align="top">
            <Col flex="64px">{releasePreflightStatusTag(check.status)}</Col>
            <Col flex="96px"><Text>{check.label}</Text></Col>
            <Col flex="auto">
              <Text type={check.status === 'blocked' ? 'danger' : check.status === 'warning' ? 'secondary' : undefined}>
                {check.message}
              </Text>
            </Col>
          </Row>
        ))}
      </Space>
    </Card>
  );
}
