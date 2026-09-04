import { DeviceRecording, RecordingStep } from './DeviceRecordingService';

export const DEVICE_REPLAY_FLOW_SCHEMA_VERSION = '1.0' as const;

export interface ReplayFlowInputDefinition {
  type: 'string';
  required?: boolean;
  default?: string;
  description?: string;
}

export interface ReplayFlowCoordinate {
  x: number;
  y: number;
}

export interface ReplayFlowTarget {
  accessibilityId?: string;
  name?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  type?: string;
  contextLabels?: string[];
  coordinate?: ReplayFlowCoordinate;
  relativePoint?: ReplayFlowCoordinate;
}

export type ReplayFlowCondition =
  | { all: ReplayFlowCondition[] }
  | { any: ReplayFlowCondition[] }
  | { not: ReplayFlowCondition }
  | { kind: 'element'; operator: 'exists' | 'not_exists' | 'visible' | 'not_visible' | 'enabled' | 'disabled'; target: ReplayFlowTarget }
  | { kind: 'text'; operator: 'equals' | 'contains' | 'not_contains'; target: ReplayFlowTarget; value: string }
  | { kind: 'keyboard'; operator: 'visible' | 'hidden' }
  | { kind: 'app'; operator: 'foreground' | 'background' }
  | { kind: 'delay'; durationMs: number }
  | { kind: 'page_stable'; durationMs?: number }
  | { kind: 'snapshot_similarity'; snapshotId: string; threshold?: number };

export interface ReplayFlowRetryPolicy {
  maxAttempts: number;
  intervalMs?: number;
  backoff?: 'fixed' | 'linear';
}

export interface ReplayFlowEvidenceReference {
  beforeSnapshotId?: string;
  afterSnapshotId?: string;
  recordingStepId?: string;
}

interface ReplayFlowNodeBase {
  id: string;
  name?: string;
  description?: string;
  timeoutMs?: number;
  retry?: ReplayFlowRetryPolicy;
  evidence?: ReplayFlowEvidenceReference;
}

export interface ReplayFlowStartNode extends ReplayFlowNodeBase {
  type: 'start';
  next: string;
}

interface ReplayFlowActionNodeBase extends ReplayFlowNodeBase {
  precondition?: ReplayFlowCondition;
  postcondition?: ReplayFlowCondition;
  next: string;
  onFailure?: string;
}

export interface ReplayFlowTapNode extends ReplayFlowActionNodeBase {
  type: 'tap';
  target: ReplayFlowTarget;
}

export interface ReplayFlowSwipeNode extends ReplayFlowActionNodeBase {
  type: 'swipe';
  start: ReplayFlowCoordinate;
  end: ReplayFlowCoordinate;
  durationMs?: number;
  startTarget?: ReplayFlowTarget;
  endTarget?: ReplayFlowTarget;
}

export interface ReplayFlowInputNode extends ReplayFlowActionNodeBase {
  type: 'input';
  value: string;
  target?: ReplayFlowTarget;
}

export interface ReplayFlowKeyboardNode extends ReplayFlowActionNodeBase {
  type: 'keyboard';
  key: 'Search' | 'Return' | 'Done' | 'Dismiss';
}

export interface ReplayFlowWaitNode extends ReplayFlowNodeBase {
  type: 'wait';
  condition: ReplayFlowCondition;
  onSuccess: string;
  onTimeout: string;
  onError?: string;
}

export interface ReplayFlowConditionNode extends ReplayFlowNodeBase {
  type: 'condition';
  condition: ReplayFlowCondition;
  onTrue: string;
  onFalse: string;
  onTimeout?: string;
  onError?: string;
}

export interface ReplayFlowAssertionNode extends ReplayFlowNodeBase {
  type: 'assertion';
  condition: ReplayFlowCondition;
  onPassed: string;
  onFailed: string;
  onError?: string;
}

export interface ReplayFlowEndNode extends ReplayFlowNodeBase {
  type: 'end';
  result: 'success' | 'failure';
  message?: string;
}

export type ReplayFlowNode =
  | ReplayFlowStartNode
  | ReplayFlowTapNode
  | ReplayFlowSwipeNode
  | ReplayFlowInputNode
  | ReplayFlowKeyboardNode
  | ReplayFlowWaitNode
  | ReplayFlowConditionNode
  | ReplayFlowAssertionNode
  | ReplayFlowEndNode;

export interface DeviceReplayFlowDsl {
  schemaVersion: typeof DEVICE_REPLAY_FLOW_SCHEMA_VERSION;
  id: string;
  name: string;
  description?: string;
  source?: { type: 'recording'; recordingId: string };
  inputs?: Record<string, ReplayFlowInputDefinition>;
  nodes: ReplayFlowNode[];
}

export interface ReplayFlowDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
  nodeId?: string;
}

export interface ReplayFlowValidationResult {
  valid: boolean;
  errors: ReplayFlowDiagnostic[];
  warnings: ReplayFlowDiagnostic[];
}

export interface CompiledReplayFlowEdge {
  outcome: string;
  to: string;
}

