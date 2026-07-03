import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import {
  Typography,
  Card,
  Button,
  Space,
  Tag,
  Spin,
  Alert,
  message,
  Table,
  Popconfirm,
  Tabs,
  Input,
  Modal,
  Tree,
} from 'antd';
import {
  QrcodeOutlined,
  MobileOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  DisconnectOutlined,
  ClearOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileSearchOutlined,
  CopyOutlined,
} from '@ant-design/icons';
import { QRCodeSVG } from 'qrcode.react';
import { pairingApi, PairingSessionData, PairingStatusData, RealtimeLogDeviceData } from '../services/api';

const { Title, Paragraph, Text } = Typography;
const MAX_RENDERED_LOG_COUNT = 10000;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ConnectionState = 'idle' | 'qrcode' | 'polling' | 'paired' | 'streaming' | 'error';
type AppConnectionState = 'unknown' | 'waiting' | 'connected' | 'disconnected';
type LogChannel = 'business' | 'im' | 'rtc';
type PairingDeviceInfo = NonNullable<PairingStatusData['deviceInfo']>;

interface LogsPairPageProps {
  embedded?: boolean;
  pairingMode?: 'inline' | 'modal';
}

interface LogEntry {
  id: number;
  timestamp: string;
  channel: LogChannel;
  message: string;
  raw: string;
}

interface ParsedBusinessLog {
  time: string;
  category: string;
  event: string;
  level: 'info' | 'warning' | 'error';
  fields: Record<string, string>;
  line: string;
}

interface ApiTimelineRow {
  key: string;
  requestTime: string;
  responseTime: string;
  api: string;
  costMs: number | null;
  retCode: string;
  retMsg: string;
  nntid: string;
  trackId: string;
  parameters: string;
  responseBody: string;
  requestLine: string;
  responseLine: string;
  fullApi: string;
  status: 'success' | 'failed' | 'pending';
}

interface BusinessLogAnalysis {
  source: string;
  total: number;
  timeRange: string;
  warnings: number;
  apiRequests: number;
  apiResponses: number;
  failedResponses: ParsedBusinessLog[];
  slowResponses: ParsedBusinessLog[];
  eventCounts: Array<{ event: string; count: number }>;
  apiStats: Array<{ api: string; requestCount: number; responseCount: number; failedCount: number; maxCostMs: number; avgCostMs: number }>;
  apiTimeline: ApiTimelineRow[];
  retCodeCounts: Array<{ retCode: string; count: number }>;
  versions: string[];
  userIds: string[];
  nntidIssueCount: number;
  suggestions: string[];
  functionGroups: Array<{ key: string; label: string; logs: ParsedBusinessLog[]; warnings: number; eventCounts: Array<{ event: string; count: number }> }>;
}

function normalizeWebSocketURL(url?: string): string | undefined {
  if (!url) return undefined;

  try {
    const parsedURL = new URL(url);
    if (parsedURL.protocol === 'ws:' || parsedURL.protocol === 'wss:') {
      return parsedURL.toString();
    }
    if (parsedURL.protocol === 'http:' || parsedURL.protocol === 'https:') {
      parsedURL.protocol = parsedURL.protocol === 'https:' ? 'wss:' : 'ws:';
      parsedURL.pathname = '/ws/logs';
      parsedURL.search = '';
      parsedURL.hash = '';
      return parsedURL.toString();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function normalizeWebSocketURLs(urls: string[]): string[] {
  return urls
    .map((url) => normalizeWebSocketURL(url))
    .filter((url): url is string => Boolean(url))
    .filter((url, index, array) => array.indexOf(url) === index);
}

function makeRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function shortDeviceId(deviceInfo?: PairingDeviceInfo): string {
  const deviceId = deviceInfo?.appDeviceId || deviceInfo?.deviceId || '';
  return deviceId.replace(/-/g, '').slice(-6).toUpperCase();
}

function deviceDisplayName(deviceInfo?: PairingDeviceInfo): string {
  const name = deviceInfo?.name || '未知设备';
  const suffix = shortDeviceId(deviceInfo);
  return suffix ? `${name} · ${suffix}` : name;
}

function deviceDetailDisplayName(deviceInfo?: PairingDeviceInfo): string {
  const name = deviceDisplayName(deviceInfo);
  const nickName = deviceInfo?.nickName?.trim();
  return nickName ? `${name} · ${nickName}` : name;
}

function highlightText(text: string, keyword: string): ReactNode {
  if (!keyword) {
    return text;
  }

  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const nodes: ReactNode[] = [];
  let searchStart = 0;
  let matchIndex = lowerText.indexOf(lowerKeyword, searchStart);

  while (matchIndex >= 0) {
    if (matchIndex > searchStart) {
      nodes.push(text.slice(searchStart, matchIndex));
    }
    const matchEnd = matchIndex + keyword.length;
    nodes.push(
      <mark
        key={`${matchIndex}-${matchEnd}-${nodes.length}`}
        style={{
          color: '#1e1e1e',
          background: '#ffd666',
          borderRadius: 2,
          padding: '0 2px',
        }}
      >
        {text.slice(matchIndex, matchEnd)}
      </mark>
    );
    searchStart = matchEnd;
    matchIndex = lowerText.indexOf(lowerKeyword, searchStart);
  }

  if (searchStart < text.length) {
    nodes.push(text.slice(searchStart));
  }

  return nodes;
}

function parseFields(fieldsText: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w]*)=("(?:\\.|[^"])*"|[^,}]+)/g;
  let match = pattern.exec(fieldsText);
  while (match) {
    const rawValue = match[2].trim();
    fields[match[1]] = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1).replace(/\\"/g, '"')
      : rawValue;
    match = pattern.exec(fieldsText);
  }
  const response = extractFieldValue(fieldsText, 'response');
  if (response) {
    fields.response = response;
  }
  return fields;
}

function decodeQuotedFieldValue(value: string): string {
  return value.replace(/\\"/g, '"');
}

function extractFieldValue(source: string, fieldName: string): string {
  if (!source) return '';
  const startToken = `${fieldName}=`;
  const startIndex = source.indexOf(startToken);
  if (startIndex < 0) return '';

  const valueStart = startIndex + startToken.length;
  if (source[valueStart] !== '"') {
    const endMatch = source.slice(valueStart).match(/(?=,\s*[A-Za-z_][\w]*=|\})/);
    const endIndex = endMatch?.index !== undefined ? valueStart + endMatch.index : source.length;
    return source.slice(valueStart, endIndex).trim();
  }

  const quotedStart = valueStart + 1;
  let searchIndex = quotedStart;
  while (searchIndex < source.length) {
    const quoteIndex = source.indexOf('"', searchIndex);
    if (quoteIndex < 0) break;
    const tail = source.slice(quoteIndex + 1);
    if (/^\s*(?:,\s*[A-Za-z_][\w]*=|\}\s*$)/.test(tail)) {
      return decodeQuotedFieldValue(source.slice(quotedStart, quoteIndex));
    }
    searchIndex = quoteIndex + 1;
  }
  return '';
}

function normalizeApiKey(api?: string): string {
  if (!api) return '-';
  try {
    const parsed = new URL(api.replace(/^"|"$/g, ''));
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return api.split('?')[0] || api;
  }
}

