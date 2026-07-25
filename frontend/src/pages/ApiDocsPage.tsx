import { ApiOutlined, CodeOutlined, DiffOutlined, HistoryOutlined, LinkOutlined, PlayCircleOutlined, SearchOutlined, ShareAltOutlined, SyncOutlined } from '@ant-design/icons';
import { Alert, AutoComplete, Button, Card, Empty, Input, InputNumber, Menu, Modal, Pagination, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography, message } from 'antd';
import axios from 'axios';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { authUtils } from '../utils/auth';

const { Title, Paragraph, Text } = Typography;

type Schema = {
  type?: string;
  format?: string;
  description?: string;
  title?: string;
  example?: unknown;
  default?: unknown;
  enum?: unknown[];
  originalRef?: string;
  $ref?: string;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
};
type Parameter = Schema & { name: string; in: string; required?: boolean; schema?: Schema; default?: unknown };
type Operation = { summary?: string; operationId?: string; tags?: string[]; parameters?: Parameter[]; responses?: Record<string, { description?: string; schema?: Schema }> };
type SwaggerDoc = { swagger: string; host?: string; basePath?: string; info?: { title?: string; version?: string }; paths: Record<string, Record<string, Operation>>; definitions?: Record<string, Schema>; tags?: { name: string }[]; xFallbackDocument?: boolean };
type ApiItem = Operation & { path: string; method: string; tag: string };
type GlobalSearchItem = { service: keyof typeof services; basePath: string; path: string; method: string; summary: string; operationId: string; tag: string; fallbackDocument?: boolean };
type RequestConfig = { headers: Record<string, unknown>; query: Record<string, unknown>; pathParams: Record<string, unknown>; body?: unknown };
type RequestResult = { status: number; statusText: string; duration: number; url: string; requestHeaders: Record<string, string>; data: unknown; tokenInvalid?: boolean; tokenInvalidReason?: string };
type ApiRequestSample = {
  id: string;
  source: 'realtime_log' | 'feedback_log';
  sourceRef: string;
  service: keyof typeof services;
  method: string;
  path: string;
  fullPath: string;
  environment: RequestEnvironment | 'unknown';
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
  pathParams: Record<string, unknown>;
  body?: unknown;
  token?: string;
  response?: unknown;
  retCode: string;
  retMsg: string;
  costMs?: number;
  nntid: string;
  createdAt: string;
  requestTime: string;
};
type ApiEnvironmentTokenSample = { token: string; environment: RequestEnvironment; createdAt: string; source: 'realtime_log' | 'feedback_log'; sourceRef: string };
type RequestEnvironment = 'release' | 'test' | 'test1';
type EnvironmentTokens = Record<RequestEnvironment, string>;
type ResponseCodeSummary = { code: string; descriptions: string[]; interfaces: { method: string; path: string; summary: string }[] };
type ApiViewRecord = { service: keyof typeof services; method: string; path: string; summary: string; tag: string; viewCount: number; lastViewedAt: string };
type ApiChangeItem = { key: string; method: string; path: string; fullPath: string; summary: string; tag: string; changes?: string[] };
type ApiDocDiff = {
  service: keyof typeof services;
  hasBaseline: boolean;
  mode?: 'cached-vs-latest' | 'previous-vs-current';
  message?: string;
  currentFallback?: boolean;
  previousFallback?: boolean;
  summary: { added: number; removed: number; changed: number };
  added: ApiChangeItem[];
  removed: ApiChangeItem[];
  changed: ApiChangeItem[];
};

const services = {
  'open-api': { name: 'NN第三方API接口接入', source: 'https://test1-doc.nn.com/doc.html#/NN第三方API接口接入' },
  'nn-assist-frontend': { name: '帮助中心前端接口', source: 'https://test1-doc.nn.com/doc.html#/帮助中心前端接口' },
  'nn-assist-client': { name: '帮助中心客户端接口', source: 'https://test1-doc.nn.com/doc.html#/帮助中心客户端接口' },
  'u-nnpc': { name: 'PC接入层', source: 'https://test1-doc.nn.com/doc.html#/PC接入层' },
  'user-query': { name: '用户查询服务', source: 'https://test1-doc.nn.com/doc.html#/用户查询服务' },
  'u-mobile': { name: '移动端接入层', source: 'https://test1-doc.nn.com/doc.html#/移动端接入层' },
  'u-miniapp': { name: 'NN小程序接入层', source: 'https://test1-doc.nn.com/doc.html#/NN小程序接入层' },
  'nchannel': { name: '社区频道接口文档', source: 'https://test1-doc.nn.com/doc.html#/社区频道接口文档' },
  'activity': { name: '活动中心-C端', source: 'https://test1-doc.nn.com/doc.html#/活动中心-C端' },
  'speed-platform': { name: '武汉用户加速器接入', source: 'https://test1-doc.nn.com/doc.html#/武汉用户加速器接入' },
  'wan-app': { name: 'NN陪玩：app接口', source: 'https://test1-doc.nn.com/doc.html#/NN陪玩：app接口' },
  'wan-client': { name: 'NN陪玩：客户端接口', source: 'https://test1-doc.nn.com/doc.html#/NN陪玩：客户端接口' },
  'wan-short-link': { name: 'NN陪玩：短链接口', source: 'https://test1-doc.nn.com/doc.html#/NN陪玩：短链接口' },
  'nn-risk-v1': { name: 'NN风控审核服务:V1', source: 'https://test1-doc.nn.com/doc.html#/NN风控审核服务:V1' },
  'nn-risk-admin': { name: 'NN风控审核服务:管理后台', source: 'https://test1-doc.nn.com/doc.html#/NN风控审核服务:管理后台' },
  'nn-risk-activity': { name: 'NN风控审核服务:活动风控', source: 'https://test1-doc.nn.com/doc.html#/NN风控审核服务:活动风控' },
  'operation-server': { name: 'operationServer', source: 'https://test1-doc.nn.com/doc.html#/operationServer' },
  'im-friend': { name: '雷神IM好友服务客户端接口', source: 'https://test1-doc.nn.com/doc.html#/雷神IM好友服务客户端接口' },
  'im-user': { name: '雷神IM用户客户端接口', source: 'https://test1-doc.nn.com/doc.html#/雷神IM用户客户端接口' },
  'order-open-api': { name: 'order-open-api', source: 'https://test1-doc.nn.com/doc.html#/order-open-api' },
  'wan-v1': { name: 'v1-NN陪玩接口', source: 'https://test1-doc.nn.com/doc.html#/v1-NN陪玩接口' },
  'wan-v2': { name: 'v2-NN陪玩接口', source: 'https://test1-doc.nn.com/doc.html#/v2-NN陪玩接口' },
  'wan-v3': { name: 'v3-NN陪玩接口', source: 'https://test1-doc.nn.com/doc.html#/v3-NN陪玩接口' },
  'wan-taobao': { name: '淘宝相关接口', source: 'https://test1-doc.nn.com/doc.html#/淘宝相关接口' },
  'short-link-api': { name: 'NN短链服务:API', source: 'https://test1-doc.nn.com/doc.html#/NN短链服务:API' },
  'leigod-rtc': { name: '雷神rtc客户端接口', source: 'https://test1-doc.nn.com/doc.html#/雷神rtc客户端接口' },
  'privilege': { name: '雷神用户权益客户端接口', source: 'https://test1-doc.nn.com/doc.html#/雷神用户权益客户端接口' },
  'leigod-market-nn': { name: '雷神营销渠道服务(NN)客户端接口', source: 'https://test1-doc.nn.com/doc.html#/雷神营销渠道服务(NN)客户端接口' },
  'nn-game': { name: '雷神赛事客户端接口', source: 'https://test1-doc.nn.com/doc.html#/雷神赛事客户端接口' },
  'cmp-bff': { name: '渠道中台bff客户端接口', source: 'https://test1-doc.nn.com/doc.html#/渠道中台bff客户端接口' },
  'gamehub': { name: 'GameHub客户端接口', source: 'https://test1-doc.nn.com/doc.html#/GameHub客户端接口' },
  'union-server': { name: 'unionServer', source: 'https://test1-doc.nn.com/doc.html#/unionServer' },
  'nn-status': { name: 'NN状态服务', source: 'https://test1-doc.nn.com/doc.html#/NN状态服务' },
  'nn-version': { name: 'NN版本服务', source: 'https://test1-doc.nn.com/doc.html#/NN版本服务' },
  'fdfs': { name: '文件服务', source: 'https://test1-doc.nn.com/doc.html#/文件服务' },
};

