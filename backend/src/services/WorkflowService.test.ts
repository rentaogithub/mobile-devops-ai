import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, initializeDatabase } from '../database';
import { WorkflowService } from './WorkflowService';
import { QualityGateService } from './QualityGateService';

describe('mobile workflow foundation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-workflow-test-'));
  const workflowService = new WorkflowService();
  const gateService = new QualityGateService();

  beforeAll(() => {
    process.env.DB_PATH = path.join(tempDir, 'workflow.sqlite');
    initializeDatabase();
  });

  afterAll(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.DB_PATH;
  });

  it('persists artifact lineage, tasks and deduplicated issues', () => {
    const artifact = workflowService.createArtifact({
      id: 'artifact_build_100',
      artifactType: 'ios_app_build',
      name: 'NNIM Build #100',
      buildNumber: '100',
      commitHash: 'abc123',
    });
    expect(artifact?.buildNumber).toBe('100');

    const task = workflowService.upsertTask({
      id: 'task_smoke_100',
      taskType: 'ios_smoke',
      suite: 'smoke',
      status: 'passed',
      buildNumber: '100',
      artifactId: artifact?.id,
      progress: 100,
      result: { passed: true },
    });
    expect(task?.status).toBe('passed');

    const first = workflowService.upsertIssue({
      source: 'quality',
      sourceRef: 'task_smoke_100:crash-1',
      fingerprint: 'same-crash',
      category: 'crash',
      severity: 'critical',
      title: '启动崩溃',
      taskId: task?.id,
      buildNumber: '100',
      evidence: [{ type: 'crash', eventId: 'event-1' }],
      lastSeen: '2026-07-20T00:00:00.000Z',
    });
    const second = workflowService.upsertIssue({
      source: 'quality',
      sourceRef: 'task_smoke_100:crash-1',
      fingerprint: 'same-crash',
      category: 'crash',
      severity: 'critical',
      title: '启动崩溃',
      taskId: task?.id,
      buildNumber: '100',
      evidence: [{ type: 'crash', eventId: 'event-1' }],
      lastSeen: '2026-07-20T00:00:00.000Z',
    });
    expect(second?.id).toBe(first?.id);
    expect(second?.occurrenceCount).toBe(1);
    expect(second?.evidence).toEqual([{ type: 'crash', eventId: 'event-1' }]);
  });

  it('evaluates a release gate from persisted task and issue data', () => {
    workflowService.upsertTask({
      id: 'task_smoke_101',
      taskType: 'ios_smoke',
      suite: 'smoke',
      status: 'passed',
      buildNumber: '101',
      result: { passed: true, crash_count: 0 },
    });

    const gate = gateService.evaluate({
      buildNumber: '101',
      buildStatus: 'success',
      policy: { requiredSuites: ['smoke'] },
    });
    const repeatedGate = gateService.evaluate({
      buildNumber: '101',
      buildStatus: 'success',
      policy: { requiredSuites: ['smoke'] },
    });
    expect(gate?.status).toBe('passed');
    expect(gate?.score).toBe(100);
    expect(repeatedGate?.id).toBe(gate?.id);
    expect(workflowService.listReleaseGates().filter((item) => item?.buildNumber === '101')).toHaveLength(1);
  });

  it('requires completed suites to explicitly report passed', () => {
    workflowService.upsertTask({
      id: 'task_smoke_102',
      taskType: 'ios_smoke',
      suite: 'smoke',
      status: 'completed',
      buildNumber: '102',
      result: {},
    });
    const preview = gateService.preview({
      buildNumber: '102',
      buildStatus: 'success',
      policy: { requiredSuites: ['smoke'] },
    });
    expect(preview?.status).toBe('blocked');
    expect((preview?.result as any)?.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'suite_incomplete' }),
    ]));
  });
});
