// Service-selection UI acceptance. All APIs are fixtures; no provider is contacted.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.SERVICES_UI_BASE_URL || 'http://127.0.0.1:5173';
const apps = [
  { id: 'ios', productLineId: 'nn', platform: 'ios', name: 'NN iOS', projectId: 'nn-ios', packageId: '', active: true, services: ['sentry', 'podx', 'jenkins', 'devices', 'quality', 'dsym'], serviceOptions: {}, config: {} },
  { id: 'android', productLineId: 'nn', platform: 'android', name: 'NN Android', projectId: 'nn-android', packageId: 'com.test.android', active: true, services: ['bugly'], serviceOptions: { bugly: { appId: 'fixture-app', consoleUrl: 'https://bugly.qq.com/v2/workbench/apps' } }, config: {} },
];
const product = { id: 'nn', key: 'nn', name: 'NN', projectId: 'nn-ios', role: 'admin', active: true, applications: apps };
const user = { id: 'tester', username: 'admin', displayName: 'admin', active: true, role: 'admin', productLines: [product] };
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1550, height: 1050 } });
  const errors = []; const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const request = route.request(); const url = new URL(request.url()); requests.push(url.pathname);
    let data = [];
    if (url.pathname === '/api/auth/me') data = { user };
    else if (url.pathname === '/api/auth/product-lines/nn/applications') data = apps;
    else if (request.method() === 'PATCH' && url.pathname.startsWith('/api/auth/product-lines/nn/applications/')) {
      const app = apps.find((app) => url.pathname.endsWith('/' + app.id)); Object.assign(app, request.postDataJSON()); data = app;
    }
    await route.fulfill({ json: { success: true, data } });
  });
  await page.goto(`${base}/applications`, { waitUntil: 'networkidle' });
  await page.getByRole('row').filter({ hasText: 'NN iOS' }).getByRole('button', { name: '选配服务' }).click();
  assert.equal(await page.getByRole('checkbox', { name: 'Sentry', exact: true }).isChecked(), true);
  for (const label of ['组件库（Podx）', 'Jenkins CI/CD', '真机服务', '自动质检', 'dSYM 与本地符号化']) {
    const checkbox = page.getByRole('checkbox', { name: label, exact: true }); if (await checkbox.isChecked()) { await checkbox.click(); await page.waitForFunction((value) => !document.querySelector(`input[value="${value}"]`)?.checked, await checkbox.getAttribute('value')); }
  }
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(apps[0].services, ['sentry']); assert.deepEqual(apps[1].services, ['bugly']);
  const checkpoint = requests.length;
  await page.goto(`${base}/pods`, { waitUntil: 'networkidle' });
  assert.match(page.url(), /\/services$/);
  assert.equal(requests.slice(checkpoint).some((path) => path.startsWith('/api/pods')), false);
  await page.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: '当前应用' }) }).locator('.ant-select-selector').click();
  await page.locator('.ant-select-item-option-content').getByText('Android', { exact: true }).click();
  await page.getByRole('heading', { name: '应用服务 · NN Android' }).waitFor();
  const consoleLink = page.getByRole('link', { name: '打开 腾讯 Bugly 控制台' });
  await consoleLink.waitFor(); assert.equal(await consoleLink.getAttribute('href'), 'https://bugly.qq.com/v2/workbench/apps');
  await page.getByText('数据适配待接入', { exact: true }).waitFor();
  assert.equal(await page.getByText('组件库', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('menuitem', { name: 'Android 交付' }).count(), 0);
  if (process.env.SERVICES_UI_SCREENSHOT) await page.screenshot({ path: process.env.SERVICES_UI_SCREENSHOT, fullPage: true });
  const androidCheckpoint = requests.length;
  await page.goto(`${base}/android`, { waitUntil: 'networkidle' }); assert.match(page.url(), /\/services$/);
  assert.equal(requests.slice(androidCheckpoint).some((path) => path.startsWith('/api/android/')), false);
  await page.goto(`${base}/applications`, { waitUntil: 'networkidle' });
  await page.getByRole('row').filter({ hasText: 'NN Android' }).getByRole('button', { name: '选配服务' }).click();
  assert.equal(await page.getByRole('checkbox', { name: /组件库（Podx）.*当前系统不支持/ }).isDisabled(), true);
  await page.getByRole('checkbox', { name: /腾讯 Bugly/ }).click();
  await page.waitForFunction(() => !document.querySelector('input[value="bugly"]')?.checked);
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(apps[1].services, []);
  await page.goto(`${base}/services`, { waitUntil: 'networkidle' });
  await page.getByText('当前应用尚未启用服务，可由管理员按需选配。', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Service selection UI passed: independent providers, optional services, OS restrictions, disabled-route guards, empty selection; API fixtures only.');
} finally { await browser.close(); }
