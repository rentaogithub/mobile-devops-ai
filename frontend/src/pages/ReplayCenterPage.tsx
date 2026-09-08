import {
  CaretRightOutlined,
  CopyOutlined,
  EditOutlined,
  EyeOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  PlusOutlined,
  ReloadOutlined,
  RollbackOutlined,
  RocketOutlined,
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
  ReplayFlowVersion,
  ReplayFlowVersionSummary,
  ReplayFlowChainPhase,
  ReplayFlowChainRun,
  ReplayFlowChainRunStatus,
} from '../services/api';
import { authUtils } from '../utils/auth';

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

function auditEventLabel(eventType: string) {
  const labels: Record<string, string> = {
    'flow.created_from_recording': '从录制创建',
    'flow.creation_completed': '完成创建',
    'flow.draft_saved': '保存草稿',
    'flow.published': '发布版本',
    'flow.version_copied': '从版本复制',
    'flow.version_rolled_back_to_draft': '回滚为新草稿',
    'flow.reset_from_recording': '从录制重置',
    'flow.execution_chain_updated': '更新执行链',
    'flow.archived': '归档',
    'flow.restored': '恢复',
  };
  return labels[eventType] || eventType;
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
  const canManageVersions = authUtils.hasAnyRole(['developer', 'admin']);
  const [assets, setAssets] = useState<ReplayFlowAssetSummary[]>([]);
  const [publishedVersions, setPublishedVersions] = useState<ReplayFlowVersionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ReplayFlowAssetStatus | 'creating' | 'all'>('all');
  const [detail, setDetail] = useState<ReplayFlowAsset | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionId, setActionId] = useState('');
  const [activeTab, setActiveTab] = useState('flows');
  const [preFlowVersionId, setPreFlowVersionId] = useState<string>();
  const [postFlowVersionId, setPostFlowVersionId] = useState<string>();
  const [chainSaving, setChainSaving] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [releaseNotes, setReleaseNotes] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [versionDetail, setVersionDetail] = useState<ReplayFlowVersion | null>(null);
  const [versionDetailLoadingId, setVersionDetailLoadingId] = useState('');
  const [versionActionId, setVersionActionId] = useState('');
  const [copyVersionTarget, setCopyVersionTarget] = useState<ReplayFlowVersionSummary | null>(null);
  const [copyVersionName, setCopyVersionName] = useState('');
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
      const [assetResponse, versionResponse] = await Promise.all([
        deviceControlApi.listReplayFlowAssets({ search, status: 'all' }),
        deviceControlApi.listPublishedReplayFlowVersions(),
      ]);
      setAssets(assetResponse.data?.assets || []);
      setPublishedVersions(versionResponse.data?.versions || []);
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

  const chainOptions = useMemo(() => publishedVersions
    .filter((version) => version.assetId !== detail?.id)
    .map((version) => ({
      value: version.id,
      label: `${version.assetName} · v${version.versionNumber}`,
    })), [detail?.id, publishedVersions]);
  const chainDirty = Boolean(detail) && (
    preFlowVersionId !== detail?.preFlowVersionId || postFlowVersionId !== detail?.postFlowVersionId
  );

  const displayedRuns = useMemo(() => runs.filter((run) => runStatus === 'all' || run.status === runStatus), [runStatus, runs]);
  const completedRuns = useMemo(() => runs.filter((run) => run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled'), [runs]);

  const openDetail = async (assetId: string) => {
    setDetailLoading(true);
    try {
      const response = await deviceControlApi.getReplayFlowAsset(assetId);
      const asset = response.data?.asset || null;
      setDetail(asset);
      setPreFlowVersionId(asset?.preFlowVersionId);
      setPostFlowVersionId(asset?.postFlowVersionId);
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
        preFlowVersionId: preFlowVersionId || null,
        postFlowVersionId: postFlowVersionId || null,
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

  const publishFlow = async () => {
    if (!detail) return;
    setPublishing(true);
    try {
      const response = await deviceControlApi.publishReplayFlowAsset(detail.id, {
        expectedRevision: detail.draft.revision,
        releaseNotes,
      });
      const asset = response.data!.asset;
      setDetail(asset);
      setPublishOpen(false);
      setReleaseNotes('');
      message.success(`已发布 ${asset.name} v${response.data!.version.versionNumber}`);
      await loadAssets();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setPublishing(false);
    }
  };

  const openVersionDetail = async (versionId: string) => {
    setVersionDetailLoadingId(versionId);
    try {
      const response = await deviceControlApi.getReplayFlowVersion(versionId);
      setVersionDetail(response.data?.version || null);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setVersionDetailLoadingId('');
    }
  };

  const copyVersion = async () => {
    if (!copyVersionTarget) return;
    const name = copyVersionName.trim();
    if (!name) {
      message.warning('请输入新回放任务名称');
      return;
    }
    setVersionActionId(copyVersionTarget.id);
    try {
      const response = await deviceControlApi.copyReplayFlowVersion(copyVersionTarget.id, name);
      const asset = response.data?.asset;
      if (!asset) throw new Error('复制历史版本失败');
      setCopyVersionTarget(null);
      setDetail(null);
      message.success(`已从 v${copyVersionTarget.versionNumber} 创建「${asset.name}」`);
      navigate(`/cicd/replay/${asset.id}/edit`);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setVersionActionId('');
    }
  };

  const rollbackVersion = async (version: ReplayFlowVersionSummary) => {
    if (!detail) return;
    setVersionActionId(version.id);
    try {
      const response = await deviceControlApi.rollbackReplayFlowVersion(version.id, detail.draft.revision);
      const asset = response.data?.asset;
      if (!asset) throw new Error('回滚历史版本失败');
      setDetail(null);
      message.success(`已基于 v${version.versionNumber} 生成草稿 r${asset.draft.revision}`);
      navigate(`/cicd/replay/${asset.id}/edit`);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setVersionActionId('');
    }
  };

  const prepareExecution = async (asset: ReplayFlowAsset) => {
    setExecutionPreparing(true);
    try {
      const referenceIds = [asset.preFlowVersionId, asset.postFlowVersionId].filter(Boolean) as string[];
      const references = await Promise.all(referenceIds.map(async (id) => {
        const response = await deviceControlApi.getReplayFlowVersion(id);
        return response.data!.version;
      }));
      const byId = new Map(references.map((item) => [item.id, item]));
      const chain = [
        asset.preFlowVersionId ? byId.get(asset.preFlowVersionId) : undefined,
        { id: asset.id, assetName: asset.name, flow: asset.draft.flow },
        asset.postFlowVersionId ? byId.get(asset.postFlowVersionId) : undefined,
      ].filter(Boolean) as Array<{ id: string; assetName: string; flow: ReplayFlowAsset['draft']['flow'] }>;
      const fields = new Map<string, ExecutionInputField>();
      chain.forEach((item) => {
        Object.entries(item.flow.inputs || {}).forEach(([name, definition]) => {
          const current = fields.get(name);
          fields.set(name, {
            name,
            required: Boolean(definition.required || current?.required),
            defaultValue: current?.defaultValue ?? definition.default,
            description: current?.description || definition.description,
            usedBy: [...(current?.usedBy || []), item.assetName],
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
      title: '回放任务名称',
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
      render: (_, asset) => (
        <Text>{asset.latestVersionNumber ? `v${asset.latestVersionNumber} · ` : ''}{asset.creationCompleted ? '草稿' : '未完成'} r{asset.revision}</Text>
      ),
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
              <Tag color={phase.phase === 'main' ? 'blue' : undefined}>
                {phaseLabel(phase.phase)}：{phase.assetName}{phase.versionNumber ? ` v${phase.versionNumber}` : ''}
              </Tag>
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
            placeholder="搜索回放任务名称、描述或录制 ID"
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
            {detail?.creationCompleted && detail.status !== 'archived' && (
              <Button
                icon={<RocketOutlined />}
                disabled={!detail.draft.validation.valid || !canManageVersions}
                title={!canManageVersions ? '发布需要研发或管理员权限' : undefined}
                onClick={() => setPublishOpen(true)}
              >
                {detail.latestVersionNumber ? '发布新版本' : '发布'}
              </Button>
            )}
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
              <Descriptions.Item label="最新发布版本">{detail.latestVersionNumber ? `v${detail.latestVersionNumber}` : '尚未发布'}</Descriptions.Item>
              <Descriptions.Item label="节点数量">{detail.nodeCount}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{dateTime(detail.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="更新时间">{dateTime(detail.updatedAt)}</Descriptions.Item>
              <Descriptions.Item label="描述" span={2}>{detail.description || '-'}</Descriptions.Item>
            </Descriptions>
            <Card size="small" title="发布历史">
              {detail.versions.length ? (
                <Table
                  size="small"
                  rowKey="id"
                  pagination={false}
                  dataSource={detail.versions}
                  columns={[
                    { title: '版本', dataIndex: 'versionNumber', width: 90, render: (value: number) => <Tag color="green">v{value}</Tag> },
                    { title: '发布说明', dataIndex: 'releaseNotes', render: (value?: string) => value || '-' },
                    { title: '发布人', dataIndex: 'createdBy', width: 120 },
                    { title: '发布时间', dataIndex: 'createdAt', width: 180, render: dateTime },
                    {
                      title: '操作',
                      width: 250,
                      render: (_, version) => (
                        <Space size="small">
                          <Button
                            size="small"
                            icon={<EyeOutlined />}
                            loading={versionDetailLoadingId === version.id}
                            onClick={() => void openVersionDetail(version.id)}
                          >
                            查看
                          </Button>
                          <Button
                            size="small"
                            icon={<CopyOutlined />}
                            loading={versionActionId === version.id}
                            onClick={() => {
                              setCopyVersionTarget(version);
                              setCopyVersionName(`${version.assetName} v${version.versionNumber} 副本`);
                            }}
                          >
                            复制
                          </Button>
                          <Popconfirm
                            title={`基于 v${version.versionNumber} 生成新的可编辑草稿？`}
                            description="历史版本和当前已发布版本不会被修改。"
                            okText="生成回滚草稿"
                            cancelText="取消"
                            disabled={!canManageVersions}
                            onConfirm={() => void rollbackVersion(version)}
                          >
                            <Button
                              size="small"
                              icon={<RollbackOutlined />}
                              loading={versionActionId === version.id}
                              disabled={!canManageVersions}
                              title={!canManageVersions ? '回滚需要研发或管理员权限' : undefined}
                            >
                              回滚
                            </Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                  scroll={{ x: 900 }}
                />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未发布版本" />
              )}
            </Card>
            <Card size="small" title="操作审计">
              {detail.auditEvents.length ? (
                <Table
                  size="small"
                  rowKey="id"
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  dataSource={detail.auditEvents}
                  columns={[
                    { title: '操作', dataIndex: 'eventType', width: 180, render: auditEventLabel },
                    { title: '操作人', dataIndex: 'actor', width: 120 },
                    {
                      title: '记录',
                      dataIndex: 'payload',
                      render: (payload: Record<string, unknown>) => (
                        <Text type="secondary" ellipsis={{ tooltip: JSON.stringify(payload) }} style={{ maxWidth: 460 }}>
                          {Object.keys(payload).length ? JSON.stringify(payload) : '-'}
                        </Text>
                      ),
                    },
                    { title: '时间', dataIndex: 'createdAt', width: 180, render: dateTime },
                  ]}
                  scroll={{ x: 900 }}
                />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无操作记录" />
              )}
            </Card>
            <Card size="small" title="执行链配置">
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Alert
                  showIcon
                  type="info"
                  message="每次只执行一条确定性链路"
                  description="前置和后置只能绑定已发布的不可变版本。前置失败会跳过主回放；无论前置或主回放是否失败，都会尝试执行后置清理。"
                />
                {!chainOptions.length && (
                  <Alert showIcon type="warning" message="暂无可引用的已发布流程，请先发布准备流程或清理流程。" />
                )}
                <Row gutter={[12, 12]} align="middle">
                  <Col xs={24} md={7}>
                    <Text strong>前置准备（可选）</Text>
                    <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      value={preFlowVersionId}
                      onChange={setPreFlowVersionId}
                      options={chainOptions}
                      placeholder="选择已发布的准备流程版本"
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
                      value={postFlowVersionId}
                      onChange={setPostFlowVersionId}
                      options={chainOptions}
                      placeholder="选择已发布的清理流程版本"
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
                  <Text type="secondary">主回放用于草稿调试；前置和后置固定执行所选的不可变发布版本。</Text>
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
        title={`发布流程：${detail?.name || ''}`}
        open={publishOpen}
        okText={detail?.latestVersionNumber ? `发布 v${detail.latestVersionNumber + 1}` : '发布 v1'}
        cancelText="取消"
        confirmLoading={publishing}
        onOk={() => void publishFlow()}
        onCancel={() => {
          setPublishOpen(false);
          setReleaseNotes('');
        }}
        destroyOnClose
      >
        <Alert
          showIcon
          type="info"
          message="发布后生成不可变版本"
          description="前置流程、后置流程和后续正式质检将固定引用该版本；之后修改草稿不会改变已经发布的内容。"
          style={{ marginBottom: 16 }}
        />
        {detail?.draft.validation.warnings.length ? (
          <Alert
            showIcon
            type="warning"
            message={`当前草稿有 ${detail.draft.validation.warnings.length} 条校验警告`}
            description={(
              <Space direction="vertical" size={2}>
                {detail.draft.validation.warnings.map((warning) => (
                  <Text key={`${warning.code}-${warning.path || warning.nodeId || ''}`}>
                    {warning.nodeId ? `${warning.nodeId}：` : ''}{warning.message}
                  </Text>
                ))}
              </Space>
            )}
            style={{ marginBottom: 16 }}
          />
        ) : (
          <Alert showIcon type="success" message="草稿校验通过，无警告" style={{ marginBottom: 16 }} />
        )}
        <Input.TextArea
          value={releaseNotes}
          onChange={(event) => setReleaseNotes(event.target.value)}
          rows={4}
          maxLength={1000}
          showCount
          placeholder="填写本次发布说明（可选）"
        />
      </Modal>

      <Modal
        title={versionDetail ? `${versionDetail.assetName} · v${versionDetail.versionNumber}` : '版本详情'}
        open={Boolean(versionDetail)}
        width="min(92vw, 980px)"
        footer={<Button onClick={() => setVersionDetail(null)}>关闭</Button>}
        onCancel={() => setVersionDetail(null)}
      >
        {versionDetail && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Alert
              showIcon
              type="success"
              message="这是不可变发布版本"
              description="查看、复制或回滚都不会修改该版本保存的 DSL 与编译执行图。"
            />
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="版本">v{versionDetail.versionNumber}</Descriptions.Item>
              <Descriptions.Item label="发布人">{versionDetail.createdBy}</Descriptions.Item>
              <Descriptions.Item label="发布时间">{dateTime(versionDetail.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="入口节点">
                {String((versionDetail.compiled as { entryNodeId?: string })?.entryNodeId || '-')}
              </Descriptions.Item>
              <Descriptions.Item label="来源指纹" span={2}><Text copyable>{versionDetail.sourceFingerprint}</Text></Descriptions.Item>
              <Descriptions.Item label="发布说明" span={2}>{versionDetail.releaseNotes || '-'}</Descriptions.Item>
            </Descriptions>
            <Tabs
              items={[
                {
                  key: 'dsl',
                  label: 'DSL 快照',
                  children: <pre style={{ maxHeight: 520, overflow: 'auto', background: '#0f172a', color: '#e2e8f0', padding: 16, borderRadius: 8 }}>{JSON.stringify(versionDetail.flow, null, 2)}</pre>,
                },
                {
                  key: 'compiled',
                  label: '编译执行图',
                  children: <pre style={{ maxHeight: 520, overflow: 'auto', background: '#0f172a', color: '#e2e8f0', padding: 16, borderRadius: 8 }}>{JSON.stringify(versionDetail.compiled, null, 2)}</pre>,
                },
              ]}
            />
          </Space>
        )}
      </Modal>

      <Modal
        title={copyVersionTarget ? `复制 ${copyVersionTarget.assetName} · v${copyVersionTarget.versionNumber}` : '复制历史版本'}
        open={Boolean(copyVersionTarget)}
        okText="创建回放任务"
        cancelText="取消"
        confirmLoading={Boolean(copyVersionTarget && versionActionId === copyVersionTarget.id)}
        onOk={() => void copyVersion()}
        onCancel={() => setCopyVersionTarget(null)}
        destroyOnClose
      >
        <Alert
          showIcon
          type="info"
          message="将使用该发布版本的不可变 DSL 创建一条全新的可编辑任务"
          style={{ marginBottom: 16 }}
        />
        <Text strong>新回放任务名称</Text>
        <Input
          value={copyVersionName}
          onChange={(event) => setCopyVersionName(event.target.value)}
          maxLength={160}
          showCount
          autoFocus
          style={{ marginTop: 8 }}
          onPressEnter={() => void copyVersion()}
        />
      </Modal>

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
          {executionAsset?.preFlowAssetName && <Tag>前置：{executionAsset.preFlowAssetName} v{executionAsset.preFlowVersionNumber}</Tag>}
          <Tag color="blue">主回放：{executionAsset?.name}</Tag>
          {executionAsset?.postFlowAssetName && <Tag>后置：{executionAsset.postFlowAssetName} v{executionAsset.postFlowVersionNumber}</Tag>}
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
