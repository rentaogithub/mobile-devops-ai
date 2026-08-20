import http from 'http';
import https from 'https';
import { URL } from 'url';
import {
  buildSentryCookieHeader,
  clearSentryCookieJar,
  getSentryCookie,
  getSentryCookieJarUpdatedAt,
  hasSentryCookie,
  updateSentryCookieJar,
} from './SentryCookieJar';
import logger from '../utils/logger';
import { crashGovernanceService } from './CrashGovernanceService';

type SentryHTTPResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

export interface SentryIssueSummary {
  id: string;
  eventId?: string;
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
  appVersionRange?: string;
  minAppVersion?: string;
  maxAppVersion?: string;
  appVersions?: string[];
  excludedAppVersionOnly?: boolean;
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

export interface SentryOriginalCrashFile {
  eventId?: string;
  incidentIdentifier?: string;
  crashLog: string;
  previewLog: string;
  rawEventJSON: string;
}

export class SentryIssueService {
  private readonly target = (process.env.SENTRY_PROXY_TARGET || 'http://172.31.2.239:9000').replace(/\/+$/, '');
  private readonly autoLogin = process.env.SENTRY_AUTO_LOGIN === 'true';
  private readonly username = process.env.SENTRY_LOGIN_USERNAME || '';
  private readonly password = process.env.SENTRY_LOGIN_PASSWORD || '';
  private loginPromise: Promise<void> | null = null;
  private lastLoginAt = 0;
  private readonly sessionTtlMs = Number(process.env.SENTRY_SESSION_TTL_MS) || 12 * 60 * 60 * 1000;

  async listNewIssues(options: {
    organization?: string;
    project?: string;
    period?: string;
    limit?: number;
    query?: string;
    enrichVersions?: boolean;
  } = {}): Promise<SentryIssueSummary[]> {
    await this.ensureLogin();

    const organization = options.organization || process.env.SENTRY_ORG || 'sentry';
    const project = options.project || process.env.SENTRY_PROJECT || 'nn-ios';
    const period = options.period || '24h';
    const limit = Math.min(Math.max(options.limit || 5, 1), 20);
    const query = options.query || this.buildDefaultIssueQuery();
    const params = new URLSearchParams({
      query,
      sort: 'date',
      limit: String(limit),
    });
    params.set('statsPeriod', period === '7d' ? '14d' : period);

    const response = await this.request(`/api/0/projects/${organization}/${project}/issues/?${params}`);
    if (response.statusCode >= 400) {
      throw new Error(`Sentry issues API failed: ${response.statusCode} ${response.body.toString('utf8').slice(0, 200)}`);
    }

    const data = JSON.parse(response.body.toString('utf8'));
    const issues = Array.isArray(data) ? data : data?.results || [];
    const normalizedIssues: SentryIssueSummary[] = issues
      .map((issue: any) => this.normalizeIssueSummary(issue))
      .filter((issue: SentryIssueSummary) => {
        if (period !== '7d') {
          return true;
        }
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        return (Date.parse(issue.lastSeen || issue.firstSeen || '') || 0) >= sevenDaysAgo;
      });

    if (!options.enrichVersions) {
      return normalizedIssues.filter((issue) => !issue.excludedAppVersionOnly);
    }

    const enrichedIssues = await this.enrichIssueSummaries(normalizedIssues);
    return enrichedIssues.filter((issue) => !issue.excludedAppVersionOnly);
  }

  async listIssuesByIdentifier(options: {
    identifier: string;
    identifierType?: 'uid' | 'deviceId';
    period?: '24h' | '7d' | '14d';
    limit?: number;
  }): Promise<SentryIssueSummary[]> {
    const identifier = String(options.identifier || '').trim();
    if (!identifier) throw new Error('请输入 UID 或 DeviceID');
    if (identifier.length > 200) throw new Error('UID 或 DeviceID 长度无效');
    const identifierType = options.identifierType === 'deviceId' ? 'deviceId' : 'uid';
    const escaped = identifier.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return this.listNewIssues({
      period: options.period || '7d',
      limit: options.limit || 20,
      query: `${this.buildDefaultIssueQuery()} ${identifierType}:"${escaped}"`,
      enrichVersions: true,
    });
  }

