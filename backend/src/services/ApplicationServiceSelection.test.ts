import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { closeDatabase, getDatabase, initializeDatabase } from '../database';
import { applicationService } from './ApplicationService';
import { authService } from './AuthService';
import { runWithProductLine } from './ProductLineContext';
import { hasCurrentApplicationServices } from './ApplicationCapabilityService';
import { assistantToolRegistry } from './AssistantToolRegistry';
import { platformOperationsService } from './PlatformOperationsService';
import { qualityGateService } from './QualityGateService';
import { crashGovernanceService } from './CrashGovernanceService';
import { productLineContextMiddleware, selectedServiceMiddleware } from '../middleware/auth';
import { defaultApplicationServices } from './ApplicationServiceCatalog';
import { AndroidDeliveryService } from './AndroidDeliveryService';
import * as externalServices from '../config/externalServices';

describe('application service selection', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'service-selection-'));
  const admin: any = { id: 'admin', username: 'admin', displayName: 'admin', active: true, role: 'admin' };
  let ios: any;
  let android: any;
  beforeAll(() => {
    closeDatabase(); process.env.DB_PATH = path.join(temp, 'test.sqlite'); initializeDatabase();
    ios = applicationService.list('nn')[0];
    android = applicationService.create('nn', { platform: 'android', name: 'Android', packageId: 'com.test.app' });
  });
  beforeEach(() => {
    applicationService.update('nn', ios.id, { services: defaultApplicationServices('ios', 'nn') });
    applicationService.update('nn', android.id, { services: defaultApplicationServices('android', 'nn') });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => { closeDatabase(); delete process.env.DB_PATH; fs.rmSync(temp, { recursive: true, force: true }); });
  const context = (application: any) => ({ ...authService.findProductLine('nn')!, application, role: 'admin' as const });
  it('keeps NN iOS Sentry separate from Android Bugly and preserves app-specific options', () => {
    const selected = applicationService.update('nn', android.id, { services: ['bugly'], serviceOptions: { bugly: { appId: 'android-app', consoleUrl: 'https://bugly.qq.com/v2/workbench/apps' } } });
    expect(selected.services).toEqual(['bugly']);
    expect(applicationService.get(ios.id, 'nn')?.services).toContain('sentry');
    expect(applicationService.get(ios.id, 'nn')?.serviceOptions?.bugly).toBeUndefined();
    const disabled = applicationService.update('nn', android.id, { services: [] });
    expect(disabled.serviceOptions?.bugly?.appId).toBe('android-app');
  });
  it('supports Bugly on iOS without forcing Sentry, and rejects incompatible or unknown services', () => {
    expect(applicationService.update('nn', ios.id, { services: ['bugly', 'podx'] }).services).toEqual(['bugly', 'podx']);
    expect(() => applicationService.update('nn', android.id, { services: ['podx'] })).toThrow('不支持');
    expect(() => applicationService.update('nn', ios.id, { services: ['sentry', 'bugly'] })).toThrow('一个主崩溃');
    expect(() => applicationService.update('nn', ios.id, { services: ['unknown'] })).toThrow('不支持');
    expect(() => applicationService.update('nn', ios.id, { services: null })).toThrow('数组');
    expect(() => applicationService.update('nn', ios.id, { services: ['quality'] })).toThrow('同时启用');
  });
  it('does not demand or advertise Android delivery when only Bugly is selected', () => {
    const app = applicationService.update('nn', android.id, { services: ['bugly'] });
    runWithProductLine(context(app), () => {
      expect(new AndroidDeliveryService().readiness()).toMatchObject({ buildEnabled: false, qualityEnabled: false, configured: false, missing: [], supported: [] });
    });
  });
  it('requires only build configuration for Jenkins-only Android applications', () => {
    jest.spyOn(externalServices, 'getJenkinsConfig').mockReturnValue({ baseUrl: 'https://jenkins.example', username: 'test', token: 'fixture', jobName: '', qualityJobName: '', repoUrl: '' });
    const app = applicationService.update('nn', android.id, { services: ['jenkins'], config: {
      repositoryUrl: 'https://git.example/app.git', buildJob: 'android/build', buildVariant: 'debug', apkPath: 'app/build/app.apk', qualityJob: '', deviceSerial: '',
    } });
    runWithProductLine(context(app), () => {
      const service = new AndroidDeliveryService();
      expect(service.readiness()).toMatchObject({ buildEnabled: true, qualityEnabled: false, configured: true, missing: [], supported: ['apk'] });
      applicationService.update('nn', android.id, { services: ['jenkins', 'quality', 'devices'] });
      expect(service.readiness().missing).toEqual(['qualityJob', 'deviceSerial']);
    });
  });
  it('does not reenable an explicitly empty selection when migrations run again', () => {
    applicationService.update('nn', ios.id, { services: [] });
    initializeDatabase(); expect(applicationService.get(ios.id, 'nn')?.services).toEqual([]);
    getDatabase().prepare('UPDATE platform_applications SET services_json = NULL WHERE id = ?').run(ios.id);
    expect(applicationService.get(ios.id, 'nn')?.services).toContain('sentry');
  });
  it('starts a new product with no selected iOS services and keeps different products independent', () => {
    const product = authService.createProductLine({ name: 'Independent services' })!;
    const other = applicationService.list(product.id)[0]; expect(other.services).toEqual([]);
    applicationService.update(product.id, other.id, { services: ['bugly'] });
    expect(applicationService.get(ios.id, 'nn')?.services).toContain('sentry');
    expect(() => applicationService.update(product.id, ios.id, { services: [] })).toThrow('不存在');
  });
  it('rejects credentials and unsafe console URLs without leaking them into configuration', () => {
    for (const consoleUrl of ['javascript:alert(1)', 'https://user:secret@bugly.qq.com', 'https://bugly.qq.com/?%74oken=secret', 'https://bugly.qq.com/#/app?api_key=secret']) {
      expect(() => applicationService.update('nn', android.id, { serviceOptions: { bugly: { consoleUrl } } })).toThrow();
    }
    expect(() => applicationService.update('nn', android.id, { serviceOptions: { bugly: { token: 'secret' } } })).toThrow();
  });
  it('blocks direct API access to disabled services and leaves enabled services available', async () => {
    jest.spyOn(authService, 'getSessionUser').mockReturnValue(admin);
    applicationService.update('nn', ios.id, { services: ['jenkins'] });
    const app = express(); app.use('/api', productLineContextMiddleware, selectedServiceMiddleware);
    app.get('/api/sentry-analysis/issues', (_req, res) => res.json({ called: true }));
    app.get('/api/pods/list', (_req, res) => res.json({ called: true }));
    app.get('/api/jenkins/nn/builds', (_req, res) => res.json({ called: true }));
    app.get('/api/jenkins/nn/quality/builds', (_req, res) => res.json({ called: true }));
    for (const endpoint of ['/api/sentry-analysis/issues', '/api/pods/list', '/api/jenkins/nn/quality/builds']) {
      const response = await request(app).get(endpoint).set('X-Application-Id', ios.id);
      expect(response.status).toBe(409); expect(response.body.code).toBe('APPLICATION_SERVICE_DISABLED');
    }
    expect((await request(app).get('/api/jenkins/nn/builds').set('X-Application-Id', ios.id)).status).toBe(200);
  });
  it('rechecks service revocation even with a stale application context or pending AI tool', () => {
    const tool = assistantToolRegistry.get('cicd_trigger_build')!;
    runWithProductLine(context(ios), () => {
      expect(assistantToolRegistry.assertAllowed(tool.name, admin)).toBe(tool);
      applicationService.update('nn', ios.id, { services: [] });
      expect(hasCurrentApplicationServices('jenkins')).toBe(false);
      expect(() => assistantToolRegistry.assertExecutable(tool, {}, { user: admin })).toThrow('未启用');
      expect(assistantToolRegistry.listForUser(admin).some((item) => item.name.startsWith('sentry_'))).toBe(false);
    });
  });
  it('hides composite tools when one dependency is disabled without hiding independent tools', () => {
    applicationService.update('nn', ios.id, { services: ['jenkins'] });
    runWithProductLine(context(ios), () => {
      const names = assistantToolRegistry.listForUser(admin).map((item) => item.name);
      expect(names).toContain('cicd_list_builds'); expect(names).not.toContain('quality_daily_report'); expect(names).not.toContain('cicd_verify_build');
    });
  });
  it('skips background synchronization for a disabled provider without sending HTTP requests', async () => {
    applicationService.update('nn', ios.id, { services: [] });
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('must not call external services'));
    await runWithProductLine(context(ios), async () => {
      expect(await platformOperationsService.runSync('sentry')).toMatchObject({ skipped: true });
      expect(await platformOperationsService.runSync('pods')).toMatchObject({ skipped: true });
      await platformOperationsService.runAllSyncs();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('does not claim old Sentry risk evidence is clear after switching to Bugly', () => {
    applicationService.update('nn', ios.id, { services: ['bugly', 'workflow'] });
    const riskSpy = jest.spyOn(crashGovernanceService, 'listOpenRisksByVersion').mockReturnValue([]);
    runWithProductLine(context(ios), () => {
      const gate = qualityGateService.preview({ buildNumber: '10', appVersion: '1.0', tasks: [], issues: [], buildStatus: 'success', policy: { requiredSuites: [] } });
      expect(JSON.stringify(gate)).toContain('crash_provider_unavailable');
      expect(JSON.stringify(gate)).not.toContain('crash_governance_clear');
    });
    expect(riskSpy).not.toHaveBeenCalled();
  });
});
