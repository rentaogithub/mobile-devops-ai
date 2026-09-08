import { Alert, Button, Card, Col, Row, Select, Space, Tag, Typography } from 'antd';
import { QualityDevicePool, QualityDevicePoolStatusResult } from '../../services/api';

const { Text } = Typography;

function configuredDevices(pool: QualityDevicePool): NonNullable<QualityDevicePool['devices']> {
  return pool.devices?.length ? pool.devices : (pool.deviceId ? [{ udid: pool.deviceId }] : []);
}

function deviceStatusTag(status?: string) {
  if (status === 'idle') return <Tag color="green">空闲</Tag>;
  if (status === 'busy') return <Tag color="orange">占用</Tag>;
  if (status === 'offline') return <Tag color="red">离线</Tag>;
  return <Tag>{status || '未知'}</Tag>;
}

interface QualityDevicePoolOverviewProps {
  error?: string;
  status?: QualityDevicePoolStatusResult | null;
  pools: QualityDevicePool[];
  canAdmin?: boolean;
  unassignedTargetPool?: string;
  adding?: boolean;
  onUnassignedTargetPoolChange: (value: string) => void;
  onAddUnassignedDevices: () => void;
}

export function QualityDevicePoolOverview({
  error,
  status,
  pools,
  canAdmin,
  unassignedTargetPool,
  adding,
  onUnassignedTargetPoolChange,
  onAddUnassignedDevices,
}: QualityDevicePoolOverviewProps) {
  return (
    <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
      {error && (
        <Col span={24}>
          <Alert type="error" showIcon message="设备池加载失败" description={error} />
        </Col>
      )}
      {status?.detector && !status.detector.available && (
        <Col span={24}>
          <Alert
            type="warning"
            showIcon
            message="无法检测本机 iOS 设备在线状态"
            description={status.detector.error}
          />
        </Col>
      )}
      {(status?.unassignedDevices || []).length > 0 && (
        <Col span={24}>
          <Alert
            type="info"
            showIcon
            message="检测到未加入设备池的在线设备"
            description={(status?.unassignedDevices || []).map((device) => `${device.udid}${device.marketName ? ` ${device.marketName}` : ''}`).join('；')}
            action={canAdmin ? (
              <Space>
                <Select
                  size="small"
                  value={unassignedTargetPool}
                  style={{ width: 160 }}
                  options={pools.map((pool) => ({ label: pool.label, value: pool.value }))}
                  onChange={onUnassignedTargetPoolChange}
                />
                <Button size="small" type="primary" loading={adding} onClick={onAddUnassignedDevices}>
                  加入设备池
                </Button>
              </Space>
            ) : undefined}
          />
        </Col>
      )}
      {pools.map((pool) => (
        <Col xs={24} md={8} key={pool.value}>
          <Card size="small" title={pool.label}>
            <Space direction="vertical" size={8}>
              <Space wrap>
                <Tag color="blue">{pool.value}</Tag>
                {(pool.devices?.length || pool.deviceId) && (
                  <Tag color="purple">设备 {pool.devices?.length || 1} 台</Tag>
                )}
                {pool.stats && <Tag color="green">空闲 {pool.stats.idle}</Tag>}
                {pool.stats && pool.stats.busy > 0 && <Tag color="orange">占用 {pool.stats.busy}</Tag>}
                {pool.stats && pool.stats.offline > 0 && <Tag color="red">离线 {pool.stats.offline}</Tag>}
              </Space>
              {configuredDevices(pool).slice(0, 4).map((device) => (
                <Space key={device.udid} size={4} wrap>
                  {deviceStatusTag(device.status)}
                  <Text code style={{ fontSize: 12 }}>{device.udid}</Text>
                  {(device.marketName || device.productVersion) && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {[device.marketName, device.productVersion].filter(Boolean).join(' / ')}
                    </Text>
                  )}
                  {device.activeBuildNumber && <Tag>#{device.activeBuildNumber}</Tag>}
                </Space>
              ))}
              <Text type="secondary">{pool.description}</Text>
            </Space>
          </Card>
        </Col>
      ))}
      {!error && pools.length === 0 && (
        <Col span={24}>
          <Alert type="warning" showIcon message="暂无质检设备池配置" />
        </Col>
      )}
    </Row>
  );
}
