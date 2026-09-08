// All APIs are mocked; this never grants a real account permission or starts a release.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.SERVICES_UI_BASE_URL || 'http://127.0.0.1:5173';
const products = ['nn', 'beta'].map((id) => ({ id, key: id, name: id === 'nn' ? 'NN' : 'Beta', projectId: `${id}-ios`, active: true, applications: [{ id: `${id}:ios`, productLineId: id, platform: 'ios', name: `${id} iOS`, projectId: `${id}-ios`, active: true, services: ['jenkins'], config: {} }] }));
const developer = { id: 'developer', username: 'release.dev', displayName: '研发', role: 'developer', active: true, productLines: products.map((product) => ({ ...product, role: 'developer', appStoreRelease: false })) };
const admin = { id: 'admin', username: 'admin', displayName: '管理员', role: 'admin', active: true, productLines: products.map((product) => ({ ...product, role: 'admin' })) };
let session = admin;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const req = route.request(); const pathname = new URL(req.url()).pathname;
    let data = [];
    if (pathname === '/api/auth/me') data = { user: session };
    else if (pathname === '/api/auth/users') data = [developer];
    else if (pathname === '/api/auth/product-lines') data = products;
    else if (pathname === '/api/auth/users/developer' && req.method() === 'PATCH') {
      const body = req.postDataJSON();
      developer.productLines = body.productLines.map((item) => ({ ...products.find((product) => product.id === item.productLineId), role: item.role, appStoreRelease: item.appStoreRelease }));
      data = developer;
    } else if (pathname.endsWith('/nn/builds')) data = { builds: [], stats: { total: 0, running: 0, latestBuild: '-', successRate: '0%' }, job: { name: 'fixture', fullName: 'fixture', url: 'https://jenkins.example/job/fixture', buildable: true } };
    else if (pathname.endsWith('/nn/branches')) data = ['develop', 'release/1.0.0'];
    else if (pathname.endsWith('/release/preflight')) data = { passed: true, blockers: [], warnings: [], checks: [] };
    else if (pathname.endsWith('/cicd/health')) data = { healthy: true, blockers: [], warnings: [], checks: [], checkedAt: '2026-09-08', elapsedMs: 0 };
    else if (pathname.endsWith('/config/status')) data = {};
    await route.fulfill({ json: { success: true, data } });
  });
  await page.goto(`${base}/roles`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: '用户角色', exact: true }).click();
  await page.getByRole('row').filter({ hasText: 'release.dev' }).getByRole('button', { name: /编\s*辑/ }).click();
  await page.getByRole('checkbox', { name: 'NN 应用商店发布权限', exact: true }).check();
  assert.equal(await page.getByRole('checkbox', { name: 'Beta 应用商店发布权限', exact: true }).isChecked(), false);
  await page.waitForFunction(() => document.querySelector('input[aria-label="NN 应用商店发布权限"]')?.checked);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (process.env.STORE_GRANT_SCREENSHOT) await page.screenshot({ path: process.env.STORE_GRANT_SCREENSHOT, fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: /保\s*存/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(developer.productLines[0].appStoreRelease, true);
  assert.equal(developer.productLines[1].appStoreRelease, false);
  session = developer;
  for (const [product, allowed] of [['nn', true], ['beta', false]]) {
    await page.evaluate((id) => localStorage.setItem('active_product_line_id', id), product);
    await page.goto(`${base}/cicd`, { waitUntil: 'networkidle' });
    const permissions = await page.evaluate(async () => (await import('/src/pages/cicd/cicdPermissions.ts')).getCicdPermissions());
    assert.equal(permissions.canPublishAppStore, allowed);
    assert.equal(permissions.canPublishPgyerOrTestFlight, true);
    assert.equal(permissions.canAdminCicd, false);
    await page.getByRole('button', { name: /发\s*布/ }).click({ timeout: 5000 });
    const modal = page.getByRole('dialog', { name: '选择发布分支和渠道' });
    await modal.waitFor();
    assert.equal(await modal.getByText('苹果商店', { exact: true }).count(), allowed ? 1 : 0);
    await modal.getByRole('button', { name: /取\s*消/ }).click();
  }
  assert.deepEqual(errors, []);
  console.log('Store release grant UI passed: per-product admin grant, developer channel selection, product switch, no admin escalation; fixtures only.');
} finally { await browser.close(); }
