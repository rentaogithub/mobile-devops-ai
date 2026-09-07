import fs from 'fs';
import path from 'path';
import { apiRequestSampleService } from './ApiRequestSampleService';
import { assistantCapabilityDatasetService } from './AssistantCapabilityDatasetService';
import { businessSemanticService, SemanticQuery } from './BusinessSemanticService';

interface ApiOperationResult {
  service: string;
  serviceTitle: string;
  method: string;
  path: string;
  fullPath: string;
  summary: string;
  definition: string;
  usage: string;
  operationId: string;
  tag: string;
  parameters: Array<{ name: string; in: string; required: boolean; type: string; description: string }>;
  responses: Array<{ code: string; description: string }>;
  parameterCount: number;
  sampleCount: number;
  detailUrl: string;
  documentPath: string;
}

interface CapabilityDoc {
  capability: string;
  domain: 'route' | 'cross_platform';
  aliases: string[];
  category?: string;
  methodName?: string;
  codeSnippet?: string;
  scenario: string;
  description: string;
  usage: string;
  inputs: string[];
  outputs: string[];
  status: string;
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '..', 'nn-ios-platform-data');

const CAPABILITY_DOCS: CapabilityDoc[] = [
  {
    capability: '带玩主页',
    domain: 'route',
    category: '游戏服务',
    aliases: ['带玩主页', '带玩用户主页', '陪玩主页', '游戏主页', 'game profile', 'profile', 'userId'],
    methodName: '路由',
    codeSnippet: 'nn://{host}/game/profile/{userId}',
    scenario: '从 App、H5 或运营入口打开带玩用户主页。',
    description: '打开带玩用户主页。',
    usage: '替换 host 与 userId 后通过 App 路由跳转，适用于展示指定带玩用户资料页。',
    inputs: ['host', 'userId'],
    outputs: ['打开带玩用户主页'],
    status: '平台路由能力',
  },
  {
    capability: '活动页',
    domain: 'route',
    category: '运营',
    aliases: ['活动页', '活动页面', '运营活动', '活动路由', 'actives', 'activityId'],
    methodName: '路由',
    codeSnippet: 'nn://{host}/actives?activityId={activityId}',
    scenario: '从 App、H5 或投放入口打开指定运营活动页。',
    description: '打开指定活动页。',
    usage: '替换 host 与 activityId 后跳转到目标活动页，用于运营活动承接和联调验证。',
    inputs: ['host', 'activityId'],
    outputs: ['打开指定活动页'],
    status: '平台路由能力',
  },
  {
    capability: '口令/CDK兑换',
    domain: 'route',
    category: '运营',
    aliases: ['口令兑换', 'cdk兑换', 'CDK兑换', '兑换页', '兑换页面', 'redeem', 'type'],
    methodName: '路由',
    codeSnippet: 'nn://{host}/redeem?type={type}',
    scenario: '从 App、H5 或运营入口打开默认兑换页，或进入指定 CDK、口令兑换页面。',
    description: '打开默认兑换页，或按 type 指定 CDK、口令兑换页面。',
    usage: '替换 host 与 type 后跳转到兑换页；type 可按业务约定区分 CDK、口令等兑换类型。',
    inputs: ['host', 'type'],
    outputs: ['打开兑换页面'],
    status: '平台路由能力',
  },
  {
    capability: '个人主页',
    domain: 'route',
    category: '个人',
    aliases: ['个人主页', '用户主页', '指定用户个人主页', 'personal profile', 'profile', 'userId'],
    methodName: '路由',
    codeSnippet: 'nn://{host}/personal/profile/{userId}',
    scenario: '从 App、H5 或运营入口打开指定用户的个人主页。',
    description: '打开指定用户个人主页。',
    usage: '替换 host 与 userId 后通过 App 路由跳转，适用于进入用户资料页。',
    inputs: ['host', 'userId'],
    outputs: ['打开用户个人主页'],
    status: '平台路由能力',
  },
  {
    capability: 'webview 页面',
    domain: 'route',
    category: '基础能力',
    aliases: ['webview 页面', 'webview', '打开 URL', '打开url', 'H5 页面', 'url'],
    methodName: '路由',
    codeSnippet: 'nn://{host}/webview/open?url={url}',
    scenario: '从 App 路由打开指定 H5 URL，url 参数会自动 encode。',
    description: '打开指定 URL，url 参数会自动 encode。',
    usage: '替换 host 与 url 后打开指定 WebView 页面，适用于 H5 承接和联调验证。',
    inputs: ['host', 'url'],
    outputs: ['打开 WebView 页面'],
    status: '平台路由能力',
  },
  {
    capability: '跳转到下载页面',
    domain: 'route',
    category: '基础能力',
    aliases: ['下载页面', '下载页', 'app downloading', '立即下载', 'immediate'],
    methodName: '路由',
    codeSnippet: 'nn://{host}/app-downloading?immediate={immediate}',
    scenario: '打开下载页面，并可控制是否立即下载。',
    description: '打开下载页面，可控制是否立即下载。',
    usage: '替换 host 与 immediate 后进入下载页；immediate 按业务约定控制是否立即触发下载。',
    inputs: ['host', 'immediate'],
    outputs: ['打开下载页面'],
    status: '平台路由能力',
  },
  {
    capability: '打开私聊',
    domain: 'route',
    category: '消息',
    aliases: ['打开私聊', '私聊', '指定用户私聊', '聊天', 'c2c', 'chat c2c', 'userId'],
    methodName: '路由',
    codeSnippet: 'nn://{host}/chat/c2c/{userId}',
    scenario: '从 App、H5 或运营入口打开与指定用户的私聊。',
    description: '打开与指定用户的私聊。',
    usage: '替换 host 与 userId 后跳转到指定用户私聊会话。',
    inputs: ['host', 'userId'],
    outputs: ['打开私聊会话'],
    status: '平台路由能力',
  },
  {
    capability: '打开明明鼠聊天',
    domain: 'route',
    category: '消息',
    aliases: ['打开明明鼠聊天', '明明鼠聊天', '明明鼠', '鼠聊天', 'inbox-msg', 'inbox msg', 'chat c2c inbox msg'],
    methodName: '路由',
    codeSnippet: 'nn://{host}/chat/c2c/inbox-msg',
    scenario: '从 App、H5 或运营入口打开明明鼠聊天。',
    description: '打开明明鼠聊天。',
    usage: '替换 host 后跳转到明明鼠聊天会话入口。',
    inputs: ['host'],
    outputs: ['打开明明鼠聊天'],
    status: '平台路由能力',
  },
  {
    capability: '打开私聊首页',
    domain: 'route',
    category: '消息',
    aliases: ['打开私聊首页', '私聊首页', '聊天首页', 'c2c首页', 'chat c2c'],
    methodName: '路由',
    codeSnippet: 'nn://{host}/chat/c2c',
    scenario: '从 App、H5 或运营入口打开私聊首页。',
    description: '打开私聊首页。',
    usage: '替换 host 后跳转到私聊首页。',
    inputs: ['host'],
    outputs: ['打开私聊首页'],
    status: '平台路由能力',
  },
  {
    capability: '打开私聊好友页面',
    domain: 'route',
    category: '消息',
    aliases: ['打开私聊好友页面', '私聊好友页面', '好友页面', '好友页', 'friends', 'chat friends'],
    methodName: '路由',
    codeSnippet: 'nn://{host}/chat/friends?type={type}',
    scenario: '从 App、H5 或运营入口打开好友页面，并可选择好友页面类型。',
    description: '打开好友页面，可选择好友页面类型。',
    usage: '替换 host 与 type 后跳转到指定好友页面。',
    inputs: ['host', 'type'],
    outputs: ['打开好友页面'],
    status: '平台路由能力',
  },
  {
    capability: '协议跳转调试',
    domain: 'route',
    aliases: ['路由', 'route', 'scheme', 'deeplink', 'deep link', '页面跳转', '协议跳转'],
    scenario: '验证 App 内页面路由、Scheme、Universal Link 是否能正确拉起目标页面。',
    description: '面向移动端路由联调的能力说明，用于整理路由地址、参数、跳转入口和兼容风险。',
    usage: '输入路由关键词或业务场景后，返回路由调试能力的适用说明、入参关注点和验证输出。',
    inputs: ['路由地址或 Scheme', '业务关键词', '页面参数', '目标端类型'],
    outputs: ['跳转能力说明', '参数检查点', '兼容性验证建议'],
    status: '说明型能力，AI 会话内直接展示',
  },
  {
    capability: 'Universal Link / Scheme 兼容说明',
    domain: 'route',
    aliases: ['universal link', 'scheme', 'deeplink', '外链', '唤起'],
    scenario: '排查外部链接、H5 链接、短信链接或分享链接拉起 App 的兼容问题。',
    description: '梳理 Universal Link 与 Scheme 的差异、降级链路和验证点，帮助定位打不开、跳错页、参数丢失等问题。',
    usage: '按业务词检索时优先展示拉起链路说明、端类型差异和验证建议。',
    inputs: ['链接地址', '业务入口', '端类型', 'App 版本'],
    outputs: ['拉起链路说明', '降级策略', '验证清单'],
    status: '说明型能力，AI 会话内直接展示',
  },
  {
    capability: '登录路由与授权跳转说明',
    domain: 'route',
    aliases: ['登录', '登陆', 'login', 'auth', '授权', 'token', '页面跳转', '路由'],
    scenario: '从 H5、外链或 App 内入口进入登录页，登录完成后回跳原业务页面。',
    description: '说明登录路由需要关注的目标页面、回跳参数、登录态刷新和失败降级，不访问外部调试页面。',
    usage: '查询“登录路由”时直接展示登录跳转链路说明；需要接口参数时再查询登录 API 定义。',
    inputs: ['登录入口', '回跳地址', '业务来源', '授权状态'],
    outputs: ['跳转链路说明', '参数关注点', '回跳验证建议'],
    status: '说明型能力，AI 会话内直接展示',
  },
  {
    capability: '获取 Token',
    domain: 'cross_platform',
    aliases: ['获取token', '获取 token', 'token', 'gettoken', 'get token', '登录态', '当前登录用户', 'jsbridge', 'bridge'],
    methodName: 'getToken',
    codeSnippet: 'NNJSBridge.getToken()',
    scenario: 'H5 或 WebView 页面需要读取 NN 当前登录用户的 token，用于后续业务接口调用或登录态判断。',
    description: '获取 NN 当前登录用户的 token。',
    usage: '在 WebView 中通过 JSBridge 调用该方法，成功后使用返回 token 继续完成需要登录态的业务流程。',
    inputs: [],
    outputs: ['token', '登录状态'],
    status: '可通过 JSBridge 调用',
  },
  {
    capability: '跳转到其它 H5 页面',
    domain: 'cross_platform',
    aliases: ['跳转到其它h5页面', '跳转到其他h5页面', '跳转到其它页面', '跳转到其他页面', '跳转h5', '打开h5', '打开页面', 'navigateTo'],
    methodName: 'navigateTo',
    codeSnippet: 'NNJSBridge.navigateTo("https://www.nn.com/")',
    scenario: '当前 H5 或 WebView 页面需要跳转到另一个 H5 页面。',
    description: '跳转到其它 H5 页面。',
    usage: '传入目标 H5 URL，通过 JSBridge 触发容器内页面跳转。',
    inputs: ['url'],
    outputs: ['跳转结果'],
    status: '可通过 JSBridge 调用',
  },
  {
    capability: '获取社区频道信息',
    domain: 'cross_platform',
    category: '社区频道',
    aliases: ['getCommunityChannelInfo', 'community channel info', '社区频道信息', '频道信息', '社区频道', '频道资料'],
    methodName: 'getCommunityChannelInfo',
    codeSnippet: 'NNJSBridge.getCommunityChannelInfo()',
    scenario: 'H5 或 WebView 页面需要读取当前社区频道上下文，用于频道页展示、活动承接或业务判断。',
    description: '获取当前社区频道信息。',
    usage: '在 WebView 中通过 JSBridge 调用该方法，成功后使用返回的社区频道信息完成页面展示或后续业务请求。',
    inputs: [],
    outputs: ['社区信息', '频道信息'],
    status: '可通过 JSBridge 调用',
  },
  {
    capability: 'JSBridge 调用说明',
    domain: 'cross_platform',
    aliases: ['jsbridge', 'bridge', 'js bridge', '跨端', 'webview', 'hybrid', 'h5'],
    scenario: 'H5、小程序或 WebView 页面调用原生能力，例如登录态、设备信息、页面跳转、分享等。',
    description: '展示跨端 JSBridge 的能力边界、调用入参、返回结果和联调注意事项，不检索 iOS 工程源码。',
    usage: '输入业务关键词后，返回相关跨端能力说明；如果需要后端接口定义，再使用 API 查询能力。',
    inputs: ['业务关键词', 'Bridge 能力名', 'H5 场景', 'App 版本'],
    outputs: ['能力说明', '入参关注点', '回调/返回值说明', '联调建议'],
    status: '说明型能力，AI 会话内直接展示',
  },
  {
    capability: '登录态跨端传递',
    domain: 'cross_platform',
    aliases: ['登录', '登陆', 'token', 'auth', '鉴权', '授权', 'login', 'passport'],
    scenario: 'Web/H5 需要识别 App 登录状态，或调用原生登录后继续完成 Web 业务流程。',
    description: '说明登录相关跨端能力如何关注 token、用户态、授权状态和失败降级，避免把 Bridge 查询误识别成 iOS 源码搜索。',
    usage: '查询“登录 bridge”时展示本说明，并提示可进一步查询登录 API 定义与使用。',
    inputs: ['登录态', 'token', '业务来源', '回调状态'],
    outputs: ['登录态传递说明', '失败降级建议', '后续 API 查询建议'],
    status: '说明型能力，AI 会话内直接展示',
  },
  {
    capability: 'WebView 容器能力说明',
    domain: 'cross_platform',
    aliases: ['webview', '容器', 'hybrid', 'h5', 'js sdk', 'jssdk'],
    scenario: 'Web 页面需要调用 App 容器能力或确认不同端的支持范围。',
    description: '归纳 WebView 容器、JS SDK、端能力注册和兼容验证的说明信息。',
    usage: '按关键词返回容器能力说明、输入输出和验证关注点。',
    inputs: ['能力名', '页面 URL', '端类型', 'App 版本'],
    outputs: ['容器能力说明', '支持范围', '兼容验证建议'],
    status: '说明型能力，AI 会话内直接展示',
  },
];

