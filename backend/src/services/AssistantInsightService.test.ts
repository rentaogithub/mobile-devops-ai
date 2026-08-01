import { AssistantInsightService } from './AssistantInsightService';
import { jenkinsAssistantService } from './JenkinsAssistantService';
import { operationalLogService } from './OperationalLogService';
import sentryIssueService from './SentryIssueService';
import { workflowService } from './WorkflowService';

describe('assistant insight closed-loop queries', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('compares crash versions and identifies issues added in the newer version', async () => {
    const service = new AssistantInsightService();
    jest.spyOn(sentryIssueService, 'listNewIssues')
      .mockResolvedValueOnce([{ id: '1', title: 'Old crash', culprit: 'A', count: '2', userCount: 1 } as any])
      .mockResolvedValueOnce([
        { id: '1', title: 'Old crash', culprit: 'A', count: '3', userCount: 2 },
        { id: '2', title: 'New crash', culprit: 'B', count: '5', userCount: 4 },
      ] as any);

    const result = await service.compareCrashVersions('5.14.0', '5.15.0', '7d');

    expect(result).toMatchObject({
      kind: 'crash_version_comparison',
      period: '7d',
      versions: [
        expect.objectContaining({ version: '5.14.0', issueCount: 1, eventCount: 2 }),
        expect.objectContaining({ version: '5.15.0', issueCount: 2, eventCount: 8 }),
      ],
      newIssues: [expect.objectContaining({ id: '2' })],
    });
  });

  it('correlates Sentry, logs, Jenkins and quality center evidence', async () => {
    const service = new AssistantInsightService();
    jest.spyOn(sentryIssueService, 'listIssuesByIdentifier').mockResolvedValue([{ id: '120727', title: 'Crash', count: '4' } as any]);
    jest.spyOn(operationalLogService, 'search').mockResolvedValue({ matchCount: 2, matches: [{ time: '10:00', content: 'error timeout' }] } as any);
    jest.spyOn(jenkinsAssistantService, 'getBuildSnapshot').mockResolvedValue({ number: 1584, result: 'FAILURE', branchName: 'develop', log: 'failed' } as any);
    jest.spyOn(workflowService, 'listTasks').mockReturnValue([{ id: 'task_1', status: 'failed' }] as any);
    jest.spyOn(workflowService, 'listIssues').mockReturnValue([{ id: 'issue_1', title: 'Smoke failed' }] as any);
    jest.spyOn(workflowService, 'listReleaseGates').mockReturnValue([{ id: 'gate_1', buildNumber: '1584', status: 'blocked' }] as any);

    const result = await service.diagnoseCrossSystem({ uid: '139926257', buildNumber: 1584, crashTime: '2026-07-29T10:00:00+08:00' });

    expect(result).toMatchObject({
      kind: 'cross_system_diagnosis',
      summary: { crashIssues: 1, logMatches: 2, workflowTasks: 1, workflowIssues: 1, releaseGates: 1 },
      possibleCauses: expect.arrayContaining([
        expect.objectContaining({ cause: '构建或发布链路失败' }),
        expect.objectContaining({ cause: '线上 Crash 回归' }),
        expect.objectContaining({ cause: '客户端日志异常' }),
      ]),
    });
  });

  it('tracks Jenkins tasks and marks terminal states', async () => {
    const service = new AssistantInsightService();
    jest.spyOn(jenkinsAssistantService, 'verifyBuild').mockResolvedValue({ status: 'passed', nextActions: ['验证通过'] } as any);

    await expect(service.trackTask({ taskType: 'build', id: '1584' })).resolves.toMatchObject({
      kind: 'task_tracking',
      taskType: 'build',
      terminal: true,
      status: 'passed',
    });
  });

  it('returns a partial quality daily report when one upstream source fails', async () => {
    const service = new AssistantInsightService();
    const now = Date.now();
    jest.spyOn(jenkinsAssistantService, 'listBuilds')
      .mockRejectedValueOnce(new Error('Jenkins unavailable'))
      .mockResolvedValueOnce([{ number: 88, result: 'FAILURE', timestamp: now }] as any);
    jest.spyOn(sentryIssueService, 'listNewIssues').mockResolvedValue([
      { id: 'crash_1', title: 'Crash', count: '3', lastSeen: new Date(now).toISOString() },
    ] as any);
    jest.spyOn(workflowService, 'listTasks').mockReturnValue([] as any);
    jest.spyOn(workflowService, 'listIssues').mockReturnValue([] as any);

    const result = await service.qualityDailyReport(24);

    expect(result).toMatchObject({
      kind: 'quality_daily_report',
      metrics: { builds: 0, qualityTasks: 1, qualityFailures: 1, newCrashIssues: 1, crashEvents: 3 },
      sourceStatus: { jenkins: 'rejected', quality: 'fulfilled', sentry: 'fulfilled' },
      sourceErrors: { jenkins: 'Jenkins unavailable' },
    });
  });
});
