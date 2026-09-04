import {
  CaretRightOutlined,
  CopyOutlined,
  EditOutlined,
  EyeOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  deviceControlApi,
  DeviceReplayFlowRun,
  ReplayFlowAsset,
  ReplayFlowAssetStatus,
  ReplayFlowAssetSummary,
  ReplayFlowChainPhase,
  ReplayFlowChainRun,
  ReplayFlowChainRunStatus,
} from '../services/api';

const { Paragraph, Text, Title } = Typography;

function errorMessage(error: unknown) {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'error' in error) return String((error as { error?: unknown }).error || '操作失败');
  if (error instanceof Error) return error.message;
  return '操作失败';
}

function statusTag(status: ReplayFlowAssetStatus, creationCompleted = true) {
  if (!creationCompleted && status !== 'archived') return <Tag color="gold">创建中</Tag>;
  if (status === 'published') return <Tag color="green">已发布</Tag>;
  if (status === 'archived') return <Tag>已归档</Tag>;
  return <Tag color="blue">草稿</Tag>;
}

function dateTime(value?: string) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function duration(value?: number) {
  if (value === undefined) return '-';
  if (value < 1000) return `${value} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60000)}m ${Math.round((value % 60000) / 1000)}s`;
}

function runStatusTag(status: ReplayFlowChainRunStatus | string) {
  if (status === 'succeeded') return <Tag color="green">成功</Tag>;
  if (status === 'failed') return <Tag color="red">失败</Tag>;
  if (status === 'cancelled') return <Tag>已终止</Tag>;
  if (status === 'running') return <Tag color="processing">执行中</Tag>;
  if (status === 'skipped') return <Tag color="gold">已跳过</Tag>;
  return <Tag color="blue">排队中</Tag>;
}

function phaseLabel(phase?: ReplayFlowChainPhase) {
  if (phase === 'pre') return '前置准备';
  if (phase === 'post') return '后置清理';
  return '主回放';
}

interface ExecutionInputField {
  name: string;
  required: boolean;
  defaultValue?: string;
  description?: string;
  usedBy: string[];
}

