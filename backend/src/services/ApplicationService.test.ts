import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { closeDatabase, initializeDatabase } from '../database';
import { applicationService } from './ApplicationService';
import { authService } from './AuthService';
import { currentProjectId, runWithProductLine } from './ProductLineContext';
import { workflowService } from './WorkflowService';
import { productLineContextMiddleware, requireApplicationPlatform } from '../middleware/auth';
import { assistantToolRegistry } from './AssistantToolRegistry';

describe('mobile application identity and enforcement', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-apps-'));
  let android: any;
  beforeAll(() => {
    closeDatabase(); process.env.DB_PATH = path.join(temp, 'test.sqlite'); initializeDatabase();
    android = applicationService.create('nn', { platform: 'android', name: 'NN Android', packageId: 'com.test.android' });
  });
  afterAll(() => { jest.restoreAllMocks(); closeDatabase(); delete process.env.DB_PATH; fs.rmSync(temp, { recursive: true, force: true }); });
  it('migrates legacy iOS identity idempotently without relabeling existing data', () => {
    expect(applicationService.list('nn').find((app) => app.platform === 'ios')?.projectId).toBe('nn-ios');
    initializeDatabase(); expect(applicationService.list('nn')).toHaveLength(2);
  });
  it('isolates Workflow artifacts between platforms in the same product line', () => {
    const product = authService.findProductLine('nn')!;
    runWithProductLine({ ...product, role: 'admin', application: android }, () => {
      expect(currentProjectId()).toBe(android.projectId);
      workflowService.createArtifact({ id: 'android-artifact', artifactType: 'android_apk', name: 'APK' });
    });
    runWithProductLine({ ...product, role: 'admin', application: applicationService.list('nn').find((app) => app.platform === 'ios') }, () => {
      expect(currentProjectId()).toBe('nn-ios'); expect(workflowService.getArtifact('android-artifact')).toBeNull();
    });
  });
  it('rejects identity mutation, duplicate platforms and credentials or traversal in configuration', () => {
    expect(() => applicationService.update('nn', android.id, { packageId: 'com.other.app' })).toThrow('不可变');
    expect(() => applicationService.create('nn', { platform: 'android', name: 'Duplicate', packageId: 'com.other.app' })).toThrow('已存在');
    for (const config of [{ repositoryUrl: 'https://token:password@git.example/app' }, { apkPath: '../app.apk' }, { buildJob: 'job;echo x' }, JSON.parse('{"__proto__":"invalid"}')]) {
      expect(() => applicationService.update('nn', android.id, { config })).toThrow();
    }
    expect(() => authService.updateProductLine('nn', { projectId: 'new-space' })).toThrow('不可变');
    expect(() => authService.createProductLine({ name: 'Collision', projectId: android.projectId })).toThrow('已被应用占用');
  });
  it('enforces platform and product ownership in HTTP middleware, including cookies', async () => {
    const product = authService.findProductLine('nn')!;
    const beta = authService.createProductLine({ key: 'another', name: 'Another' })!;
    const foreign = applicationService.create(beta.id, { platform: 'android', name: 'Another Android', packageId: 'com.other.app' });
    jest.spyOn(authService, 'getSessionUser').mockReturnValue({ id: 'user', username: 'user', displayName: 'user', active: true, role: 'tester', productLines: [{ ...product, role: 'tester' }] });
    const app = express();
    app.use(productLineContextMiddleware);
    app.get('/ios', requireApplicationPlatform('ios'), (_req, res) => res.json({ project: currentProjectId() }));
    app.get('/android', requireApplicationPlatform('android'), (_req, res) => res.json({ project: currentProjectId() }));
    expect((await request(app).get('/ios')).body.project).toBe('nn-ios');
    expect((await request(app).get('/ios').set('X-Application-Id', android.id)).status).toBe(409);
    expect((await request(app).get('/android').set('Cookie', `active_application_id=${android.id}`)).body.project).toBe(android.projectId);
    expect((await request(app).get('/android').set('X-Application-Id', foreign.id)).status).toBe(403);
    expect((await request(app).get('/android').set('X-Application-Id', '%ZZ')).status).toBe(400);
  });
  it('filters AI capabilities by platform and rechecks at execution, preserving role checks', () => {
    const admin: any = { id: 'admin', username: 'admin', role: 'admin', active: true };
    const tool = assistantToolRegistry.get('cicd_trigger_build')!;
    runWithProductLine({ ...authService.findProductLine('nn')!, role: 'admin', application: android }, () => {
      expect(assistantToolRegistry.listForUser(admin).every((item) => item.name.startsWith('android_'))).toBe(true);
      expect(() => assistantToolRegistry.assertAllowed(tool.name, admin)).toThrow('平台');
      expect(() => assistantToolRegistry.assertExecutable(tool, {}, { user: admin })).toThrow('平台');
      expect(() => assistantToolRegistry.assertAllowed('android_trigger_run', { ...admin, role: 'guest' })).toThrow('角色');
    });
    expect(assistantToolRegistry.listForUser(admin).some((item) => item.name.startsWith('android_'))).toBe(false);
  });
});
