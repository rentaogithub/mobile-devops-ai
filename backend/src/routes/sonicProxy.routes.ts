import '../config/env';
import { Router, Request, Response } from 'express';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import logger from '../utils/logger';

const router = Router();

const SONIC_WEB_PROXY_TARGET = (process.env.SONIC_WEB_PROXY_TARGET || 'http://127.0.0.1:3002').replace(/\/+$/, '');
const SONIC_API_PROXY_TARGET = (process.env.SONIC_API_PROXY_TARGET || process.env.SONIC_API_BASE || 'http://127.0.0.1:8094').replace(/\/+$/, '');

function buildTargetURL(req: Request): URL {
  const isApi = req.originalUrl.startsWith('/sonic-api');
  const target = new URL(isApi ? SONIC_API_PROXY_TARGET : SONIC_WEB_PROXY_TARGET);
  const prefix = isApi ? '/sonic-api' : '/sonic-admin';
  const targetBasePath = target.pathname.replace(/\/+$/, '');
  const proxyPath = req.originalUrl.replace(new RegExp(`^${prefix}(?=/|$)`), '') || '/';
  const queryIndex = proxyPath.indexOf('?');
  const requestPath = queryIndex >= 0 ? proxyPath.substring(0, queryIndex) : proxyPath;
  target.pathname = `${targetBasePath}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`;
  target.search = queryIndex >= 0 ? proxyPath.substring(queryIndex) : '';
  return target;
}

function rewriteBody(body: string, proxyBaseURL: string, targetOrigin: string) {
  const escapedTarget = targetOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return body
    .replace(new RegExp(escapedTarget, 'g'), proxyBaseURL)
    .replace(/(href|src|action)=["']\/(?!sonic-admin\/|sonic-api\/)/g, '$1="/sonic-admin/')
    .replace(/url\(\s*["']?\/(?!sonic-admin\/|sonic-api\/)/g, 'url(/sonic-admin/');
}

function rewriteLocationHeader(location: string, proxyBaseURL: string, targetOrigin: string) {
  if (location.startsWith(targetOrigin)) {
    const target = new URL(location);
    return `${proxyBaseURL}${target.pathname}${target.search}${target.hash}`;
  }
  if (location.startsWith('/')) {
    return `${proxyBaseURL}${location}`;
  }
  return location;
}

router.use((req: Request, res: Response) => {
  const targetURL = buildTargetURL(req);
  const isHttps = targetURL.protocol === 'https:';
  const client = isHttps ? https : http;
  const targetOrigin = `${targetURL.protocol}//${targetURL.host}`;
  const proxyPrefix = req.originalUrl.startsWith('/sonic-api') ? '/sonic-api' : '/sonic-admin';
  const proxyBaseURL = `${req.protocol}://${req.get('host') || ''}${proxyPrefix}`;

  const headers = {
    ...req.headers,
    host: targetURL.host,
    'accept-encoding': 'identity',
    'x-forwarded-host': req.get('host') || '',
    'x-forwarded-proto': req.protocol,
    'x-forwarded-prefix': proxyPrefix,
    'x-forwarded-for': req.ip,
  };

  if (typeof headers.origin === 'string') {
    headers.origin = targetOrigin;
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
      delete responseHeaders['content-security-policy'];
      delete responseHeaders['content-security-policy-report-only'];
      delete responseHeaders['x-frame-options'];
      delete responseHeaders.etag;

      if (typeof responseHeaders.location === 'string') {
        responseHeaders.location = rewriteLocationHeader(responseHeaders.location, proxyBaseURL, targetOrigin);
      }

      const contentType = String(proxyRes.headers['content-type'] || '');
      const shouldRewrite =
        proxyPrefix === '/sonic-admin' &&
        (contentType.includes('text/html') || contentType.includes('text/css') || contentType.includes('javascript'));

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
        res.send(rewriteBody(body, proxyBaseURL, targetOrigin));
      });
    }
  );

  proxyReq.on('error', (error) => {
    logger.error('Sonic 代理请求失败', {
      target: targetURL.toString(),
      error: error.message,
    });
    res.status(502).send('Sonic 代理请求失败，请确认 Sonic 服务已在固定电脑启动。');
  });

  proxyReq.setTimeout(15000, () => {
    proxyReq.destroy(new Error('Sonic proxy timeout'));
  });

  req.pipe(proxyReq);
});

export default router;