function normalizeApiPath(api?: string): string {
  if (!api) return '-';
  try {
    const parsed = new URL(api.replace(/^"|"$/g, ''));
    return `${parsed.pathname}${parsed.search || ''}`;
  } catch {
    const value = api.replace(/^"|"$/g, '');
    return value.replace(/^https?:\/\/[^/]+/i, '') || value;
  }
}

function parseJsonValue(value?: string): JsonValue | null {
  if (!value || value === '-') return '';
  const candidates = [
    value,
    value.replace(/\\\\(?=")/g, '\\'),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as JsonValue;
    } catch {
      // 尝试下一种转义层级。
    }
  }
  return null;
}

function formatJsonText(value?: string): string {
  const parsed = parseJsonValue(value);
  if (parsed === null) {
    return '';
  }
  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return '';
  }
}

function formatJsonPrimitive(value: JsonValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  return String(value);
}

function getJsonNodeSummary(value: JsonValue): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value && typeof value === 'object') return `Object(${Object.keys(value).length})`;
  return formatJsonPrimitive(value);
}

function buildJsonTreeData(value: JsonValue, keyword: string, key = 'root', label = 'root'): any[] {
  const lowerKeyword = keyword.trim().toLowerCase();
  const renderLabel = (nodeLabel: string, nodeValue: JsonValue) => {
    const valueText = getJsonNodeSummary(nodeValue);
    const text = `${nodeLabel}: ${valueText}`;
    return <span>{highlightText(text, lowerKeyword)}</span>;
  };

  const makeNode = (nodeValue: JsonValue, nodeKey: string, nodeLabel: string): any => {
    if (Array.isArray(nodeValue)) {
      return {
        key: nodeKey,
        title: renderLabel(nodeLabel, nodeValue),
        children: nodeValue.map((item, index) => makeNode(item, `${nodeKey}.${index}`, `[${index}]`)),
      };
    }
    if (nodeValue && typeof nodeValue === 'object') {
      return {
        key: nodeKey,
        title: renderLabel(nodeLabel, nodeValue),
        children: Object.entries(nodeValue).map(([childKey, childValue]) => makeNode(childValue, `${nodeKey}.${childKey}`, childKey)),
      };
    }
    return {
      key: nodeKey,
      title: renderLabel(nodeLabel, nodeValue),
    };
  };

  return [makeNode(value, key, label)];
}

function getDefaultExpandedJsonKeys(value: JsonValue, maxDepth = 2, key = 'root', depth = 0): string[] {
  if (depth >= maxDepth || value === null || typeof value !== 'object') {
    return [];
  }
  const keys = [key];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [`${index}`, item] as const)
    : Object.entries(value);
  entries.forEach(([childKey, childValue]) => {
    keys.push(...getDefaultExpandedJsonKeys(childValue, maxDepth, `${key}.${childKey}`, depth + 1));
  });
  return keys;
}

function getMatchedJsonKeys(value: JsonValue, keyword: string, key = 'root', label = 'root'): string[] {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return [];
  const keys = new Set<string>();
  const walk = (nodeValue: JsonValue, nodeKey: string, nodeLabel: string, ancestors: string[]) => {
    const text = `${nodeLabel}: ${getJsonNodeSummary(nodeValue)}`.toLowerCase();
    if (text.includes(normalizedKeyword)) {
      [...ancestors, nodeKey].forEach((item) => keys.add(item));
    }
    if (Array.isArray(nodeValue)) {
      nodeValue.forEach((item, index) => walk(item, `${nodeKey}.${index}`, `[${index}]`, [...ancestors, nodeKey]));
    } else if (nodeValue && typeof nodeValue === 'object') {
      Object.entries(nodeValue).forEach(([childKey, childValue]) => walk(childValue, `${nodeKey}.${childKey}`, childKey, [...ancestors, nodeKey]));
    }
  };
  walk(value, key, label, []);
  return Array.from(keys);
}

function removeResponseFieldFromLogLine(line: string): string {
  if (!line || line === '-') return line;
  return line
    .replace(/,\s*response="(?:\\.|[^"\\])*"(?=,\s*[A-Za-z_][\w]*=|\})/g, '')
    .replace(/\sresponse="(?:\\.|[^"\\])*",\s*/g, ' ')
    .replace(/\sresponse="(?:\\.|[^"\\])*"(?=\})/g, '');
}

function extractResponseFieldFromLogLine(line: string): string {
  if (!line || line === '-') return '';
  return extractFieldValue(line, 'response');
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 回退到 textarea 复制。
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', 'true');
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '0';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  textArea.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    document.body.removeChild(textArea);
  }
  return copied;
}

function parseBusinessLogLine(line: string): ParsedBusinessLog {
  const time = line.match(/^\[([^\]]+)\]/)?.[1] || '';
  const categoryMatches = [...line.matchAll(/\[([A-Za-z][A-Za-z0-9_+\-.]*)\]/g)].map((item) => item[1]);
  const category = categoryMatches.find((item) => item !== time && !item.includes(':')) || '业务';
  const event = line.match(/\bevent=([A-Za-z0-9_:.+-]+)/)?.[1] || 'raw_log';
  const fieldsText = line.match(/\bfields=\{([\s\S]*)\}\s*$/)?.[1] || '';
  const fields = fieldsText ? parseFields(fieldsText) : {};
  const retCode = fields.retCode;
  const level = /⚠️|\[Warning\]|error|fail|exception/i.test(line) || (retCode && !['0', '100', '200'].includes(retCode))
    ? 'warning'
    : 'info';
  return { time, category, event, level, fields, line };
}

function topCounts(values: string[], limit = 12) {
  const counts = new Map<string, number>();
  values.filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([event, count]) => ({ event, count }));
}

function getLogModuleGroup(log: ParsedBusinessLog): { key: string; label: string } {
  const label = log.category && log.category !== '业务' ? log.category : '未分类';
  const key = label.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_') || 'unknown';
  return { key, label };
}

