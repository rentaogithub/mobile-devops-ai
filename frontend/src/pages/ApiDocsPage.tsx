import { ApiOutlined, CodeOutlined, CopyOutlined, LinkOutlined, PlayCircleOutlined, SearchOutlined, SettingOutlined, SyncOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Collapse, Empty, Input, InputNumber, Menu, Modal, Pagination, Select, Space, Spin, Table, Tabs, Tag, Typography, message } from 'antd';
import axios from 'axios';
import { useEffect, useMemo, useState } from 'react';
import { authUtils } from '../utils/auth';

const { Title, Paragraph, Text } = Typography;

type Schema = { type?: string; format?: string; description?: string; $ref?: string; items?: Schema; properties?: Record<string, Schema>; required?: string[] };
type Parameter = Schema & { name: string; in: string; required?: boolean; schema?: Schema; default?: unknown };
type Operation = { summary?: string; operationId?: string; tags?: string[]; parameters?: Parameter[]; responses?: Record<string, { description?: string; schema?: Schema }> };
type SwaggerDoc = { swagger: string; host?: string; basePath?: string; info?: { title?: string; version?: string }; paths: Record<string, Record<string, Operation>>; definitions?: Record<string, Schema>; tags?: { name: string }[] };
type ApiItem = Operation & { path: string; method: string; tag: string };
type GlobalSearchItem = { service: keyof typeof services; basePath: string; path: string; method: string; summary: string; operationId: string; tag: string };
type RequestConfig = { headers: Record<string, unknown>; query: Record<string, unknown>; pathParams: Record<string, unknown>; body?: unknown };
type RequestResult = { status: number; statusText: string; duration: number; url: string; requestHeaders: Record<string, string>; data: unknown };
type RequestEnvironment = 'release' | 'test' | 'test1';
type EnvironmentTokens = Record<RequestEnvironment, string>;
type ResponseCodeSummary = { code: string; descriptions: string[]; interfaces: { method: string; path: string; summary: string }[] };

