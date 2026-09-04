import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  FileSearchOutlined,
  LoadingOutlined,
  RollbackOutlined,
  SaveOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { Alert, Button, Descriptions, List, Modal, Result, Space, Spin, Steps, Tag, Typography, message } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import ReplayFlowDesigner from '../components/ReplayFlowDesigner';
import {
  DeviceReplayFlowDsl,
  DeviceReplayFlowValidation,
  ReplayFlowAsset,
  ReplayFlowSourcePreview,
  deviceControlApi,
} from '../services/api';

const { Text } = Typography;
const AUTO_SAVE_DELAY_MS = 1200;

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

function errorMessage(error: unknown) {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'error' in error) {
    return String((error as { error?: unknown }).error || '操作失败');
  }
  if (error instanceof Error) return error.message;
  return '操作失败';
}

function errorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code?: unknown }).code || '');
  }
  return '';
}

function serializeFlow(flow: DeviceReplayFlowDsl | null) {
  return flow ? JSON.stringify(flow) : '';
}

function saveStateTag(state: SaveState, revision: number, savedAt?: Date) {
  if (state === 'saving') return <Tag icon={<LoadingOutlined />} color="processing">正在保存 r{revision}</Tag>;
  if (state === 'dirty') return <Tag icon={<SyncOutlined spin />} color="gold">等待自动保存</Tag>;
  if (state === 'conflict') return <Tag icon={<ExclamationCircleOutlined />} color="error">草稿冲突</Tag>;
  if (state === 'error') return <Tag icon={<ExclamationCircleOutlined />} color="error">保存失败</Tag>;
  return (
    <Tag icon={<CheckCircleOutlined />} color="success">
      已保存 r{revision}{savedAt ? ` · ${savedAt.toLocaleTimeString()}` : ''}
    </Tag>
  );
}

