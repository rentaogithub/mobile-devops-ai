import crypto from 'crypto';
import { getDatabase } from '../database';
import logger from '../utils/logger';
import { currentProductLineId } from './ProductLineContext';

type LogSource = 'realtime_log' | 'feedback_log';
type RequestEnvironment = 'release' | 'test' | 'test1' | 'unknown';

interface ParsedLog {
  time: string;
  event: string;
  fields: Record<string, string>;
}

interface PendingRequest {
  productLineId: string;
  source: LogSource;
  sourceRef: string;
  line: string;
  api: string;
  parameters: unknown;
  token: string;
  nntid: string;
  createdAt: string;
}

interface DocumentLike {
  basePath?: string;
  paths?: Record<string, Record<string, unknown>>;
}

export interface ApiRequestSample {
  id: string;
  productLineId: string;
  source: LogSource;
  sourceRef: string;
  service: string;
  method: string;
  path: string;
  fullPath: string;
  environment: RequestEnvironment;
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
  pathParams: Record<string, unknown>;
  body: unknown;
  token: string;
  response: unknown;
  statusCode?: number;
  retCode: string;
  retMsg: string;
  costMs?: number;
  uid: string;
  deviceId: string;
  nntid: string;
  createdAt: string;
  requestTime: string;
}

const requestEnvironments: Record<Exclude<RequestEnvironment, 'unknown'>, string[]> = {
  release: ['opapi.nnraytheon.com'],
  test: ['test-opapi.nn.com'],
  test1: ['test1-opapi.nn.com'],
};

const runtimeRequestParamKeys = new Set(['timestamp', 'token']);
const serviceBasePaths: Record<string, string> = {
  'open-api': '/openApi',
  'nn-assist-frontend': '/nn-assist',
  'nn-assist-client': '/nn-assist',
  'u-nnpc': '/u-nnpc',
  'user-query': '/user-query',
  'u-mobile': '/u-mobile',
  'u-miniapp': '/u-miniapp',
  nchannel: '/nchannel',
  activity: '/activity',
  'speed-platform': '/speed-platform',
  'wan-app': '/wan',
  'wan-client': '/wan',
  'wan-short-link': '/wan',
  'nn-risk-v1': '/nn-risk',
  'nn-risk-admin': '/nn-risk',
  'nn-risk-activity': '/nn-risk',
  'operation-server': '/ncoperation',
  'im-friend': '/im-friend',
  'im-user': '/im-user',
  'order-open-api': '/nnorder',
  'wan-v1': '/wan',
  'wan-v2': '/wan',
  'wan-v3': '/wan',
  'wan-taobao': '/wan',
  'short-link-api': '/short-link-business',
  'leigod-rtc': '/leigod-rtc',
  privilege: '/privilege',
  'leigod-market-nn': '/leigod-market-nn',
  'nn-game': '/nn-game',
  'cmp-bff': '/cmp-bff',
  gamehub: '/gamehub',
  'union-server': '/nn-union',
  'nn-status': '/nn-status',
  'nn-version': '/nn-version',
  fdfs: '/fdfs',
};

class ApiRequestSampleService {
  private readonly pendingRequests = new Map<string, PendingRequest>();

