import { Alert, Button, Card, Input, Modal, Space, Table, Tabs, Tag, Typography } from 'antd';
import { BulbOutlined, DownloadOutlined, PieChartOutlined } from '@ant-design/icons';
import { JenkinsBuild, JenkinsBuildFailureAnalysis, JenkinsPackageSizeAnalysis } from '../../services/api';
import { ReleaseTimelineCard } from './ReleaseTimelineCard';
import { TestFlightDistributionCard } from './TestFlightDistributionCard';
import { AppStoreReleaseCard } from './AppStoreReleaseCard';
import { PackageSizeAnalysisPanel } from './PackageSizeAnalysisPanel';
import { canAnalyzeBuildFailure } from './cicdBuildUtils';

const { Paragraph, Text } = Typography;

export interface SelectedBuildLog {
  build: JenkinsBuild;
  log: string;
  thirdSdkBranch: string;
  thirdSdkRevision?: string;
  thirdSdkDependencies: Array<{ name: string; version: string; source: string }>;
  thirdSdkMissingFiles?: string[];
  thirdSdkError?: string;
}

function analysisSeverityColor(severity?: string) {
  if (severity === 'critical' || severity === 'high') return 'red';
  if (severity === 'medium') return 'orange';
  if (severity === 'low') return 'blue';
  return 'default';
}

interface BuildLogModalProps {
  open: boolean;
  selectedBuildLog: SelectedBuildLog | null;
  logLoading?: boolean;
  canPublishAppStore?: boolean;
  cancelingAppStoreReview?: number | null;
  buildFailureAnalysis: JenkinsBuildFailureAnalysis | null;
  buildFailureAnalysisLoading?: boolean;
  packageSizeAnalysis: JenkinsPackageSizeAnalysis | null;
  packageSizeLoading?: boolean;
  packageSizeError?: string;
  getChannelBuildNumber: (build: JenkinsBuild) => string;
  shouldUseInstalledProductionApp: (build?: JenkinsBuild | null) => boolean;
  onClose: () => void;
  onDownloadLog: () => void;
  onCancelAppStoreReview: (buildNumber: number) => void;
  onEnsureBuildFailureAnalysis: () => void;
  onAnalyzeBuildFailure: (force: boolean) => void;
  onEnsurePackageSizeAnalysis: (force?: boolean) => void;
}

