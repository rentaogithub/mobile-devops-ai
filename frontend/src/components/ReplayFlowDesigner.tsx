import {
  AimOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  DragOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Divider,
  Drawer,
  Empty,
  Image,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DeviceRecording,
  DeviceReplayFlowCondition,
  DeviceReplayFlowDsl,
  DeviceReplayFlowNode,
  DeviceReplayFlowNodeType,
  DeviceReplayFlowRun,
  DeviceReplayFlowTarget,
  DeviceReplayFlowValidation,
  deviceControlApi,
} from '../services/api';
import './ReplayFlowDesigner.css';

const { Paragraph, Text, Title } = Typography;
const NODE_WIDTH = 220;
const NODE_HEADER_HEIGHT = 44;
type SimpleReplayCondition = Extract<DeviceReplayFlowCondition, { kind: string }>;

interface NodePosition {
  x: number;
  y: number;
}

interface ConnectionDraft {
  nodeId: string;
  field: string;
}

interface NodeDragState {
  nodeId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
}

interface PaletteDragState {
  type: DeviceReplayFlowNodeType;
  pointerId: number;
}

interface ReplayFlowDesignerProps {
  open: boolean;
  recording?: DeviceRecording | null;
  initialFlow?: DeviceReplayFlowDsl | null;
  initialValidation?: DeviceReplayFlowValidation | null;
  connected: boolean;
  onClose: () => void;
  onFlowChange?: (flow: DeviceReplayFlowDsl) => void;
  onReload?: () => void | Promise<void>;
  headerExtra?: ReactNode;
  workspaceHeader?: ReactNode;
  title?: string;
  resetLabel?: string;
  readOnly?: boolean;
  showRunControls?: boolean;
}

const NODE_META: Record<DeviceReplayFlowNodeType, { title: string; color: string }> = {
  start: { title: 'Start', color: '#1677ff' },
  tap: { title: 'Tap', color: '#13c2c2' },
  swipe: { title: 'Swipe', color: '#36cfc9' },
  input: { title: 'Input', color: '#722ed1' },
  keyboard: { title: 'Keyboard', color: '#9254de' },
  wait: { title: 'Wait', color: '#fa8c16' },
  condition: { title: 'Condition', color: '#faad14' },
  assertion: { title: 'Assertion', color: '#52c41a' },
  end: { title: 'End', color: '#8c8c8c' },
};

const PALETTE_TYPES: DeviceReplayFlowNodeType[] = [
  'tap', 'swipe', 'input', 'keyboard', 'wait', 'condition', 'assertion', 'end',
];

function errorMessage(error: unknown) {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'error' in error) return String((error as { error?: unknown }).error || '操作失败');
  if (error instanceof Error) return error.message;
  return '操作失败';
}

function edgeFields(node: DeviceReplayFlowNode) {
  if (node.type === 'start') return [{ field: 'next', label: 'next' }];
  if (['tap', 'swipe', 'input', 'keyboard'].includes(node.type)) return [
    { field: 'next', label: 'success' },
    { field: 'onFailure', label: 'failure' },
  ];
  if (node.type === 'wait') return [
    { field: 'onSuccess', label: 'success' },
    { field: 'onTimeout', label: 'timeout' },
    { field: 'onError', label: 'error' },
  ];
  if (node.type === 'condition') return [
    { field: 'onTrue', label: 'true' },
    { field: 'onFalse', label: 'false' },
    { field: 'onTimeout', label: 'timeout' },
    { field: 'onError', label: 'error' },
  ];
  if (node.type === 'assertion') return [
    { field: 'onPassed', label: 'passed' },
    { field: 'onFailed', label: 'failed' },
    { field: 'onError', label: 'error' },
  ];
  return [];
}

function defaultCondition(kind: string): DeviceReplayFlowCondition {
  if (kind === 'text') return { kind: 'text', operator: 'equals', target: { label: '目标文本' }, value: '期望文本' };
  if (kind === 'keyboard') return { kind: 'keyboard', operator: 'visible' };
  if (kind === 'app') return { kind: 'app', operator: 'foreground' };
  if (kind === 'delay') return { kind: 'delay', durationMs: 800 };
  if (kind === 'page_stable') return { kind: 'page_stable', durationMs: 800 };
  if (kind === 'snapshot_similarity') return { kind: 'snapshot_similarity', snapshotId: '', threshold: 0.72 };
  return { kind: 'element', operator: 'exists', target: { label: '目标控件' } };
}

