import { useEffect, useMemo, useState } from 'react';
import { Typography, Card, Row, Col, Button, Space, Table, Tag, message, Modal, Alert, Radio, Input, Select, QRCode, AutoComplete, Popconfirm, Tabs } from 'antd';
import {
  RocketOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  ExportOutlined,
  DownloadOutlined,
  StopOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import { JenkinsBuild, JenkinsBuildListResult, jenkinsApi } from '../services/api';

const { Title, Paragraph, Text } = Typography;
type DeployTarget = 'Pgyer' | 'TestFlight' | 'AppStore';

const DEPLOY_TARGET_OPTIONS: { label: string; value: DeployTarget }[] = [
  { label: '蒲公英', value: 'Pgyer' },
  { label: 'TestFlight', value: 'TestFlight' },
  { label: '苹果商店', value: 'AppStore' },
];

function isReleaseBranch(branch: string) {
  return /^(?:origin\/)?release\/\d+(?:\.\d+){2,}$/.test(branch.trim());
}

function getReleaseVersion(branch: string) {
  const match = branch.trim().replace(/^origin\//, '').match(/^release\/(\d+(?:\.\d+){2,})$/);
  return match ? match[1].split('.').map((item) => Number(item)) : [];
}

function compareReleaseBranches(a: string, b: string) {
  const av = getReleaseVersion(a);
  const bv = getReleaseVersion(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (av[i] || 0) - (bv[i] || 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function getHighestReleaseBranch(list: string[]) {
  return list.filter(isReleaseBranch).sort(compareReleaseBranches).at(-1) || '';
}

function formatBuildTime(timestamp: number) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString();
}

function formatDuration(duration: number, building: boolean) {
  if (!duration && building) return '运行中';
  if (!duration) return '-';
  const seconds = Math.round(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}分${restSeconds}秒` : `${restSeconds}秒`;
}

function resultTag(build: JenkinsBuild) {
  if (build.building) {
    return <Tag color="processing">运行中</Tag>;
  }
  switch (build.result) {
    case 'SUCCESS':
      return <Tag color="green">成功</Tag>;
    case 'FAILURE':
      return <Tag color="red">失败</Tag>;
    case 'ABORTED':
      return <Tag color="default">已取消</Tag>;
    case 'UNSTABLE':
      return <Tag color="orange">不稳定</Tag>;
    default:
      return <Tag>未知</Tag>;
  }
}

export default function CICDPage() {
  const [data, setData] = useState<JenkinsBuildListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [stoppingBuild, setStoppingBuild] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [qrPreview, setQrPreview] = useState<{ url: string; channel?: string; buildNumber?: string } | null>(null);
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [selectedBuildLog, setSelectedBuildLog] = useState<{
    build: JenkinsBuild;
    log: string;
    thirdSdkBranch: string;
    thirdSdkRevision?: string;
    thirdSdkDependencies: Array<{ name: string; version: string; source: string }>;
    thirdSdkMissingFiles?: string[];
    thirdSdkError?: string;
  } | null>(null);
  const [deployTarget, setDeployTarget] = useState<DeployTarget>('Pgyer');
  const [filterDeployTarget, setFilterDeployTarget] = useState<DeployTarget | ''>('');
  const [publishBranch, setPublishBranch] = useState('develop');
  const [branches, setBranches] = useState<string[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [verificationPassword, setVerificationPassword] = useState('');

  const loadBuilds = async (target = filterDeployTarget) => {
    setLoading(true);
    setError('');
    try {
      const response = await jenkinsApi.listNNBuilds({ deployTarget: target });
      setData(response.data || null);
    } catch (err: any) {
      setError(err?.error || err?.message || '加载 Jenkins 构建列表失败');
    } finally {
      setLoading(false);
    }
  };

  const publish = async () => {
    if (!publishBranch.trim()) {
      message.warning('请输入发布分支');
      return;
    }
    if (deployTarget !== 'Pgyer' && !isReleaseBranch(publishBranch)) {
      message.warning('TestFlight / 苹果商店只能选择 release/x.x.x 格式分支');
      return;
    }
    if (deployTarget !== 'Pgyer' && !verificationPassword.trim()) {
      message.warning('TestFlight / 苹果商店发布需要填写验证密码');
      return;
    }
    setPublishing(true);
    try {
      await jenkinsApi.publishNN({
        deployTarget,
        branch: publishBranch.trim(),
        verificationPassword: verificationPassword.trim(),
      });
      message.success(`已触发 ${DEPLOY_TARGET_OPTIONS.find((item) => item.value === deployTarget)?.label} 发布构建`);
      setPublishModalOpen(false);
      setVerificationPassword('');
      await loadBuilds();
      setTimeout(() => loadBuilds(), 1500);
      setTimeout(() => loadBuilds(), 5000);
    } catch (err: any) {
      message.error(err?.error || err?.message || '触发发布失败');
    } finally {
      setPublishing(false);
    }
  };

  const loadBranches = async () => {
    setBranchLoading(true);
    try {
      const response = await jenkinsApi.listBranches();
      const nextBranches = response.data || [];
      setBranches(nextBranches);
      if (deployTarget !== 'Pgyer') {
        setPublishBranch(getHighestReleaseBranch(nextBranches));
      }
    } catch (err: any) {
      message.warning(err?.error || err?.message || '加载分支列表失败，可直接输入分支名');
    } finally {
      setBranchLoading(false);
    }
  };

  const stopBuild = async (buildNumber: number) => {
    setStoppingBuild(buildNumber);
    try {
      await jenkinsApi.stopBuild(buildNumber);
      message.success(`已取消构建 #${buildNumber}`);
      loadBuilds();
    } catch (err: any) {
      message.error(err?.error || err?.message || '取消构建失败');
    } finally {
      setStoppingBuild(null);
    }
  };

  const openPgyerPublish = (build: JenkinsBuild) => {
    setDeployTarget('Pgyer');
    setVerificationPassword('');
    setPublishBranch(build.branchName || 'develop');
    setPublishModalOpen(true);
  };

  const openPublishModal = () => {
    if (deployTarget !== 'Pgyer') {
      setPublishBranch(getHighestReleaseBranch(branches));
    }
    setPublishModalOpen(true);
  };

  const showBuildLog = async (build: JenkinsBuild) => {
    setLogModalOpen(true);
    setSelectedBuildLog({ build, log: '', thirdSdkBranch: build.branchName || 'develop', thirdSdkDependencies: [] });
    setLogLoading(true);
    try {
      const response = await jenkinsApi.getBuildLog(build.number);
      setSelectedBuildLog({
        build,
        log: response.data?.log || '',
        thirdSdkBranch: response.data?.thirdSdkBranch || build.branchName || 'develop',
        thirdSdkRevision: response.data?.thirdSdkRevision,
        thirdSdkDependencies: response.data?.thirdSdkDependencies || [],
        thirdSdkMissingFiles: response.data?.thirdSdkMissingFiles || [],
        thirdSdkError: response.data?.thirdSdkError,
      });
    } catch (err: any) {
      message.error(err?.error || err?.message || '加载打包日志失败');
      setSelectedBuildLog({
        build,
        log: '加载打包日志失败',
        thirdSdkBranch: build.branchName || 'develop',
        thirdSdkDependencies: [],
        thirdSdkError: err?.error || err?.message || '加载打包日志失败',
      });
    } finally {
      setLogLoading(false);
    }
  };

  const downloadBuildLog = () => {
    if (!selectedBuildLog) return;
    const blob = new Blob([selectedBuildLog.log || ''], { type: 'text/plain;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `nn-${selectedBuildLog.build.number}.log`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  useEffect(() => {
    loadBuilds();
  }, []);

  useEffect(() => {
    if (publishModalOpen && branches.length === 0) {
      loadBranches();
    }
  }, [publishModalOpen]);

  useEffect(() => {
    if (deployTarget !== 'Pgyer' && branches.length > 0) {
      setPublishBranch(getHighestReleaseBranch(branches));
    }
  }, [deployTarget, branches]);

  const stats = useMemo(() => data?.stats || {
    total: 0,
    running: 0,
    latestBuild: '-',
    successRate: '-',
  }, [data]);

  const publishBranchOptions = useMemo(
    () => branches.map((branch) => ({ value: branch, label: branch })),
    [branches],
  );

  return (
    <div>
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
        <div>
          <Title level={4}>
            <RocketOutlined style={{ marginRight: 8, color: '#722ed1' }} />
            CI/CD 管理
          </Title>
          <Paragraph type="secondary">
            nn-ios Jekins构建与发布蒲公英、TestFlight、苹果商店包。
          </Paragraph>
        </div>
        <Space>
          <Button icon={<ExportOutlined />} onClick={() => window.open(data?.job.url || 'http://10.1.3.177:8080/job/nn/', '_blank', 'noopener,noreferrer')}>
            打开 Jenkins
          </Button>
            <Button icon={<ReloadOutlined />} onClick={() => loadBuilds()} loading={loading}>
            刷新
          </Button>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={publishing} onClick={openPublishModal}>
            发布
          </Button>
        </Space>
      </div>

      {error && (
        <Alert
          type="error"
          showIcon
          message="Jenkins 操作失败"
          description={error}
          style={{ marginBottom: 16 }}
        />
      )}

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {[
          { label: '最近构建数', value: stats.total, color: '#1677ff' },
          { label: '运行中', value: stats.running, color: '#52c41a' },
          { label: '最新构建', value: stats.latestBuild, color: '#722ed1' },
          { label: '成功率', value: stats.successRate, color: '#faad14' },
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
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
            <Space>
              <span>构建列表</span>
              {data?.job.fullName && <Tag color="blue">{data.job.fullName}</Tag>}
              {data?.job.buildable === false && <Tag color="red">不可构建</Tag>}
            </Space>
            <Space>
              <Text type="secondary">发布渠道</Text>
              <Select
                size="small"
                value={filterDeployTarget}
                style={{ width: 130 }}
                options={[
                  { label: '全部', value: '' },
                  ...DEPLOY_TARGET_OPTIONS,
                ]}
                onChange={(value) => {
                  setFilterDeployTarget(value);
                  loadBuilds(value);
                }}
              />
            </Space>
          </div>
        }
      >
        <Table<JenkinsBuild>
          rowKey="number"
          loading={loading}
          dataSource={data?.builds || []}
          tableLayout="fixed"
          scroll={{ x: 1280 }}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          columns={[
            {
              title: '构建',
              dataIndex: 'number',
              key: 'number',
              width: 90,
              render: (number: number, record) => (
                <Button type="link" onClick={() => window.open(record.url, '_blank', 'noopener,noreferrer')}>
                  #{number}
                </Button>
              ),
            },
            {
              title: '发布渠道',
              dataIndex: 'publishChannel',
              key: 'publishChannel',
              width: 120,
              render: (value?: string) => value ? <Tag color="blue">{value}</Tag> : <Text type="secondary">-</Text>,
            },
            {
              title: '分支名',
              dataIndex: 'branchName',
              key: 'branchName',
              width: 150,
              ellipsis: true,
              render: (value?: string) => value ? <Tag>{value}</Tag> : <Text type="secondary">-</Text>,
            },
            {
              title: 'Commit Hash',
              dataIndex: 'commitHash',
              key: 'commitHash',
              width: 130,
              render: (value?: string) => value ? <Text code title={value}>{value.slice(0, 12)}</Text> : <Text type="secondary">-</Text>,
            },
            {
              title: '构建号',
              dataIndex: 'buildNumber',
              key: 'buildNumber',
              width: 110,
              render: (value?: string) => value || <Text type="secondary">-</Text>,
            },
            {
              title: 'APP版本',
              dataIndex: 'appVersion',
              key: 'appVersion',
              width: 120,
              render: (value?: string) => value ? <Tag color="purple">{value}</Tag> : <Text type="secondary">-</Text>,
            },
            {
              title: '渠道二维码',
              dataIndex: 'channelQrUrl',
              key: 'channelQrUrl',
              width: 110,
              render: (value: string | undefined, record) => value ? (
                <button
                  type="button"
                  onClick={() => setQrPreview({
                    url: value,
                    channel: record.publishChannel,
                    buildNumber: record.buildNumber,
                  })}
                  style={{
                    width: 64,
                    height: 64,
                    padding: 0,
                    border: '1px solid #f0f0f0',
                    borderRadius: 4,
                    background: '#fff',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title="打开二维码地址"
                >
                  <QRCode value={value} size={56} bordered={false} />
                </button>
              ) : <Text type="secondary">-</Text>,
            },
            {
              title: '状态',
              key: 'result',
              width: 100,
              render: (_, record) => resultTag(record),
            },
            {
              title: '开始时间',
              dataIndex: 'timestamp',
              key: 'timestamp',
              width: 170,
              render: formatBuildTime,
            },
            {
              title: '耗时',
              key: 'duration',
              width: 100,
              render: (_, record) => formatDuration(record.duration, record.building),
            },
            {
              title: '操作',
              key: 'action',
              width: 210,
              render: (_, record) => (
                <Space size={8}>
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    disabled={!record.archiveUrl}
                    onClick={() => record.archiveUrl && window.open(record.archiveUrl, '_blank', 'noopener,noreferrer')}
                  >
                    下载
                  </Button>
                  <Button size="small" icon={<FileTextOutlined />} onClick={() => showBuildLog(record)}>
                    详情
                  </Button>
                  {record.publishChannel === 'Pgyer' && (
                    <Button size="small" type="primary" ghost icon={<PlayCircleOutlined />} onClick={() => openPgyerPublish(record)}>
                      发布
                    </Button>
                  )}
                  {record.building && (
                    <Popconfirm
                      title="取消构建？"
                      description={`确定要取消 #${record.number} 吗？`}
                      okText="取消构建"
                      cancelText="关闭"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => stopBuild(record.number)}
                    >
                      <Button
                        size="small"
                        danger
                        icon={<StopOutlined />}
                        loading={stoppingBuild === record.number}
                      >
                        取消
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title="选择发布分支和渠道"
        open={publishModalOpen}
        okText="发布"
        cancelText="取消"
        confirmLoading={publishing}
        onOk={publish}
        onCancel={() => setPublishModalOpen(false)}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <Text strong>发布分支</Text>
            {deployTarget === 'Pgyer' ? (
              <AutoComplete
                value={publishBranch}
                options={publishBranchOptions}
                onChange={setPublishBranch}
                placeholder="请输入分支名，如 develop 或 release/5.14.7"
                style={{ marginTop: 8, width: '100%' }}
                filterOption={(inputValue, option) =>
                  String(option?.value || '').toLowerCase().includes(inputValue.toLowerCase())
                }
              />
            ) : (
              <Input
                value={publishBranch || '未找到 release/x.x.x 分支'}
                readOnly
                status={publishBranch ? undefined : 'warning'}
                style={{ marginTop: 8 }}
              />
            )}
            <Space style={{ marginTop: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {branchLoading
                  ? '正在加载分支列表...'
                  : deployTarget === 'Pgyer'
                    ? '可选择已有分支，也可直接输入分支名'
                    : 'TestFlight / 苹果商店自动使用当前 release/ 下最高版本分支'}
              </Text>
              <Button size="small" type="link" onClick={loadBranches} loading={branchLoading}>
                刷新分支
              </Button>
            </Space>
          </div>
          <div>
            <Text strong>发布渠道</Text>
          </div>
          <Radio.Group
            optionType="button"
            buttonStyle="solid"
            options={DEPLOY_TARGET_OPTIONS}
            value={deployTarget}
            onChange={(event) => {
              const nextTarget = event.target.value as DeployTarget;
              setDeployTarget(nextTarget);
              if (nextTarget !== 'Pgyer') {
                setPublishBranch(getHighestReleaseBranch(branches));
              }
              if (nextTarget === 'Pgyer') {
                setVerificationPassword('');
              }
            }}
          />
          {deployTarget !== 'Pgyer' && (
            <Input.Password
              placeholder="请输入验证密码"
              value={verificationPassword}
              onChange={(event) => setVerificationPassword(event.target.value)}
            />
          )}
          <Alert
            type={deployTarget === 'Pgyer' ? 'info' : 'warning'}
            showIcon
            message={deployTarget === 'Pgyer' ? '蒲公英发布无需验证密码' : 'TestFlight / 苹果商店发布需要验证密码'}
          />
        </Space>
      </Modal>

      <Modal
        title={selectedBuildLog ? `打包日志 - #${selectedBuildLog.build.number}` : '打包日志'}
        open={logModalOpen}
        width="82vw"
        footer={(
          <Space>
            <Button onClick={() => setLogModalOpen(false)}>关闭</Button>
            <Button
              icon={<DownloadOutlined />}
              disabled={!selectedBuildLog?.log}
              onClick={downloadBuildLog}
            >
              下载日志
            </Button>
          </Space>
        )}
        onCancel={() => setLogModalOpen(false)}
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
              {selectedBuildLog.build.buildNumber && <Tag color="green">构建号 {selectedBuildLog.build.buildNumber}</Tag>}
              {selectedBuildLog.build.appVersion && <Tag color="purple">APP {selectedBuildLog.build.appVersion}</Tag>}
            </Space>
          )}
          <Tabs
            key={selectedBuildLog?.build.number || 'build-log'}
            defaultActiveKey="build-log"
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
                      <Text type="secondary">来源：当前构建主工程 third_sdk.rb</Text>
                      {selectedBuildLog?.thirdSdkBranch && <Tag color="geekblue">分支 {selectedBuildLog.thirdSdkBranch}</Tag>}
                    </Space>
                    {selectedBuildLog?.thirdSdkError && (
                      <Alert type="warning" showIcon message="读取 third_sdk.rb 失败" description={selectedBuildLog.thirdSdkError} />
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
                        {logLoading ? '正在读取 third_sdk.rb...' : '未从 third_sdk.rb 解析到三方库'}
                      </Text>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </Space>
      </Modal>

      <Modal
        title="渠道二维码"
        open={!!qrPreview}
        footer={qrPreview ? (
          <Space>
            <Button onClick={() => setQrPreview(null)}>关闭</Button>
            <Button type="primary" onClick={() => window.open(qrPreview.url, '_blank', 'noopener,noreferrer')}>
              打开地址
            </Button>
          </Space>
        ) : null}
        onCancel={() => setQrPreview(null)}
      >
        <Space direction="vertical" align="center" size={16} style={{ width: '100%', padding: '12px 0 16px' }}>
          <Space>
            {qrPreview?.channel && <Tag color="blue">{qrPreview.channel}</Tag>}
            {qrPreview?.buildNumber && <Tag color="green">构建号 {qrPreview.buildNumber}</Tag>}
          </Space>
          {qrPreview?.url && <QRCode value={qrPreview.url} size={260} />}
        </Space>
      </Modal>
    </div>
  );
}
