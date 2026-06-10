import { Router, Request, Response } from 'express';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import logger from '../utils/logger';

const router = Router();
const DEFAULT_SENTRY_TARGET = 'http://172.31.2.239:9000';
const SENTRY_TARGET = (process.env.SENTRY_PROXY_TARGET || DEFAULT_SENTRY_TARGET).replace(/\/+$/, '');
const DEFAULT_SENTRY_PUBLIC_URL = 'https://data.nn.com/sentry';
const SENTRY_PUBLIC_URL = (process.env.SENTRY_PUBLIC_URL || DEFAULT_SENTRY_PUBLIC_URL).replace(/\/+$/, '');
const SENTRY_AUTO_LOGIN = process.env.SENTRY_AUTO_LOGIN === 'true';
const SENTRY_LOGIN_USERNAME = process.env.SENTRY_LOGIN_USERNAME || '';
const SENTRY_LOGIN_PASSWORD = process.env.SENTRY_LOGIN_PASSWORD || '';
const SENTRY_DEFAULT_PATH = process.env.SENTRY_DEFAULT_PATH || '/organizations/sentry/projects/nn-ios/?project=6';
const SENTRY_SESSION_TTL_MS = 30 * 60 * 1000;

type SentryHTTPResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

const sentrySessionCookies = new Map<string, string>();
let sentryLoginPromise: Promise<void> | null = null;
let sentryLastLoginAt = 0;

function buildTargetURL(req: Request): URL {
  const target = new URL(SENTRY_TARGET);
  let proxyPath = req.originalUrl.replace(/^\/sentry(?=\/|$)/, '') || req.originalUrl || '/';
  proxyPath = proxyPath.replace(
    /^\/api\/0\/([^/?#]+)\/organizations\/\1(?=\/|[?#]|$)/,
    '/api/0/organizations/$1'
  );
  target.pathname = proxyPath.split('?')[0] || '/';
  const queryIndex = proxyPath.indexOf('?');
  target.search = queryIndex >= 0 ? proxyPath.substring(queryIndex) : '';
  return target;
}

function rewriteSentryAssetURLs(body: string, proxyBaseURL: string): string {
  const sentryPublicURLPattern = SENTRY_PUBLIC_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sentryTargetPattern = SENTRY_TARGET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rewritten = body
    .replace(new RegExp(sentryPublicURLPattern, 'g'), proxyBaseURL)
    .replace(new RegExp(sentryTargetPattern, 'g'), proxyBaseURL)
    .replace(
      't.p=window.__initialData?.distPrefix||"/sentry/_assets/"',
      't.p="/sentry/_static/dist/sentry/"'
    )
    .replace(/(href|src|action)=["']\/(?!sentry\/)/g, '$1="/sentry/')
    .replace(/url\(\s*["']?\/(?!sentry\/)/g, 'url(/sentry/')
    .replace(/(["'`])\/(api|auth|organizations|settings|_static|_assets|avatar|static)(?=\/)/g, '$1/sentry/$2');

  return injectSentryIssueBridge(rewritten);
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

function normalizeSetCookie(setCookie: string | string[] | undefined): string[] {
  if (!setCookie) {
    return [];
  }
  return Array.isArray(setCookie) ? setCookie : [setCookie];
}

function updateSentryCookieJar(setCookie: string | string[] | undefined) {
  normalizeSetCookie(setCookie).forEach((cookie) => {
    const firstPart = cookie.split(';')[0];
    const equalIndex = firstPart.indexOf('=');
    if (equalIndex <= 0) {
      return;
    }
    const name = firstPart.substring(0, equalIndex).trim();
    const value = firstPart.substring(equalIndex + 1).trim();
    if (!name) {
      return;
    }
    if (!value) {
      sentrySessionCookies.delete(name);
      return;
    }
    sentrySessionCookies.set(name, value);
  });
}

function buildSentryCookieHeader(extraCookie?: string): string | undefined {
  const cookies = new Map<string, string>();

  if (extraCookie) {
    extraCookie.split(';').forEach((part) => {
      const equalIndex = part.indexOf('=');
      if (equalIndex <= 0) {
        return;
      }
      const name = part.substring(0, equalIndex).trim();
      const value = part.substring(equalIndex + 1).trim();
      if (name && value) {
        cookies.set(name, value);
      }
    });
  }

  sentrySessionCookies.forEach((value, name) => {
    cookies.set(name, value);
  });

  if (cookies.size === 0) {
    return undefined;
  }

  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
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

function requestSentry(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const targetURL = new URL(path, SENTRY_TARGET);
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
    sentrySessionCookies.get('sc') ||
    '';
  return decodeHTML(token);
}

async function performSentryLogin() {
  sentrySessionCookies.clear();
  const loginPage = await requestSentry('/auth/login/sentry/');
  const csrfToken = extractCSRFToken(loginPage.body.toString('utf8'));
  if (!csrfToken) {
    throw new Error('Sentry login csrf token missing');
  }

  const form = new URLSearchParams();
  form.set('op', SENTRY_LOGIN_USERNAME);
  form.set('password', SENTRY_LOGIN_PASSWORD);
  form.set('csrfmiddlewaretoken', csrfToken);

  await requestSentry('/auth/login/sentry/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: new URL(SENTRY_TARGET).origin,
      referer: `${SENTRY_TARGET}/auth/login/sentry/`,
    },
    body: form.toString(),
  });

  sentryLastLoginAt = Date.now();
  if (!sentrySessionCookies.has('sentrysid')) {
    throw new Error('Sentry login session cookie missing');
  }
}

async function ensureSentryAutoLogin() {
  if (!SENTRY_AUTO_LOGIN || !SENTRY_LOGIN_USERNAME || !SENTRY_LOGIN_PASSWORD) {
    return;
  }

  const isSessionFresh =
    sentrySessionCookies.has('sentrysid') &&
    Date.now() - sentryLastLoginAt < SENTRY_SESSION_TTL_MS;
  if (isSessionFresh) {
    return;
  }

  if (!sentryLoginPromise) {
    sentryLoginPromise = performSentryLogin()
      .catch((error) => {
        logger.warn('Sentry 自动登录失败', {
          target: SENTRY_TARGET,
          error: error instanceof Error ? error.message : String(error),
        });
        sentrySessionCookies.clear();
      })
      .finally(() => {
        sentryLoginPromise = null;
      });
  }

  await sentryLoginPromise;
}

function isSentryLoginPath(req: Request): boolean {
  return req.originalUrl.startsWith('/sentry/auth/login/');
}

function buildDefaultProxyPath(): string {
  return `/sentry${SENTRY_DEFAULT_PATH.startsWith('/') ? SENTRY_DEFAULT_PATH : `/${SENTRY_DEFAULT_PATH}`}`;
}

router.use(async (req: Request, res: Response) => {
  await ensureSentryAutoLogin();
  if (SENTRY_AUTO_LOGIN && isSentryLoginPath(req) && sentrySessionCookies.has('sentrysid')) {
    res.redirect(buildDefaultProxyPath());
    return;
  }

  const targetURL = buildTargetURL(req);
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
    headers.referer = rewriteRequestURLHeader(headers.referer);
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
        responseHeaders.location = rewriteLocationHeader(responseHeaders.location);
      }

      if (responseHeaders['set-cookie']) {
        updateSentryCookieJar(responseHeaders['set-cookie']);
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
        res.send(rewriteSentryAssetURLs(body, proxyBaseURL));
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