const businessResponseCodes = [
  { code: '100', description: '成功，无错误信息；多数接口以此作为成功码' },
  { code: '300002', description: '登录失效，统一弹出登录超时提示' },
  { code: '300131', description: '组队信息疑似违规，请重新输入' },
  { code: '300203', description: '封控类 code；可交给业务层，其他路径展示服务端 retMsg' },
  { code: '300207', description: '封控类 code；可交给业务层，其他路径展示服务端 retMsg' },
  { code: '300208', description: '进入语音房异常时展示服务端 retMsg，也可交给业务层处理' },
  { code: '300240', description: '封控类 code；可交给业务层，其他路径展示服务端 retMsg' },
  { code: '300301', description: '进入语音房异常时展示服务端 retMsg，也可交给业务层处理' },
  { code: '300346', description: '进入语音房异常，以“温馨提示”展示服务端 retMsg' },
  { code: '300501', description: '社区版本号不匹配，请重试一次，并触发社区列表刷新' },
  { code: '3001010', description: '进入语音房异常，以“温馨提示”展示服务端 retMsg' },
  { code: '500', description: '统一转换为 NetworkError.responseRetCode500' },
  { code: '700301', description: '订单异常，保留响应交给业务层处理，信息为动态 retMsg' },
  { code: 'auth_10003', description: '登录失效，统一弹出登录超时提示' },
  { code: 'auth_40001', description: '登录失效，统一弹出登录超时提示' },
  { code: 'auth_40002', description: '账号已在其他地方登录，调用统一被踢下线提示' },
  { code: 'auth_50001', description: '游客模式权限异常，统一处理直接忽略' },
  { code: 'order-428', description: '订单异常，统一处理直接忽略' },
  { code: 'umid_10017', description: '第三方登录或绑定场景进入绑定手机号/登录页，其他路径展示 retMsg' },
  { code: 'umid_10019', description: '手机号已绑定其他第三方账号，提示继续绑定会解绑原账号' },
  { code: 'umid_10079', description: 'token 数量上限，返回登录页并展示服务端 retMsg' },
  { code: 'order_*', description: '服务端动态 retMsg，响应交给订单业务层处理' },
  { code: '长度为6且包含300', description: '优先展示服务端 retMsg；为空时展示接口请求失败及错误码' },
  { code: '包含umid', description: '统一层不消费错误，返回业务层处理，通常使用动态 retMsg' },
  { code: '其他非100', description: '优先展示服务端 retMsg；为空时展示接口请求失败及错误码' },
];

const schemaName = (schema?: Schema): string => {
  if (!schema) return '-';
  if (schema.$ref) return decodeURIComponent(schema.$ref.split('/').pop() || 'object');
  if (schema.type === 'array') return `${schemaName(schema.items)}[]`;
  return [schema.type || 'object', schema.format].filter(Boolean).join('(') + (schema.format ? ')' : '');
};

const joinApiPath = (basePath = '', apiPath = ''): string => {
  const normalizedBase = basePath.replace(/\/+$/, '');
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  if (!normalizedBase) return normalizedPath;
  if (normalizedPath === normalizedBase || normalizedPath.startsWith(`${normalizedBase}/`)) {
    return normalizedPath;
  }
  return `${normalizedBase}${normalizedPath}`;
};

type RequestField = { name: string; in: string; dataType: string; schema: string; required: boolean; description: string; level: number };

const parameterColumns = [
  { title: '参数名称', dataIndex: 'name', key: 'name', render: (value: string, row: RequestField) => <span style={{ display: 'inline-block', paddingLeft: row.level * 22 }}>{value}</span> },
  { title: '参数说明', dataIndex: 'description', key: 'description' },
  { title: '请求类型', dataIndex: 'in', key: 'in', width: 100, render: (value: string) => value ? <Text style={{ color: '#1677ff' }}>{value}</Text> : null },
  { title: '是否必须', dataIndex: 'required', key: 'required', width: 90, render: (value: boolean) => <Text type={value ? 'danger' : 'secondary'}>{String(value)}</Text> },
  { title: '数据类型', dataIndex: 'dataType', key: 'dataType', width: 160 },
  { title: 'Schema', dataIndex: 'schema', key: 'schema', width: 180 },
];

const resolveSchema = (schema: Schema | undefined, definitions: Record<string, Schema>): Schema | undefined => {
  if (!schema?.$ref) return schema;
  return definitions[decodeURIComponent(schema.$ref.split('/').pop() || '')] || schema;
};

const responseFieldColumns = [
  { title: '字段', dataIndex: 'name', key: 'name', render: (value: string, row: RequestField) => <span style={{ display: 'inline-block', paddingLeft: row.level * 22 }}>{value}</span> },
  { title: '说明', dataIndex: 'description', key: 'description' },
  { title: '必填', dataIndex: 'required', key: 'required', width: 80, render: (value: boolean) => <Text type={value ? 'danger' : 'secondary'}>{String(value)}</Text> },
  { title: '数据类型', dataIndex: 'dataType', key: 'dataType', width: 150 },
  { title: 'Schema', dataIndex: 'schema', key: 'schema', width: 180 },
];

const apiChangeColumns = [
  { title: '方式', dataIndex: 'method', width: 90, render: (value: string) => <Tag color={value === 'GET' ? 'blue' : 'green'}>{value}</Tag> },
  { title: '接口路径', dataIndex: 'fullPath', render: (value: string) => <Text code>{value}</Text> },
  { title: '接口名称', dataIndex: 'summary', render: (value: string) => value || '-' },
  { title: '分组', dataIndex: 'tag', width: 180, render: (value: string) => <Text type="secondary">{value}</Text> },
  { title: '变化内容', dataIndex: 'changes', width: 220, render: (values?: string[]) => values?.length ? values.map((value) => <Tag key={value}>{value}</Tag>) : '-' },
];

const schemaReferenceName = (schema?: Schema): string => {
  if (!schema) return '';
  if (schema.originalRef) return schema.originalRef;
  if (schema.$ref) return decodeURIComponent(schema.$ref.split('/').pop() || '');
  if (schema.type === 'array') return schemaReferenceName(schema.items) || schema.items?.type || '';
  return '';
};

const isBareObjectSchema = (schema?: Schema): boolean => {
  return Boolean(schema && schema.type === 'object' && !schema.$ref && !schema.originalRef && !schema.properties);
};

const findDefinition = (definitions: Record<string, Schema>, candidates: string[]): Schema | undefined => {
  for (const candidate of candidates) {
    if (definitions[candidate]) return definitions[candidate];
  }

  const normalizedCandidates = candidates.map((candidate) => candidate.toLowerCase());
  const entry = Object.entries(definitions).find(([name]) =>
    normalizedCandidates.some((candidate) => name.toLowerCase() === candidate)
  );
  return entry?.[1];
};

