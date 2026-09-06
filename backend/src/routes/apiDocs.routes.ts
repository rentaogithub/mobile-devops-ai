import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { adminMiddleware } from '../middleware/auth';
import { getDatabase } from '../database';
import { apiRequestSampleService } from '../services/ApiRequestSampleService';
import { browserLogWebSocketService } from '../services/BrowserLogWebSocketService';
import { clearOpAccessToken, getOpAccessToken } from '../services/OpCookieJar';
import { currentProductLineId } from '../services/ProductLineContext';

const router = Router();
const sourceBase = 'https://test1-doc.nn.com';
const sources: Record<string, string> = {
  'open-api': '/openApi/v2/api-docs?group=' + encodeURIComponent('NN第三方API接口接入'),
  'nn-assist-frontend': '/nn-assist/v2/api-docs?group=' + encodeURIComponent('帮助中心前端接口'),
  'nn-assist-client': '/nn-assist/v2/api-docs?group=' + encodeURIComponent('帮助中心客户端接口'),
  'u-nnpc': '/u-nnpc/v2/api-docs?group=' + encodeURIComponent('PC接入层'),
  'user-query': '/user-query/v2/api-docs?group=' + encodeURIComponent('用户查询服务'),
  'u-mobile': '/u-mobile/v2/api-docs?group=' + encodeURIComponent('移动端接入层'),
  'u-miniapp': '/u-miniapp/v2/api-docs?group=' + encodeURIComponent('NN小程序接入层'),
  'nchannel': '/nchannel/v2/api-docs?group=' + encodeURIComponent('社区频道接口文档'),
  'activity': '/activity/v2/api-docs?group=' + encodeURIComponent('活动中心-C端'),
  'speed-platform': '/speed-platform/v2/api-docs?group=' + encodeURIComponent('武汉用户加速器接入'),
  'wan-app': '/wan/v2/api-docs?group=' + encodeURIComponent('NN陪玩：app接口'),
  'wan-client': '/wan/v2/api-docs?group=' + encodeURIComponent('NN陪玩：客户端接口'),
  'wan-short-link': '/wan/v2/api-docs?group=' + encodeURIComponent('NN陪玩：短链接口'),
  'nn-risk-v1': '/nn-risk/v2/api-docs?group=' + encodeURIComponent('NN风控审核服务:V1'),
  'nn-risk-admin': '/nn-risk/v2/api-docs?group=' + encodeURIComponent('NN风控审核服务:管理后台'),
  'nn-risk-activity': '/nn-risk/v2/api-docs?group=' + encodeURIComponent('NN风控审核服务:活动风控'),
  'operation-server': '/ncoperation/v2/api-docs?group=' + encodeURIComponent('operationServer'),
  'im-friend': '/im-friend/v2/api-docs?group=' + encodeURIComponent('雷神IM好友服务客户端接口'),
  'im-user': '/im-user/v2/api-docs?group=' + encodeURIComponent('雷神IM用户客户端接口'),
  'order-open-api': '/nnorder/v2/api-docs?group=' + encodeURIComponent('order-open-api'),
  'wan-v1': '/wan/v2/api-docs?group=' + encodeURIComponent('v1-NN陪玩接口'),
  'wan-v2': '/wan/v2/api-docs?group=' + encodeURIComponent('v2-NN陪玩接口'),
  'wan-v3': '/wan/v2/api-docs?group=' + encodeURIComponent('v3-NN陪玩接口'),
  'wan-taobao': '/wan/v2/api-docs?group=' + encodeURIComponent('淘宝相关接口'),
  'short-link-api': '/short-link-business/v2/api-docs?group=' + encodeURIComponent('NN短链服务:API'),
  'leigod-rtc': '/leigod-rtc/v2/api-docs?group=' + encodeURIComponent('雷神rtc客户端接口'),
  'privilege': '/privilege/v2/api-docs?group=' + encodeURIComponent('雷神用户权益客户端接口'),
  'leigod-market-nn': '/leigod-market-nn/v2/api-docs?group=' + encodeURIComponent('雷神营销渠道服务(NN)客户端接口'),
  'nn-game': '/nn-game/v2/api-docs?group=' + encodeURIComponent('雷神赛事客户端接口'),
  'cmp-bff': '/cmp-bff/v2/api-docs?group=' + encodeURIComponent('渠道中台bff客户端接口'),
  'gamehub': '/gamehub/v2/api-docs?group=' + encodeURIComponent('GameHub客户端接口'),
  'union-server': '/nn-union/v2/api-docs?group=' + encodeURIComponent('unionServer'),
  'nn-status': '/nn-status/v2/api-docs?group=' + encodeURIComponent('NN状态服务'),
  'nn-version': '/nn-version/v2/api-docs?group=' + encodeURIComponent('NN版本服务'),
  'fdfs': '/fdfs/v2/api-docs?group=' + encodeURIComponent('文件服务'),
};
const cache = new Map<string, { expiresAt: number; data: unknown }>();
const cacheDirectory = path.resolve(__dirname, '../../../nn-ios-platform-data/api-docs-cache');
const previousCacheDirectory = path.join(cacheDirectory, 'previous');
const requestEnvironments: Record<string, string> = {
  release: 'https://opapi.nnraytheon.com',
  test: 'https://test-opapi.nn.com',
  test1: 'https://test1-opapi.nn.com',
};
const publicHeaders = {
  version: '51409',
  deviceId: '7003B3C9-0FC1-49EB-9143-D35525F338A7',
  latitude: '0.0',
  longitude: '0.0',
  osVersion: '5.14.9',
  platform: '1',
  appId: 'nnMobileIm_6z0g3ut7',
  appName: 'nn_accelerator',
  reqChannel: '1',
  registerCanal: 'App Store',
};
const invalidTokenRetCodes = new Set(['300002', 'auth_10003', 'auth_40001', 'auth_40002']);

