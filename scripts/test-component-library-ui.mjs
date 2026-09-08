// Isolated UI fixtures: no real repository, publishing, or library configuration is changed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.SERVICES_UI_BASE_URL || 'http://127.0.0.1:5173';
const apps = ['nn', 'beta'].map((id) => ({ id: `${id}:ios`, productLineId: id, platform: 'ios', name: `${id.toUpperCase()} iOS`, projectId: `${id}-ios`, packageId: '', active: true, services: ['podx'], serviceOptions: {}, componentLibraryId: `ios:${id}`, config: {} }));
const products = apps.map((app) => ({ id: app.productLineId, key: app.productLineId, name: app.productLineId.toUpperCase(), projectId: app.projectId, role: 'admin', active: true, applications: [app] }));
const libraries = products.map((product) => ({ id: `ios:${product.id}`, name: `${product.name} · iOS 组件库`, platform: 'ios', configProductLineId: product.id }));
const user = { id: 'fixture-admin', username: 'admin', displayName: '管理员', active: true, role: 'admin', productLines: products };
const shared = { id: 1, name: 'SharedCore', version: '1.0.0', status: 'published', summary: '跨产品线共用的 iOS 组件', source_zip_url: 'https://nexus.example/SharedCore/1.0.zip', podspec_content: '', upload_time: '2026-09-08T01:00:00Z' };
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1550, height: 1050 } });
  const errors = []; const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('active_product_line_id', 'beta'));
  await page.route('**/api/**', async (route) => {
    const req = route.request(); const pathname = new URL(req.url()).pathname;
    requests.push({ path: pathname, method: req.method(), app: req.headers()['x-application-id'] });
    const active = apps.find((app) => app.id === req.headers()['x-application-id']) || apps[1];
    let data = [];
    if (pathname === '/api/auth/me') data = { user };
    else if (pathname === '/api/auth/component-libraries') data = libraries;
    else if (pathname === '/api/auth/product-lines/beta/applications') data = [apps[1]];
    else if (req.method() === 'PATCH' && pathname === '/api/auth/product-lines/beta/applications/beta%3Aios') { Object.assign(apps[1], req.postDataJSON()); data = apps[1]; }
    else if (pathname === '/api/pods/library') { const library = libraries.find((item) => item.id === active.componentLibraryId); data = { ...library, shared: apps.filter((app) => app.componentLibraryId === library.id).length > 1, applications: apps.filter((app) => app.componentLibraryId === library.id) }; }
    else if (pathname === '/api/pods/list') data = active.componentLibraryId === 'ios:nn' ? [shared] : [];
    await route.fulfill({ json: { success: true, data } });
  });
  await page.goto(`${base}/applications`, { waitUntil: 'networkidle' });
  await page.getByRole('row').filter({ hasText: 'BETA iOS' }).getByRole('button', { name: '选配服务' }).click();
  await page.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: '共用组件库' }) }).locator('.ant-select-selector').click();
  await page.locator('.ant-select-item-option-content').getByText('NN · iOS 组件库', { exact: true }).click();
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(apps[1].componentLibraryId, 'ios:nn');
  assert.equal(apps[0].componentLibraryId, 'ios:nn');
  await page.goto(`${base}/pods`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /组件库/ }).waitFor();
  await page.getByText('NN · iOS 组件库 · 多个产品线共用', { exact: true }).waitFor();
  await page.getByText('SharedCore', { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('menuitem', { name: /组件库/ }).count(), 1);
  assert.equal(requests.some((req) => req.path === '/api/pods/list' && req.app === 'beta:ios'), true);
  if (process.env.COMPONENT_LIBRARY_SCREENSHOT) await page.screenshot({ path: process.env.COMPONENT_LIBRARY_SCREENSHOT, fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Component library UI passed: rename, cross-product library selection, shared catalog and scope; fixture APIs only.');
} finally { await browser.close(); }
