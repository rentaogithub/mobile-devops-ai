import { Router, Request, Response } from 'express';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import logger from '../utils/logger';
import {
  buildSentryCookieHeader,
  clearSentryCookieJar,
  getSentryCookie,
  getSentryCookieJarUpdatedAt,
  hasSentryCookie,
  updateSentryCookieJar,
} from '../services/SentryCookieJar';
import { productLineConfigService } from '../services/ProductLineConfigService';
import { currentProductLineId } from '../services/ProductLineContext';

const router = Router();
const DEFAULT_SENTRY_TARGET = 'http://172.31.2.239:9000';
const DEFAULT_SENTRY_PUBLIC_URL = 'https://data.nn.com/sentry';
const SENTRY_PUBLIC_URL = (process.env.SENTRY_PUBLIC_URL || DEFAULT_SENTRY_PUBLIC_URL).replace(/\/+$/, '');
const SENTRY_SESSION_TTL_MS = Number(process.env.SENTRY_SESSION_TTL_MS) || 12 * 60 * 60 * 1000;

interface SentryProxyConfig {
  productLineId: string;
  target: string;
  autoLogin: boolean;
  username: string;
  password: string;
  defaultPath: string;
}

type SentryHTTPResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

const sentryLoginStates = new Map<string, { promise: Promise<void> | null; lastLoginAt: number }>();

function currentSentryProxyConfig(): SentryProxyConfig {
  const productLineId = currentProductLineId();
  const legacy = productLineId === 'nn';
  const target = (
    productLineConfigService.get('SENTRY_PROXY_TARGET')
    || (legacy ? process.env.SENTRY_PROXY_TARGET || DEFAULT_SENTRY_TARGET : '')
  ).replace(/\/+$/, '');
  if (!target) throw new Error(`当前产品线 ${productLineId} 未配置 Sentry 服务地址`);
  const org = productLineConfigService.get('SENTRY_ORG') || (legacy ? process.env.SENTRY_ORG || 'sentry' : '');
  const project = productLineConfigService.get('SENTRY_PROJECT') || (legacy ? process.env.SENTRY_PROJECT || 'nn-ios' : '');
  const configuredDefaultPath = legacy ? String(process.env.SENTRY_DEFAULT_PATH || '').trim() : '';
  const defaultPath = configuredDefaultPath || (org && project
    ? `/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/`
    : '/');
  return {
    productLineId,
    target,
    autoLogin: (productLineConfigService.get('SENTRY_AUTO_LOGIN') || (legacy ? String(process.env.SENTRY_AUTO_LOGIN || '') : '')) === 'true',
    username: productLineConfigService.get('SENTRY_LOGIN_USERNAME') || (legacy ? process.env.SENTRY_LOGIN_USERNAME || '' : ''),
    password: productLineConfigService.get('SENTRY_LOGIN_PASSWORD') || (legacy ? process.env.SENTRY_LOGIN_PASSWORD || '' : ''),
    defaultPath,
  };
}

function currentLoginState(productLineId: string) {
  let state = sentryLoginStates.get(productLineId);
  if (!state) {
    state = { promise: null, lastLoginAt: 0 };
    sentryLoginStates.set(productLineId, state);
  }
  return state;
}

