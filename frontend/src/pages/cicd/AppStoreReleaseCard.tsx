import { Alert, Button, Card, Descriptions, Popconfirm, Space, Tag, Typography } from 'antd';
import { JenkinsBuild } from '../../services/api';

const { Paragraph, Text } = Typography;

export function appStoreReleaseTag(build: JenkinsBuild) {
  if (build.publishChannel !== 'AppStore') {
    return <Text type="secondary">-</Text>;
  }
  if (build.building) {
    return <Tag color="processing">等待打包完成</Tag>;
  }
  if (build.result && build.result !== 'SUCCESS') {
    return <Text type="secondary">-</Text>;
  }
  const release = build.appStoreRelease;
  if (!release) {
    return <Tag color="default">待监听</Tag>;
  }
  const title = release.message || release.appStoreState || undefined;
  if (release.status === 'ready_for_review') {
    return <Tag color="processing" title={title}>自动提交中</Tag>;
  }
  if (release.status === 'waiting_for_review') {
    return <Tag color="processing" title={title}>等待审核</Tag>;
  }
  if (release.status === 'in_review') {
    return <Tag color="processing" title={title}>审核中</Tag>;
  }
  if (release.status === 'pending_release') {
    return <Tag color="processing" title={title}>等待发布</Tag>;
  }
  if (release.status === 'ready_for_distribution') {
    return <Tag color="success" title={title}>可供分发</Tag>;
  }
  if (release.status === 'ready_for_sale') {
    return <Tag color="success" title={title}>已上架</Tag>;
  }
  if (release.status === 'rejected') {
    return <Tag color="error" title={title}>审核被拒</Tag>;
  }
  if (release.status === 'developer_rejected') {
    return <Tag color="default" title={title}>已取消审核</Tag>;
  }
  if (release.status === 'developer_action_needed') {
    return <Tag color="error" title={title}>需处理</Tag>;
  }
  if (release.status === 'pending_agreement') {
    return <Tag color="warning" title={title}>协议待处理</Tag>;
  }
  if (release.status === 'uploaded') {
    return <Tag color="blue" title={title}>已上传</Tag>;
  }
  if (release.status === 'waiting_processing') {
    return <Tag color="processing" title={title}>处理中</Tag>;
  }
  if (release.status === 'failed') {
    return <Tag color="error" title={title}>审核异常</Tag>;
  }
  if (release.status === 'skipped') {
    return <Tag color="warning" title={title}>未配置</Tag>;
  }
  return <Tag color="warning" title={title}>无法确认</Tag>;
}

function appStoreManualIntervention(build: JenkinsBuild) {
  if (build.publishChannel !== 'AppStore' || build.building || build.result !== 'SUCCESS') return null;
  const release = build.appStoreRelease;
  if (!release) {
    return {
      type: 'info' as const,
      message: '等待平台监听 App Store 发布状态',
      description: '构建刚完成或列表尚未刷新，平台会继续轮询 App Store Connect。',
    };
  }
  const status = String(release.status || '');
  const detail = release.failureReason || release.message || release.appStoreState || '';
  if (status === 'ready_for_review') {
    return {
      type: 'info' as const,
      message: '等待自动提交 App Store 审核',
      description: detail || 'App Store Connect 构建已处理完成，平台会自动提交审核。',
    };
  }
  if (status === 'pending_agreement') {
    return {
      type: 'warning' as const,
      message: 'Apple 协议待处理，需要人工介入',
      description: detail || '请使用 Account Holder/Admin 账号进入 App Store Connect 完成协议签署。',
    };
  }
  if (status === 'pending_release') {
    return {
      type: 'warning' as const,
      message: '审核已通过，等待 ASC 发布',
      description: detail || '平台已将 ASC 版本设置为审核通过后自动上架，并会继续监听至已上架；如果长时间停留，请检查 ASC 版本发布方式是否保存成功。',
    };
  }
  if (['developer_action_needed', 'rejected', 'developer_rejected', 'failed', 'skipped', 'unconfirmed'].includes(status)) {
    return {
      type: status === 'skipped' || status === 'unconfirmed' ? 'warning' as const : 'error' as const,
      message: 'App Store 发布需要人工处理',
      description: detail || '请到 App Store Connect 检查版本信息、审核反馈、API Key 权限或构建处理状态。',
    };
  }
  return null;
}

function appStoreReleaseTypeText(releaseType?: string) {
  if (releaseType === 'AFTER_APPROVAL') return '审核通过后自动上架';
  if (releaseType === 'MANUAL') return '手动发布';
  if (releaseType === 'SCHEDULED') return '定时发布';
  return releaseType || '-';
}

interface AppStoreReleaseCardProps {
  build?: JenkinsBuild;
  canCancelReview?: boolean;
  cancelingBuildNumber?: number | null;
  channelBuildNumber?: string;
  onCancelReview?: (buildNumber: number) => void;
}

export function AppStoreReleaseCard({
  build,
  canCancelReview,
  cancelingBuildNumber,
  channelBuildNumber,
  onCancelReview,
}: AppStoreReleaseCardProps) {
  if (!build || build.publishChannel !== 'AppStore') return null;

  const intervention = appStoreManualIntervention(build);
  const canShowCancelReview = Boolean(
    canCancelReview &&
    onCancelReview &&
    build.appStoreRelease &&
    ['waiting_for_review', 'in_review'].includes(String(build.appStoreRelease.status || ''))
  );

  return (
    <Card size="small">
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {build.appStoreRelease && (
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="审核状态">
              <Space size={4} wrap>
                {appStoreReleaseTag(build)}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="更新时间">
              {build.appStoreRelease.updatedAt
                ? new Date(build.appStoreRelease.updatedAt).toLocaleString('zh-CN')
                : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="上架方式">
              {appStoreReleaseTypeText(build.appStoreRelease.releaseType)}
            </Descriptions.Item>
            {build.appStoreRelease.failureReason && (
              <Descriptions.Item label="失败原因" span={2}>
                <Text type="danger">{build.appStoreRelease.failureReason}</Text>
              </Descriptions.Item>
            )}
            {(build.appStoreRelease.releaseNotes || build.testFlightWhatsNew) && (
              <Descriptions.Item label="提审文案" span={2}>
                <Paragraph
                  style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}
                  copyable={{ text: build.appStoreRelease.releaseNotes || build.testFlightWhatsNew }}
                >
                  {build.appStoreRelease.releaseNotes || build.testFlightWhatsNew}
                </Paragraph>
              </Descriptions.Item>
            )}
          </Descriptions>
        )}
        {intervention && (
          <Alert
            showIcon
            type={intervention.type}
            message={intervention.message}
            description={intervention.description}
          />
        )}
        {canShowCancelReview && (
          <Alert
            type="warning"
            showIcon
            message="当前正式包正在审核"
            description="停止审核会从 App Store Connect 撤回当前版本，后续需要重新提交审核。"
            action={(
              <Popconfirm
                title="停止 App Store 审核？"
                description={`确定停止 #${build.number} / ${channelBuildNumber || '-'} 的 App Store 审核吗？`}
                okText="停止审核"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => onCancelReview?.(build.number)}
              >
                <Button
                  danger
                  size="small"
                  loading={cancelingBuildNumber === build.number}
                >
                  停止审核
                </Button>
              </Popconfirm>
            )}
          />
        )}
      </Space>
    </Card>
  );
}
