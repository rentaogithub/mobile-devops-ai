import fs from 'fs';
import os from 'os';
import path from 'path';
import { assistantCapabilityDatasetService } from './AssistantCapabilityDatasetService';
import { ApiRouteSearchService } from './ApiRouteSearchService';

describe('ApiRouteSearchService', () => {
  let repoDir = '';
  let datasetDir = '';
  let previousRepoPath: string | undefined;
  let previousDatasetDir: string | undefined;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-route-search-'));
    datasetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-capability-dataset-'));
    previousRepoPath = process.env.NNIOS_REPO_PATH;
    previousDatasetDir = process.env.ASSISTANT_CAPABILITY_DATASET_DIR;
    process.env.NNIOS_REPO_PATH = repoDir;
    process.env.ASSISTANT_CAPABILITY_DATASET_DIR = datasetDir;
  });

  afterEach(() => {
    if (previousRepoPath === undefined) {
      delete process.env.NNIOS_REPO_PATH;
    } else {
      process.env.NNIOS_REPO_PATH = previousRepoPath;
    }
    if (previousDatasetDir === undefined) {
      delete process.env.ASSISTANT_CAPABILITY_DATASET_DIR;
    } else {
      process.env.ASSISTANT_CAPABILITY_DATASET_DIR = previousDatasetDir;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(datasetDir, { recursive: true, force: true });
  });

  it('does not search iOS project source code for cross-platform results', () => {
    fs.mkdirSync(path.join(repoDir, 'Development Pods', 'NNLibrary', 'Classes', 'TXLogin'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'Development Pods', 'NNLibrary', 'Classes', 'TXLogin', 'TXCaptchaWebView.m'),
      'NSString *loginBridge = @"jsbridge://login/captcha";\n',
      'utf8',
    );
    fs.mkdirSync(path.join(repoDir, 'NNApp', 'Login'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'NNApp', 'Login', 'LoginRoute.m'),
      'NSString *loginRoute = @"nn://login"; // JSBridge login route\n',
      'utf8',
    );

    const readdirSpy = jest.spyOn(fs, 'readdirSync');
    const result = new ApiRouteSearchService().searchCrossPlatform('登录 JSBridge', 10);

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result).toMatchObject({
      kind: 'cross_platform_search',
      displayType: 'capability_docs',
    });
    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capability: expect.any(String),
        scenario: expect.any(String),
        description: expect.any(String),
        usage: expect.any(String),
        inputs: expect.any(Array),
        outputs: expect.any(Array),
      }),
    ]));
    expect(result.rows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ file: expect.any(String) }),
      expect.objectContaining({ detailUrl: expect.any(String) }),
    ]));
    expect(readdirSpy.mock.calls.some(([target]) => String(target).startsWith(repoDir))).toBe(false);
    readdirSpy.mockRestore();
  });

  it('returns route capability descriptions instead of frontend page links', () => {
    const result = new ApiRouteSearchService().searchRoutes('查询登录页面跳转路由', 10);

    expect(result).toMatchObject({
      kind: 'route_search',
      displayType: 'capability_docs',
    });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ detailUrl: expect.any(String) }),
      expect.objectContaining({ url: expect.any(String) }),
    ]));
  });

  it('returns concrete route definition cards from the platform route catalog', () => {
    const result = new ApiRouteSearchService().searchRoutes('查询 带玩主页 的路由', 10);

    expect(result.rows[0]).toMatchObject({
      capability: '带玩主页',
      category: '游戏服务',
      description: '打开带玩用户主页。',
      codeSnippet: 'nn://{host}/game/profile/{userId}',
      inputs: ['host', 'userId'],
    });
  });

  it('returns concrete chat route cards from the route catalog', () => {
    const result = new ApiRouteSearchService().searchRoutes('打开明明鼠聊天的路由', 10);

    expect(result.rows[0]).toMatchObject({
      capability: '打开明明鼠聊天',
      category: '消息',
      description: '打开明明鼠聊天。',
      codeSnippet: 'nn://{host}/chat/c2c/inbox-msg',
      inputs: ['host'],
    });
  });

  it('searches capabilities synced into the assistant dataset', () => {
    const syncResult = assistantCapabilityDatasetService.syncCapabilities({
      source: 'route-tool',
      replace: true,
      items: [{
        domain: 'route',
        capability: '战队主页',
        category: '游戏服务',
        description: '打开指定战队主页。',
        route: 'nn://{host}/game/team/{teamId}',
        aliases: ['战队主页', 'team profile'],
        parameters: ['host', 'teamId'],
        outputs: ['打开战队主页'],
      }],
    });
    const result = new ApiRouteSearchService().searchRoutes('查询战队主页路由', 10);

    expect(syncResult).toMatchObject({ source: 'route-tool', synced: 1, total: 1 });
    expect(result.rows[0]).toMatchObject({
      capability: '战队主页',
      category: '游戏服务',
      codeSnippet: 'nn://{host}/game/team/{teamId}',
      source: 'route-tool',
    });
  });

  it('returns concrete JSBridge definition cards for token queries', () => {
    const result = new ApiRouteSearchService().searchCrossPlatform('查询获取token的jsbridge', 10);

    expect(result.rows[0]).toMatchObject({
      capability: '获取 Token',
      methodName: 'getToken',
      description: '获取 NN 当前登录用户的 token。',
      codeSnippet: 'NNJSBridge.getToken()',
    });
  });

  it('returns navigateTo for H5 navigation JSBridge queries', () => {
    const result = new ApiRouteSearchService().searchCrossPlatform('跳转到其它 H5 页面的能力', 10);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      capability: '跳转到其它 H5 页面',
      methodName: 'navigateTo',
      description: '跳转到其它 H5 页面。',
      codeSnippet: 'NNJSBridge.navigateTo("https://www.nn.com/")',
    });
  });

  it('returns concrete JSBridge definition cards for bare method-name questions', () => {
    const result = new ApiRouteSearchService().searchCrossPlatform('getCommunityChannelInfo是什么', 10);

    expect(result.rows[0]).toMatchObject({
      capability: '获取社区频道信息',
      methodName: 'getCommunityChannelInfo',
      description: '获取当前社区频道信息。',
      codeSnippet: 'NNJSBridge.getCommunityChannelInfo()',
      outputs: ['社区信息', '频道信息'],
    });
  });
});
