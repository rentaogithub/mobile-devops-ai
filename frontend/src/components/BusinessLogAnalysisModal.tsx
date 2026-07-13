import { useState, type ReactNode } from 'react';
import { Button, Input, message, Modal, Space, Table, Tabs, Tag, Tree, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';

const { Text } = Typography;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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
  matchedRequest: boolean;
  status: 'success' | 'failed' | 'pending';
}

export interface BusinessLogAnalysis {
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
        style={{ color: '#1e1e1e', background: '#ffd666', borderRadius: 2, padding: '0 2px' }}
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

function parseLogTimeValue(time: string): number {
  const match = time.match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!match) return 0;
  const [, month, day, hour, minute, second, millisecond = '0'] = match;
  return new Date(2000, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millisecond.padEnd(3, '0'))).getTime();
}

function parseJsonValue(value?: string): JsonValue | null {
  if (!value || value === '-') return null;
  const candidates = [value, value.replace(/\\\\(?=")/g, '\\')];
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
  if (parsed === null) return '';
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
    return { key: nodeKey, title: renderLabel(nodeLabel, nodeValue) };
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
  const level = /⚠️|\[Warning\]|error|fail|exception/i.test(line) || (retCode && !['0', '100', '200'].includes(retCode)) ? 'warning' : 'info';
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

export function analyzeBusinessLogLines(lines: string[], source: string): BusinessLogAnalysis {
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
      matchedRequest: true,
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
      costMs: null,
      retCode: retCode || '-',
      retMsg: response.fields.retMsg || '-',
      nntid: response.fields.nntid || '-',
      trackId: response.fields.trackId || '-',
      parameters: '-',
      responseBody: response.fields.response || extractResponseFieldFromLogLine(response.line) || '-',
      requestLine: '-',
      responseLine: response.line,
      fullApi: response.fields.api || '-',
      matchedRequest: false,
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

interface BusinessLogAnalysisModalProps {
  open: boolean;
  analysisResult: BusinessLogAnalysis | null;
  onCancel: () => void;
}

export function BusinessLogAnalysisModal({ open, analysisResult, onCancel }: BusinessLogAnalysisModalProps) {
  const [apiResponseJsonSearchText, setApiResponseJsonSearchText] = useState('');
  const [apiSearchText, setApiSearchText] = useState('');

  const renderApiTimelineTable = (dataSource: ApiTimelineRow[], pageSize = 20) => {
    const normalizedApiSearchText = apiSearchText.trim().toLowerCase();
    const filteredDataSource = normalizedApiSearchText
      ? dataSource.filter((record) => [
        record.fullApi,
        normalizeApiPath(record.fullApi),
        record.api,
        record.parameters,
        record.requestLine,
        record.responseLine,
        record.responseBody,
        formatJsonText(record.responseBody),
        record.retCode,
        record.retMsg,
        record.nntid,
        record.trackId,
      ].join('\n').toLowerCase().includes(normalizedApiSearchText))
      : dataSource;

    return (
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Space>
          <Input.Search
            allowClear
            placeholder="检索接口 / 日志内容"
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
                  <Text code style={{ display: 'block', whiteSpace: 'pre-wrap' }}>
                    请求：{record.matchedRequest ? highlightText(record.requestLine, apiSearchText.trim()) : <Tag color="gold">缺少请求日志</Tag>}
                  </Text>
                  <Text code style={{ display: 'block', whiteSpace: 'pre-wrap' }}>响应：{highlightText(removeResponseFieldFromLogLine(record.responseLine), apiSearchText.trim())}</Text>
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
                  ) : null}
                </Space>
              );
            },
          }}
          columns={[
            {
              title: '请求时间',
              dataIndex: 'requestTime',
              width: 150,
              sorter: (a, b) => parseLogTimeValue(a.requestTime) - parseLogTimeValue(b.requestTime),
            },
            {
              title: '耗时',
              dataIndex: 'costMs',
              width: 90,
              sorter: (a, b) => {
                if (a.costMs === null && b.costMs === null) return 0;
                if (a.costMs === null) return 1;
                if (b.costMs === null) return -1;
                return a.costMs - b.costMs;
              },
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
    <Modal
      title="业务日志在线分析"
      open={open}
      onCancel={onCancel}
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
  );
}