  ensureTable(): void {
    getDatabase().prepare(`
      CREATE TABLE IF NOT EXISTS api_request_samples (
        id TEXT PRIMARY KEY,
        product_line_id TEXT NOT NULL DEFAULT 'nn',
        sample_key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        source_ref TEXT DEFAULT '',
        service TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        full_path TEXT NOT NULL,
        environment TEXT NOT NULL,
        headers_json TEXT DEFAULT '{}',
        query_json TEXT DEFAULT '{}',
        path_params_json TEXT DEFAULT '{}',
        body_json TEXT DEFAULT 'null',
        token TEXT DEFAULT '',
        response_json TEXT DEFAULT 'null',
        status_code INTEGER,
        ret_code TEXT DEFAULT '',
        ret_msg TEXT DEFAULT '',
        cost_ms INTEGER,
        uid TEXT DEFAULT '',
        device_id TEXT DEFAULT '',
        nntid TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        request_time TEXT DEFAULT ''
      )
    `).run();
    this.ensureColumn('api_request_samples', 'token', 'TEXT DEFAULT ""');
    this.ensureColumn('api_request_samples', 'product_line_id', "TEXT NOT NULL DEFAULT 'nn'");
    getDatabase().prepare(`
      CREATE TABLE IF NOT EXISTS api_request_invalid_tokens (
        product_line_id TEXT NOT NULL DEFAULT 'nn',
        token TEXT NOT NULL,
        environment TEXT NOT NULL,
        reason TEXT DEFAULT '',
        invalid_at TEXT NOT NULL,
        PRIMARY KEY (product_line_id, token, environment)
      )
    `).run();
    const invalidTokenColumns = getDatabase().prepare('PRAGMA table_info(api_request_invalid_tokens)').all() as { name: string }[];
    if (!invalidTokenColumns.some((column) => column.name === 'product_line_id')) {
      getDatabase().exec(`
        ALTER TABLE api_request_invalid_tokens RENAME TO api_request_invalid_tokens_legacy;
        CREATE TABLE api_request_invalid_tokens (
          product_line_id TEXT NOT NULL DEFAULT 'nn',
          token TEXT NOT NULL,
          environment TEXT NOT NULL,
          reason TEXT DEFAULT '',
          invalid_at TEXT NOT NULL,
          PRIMARY KEY (product_line_id, token, environment)
        );
        INSERT INTO api_request_invalid_tokens (product_line_id, token, environment, reason, invalid_at)
        SELECT 'nn', token, environment, reason, invalid_at FROM api_request_invalid_tokens_legacy;
        DROP TABLE api_request_invalid_tokens_legacy;
      `);
    }
    getDatabase().prepare('CREATE INDEX IF NOT EXISTS idx_api_request_samples_lookup ON api_request_samples(product_line_id, service, method, path, environment, created_at)').run();
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = getDatabase().prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
    if (!columns.some((column) => column.name === columnName)) {
      getDatabase().prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
    }
  }

  ingestLogLine(line: string, options: { source: LogSource; sourceRef?: string; timestamp?: string; productLineId?: string }): number {
    if (!line.includes('event=api_request') && !line.includes('event=api_response')) return 0;
    const parsed = this.parseBusinessLogLine(line);
    if (!parsed || (parsed.event !== 'api_request' && parsed.event !== 'api_response')) return 0;

    if (parsed.event === 'api_request') {
      const api = parsed.fields.api || '';
      const nntid = parsed.fields.nntid || crypto.randomUUID();
      const productLineId = options.productLineId || currentProductLineId();
      this.pendingRequests.set(`${productLineId}:${nntid}`, {
        productLineId,
        source: options.source,
        sourceRef: options.sourceRef || '',
        line,
        api,
        parameters: this.parseJsonValue(parsed.fields.parameters),
        token: parsed.fields.token || this.extractToken(this.parseJsonValue(parsed.fields.parameters)),
        nntid,
        createdAt: options.timestamp || new Date().toISOString(),
      });
      return 0;
    }

    const nntid = parsed.fields.nntid || '';
    const productLineId = options.productLineId || currentProductLineId();
    const pendingKey = `${productLineId}:${nntid}`;
    const pending = nntid ? this.pendingRequests.get(pendingKey) : undefined;
    if (!pending && !parsed.fields.api) return 0;
    const api = pending?.api || parsed.fields.api || '';
    const sample = this.buildSample({
      productLineId: pending?.productLineId || options.productLineId || currentProductLineId(),
      source: pending?.source || options.source,
      sourceRef: pending?.sourceRef || options.sourceRef || '',
      api,
      parameters: pending?.parameters,
      token: pending?.token || parsed.fields.token || '',
      response: this.parseJsonValue(parsed.fields.response),
      retCode: parsed.fields.retCode || '',
      retMsg: parsed.fields.retMsg || '',
      costMs: Number(parsed.fields.costMs || 0) || undefined,
      nntid,
      uid: parsed.fields.uid || parsed.fields.userId || '',
      deviceId: parsed.fields.deviceId || '',
      createdAt: options.timestamp || new Date().toISOString(),
      requestTime: pending?.createdAt || parsed.time || '',
    });
    if (nntid) this.pendingRequests.delete(pendingKey);
    return sample ? this.saveSample(sample) : 0;
  }