const inferArrayItemSchema = (
  propertyName: string,
  parentRefName: string,
  definitions: Record<string, Schema>
): Schema | undefined => {
  if (!parentRefName || !/records?|list|items?/i.test(propertyName)) {
    return undefined;
  }

  const candidates = [
    parentRefName.replace(/分页结果VO$/, 'VO'),
    parentRefName.replace(/分页结果$/, ''),
    parentRefName.replace(/分页VO$/, 'VO'),
    parentRefName.replace(/列表VO$/, 'VO'),
    parentRefName.replace(/结果VO$/, 'VO'),
  ].filter((candidate) => candidate && candidate !== parentRefName);

  const genericInnerMatch = parentRefName.match(/[«<]([^«»<>]+)[»>]$/);
  if (genericInnerMatch?.[1]) {
    candidates.unshift(genericInnerMatch[1]);
  }

  return findDefinition(definitions, candidates);
};

const nestedRequestFields = (schema: Schema, definitions: Record<string, Schema>, level = 0, visited = new Set<string>()): RequestField[] => {
  const refName = schemaReferenceName(schema);
  if (refName && visited.has(refName)) return [];
  const nextVisited = new Set(visited);
  if (refName) nextVisited.add(refName);
  const resolved = resolveSchema(schema, definitions) || schema;
  return Object.entries(resolved.properties || {}).flatMap(([name, property]) => {
    const propertyResolved = resolveSchema(property, definitions) || property;
    const isArray = property.type === 'array';
    const inferredArrayItemSchema = isArray && isBareObjectSchema(property.items)
      ? inferArrayItemSchema(name, refName || resolved.title || schema.title || '', definitions)
      : undefined;
    const resolvedArrayItemSchema = inferredArrayItemSchema || property.items;
    const row: RequestField = {
      name,
      in: level === 0 ? 'body' : '',
      dataType: isArray ? 'array' : propertyResolved.type || property.type || 'object',
      schema: isArray && inferredArrayItemSchema?.title
        ? inferredArrayItemSchema.title
        : schemaReferenceName(property) || (isArray ? property.items?.type || '' : ''),
      required: resolved.required?.includes(name) || false,
      description: property.description || propertyResolved.description || '-',
      level,
    };
    const childSchema = isArray ? resolvedArrayItemSchema : property;
    const children = childSchema ? nestedRequestFields(childSchema, definitions, level + 1, nextVisited) : [];
    return [row, ...children];
  });
};

const requestFields = (parameters: Parameter[], definitions: Record<string, Schema>): RequestField[] => parameters.flatMap((parameter) => {
  const root: RequestField = {
    name: parameter.name,
    in: parameter.in,
    dataType: parameter.type || resolveSchema(parameter.schema, definitions)?.type || 'object',
    schema: schemaReferenceName(parameter.schema),
    required: parameter.required || false,
    description: parameter.description || parameter.schema?.description || '-',
    level: 0,
  };
  if (parameter.in !== 'body' || !parameter.schema) return [root];
  return nestedRequestFields(parameter.schema, definitions);
});

const sampleValue = (
  schema: Schema | undefined,
  definitions: Record<string, Schema>,
  depth = 0,
  parentRefName = '',
  propertyName = ''
): unknown => {
  if (!schema || depth > 4) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  const refName = schemaReferenceName(schema);
  const resolved = resolveSchema(schema, definitions) || schema;
  if (resolved.type === 'array') {
    const inferredArrayItemSchema = isBareObjectSchema(resolved.items)
      ? inferArrayItemSchema(propertyName, parentRefName, definitions)
      : undefined;
    return [sampleValue(inferredArrayItemSchema || resolved.items, definitions, depth + 1, '', '')];
  }
  if (resolved.properties) {
    const currentRefName = refName || resolved.title || parentRefName;
    return Object.fromEntries(Object.entries(resolved.properties).map(([key, value]) => [
      key,
      sampleValue(value, definitions, depth + 1, currentRefName, key),
    ]));
  }
  const key = propertyName.toLowerCase();
  if (resolved.type === 'integer' || resolved.type === 'number') {
    if (/count|total|num|size|page/.test(key)) return 1;
    if (/time|timestamp/.test(key)) return Date.now();
    return /id$|_id$|uid|userid|nnnumber/.test(key) ? 10001 : 0;
  }
  if (resolved.type === 'boolean') return /success|enable|valid|ok/.test(key);
  if (resolved.format === 'date-time' || /time|date/.test(key)) return new Date().toISOString();
  if (/retcode|code/.test(key)) return '100';
  if (/retmsg|message|msg/.test(key)) return 'success';
  if (/url|avatar|icon|image|img/.test(key)) return 'https://example.com/mock.png';
  if (/name|nick/.test(key)) return 'mock_name';
  if (/id$|_id$|uid|userid/.test(key)) return '10001';
  return '';
};

const createRequestConfig = (api: ApiItem, definitions: Record<string, Schema>): RequestConfig => {
  const config: RequestConfig = { headers: {}, query: {}, pathParams: {} };
  for (const parameter of api.parameters || []) {
    if (parameter.in === 'header') continue;
    const value = parameter.default ?? (parameter.schema ? sampleValue(parameter.schema, definitions) : sampleValue(parameter, definitions));
    if (parameter.in === 'body') config.body = value;
    else if (parameter.in === 'header') config.headers[parameter.name] = value;
    else if (parameter.in === 'query') config.query[parameter.name] = value;
    else if (parameter.in === 'path') config.pathParams[parameter.name] = value;
  }
  return config;
};

const readEnvironmentTokens = (): EnvironmentTokens => {
  try {
    return { release: '', test: '', test1: '', ...JSON.parse(localStorage.getItem('api_environment_tokens') || '{}') };
  } catch {
    return { release: '', test: '', test1: '' };
  }
};

const apiSearchHistoryKey = 'api_docs_search_history';
const maxApiSearchHistory = 12;

const readApiSearchHistory = (): string[] => {
  try {
    const history = JSON.parse(localStorage.getItem(apiSearchHistoryKey) || '[]');
    return Array.isArray(history) ? history.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  } catch {
    return [];
  }
};

const runtimePublicParamKeys = new Set(['authorization', 'token', 'cookie', 'set-cookie', 'x-auth-token', 'timestamp']);

const sanitizeRuntimeParams = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeRuntimeParams);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !runtimePublicParamKeys.has(key.toLowerCase()))
    .map(([key, item]) => [key, sanitizeRuntimeParams(item)]));
};

type EditableField = { path: string; value: string | number | boolean; type: string };