function ensureApiDocRecordsTable(): void {
  getDatabase().prepare(`
    CREATE TABLE IF NOT EXISTS api_doc_view_records (
      product_line_id TEXT NOT NULL DEFAULT 'nn',
      record_key TEXT NOT NULL,
      service TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      summary TEXT DEFAULT '',
      tag TEXT DEFAULT '',
      view_count INTEGER NOT NULL DEFAULT 0,
      last_viewed_at TEXT NOT NULL,
      PRIMARY KEY (product_line_id, record_key)
    )
  `).run();
  const columns = getDatabase().prepare('PRAGMA table_info(api_doc_view_records)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'product_line_id')) {
    getDatabase().exec(`
      ALTER TABLE api_doc_view_records RENAME TO api_doc_view_records_legacy;
      CREATE TABLE api_doc_view_records (
        product_line_id TEXT NOT NULL DEFAULT 'nn',
        record_key TEXT NOT NULL,
        service TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        summary TEXT DEFAULT '',
        tag TEXT DEFAULT '',
        view_count INTEGER NOT NULL DEFAULT 0,
        last_viewed_at TEXT NOT NULL,
        PRIMARY KEY (product_line_id, record_key)
      );
      INSERT INTO api_doc_view_records (
        product_line_id, record_key, service, method, path, summary, tag, view_count, last_viewed_at
      ) SELECT 'nn', record_key, service, method, path, summary, tag, view_count, last_viewed_at
        FROM api_doc_view_records_legacy;
      DROP TABLE api_doc_view_records_legacy;
    `);
  }
  getDatabase().prepare('CREATE INDEX IF NOT EXISTS idx_api_doc_views_product ON api_doc_view_records(product_line_id, last_viewed_at DESC)').run();
}

router.get('/records/list', (_req, res) => {
  ensureApiDocRecordsTable();
  const data = getDatabase().prepare(`
    SELECT service, method, path, summary, tag, view_count AS viewCount, last_viewed_at AS lastViewedAt
    FROM api_doc_view_records
    WHERE product_line_id = ?
    ORDER BY last_viewed_at DESC
    LIMIT 500
  `).all(currentProductLineId());
  res.json({ data });
});

