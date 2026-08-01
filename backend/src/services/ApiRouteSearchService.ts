import fs from 'fs';
import path from 'path';
import { apiRequestSampleService } from './ApiRequestSampleService';

interface ApiOperationResult {
  service: string;
  serviceTitle: string;
  method: string;
  path: string;
  summary: string;
  operationId: string;
  tag: string;
  parameterCount: number;
  sampleCount: number;
  documentPath: string;
}

interface RouteIndexEntry {
  file: string;
  line: number;
  route: string;
  snippet: string;
  module: string;
  compatibility: string;
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '..', 'nn-ios-platform-data');
const API_CACHE_DIR = path.join(DATA_DIR, 'api-docs-cache');
const ROUTE_REPO = path.resolve(process.env.NNIOS_REPO_PATH || process.env.NNIOS_REPO_LOCAL || '/Users/a1/工作/nnios');
const SOURCE_EXTENSIONS = new Set(['.swift', '.m', '.mm', '.h', '.hpp', '.plist', '.json', '.js', '.ts', '.tsx']);
const ROUTE_MARKER = /router|route|scheme|deeplink|openurl|open\(|jump|navigate|jsbridge|webview|protocol|页面跳转|路由|跳转/i;
const IGNORED_DIRECTORIES = new Set(['.git', 'Pods', 'Carthage', 'DerivedData', 'build', 'node_modules', '.build']);

function normalize(value: string) {
  return value.toLowerCase().replace(/[%\s_\-./:?=&]+/g, '');
}

function queryTokens(keyword: string) {
  const cleaned = keyword
    .replace(/帮我|请|查询|查找|搜索|接口|路由|相关|一下|调用示例|负责人|跨端兼容性/g, ' ')
    .trim();
  const pieces = cleaned.split(/[\s,，/]+/).map(normalize).filter((item) => item.length >= 1);
  return Array.from(new Set([normalize(cleaned), ...pieces].filter((item) => item.length >= 1)));
}

function matches(text: string, tokens: string[]) {
  const normalized = normalize(text);
  return tokens.length > 0 && tokens.every((token) => normalized.includes(token));
}

function joinPath(basePath = '', apiPath = '') {
  const normalizedBase = basePath.replace(/\/$/, '');
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  if (normalizedBase && (normalizedPath === normalizedBase || normalizedPath.startsWith(`${normalizedBase}/`))) return normalizedPath;
  const joined = `${basePath.replace(/\/$/, '')}/${apiPath.replace(/^\//, '')}`;
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function inferModule(relativeFile: string) {
  const parts = relativeFile.split('/').filter(Boolean);
  const feature = parts.find((part) => /module|feature|business|component|service/i.test(part));
  return feature || parts.at(-2) || 'App';
}

function inferCompatibility(file: string, snippet: string) {
  const value = `${file} ${snippet}`;
  if (/jsbridge|webview|hybrid|h5|javascript/i.test(value)) return 'iOS / H5 Bridge';
  if (/universal.?link|https?:\/\//i.test(value)) return 'Universal Link / Web';
  if (/scheme|openurl|deeplink|router|route/i.test(value)) return 'iOS Native Scheme';
  return 'iOS Native';
}

function extractRoute(snippet: string) {
  const url = snippet.match(/(?:[a-z][a-z0-9+.-]*:\/\/[^\s"']+|\/[A-Za-z0-9_{}.?=&:/-]{3,})/i)?.[0];
  if (url) return url.replace(/[),;]+$/, '');
  const quoted = snippet.match(/["']([^"']{3,160})["']/)?.[1];
  return quoted || '-';
}

export class ApiRouteSearchService {
  private routeIndex: RouteIndexEntry[] = [];
  private routeIndexedAt = 0;

  searchApi(keyword: string, limit = 30) {
    const tokens = queryTokens(keyword);
    if (tokens.length === 0) throw new Error('API 查询关键词不能为空');
    if (!fs.existsSync(API_CACHE_DIR)) return { kind: 'api_search', keyword, total: 0, rows: [], warning: 'API 文档缓存尚未同步' };
    const results: ApiOperationResult[] = [];
    for (const filename of fs.readdirSync(API_CACHE_DIR).filter((item) => item.endsWith('.json'))) {
      let document: any;
      try {
        document = JSON.parse(fs.readFileSync(path.join(API_CACHE_DIR, filename), 'utf8'));
      } catch {
        continue;
      }
      const service = filename.replace(/\.json$/, '');
      const serviceTitle = String(document?.info?.title || service);
      for (const [apiPath, methods] of Object.entries(document?.paths || {}) as Array<[string, Record<string, any>]>) {
        for (const [method, operation] of Object.entries(methods || {})) {
          const fullPath = joinPath(document?.basePath || '', apiPath);
          const summary = String(operation?.summary || operation?.description || '');
          const operationId = String(operation?.operationId || '');
          const tag = String(operation?.tags?.[0] || '其他');
          if (!matches(`${service} ${serviceTitle} ${fullPath} ${summary} ${operationId} ${tag}`, tokens)) continue;
          results.push({
            service,
            serviceTitle,
            method: method.toUpperCase(),
            path: fullPath,
            summary,
            operationId,
            tag,
            parameterCount: Array.isArray(operation?.parameters) ? operation.parameters.length : 0,
            sampleCount: 0,
            documentPath: apiPath,
          });
        }
      }
    }
    const rows = results.slice(0, Math.min(Math.max(limit, 1), 100)).map((item) => {
      const { documentPath, ...publicItem } = item;
      return {
        ...publicItem,
        sampleCount: apiRequestSampleService.listSamples({ service: item.service, method: item.method, path: documentPath, limit: 3 }).length,
      };
    });
    return {
      kind: 'api_search',
      keyword,
      total: results.length,
      rows,
      quickActions: rows.slice(0, 3).map((item) => ({ label: `查看 ${item.method} ${item.path}`, prompt: `查看接口 ${item.method} ${item.path} 的参数和最近调用示例` })),
    };
  }

  searchRoutes(keyword: string, limit = 30) {
    const tokens = queryTokens(keyword);
    if (tokens.length === 0) throw new Error('路由查询关键词不能为空');
    this.ensureRouteIndex();
    const rows = this.routeIndex
      .filter((item) => matches(`${item.file} ${item.route} ${item.snippet} ${item.module}`, tokens))
      .slice(0, Math.min(Math.max(limit, 1), 100));
    return {
      kind: 'route_search',
      keyword,
      repo: ROUTE_REPO,
      total: rows.length,
      rows,
      note: '负责人和跨端兼容性来自模块路径与代码特征推断，最终以模块维护信息为准。',
      quickActions: rows.slice(0, 3).map((item) => ({ label: `分析 ${item.module}`, prompt: `分析路由 ${item.route} 的调用入口、参数和跨端兼容风险` })),
    };
  }

  private ensureRouteIndex() {
    if (this.routeIndex.length > 0 && Date.now() - this.routeIndexedAt < 5 * 60_000) return;
    if (!fs.existsSync(ROUTE_REPO)) {
      this.routeIndex = [];
      this.routeIndexedAt = Date.now();
      return;
    }
    const entries: RouteIndexEntry[] = [];
    let visitedFiles = 0;
    const visit = (directory: string) => {
      if (visitedFiles >= 30_000 || entries.length >= 10_000) return;
      let children: fs.Dirent[] = [];
      try {
        children = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        if (IGNORED_DIRECTORIES.has(child.name)) continue;
        const absolute = path.join(directory, child.name);
        if (child.isDirectory()) {
          visit(absolute);
          continue;
        }
        if (!child.isFile() || !SOURCE_EXTENSIONS.has(path.extname(child.name).toLowerCase())) continue;
        visitedFiles += 1;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(absolute);
        } catch {
          continue;
        }
        if (stat.size > 768 * 1024) continue;
        let content = '';
        try {
          content = fs.readFileSync(absolute, 'utf8');
        } catch {
          continue;
        }
        const relative = path.relative(ROUTE_REPO, absolute).replace(/\\/g, '/');
        content.split(/\r?\n/).forEach((line, index) => {
          const snippet = line.trim();
          if (!snippet || (!ROUTE_MARKER.test(snippet) && !/router|route|scheme|deeplink|jsbridge/i.test(relative))) return;
          const route = extractRoute(snippet);
          if (route === '-' && !/router|route|scheme|deeplink|openurl|open\(|navigate|jsbridge|webview/i.test(snippet)) return;
          entries.push({
            file: relative,
            line: index + 1,
            route,
            snippet: snippet.slice(0, 500),
            module: inferModule(relative),
            compatibility: inferCompatibility(relative, snippet),
          });
        });
      }
    };
    visit(ROUTE_REPO);
    this.routeIndex = entries;
    this.routeIndexedAt = Date.now();
  }
}

export const apiRouteSearchService = new ApiRouteSearchService();
