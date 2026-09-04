import {
  ApiOutlined,
  BranchesOutlined,
  DisconnectOutlined,
  EyeOutlined,
  FullscreenOutlined,
  MobileOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SendOutlined,
  StopOutlined,
  VideoCameraAddOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Empty,
  Input,
  List,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Steps,
  Tag,
  Typography,
  message,
} from 'antd';
import { PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DeviceControlDevice,
  DeviceControlStatus,
  DeviceRecording,
  DeviceRecordingObservation,
  DeviceRecordingStep,
  ReplayFlowSourcePreview,
  deviceControlApi,
} from '../services/api';
import {
  ContainedImageViewport,
  containedImageViewport,
  normalizedPointInContainedImage,
} from '../utils/containedImageCoordinates';
import './DeviceConsolePage.css';

const { Paragraph, Text, Title } = Typography;

interface PointerStart {
  point: { x: number; y: number };
  clientX: number;
  clientY: number;
  startedAt: number;
}

interface ActionLog {
  id: number;
  text: string;
  time: string;
}

interface TouchMarker {
  id: number;
  left: number;
  top: number;
}

interface NormalizedAnnotationPoint {
  x: number;
  y: number;
}

function errorMessage(error: unknown) {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'error' in error) return String((error as { error?: unknown }).error || '操作失败');
  if (error instanceof Error) return error.message;
  return '操作失败';
}

function phaseTag(phase: DeviceControlStatus['phase']) {
  const map = {
    idle: { color: 'default', text: '未连接' },
    starting: { color: 'processing', text: 'WDA 启动中' },
    connected: { color: 'success', text: '已连接' },
    error: { color: 'error', text: '连接失败' },
  } as const;
  const value = map[phase];
  return <Tag color={value.color}>{value.text}</Tag>;
}

function frameFingerprint(image: HTMLImageElement) {
  if (!image.naturalWidth || !image.naturalHeight) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 24;
  canvas.height = 48;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const fingerprint = new Uint8Array(canvas.width * canvas.height);
    for (let sourceIndex = 0, targetIndex = 0; sourceIndex < pixels.length; sourceIndex += 4, targetIndex += 1) {
      fingerprint[targetIndex] = Math.round((pixels[sourceIndex] * 0.299) + (pixels[sourceIndex + 1] * 0.587) + (pixels[sourceIndex + 2] * 0.114));
    }
    return fingerprint;
  } catch {
    return null;
  }
}

function frameDifference(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length || !left.length) return 1;
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index] - right[index]);
  return total / (left.length * 255);
}

function stepTargetSummary(step: DeviceRecordingStep) {
  const target = step.action.target || step.action.startTarget;
  if (!target) return step.action.type === 'input'
    ? '未识别聚焦输入框，回放时依赖前一步保持焦点'
    : '未命中稳定元素，将使用归一化坐标回放';
  const identity = target.name || target.label || target.placeholder || target.type;
  const contextLabel = target.contextLabels?.find((label) => label !== identity);
  const name = contextLabel ? `${contextLabel} (${identity})` : identity;
  const relative = `控件内 ${Math.round(target.relativePoint.x * 100)}%, ${Math.round(target.relativePoint.y * 100)}%`;
  const bestLocator = target.locators[0];
  if (step.action.type === 'input') return `${name} · 当前输入焦点${bestLocator ? ` · ${bestLocator.strategy}` : ''}`;
  return `${name} · ${relative}${bestLocator ? ` · ${bestLocator.strategy}` : ''}`;
}

interface DeviceConsolePageProps {
  mode?: 'debug' | 'replay-create';
}