function newNode(type: DeviceReplayFlowNodeType): DeviceReplayFlowNode {
  const id = `${type}_${Date.now().toString(36)}`;
  const base = { id, type, name: `${NODE_META[type].title} 节点`, timeoutMs: 15000 } as DeviceReplayFlowNode;
  if (type === 'tap') return { ...base, target: { label: '目标控件', coordinate: { x: 0.5, y: 0.5 } } };
  if (type === 'swipe') return { ...base, start: { x: 0.5, y: 0.8 }, end: { x: 0.5, y: 0.2 }, durationMs: 350 };
  if (type === 'input') return { ...base, target: { label: '输入框' }, value: '${INPUT}' };
  if (type === 'keyboard') return { ...base, key: 'Search' };
  if (type === 'wait') return { ...base, condition: defaultCondition('element') };
  if (type === 'condition') return { ...base, condition: defaultCondition('element') };
  if (type === 'assertion') return { ...base, condition: defaultCondition('element') };
  if (type === 'end') return { ...base, result: 'success', message: '流程执行完成' };
  return base;
}

function autoPositions(nodes: DeviceReplayFlowNode[]) {
  return Object.fromEntries(nodes.map((node, index) => [node.id, {
    x: 48 + ((index % 4) * 280),
    y: 48 + (Math.floor(index / 4) * 190),
  }])) as Record<string, NodePosition>;
}

function conditionKind(condition?: DeviceReplayFlowCondition) {
  if (!condition) return 'element';
  if ('all' in condition) return 'all';
  if ('any' in condition) return 'any';
  if ('not' in condition) return 'not';
  return condition.kind;
}

function conditionSummary(condition?: DeviceReplayFlowCondition): string {
  if (!condition) return '未配置条件';
  if ('all' in condition) return `全部满足（${condition.all.length} 项）`;
  if ('any' in condition) return `任一满足（${condition.any.length} 项）`;
  if ('not' in condition) return `NOT ${conditionSummary(condition.not)}`;
  if (condition.kind === 'element') return `${condition.operator} · ${condition.target.accessibilityId || condition.target.label || condition.target.text || '目标'}`;
  if (condition.kind === 'text') return `${condition.operator} “${condition.value}”`;
  if (condition.kind === 'delay') return `等待 ${condition.durationMs}ms`;
  if (condition.kind === 'page_stable') return `页面稳定 ${condition.durationMs || 800}ms`;
  if (condition.kind === 'snapshot_similarity') return `快照相似 ≥ ${Math.round((condition.threshold ?? 0.72) * 100)}%`;
  return `${condition.kind} · ${condition.operator}`;
}

function nodeSummary(node: DeviceReplayFlowNode) {
  if (node.type === 'tap') return node.target?.accessibilityId || node.target?.label || node.target?.text || '点击目标';
  if (node.type === 'input') return `${node.value || ''} → ${node.target?.label || node.target?.placeholder || '当前焦点'}`;
  if (node.type === 'swipe') return `${Math.round((node.start?.x || 0) * 100)}%,${Math.round((node.start?.y || 0) * 100)}% → ${Math.round((node.end?.x || 0) * 100)}%,${Math.round((node.end?.y || 0) * 100)}%`;
  if (node.type === 'keyboard') return node.key || 'Search';
  if (node.type === 'wait' || node.type === 'condition' || node.type === 'assertion') return conditionSummary(node.condition);
  if (node.type === 'end') return node.result === 'failure' ? 'Failure End' : 'Success End';
  return '流程入口';
}

function runNodeFor(run: DeviceReplayFlowRun | null, nodeId: string) {
  return run?.nodes.filter((item) => item.nodeId === nodeId).slice(-1)[0];
}

