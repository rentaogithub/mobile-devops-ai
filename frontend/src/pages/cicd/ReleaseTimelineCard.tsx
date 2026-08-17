import { Alert, Card, Col, Row, Space, Tag, Typography } from 'antd';
import { JenkinsReleaseOrder, JenkinsReleaseOrderEvent } from '../../services/api';

const { Text } = Typography;

function releaseOrderStatusTag(status?: string) {
  if (status === 'published') return <Tag color="success">已发布</Tag>;
  if (status === 'uploaded') return <Tag color="blue">已上传</Tag>;
  if (status === 'running' || status === 'queued' || status === 'syncing') return <Tag color="processing">进行中</Tag>;
  if (status === 'failed') return <Tag color="error">失败</Tag>;
  if (status === 'canceled') return <Tag color="default">已取消</Tag>;
  if (status === 'preflight_passed') return <Tag color="green">预检通过</Tag>;
  return status ? <Tag>{status}</Tag> : <Tag>未关联</Tag>;
}

function releaseOrderEventTag(status?: string) {
  if (status === 'success') return <Tag color="success">完成</Tag>;
  if (status === 'processing') return <Tag color="processing">进行中</Tag>;
  if (status === 'warning') return <Tag color="warning">需关注</Tag>;
  if (status === 'error') return <Tag color="error">失败</Tag>;
  return <Tag>记录</Tag>;
}

function formatDurationBetween(start?: string, end?: string) {
  const startTime = Date.parse(String(start || ''));
  const endTime = Date.parse(String(end || ''));
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return '';
  const seconds = Math.round((endTime - startTime) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  if (minutes < 60) return remainSeconds ? `${minutes}m ${remainSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}

function eventsWithDurations(events?: JenkinsReleaseOrderEvent[]) {
  const list = Array.isArray(events) ? events : [];
  return list.map((event, index) => ({
    ...event,
    elapsedFromPrevious: index > 0 ? formatDurationBetween(list[index - 1]?.at, event.at) : '',
  }));
}

interface ReleaseTimelineCardProps {
  releaseOrder?: JenkinsReleaseOrder;
}

export function ReleaseTimelineCard({ releaseOrder }: ReleaseTimelineCardProps) {
  if (!releaseOrder) return null;

  return (
    <Card size="small">
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space wrap>
          <Text strong>发布进度</Text>
          {releaseOrderStatusTag(releaseOrder.status)}
          {releaseOrder.updatedAt && (
            <Text type="secondary">
              最后同步 {new Date(releaseOrder.updatedAt).toLocaleString('zh-CN')}
            </Text>
          )}
        </Space>
        {releaseOrder.failureReason && (
          <Alert
            type="error"
            showIcon
            message="发布异常"
            description={releaseOrder.failureReason}
          />
        )}
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {eventsWithDurations(releaseOrder.events).slice(-10).map((event) => (
            <Row key={event.id} gutter={12} align="top">
              <Col flex="108px">
                <Text type="secondary">
                  {event.at ? new Date(event.at).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  }) : '-'}
                </Text>
              </Col>
              <Col flex="88px">{releaseOrderEventTag(event.status)}</Col>
              <Col flex="auto">
                <Space direction="vertical" size={2}>
                  <Space size={6} wrap>
                    <Text>{event.title}</Text>
                    {event.elapsedFromPrevious && <Tag color="default">+{event.elapsedFromPrevious}</Tag>}
                  </Space>
                  {event.detail && <Text type="secondary">{event.detail}</Text>}
                </Space>
              </Col>
            </Row>
          ))}
        </Space>
      </Space>
    </Card>
  );
}

export { releaseOrderStatusTag };
