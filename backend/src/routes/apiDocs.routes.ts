import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { adminMiddleware } from '../middleware/auth';
import { getDatabase } from '../database';

const router = Router();
const sourceBase = 'https://test1-doc.nn.com';
const sources: Record<string, string> = {
  'user-query': '/user-query/v2/api-docs?group=' + encodeURIComponent('用户查询服务'),
  'u-mobile': '/u-mobile/v2/api-docs?group=' + encodeURIComponent('移动端接入层'),
  'nchannel': '/nchannel/v2/api-docs?group=' + encodeURIComponent('社区频道接口文档'),
  'wan-app': '/wan/v2/api-docs?group=' + encodeURIComponent('NN陪玩：app接口'),
  'nn-risk-v1': '/nn-risk/v2/api-docs?group=' + encodeURIComponent('NN风控审核服务:V1'),
  'operation-server': '/ncoperation/v2/api-docs?group=' + encodeURIComponent('operationServer'),
  'im-friend': '/im-friend/v2/api-docs?group=' + encodeURIComponent('雷神IM好友服务客户端接口'),
  'order-open-api': '/nnorder/v2/api-docs?group=' + encodeURIComponent('order-open-api'),
  'wan-v1': '/wan/v2/api-docs?group=' + encodeURIComponent('v1-NN陪玩接口'),
  'wan-v2': '/wan/v2/api-docs?group=' + encodeURIComponent('v2-NN陪玩接口'),
  'wan-v3': '/wan/v2/api-docs?group=' + encodeURIComponent('v3-NN陪玩接口'),
  'leigod-rtc': '/leigod-rtc/v2/api-docs?group=' + encodeURIComponent('雷神rtc客户端接口'),
  'privilege': '/privilege/v2/api-docs?group=' + encodeURIComponent('雷神用户权益客户端接口'),
  'nn-game': '/nn-game/v2/api-docs?group=' + encodeURIComponent('雷神赛事客户端接口'),
  'union-server': '/nn-union/v2/api-docs?group=' + encodeURIComponent('unionServer'),
  'nn-status': '/nn-status/v2/api-docs?group=' + encodeURIComponent('NN状态服务'),
  'fdfs': '/fdfs/v2/api-docs?group=' + encodeURIComponent('文件服务'),
};
const cache = new Map<string, { expiresAt: number; data: unknown }>();
const cacheDirectory = path.resolve(__dirname, '../../../nn-ios-platform-data/api-docs-cache');
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

function ensureApiDocRecordsTable(): void {
  getDatabase().prepare(`
    CREATE TABLE IF NOT EXISTS api_doc_view_records (
      record_key TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      summary TEXT DEFAULT '',
      tag TEXT DEFAULT '',
      view_count INTEGER NOT NULL DEFAULT 0,
      last_viewed_at TEXT NOT NULL
    )
  `).run();
}

router.get('/records/list', (_req, res) => {
  ensureApiDocRecordsTable();
  const data = getDatabase().prepare(`
    SELECT service, method, path, summary, tag, view_count AS viewCount, last_viewed_at AS lastViewedAt
    FROM api_doc_view_records
    ORDER BY last_viewed_at DESC
    LIMIT 500
  `).all();
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
    INSERT INTO api_doc_view_records (record_key, service, method, path, summary, tag, view_count, last_viewed_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(record_key) DO UPDATE SET
      summary = excluded.summary,
      tag = excluded.tag,
      view_count = api_doc_view_records.view_count + 1,
      last_viewed_at = excluded.last_viewed_at
  `).run(recordKey, service, normalizedMethod, apiPath, String(summary), String(tag), now);
  res.json({ success: true });
});

function normalizeApiSearchText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
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

function readCachedDocument(service: string): { expiresAt: number; data: unknown } | undefined {
  const memory = cache.get(service);
  if (memory) return memory;
  try {
    const filePath = cacheFile(service);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const cached = { data, expiresAt: fs.statSync(filePath).mtimeMs + 10 * 60 * 1000 };
    cache.set(service, cached);
    return cached;
  } catch {
    return undefined;
  }
}

function writeCachedDocument(service: string, data: unknown): void {
  fs.mkdirSync(cacheDirectory, { recursive: true });
  fs.writeFileSync(cacheFile(service), JSON.stringify(data));
  cache.set(service, { data, expiresAt: Date.now() + 10 * 60 * 1000 });
}

function readSearchDocument(service: string): unknown | undefined {
  const cached = readCachedDocument(service);
  if (cached) return cached.data;
  try {
    return JSON.parse(fs.readFileSync(cacheFile(service), 'utf8'));
  } catch {
    return undefined;
  }
}

async function fetchDocument(service: string): Promise<unknown> {
  const source = sources[service];
  if (!source) throw new Error('API 文档服务不存在');
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    try {
      const response = await fetch(`${sourceBase}${source}`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
      }
      const data = await response.json();
      writeCachedDocument(service, data);
      return data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('未知错误');
    }
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

    const documents = Object.keys(sources).map((service) => {
      const data = readSearchDocument(service);
      return data
        ? { status: 'fulfilled' as const, value: { service, data: data as { host?: string; basePath?: string; paths?: Record<string, Record<string, { summary?: string; operationId?: string; tags?: string[] }>> } } }
        : { status: 'rejected' as const };
    });
    const basePaths = documents.flatMap((result) => result.status === 'fulfilled' && result.value.data.basePath ? [result.value.data.basePath] : []);
    const tokens = makeSearchTokens(keyword, basePaths);

    const results = documents.flatMap((result) => {
      if (result.status !== 'fulfilled') return [];
      const { service, data } = result.value;
      return Object.entries(data.paths || {}).flatMap(([path, methods]) => Object.entries(methods).flatMap(([method, operation]) => {
        const fullPath = `${data.basePath || ''}${path}`;
        const text = normalizeApiSearchText(`${fullPath} ${path} ${operation.summary || ''} ${operation.operationId || ''} ${(operation.tags || []).join(' ')}`);
        if (!tokens.every((token) => matchSearchToken(text, token))) return [];
        return [{ service, basePath: data.basePath || '', path, method: method.toUpperCase(), summary: operation.summary || '', operationId: operation.operationId || '', tag: operation.tags?.[0] || '其他' }];
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
    await fetchDocument(service);
    return service;
  }));
  const succeeded = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  const failed = results.flatMap((result, index) => result.status === 'rejected'
    ? [{ service: Object.keys(sources)[index], message: result.reason instanceof Error ? result.reason.message : '未知错误' }]
    : []);
  res.status(failed.length === Object.keys(sources).length ? 502 : 200).json({
    success: failed.length === 0,
    total: Object.keys(sources).length,
    succeeded,
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
    const document = (cached && cached.expiresAt > Date.now() ? cached.data : await fetchDocument(req.params.service)) as {
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

    const url = new URL(`${origin}${document.basePath || ''}${resolvedPath}`);
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
    res.json({
      status: response.status,
      statusText: response.statusText,
      duration: Date.now() - startedAt,
      url: url.toString(),
      requestHeaders,
      data: responseData,
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
    const data = await fetchDocument(req.params.service);
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