function analyzeBusinessLogLines(lines: string[], source: string): BusinessLogAnalysis {
  const parsedLogs = lines.map(parseBusinessLogLine);
  const apiRequests = parsedLogs.filter((log) => log.event === 'api_request');
  const apiResponses = parsedLogs.filter((log) => log.event === 'api_response');
  const failedResponses = apiResponses.filter((log) => {
    const retCode = log.fields.retCode;
    return retCode && !['0', '100', '200'].includes(retCode);
  });
  const slowResponses = apiResponses
    .filter((log) => Number(log.fields.costMs || 0) >= 500)
    .sort((left, right) => Number(right.fields.costMs || 0) - Number(left.fields.costMs || 0))
    .slice(0, 20);

  const apiMap = new Map<string, { requestCount: number; responseCount: number; failedCount: number; totalCostMs: number; costCount: number; maxCostMs: number }>();
  [...apiRequests, ...apiResponses].forEach((log) => {
    const api = normalizeApiKey(log.fields.api);
    const item = apiMap.get(api) || { requestCount: 0, responseCount: 0, failedCount: 0, totalCostMs: 0, costCount: 0, maxCostMs: 0 };
    if (log.event === 'api_request') item.requestCount += 1;
    if (log.event === 'api_response') {
      item.responseCount += 1;
      const costMs = Number(log.fields.costMs || 0);
      if (costMs > 0) {
        item.totalCostMs += costMs;
        item.costCount += 1;
        item.maxCostMs = Math.max(item.maxCostMs, costMs);
      }
      const retCode = log.fields.retCode;
      if (retCode && !['0', '100', '200'].includes(retCode)) item.failedCount += 1;
    }
    apiMap.set(api, item);
  });

  const apiStats = Array.from(apiMap.entries())
    .map(([api, stat]) => ({
      api,
      requestCount: stat.requestCount,
      responseCount: stat.responseCount,
      failedCount: stat.failedCount,
      maxCostMs: stat.maxCostMs,
      avgCostMs: stat.costCount ? Math.round(stat.totalCostMs / stat.costCount) : 0,
    }))
    .sort((left, right) => right.failedCount - left.failedCount || right.maxCostMs - left.maxCostMs || right.requestCount - left.requestCount)
    .slice(0, 30);

  const responsesByNntid = new Map<string, ParsedBusinessLog[]>();
  apiResponses.forEach((response) => {
    const nntid = response.fields.nntid || '';
    if (!nntid) return;
    responsesByNntid.set(nntid, [...(responsesByNntid.get(nntid) || []), response]);
  });
  const usedResponses = new Set<ParsedBusinessLog>();
  const apiTimeline: ApiTimelineRow[] = apiRequests.map((request, index) => {
    const nntid = request.fields.nntid || '';
    const response = nntid ? responsesByNntid.get(nntid)?.shift() : undefined;
    if (response) usedResponses.add(response);
    const retCode = response?.fields.retCode || '';
    const status: 'success' | 'failed' | 'pending' = response
      ? (retCode && !['0', '100', '200'].includes(retCode) ? 'failed' : 'success')
      : 'pending';
    return {
      key: `${nntid || request.time}-${index}`,
      requestTime: request.time,
      responseTime: response?.time || '-',
      api: normalizeApiKey(request.fields.api || response?.fields.api),
      costMs: response?.fields.costMs ? Number(response.fields.costMs) : null,
      retCode: retCode || '-',
      retMsg: response?.fields.retMsg || '-',
      nntid: nntid || '-',
      trackId: response?.fields.trackId || '-',
      parameters: request.fields.parameters || '-',
      responseBody: response?.fields.response || extractResponseFieldFromLogLine(response?.line || '') || '-',
      requestLine: request.line,
      responseLine: response?.line || '-',
      fullApi: request.fields.api || response?.fields.api || '-',
      status,
    };
  });
  apiResponses.forEach((response, index) => {
    if (usedResponses.has(response)) return;
    const retCode = response.fields.retCode || '';
    const status: 'success' | 'failed' = retCode && !['0', '100', '200'].includes(retCode) ? 'failed' : 'success';
    apiTimeline.push({
      key: `response-only-${response.fields.nntid || response.time}-${index}`,
      requestTime: response.time || '-',
      responseTime: response.time || '-',
      api: normalizeApiKey(response.fields.api),
      costMs: response.fields.costMs ? Number(response.fields.costMs) : null,
      retCode: retCode || '-',
      retMsg: response.fields.retMsg || '-',
      nntid: response.fields.nntid || '-',
      trackId: response.fields.trackId || '-',
      parameters: '-',
      responseBody: response.fields.response || extractResponseFieldFromLogLine(response.line) || '-',
      requestLine: '-',
      responseLine: response.line,
      fullApi: response.fields.api || '-',
      status,
    });
  });

  const requestNntids = new Set(apiRequests.map((log) => log.fields.nntid).filter(Boolean));
  const responseNntids = new Set(apiResponses.map((log) => log.fields.nntid).filter(Boolean));
  let nntidIssueCount = 0;
  requestNntids.forEach((nntid) => {
    if (!responseNntids.has(nntid)) nntidIssueCount += 1;
  });

  const versions = Array.from(new Set(parsedLogs.map((log) => log.fields.version).filter(Boolean))).slice(0, 8);
  const userIds = Array.from(new Set(parsedLogs.flatMap((log) => {
    const raw = `${log.fields.userId || ''} ${log.fields.parameters || ''}`;
    return [...raw.matchAll(/\buserId"?[:=]?"?(\d{5,})/g)].map((item) => item[1]);
  }))).slice(0, 8);

  const suggestions: string[] = [];
  if (failedResponses.length) suggestions.push(`发现 ${failedResponses.length} 条非成功 retCode，优先查看异常响应列表。`);
  if (slowResponses.length) suggestions.push(`发现 ${slowResponses.length} 条接口耗时 >= 500ms，建议关注慢请求 Top。`);
  if (nntidIssueCount) suggestions.push(`发现 ${nntidIssueCount} 个请求 nntid 未匹配到响应，可能存在超时、丢日志或请求未完成。`);
  if (!suggestions.length) suggestions.push('未发现明显异常 retCode 或慢请求，可结合用户操作路径继续检索关键 event。');

  const groupMap = new Map<string, { key: string; label: string; logs: ParsedBusinessLog[] }>();
  parsedLogs.forEach((log) => {
    const group = getLogModuleGroup(log);
    const item = groupMap.get(group.key) || { ...group, logs: [] };
    item.logs.push(log);
    groupMap.set(group.key, item);
  });
  const functionGroups = Array.from(groupMap.values())
    .sort((left, right) => {
      const leadingOrder = ['API', 'Login', 'Community'];
      const trailingOrder = ['未分类', 'Warning', 'Error', 'Debug'];
      const leftLeadingIndex = leadingOrder.indexOf(left.label);
      const rightLeadingIndex = leadingOrder.indexOf(right.label);
      if (leftLeadingIndex !== -1 || rightLeadingIndex !== -1) {
        if (leftLeadingIndex === -1) return 1;
        if (rightLeadingIndex === -1) return -1;
        return leftLeadingIndex - rightLeadingIndex;
      }
      const leftTrailingIndex = trailingOrder.indexOf(left.label);
      const rightTrailingIndex = trailingOrder.indexOf(right.label);
      if (leftTrailingIndex !== -1 || rightTrailingIndex !== -1) {
        if (leftTrailingIndex === -1) return -1;
        if (rightTrailingIndex === -1) return 1;
        return leftTrailingIndex - rightTrailingIndex;
      }
      if (left.label === 'IM' && right.label === 'RTC') return -1;
      if (left.label === 'RTC' && right.label === 'IM') return 1;
      return 0;
    })
    .map((group) => ({
      ...group,
      warnings: group.logs.filter((log) => log.level !== 'info').length,
      eventCounts: topCounts(group.logs.map((log) => log.event), 8),
    }));

  return {
    source,
    total: parsedLogs.length,
    timeRange: parsedLogs.length ? `${parsedLogs[0].time || '-'} ~ ${parsedLogs[parsedLogs.length - 1].time || '-'}` : '-',
    warnings: parsedLogs.filter((log) => log.level !== 'info').length,
    apiRequests: apiRequests.length,
    apiResponses: apiResponses.length,
    failedResponses: failedResponses.slice(0, 30),
    slowResponses,
    eventCounts: topCounts(parsedLogs.map((log) => log.event), 16),
    apiStats,
    apiTimeline,
    retCodeCounts: topCounts(apiResponses.map((log) => log.fields.retCode || 'empty'), 12).map((item) => ({ retCode: item.event, count: item.count })),
    versions,
    userIds,
    nntidIssueCount,
    suggestions,
    functionGroups,
  };
}