  async enrichIssueSummaries(issues: SentryIssueSummary[]): Promise<SentryIssueSummary[]> {
    const enriched: SentryIssueSummary[] = [];
    const concurrency = 5;
    for (let index = 0; index < issues.length; index += concurrency) {
      const batch = issues.slice(index, index + concurrency);
      enriched.push(...await Promise.all(batch.map(async (issue) => {
        try {
          return await this.enrichIssueVersionRange(issue);
        } catch (error) {
          logger.warn('补充 Sentry issue 版本信息失败，保留基础问题数据', {
            issueId: issue.id,
            shortId: issue.shortId,
            error: error instanceof Error ? error.message : String(error),
          });
          return issue;
        }
      })));
    }
    return enriched;
  }

  async getIssue(
    issueId: string,
    options: { enrichVersions?: boolean } = {}
  ): Promise<SentryIssueSummary | undefined> {
    await this.ensureLogin();

    const resolvedIssueId = await this.resolveIssueId(issueId);
    const response = await this.request(`/api/0/issues/${resolvedIssueId}/`);
    if (response.statusCode === 404) {
      return undefined;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Sentry issue API failed: ${response.statusCode} ${response.body.toString('utf8').slice(0, 200)}`
      );
    }

    const issue = this.normalizeIssueSummary(JSON.parse(response.body.toString('utf8')));
    if (!options.enrichVersions) {
      return issue;
    }

    try {
      return await this.enrichIssueVersionRange(issue);
    } catch (error) {
      logger.warn('补充 Sentry issue 版本信息失败，保留基础问题数据', {
        issueId: issue.id,
        shortId: issue.shortId,
        error: error instanceof Error ? error.message : String(error),
      });
      return issue;
    }
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

    const latestBody = latestResponse.body.toString('utf8').slice(0, 200);
    const listBody = listResponse.body.toString('utf8').slice(0, 200);
    logger.warn('获取 Sentry latest event 失败', {
      issueId,
      resolvedIssueId,
      latestStatus: latestResponse.statusCode,
      listStatus: listResponse.statusCode,
      latestBody,
      listBody,
    });
    throw new Error(
      `获取 Sentry latest event 失败：latest=${latestResponse.statusCode} ${latestBody}; events=${listResponse.statusCode} ${listBody}`
    );
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
      issue.maxAppVersion ? `App Version: ${issue.maxAppVersion}` : '',
      issue.appVersionRange ? `App Version Range: ${issue.appVersionRange}` : '',
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

  buildOriginalCrashFile(issue: SentryIssueSummary, event?: SentryEventDetail): SentryOriginalCrashFile {
    const payload = {
      exportedAt: new Date().toISOString(),
      source: 'sentry',
      issue,
      event,
    };
    const rawEventJSON = JSON.stringify(payload, null, 2);
    const crashLog = this.convertSentryEventToCrash(issue, event);

    return {
      eventId: event?.id,
      incidentIdentifier: (event as any)?.eventID || event?.id,
      crashLog,
      previewLog: this.buildAnalysisLog(issue, event),
      rawEventJSON,
    };
  }

  extractEventUserIdentifiers(event?: SentryEventDetail): { uid?: string; deviceId?: string } {
    return {
      uid: this.tagValue(event, 'uid') || undefined,
      deviceId: this.tagValue(event, 'deviceId') || this.tagValue(event, 'deviceid') || undefined,
    };
  }

  private convertSentryEventToCrash(issue: SentryIssueSummary, event?: SentryEventDetail): string {
    const entries = event?.entries || [];
    const exceptionEntry = entries.find((entry: any) => entry?.type === 'exception');
    const threadsEntry = entries.find((entry: any) => entry?.type === 'threads');
    const debugMetaEntry = entries.find((entry: any) => entry?.type === 'debugmeta');
    const exceptionValues = exceptionEntry?.data?.values || [];
    const firstException = exceptionValues[0] || {};
    const contextValues = this.getContextValues((event as any)?.contexts);
    const deviceContext = (event as any)?.contexts?.device || contextValues.find((context: any) => context?.type === 'device') || {};
    const osContext = (event as any)?.contexts?.os || contextValues.find((context: any) => context?.type === 'os') || {};
    const appContext = (event as any)?.contexts?.app || contextValues.find((context: any) => context?.type === 'app') || {};
    const release = this.tagValue(event, 'release') || issue.maxAppVersion || issue.appVersionRange || '';
    const dist = this.tagValue(event, 'dist') || '';
    const bundleId = this.tagValue(event, 'bundle_id') || '';
    const processName = bundleId.split('.').pop() || 'NNIM';
    const osName = osContext.name || this.tagValue(event, 'os.name') || 'iOS';
    const osVersion = osContext.version || this.tagValue(event, 'os')?.replace(/^iOS\s+/i, '') || '';
    const osBuild = osContext.build || '';
    const debugImages = this.extractDebugImages(debugMetaEntry, event);
    const userIdentifiers = this.extractEventUserIdentifiers(event);
    const threadValues = threadsEntry?.data?.values || [];
    const exceptionThreadId = firstException.threadId;
    const syntheticExceptionThread = firstException.stacktrace || firstException.rawStacktrace
      ? [{
        id: exceptionThreadId ?? 0,
        crashed: true,
        current: true,
        stacktrace: firstException.stacktrace || firstException.rawStacktrace,
      }]
      : [];
    const threads = threadValues.length > 0 ? threadValues : syntheticExceptionThread;
    const crashedThreadIndex = Math.max(threads.findIndex((thread: any) =>
      thread?.crashed || thread?.current || thread?.id === exceptionThreadId
    ), 0);
    const lines: string[] = [];

    lines.push(`Incident Identifier: ${(event as any)?.eventID || event?.id || 'N/A'}`);
    lines.push(`CrashReporter Key:   ${(event as any)?.user?.id || 'N/A'}`);
    if (userIdentifiers.uid) {
      lines.push(`UID:                 ${userIdentifiers.uid}`);
    }
    if (userIdentifiers.deviceId) {
      lines.push(`DeviceID:            ${userIdentifiers.deviceId}`);
    }
    lines.push(`Hardware Model:      ${deviceContext.model || deviceContext.model_id || this.tagValue(event, 'device') || 'N/A'}`);
    lines.push(`Process:             ${processName} [0]`);
    lines.push('Path:                N/A');
    lines.push(`Identifier:          ${bundleId || 'N/A'}`);
    lines.push(`Version:             ${release || 'N/A'} (${dist || 'N/A'})`);
    lines.push(`Code Type:           ${(deviceContext.arch || 'ARM-64').toString().toUpperCase()}`);
    lines.push('Parent Process:      launchd [1]');
    lines.push('');
    lines.push(`Date/Time:           ${event?.dateCreated || (event as any)?.dateReceived || ''}`);
    lines.push(`OS Version:          ${osName}${osVersion ? ` ${osVersion}` : ''}${osBuild ? ` (${osBuild})` : ''}`);
    lines.push('Report Version:      104');
    lines.push('');
    lines.push(`Exception Type:      ${firstException.type || event?.metadata?.type || issue.title || 'N/A'}`);
    if (firstException.value || event?.metadata?.value) {
      lines.push(`Exception Message:   ${firstException.value || event?.metadata?.value}`);
    }
    const mechanism = firstException.mechanism?.type || this.tagValue(event, 'mechanism');
    if (mechanism) {
      lines.push(`Exception Mechanism: ${mechanism}`);
    }
    lines.push(`Crashed Thread:      ${threads.length > 0 ? crashedThreadIndex : 'N/A'}`);
    lines.push('');
    if (firstException.value || event?.message) {
      lines.push('Application Specific Information:');
      lines.push(firstException.value || event?.message || '');
      lines.push('');
    }
    if (threads.length === 0) {
      lines.push('Thread 0 Crashed:');
      lines.push('0  <unknown>  0x0000000000000000 Sentry event does not contain stacktrace/threads');
      lines.push('');
    } else {
      threads.forEach((thread: any, threadIndex: number) => {
        const frames = thread?.stacktrace?.frames || thread?.rawStacktrace?.frames || [];
        lines.push(`Thread ${threadIndex}${threadIndex === crashedThreadIndex ? ' Crashed' : ''}:`);
        if (frames.length === 0) {
          lines.push('0  <unknown>  0x0000000000000000 <no stack frames in Sentry event>');
        } else {
          [...frames].reverse().forEach((frame: any, frameIndex: number) => {
            lines.push(this.formatSentryFrame(frame, frameIndex));
          });
        }
        lines.push('');
      });
    }
    lines.push('Binary Images:');
    if (debugImages.length === 0) {
      lines.push('0x000000000 - 0x000000000 <unknown> arm64  <N/A> Sentry event does not contain debug images');
    } else {
      debugImages.forEach((image) => lines.push(image));
    }

    return lines.join('\n');
  }

  private formatSentryFrame(frame: any, index: number): string {
    const packagePath = frame.package || frame.absPath || frame.filename || frame.module || '<unknown>';
    const binaryName = this.basename(packagePath);
    const instructionAddress = this.normalizeAddress(frame.instructionAddr || frame.instruction_addr || frame.addr);
    const symbolAddress = this.normalizeAddress(frame.symbolAddr || frame.symbol_addr);
    const imageAddress = this.normalizeAddress(frame.imageAddr || frame.image_addr || frame.package);
    const offset = this.formatFrameOffset(frame, symbolAddress || imageAddress);
    const functionName = frame.function || frame.symbol || '<unknown>';
    const location = frame.filename ? ` (${frame.filename}${frame.lineno ? `:${frame.lineno}` : ''})` : '';
    const symbol = symbolAddress || imageAddress
      ? `${functionName}${location} (${symbolAddress || imageAddress} + ${offset})`
      : `${functionName}${location}`;
    return `${index}  ${binaryName}  ${instructionAddress || '0x0000000000000000'} ${symbol}`;
  }

  private formatFrameOffset(frame: any, baseAddress?: string): number {
    if (typeof frame.instructionAddr === 'string' && baseAddress) {
      const instruction = Number.parseInt(frame.instructionAddr.replace(/^0x/i, ''), 16);
      const base = Number.parseInt(baseAddress.replace(/^0x/i, ''), 16);
      if (Number.isFinite(instruction) && Number.isFinite(base) && instruction >= base) {
        return instruction - base;
      }
    }
    return Number(frame.instructionOffset || frame.instruction_offset || frame.offset || 0) || 0;
  }

  private extractDebugImages(debugMetaEntry: any, event?: SentryEventDetail): string[] {
    const images = debugMetaEntry?.data?.images || (event as any)?.debugMeta?.images || [];
    return images.map((image: any) => {
      const start = this.normalizeAddress(image.image_addr || image.imageAddr || image.addr || image.start_addr) || '0x000000000';
      const size = Number.parseInt(String(image.image_size || image.imageSize || image.size || '0'), 10) || 0;
      const startNumber = Number.parseInt(start.replace(/^0x/i, ''), 16) || 0;
      const end = `0x${(startNumber + size).toString(16).padStart(9, '0')}`;
      const name = this.basename(image.name || image.code_file || image.codeFile || image.debug_file || image.debugFile || '<unknown>');
      const arch = image.arch || image.cpu_type || 'arm64';
      const uuid = image.uuid || image.debug_id || image.debugId || 'N/A';
      const path = image.code_file || image.codeFile || image.name || '';
      return `${start} - ${end} ${name} ${arch}  <${uuid}> ${path}`;
    });
  }

  private tagValue(event: SentryEventDetail | undefined, key: string): string | undefined {
    const targetKey = key.toLowerCase();
    return event?.tags?.find((tag) => tag.key.toLowerCase() === targetKey)?.value;
  }

  private basename(value: string): string {
    return String(value).split('/').filter(Boolean).pop() || String(value);
  }

  private normalizeAddress(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `0x${value.toString(16).padStart(16, '0')}`;
    }
    if (typeof value !== 'string') {
      return undefined;
    }
    const hex = value.match(/0x[0-9a-f]+/i)?.[0];
    if (hex) {
      return `0x${hex.replace(/^0x/i, '').padStart(16, '0')}`;
    }
    return undefined;
  }

  normalizeIssueSummary(issue: any): SentryIssueSummary {
    const appVersions = this.collectVersionCandidates(issue);
    const versionRange = this.buildVersionRange(appVersions);
    const excludedAppVersionOnly = this.isExcludedOnlyVersionSet(appVersions);
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
      appVersionRange: versionRange.range || issue.appVersionRange,
      minAppVersion: versionRange.min || issue.minAppVersion,
      maxAppVersion: versionRange.max || issue.maxAppVersion,
      appVersions: versionRange.versions.length > 0 ? versionRange.versions : issue.appVersions,
      excludedAppVersionOnly,
    };
  }

  private async enrichIssueVersionRange(issue: SentryIssueSummary): Promise<SentryIssueSummary> {
    const resolvedIssueId = await this.resolveIssueId(issue.id);
    const eventsResponse = await this.requestWithRetry(`/api/0/issues/${resolvedIssueId}/events/?limit=20`);
    let events: any[] = [];
    if (eventsResponse.statusCode >= 200 && eventsResponse.statusCode < 300) {
      const data = JSON.parse(eventsResponse.body.toString('utf8'));
      events = Array.isArray(data) ? data : [];
    }

    let latestEvent: any;
    const latestResponse = await this.requestWithRetry(`/api/0/issues/${resolvedIssueId}/events/latest/`);
    if (latestResponse.statusCode >= 200 && latestResponse.statusCode < 300) {
      latestEvent = JSON.parse(latestResponse.body.toString('utf8'));
    }

    const rawVersions = [
      ...(issue.appVersions || []),
      ...events.flatMap((event) => this.collectVersionCandidates(event)),
      ...this.collectVersionCandidates(latestEvent),
    ];
    const versionRange = this.buildVersionRange(rawVersions);
    const eventId = latestEvent?.id || events[0]?.id || issue.eventId;

    if (this.isExcludedOnlyVersionSet(rawVersions)) {
      logger.info('过滤 Sentry TestFlight 版本 issue', {
        issueId: issue.id,
        shortId: issue.shortId,
        excludedVersions: Array.from(this.getExcludedAppVersions()),
        rawVersions: Array.from(new Set(rawVersions)),
      });
      return {
        ...issue,
        eventId,
        appVersionRange: undefined,
        minAppVersion: undefined,
        maxAppVersion: undefined,
        appVersions: [],
        excludedAppVersionOnly: true,
      };
    }

    if (versionRange.versions.length === 0) {
      return { ...issue, eventId };
    }

    return {
      ...issue,
      eventId,
      appVersionRange: versionRange.range,
      minAppVersion: versionRange.min,
      maxAppVersion: versionRange.max,
      appVersions: versionRange.versions,
      excludedAppVersionOnly: false,
    };
  }

  private collectVersionCandidates(source: any): string[] {
    const candidates = [
      source?.maxAppVersion,
      source?.minAppVersion,
      source?.appVersionRange,
      source?.release,
      source?.release?.version,
      source?.release?.shortVersion,
      source?.release?.versionInfo?.version?.raw,
      source?.dist,
      source?.metadata?.release,
      source?.metadata?.dist,
      ...(Array.isArray(source?.tags) ? source.tags.flatMap((tag: any) => {
        const key = String(tag?.key || '').toLowerCase();
        if (['release', 'dist', 'version', 'app.version', 'app_version'].includes(key)) {
          return [tag?.value];
        }
        return [];
      }) : []),
      ...this.getContextValues(source?.contexts).flatMap((context: any) => [
        context?.release,
        context?.dist,
        context?.app_version,
      ]),
    ];

    return candidates
      .map((value) => this.extractAppVersion(value))
      .filter((value): value is string => Boolean(value));
  }

  private getContextValues(contexts: unknown): any[] {
    if (Array.isArray(contexts)) {
      return contexts;
    }
    if (contexts && typeof contexts === 'object') {
      return Object.values(contexts);
    }
    return [];
  }

  private extractAppVersion(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const versionMatch =
      trimmed.match(/@([0-9]+(?:\.[0-9]+){1,3})(?:[+._-]|$)/) ||
      trimmed.match(/\b([0-9]+(?:\.[0-9]+){1,3})(?:[+._-]\d+)?\b/);

    return versionMatch?.[1];
  }

  private buildVersionRange(values: string[]) {
    const excludedAppVersions = this.getExcludedAppVersions();
    const versions = Array.from(new Set(values.filter((value) =>
      Boolean(value) && !excludedAppVersions.has(value)
    ))).sort((a, b) => this.compareVersions(a, b));
    const min = versions[0];
    const max = versions[versions.length - 1];
    return {
      versions,
      min,
      max,
      range: min && max ? (min === max ? max : `${min} - ${max}`) : undefined,
    };
  }

  private isExcludedOnlyVersionSet(values: string[]) {
    const excludedAppVersions = this.getExcludedAppVersions();
    const versions = Array.from(new Set(values.filter(Boolean)));
    return versions.length > 0 && versions.every((version) => excludedAppVersions.has(version));
  }

  private buildDefaultIssueQuery(): string {
    return crashGovernanceService.getDefaultIssueQuery();
  }

  private getExcludedAppVersions(): Set<string> {
    return new Set(crashGovernanceService.getExcludedVersions());
  }

  private compareVersions(a: string, b: string): number {
    const left = a.split('.').map((part) => Number(part) || 0);
    const right = b.split('.').map((part) => Number(part) || 0);
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (left[index] || 0) - (right[index] || 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return a.localeCompare(b);
  }

  private async ensureLogin() {
    if (!this.autoLogin || !this.username || !this.password) {
      return;
    }

    const isFresh =
      hasSentryCookie('sentrysid') &&
      Date.now() - Math.max(this.lastLoginAt, getSentryCookieJarUpdatedAt()) < this.sessionTtlMs;
    if (isFresh) {
      return;
    }

    if (!this.loginPromise) {
      this.loginPromise = this.performLogin()
        .catch((error) => {
          clearSentryCookieJar();
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
    clearSentryCookieJar();
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
    if (!hasSentryCookie('sentrysid')) {
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
    const cookieHeader = buildSentryCookieHeader();
    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }

    return new Promise<SentryHTTPResponse>((resolve, reject) => {
      const request = client.request(
        targetURL,
        { method: options.method || 'GET', headers },
        (response) => {
          const chunks: Buffer[] = [];
          updateSentryCookieJar(response.headers['set-cookie']);
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

  private async requestWithRetry(path: string): Promise<SentryHTTPResponse> {
    try {
      const response = await this.request(path);
      if (response.statusCode !== 429 && response.statusCode < 500) {
        return response;
      }
    } catch {
      // 瞬时网络异常时立即重试一次。
    }
    return this.request(path);
  }

  private extractCSRFToken(html: string): string {
    const token =
      html.match(/name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)/i)?.[1] ||
      html.match(/value=["']([^"']+)["'][^>]*name=["']csrfmiddlewaretoken/i)?.[1] ||
      getSentryCookie('sc') ||
      '';
    return token
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }
}

export default new SentryIssueService();
