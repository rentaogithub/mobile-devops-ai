import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import vm from 'vm';

export interface CapabilityDatasetDoc {
  capability: string;
  domain: AssistantCapabilityDomain;
  aliases: string[];
  category?: string;
  toolName?: string;
  cardType?: string;
  role?: string;
  riskLevel?: string;
  methodName?: string;
  codeSnippet?: string;
  scenario: string;
  description: string;
  usage: string;
  inputs: string[];
  outputs: string[];
  status: string;
  source?: string;
  updatedAt?: string;
}

export type AssistantCapabilityDomain = 'route' | 'cross_platform' | 'crash' | 'cicd' | 'quality' | 'workflow' | 'logs' | 'pods' | 'api' | 'platform';

interface CapabilityDatasetFile {
  source: string;
  syncedAt: string;
  items: CapabilityDatasetDoc[];
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '..', 'nn-ios-platform-data');

function datasetDir() {
  return process.env.ASSISTANT_CAPABILITY_DATASET_DIR || path.join(DATA_DIR, 'assistant-capabilities');
}

function safeSourceName(source: string) {
  return source.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'manual';
}

function toStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeCapabilityDoc(value: any, source: string, syncedAt: string): CapabilityDatasetDoc | undefined {
  const domain = String(value?.domain || '').trim();
  const capability = String(value?.capability || value?.title || value?.name || '').trim();
  if (!capability || !isCapabilityDomain(domain)) return undefined;
  const description = String(value?.description || value?.summary || '').trim();
  const codeSnippet = String(value?.codeSnippet || value?.route || value?.scheme || value?.method || '').trim();
  const aliases = Array.from(new Set([
    capability,
    value?.toolName,
    value?.methodName,
    ...toStringArray(value?.aliases),
    ...toStringArray(value?.keywords),
    codeSnippet,
  ].filter(Boolean)));
  return {
    capability,
    domain,
    aliases,
    ...(value?.category ? { category: String(value.category).trim() } : {}),
    ...(value?.toolName ? { toolName: String(value.toolName).trim() } : {}),
    ...(value?.cardType ? { cardType: String(value.cardType).trim() } : {}),
    ...(value?.role ? { role: String(value.role).trim() } : {}),
    ...(value?.riskLevel ? { riskLevel: String(value.riskLevel).trim() } : {}),
    ...(value?.methodName ? { methodName: String(value.methodName).trim() } : domain === 'route' && codeSnippet ? { methodName: '路由' } : {}),
    ...(codeSnippet ? { codeSnippet } : {}),
    scenario: String(value?.scenario || value?.scene || description || capability).trim(),
    description: description || capability,
    usage: String(value?.usage || value?.use || (codeSnippet ? '按业务参数替换占位符后使用。' : description || capability)).trim(),
    inputs: toStringArray(value?.inputs || value?.parameters || value?.params),
    outputs: toStringArray(value?.outputs || value?.returns || value?.result),
    status: String(value?.status || '平台能力数据集').trim(),
    source,
    updatedAt: String(value?.updatedAt || syncedAt),
  };
}