export interface CompiledReplayFlowNode {
  id: string;
  type: ReplayFlowNode['type'];
  node: ReplayFlowNode;
  edges: CompiledReplayFlowEdge[];
}

export interface CompiledDeviceReplayFlow {
  schemaVersion: typeof DEVICE_REPLAY_FLOW_SCHEMA_VERSION;
  flowId: string;
  name: string;
  entryNodeId: string;
  inputs: Record<string, ReplayFlowInputDefinition>;
  nodes: Record<string, CompiledReplayFlowNode>;
  order: string[];
}

const replayNodeCommonSchemaProperties = {
  id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._-]{0,127}$' },
  name: { type: 'string', minLength: 1, maxLength: 200 },
  description: { type: 'string', maxLength: 2000 },
  timeoutMs: { type: 'integer', minimum: 100, maximum: 600000 },
  retry: { $ref: '#/$defs/retry' },
  evidence: { $ref: '#/$defs/evidence' },
} as const;

const replayActionSchemaProperties = {
  ...replayNodeCommonSchemaProperties,
  precondition: { $ref: '#/$defs/condition' },
  postcondition: { $ref: '#/$defs/condition' },
  next: { $ref: '#/$defs/nodeId' },
  onFailure: { $ref: '#/$defs/nodeId' },
} as const;

