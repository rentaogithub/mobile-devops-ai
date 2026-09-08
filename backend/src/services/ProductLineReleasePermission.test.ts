import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { closeDatabase, getDatabase, initializeDatabase } from '../database';
import { authService, PlatformUser } from './AuthService';
import { runWithProductLine } from './ProductLineContext';
import { requireAppStoreRelease } from '../middleware/auth';
import { assistantToolRegistry } from './AssistantToolRegistry';

describe('product-scoped developer App Store release grants', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'store-grant-'));
  let beta: any;
  let developer: PlatformUser;
  let admin: PlatformUser;
  beforeAll(() => {
    closeDatabase(); process.env.DB_PATH = path.join(temp, 'test.sqlite'); initializeDatabase();
    beta = authService.createProductLine({ name: 'Beta grants' })!;
    developer = authService.createUser({ username: 'release.dev', displayName: 'Release developer', password: 'fixture-password', role: 'developer', productLines: [
      { productLineId: 'nn', role: 'developer' }, { productLineId: beta.id, role: 'developer' },
    ] })!;
    admin = authService.createUser({ username: 'release.admin', displayName: 'Admin', password: 'fixture-password', role: 'admin' })!;
  });
  beforeEach(() => {
    authService.updateUser(developer.id, { active: true, productLines: [
      { productLineId: 'nn', role: 'developer', appStoreRelease: false }, { productLineId: beta.id, role: 'developer', appStoreRelease: false },
    ] });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => { closeDatabase(); delete process.env.DB_PATH; fs.rmSync(temp, { recursive: true, force: true }); });
  const grantNN = () => authService.setUserProductLines(developer.id, [
    { productLineId: 'nn', role: 'developer', appStoreRelease: true }, { productLineId: beta.id, role: 'developer', appStoreRelease: false },
  ]);
  it('defaults to denied and only grants the specified developer membership', () => {
    expect(authService.canReleaseAppStore(developer.id, 'nn')).toBe(false);
    expect(grantNN()?.productLines?.find((item) => item.id === 'nn')?.appStoreRelease).toBe(true);
    expect(authService.canReleaseAppStore(developer.id, 'nn')).toBe(true);
    expect(authService.canReleaseAppStore(developer.id, beta.id)).toBe(false);
    expect(authService.canReleaseAppStore(developer.id, 'missing')).toBe(false);
    expect(authService.canReleaseAppStore('missing', 'nn')).toBe(false);
  });
  it('preserves grants on unrelated edits and repeated migration, and revokes explicitly', () => {
    grantNN();
    authService.updateUser(developer.id, { displayName: 'Updated', productLines: [{ productLineId: 'nn', role: 'developer' }, { productLineId: beta.id, role: 'developer' }] });
    initializeDatabase();
    expect(authService.canReleaseAppStore(developer.id, 'nn')).toBe(true);
    authService.setUserProductLines(developer.id, [{ productLineId: 'nn', role: 'developer', appStoreRelease: false }]);
    expect(authService.canReleaseAppStore(developer.id, 'nn')).toBe(false);
  });
  it('rejects malformed grants atomically and clears supplemental grants after a role change', () => {
    grantNN();
    expect(() => authService.updateUser(developer.id, { displayName: 'must rollback', productLines: [{ productLineId: 'nn', role: 'tester', appStoreRelease: true }] })).toThrow('仅适用于研发');
    expect(authService.findUserByUsername(developer.username)?.displayName).not.toBe('must rollback');
    expect(() => authService.setUserProductLines(developer.id, [{ productLineId: 'nn', role: 'developer', appStoreRelease: 'true' as any }])).toThrow('布尔值');
    authService.setUserProductLines(developer.id, [{ productLineId: 'nn', role: 'tester' }]);
    authService.setUserProductLines(developer.id, [{ productLineId: 'nn', role: 'developer' }]);
    expect(authService.canReleaseAppStore(developer.id, 'nn')).toBe(false);
  });
  it('keeps product operators and admins allowed and inactive or removed members denied', () => {
    expect(authService.canReleaseAppStore(admin.id, beta.id)).toBe(true);
    authService.setUserProductLines(developer.id, [{ productLineId: beta.id, role: 'product' }]);
    expect(authService.canReleaseAppStore(developer.id, beta.id)).toBe(true);
    expect(authService.canReleaseAppStore(developer.id, 'nn')).toBe(false);
    grantNN(); authService.updateUser(developer.id, { active: false });
    expect(authService.canReleaseAppStore(developer.id, 'nn')).toBe(false);
  });
  it('does not grant store release through a self-registration request', () => {
    const registration = authService.createRegistrationRequest({ username: 'new.developer', displayName: 'New', password: 'new.developer123', requestedRole: 'developer', productLineId: 'nn', appStoreRelease: true } as any)!;
    const result = authService.approveRegistrationRequest(registration.id, admin);
    expect(authService.canReleaseAppStore(result.user!.id, 'nn')).toBe(false);
  });
  it('enforces direct API requests using current membership data despite stale user objects', async () => {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).authUser = developer;
      runWithProductLine({ ...authService.findProductLine(String(req.headers['x-product-line-id'] || 'nn'))!, role: 'developer' }, next);
    });
    app.post('/publish', requireAppStoreRelease, (_req, res) => res.json({ allowed: true }));
    expect((await request(app).post('/publish').send({ appStoreRelease: true })).status).toBe(403);
    grantNN();
    expect((await request(app).post('/publish')).status).toBe(200);
    expect((await request(app).post('/publish').set('X-Product-Line-Id', beta.id)).status).toBe(403);
    authService.setUserProductLines(developer.id, [{ productLineId: 'nn', role: 'developer', appStoreRelease: false }]);
    expect((await request(app).post('/publish')).status).toBe(403);
  });
  it('rechecks AI release grants after revocation without changing Pgyer or TestFlight permissions', () => {
    const tool = assistantToolRegistry.get('cicd_trigger_release')!;
    runWithProductLine({ ...authService.findProductLine('nn')!, role: 'developer' }, () => {
      const check = () => assistantToolRegistry.assertExecutable(tool, { deployTarget: 'AppStore' }, { user: developer });
      expect(check).toThrow('单独授权'); grantNN(); expect(check).not.toThrow();
      authService.setUserProductLines(developer.id, [{ productLineId: 'nn', role: 'developer', appStoreRelease: false }]);
      expect(check).toThrow('单独授权');
      expect(() => assistantToolRegistry.assertExecutable(tool, { deployTarget: 'TestFlight' }, { user: developer })).not.toThrow();
      expect(() => assistantToolRegistry.assertExecutable(tool, { deployTarget: 'Pgyer' }, { user: developer })).not.toThrow();
    });
    expect(getDatabase().prepare('SELECT app_store_release FROM platform_product_line_memberships WHERE user_id = ? AND product_line_id = ?').get(developer.id, 'nn')).toEqual({ app_store_release: 0 });
  });
});