export default function LogsPairPage({ embedded = false, pairingMode = 'inline' }: LogsPairPageProps = {}) {
  const usePairingModal = pairingMode === 'modal';
  const [state, setState] = useState<ConnectionState>('idle');
  const [session, setSession] = useState<PairingSessionData | null>(null);
  const [pairingStatus, setPairingStatus] = useState<PairingStatusData | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [qrValue, setQrValue] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [activeLogChannel, setActiveLogChannel] = useState<LogChannel>('business');
  const [logSearchText, setLogSearchText] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState('');
  const [appConnectionState, setAppConnectionState] = useState<AppConnectionState>('unknown');
  const [devices, setDevices] = useState<RealtimeLogDeviceData[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [isDownloadingLogs, setIsDownloadingLogs] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [centerSuccessText, setCenterSuccessText] = useState('');
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<BusinessLogAnalysis | null>(null);
  const [apiResponseJsonSearchText, setApiResponseJsonSearchText] = useState('');
  const [apiSearchText, setApiSearchText] = useState('');

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef<PairingSessionData | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const logIdRef = useRef(0);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const refreshAfterOpenRef = useRef(false);
  const centerSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logArchiveRef = useRef<{
    requestId: string;
    fileName: string;
    totalBytes: number;
    receivedBytes: number;
    chunks: Uint8Array[];
  } | null>(null);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, activeLogChannel, autoScroll]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      stopPolling();
      disconnectWs();
      if (centerSuccessTimerRef.current) {
        clearTimeout(centerSuccessTimerRef.current);
        centerSuccessTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    loadDevices();
    const timer = setInterval(loadDevices, 5000);
    return () => clearInterval(timer);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const disconnectWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const loadDevices = async () => {
    try {
      setDevicesLoading(true);
      const response = await pairingApi.listDevices();
      if (response.success && response.data) {
        setDevices(response.data);
      }
    } catch {
      // 设备列表只是辅助入口，失败不影响扫码链路。
    } finally {
      setDevicesLoading(false);
    }
  };

  const showCenterSuccess = (text: string) => {
    if (centerSuccessTimerRef.current) {
      clearTimeout(centerSuccessTimerRef.current);
    }
    setCenterSuccessText(text);
    centerSuccessTimerRef.current = setTimeout(() => {
      setCenterSuccessText('');
      centerSuccessTimerRef.current = null;
    }, 1600);
  };

  const openBusinessLogAnalysis = () => {
    const lines = businessLogs.map((log) => normalizeDisplayLine(log.message || log.raw, 'business'));
    if (lines.length === 0) {
      message.warning('当前没有业务日志可分析');
      return;
    }
    setAnalysisResult(analyzeBusinessLogLines(lines, '实时业务日志'));
    setAnalysisOpen(true);
  };

  const normalizeLogChannel = (channel?: string, line?: string): LogChannel => {
    if (channel === 'im' || channel === 'rtc') {
      return channel;
    }
    if (line && (line.includes('[IMSDK]') || /\[nnimsdk-[^\]]+\]/.test(line))) {
      return 'im';
    }
    if (line && (line.includes('[RTCSDK]') || /\[nnrtc-[^\]]+\]/i.test(line))) {
      return 'rtc';
    }
    return 'business';
  };

  const normalizeDisplayLine = (line: string, channel: LogChannel): string => {
    if (channel === 'im') {
      return sdkRawLog(line, '[IMSDK]');
    }
    if (channel === 'rtc') {
      return sdkRawLog(line, '[RTCSDK]');
    }
    return line;
  };

  const sdkRawLog = (line: string, marker: string): string => {
    const markerIndex = line.indexOf(marker);
    if (markerIndex < 0) {
      return line;
    }
    const rawLog = line.slice(markerIndex + marker.length).trim();
    return rawLog || marker;
  };

  const effectiveLogChannel = (log: LogEntry): LogChannel => {
    return normalizeLogChannel(log.channel, `${log.message}\n${log.raw}`);
  };

  const logChannelLabel = (channel: LogChannel): string => {
    switch (channel) {
      case 'im':
        return 'IM';
      case 'rtc':
        return 'RTC';
      default:
        return '业务';
    }
  };

  /**
   * 开始配对流程
   */
  const startPairing = async () => {
    try {
      if (usePairingModal) {
        setQrModalOpen(true);
      }
      if ((state === 'qrcode' || state === 'polling') && sessionRef.current) {
        pairingApi.delete(sessionRef.current.pairingId).catch(() => {});
      }
      stopPolling();
      disconnectWs();
      setState('qrcode');
      setErrorMsg('');
      setPairingStatus(null);
      setLogs([]);
      setLastHeartbeatAt('');
      setAppConnectionState('unknown');

      const response = await pairingApi.create();
      if (!response.success || !response.data) {
        throw new Error('创建配对会话失败');
      }

      const { pairingId, token } = response.data;
      const wsUrl = normalizeWebSocketURL(response.data.wsUrl);
      const wsUrls = normalizeWebSocketURLs(response.data.wsUrls || []);
      const resolvedWsUrls = wsUrl ? [wsUrl, ...wsUrls.filter((item) => item !== wsUrl)] : wsUrls;
      const pairingWsUrl = wsUrl || resolvedWsUrls[0];
      if (!pairingWsUrl) {
        throw new Error('WebSocket 地址为空，请重新生成二维码');
      }
      const nextSession = { pairingId, token, wsUrl, wsUrls: resolvedWsUrls };
      setSession(nextSession);

      // 生成二维码内容
      // App 扫码后只连接明确的 nn-ios-platform WebSocket 服务地址。
      const qrData = JSON.stringify({
        type: 'nn_log_pair',
        p: pairingId,
        t: token,
        u: resolvedWsUrls,
      });
      setQrValue(qrData);

      // 开始轮询配对状态（等待 App WebSocket 连接）
      setState('polling');
      startPolling(pairingId, nextSession);
    } catch (error: any) {
      setState('error');
      setErrorMsg(error?.error || error?.message || '创建配对会话失败');
    }
  };

  /**
   * 轮询配对状态
   */
  const startPolling = (pairingId: string, targetSession: PairingSessionData) => {
    stopPolling();

    pollingRef.current = setInterval(async () => {
      try {
        const response = await pairingApi.getStatus(pairingId);
        if (!response.success || !response.data) {
          stopPolling();
          setState('error');
          setErrorMsg(response.error || '配对会话不存在或已过期，请重新生成二维码');
          return;
        }

        const data = response.data;
        setPairingStatus(data);

        if (data.status === 'paired' || data.status === 'streaming') {
          stopPolling();
          setState('paired');
          setQrModalOpen(false);
          loadDevices();
          showCenterSuccess('设备配对成功，正在打开日志页面');
          connectLogStream(targetSession);
        } else if (data.status === 'expired') {
          stopPolling();
          setState('error');
          setErrorMsg('配对会话已过期，请重新生成二维码');
        }
      } catch {
        stopPolling();
        setState('error');
        setErrorMsg('配对会话不存在或已过期，请重新生成二维码');
      }
    }, 1500);
  };

  /**
   * 构建浏览器端 WebSocket 地址
   */
  const makeBrowserLogWebSocketURL = (targetSession: PairingSessionData | null = session): string | null => {
    if (!targetSession) {
      message.error('配对会话不存在，请重新生成二维码');
      return null;
    }

    const { pairingId, token, wsUrl, wsUrls } = targetSession;
    const baseWsUrl = wsUrl || wsUrls[0];
    if (!baseWsUrl) {
      message.error('WebSocket 地址为空，请重新生成二维码');
      return null;
    }

    const logWsUrl = new URL(baseWsUrl);
    logWsUrl.searchParams.set('role', 'browser');
    logWsUrl.searchParams.set('pairingId', pairingId);
    logWsUrl.searchParams.set('token', token);
    return logWsUrl.toString();
  };

  /**
   * 连接 WebSocket 接收日志流
   */
  const connectLogStream = (targetSession: PairingSessionData | null = session) => {
    if (wsRef.current
      && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      setState('streaming');
      return;
    }

    const logWsUrl = makeBrowserLogWebSocketURL(targetSession);
    if (!logWsUrl) return;

    const ws = new WebSocket(logWsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setState('streaming');
      setAppConnectionState('waiting');
      if (refreshAfterOpenRef.current) {
        refreshAfterOpenRef.current = false;
        ws.send(JSON.stringify({
          type: 'command',
          command: 'refreshLogs',
          requestId: makeRequestId(),
        }));
      }
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return;
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'status' && data.status === 'app_disconnected') {
          setAppConnectionState('disconnected');
          message.warning('设备已断开连接');
          return;
        }
        if (data.type === 'status') {
          if (data.status === 'app_connected') {
            setAppConnectionState('connected');
            return;
          }
          if (data.status === 'waiting_app') {
            setAppConnectionState('waiting');
            return;
          }
          return;
        }
        if (data.type === 'heartbeat') {
          setAppConnectionState('connected');
          setLastHeartbeatAt(data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString());
          return;
        }
        if (data.type === 'clear_logs') {
          setLogs([]);
          logIdRef.current = 0;
          return;
        }
        if (data.type === 'deviceInfo') {
          setPairingStatus((prev) => ({
            status: prev?.status || 'paired',
            deviceInfo: data.deviceInfo,
          }));
          return;
        }
        if (data.type === 'logArchivePreparing') {
          setIsDownloadingLogs(true);
          setDownloadProgress(0);
          message.info('正在打包 NN 日志...');
          return;
        }
        if (data.type === 'logArchiveStart') {
          logArchiveRef.current = {
            requestId: data.requestId,
            fileName: data.fileName || `nn-logs-${Date.now()}.zip`,
            totalBytes: Number(data.totalBytes || 0),
            receivedBytes: 0,
            chunks: [],
          };
          setIsDownloadingLogs(true);
          setDownloadProgress(0);
          return;
        }
        if (data.type === 'logArchiveChunk') {
          appendLogArchiveChunk(data);
          return;
        }
        if (data.type === 'logArchiveFinished') {
          finishLogArchiveDownload(data.requestId);
          return;
        }
        if (data.type === 'logArchiveFailed') {
          logArchiveRef.current = null;
          setIsDownloadingLogs(false);
          setDownloadProgress(0);
          message.error(data.message || 'NN 日志下载失败');
          return;
        }

        if (data.type !== 'log') {
          return;
        }

        const line = data.line || data.message || event.data;
        const channel = normalizeLogChannel(data.channel, line);
        const entry: LogEntry = {
          id: ++logIdRef.current,
          timestamp: data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString(),
          channel,
          message: normalizeDisplayLine(line, channel),
          raw: event.data,
        };
        setLogs((prev) => {
          const next = [...prev, entry];
          return next.length > MAX_RENDERED_LOG_COUNT ? next.slice(-MAX_RENDERED_LOG_COUNT) : next;
        });
      } catch {
        // 非 JSON 格式，直接作为日志文本
        const entry: LogEntry = {
          id: ++logIdRef.current,
          timestamp: new Date().toLocaleTimeString(),
          channel: 'business',
          message: event.data,
          raw: event.data,
        };
        setLogs((prev) => {
          const next = [...prev, entry];
          return next.length > MAX_RENDERED_LOG_COUNT ? next.slice(-MAX_RENDERED_LOG_COUNT) : next;
        });
      }
    };

    ws.onerror = () => {
      message.error('WebSocket 连接错误');
    };

    ws.onclose = (event) => {
      if (event.code !== 1000) {
        message.warning('日志流连接已断开');
      }
      if (wsRef.current === ws) {
        setAppConnectionState('disconnected');
        wsRef.current = null;
      }
    };
  };

  const requestNNLogsDownload = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      message.warning('日志流未连接，无法下载 NN 日志');
      return;
    }
    const requestId = makeRequestId();
    logArchiveRef.current = null;
    setIsDownloadingLogs(true);
    setDownloadProgress(0);
    ws.send(JSON.stringify({
      type: 'command',
      command: 'downloadLogs',
      requestId,
    }));
  };

  const requestRefreshLogs = (targetSession?: PairingSessionData) => {
    const currentSession = targetSession || sessionRef.current || session;
    if (!currentSession) {
      message.warning('当前没有可刷新的设备连接');
      return;
    }

    setLogs([]);
    logIdRef.current = 0;
    setLastHeartbeatAt('');

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      refreshAfterOpenRef.current = true;
      connectLogStream(currentSession);
      return;
    }

    wsRef.current.send(JSON.stringify({
      type: 'command',
      command: 'refreshLogs',
      requestId: makeRequestId(),
    }));
    message.success('已刷新日志流');
  };

  const appendLogArchiveChunk = (data: any) => {
    const archive = logArchiveRef.current;
    if (!archive || archive.requestId !== data.requestId || typeof data.data !== 'string') return;

    const bytes = base64ToUint8Array(data.data);
    const index = Number(data.index || 0);
    archive.chunks[index] = bytes;
    archive.receivedBytes += bytes.byteLength;
    if (archive.totalBytes > 0) {
      setDownloadProgress(Math.min(99, Math.floor((archive.receivedBytes / archive.totalBytes) * 100)));
    }
  };

  const finishLogArchiveDownload = (requestId: string) => {
    const archive = logArchiveRef.current;
    if (!archive || archive.requestId !== requestId) return;

    const blobParts = archive.chunks.map((chunk) => {
      const copy = new Uint8Array(chunk.byteLength);
      copy.set(chunk);
      return copy.buffer;
    });
    const blob = new Blob(blobParts, { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = archive.fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    logArchiveRef.current = null;
    setIsDownloadingLogs(false);
    setDownloadProgress(100);
    message.success('NN 日志已下载到电脑');
  };

  const enterDeviceLogStream = (device: RealtimeLogDeviceData) => {
    stopPolling();
    disconnectWs();
    const targetSession: PairingSessionData = {
      pairingId: device.pairingId,
      token: device.token,
      wsUrl: device.wsUrl,
      wsUrls: device.wsUrls || (device.wsUrl ? [device.wsUrl] : []),
    };
    setSession(targetSession);
    sessionRef.current = targetSession;
    setPairingStatus(device);
    setLastHeartbeatAt(device.lastActiveAt ? new Date(device.lastActiveAt).toLocaleTimeString() : '');
    setAppConnectionState(device.appConnected ? 'connected' : 'waiting');
    connectLogStream(targetSession);
  };

  const reconnectDeviceLogStream = (device: RealtimeLogDeviceData) => {
    const targetSession: PairingSessionData = {
      pairingId: device.pairingId,
      token: device.token,
      wsUrl: device.wsUrl,
      wsUrls: device.wsUrls || (device.wsUrl ? [device.wsUrl] : []),
    };
    enterDeviceLogStream(device);
    requestRefreshLogs(targetSession);
  };

  const stopViewing = () => {
    disconnectWs();
    setState('idle');
    setSession(null);
    setPairingStatus(null);
    setQrValue('');
    setLastHeartbeatAt('');
    setAppConnectionState('unknown');
    setLogs([]);
    loadDevices();
  };

  const removeDevice = async (device: RealtimeLogDeviceData) => {
    try {
      await pairingApi.delete(device.pairingId);
      if (sessionRef.current?.pairingId === device.pairingId) {
        stopViewing();
      } else {
        loadDevices();
      }
      message.success('设备已移出');
    } catch (error: any) {
      message.error(error?.error || error?.message || '移出设备失败');
    }
  };

  /**
   * 断开连接，重置状态
   */
  const disconnect = () => {
    stopPolling();
    disconnectWs();
    if (session) {
      pairingApi.delete(session.pairingId).catch(() => {});
    }
    setState('idle');
    setSession(null);
    setPairingStatus(null);
    setQrValue('');
    setErrorMsg('');
    setLastHeartbeatAt('');
    setAppConnectionState('unknown');
    setLogs([]);
    setQrModalOpen(false);
    loadDevices();
  };

  const getAppConnectionTag = () => {
    switch (appConnectionState) {
      case 'connected':
        return <Tag color="green" icon={<CheckCircleOutlined />}>App 已连接</Tag>;
      case 'waiting':
        return <Tag color="gold">等待 App 重连</Tag>;
      case 'disconnected':
        return <Tag color="red">App 已断开</Tag>;
      default:
        return null;
    }
  };

  const getEmptyLogText = (): string => {
    if (appConnectionState === 'connected') {
      return lastHeartbeatAt
        ? `设备已连接，等待新的${logChannelLabel(activeLogChannel)}日志... 最近心跳 ${lastHeartbeatAt}`
        : `设备已连接，等待新的${logChannelLabel(activeLogChannel)}日志...`;
    }
    if (appConnectionState === 'waiting') {
      return '浏览器已连接，等待 App 重连...';
    }
    if (appConnectionState === 'disconnected') {
      return 'App 已断开，请重启 App 自动重连；如果后端服务重启过，请重新扫码';
    }
    return '等待日志数据...';
  };

  const businessLogs = logs.filter((log) => effectiveLogChannel(log) === 'business');
  const imLogs = logs.filter((log) => effectiveLogChannel(log) === 'im');
  const rtcLogs = logs.filter((log) => effectiveLogChannel(log) === 'rtc');
  const activeLogs = logs.filter((log) => effectiveLogChannel(log) === activeLogChannel);
  const normalizedLogSearchText = logSearchText.trim().toLowerCase();
  const visibleLogs = normalizedLogSearchText
    ? activeLogs.filter((log) => `${log.message}\n${log.raw}`.toLowerCase().includes(normalizedLogSearchText))
    : activeLogs;

  const renderApiTimelineTable = (dataSource: ApiTimelineRow[], pageSize = 20) => {
    const normalizedApiSearchText = apiSearchText.trim().toLowerCase();
    const filteredDataSource = normalizedApiSearchText
      ? dataSource.filter((record) => `${record.fullApi}\n${normalizeApiPath(record.fullApi)}\n${record.api}`.toLowerCase().includes(normalizedApiSearchText))
      : dataSource;

    return (
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Space>
          <Input.Search
            allowClear
            placeholder="检索接口"
            value={apiSearchText}
            onChange={(event) => setApiSearchText(event.target.value)}
            style={{ width: 360 }}
          />
          {normalizedApiSearchText && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              命中 {filteredDataSource.length} 条
            </Text>
          )}
        </Space>
        <Table
          size="small"
          bordered
          rowKey="key"
          dataSource={filteredDataSource}
          pagination={filteredDataSource.length > pageSize ? { pageSize } : false}
      scroll={{ x: 900 }}
      expandable={{
        expandedRowRender: (record) => {
          const responseBody = record.responseBody || extractResponseFieldFromLogLine(record.responseLine);
          const parsedResponse = parseJsonValue(responseBody);
          const formattedResponse = formatJsonText(responseBody);
          const responseJsonSearchKeyword = apiResponseJsonSearchText.trim();
          const expandedJsonKeys = parsedResponse && responseJsonSearchKeyword
            ? getMatchedJsonKeys(parsedResponse, responseJsonSearchKeyword)
            : parsedResponse
              ? getDefaultExpandedJsonKeys(parsedResponse)
              : [];
          return (
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Text type="secondary">完整接口：{record.fullApi}</Text>
              <Text type="secondary">参数：{record.parameters}</Text>
              <Text type="secondary">nntid：{record.nntid}</Text>
              <Text type="secondary">trackId：{record.trackId}</Text>
              <Text code style={{ display: 'block', whiteSpace: 'pre-wrap' }}>请求：{record.requestLine}</Text>
              <Text code style={{ display: 'block', whiteSpace: 'pre-wrap' }}>响应：{removeResponseFieldFromLogLine(record.responseLine)}</Text>
              {formattedResponse ? (
                <div>
                  <Space style={{ marginBottom: 6 }}>
                    <Text type="secondary">响应 JSON：</Text>
                    <Input.Search
                      allowClear
                      size="small"
                      placeholder="检索响应 JSON"
                      value={apiResponseJsonSearchText}
                      onChange={(event) => setApiResponseJsonSearchText(event.target.value)}
                      style={{ width: 240 }}
                    />
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={async () => {
                        const copied = await copyTextToClipboard(formattedResponse);
                        if (copied) {
                          message.success('已复制响应 JSON');
                        } else {
                          message.error('复制失败，请手动选中复制');
                        }
                      }}
                    >
                      复制
                    </Button>
                  </Space>
                  <div
                    style={{
                      padding: 8,
                      background: '#f6f8fa',
                      border: '1px solid #f0f0f0',
                      borderRadius: 4,
                      maxHeight: 420,
                      overflow: 'auto',
                    }}
                  >
                    {parsedResponse ? (
                      <Tree
                        key={`${record.key}-${responseJsonSearchKeyword}`}
                        blockNode
                        defaultExpandAll={false}
                        defaultExpandedKeys={expandedJsonKeys}
                        treeData={buildJsonTreeData(parsedResponse, responseJsonSearchKeyword)}
                        style={{ background: 'transparent', fontFamily: 'Menlo, Monaco, Consolas, monospace', fontSize: 12 }}
                      />
                    ) : (
                      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {highlightText(formattedResponse, responseJsonSearchKeyword)}
                      </pre>
                    )}
                  </div>
                </div>
              ) : (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  未采集 response 字段，当前响应日志没有可格式化的 JSON。
                </Text>
              )}
            </Space>
          );
        },
      }}
      columns={[
        { title: '请求时间', dataIndex: 'requestTime', width: 150 },
        {
          title: '耗时',
          dataIndex: 'costMs',
          width: 90,
          sorter: (a, b) => (a.costMs || 0) - (b.costMs || 0),
          render: (value: number | null) => {
            if (value === null) return '-';
            return value > 350 ? <Tag color="orange">{value}ms</Tag> : `${value}ms`;
          },
        },
        {
          title: '结果',
          key: 'result',
          width: 220,
          render: (_, record) => {
            const color = record.status === 'failed' ? 'red' : record.status === 'pending' ? 'gold' : 'green';
            const text = record.status === 'pending'
              ? '无响应'
              : `${record.retCode}${record.retMsg && record.retMsg !== '-' ? ` / ${record.retMsg}` : ''}`;
            return <Tag color={color}>{text}</Tag>;
          },
        },
        {
          title: '接口',
          dataIndex: 'fullApi',
          ellipsis: true,
          render: (value: string) => highlightText(normalizeApiPath(value), apiSearchText.trim()),
        },
      ]}
        />
      </Space>
    );
  };

  return (
    <div>
      {centerSuccessText && (
        <div
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 2000,
            maxWidth: 'calc(100vw - 48px)',
            minWidth: 280,
            padding: '18px 24px',
            borderRadius: 12,
            background: '#f6ffed',
            border: '1px solid #b7eb8f',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.16)',
            textAlign: 'center',
            whiteSpace: 'normal',
          }}
        >
          <Space size={12}>
            <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 22 }} />
            <Text strong>{centerSuccessText}</Text>
          </Space>
        </div>
      )}

      {!embedded && (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <Title level={4}>
              <MobileOutlined style={{ marginRight: 8, color: '#1677ff' }} />
              实时日志 - 扫码配对
            </Title>
            <Paragraph type="secondary">
              通过 NN App 扫描二维码，连接设备实时日志服务，在浏览器中查看设备运行日志
            </Paragraph>
          </div>
          {state !== 'streaming' && (
            <Button type="primary" icon={<QrcodeOutlined />} onClick={startPairing}>
              生成配对二维码
            </Button>
          )}
        </div>
      )}

      {(devices.length > 0 || embedded) && state !== 'streaming' && (
        <Card
          title="已连接设备"
          extra={
            <Space>
              <Button size="small" icon={<ReloadOutlined />} onClick={loadDevices}>刷新</Button>
              {embedded && (
                <Button size="small" type="primary" icon={<QrcodeOutlined />} onClick={startPairing}>
                  打开实时日志（蒲公英）
                </Button>
              )}
            </Space>
          }
          style={{ marginBottom: embedded ? 0 : 24 }}
        >
          <Table
            rowKey="pairingId"
            size="small"
            loading={devicesLoading}
            pagination={false}
            dataSource={devices}
            locale={{ emptyText: '暂无已连接设备，请点击右上角打开实时日志（蒲公英）' }}
            columns={[
              {
                title: '设备',
                key: 'device',
                render: (_, record) => (
                  <Space direction="vertical" size={0}>
                    <Space>
                      <MobileOutlined />
                      <span>{deviceDisplayName(record.deviceInfo)}</span>
                      {record.deviceInfo?.model && <Tag>{record.deviceInfo.model}</Tag>}
                    </Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      设备ID: {record.deviceInfo?.appDeviceId || '-'}
                    </Text>
                  </Space>
                ),
              },
              {
                title: '用户',
                key: 'user',
                render: (_, record) => (
                  <Space direction="vertical" size={0}>
                    <span>{record.deviceInfo?.nickName || '-'}</span>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      NN: {record.deviceInfo?.nnNumber || '-'}
                      {record.deviceInfo?.userId ? ` / UID: ${record.deviceInfo.userId}` : ''}
                    </Text>
                  </Space>
                ),
              },
              {
                title: '状态',
                dataIndex: 'appConnected',
                key: 'appConnected',
                width: 120,
                render: (connected: boolean) => (
                  connected
                    ? <Tag color="green" icon={<CheckCircleOutlined />}>在线</Tag>
                    : <Tag color="gold">等待重连</Tag>
                ),
              },
              {
                title: '最近活跃',
                dataIndex: 'lastActiveAt',
                key: 'lastActiveAt',
                width: 160,
                render: (value?: number) => value ? new Date(value).toLocaleTimeString() : '-',
              },
              {
                title: '已缓存日志',
                dataIndex: 'recentLogCount',
                key: 'recentLogCount',
                width: 100,
                render: (value: number) => `${value || 0} 条`,
              },
              {
                title: '操作',
                key: 'action',
                width: 220,
                render: (_, record) => (
                  <Space size="small">
                    <Button type="link" size="small" onClick={() => enterDeviceLogStream(record)}>
                      查看日志
                    </Button>
                    <Button
                      type="link"
                      size="small"
                      icon={<ReloadOutlined />}
                      onClick={() => reconnectDeviceLogStream(record)}
                    >
                      {record.appConnected ? '刷新' : '重连'}
                    </Button>
                    <Popconfirm
                      title="移出设备"
                      description="移出后会断开该设备实时日志连接，确认继续？"
                      okText="移出"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => removeDevice(record)}
                    >
                      <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                        移出
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      )}

      {state === 'idle' && devices.length === 0 && !embedded && (
        <Card>
          <div style={{ textAlign: 'center', padding: '72px 0' }}>
            <QrcodeOutlined style={{ fontSize: 64, color: '#1677ff', marginBottom: 24 }} />
            <Title level={5}>连接设备实时日志</Title>
            <Paragraph type="secondary" style={{ maxWidth: 520, margin: '0 auto 24px' }}>
              点击生成二维码，然后在 NN App 中通过 Debug → 实时日志 → 扫描二维码进行配对。
              配对成功后，设备日志将通过服务器中转实时展示在浏览器中。
            </Paragraph>
            <Button type="primary" size="large" icon={<QrcodeOutlined />} onClick={startPairing}>
              生成配对二维码
            </Button>
          </div>
        </Card>
      )}

      {/* 等待扫码 */}
      {(state === 'qrcode' || state === 'polling') && usePairingModal && (
        <Modal
          title="实时日志（蒲公英）"
          open={qrModalOpen}
          footer={null}
          onCancel={disconnect}
          width={520}
          destroyOnHidden
        >
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            {qrValue ? (
              <>
                <div
                  style={{
                    display: 'inline-block',
                    padding: 16,
                    background: '#fff',
                    borderRadius: 8,
                    border: '1px solid #f0f0f0',
                    marginBottom: 24,
                  }}
                >
                  <QRCodeSVG value={qrValue} size={220} level="M" />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <Space>
                    <Spin size="small" />
                    <Text type="secondary">等待 App 扫码配对...</Text>
                    <Tag color="blue">协议 nn_log_pair</Tag>
                  </Space>
                </div>
                <Paragraph type="secondary" style={{ fontSize: 13 }}>
                  请在 NN App 中打开：Debug → 实时日志 → 扫描二维码
                </Paragraph>
                <Paragraph
                  copyable={{ text: qrValue }}
                  type="secondary"
                  style={{ maxWidth: 440, margin: '8px auto 0', fontSize: 12 }}
                  ellipsis={{ rows: 2, expandable: true, symbol: '展开二维码内容' }}
                >
                  二维码内容：{qrValue}
                </Paragraph>
                <Space style={{ marginTop: 16 }}>
                  <Button onClick={startPairing} icon={<ReloadOutlined />}>
                    重新生成
                  </Button>
                  <Button onClick={disconnect}>取消</Button>
                </Space>
              </>
            ) : (
              <Spin tip="正在生成二维码..." />
            )}
          </div>
        </Modal>
      )}

      {(state === 'qrcode' || state === 'polling') && !usePairingModal && (
        <Card>
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            {qrValue ? (
              <>
                <div
                  style={{
                    display: 'inline-block',
                    padding: 16,
                    background: '#fff',
                    borderRadius: 8,
                    border: '1px solid #f0f0f0',
                    marginBottom: 24,
                  }}
                >
                  <QRCodeSVG value={qrValue} size={220} level="M" />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <Space>
                    <Spin size="small" />
                    <Text type="secondary">等待 App 扫码配对...</Text>
                    <Tag color="blue">协议 nn_log_pair</Tag>
                  </Space>
                </div>
                <Paragraph type="secondary" style={{ fontSize: 13 }}>
                  请在 NN App 中打开：Debug → 实时日志 → 扫描二维码
                </Paragraph>
                <Paragraph
                  copyable={{ text: qrValue }}
                  type="secondary"
                  style={{ maxWidth: 520, margin: '8px auto 0', fontSize: 12 }}
                  ellipsis={{ rows: 2, expandable: true, symbol: '展开二维码内容' }}
                >
                  二维码内容：{qrValue}
                </Paragraph>
                <Space style={{ marginTop: 16 }}>
                  <Button onClick={startPairing} icon={<ReloadOutlined />}>
                    重新生成
                  </Button>
                  <Button onClick={disconnect}>取消</Button>
                </Space>
              </>
            ) : (
              <Spin tip="正在生成二维码..." />
            )}
          </div>
        </Card>
      )}

      {/* 实时日志流 */}
      {state === 'streaming' && (
        <Card
          title={
            <Space>
              <MobileOutlined />
              <span>设备实时日志</span>
              {pairingStatus?.deviceInfo && (
                <Tag color="blue">{deviceDetailDisplayName(pairingStatus.deviceInfo)}</Tag>
              )}
              <Tag color="green" icon={<CheckCircleOutlined />}>浏览器接收中</Tag>
              {getAppConnectionTag()}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {visibleLogs.length} / {activeLogs.length} 条{logChannelLabel(activeLogChannel)}日志
              </Text>
              {lastHeartbeatAt && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  心跳 {lastHeartbeatAt}
                </Text>
              )}
            </Space>
          }
          extra={
            <Space>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => requestRefreshLogs()}
              >
                刷新日志流
              </Button>
              <Button
                size="small"
                icon={<DownloadOutlined />}
                loading={isDownloadingLogs}
                onClick={requestNNLogsDownload}
              >
                {isDownloadingLogs ? `下载中 ${downloadProgress}%` : '下载 NN 日志'}
              </Button>
              <Button
                size="small"
                icon={<FileSearchOutlined />}
                onClick={openBusinessLogAnalysis}
              >
                分析业务日志
              </Button>
              <Button
                size="small"
                type={autoScroll ? 'primary' : 'default'}
                onClick={() => setAutoScroll(!autoScroll)}
              >
                {autoScroll ? '自动滚动: 开' : '自动滚动: 关'}
              </Button>
              <Button
                size="small"
                icon={<ClearOutlined />}
                onClick={() => setLogs((prev) => prev.filter((log) => log.channel !== activeLogChannel))}
              >
                清空
              </Button>
              <Button size="small" icon={<DisconnectOutlined />} onClick={stopViewing}>
                停止查看
              </Button>
            </Space>
          }
          bodyStyle={{ padding: 0 }}
        >
          <Tabs
            activeKey={activeLogChannel}
            onChange={(key) => setActiveLogChannel(key as LogChannel)}
            style={{ padding: '0 16px' }}
            items={[
              {
                key: 'business',
                label: `业务 (${businessLogs.length})`,
              },
              {
                key: 'im',
                label: `IM (${imLogs.length})`,
              },
              {
                key: 'rtc',
                label: `RTC (${rtcLogs.length})`,
              },
            ]}
          />
          <div style={{ padding: '0 16px 12px' }}>
            <Space>
              <Input.Search
                allowClear
                placeholder={`检索${logChannelLabel(activeLogChannel)}日志`}
                value={logSearchText}
                onChange={(event) => setLogSearchText(event.target.value)}
                style={{ width: 360 }}
              />
              {normalizedLogSearchText && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  命中 {visibleLogs.length} 条
                </Text>
              )}
            </Space>
          </div>
          <div
            ref={logContainerRef}
            style={{
              height: 'calc(100vh - 350px)',
              minHeight: 400,
              overflow: 'auto',
              background: '#1e1e1e',
              padding: '12px 16px',
              fontFamily: 'Menlo, Monaco, Consolas, monospace',
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            {activeLogs.length === 0 ? (
              <div style={{ color: '#666', textAlign: 'center', paddingTop: 100 }}>
                {getEmptyLogText()}
              </div>
            ) : visibleLogs.length === 0 ? (
              <div style={{ color: '#666', textAlign: 'center', paddingTop: 100 }}>
                未找到匹配日志
              </div>
            ) : (
              visibleLogs.map((log) => {
                const channel = effectiveLogChannel(log);
                const displayLine = normalizeDisplayLine(log.message, channel);
                return (
                  <div key={log.id} style={{ color: '#d4d4d4', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    <span>{highlightText(displayLine, normalizedLogSearchText)}</span>
                  </div>
                );
              })
            )}
          </div>
        </Card>
      )}

      <Modal
        title="业务日志在线分析"
        open={analysisOpen}
        onCancel={() => setAnalysisOpen(false)}
        footer={null}
        width="88vw"
        destroyOnHidden
      >
        {analysisResult ? (
          <Tabs
            defaultActiveKey={analysisResult.functionGroups.find((group) => group.label === 'API')?.key || analysisResult.functionGroups[0]?.key || 'unknown'}
            items={analysisResult.functionGroups.map((group) => ({
              key: group.key,
              label: `${group.label} (${group.logs.length})`,
              children: group.label === 'API' ? (
                renderApiTimelineTable(analysisResult.apiTimeline)
              ) : (
                <Space direction="vertical" size="small" style={{ width: '100%' }}>
                  <Table
                    size="small"
                    bordered
                    rowKey={(record: ParsedBusinessLog, index) => `${record.time}-${index}`}
                    dataSource={group.logs.slice(0, 100)}
                    pagination={{ pageSize: 10 }}
                    columns={[
                      { title: '时间', dataIndex: 'time', width: 150 },
                      { title: '事件', dataIndex: 'event', width: 180 },
                      { title: '日志', dataIndex: 'line', render: (value: string) => <Text code>{value}</Text> },
                    ]}
                  />
                </Space>
              ),
            }))}
          />
        ) : null}
      </Modal>

      {/* 错误 */}
      {state === 'error' && (
        <Card>
          <Alert
            type="error"
            showIcon
            icon={<CloseCircleOutlined />}
            message="配对失败"
            description={errorMsg || '未知错误'}
            style={{ marginBottom: 24 }}
          />
          <Space>
            <Button type="primary" icon={<ReloadOutlined />} onClick={startPairing}>
              重新生成二维码
            </Button>
            <Button onClick={disconnect}>返回</Button>
          </Space>
        </Card>
      )}
    </div>
  );
}
