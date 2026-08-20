import fs from 'fs';
import os from 'os';
import path from 'path';

describe('CrashGovernanceService', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-crash-governance-test-'));
  let closeDatabase: () => void;
  let initializeDatabase: () => void;
  let getDatabase: () => any;
  let service: import('./CrashGovernanceService').CrashGovernanceService;
  let gateService: import('./QualityGateService').QualityGateService;

  beforeAll(() => {
    process.env.DB_PATH = path.join(tempDir, 'crash-governance.sqlite');
    ({ closeDatabase, initializeDatabase, getDatabase } = require('../database'));
    ({ crashGovernanceService: service } = require('./CrashGovernanceService'));
    const { QualityGateService } = require('./QualityGateService');
    initializeDatabase();
    gateService = new QualityGateService();
  });

  afterAll(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.DB_PATH;
  });

  it('keeps online Sentry statistics separate from quality and manual evidence', () => {
    service.upsertSentryIssue({
      id: 'sentry-1',
      shortId: 'NN-IOS-1',
      title: '线上崩溃',
      level: 'error',
      count: '8',
      userCount: 2,
      maxAppVersion: '10.1.0',
      lastSeen: '2026-08-18T01:00:00.000Z',
    });
    service.upsertQualityCrash({
      sourceRef: 'qa-1:crash-1',
      title: '质检崩溃',
      appVersion: '10.1.0',
      qualityTaskId: 'qa-1',
      level: 'error',
    });
    service.upsertManualCrash({
      historyId: 99,
      title: '手动解析崩溃',
      appVersion: '10.1.0',
      crashType: 'EXC_BAD_ACCESS',
    });

    const dashboard = service.dashboard();

    expect(dashboard.summary.totalOpen).toBe(1);
    expect(dashboard.topIssues).toHaveLength(1);
    expect(dashboard.topIssues[0].source).toBe('sentry');
    expect(dashboard.qualityEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'quality', qualityTaskId: 'qa-1' }),
    ]));
    expect(dashboard.manualEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'manual', historyId: 99 }),
    ]));
  });

  it('groups top online crashes by stable fingerprint instead of Sentry issue id', () => {
    const analysis = {
      summary: '聊天发送时访问已释放对象',
      crashType: 'EXC_BAD_ACCESS',
      possibleCauses: ['对象生命周期异常'],
      suggestions: ['检查发送消息回调中的对象持有关系'],
      severity: 'critical' as const,
      affectedComponents: ['IM'],
      crashModule: 'NNIM',
      crashLocation: 'NNChatViewController.sendMessage:1024',
    };

    const first = service.upsertSentryIssue({
      id: 'sentry-fingerprint-a',
      shortId: 'NN-IOS-FP-A',
      title: '聊天发送崩溃 A',
      culprit: 'NNChatViewController.sendMessage',
      level: 'fatal',
      count: '31',
      userCount: 3,
      maxAppVersion: '10.20.0',
      lastSeen: '2026-08-18T02:00:00.000Z',
    }, {
      analysis,
    });
    const second = service.upsertSentryIssue({
      id: 'sentry-fingerprint-b',
      shortId: 'NN-IOS-FP-B',
      title: '聊天发送崩溃 B',
      culprit: 'NNChatViewController.sendMessage',
      level: 'fatal',
      count: '29',
      userCount: 4,
      maxAppVersion: '10.21.0',
      lastSeen: '2026-08-18T02:05:00.000Z',
    }, {
      analysis: {
        ...analysis,
        crashLocation: 'NNChatViewController.sendMessage:2048',
      },
    });

    const dashboard = service.dashboard();
    const grouped = dashboard.topIssues.find((record) => record.groupedIssueIds?.includes('sentry-fingerprint-a'));

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(grouped).toEqual(expect.objectContaining({
      groupedIssueCount: 2,
      eventCount: 60,
      userCount: 7,
    }));
    expect(grouped?.groupedIssueIds).toEqual(expect.arrayContaining([
      'sentry-fingerprint-a',
      'sentry-fingerprint-b',
    ]));
  });

  it('summarizes crash insights by type, module and reason', () => {
    service.upsertSentryIssue({
      id: 'sentry-insight-identified',
      shortId: 'NN-IOS-INSIGHT-ID',
      title: 'IM 发送崩溃',
      culprit: 'NNChatViewController.sendMessage',
      level: 'fatal',
      count: '13',
      userCount: 5,
      maxAppVersion: '99.40.0',
    }, {
      analysis: {
        summary: 'IM 发送消息访问已释放对象',
        crashType: 'EXC_BAD_ACCESS',
        possibleCauses: ['对象生命周期异常'],
        suggestions: ['检查发送消息回调'],
        severity: 'critical',
        affectedComponents: ['IM'],
        crashModule: 'NNIM',
        crashLocation: 'NNChatViewController.sendMessage:88',
      },
    });
    service.upsertSentryIssue({
      id: 'sentry-insight-unidentified',
      shortId: 'NN-IOS-INSIGHT-UNKNOWN',
      title: '未识别崩溃',
      level: 'error',
      count: '3',
      userCount: 1,
      maxAppVersion: '99.40.1',
    });

    const dashboard = service.dashboard();

    expect(dashboard.crashInsightSummary.identifiedCount).toBeGreaterThanOrEqual(1);
    expect(dashboard.crashInsightSummary.unidentifiedCount).toBeGreaterThanOrEqual(1);
    expect(dashboard.crashInsightSummary.topTypes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'EXC_BAD_ACCESS' }),
    ]));
    expect(dashboard.crashInsightSummary.topModules).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'NNIM' }),
    ]));
    expect(dashboard.crashInsightSummary.topReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'IM 发送崩溃' }),
    ]));
    expect(dashboard.actionRecommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'identification',
        title: '提升崩溃识别完整度',
      }),
    ]));
  });

  it('returns same-fingerprint issue group for governance detail', () => {
    const analysis = {
      summary: '社区列表刷新崩溃',
      crashType: 'EXC_CRASH',
      possibleCauses: ['列表刷新状态异常'],
      suggestions: ['检查社区列表刷新回调'],
      severity: 'high' as const,
      affectedComponents: ['Community'],
      crashModule: 'NNIM',
      crashLocation: 'NNCommunityViewController.reloadData:88',
    };
    const first = service.upsertSentryIssue({
      id: 'sentry-fingerprint-detail-a',
      shortId: 'NN-IOS-FP-DETAIL-A',
      title: '社区刷新崩溃 A',
      culprit: 'NNCommunityViewController.reloadData',
      level: 'error',
      count: '6',
      userCount: 2,
      maxAppVersion: '10.25.0',
      lastSeen: '2026-08-18T04:00:00.000Z',
    }, {
      analysis,
    });
    service.upsertSentryIssue({
      id: 'sentry-fingerprint-detail-b',
      shortId: 'NN-IOS-FP-DETAIL-B',
      title: '社区刷新崩溃 B',
      culprit: 'NNCommunityViewController.reloadData',
      level: 'error',
      count: '9',
      userCount: 4,
      maxAppVersion: '10.26.0',
      lastSeen: '2026-08-18T04:10:00.000Z',
    }, {
      analysis: {
        ...analysis,
        crashLocation: 'NNCommunityViewController.reloadData:128',
      },
    });

    const group = service.getFingerprintGroupByRecordId(first.id);

    expect(group).toEqual(expect.objectContaining({
      fingerprint: first.fingerprint,
      issueCount: 2,
      eventCount: 15,
      userCount: 6,
      lastSeen: '2026-08-18T04:10:00.000Z',
    }));
    expect(group?.versions).toEqual(['10.26.0', '10.25.0']);
    expect(group?.records.map((record) => record.sourceIssueId)).toEqual(expect.arrayContaining([
      'sentry-fingerprint-detail-a',
      'sentry-fingerprint-detail-b',
    ]));
  });

  it('updates governance status for all same-fingerprint online issues', () => {
    const analysis = {
      summary: '同类批量治理崩溃',
      crashType: 'EXC_BAD_ACCESS',
      possibleCauses: ['共享状态异常'],
      suggestions: ['检查同类入口'],
      severity: 'high' as const,
      affectedComponents: ['IM'],
      crashModule: 'NNIM',
      crashLocation: 'NNSharedController.open:66',
    };
    const first = service.upsertSentryIssue({
      id: 'sentry-fingerprint-bulk-a',
      shortId: 'NN-IOS-FP-BULK-A',
      title: '同类批量治理 A',
      culprit: 'NNSharedController.open',
      level: 'error',
      count: '4',
      userCount: 1,
      maxAppVersion: '10.27.0',
    }, {
      analysis,
    });
    service.upsertSentryIssue({
      id: 'sentry-fingerprint-bulk-b',
      shortId: 'NN-IOS-FP-BULK-B',
      title: '同类批量治理 B',
      culprit: 'NNSharedController.open',
      level: 'error',
      count: '5',
      userCount: 2,
      maxAppVersion: '10.27.1',
    }, {
      analysis: {
        ...analysis,
        crashLocation: 'NNSharedController.open:88',
      },
    });

    const group = service.updateFingerprintGroupStatus(first.id, {
      governanceStatus: 'pending_fix',
      owner: 'IM负责人',
      operator: '测试管理员',
    });

    expect(group.issueCount).toBe(2);
    expect(group.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceIssueId: 'sentry-fingerprint-bulk-a', governanceStatus: 'pending_fix', owner: 'IM负责人' }),
      expect.objectContaining({ sourceIssueId: 'sentry-fingerprint-bulk-b', governanceStatus: 'pending_fix', owner: 'IM负责人' }),
    ]));
    expect(service.listGovernanceEvents(first.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: 'fingerprint',
        fromStatus: 'new',
        toStatus: 'pending_fix',
        operator: '测试管理员',
        relatedRecordIds: expect.arrayContaining(group.records.map((record) => record.id)),
      }),
    ]));
  });

  it('records governance status update events for a single issue', () => {
    const record = service.upsertSentryIssue({
      id: 'sentry-governance-event-single',
      shortId: 'NN-IOS-EVENT-SINGLE',
      title: '单条治理留痕',
      level: 'error',
      count: '1',
      userCount: 1,
      maxAppVersion: '10.28.0',
    });

    service.updateGovernanceStatus(record.id, {
      governanceStatus: 'ignored',
      ignoreReason: '重复问题',
      operator: '测试管理员',
    });

    expect(service.listGovernanceEvents(record.id)).toEqual([
      expect.objectContaining({
        recordId: record.id,
        scope: 'single',
        fromStatus: 'new',
        toStatus: 'ignored',
        operator: '测试管理员',
        note: '重复问题',
        relatedRecordIds: [record.id],
      }),
    ]);
  });

  it('lists recent governance events with filters and record summaries', () => {
    const record = service.upsertSentryIssue({
      id: 'sentry-governance-event-list',
      shortId: 'NN-IOS-EVENT-LIST',
      title: '治理记录列表',
      level: 'error',
      count: '2',
      userCount: 1,
      maxAppVersion: '10.29.0',
    });
    service.updateGovernanceStatus(record.id, {
      governanceStatus: 'fixed',
      fixedVersion: '10.29.1',
      operator: '审计管理员',
    });

    const events = service.listRecentGovernanceEvents({
      scope: 'single',
      toStatus: 'fixed',
      operator: '审计',
      keyword: 'EVENT-LIST',
    });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recordId: record.id,
        scope: 'single',
        toStatus: 'fixed',
        operator: '审计管理员',
        record: expect.objectContaining({
          sourceIssueId: 'sentry-governance-event-list',
          shortId: 'NN-IOS-EVENT-LIST',
          appVersion: '10.29.0',
        }),
      }),
    ]));
  });

  it('summarizes recent governance activity in dashboard', () => {
    const record = service.upsertSentryIssue({
      id: 'sentry-governance-activity',
      shortId: 'NN-IOS-ACTIVITY',
      title: '治理动态统计',
      level: 'error',
      count: '3',
      userCount: 1,
      maxAppVersion: '99.29.0',
    });

    service.updateGovernanceStatus(record.id, {
      governanceStatus: 'pending_fix',
      owner: 'Crash负责人',
      operator: '治理管理员',
    });

    const dashboard = service.dashboard();

    expect(dashboard.governanceActivity.recent7dCount).toBeGreaterThanOrEqual(1);
    expect(dashboard.governanceActivity.singleCount).toBeGreaterThanOrEqual(1);
    expect(dashboard.governanceActivity.lastEvent).toEqual(expect.objectContaining({
      recordId: record.id,
      scope: 'single',
      fromStatus: 'new',
      toStatus: 'pending_fix',
      operator: '治理管理员',
    }));
    expect(dashboard.governanceActivity.topOperators).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operator: '治理管理员',
        count: expect.any(Number),
      }),
    ]));
  });

  it('summarizes governance status distribution for online crashes', () => {
    const first = service.upsertSentryIssue({
      id: 'sentry-governance-distribution-new',
      shortId: 'NN-IOS-DIST-NEW',
      title: '治理状态分布新问题',
      level: 'error',
      count: '7',
      userCount: 3,
      maxAppVersion: '99.31.0',
    });
    const second = service.upsertSentryIssue({
      id: 'sentry-governance-distribution-fixed',
      shortId: 'NN-IOS-DIST-FIXED',
      title: '治理状态分布已修复',
      level: 'error',
      count: '5',
      userCount: 2,
      maxAppVersion: '99.31.1',
    });
    service.updateGovernanceStatus(second.id, {
      governanceStatus: 'fixed',
      fixedVersion: '99.31.2',
      operator: '治理管理员',
    });
    service.upsertQualityCrash({
      sourceRef: 'qa-distribution:crash',
      title: '质检记录不进入线上治理分布',
      appVersion: '99.31.0',
      level: 'error',
    });

    const dashboard = service.dashboard();
    const newStatus = dashboard.governanceStatusDistribution.find((item) => item.status === 'new');
    const fixedStatus = dashboard.governanceStatusDistribution.find((item) => item.status === 'fixed');

    expect(newStatus).toEqual(expect.objectContaining({
      status: 'new',
      count: expect.any(Number),
      eventCount: expect.any(Number),
      userCount: expect.any(Number),
    }));
    expect(fixedStatus).toEqual(expect.objectContaining({
      status: 'fixed',
      count: expect.any(Number),
      eventCount: expect.any(Number),
      userCount: expect.any(Number),
    }));
    expect(newStatus!.eventCount).toBeGreaterThanOrEqual(first.eventCount);
    expect(fixedStatus!.eventCount).toBeGreaterThanOrEqual(second.eventCount);
  });

  it('summarizes and filters owner open crash todos', () => {
    const openRecord = service.upsertSentryIssue({
      id: 'sentry-owner-todo-open',
      shortId: 'NN-IOS-OWNER-OPEN',
      title: '负责人待办未解决',
      level: 'fatal',
      count: '11',
      userCount: 4,
      maxAppVersion: '99.32.0',
      firstSeen: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    service.updateGovernanceStatus(openRecord.id, {
      governanceStatus: 'pending_fix',
      owner: 'IM负责人-待办测试',
      operator: '治理管理员',
    });
    const fixedRecord = service.upsertSentryIssue({
      id: 'sentry-owner-todo-fixed',
      shortId: 'NN-IOS-OWNER-FIXED',
      title: '负责人待办已修复不计入',
      level: 'fatal',
      count: '99',
      userCount: 20,
      maxAppVersion: '99.32.1',
    });
    service.updateGovernanceStatus(fixedRecord.id, {
      governanceStatus: 'fixed',
      owner: 'IM负责人-待办测试',
      fixedVersion: '99.32.2',
      operator: '治理管理员',
    });
    service.upsertSentryIssue({
      id: 'sentry-owner-todo-unassigned',
      shortId: 'NN-IOS-OWNER-UNASSIGNED',
      title: '负责人待办未分配',
      level: 'error',
      count: '2',
      userCount: 1,
      maxAppVersion: '99.32.3',
      firstSeen: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const dashboard = service.dashboard();
    const ownerTodo = dashboard.ownerTodoDistribution.find((item) => item.owner === 'IM负责人-待办测试');
    const ownerOpenRecords = service.list({
      source: 'sentry',
      status: 'open',
      owner: 'IM负责人-待办测试',
      limit: 20,
    });

    expect(ownerTodo).toEqual(expect.objectContaining({
      owner: 'IM负责人-待办测试',
      count: expect.any(Number),
      highRiskCount: expect.any(Number),
      overdueCount: expect.any(Number),
      oldestOpenAgeDays: expect.any(Number),
      overdueThresholdDays: expect.any(Number),
      eventCount: expect.any(Number),
      userCount: expect.any(Number),
    }));
    expect(ownerTodo!.count).toBeGreaterThanOrEqual(1);
    expect(ownerTodo!.overdueCount).toBeGreaterThanOrEqual(1);
    expect(ownerTodo!.oldestOpenAgeDays).toBeGreaterThanOrEqual(4);
    expect(ownerTodo!.overdueThresholdDays).toBe(3);
    expect(ownerTodo!.eventCount).toBeGreaterThanOrEqual(openRecord.eventCount);
    expect(ownerOpenRecords.map((record) => record.sourceIssueId)).toContain('sentry-owner-todo-open');
    expect(ownerOpenRecords.map((record) => record.sourceIssueId)).not.toContain('sentry-owner-todo-fixed');
    expect(dashboard.actionRecommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'owner',
        title: '先分派未分配 Crash',
        targetFilters: {
          source: 'sentry',
          status: 'open',
          owner: '未分配',
        },
      }),
      expect.objectContaining({
        type: 'owner',
        title: '跟进逾期待办负责人',
        targetFilters: {
          source: 'sentry',
          status: 'open',
          owner: 'IM负责人-待办测试',
        },
      }),
    ]));
  });

  it('exports governance events as escaped csv with filters', () => {
    const record = service.upsertSentryIssue({
      id: 'sentry-governance-export',
      shortId: 'NN-IOS-EXPORT',
      title: '导出治理记录, 包含"特殊"字符',
      level: 'error',
      count: '1',
      userCount: 1,
      maxAppVersion: '99.30.0',
    });
    service.updateGovernanceStatus(record.id, {
      governanceStatus: 'ignored',
      ignoreReason: '重复问题\n已有单独 Issue',
      operator: '导出管理员',
    });

    const csv = service.exportGovernanceEventsCsv({
      toStatus: 'ignored',
      keyword: 'NN-IOS-EXPORT',
    });

    expect(csv).toContain('"时间","操作范围","原状态","目标状态","操作人","关联记录","Issue","App版本","Crash标题","备注"');
    expect(csv).toContain('"导出管理员"');
    expect(csv).toContain('"NN-IOS-EXPORT"');
    expect(csv).toContain('"99.30.0"');
    expect(csv).toContain('"导出治理记录, 包含""特殊""字符"');
    expect(csv).toContain('"重复问题 已有单独 Issue"');
    expect(csv).not.toContain('NN-IOS-ACTIVITY');
  });

  it('classifies symbolication failures into actionable categories', () => {
    service.upsertSentryIssue({
      id: 'sentry-symbolication-category',
      shortId: 'NN-IOS-SYM-CAT',
      title: '符号化失败分类',
      level: 'error',
      count: '1',
      userCount: 1,
      maxAppVersion: '10.22.0',
    });

    service.markSymbolication('sentry-symbolication-category', {
      status: 'failed',
      error: '未找到 UUID ABCD 对应的 dSYM',
    });

    expect(service.getBySourceIssueId('sentry-symbolication-category')).toEqual(expect.objectContaining({
      symbolicationStatus: 'failed',
      symbolicationFailureCategory: 'missing_dsym',
    }));
  });

  it('filters governance records by symbolication failure category', () => {
    service.upsertSentryIssue({
      id: 'sentry-symbolication-missing-dsym',
      shortId: 'NN-IOS-SYM-MISSING',
      title: '缺少符号文件',
      level: 'error',
      count: '1',
      userCount: 1,
      maxAppVersion: '10.23.0',
    });
    service.upsertSentryIssue({
      id: 'sentry-symbolication-uuid-mismatch',
      shortId: 'NN-IOS-SYM-UUID',
      title: 'UUID 不匹配',
      level: 'error',
      count: '1',
      userCount: 1,
      maxAppVersion: '10.23.0',
    });
    service.markSymbolication('sentry-symbolication-missing-dsym', {
      status: 'failed',
      error: '未找到 UUID ABCD 对应的 dSYM',
    });
    service.markSymbolication('sentry-symbolication-uuid-mismatch', {
      status: 'failed',
      error: 'UUID 不匹配',
    });

    const records = service.list({
      appVersion: '10.23.0',
      symbolicationFailureCategory: 'missing_dsym',
    });

    expect(records).toEqual([
      expect.objectContaining({
        sourceIssueId: 'sentry-symbolication-missing-dsym',
        symbolicationFailureCategory: 'missing_dsym',
      }),
    ]);
  });

  it('summarizes symbolication failure categories in dashboard', () => {
    service.upsertSentryIssue({
      id: 'sentry-symbolication-breakdown-a',
      shortId: 'NN-IOS-SYM-BREAK-A',
      title: '符号化失败分布 A',
      level: 'error',
      count: '5',
      userCount: 2,
      maxAppVersion: '10.24.0',
      lastSeen: '2026-08-18T03:00:00.000Z',
    });
    service.upsertSentryIssue({
      id: 'sentry-symbolication-breakdown-b',
      shortId: 'NN-IOS-SYM-BREAK-B',
      title: '符号化失败分布 B',
      level: 'error',
      count: '7',
      userCount: 3,
      maxAppVersion: '10.24.0',
      lastSeen: '2026-08-18T03:05:00.000Z',
    });
    service.markSymbolication('sentry-symbolication-breakdown-a', {
      status: 'failed',
      error: 'xcrun atos command failed',
    });
    service.markSymbolication('sentry-symbolication-breakdown-b', {
      status: 'failed',
      error: 'dwarfdump 执行失败',
    });

    const dashboard = service.dashboard();
    const toolFailed = dashboard.symbolicationFailureBreakdown.find((item) => item.category === 'tool_failed');

    expect(toolFailed).toEqual(expect.objectContaining({
      category: 'tool_failed',
      count: expect.any(Number),
      eventCount: expect.any(Number),
      userCount: expect.any(Number),
      latestSeen: '2026-08-18T03:05:00.000Z',
    }));
    expect(toolFailed!.count).toBeGreaterThanOrEqual(2);
    expect(toolFailed!.eventCount).toBeGreaterThanOrEqual(12);
    expect(toolFailed!.userCount).toBeGreaterThanOrEqual(5);
    expect(dashboard.actionRecommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'symbolication',
        priority: 'medium',
        relatedCategory: 'tool_failed',
      }),
    ]));
  });

  it('clears symbolication failure category after a later successful symbolication', () => {
    service.upsertSentryIssue({
      id: 'sentry-symbolication-clear',
      shortId: 'NN-IOS-SYM-CLEAR',
      title: '符号化失败后重试成功',
      level: 'error',
      count: '1',
      userCount: 1,
      maxAppVersion: '10.22.1',
    });

    service.markSymbolication('sentry-symbolication-clear', {
      status: 'failed',
      error: 'UUID 不匹配',
    });
    service.markSymbolication('sentry-symbolication-clear', {
      status: 'success',
      historyId: 20260818,
    });

    expect(service.getBySourceIssueId('sentry-symbolication-clear')).toEqual(expect.objectContaining({
      symbolicationStatus: 'success',
      symbolicationFailureCategory: undefined,
      symbolicationError: undefined,
    }));
  });

  it('marks a fixed Sentry crash as regression when it appears in another version', () => {
    const record = service.upsertSentryIssue({
      id: 'sentry-regression',
      shortId: 'NN-IOS-REG',
      title: '已修复后复现',
      level: 'fatal',
      count: '1',
      userCount: 1,
      maxAppVersion: '10.1.0',
    });

    service.updateGovernanceStatus(record.id, {
      governanceStatus: 'fixed',
      fixedVersion: '10.1.0',
      fixedRemark: '已在 10.1.0 修复',
    });

    const nextRecord = service.upsertSentryIssue({
      id: 'sentry-regression',
      shortId: 'NN-IOS-REG',
      title: '已修复后复现',
      level: 'fatal',
      count: '3',
      userCount: 2,
      maxAppVersion: '10.2.0',
    });

    expect(nextRecord.governanceStatus).toBe('regression');
    expect(service.dashboard().regressions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceIssueId: 'sentry-regression' }),
    ]));
  });

  it('adds Crash governance risks to release gates as warnings by default and blockers when requested', () => {
    service.upsertSentryIssue({
      id: 'sentry-gate',
      shortId: 'NN-IOS-GATE',
      title: '发布版本高风险崩溃',
      level: 'error',
      count: '30',
      userCount: 8,
      maxAppVersion: '10.3.0',
    });

    const warningGate = gateService.preview({
      buildNumber: '2001',
      buildStatus: 'success',
      appVersion: '10.3.0',
      policy: { requiredSuites: [], checkCrashGovernance: true },
    });
    const blockingGate = gateService.preview({
      buildNumber: '2001',
      buildStatus: 'success',
      appVersion: '10.3.0',
      policy: { requiredSuites: [], checkCrashGovernance: true, blockCrashGovernanceRisk: true },
    });

    expect(warningGate!.status).toBe('warning');
    expect((warningGate!.result as any).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'open_high_crash', issueId: 'sentry-gate' }),
    ]));
    expect(blockingGate!.status).toBe('blocked');
    expect((blockingGate!.result as any).blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'open_high_crash', issueId: 'sentry-gate' }),
    ]));
  });

  it('adds online Crash governance to release health verification', () => {
    service.upsertSentryIssue({
      id: 'sentry-release-health-critical',
      shortId: 'NN-IOS-HEALTH-CRITICAL',
      title: '发布后线上高风险崩溃',
      level: 'fatal',
      count: '12',
      userCount: 6,
      maxAppVersion: '10.4.0',
    });

    const health = gateService.evaluateReleaseHealth('nn-ios', '10.4.0');

    expect(health.status).toBe('critical');
    expect(health.crashHealth.highRiskCount).toBe(1);
    expect(health.crashHealth.highRisks).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceIssueId: 'sentry-release-health-critical' }),
    ]));
    expect(health.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('暂停继续放量'),
    ]));
  });

  it('treats dSYM missing and symbolication failures as release health warnings', () => {
    service.upsertSentryIssue({
      id: 'sentry-release-health-dsym',
      shortId: 'NN-IOS-HEALTH-DSYM',
      title: '符号文件缺失崩溃',
      level: 'info',
      count: '1',
      userCount: 1,
      maxAppVersion: '10.5.0',
    });
    getDatabase().prepare(`
      UPDATE crash_governance_records
      SET dsym_coverage_status = 'missing',
          symbolication_status = 'failed',
          symbolication_error = 'UUID 不匹配'
      WHERE source = 'sentry' AND source_issue_id = 'sentry-release-health-dsym'
    `).run();

    const health = gateService.evaluateReleaseHealth('nn-ios', '10.5.0');

    expect(health.status).toBe('warning');
    expect(health.crashHealth.dsymMissingCount).toBe(1);
    expect(health.crashHealth.symbolicationFailedCount).toBe(1);
  });

  it('keeps quality and manual Crash records as supporting release health evidence only', () => {
    service.upsertQualityCrash({
      sourceRef: 'qa-health:crash-1',
      title: '质检侧崩溃证据',
      appVersion: '10.6.0',
      qualityTaskId: 'qa-health',
      level: 'fatal',
    });
    service.upsertManualCrash({
      historyId: 1006,
      title: '手动解析证据',
      appVersion: '10.6.0',
      crashType: 'EXC_CRASH',
    });

    const health = gateService.evaluateReleaseHealth('nn-ios', '10.6.0');

    expect(health.status).toBe('healthy');
    expect(health.crashHealth.openCrashCount).toBe(0);
    expect(health.crashHealth.supportingEvidence.qualityCrashCount).toBe(1);
    expect(health.crashHealth.supportingEvidence.manualCrashCount).toBe(1);
  });

  it('filters governance records by version, source, status and keyword', () => {
    const record = service.upsertSentryIssue({
      id: 'sentry-filter-target',
      shortId: 'NN-IOS-FILTER',
      title: '筛选目标崩溃',
      level: 'error',
      count: '2',
      userCount: 1,
      maxAppVersion: '10.7.0',
    });
    service.updateGovernanceStatus(record.id, {
      governanceStatus: 'pending_fix',
      owner: 'IM负责人',
    });
    service.upsertSentryIssue({
      id: 'sentry-filter-other',
      shortId: 'NN-IOS-FILTER-OTHER',
      title: '其他版本崩溃',
      level: 'error',
      count: '2',
      userCount: 1,
      maxAppVersion: '10.8.0',
    });

    const records = service.list({
      source: 'sentry',
      status: 'pending_fix',
      appVersion: '10.7.0',
      keyword: 'IM负责人',
    });

    expect(records).toEqual([
      expect.objectContaining({
        sourceIssueId: 'sentry-filter-target',
        appVersion: '10.7.0',
        governanceStatus: 'pending_fix',
        owner: 'IM负责人',
      }),
    ]);
  });

  it('summarizes release version health in the governance dashboard', () => {
    service.upsertSentryIssue({
      id: 'sentry-version-health',
      shortId: 'NN-IOS-VERSION-HEALTH',
      title: '版本健康高风险崩溃',
      level: 'fatal',
      count: '5',
      userCount: 2,
      maxAppVersion: '99.9.0',
    });

    const dashboard = service.dashboard();

    expect(dashboard.versionHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({
        appVersion: '99.9.0',
        status: 'critical',
        openCrashCount: 1,
        highRiskCount: 1,
      }),
    ]));
  });

  it('uses full dashboard data instead of truncating governance statistics to the first 100 records', () => {
    const before = service.dashboard();
    const beforeOpen = before.summary.totalOpen;
    const beforeVersion = before.versionHealth.find((item) => item.appVersion === '99.13.0')?.openCrashCount || 0;

    for (let index = 0; index < 125; index += 1) {
      service.upsertSentryIssue({
        id: `sentry-dashboard-full-${index}`,
        shortId: `NN-IOS-DASH-${index}`,
        title: `Dashboard 全量统计 ${index}`,
        level: 'warning',
        count: '1',
        userCount: 1,
        maxAppVersion: '99.13.0',
        lastSeen: new Date(Date.now() + index * 1000).toISOString(),
      });
    }

    const dashboard = service.dashboard();
    const versionHealth = dashboard.versionHealth.find((item) => item.appVersion === '99.13.0');

    expect(dashboard.summary.totalOpen).toBeGreaterThanOrEqual(beforeOpen + 125);
    expect(versionHealth?.openCrashCount).toBeGreaterThanOrEqual(beforeVersion + 125);
  });

  it('summarizes Sentry sync health failures in the governance dashboard', () => {
    service.upsertSentryIssue({
      id: 'sentry-sync-health',
      shortId: 'NN-IOS-SYNC',
      title: '同步失败观测',
      level: 'warning',
      count: '1',
      userCount: 1,
      maxAppVersion: '10.10.0',
    }, {
      syncError: 'Sentry API timeout',
    });
    getDatabase().prepare(`
      UPDATE crash_governance_records
      SET retry_count = 2
      WHERE source = 'sentry' AND source_issue_id = 'sentry-sync-health'
    `).run();

    const dashboard = service.dashboard();

    expect(dashboard.syncHealth.status).toBe('failed');
    expect(dashboard.syncHealth.failedCount).toBeGreaterThanOrEqual(1);
    expect(dashboard.syncHealth.retryCount).toBeGreaterThanOrEqual(2);
    expect(dashboard.syncHealth.message).toContain('失败');
  });

  it('stores configurable excluded Sentry app versions', () => {
    const config = service.updateConfig({ excludedVersions: ['10.0.0', '9.9.9', '10.0.0'] });

    expect(config.excludedVersions).toEqual(['10.0.0', '9.9.9']);
    expect(config.defaultIssueQuery).toContain('!release:"10.0.0"');
    expect(config.defaultIssueQuery).toContain('!release:"9.9.9"');
    expect(service.dashboard().summary.excludedVersions).toEqual(['10.0.0', '9.9.9']);
  });

  it('refreshes dSYM coverage for a governance record by id', async () => {
    const record = service.upsertSentryIssue({
      id: 'sentry-refresh-coverage',
      shortId: 'NN-IOS-COVERAGE',
      title: '重查 dSYM 覆盖',
      level: 'error',
      count: '1',
      userCount: 1,
      maxAppVersion: '10.11.0',
    });

    const refreshed = await service.refreshCoverageById(record.id);

    expect(refreshed).toEqual(expect.objectContaining({
      id: record.id,
      dsymCoverageStatus: 'missing',
    }));
    expect(refreshed?.dsymCoverage).toEqual(expect.objectContaining({
      appVersion: '10.11.0',
      total: 0,
      valid: 0,
    }));
  });

  it('refreshes dSYM coverage for all governance records in a version', async () => {
    service.upsertSentryIssue({
      id: 'sentry-refresh-version-1',
      shortId: 'NN-IOS-COVERAGE-V1',
      title: '批量重查 dSYM 覆盖 1',
      level: 'error',
      count: '1',
      userCount: 1,
      maxAppVersion: '10.12.0',
    });
    service.upsertSentryIssue({
      id: 'sentry-refresh-version-2',
      shortId: 'NN-IOS-COVERAGE-V2',
      title: '批量重查 dSYM 覆盖 2',
      level: 'warning',
      count: '1',
      userCount: 1,
      maxAppVersion: '10.12.0',
    });
    service.upsertSentryIssue({
      id: 'sentry-refresh-version-other',
      shortId: 'NN-IOS-COVERAGE-OTHER',
      title: '其他版本不应重查',
      level: 'warning',
      count: '1',
      userCount: 1,
      maxAppVersion: '10.12.1',
    });

    const result = await service.refreshCoverageByVersion('10.12.0');

    expect(result.total).toBe(2);
    expect(result.refreshed).toBe(2);
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceIssueId: 'sentry-refresh-version-1', dsymCoverageStatus: 'missing' }),
      expect.objectContaining({ sourceIssueId: 'sentry-refresh-version-2', dsymCoverageStatus: 'missing' }),
    ]));
    expect(service.getBySourceIssueId('sentry-refresh-version-other')?.dsymCoverageStatus).toBe('unknown');
  });
});