export function BuildLogModal({
  open,
  selectedBuildLog,
  logLoading,
  canPublishAppStore,
  cancelingAppStoreReview,
  buildFailureAnalysis,
  buildFailureAnalysisLoading,
  packageSizeAnalysis,
  packageSizeLoading,
  packageSizeError,
  getChannelBuildNumber,
  shouldUseInstalledProductionApp,
  onClose,
  onDownloadLog,
  onCancelAppStoreReview,
  onEnsureBuildFailureAnalysis,
  onAnalyzeBuildFailure,
  onEnsurePackageSizeAnalysis,
}: BuildLogModalProps) {
  return (
    <Modal
      title={selectedBuildLog ? `打包日志 - #${selectedBuildLog.build.number}` : '打包日志'}
      open={open}
      width="82vw"
      footer={(
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button
            icon={<DownloadOutlined />}
            disabled={!selectedBuildLog?.log}
            onClick={onDownloadLog}
          >
            下载日志
          </Button>
        </Space>
      )}
      onCancel={onClose}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {selectedBuildLog && (
          <Space wrap>
            <Tag color="blue">构建 #{selectedBuildLog.build.number}</Tag>
            {selectedBuildLog.build.publishChannel && <Tag>{selectedBuildLog.build.publishChannel}</Tag>}
            {selectedBuildLog.build.branchName && <Tag>分支 {selectedBuildLog.build.branchName}</Tag>}
            {(selectedBuildLog.thirdSdkRevision || selectedBuildLog.build.commitHash) && (
              <Tag color="gold">commit {(selectedBuildLog.thirdSdkRevision || selectedBuildLog.build.commitHash || '').slice(0, 12)}</Tag>
            )}
            {getChannelBuildNumber(selectedBuildLog.build) && <Tag color="green">渠道构建号 {getChannelBuildNumber(selectedBuildLog.build)}</Tag>}
            {selectedBuildLog.build.appVersion && <Tag color="purple">APP {selectedBuildLog.build.appVersion}</Tag>}
          </Space>
        )}
        {selectedBuildLog?.build.testFlightWhatsNew && shouldUseInstalledProductionApp(selectedBuildLog.build) && (
          <Card size="small">
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Text strong>发布文案</Text>
              <Paragraph
                style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}
                copyable={{ text: selectedBuildLog.build.testFlightWhatsNew }}
              >
                {selectedBuildLog.build.testFlightWhatsNew}
              </Paragraph>
            </Space>
          </Card>
        )}
        <ReleaseTimelineCard releaseOrder={selectedBuildLog?.build.releaseOrder} />
        <TestFlightDistributionCard build={selectedBuildLog?.build} />
        <AppStoreReleaseCard
          build={selectedBuildLog?.build}
          canCancelReview={canPublishAppStore}
          cancelingBuildNumber={cancelingAppStoreReview}
          channelBuildNumber={selectedBuildLog?.build ? getChannelBuildNumber(selectedBuildLog.build) : ''}
          onCancelReview={onCancelAppStoreReview}
        />
        <Tabs
          key={selectedBuildLog?.build.number || 'build-log'}
          defaultActiveKey="build-log"
          onChange={(key) => {
            if (key === 'ai-analysis') onEnsureBuildFailureAnalysis();
            if (key === 'package-size') onEnsurePackageSizeAnalysis();
          }}
          items={[
            {
              key: 'build-log',
              label: '打包日志',
              children: (
                <Input.TextArea
                  value={logLoading ? '正在加载打包日志...' : selectedBuildLog?.log || '暂无打包日志'}
                  readOnly
                  autoSize={false}
                  style={{
                    height: '58vh',
                    fontFamily: 'Menlo, Monaco, Consolas, monospace',
                    fontSize: 12,
                    whiteSpace: 'pre',
                  }}
                />
              ),
            },
            {
              key: 'package-size',
              label: (
                <Space>
                  <PieChartOutlined />
                  <span>包体积分析</span>
                </Space>
              ),
              children: (
                <PackageSizeAnalysisPanel
                  analysis={packageSizeAnalysis}
                  loading={packageSizeLoading}
                  error={packageSizeError}
                  onRefresh={() => onEnsurePackageSizeAnalysis(true)}
                />
              ),
            },
            {
              key: 'third-sdk',
              label: (
                <Space>
                  <span>三方库</span>
                  <Tag color="blue">{selectedBuildLog?.thirdSdkDependencies.length || 0}</Tag>
                </Space>
              ),
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Space wrap>
                    <Text type="secondary">来源：当前构建主工程 Podfile</Text>
                    {selectedBuildLog?.thirdSdkBranch && <Tag color="geekblue">分支 {selectedBuildLog.thirdSdkBranch}</Tag>}
                  </Space>
                  {selectedBuildLog?.thirdSdkError && (
                    <Alert type="warning" showIcon message="读取 Podfile 失败" description={selectedBuildLog.thirdSdkError} />
                  )}
                  {selectedBuildLog?.thirdSdkMissingFiles?.length ? (
                    <Alert type="warning" showIcon message={`未找到：${selectedBuildLog.thirdSdkMissingFiles.join(', ')}`} />
                  ) : null}
                  {selectedBuildLog?.thirdSdkDependencies.length ? (
                    <Table
                      size="small"
                      rowKey={(record) => record.name}
                      pagination={false}
                      scroll={{ y: 430 }}
                      dataSource={selectedBuildLog.thirdSdkDependencies}
                      columns={[
                        {
                          title: '三方库',
                          dataIndex: 'name',
                          key: 'name',
                          width: 240,
                          render: (value: string) => <Text strong>{value}</Text>,
                        },
                        {
                          title: '版本',
                          dataIndex: 'version',
                          key: 'version',
                          width: 180,
                          render: (value: string) => <Tag color="purple">{value}</Tag>,
                        },
                      ]}
                    />
                  ) : (
                    <Text type="secondary">
                      {logLoading ? '正在读取 Podfile...' : '未从 Podfile 解析到三方库'}
                    </Text>
                  )}
                </Space>
              ),
            },
            ...(canAnalyzeBuildFailure(selectedBuildLog?.build, selectedBuildLog?.log) ? [{
              key: 'ai-analysis',
              label: (
                <Space>
                  <span>失败分析</span>
                  {buildFailureAnalysis && <Tag color={analysisSeverityColor(buildFailureAnalysis.severity)}>{buildFailureAnalysis.severity}</Tag>}
                </Space>
              ),
              children: (
                <Card size="small">
                  {buildFailureAnalysis ? (
                    <Space direction="vertical" size={10} style={{ width: '100%' }}>
                      <Alert
                        showIcon
                        type={buildFailureAnalysis.severity === 'critical' || buildFailureAnalysis.severity === 'high' ? 'error' : 'warning'}
                        message={buildFailureAnalysis.summary || '构建失败分析'}
                        description={(
                          <Space direction="vertical" size={6}>
                            <Space wrap>
                              <Tag color={analysisSeverityColor(buildFailureAnalysis.severity)}>{buildFailureAnalysis.severity}</Tag>
                              <Tag color="blue">{buildFailureAnalysis.stage || '未知阶段'}</Tag>
                              {buildFailureAnalysis.ownerHint && <Tag>{buildFailureAnalysis.ownerHint}</Tag>}
                              {buildFailureAnalysis.needsManualAction && <Tag color="orange">需要人工处理</Tag>}
                            </Space>
                            <Text>{buildFailureAnalysis.rootCause}</Text>
                          </Space>
                        )}
                      />
                      {buildFailureAnalysis.evidence?.length > 0 && (
                        <div>
                          <Text strong>关键证据</Text>
                          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                            {buildFailureAnalysis.evidence.map((item, index) => (
                              <li key={`${index}-${item}`}>
                                <Text code style={{ whiteSpace: 'pre-wrap' }}>{item}</Text>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {buildFailureAnalysis.suggestions?.length > 0 && (
                        <div>
                          <Text strong>处理建议</Text>
                          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                            {buildFailureAnalysis.suggestions.map((item, index) => (
                              <li key={`${index}-${item}`}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <Button icon={<BulbOutlined />} loading={buildFailureAnalysisLoading} onClick={() => onAnalyzeBuildFailure(true)}>
                        重新失败分析
                      </Button>
                    </Space>
                  ) : (
                    <Alert
                      showIcon
                      type="error"
                      message="构建失败，可发起失败分析"
                      description="会优先定位第一处关键失败日志，并给出根因、证据和处理建议。"
                      action={(
                        <Button size="small" icon={<BulbOutlined />} loading={buildFailureAnalysisLoading} onClick={() => onAnalyzeBuildFailure(false)}>
                          失败分析
                        </Button>
                      )}
                    />
                  )}
                </Card>
              ),
            }] : []),
          ]}
        />
      </Space>
    </Modal>
  );
}