export const DEVICE_REPLAY_FLOW_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://nn-ios-platform.local/schemas/device-replay-flow-v1.json',
  title: 'NN iOS Device Replay Flow DSL',
  description: '纯黑盒 iOS 真机状态驱动回放流程协议',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'id', 'name', 'nodes'],
  properties: {
    schemaVersion: { const: DEVICE_REPLAY_FLOW_SCHEMA_VERSION },
    id: { $ref: '#/$defs/nodeId' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 2000 },
    source: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'recordingId'],
      properties: { type: { const: 'recording' }, recordingId: { type: 'string', minLength: 1 } },
    },
    inputs: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['type'],
        properties: {
          type: { const: 'string' },
          required: { type: 'boolean' },
          default: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
    nodes: {
      type: 'array',
      minItems: 2,
      maxItems: 1000,
      items: { oneOf: [
        { $ref: '#/$defs/startNode' },
        { $ref: '#/$defs/tapNode' },
        { $ref: '#/$defs/swipeNode' },
        { $ref: '#/$defs/inputNode' },
        { $ref: '#/$defs/keyboardNode' },
        { $ref: '#/$defs/waitNode' },
        { $ref: '#/$defs/conditionNode' },
        { $ref: '#/$defs/assertionNode' },
        { $ref: '#/$defs/endNode' },
      ] },
    },
  },
  $defs: {
    nodeId: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._-]{0,127}$' },
    coordinate: {
      type: 'object', additionalProperties: false, required: ['x', 'y'],
      properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } },
    },
    target: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accessibilityId: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        label: { type: 'string', minLength: 1 },
        text: { type: 'string', minLength: 1 },
        placeholder: { type: 'string', minLength: 1 },
        type: { type: 'string', minLength: 1 },
        contextLabels: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true, minItems: 1, maxItems: 20 },
        coordinate: { $ref: '#/$defs/coordinate' },
        relativePoint: { $ref: '#/$defs/coordinate' },
      },
      anyOf: [
        { required: ['accessibilityId'] }, { required: ['name'] }, { required: ['label'] },
        { required: ['text'] }, { required: ['placeholder'] }, { required: ['contextLabels'] }, { required: ['coordinate'] },
      ],
    },
    retry: {
      type: 'object', additionalProperties: false, required: ['maxAttempts'],
      properties: {
        maxAttempts: { type: 'integer', minimum: 1, maximum: 20 },
        intervalMs: { type: 'integer', minimum: 0, maximum: 60000 },
        backoff: { enum: ['fixed', 'linear'] },
      },
    },
    evidence: {
      type: 'object', additionalProperties: false,
      properties: {
        beforeSnapshotId: { type: 'string', minLength: 1 },
        afterSnapshotId: { type: 'string', minLength: 1 },
        recordingStepId: { type: 'string', minLength: 1 },
      },
    },
    condition: {
      oneOf: [
        {
          type: 'object', additionalProperties: false, required: ['all'],
          properties: { all: { type: 'array', minItems: 1, maxItems: 20, items: { $ref: '#/$defs/condition' } } },
        },
        {
          type: 'object', additionalProperties: false, required: ['any'],
          properties: { any: { type: 'array', minItems: 1, maxItems: 20, items: { $ref: '#/$defs/condition' } } },
        },
        {
          type: 'object', additionalProperties: false, required: ['not'],
          properties: { not: { $ref: '#/$defs/condition' } },
        },
        {
          type: 'object', additionalProperties: false, required: ['kind', 'operator', 'target'],
          properties: {
            kind: { const: 'element' },
            operator: { enum: ['exists', 'not_exists', 'visible', 'not_visible', 'enabled', 'disabled'] },
            target: { $ref: '#/$defs/target' },
          },
        },
        {
          type: 'object', additionalProperties: false, required: ['kind', 'operator', 'target', 'value'],
          properties: {
            kind: { const: 'text' }, operator: { enum: ['equals', 'contains', 'not_contains'] },
            target: { $ref: '#/$defs/target' }, value: { type: 'string', minLength: 1 },
          },
        },
        {
          type: 'object', additionalProperties: false, required: ['kind', 'operator'],
          properties: { kind: { const: 'keyboard' }, operator: { enum: ['visible', 'hidden'] } },
        },
        {
          type: 'object', additionalProperties: false, required: ['kind', 'operator'],
          properties: { kind: { const: 'app' }, operator: { enum: ['foreground', 'background'] } },
        },
        {
          type: 'object', additionalProperties: false, required: ['kind', 'durationMs'],
          properties: { kind: { const: 'delay' }, durationMs: { type: 'integer', minimum: 100, maximum: 60000 } },
        },
        {
          type: 'object', additionalProperties: false, required: ['kind'],
          properties: { kind: { const: 'page_stable' }, durationMs: { type: 'integer', minimum: 100, maximum: 60000 } },
        },
        {
          type: 'object', additionalProperties: false, required: ['kind', 'snapshotId'],
          properties: {
            kind: { const: 'snapshot_similarity' }, snapshotId: { type: 'string', minLength: 1 },
            threshold: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      ],
    },
    startNode: {
      type: 'object', additionalProperties: false, required: ['id', 'type', 'next'],
      properties: { ...replayNodeCommonSchemaProperties, type: { const: 'start' }, next: { $ref: '#/$defs/nodeId' } },
    },
    tapNode: {
      type: 'object', additionalProperties: false, required: ['id', 'type', 'target', 'next'],
      properties: { ...replayActionSchemaProperties, type: { const: 'tap' }, target: { $ref: '#/$defs/target' } },
    },
    swipeNode: {
      type: 'object', additionalProperties: false, required: ['id', 'type', 'start', 'end', 'next'],
      properties: {
        ...replayActionSchemaProperties, type: { const: 'swipe' }, start: { $ref: '#/$defs/coordinate' },
        end: { $ref: '#/$defs/coordinate' }, durationMs: { type: 'integer', minimum: 100, maximum: 3000 },
        startTarget: { $ref: '#/$defs/target' }, endTarget: { $ref: '#/$defs/target' },
      },
    },
    inputNode: {
      type: 'object', additionalProperties: false, required: ['id', 'type', 'value', 'next'],
      properties: { ...replayActionSchemaProperties, type: { const: 'input' }, value: { type: 'string', minLength: 1 }, target: { $ref: '#/$defs/target' } },
    },
    keyboardNode: {
      type: 'object', additionalProperties: false, required: ['id', 'type', 'key', 'next'],
      properties: { ...replayActionSchemaProperties, type: { const: 'keyboard' }, key: { enum: ['Search', 'Return', 'Done', 'Dismiss'] } },
    },
    waitNode: {
      type: 'object', additionalProperties: false, required: ['id', 'type', 'condition', 'onSuccess', 'onTimeout'],
      properties: {
        ...replayNodeCommonSchemaProperties, type: { const: 'wait' }, condition: { $ref: '#/$defs/condition' },
        onSuccess: { $ref: '#/$defs/nodeId' }, onTimeout: { $ref: '#/$defs/nodeId' }, onError: { $ref: '#/$defs/nodeId' },
      },
    },
    conditionNode: {
      type: 'object', additionalProperties: false, required: ['id', 'type', 'condition', 'onTrue', 'onFalse'],
      properties: {
        ...replayNodeCommonSchemaProperties, type: { const: 'condition' }, condition: { $ref: '#/$defs/condition' },
        onTrue: { $ref: '#/$defs/nodeId' }, onFalse: { $ref: '#/$defs/nodeId' },
        onTimeout: { $ref: '#/$defs/nodeId' }, onError: { $ref: '#/$defs/nodeId' },
      },
    },
    assertionNode: {
      type: 'object', additionalProperties: false, required: ['id', 'type', 'condition', 'onPassed', 'onFailed'],
      properties: {
        ...replayNodeCommonSchemaProperties, type: { const: 'assertion' }, condition: { $ref: '#/$defs/condition' },
        onPassed: { $ref: '#/$defs/nodeId' }, onFailed: { $ref: '#/$defs/nodeId' }, onError: { $ref: '#/$defs/nodeId' },
      },
    },
    endNode: {
      type: 'object', additionalProperties: false, required: ['id', 'type', 'result'],
      properties: { ...replayNodeCommonSchemaProperties, type: { const: 'end' }, result: { enum: ['success', 'failure'] }, message: { type: 'string' } },
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateCoordinate(value: unknown, path: string, nodeId: string, diagnostics: ReplayFlowDiagnostic[]) {
  if (!isRecord(value) || typeof value.x !== 'number' || typeof value.y !== 'number'
    || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    diagnostics.push({ severity: 'error', code: 'COORDINATE_REQUIRED', message: '坐标必须包含有效数字 x 和 y', path, nodeId });
    return false;
  }
  if (value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1) {
    diagnostics.push({ severity: 'error', code: 'COORDINATE_RANGE', message: '归一化坐标必须在 0～1 之间', path, nodeId });
    return false;
  }
  return true;
}

function nodeEdges(node: ReplayFlowNode): CompiledReplayFlowEdge[] {
  const edge = (outcome: string, to: unknown): CompiledReplayFlowEdge[] => (
    typeof to === 'string' && to.trim() ? [{ outcome, to: to.trim() }] : []
  );
  switch (node.type) {
    case 'start': return edge('next', node.next);
    case 'tap':
    case 'swipe':
    case 'input':
    case 'keyboard': return [
      ...edge('success', node.next),
      ...edge('failure', node.onFailure),
    ];
    case 'wait': return [
      ...edge('success', node.onSuccess),
      ...edge('timeout', node.onTimeout),
      ...edge('error', node.onError),
    ];
    case 'condition': return [
      ...edge('true', node.onTrue),
      ...edge('false', node.onFalse),
      ...edge('timeout', node.onTimeout),
      ...edge('error', node.onError),
    ];
    case 'assertion': return [
      ...edge('passed', node.onPassed),
      ...edge('failed', node.onFailed),
      ...edge('error', node.onError),
    ];
    case 'end': return [];
  }
}

function validateTarget(target: unknown, path: string, nodeId: string, diagnostics: ReplayFlowDiagnostic[]) {
  if (!isRecord(target)) {
    diagnostics.push({ severity: 'error', code: 'TARGET_REQUIRED', message: '节点缺少有效目标', path, nodeId });
    return;
  }
  const semantic = ['accessibilityId', 'name', 'label', 'text', 'placeholder'].some((key) => Boolean(stringValue(target[key])))
    || (Array.isArray(target.contextLabels) && target.contextLabels.some((value) => Boolean(stringValue(value))));
  const coordinate = target.coordinate !== undefined;
  if (!semantic && !coordinate) {
    diagnostics.push({ severity: 'error', code: 'TARGET_EMPTY', message: '目标必须包含语义定位或归一化坐标', path, nodeId });
  } else if (!semantic && coordinate) {
    diagnostics.push({ severity: 'warning', code: 'COORDINATE_ONLY_TARGET', message: '目标仅有坐标，页面布局变化时可能失效', path, nodeId });
  }
  if (coordinate) validateCoordinate(target.coordinate, `${path}.coordinate`, nodeId, diagnostics);
  if (target.relativePoint !== undefined) validateCoordinate(target.relativePoint, `${path}.relativePoint`, nodeId, diagnostics);
  if (target.contextLabels !== undefined && (!Array.isArray(target.contextLabels)
    || target.contextLabels.length < 1 || target.contextLabels.length > 20
    || target.contextLabels.some((value) => !stringValue(value)))) {
    diagnostics.push({ severity: 'error', code: 'TARGET_CONTEXT_LABELS', message: '上下文文本必须是 1～20 个非空字符串', path: `${path}.contextLabels`, nodeId });
  }
}

function validateCondition(condition: unknown, path: string, nodeId: string, diagnostics: ReplayFlowDiagnostic[], depth = 0) {
  if (!isRecord(condition)) {
    diagnostics.push({ severity: 'error', code: 'CONDITION_REQUIRED', message: '缺少有效条件', path, nodeId });
    return;
  }
  if (depth > 8) {
    diagnostics.push({ severity: 'error', code: 'CONDITION_TOO_DEEP', message: '条件嵌套不能超过 8 层', path, nodeId });
    return;
  }
  if (Array.isArray(condition.all) || Array.isArray(condition.any)) {
    const key = Array.isArray(condition.all) ? 'all' : 'any';
    const values = condition[key] as unknown[];
    if (!values.length) diagnostics.push({ severity: 'error', code: 'EMPTY_CONDITION_GROUP', message: `${key} 条件组不能为空`, path, nodeId });
    if (values.length > 20) diagnostics.push({ severity: 'error', code: 'CONDITION_GROUP_TOO_LARGE', message: `${key} 条件组不能超过 20 项`, path, nodeId });
    values.forEach((value, index) => validateCondition(value, `${path}.${key}[${index}]`, nodeId, diagnostics, depth + 1));
    return;
  }
  if (condition.not !== undefined) {
    validateCondition(condition.not, `${path}.not`, nodeId, diagnostics, depth + 1);
    return;
  }
  const kind = stringValue(condition.kind);
  const allowedKinds = new Set(['element', 'text', 'keyboard', 'app', 'delay', 'page_stable', 'snapshot_similarity']);
  if (!allowedKinds.has(kind)) {
    diagnostics.push({ severity: 'error', code: 'CONDITION_KIND', message: `不支持的条件类型：${kind || '空'}`, path: `${path}.kind`, nodeId });
    return;
  }
  const operators: Record<string, string[]> = {
    element: ['exists', 'not_exists', 'visible', 'not_visible', 'enabled', 'disabled'],
    text: ['equals', 'contains', 'not_contains'],
    keyboard: ['visible', 'hidden'],
    app: ['foreground', 'background'],
  };
  if (operators[kind] && !operators[kind].includes(stringValue(condition.operator))) {
    diagnostics.push({ severity: 'error', code: 'CONDITION_OPERATOR', message: `${kind} 条件的 operator 无效`, path: `${path}.operator`, nodeId });
  }
  if (kind === 'element' || kind === 'text') validateTarget(condition.target, `${path}.target`, nodeId, diagnostics);
  if (kind === 'text' && !stringValue(condition.value)) {
    diagnostics.push({ severity: 'error', code: 'TEXT_CONDITION_VALUE', message: '文本条件必须提供 value', path: `${path}.value`, nodeId });
  }
  if (kind === 'delay' || (kind === 'page_stable' && condition.durationMs !== undefined)) {
    const durationMs = Number(condition.durationMs);
    if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 60000) {
      diagnostics.push({ severity: 'error', code: 'CONDITION_DURATION_RANGE', message: '等待时长必须是 100～60000ms 的整数', path: `${path}.durationMs`, nodeId });
    }
  }
  if (kind === 'snapshot_similarity') {
    if (!stringValue(condition.snapshotId)) diagnostics.push({ severity: 'error', code: 'SNAPSHOT_REQUIRED', message: '快照相似条件必须提供 snapshotId', path, nodeId });
    if (condition.threshold !== undefined) {
      const threshold = Number(condition.threshold);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        diagnostics.push({ severity: 'error', code: 'THRESHOLD_RANGE', message: '相似度阈值必须在 0～1 之间', path: `${path}.threshold`, nodeId });
      }
    }
  }
}

export function validateDeviceReplayFlow(input: unknown): ReplayFlowValidationResult {
  const diagnostics: ReplayFlowDiagnostic[] = [];
  if (!isRecord(input)) {
    return { valid: false, errors: [{ severity: 'error', code: 'FLOW_OBJECT_REQUIRED', message: '流程必须是对象', path: '$' }], warnings: [] };
  }
  if (input.schemaVersion !== DEVICE_REPLAY_FLOW_SCHEMA_VERSION) diagnostics.push({ severity: 'error', code: 'SCHEMA_VERSION', message: `schemaVersion 必须为 ${DEVICE_REPLAY_FLOW_SCHEMA_VERSION}`, path: '$.schemaVersion' });
  const flowId = stringValue(input.id);
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(flowId)) diagnostics.push({ severity: 'error', code: 'FLOW_ID', message: '流程 ID 格式无效', path: '$.id' });
  if (!stringValue(input.name)) diagnostics.push({ severity: 'error', code: 'FLOW_NAME', message: '流程名称不能为空', path: '$.name' });
  if (!Array.isArray(input.nodes)) diagnostics.push({ severity: 'error', code: 'NODES_REQUIRED', message: '流程 nodes 必须是数组', path: '$.nodes' });
  if (!Array.isArray(input.nodes)) return { valid: false, errors: diagnostics, warnings: [] };
  if (input.nodes.length < 2 || input.nodes.length > 1000) {
    diagnostics.push({ severity: 'error', code: 'NODE_COUNT_RANGE', message: '流程节点数量必须在 2～1000 之间', path: '$.nodes' });
  }
  if (input.source !== undefined && (!isRecord(input.source) || input.source.type !== 'recording' || !stringValue(input.source.recordingId))) {
    diagnostics.push({ severity: 'error', code: 'FLOW_SOURCE', message: '录制来源必须包含 type=recording 和 recordingId', path: '$.source' });
  }
  if (input.inputs !== undefined && !isRecord(input.inputs)) {
    diagnostics.push({ severity: 'error', code: 'FLOW_INPUTS', message: 'inputs 必须是对象', path: '$.inputs' });
  } else if (isRecord(input.inputs)) {
    Object.entries(input.inputs).forEach(([name, definition]) => {
      const path = `$.inputs.${name}`;
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) || !isRecord(definition) || definition.type !== 'string') {
        diagnostics.push({ severity: 'error', code: 'FLOW_INPUT_DEFINITION', message: `变量 ${name} 必须是 string 类型定义`, path });
        return;
      }
      if (definition.required !== undefined && typeof definition.required !== 'boolean') {
        diagnostics.push({ severity: 'error', code: 'FLOW_INPUT_REQUIRED', message: `变量 ${name} 的 required 必须是布尔值`, path: `${path}.required` });
      }
      if (definition.default !== undefined && typeof definition.default !== 'string') {
        diagnostics.push({ severity: 'error', code: 'FLOW_INPUT_DEFAULT', message: `变量 ${name} 的 default 必须是字符串`, path: `${path}.default` });
      }
    });
  }
  const nodeRecords = input.nodes.filter(isRecord);
  if (nodeRecords.length !== input.nodes.length) diagnostics.push({ severity: 'error', code: 'NODE_OBJECT', message: '所有节点必须是对象', path: '$.nodes' });
  const ids = new Set<string>();
  const supportedTypes = new Set(['start', 'tap', 'swipe', 'input', 'keyboard', 'wait', 'condition', 'assertion', 'end']);
  const requiredReferences: Record<string, string[]> = {
    start: ['next'], tap: ['next'], swipe: ['next'], input: ['next'], keyboard: ['next'],
    wait: ['onSuccess', 'onTimeout'], condition: ['onTrue', 'onFalse'], assertion: ['onPassed', 'onFailed'], end: [],
  };
  nodeRecords.forEach((node, index) => {
    const path = `$.nodes[${index}]`;
    const id = stringValue(node.id);
    const type = stringValue(node.type);
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(id)) diagnostics.push({ severity: 'error', code: 'NODE_ID', message: '节点 ID 格式无效', path: `${path}.id` });
    if (ids.has(id)) diagnostics.push({ severity: 'error', code: 'DUPLICATE_NODE_ID', message: `节点 ID 重复：${id}`, path: `${path}.id`, nodeId: id });
    if (id) ids.add(id);
    if (!supportedTypes.has(type)) diagnostics.push({ severity: 'error', code: 'NODE_TYPE', message: `不支持的节点类型：${type || '空'}`, path: `${path}.type`, nodeId: id });
    (requiredReferences[type] || []).forEach((field) => {
      if (!stringValue(node[field])) diagnostics.push({ severity: 'error', code: 'EDGE_REQUIRED', message: `节点 ${id || path} 缺少必填跳转 ${field}`, path: `${path}.${field}`, nodeId: id });
    });
    if (node.timeoutMs !== undefined && (!Number.isFinite(Number(node.timeoutMs)) || Number(node.timeoutMs) < 100 || Number(node.timeoutMs) > 600000)) {
      diagnostics.push({ severity: 'error', code: 'TIMEOUT_RANGE', message: '节点超时必须在 100～600000ms 之间', path: `${path}.timeoutMs`, nodeId: id });
    }
    if (node.retry !== undefined && !isRecord(node.retry)) {
      diagnostics.push({ severity: 'error', code: 'RETRY_POLICY', message: '重试策略必须是对象', path: `${path}.retry`, nodeId: id });
    } else if (isRecord(node.retry)) {
      const attempts = Number(node.retry.maxAttempts);
      if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) diagnostics.push({ severity: 'error', code: 'RETRY_RANGE', message: '重试次数必须在 1～20 之间', path: `${path}.retry.maxAttempts`, nodeId: id });
      if (node.retry.intervalMs !== undefined) {
        const intervalMs = Number(node.retry.intervalMs);
        if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 60000) {
          diagnostics.push({ severity: 'error', code: 'RETRY_INTERVAL_RANGE', message: '重试间隔必须是 0～60000ms 的整数', path: `${path}.retry.intervalMs`, nodeId: id });
        }
      }
      if (node.retry.backoff !== undefined && !['fixed', 'linear'].includes(stringValue(node.retry.backoff))) {
        diagnostics.push({ severity: 'error', code: 'RETRY_BACKOFF', message: '重试退避只支持 fixed 或 linear', path: `${path}.retry.backoff`, nodeId: id });
      }
    }
    if (type === 'tap') validateTarget(node.target, `${path}.target`, id, diagnostics);
    if (type === 'swipe') {
      validateCoordinate(node.start, `${path}.start`, id, diagnostics);
      validateCoordinate(node.end, `${path}.end`, id, diagnostics);
      if (node.durationMs !== undefined) {
        const durationMs = Number(node.durationMs);
        if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 3000) {
          diagnostics.push({ severity: 'error', code: 'SWIPE_DURATION_RANGE', message: '滑动时长必须是 100～3000ms 的整数', path: `${path}.durationMs`, nodeId: id });
        }
      }
      if (node.startTarget !== undefined) validateTarget(node.startTarget, `${path}.startTarget`, id, diagnostics);
      if (node.endTarget !== undefined) validateTarget(node.endTarget, `${path}.endTarget`, id, diagnostics);
    }
    if (type === 'input') {
      if (!stringValue(node.value)) diagnostics.push({ severity: 'error', code: 'INPUT_VALUE', message: '输入节点 value 不能为空', path: `${path}.value`, nodeId: id });
      if (node.target !== undefined) validateTarget(node.target, `${path}.target`, id, diagnostics);
    }
    if (type === 'keyboard' && !['Search', 'Return', 'Done', 'Dismiss'].includes(stringValue(node.key))) {
      diagnostics.push({ severity: 'error', code: 'KEYBOARD_KEY', message: '键盘节点只支持 Search、Return、Done 或 Dismiss', path: `${path}.key`, nodeId: id });
    }
    if (type === 'end' && !['success', 'failure'].includes(stringValue(node.result))) {
      diagnostics.push({ severity: 'error', code: 'END_RESULT', message: 'End 节点 result 只支持 success 或 failure', path: `${path}.result`, nodeId: id });
    }
    if (type === 'wait' || type === 'condition' || type === 'assertion') validateCondition(node.condition, `${path}.condition`, id, diagnostics);
    if (node.precondition !== undefined) validateCondition(node.precondition, `${path}.precondition`, id, diagnostics);
    if (node.postcondition !== undefined) validateCondition(node.postcondition, `${path}.postcondition`, id, diagnostics);
  });
  const starts = nodeRecords.filter((node) => node.type === 'start');
  if (starts.length !== 1) diagnostics.push({ severity: 'error', code: 'START_COUNT', message: `流程必须且只能有 1 个 Start，当前为 ${starts.length}`, path: '$.nodes' });
  if (!nodeRecords.some((node) => node.type === 'end')) diagnostics.push({ severity: 'error', code: 'END_REQUIRED', message: '流程至少需要 1 个 End 节点', path: '$.nodes' });
  const declaredInputs = new Set(isRecord(input.inputs) ? Object.keys(input.inputs) : []);
  const runtimeVariables = new Set(['retryCount', 'previous.result', 'element.text']);
  const serializedNodes = JSON.stringify(input.nodes);
  for (const match of serializedNodes.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g)) {
    const variable = match[1];
    if (!declaredInputs.has(variable) && !runtimeVariables.has(variable)) {
      diagnostics.push({ severity: 'error', code: 'UNDECLARED_VARIABLE', message: `变量 ${variable} 未在 inputs 中声明`, path: '$.nodes' });
    }
  }
  const typedNodes = nodeRecords.filter((node) => supportedTypes.has(stringValue(node.type))) as unknown as ReplayFlowNode[];
  typedNodes.forEach((node) => {
    nodeEdges(node).forEach((edge) => {
      if (!ids.has(edge.to)) diagnostics.push({ severity: 'error', code: 'MISSING_EDGE_TARGET', message: `节点 ${node.id} 的 ${edge.outcome} 指向不存在节点 ${edge.to}`, nodeId: node.id });
    });
  });
  if (starts.length === 1) {
    const byId = new Map(typedNodes.map((node) => [node.id, node]));
    const visited = new Set<string>();
    const active = new Set<string>();
    const walk = (id: string) => {
      if (active.has(id)) {
        diagnostics.push({ severity: 'error', code: 'FREE_CYCLE', message: `第一阶段不允许自由环路，检测到环路节点 ${id}`, nodeId: id });
        return;
      }
      if (visited.has(id)) return;
      visited.add(id);
      active.add(id);
      const node = byId.get(id);
      if (node) nodeEdges(node).forEach((edge) => walk(edge.to));
      active.delete(id);
    };
    walk(stringValue(starts[0].id));
    typedNodes.filter((node) => !visited.has(node.id)).forEach((node) => diagnostics.push({ severity: 'warning', code: 'UNREACHABLE_NODE', message: `节点 ${node.id} 从 Start 不可达`, nodeId: node.id }));
  }
  const errors = diagnostics.filter((item) => item.severity === 'error');
  return { valid: errors.length === 0, errors, warnings: diagnostics.filter((item) => item.severity === 'warning') };
}