  ingestLogLines(lines: string[], options: { source: LogSource; sourceRef?: string; productLineId?: string }): number {
    let count = 0;
    for (const line of lines) {
      try {
        count += this.ingestLogLine(line, options);
      } catch (error) {
        logger.debug(`[ApiRequestSample] 忽略无法解析的日志行: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
    return count;
  }

  listSamples(filters: { service: string; method: string; path: string; environment?: string; limit?: number }): ApiRequestSample[] {
    this.ensureTable();
    const limit = Math.min(Math.max(Number(filters.limit || 20), 1), 50);
    const params: unknown[] = [currentProductLineId(), filters.service, filters.method.toUpperCase(), filters.path];
    let where = 'product_line_id = ? AND service = ? AND method = ? AND path = ?';
    if (filters.environment && filters.environment !== 'all') {
      where += ' AND environment = ?';
      params.push(filters.environment);
    }
    params.push(limit);
    let rows = getDatabase().prepare(`
      SELECT *
      FROM api_request_samples
      WHERE ${where}
        AND (
          token = ''
          OR NOT EXISTS (
            SELECT 1 FROM api_request_invalid_tokens
            WHERE api_request_invalid_tokens.product_line_id = api_request_samples.product_line_id
              AND api_request_invalid_tokens.token = api_request_samples.token
              AND api_request_invalid_tokens.environment = api_request_samples.environment
          )
        )
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params) as any[];
    if (rows.length === 0 && filters.method) {
      const fallbackParams: unknown[] = [currentProductLineId(), filters.service, filters.path];
      let fallbackWhere = 'product_line_id = ? AND service = ? AND path = ?';
      if (filters.environment && filters.environment !== 'all') {
        fallbackWhere += ' AND environment = ?';
        fallbackParams.push(filters.environment);
      }
      fallbackParams.push(limit);
      rows = getDatabase().prepare(`
        SELECT *
        FROM api_request_samples
        WHERE ${fallbackWhere}
          AND (
            token = ''
            OR NOT EXISTS (
              SELECT 1 FROM api_request_invalid_tokens
              WHERE api_request_invalid_tokens.product_line_id = api_request_samples.product_line_id
                AND api_request_invalid_tokens.token = api_request_samples.token
                AND api_request_invalid_tokens.environment = api_request_samples.environment
            )
          )
        ORDER BY created_at DESC
        LIMIT ?
      `).all(...fallbackParams) as any[];
    }
    return rows.map((row) => ({
      id: row.id,
      productLineId: row.product_line_id || 'nn',
      source: row.source,
      sourceRef: row.source_ref || '',
      service: row.service,
      method: row.method,
      path: row.path,
      fullPath: row.full_path,
      environment: row.environment,
      headers: this.safeParseObject(row.headers_json),
      query: this.safeParseObject(row.query_json),
      pathParams: this.safeParseObject(row.path_params_json),
      body: this.safeParse(row.body_json),
      token: row.token || '',
      response: this.safeParse(row.response_json),
      statusCode: row.status_code ?? undefined,
      retCode: row.ret_code || '',
      retMsg: row.ret_msg || '',
      costMs: row.cost_ms ?? undefined,
      uid: row.uid || '',
      deviceId: row.device_id || '',
      nntid: row.nntid || '',
      createdAt: row.created_at,
      requestTime: row.request_time || '',
    }));
  }

  latestToken(environment: string): { token: string; environment: string; createdAt: string; source: LogSource; sourceRef: string } | undefined {
    this.ensureTable();
    const row = getDatabase().prepare(`
      SELECT token, environment, created_at, source, source_ref
      FROM api_request_samples
      WHERE product_line_id = ? AND environment = ?
        AND token != ''
        AND NOT EXISTS (
          SELECT 1 FROM api_request_invalid_tokens
          WHERE api_request_invalid_tokens.product_line_id = api_request_samples.product_line_id
            AND api_request_invalid_tokens.token = api_request_samples.token
            AND api_request_invalid_tokens.environment = api_request_samples.environment
        )
      ORDER BY created_at DESC
      LIMIT 1
    `).get(currentProductLineId(), environment) as { token?: string; environment?: string; created_at?: string; source?: LogSource; source_ref?: string } | undefined;
    if (!row?.token) return undefined;
    return {
      token: row.token,
      environment: row.environment || environment,
      createdAt: row.created_at || '',
      source: row.source || 'realtime_log',
      sourceRef: row.source_ref || '',
    };
  }

  matchOperation(apiUrl: string, documents: Record<string, DocumentLike>): { service: string; method: string; path: string; fullPath: string } | undefined {
    const urlPath = this.extractPath(apiUrl);
    for (const [service, document] of Object.entries(documents)) {
      for (const [apiPath, methods] of Object.entries(document.paths || {})) {
        const fullPath = this.joinApiPath(document.basePath || '', apiPath);
        const params = this.matchPath(fullPath, urlPath);
        if (!params) continue;
        const method = Object.keys(methods || {})[0]?.toUpperCase() || 'POST';
        return { service, method, path: apiPath, fullPath };
      }
    }
    return undefined;
  }

  buildSample(input: {
    productLineId?: string;
    source: LogSource;
    sourceRef: string;
    api: string;
    parameters: unknown;
    token: string;
    response: unknown;
    retCode: string;
    retMsg: string;
    costMs?: number;
    nntid: string;
    uid: string;
    deviceId: string;
    createdAt: string;
    requestTime: string;
  }): (Omit<ApiRequestSample, 'id'> & { sampleKey: string }) | undefined {
    const operation = this.inferOperation(input.api);
    if (!operation) return undefined;
    return this.createSample(input, operation);
  }

  private saveSample(sample: Omit<ApiRequestSample, 'id'> & { sampleKey: string }): number {
    this.ensureTable();
    if (sample.token && this.isTokenInvalid(sample.productLineId, sample.environment, sample.token)) {
      return 0;
    }
    const id = crypto.randomUUID();
    const result = getDatabase().prepare(`
      INSERT INTO api_request_samples (
        id, product_line_id, sample_key, source, source_ref, service, method, path, full_path, environment,
        headers_json, query_json, path_params_json, body_json, token, response_json, status_code,
        ret_code, ret_msg, cost_ms, uid, device_id, nntid, created_at, request_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sample_key) DO UPDATE SET
        token = excluded.token,
        response_json = excluded.response_json,
        status_code = excluded.status_code,
        ret_code = excluded.ret_code,
        ret_msg = excluded.ret_msg,
        cost_ms = excluded.cost_ms,
        created_at = excluded.created_at
    `).run(
      id,
      sample.productLineId,
      sample.sampleKey,
      sample.source,
      sample.sourceRef,
      sample.service,
      sample.method,
      sample.path,
      sample.fullPath,
      sample.environment,
      JSON.stringify(sample.headers),
      JSON.stringify(sample.query),
      JSON.stringify(sample.pathParams),
      JSON.stringify(sample.body ?? null),
      sample.token,
      JSON.stringify(sample.response ?? null),
      sample.statusCode ?? null,
      sample.retCode,
      sample.retMsg,
      sample.costMs ?? null,
      sample.uid,
      sample.deviceId,
      sample.nntid,
      sample.createdAt,
      sample.requestTime,
    );
    return result.changes > 0 ? 1 : 0;
  }

  markTokenInvalid(environment: string, token: string, reason: string): number {
    const normalizedEnvironment = environment || 'unknown';
    const normalizedToken = token.trim();
    if (!normalizedToken) return 0;
    this.ensureTable();
    const now = new Date().toISOString();
    getDatabase().prepare(`
      INSERT INTO api_request_invalid_tokens (product_line_id, token, environment, reason, invalid_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(product_line_id, token, environment) DO UPDATE SET
        reason = excluded.reason,
        invalid_at = excluded.invalid_at
    `).run(currentProductLineId(), normalizedToken, normalizedEnvironment, reason, now);
    const result = getDatabase().prepare(`
      DELETE FROM api_request_samples
      WHERE product_line_id = ? AND token = ? AND environment = ?
    `).run(currentProductLineId(), normalizedToken, normalizedEnvironment);
    return result.changes;
  }

  private isTokenInvalid(productLineId: string, environment: string, token: string): boolean {
    const row = getDatabase().prepare(`
      SELECT 1 AS matched
      FROM api_request_invalid_tokens
      WHERE product_line_id = ? AND environment = ? AND token = ?
      LIMIT 1
    `).get(productLineId, environment || 'unknown', token) as { matched?: number } | undefined;
    return Boolean(row?.matched);
  }

  private parseBusinessLogLine(line: string): ParsedLog | undefined {
    const event = line.match(/\bevent=([A-Za-z0-9_:.+-]+)/)?.[1] || '';
    const fieldsText = line.match(/\bfields=\{([\s\S]*)\}\s*$/)?.[1] || '';
    if (!event || !fieldsText) return undefined;
    return {
      time: line.match(/^\[([^\]]+)\]/)?.[1] || '',
      event,
      fields: this.parseFields(fieldsText),
    };
  }

  private parseFields(text: string): Record<string, string> {
    const fields: Record<string, string> = {};
    let index = 0;
    while (index < text.length) {
      const keyMatch = text.slice(index).match(/^\s*,?\s*([A-Za-z0-9_]+)=/);
      if (!keyMatch) break;
      const key = keyMatch[1];
      index += keyMatch[0].length;
      let value = '';
      if (text[index] === '"') {
        index += 1;
        const start = index;
        while (index < text.length) {
          if (text[index] === '"' && (text[index - 1] !== '\\' || text[index - 2] === '\\')) {
            const rest = text.slice(index + 1);
            if (/^\s*(?:,\s*[A-Za-z0-9_]+=|\s*$)/.test(rest)) break;
          }
          index += 1;
        }
        value = text.slice(start, index);
        if (text[index] === '"') index += 1;
      } else {
        const start = index;
        while (index < text.length && text[index] !== ',') index += 1;
        value = text.slice(start, index).trim();
      }
      fields[key] = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return fields;
  }

  private parseJsonValue(value: string | undefined): unknown {
    if (!value || value === '-') return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private safeParse(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private safeParseObject(value: string): Record<string, unknown> {
    const parsed = this.safeParse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  }

  private extractPath(apiUrl: string): string {
    try {
      return new URL(apiUrl).pathname.replace(/\/+$/, '') || '/';
    } catch {
      return (`/${apiUrl}`).replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    }
  }

  private environmentFromApi(apiUrl: string): RequestEnvironment {
    try {
      const host = new URL(apiUrl).host;
      for (const [environment, hosts] of Object.entries(requestEnvironments)) {
        if (hosts.some((item) => host.includes(item))) return environment as RequestEnvironment;
      }
    } catch {
      // 非完整 URL 无法判断环境。
    }
    return 'unknown';
  }

  private joinApiPath(basePath = '', apiPath = ''): string {
    const normalizedBase = basePath.replace(/\/+$/, '');
    const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    if (!normalizedBase) return normalizedPath;
    if (normalizedPath === normalizedBase || normalizedPath.startsWith(`${normalizedBase}/`)) return normalizedPath;
    return `${normalizedBase}${normalizedPath}`;
  }

  private matchPath(template: string, actual: string): Record<string, string> | undefined {
    const templateParts = template.split('/').filter(Boolean);
    const actualParts = actual.split('/').filter(Boolean);
    if (templateParts.length !== actualParts.length) return undefined;
    const params: Record<string, string> = {};
    for (let index = 0; index < templateParts.length; index += 1) {
      const templatePart = templateParts[index];
      const actualPart = actualParts[index];
      const pathParam = templatePart.match(/^\{(.+)\}$/)?.[1];
      if (pathParam) {
        params[pathParam] = decodeURIComponent(actualPart);
      } else if (templatePart !== actualPart) {
        return undefined;
      }
    }
    return params;
  }

  sanitizeBusinessParams(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.sanitizeBusinessParams(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !runtimeRequestParamKeys.has(key.toLowerCase()))
      .map(([key, item]) => [key, this.sanitizeBusinessParams(item)]));
  }

  sanitizeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
    return this.sanitizeBusinessParams(headers) as Record<string, unknown>;
  }

  splitParameters(parameters: unknown, method: string): Pick<ApiRequestSample, 'query' | 'pathParams' | 'body' | 'headers'> {
    const headers: Record<string, unknown> = {};
    const sanitizedParameters = this.sanitizeBusinessParams(parameters);
    if (!sanitizedParameters || typeof sanitizedParameters !== 'object' || Array.isArray(sanitizedParameters)) {
      return { headers, query: {}, pathParams: {}, body: sanitizedParameters };
    }
    if (method === 'GET') {
      return { headers, query: sanitizedParameters as Record<string, unknown>, pathParams: {}, body: undefined };
    }
    return { headers, query: {}, pathParams: {}, body: sanitizedParameters };
  }

  createSample(input: Parameters<ApiRequestSampleService['buildSample']>[0], operation: { service: string; method: string; path: string; fullPath: string; pathParams?: Record<string, string> }) {
    const token = input.token || this.extractToken(input.parameters);
    const parts = this.splitParameters(input.parameters, operation.method);
    const sampleKey = crypto
      .createHash('sha1')
      .update([input.productLineId || currentProductLineId(), input.nntid, input.source, operation.service, operation.method, operation.path, JSON.stringify(input.parameters || {})].join('|'))
      .digest('hex');
    return {
      sampleKey,
      productLineId: input.productLineId || currentProductLineId(),
      source: input.source,
      sourceRef: input.sourceRef,
      service: operation.service,
      method: operation.method,
      path: operation.path,
      fullPath: operation.fullPath,
      environment: this.environmentFromApi(input.api),
      headers: this.sanitizeHeaders(parts.headers),
      query: parts.query,
      pathParams: operation.pathParams || {},
      body: parts.body,
      token,
      response: input.response,
      retCode: input.retCode,
      retMsg: input.retMsg,
      costMs: input.costMs,
      statusCode: undefined,
      uid: input.uid,
      deviceId: input.deviceId,
      nntid: input.nntid,
      createdAt: input.createdAt,
      requestTime: input.requestTime,
    };
  }

  private extractToken(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value)) {
      for (const item of value) {
        const token = this.extractToken(item);
        if (token) return token;
      }
      return '';
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase() === 'token' && typeof item === 'string') return item;
      const token = this.extractToken(item);
      if (token) return token;
    }
    return '';
  }

  private inferOperation(apiUrl: string): { service: string; method: string; path: string; fullPath: string; pathParams?: Record<string, string> } | undefined {
    const urlPath = this.extractPath(apiUrl);
    const entries = Object.entries(serviceBasePaths).sort((left, right) => right[1].length - left[1].length);
    for (const [service, basePath] of entries) {
      if (urlPath !== basePath && !urlPath.startsWith(`${basePath}/`)) continue;
      const apiPath = urlPath.slice(basePath.length) || '/';
      return {
        service,
        method: 'POST',
        path: apiPath,
        fullPath: urlPath,
        pathParams: {},
      };
    }
    return undefined;
  }
}

export const apiRequestSampleService = new ApiRequestSampleService();
