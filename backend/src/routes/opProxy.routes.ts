import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { URL } from 'url';
import logger from '../utils/logger';
import { buildOpCookieHeader, updateOpCookieJar } from '../services/OpCookieJar';

const router = Router();
const OP_TARGET = (process.env.OP_PROXY_TARGET || 'https://op.nn.com').replace(/\/+$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '..', 'nn-ios-platform-data');
const OP_STATIC_CACHE_DIR = process.env.OP_STATIC_CACHE_DIR || path.join(DATA_DIR, 'op-static-cache');
const OP_STATIC_CACHE_TTL_MS = Number(process.env.OP_STATIC_CACHE_TTL_MS || 365 * 24 * 60 * 60 * 1000);
const OP_STATIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';

type CacheableHeaders = Record<string, string | string[] | number | undefined>;

interface StaticCacheMeta {
  createdAt: number;
  statusCode: number;
  headers: CacheableHeaders;
}

function ensureStaticCacheDir() {
  if (!fs.existsSync(OP_STATIC_CACHE_DIR)) {
    fs.mkdirSync(OP_STATIC_CACHE_DIR, { recursive: true });
  }
}

function getStaticCacheKey(targetURL: URL): string {
  return crypto.createHash('sha256').update(targetURL.toString()).digest('hex');
}

function getStaticCachePaths(targetURL: URL) {
  const key = getStaticCacheKey(targetURL);
  return {
    bodyPath: path.join(OP_STATIC_CACHE_DIR, `${key}.body`),
    metaPath: path.join(OP_STATIC_CACHE_DIR, `${key}.json`),
  };
}

function normalizeStaticResponseHeaders(headers: CacheableHeaders, bodyLength?: number): CacheableHeaders {
  const normalized: CacheableHeaders = { ...headers };
  delete normalized['content-encoding'];
  delete normalized['content-length'];
  delete normalized['content-security-policy'];
  delete normalized['content-security-policy-report-only'];
  delete normalized['set-cookie'];
  delete normalized['transfer-encoding'];
  delete normalized['x-frame-options'];
  delete normalized.etag;
  normalized['cache-control'] = OP_STATIC_CACHE_CONTROL;
  if (typeof bodyLength === 'number') {
    normalized['content-length'] = bodyLength;
  }
  return normalized;
}

function buildTargetURL(req: Request): URL {
  const target = new URL(OP_TARGET);
  const targetBasePath = target.pathname.replace(/\/+$/, '');
  let proxyPath = req.originalUrl || `${req.baseUrl || ''}${req.url || ''}` || '/';
  if (req.baseUrl === '/sys') {
    proxyPath = `/jeecg-boot/sys${req.url.startsWith('/') ? req.url : `/${req.url}`}`;
  } else {
    proxyPath = proxyPath.replace(/^\/op(?=\/|$)/, '') || '/';
    if (proxyPath.startsWith('/sys/')) {
      proxyPath = `/jeecg-boot${proxyPath}`;
    }
  }
  const requestPath = proxyPath.split('?')[0] || '/';
  target.pathname = `${targetBasePath}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`;
  const queryIndex = proxyPath.indexOf('?');
  target.search = queryIndex >= 0 ? proxyPath.substring(queryIndex) : '';
  return target;
}