export function compileDeviceReplayFlow(flow: DeviceReplayFlowDsl): CompiledDeviceReplayFlow {
  const validation = validateDeviceReplayFlow(flow);
  if (!validation.valid) throw new Error(`流程校验失败：${validation.errors.map((item) => item.message).join('；')}`);
  const start = flow.nodes.find((node): node is ReplayFlowStartNode => node.type === 'start')!;
  const compiledNodes = Object.fromEntries(flow.nodes.map((node) => [node.id, {
    id: node.id,
    type: node.type,
    node,
    edges: nodeEdges(node),
  }]));
  const order: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    order.push(id);
    compiledNodes[id]?.edges.forEach((edge) => visit(edge.to));
  };
  visit(start.id);
  return {
    schemaVersion: flow.schemaVersion,
    flowId: flow.id,
    name: flow.name,
    entryNodeId: start.id,
    inputs: flow.inputs || {},
    nodes: compiledNodes,
    order,
  };
}

function replayTargetFromStep(step: RecordingStep, target = step.action.target): ReplayFlowTarget | undefined {
  const coordinate = step.action.normalizedPoint;
  if (!target && !coordinate) return undefined;
  const accessibilityId = target?.locators.find((locator) => locator.strategy === 'accessibilityId')?.value;
  return {
    accessibilityId,
    name: target?.name,
    label: target?.label,
    text: target?.contextLabels?.[0] || target?.value,
    placeholder: target?.placeholder,
    type: target?.type,
    contextLabels: target?.contextLabels,
    coordinate,
    relativePoint: target?.relativePoint,
  };
}

