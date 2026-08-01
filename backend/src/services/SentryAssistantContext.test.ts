import { AssistantToolRegistry } from './AssistantToolRegistry';
import sentryIssueService, { SentryIssueService } from './SentryIssueService';

describe('Sentry assistant issue context', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads a numeric issue ID through the direct issue endpoint', async () => {
    const service = new SentryIssueService();
    jest.spyOn(service as any, 'ensureLogin').mockResolvedValue(undefined);
    const request = jest.spyOn(service as any, 'request').mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({ id: '151217', title: 'EXC_BAD_ACCESS' })),
    });

    await expect(service.getIssue('151217')).resolves.toMatchObject({
      id: '151217',
      title: 'EXC_BAD_ACCESS',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/api/0/issues/151217/');
    expect(request.mock.calls.some(([path]) => String(path).includes('/projects/'))).toBe(false);
  });

  it('builds the same exact UID filter as the Sentry user lookup page', async () => {
    const service = new SentryIssueService();
    const list = jest.spyOn(service, 'listNewIssues').mockResolvedValue([]);

    await service.listIssuesByIdentifier({ identifier: '139926257', identifierType: 'uid' });

    expect(list).toHaveBeenCalledWith({
      period: '7d',
      limit: 20,
      query: 'is:unresolved !release:"10.0.0" uid:"139926257"',
      enrichVersions: true,
    });
  });

  it('repairs a raw numeric generic query as a UID lookup', async () => {
    const registry = new AssistantToolRegistry();
    const lookup = jest.spyOn(sentryIssueService, 'listIssuesByIdentifier').mockResolvedValue([]);

    await registry.get('sentry_list_issues')!.execute(
      { query: '139926257', period: '14d', limit: 10 },
      { user: { id: 'anonymous-test', username: 'anonymous', displayName: '匿名访客', role: 'admin', active: true } },
    );

    expect(lookup).toHaveBeenCalledWith({
      identifier: '139926257',
      identifierType: 'uid',
      period: '7d',
      limit: 10,
    });
  });

  it('does not search the issues list and falls back to latest event context', async () => {
    const registry = new AssistantToolRegistry();
    const list = jest.spyOn(sentryIssueService, 'listNewIssues');
    jest.spyOn(sentryIssueService, 'getIssue').mockRejectedValue(new Error('issue detail unavailable'));
    jest.spyOn(sentryIssueService, 'getLatestEvent').mockResolvedValue({
      id: 'event-1',
      title: 'EXC_BAD_ACCESS in ZTUM',
      message: 'crashed while handling request',
      metadata: { type: 'EXC_BAD_ACCESS' },
    });

    const result = await registry.get('sentry_get_issue_context')!.execute(
      { issueId: '151217' },
      { user: { id: 'viewer-1', username: 'viewer', displayName: 'Viewer', role: 'viewer', active: true } },
    ) as any;

    expect(list).not.toHaveBeenCalled();
    expect(result.issue).toMatchObject({
      id: '151217',
      eventId: 'event-1',
      title: 'EXC_BAD_ACCESS in ZTUM',
    });
    expect(result.analysisLog).toContain('EXC_BAD_ACCESS in ZTUM');
    expect(result.analysisLog).toContain('crashed while handling request');
  });
});
