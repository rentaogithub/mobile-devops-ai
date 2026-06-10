import http from 'http';
import https from 'https';
import { URL } from 'url';
import logger from '../utils/logger';

type SentryHTTPResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

export interface SentryIssueSummary {
  id: string;
  shortId?: string;
  title: string;
  culprit?: string;
  level?: string;
  status?: string;
  count?: string;
  userCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  permalink?: string;
}

export interface SentryEventDetail {
  id?: string;
  title?: string;
  message?: string;
  platform?: string;
  dateCreated?: string;
  entries?: any[];
  metadata?: Record<string, any>;
  tags?: Array<{ key: string; value: string }>;
}

export class SentryIssueService {
  private readonly target = (process.env.SENTRY_PROXY_TARGET || 'http://172.31.2.239:9000').replace(/\/+$/, '');
  private readonly autoLogin = process.env.SENTRY_AUTO_LOGIN === 'true';
  private readonly username = process.env.SENTRY_LOGIN_USERNAME || '';
  private readonly password = process.env.SENTRY_LOGIN_PASSWORD || '';
  private readonly sessionCookies = new Map<string, string>();
  private loginPromise: Promise<void> | null = null;
  private lastLoginAt = 0;
  private readonly sessionTtlMs = 30 * 60 * 1000;

  async listNewIssues(options: {
    organization?: string;
    project?: string;
    period?: string;
    limit?: number;
    query?: string;
  } = {}): Promise<SentryIssueSummary[]> {
    await this.ensureLogin();

    const organization = options.organization || process.env.SENTRY_ORG || 'sentry';
    const project = options.project || process.env.SENTRY_PROJECT || 'nn-ios';
    const period = options.period || '24h';
    const limit = Math.min(Math.max(options.limit || 5, 1), 20);
    const query = options.query || 'is:unresolved';
    const params = new URLSearchParams({
      query,
      sort: 'new',
      limit: String(limit),
      statsPeriod: period,
    });

    const response = await this.request(`/api/0/projects/${organization}/${project}/issues/?${params}`);
    if (response.statusCode >= 400) {
      throw new Error(`Sentry issues API failed: ${response.statusCode} ${response.body.toString('utf8').slice(0, 200)}`);
    }

    const data = JSON.parse(response.body.toString('utf8'));
    const issues = Array.isArray(data) ? data : data?.results || [];
    return issues.map((issue: any) => this.normalizeIssueSummary(issue));
  }

  async getLatestEvent(issueId: string): Promise<SentryEventDetail | undefined> {
    await this.ensureLogin();

    const resolvedIssueId = await this.resolveIssueId(issueId);
    const latestResponse = await this.request(`/api/0/issues/${resolvedIssueId}/events/latest/`);
    if (latestResponse.statusCode >= 200 && latestResponse.statusCode < 300) {
      return JSON.parse(latestResponse.body.toString('utf8'));
    }

    const listResponse = await this.request(`/api/0/issues/${resolvedIssueId}/events/?limit=1`);
    if (listResponse.statusCode >= 200 && listResponse.statusCode < 300) {
      const data = JSON.parse(listResponse.body.toString('utf8'));
      return Array.isArray(data) ? data[0] : data?.[0];
    }

    logger.warn('获取 Sentry latest event 失败', {
      issueId,
      resolvedIssueId,
      latestStatus: latestResponse.statusCode,
      listStatus: listResponse.statusCode,
    });
    return undefined;
  }

  private async resolveIssueId(issueId: string): Promise<string> {
    if (/^\d+$/.test(issueId)) {
      return issueId;
    }

    const organization = process.env.SENTRY_ORG || 'sentry';
    const project = process.env.SENTRY_PROJECT || 'nn-ios';
    const queryCandidates = [
      `issue:${issueId}`,
      `shortId:${issueId}`,
    ];

    for (const query of queryCandidates) {
      const params = new URLSearchParams({
        query,
        limit: '1',
      });
      const response = await this.request(`/api/0/projects/${organization}/${project}/issues/?${params}`);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        continue;
      }

      const data = JSON.parse(response.body.toString('utf8'));
      const issues = Array.isArray(data) ? data : data?.results || [];
      const match = issues.find((issue: any) =>
        issue.shortId === issueId ||
        issue.shortID === issueId
      ) || issues[0];
      if (match?.id) {
        return String(match.id);
      }
    }