function sameInputTarget(left: RecordingStep, right: RecordingStep) {
  const leftTarget = left.action.target;
  const rightTarget = right.action.target;
  const leftKey = leftTarget?.placeholder || leftTarget?.name || leftTarget?.label;
  const rightKey = rightTarget?.placeholder || rightTarget?.name || rightTarget?.label;
  return left.action.type === 'input'
    && right.action.type === 'input'
    && Boolean(leftKey)
    && leftKey === rightKey
    && left.afterSnapshot?.id === right.beforeSnapshot?.id;
}

function hasSemanticReplayTarget(target?: ReplayFlowTarget) {
  return Boolean(target && [
    target.accessibilityId,
    target.name,
    target.label,
    target.text,
    target.placeholder,
    ...(target.contextLabels || []),
  ].some((value) => String(value || '').trim()));
}

function isSearchSubmitStep(step: RecordingStep) {
  if (step.action.type !== 'tap') return false;
  const target = step.action.target;
  const identity = String(target?.name || target?.label || target?.value || '').trim();
  return /^(搜索|search)$/i.test(identity);
}

function replayActionPrecondition(
  step: RecordingStep,
  index: number,
  target?: ReplayFlowTarget,
): ReplayFlowCondition | undefined {
  if ((step.action.type === 'tap' || step.action.type === 'input') && hasSemanticReplayTarget(target)) {
    return { kind: 'element', operator: 'enabled', target: target! };
  }
  if (!step.beforeSnapshot?.id) return undefined;
  return {
    kind: 'snapshot_similarity',
    snapshotId: step.beforeSnapshot.id,
    threshold: index === 0 ? 0.4 : 0.72,
  };
}