export default function DeviceConsolePage({ mode = 'debug' }: DeviceConsolePageProps) {
  const navigate = useNavigate();
  const isReplayCreate = mode === 'replay-create';
  const [devices, setDevices] = useState<DeviceControlDevice[]>([]);
  const [selectedUdid, setSelectedUdid] = useState('');
  const [status, setStatus] = useState<DeviceControlStatus>({ phase: 'idle' });
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [queuedActionCount, setQueuedActionCount] = useState(0);
  const [streamVersion, setStreamVersion] = useState(0);
  const [streamReady, setStreamReady] = useState(false);
  const [streamError, setStreamError] = useState('');
  const [screenExpanded, setScreenExpanded] = useState(false);
  const [touchMarker, setTouchMarker] = useState<TouchMarker | null>(null);
  const [inputText, setInputText] = useState('');
  const [sourceVisible, setSourceVisible] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [source, setSource] = useState('');
  const [actions, setActions] = useState<ActionLog[]>([]);
  const [recording, setRecording] = useState<DeviceRecording | null>(null);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [onlySelectedSteps, setOnlySelectedSteps] = useState(false);
  const [evidenceStep, setEvidenceStep] = useState<DeviceRecordingStep | null>(null);
  const [evidenceObservation, setEvidenceObservation] = useState<DeviceRecordingObservation | null>(null);
  const [annotationMode, setAnnotationMode] = useState<'tap' | 'swipe' | 'input'>('tap');
  const [annotationStart, setAnnotationStart] = useState<NormalizedAnnotationPoint | null>(null);
  const [annotationEnd, setAnnotationEnd] = useState<NormalizedAnnotationPoint | null>(null);
  const [annotationViewport, setAnnotationViewport] = useState<ContainedImageViewport | null>(null);
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayInputVisible, setReplayInputVisible] = useState(false);
  const [replayInputValue, setReplayInputValue] = useState('');
  const [saveFlowBusy, setSaveFlowBusy] = useState(false);
  const [orchestrationPreview, setOrchestrationPreview] = useState<ReplayFlowSourcePreview | null>(null);
  const [orchestrationPreviewOpen, setOrchestrationPreviewOpen] = useState(false);
  const pointerStart = useRef<PointerStart | null>(null);
  const screenImageRef = useRef<HTMLImageElement | null>(null);
  const annotationImageRef = useRef<HTMLImageElement | null>(null);
  const recordingListRef = useRef<HTMLDivElement | null>(null);
  const lastFrameRef = useRef<Uint8Array | null>(null);
  const pendingVisualChangeRef = useRef(false);
  const lastVisualChangeAtRef = useRef(0);
  const observingChangeRef = useRef(false);
  const suppressObservationUntilRef = useRef(0);
  const actionQueueRef = useRef<Promise<void>>(Promise.resolve());

  const connected = status.phase === 'connected';
  const isRecording = recording?.status === 'recording';
  const selectedDevice = useMemo(
    () => devices.find((device) => device.udid === selectedUdid),
    [devices, selectedUdid],
  );

  const addAction = useCallback((text: string) => {
    setActions((current) => [{ id: Date.now() + Math.random(), text, time: new Date().toLocaleTimeString() }, ...current].slice(0, 30));
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const response = await deviceControlApi.status();
      if (response.data) {
        setStatus(response.data);
        if (response.data.device?.udid) setSelectedUdid(response.data.device.udid);
      }
    } catch (error) {
      message.error(errorMessage(error));
    }
  }, []);

  const loadDevices = useCallback(async () => {
    setLoadingDevices(true);
    try {
      const response = await deviceControlApi.listDevices();
      const nextDevices = response.data?.devices || [];
      setDevices(nextDevices);
      setSelectedUdid((current) => current || nextDevices.find((device) => device.connected)?.udid || nextDevices[0]?.udid || '');
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoadingDevices(false);
    }
  }, []);

  const loadCurrentRecording = useCallback(async () => {
    try {
      const response = await deviceControlApi.currentRecording();
      if (response.data?.recording) {
        setRecording(response.data.recording);
        return;
      }
      const latest = await deviceControlApi.latestRecording();
      setRecording(latest.data?.recording || null);
    } catch (error) {
      message.error(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void Promise.all([loadDevices(), loadStatus(), loadCurrentRecording()]);
  }, [loadCurrentRecording, loadDevices, loadStatus]);

  useEffect(() => {
    if (!connected) {
      setStreamReady(false);
      return undefined;
    }
    setStreamVersion(Date.now());
    if (status.streamAvailable) return undefined;
    const timer = window.setInterval(() => setStreamVersion(Date.now()), 450);
    return () => window.clearInterval(timer);
  }, [connected, status.streamAvailable]);

  useEffect(() => {
    if (!connected) return undefined;
    const timer = window.setInterval(() => { void loadStatus(); }, 3000);
    return () => window.clearInterval(timer);
  }, [connected, loadStatus]);

  useEffect(() => {
    if (!isRecording || !recording?.id) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const response = await deviceControlApi.getRecording(recording.id);
        if (response.data) setRecording(response.data);
      } catch {
        // 轮询失败不打断操作台，下一轮继续同步。
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [isRecording, recording?.id]);

  useEffect(() => {
    if (!isRecording || !connected || !streamReady) {
      lastFrameRef.current = null;
      pendingVisualChangeRef.current = false;
      return undefined;
    }
    const timer = window.setInterval(() => {
      const image = screenImageRef.current;
      if (!image) return;
      const current = frameFingerprint(image);
      if (!current) return;
      const previous = lastFrameRef.current;
      lastFrameRef.current = current;
      if (!previous) return;
      if (Date.now() < suppressObservationUntilRef.current) {
        pendingVisualChangeRef.current = false;
        return;
      }
      const difference = frameDifference(previous, current);
      if (difference > 0.008) {
        pendingVisualChangeRef.current = true;
        lastVisualChangeAtRef.current = Date.now();
        return;
      }
      if (
        pendingVisualChangeRef.current
        && Date.now() - lastVisualChangeAtRef.current > 480
        && !observingChangeRef.current
      ) {
        pendingVisualChangeRef.current = false;
        observingChangeRef.current = true;
        void deviceControlApi.observeRecordingChange()
          .then((response) => {
            if (response.data) setRecording(response.data);
          })
          .catch(() => {
            // 页面可能仍在变化，交给下一次稳定画面重新触发。
          })
          .finally(() => {
            observingChangeRef.current = false;
          });
      }
    }, 220);
    return () => window.clearInterval(timer);
  }, [connected, isRecording, streamReady]);

  useEffect(() => {
    const container = recordingListRef.current;
    if (!container) return;
    window.requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
  }, [recording?.steps.length]);

  const refreshFallbackSoon = useCallback(() => {
    if (!status.streamAvailable) window.setTimeout(() => setStreamVersion(Date.now()), 120);
  }, [status.streamAvailable]);

  const enqueueDeviceAction = useCallback((label: string, execute: () => Promise<unknown>) => {
    setQueuedActionCount((current) => current + 1);
    addAction(`${label} · 已排队`);
    const task = actionQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        suppressObservationUntilRef.current = Date.now() + 1800;
        pendingVisualChangeRef.current = false;
        try {
          await execute();
          addAction(`${label} · 已执行`);
          refreshFallbackSoon();
        } catch (error) {
          const text = errorMessage(error);
          addAction(`${label} · 失败：${text}`);
          message.error(text);
          void loadStatus();
        }
      })
      .finally(() => {
        setQueuedActionCount((current) => Math.max(0, current - 1));
      });
    actionQueueRef.current = task;
  }, [addAction, loadStatus, refreshFallbackSoon]);

  const handleConnect = async () => {
    if (!selectedUdid) {
      message.warning('请先选择一台真机');
      return;
    }
    setConnecting(true);
    setStreamError('');
    setStatus((current) => ({ ...current, phase: 'starting', device: selectedDevice || current.device }));
    try {
      const response = await deviceControlApi.connect(selectedUdid);
      if (response.data) setStatus(response.data);
      addAction(`连接设备 ${selectedDevice?.name || selectedUdid}`);
      message.success('真机操作台已连接');
    } catch (error) {
      const text = errorMessage(error);
      setStatus((current) => ({ ...current, phase: 'error', lastError: text }));
      message.error(text);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (isRecording) {
      message.warning('请先停止当前路径录制');
      return;
    }
    setConnecting(true);
    try {
      const response = await deviceControlApi.disconnect();
      setStatus(response.data || { phase: 'idle' });
      setStreamReady(false);
      addAction('断开真机操作台');
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setConnecting(false);
    }
  };

  const pointFromEvent = (event: PointerEvent<HTMLImageElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const windowSize = status.windowSize;
    if (!windowSize || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * windowSize.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * windowSize.height),
    };
  };

  const handlePointerDown = (event: PointerEvent<HTMLImageElement>) => {
    if (!connected) return;
    const windowSize = status.windowSize;
    if (!windowSize) return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const markerId = Date.now();
    setTouchMarker({
      id: markerId,
      left: (point.x / windowSize.width) * 100,
      top: (point.y / windowSize.height) * 100,
    });
    window.setTimeout(() => {
      setTouchMarker((current) => current?.id === markerId ? null : current);
    }, 340);
    pointerStart.current = {
      point,
      clientX: event.clientX,
      clientY: event.clientY,
      startedAt: Date.now(),
    };
  };

  const handlePointerUp = (event: PointerEvent<HTMLImageElement>) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start || !connected) return;
    const end = pointFromEvent(event);
    if (!end) return;
    const distance = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
    if (distance < 12) {
      enqueueDeviceAction(`点击 (${end.x}, ${end.y})`, () => deviceControlApi.tap(end.x, end.y));
    } else {
      const durationMs = Math.min(Math.max(Date.now() - start.startedAt, 150), 1200);
      enqueueDeviceAction(
        `滑动 (${start.point.x}, ${start.point.y}) → (${end.x}, ${end.y})`,
        () => deviceControlApi.swipe({
          startX: start.point.x,
          startY: start.point.y,
          endX: end.x,
          endY: end.y,
          durationMs,
        }),
      );
    }
  };

  const handleSendInput = () => {
    const text = inputText;
    if (!text.trim()) return;
    setInputText('');
    enqueueDeviceAction(`输入文本（${text.length} 字符）`, () => deviceControlApi.input(text));
  };

  const handleReconnectScreen = () => {
    setStreamReady(false);
    setStreamError('');
    setStreamVersion(Date.now());
  };

  const handleOpenSource = async () => {
    setSourceVisible(true);
    setSourceLoading(true);
    try {
      const response = await deviceControlApi.source();
      setSource(response.data?.source || '');
      addAction('抓取 WDA 页面树');
    } catch (error) {
      setSource(errorMessage(error));
    } finally {
      setSourceLoading(false);
    }
  };

  const handleStartRecording = async () => {
    if (!connected) {
      message.warning('请先连接真机操作台');
      return;
    }
    setRecordingBusy(true);
    try {
      const response = await deviceControlApi.startRecording();
      setRecording(response.data || null);
      lastFrameRef.current = null;
      pendingVisualChangeRef.current = false;
      addAction('开始黑盒路径录制');
      message.success('录制已开始，请在平台画面操作；手机直接操作只会标记为外部变化');
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setRecordingBusy(false);
    }
  };

  const handleStopRecording = async () => {
    setRecordingBusy(true);
    try {
      const response = await deviceControlApi.stopRecording();
      if (response.data) setRecording(response.data);
      addAction('停止黑盒路径录制');
      message.success('录制已停止，可继续筛选操作步骤');
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setRecordingBusy(false);
    }
  };

  const handleEnterOrchestration = async () => {
    if (!recording || recording.status !== 'stopped' || recording.selectedCount <= 0) {
      message.warning('请先停止录制，并选择至少一条可回放步骤');
      return;
    }
    setSaveFlowBusy(true);
    try {
      const response = await deviceControlApi.recordingOrchestrationPreview(recording.id);
      if (!response.data?.preview) throw new Error('无法生成录制来源预览');
      setOrchestrationPreview(response.data.preview);
      setOrchestrationPreviewOpen(true);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSaveFlowBusy(false);
    }
  };

  const handleConfirmOrchestration = async () => {
    if (!recording || !orchestrationPreview) return;
    setSaveFlowBusy(true);
    try {
      const response = await deviceControlApi.createReplayFlowAsset(recording.id, {
        name: `${recording.title || '未命名录制'} 回放流程`,
        description: `来源于录制 ${recording.id}，包含 ${recording.selectedCount} 条已选择步骤。`,
        creationMode: true,
      });
      const asset = response.data?.asset;
      if (!asset?.id) throw new Error('创建回放草稿失败');
      addAction(`生成可恢复草稿：${asset.name}`);
      setOrchestrationPreviewOpen(false);
      navigate(`/cicd/replay/${asset.id}/edit?mode=create`);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSaveFlowBusy(false);
    }
  };

  const handleStepIncluded = async (step: DeviceRecordingStep, included: boolean) => {
    if (!recording) return;
    setRecording((current) => current ? {
      ...current,
      selectedCount: current.selectedCount + (included ? 1 : -1),
      steps: current.steps.map((item) => item.id === step.id ? { ...item, included } : item),
    } : current);
    try {
      const response = await deviceControlApi.updateRecordingStep(recording.id, step.id, included);
      if (response.data) setRecording(response.data);
    } catch (error) {
      message.error(errorMessage(error));
      const response = await deviceControlApi.getRecording(recording.id).catch(() => null);
      if (response?.data) setRecording(response.data);
    }
  };

  const handleObservationIncluded = async (observation: DeviceRecordingObservation, included: boolean) => {
    if (!recording) return;
    setRecording((current) => current ? {
      ...current,
      candidateSelectedCount: current.candidateSelectedCount + (included ? 1 : -1),
      observations: current.observations.map((item) => item.id === observation.id ? { ...item, included } : item),
    } : current);
    try {
      const response = await deviceControlApi.updateRecordingObservation(recording.id, observation.id, included);
      if (response.data) setRecording(response.data);
    } catch (error) {
      message.error(errorMessage(error));
      const response = await deviceControlApi.getRecording(recording.id).catch(() => null);
      if (response?.data) setRecording(response.data);
    }
  };

  const openObservationEvidence = (observation: DeviceRecordingObservation) => {
    setEvidenceObservation(observation);
    setAnnotationMode(observation.suggestedAction === 'input' ? 'input' : 'tap');
    setAnnotationStart(null);
    setAnnotationEnd(null);
    setAnnotationViewport(null);
  };

  const updateAnnotationViewport = useCallback((image: HTMLImageElement) => {
    const imageRect = image.getBoundingClientRect();
    const stageRect = image.parentElement?.getBoundingClientRect();
    const content = containedImageViewport(imageRect.width, imageRect.height, image.naturalWidth, image.naturalHeight);
    const viewport = {
      left: (imageRect.left - (stageRect?.left || imageRect.left)) + content.left,
      top: (imageRect.top - (stageRect?.top || imageRect.top)) + content.top,
      width: content.width,
      height: content.height,
    };
    setAnnotationViewport(viewport);
    return { imageRect, content, viewport };
  }, []);

  const annotationPointFromEvent = (event: PointerEvent<HTMLImageElement>): NormalizedAnnotationPoint => {
    const { imageRect, content } = updateAnnotationViewport(event.currentTarget);
    return normalizedPointInContainedImage({
      x: event.clientX - imageRect.left,
      y: event.clientY - imageRect.top,
    }, content);
  };

  const annotationMarkerStyle = (point: NormalizedAnnotationPoint) => ({
    left: annotationViewport ? annotationViewport.left + (point.x * annotationViewport.width) : `${point.x * 100}%`,
    top: annotationViewport ? annotationViewport.top + (point.y * annotationViewport.height) : `${point.y * 100}%`,
  });

  useEffect(() => {
    const image = annotationImageRef.current;
    if (!evidenceObservation || !image) return undefined;
    const refresh = () => updateAnnotationViewport(image);
    refresh();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refresh);
    observer?.observe(image);
    window.addEventListener('resize', refresh);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', refresh);
    };
  }, [evidenceObservation, updateAnnotationViewport]);

  const handleAnnotationPointerDown = (event: PointerEvent<HTMLImageElement>) => {
    if (annotationMode === 'input') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = annotationPointFromEvent(event);
    setAnnotationStart(point);
    setAnnotationEnd(annotationMode === 'tap' ? point : null);
  };

  const handleAnnotationPointerUp = (event: PointerEvent<HTMLImageElement>) => {
    if (annotationMode === 'input') return;
    const point = annotationPointFromEvent(event);
    if (annotationMode === 'tap') {
      setAnnotationStart(point);
      setAnnotationEnd(point);
    } else {
      setAnnotationEnd(point);
    }
  };

  const handlePromoteObservation = async () => {
    if (!recording || !evidenceObservation) return;
    if (annotationMode === 'tap' && !annotationStart) {
      message.warning('请在变化前截图上点一下实际点击位置');
      return;
    }
    if (annotationMode === 'swipe' && (!annotationStart || !annotationEnd)) {
      message.warning('请在变化前截图上拖出实际滑动路径');
      return;
    }
    setAnnotationBusy(true);
    try {
      const response = await deviceControlApi.promoteRecordingObservation(recording.id, evidenceObservation.id, {
        type: annotationMode,
        point: annotationMode === 'tap' ? annotationStart || undefined : undefined,
        start: annotationMode === 'swipe' ? annotationStart || undefined : undefined,
        end: annotationMode === 'swipe' ? annotationEnd || undefined : undefined,
        durationMs: annotationMode === 'swipe' ? 350 : undefined,
      });
      if (response.data) {
        setRecording(response.data);
        const nextObservation = response.data.observations.find((observation) => (
          observation.included
          && !observation.promotedStepId
          && observation.status === 'ready'
          && observation.suggestedAction !== 'ignore'
          && !observation.collapsedIntoObservationId
        ));
        if (nextObservation) {
          openObservationEvidence(nextObservation);
          message.success('已生成 1 条可回放步骤，继续补标下一条已选候选');
        } else {
          setEvidenceObservation(null);
          message.success('已选候选补标完成，可回放步骤已更新');
        }
      }
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setAnnotationBusy(false);
    }
  };

  const handleStartSelectedAnnotation = () => {
    const nextObservation = recording?.observations.find((observation) => (
      observation.included
      && !observation.promotedStepId
      && observation.status === 'ready'
      && observation.suggestedAction !== 'ignore'
      && !observation.collapsedIntoObservationId
    ));
    if (!nextObservation) {
      message.warning('请先勾选至少一条待补标候选');
      return;
    }
    openObservationEvidence(nextObservation);
  };

  const executeReplay = async (inputValue = '') => {
    if (!recording) return;
    setReplayBusy(true);
    addAction(`开始一次性回放，共 ${recording.selectedCount} 步`);
    try {
      const response = await deviceControlApi.replayRecording(recording.id, inputValue);
      const executedCount = response.data?.executedCount || 0;
      const skippedCount = response.data?.skippedCount || 0;
      const mergedText = skippedCount > 0 ? `，自动合并 ${skippedCount} 条重复输入` : '';
      addAction(`一次性回放完成，共执行 ${executedCount} 步${mergedText}`);
      message.success(`回放完成，共执行 ${executedCount} 步${mergedText}`);
      setReplayInputVisible(false);
      setReplayInputValue('');
      refreshFallbackSoon();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setReplayBusy(false);
    }
  };

  const handleReplay = () => {
    if (!recording || recording.selectedCount <= 0) {
      message.warning('请先选择至少一个可回放步骤');
      return;
    }
    const hasParameterizedInput = recording.steps.some((step) => step.included && step.action.type === 'input');
    if (hasParameterizedInput) {
      setReplayInputVisible(true);
      return;
    }
    void executeReplay();
  };

  const displayedSteps = useMemo(
    () => (recording?.steps || []).filter((step) => !onlySelectedSteps || step.included),
    [onlySelectedSteps, recording?.steps],
  );
  const logicalObservations = useMemo(
    () => (recording?.observations || []).filter((observation) => !observation.collapsedIntoObservationId),
    [recording?.observations],
  );
  const externalChangeCount = recording?.observations?.length || 0;
  const promotedCandidateCount = recording?.observations?.filter((observation) => observation.promotedStepId).length || 0;
  const pendingCandidateCount = logicalObservations.filter((observation) => (
    !observation.promotedStepId && observation.suggestedAction !== 'ignore'
  )).length;
  const ignoredCandidateCount = logicalObservations.filter((observation) => observation.suggestedAction === 'ignore').length;
  const stoppedWithoutReplayableSteps = recording?.status === 'stopped' && recording.steps.length === 0;
  const emptyStepText = onlySelectedSteps
    ? '暂无已选择步骤'
    : (isRecording ? '等待操作手机，或在放大设备画面中操作…' : '本次没有可回放步骤');
  const createStep = recording?.status === 'stopped' ? 1 : 0;

  const renderDeviceScreen = (interactive: boolean) => (
    <div className={`device-console-stage ${interactive ? 'is-expanded' : 'is-preview'}`}>
      {!connected ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={status.phase === 'starting' ? '正在启动 WDA' : '连接真机后显示画面'}
        />
      ) : (
        <div className={`device-console-screen ${interactive ? 'is-interactive' : 'is-preview'}`}>
          {!streamReady && <Spin className="device-console-screen-spinner" />}
          <img
            ref={screenImageRef}
            src={`/api/device-control/${status.streamAvailable ? 'stream' : 'screenshot'}?ts=${streamVersion}`}
            alt={interactive ? 'iOS 真机操作画面' : 'iOS 真机预览'}
            draggable={false}
            onLoad={() => {
              setStreamReady(true);
              setStreamError('');
            }}
            onError={() => {
              setStreamReady(false);
              setStreamError(status.streamAvailable ? '实时画面流已中断，请点击“重连画面”' : '画面抓取失败，WDA 可能正在忙碌');
            }}
            onPointerDown={interactive ? handlePointerDown : undefined}
            onPointerUp={interactive ? handlePointerUp : undefined}
            onPointerCancel={interactive ? () => { pointerStart.current = null; } : undefined}
          />
          {interactive && touchMarker && (
            <span
              key={touchMarker.id}
              className="device-console-touch-marker"
              style={{ left: `${touchMarker.left}%`, top: `${touchMarker.top}%` }}
            />
          )}
        </div>
      )}
      {streamError && interactive && <Text type="danger" className="device-console-screen-error">{streamError}</Text>}
    </div>
  );

  return (
    <div className="device-console-page">
      <div className="device-console-heading">
        <div>
          <Title level={3}>{isReplayCreate ? '新建回放流程' : '真机调试台'}</Title>
          <Paragraph type="secondary">
            {isReplayCreate
              ? '先录制真机操作，再筛选补标、编排和验证，最后保存到回放中心。'
              : '一次性真机调试：可直接操作、录制、筛选补标并立即回放，但不会保存为流程资产。'}
          </Paragraph>
        </div>
        <Space wrap>
          {phaseTag(status.phase)}
          <Button onClick={() => navigate('/cicd/replay')}>回放中心</Button>
          <Button icon={<ReloadOutlined />} loading={loadingDevices} onClick={() => void loadDevices()}>刷新设备</Button>
        </Space>
      </div>

      {isReplayCreate && (
        <Card size="small" className="device-console-toolbar">
          <Steps
            current={createStep}
            items={[
              { title: '录制路径', description: '连接真机并完成操作' },
              { title: '筛选补标', description: '去除杂音并确认步骤' },
              { title: '编排验证', description: '连线、条件与真机调试' },
              { title: '保存完成', description: '进入回放流程库' },
            ]}
          />
          {recording && (
            <Alert
              showIcon
              type={recording.status === 'recording' ? 'warning' : 'info'}
              style={{ marginTop: 16 }}
              message={recording.status === 'recording' ? '当前回放录制进行中' : '已恢复上次未完成的录制会话'}
              description={`${recording.title}：${recording.selectedCount}/${recording.steps.length} 条步骤已选择。${recording.status === 'stopped' ? '可继续筛选补标，或连接真机后重新开始一次录制。' : ''}`}
            />
          )}
        </Card>
      )}

      {status.lastError && <Alert type="error" showIcon message={status.lastError} closable className="device-console-alert" />}

      <Card size="small" className="device-console-toolbar">
        <Space wrap size="middle">
          <Select
            showSearch
            value={selectedUdid || undefined}
            placeholder="选择 USB iOS 真机"
            loading={loadingDevices}
            disabled={connected || connecting}
            onChange={setSelectedUdid}
            optionFilterProp="label"
            style={{ width: 360, maxWidth: '72vw' }}
            options={devices.map((device) => ({
              value: device.udid,
              label: `${device.name}${device.osVersion ? ` · iOS ${device.osVersion}` : ''} · ${device.udid.slice(-8)}`,
              disabled: !device.connected,
            }))}
          />
          {!connected ? (
            <Button type="primary" icon={<MobileOutlined />} loading={connecting} disabled={!selectedUdid} onClick={() => void handleConnect()}>
              连接并启动 WDA
            </Button>
          ) : (
            <Button danger icon={<DisconnectOutlined />} loading={connecting} disabled={queuedActionCount > 0} onClick={() => void handleDisconnect()}>
              断开
            </Button>
          )}
          <Button
            icon={<ReloadOutlined />}
            disabled={!connected}
            onClick={handleReconnectScreen}
          >
            重连画面
          </Button>
          <Button icon={<ApiOutlined />} disabled={!connected} onClick={() => void handleOpenSource()}>
            WDA 树
          </Button>
          {isRecording ? (
            <Button danger icon={<StopOutlined />} loading={recordingBusy} disabled={queuedActionCount > 0} onClick={() => void handleStopRecording()}>
              停止录制
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<VideoCameraAddOutlined />}
              loading={recordingBusy}
              disabled={!connected}
              onClick={() => void handleStartRecording()}
            >
              开始录制
            </Button>
          )}
        </Space>
      </Card>

      <Row gutter={[20, 20]}>
        <Col xs={24}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Row gutter={[16, 16]}>
              <Col xs={24} xl={8}>
                <Card title="输入控制" size="small" className="device-console-utility-card">
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Space.Compact style={{ width: '100%' }}>
                      <Input
                        value={inputText}
                        disabled={!connected}
                        placeholder="先在 App 中聚焦输入框"
                        onChange={(event) => setInputText(event.target.value)}
                        onPressEnter={() => void handleSendInput()}
                      />
                      <Button
                        type="primary"
                        icon={<SendOutlined />}
                        disabled={!connected || !inputText}
                        onClick={() => void handleSendInput()}
                      >
                        发送
                      </Button>
                    </Space.Compact>
                    <Text type="secondary">仅平台代理输入时使用；手机直接操作无需填写。</Text>
                  </Space>
                </Card>
              </Col>

              <Col xs={24} xl={16}>
                <Card title="会话信息" size="small" className="device-console-utility-card">
                  <Descriptions column={{ xs: 1, sm: 2, xxl: 3 }} size="small">
                    <Descriptions.Item label="状态">{phaseTag(status.phase)}</Descriptions.Item>
                    <Descriptions.Item label="设备">{status.device?.name || selectedDevice?.name || '-'}</Descriptions.Item>
                    <Descriptions.Item label="UDID"><Text copyable>{status.device?.udid || selectedUdid || '-'}</Text></Descriptions.Item>
                    <Descriptions.Item label="系统">{status.device?.osVersion ? `iOS ${status.device.osVersion}` : '-'}</Descriptions.Item>
                    <Descriptions.Item label="逻辑分辨率">
                      {status.windowSize ? `${status.windowSize.width} × ${status.windowSize.height}` : '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="画面模式">{status.streamAvailable ? 'MJPEG 实时流 · 目标 25 FPS' : '截图轮询（降级）'}</Descriptions.Item>
                    <Descriptions.Item label="操作者">{status.owner || '-'}</Descriptions.Item>
                  </Descriptions>
                </Card>
              </Col>
            </Row>

            <Card
              title={(
                <Space>
                  <span>{isReplayCreate ? '黑盒操作步骤' : '一次性录制与回放'}</span>
                  {isRecording && <Tag color="red">录制中</Tag>}
                </Space>
              )}
              size="small"
              extra={recording ? (
                <Space wrap>
                  <Text type="secondary">
                    可回放 {recording.selectedCount}/{recording.steps.length} · 待补标选择 {recording.candidateSelectedCount}/{pendingCandidateCount}
                  </Text>
                  {isReplayCreate ? (
                    <Button
                      size="small"
                      type="primary"
                      icon={<BranchesOutlined />}
                      loading={saveFlowBusy}
                      disabled={isRecording || recording.selectedCount <= 0}
                      onClick={() => void handleEnterOrchestration()}
                    >
                      下一步：确认录制来源
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      type="primary"
                      icon={<PlayCircleOutlined />}
                      loading={replayBusy}
                      disabled={!connected || isRecording || recording.selectedCount <= 0}
                      onClick={handleReplay}
                    >
                      立即回放已选步骤
                    </Button>
                  )}
                </Space>
              ) : null}
            >
              {!recording ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="开始录制后，手机操作候选和平台精确指令会滚动显示在这里" />
              ) : (
                <>
                  {recording.steps.length > 0 && (
                    <div className="device-console-recording-filter">
                      <Checkbox checked={onlySelectedSteps} onChange={(event) => setOnlySelectedSteps(event.target.checked)}>
                        只看已选择步骤
                      </Checkbox>
                      <Text type="secondary">每条可回放步骤都包含明确的 WDA 动作；元素定位与坐标共同用于稳定回放</Text>
                    </div>
                  )}
                  {externalChangeCount > 0 && (
                    <Alert
                      type={isRecording ? 'warning' : 'info'}
                      showIcon
                      className="device-console-observation-alert"
                      message={stoppedWithoutReplayableSteps
                        ? `录制已停止：${externalChangeCount} 段页面变化已整理为 ${logicalObservations.length - ignoredCandidateCount} 个逻辑动作组`
                        : (isRecording ? '检测到手机直触或平台外页面变化' : '另有平台外页面变化证据')}
                      description={stoppedWithoutReplayableSteps
                        ? `平台已自动合并连续输入态，并忽略 ${ignoredCandidateCount} 段页面抖动。确认建议动作后逐组补标，即可生成回放路径。`
                        : `已采集 ${externalChangeCount} 段变化证据，并持续整理为逻辑动作组。`}
                    />
                  )}
                  {recording.observations.length > 0 && (
                    <div className="device-console-observation-candidates">
                      <div className="device-console-candidate-heading">
                        <div>
                          <Text strong>逻辑动作组</Text>
                          <Text type="secondary"> · 输入法中间态会自动折叠</Text>
                        </div>
                        <Space wrap>
                          <Text type="secondary">待补标已选 {recording.candidateSelectedCount}/{pendingCandidateCount} · 已转步骤 {promotedCandidateCount}</Text>
                          <Button
                            type="primary"
                            size="small"
                            disabled={recording.candidateSelectedCount <= 0}
                            onClick={handleStartSelectedAnnotation}
                          >
                            开始补标已选候选（{recording.candidateSelectedCount}）
                          </Button>
                        </Space>
                      </div>
                      <List
                        size="small"
                        dataSource={logicalObservations}
                        renderItem={(observation) => (
                          <List.Item className={`device-console-recording-step ${observation.noiseLikely ? 'is-noise' : ''}`}>
                            <div className="device-console-recording-step-main">
                              <Checkbox
                                checked={observation.included}
                                disabled={observation.status === 'failed' || Boolean(observation.promotedStepId) || observation.suggestedAction === 'ignore'}
                                onChange={(event) => void handleObservationIncluded(observation, event.target.checked)}
                              />
                              <div className="device-console-recording-step-content">
                                <Space size={6} wrap>
                                  <Text strong>C{observation.index}</Text>
                                  <Tag color="gold">逻辑动作</Tag>
                                  {observation.suggestedAction === 'input' && <Tag color="purple">建议 Input</Tag>}
                                  {observation.suggestedAction === 'tap' && <Tag color="blue">建议 Tap</Tag>}
                                  {observation.suggestedAction === 'ignore' && <Tag>自动忽略</Tag>}
                                  {(observation.collapsedObservationCount || 1) > 1 && <Tag color="cyan">已合并 {observation.collapsedObservationCount} 段输入态</Tag>}
                                  {observation.promotedStepId ? <Tag color="green">已转可回放</Tag> : <Tag>待补标</Tag>}
                                  {observation.noiseLikely && <Tag color="default">可能是杂音</Tag>}
                                  {observation.status === 'pending' && <Spin size="small" />}
                                  {observation.status === 'failed' && <Tag color="error">采集失败</Tag>}
                                </Space>
                                <Text className="device-console-recording-step-summary">{observation.error || observation.suggestionReason || observation.summary}</Text>
                                <Text type="secondary" className="device-console-recording-step-target">
                                  {observation.promotedStepId
                                    ? '已生成可回放指令，可重新打开证据调整标注'
                                    : (observation.suggestedAction === 'ignore' ? observation.summary : `原始证据：${observation.summary}`)}
                                </Text>
                              </div>
                            </div>
                            <Button
                              type="text"
                              size="small"
                              icon={<EyeOutlined />}
                              disabled={!observation.beforeSnapshot || !observation.afterSnapshot}
                              onClick={() => openObservationEvidence(observation)}
                            >
                              证据
                            </Button>
                          </List.Item>
                        )}
                      />
                    </div>
                  )}
                  {recording.steps.length > 0 && <Text strong className="device-console-replayable-heading">可回放步骤</Text>}
                  <div ref={recordingListRef} className="device-console-recording-steps">
                    <List
                      size="small"
                      locale={{ emptyText: emptyStepText }}
                      dataSource={displayedSteps}
                      renderItem={(step) => (
                        <List.Item className={`device-console-recording-step ${step.noiseLikely ? 'is-noise' : ''}`}>
                          <div className="device-console-recording-step-main">
                            <Checkbox
                              checked={step.included}
                              disabled={step.status === 'failed'}
                              onChange={(event) => void handleStepIncluded(step, event.target.checked)}
                            />
                            <div className="device-console-recording-step-content">
                              <Space size={6} wrap>
                                <Text strong>#{step.index}</Text>
                                <Tag color={step.origin === 'annotated' ? 'purple' : 'blue'}>{step.origin === 'annotated' ? '人工补标' : 'WDA 指令'}</Tag>
                                {step.action.target || step.action.startTarget
                                  ? <Tag color="green">元素定位</Tag>
                                  : (step.action.type === 'input' ? <Tag color="orange">焦点兜底</Tag> : <Tag>坐标兜底</Tag>)}
                                {step.status === 'pending' && <Spin size="small" />}
                                {step.status === 'failed' && <Tag color="error">采集失败</Tag>}
                              </Space>
                              <Text className="device-console-recording-step-summary">{step.error || step.summary}</Text>
                              <Text type="secondary" className="device-console-recording-step-target">{stepTargetSummary(step)}</Text>
                            </div>
                          </div>
                          <Button
                            type="text"
                            size="small"
                            icon={<EyeOutlined />}
                            disabled={!step.beforeSnapshot || !step.afterSnapshot}
                            onClick={() => setEvidenceStep(step)}
                          >
                            证据
                          </Button>
                        </List.Item>
                      )}
                    />
                  </div>
                </>
              )}
            </Card>

            <Card title="操作记录" size="small">
              <List
                size="small"
                locale={{ emptyText: '本次会话暂无操作' }}
                dataSource={actions}
                className="device-console-actions"
                renderItem={(item) => (
                  <List.Item>
                    <Text>{item.text}</Text>
                    <Text type="secondary">{item.time}</Text>
                  </List.Item>
                )}
              />
            </Card>
          </Space>
        </Col>
      </Row>

      {!screenExpanded && <div className="device-console-floating-preview">
        <button
          type="button"
          className="device-console-floating-trigger"
          aria-label="放大设备画面并进入操作"
          onClick={() => setScreenExpanded(true)}
        >
          <span className="device-console-floating-heading">
            <span>
              <Text strong>设备画面</Text>
              <Text type="secondary" className="device-console-floating-status">
                {connected ? '实时监看' : '未连接'}
              </Text>
            </span>
            <FullscreenOutlined />
          </span>
          {renderDeviceScreen(false)}
          <Text type="secondary" className="device-console-floating-hint">点击放大后可操作</Text>
        </button>
      </div>}

      <Modal
        title={(
          <Space>
            <span>设备操作画面</span>
            {queuedActionCount > 0 && <Tag color="processing">执行队列 {queuedActionCount} 条</Tag>}
          </Space>
        )}
        open={screenExpanded}
        width="min(92vw, 760px)"
        footer={null}
        centered
        onCancel={() => {
          pointerStart.current = null;
          setScreenExpanded(false);
        }}
      >
        {screenExpanded && renderDeviceScreen(true)}
        <div className="device-console-expanded-controls">
          <Space wrap>
            <Text type="secondary">{status.device?.name || selectedDevice?.name || '未选择设备'}</Text>
            <Button size="small" icon={<ReloadOutlined />} disabled={!connected} onClick={handleReconnectScreen}>
              重连画面
            </Button>
            <Button size="small" icon={<ApiOutlined />} disabled={!connected} onClick={() => void handleOpenSource()}>
              WDA 树
            </Button>
          </Space>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={inputText}
              disabled={!connected}
              placeholder="先在 App 中聚焦输入框，再发送文本"
              onChange={(event) => setInputText(event.target.value)}
              onPressEnter={() => void handleSendInput()}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              disabled={!connected || !inputText}
              onClick={() => void handleSendInput()}
            >
              发送
            </Button>
          </Space.Compact>
          <Text type="secondary">在放大画面上点击或拖动可执行 Tap / Swipe；缩略图仅用于监看。</Text>
        </div>
      </Modal>

      <Modal
        title="当前 WDA 页面树"
        open={sourceVisible}
        width="86vw"
        footer={<Button onClick={() => setSourceVisible(false)}>关闭</Button>}
        onCancel={() => setSourceVisible(false)}
      >
        <Spin spinning={sourceLoading}>
          <pre className="device-console-source">{source || '暂无页面树'}</pre>
        </Spin>
      </Modal>

      <Modal
        title={evidenceStep ? `步骤 #${evidenceStep.index} 前后证据` : '步骤证据'}
        open={Boolean(evidenceStep)}
        width="88vw"
        footer={<Button onClick={() => setEvidenceStep(null)}>关闭</Button>}
        onCancel={() => setEvidenceStep(null)}
      >
        {evidenceStep && (
          <>
            <Alert
              type="info"
              showIcon
              message={evidenceStep.summary}
              description={`${evidenceStep.origin === 'annotated' ? '该步骤由手机操作候选人工补标生成。' : '该步骤来自平台发送的精确 WDA 指令。'}${stepTargetSummary(evidenceStep)}`}
              style={{ marginBottom: 16 }}
            />
            <Row gutter={[16, 16]}>
              <Col xs={24} md={12}>
                <Card size="small" title="操作前">
                  {evidenceStep.beforeSnapshot && <img className="device-console-evidence-image" src={evidenceStep.beforeSnapshot.screenshotUrl} alt="操作前截图" />}
                  {evidenceStep.beforeSnapshot && (
                    <Button block href={evidenceStep.beforeSnapshot.sourceUrl} target="_blank">打开操作前 Source</Button>
                  )}
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card size="small" title="操作后">
                  {evidenceStep.afterSnapshot && <img className="device-console-evidence-image" src={evidenceStep.afterSnapshot.screenshotUrl} alt="操作后截图" />}
                  {evidenceStep.afterSnapshot && (
                    <Button block href={evidenceStep.afterSnapshot.sourceUrl} target="_blank">打开操作后 Source</Button>
                  )}
                </Card>
              </Col>
            </Row>
          </>
        )}
      </Modal>

      <Modal
        title={evidenceObservation ? `手机操作候选 C${evidenceObservation.index} 前后证据` : '手机操作候选证据'}
        open={Boolean(evidenceObservation)}
        width="88vw"
        footer={(
          <Space>
            <Button onClick={() => setEvidenceObservation(null)}>关闭</Button>
            <Button type="primary" loading={annotationBusy} onClick={() => void handlePromoteObservation()}>
              {evidenceObservation?.promotedStepId ? '更新可回放步骤' : '生成可回放步骤'}
            </Button>
          </Space>
        )}
        onCancel={() => setEvidenceObservation(null)}
      >
        {evidenceObservation && (
          <>
            <Alert
              type="warning"
              showIcon
              message={evidenceObservation.summary}
              description="选择动作类型，并在变化前截图上补标实际操作。平台会据此生成坐标、WDA元素定位和可回放指令。"
              style={{ marginBottom: 16 }}
            />
            <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 16 }}>
              <Segmented
                value={annotationMode}
                options={[
                  { label: '点击 Tap', value: 'tap' },
                  { label: '滑动 Swipe', value: 'swipe' },
                  { label: '输入 Input', value: 'input' },
                ]}
                onChange={(value) => {
                  setAnnotationMode(value as 'tap' | 'swipe' | 'input');
                  setAnnotationStart(null);
                  setAnnotationEnd(null);
                }}
              />
              <Text type="secondary">
                {annotationMode === 'tap' && '请在变化前截图上点一下实际点击位置。'}
                {annotationMode === 'swipe' && '请在变化前截图上按住并拖出实际滑动方向。'}
                {annotationMode === 'input' && '平台将从变化前 Source 识别输入框，并生成参数化 ${INPUT}。'}
              </Text>
            </Space>
            <Row gutter={[16, 16]}>
              <Col xs={24} md={12}>
                <Card size="small" title="变化前">
                  {evidenceObservation.beforeSnapshot && (
                    <div className={`device-console-annotation-stage is-${annotationMode}`}>
                      <img
                        ref={annotationImageRef}
                        className="device-console-evidence-image"
                        src={evidenceObservation.beforeSnapshot.screenshotUrl}
                        alt="候选变化前截图"
                        draggable={false}
                        onLoad={(event) => updateAnnotationViewport(event.currentTarget)}
                        onPointerDown={handleAnnotationPointerDown}
                        onPointerUp={handleAnnotationPointerUp}
                      />
                      {annotationStart && annotationMode !== 'input' && (
                        <span className="device-console-annotation-marker is-start" style={annotationMarkerStyle(annotationStart)} />
                      )}
                      {annotationEnd && annotationMode === 'swipe' && (
                        <span className="device-console-annotation-marker is-end" style={annotationMarkerStyle(annotationEnd)} />
                      )}
                    </div>
                  )}
                  {evidenceObservation.beforeSnapshot && (
                    <Button block href={evidenceObservation.beforeSnapshot.sourceUrl} target="_blank">打开变化前 Source</Button>
                  )}
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card size="small" title="变化后">
                  {evidenceObservation.afterSnapshot && <img className="device-console-evidence-image" src={evidenceObservation.afterSnapshot.screenshotUrl} alt="候选变化后截图" />}
                  {evidenceObservation.afterSnapshot && (
                    <Button block href={evidenceObservation.afterSnapshot.sourceUrl} target="_blank">打开变化后 Source</Button>
                  )}
                </Card>
              </Col>
            </Row>
          </>
        )}
      </Modal>

      <Modal
        title="确认录制来源"
        open={orchestrationPreviewOpen}
        width="min(92vw, 860px)"
        okText="确认并生成流程草稿"
        cancelText="返回筛选"
        confirmLoading={saveFlowBusy}
        onOk={() => void handleConfirmOrchestration()}
        onCancel={() => setOrchestrationPreviewOpen(false)}
      >
        {orchestrationPreview && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Alert
              showIcon
              type="info"
              message="只有确认后，这次录制才会成为新回放流程的生成来源"
              description="后续录制选择或补标发生变化时，平台只会提示来源已变更，不会自动覆盖已编排草稿。"
            />
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="录制名称">{orchestrationPreview.recording.title}</Descriptions.Item>
              <Descriptions.Item label="已选步骤">{orchestrationPreview.recording.selectedCount}</Descriptions.Item>
              <Descriptions.Item label="录制 ID"><Text copyable>{orchestrationPreview.recording.id}</Text></Descriptions.Item>
              <Descriptions.Item label="停止时间">{orchestrationPreview.recording.stoppedAt ? new Date(orchestrationPreview.recording.stoppedAt).toLocaleString() : '-'}</Descriptions.Item>
              <Descriptions.Item label="设备">{orchestrationPreview.recording.device?.name || '-'}</Descriptions.Item>
              <Descriptions.Item label="来源指纹"><Text copyable>{orchestrationPreview.sourceFingerprint}</Text></Descriptions.Item>
            </Descriptions>
            <List
              size="small"
              bordered
              header={<Text strong>将按以下顺序生成 DSL 动作节点</Text>}
              dataSource={orchestrationPreview.selectedSteps}
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
      </Modal>

      <Modal
        title="设置本次一次性回放输入"
        open={replayInputVisible}
        okText="开始回放"
        cancelText="取消"
        confirmLoading={replayBusy}
        onOk={() => void executeReplay(replayInputValue)}
        onCancel={() => setReplayInputVisible(false)}
      >
        <Paragraph type="secondary">录制中的输入已参数化为 `${'{INPUT}'}`，请填写这次回放使用的内容。</Paragraph>
        <Input
          value={replayInputValue}
          placeholder="输入本次回放文本"
          onChange={(event) => setReplayInputValue(event.target.value)}
          onPressEnter={() => void executeReplay(replayInputValue)}
        />
      </Modal>

    </div>
  );
}
