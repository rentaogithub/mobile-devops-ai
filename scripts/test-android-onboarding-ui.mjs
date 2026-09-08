// All APIs are intercepted. This test never triggers a real build or installs an APK.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const baseURL = process.env.ANDROID_UI_BASE_URL || 'http://127.0.0.1:5173';
const ios = { id: 'nn:ios', productLineId: 'nn', platform: 'ios', name: 'NN iOS', packageId: '', projectId: 'nn-ios', active: true, config: {} };
const product = { id: 'nn', key: 'nn', name: 'NN', projectId: 'nn-ios', active: true, role: 'admin', applications: [ios] };
const user = { id: 'ui-admin', username: 'ui-admin', displayName: '管理员', role: 'admin', active: true, productLines: [product] };
const runs = [];
const requests = [];
let gatePassed = false;
let corruptDownload = true;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1200 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => { localStorage.removeItem('auth_user'); });
  await page.route('**/api/**', async (route) => {
    const req = route.request(); const url = new URL(req.url()); const pathname = url.pathname;
    requests.push({ path: pathname, method: req.method(), app: req.headers()['x-application-id'] });
    let data = [];
    if (pathname === '/api/auth/me') data = { user };
    else if (pathname === '/api/auth/product-lines/nn/applications') {
      if (req.method() === 'POST') { const body = req.postDataJSON(); product.applications.push({ ...body, id: 'nn-android', productLineId: 'nn', projectId: 'nn-ios:android', active: true }); }
      data = product.applications;
    } else if (pathname === '/api/android/readiness') data = { configured: true, missing: [], acceptance: 'pending_external_validation' };
    else if (pathname === '/api/android/runs' && req.method() === 'GET') data = runs;
    else if (pathname === '/api/android/runs' && req.method() === 'POST') {
      const body = req.postDataJSON(); assert.equal(req.headers()['x-application-id'], 'nn-android');
      assert.match(body.requestKey, /^[\w-]{8,100}$/);
      if (body.kind === 'build') assert.equal(body.commit, 'a'.repeat(40));
      const run = { id: `run-${runs.length + 1}`, kind: body.kind, status: 'queued', jobName: `android/${body.kind}`, createdAt: new Date().toISOString(), config: { commit: 'a'.repeat(40), sourceRunId: body.sourceRunId }, result: {} };
      runs.unshift(run); data = run;
    } else if (pathname.endsWith('/sync')) { data = runs.find((run) => pathname.includes(`/${run.id}/`)); data.status = 'passed'; data.buildNumber = 12; if (data.kind === 'smoke') gatePassed = true; }
    else if (pathname.endsWith('/gate')) data = { passed: gatePassed, reason: gatePassed ? 'Smoke 已通过' : '需要最近一次同源 Smoke 通过' };
    else if (pathname.endsWith('/download')) { assert.equal(gatePassed, true); if (corruptDownload) { corruptDownload = false; return route.fulfill({ status: 409, json: { success: false, error: 'APK SHA256 不匹配，已阻止下载' } }); } return route.fulfill({ body: Buffer.from('APK-fixture'), headers: { 'content-type': 'application/vnd.android.package-archive' } }); }
    return route.fulfill({ json: { success: true, data } });
  });
  await page.goto(`${baseURL}/applications`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '接入 Android 应用' }).click();
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await page.getByLabel('应用名称', { exact: true }).fill('NN Android');
  await page.getByLabel('applicationId（创建后不可修改）', { exact: true }).fill('com.test.android');
  await page.getByLabel('Git 仓库 URL（HTTPS / SSH，无密码）', { exact: true }).fill('https://git.example/app.git');
  await page.getByLabel('Jenkins APK 构建 Job', { exact: true }).fill('android/build');
  await page.getByLabel('Jenkins Smoke Job', { exact: true }).fill('android/smoke');
  await page.getByLabel('APK 相对路径', { exact: true }).fill('app/build/app.apk');
  await page.getByLabel('Android 测试设备序列号', { exact: true }).fill('test-device');
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await page.getByRole('row').filter({ hasText: 'NN Android' }).getByRole('button', { name: '进入应用' }).click();
  await page.getByRole('heading', { name: 'Android 交付 · NN Android' }).waitFor();
  assert.equal(await page.getByText('组件库', { exact: true }).count(), 0);
  await page.getByRole('textbox', { name: 'Git Commit' }).fill('a'.repeat(40));
  await page.getByRole('button', { name: '构建 APK', exact: true }).click();
  await page.getByText('排队中', { exact: true }).waitFor();
  await page.getByRole('button', { name: '同步状态' }).click();
  await page.getByText('证据通过', { exact: true }).waitFor();
  await page.getByRole('button', { name: '校验并下载' }).click();
  await page.getByText('需要最近一次同源 Smoke 通过', { exact: true }).waitFor();
  assert.equal(requests.filter((req) => req.path.endsWith('/download')).length, 0);
  await page.getByRole('button', { name: '安装 Smoke' }).click();
  await page.getByRole('button', { name: '开始安装' }).click();
  await page.getByRole('row').filter({ hasText: 'android/smoke' }).getByRole('button', { name: '同步状态' }).click();
  await page.getByRole('button', { name: '校验并下载' }).click();
  await page.getByText('APK SHA256 不匹配，已阻止下载', { exact: true }).waitFor();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '校验并下载' }).click();
  const download = await downloading; assert.match(download.suggestedFilename(), /com.test.android.*\.apk/);
  if (process.env.ANDROID_UI_SCREENSHOT) await page.screenshot({ path: process.env.ANDROID_UI_SCREENSHOT, fullPage: true });
  const checkpoint = requests.length;
  await page.goto(`${baseURL}/cicd`, { waitUntil: 'networkidle' });
  assert.match(page.url(), /\/android$/);
  assert.equal(requests.slice(checkpoint).some((req) => req.path.startsWith('/api/jenkins')), false);
  assert.deepEqual(errors, []);
  console.log('Android UI passed: application onboarding, platform navigation, scoped requests, build/Smoke flow, gated download. API fixtures only.');
} finally { await browser.close(); }
