import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { closeDatabase, getDatabase, initializeDatabase } from '../database';
import { applicationService } from './ApplicationService';
import { AuthService } from './AuthService';
import { runWithProductLine } from './ProductLineContext';
import { AndroidDeliveryService, AndroidRun } from './AndroidDeliveryService';
import * as external from '../config/externalServices';
import { workflowService } from './WorkflowService';

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const commit = 'a'.repeat(40);
const apk = Buffer.from('signed-apk-fixture');
const evidence = { logcat: Buffer.from('test logcat'), screenshot: Buffer.from('89504e470d0a1a0a0000', 'hex'), packageDump: Buffer.from('package com.test.android versionCode=1') };
describe('Android delivery evidence and durable submissions', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'android-delivery-'));
  const client = { get: jest.fn(), post: jest.fn() };
  const service = new AndroidDeliveryService(client);
  let context: any;
  let configSpy: jest.SpyInstance;
  beforeAll(() => {
    closeDatabase(); process.env.DB_PATH = path.join(temp, 'test.sqlite'); initializeDatabase();
    const product = new AuthService().createProductLine({ key: 'android-test', name: 'Android test' })!;
    const application = applicationService.create(product.id, { name: 'Android', packageId: 'com.test.android', platform: 'android', config: {
      repositoryUrl: 'https://git.example/app.git', buildJob: 'mobile/build', qualityJob: 'mobile/smoke', apkPath: 'app/build/app-debug.apk', deviceSerial: 'test-device', buildVariant: 'debug',
    } });
    context = { ...product, application, role: 'admin' };
    configSpy = jest.spyOn(external, 'getJenkinsConfig').mockReturnValue({ baseUrl: 'https://jenkins.example', username: 'test', token: 'fixture', jobName: 'ios-job', qualityJobName: 'ios-quality', repoUrl: '' });
  });
  afterAll(() => { configSpy.mockRestore(); closeDatabase(); delete process.env.DB_PATH; fs.rmSync(temp, { recursive: true, force: true }); });
  beforeEach(() => {
    client.get.mockReset(); client.post.mockReset();
    client.post.mockResolvedValue({ location: 'https://jenkins.example/queue/item/7/' });
    getDatabase().prepare('DELETE FROM android_delivery_runs').run();
  });
  const scoped = (fn: () => Promise<void>) => runWithProductLine(context, fn);
  function manifest(run: AndroidRun): any {
    const common = { schemaVersion: 1, kind: run.kind, requestId: run.id, applicationId: run.applicationId, packageId: run.config.packageId, commit: run.config.commit };
    return run.kind === 'build' ? { ...common, apkPath: run.config.apkPath, sha256: sha(apk), versionCode: '1', versionName: '1.0' }
      : { ...common, sourceRunId: run.config.sourceRunId, sourceBuild: run.config.sourceBuild, sourceJob: run.config.sourceJob, sha256: sha(apk), deviceSerial: run.config.deviceSerial,
        installedPackageId: run.config.packageId, installedVersionCode: '1', installedVersionName: '1.0', passed: true, launchPassed: true, crashDetected: false, anrDetected: false,
        evidence: { logcat: 'evidence/logcat.txt', screenshot: 'evidence/screen.png', packageDump: 'evidence/package.txt' },
        evidenceSha256: Object.fromEntries(Object.entries(evidence).map(([key, bytes]) => [key, sha(bytes)])) };
  }
  function respond(run: AndroidRun, m: any = manifest(run), result = 'SUCCESS') {
    const actions = [{ parameters: [{ name: 'PLATFORM_REQUEST_ID', value: run.id }] }];
    client.get.mockImplementation(async (_base, url, binary) => {
      if (binary) {
        if (url.endsWith('screen.png')) return evidence.screenshot;
        if (url.endsWith('logcat.txt')) return evidence.logcat;
        if (url.endsWith('package.txt')) return evidence.packageDump;
        return apk;
      }
      if (url.startsWith('queue/')) return { actions, executable: { number: 12 } };
      if (url.includes('artifact/')) return m;
      if (url.includes('?tree=')) return { builds: [{ number: 12, actions }] };
      return { actions, building: false, result };
    });
  }
  async function build() {
    const run = await service.trigger({ kind: 'build', requestKey: 'build-key', commit }); respond(run); return service.refresh(run.id);
  }
  async function smoke(source: AndroidRun, key = 'smoke-key') {
    const run = await service.trigger({ kind: 'smoke', sourceRunId: source.id, requestKey: key }); respond(run); return service.refresh(run.id);
  }
  it('keeps a lost POST response durable and never resubmits an existing request key', () => scoped(async () => {
    client.post.mockRejectedValue(new Error('timeout'));
    const run = await service.trigger({ kind: 'build', requestKey: 'lost-key', commit });
    expect(run.status).toBe('dispatch_unknown');
    const afterRestart = new AndroidDeliveryService(client);
    expect((await afterRestart.trigger({ kind: 'build', requestKey: 'lost-key', commit })).id).toBe(run.id);
    expect(client.post).toHaveBeenCalledTimes(1);
    await expect(service.trigger({ kind: 'build', requestKey: 'lost-key', commit: 'b'.repeat(40) })).rejects.toThrow('不同参数');
    respond(run); expect((await afterRestart.refresh(run.id)).status).toBe('passed');
  }));
  it('sends exact Commit and configured Android Job without using legacy iOS defaults', () => scoped(async () => {
    await expect(service.trigger({ kind: 'build', requestKey: 'short-key', commit: 'abc1234' })).rejects.toThrow('40 位');
    await build(); expect(client.post).toHaveBeenCalledWith('https://jenkins.example', 'job/mobile/job/build/buildWithParameters', expect.objectContaining({ COMMIT: commit, PACKAGE_ID: 'com.test.android' }));
  }));
  it.each(['requestId', 'applicationId', 'packageId', 'commit', 'apkPath', 'sha256', 'versionCode'])('rejects mismatched build %s evidence', (field) => scoped(async () => {
    const run = await service.trigger({ kind: 'build', requestKey: 'wrong-key', commit }); const m = manifest(run); m[field] = 'wrong'; respond(run, m);
    expect((await service.refresh(run.id)).status).toBe('invalid_evidence'); expect(service.gate(run.id).passed).toBe(false);
  }));
  it('requires same-source Smoke and rehashes the APK before download', () => scoped(async () => {
    const source = await build(); expect(service.gate(source.id).passed).toBe(false);
    await expect(service.download(source.id)).rejects.toThrow('门禁');
    const check = await smoke(source); expect(check.status).toBe('passed'); expect(service.gate(source.id).passed).toBe(true);
    expect(await service.download(source.id)).toEqual(apk);
    client.get.mockResolvedValue(Buffer.from('tampered'));
    await expect(service.download(source.id)).rejects.toThrow('SHA256');
    expect(workflowService.getArtifact(`apk:${source.id}`)?.projectId).toBe(context.application.projectId);
  }));
  it.each(['sourceRunId', 'sourceBuild', 'sha256', 'deviceSerial', 'installedPackageId', 'installedVersionCode', 'installedVersionName'])('rejects mismatched Smoke %s', (field) => scoped(async () => {
    const source = await build(); const run = await service.trigger({ kind: 'smoke', sourceRunId: source.id, requestKey: 'wrong-smoke' });
    const m = manifest(run); m[field] = 'wrong'; respond(run, m);
    expect((await service.refresh(run.id)).status).toBe('invalid_evidence'); expect(service.gate(source.id).passed).toBe(false);
  }));
  it('blocks missing or altered archived evidence even when the Jenkins Job succeeds', () => scoped(async () => {
    const source = await build(); const run = await service.trigger({ kind: 'smoke', sourceRunId: source.id, requestKey: 'missing-evidence' });
    const m = manifest(run); m.evidenceSha256.screenshot = 'b'.repeat(64); respond(run, m);
    expect((await service.refresh(run.id)).status).not.toBe('passed'); expect(service.gate(source.id).passed).toBe(false);
  }));
  it('uses the most recent Smoke, so a new pending or failed test invalidates an older pass', () => scoped(async () => {
    const source = await build(); await smoke(source); expect(service.gate(source.id).passed).toBe(true);
    const pending = await service.trigger({ kind: 'smoke', sourceRunId: source.id, requestKey: 'second-smoke' });
    expect(service.gate(source.id).passed).toBe(false); respond(pending, manifest(pending), 'FAILURE');
    expect((await service.refresh(pending.id)).status).toBe('failed'); expect(service.gate(source.id).passed).toBe(false);
  }));
  it('retains verified Crash/ANR evidence as a scoped issue and requires later same-APK verification to resolve', () => scoped(async () => {
    const source = await build(); const run = await service.trigger({ kind: 'smoke', sourceRunId: source.id, requestKey: 'crash-smoke' });
    const m = { ...manifest(run), passed: false, crashDetected: true }; respond(run, m, 'FAILURE');
    expect((await service.refresh(run.id)).status).toBe('failed');
    const issue = service.issues().find((item) => item?.taskId === run.id)!; expect(issue.category).toBe('android_crash');
    expect(() => service.resolveIssue(issue.id, run.id)).toThrow('通过 Smoke');
    const later = await smoke(source, 'verified-smoke'); expect(service.gate(source.id).passed).toBe(false);
    // Use deterministic ordering independent of millisecond clock resolution.
    getDatabase().prepare('UPDATE workflow_issues SET last_seen = ? WHERE id = ?').run('2020-01-01T00:00:00Z', issue.id);
    service.resolveIssue(issue.id, later.id); expect(service.gate(source.id).passed).toBe(true);
  }));
  it('cannot read or cancel another application task', () => scoped(async () => {
    const source = await build();
    runWithProductLine({ ...context, application: { ...context.application, id: 'another-app' } }, () => {
      expect(service.list()).toEqual([]); expect(() => service.get(source.id)).toThrow('当前应用');
    });
  }));
  it('does not interpret a cancel request as a confirmed cancellation', () => scoped(async () => {
    const run = await service.trigger({ kind: 'build', requestKey: 'cancel-key', commit });
    expect((await service.cancel(run.id)).status).toBe('cancel_requested');
    client.get.mockResolvedValue({ actions: [{ parameters: [{ name: 'PLATFORM_REQUEST_ID', value: run.id }] }], cancelled: true });
    expect((await service.refresh(run.id)).status).toBe('canceled');
  }));
  it('does not allow a new request key to duplicate an unresolved submission and exposes timeout without claiming cancellation', () => scoped(async () => {
    const run = await service.trigger({ kind: 'build', requestKey: 'timeout-key', commit });
    await expect(service.trigger({ kind: 'build', requestKey: 'new-timeout-key', commit })).rejects.toThrow('未结束任务');
    getDatabase().prepare('UPDATE android_delivery_runs SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z', run.id);
    client.get.mockResolvedValue({ builds: [] });
    expect((await service.refresh(run.id)).status).toBe('timed_out');
    expect((await service.cancel(run.id)).status).toBe('cancel_requested');
  }));
  it('refuses ambiguous exact-request recovery when Jenkins reports multiple builds', () => scoped(async () => {
    client.post.mockRejectedValue(new Error('lost response'));
    const run = await service.trigger({ kind: 'build', requestKey: 'duplicate-key', commit });
    const actions = [{ parameters: [{ name: 'PLATFORM_REQUEST_ID', value: run.id }] }];
    client.get.mockResolvedValue({ builds: [{ number: 12, actions }, { number: 13, actions }] });
    const recovered = await service.refresh(run.id);
    expect(recovered.buildNumber).toBeUndefined(); expect(recovered.status).toBe('dispatch_unknown');
  }));
  it('rejects a changed configuration after preview instead of executing on a different Job or device', () => scoped(async () => {
    await expect(service.trigger({ kind: 'build', requestKey: 'stale-preview', commit, configurationRevision: 'stale-revision' })).rejects.toThrow('配置已变化');
    expect(client.post).not.toHaveBeenCalled();
  }));
  it('blocks execution with missing Android configuration without issuing a Jenkins request', () => scoped(async () => {
    await runWithProductLine({ ...context, application: { ...context.application, config: { ...context.application.config, buildJob: '' } } }, async () => {
      expect(service.readiness().missing).toContain('buildJob');
      await expect(service.trigger({ kind: 'build', requestKey: 'missing-job', commit })).rejects.toThrow('buildJob');
    });
    expect(client.post).not.toHaveBeenCalled();
  }));
  it('does not follow foreign queue URLs, or guess matches by branch when recovery fails', () => scoped(async () => {
    client.post.mockResolvedValue({ location: 'https://other.example/queue/item/7/' });
    const run = await service.trigger({ kind: 'build', requestKey: 'foreign-key', commit }); expect(run.queueUrl).toBeUndefined();
    client.get.mockResolvedValue({ builds: [{ number: 99, actions: [{ parameters: [{ name: 'COMMIT', value: commit }] }] }] });
    expect((await service.refresh(run.id)).buildNumber).toBeUndefined(); expect(client.post).toHaveBeenCalledTimes(1);
  }));
});
