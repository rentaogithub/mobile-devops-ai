import { Router, Request, Response } from 'express';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import logger from '../utils/logger';

const router = Router();
const DEFAULT_SENTRY_TARGET = 'http://172.31.2.239:9000';
const SENTRY_TARGET = (process.env.SENTRY_PROXY_TARGET || DEFAULT_SENTRY_TARGET).replace(/\/+$/, '');

function buildTargetURL(req: Request): URL {
  const target = new URL(SENTRY_TARGET);
  const proxyPath = req.originalUrl.replace(/^\/sentry(?=\/|$)/, '') || req.originalUrl || '/';
  target.pathname = proxyPath.split('?')[0] || '/';
  const queryIndex = proxyPath.indexOf('?');
  target.search = queryIndex >= 0 ? proxyPath.substring(queryIndex) : '';
  return target;
}

function rewriteSentryAssetURLs(body: string): string {
  return body
    .replace(/(href|src|action)=["']\/(?!sentry\/)/g, '$1="/sentry/')
    .replace(/url\(\s*["']?\/(?!sentry\/)/g, 'url(/sentry/')
    .replace(/(["'`])\/(api|auth|organizations|settings|_static|_assets|avatar|static)(?=\/)/g, '$1/sentry/$2');
}

function rewriteLocationHeader(location: string): string {
  if (location.startsWith(SENTRY_TARGET)) {
    const target = new URL(location);
    return `/sentry${target.pathname}${target.search}${target.hash}`;
  }

  if (location.startsWith('/') && !location.startsWith('/sentry/')) {
    return `/sentry${location}`;
  }

  return location;
}

function rewriteSetCookieHeaders(setCookie: string | string[]): string[] {
  const rewriteCookie = (cookie: string) =>
    cookie
      .replace(/;\s*Domain=[^;]+/i, '')
      .replace(/;\s*Path=\/sentry\/?/i, '; Path=/sentry')
      .replace(/;\s*Path=\//i, '; Path=/sentry');

  return Array.isArray(setCookie)
    ? setCookie.map(rewriteCookie)
    : [rewriteCookie(setCookie)];
}

function rewriteRequestURLHeader(value: string): string {
  const target = new URL(SENTRY_TARGET);
  return value.replace(/^https?:\/\/[^/]+\/sentry(?=\/|$)/i, `${target.origin}`);
}

router.use((req: Request, res: Response) => {
  const targetURL = buildTargetURL(req);
  const isHttps = targetURL.protocol === 'https:';
  const client = isHttps ? https : http;
  const targetOrigin = `${targetURL.protocol}//${targetURL.host}`;

  const headers = {
    ...req.headers,
    host: targetURL.host,
    'accept-encoding': 'identity',
    'x-forwarded-host': req.get('host') || '',
    'x-forwarded-proto': req.protocol,
    'x-forwarded-prefix': '/sentry',
    'x-forwarded-for': req.ip,
  };

  if (typeof headers.origin === 'string') {
    headers.origin = targetOrigin;
  }

  if (typeof headers.referer === 'string') {
    headers.referer = rewriteRequestURLHeader(headers.referer);
  }

  delete headers['content-length'];

  const proxyReq = client.request(
    targetURL,
    {
      method: req.method,
      headers,
    },
    (proxyRes) => {
      const responseHeaders = { ...proxyRes.headers };
      delete responseHeaders['content-encoding'];
      delete responseHeaders['content-length'];

      if (typeof responseHeaders.location === 'string') {
        responseHeaders.location = rewriteLocationHeader(responseHeaders.location);
      }

      if (responseHeaders['set-cookie']) {
        responseHeaders['set-cookie'] = rewriteSetCookieHeaders(responseHeaders['set-cookie']);
      }

      const contentType = String(proxyRes.headers['content-type'] || '');
      const shouldRewrite =
        contentType.includes('text/html') ||
        contentType.includes('text/css') ||
        contentType.includes('javascript');

      res.status(proxyRes.statusCode || 200);
      Object.entries(responseHeaders).forEach(([key, value]) => {
        if (value !== undefined) {
          res.setHeader(key, value as string | string[]);
        }
      });

      if (!shouldRewrite) {
        proxyRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        res.send(rewriteSentryAssetURLs(body));
      });
    }
  );

  proxyReq.on('error', (error) => {
    logger.error('Sentry 代理请求失败', {
      target: targetURL.toString(),
      error: error.message,
    });
    res.status(502).send('Sentry 代理请求失败，请确认固定电脑可以访问内网 Sentry 服务。');
  });

  req.pipe(proxyReq);
});

export default router;
