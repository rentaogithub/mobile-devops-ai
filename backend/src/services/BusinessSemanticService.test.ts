import fs from 'fs';
import os from 'os';
import path from 'path';
import { assistantCapabilityDatasetService } from './AssistantCapabilityDatasetService';
import { businessSemanticService } from './BusinessSemanticService';

describe('BusinessSemanticService', () => {
  it('routes delivery evidence questions to the read-only build diagnosis', () => {
    expect(businessSemanticService.resolveAssistantAction('诊断构建 #12345 的交付链路，还缺哪些证据', ['workflow_delivery_readiness', 'platform_cross_system_diagnosis'])).toMatchObject({ toolName: 'workflow_delivery_readiness', args: { buildNumber: '12345' } });
    expect(businessSemanticService.resolveAssistantAction('构建 #12345 的交付诊断', [])).toBeUndefined();
  });
  const semanticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-semantic-test-'));
  const capabilityDatasetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-semantic-capability-test-'));

  beforeAll(() => {
    process.env.ASSISTANT_SEMANTIC_DIR = semanticDir;
    process.env.ASSISTANT_CAPABILITY_DATASET_DIR = capabilityDatasetDir;
    assistantCapabilityDatasetService.syncCapabilities({
      source: 'semantic-test-routes',
      replace: true,
      items: [{
        domain: 'route',
        capability: '社区大厅（闲聊）',
        category: '社区（community）',
        description: '打开指定社区大厅。',
        route: 'nn://{host}/community/hall/{serverId}',
        aliases: ['社区大厅', '闲聊', 'community hall'],
        parameters: ['host', 'serverId'],
        outputs: ['打开指定社区大厅'],
      }],
    });
  });

  afterAll(() => {
    delete process.env.ASSISTANT_SEMANTIC_DIR;
    delete process.env.ASSISTANT_CAPABILITY_DATASET_DIR;
    fs.rmSync(semanticDir, { recursive: true, force: true });
    fs.rmSync(capabilityDatasetDir, { recursive: true, force: true });
  });

  it('cleans spoken filler words and expands business synonyms', () => {
    const query = businessSemanticService.query('查询下进房的接口', ['接口']);
    expect(query.cleaned).toBe('进房');
    expect(query.tokens).toEqual(expect.arrayContaining([
      '进房',
      '进入房间',
      '加入房间',
      'joinroom',
      'enterroom',
      'room',
    ]));
  });

  it('classifies API, route and cross-platform knowledge intents', () => {
    expect(businessSemanticService.classifyKnowledgeIntent('查询下进房的接口')).toBe('api');
    expect(businessSemanticService.classifyKnowledgeIntent('查找登录页面跳转路由')).toBe('route');
    expect(businessSemanticService.classifyKnowledgeIntent('社区大厅（闲聊）')).toBe('route');
    expect(businessSemanticService.classifyKnowledgeIntent('带玩主页')).toBe('route');
    expect(businessSemanticService.classifyKnowledgeIntent('打开明明鼠聊天的路由')).toBe('route');
    expect(businessSemanticService.classifyKnowledgeIntent('getCommunityChannelInfo是什么')).toBe('cross_platform');
    expect(businessSemanticService.classifyKnowledgeIntent('查询登录相关跨端能力和 JSBridge 兼容入口')).toBe('cross_platform');
  });

  it('resolves representative assistant actions across service domains', () => {
    const tools = [
      'platform_cross_system_diagnosis',
      'logs_search',
      'sentry_find_user_issues',
      'sentry_list_issues',
      'sentry_get_issue_context',
      'crash_list_history',
      'crash_get_history',
      'crash_compare_versions',
      'dsym_diagnose_missing',
      'cicd_list_builds',
      'cicd_get_build_log',
      'cicd_analyze_build_failure',
      'cicd_verify_build',
      'cicd_trigger_build',
      'cicd_retry_build',
      'cicd_trigger_release',
      'cicd_stop_build',
      'quality_list_tasks',
      'quality_daily_report',
      'quality_create_task',
      'quality_retry_task',
      'quality_stop_task',
      'workflow_overview',
      'workflow_list_issues',
      'workflow_get_issue',
      'workflow_list_tasks',
      'workflow_verify_task',
      'workflow_release_gate_preview',
      'workflow_verify_release_health',
      'task_track',
      'workflow_create_regression_candidate',
      'workflow_generate_xcuitest',
      'workflow_change_impact',
      'api_search',
      'routes_search',
      'cross_platform_search',
      'pods_analyze_impact',
    ];
    expect(businessSemanticService.resolveAssistantAction('停止构建 #12345', tools)).toMatchObject({ toolName: 'cicd_stop_build', args: { buildNumber: 12345 } });
    expect(businessSemanticService.resolveAssistantAction('重试构建 #12345', tools)).toMatchObject({ toolName: 'cicd_retry_build', args: { buildNumber: 12345 } });
    expect(businessSemanticService.resolveAssistantAction('发布 release/1.2.3 到 TestFlight，门禁构建 456', tools)).toMatchObject({ toolName: 'cicd_trigger_release', args: { branch: 'release/1.2.3', deployTarget: 'TestFlight', gateBuildNumber: 456 } });
    expect(businessSemanticService.resolveAssistantAction('停止质检任务 #456', tools)).toMatchObject({ toolName: 'quality_stop_task', args: { buildNumber: 456 } });
    expect(businessSemanticService.resolveAssistantAction('查看质量中心概览', tools)).toMatchObject({ toolName: 'workflow_overview' });
    expect(businessSemanticService.resolveAssistantAction('查询高风险未关闭 Issue', tools)).toMatchObject({ toolName: 'workflow_list_issues', args: { limit: 20, severity: 'high', status: 'open' } });
    expect(businessSemanticService.resolveAssistantAction('验证 workflow task_100 是否通过', tools)).toMatchObject({ toolName: 'workflow_verify_task', args: { taskId: 'task_100' } });
    expect(businessSemanticService.resolveAssistantAction('预览构建 #789 的发布质量门禁', tools)).toMatchObject({ toolName: 'workflow_release_gate_preview', args: { buildNumber: '789' } });
    expect(businessSemanticService.resolveAssistantAction('验证版本 5.15.0 发布后健康度', tools)).toMatchObject({ toolName: 'workflow_verify_release_health', args: { releaseVersion: '5.15.0' } });
    expect(businessSemanticService.resolveAssistantAction('把 Issue ISSUE-1 转成回归候选', tools)).toMatchObject({ toolName: 'workflow_create_regression_candidate', args: { issueId: 'ISSUE-1' } });
    expect(businessSemanticService.resolveAssistantAction('给 candidate reg_1 生成 XCUITest', tools)).toMatchObject({ toolName: 'workflow_generate_xcuitest', args: { candidateId: 'reg_1' } });
    expect(businessSemanticService.resolveAssistantAction('查询 5.15.0 的 Crash 历史记录', tools)).toMatchObject({ toolName: 'crash_list_history', args: { version: '5.15.0', limit: 20 } });
    expect(businessSemanticService.resolveAssistantAction('读取历史 12 的 Crash 日志', tools)).toMatchObject({ toolName: 'crash_get_history', args: { historyId: 12 } });
    expect(businessSemanticService.resolveAssistantAction('分析 NNRtc 组件升级影响范围', tools)).toMatchObject({ toolName: 'pods_analyze_impact', args: { name: 'NNRtc' } });
  });

  it('scores direct business matches above loose room matches', () => {
    const query = businessSemanticService.query('进房', ['接口']);
    const direct = businessSemanticService.scoreFields(query, [
      { value: '/u-mobile/channel/query/enterRoomAfter/info', weight: 5 },
      { value: '查询当前用户进房之后的信息', weight: 3 },
    ]);
    const loose = businessSemanticService.scoreFields(query, [
      { value: '/activity/nnActInfo/room/report', weight: 5 },
      { value: '语音房停留三分钟上报', weight: 3 },
    ]);
    expect(direct).toBeGreaterThan(loose);
  });

  it('records semantic resolution and search miss stats without affecting routing', () => {
    businessSemanticService.recordAssistantResolution({
      rawInput: '查询下进房的接口',
      mode: 'deterministic',
      toolName: 'api_search',
      availableToolCount: 10,
      productLineId: 'semantic-test',
    });
    businessSemanticService.recordSearchMiss({
      toolName: 'api_search',
      rawQuery: '未知业务词',
      cleanedQuery: '未知业务词',
      tokens: ['未知业务词'],
      productLineId: 'semantic-test',
    });
    const stats = businessSemanticService.semanticStats(5);
    expect(stats.totals.deterministic).toBeGreaterThanOrEqual(1);
    expect(stats.totals.searchMisses).toBeGreaterThanOrEqual(1);
    expect(stats.topTools).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: 'api_search' })]));
    expect(stats.recentSearchMisses[0]).toHaveProperty('rawQuery');
  });
});