export default function ReplayFlowDesigner({
  open,
  recording = null,
  initialFlow = null,
  initialValidation = null,
  connected,
  onClose,
  onFlowChange,
  onReload,
  headerExtra,
  workspaceHeader,
  title = '真机回放流程编排',
  resetLabel,
  readOnly = false,
  showRunControls = true,
}: ReplayFlowDesignerProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [flow, setFlow] = useState<DeviceReplayFlowDsl | null>(null);
  const [positions, setPositions] = useState<Record<string, NodePosition>>({});
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [loading, setLoading] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<DeviceReplayFlowValidation | null>(null);
  const [connection, setConnection] = useState<ConnectionDraft | null>(null);
  const [pointerPosition, setPointerPosition] = useState<NodePosition | null>(null);
  const [dragState, setDragState] = useState<NodeDragState | null>(null);
  const [paletteDrag, setPaletteDrag] = useState<PaletteDragState | null>(null);
  const [palettePointer, setPalettePointer] = useState<NodePosition | null>(null);
  const [run, setRun] = useState<DeviceReplayFlowRun | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [inputModalOpen, setInputModalOpen] = useState(false);
  const [runtimeInputs, setRuntimeInputs] = useState<Record<string, string>>({});

  const selectedNode = flow?.nodes.find((node) => node.id === selectedNodeId) || null;
  const selectedNodeRun = selectedNode ? runNodeFor(run, selectedNode.id) : undefined;

  const loadTemplate = useCallback(async () => {
    if (initialFlow) {
      const nextFlow = JSON.parse(JSON.stringify(initialFlow)) as DeviceReplayFlowDsl;
      setFlow(nextFlow);
      setPositions(autoPositions(nextFlow.nodes));
      setSelectedNodeId(nextFlow.nodes[0]?.id || '');
      setValidation(initialValidation);
      setRun(null);
      const defaults = Object.fromEntries(Object.entries(nextFlow.inputs || {}).map(([name, definition]) => [name, definition.default || '']));
      setRuntimeInputs(defaults);
      return;
    }
    if (!recording) return;
    setLoading(true);
    setValidation(null);
    setRun(null);
    try {
      const response = await deviceControlApi.replayFlowTemplate(recording.id);
      if (!response.success || !response.data?.flow) throw new Error(response.error || '生成流程模板失败');
      setFlow(response.data.flow);
      setPositions(autoPositions(response.data.flow.nodes));
      setSelectedNodeId(response.data.flow.nodes[0]?.id || '');
      setValidation(response.data.validation);
      const defaults = Object.fromEntries(Object.entries(response.data.flow.inputs || {}).map(([name, definition]) => [name, definition.default || '']));
      setRuntimeInputs(defaults);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [initialFlow, initialValidation, recording]);

  useEffect(() => {
    if (open) void loadTemplate();
  }, [open, loadTemplate]);

  useEffect(() => {
    if (flow) onFlowChange?.(flow);
  }, [flow, onFlowChange]);

  useEffect(() => {
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const response = await deviceControlApi.getReplayFlowRun(run.id);
        if (response.success && response.data?.run) setRun(response.data.run);
      } catch {
        // 下一轮继续查询，避免一次网络抖动中断调试视图。
      }
    }, 800);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status]);

  useEffect(() => {
    if (!run || run.status === 'queued' || run.status === 'running') return;
    setRunBusy(false);
  }, [run?.status]);

  const updateNode = useCallback((nodeId: string, patch: Partial<DeviceReplayFlowNode>) => {
    if (readOnly) return;
    setFlow((current) => current ? {
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node),
    } : current);
    setValidation(null);
  }, [readOnly]);

  const updateTarget = useCallback((patch: Partial<DeviceReplayFlowTarget>) => {
    if (!selectedNode) return;
    updateNode(selectedNode.id, { target: { ...(selectedNode.target || {}), ...patch } });
  }, [selectedNode, updateNode]);

  const updateCondition = useCallback((condition: DeviceReplayFlowCondition) => {
    if (!selectedNode) return;
    updateNode(selectedNode.id, { condition });
  }, [selectedNode, updateNode]);

  const addNodeAt = useCallback((type: DeviceReplayFlowNodeType, position: NodePosition) => {
    if (readOnly) return;
    const node = newNode(type);
    setFlow((current) => current ? { ...current, nodes: [...current.nodes, node] } : current);
    setPositions((current) => ({ ...current, [node.id]: position }));
    setSelectedNodeId(node.id);
    setValidation(null);
  }, [readOnly]);

  const beginPaletteDrag = (event: ReactPointerEvent<HTMLDivElement>, type: DeviceReplayFlowNodeType) => {
    if (readOnly) return;
    event.preventDefault();
    setPaletteDrag({ type, pointerId: event.pointerId });
    setPalettePointer({ x: event.clientX, y: event.clientY });
  };

  useEffect(() => {
    if (!paletteDrag) return undefined;
    const move = (event: PointerEvent) => {
      if (event.pointerId === paletteDrag.pointerId) setPalettePointer({ x: event.clientX, y: event.clientY });
    };
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== paletteDrag.pointerId) return;
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const insideCanvas = event.clientX >= rect.left
          && event.clientX <= rect.right
          && event.clientY >= rect.top
          && event.clientY <= rect.bottom;
        if (insideCanvas) {
          addNodeAt(paletteDrag.type, {
            x: Math.max(10, event.clientX - rect.left + canvas.scrollLeft - (NODE_WIDTH / 2)),
            y: Math.max(10, event.clientY - rect.top + canvas.scrollTop - 30),
          });
        }
      }
      setPaletteDrag(null);
      setPalettePointer(null);
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId !== paletteDrag.pointerId) return;
      setPaletteDrag(null);
      setPalettePointer(null);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', cancel, true);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', cancel, true);
    };
  }, [addNodeAt, paletteDrag]);

  const deleteSelected = useCallback(() => {
    if (readOnly || !flow || !selectedNode || selectedNode.type === 'start') return;
    const deletedId = selectedNode.id;
    const referenceFields = ['next', 'onFailure', 'onSuccess', 'onTimeout', 'onError', 'onTrue', 'onFalse', 'onPassed', 'onFailed'];
    setFlow({
      ...flow,
      nodes: flow.nodes
        .filter((node) => node.id !== deletedId)
        .map((node) => {
          const clone = { ...node } as DeviceReplayFlowNode & Record<string, unknown>;
          referenceFields.forEach((field) => {
            if (clone[field] === deletedId) delete clone[field];
          });
          return clone;
        }),
    });
    setPositions((current) => {
      const next = { ...current };
      delete next[deletedId];
      return next;
    });
    setSelectedNodeId(flow.nodes.find((node) => node.id !== deletedId)?.id || '');
    setValidation(null);
  }, [flow, readOnly, selectedNode]);

  const validateFlow = useCallback(async () => {
    if (!flow) return null;
    setValidating(true);
    try {
      const response = await deviceControlApi.validateReplayFlow(flow);
      if (!response.success || !response.data?.validation) throw new Error(response.error || '流程校验失败');
      setValidation(response.data.validation);
      if (response.data.validation.valid) message.success('流程校验通过');
      else message.error(`流程存在 ${response.data.validation.errors.length} 个错误`);
      return response.data.validation;
    } catch (error) {
      message.error(errorMessage(error));
      return null;
    } finally {
      setValidating(false);
    }
  }, [flow]);

  const startValidatedFlow = useCallback(async () => {
    if (!flow) return;
    setRunBusy(true);
    try {
      const response = await deviceControlApi.startReplayFlow(flow, runtimeInputs);
      if (!response.success || !response.data?.run) throw new Error(response.error || '启动流程失败');
      setRun(response.data.run);
      setInputModalOpen(false);
      message.success('流程已进入执行队列');
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setRunBusy(false);
    }
  }, [flow, runtimeInputs]);

  const executeFlow = useCallback(async () => {
    if (!flow) return;
    if (!connected) {
      message.warning('请先连接真机操作台');
      return;
    }
    const result = await validateFlow();
    if (!result?.valid) return;
    const missing = Object.entries(flow.inputs || {}).filter(([name, definition]) => definition.required && !runtimeInputs[name]?.trim());
    if (missing.length) {
      setInputModalOpen(true);
      return;
    }
    await startValidatedFlow();
  }, [connected, flow, runtimeInputs, startValidatedFlow, validateFlow]);

  const confirmRuntimeInputs = useCallback(async () => {
    const missingNames = Object.entries(flow?.inputs || {})
      .filter(([name, definition]) => definition.required && !runtimeInputs[name]?.trim())
      .map(([name]) => name);
    if (missingNames.length) {
      message.warning(`请填写必填参数：${missingNames.join('、')}`);
      return;
    }
    await startValidatedFlow();
  }, [flow?.inputs, runtimeInputs, startValidatedFlow]);

  const stopRun = useCallback(async () => {
    if (!run) return;
    try {
      const response = await deviceControlApi.stopReplayFlowRun(run.id);
      if (!response.success || !response.data?.run) throw new Error(response.error || '终止流程失败');
      setRun(response.data.run);
      message.info('已请求终止流程');
    } catch (error) {
      message.error(errorMessage(error));
    }
  }, [run]);

  const connectNodes = useCallback((targetNodeId: string) => {
    if (!connection || connection.nodeId === targetNodeId) return;
    updateNode(connection.nodeId, { [connection.field]: targetNodeId } as Partial<DeviceReplayFlowNode>);
    setConnection(null);
    setPointerPosition(null);
  }, [connection, updateNode]);

  const nodeOptions = useMemo(() => (flow?.nodes || []).map((node) => ({
    value: node.id,
    label: `${node.name || NODE_META[node.type].title} · ${node.id}`,
  })), [flow?.nodes]);

  const canvasEdges = useMemo(() => {
    if (!flow) return [];
    const byId = new Map(flow.nodes.map((node) => [node.id, node]));
    return flow.nodes.flatMap((node) => edgeFields(node).flatMap((edge, edgeIndex) => {
      const targetId = String((node as unknown as Record<string, unknown>)[edge.field] || '');
      if (!targetId || !byId.has(targetId)) return [];
      const source = positions[node.id];
      const target = positions[targetId];
      if (!source || !target) return [];
      return [{
        id: `${node.id}-${edge.field}-${targetId}`,
        label: edge.label,
        source: { x: source.x + NODE_WIDTH, y: source.y + 58 + (edgeIndex * 20) },
        target: { x: target.x, y: target.y + NODE_HEADER_HEIGHT + 18 },
      }];
    }));
  }, [flow, positions]);

  const handleCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!connection || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    setPointerPosition({ x: event.clientX - rect.left + canvasRef.current.scrollLeft, y: event.clientY - rect.top + canvasRef.current.scrollTop });
  };

  const beginNodeDrag = (event: ReactPointerEvent<HTMLDivElement>, nodeId: string) => {
    if (readOnly || connection) return;
    const position = positions[nodeId] || { x: 0, y: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragState({
      nodeId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: position.x,
      startY: position.y,
    });
  };

  const moveNode = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    setPositions((current) => ({
      ...current,
      [dragState.nodeId]: {
        x: Math.max(10, dragState.startX + event.clientX - dragState.startClientX),
        y: Math.max(10, dragState.startY + event.clientY - dragState.startClientY),
      },
    }));
  };

  const finishNodeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragState?.pointerId === event.pointerId) setDragState(null);
  };

  const renderTargetEditor = () => {
    if (!selectedNode || (selectedNode.type !== 'tap' && selectedNode.type !== 'input')) return null;
    const target = selectedNode.target || {};
    return (
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Text strong>目标定位</Text>
        <Input value={target.accessibilityId} placeholder="accessibilityId" onChange={(event) => updateTarget({ accessibilityId: event.target.value || undefined })} />
        <Input value={target.label} placeholder="label / 目标文本" onChange={(event) => updateTarget({ label: event.target.value || undefined })} />
        <Input value={target.text} placeholder="text" onChange={(event) => updateTarget({ text: event.target.value || undefined })} />
        <Space.Compact style={{ width: '100%' }}>
          <InputNumber style={{ width: '50%' }} min={0} max={1} step={0.01} value={target.coordinate?.x} placeholder="归一化 X" onChange={(value) => updateTarget({ coordinate: { x: Number(value ?? 0.5), y: target.coordinate?.y ?? 0.5 } })} />
          <InputNumber style={{ width: '50%' }} min={0} max={1} step={0.01} value={target.coordinate?.y} placeholder="归一化 Y" onChange={(value) => updateTarget({ coordinate: { x: target.coordinate?.x ?? 0.5, y: Number(value ?? 0.5) } })} />
        </Space.Compact>
        {selectedNode.type === 'input' && (
          <Input value={selectedNode.value} placeholder="输入内容，例如 ${INPUT}" onChange={(event) => updateNode(selectedNode.id, { value: event.target.value })} />
        )}
      </Space>
    );
  };

  const renderConditionEditor = () => {
    if (!selectedNode || !['wait', 'condition', 'assertion'].includes(selectedNode.type)) return null;
    const condition = selectedNode.condition || defaultCondition('element');
    const kind = conditionKind(condition);
    if (kind === 'all' || kind === 'any' || kind === 'not') {
      return <Alert type="info" showIcon message="组合条件已保留" description="首版画布不拆解组合条件，可继续连线和执行；阶段 4 低代码编辑器将负责精确编辑。" />;
    }
    const simpleCondition = condition as SimpleReplayCondition;
    return (
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Text strong>条件</Text>
        <Select
          value={kind}
          style={{ width: '100%' }}
          onChange={(value) => updateCondition(defaultCondition(value))}
          options={[
            ['element', '元素'], ['text', '文本'], ['keyboard', '键盘'], ['app', 'App'],
            ['delay', '固定等待'], ['page_stable', '页面稳定'], ['snapshot_similarity', '快照相似'],
          ].map(([value, label]) => ({ value, label }))}
        />
        {simpleCondition.kind === 'element' && (
          <>
            <Select value={simpleCondition.operator} style={{ width: '100%' }} onChange={(operator) => updateCondition({ ...simpleCondition, operator })} options={['exists', 'not_exists', 'visible', 'not_visible', 'enabled', 'disabled'].map((value) => ({ value, label: value }))} />
            <Input value={simpleCondition.target.accessibilityId || simpleCondition.target.label || simpleCondition.target.text} placeholder="目标 accessibilityId / label" onChange={(event) => updateCondition({ ...simpleCondition, target: { ...simpleCondition.target, label: event.target.value, accessibilityId: undefined } })} />
          </>
        )}
        {simpleCondition.kind === 'text' && (
          <>
            <Select value={simpleCondition.operator} style={{ width: '100%' }} onChange={(operator) => updateCondition({ ...simpleCondition, operator })} options={['equals', 'contains', 'not_contains'].map((value) => ({ value, label: value }))} />
            <Input value={simpleCondition.target.accessibilityId || simpleCondition.target.label || simpleCondition.target.text} placeholder="目标 accessibilityId / label" onChange={(event) => updateCondition({ ...simpleCondition, target: { ...simpleCondition.target, label: event.target.value, accessibilityId: undefined } })} />
            <Input value={simpleCondition.value} placeholder="期望文本" onChange={(event) => updateCondition({ ...simpleCondition, value: event.target.value })} />
          </>
        )}
        {simpleCondition.kind === 'keyboard' && <Select value={simpleCondition.operator} style={{ width: '100%' }} onChange={(operator) => updateCondition({ ...simpleCondition, operator })} options={['visible', 'hidden'].map((value) => ({ value, label: value }))} />}
        {simpleCondition.kind === 'app' && <Select value={simpleCondition.operator} style={{ width: '100%' }} onChange={(operator) => updateCondition({ ...simpleCondition, operator })} options={['foreground', 'background'].map((value) => ({ value, label: value }))} />}
        {(simpleCondition.kind === 'delay' || simpleCondition.kind === 'page_stable') && <InputNumber min={100} max={60000} style={{ width: '100%' }} value={simpleCondition.durationMs} addonAfter="ms" onChange={(value) => updateCondition({ ...simpleCondition, durationMs: Number(value || 800) })} />}
        {simpleCondition.kind === 'snapshot_similarity' && (
          <>
            <Input value={simpleCondition.snapshotId} placeholder="录制 snapshotId" onChange={(event) => updateCondition({ ...simpleCondition, snapshotId: event.target.value })} />
            <InputNumber min={0} max={1} step={0.01} style={{ width: '100%' }} value={simpleCondition.threshold} addonAfter="阈值" onChange={(value) => updateCondition({ ...simpleCondition, threshold: Number(value ?? 0.72) })} />
          </>
        )}
      </Space>
    );
  };

  const renderNodeEditor = () => {
    if (!selectedNode) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一个节点进行配置" />;
    const edges = edgeFields(selectedNode);
    return (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Text type="secondary">节点 ID</Text>
          <Input value={selectedNode.id} disabled />
        </div>
        <Input value={selectedNode.name} placeholder="节点名称" onChange={(event) => updateNode(selectedNode.id, { name: event.target.value })} />
        {selectedNode.type !== 'start' && selectedNode.type !== 'end' && (
          <InputNumber min={100} max={600000} style={{ width: '100%' }} value={selectedNode.timeoutMs} addonAfter="ms 超时" onChange={(value) => updateNode(selectedNode.id, { timeoutMs: Number(value || 15000) })} />
        )}
        {renderTargetEditor()}
        {selectedNode.type === 'swipe' && (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Text strong>滑动路径（归一化坐标）</Text>
            <Space.Compact style={{ width: '100%' }}>
              <InputNumber min={0} max={1} step={0.01} style={{ width: '50%' }} value={selectedNode.start?.x} addonBefore="起 X" onChange={(value) => updateNode(selectedNode.id, { start: { x: Number(value ?? 0.5), y: selectedNode.start?.y ?? 0.8 } })} />
              <InputNumber min={0} max={1} step={0.01} style={{ width: '50%' }} value={selectedNode.start?.y} addonBefore="起 Y" onChange={(value) => updateNode(selectedNode.id, { start: { x: selectedNode.start?.x ?? 0.5, y: Number(value ?? 0.8) } })} />
            </Space.Compact>
            <Space.Compact style={{ width: '100%' }}>
              <InputNumber min={0} max={1} step={0.01} style={{ width: '50%' }} value={selectedNode.end?.x} addonBefore="终 X" onChange={(value) => updateNode(selectedNode.id, { end: { x: Number(value ?? 0.5), y: selectedNode.end?.y ?? 0.2 } })} />
              <InputNumber min={0} max={1} step={0.01} style={{ width: '50%' }} value={selectedNode.end?.y} addonBefore="终 Y" onChange={(value) => updateNode(selectedNode.id, { end: { x: selectedNode.end?.x ?? 0.5, y: Number(value ?? 0.2) } })} />
            </Space.Compact>
          </Space>
        )}
        {selectedNode.type === 'keyboard' && <Select value={selectedNode.key} style={{ width: '100%' }} onChange={(key) => updateNode(selectedNode.id, { key })} options={['Search', 'Return', 'Done', 'Dismiss'].map((value) => ({ value, label: value }))} />}
        {renderConditionEditor()}
        {selectedNode.type === 'end' && (
          <>
            <Select value={selectedNode.result} style={{ width: '100%' }} onChange={(result) => updateNode(selectedNode.id, { result })} options={[{ value: 'success', label: 'Success End' }, { value: 'failure', label: 'Failure End' }]} />
            <Input value={selectedNode.message} placeholder="结束消息" onChange={(event) => updateNode(selectedNode.id, { message: event.target.value })} />
          </>
        )}
        {edges.length > 0 && (
          <>
            <Divider plain>分支目标</Divider>
            {edges.map((edge) => (
              <div key={edge.field}>
                <Text type="secondary">{edge.label}</Text>
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  value={String((selectedNode as unknown as Record<string, unknown>)[edge.field] || '') || undefined}
                  style={{ width: '100%' }}
                  options={nodeOptions.filter((option) => option.value !== selectedNode.id)}
                  onChange={(value) => updateNode(selectedNode.id, { [edge.field]: value } as Partial<DeviceReplayFlowNode>)}
                />
              </div>
            ))}
          </>
        )}
        <Button danger icon={<DeleteOutlined />} disabled={selectedNode.type === 'start'} onClick={deleteSelected}>删除节点</Button>
        {selectedNodeRun && (
          <>
            <Divider plain>最近运行证据</Divider>
            <Alert
              type={selectedNodeRun.status === 'succeeded' ? 'success' : selectedNodeRun.status === 'running' ? 'info' : 'error'}
              showIcon
              message={`${selectedNodeRun.status} · ${selectedNodeRun.outcome || '-'}`}
              description={selectedNodeRun.error || (selectedNodeRun.condition ? `条件：${String(selectedNodeRun.condition.actual)} / ${String(selectedNodeRun.condition.expected)}` : undefined)}
            />
            <div className="replay-flow-evidence-grid">
              {selectedNodeRun.evidence.map((evidence) => (
                <Card key={evidence.id} size="small" title={evidence.phase === 'before' ? '执行前' : '执行后'}>
                  {evidence.screenshotUrl && <Image src={evidence.screenshotUrl} alt={`${selectedNode.id}-${evidence.phase}`} />}
                  {evidence.sourceUrl && <a href={evidence.sourceUrl} target="_blank" rel="noreferrer">查看 WDA Source</a>}
                  {evidence.captureError && <Text type="danger">{evidence.captureError}</Text>}
                </Card>
              ))}
            </div>
          </>
        )}
      </Space>
    );
  };

  return (
    <>
      <Drawer
        open={open}
        width="100%"
        placement="right"
        destroyOnClose
        onClose={onClose}
        title={(
          <Space>
            <BranchesOutlined />
            <span>{title}</span>
            {flow && <Tag>{flow.name}</Tag>}
          </Space>
        )}
        extra={(
          <Space wrap>
            {headerExtra}
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => void (onReload ? onReload() : loadTemplate())}
            >
              {resetLabel || (initialFlow ? '重新载入草稿' : '从录制重置')}
            </Button>
            <Button icon={<CheckCircleOutlined />} loading={validating} onClick={() => void validateFlow()}>校验流程</Button>
            {showRunControls && (run && (run.status === 'queued' || run.status === 'running') ? (
              <Button danger icon={<StopOutlined />} onClick={() => void stopRun()}>终止运行</Button>
            ) : (
              <Button type="primary" icon={<PlayCircleOutlined />} loading={runBusy} disabled={!connected} onClick={() => void executeFlow()}>真机调试</Button>
            ))}
          </Space>
        )}
      >
        {workspaceHeader && <div className="replay-flow-workspace-header">{workspaceHeader}</div>}
        {loading || !flow ? <div className="replay-flow-loading"><Spin size="large" /></div> : (
          <div className={`replay-flow-designer${workspaceHeader ? ' has-workspace-header' : ''}`}>
            <aside className="replay-flow-palette">
              <Title level={5}>节点库</Title>
              <Paragraph type="secondary">拖到中间画布创建节点。</Paragraph>
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                {PALETTE_TYPES.map((type) => (
                  <div
                    key={type}
                    className={`replay-flow-palette-item${paletteDrag?.type === type ? ' is-dragging' : ''}${readOnly ? ' is-disabled' : ''}`}
                    style={{ borderLeftColor: NODE_META[type].color }}
                    onPointerDown={(event) => beginPaletteDrag(event, type)}
                  >
                    <DragOutlined />
                    <span>{NODE_META[type].title}</span>
                  </div>
                ))}
              </Space>
              <Divider />
              <Title level={5}>流程</Title>
              <Input
                disabled={readOnly}
                value={flow.name}
                placeholder="流程名称"
                onChange={(event) => { setFlow({ ...flow, name: event.target.value }); setValidation(null); }}
              />
              <Input.TextArea
                disabled={readOnly}
                value={flow.description}
                placeholder="流程描述"
                autoSize={{ minRows: 2, maxRows: 4 }}
                style={{ marginTop: 8 }}
                onChange={(event) => { setFlow({ ...flow, description: event.target.value }); setValidation(null); }}
              />
              {validation && (
                <Alert
                  className="replay-flow-validation"
                  type={validation.valid ? 'success' : 'error'}
                  showIcon
                  message={validation.valid ? '校验通过' : `${validation.errors.length} 个错误`}
                  description={(
                    <div>
                      {validation.errors.slice(0, 5).map((item) => <div key={`${item.code}-${item.path}`}>{item.nodeId ? `${item.nodeId}: ` : ''}{item.message}</div>)}
                      {validation.warnings.slice(0, 3).map((item) => <div key={`${item.code}-${item.path}`}><Text type="warning">{item.message}</Text></div>)}
                    </div>
                  )}
                />
              )}
              {run && (
                <Alert
                  className="replay-flow-validation"
                  type={run.status === 'succeeded' ? 'success' : run.status === 'failed' || run.status === 'cancelled' ? 'error' : 'info'}
                  showIcon
                  message={`运行：${run.status}`}
                  description={run.error || `${run.nodes.length} 个节点已有结果`}
                />
              )}
            </aside>

            <main
              ref={canvasRef}
              className={`replay-flow-canvas${connection ? ' is-connecting' : ''}`}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={() => { setConnection(null); setPointerPosition(null); }}
            >
              <div className="replay-flow-canvas-surface">
                <svg className="replay-flow-edges" width="1800" height="1200">
                  {canvasEdges.map((edge) => {
                    const middle = Math.max(60, Math.abs(edge.target.x - edge.source.x) / 2);
                    return (
                      <g key={edge.id}>
                        <path d={`M ${edge.source.x} ${edge.source.y} C ${edge.source.x + middle} ${edge.source.y}, ${edge.target.x - middle} ${edge.target.y}, ${edge.target.x} ${edge.target.y}`} />
                        <text
                          x={edge.source.x + (edge.target.x >= edge.source.x ? 38 : -38)}
                          y={edge.source.y - 6}
                        >
                          {edge.label}
                        </text>
                      </g>
                    );
                  })}
                  {connection && pointerPosition && positions[connection.nodeId] && (() => {
                    const node = flow.nodes.find((item) => item.id === connection.nodeId)!;
                    const edgeIndex = edgeFields(node).findIndex((edge) => edge.field === connection.field);
                    const source = { x: positions[node.id].x + NODE_WIDTH, y: positions[node.id].y + 58 + (Math.max(edgeIndex, 0) * 20) };
                    return <path className="is-draft" d={`M ${source.x} ${source.y} C ${source.x + 80} ${source.y}, ${pointerPosition.x - 80} ${pointerPosition.y}, ${pointerPosition.x} ${pointerPosition.y}`} />;
                  })()}
                </svg>
                {flow.nodes.map((node) => {
                  const position = positions[node.id] || { x: 20, y: 20 };
                  const meta = NODE_META[node.type];
                  const edges = edgeFields(node);
                  const nodeRun = runNodeFor(run, node.id);
                  const active = run?.currentNodeId === node.id || nodeRun?.status === 'running';
                  return (
                    <div
                      key={node.id}
                      className={`replay-flow-node${selectedNodeId === node.id ? ' is-selected' : ''}${active ? ' is-running' : ''}${nodeRun ? ` is-${nodeRun.status}` : ''}`}
                      style={{ left: position.x, top: position.y, borderTopColor: meta.color }}
                      onClick={() => setSelectedNodeId(node.id)}
                      onPointerUp={(event) => {
                        event.stopPropagation();
                        if (connection) connectNodes(node.id);
                      }}
                    >
                      <div
                        className="replay-flow-node-header"
                        onPointerDown={(event) => beginNodeDrag(event, node.id)}
                        onPointerMove={moveNode}
                        onPointerUp={finishNodeDrag}
                        onPointerCancel={finishNodeDrag}
                      >
                        <span className="replay-flow-node-icon" style={{ background: meta.color }}>{node.type === 'condition' ? <BranchesOutlined /> : <AimOutlined />}</span>
                        <div>
                          <Text strong>{node.name || meta.title}</Text>
                          <Text type="secondary">{meta.title}</Text>
                        </div>
                        {nodeRun?.status === 'succeeded' && <CheckCircleOutlined className="is-success" />}
                        {(nodeRun?.status === 'failed' || nodeRun?.status === 'cancelled') && <CloseCircleOutlined className="is-error" />}
                      </div>
                      <div className="replay-flow-node-body">{nodeSummary(node)}</div>
                      <span className="replay-flow-target-port" title="分支连接目标" />
                      <div className="replay-flow-output-ports">
                        {edges.map((edge) => (
                          <Tooltip key={edge.field} title={`拖动连接 ${edge.label} 分支`} placement="right">
                            <button
                              type="button"
                              className="replay-flow-output-port"
                              onPointerDown={(event) => {
                                event.stopPropagation();
                                setConnection({ nodeId: node.id, field: edge.field });
                              }}
                            >
                              <span>{edge.label}</span>
                              <i />
                            </button>
                          </Tooltip>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {!flow.nodes.length && <Empty description="从左侧拖入节点" />}
              </div>
            </main>

            <aside className="replay-flow-inspector">
              <Title level={5}>节点属性</Title>
              {renderNodeEditor()}
            </aside>
          </div>
        )}
      </Drawer>

      {paletteDrag && palettePointer && (
        <div
          className="replay-flow-palette-drag-preview"
          style={{ left: palettePointer.x + 14, top: palettePointer.y + 14, borderLeftColor: NODE_META[paletteDrag.type].color }}
        >
          <DragOutlined />
          <span>{NODE_META[paletteDrag.type].title}</span>
        </div>
      )}

      <Modal
        open={inputModalOpen}
        title="设置本次流程参数"
        okText="开始真机调试"
        confirmLoading={runBusy}
        onCancel={() => setInputModalOpen(false)}
        onOk={() => void confirmRuntimeInputs()}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {Object.entries(flow?.inputs || {}).map(([name, definition]) => (
            <div key={name}>
              <Text strong>{name}{definition.required ? ' *' : ''}</Text>
              <Input
                value={runtimeInputs[name]}
                placeholder={definition.description || `输入 ${name}`}
                onChange={(event) => setRuntimeInputs((current) => ({ ...current, [name]: event.target.value }))}
              />
            </div>
          ))}
        </Space>
      </Modal>
    </>
  );
}