function rewriteAbsoluteURL(value: string, req: Request): string {
  const target = new URL(OP_TARGET);
  const proxyBaseURL = `${req.protocol}://${req.get('host') || ''}/op`;

  if (value.startsWith(OP_TARGET)) {
    const parsed = new URL(value);
    return `/op${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  if (value.startsWith(target.origin)) {
    const parsed = new URL(value);
    return `/op${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  return value.replace(new RegExp(target.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), proxyBaseURL);
}

function rewriteLocationHeader(location: string, req: Request): string {
  const rewritten = rewriteAbsoluteURL(location, req);
  if (rewritten.startsWith('/') && !rewritten.startsWith('/op/')) {
    return `/op${rewritten}`;
  }
  return rewritten;
}

function rewriteSetCookieHeaders(setCookie: string | string[]): string[] {
  const rewriteCookie = (cookie: string) =>
    cookie
      .replace(/;\s*Domain=[^;]+/i, '')
      .replace(/;\s*Path=[^;]*/i, '; Path=/op')
      .replace(/;\s*Secure(?=;|$)/i, '')
      .replace(/;\s*SameSite=None/i, '; SameSite=Lax');

  return Array.isArray(setCookie)
    ? setCookie.map(rewriteCookie)
    : [rewriteCookie(setCookie)];
}

function rewriteRequestURLHeader(value: string): string {
  const target = new URL(OP_TARGET);
  return value.replace(/^https?:\/\/[^/]+\/op(?=\/|$)/i, target.origin);
}

function pickHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

function buildProxyHeaders(req: Request, targetURL: URL): Record<string, string> {
  const targetOrigin = `${targetURL.protocol}//${targetURL.host}`;
  const headers: Record<string, string> = {
    host: targetURL.host,
    'accept-encoding': 'identity',
    'user-agent':
      pickHeader(req, 'user-agent') ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    accept: pickHeader(req, 'accept') || '*/*',
  };

  const optionalHeaders = [
    'accept-language',
    'content-type',
    'x-requested-with',
    'x-access-token',
    'x-sign',
    'x-timestamp',
    'tenant-id',
    'authorization',
  ];
  optionalHeaders.forEach((name) => {
    const value = pickHeader(req, name);
    if (value) {
      headers[name] = value;
    }
  });

  const origin = pickHeader(req, 'origin');
  if (origin) {
    headers.origin = targetOrigin;
  }

  const referer = pickHeader(req, 'referer');
  if (referer) {
    headers.referer = rewriteRequestURLHeader(referer);
  }

  const cookieHeader = buildOpCookieHeader(pickHeader(req, 'cookie'));
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  return headers;
}

function rewriteHTMLBody(body: string, req: Request): string {
  const target = new URL(OP_TARGET);
  const proxyBaseURL = `${req.protocol}://${req.get('host') || ''}/op`;
  const targetPattern = new RegExp(target.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');

  return body
    .replace(targetPattern, proxyBaseURL)
    .replace(/(window\._CONFIG\[['"]domianURL['"]\]\s*=\s*['"])\/jeecg-boot(['"])/g, '$1/op/jeecg-boot$2')
    .replace(/(href|src|action)=["']\/(?!op\/)/g, '$1="/op/')
    .replace(/(href|src|action)=\/(?!op\/)/g, '$1=/op/')
    .replace(/url\(\s*["']?\/(?!op\/)/g, 'url(/op/');
}

function rewriteCSSBody(body: string, req: Request): string {
  const target = new URL(OP_TARGET);
  const proxyBaseURL = `${req.protocol}://${req.get('host') || ''}/op`;
  const targetPattern = new RegExp(target.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');

  return body
    .replace(targetPattern, proxyBaseURL)
    .replace(/url\(\s*["']?\/(?!op\/)/g, 'url(/op/');
}

function rewriteJavaScriptBody(body: string, req: Request): string {
  const target = new URL(OP_TARGET);
  const proxyBaseURL = `${req.protocol}://${req.get('host') || ''}/op`;
  const targetPattern = new RegExp(target.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');

  return body
    .replace(targetPattern, proxyBaseURL)
    .replace(/(\b[$A-Z_a-z][$\w]*\.p=)(["'])\/\2/g, '$1$2/op/$2');
}

function rewriteJSONBody(body: string, req: Request): string {
  const target = new URL(OP_TARGET);
  const proxyBaseURL = `${req.protocol}://${req.get('host') || ''}/op`;
  const targetPattern = new RegExp(target.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  return body.replace(targetPattern, proxyBaseURL);
}

function isCacheableStaticAsset(targetURL: URL, contentType: string): boolean {
  const pathname = targetURL.pathname.toLowerCase();
  if (/\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|map)$/.test(pathname)) {
    return true;
  }
  return (
    contentType.includes('javascript') ||
    contentType.includes('text/css') ||
    contentType.startsWith('image/') ||
    contentType.startsWith('font/')
  );
}

function isCacheableStaticPath(targetURL: URL): boolean {
  return /\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|map)$/i.test(targetURL.pathname);
}

function readStaticAssetCache(targetURL: URL): { meta: StaticCacheMeta; body: Buffer } | null {
  if (!isCacheableStaticPath(targetURL)) {
    return null;
  }

  try {
    const { bodyPath, metaPath } = getStaticCachePaths(targetURL);
    if (!fs.existsSync(bodyPath) || !fs.existsSync(metaPath)) {
      return null;
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as StaticCacheMeta;
    if (!meta.createdAt || Date.now() - meta.createdAt > OP_STATIC_CACHE_TTL_MS) {
      fs.rmSync(bodyPath, { force: true });
      fs.rmSync(metaPath, { force: true });
      return null;
    }

    return {
      meta,
      body: fs.readFileSync(bodyPath),
    };
  } catch (error) {
    logger.warn('读取 OP 静态资源缓存失败', {
      target: targetURL.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function writeStaticAssetCache(targetURL: URL, statusCode: number, headers: CacheableHeaders, body: Buffer) {
  if (!isCacheableStaticPath(targetURL) || statusCode !== 200) {
    return;
  }

  try {
    ensureStaticCacheDir();
    const { bodyPath, metaPath } = getStaticCachePaths(targetURL);
    const cacheHeaders = normalizeStaticResponseHeaders(headers, body.length);
    const meta: StaticCacheMeta = {
      createdAt: Date.now(),
      statusCode,
      headers: cacheHeaders,
    };
    fs.writeFileSync(bodyPath, body);
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  } catch (error) {
    logger.warn('写入 OP 静态资源缓存失败', {
      target: targetURL.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function rewriteBody(body: string, contentType: string, req: Request): string {
  if (contentType.includes('text/html')) {
    return rewriteHTMLBody(body, req);
  }
  if (contentType.includes('text/css')) {
    return rewriteCSSBody(body, req);
  }
  if (contentType.includes('javascript')) {
    return rewriteJavaScriptBody(body, req);
  }
  if (contentType.includes('application/json')) {
    return rewriteJSONBody(body, req);
  }
  return body;
}

router.use((req: Request, res: Response) => {
  const targetURL = buildTargetURL(req);
  const client = targetURL.protocol === 'https:' ? https : http;
  const headers = buildProxyHeaders(req, targetURL);
  const cachedStaticAsset = req.method === 'GET' || req.method === 'HEAD'
    ? readStaticAssetCache(targetURL)
    : null;

  if (cachedStaticAsset) {
    res.status(cachedStaticAsset.meta.statusCode);
    Object.entries(normalizeStaticResponseHeaders(cachedStaticAsset.meta.headers, cachedStaticAsset.body.length)).forEach(
      ([key, value]) => {
        if (value !== undefined) {
          res.setHeader(key, value);
        }
      }
    );
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.send(cachedStaticAsset.body);
    return;
  }

  const proxyReq = client.request(
    targetURL,
    {
      method: req.method,
      headers,
    },
    (proxyRes) => {
      const responseHeaders = { ...proxyRes.headers };
      const contentType = String(proxyRes.headers['content-type'] || '');
      delete responseHeaders['content-encoding'];
      delete responseHeaders['content-length'];
      delete responseHeaders['content-security-policy'];
      delete responseHeaders['content-security-policy-report-only'];
      delete responseHeaders['x-frame-options'];
      delete responseHeaders.etag;
      responseHeaders['cache-control'] = isCacheableStaticAsset(targetURL, contentType)
        ? OP_STATIC_CACHE_CONTROL
        : 'no-cache, no-store, must-revalidate';

      if (typeof responseHeaders.location === 'string') {
        responseHeaders.location = rewriteLocationHeader(responseHeaders.location, req);
      }

      if (responseHeaders['set-cookie']) {
        updateOpCookieJar(responseHeaders['set-cookie']);
        responseHeaders['set-cookie'] = rewriteSetCookieHeaders(responseHeaders['set-cookie']);
      }

      const shouldRewrite =
        contentType.includes('text/html') ||
        contentType.includes('text/css') ||
        contentType.includes('javascript') ||
        contentType.includes('application/json');
      const shouldCacheStaticAsset =
        req.method === 'GET' &&
        (proxyRes.statusCode || 200) === 200 &&
        isCacheableStaticPath(targetURL);

      res.status(proxyRes.statusCode || 200);
      Object.entries(responseHeaders).forEach(([key, value]) => {
        if (value !== undefined) {
          res.setHeader(key, value as string | string[]);
        }
      });

      if (!shouldRewrite && !shouldCacheStaticAsset) {
        proxyRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks);
        const responseBody = shouldRewrite
          ? Buffer.from(rewriteBody(body.toString('utf8'), contentType, req), 'utf8')
          : body;
        if (shouldCacheStaticAsset) {
          writeStaticAssetCache(targetURL, proxyRes.statusCode || 200, responseHeaders, responseBody);
        }
        res.send(responseBody);
      });
    }
  );

  proxyReq.on('error', (error) => {
    logger.error('OP 代理请求失败', {
      target: targetURL.toString(),
      error: error.message,
    });
    res.status(502).send('OP 代理请求失败，请确认服务器可以访问 https://op.nn.com/。');
  });

  proxyReq.setTimeout(30000, () => {
    proxyReq.destroy(new Error('OP proxy timeout'));
  });

  req.pipe(proxyReq);
});

export default router;
