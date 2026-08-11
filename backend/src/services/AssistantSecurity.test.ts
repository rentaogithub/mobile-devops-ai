import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, initializeDatabase } from '../database';
import { AssistantAuditService } from './AssistantAuditService';
import { AssistantToolRegistry } from './AssistantToolRegistry';
import { AuthService, PlatformUser } from './AuthService';
import { AssistantService, AssistantEvent, sanitizeToolOutput } from './AssistantService';
import { assistantModelGateway } from './AssistantModelGateway';
import { jenkinsAssistantService } from './JenkinsAssistantService';
import { isAssistantOriginAllowed } from '../routes/assistant.routes';

describe('assistant identity, permissions and audit', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-assistant-test-'));
  const auth = new AuthService();
  const registry = new AssistantToolRegistry();
  const audits = new AssistantAuditService();
  let guest: PlatformUser;
  let tester: PlatformUser;
  let product: PlatformUser;
  let admin: PlatformUser;

  beforeAll(() => {
    process.env.DB_PATH = path.join(tempDir, 'assistant.sqlite');
    initializeDatabase();
    guest = auth.createUser({ username: 'guest.one', displayName: '只读用户', password: 'guest-password', role: 'guest' })!;
    tester = auth.createUser({ username: 'tester.one', displayName: '执行用户', password: 'tester-password', role: 'tester' })!;
    product = auth.createUser({ username: 'product.one', displayName: '产品运营', password: 'product-password', role: 'product' })!;
    admin = auth.createUser({ username: 'admin.one', displayName: '管理员', password: 'admin-password', role: 'admin' })!;
  });

  afterAll(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.DB_PATH;
  });

  it('hashes passwords and authenticates named users', () => {
    const encoded = auth.hashPassword('secret-password');
    expect(encoded).not.toContain('secret-password');
    expect(auth.verifyPassword('secret-password', encoded)).toBe(true);
    expect(auth.verifyPassword('wrong-password', encoded)).toBe(false);
    expect(auth.authenticate('tester.one', 'tester-password')?.role).toBe('tester');
  });

  it('provides all registered capabilities to an anonymous assistant client', () => {
    const guest: PlatformUser = {
      id: 'assistant-anonymous:test-client',
      username: 'anonymous',
      displayName: '匿名访客',
      role: 'guest',
      active: true,
    };
    expect(guest).toMatchObject({
      username: 'anonymous',
      displayName: '匿名访客',
      role: 'guest',
      active: true,
    });
    expect(registry.listForUser(guest).map((tool) => tool.name)).not.toContain('cicd_trigger_release');
  });

  it('exposes tools according to the role matrix', () => {
    const viewerTools = registry.listForUser(guest).map((tool) => tool.name);
    const operatorTools = registry.listForUser(tester).map((tool) => tool.name);
    const productTools = registry.listForUser(product).map((tool) => tool.name);
    expect(viewerTools).toEqual(expect.arrayContaining([
      'platform_cross_system_diagnosis',
      'logs_search',
      'crash_compare_versions',
      'dsym_diagnose_missing',
      'pods_analyze_impact',
      'api_search',
      'routes_search',
      'task_track',
    ]));
    expect(viewerTools).not.toContain('workflow_overview');
    expect(viewerTools).not.toContain('quality_daily_report');
    expect(viewerTools).toContain('cicd_analyze_build_failure');
    expect(viewerTools).toContain('cicd_verify_build');
    expect(viewerTools).not.toContain('workflow_verify_task');
    expect(viewerTools).not.toContain('quality_create_task');
    expect(viewerTools).not.toContain('cicd_retry_build');
    expect(operatorTools).toContain('quality_daily_report');
    expect(operatorTools).toContain('quality_create_task');
    expect(operatorTools).toContain('cicd_trigger_build');
    expect(operatorTools).toContain('cicd_retry_build');
    expect(operatorTools).toContain('quality_retry_task');
    expect(operatorTools).toContain('cicd_trigger_release');
    expect(productTools).toContain('cicd_trigger_release');
    expect(productTools).not.toContain('cicd_trigger_build');
    expect(productTools).not.toContain('quality_daily_report');
    expect(productTools).not.toContain('quality_create_task');
    expect(() => registry.assertAllowed('quality_create_task', guest)).toThrow('无权');
    expect(() => registry.assertExecutable(registry.get('cicd_trigger_release')!, { deployTarget: 'AppStore' }, { user: tester })).toThrow('产品运营或管理员');
    expect(() => registry.assertExecutable(registry.get('cicd_trigger_release')!, { deployTarget: 'TestFlight' }, { user: product })).toThrow('测试、研发或管理员');
    expect(registry.assertExecutable(registry.get('cicd_trigger_release')!, { deployTarget: 'AppStore' }, { user: product })).toBeUndefined();
    expect(registry.listForUser(admin)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'workflow_overview' }),
      expect.objectContaining({ name: 'quality_daily_report' }),
    ]));
    expect(registry.listForUser(admin).some((tool) => /delete|remove/i.test(tool.name))).toBe(false);
    expect(registry.listForUser(admin).every((tool) => tool.parameters && (tool.parameters as any).additionalProperties === false)).toBe(true);
  });

  it('rejects unknown and invalid tool arguments', () => {
    const tool = registry.get('quality_create_task')!;
    expect(() => registry.validate(tool, { sourceBuildNumber: 100, suite: 'unknown' })).toThrow('允许范围');
    expect(() => registry.validate(tool, { sourceBuildNumber: 100, suite: 'smoke', arbitraryUrl: 'https://example.com' })).toThrow('不允许的参数');
    const logsTool = registry.get('logs_search')!;
    expect(() => registry.validate(logsTool, { uid: '139926257', windowMinutes: 2000 })).toThrow('大于最大值');
    expect(() => registry.validate(logsTool, { uid: '139926257', url: 'https://example.com/log.zip' })).toThrow('不允许的参数');
    const taskTrack = registry.get('task_track')!;
    expect(() => registry.validate(taskTrack, { taskType: 'shell', id: '1' })).toThrow('允许范围');
  });

  it('accepts same-origin browser requests through a development proxy but rejects cross-site requests', () => {
    expect(isAssistantOriginAllowed({
      origin: 'http://10.1.106.95:5173',
      host: '127.0.0.1:3000',
      'sec-fetch-site': 'same-origin',
    })).toBe(true);
    expect(isAssistantOriginAllowed({
      origin: 'https://malicious.example',
      host: 'platform.example',
      'sec-fetch-site': 'cross-site',
    })).toBe(false);
    expect(isAssistantOriginAllowed({ origin: 'https://platform.example', host: 'platform.example' })).toBe(true);
    expect(isAssistantOriginAllowed({ origin: 'https://malicious.example', host: 'platform.example' })).toBe(false);
  });

  it('redacts secrets while persisting approval and execution audit', () => {
    const audit = audits.create({
      user: tester,
      toolName: 'quality_create_task',
      domain: 'quality',
      riskLevel: 'confirm',
      status: 'awaiting_confirmation',
      arguments: { sourceBuildNumber: 100, token: 'do-not-store', nested: { password: 'secret' } },
      preview: { title: '创建质检任务' },
      approvalsRequired: 1,
      idempotencyKey: 'quality-task-100',
    })!;
    expect(audit.arguments).toMatchObject({ token: '[redacted]', nested: { password: '[redacted]' } });
    expect(audits.findRecentDuplicate('quality-task-100')?.id).toBe(audit.id);
    const completed = audits.update(audit.id, { status: 'completed', approvalCount: 1, result: { taskId: 'task_100' }, completed: true });
    expect(completed?.status).toBe('completed');
    expect(completed?.approvalCount).toBe(1);
    expect(completed?.result).toEqual({ taskId: 'task_100' });
  });

  it('redacts secrets embedded in tool output text', () => {
    expect(sanitizeToolOutput({
      content: 'event=api_request fields={token=abc123, authorization=Bearer secret-value, version=51410}',
      nested: 'https://example.com/path?access_token=query-secret&uid=131088950',
    })).toEqual({
      content: 'event=api_request fields={token=[redacted], authorization=[redacted], version=51410}',
      nested: 'https://example.com/path?access_token=[redacted]&uid=131088950',
    });
  });

  it('executes read tools without confirmation and resumes the model', async () => {
    const service = new AssistantService();
    const events: AssistantEvent[] = [];
    jest.spyOn(assistantModelGateway, 'start').mockResolvedValueOnce({
      text: '',
      calls: [{ callId: 'call_read', name: 'workflow_overview', arguments: '{}' }],
      state: { style: 'responses', previousResponseId: 'response_read' },
    });
    jest.spyOn(assistantModelGateway, 'continue').mockResolvedValueOnce({
      text: '已读取质量中心概览。',
      calls: [],
      state: { style: 'responses', previousResponseId: 'response_done' },
    });

    await service.turn(admin, [{ role: 'user', content: '查看质量中心概览' }], (event) => events.push(event));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.started', toolName: 'workflow_overview' }),
      expect.objectContaining({ type: 'tool.completed', toolName: 'workflow_overview' }),
      expect.objectContaining({ type: 'assistant.delta' }),
      expect.objectContaining({ type: 'assistant.completed', status: 'completed' }),
    ]));
    jest.restoreAllMocks();
  });

  it('requires one confirmation for tester writes and can reject safely', async () => {
    const service = new AssistantService();
    const events: AssistantEvent[] = [];
    jest.spyOn(assistantModelGateway, 'start').mockResolvedValueOnce({
      text: '',
      calls: [{ callId: 'call_quality', name: 'quality_create_task', arguments: '{"sourceBuildNumber":100,"suite":"smoke"}' }],
      state: { style: 'responses', previousResponseId: 'response_quality' },
    });
    jest.spyOn(assistantModelGateway, 'continue').mockResolvedValueOnce({
      text: '已按你的决定取消执行。', calls: [], state: { style: 'responses', previousResponseId: 'response_rejected' },
    });

    await service.turn(tester, [{ role: 'user', content: '创建 smoke 质检' }], (event) => events.push(event));
    const proposal = events.find((event) => event.type === 'tool.proposed');
    expect(proposal).toMatchObject({ confirmationsRequired: 1, confirmationStep: 1 });
    await service.decide(tester, String(proposal?.actionId), 'reject', (event) => events.push(event));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.completed', status: 'rejected' }));
    jest.restoreAllMocks();
  });

  it('routes an explicit branch package request to a confirmed Pgyer build', async () => {
    const result = await assistantModelGateway.start(
      [{ role: 'user', content: '发布一个develop分支的包' }],
      registry.listForUser(tester),
    );
    expect(result.calls).toEqual([
      expect.objectContaining({ name: 'cicd_trigger_build', arguments: '{"branch":"develop"}' }),
    ]);
    expect(result.state.style).toBe('local');
  });

  it('queries the latest feedback logs without inventing a time range', async () => {
    const result = await assistantModelGateway.start(
      [{ role: 'user', content: '查询下用户131088950的最近反馈日志' }],
      registry.listForUser(guest),
    );
    expect(result.calls).toEqual([
      expect.objectContaining({ name: 'logs_search', arguments: '{"uid":"131088950","limit":10}' }),
    ]);
    expect(result.state.style).toBe('local');
  });

  it('requires two confirmations before a high-risk admin action', async () => {
    const service = new AssistantService();
    const events: AssistantEvent[] = [];
    jest.spyOn(assistantModelGateway, 'start').mockResolvedValueOnce({
      text: '',
      calls: [{ callId: 'call_stop', name: 'cicd_stop_build', arguments: '{"buildNumber":123}' }],
      state: { style: 'responses', previousResponseId: 'response_stop' },
    });
    await service.turn(admin, [{ role: 'user', content: '停止构建 123' }], (event) => events.push(event));
    const first = events.find((event) => event.type === 'tool.proposed');
    expect(first).toMatchObject({ confirmationsRequired: 2, confirmationStep: 1, riskLevel: 'high' });
    await service.decide(admin, String(first?.actionId), 'approve', (event) => events.push(event));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.proposed', confirmationStep: 2, confirmationsRequired: 2 }));
    expect(events.some((event) => event.type === 'tool.started')).toBe(false);
    jest.restoreAllMocks();
  });

  it('keeps Apple release secrets out of model arguments and audit records', async () => {
    const service = new AssistantService();
    const events: AssistantEvent[] = [];
    jest.spyOn(jenkinsAssistantService, 'previewReleaseGate').mockResolvedValueOnce({
      build: { number: 456, result: 'SUCCESS', branchName: 'release/1.2.3' },
      releaseGate: { id: 'gate_preview_456', status: 'passed' },
      missingSuites: [],
    });
    const trigger = jest.spyOn(jenkinsAssistantService, 'triggerRelease').mockResolvedValueOnce({
      jobName: 'nn',
      branch: 'release/1.2.3',
      jenkinsBranch: 'origin/release/1.2.3',
      deployTarget: 'TestFlight',
      sourceBuildNumber: 456,
      releaseGate: { id: 'gate_456', status: 'passed' },
      queueUrl: null,
      url: 'http://jenkins/job/nn/',
    });
    jest.spyOn(assistantModelGateway, 'start').mockResolvedValueOnce({
      text: '',
      calls: [{
        callId: 'call_release',
        name: 'cicd_trigger_release',
        arguments: '{"branch":"release/1.2.3","deployTarget":"TestFlight","gateBuildNumber":456}',
      }],
      state: { style: 'responses', previousResponseId: 'response_release' },
    });
    jest.spyOn(assistantModelGateway, 'continue').mockResolvedValueOnce({
      text: '发布任务已提交。', calls: [], state: { style: 'responses', previousResponseId: 'response_release_done' },
    });

    await service.turn(admin, [{ role: 'user', content: '发布 release/1.2.3 到 TestFlight' }], (event) => events.push(event));
    const first = events.find((event) => event.type === 'tool.proposed');
    expect(first).toMatchObject({
      confirmationStep: 1,
      confirmationsRequired: 2,
      secretInputs: [expect.objectContaining({ name: 'verificationPassword', required: true })],
    });

    await service.decide(admin, String(first?.actionId), 'approve', (event) => events.push(event));
    await service.decide(admin, String(first?.actionId), 'approve', (event) => events.push(event));
    expect(trigger).not.toHaveBeenCalled();
    expect(events.at(-2)).toMatchObject({ type: 'tool.proposed', confirmationStep: 2 });

    await service.decide(
      admin,
      String(first?.actionId),
      'approve',
      (event) => events.push(event),
      { verificationPassword: 'direct-secret-value' },
    );
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({
      verificationPassword: 'direct-secret-value',
      requireReleaseGate: true,
    }));
    expect(audits.get(String(first?.actionId))?.arguments).not.toHaveProperty('verificationPassword');
    jest.restoreAllMocks();
  });
});