function joinPath(basePath = '', apiPath = '') {
  const normalizedBase = basePath.replace(/\/$/, '');
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  if (normalizedBase && (normalizedPath === normalizedBase || normalizedPath.startsWith(`${normalizedBase}/`))) return normalizedPath;
  const joined = `${basePath.replace(/\/$/, '')}/${apiPath.replace(/^\//, '')}`;
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function apiScore(item: ApiOperationResult, query: SemanticQuery) {
  return businessSemanticService.scoreFields(query, [
    { value: item.path, weight: 5 },
    { value: item.operationId, weight: 4 },
    { value: item.summary, weight: 3 },
    { value: item.tag, weight: 2 },
    { value: `${item.service} ${item.serviceTitle}`, weight: 1 },
  ]);
}

function currentApiCacheDir() {
  // API 文档描述的是平台共享后端服务；调用样本和查看历史另行按产品线隔离。
  return path.join(DATA_DIR, 'api-docs-cache');
}

function schemaName(schema?: any): string {
  if (!schema) return '';
  if (schema.$ref) return decodeURIComponent(String(schema.$ref).split('/').pop() || 'object');
  if (schema.type === 'array') return `${schemaName(schema.items) || 'object'}[]`;
  return [schema.type, schema.format].filter(Boolean).join('/');
}

function summarizeParameters(parameters: any[] = []) {
  return parameters
    .filter((parameter) => String(parameter?.in || '').toLowerCase() !== 'header')
    .slice(0, 8)
    .map((parameter) => ({
      name: String(parameter?.name || ''),
      in: String(parameter?.in || ''),
      required: Boolean(parameter?.required),
      type: schemaName(parameter?.schema) || String(parameter?.type || ''),
      description: String(parameter?.description || parameter?.schema?.description || ''),
    }))
    .filter((parameter) => parameter.name);
}

function summarizeResponses(responses: Record<string, any> = {}) {
  return Object.entries(responses)
    .slice(0, 6)
    .map(([code, response]) => ({
      code,
      description: String(response?.description || schemaName(response?.schema) || ''),
    }));
}

function buildApiDocsDetailUrl(service: string, method: string, apiPath: string, keyword: string) {
  const params = new URLSearchParams({
    service,
    method,
    path: apiPath,
  });
  if (keyword.trim()) params.set('q', keyword.trim());
  return `/api-docs?${params.toString()}`;
}

function capabilityScore(item: CapabilityDoc, query: SemanticQuery) {
  const normalizedRaw = businessSemanticService.normalize(query.raw);
  const exactMethodScore = item.methodName && normalizedRaw.includes(businessSemanticService.normalize(item.methodName)) ? 500 : 0;
  const exactAliasScore = item.aliases.some((alias) => normalizedRaw.includes(businessSemanticService.normalize(alias))) ? 300 : 0;
  const concreteScore = item.methodName && item.codeSnippet ? 120 : 0;
  return exactMethodScore + exactAliasScore + concreteScore + businessSemanticService.scoreFields(query, [
    { value: item.capability, weight: 5 },
    { value: item.category || '', weight: 3 },
    { value: `${item.methodName || ''} ${item.codeSnippet || ''}`, weight: 5 },
    { value: item.aliases.join(' '), weight: 4 },
    { value: item.scenario, weight: 3 },
    { value: item.description, weight: 3 },
    { value: `${item.inputs.join(' ')} ${item.outputs.join(' ')}`, weight: 2 },
  ]);
}

function capabilityDocs() {
  const map = new Map<string, CapabilityDoc>();
  const syncedDocs = assistantCapabilityDatasetService.listCapabilityDocs()
    .filter((item): item is CapabilityDoc => item.domain === 'route' || item.domain === 'cross_platform');
  for (const item of [...CAPABILITY_DOCS, ...syncedDocs]) {
    const key = `${item.domain}:${item.capability}:${item.codeSnippet || item.methodName || ''}`.toLowerCase();
    map.set(key, item);
  }
  return Array.from(map.values());
}

export class ApiRouteSearchService {
  searchApi(keyword: string, limit = 30) {
    const query = businessSemanticService.query(keyword, ['api', '接口', '后端服务', '服务端']);
    if (query.tokens.length === 0) throw new Error('API 查询关键词不能为空');
    const apiCacheDir = currentApiCacheDir();
    if (!fs.existsSync(apiCacheDir)) return { kind: 'api_search', keyword: query.cleaned || keyword, total: 0, rows: [], warning: '当前产品线 API 文档缓存尚未同步' };
    const results: ApiOperationResult[] = [];
    for (const filename of fs.readdirSync(apiCacheDir).filter((item) => item.endsWith('.json'))) {
      let document: any;
      try {
        document = JSON.parse(fs.readFileSync(path.join(apiCacheDir, filename), 'utf8'));
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
          if (!businessSemanticService.matches(`${service} ${serviceTitle} ${fullPath} ${summary} ${operationId} ${tag}`, query)) continue;
          const parameterSummary = summarizeParameters(operation?.parameters || []);
          const responseSummary = summarizeResponses(operation?.responses || {});
          results.push({
            service,
            serviceTitle,
            method: method.toUpperCase(),
            path: fullPath,
            fullPath,
            summary,
            definition: summary || operationId || `${method.toUpperCase()} ${fullPath}`,
            usage: `在 API 接口页面打开该接口，可查看完整请求参数、响应结构，并使用已采集的 token 和调用样本发起联调。`,
            operationId,
            tag,
            parameters: parameterSummary,
            responses: responseSummary,
            parameterCount: parameterSummary.length,
            sampleCount: 0,
            detailUrl: buildApiDocsDetailUrl(service, method.toUpperCase(), apiPath, query.cleaned || keyword),
            documentPath: apiPath,
          });
        }
      }
    }
    const rows = results
      .sort((left, right) => apiScore(right, query) - apiScore(left, query))
      .slice(0, Math.min(Math.max(limit, 1), 100)).map((item) => {
      const { documentPath, ...publicItem } = item;
      return {
        ...publicItem,
        sampleCount: apiRequestSampleService.listSamples({ service: item.service, method: item.method, path: documentPath, limit: 3 }).length,
      };
    });
    if (results.length === 0) {
      businessSemanticService.recordSearchMiss({ toolName: 'api_search', rawQuery: keyword, cleanedQuery: query.cleaned, tokens: query.tokens });
    }
    return {
      kind: 'api_search',
      keyword: query.cleaned || keyword,
      total: results.length,
      rows,
      quickActions: rows.slice(0, 3).map((item) => ({ label: `查看 ${item.method} ${item.path}`, prompt: `查看接口 ${item.method} ${item.path} 的参数和最近调用示例` })),
    };
  }

  searchRoutes(keyword: string, limit = 30) {
    return this.searchCapabilities('route_search', 'route', keyword, limit, ['app', '路由', 'route', '页面跳转', 'deeplink', 'deep link', '搜索', '查询', '查找', '有哪些', '入口']);
  }

  searchCrossPlatform(keyword: string, limit = 30) {
    return this.searchCapabilities('cross_platform_search', 'cross_platform', keyword, limit, ['app', '跨端能力', '跨端', '能力', 'js sdk', 'jssdk', 'jsbridge', 'bridge', 'webview', 'hybrid', 'h5', 'universal link', 'scheme', '路由', 'route', '页面跳转', 'deeplink', 'deep link', '搜索', '查询', '查找', '有哪些', '兼容', '入口']);
  }

  private searchCapabilities(kind: 'route_search' | 'cross_platform_search', domain: CapabilityDoc['domain'], keyword: string, limit: number, stopWords: string[]) {
    const query = businessSemanticService.query(keyword, stopWords);
    const normalizedKeyword = businessSemanticService.normalize(keyword);
    const matchedDocs = capabilityDocs()
      .filter((item) => item.domain === domain)
      .filter((item) => (
        query.tokens.length === 0
        || businessSemanticService.matches(`${item.capability} ${item.category || ''} ${item.methodName || ''} ${item.codeSnippet || ''} ${item.aliases.join(' ')} ${item.scenario} ${item.description} ${item.inputs.join(' ')} ${item.outputs.join(' ')}`, query)
        || item.aliases.some((alias) => normalizedKeyword.includes(businessSemanticService.normalize(alias)))
      ))
      .sort((left, right) => capabilityScore(right, query) - capabilityScore(left, query))
    const exactConcreteDocs = matchedDocs.filter((item) => (
      item.methodName
      && item.codeSnippet
      && (
        normalizedKeyword.includes(businessSemanticService.normalize(item.methodName))
        || item.aliases.some((alias) => normalizedKeyword.includes(businessSemanticService.normalize(alias)))
      )
    ));
    const rows = (exactConcreteDocs.length > 0 ? exactConcreteDocs : matchedDocs)
      .slice(0, Math.min(Math.max(limit, 1), 100))
      .map(({ domain: _domain, aliases, ...item }) => ({
        ...item,
        matchedTerms: aliases.filter((alias) => normalizedKeyword.includes(businessSemanticService.normalize(alias))),
      }));
    if (rows.length === 0) {
      businessSemanticService.recordSearchMiss({ toolName: kind, rawQuery: keyword, cleanedQuery: query.cleaned, tokens: query.tokens });
    }
    const title = kind === 'route_search' ? '路由能力说明' : '跨端能力说明';
    return {
      kind,
      displayType: 'capability_docs',
      keyword: query.cleaned || keyword,
      total: rows.length,
      rows,
      quickActions: kind === 'cross_platform_search' && /登录|登陆|login|token|auth/i.test(keyword)
        ? [{ label: '查询登录 API 定义', prompt: '搜索登录相关 API 定义和使用' }]
        : [],
      note: `${title}直接来自平台功能说明，只展示能力边界、入参、输出和使用场景；不打开外部页面，也不检索 iOS 工程源码。`,
    };
  }
}

export const apiRouteSearchService = new ApiRouteSearchService();