export default function ReplayFlowEditorPage() {
  const navigate = useNavigate();
  const { assetId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const requestedCreationMode = searchParams.get('mode') === 'create';
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [asset, setAsset] = useState<ReplayFlowAsset | null>(null);
  const [editorSeed, setEditorSeed] = useState<DeviceReplayFlowDsl | null>(null);
  const [editorValidation, setEditorValidation] = useState<DeviceReplayFlowValidation | null>(null);
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [workingFlow, setWorkingFlow] = useState<DeviceReplayFlowDsl | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState('');
  const [savedAt, setSavedAt] = useState<Date>();
  const [connected, setConnected] = useState(false);
  const [sourcePreview, setSourcePreview] = useState<ReplayFlowSourcePreview | null>(null);
  const [sourcePreviewOpen, setSourcePreviewOpen] = useState(false);
  const [sourcePreviewLoading, setSourcePreviewLoading] = useState(false);
  const [sourcePreviewError, setSourcePreviewError] = useState('');
  const [resettingSource, setResettingSource] = useState(false);
  const revisionRef = useRef(0);
  const savedFlowRef = useRef('');
  const workingFlowRef = useRef<DeviceReplayFlowDsl | null>(null);
  const savingRef = useRef(false);
  const conflictRef = useRef(false);
  const creationMode = requestedCreationMode || asset?.creationCompleted === false;

  const applyAsset = useCallback((nextAsset: ReplayFlowAsset) => {
    const nextFlow = nextAsset.draft.flow;
    const serialized = serializeFlow(nextFlow);
    setAsset(nextAsset);
    setEditorSeed(nextFlow);
    setEditorValidation(nextAsset.draft.validation);
    setEditorGeneration((current) => current + 1);
    setWorkingFlow(nextFlow);
    workingFlowRef.current = nextFlow;
    revisionRef.current = nextAsset.draft.revision;
    savedFlowRef.current = serialized;
    savingRef.current = false;
    conflictRef.current = false;
    setSaveState('saved');
    setSaveError('');
  }, []);

  const loadAsset = useCallback(async () => {
    if (!assetId) return;
    setLoading(true);
    setLoadError('');
    try {
      const response = await deviceControlApi.getReplayFlowAsset(assetId);
      if (!response.success || !response.data?.asset) throw new Error(response.error || '回放流程不存在');
      applyAsset(response.data.asset);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [applyAsset, assetId]);

  useEffect(() => {
    void loadAsset();
  }, [loadAsset]);

  const loadSourcePreview = useCallback(async () => {
    if (!assetId) return;
    setSourcePreviewLoading(true);
    setSourcePreviewError('');
    try {
      const response = await deviceControlApi.getReplayFlowSourcePreview(assetId);
      if (!response.data?.preview) throw new Error('无法读取录制来源');
      setSourcePreview(response.data.preview);
    } catch (error) {
      setSourcePreviewError(errorMessage(error));
    } finally {
      setSourcePreviewLoading(false);
    }
  }, [assetId]);

  useEffect(() => {
    if (asset?.sourceRecordingId) void loadSourcePreview();
  }, [asset?.draft.revision, asset?.sourceRecordingId, loadSourcePreview]);

  useEffect(() => {
    void deviceControlApi.status()
      .then((response) => setConnected(response.data?.phase === 'connected'))
      .catch(() => setConnected(false));
  }, []);

  const handleFlowChange = useCallback((flow: DeviceReplayFlowDsl) => {
    workingFlowRef.current = flow;
    setWorkingFlow(flow);
    if (conflictRef.current) return;
    setSaveState(serializeFlow(flow) === savedFlowRef.current ? 'saved' : savingRef.current ? 'saving' : 'dirty');
  }, []);

  const persistFlow = useCallback(async (flow: DeviceReplayFlowDsl | null, manual = false) => {
    if (!flow || !assetId || savingRef.current || conflictRef.current || asset?.status === 'archived') return false;
    const submitted = serializeFlow(flow);
    if (submitted === savedFlowRef.current) {
      setSaveState('saved');
      return true;
    }
    savingRef.current = true;
    setSaveState('saving');
    setSaveError('');
    try {
      const response = await deviceControlApi.saveReplayFlowDraft(assetId, {
        expectedRevision: revisionRef.current,
        flow,
        name: flow.name,
        description: flow.description,
      });
      if (!response.success || !response.data?.asset) throw new Error(response.error || '保存草稿失败');
      const savedAsset = response.data.asset;
      const savedSerialized = serializeFlow(savedAsset.draft.flow);
      revisionRef.current = savedAsset.draft.revision;
      savedFlowRef.current = savedSerialized;
      setAsset(savedAsset);
      setSavedAt(new Date());
      setSaveState(serializeFlow(workingFlowRef.current) === savedSerialized ? 'saved' : 'dirty');
      if (manual) message.success(`草稿已保存为 r${savedAsset.draft.revision}`);
      return true;
    } catch (error) {
      if (errorCode(error) === 'FLOW_DRAFT_CONFLICT') {
        conflictRef.current = true;
        setSaveState('conflict');
      } else {
        setSaveState('error');
        setSaveError(errorMessage(error));
        if (manual) message.error(errorMessage(error));
      }
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [asset?.status, assetId]);

  useEffect(() => {
    if (saveState !== 'dirty' || !workingFlow || asset?.status === 'archived') return undefined;
    const timer = window.setTimeout(() => void persistFlow(workingFlow), AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [asset?.status, persistFlow, saveState, workingFlow]);

  const closeEditor = useCallback(async () => {
    if (saveState === 'saving') {
      message.info('草稿正在保存，请稍后再离开');
      return;
    }
    if (saveState === 'dirty') {
      const saved = await persistFlow(workingFlowRef.current, true);
      if (saved) navigate('/cicd/replay');
      return;
    }
    if (saveState === 'error' || saveState === 'conflict') {
      Modal.confirm({
        title: '当前修改尚未保存',
        content: saveState === 'conflict' ? '草稿已在其他窗口更新，本地修改还未写入服务端。' : '离开后本地未保存的修改会丢失。',
        okText: '仍然离开',
        okButtonProps: { danger: true },
        cancelText: '继续编辑',
        onOk: () => navigate('/cicd/replay'),
      });
      return;
    }
    navigate('/cicd/replay');
  }, [navigate, persistFlow, saveState]);

  const finishCreation = useCallback(async () => {
    if (saveState === 'saving') {
      message.info('草稿正在保存，请稍候');
      return;
    }
    if (saveState === 'conflict') {
      message.warning('请先处理草稿版本冲突');
      return;
    }
    if (saveState === 'dirty' || saveState === 'error') {
      const saved = await persistFlow(workingFlowRef.current, true);
      if (!saved) return;
    }
    try {
      const response = await deviceControlApi.completeReplayFlowCreation(assetId);
      if (!response.success || !response.data?.asset) throw new Error(response.error || '完成创建失败');
      setAsset(response.data.asset);
      message.success('回放流程已保存到流程库');
      navigate('/cicd/replay');
    } catch (error) {
      message.error(errorMessage(error));
    }
  }, [assetId, navigate, persistFlow, saveState]);

  const resetFromRecording = useCallback(() => {
    if (!asset || !sourcePreview || resettingSource) return;
    if (saveState === 'saving') {
      message.info('草稿正在保存，请稍后重试');
      return;
    }
    if (saveState === 'conflict') {
      message.warning('请先重新载入服务端草稿，再从录制来源重置');
      return;
    }
    Modal.confirm({
      title: '确定从原录制重置草稿？',
      icon: <ExclamationCircleOutlined />,
      content: `当前编排内容${saveState === 'dirty' || saveState === 'error' ? '（包含未保存修改）' : ''}将被录制「${sourcePreview.recording.title}」的 ${sourcePreview.recording.selectedCount} 条已选步骤替换，并保存为新 revision。`,
      okText: '确认重置',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setResettingSource(true);
        try {
          const response = await deviceControlApi.resetReplayFlowFromRecording(asset.id, revisionRef.current);
          if (!response.data?.asset) throw new Error('从录制来源重置失败');
          applyAsset(response.data.asset);
          if (response.data.preview) setSourcePreview(response.data.preview);
          setSourcePreviewOpen(false);
          setSavedAt(new Date());
          message.success(`已从录制来源重置为 r${response.data.asset.draft.revision}`);
        } catch (error) {
          if (errorCode(error) === 'FLOW_DRAFT_CONFLICT') {
            conflictRef.current = true;
            setSaveState('conflict');
          }
          message.error(errorMessage(error));
        } finally {
          setResettingSource(false);
        }
      },
    });
  }, [applyAsset, asset, resettingSource, saveState, sourcePreview]);

  if (loading) {
    return <div style={{ minHeight: '70vh', display: 'grid', placeItems: 'center' }}><Spin size="large" tip="正在加载流程草稿" /></div>;
  }

  if (loadError || !asset || !editorSeed) {
    return (
      <Result
        status="error"
        title="无法打开流程编辑器"
        subTitle={loadError || '回放流程不存在'}
        extra={<Button type="primary" onClick={() => navigate('/cicd/replay')}>返回回放中心</Button>}
      />
    );
  }

  const archived = asset.status === 'archived';
  const headerExtra = (
    <Space>
      <Button
        icon={<FileSearchOutlined />}
        loading={sourcePreviewLoading}
        onClick={() => {
          setSourcePreviewOpen(true);
          void loadSourcePreview();
        }}
      >
        录制来源
      </Button>
      {sourcePreview?.sourceChanged && <Tag color="warning">来源已变更</Tag>}
      {saveStateTag(saveState, revisionRef.current, savedAt)}
      <Button
        icon={<SaveOutlined />}
        loading={saveState === 'saving'}
        disabled={archived || saveState === 'saved' || saveState === 'conflict'}
        onClick={() => void persistFlow(workingFlowRef.current, true)}
      >
        立即保存
      </Button>
      {creationMode && (
        <Button
          type="primary"
          disabled={archived || saveState === 'conflict'}
          loading={saveState === 'saving'}
          onClick={() => void finishCreation()}
        >
          完成创建
        </Button>
      )}
    </Space>
  );

  return (
    <>
      {(archived || saveState === 'error') && (
        <Alert
          banner
          showIcon
          type={archived ? 'warning' : 'error'}
          message={archived ? '当前流程已归档，编辑器为只读模式' : `自动保存失败：${saveError}`}
          action={!archived && <Button size="small" onClick={() => void persistFlow(workingFlowRef.current, true)}>重试</Button>}
        />
      )}
      <ReplayFlowDesigner
        key={`${asset.id}-${editorGeneration}`}
        open
        initialFlow={editorSeed}
        initialValidation={editorValidation}
        connected={connected}
        readOnly={archived}
        showRunControls
        title={creationMode ? '新建回放：编排与验证' : '回放流程编辑器'}
        resetLabel="重新载入服务端草稿"
        headerExtra={headerExtra}
        workspaceHeader={creationMode ? (
          <Steps
            current={2}
            items={[
              { title: '录制路径', status: 'finish' },
              { title: '筛选补标', status: 'finish' },
              { title: '编排验证', description: connected ? '真机已连接，可直接调试' : '可先完成编排，连接真机后调试' },
              { title: '保存完成' },
            ]}
          />
        ) : undefined}
        onFlowChange={handleFlowChange}
        onReload={loadAsset}
        onClose={closeEditor}
      />

      <Modal
        open={sourcePreviewOpen}
        width="min(92vw, 900px)"
        title="录制来源预览"
        onCancel={() => setSourcePreviewOpen(false)}
        footer={[
          <Button key="close" onClick={() => setSourcePreviewOpen(false)}>关闭</Button>,
          <Button
            key="reset"
            danger
            icon={<RollbackOutlined />}
            loading={resettingSource}
            disabled={archived || !sourcePreview || saveState === 'conflict'}
            onClick={resetFromRecording}
          >
            从该录制重置草稿
          </Button>,
        ]}
      >
        <Spin spinning={sourcePreviewLoading}>
          {sourcePreviewError && <Alert type="error" showIcon message={sourcePreviewError} style={{ marginBottom: 16 }} />}
          {sourcePreview && (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Alert
                showIcon
                type={sourcePreview.sourceChanged ? 'warning' : sourcePreview.storedSourceFingerprint !== sourcePreview.sourceFingerprint ? 'info' : 'success'}
                message={sourcePreview.sourceChanged
                  ? '录制来源已发生变化'
                  : sourcePreview.storedSourceFingerprint !== sourcePreview.sourceFingerprint
                    ? '来源内容一致，指纹算法已升级'
                    : '当前草稿与已确认来源指纹一致'}
                description={sourcePreview.sourceChanged
                  ? '平台不会自动改写当前草稿。只有主动选择“从该录制重置草稿”才会用最新已选步骤替换编排。'
                  : sourcePreview.storedSourceFingerprint !== sourcePreview.sourceFingerprint
                    ? '当前资产使用旧版兼容指纹，已确认选中动作内容未变。下次主动重置时会更新为新指纹。'
                    : '可以查看生成来源；如主动重置，仍会创建新 revision。'}
              />
              <Descriptions bordered size="small" column={2}>
                <Descriptions.Item label="录制名称">{sourcePreview.recording.title}</Descriptions.Item>
                <Descriptions.Item label="已选步骤">{sourcePreview.recording.selectedCount}</Descriptions.Item>
                <Descriptions.Item label="录制 ID"><Text copyable>{sourcePreview.recording.id}</Text></Descriptions.Item>
                <Descriptions.Item label="停止时间">{sourcePreview.recording.stoppedAt ? new Date(sourcePreview.recording.stoppedAt).toLocaleString() : '-'}</Descriptions.Item>
                <Descriptions.Item label="当前来源指纹"><Text copyable>{sourcePreview.storedSourceFingerprint || '-'}</Text></Descriptions.Item>
                <Descriptions.Item label="最新录制指纹"><Text copyable>{sourcePreview.sourceFingerprint}</Text></Descriptions.Item>
              </Descriptions>
              <List
                size="small"
                bordered
                header={<Text strong>录制中已确认的生成步骤</Text>}
                dataSource={sourcePreview.selectedSteps}
                renderItem={(step) => (
                  <List.Item>
                    <Space direction="vertical" size={0}>
                      <Text><Text strong>#{step.index}</Text> <Tag>{step.actionType}</Tag>{step.summary}</Text>
                      <Text type="secondary">{step.targetSummary || '无语义目标，将使用录制几何信息'}</Text>
                    </Space>
                  </List.Item>
                )}
              />
            </Space>
          )}
        </Spin>
      </Modal>

      <Modal
        open={saveState === 'conflict'}
        closable={false}
        maskClosable={false}
        title="检测到草稿版本冲突"
        footer={[
          <Button key="back" onClick={() => navigate('/cicd/replay')}>返回流程库</Button>,
          <Button key="reload" type="primary" onClick={() => void loadAsset()}>重新载入服务端草稿</Button>,
        ]}
      >
        <Space direction="vertical" size="middle">
          <Alert
            showIcon
            type="warning"
            message="这个流程已在其他窗口或会话中保存"
            description={`本地基于 r${revisionRef.current} 编辑，服务端 revision 已变更。为避免覆盖他人的修改，平台已停止自动保存。`}
          />
          <Text type="secondary">重新载入会以服务端最新草稿替换当前本地内容。</Text>
        </Space>
      </Modal>
    </>
  );
}