router.post('/records/view', (req, res) => {
  const { service, method, path: apiPath, summary = '', tag = '' } = req.body || {};
  if (!sources[String(service)] || !method || !apiPath) {
    res.status(400).json({ message: '接口记录参数无效' });
    return;
  }
  ensureApiDocRecordsTable();
  const normalizedMethod = String(method).toUpperCase();
  const recordKey = `${service}:${normalizedMethod}:${apiPath}`;
  const now = new Date().toISOString();
  getDatabase().prepare(`
    INSERT INTO api_doc_view_records (product_line_id, record_key, service, method, path, summary, tag, view_count, last_viewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(product_line_id, record_key) DO UPDATE SET
      summary = excluded.summary,
      tag = excluded.tag,
      view_count = api_doc_view_records.view_count + 1,
      last_viewed_at = excluded.last_viewed_at
  `).run(currentProductLineId(), recordKey, service, normalizedMethod, apiPath, String(summary), String(tag), now);
  res.json({ success: true });
});

router.get('/request-samples', (req, res) => {
  const service = String(req.query.service || '');
  const method = String(req.query.method || '').toUpperCase();
  const apiPath = String(req.query.path || '');
  if (!sources[service] || !method || !apiPath) {
    res.status(400).json({ message: '请求样本查询参数无效' });
    return;
  }
  browserLogWebSocketService.replayRecentLogsToApiSamples();
  const data = apiRequestSampleService.listSamples({
    service,
    method,
    path: apiPath,
    environment: String(req.query.environment || ''),
    limit: Number(req.query.limit || 20),
  });
  res.json({ data });
});

router.get('/request-token', (req, res) => {
  const environment = String(req.query.environment || '');
  if (!requestEnvironments[environment]) {
    res.status(400).json({ message: '请求环境无效' });
    return;
  }
  browserLogWebSocketService.replayRecentLogsToApiSamples();
  const data = apiRequestSampleService.latestToken(environment);
  res.json({ data: data || null });
});

function normalizeApiSearchText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
}

function joinApiPath(basePath = '', apiPath = ''): string {
  const normalizedBase = basePath.replace(/\/+$/, '');
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  if (!normalizedBase) return normalizedPath;
  if (normalizedPath === normalizedBase || normalizedPath.startsWith(`${normalizedBase}/`)) {
    return normalizedPath;
  }
  return `${normalizedBase}${normalizedPath}`;
}

function makeSearchTokens(keyword: string, basePaths: string[]): string[] {
  const normalizedKeyword = normalizeApiSearchText(keyword);
  const tokens = normalizedKeyword.split(/\s+/).filter(Boolean);
  return tokens.map((token) => {
    const variants = new Set([token]);
    basePaths.forEach((basePath) => {
      const normalizedBasePath = normalizeApiSearchText(basePath);
      if (normalizedBasePath && token.startsWith(`${normalizedBasePath}/`)) {
        variants.add(token.slice(normalizedBasePath.length) || '/');
      }
    });
    return Array.from(variants).join('\u0000');
  });
}

function matchSearchToken(text: string, encodedVariants: string): boolean {
  return encodedVariants.split('\u0000').some((variant) => text.includes(variant));
}

function cacheFile(service: string): string {
  return path.join(cacheDirectory, `${service}.json`);
}

function previousCacheFile(service: string): string {
  return path.join(previousCacheDirectory, `${service}.json`);
}

function isSwaggerDocument(data: unknown): data is { paths?: Record<string, unknown>; swagger?: string; openapi?: string } {
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return (typeof record.swagger === 'string' || typeof record.openapi === 'string') && Boolean(record.paths && typeof record.paths === 'object');
}

function extractSwaggerDocument(data: unknown): unknown {
  if (isSwaggerDocument(data)) return data;
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const retData = record.retData ?? record.data;
  return isSwaggerDocument(retData) ? retData : undefined;
}