export class AssistantCapabilityDatasetService {
  listCapabilityDocs(): CapabilityDatasetDoc[] {
    const dir = datasetDir();
    if (!fs.existsSync(dir)) return [];
    const rows: CapabilityDatasetDoc[] = [];
    for (const filename of fs.readdirSync(dir).filter((item) => item.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, filename), 'utf8')) as CapabilityDatasetFile;
        if (!Array.isArray(parsed.items)) continue;
        rows.push(...parsed.items.flatMap((item) => {
          const normalized = normalizeCapabilityDoc(item, parsed.source || filename.replace(/\.json$/, ''), parsed.syncedAt || new Date().toISOString());
          return normalized ? [normalized] : [];
        }));
      } catch {
        continue;
      }
    }
    return rows;
  }

  inferKnowledgeIntent(content: string): CapabilityDatasetDoc['domain'] | undefined {
    const normalizedContent = normalizeDatasetText(content);
    if (!normalizedContent || normalizedContent.length < 2) return undefined;
    const matches = this.listCapabilityDocs()
      .flatMap((item) => {
        const terms = [
          item.capability,
          item.methodName || '',
          ...item.aliases,
        ].map(normalizeDatasetText).filter((term) => term.length >= 2);
        const score = terms.reduce((max, term) => {
          if (normalizedContent === term) return Math.max(max, 1000 + term.length);
          if (normalizedContent.includes(term)) return Math.max(max, 500 + term.length);
          if (term.includes(normalizedContent)) return Math.max(max, 200 + normalizedContent.length);
          return max;
        }, 0);
        return score > 0 ? [{ domain: item.domain, score }] : [];
      })
      .sort((left, right) => right.score - left.score);
    return matches[0]?.domain;
  }

  searchCapabilities(keyword: string, limit = 30, domains?: AssistantCapabilityDomain[]) {
    const normalizedKeyword = normalizeDatasetText(keyword);
    const domainSet = domains?.length ? new Set(domains) : undefined;
    const rows = this.listCapabilityDocs()
      .filter((item) => !domainSet || domainSet.has(item.domain))
      .map((item) => ({ item, score: capabilitySearchScore(item, normalizedKeyword) }))
      .filter(({ score }) => score > 0 || !normalizedKeyword)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.min(Math.max(limit, 1), 100))
      .map(({ item, score }) => ({ ...item, score }));
    return {
      kind: 'assistant_capability_search',
      displayType: 'capability_directory',
      keyword,
      total: rows.length,
      rows,
      dataset: this.status(),
      note: '能力目录来自全服务工具注册、路由管理入口、跨端能力入口和外部同步数据集；用于语义识别、查询引导和结果卡片展示。',
    };
  }

  syncCapabilities(input: { source?: string; replace?: boolean; items?: unknown[] } | unknown[]) {
    const payload = Array.isArray(input) ? { items: input } : input;
    const source = safeSourceName(String(payload?.source || 'manual'));
    const syncedAt = new Date().toISOString();
    const incoming = Array.isArray(payload?.items) ? payload.items : [];
    const normalized = incoming.flatMap((item) => {
      const doc = normalizeCapabilityDoc(item, source, syncedAt);
      return doc ? [doc] : [];
    });
    const filePath = path.join(datasetDir(), `${source}.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const previous = payload?.replace ? [] : this.readDatasetFile(filePath).items;
    const merged = this.mergeCapabilityDocs([...previous, ...normalized]);
    const data: CapabilityDatasetFile = { source, syncedAt, items: merged };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return {
      source,
      syncedAt,
      received: incoming.length,
      synced: normalized.length,
      total: merged.length,
      datasetPath: filePath,
    };
  }

  async syncFromEntrances(options: { routesUrl?: string; crossPlatformUrl?: string } = {}) {
    const results = [];
    const routesUrl = options.routesUrl || process.env.ROUTE_CAPABILITY_SOURCE_URL || 'https://fe-tools.nn.com/protocol-jump.html';
    const crossPlatformUrl = options.crossPlatformUrl || process.env.CROSS_PLATFORM_CAPABILITY_SOURCE_URL || 'https://fe-tools.nn.com/js-sdk-example/index.html';

    results.push(await this.syncRoutesFromEntrance(routesUrl));
    results.push(await this.syncCrossPlatformFromEntrance(crossPlatformUrl));

    return {
      syncedAt: new Date().toISOString(),
      results,
      totalSynced: results.reduce((sum, item) => sum + item.synced, 0),
    };
  }

  async syncRoutesFromEntrance(url: string) {
    const bundle = await this.fetchEntranceBundle(url);
    const protocols = this.extractRouteProtocols(bundle.js);
    const items = protocols.map((item) => ({
      domain: 'route',
      capability: item.title,
      category: item.module,
      description: item.description,
      scenario: item.description,
      route: item.template,
      aliases: [
        item.id,
        item.title,
        item.description,
        item.module,
        item.template,
        ...(item.params || []).flatMap((param: any) => [param.key, param.label]),
      ],
      parameters: ['host', ...(item.params || []).map((param: any) => param.key).filter(Boolean)],
      outputs: [item.description || `打开${item.title}`],
      usage: [
        `来自路由管理入口：${item.title}。`,
        item.versionNote ? `版本要求：${item.versionNote}` : '',
        Array.isArray(item.platforms) && item.platforms.length ? `支持端：${item.platforms.join('、')}` : '',
      ].filter(Boolean).join(' '),
      status: '路由管理入口同步',
    }));
    return this.syncCapabilities({ source: 'route-management', replace: true, items });
  }

  async syncCrossPlatformFromEntrance(url: string) {
    const bundle = await this.fetchEntranceBundle(url);
    const groups = this.extractBridgeGroups(bundle.js);
    const items = groups.flatMap((group) => group.list.map((item: any) => ({
      domain: 'cross_platform',
      capability: item.label,
      category: group.title,
      methodName: item.method,
      codeSnippet: this.bridgeCodeSnippet(item),
      description: item.description,
      scenario: item.description,
      aliases: [
        item.label,
        item.method,
        item.description,
        group.title,
        ...(Array.isArray(item.params) ? item.params.flatMap((param: any) => typeof param === 'object' ? [param.name, param.label, param.value] : [String(param)]) : []),
      ],
      parameters: this.bridgeInputs(item),
      outputs: ['调用结果'],
      usage: `来自跨端能力入口：通过 NNJSBridge.${item.method} 调用。`,
      status: '跨端能力入口同步',
    })));
    return this.syncCapabilities({ source: 'cross-platform', replace: true, items });
  }

  status() {
    const dir = datasetDir();
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((item) => item.endsWith('.json')) : [];
    const docs = this.listCapabilityDocs();
    return {
      datasetDir: dir,
      files: files.length,
      total: docs.length,
      byDomain: docs.reduce<Record<string, number>>((acc, item) => {
        acc[item.domain] = (acc[item.domain] || 0) + 1;
        return acc;
      }, {}),
      sources: docs.reduce<Record<string, number>>((acc, item) => {
        const source = item.source || 'unknown';
        acc[source] = (acc[source] || 0) + 1;
        return acc;
      }, {}),
    };
  }

  private readDatasetFile(filePath: string): CapabilityDatasetFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CapabilityDatasetFile;
      return {
        source: parsed.source || path.basename(filePath, '.json'),
        syncedAt: parsed.syncedAt || new Date().toISOString(),
        items: Array.isArray(parsed.items) ? parsed.items : [],
      };
    } catch {
      return { source: path.basename(filePath, '.json'), syncedAt: new Date().toISOString(), items: [] };
    }
  }

  private mergeCapabilityDocs(items: CapabilityDatasetDoc[]) {
    const map = new Map<string, CapabilityDatasetDoc>();
    for (const item of items) {
      const key = `${item.domain}:${item.capability}:${item.codeSnippet || item.methodName || ''}`.toLowerCase();
      map.set(key, item);
    }
    return Array.from(map.values());
  }

  private async fetchEntranceBundle(entryUrl: string) {
    const html = await fetchText(entryUrl);
    const scriptMatch = html.match(/<script[^>]+src="([^"]+\.js)"[^>]*><\/script>/i);
    if (!scriptMatch) throw new Error(`入口未找到 JS bundle：${entryUrl}`);
    const scriptUrl = new URL(scriptMatch[1], entryUrl).toString();
    return { html, scriptUrl, js: await fetchText(scriptUrl) };
  }

  private extractRouteProtocols(js: string): any[] {
    const start = js.indexOf('const se=');
    const end = js.indexOf(';for(const y of U)', start);
    if (start < 0 || end < 0) throw new Error('路由入口 bundle 未找到协议定义数组');
    const context: any = {};
    vm.runInNewContext(`${js.slice(start, end)};result=U;`, context, { timeout: 1000 });
    if (!Array.isArray(context.result)) throw new Error('路由协议定义解析失败');
    return context.result;
  }

  private extractBridgeGroups(js: string): Array<{ title: string; list: any[] }> {
    const marker = 'de=N(()=>';
    const start = js.indexOf(marker);
    if (start < 0) throw new Error('跨端入口 bundle 未找到能力定义数组');
    const arrayStart = js.indexOf('[', start + marker.length);
    const arrayEnd = findBalancedEnd(js, arrayStart, '[', ']');
    if (arrayStart < 0 || arrayEnd < 0) throw new Error('跨端入口 bundle 能力定义数组解析失败');
    const context: any = {
      z: '使用默认图片',
      M: '使用 file 选择器',
      K: ['', 'CustomerService', 'Share', 'More'],
      Ue: { CustomerService: 'e620', Share: 'e6be', More: 'e787' },
      g: () => undefined,
      v: (value: unknown) => String(value),
      I: (value: unknown) => String(value),
    };
    vm.runInNewContext(`result=${js.slice(arrayStart, arrayEnd + 1)};`, context, { timeout: 1000 });
    if (!Array.isArray(context.result)) throw new Error('跨端能力定义解析失败');
    return context.result.filter((group: any) => group?.title && Array.isArray(group?.list));
  }

  private bridgeInputs(item: any) {
    if (!Array.isArray(item.params)) return [];
    if (item.prompt) {
      return item.params.map((param: any) => typeof param === 'object' ? String(param.name || param.label || '').trim() : '').filter(Boolean);
    }
    return item.params.map((param: any, index: number) => typeof param === 'object'
      ? String(param.name || param.label || `param${index + 1}`).trim()
      : `param${index + 1}`).filter(Boolean);
  }

  private bridgeCodeSnippet(item: any) {
    const inputs = this.bridgeInputs(item);
    if (!inputs.length) return `NNJSBridge.${item.method}()`;
    return `NNJSBridge.${item.method}(${inputs.map((input: string) => `<${input}>`).join(', ')})`;
  }
}

export const assistantCapabilityDatasetService = new AssistantCapabilityDatasetService();

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { timeout: 20_000 }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        fetchText(new URL(response.headers.location, url).toString()).then(resolve, reject);
        return;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`请求入口失败：${response.statusCode || 'unknown'} ${url}`));
        return;
      }
      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    });
    request.on('timeout', () => {
      request.destroy(new Error(`请求入口超时：${url}`));
    });
    request.on('error', reject);
  });
}

function normalizeDatasetText(value: string) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '');
}

function isCapabilityDomain(value: string): value is AssistantCapabilityDomain {
  return ['route', 'cross_platform', 'crash', 'cicd', 'quality', 'workflow', 'logs', 'pods', 'api', 'platform'].includes(value);
}

function capabilitySearchScore(item: CapabilityDatasetDoc, normalizedKeyword: string) {
  if (!normalizedKeyword) return 1;
  const fields = [
    { value: item.capability, weight: 8 },
    { value: item.toolName || '', weight: 7 },
    { value: item.methodName || '', weight: 7 },
    { value: item.category || '', weight: 5 },
    { value: item.aliases.join(' '), weight: 5 },
    { value: item.description, weight: 4 },
    { value: item.scenario, weight: 3 },
    { value: item.usage, weight: 2 },
    { value: `${item.inputs.join(' ')} ${item.outputs.join(' ')}`, weight: 2 },
    { value: item.domain, weight: 2 },
  ];
  return fields.reduce((total, field) => {
    const normalized = normalizeDatasetText(field.value);
    if (!normalized) return total;
    if (normalized === normalizedKeyword) return total + 1000 * field.weight;
    if (normalized.includes(normalizedKeyword)) return total + (100 + normalizedKeyword.length) * field.weight;
    if (normalizedKeyword.includes(normalized)) return total + Math.min(normalized.length, 30) * field.weight;
    return total;
  }, 0);
}

function findBalancedEnd(source: string, start: number, open: string, close: string) {
  if (start < 0 || source[start] !== open) return -1;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
