import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authUtils, type AuthUser, type MobileApplication } from './auth';
const application = (id: string, productLineId: string, platform: 'ios' | 'android'): MobileApplication => ({ id, productLineId, platform, name: id, projectId: id, packageId: `com.test.${id}`, active: true, config: { repositoryUrl: '', buildJob: '', qualityJob: '', buildVariant: 'debug', apkPath: '', deviceSerial: '' } });
const user: AuthUser = { id: 'user', username: 'user', displayName: 'user', active: true, role: 'admin', productLines: [
  { id: 'nn', key: 'nn', name: 'NN', projectId: 'nn-ios', active: true, role: 'admin', applications: [application('ios', 'nn', 'ios'), application('android', 'nn', 'android')] },
  { id: 'beta', key: 'beta', name: 'Beta', projectId: 'beta-ios', active: true, role: 'admin', applications: [application('beta-ios', 'beta', 'ios')] },
] };
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
  vi.stubGlobal('document', { cookie: '' }); vi.stubGlobal('window', new EventTarget());
  authUtils.setUser(user);
});
afterEach(() => vi.unstubAllGlobals());
describe('active application selection', () => {
  it('allows a developer to release to the store only in the granted product', () => {
    authUtils.setUser({ ...user, role: 'developer', productLines: user.productLines.map((product) => ({ ...product, role: 'developer', appStoreRelease: product.id === 'nn' })) });
    expect(authUtils.canReleaseAppStore()).toBe(true);
    authUtils.setActiveProductLine('beta'); expect(authUtils.canReleaseAppStore()).toBe(false);
    authUtils.clearUser(); expect(authUtils.canReleaseAppStore()).toBe(false);
  });
  it('defaults legacy users to iOS and remembers per-product application selections', () => {
    expect(authUtils.getActiveApplication()?.id).toBe('ios');
    expect(authUtils.setActiveApplication('android')).toBe(true);
    expect(document.cookie).toContain('active_application_id=android');
    authUtils.setActiveProductLine('beta');
    expect(authUtils.getActiveApplication()?.id).toBe('beta-ios');
    expect(document.cookie).toContain('active_application_id=beta-ios');
    authUtils.setActiveProductLine('nn'); expect(authUtils.getActiveApplication()?.id).toBe('android');
  });
  it('cannot select another product application and clears the context cookie on logout', () => {
    expect(authUtils.setActiveApplication('beta-ios')).toBe(false);
    authUtils.clearUser(); expect(authUtils.getActiveApplication()).toBeNull(); expect(document.cookie).toContain('Max-Age=0');
  });
  it('falls back to an owned active application when a persisted selection becomes stale', () => {
    localStorage.setItem('active_application:nn', 'foreign-app');
    authUtils.setUser(user); expect(authUtils.getActiveApplication()?.id).toBe('ios'); expect(document.cookie).toContain('active_application_id=ios');
  });
  it('supports pre-migration authentication fixtures without application lists', () => {
    authUtils.setUser({ ...user, productLines: user.productLines.map(({ applications, ...product }) => product) });
    expect(authUtils.getActiveApplication()).toBeNull(); expect(document.cookie).toContain('Max-Age=0');
  });
});