function readCachedDocument(service: string): { expiresAt: number; data: unknown } | undefined {
  const memory = cache.get(service);
  if (memory && extractSwaggerDocument(memory.data)) return memory;
  if (memory) cache.delete(service);
  try {
    const filePath = cacheFile(service);
    const data = extractSwaggerDocument(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    if (!data) return undefined;
    const cached = { data, expiresAt: fs.statSync(filePath).mtimeMs + 10 * 60 * 1000 };
    cache.set(service, cached);
    return cached;
  } catch {
    return undefined;
  }
}

function writeCachedDocument(service: string, data: unknown): void {
  const document = extractSwaggerDocument(data);
  if (!document) throw new Error('上游返回的不是有效 API 文档，已拒绝写入缓存');
  fs.mkdirSync(cacheDirectory, { recursive: true });
  fs.mkdirSync(previousCacheDirectory, { recursive: true });
  const filePath = cacheFile(service);
  if (fs.existsSync(filePath)) {
    try {
      const previousData = fs.readFileSync(filePath, 'utf8');
      const nextData = JSON.stringify(document);
      if (previousData && previousData !== nextData) {
        fs.writeFileSync(previousCacheFile(service), previousData);
      }
    } catch {
      // 历史快照失败不影响当前文档写入。
    }
  }
  fs.writeFileSync(filePath, JSON.stringify(document));
  cache.set(service, { data: document, expiresAt: Date.now() + 10 * 60 * 1000 });
}

type ApiDocOperation = { summary?: string; operationId?: string; tags?: string[]; parameters?: unknown[]; responses?: unknown };
type ApiDocForCompare = { basePath?: string; paths?: Record<string, Record<string, ApiDocOperation>>; xFallbackDocument?: boolean };
type ApiChangeItem = {
  key: string;
  method: string;
  path: string;
  fullPath: string;
  summary: string;
  tag: string;
  changes?: string[];
};

function operationSignature(operation: ApiDocOperation): string {
  return JSON.stringify({
    summary: operation.summary || '',
    operationId: operation.operationId || '',
    tags: operation.tags || [],
    parameters: operation.parameters || [],
    responses: operation.responses || {},
  });
}

function flattenOperations(document: ApiDocForCompare): Map<string, ApiChangeItem & { signature: string }> {
  const operations = new Map<string, ApiChangeItem & { signature: string }>();
  Object.entries(document.paths || {}).forEach(([apiPath, methods]) => {
    Object.entries(methods || {}).forEach(([method, operation]) => {
      const normalizedMethod = method.toUpperCase();
      const fullPath = joinApiPath(document.basePath || '', apiPath);
      operations.set(`${normalizedMethod} ${fullPath}`, {
        key: `${normalizedMethod} ${fullPath}`,
        method: normalizedMethod,
        path: apiPath,
        fullPath,
        summary: operation.summary || '',
        tag: operation.tags?.[0] || '其他',
        signature: operationSignature(operation),
      });
    });
  });
  return operations;
}

function changedFields(before: ApiDocOperation | undefined, after: ApiDocOperation | undefined): string[] {
  if (!before || !after) return [];
  const checks: Array<[string, unknown, unknown]> = [
    ['接口名称', before.summary || '', after.summary || ''],
    ['Operation ID', before.operationId || '', after.operationId || ''],
    ['接口分组', before.tags || [], after.tags || []],
    ['请求参数', before.parameters || [], after.parameters || []],
    ['响应结构', before.responses || {}, after.responses || {}],
  ];
  return checks.flatMap(([label, left, right]) => JSON.stringify(left) === JSON.stringify(right) ? [] : [label]);
}

function findOperation(document: ApiDocForCompare, item: ApiChangeItem): ApiDocOperation | undefined {
  return document.paths?.[item.path]?.[item.method.toLowerCase()];
}

function compareDocuments(previous: ApiDocForCompare, current: ApiDocForCompare) {
  const before = flattenOperations(previous);
  const after = flattenOperations(current);
  const added: ApiChangeItem[] = [];
  const removed: ApiChangeItem[] = [];
  const changed: ApiChangeItem[] = [];

  after.forEach((item, key) => {
    const oldItem = before.get(key);
    if (!oldItem) {
      added.push(item);
      return;
    }
    if (oldItem.signature !== item.signature) {
      changed.push({ ...item, changes: changedFields(findOperation(previous, item), findOperation(current, item)) });
    }
  });
  before.forEach((item, key) => {
    if (!after.has(key)) removed.push(item);
  });

  return { added, removed, changed };
}

function fallbackDocument(
  document: {
    swagger?: string;
    info?: { title?: string; version?: string };
    tags?: { name: string }[];
  },
  options: {
    basePath: string;
    title: string;
    tag: string;
    paths: Record<string, Record<string, unknown>>;
  },
) {
  return {
    swagger: document.swagger || '2.0',
    basePath: options.basePath,
    info: document.info || { title: options.title, version: 'fallback' },
    xFallbackDocument: true,
    tags: document.tags || [{ name: options.tag }],
    paths: options.paths,
    definitions: {
      BaseOutputObject: {
        type: 'object',
        title: 'BaseOutputObject',
        properties: {
          retTime: { type: 'string', description: '响应时间' },
          success: { type: 'boolean', description: '是否成功' },
          trackId: { type: 'string', description: '链路追踪ID' },
          retData: { type: 'object', description: '响应内容' },
          retCode: { type: 'string', description: '响应码' },
          retMsg: { type: 'string', description: '响应信息' },
        },
      },
    },
  };
}

function withFallbackDocument(service: string, data: unknown): unknown {
  const document = data as {
    swagger?: string;
    basePath?: string;
    info?: { title?: string; version?: string };
    paths?: Record<string, unknown>;
    tags?: { name: string }[];
  };
  if (document.paths && Object.keys(document.paths).length > 0) return data;

  if (service === 'nn-version') {
    return fallbackDocument(document, {
      basePath: '/nn-version',
      title: 'NN版本服务',
      tag: 'NN版本服务',
      paths: {
        '/version/upgrade': { post: versionOperation('普通检测版本更新', 'checkUpgradeUsingPOST') },
        '/version/gray/release/update': { post: versionOperation('灰度版本更新', 'grayReleaseUpdateUsingPOST') },
        '/version/gray/release/refuse': { post: versionOperation('拒绝/确认灰度版本更新', 'grayReleaseRefuseUsingPOST') },
      },
    });
  }

  if (service === 'im-user') {
    return fallbackDocument(document, {
      basePath: '/im-user',
      title: '雷神IM用户客户端接口',
      tag: '雷神IM用户客户端接口',
      paths: {
        '/app/v1/user/getUserList': { post: simpleOperation('批量查询用户列表', 'getUserListUsingPOST', '雷神IM用户客户端接口') },
      },
    });
  }

  return data;
}

function versionOperation(summary: string, operationId: string) {
  return simpleOperation(summary, operationId, 'NN版本服务', 'OK。上游 Knife4j 当前未提供该服务的详细参数 schema，平台按客户端常量补充接口入口。');
}

function simpleOperation(summary: string, operationId: string, tag: string, responseDescription = 'OK。上游 Knife4j 当前异常，平台先补充接口入口。') {
  return {
    summary,
    operationId,
    tags: [tag],
    consumes: ['application/json'],
    produces: ['*/*'],
    parameters: [],
    responses: {
      '200': {
        description: responseDescription,
        schema: { originalRef: 'BaseOutputObject', $ref: '#/definitions/BaseOutputObject' },
      },
    },
  };
}

function sourceSearchHints(service: string): string[] {
  const source = sources[service];
  if (!source) return [service];
  const url = new URL(source, sourceBase);
  const group = url.searchParams.get('group') || '';
  const basePath = `/${url.pathname.split('/').filter(Boolean)[0] || ''}`;
  return [service, basePath, group].filter(Boolean);
}

function shouldFetchMissingSearchDocument(service: string, keyword: string): boolean {
  const normalizedKeyword = normalizeApiSearchText(keyword);
  return sourceSearchHints(service).some((hint) => {
    const normalizedHint = normalizeApiSearchText(hint);
    return normalizedHint.length >= 2 && (normalizedKeyword.includes(normalizedHint) || normalizedHint.includes(normalizedKeyword));
  });
}

function responseRetCode(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const record = data as Record<string, unknown>;
  const direct = record.retCode ?? record.code;
  if (direct !== undefined && direct !== null) return String(direct);
  const retData = record.retData;
  if (retData && typeof retData === 'object') {
    const nested = (retData as Record<string, unknown>).retCode ?? (retData as Record<string, unknown>).code;
    if (nested !== undefined && nested !== null) return String(nested);
  }
  return '';
}

function responseRetMessage(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const record = data as Record<string, unknown>;
  const direct = record.retMsg ?? record.message ?? record.msg;
  return direct !== undefined && direct !== null ? String(direct) : '';
}

function isInvalidTokenResponse(status: number, data: unknown): boolean {
  if (status === 401 || status === 403) return true;
  return invalidTokenRetCodes.has(responseRetCode(data));
}

async function readSearchDocument(service: string, keyword: string): Promise<unknown | undefined> {
  const cached = readCachedDocument(service);
  if (cached) return cached.data;
  try {
    return JSON.parse(fs.readFileSync(cacheFile(service), 'utf8'));
  } catch {
    if (shouldFetchMissingSearchDocument(service, keyword)) {
      try {
        return await fetchDocument(service);
      } catch {
        // 单个服务拉取失败不影响全局搜索。
      }
    }
    if (service === 'nn-version' || service === 'im-user') {
      return withFallbackDocument(service, {});
    }
    return undefined;
  }
}

async function fetchDocument(service: string, options: { fallbackOnError?: boolean; writeCache?: boolean } = {}): Promise<unknown> {
  const fallbackOnError = options.fallbackOnError ?? true;
  const shouldWriteCache = options.writeCache ?? true;
  const source = sources[service];
  if (!source) throw new Error('API 文档服务不存在');
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    try {
      const url = new URL(source, sourceBase);
      if (!url.searchParams.has('reqChannel')) url.searchParams.set('reqChannel', publicHeaders.reqChannel);
      const token = getOpAccessToken();
      const response = await fetch(url, {
        headers: {
          ...publicHeaders,
          ...(token ? { token, 'x-access-token': token } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
      }
      const rawData = await response.json();
      if (invalidTokenRetCodes.has(responseRetCode(rawData))) {
        clearOpAccessToken();
        throw new Error(responseRetMessage(rawData) || 'OP token 已失效，请在 OP 页面重新登录后再同步');
      }
      const document = extractSwaggerDocument(rawData);
      if (!document) {
        throw new Error(responseRetMessage(rawData) || '上游返回的不是有效 API 文档');
      }
      const data = withFallbackDocument(service, document);
      if (shouldWriteCache) writeCachedDocument(service, data);
      return data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('未知错误');
    }
  }
  if (fallbackOnError && (service === 'nn-version' || service === 'im-user')) {
    const fallback = withFallbackDocument(service, {});
    if (shouldWriteCache) writeCachedDocument(service, fallback);
    return fallback;
  }
  throw lastError || new Error('获取上游文档失败');
}

router.get('/search/all', async (req, res) => {
  try {
    const keyword = normalizeApiSearchText(String(req.query.q || ''));
    if (keyword.length < 2) {
      res.json({ data: [], total: 0 });
      return;
    }

    const documents = await Promise.all(Object.keys(sources).map(async (service) => {
      const data = await readSearchDocument(service, keyword);
      return data
        ? { status: 'fulfilled' as const, value: { service, data: data as { host?: string; basePath?: string; xFallbackDocument?: boolean; paths?: Record<string, Record<string, { summary?: string; operationId?: string; tags?: string[] }>> } } }
        : { status: 'rejected' as const };
    }));
    const basePaths = documents.flatMap((result) => result.status === 'fulfilled' && result.value.data.basePath ? [result.value.data.basePath] : []);
    const tokens = makeSearchTokens(keyword, basePaths);

    const results = documents.flatMap((result) => {
      if (result.status !== 'fulfilled') return [];
      const { service, data } = result.value;
      const serviceText = sourceSearchHints(service).join(' ');
      return Object.entries(data.paths || {}).flatMap(([path, methods]) => Object.entries(methods).flatMap(([method, operation]) => {
        const fullPath = joinApiPath(data.basePath || '', path);
        const text = normalizeApiSearchText(`${serviceText} ${fullPath} ${path} ${operation.summary || ''} ${operation.operationId || ''} ${(operation.tags || []).join(' ')}`);
        if (!tokens.every((token) => matchSearchToken(text, token))) return [];
        return [{
          service,
          basePath: data.basePath || '',
          path,
          method: method.toUpperCase(),
          summary: operation.summary || '',
          operationId: operation.operationId || '',
          tag: operation.tags?.[0] || '其他',
          fallbackDocument: !!data.xFallbackDocument,
        }];
      }));
    });

    res.json({ data: results.slice(0, 200), total: results.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : '全局查询失败';
    res.status(500).json({ message });
  }
});

router.post('/sync/all', adminMiddleware, async (_req, res) => {
  const results = await Promise.allSettled(Object.keys(sources).map(async (service) => {
    try {
      await fetchDocument(service);
      return { service, mode: 'latest' as const };
    } catch (error) {
      const cached = readCachedDocument(service);
      if (cached) {
        return {
          service,
          mode: 'cache' as const,
          message: error instanceof Error ? error.message : '上游同步失败，已使用本地缓存',
        };
      }
      throw error;
    }
  }));
  const succeeded = results.flatMap((result) => result.status === 'fulfilled' && result.value.mode === 'latest' ? [result.value.service] : []);
  const cached = results.flatMap((result) => result.status === 'fulfilled' && result.value.mode === 'cache'
    ? [{ service: result.value.service, message: result.value.message }]
    : []);
  const failed = results.flatMap((result, index) => result.status === 'rejected'
    ? [{ service: Object.keys(sources)[index], message: result.reason instanceof Error ? result.reason.message : '未知错误' }]
    : []);
  res.status(failed.length === Object.keys(sources).length ? 502 : 200).json({
    success: failed.length === 0,
    total: Object.keys(sources).length,
    succeeded,
    cached,
    failed,
    syncedAt: new Date().toISOString(),
  });
});

router.post('/request/:service', async (req, res) => {
  const { environment, path: requestPath, method, token, headers = {}, query = {}, pathParams = {}, body } = req.body || {};
  const origin = requestEnvironments[String(environment)];
  const source = sources[req.params.service];
  if (!origin || !source || !requestPath || !method) {
    res.status(400).json({ message: '请求环境或接口参数无效' });
    return;
  }
  if (!String(token || '').trim()) {
    res.status(400).json({ message: '请先设置 token' });
    return;
  }

  try {
    const cached = readCachedDocument(req.params.service);
    const document = (cached && cached.expiresAt > Date.now() ? cached.data : await fetchDocument(req.params.service, { fallbackOnError: !cached })) as {
      basePath?: string;
      paths?: Record<string, Record<string, unknown>>;
    };
    const normalizedMethod = String(method).toLowerCase();
    if (!document.paths?.[requestPath]?.[normalizedMethod]) {
      res.status(400).json({ message: '接口不在已同步的 API 文档中' });
      return;
    }

    let resolvedPath = String(requestPath);
    for (const [name, value] of Object.entries(pathParams as Record<string, unknown>)) {
      resolvedPath = resolvedPath.replace(`{${name}}`, encodeURIComponent(String(value ?? '')));
    }
    if (/\{[^}]+\}/.test(resolvedPath)) {
      res.status(400).json({ message: '请填写完整的 Path 参数' });
      return;
    }

    const url = new URL(`${origin}${joinApiPath(document.basePath || '', resolvedPath)}`);
    for (const [name, value] of Object.entries(query as Record<string, unknown>)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
    }
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...publicHeaders,
      ...Object.fromEntries(Object.entries(headers as Record<string, unknown>).map(([key, value]) => [key, String(value ?? '')])),
      token: String(token),
      timeStamp: String(Date.now()),
    };
    const startedAt = Date.now();
    const response = await fetch(url, {
      method: normalizedMethod.toUpperCase(),
      headers: requestHeaders,
      body: ['GET', 'HEAD'].includes(normalizedMethod.toUpperCase()) || body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const responseText = await response.text();
    let responseData: unknown = responseText;
    try { responseData = responseText ? JSON.parse(responseText) : null; } catch { /* 保留文本响应 */ }
    const tokenInvalid = isInvalidTokenResponse(response.status, responseData);
    const tokenInvalidReason = tokenInvalid
      ? responseRetMessage(responseData) || responseRetCode(responseData) || `HTTP ${response.status}`
      : '';
    if (tokenInvalid) {
      apiRequestSampleService.markTokenInvalid(String(environment), String(token), tokenInvalidReason);
    }
    res.json({
      status: response.status,
      statusText: response.statusText,
      duration: Date.now() - startedAt,
      url: url.toString(),
      requestHeaders,
      data: responseData,
      tokenInvalid,
      tokenInvalidReason,
    });
  } catch (error) {
    res.status(502).json({ message: `真实请求失败: ${error instanceof Error ? error.message : '未知错误'}` });
  }
});

router.post('/:service/sync', adminMiddleware, async (req, res) => {
  if (!sources[req.params.service]) {
    res.status(404).json({ message: 'API 文档服务不存在' });
    return;
  }
  try {
    const data = await fetchDocument(req.params.service);
    res.json({ data, syncedAt: new Date().toISOString() });
  } catch (error) {
    res.status(502).json({ message: `同步上游 API 文档失败: ${error instanceof Error ? error.message : '未知错误'}` });
  }
});

router.get('/:service/diff', async (req, res) => {
  if (!sources[req.params.service]) {
    res.status(404).json({ message: 'API 文档服务不存在' });
    return;
  }

  try {
    const cached = readCachedDocument(req.params.service);
    const current = (cached?.data || await fetchDocument(req.params.service)) as ApiDocForCompare;
    if (cached) {
      try {
        const latest = await fetchDocument(req.params.service, { fallbackOnError: false, writeCache: false }) as ApiDocForCompare;
        const diff = compareDocuments(current, latest);
        res.json({
          service: req.params.service,
          hasBaseline: true,
          mode: 'cached-vs-latest',
          currentFallback: !!latest.xFallbackDocument,
          previousFallback: !!current.xFallbackDocument,
          summary: {
            added: diff.added.length,
            removed: diff.removed.length,
            changed: diff.changed.length,
          },
          ...diff,
        });
        return;
      } catch {
        // 上游异常时回退到缓存快照对比。
      }
    }

    const previousPath = previousCacheFile(req.params.service);
    if (!fs.existsSync(previousPath)) {
      res.json({
        service: req.params.service,
        hasBaseline: false,
        message: '暂无上一版 API 文档快照，请先同步一次后再对比',
        summary: { added: 0, removed: 0, changed: 0 },
        added: [],
        removed: [],
        changed: [],
      });
      return;
    }

    const previous = JSON.parse(fs.readFileSync(previousPath, 'utf8')) as ApiDocForCompare;
    const diff = compareDocuments(previous, current);
    res.json({
      service: req.params.service,
      hasBaseline: true,
      mode: 'previous-vs-current',
      currentFallback: !!current.xFallbackDocument,
      previousFallback: !!previous.xFallbackDocument,
      summary: {
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
      },
      ...diff,
    });
  } catch (error) {
    res.status(502).json({ message: `接口变更对比失败: ${error instanceof Error ? error.message : '未知错误'}` });
  }
});

router.get('/:service', async (req, res) => {
  const source = sources[req.params.service];
  if (!source) {
    res.status(404).json({ message: 'API 文档服务不存在' });
    return;
  }

  const cached = readCachedDocument(req.params.service);
  if (cached && cached.expiresAt > Date.now()) {
    res.json(cached.data);
    return;
  }

  try {
    const data = await fetchDocument(req.params.service, { fallbackOnError: !cached });
    res.json(data);
  } catch (error) {
    if (cached) {
      res.setHeader('X-API-Docs-Cache', 'stale');
      res.setHeader('Warning', '110 - "Upstream unavailable, serving stale API documentation"');
      res.json(cached.data);
      return;
    }
    res.status(502).json({ message: `获取上游 API 文档失败: ${error instanceof Error ? error.message : '未知错误'}` });
  }
});

export default router;