function buildTargetURL(req: Request, config: SentryProxyConfig): URL {
  const target = new URL(config.target);
  const targetBasePath = target.pathname.replace(/\/+$/, '');
  let proxyPath = req.originalUrl.replace(/^\/sentry(?=\/|$)/, '') || req.originalUrl || '/';
  proxyPath = proxyPath.replace(/npm_modules/g, 'node_modules');
  proxyPath = proxyPath.replace(
    /^\/api\/0\/([^/?#]+)\/organizations\/\1(?=\/|[?#]|$)/,
    '/api/0/organizations/$1'
  );
  const requestPath = proxyPath.split('?')[0] || '/';
  target.pathname = `${targetBasePath}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`;
  const queryIndex = proxyPath.indexOf('?');
  target.search = queryIndex >= 0 ? proxyPath.substring(queryIndex) : '';
  return target;
}

function rewriteSentryAssetURLs(body: string, proxyBaseURL: string, config: SentryProxyConfig, options: { injectBridge?: boolean } = {}): string {
  const sentryPublicURLPattern = SENTRY_PUBLIC_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sentryTargetPattern = config.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rewritten = body
    .replace(new RegExp(sentryPublicURLPattern, 'g'), proxyBaseURL)
    .replace(new RegExp(sentryTargetPattern, 'g'), proxyBaseURL)
    .replace(/(href|src|action)=["']\/(?!sentry\/)/g, '$1="/sentry/')
    .replace(/url\(\s*["']?\/(?!sentry\/)/g, 'url(/sentry/')
    .replace(/(["'`])\/(api|auth|organizations|settings|_static|_assets|avatar|static)(?=\/)/g, '$1/sentry/$2');

  return options.injectBridge ? injectSentryIssueBridge(rewritten) : rewritten;
}

function rewriteSentryJavaScript(body: string): string {
  return stripInjectedIssueBridge(body).replace(/node_modules/g, 'npm_modules');
}

function stripInjectedIssueBridge(body: string): string {
  return body.replace(/\n?<script data-nn-sentry-issue-bridge>[\s\S]*?<\/script>\n?/g, '');
}

function injectSentryIssueBridge(body: string): string {
  if (!body.includes('</body>') || body.includes('data-nn-sentry-issue-bridge')) {
    return body;
  }

  const bridgeScript = `
<script data-nn-sentry-issue-bridge>
(function () {
  function parseIssue(url, title) {
    try {
      var parsed = new URL(url, window.location.href);
      var match = parsed.pathname.match(/\\/issues\\/([^/?#]+)/);
      if (!match) {
        return {
          type: 'nn-sentry-issue-selected',
          issue: null
        };
      }
      return {
        type: 'nn-sentry-issue-selected',
        issue: {
          id: decodeURIComponent(match[1]),
          title: (title || '').trim() || decodeURIComponent(match[1]),
          permalink: parsed.pathname + parsed.search + parsed.hash
        }
      };
    } catch (_) {
      return null;
    }
  }

  function postIssue(issueMessage) {
    if (issueMessage && window.parent && window.parent !== window) {
      window.parent.postMessage(issueMessage, '*');
    }
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    var anchor = target && target.closest ? target.closest('a[href*="/issues/"]') : null;
    if (anchor) {
      postIssue(parseIssue(anchor.href, anchor.textContent));
    }
  }, true);

  postIssue(parseIssue(window.location.href, document.title));
})();
</script>`;

  return body.replace('</body>', `${bridgeScript}\n</body>`);
}

function rewriteLocationHeader(location: string, config: SentryProxyConfig): string {
  const normalizedLocation = location;
  if (normalizedLocation.startsWith(config.target)) {
    const target = new URL(normalizedLocation);
    return `${target.pathname}${target.search}${target.hash}`;
  }

  return normalizedLocation;
}

function rewriteSetCookieHeaders(setCookie: string | string[]): string[] {
  const rewriteCookie = (cookie: string) =>
    cookie
      .replace(/;\s*Domain=[^;]+/i, '')
      .replace(/;\s*Path=\/sentry\/?/i, '; Path=/')
      .replace(/;\s*Path=\/(?=;|$)/i, '; Path=/');

  return Array.isArray(setCookie)
    ? setCookie.map(rewriteCookie)
    : [rewriteCookie(setCookie)];
}

function rewriteRequestURLHeader(value: string, config: SentryProxyConfig): string {
  const target = new URL(config.target);
  return value.replace(/^https?:\/\/[^/]+\/sentry(?=\/|$)/i, `${target.origin}`);
}

function requestSentry(config: SentryProxyConfig, requestPathWithQuery: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const baseURL = new URL(config.target);
  const targetBasePath = baseURL.pathname.replace(/\/+$/, '');
  const targetURL = new URL(config.target);
  const queryIndex = requestPathWithQuery.indexOf('?');
  const requestPath = queryIndex >= 0 ? requestPathWithQuery.substring(0, queryIndex) : requestPathWithQuery;
  targetURL.pathname = `${targetBasePath}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`;
  targetURL.search = queryIndex >= 0 ? requestPathWithQuery.substring(queryIndex) : '';
  const client = targetURL.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = {
    ...(options.headers || {}),
    host: targetURL.host,
    'accept-encoding': 'identity',
  };
  const cookieHeader = buildSentryCookieHeader();
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  return new Promise<SentryHTTPResponse>((resolve, reject) => {
    const request = client.request(
      targetURL,
      {
        method: options.method || 'GET',
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        updateSentryCookieJar(response.headers['set-cookie']);
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );

    request.setTimeout(15000, () => {
      request.destroy(new Error('Sentry auto login timeout'));
    });
    request.on('error', reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function decodeHTML(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractCSRFToken(html: string): string {
  const token =
    html.match(/name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)/i)?.[1] ||
    html.match(/value=["']([^"']+)["'][^>]*name=["']csrfmiddlewaretoken/i)?.[1] ||
    getSentryCookie('sc') ||
    '';
  return decodeHTML(token);
}

async function performSentryLogin(config: SentryProxyConfig) {
  clearSentryCookieJar();
  const loginPage = await requestSentry(config, '/auth/login/sentry/');
  const csrfToken = extractCSRFToken(loginPage.body.toString('utf8'));
  if (!csrfToken) {
    throw new Error('Sentry login csrf token missing');
  }

  const form = new URLSearchParams();
  form.set('op', config.username);
  form.set('password', config.password);
  form.set('csrfmiddlewaretoken', csrfToken);

  await requestSentry(config, '/auth/login/sentry/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: new URL(config.target).origin,
      referer: `${config.target}/auth/login/sentry/`,
    },
    body: form.toString(),
  });

  currentLoginState(config.productLineId).lastLoginAt = Date.now();
  if (!hasSentryCookie('sentrysid')) {
    throw new Error('Sentry login session cookie missing');
  }
}

async function ensureSentryAutoLogin(config: SentryProxyConfig) {
  if (!config.autoLogin || !config.username || !config.password) {
    return;
  }

  const state = currentLoginState(config.productLineId);

  const isSessionFresh =
    hasSentryCookie('sentrysid') &&
    Date.now() - Math.max(state.lastLoginAt, getSentryCookieJarUpdatedAt()) < SENTRY_SESSION_TTL_MS;
  if (isSessionFresh) {
    return;
  }

  if (!state.promise) {
    state.promise = performSentryLogin(config)
      .catch((error) => {
        logger.warn('Sentry 自动登录失败', {
          target: config.target,
          productLineId: config.productLineId,
          error: error instanceof Error ? error.message : String(error),
        });
        clearSentryCookieJar();
      })
      .finally(() => {
        state.promise = null;
      });
  }

  await state.promise;
}

function isSentryLoginPath(req: Request): boolean {
  return req.originalUrl.startsWith('/sentry/auth/login/');
}

function buildDefaultProxyPath(config: SentryProxyConfig): string {
  const defaultPath = config.defaultPath.startsWith('/') ? config.defaultPath : `/${config.defaultPath}`;
  return defaultPath.replace(/^\/sentry(?=\/)/, '');
}

router.use(async (req: Request, res: Response) => {
  let config: SentryProxyConfig;
  try {
    config = currentSentryProxyConfig();
    await ensureSentryAutoLogin(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Sentry 代理配置不可用', { productLineId: currentProductLineId(), error: message });
    res.status(503).send(message);
    return;
  }
  if (config.autoLogin && isSentryLoginPath(req) && hasSentryCookie('sentrysid')) {
    res.redirect(buildDefaultProxyPath(config));
    return;
  }

  const targetURL = buildTargetURL(req, config);
  const isHttps = targetURL.protocol === 'https:';
  const client = isHttps ? https : http;
  const targetOrigin = `${targetURL.protocol}//${targetURL.host}`;
  const proxyBaseURL = `${req.protocol}://${req.get('host') || ''}/sentry`;

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
    headers.referer = rewriteRequestURLHeader(headers.referer, config);
  }

  const sentryCookieHeader = buildSentryCookieHeader(typeof headers.cookie === 'string' ? headers.cookie : undefined);
  if (sentryCookieHeader) {
    headers.cookie = sentryCookieHeader;
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
      responseHeaders['cache-control'] = 'no-cache, no-store, must-revalidate';

      if (typeof responseHeaders.location === 'string') {
        responseHeaders.location = rewriteLocationHeader(responseHeaders.location, config);
      }

      if (responseHeaders['set-cookie']) {
        updateSentryCookieJar(responseHeaders['set-cookie']);
        responseHeaders['set-cookie'] = rewriteSetCookieHeaders(responseHeaders['set-cookie']);
      }

      const contentType = String(proxyRes.headers['content-type'] || '');
      const shouldRewriteHTML = contentType.includes('text/html');
      const shouldRewrite =
        shouldRewriteHTML ||
        contentType.includes('text/css') ||
        contentType.includes('javascript');
      const shouldRewriteJavaScript = contentType.includes('javascript');

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
        const rewrittenBody = shouldRewriteJavaScript
          ? rewriteSentryJavaScript(body)
          : rewriteSentryAssetURLs(body, proxyBaseURL, config, { injectBridge: shouldRewriteHTML });
        res.send(rewrittenBody);
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

  proxyReq.setTimeout(15000, () => {
    proxyReq.destroy(new Error('Sentry proxy timeout'));
  });

  req.pipe(proxyReq);
});

export default router;