export default function ReplayCenterPage() {
  const navigate = useNavigate();
  const [assets, setAssets] = useState<ReplayFlowAssetSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ReplayFlowAssetStatus | 'creating' | 'all'>('all');
  const [detail, setDetail] = useState<ReplayFlowAsset | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionId, setActionId] = useState('');
  const [activeTab, setActiveTab] = useState('flows');
  const [preFlowAssetId, setPreFlowAssetId] = useState<string>();
  const [postFlowAssetId, setPostFlowAssetId] = useState<string>();
  const [chainSaving, setChainSaving] = useState(false);
  const [runs, setRuns] = useState<ReplayFlowChainRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runStatus, setRunStatus] = useState<ReplayFlowChainRunStatus | 'all'>('all');
  const [runDetail, setRunDetail] = useState<ReplayFlowChainRun | null>(null);
  const [phaseDetails, setPhaseDetails] = useState<Record<string, DeviceReplayFlowRun>>({});
  const [phaseLoadingId, setPhaseLoadingId] = useState('');
  const [executionAsset, setExecutionAsset] = useState<ReplayFlowAsset | null>(null);
  const [executionInputs, setExecutionInputs] = useState<ExecutionInputField[]>([]);
  const [executionOpen, setExecutionOpen] = useState(false);
  const [executionPreparing, setExecutionPreparing] = useState(false);
  const [executionSubmitting, setExecutionSubmitting] = useState(false);
  const [executionForm] = Form.useForm<Record<string, string>>();

  const loadAssets = useCallback(async () => {
    setLoading(true);
    try {
      const response = await deviceControlApi.listReplayFlowAssets({ search, status: 'all' });
      setAssets(response.data?.assets || []);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const response = await deviceControlApi.listReplayFlowChainRuns({ status: 'all', limit: 200 });
      const nextRuns = response.data?.runs || [];
      setRuns(nextRuns);
      setRunDetail((current) => current ? (nextRuns.find((run) => run.id === current.id) || current) : current);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setRunsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!runs.some((run) => run.status === 'queued' || run.status === 'running')) return undefined;
    const timer = window.setInterval(() => void loadRuns(), 3000);
    return () => window.clearInterval(timer);
  }, [loadRuns, runs]);

  const displayedAssets = useMemo(() => assets.filter((asset) => {
    if (status === 'all') return true;
    if (status === 'creating') return !asset.creationCompleted && asset.status !== 'archived';
    if (status === 'draft') return asset.status === 'draft' && asset.creationCompleted;
    return asset.status === status;
  }), [assets, status]);

  const counts = useMemo(() => ({
    total: assets.length,
    creating: assets.filter((asset) => !asset.creationCompleted && asset.status !== 'archived').length,
    draft: assets.filter((asset) => asset.status === 'draft' && asset.creationCompleted).length,
    published: assets.filter((asset) => asset.status === 'published').length,
    archived: assets.filter((asset) => asset.status === 'archived').length,
  }), [assets]);

  const chainOptions = useMemo(() => assets
    .filter((asset) => asset.id !== detail?.id && asset.status !== 'archived' && asset.creationCompleted)
    .map((asset) => ({ value: asset.id, label: asset.name })), [assets, detail?.id]);
  const chainDirty = Boolean(detail) && (
    preFlowAssetId !== detail?.preFlowAssetId || postFlowAssetId !== detail?.postFlowAssetId
  );

  const displayedRuns = useMemo(() => runs.filter((run) => runStatus === 'all' || run.status === runStatus), [runStatus, runs]);
  const completedRuns = useMemo(() => runs.filter((run) => run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled'), [runs]);

  const openDetail = async (assetId: string) => {
    setDetailLoading(true);
    try {
      const response = await deviceControlApi.getReplayFlowAsset(assetId);
      const asset = response.data?.asset || null;
      setDetail(asset);
      setPreFlowAssetId(asset?.preFlowAssetId);
      setPostFlowAssetId(asset?.postFlowAssetId);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setDetailLoading(false);
    }
  };

  const saveExecutionChain = async () => {
    if (!detail) return;
    setChainSaving(true);
    try {
      const response = await deviceControlApi.updateReplayFlowExecutionChain(detail.id, {
        preFlowAssetId: preFlowAssetId || null,
        postFlowAssetId: postFlowAssetId || null,
      });
      setDetail(response.data?.asset || detail);
      message.success('执行链配置已保存');
      await loadAssets();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setChainSaving(false);
    }
  };

  const prepareExecution = async (asset: ReplayFlowAsset) => {
    setExecutionPreparing(true);
    try {
      const referenceIds = [asset.preFlowAssetId, asset.postFlowAssetId].filter(Boolean) as string[];
      const references = await Promise.all(referenceIds.map(async (id) => {
        const response = await deviceControlApi.getReplayFlowAsset(id);
        return response.data!.asset;
      }));
      const byId = new Map(references.map((item) => [item.id, item]));
      const chain = [asset.preFlowAssetId ? byId.get(asset.preFlowAssetId) : undefined, asset, asset.postFlowAssetId ? byId.get(asset.postFlowAssetId) : undefined]
        .filter(Boolean) as ReplayFlowAsset[];
      const fields = new Map<string, ExecutionInputField>();
      chain.forEach((item) => {
        Object.entries(item.draft.flow.inputs || {}).forEach(([name, definition]) => {
          const current = fields.get(name);
          fields.set(name, {
            name,
            required: Boolean(definition.required || current?.required),
            defaultValue: current?.defaultValue ?? definition.default,
            description: current?.description || definition.description,
            usedBy: [...(current?.usedBy || []), item.name],
          });
        });
      });
      const inputFields = [...fields.values()];
      executionForm.resetFields();
      executionForm.setFieldsValue(Object.fromEntries(inputFields.filter((field) => field.defaultValue !== undefined).map((field) => [field.name, field.defaultValue])));
      setExecutionAsset(asset);
      setExecutionInputs(inputFields);
      setExecutionOpen(true);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setExecutionPreparing(false);
    }
  };

  const submitExecution = async () => {
    if (!executionAsset) return;
    try {
      const values = await executionForm.validateFields();
      setExecutionSubmitting(true);
      const response = await deviceControlApi.startReplayFlowAssetRun(executionAsset.id, values);
      const run = response.data!.run;
      setExecutionOpen(false);
      setDetail(null);
      setRunDetail(run);
      setPhaseDetails({});
      setActiveTab('runs');
      message.success('单次回放任务已启动');
      await loadRuns();
    } catch (error) {
      if ((error as { errorFields?: unknown }).errorFields) return;
      message.error(errorMessage(error));
    } finally {
      setExecutionSubmitting(false);
    }
  };

  const openRunDetail = async (runId: string) => {
    try {
      const response = await deviceControlApi.getReplayFlowChainRun(runId);
      setRunDetail(response.data?.run || null);
      setPhaseDetails({});
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const stopRun = async (runId: string) => {
    setActionId(runId);
    try {
      const response = await deviceControlApi.stopReplayFlowChainRun(runId);
      if (runDetail?.id === runId) setRunDetail(response.data?.run || runDetail);
      message.success('已请求终止；当前阶段停止后仍会尝试后置清理');
      await loadRuns();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setActionId('');
    }
  };

  const loadPhaseDetail = async (replayRunId: string) => {
    setPhaseLoadingId(replayRunId);
    try {
      const response = await deviceControlApi.getReplayFlowRun(replayRunId);
      setPhaseDetails((current) => ({ ...current, [replayRunId]: response.data!.run }));
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setPhaseLoadingId('');
    }
  };

  const copyAsset = async (asset: ReplayFlowAssetSummary) => {
    setActionId(asset.id);
    try {
      const response = await deviceControlApi.copyReplayFlowAsset(asset.id);
      message.success(`已创建「${response.data?.asset.name || `${asset.name} 副本`}」`);
      await loadAssets();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setActionId('');
    }
  };

  const setArchived = async (asset: ReplayFlowAssetSummary, archived: boolean) => {
    setActionId(asset.id);
    try {
      await deviceControlApi.setReplayFlowAssetArchived(asset.id, archived);
      message.success(archived ? '流程已归档' : '流程已恢复');
      await loadAssets();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setActionId('');
    }
  };

  const columns: TableColumnsType<ReplayFlowAssetSummary> = [
    {
      title: '回放流程',
      dataIndex: 'name',
      width: 280,
      render: (_, asset) => (
        <Space direction="vertical" size={2}>
          <Button type="link" style={{ padding: 0, height: 'auto', fontWeight: 600 }} onClick={() => void openDetail(asset.id)}>
            {asset.name}
          </Button>
          <Text type="secondary" ellipsis style={{ maxWidth: 260 }}>{asset.description || '暂无描述'}</Text>
        </Space>
      ),
    },
    { title: '状态', dataIndex: 'status', width: 90, render: (_, asset) => statusTag(asset.status, asset.creationCompleted) },
    {
      title: '来源录制',
      dataIndex: 'sourceRecordingId',
      width: 180,
      render: (value?: string) => value ? <Text copyable={{ text: value }}>{value.slice(0, 16)}…</Text> : '-',
    },
    { title: '节点', dataIndex: 'nodeCount', width: 70, render: (value: number) => `${value} 个` },
    {
      title: '版本',
      width: 110,
      render: (_, asset) => <Text>{asset.creationCompleted ? '草稿' : '未完成'} r{asset.revision}{asset.versionCount ? ` · ${asset.versionCount} 版` : ''}</Text>,
    },
    { title: '创建人', dataIndex: 'owner', width: 100 },
    { title: '更新时间', dataIndex: 'updatedAt', width: 170, render: dateTime },
    {
      title: '操作',
      fixed: 'right',
      width: 300,
      render: (_, asset) => (
        <Space size="small">
          {asset.status !== 'archived' && (
            <Button size="small" type="primary" ghost icon={<EditOutlined />} onClick={() => navigate(`/cicd/replay/${asset.id}/edit${asset.creationCompleted ? '' : '?mode=create'}`)}>
              {asset.creationCompleted ? '编辑' : '继续创建'}
            </Button>
          )}
          <Button size="small" icon={<EyeOutlined />} loading={detailLoading && detail?.id === asset.id} onClick={() => void openDetail(asset.id)}>
            查看
          </Button>
          <Button size="small" icon={<CopyOutlined />} loading={actionId === asset.id} onClick={() => void copyAsset(asset)}>
            复制
          </Button>
          {asset.status === 'archived' ? (
            <Button size="small" loading={actionId === asset.id} onClick={() => void setArchived(asset, false)}>恢复</Button>
          ) : (
            <Popconfirm title="归档后不会出现在默认流程列表中，确定继续？" onConfirm={() => void setArchived(asset, true)}>
              <Button size="small" icon={<InboxOutlined />} loading={actionId === asset.id}>归档</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const runColumns: TableColumnsType<ReplayFlowChainRun> = [
    {
      title: '执行任务',
      dataIndex: 'mainAssetName',
      width: 240,
      render: (_, run) => (
        <Space direction="vertical" size={2}>
          <Button type="link" style={{ padding: 0, height: 'auto', fontWeight: 600 }} onClick={() => void openRunDetail(run.id)}>
            {run.mainAssetName}
          </Button>
          <Text type="secondary" copyable={{ text: run.id }}>{run.id.slice(0, 12)}…</Text>
        </Space>
      ),
    },
    {
      title: '执行链',
      width: 320,
      render: (_, run) => (
        <Space size={4} wrap>
          {run.phases.map((phase, index) => (
            <span key={`${phase.phase}-${phase.assetId}`}>
              {index > 0 && <Text type="secondary"> → </Text>}
              <Tag color={phase.phase === 'main' ? 'blue' : undefined}>{phaseLabel(phase.phase)}：{phase.assetName}</Tag>
            </span>
          ))}
        </Space>
      ),
    },
    { title: '状态', dataIndex: 'status', width: 100, render: runStatusTag },
    {
      title: '当前阶段',
      dataIndex: 'currentPhase',
      width: 110,
      render: (value?: ReplayFlowChainPhase) => value ? phaseLabel(value) : '-',
    },
    { title: '设备', width: 150, render: (_, run) => run.device?.name || '-' },
    { title: '开始时间', dataIndex: 'startedAt', width: 180, render: dateTime },
    { title: '耗时', dataIndex: 'durationMs', width: 100, render: duration },
    {
      title: '操作',
      fixed: 'right',
      width: 170,
      render: (_, run) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => void openRunDetail(run.id)}>查看</Button>
          {(run.status === 'queued' || run.status === 'running') && (
            <Popconfirm title="终止后仍会尝试执行后置清理，确定继续？" onConfirm={() => void stopRun(run.id)}>
              <Button size="small" danger icon={<StopOutlined />} loading={actionId === run.id}>终止</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const flowList = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Row gutter={[12, 12]}>
        <Col xs={12} md={5}><Card size="small"><Statistic title="全部流程" value={counts.total} /></Card></Col>
        <Col xs={12} md={5}><Card size="small"><Statistic title="创建中" value={counts.creating} /></Card></Col>
        <Col xs={12} md={5}><Card size="small"><Statistic title="草稿" value={counts.draft} /></Card></Col>
        <Col xs={12} md={5}><Card size="small"><Statistic title="已发布" value={counts.published} /></Card></Col>
        <Col xs={12} md={4}><Card size="small"><Statistic title="已归档" value={counts.archived} /></Card></Col>
      </Row>
      <Card size="small">
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search
            allowClear
            placeholder="搜索流程名称、描述或录制 ID"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onSearch={() => void loadAssets()}
            style={{ width: 320 }}
          />
          <Select
            value={status}
            onChange={setStatus}
            style={{ width: 130 }}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'creating', label: '创建中' },
              { value: 'draft', label: '草稿' },
              { value: 'published', label: '已发布' },
              { value: 'archived', label: '已归档' },
            ]}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadAssets()}>刷新</Button>
        </Space>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={displayedAssets}
          loading={loading}
          scroll={{ x: 1250 }}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有保存的回放流程" /> }}
        />
      </Card>
    </Space>
  );

  const runList = (data: ReplayFlowChainRun[], reportMode = false) => (
    <Card size="small">
      <Space wrap style={{ marginBottom: 16 }}>
        {!reportMode && (
          <Select
            value={runStatus}
            onChange={setRunStatus}
            style={{ width: 140 }}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'queued', label: '排队中' },
              { value: 'running', label: '执行中' },
              { value: 'succeeded', label: '成功' },
              { value: 'failed', label: '失败' },
              { value: 'cancelled', label: '已终止' },
            ]}
          />
        )}
        <Button icon={<ReloadOutlined />} loading={runsLoading} onClick={() => void loadRuns()}>刷新</Button>
        {reportMode && <Text type="secondary">报告按前置、主回放、后置三段保留独立节点结果与证据。</Text>}
      </Space>
      <Table
        rowKey="id"
        columns={runColumns}
        dataSource={data}
        loading={runsLoading}
        scroll={{ x: 1370 }}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={reportMode ? '还没有已完成的执行报告' : '还没有单次回放任务'} /> }}
      />
    </Card>
  );

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <Title level={3} style={{ marginBottom: 4 }}>回放中心</Title>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              管理可复用的回放流程、单次执行任务与执行证据。循环和并发策略由自动质检任务负责。
            </Paragraph>
          </div>
          <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => navigate('/cicd/replay/new')}>
            创建回放
          </Button>
        </div>

        <Alert
          showIcon
          type="info"
          message="回放只负责一次确定性执行"
          description="后续每次执行可配置前置准备和后置清理；循环次数、并发、设备池和 Jenkins 调度属于质检任务。"
        />

        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            { key: 'flows', label: '回放流程', children: flowList },
            {
              key: 'runs',
              label: '执行任务',
              children: runList(displayedRuns),
            },
            {
              key: 'reports',
              label: '执行报告',
              children: runList(completedRuns, true),
            },
          ]}
        />
      </Space>

      <Drawer
        title={detail?.name || '回放流程详情'}
        width="72vw"
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        extra={(
          <Space>
            {detail?.status !== 'archived' && (
              <Button
                type="primary"
                icon={<EditOutlined />}
                onClick={() => navigate(`/cicd/replay/${detail?.id}/edit${detail?.creationCompleted ? '' : '?mode=create'}`)}
              >
                {detail?.creationCompleted ? '编辑草稿' : '继续创建'}
              </Button>
            )}
            <Button icon={<FolderOpenOutlined />} onClick={() => navigate('/cicd/device-control')}>打开真机调试台</Button>
          </Space>
        )}
      >
        {detail && (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="状态">{statusTag(detail.status, detail.creationCompleted)}</Descriptions.Item>
              <Descriptions.Item label="创建人">{detail.owner}</Descriptions.Item>
              <Descriptions.Item label="来源录制"><Text copyable>{detail.sourceRecordingId || '-'}</Text></Descriptions.Item>
              <Descriptions.Item label="来源指纹"><Text copyable>{detail.sourceFingerprint}</Text></Descriptions.Item>
              <Descriptions.Item label="草稿 revision">r{detail.draft.revision}</Descriptions.Item>
              <Descriptions.Item label="节点数量">{detail.nodeCount}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{dateTime(detail.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="更新时间">{dateTime(detail.updatedAt)}</Descriptions.Item>
              <Descriptions.Item label="描述" span={2}>{detail.description || '-'}</Descriptions.Item>
            </Descriptions>
            <Card size="small" title="执行链配置">
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Alert
                  showIcon
                  type="info"
                  message="每次只执行一条确定性链路"
                  description="前置失败会跳过主回放；无论前置或主回放是否失败，都会尝试执行后置清理。"
                />
                <Row gutter={[12, 12]} align="middle">
                  <Col xs={24} md={7}>
                    <Text strong>前置准备（可选）</Text>
                    <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      value={preFlowAssetId}
                      onChange={setPreFlowAssetId}
                      options={chainOptions}
                      placeholder="例如：登录、切换测试环境"
                      style={{ width: '100%', marginTop: 8 }}
                      disabled={!detail.creationCompleted || detail.status === 'archived'}
                    />
                  </Col>
                  <Col xs={24} md={2} style={{ textAlign: 'center' }}><Text type="secondary">→</Text></Col>
                  <Col xs={24} md={6}>
                    <Text strong>主回放</Text>
                    <Input value={detail.name} readOnly style={{ marginTop: 8 }} />
                  </Col>
                  <Col xs={24} md={2} style={{ textAlign: 'center' }}><Text type="secondary">→</Text></Col>
                  <Col xs={24} md={7}>
                    <Text strong>后置清理（可选）</Text>
                    <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      value={postFlowAssetId}
                      onChange={setPostFlowAssetId}
                      options={chainOptions}
                      placeholder="例如：退出登录、恢复初始状态"
                      style={{ width: '100%', marginTop: 8 }}
                      disabled={!detail.creationCompleted || detail.status === 'archived'}
                    />
                  </Col>
                </Row>
                <Space wrap>
                  <Button
                    onClick={() => void saveExecutionChain()}
                    loading={chainSaving}
                    disabled={!detail.creationCompleted || detail.status === 'archived' || !chainDirty}
                  >
                    保存执行链
                  </Button>
                  <Button
                    type="primary"
                    icon={<CaretRightOutlined />}
                    loading={executionPreparing}
                    disabled={!detail.creationCompleted || detail.status === 'archived' || !detail.draft.validation.valid || chainDirty}
                    onClick={() => void prepareExecution(detail)}
                  >
                    连接真机后执行一次
                  </Button>
                  {chainDirty && <Text type="warning">请先保存执行链，再启动回放。</Text>}
                  <Text type="secondary">当前阶段执行有效草稿；发布版本接入后将固定到不可变版本。</Text>
                </Space>
              </Space>
            </Card>
            <div>
              <Title level={5}>当前草稿 DSL</Title>
              <pre style={{ maxHeight: 520, overflow: 'auto', background: '#0f172a', color: '#e2e8f0', padding: 16, borderRadius: 8 }}>
                {JSON.stringify(detail.draft.flow, null, 2)}
              </pre>
            </div>
          </Space>
        )}
      </Drawer>

      <Drawer
        title={runDetail ? `执行报告：${runDetail.mainAssetName}` : '执行报告'}
        width="76vw"
        open={Boolean(runDetail)}
        onClose={() => {
          setRunDetail(null);
          setPhaseDetails({});
        }}
        extra={runDetail && (runDetail.status === 'queued' || runDetail.status === 'running') ? (
          <Popconfirm title="终止后仍会尝试后置清理，确定继续？" onConfirm={() => void stopRun(runDetail.id)}>
            <Button danger icon={<StopOutlined />} loading={actionId === runDetail.id}>终止任务</Button>
          </Popconfirm>
        ) : null}
      >
        {runDetail && (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="状态">{runStatusTag(runDetail.status)}</Descriptions.Item>
              <Descriptions.Item label="当前阶段">{runDetail.currentPhase ? phaseLabel(runDetail.currentPhase) : '-'}</Descriptions.Item>
              <Descriptions.Item label="设备">{runDetail.device ? `${runDetail.device.name} (${runDetail.device.udid})` : '-'}</Descriptions.Item>
              <Descriptions.Item label="参数名">{runDetail.inputNames.length ? runDetail.inputNames.join('、') : '无'}</Descriptions.Item>
              <Descriptions.Item label="开始时间">{dateTime(runDetail.startedAt)}</Descriptions.Item>
              <Descriptions.Item label="总耗时">{duration(runDetail.durationMs)}</Descriptions.Item>
              {runDetail.error && <Descriptions.Item label="失败原因" span={2}><Text type="danger">{runDetail.error}</Text></Descriptions.Item>}
            </Descriptions>
            {runDetail.phases.map((phase) => {
              const replayRun = phase.replayRunId ? phaseDetails[phase.replayRunId] : undefined;
              return (
                <Card
                  key={`${phase.phase}-${phase.assetId}`}
                  size="small"
                  title={`${phaseLabel(phase.phase)}：${phase.assetName}`}
                  extra={runStatusTag(phase.status)}
                >
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Space wrap>
                      <Text type="secondary">耗时 {duration(phase.durationMs)}</Text>
                      {phase.replayRunId && <Text copyable={{ text: phase.replayRunId }}>阶段 Run {phase.replayRunId.slice(0, 12)}…</Text>}
                      {phase.replayRunId && !replayRun && (
                        <Button size="small" loading={phaseLoadingId === phase.replayRunId} onClick={() => void loadPhaseDetail(phase.replayRunId!)}>
                          加载节点与证据
                        </Button>
                      )}
                    </Space>
                    {phase.error && <Alert type={phase.status === 'skipped' ? 'warning' : 'error'} showIcon message={phase.error} />}
                    {replayRun && (
                      <Table
                        size="small"
                        rowKey={(node) => `${node.sequence}-${node.nodeId}`}
                        pagination={false}
                        dataSource={replayRun.nodes}
                        columns={[
                          { title: '#', dataIndex: 'sequence', width: 52 },
                          { title: '节点', dataIndex: 'nodeId', width: 180 },
                          { title: '类型', dataIndex: 'nodeType', width: 90 },
                          { title: '状态', dataIndex: 'status', width: 90, render: runStatusTag },
                          { title: '尝试', dataIndex: 'attempts', width: 70 },
                          { title: '结果', dataIndex: 'outcome', width: 90, render: (value?: string) => value || '-' },
                          {
                            title: '证据',
                            render: (_, node) => (
                              <Space wrap>
                                {node.evidence.flatMap((evidence) => [
                                  evidence.screenshotUrl ? <a key={`${evidence.id}-shot`} href={evidence.screenshotUrl} target="_blank" rel="noreferrer">{evidence.phase}截图</a> : null,
                                  evidence.sourceUrl ? <a key={`${evidence.id}-source`} href={evidence.sourceUrl} target="_blank" rel="noreferrer">{evidence.phase} Source</a> : null,
                                ])}
                                {!node.evidence.length && '-'}
                              </Space>
                            ),
                          },
                        ]}
                        scroll={{ x: 850 }}
                      />
                    )}
                  </Space>
                </Card>
              );
            })}
          </Space>
        )}
      </Drawer>

      <Modal
        title={`执行一次：${executionAsset?.name || ''}`}
        open={executionOpen}
        okText="启动单次回放"
        cancelText="取消"
        confirmLoading={executionSubmitting}
        onOk={() => void submitExecution()}
        onCancel={() => setExecutionOpen(false)}
        destroyOnClose
      >
        <Alert
          showIcon
          type="info"
          message="此处只启动一次确定性执行"
          description="循环次数、并发、设备池和 Jenkins 调度仍由自动质检任务配置。输入值仅用于当次执行，任务记录只保留参数名。"
          style={{ marginBottom: 16 }}
        />
        <Space wrap>
          {executionAsset?.preFlowAssetName && <Tag>前置：{executionAsset.preFlowAssetName}</Tag>}
          <Tag color="blue">主回放：{executionAsset?.name}</Tag>
          {executionAsset?.postFlowAssetName && <Tag>后置：{executionAsset.postFlowAssetName}</Tag>}
        </Space>
        <Divider />
        {executionInputs.length ? (
          <Form form={executionForm} layout="vertical">
            {executionInputs.map((field) => (
              <Form.Item
                key={field.name}
                name={field.name}
                label={field.name}
                extra={`${field.description || '回放流程参数'} · 使用于：${field.usedBy.join('、')}`}
                rules={field.required ? [{ required: true, message: `请输入 ${field.name}` }] : undefined}
              >
                <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} placeholder={`请输入 ${field.name}`} />
              </Form.Item>
            ))}
          </Form>
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该执行链不需要运行参数" />}
      </Modal>
    </div>
  );
}
