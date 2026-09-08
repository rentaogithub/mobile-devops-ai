// Run against a local Vite server. All API traffic is intercepted with fixtures.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseURL = process.env.DELIVERY_UI_BASE_URL || 'http://127.0.0.1:5173';
const products = [
  { id: 'nn', key: 'nn', name: 'NN', projectId: 'nn-ios', active: true, role: 'admin' },
  { id: 'beta', key: 'beta', name: 'Beta', projectId: 'beta-ios', active: true, role: 'admin' },
];
const user = { id: 'ui-admin', username: 'ui-admin', displayName: '验收用户', role: 'admin', active: true, productLines: products };
const fixture = {
  projectId: 'nn-ios', buildNumber: '101', status: 'blocked',
  summary: '交付存在阻断项，请先处理下列证据与问题', evaluatedAt: '2026-09-07T10:00:00Z',
  limitations: ['依据当前产品线已同步快照，不能替代 Jenkins 发布前实时复核。', '发布观察按版本聚合，回归候选仍需核对执行构建。'],
  context: { commitHash: 'abc123', branch: 'release/1.0.0', releaseVersion: '1.0.0', updatedAt: '2026-09-07T09:58:00Z' },
  counts: { artifacts: 1, tasks: 2, issues: 1, openIssues: 1, candidates: 0 },
  stages: [
    { key: 'lineage', title: '变更与产物', status: 'passed', summary: '分支 release/1.0.0 · Commit abc123', evidenceIds: ['artifact-101'] },
    { key: 'build', title: '构建', status: 'passed', summary: '源构建状态：passed', evidenceIds: ['build-101'] },
    { key: 'quality', title: '质量验证', status: 'blocked', summary: '必需套件：smoke；1 项验证阻断', evidenceIds: ['smoke-101'] },
    { key: 'issues', title: '问题处理', status: 'blocked', summary: '1 个开放问题，1 个阻断级问题', evidenceIds: ['issue-101'] },
    { key: 'regression', title: '回归闭环', status: 'warning', summary: '1 个问题尚无已验证回归候选', evidenceIds: [] },
    { key: 'observation', title: '发布观察', status: 'unknown', summary: '版本 1.0.0 · 0 条观察 · unknown', evidenceIds: [] },
  ],
  actions: [
    { code: 'suite_failed:smoke', priority: 'P0', title: 'Smoke 套件未通过', reason: '对照当前源构建执行或复核质检，完成后重新诊断。', target: 'cicd', evidenceIds: ['smoke-101'] },
    { code: 'open_issues', priority: 'P0', title: '处理关联问题', reason: '检查问题证据、负责人和修复建议。', target: 'issues', evidenceIds: ['issue-101'] },
    { code: 'regression_missing', priority: 'P1', title: '补齐确定性回归', reason: '从 Issue 生成候选并验证；生成代码和独立编译均不等于执行通过。', target: 'regression', evidenceIds: ['issue-101'] },
    { code: 'release_observation', priority: 'P2', title: '核实版本发布观察', reason: '尚无发布观察指标，无法确认版本健康。', target: 'evolution', evidenceIds: [] },
  ],
  gate: { id: 'gate-preview', buildNumber: '101', status: 'blocked', score: 50, result: { summary: '发布被阻断：2 项阻断问题' }, createdAt: '2026-09-07T10:00:00Z' },
  evidence: { artifacts: [], tasks: [{ id: 'build-101', suite: 'build', status: 'passed', commitHash: 'abc123' }, { id: 'smoke-101', suite: 'smoke', status: 'failed', commitHash: 'abc123' }], issues: [], candidates: [] },
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1280 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((user) => {
    localStorage.setItem('auth_user', JSON.stringify(user));
    localStorage.setItem('active_product_line_id', 'nn');
  }, user);
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/delivery/999')) return route.fulfill({ status: 500, json: { success: false, error: '诊断服务暂不可用' } });
    const data = pathname === '/api/auth/me' ? { user }
      : pathname.includes('/delivery/') ? fixture
        : pathname.endsWith('/overview') ? { latestTasks: [], latestIssues: [] }
          : [];
    return route.fulfill({ json: { success: true, data } });
  });
  await page.goto(`${baseURL}/workflow`, { waitUntil: 'networkidle' });
  const input = page.getByRole('textbox', { name: 'Jenkins 源构建号' });
  const submit = page.getByRole('button', { name: '诊断交付链路' });
  await input.fill('abc');
  await submit.click();
  await page.getByText('请输入 1 至 12 位正整数', { exact: true }).waitFor();
  await input.fill('101');
  await submit.click();
  await page.getByText('构建 #101 · 交付存在阻断项，请先处理下列证据与问题').waitFor();
  await page.getByText('请输入 1 至 12 位正整数', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByText('证据不足', { exact: true }).count(), 1);
  if (process.env.DELIVERY_UI_SCREENSHOT) await page.screenshot({ path: process.env.DELIVERY_UI_SCREENSHOT, fullPage: true });
  await page.getByRole('row').filter({ hasText: '补齐确定性回归' }).getByRole('button', { name: '前往处理' }).click();
  assert.equal(await page.getByRole('tab', { name: '回归候选（0）' }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: '交付诊断', exact: true }).click();
  await input.fill('999');
  await submit.click();
  await page.getByText('诊断服务暂不可用', { exact: true }).waitFor();
  assert.equal(await page.getByText('构建 #101 · 交付存在阻断项，请先处理下列证据与问题').count(), 0);
  await input.fill('101');
  await submit.click();
  await page.getByText('构建 #101 · 交付存在阻断项，请先处理下列证据与问题').waitFor();
  await page.locator('.ant-select-selector').first().click();
  await page.locator('.ant-select-item-option-content').getByText('Beta', { exact: true }).click();
  await page.getByText('输入源构建号，查看当前产品线的交付证据', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '');
  assert.deepEqual(errors, []);
  console.log('Delivery UI passed: validation, evidence, navigation, failed refresh, product switch; API fixtures only.');
} finally {
  await browser.close();
}
