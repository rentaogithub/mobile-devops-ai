import { Alert, Card, Descriptions, Space, Tag, Typography } from 'antd';
import { JenkinsBuild } from '../../services/api';

const { Text } = Typography;

export function testFlightDistributionTag(build: JenkinsBuild) {
  if (build.publishChannel !== 'TestFlight') {
    return <Text type="secondary">-</Text>;
  }
  if (build.building) {
    return <Tag color="processing">等待打包完成</Tag>;
  }
  if (build.result && build.result !== 'SUCCESS') {
    return <Text type="secondary">-</Text>;
  }
  const distribution = build.testFlightDistribution;
  if (!distribution) {
    return <Tag color="default">待监听</Tag>;
  }
  const title = distribution.message || distribution.groups?.map((group) => group.name).join('、') || undefined;
  if (distribution.status === 'distributed') {
    return <Tag color="success" title={title}>已分发</Tag>;
  }
  if (distribution.status === 'uploaded') {
    return <Tag color="blue" title={title}>已上传</Tag>;
  }
  if (distribution.status === 'waiting_processing') {
    return <Tag color="processing" title={title}>处理中</Tag>;
  }
  if (distribution.status === 'ready_for_submission') {
    return <Tag color="warning" title={title}>准备提交</Tag>;
  }
  if (distribution.status === 'in_beta_review') {
    return <Tag color="processing" title={title}>审核中</Tag>;
  }
  if (distribution.status === 'skipped') {
    return <Tag color="warning" title={title}>未配置</Tag>;
  }
  if (distribution.status === 'unconfirmed') {
    return <Tag color="warning" title={title}>无法确认</Tag>;
  }
  if (distribution.status === 'failed') {
    return <Tag color="error" title={title}>分发失败</Tag>;
  }
  return <Tag title={title}>待监听</Tag>;
}

function testFlightManualIntervention(build: JenkinsBuild) {
  if (build.publishChannel !== 'TestFlight' || build.building || build.result !== 'SUCCESS') return null;
  const distribution = build.testFlightDistribution;
  if (!distribution) {
    return {
      type: 'info' as const,
      message: '等待平台监听 TestFlight 分发状态',
      description: '构建刚完成或列表尚未刷新，平台会继续轮询 App Store Connect。',
    };
  }
  const status = String(distribution.status || '');
  const rawMessage = String(distribution.message || '').trim();
  if (status === 'skipped') {
    return {
      type: 'warning' as const,
      message: 'TestFlight 自动分发未启用',
      description: rawMessage || '缺少 App Store Connect App ID 或 TestFlight 测试组配置，需要管理员补齐平台配置后重新触发或刷新。',
    };
  }
  if (status === 'failed') {
    return {
      type: 'error' as const,
      message: 'TestFlight 自动分发失败，需要人工处理',
      description: rawMessage || '请检查 App Store Connect API Key 权限、Apple 协议、构建处理状态或测试组配置。',
    };
  }
  if (status === 'unconfirmed') {
    const needsExportCompliance = /出口合规|MISSING_EXPORT_COMPLIANCE/i.test(`${rawMessage} ${distribution.externalBuildState || ''}`);
    return {
      type: 'warning' as const,
      message: needsExportCompliance ? '缺少出口合规信息，需要到 App Store Connect 处理' : 'TestFlight 状态无法确认，需要人工核对',
      description: rawMessage || '平台暂时无法确认外部测试状态，请到 App Store Connect 检查构建处理、测试组和审核状态。',
    };
  }
  if (status === 'uploaded' && /无法|确认|团队|API Key/i.test(rawMessage)) {
    return {
      type: 'warning' as const,
      message: '已上传但未确认分发，需要人工核对',
      description: rawMessage,
    };
  }
  return null;
}

interface TestFlightDistributionCardProps {
  build?: JenkinsBuild;
}

export function TestFlightDistributionCard({ build }: TestFlightDistributionCardProps) {
  if (!build || build.publishChannel !== 'TestFlight') return null;

  const intervention = testFlightManualIntervention(build);

  return (
    <Card size="small">
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Text strong>TestFlight 分发状态</Text>
        {build.testFlightDistribution ? (
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="分发状态">
              <Space size={4} wrap>
                {testFlightDistributionTag(build)}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="更新时间">
              {build.testFlightDistribution.updatedAt
                ? new Date(build.testFlightDistribution.updatedAt).toLocaleString('zh-CN')
                : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="内部测试">
              {build.testFlightDistribution.internalBuildState || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="外部测试">
              {build.testFlightDistribution.externalBuildState || '-'}
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Alert type="info" showIcon message="等待平台监听 TestFlight 分发状态" />
        )}
        {intervention && (
          <Alert
            showIcon
            type={intervention.type}
            message={intervention.message}
            description={intervention.description}
          />
        )}
      </Space>
    </Card>
  );
}