const services = {
  'user-query': { name: '用户查询服务', source: 'https://test1-doc.nn.com/doc.html#/用户查询服务' },
  'u-mobile': { name: '移动端接入层', source: 'https://test1-doc.nn.com/doc.html#/移动端接入层' },
  'nchannel': { name: '社区频道接口文档', source: 'https://test1-doc.nn.com/doc.html#/社区频道接口文档' },
  'wan-app': { name: 'NN陪玩：app接口', source: 'https://test1-doc.nn.com/doc.html#/NN陪玩：app接口' },
  'nn-risk-v1': { name: 'NN风控审核服务:V1', source: 'https://test1-doc.nn.com/doc.html#/NN风控审核服务:V1' },
  'operation-server': { name: 'operationServer', source: 'https://test1-doc.nn.com/doc.html#/operationServer' },
  'im-friend': { name: '雷神IM好友服务客户端接口', source: 'https://test1-doc.nn.com/doc.html#/雷神IM好友服务客户端接口' },
  'order-open-api': { name: 'order-open-api', source: 'https://test1-doc.nn.com/doc.html#/order-open-api' },
  'wan-v1': { name: 'v1-NN陪玩接口', source: 'https://test1-doc.nn.com/doc.html#/v1-NN陪玩接口' },
  'wan-v2': { name: 'v2-NN陪玩接口', source: 'https://test1-doc.nn.com/doc.html#/v2-NN陪玩接口' },
  'wan-v3': { name: 'v3-NN陪玩接口', source: 'https://test1-doc.nn.com/doc.html#/v3-NN陪玩接口' },
  'leigod-rtc': { name: '雷神rtc客户端接口', source: 'https://test1-doc.nn.com/doc.html#/雷神rtc客户端接口' },
  'privilege': { name: '雷神用户权益客户端接口', source: 'https://test1-doc.nn.com/doc.html#/雷神用户权益客户端接口' },
  'nn-game': { name: '雷神赛事客户端接口', source: 'https://test1-doc.nn.com/doc.html#/雷神赛事客户端接口' },
  'union-server': { name: 'unionServer', source: 'https://test1-doc.nn.com/doc.html#/unionServer' },
  'nn-status': { name: 'NN状态服务', source: 'https://test1-doc.nn.com/doc.html#/NN状态服务' },
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

const schemaReferenceName = (schema?: Schema): string => {
  if (!schema) return '';
  if (schema.$ref) return decodeURIComponent(schema.$ref.split('/').pop() || '');
  if (schema.type === 'array') return schemaReferenceName(schema.items) || schema.items?.type || '';
  return '';
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
    const row: RequestField = {
      name,
      in: level === 0 ? 'body' : '',
      dataType: isArray ? 'array' : propertyResolved.type || property.type || 'object',
      schema: schemaReferenceName(property) || (isArray ? property.items?.type || '' : ''),
      required: resolved.required?.includes(name) || false,
      description: property.description || propertyResolved.description || '-',
      level,
    };
    const childSchema = isArray ? property.items : property;
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

const sampleValue = (schema: Schema | undefined, definitions: Record<string, Schema>, depth = 0): unknown => {
  if (!schema || depth > 4) return null;
  const resolved = resolveSchema(schema, definitions) || schema;
  if (resolved.type === 'array') return [sampleValue(resolved.items, definitions, depth + 1)];
  if (resolved.properties) return Object.fromEntries(Object.entries(resolved.properties).map(([key, value]) => [key, sampleValue(value, definitions, depth + 1)]));
  if (resolved.type === 'integer' || resolved.type === 'number') return 0;
  if (resolved.type === 'boolean') return false;
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

type EditableField = { path: string; value: string | number | boolean; type: string };

const flattenEditableFields = (value: unknown, prefix = ''): EditableField[] => {
  if (Array.isArray(value)) return value.flatMap((item, index) => flattenEditableFields(item, `${prefix}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => flattenEditableFields(item, prefix ? `${prefix}.${key}` : key));
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

export default function ApiDocsPage() {
  const [service, setService] = useState<keyof typeof services>('user-query');
  const [doc, setDoc] = useState<SwaggerDoc>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [syncing, setSyncing] = useState(false);
  const [globalResults, setGlobalResults] = useState<GlobalSearchItem[]>([]);
  const [globalTotal, setGlobalTotal] = useState(0);
  const [globalSearching, setGlobalSearching] = useState(false);
  const [searchMode, setSearchMode] = useState<'global' | 'service'>('global');
  const [requestApi, setRequestApi] = useState<ApiItem>();
  const [requestEnvironment, setRequestEnvironment] = useState<RequestEnvironment>('test');
  const [environmentTokens, setEnvironmentTokens] = useState<EnvironmentTokens>(readEnvironmentTokens);
  const [tokenSettingsOpen, setTokenSettingsOpen] = useState(false);
  const [responseCodesOpen, setResponseCodesOpen] = useState(false);
  const [responseCodeSearch, setResponseCodeSearch] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailService, setDetailService] = useState<keyof typeof services>();
  const [detailDoc, setDetailDoc] = useState<SwaggerDoc>();
  const [detailApi, setDetailApi] = useState<ApiItem>();
  const [requestConfig, setRequestConfig] = useState<RequestConfig>({ headers: {}, query: {}, pathParams: {} });
  const [requesting, setRequesting] = useState(false);
  const [requestResult, setRequestResult] = useState<RequestResult>();
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
    const text = `${api.path} ${api.summary} ${api.operationId} ${api.tag}`.toLowerCase();
    return text.includes(keyword.trim().toLowerCase());
  }), [apis, keyword]);
  const pagedApis = useMemo(() => filteredApis.slice((page - 1) * pageSize, page * pageSize), [filteredApis, page]);
  const responseCodeSummaries = useMemo<ResponseCodeSummary[]>(() => {
    const summaries = new Map<string, ResponseCodeSummary>();
    for (const api of apis) {
      for (const [code, response] of Object.entries(api.responses || {})) {
        const current = summaries.get(code) || { code, descriptions: [], interfaces: [] };
        const description = response.description || '-';
        if (!current.descriptions.includes(description)) current.descriptions.push(description);
        current.interfaces.push({ method: api.method, path: `${doc?.basePath || ''}${api.path}`, summary: api.summary || '' });
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
  const fullUrl = (path: string) => `https://${doc?.host || 'test1-doc.nn.com'}${doc?.basePath || ''}${path}`;
  const originalDocumentUrl = (api: ApiItem) => `${services[service].source}/${encodeURIComponent(api.tag)}/${encodeURIComponent(api.operationId || api.path)}`;
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
  const openRequest = (api: ApiItem) => {
    const environment: RequestEnvironment = 'test';
    setRequestApi(api);
    setRequestEnvironment(environment);
    const saved = localStorage.getItem(`api_request_config:${service}:${api.method}:${api.path}:${environment}`);
    setRequestConfig(saved ? JSON.parse(saved) : createRequestConfig(api, doc?.definitions || {}));
    setRequestResult(undefined);
  };
  const requestConfigKey = (environment: RequestEnvironment, api = requestApi) => api
    ? `api_request_config:${service}:${api.method}:${api.path}:${environment}`
    : '';
  const changeRequestEnvironment = (environment: RequestEnvironment) => {
    const currentKey = requestConfigKey(requestEnvironment);
    if (currentKey) localStorage.setItem(currentKey, JSON.stringify(requestConfig));
    setRequestEnvironment(environment);
    const nextKey = requestConfigKey(environment);
    const saved = nextKey && localStorage.getItem(nextKey);
    setRequestConfig(saved ? JSON.parse(saved) : requestApi ? createRequestConfig(requestApi, doc?.definitions || {}) : { headers: {}, query: {}, pathParams: {} });
    setRequestResult(undefined);
  };
  const saveTokenSettings = () => {
    localStorage.setItem('api_environment_tokens', JSON.stringify(environmentTokens));
    setTokenSettingsOpen(false);
    message.success('环境 token 配置已保存');
  };
  const sendRequest = async () => {
    if (!requestApi) return;
    const token = environmentTokens[requestEnvironment].trim();
    if (!token) { message.warning(`请先在顶部配置 ${requestEnvironment} 环境 token`); return; }
    try {
      setRequesting(true);
      const configKey = requestConfigKey(requestEnvironment);
      if (configKey) localStorage.setItem(configKey, JSON.stringify(requestConfig));
      const { data } = await axios.post<RequestResult>(`/api/api-docs/request/${service}`, {
        environment: requestEnvironment,
        path: requestApi.path,
        method: requestApi.method,
        token,
        ...requestConfig,
      }, { timeout: 70_000 });
      setRequestResult(data);
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
      setDetailApi({ ...operation, path: item.path, method: item.method, tag: operation.tags?.[0] || item.tag || '其他' });
    } catch (reason) {
      const errorMessage = axios.isAxiosError(reason) ? reason.response?.data?.message || reason.message : reason instanceof Error ? reason.message : '加载接口详情失败';
      message.error(errorMessage);
      setDetailService(undefined);
    } finally {
      setDetailLoading(false);
    }
  };

  return <div className="api-docs-page">
    <div className="api-docs-title">
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Space><ApiOutlined style={{ fontSize: 28, color: '#1677ff' }} /><Title level={2} style={{ margin: 0 }}>API 接口文档</Title></Space>
        <Space>
          <Button size="large" icon={<SettingOutlined />} onClick={() => setTokenSettingsOpen(true)}>请求配置</Button>
          <Button size="large" icon={<CodeOutlined />} onClick={() => setResponseCodesOpen(true)}>响应码查询</Button>
          {isAdmin && <Button type="primary" size="large" icon={<SyncOutlined spin={syncing} />} loading={syncing} onClick={syncAllDocuments}>同步API</Button>}
        </Space>
      </Space>
    </div>
    <Card className="api-docs-global-search" styles={{ body: { padding: 16 } }}>
      <Input
        size="large"
        allowClear
        prefix={<SearchOutlined style={{ color: '#1677ff' }} />}
        placeholder="全局查询当前服务的接口名称、路径、Operation ID 或接口分组"
        value={keyword}
        onChange={(e) => { setKeyword(e.target.value); setSearchMode('global'); setPage(1); }}
      />
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
              <Space wrap><Tag color={item.method === 'GET' ? 'blue' : 'green'}>{item.method}</Tag><Tag color="purple">{services[item.service]?.name || item.service}</Tag><Text code>{`${item.basePath}${item.path}`}</Text><Text strong>{item.summary}</Text><Text type="secondary">{item.tag}</Text></Space>
            </Card>)}
          </Space></Spin>
        </> : <>
        <Card className="api-docs-service-header" styles={{ body: { padding: 20 } }}>
          <Title level={3} style={{ margin: 0 }}>{services[service].name}</Title>
        </Card>

        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        <Spin spinning={loading}><Space direction="vertical" size={12} style={{ width: '100%' }}>
      {!loading && filteredApis.length === 0 && <Empty description="没有匹配的接口" />}
      {pagedApis.map((api) => {
        const businessParameters = (api.parameters || []).filter((parameter) => parameter.in !== 'header');
        const expandedBusinessParameters = requestFields(businessParameters, doc?.definitions || {});
        const commonResponseStatuses = new Set(['200', '201', '401', '403', '404']);
        const customResponses = Object.entries(api.responses || {}).filter(([code]) => !commonResponseStatuses.has(code));
        return <Card className="api-docs-api-card" key={`${api.method}-${api.path}`} title={<Space wrap><Tag color={api.method === 'GET' ? 'blue' : 'green'}>{api.method}</Tag><Text code>{`${doc?.basePath || ''}${api.path}`}</Text><Text strong>{api.summary}</Text></Space>}
        extra={<Space><Button type="link" icon={<LinkOutlined />} href={originalDocumentUrl(api)} target="_blank">原始文档</Button><Button type="primary" ghost icon={<PlayCircleOutlined />} onClick={() => openRequest(api)}>在线请求</Button><Button type="text" icon={<CopyOutlined />} onClick={() => navigator.clipboard.writeText(fullUrl(api.path)).then(() => message.success('接口地址已复制'))}>复制地址</Button></Space>}>
        <Collapse items={[
          ...(expandedBusinessParameters.length ? [{ key: 'parameters', label: '请求参数', children: <Table rowKey={(row) => `${row.in}-${row.name}`} size="small" pagination={false} columns={parameterColumns} dataSource={expandedBusinessParameters} scroll={{ x: 800 }} /> }] : []),
          ...(customResponses.length ? [{ key: 'status', label: `响应状态（${customResponses.length}）`, children: <Table
            rowKey="code"
            size="small"
            pagination={false}
            dataSource={customResponses.map(([code, value]) => ({ code, description: value.description || '-' }))}
            columns={[
              { title: 'HTTP 状态码', dataIndex: 'code', width: 160, render: (value: string) => <Tag color={value === '200' ? 'green' : value.startsWith('4') || value.startsWith('5') ? 'red' : 'blue'}>{value}</Tag> },
              { title: '状态说明', dataIndex: 'description' },
            ]}
          /> }] : []),
          { key: 'responses', label: '响应参数', children: <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {Object.entries(api.responses || {}).filter(([, value]) => Boolean(value.schema)).map(([code, value]) => {
              const fields = value.schema ? nestedRequestFields(value.schema, doc?.definitions || {}) : [];
              return fields.length > 0
                ? <Table key={code} rowKey="name" size="small" pagination={false} columns={responseFieldColumns} dataSource={fields} scroll={{ x: 800 }} />
                : null;
            })}
          </Space> },
        ]} />
      </Card>;})}
      {filteredApis.length > pageSize && <Pagination current={page} pageSize={pageSize} total={filteredApis.length} showSizeChanger={false} showQuickJumper onChange={setPage} style={{ alignSelf: 'center', paddingTop: 8 }} />}
        </Space></Spin>
        </>}
      </main>
    </div>
    <Modal title={requestApi ? `在线请求：${requestApi.method} ${doc?.basePath || ''}${requestApi.path}` : '在线请求'} open={Boolean(requestApi)} onCancel={() => setRequestApi(undefined)} width={900} footer={null} destroyOnHidden>
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Space wrap style={{ width: '100%' }}>
          <Select value={requestEnvironment} onChange={changeRequestEnvironment} style={{ width: 220 }} options={[{ value: 'release', label: 'release 环境' }, { value: 'test', label: 'test 环境（默认）' }, { value: 'test1', label: 'test1 环境' }]} />
          <Button type="primary" icon={<PlayCircleOutlined />} loading={requesting} onClick={sendRequest}>发送请求</Button>
        </Space>
        <Alert type="info" showIcon message={`当前使用 ${requestEnvironment} 环境 token。公共参数自动注入，timeStamp 在发送瞬间生成；业务参数按接口和环境分别保存。`} />
        <div>
          <Text strong>业务请求参数</Text>
          <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 10 }}>
            {(['pathParams', 'query', 'body'] as const).flatMap((section) => {
              const fields = flattenEditableFields(requestConfig[section]);
              if (!fields.length) return [];
              const sectionName = section === 'pathParams' ? 'Path' : section === 'query' ? 'Query' : 'Body';
              return [<Card key={section} size="small" title={sectionName} styles={{ body: { padding: 12 } }}>
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
              </Card>];
            })}
            {flattenEditableFields(requestConfig.pathParams).length + flattenEditableFields(requestConfig.query).length + flattenEditableFields(requestConfig.body).length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该接口没有业务请求参数" />}
          </Space>
        </div>
        {requestResult && <Card size="small" title={<Space><Tag color={requestResult.status >= 200 && requestResult.status < 300 ? 'green' : 'red'}>{requestResult.status}</Tag><Text>{requestResult.statusText}</Text><Text type="secondary">{requestResult.duration}ms</Text></Space>}>
          <Paragraph copyable style={{ wordBreak: 'break-all' }}>{requestResult.url}</Paragraph>
          <pre style={{ margin: 0, padding: 14, borderRadius: 8, background: '#f6f8fa', overflow: 'auto', maxHeight: 480 }}>{JSON.stringify(requestResult.data, null, 2)}</pre>
        </Card>}
      </Space>
    </Modal>
    <Modal title="请求环境配置" open={tokenSettingsOpen} onCancel={() => setTokenSettingsOpen(false)} onOk={saveTokenSettings} okText="保存配置" cancelText="取消" width={640}>
      <Space direction="vertical" size={16} style={{ width: '100%', paddingTop: 8 }}>
        <Alert type="info" showIcon message="为三套环境分别配置公共参数 token。配置仅保存在当前浏览器，不会上传到平台数据库。" />
        {(['release', 'test', 'test1'] as RequestEnvironment[]).map((environment) => <div key={environment}>
          <Text strong>{environment} 环境 token</Text>
          <Input.Password value={environmentTokens[environment]} onChange={(event) => setEnvironmentTokens((current) => ({ ...current, [environment]: event.target.value }))} placeholder={`请输入 ${environment} 环境 token`} style={{ marginTop: 6 }} />
        </div>)}
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
    <Modal
      title={detailApi && detailService ? <Space wrap><Tag color={detailApi.method === 'GET' ? 'blue' : 'green'}>{detailApi.method}</Tag><Text code>{`${detailDoc?.basePath || ''}${detailApi.path}`}</Text><Text strong>{detailApi.summary}</Text></Space> : '接口详情'}
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
            {expandedParameters.length > 0 && <Card size="small" title="请求参数"><Table rowKey={(row) => `${row.in}-${row.name}-${row.level}`} size="small" pagination={false} columns={parameterColumns} dataSource={expandedParameters} scroll={{ x: 800 }} /></Card>}
            {customResponses.length > 0 && <Card size="small" title="响应状态"><Table rowKey="code" size="small" pagination={false} dataSource={customResponses.map(([code, value]) => ({ code, description: value.description || '-' }))} columns={[{ title: 'HTTP 状态码', dataIndex: 'code', width: 160, render: (value: string) => <Tag color={value.startsWith('4') || value.startsWith('5') ? 'red' : 'blue'}>{value}</Tag> }, { title: '状态说明', dataIndex: 'description' }]} /></Card>}
            {Object.entries(detailApi.responses || {}).filter(([, value]) => Boolean(value.schema)).map(([code, value]) => {
              const fields = value.schema ? nestedRequestFields(value.schema, detailDoc.definitions || {}) : [];
              return fields.length ? <Card key={code} size="small" title="响应参数"><Table rowKey={(row) => `${row.name}-${row.level}`} size="small" pagination={false} columns={responseFieldColumns} dataSource={fields} scroll={{ x: 800 }} /></Card> : null;
            })}
          </Space>;
        })()}
      </Spin>
    </Modal>
  </div>;
}