const flattenEditableFields = (value: unknown, prefix = ''): EditableField[] => {
  if ((value === undefined || value === null || value === '') && !prefix) return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => flattenEditableFields(item, `${prefix}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => flattenEditableFields(item, prefix ? `${prefix}.${key}` : key));
  if (!prefix) return [];
  return [{ path: prefix, value: (value ?? '') as string | number | boolean, type: typeof value }];
};

const updateValueAtPath = (config: RequestConfig, section: keyof RequestConfig, path: string, value: unknown): RequestConfig => {
  const next = structuredClone(config);
  const tokens = path.match(/[^.[\]]+|\d+/g) || [];
  let target = next[section] as Record<string, unknown> | unknown[] | undefined;
  if (target === undefined || target === null) {
    target = {};
    (next as Record<string, unknown>)[section] = target;
  }
  tokens.forEach((token, index) => {
    const key: string | number = /^\d+$/.test(token) ? Number(token) : token;
    if (index === tokens.length - 1) {
      (target as Record<string | number, unknown>)[key] = value;
      return;
    }
    target = (target as Record<string | number, unknown>)[key] as Record<string, unknown> | unknown[];
  });
  return next;
};

async function copyTextToClipboard(text: string): Promise<boolean> {
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
  const copied = document.execCommand('copy');
  document.body.removeChild(textArea);
  return copied;
}

export default function ApiDocsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [service, setService] = useState<keyof typeof services>('user-query');
  const [doc, setDoc] = useState<SwaggerDoc>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState(searchParams.get('q') || '');
  const [page, setPage] = useState(1);
  const [syncing, setSyncing] = useState(false);
  const [globalResults, setGlobalResults] = useState<GlobalSearchItem[]>([]);
  const [globalTotal, setGlobalTotal] = useState(0);
  const [globalSearching, setGlobalSearching] = useState(false);
  const [searchMode, setSearchMode] = useState<'global' | 'service'>('global');
  const [requestApi, setRequestApi] = useState<ApiItem>();
  const [requestService, setRequestService] = useState<keyof typeof services>('user-query');
  const [requestDoc, setRequestDoc] = useState<SwaggerDoc>();
  const [requestEnvironment, setRequestEnvironment] = useState<RequestEnvironment>('test');
  const [environmentTokens, setEnvironmentTokens] = useState<EnvironmentTokens>(readEnvironmentTokens);
  const [responseCodesOpen, setResponseCodesOpen] = useState(false);
  const [responseCodeSearch, setResponseCodeSearch] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailService, setDetailService] = useState<keyof typeof services>();
  const [detailDoc, setDetailDoc] = useState<SwaggerDoc>();
  const [detailApi, setDetailApi] = useState<ApiItem>();
  const [requestConfig, setRequestConfig] = useState<RequestConfig>({ headers: {}, query: {}, pathParams: {} });
  const [requesting, setRequesting] = useState(false);
  const [requestResult, setRequestResult] = useState<RequestResult>();
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [records, setRecords] = useState<ApiViewRecord[]>([]);
  const [recordSearch, setRecordSearch] = useState('');
  const [searchHistory, setSearchHistory] = useState<string[]>(readApiSearchHistory);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [apiDiff, setApiDiff] = useState<ApiDocDiff>();
  const isAdmin = authUtils.isAdmin();
  const pageSize = 20;

  useEffect(() => {
    setLoading(true); setError(''); setDoc(undefined); setPage(1);
    axios.get<SwaggerDoc>(`/api/api-docs/${service}`, { timeout: 45_000 })
      .then(({ data }) => setDoc(data))
      .catch((reason) => setError(reason.response?.data?.message || reason.message || '加载失败'))
      .finally(() => setLoading(false));
  }, [service]);

  useEffect(() => {
    const sharedService = searchParams.get('service') as keyof typeof services | null;
    const sharedMethod = searchParams.get('method')?.toUpperCase();
    const sharedPath = searchParams.get('path');
    if (!sharedService || !services[sharedService] || !sharedMethod || !sharedPath) {
      return;
    }

    setService(sharedService);
    setDetailLoading(true);
    setDetailService(sharedService);
    setDetailApi(undefined);
    setDetailDoc(undefined);
    axios.get<SwaggerDoc>(`/api/api-docs/${sharedService}`, { timeout: 45_000 })
      .then(({ data }) => {
        const operation = data.paths?.[sharedPath]?.[sharedMethod.toLowerCase()];
        if (!operation) throw new Error('接口详情不存在');
        setDetailDoc(data);
        const api = { ...operation, path: sharedPath, method: sharedMethod, tag: operation.tags?.[0] || '其他' };
        setDetailApi(api);
        void trackApiView(sharedService, api);
      })
      .catch((reason) => {
        const errorMessage = axios.isAxiosError(reason) ? reason.response?.data?.message || reason.message : reason instanceof Error ? reason.message : '加载接口详情失败';
        message.error(errorMessage);
        setDetailService(undefined);
      })
      .finally(() => setDetailLoading(false));
  }, []);

  useEffect(() => {
    const query = keyword.trim();
    if (searchMode !== 'global' || query.length < 2) {
      setGlobalResults([]);
      setGlobalTotal(0);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setGlobalSearching(true);
      axios.get<{ data: GlobalSearchItem[]; total: number }>('/api/api-docs/search/all', { params: { q: query }, signal: controller.signal, timeout: 90_000 })
        .then(({ data }) => { setGlobalResults(data.data); setGlobalTotal(data.total); })
        .catch((reason) => { if (reason.code !== 'ERR_CANCELED') message.error('全局查询失败'); })
        .finally(() => setGlobalSearching(false));
    }, 400);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [keyword, searchMode]);

  const apis = useMemo<ApiItem[]>(() => doc ? Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({ ...operation, path, method: method.toUpperCase(), tag: operation.tags?.[0] || '其他' }))) : [], [doc]);
  const filteredApis = useMemo(() => apis.filter((api) => {
    const text = `${joinApiPath(doc?.basePath, api.path)} ${api.path} ${api.summary} ${api.operationId} ${api.tag}`.toLowerCase();
    return text.includes(keyword.trim().toLowerCase());
  }), [apis, doc?.basePath, keyword]);
  const pagedApis = useMemo(() => filteredApis.slice((page - 1) * pageSize, page * pageSize), [filteredApis, page]);
  const responseCodeSummaries = useMemo<ResponseCodeSummary[]>(() => {
    const summaries = new Map<string, ResponseCodeSummary>();
    for (const api of apis) {
      for (const [code, response] of Object.entries(api.responses || {})) {
        const current = summaries.get(code) || { code, descriptions: [], interfaces: [] };
        const description = response.description || '-';
        if (!current.descriptions.includes(description)) current.descriptions.push(description);
        current.interfaces.push({ method: api.method, path: joinApiPath(doc?.basePath, api.path), summary: api.summary || '' });
        summaries.set(code, current);
      }
    }
    return Array.from(summaries.values()).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [apis, doc?.basePath]);
  const filteredResponseCodes = useMemo(() => {
    const value = responseCodeSearch.trim().toLowerCase();
    return responseCodeSummaries.filter((item) => !value || `${item.code} ${item.descriptions.join(' ')}`.toLowerCase().includes(value));
  }, [responseCodeSearch, responseCodeSummaries]);
  const filteredBusinessResponseCodes = useMemo(() => {
    const value = responseCodeSearch.trim().toLowerCase();
    return businessResponseCodes.filter((item) => !value || `${item.code} ${item.description}`.toLowerCase().includes(value));
  }, [responseCodeSearch]);
  const searchHistoryOptions = useMemo(() => {
    const value = keyword.trim().toLowerCase();
    return searchHistory
      .filter((item) => !value || item.toLowerCase().includes(value))
      .slice(0, maxApiSearchHistory)
      .map((item) => ({ value: item, label: <Space><HistoryOutlined />{item}</Space> }));
  }, [keyword, searchHistory]);
  const originalDocumentUrl = (api: ApiItem, targetService: keyof typeof services = service) => {
    const operationKey = api.operationId || api.path;
    return `${services[targetService].source}/${api.tag}/${operationKey}`;
  };
  const renderOriginalDocumentButton = (
    api: ApiItem,
    targetService: keyof typeof services = service,
    isFallbackDocument = false
  ) => {
    if (isFallbackDocument) {
      return (
        <Tooltip title="上游 Knife4j 文档当前异常，暂无原始文档">
          <Button type="link" icon={<LinkOutlined />} disabled>原始文档</Button>
        </Tooltip>
      );
    }

    return (
      <Button type="link" icon={<LinkOutlined />} href={originalDocumentUrl(api, targetService)} target="_blank">原始文档</Button>
    );
  };
  const syncAllDocuments = async () => {
    setSyncing(true);
    try {
      const token = authUtils.getToken();
      const { data } = await axios.post<{ total: number; succeeded: string[]; failed: { service: string; message: string }[] }>(
        '/api/api-docs/sync/all',
        undefined,
        { timeout: 180_000, headers: token ? { Authorization: `Bearer ${token}` } : undefined },
      );
      const refreshed = await axios.get<SwaggerDoc>(`/api/api-docs/${service}`, { timeout: 45_000 });
      setDoc(refreshed.data);
      setPage(1);
      if (data.failed.length) message.warning(`同步完成：成功 ${data.succeeded.length} 个，失败 ${data.failed.length} 个`);
      else message.success(`同步成功，共更新 ${data.total} 个 API 服务`);
    } catch (reason) {
      const errorMessage = axios.isAxiosError(reason) ? reason.response?.data?.message || reason.message : '同步失败';
      message.error(errorMessage);
    } finally {
      setSyncing(false);
    }
  };
  const applyRequestSampleToConfig = (sample: ApiRequestSample, environment: RequestEnvironment) => {
    setRequestConfig({
      headers: sanitizeRuntimeParams(sample.headers || {}) as Record<string, unknown>,
      query: sanitizeRuntimeParams(sample.query || {}) as Record<string, unknown>,
      pathParams: sanitizeRuntimeParams(sample.pathParams || {}) as Record<string, unknown>,
      body: sanitizeRuntimeParams(sample.body),
    });
    if (sample.token && sample.environment === environment) {
      const nextTokens = { ...readEnvironmentTokens(), [environment]: sample.token };
      setEnvironmentTokens(nextTokens);
      localStorage.setItem('api_environment_tokens', JSON.stringify(nextTokens));
    }
  };
  const refreshEnvironmentToken = async (environment: RequestEnvironment): Promise<string> => {
    try {
      const { data } = await axios.get<{ data: ApiEnvironmentTokenSample | null }>('/api/api-docs/request-token', {
        params: { environment },
        timeout: 15_000,
      });
      const token = data.data?.token?.trim() || '';
      if (!token) return readEnvironmentTokens()[environment].trim();
      const nextTokens = { ...readEnvironmentTokens(), [environment]: token };
      setEnvironmentTokens(nextTokens);
      localStorage.setItem('api_environment_tokens', JSON.stringify(nextTokens));
      return token;
    } catch {
      return readEnvironmentTokens()[environment].trim();
    }
  };
  const loadAndApplyBestSample = async (
    api: ApiItem,
    targetService: keyof typeof services,
    environment: RequestEnvironment,
    targetDoc: SwaggerDoc | undefined,
  ): Promise<ApiRequestSample | undefined> => {
    const saved = localStorage.getItem(`api_request_config:${targetService}:${api.method}:${api.path}:${environment}`);
    const fallbackConfig = saved ? JSON.parse(saved) : createRequestConfig(api, targetDoc?.definitions || {});
    try {
      const { data } = await axios.get<{ data: ApiRequestSample[] }>('/api/api-docs/request-samples', {
        params: { service: targetService, method: api.method, path: api.path, environment, limit: 20 },
        timeout: 15_000,
      });
      const sample = data.data[0];
      if (sample) {
        applyRequestSampleToConfig(sample, environment);
        return sample;
      }
    } catch {
      // 样本匹配失败不影响手动编辑请求参数。
    }
    setRequestConfig(fallbackConfig);
    return undefined;
  };
  const openRequest = (api: ApiItem, targetService: keyof typeof services = service, targetDoc: SwaggerDoc | undefined = doc) => {
    const environment: RequestEnvironment = 'test';
    setRequestApi(api);
    setRequestService(targetService);
    setRequestDoc(targetDoc);
    setRequestEnvironment(environment);
    setRequestConfig(createRequestConfig(api, targetDoc?.definitions || {}));
    setRequestResult(undefined);
    void loadAndApplyBestSample(api, targetService, environment, targetDoc);
    void refreshEnvironmentToken(environment);
  };
  const requestConfigKey = (environment: RequestEnvironment, api = requestApi) => api
    ? `api_request_config:${requestService}:${api.method}:${api.path}:${environment}`
    : '';
  const changeRequestEnvironment = (environment: RequestEnvironment) => {
    const currentKey = requestConfigKey(requestEnvironment);
    if (currentKey) localStorage.setItem(currentKey, JSON.stringify(requestConfig));
    setRequestEnvironment(environment);
    setRequestResult(undefined);
    if (requestApi) {
      setRequestConfig(createRequestConfig(requestApi, requestDoc?.definitions || {}));
      void loadAndApplyBestSample(requestApi, requestService, environment, requestDoc);
      void refreshEnvironmentToken(environment);
    } else {
      setRequestConfig({ headers: {}, query: {}, pathParams: {} });
    }
  };
  const changeKeyword = (value: string) => {
    setKeyword(value);
    setSearchMode('global');
    setPage(1);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      const query = value.trim();
      if (query) next.set('q', query);
      else next.delete('q');
      return next;
    }, { replace: true });
  };
  const saveSearchKeyword = (value = keyword) => {
    const query = value.trim();
    if (query.length < 2) return;
    setSearchHistory((current) => {
      const next = [query, ...current.filter((item) => item !== query)].slice(0, maxApiSearchHistory);
      localStorage.setItem(apiSearchHistoryKey, JSON.stringify(next));
      return next;
    });
  };
  useEffect(() => {
    const query = keyword.trim();
    if (query.length < 2) return;
    const timer = window.setTimeout(() => saveSearchKeyword(query), 1200);
    return () => window.clearTimeout(timer);
  }, [keyword]);
  const sendRequest = async () => {
    if (!requestApi) return;
    let token = environmentTokens[requestEnvironment].trim();
    if (!token) {
      const sample = await loadAndApplyBestSample(requestApi, requestService, requestEnvironment, requestDoc);
      token = sample?.token?.trim() || await refreshEnvironmentToken(requestEnvironment);
    }
    if (!token) { message.warning(`请先通过实时日志采集 ${requestEnvironment} 环境 token`); return; }
    try {
      setRequesting(true);
      const configKey = requestConfigKey(requestEnvironment);
      if (configKey) localStorage.setItem(configKey, JSON.stringify(requestConfig));
      const { data } = await axios.post<RequestResult>(`/api/api-docs/request/${requestService}`, {
        environment: requestEnvironment,
        path: requestApi.path,
        method: requestApi.method,
        token,
        ...requestConfig,
      }, { timeout: 70_000 });
      setRequestResult(data);
      if (data.tokenInvalid) {
        const nextTokens = { ...environmentTokens, [requestEnvironment]: '' };
        setEnvironmentTokens(nextTokens);
        localStorage.setItem('api_environment_tokens', JSON.stringify(nextTokens));
        message.warning(data.tokenInvalidReason ? `当前 token 已失效：${data.tokenInvalidReason}` : '当前 token 已失效，已从样本集合剔除');
      }
    } catch (reason) {
      const errorMessage = axios.isAxiosError(reason) ? reason.response?.data?.message || reason.message : reason instanceof Error ? reason.message : '请求失败';
      message.error(errorMessage);
    } finally {
      setRequesting(false);
    }
  };
  const openGlobalDetail = async (item: GlobalSearchItem) => {
    setDetailLoading(true);
    setDetailService(item.service);
    setDetailApi(undefined);
    setDetailDoc(undefined);
    try {
      const { data } = await axios.get<SwaggerDoc>(`/api/api-docs/${item.service}`, { timeout: 45_000 });
      const operation = data.paths?.[item.path]?.[item.method.toLowerCase()];
      if (!operation) throw new Error('接口详情不存在');
      setDetailDoc(data);
      const api = { ...operation, path: item.path, method: item.method, tag: operation.tags?.[0] || item.tag || '其他' };
      setDetailApi(api);
      void trackApiView(item.service, api);
    } catch (reason) {
      const errorMessage = axios.isAxiosError(reason) ? reason.response?.data?.message || reason.message : reason instanceof Error ? reason.message : '加载接口详情失败';
      message.error(errorMessage);
      setDetailService(undefined);
    } finally {
      setDetailLoading(false);
    }
  };
  const openCurrentDetail = (api: ApiItem) => {
    setDetailService(service);
    setDetailDoc(doc);
    setDetailApi(api);
    void trackApiView(service, api);
  };
  const trackApiView = async (targetService: keyof typeof services, api: ApiItem) => {
    try {
      await axios.post('/api/api-docs/records/view', { service: targetService, method: api.method, path: api.path, summary: api.summary || '', tag: api.tag || '' });
    } catch {
      // 查询记录失败不影响接口详情展示。
    }
  };
  const loadRecords = async () => {
    setRecordsOpen(true);
    setRecordsLoading(true);
    try {
      const { data } = await axios.get<{ data: ApiViewRecord[] }>('/api/api-docs/records/list');
      setRecords(data.data);
    } catch {
      message.error('查询记录加载失败');
    } finally {
      setRecordsLoading(false);
    }
  };
  const loadApiDiff = async () => {
    setDiffOpen(true);
    setDiffLoading(true);
    try {
      const { data } = await axios.get<ApiDocDiff>(`/api/api-docs/${service}/diff`, { timeout: 60_000 });
      setApiDiff(data);
    } catch (reason) {
      const errorMessage = axios.isAxiosError(reason) ? reason.response?.data?.message || reason.message : '接口变更对比失败';
      message.error(errorMessage);
    } finally {
      setDiffLoading(false);
    }
  };
  const filteredRecords = records.filter((record) => {
    const value = recordSearch.trim().toLowerCase();
    return !value || `${services[record.service]?.name || record.service} ${record.method} ${record.path} ${record.summary} ${record.tag}`.toLowerCase().includes(value);
  });
  const openRecordDetail = async (record: ApiViewRecord) => {
    setRecordsOpen(false);
    await openGlobalDetail({ ...record, basePath: '', operationId: '' });
  };
  const shareCurrentApi = async (
    api: ApiItem,
    targetService: keyof typeof services = service,
    targetDoc: SwaggerDoc | undefined = doc
  ) => {
    const url = new URL('/api-docs', window.location.origin);
    url.searchParams.set('service', targetService);
    url.searchParams.set('method', api.method);
    url.searchParams.set('path', api.path);
    if (keyword.trim()) url.searchParams.set('q', keyword.trim());
    const summary = api.summary || api.operationId || 'API 接口';
    const titleParts = [summary, api.tag].filter((item, index, array) => item && array.indexOf(item) === index);
    const copied = await copyTextToClipboard([
      titleParts.join('，'),
      `API接口: ${joinApiPath(targetDoc?.basePath, api.path)}`,
      `API文档: ${url.toString()}`,
    ].join('\n'));
    if (copied) message.success('分享内容已复制');
    else message.error('复制失败，请手动复制分享内容');
  };
  const globalItemToApi = (item: GlobalSearchItem): ApiItem => ({
    path: item.path,
    method: item.method,
    summary: item.summary,
    operationId: item.operationId,
    tag: item.tag,
  });
  const openGlobalRequest = async (item: GlobalSearchItem) => {
    try {
      const { data } = await axios.get<SwaggerDoc>(`/api/api-docs/${item.service}`, { timeout: 45_000 });
      const operation = data.paths?.[item.path]?.[item.method.toLowerCase()];
      openRequest(operation ? { ...operation, path: item.path, method: item.method, tag: operation.tags?.[0] || item.tag } : globalItemToApi(item), item.service, data);
    } catch (reason) {
      const errorMessage = axios.isAxiosError(reason) ? reason.response?.data?.message || reason.message : '加载在线请求配置失败';
      message.error(errorMessage);
    }
  };
  const shareGlobalApi = async (item: GlobalSearchItem) => {
    const url = new URL('/api-docs', window.location.origin);
    url.searchParams.set('service', item.service);
    url.searchParams.set('method', item.method);
    url.searchParams.set('path', item.path);
    if (keyword.trim()) url.searchParams.set('q', keyword.trim());
    const titleParts = [item.summary || item.operationId || 'API 接口', item.tag].filter((value, index, array) => value && array.indexOf(value) === index);
    const copied = await copyTextToClipboard([titleParts.join('，'), `API接口: ${joinApiPath(item.basePath, item.path)}`, `API文档: ${url.toString()}`].join('\n'));
    if (copied) message.success('分享内容已复制');
    else message.error('复制失败，请手动复制分享内容');
  };
  const editableRequestSections = (['pathParams', 'query', 'body'] as const)
    .map((section) => ({ section, fields: flattenEditableFields(requestConfig[section]) }))
    .filter((item) => item.fields.length > 0);
  return <div className="api-docs-page">
    <div className="api-docs-title">
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Space><ApiOutlined style={{ fontSize: 28, color: '#1677ff' }} /><Title level={2} style={{ margin: 0 }}>API 接口文档</Title></Space>
        <Space>
          <Button size="large" icon={<CodeOutlined />} onClick={() => setResponseCodesOpen(true)}>响应码查询</Button>
          <Button size="large" icon={<DiffOutlined />} onClick={loadApiDiff}>变更对比</Button>
          <Button size="large" icon={<HistoryOutlined />} onClick={loadRecords}>查询记录</Button>
          {isAdmin && <Button type="primary" size="large" icon={<SyncOutlined spin={syncing} />} loading={syncing} onClick={syncAllDocuments}>同步API</Button>}
        </Space>
      </Space>
    </div>
    <Card className="api-docs-global-search" styles={{ body: { padding: 16 } }}>
      <AutoComplete
        value={keyword}
        options={searchHistoryOptions}
        onChange={changeKeyword}
        onSelect={(value) => {
          changeKeyword(value);
          saveSearchKeyword(value);
        }}
        style={{ width: '100%' }}
      >
        <Input
          size="large"
          allowClear
          prefix={<SearchOutlined style={{ color: '#1677ff' }} />}
          placeholder="全局查询当前服务的接口名称、路径、Operation ID 或接口分组"
          onBlur={() => saveSearchKeyword()}
          onPressEnter={(event) => saveSearchKeyword(event.currentTarget.value)}
        />
      </AutoComplete>
    </Card>

    <div className="api-docs-workspace">
      <Card className="api-docs-sidebar" title={<Space><ApiOutlined />服务类型</Space>} styles={{ body: { padding: '8px 0' } }}>
        <Menu
          mode="inline"
          selectedKeys={[service]}
          onClick={({ key }) => setService(key as keyof typeof services)}
          items={Object.entries(services).map(([key, item]) => ({ key, label: item.name }))}
          style={{ borderInlineEnd: 0 }}
        />
      </Card>

      <main className="api-docs-content">
        {searchMode === 'global' && keyword.trim().length >= 2 ? <>
          <Card className="api-docs-service-header" styles={{ body: { padding: 20 } }}>
            <Title level={3} style={{ margin: 0 }}>全局查询结果</Title>
            <Paragraph type="secondary" style={{ margin: '6px 0 0' }}>在全部 {Object.keys(services).length} 个服务中模糊查询“{keyword.trim()}”，找到 {globalTotal} 个接口{globalTotal > 200 ? '，当前展示前 200 个' : ''}</Paragraph>
          </Card>
          <Spin spinning={globalSearching}><Space direction="vertical" size={10} style={{ width: '100%' }}>
            {!globalSearching && globalResults.length === 0 && <Empty description="没有找到匹配的接口" />}
            {globalResults.map((item) => <Card key={`${item.service}-${item.method}-${item.path}`} size="small" hoverable onClick={() => openGlobalDetail(item)}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                <Space wrap><Tag color={item.method === 'GET' ? 'blue' : 'green'}>{item.method}</Tag><Tag color="purple">{services[item.service]?.name || item.service}</Tag><Text code>{joinApiPath(item.basePath, item.path)}</Text><Text strong>{item.summary}</Text><Text type="secondary">{item.tag}</Text></Space>
                <Space onClick={(event) => event.stopPropagation()}>
                  {renderOriginalDocumentButton(globalItemToApi(item), item.service, item.fallbackDocument)}
                  <Button type="primary" ghost icon={<PlayCircleOutlined />} onClick={() => openGlobalRequest(item)}>在线请求</Button>
                  <Button type="text" icon={<ShareAltOutlined />} onClick={() => shareGlobalApi(item)}>分享</Button>
                </Space>
              </div>
            </Card>)}
          </Space></Spin>
        </> : <>
        <Card className="api-docs-service-header" styles={{ body: { padding: 20 } }}>
          <Title level={3} style={{ margin: 0 }}>{services[service].name}</Title>
        </Card>

        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        <Spin spinning={loading}><Space direction="vertical" size={12} style={{ width: '100%' }}>
      {!loading && filteredApis.length === 0 && <Empty description="没有匹配的接口" />}
      {pagedApis.map((api) => <Card
        className="api-docs-api-card"
        key={`${api.method}-${api.path}`}
        size="small"
        hoverable
        onClick={() => openCurrentDetail(api)}
        styles={{ body: { padding: '12px 16px' } }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <Space wrap>
            <Tag color={api.method === 'GET' ? 'blue' : 'green'}>{api.method}</Tag>
            <Text code>{joinApiPath(doc?.basePath, api.path)}</Text>
            <Text strong>{api.summary}</Text>
            <Text type="secondary">{api.tag}</Text>
          </Space>
          <Space onClick={(event) => event.stopPropagation()}>
            {renderOriginalDocumentButton(api, service, doc?.xFallbackDocument)}
            <Button type="primary" ghost icon={<PlayCircleOutlined />} onClick={() => openRequest(api)}>在线请求</Button>
            <Button type="text" icon={<ShareAltOutlined />} onClick={() => shareCurrentApi(api)}>分享</Button>
          </Space>
        </div>
      </Card>)}
      {filteredApis.length > pageSize && <Pagination current={page} pageSize={pageSize} total={filteredApis.length} showSizeChanger={false} showQuickJumper onChange={setPage} style={{ alignSelf: 'center', paddingTop: 8 }} />}
        </Space></Spin>
        </>}
      </main>
    </div>
    <Modal title={requestApi ? `在线请求：${requestApi.method} ${joinApiPath(requestDoc?.basePath, requestApi.path)}` : '在线请求'} open={Boolean(requestApi)} onCancel={() => setRequestApi(undefined)} width={900} footer={null} destroyOnHidden>
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Space wrap style={{ width: '100%' }}>
          <Select value={requestEnvironment} onChange={changeRequestEnvironment} style={{ width: 220 }} options={[{ value: 'release', label: 'release 环境' }, { value: 'test', label: 'test 环境（默认）' }, { value: 'test1', label: 'test1 环境' }]} />
          <Button type="primary" icon={<PlayCircleOutlined />} loading={requesting} onClick={sendRequest}>发送请求</Button>
        </Space>
        <Alert type="info" showIcon message={`当前使用 ${requestEnvironment} 环境 token。token 可从日志样本自动更新；公共参数自动注入，timeStamp 在发送瞬间生成。`} />
        {editableRequestSections.length > 0 && <div>
          <Text strong>业务请求参数</Text>
          <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 10 }}>
            {editableRequestSections.map(({ section, fields }) => {
              const sectionName = section === 'pathParams' ? 'Path' : section === 'query' ? 'Query' : 'Body';
              return <Card key={section} size="small" title={sectionName} styles={{ body: { padding: 12 } }}>
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  {fields.map((field) => <div key={field.path} style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 38%) minmax(0, 1fr)', gap: 12, alignItems: 'center' }}>
                    <Text code>{field.path}</Text>
                    {field.type === 'number'
                      ? <InputNumber value={field.value as number} onChange={(value) => setRequestConfig((current) => updateValueAtPath(current, section, field.path, value ?? 0))} style={{ width: '100%' }} />
                      : field.type === 'boolean'
                        ? <Select value={field.value as boolean} onChange={(value) => setRequestConfig((current) => updateValueAtPath(current, section, field.path, value))} options={[{ value: true, label: 'true' }, { value: false, label: 'false' }]} />
                        : <Input value={String(field.value ?? '')} onChange={(event) => setRequestConfig((current) => updateValueAtPath(current, section, field.path, event.target.value))} />}
                  </div>)}
                </Space>
              </Card>;
            })}
          </Space>
        </div>}
        {requestResult && <Card size="small" title={<Space><Tag color={requestResult.status >= 200 && requestResult.status < 300 ? 'green' : 'red'}>{requestResult.status}</Tag><Text>{requestResult.statusText}</Text><Text type="secondary">{requestResult.duration}ms</Text></Space>}>
          <Paragraph copyable style={{ wordBreak: 'break-all' }}>{requestResult.url}</Paragraph>
          <pre style={{ margin: 0, padding: 14, borderRadius: 8, background: '#f6f8fa', overflow: 'auto', maxHeight: 480 }}>{JSON.stringify(requestResult.data, null, 2)}</pre>
        </Card>}
      </Space>
    </Modal>
    <Modal title={`${services[service].name} · 响应码查询`} open={responseCodesOpen} onCancel={() => setResponseCodesOpen(false)} footer={null} width={1000}>
      <Input allowClear prefix={<SearchOutlined />} placeholder="查询响应码或状态说明" value={responseCodeSearch} onChange={(event) => setResponseCodeSearch(event.target.value)} style={{ marginBottom: 16 }} />
      <Tabs items={[
        { key: 'business', label: `业务 retCode（${filteredBusinessResponseCodes.length}）`, children: <Table rowKey="code" size="small" pagination={false} dataSource={filteredBusinessResponseCodes} scroll={{ y: 520 }} columns={[
          { title: 'retCode', dataIndex: 'code', width: 180, render: (value: string) => <Tag color={value === '100' ? 'green' : 'red'}>{value}</Tag> },
          { title: 'errMsg / retMsg 或处理语义', dataIndex: 'description' },
        ]} /> },
        { key: 'http', label: `HTTP 状态码（${filteredResponseCodes.length}）`, children: <Table rowKey="code" size="small" pagination={false} dataSource={filteredResponseCodes} scroll={{ y: 520 }} columns={[
          { title: '响应码', dataIndex: 'code', width: 120, render: (value: string) => <Tag color={value === '200' ? 'green' : value.startsWith('4') || value.startsWith('5') ? 'red' : 'blue'}>{value}</Tag> },
          { title: '状态说明', dataIndex: 'descriptions', render: (values: string[]) => values.join(' / ') },
        ]} /> },
      ]} />
    </Modal>
    <Modal title="接口查询记录" open={recordsOpen} onCancel={() => setRecordsOpen(false)} footer={null} width={1100}>
      <Input allowClear prefix={<SearchOutlined />} placeholder="查询服务、接口名称或路径" value={recordSearch} onChange={(event) => setRecordSearch(event.target.value)} style={{ marginBottom: 16 }} />
      <Table
        rowKey={(record) => `${record.service}-${record.method}-${record.path}`}
        loading={recordsLoading}
        size="small"
        dataSource={filteredRecords}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        onRow={(record) => ({ onClick: () => openRecordDetail(record), style: { cursor: 'pointer' } })}
        columns={[
          { title: '服务', dataIndex: 'service', width: 210, render: (value: keyof typeof services) => <Tag color="purple">{services[value]?.name || value}</Tag> },
          { title: '方式', dataIndex: 'method', width: 90, render: (value: string) => <Tag color={value === 'GET' ? 'blue' : 'green'}>{value}</Tag> },
          { title: '接口路径', dataIndex: 'path', render: (value: string) => <Text code>{value}</Text> },
          { title: '接口名称', dataIndex: 'summary' },
          { title: '访问次数', dataIndex: 'viewCount', width: 100, sorter: (a: ApiViewRecord, b: ApiViewRecord) => a.viewCount - b.viewCount },
          { title: '最近访问', dataIndex: 'lastViewedAt', width: 180, render: (value: string) => new Date(value).toLocaleString('zh-CN') },
        ]}
      />
    </Modal>
    <Modal
      title={`${services[service].name} · 接口变更对比`}
      open={diffOpen}
      onCancel={() => setDiffOpen(false)}
      footer={null}
      width={1180}
    >
      <Spin spinning={diffLoading}>
        {apiDiff && (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            {!apiDiff.hasBaseline && <Alert type="info" showIcon message={apiDiff.message || '暂无上一版 API 文档快照'} />}
            {apiDiff.hasBaseline && <Alert type="info" showIcon message={apiDiff.mode === 'cached-vs-latest' ? '当前对比：本地已同步文档 vs 最新上游文档，不会更新本地缓存' : '当前对比：上一版同步快照 vs 当前本地文档'} />}
            {(apiDiff.currentFallback || apiDiff.previousFallback) && <Alert type="warning" showIcon message="当前或上一版包含兜底文档，对比结果仅供参考" />}
            <Space wrap>
              <Tag color="green">新增 {apiDiff.summary.added}</Tag>
              <Tag color="red">删除 {apiDiff.summary.removed}</Tag>
              <Tag color="orange">变更 {apiDiff.summary.changed}</Tag>
            </Space>
            <Tabs items={[
              { key: 'added', label: `新增（${apiDiff.added.length}）`, children: <Table rowKey="key" size="small" pagination={{ pageSize: 10 }} dataSource={apiDiff.added} columns={apiChangeColumns} scroll={{ x: 900 }} /> },
              { key: 'removed', label: `删除（${apiDiff.removed.length}）`, children: <Table rowKey="key" size="small" pagination={{ pageSize: 10 }} dataSource={apiDiff.removed} columns={apiChangeColumns} scroll={{ x: 900 }} /> },
              { key: 'changed', label: `变更（${apiDiff.changed.length}）`, children: <Table rowKey="key" size="small" pagination={{ pageSize: 10 }} dataSource={apiDiff.changed} columns={apiChangeColumns} scroll={{ x: 900 }} /> },
            ]} />
          </Space>
        )}
      </Spin>
    </Modal>
    <Modal
      title={detailApi && detailService && detailDoc ? (
        <Space wrap style={{ width: '100%', justifyContent: 'space-between', paddingRight: 32 }}>
          <Space wrap>
            <Tag color={detailApi.method === 'GET' ? 'blue' : 'green'}>{detailApi.method}</Tag>
            <Text code>{joinApiPath(detailDoc?.basePath, detailApi.path)}</Text>
            <Text strong>{detailApi.summary}</Text>
          </Space>
          <Button
            size="small"
            type="text"
            icon={<ShareAltOutlined />}
            onClick={(event) => {
              event.stopPropagation();
              void shareCurrentApi(detailApi, detailService, detailDoc);
            }}
          >
            分享
          </Button>
        </Space>
      ) : '接口详情'}
      open={Boolean(detailService)}
      onCancel={() => { setDetailService(undefined); setDetailApi(undefined); setDetailDoc(undefined); }}
      footer={null}
      width={1100}
    >
      <Spin spinning={detailLoading}>
        {detailApi && detailDoc && (() => {
          const businessParameters = (detailApi.parameters || []).filter((parameter) => parameter.in !== 'header');
          const expandedParameters = requestFields(businessParameters, detailDoc.definitions || {});
          const customResponses = Object.entries(detailApi.responses || {}).filter(([code]) => !new Set(['200', '201', '401', '403', '404']).has(code));
          return <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Space><Tag color="purple">{detailService ? services[detailService].name : ''}</Tag><Text type="secondary">{detailApi.tag}</Text></Space>
            <Card size="small" title="请求参数">
              {expandedParameters.length > 0 ? (
                <Table rowKey={(row) => `${row.in}-${row.name}-${row.level}`} size="small" pagination={false} columns={parameterColumns} dataSource={expandedParameters} scroll={{ x: 800 }} />
              ) : (
                <Text type="secondary">-</Text>
              )}
            </Card>
            {customResponses.length > 0 && <Card size="small" title="响应状态"><Table rowKey="code" size="small" pagination={false} dataSource={customResponses.map(([code, value]) => ({ code, description: value.description || '-' }))} columns={[{ title: 'HTTP 状态码', dataIndex: 'code', width: 160, render: (value: string) => <Tag color={value.startsWith('4') || value.startsWith('5') ? 'red' : 'blue'}>{value}</Tag> }, { title: '状态说明', dataIndex: 'description' }]} /></Card>}
            {Object.entries(detailApi.responses || {}).filter(([, value]) => Boolean(value.schema)).map(([code, value]) => {
              const fields = value.schema ? nestedRequestFields(value.schema, detailDoc.definitions || {}) : [];
              const jsonExample = value.schema ? sampleValue(value.schema, detailDoc.definitions || {}) : null;
              return fields.length ? <Card key={code} size="small" title="响应参数"><Tabs items={[
                { key: 'table', label: '参数表格', children: <Table rowKey={(row) => `${row.name}-${row.level}`} size="small" pagination={false} columns={responseFieldColumns} dataSource={fields} scroll={{ x: 800 }} /> },
                { key: 'json', label: 'JSON 格式', children: <pre style={{ margin: 0, padding: 16, borderRadius: 8, background: '#f6f8fa', overflow: 'auto', maxHeight: 520 }}>{JSON.stringify(jsonExample, null, 2)}</pre> },
                { key: 'mock', label: 'Mock 数据', children: <pre style={{ margin: 0, padding: 16, borderRadius: 8, background: '#f6f8fa', overflow: 'auto', maxHeight: 520 }}>{JSON.stringify(jsonExample, null, 2)}</pre> },
              ]} /></Card> : null;
            })}
          </Space>;
        })()}
      </Spin>
    </Modal>
  </div>;
}