export function replayFlowTemplateFromRecording(recording: DeviceRecording, includeUnselected = false): DeviceReplayFlowDsl {
  const candidates = recording.steps.filter((step) => step.status === 'ready' && (includeUnselected || step.included));
  const steps = candidates.filter((step, index) => index === 0 || !sameInputTarget(candidates[index - 1], step));
  const actionIds = steps.map((step, index) => `step_${String(index + 1).padStart(3, '0')}_${step.id.slice(0, 8)}`);
  const waitIds = steps.map((step, index) => {
    const nextTarget = index < steps.length - 1 ? replayTargetFromStep(steps[index + 1]) : undefined;
    return isSearchSubmitStep(step) && hasSemanticReplayTarget(nextTarget)
      ? `wait_${String(index + 1).padStart(3, '0')}_search_result`
      : undefined;
  });
  const actionNodes: ReplayFlowNode[] = steps.map((step, index) => {
    const id = actionIds[index];
    const next = waitIds[index] || actionIds[index + 1] || 'success_end';
    const target = replayTargetFromStep(step);
    const base = {
      id,
      name: step.summary,
      next,
      onFailure: 'failure_end',
      timeoutMs: 15000,
      retry: { maxAttempts: 1, intervalMs: 500, backoff: 'fixed' as const },
      evidence: {
        beforeSnapshotId: step.beforeSnapshot?.id,
        afterSnapshotId: step.afterSnapshot?.id,
        recordingStepId: step.id,
      },
      precondition: replayActionPrecondition(step, index, target),
    };
    if (step.action.type === 'tap') return { ...base, type: 'tap' as const, target: target || { coordinate: step.action.normalizedPoint! } };
    if (step.action.type === 'swipe') return {
      ...base,
      type: 'swipe' as const,
      start: step.action.normalizedStart || { x: 0.5, y: 0.8 },
      end: step.action.normalizedEnd || { x: 0.5, y: 0.2 },
      durationMs: Number(step.action.params.durationMs) || 350,
    };
    if (step.action.type === 'input') return { ...base, type: 'input' as const, value: '${INPUT}', target };
    return { ...base, type: 'tap' as const, target: target || { coordinate: { x: 0.5, y: 0.5 } } };
  });
  const executionNodes: ReplayFlowNode[] = [];
  actionNodes.forEach((actionNode, index) => {
    executionNodes.push(actionNode);
    const waitId = waitIds[index];
    if (!waitId) return;
    const target = replayTargetFromStep(steps[index + 1])!;
    const rawTargetName = target.name || target.label || target.text || target.placeholder || '搜索结果';
    const targetName = rawTargetName.length > 36 ? `${rawTargetName.slice(0, 36)}…` : rawTargetName;
    executionNodes.push({
      id: waitId,
      type: 'wait',
      name: `等待「${targetName}」搜索结果`,
      timeoutMs: 15000,
      condition: { kind: 'element', operator: 'exists', target },
      onSuccess: actionIds[index + 1],
      onTimeout: 'failure_end',
      onError: 'failure_end',
      evidence: {
        afterSnapshotId: steps[index].afterSnapshot?.id,
        recordingStepId: steps[index].id,
      },
    });
  });
  return {
    schemaVersion: DEVICE_REPLAY_FLOW_SCHEMA_VERSION,
    id: `recording-${recording.id}`,
    name: `${recording.title} 回放流程`,
    description: '由真机录制自动生成的 DSL v1 线性流程模板，尚未发布。',
    source: { type: 'recording', recordingId: recording.id },
    inputs: steps.some((step) => step.action.type === 'input') ? {
      INPUT: { type: 'string', required: true, description: '回放时的参数化输入内容' },
    } : {},
    nodes: [
      { id: 'start', type: 'start', next: actionNodes[0]?.id || 'success_end' },
      ...executionNodes,
      { id: 'success_end', type: 'end', result: 'success', message: '录制步骤执行完成' },
      { id: 'failure_end', type: 'end', result: 'failure', message: '回放条件或动作执行失败' },
    ],
  };
}
