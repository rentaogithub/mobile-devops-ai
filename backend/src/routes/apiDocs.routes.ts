import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { adminMiddleware } from '../middleware/auth';

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
  const keyword = String(req.query.q || '').trim().toLowerCase();
  if (keyword.length < 2) {
    res.json({ data: [], total: 0 });
    return;
  }

  const tokens = keyword.split(/\s+/).filter(Boolean);
  const documents = await Promise.allSettled(Object.keys(sources).map(async (service) => {
    const cached = readCachedDocument(service);
    const data = cached && cached.expiresAt > Date.now() ? cached.data : await fetchDocument(service);
    return { service, data: data as { host?: string; basePath?: string; paths?: Record<string, Record<string, { summary?: string; operationId?: string; tags?: string[] }>> } };
  }));

  const results = documents.flatMap((result) => {
    if (result.status !== 'fulfilled') return [];
    const { service, data } = result.value;
    return Object.entries(data.paths || {}).flatMap(([path, methods]) => Object.entries(methods).flatMap(([method, operation]) => {
      const text = `${path} ${operation.summary || ''} ${operation.operationId || ''} ${(operation.tags || []).join(' ')}`.toLowerCase();
      if (!tokens.every((token) => text.includes(token))) return [];
      return [{ service, basePath: data.basePath || '', path, method: method.toUpperCase(), summary: operation.summary || '', operationId: operation.operationId || '', tag: operation.tags?.[0] || '其他' }];
    }));
  });

  res.json({ data: results.slice(0, 200), total: results.length });
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
