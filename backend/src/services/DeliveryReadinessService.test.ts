import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { closeDatabase, getDatabase, initializeDatabase } from '../database';
import { productLineContextMiddleware } from '../middleware/auth';
import workflowRoutes from '../routes/workflow.routes';
import { AuthService } from './AuthService';
import { DeliveryReadinessService } from './DeliveryReadinessService';
import { runWithProductLine } from './ProductLineContext';
import { qualityGateService } from './QualityGateService';
import { workflowService } from './WorkflowService';

describe('delivery readiness evidence', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-delivery-'));
  const previousDB = process.env.DB_PATH;
  const previousSuites = process.env.RELEASE_GATE_REQUIRED_SUITES;
  const service = new DeliveryReadinessService();
  const app = express();
  app.use('/api/workflow', productLineContextMiddleware, workflowRoutes);

  beforeAll(() => {
    closeDatabase();
    process.env.DB_PATH = path.join(tempDir, 'test.sqlite');
    process.env.RELEASE_GATE_REQUIRED_SUITES = 'smoke';
    initializeDatabase();
  });
  afterAll(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousDB === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = previousDB;
    if (previousSuites === undefined) delete process.env.RELEASE_GATE_REQUIRED_SUITES; else process.env.RELEASE_GATE_REQUIRED_SUITES = previousSuites;
  });

  const seed = (buildNumber: string, prefix = '') => {
    const artifact = workflowService.createArtifact({ id: `${prefix}artifact-${buildNumber}`, artifactType: 'jenkins_build', buildNumber, commitHash: 'abc123', branch: 'release/1.0.0', version: `1.0.${buildNumber}` })!;
    workflowService.upsertTask({ id: `${prefix}build-${buildNumber}`, taskType: 'ios_build', source: 'jenkins', suite: 'build', buildNumber, artifactId: artifact.id, status: 'passed', commitHash: 'abc123', branch: 'release/1.0.0' });
    workflowService.upsertTask({ id: `${prefix}smoke-${buildNumber}`, taskType: 'ios_smoke', suite: 'smoke', buildNumber, status: 'passed', commitHash: 'abc123', branch: 'release/1.0.0', result: { passed: true } });
  };

  it('never labels an unknown build as ready', () => {
    const result = service.diagnose('999');
    expect(result.status).toBe('blocked');
    expect(result.gate.result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'build_status_missing' }), expect.objectContaining({ code: 'required_suite_missing' })]));
    expect(result.stages.find((stage) => stage.key === 'observation')?.status).toBe('unknown');
  });

  it('joins persisted evidence without writing workflow records', () => {
    seed('101');
    const before = getDatabase().prepare('SELECT total_changes() AS count').get();
    const result = service.diagnose('101');
    const repeated = service.diagnose('101');
    expect(result.counts).toEqual({ artifacts: 1, tasks: 2, issues: 0, openIssues: 0, candidates: 0 });
    expect(result.gate.status).toBe('passed');
    expect(result.status).toBe('warning');
    expect(result.releaseHealth?.status).toBe('unknown');
    expect(repeated.gate.id).toBe(result.gate.id);
    expect(getDatabase().prepare('SELECT total_changes() AS count').get()).toEqual(before);
  });

  it('does not confuse generated, compiled or verified candidates with verification of this build', () => {
    seed('102');
    const issue = workflowService.upsertIssue({ id: 'issue-102', fingerprint: 'issue-102', buildNumber: '102', title: '登录失败', severity: 'critical' })!;
    const candidate = workflowService.createRegressionCandidate({ issueId: issue.id, title: '登录回归', status: 'compiled' })!;
    expect(service.diagnose('102').status).toBe('blocked');
    workflowService.updateIssue(issue.id, { status: 'resolved' });
    expect(service.diagnose('102').actions.some((action) => action.code === 'regression_missing')).toBe(true);
    workflowService.updateRegressionCandidate(candidate.id, { status: 'verified' });
    const result = service.diagnose('102');
    expect(result.stages.find((stage) => stage.key === 'regression')?.status).toBe('warning');
    expect(result.actions.some((action) => action.code === 'regression_build_unverified')).toBe(true);
  });

  it('preserves issue lineage when the same fingerprint recurs in a later build', () => {
    seed('103');
    const issue = workflowService.upsertIssue({ fingerprint: 'recurring', buildNumber: '103', title: '重复崩溃', severity: 'critical' })!;
    workflowService.upsertIssue({ fingerprint: 'recurring', buildNumber: '104', title: '重复崩溃', severity: 'critical' });
    expect(service.diagnose('103').evidence.issues.map((item) => item.id)).toContain(issue.id);
    expect(service.diagnose('103').status).toBe('blocked');
  });

  it('isolates same-number builds by the current product line', () => {
    const beta = new AuthService().createProductLine({ key: 'delivery-beta', name: 'Beta' })!;
    runWithProductLine({ ...beta, role: 'admin' }, () => {
      expect(service.diagnose('101').counts.tasks).toBe(0);
      seed('101', 'beta-');
      const result = service.diagnose('101');
      expect(result.projectId).toBe(beta.projectId);
      expect(result.evidence.tasks.every((task) => task.id.startsWith('beta-'))).toBe(true);
    });
    expect(service.diagnose('101').evidence.tasks.every((task) => !task.id.startsWith('beta-'))).toBe(true);
  });

  it('cannot turn truncated evidence into a passed diagnosis', () => {
    seed('105');
    getDatabase().transaction(() => {
      for (let index = 0; index < 501; index++) workflowService.createArtifact({ id: `extra-${index}`, artifactType: 'test', buildNumber: '105' });
    })();
    const result = service.diagnose('105');
    expect(result.status).not.toBe('passed');
    expect(result.actions.some((action) => action.code === 'evidence_truncated')).toBe(true);
    expect(result.evidence.artifacts).toHaveLength(500);
  });

  it('serves the same scoped result through HTTP and rejects malformed build numbers', async () => {
    const response = await request(app).get('/api/workflow/delivery/101?projectId=other');
    expect(response.status).toBe(200);
    expect(response.body.data.counts).toEqual(service.diagnose('101').counts);
    expect(response.body.data.projectId).toBe('nn-ios');
    expect((await request(app).get('/api/workflow/delivery/abc')).status).toBe(400);
    expect((await request(app).get('/api/workflow/delivery/101').set('X-Product-Line-Id', 'delivery-beta')).status).toBe(401);
  });

  it('requires an explicit successful build status for gate previews', () => {
    expect(qualityGateService.preview({ buildNumber: '1', tasks: [], issues: [], policy: { requiredSuites: [] } }).status).toBe('blocked');
  });

  it('shares configured suite aliases with release execution and keeps a nonempty policy', () => {
    process.env.RELEASE_GATE_REQUIRED_SUITES = '冒烟,Monkey';
    expect(service.diagnose('101').gate.policy.requiredSuites).toEqual(['smoke', 'monkey']);
    process.env.RELEASE_GATE_REQUIRED_SUITES = '  ,  ';
    expect(service.diagnose('101').gate.policy.requiredSuites).toEqual(['smoke']);
    process.env.RELEASE_GATE_REQUIRED_SUITES = 'smoke';
  });

  it('counts crashes and failures in optional suites', () => {
    const gate = qualityGateService.preview({ buildNumber: '1', buildStatus: 'success', issues: [], tasks: [
      { id: 'smoke', suite: 'smoke', status: 'passed', result: { passed: true } },
      { id: 'monkey', suite: 'monkey', status: 'failed', result: { crash_count: 1, failed_tests: 2 } },
    ] });
    expect(gate.result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'crash_threshold', value: 1 }), expect.objectContaining({ code: 'failed_test_threshold', value: 2 })]));
  });

  it('blocks a passing suite without evidence linking it to the source commit', () => {
    const gate = qualityGateService.preview({ buildNumber: '1', buildStatus: 'success', commitHash: 'source-commit', issues: [], tasks: [
      { id: 'smoke', suite: 'smoke', status: 'passed', result: { passed: true } },
    ] });
    expect(gate.status).toBe('blocked');
    expect(gate.result.blockers).toContainEqual(expect.objectContaining({ code: 'suite_commit_missing', taskId: 'smoke' }));
  });

  it('uses attempt time rather than synchronization time to select suite evidence', () => {
    const gate = qualityGateService.preview({ buildNumber: '1', buildStatus: 'success', issues: [], policy: { maxSuiteAgeHours: 0 }, tasks: [
      { id: 'old', suite: 'smoke', status: 'passed', startedAt: '2026-09-01T01:00:00Z', updatedAt: '2026-09-07T01:00:00Z', result: { passed: true } },
      { id: 'new', suite: 'smoke', status: 'failed', startedAt: '2026-09-02T01:00:00Z', updatedAt: '2026-09-02T02:00:00Z', result: { passed: false } },
    ] });
    expect(gate.result.blockers).toContainEqual(expect.objectContaining({ code: 'suite_failed', taskId: 'new' }));
  });

  it('distinguishes missing observations from normal observed metrics', () => {
    expect(qualityGateService.evaluateReleaseHealth('nn-ios', '2.0.0').status).toBe('unknown');
    workflowService.addReleaseObservation({ releaseVersion: '2.0.0', metric: 'crash_free_sessions', value: 100, status: 'normal' });
    expect(qualityGateService.evaluateReleaseHealth('nn-ios', '2.0.0').status).toBe('healthy');
  });
});