    return issueId;
  }

  buildAnalysisLog(issue: SentryIssueSummary, event?: SentryEventDetail): string {
    const exceptionEntry = event?.entries?.find((entry: any) => entry?.type === 'exception');
    const exceptionValues = exceptionEntry?.data?.values || [];
    const stacktrace = exceptionValues
      .flatMap((value: any) => value?.stacktrace?.frames || [])
      .slice(-30)
      .reverse()
      .map((frame: any, index: number) => {
        const module = frame.package || frame.module || frame.filename || '<unknown>';
        const func = frame.function || frame.symbol || '<unknown>';
        const location = frame.filename
          ? `${frame.filename}${frame.lineno ? `:${frame.lineno}` : ''}`
          : '';
        return `${index}  ${module}  ${func}${location ? ` (${location})` : ''}`;
      })
      .join('\n');

    const metadata = event?.metadata ? JSON.stringify(event.metadata, null, 2) : '';
    const tags = event?.tags?.map((tag) => `${tag.key}: ${tag.value}`).join('\n') || '';

    return [
      `Sentry Issue: ${issue.shortId || issue.id}`,
      `Title: ${issue.title}`,
      issue.culprit ? `Culprit: ${issue.culprit}` : '',
      issue.level ? `Level: ${issue.level}` : '',
      issue.status ? `Status: ${issue.status}` : '',
      issue.count ? `Events: ${issue.count}` : '',
      typeof issue.userCount === 'number' ? `Users: ${issue.userCount}` : '',
      issue.firstSeen ? `First Seen: ${issue.firstSeen}` : '',
      issue.lastSeen ? `Last Seen: ${issue.lastSeen}` : '',
      event?.message ? `Message: ${event.message}` : '',
      metadata ? `Metadata:\n${metadata}` : '',
      tags ? `Tags:\n${tags}` : '',
      stacktrace ? `Thread 0 Crashed:\n${stacktrace}` : '',
    ].filter(Boolean).join('\n');
  }

  normalizeIssueSummary(issue: any): SentryIssueSummary {
    return {
      id: String(issue.id || ''),
      shortId: issue.shortId || issue.shortID,
      title: issue.title || issue.metadata?.title || issue.type || '未知崩溃',
      culprit: issue.culprit,
      level: issue.level,
      status: issue.status,
      count: String(issue.count ?? issue.numComments ?? ''),
      userCount: typeof issue.userCount === 'number' ? issue.userCount : Number(issue.userCount || 0),
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      permalink: issue.permalink,
    };
  }

  private async ensureLogin() {
    if (!this.autoLogin || !this.username || !this.password) {
      return;
    }

    const isFresh = this.sessionCookies.has('sentrysid') && Date.now() - this.lastLoginAt < this.sessionTtlMs;
    if (isFresh) {
      return;
    }

    if (!this.loginPromise) {
      this.loginPromise = this.performLogin()
        .catch((error) => {
          this.sessionCookies.clear();
          logger.warn('Sentry issue API 自动登录失败', {
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        })
        .finally(() => {
          this.loginPromise = null;
        });
    }

    await this.loginPromise;
  }

  private async performLogin() {
    this.sessionCookies.clear();
    const loginPage = await this.request('/auth/login/sentry/');
    const csrfToken = this.extractCSRFToken(loginPage.body.toString('utf8'));
    if (!csrfToken) {
      throw new Error('Sentry login csrf token missing');
    }

    const form = new URLSearchParams();
    form.set('op', this.username);
    form.set('password', this.password);
    form.set('csrfmiddlewaretoken', csrfToken);

    await this.request('/auth/login/sentry/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: new URL(this.target).origin,
        referer: `${this.target}/auth/login/sentry/`,
      },
      body: form.toString(),
    });

    this.lastLoginAt = Date.now();
    if (!this.sessionCookies.has('sentrysid')) {
      throw new Error('Sentry login session cookie missing');
    }
  }

  private request(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    const baseURL = new URL(this.target);
    const targetBasePath = baseURL.pathname.replace(/\/+$/, '');
    const targetURL = new URL(this.target);
    const queryIndex = path.indexOf('?');
    const requestPath = queryIndex >= 0 ? path.substring(0, queryIndex) : path;
    targetURL.pathname = `${targetBasePath}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`;
    targetURL.search = queryIndex >= 0 ? path.substring(queryIndex) : '';
    const client = targetURL.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
      ...(options.headers || {}),
      host: targetURL.host,
      'accept-encoding': 'identity',
    };
    const cookieHeader = this.buildCookieHeader();
    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }

    return new Promise<SentryHTTPResponse>((resolve, reject) => {
      const request = client.request(
        targetURL,
        { method: options.method || 'GET', headers },
        (response) => {
          const chunks: Buffer[] = [];
          this.updateCookieJar(response.headers['set-cookie']);
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }));
        }
      );

      request.setTimeout(20000, () => request.destroy(new Error('Sentry request timeout')));
      request.on('error', reject);
      if (options.body) {
        request.write(options.body);
      }
      request.end();
    });
  }

  private buildCookieHeader(): string | undefined {
    if (this.sessionCookies.size === 0) {
      return undefined;
    }

    return Array.from(this.sessionCookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  private updateCookieJar(setCookie: string | string[] | undefined) {
    if (!setCookie) {
      return;
    }

    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    cookies.forEach((cookie) => {
      const firstPart = cookie.split(';')[0];
      const equalIndex = firstPart.indexOf('=');
      if (equalIndex <= 0) {
        return;
      }
      const name = firstPart.substring(0, equalIndex).trim();
      const value = firstPart.substring(equalIndex + 1).trim();
      if (name && value) {
        this.sessionCookies.set(name, value);
      }
    });
  }

  private extractCSRFToken(html: string): string {
    const token =
      html.match(/name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)/i)?.[1] ||
      html.match(/value=["']([^"']+)["'][^>]*name=["']csrfmiddlewaretoken/i)?.[1] ||
      this.sessionCookies.get('sc') ||
      '';
    return token
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }
}

export default new SentryIssueService();
