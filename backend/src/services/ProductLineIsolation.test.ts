import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, getDatabase, initializeDatabase } from '../database';
import { AuthService } from './AuthService';
import historyService from './HistoryService';
import { runWithProductLine } from './ProductLineContext';
import { StorageService } from './StorageService';
import { WorkflowService } from './WorkflowService';
import { getJenkinsBaseUrl, getJenkinsConfig } from '../config/externalServices';
import { productLineConfigService } from './ProductLineConfigService';

describe('product line isolation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-product-lines-'));
  const auth = new AuthService();
  const workflow = new WorkflowService();
  let storage: StorageService;

  beforeAll(() => {
    closeDatabase();
    process.env.DB_PATH = path.join(tempDir, 'platform.sqlite');
    initializeDatabase();
    storage = new StorageService();
  });

  afterAll(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.DB_PATH;
  });

  it('keeps memberships, dSYMs, crash history and workflow entities in their product line', async () => {
    const beta = auth.createProductLine({
      key: 'beta',
      name: 'Beta',
      jenkinsBaseUrl: 'http://192.168.50.20:8080/',
    })!;
    const member = auth.createUser({
      username: 'multi.product',
      displayName: '多产品用户',
      password: 'password123',
      role: 'tester',
      productLines: [
        { productLineId: 'nn', role: 'tester' },
        { productLineId: beta.id, role: 'developer' },
      ],
    })!;

    expect(member.productLines).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'nn', role: 'tester' }),
      expect.objectContaining({ id: beta.id, role: 'developer' }),
    ]));

    const betaContext = { ...beta, role: 'developer' as const };
    await runWithProductLine(betaContext, async () => {
      expect(getJenkinsBaseUrl()).toBe('http://192.168.50.20:8080');
      await storage.saveDSYMInfo({
        uuid: '22222222-2222-2222-2222-222222222222',
        appName: 'BetaApp',
        version: '1.0',
        architecture: 'arm64',
        filePath: path.join(tempDir, 'BetaApp.dSYM'),
        fileSize: 1,
      });
      await historyService.saveHistory({
        appVersion: '1.0',
        originalLog: 'beta original crash',
        symbolicatedLog: 'beta symbolicated crash',
        usedUuids: [],
      });
      expect(workflow.upsertTask({ id: 'beta-task', taskType: 'smoke', status: 'passed' })?.projectId).toBe(beta.projectId);
    });

    expect(await storage.getAllDSYMs()).toHaveLength(0);
    expect(historyService.getAllHistoryGroupedByVersion()).toEqual({});
    expect(workflow.getTask('beta-task')).toBeNull();

    await runWithProductLine(betaContext, async () => {
      expect(await storage.getAllDSYMs()).toHaveLength(1);
      expect(historyService.getAllHistoryGroupedByVersion()['1.0']).toHaveLength(1);
      expect(workflow.getTask('beta-task')?.projectId).toBe(beta.projectId);
    });
  });

  it('keeps external service addresses and secrets isolated per product line', async () => {
    const previousJenkinsToken = process.env.JENKINS_TOKEN;
    const previousWeChatWebhook = process.env.WECHAT_WEBHOOK_URL;
    process.env.JENKINS_TOKEN = 'nn-global-token';
    process.env.WECHAT_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=nn-global-secret';

    try {
      const alpha = auth.createProductLine({
        key: 'alpha',
        name: 'Alpha',
        jenkinsBaseUrl: 'https://10.20.30.40:9443/jenkins/',
      })!;
      const empty = auth.createProductLine({ key: 'empty', name: 'Empty' })!;

      productLineConfigService.setMany(alpha.id, {
        JENKINS_USER: 'alpha-ci',
        JENKINS_TOKEN: 'alpha-token',
        JENKINS_NN_JOB: 'alpha/app-build',
        JENKINS_NN_QA_JOB: 'alpha/app-quality',
        JENKINS_NN_REPO_URL: 'https://git.example.com/alpha/ios.git',
        PODX_TARGET_NAME: 'alpha_ios',
        PODX_PRIVATE_SOURCE: 'https://git.example.com/alpha_ios/nnspec.git',
        PODX_GIT_BASE_URL: 'https://git.example.com',
        PODX_OVERLAY_FILE: 'Podfile.overlay.alpha',
        PODX_PUBLISH_REPOS: 'alpha-ios, alpha-core',
        PODX_PUBLISH_MAIN_REPO: 'alpha-ios',
        PODX_PUBLISH_WORK_DIR: '.mgit-publish/alpha',
        PODX_PUBLISH_BASE_BRANCH: 'develop',
        PGYER_API_KEY: 'alpha-pgyer-key',
        APP_STORE_CONNECT_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nalpha-private-key\n-----END PRIVATE KEY-----',
        WECHAT_WEBHOOK_URL: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=alpha-webhook-secret',
      }, 'test-admin');

      await runWithProductLine({ ...alpha, role: 'admin' }, async () => {
        expect(getJenkinsBaseUrl()).toBe('https://10.20.30.40:9443/jenkins');
        expect(getJenkinsConfig()).toEqual(expect.objectContaining({
          username: 'alpha-ci',
          token: 'alpha-token',
          jobName: 'alpha/app-build',
          qualityJobName: 'alpha/app-quality',
          repoUrl: 'https://git.example.com/alpha/ios.git',
        }));
        expect(productLineConfigService.podxConfig()).toEqual(expect.objectContaining({
          targetName: 'alpha_ios',
          privateSource: 'https://git.example.com/alpha_ios/nnspec.git',
          gitBaseUrl: 'https://git.example.com',
          overlayFile: 'Podfile.overlay.alpha',
          publishRepos: ['alpha-ios', 'alpha-core'],
          publishRepoUrls: [
            'https://git.example.com/alpha_ios/alpha-ios.git',
            'https://git.example.com/alpha_ios/alpha-core.git',
          ],
          publishMainRepo: 'alpha-ios',
          publishWorkDir: '.mgit-publish/alpha',
          publishBaseBranch: 'develop',
        }));
        expect(productLineConfigService.podxEnvironment()).toEqual(expect.objectContaining({
          PODX_PRODUCT_LINE: alpha.id,
          PODX_TARGET_NAME: 'alpha_ios',
          PODX_PUBLISH_REPOS: 'alpha-ios,alpha-core',
          JENKINS_NN_JOB: 'alpha/app-build',
        }));
      });

      await runWithProductLine({ ...empty, role: 'admin' }, async () => {
        expect(getJenkinsBaseUrl()).toBe('');
        expect(productLineConfigService.get('WECHAT_WEBHOOK_URL')).toBe('');
        expect(getJenkinsConfig()).toEqual(expect.objectContaining({
          username: '',
          token: '',
          jobName: '',
          qualityJobName: '',
          repoUrl: '',
        }));
      });

      const adminView = productLineConfigService.adminView(alpha.id) as Record<string, unknown>;
      expect(adminView.JENKINS_TOKENConfigured).toBe(true);
      expect(adminView.PGYER_API_KEYConfigured).toBe(true);
      expect(adminView.APP_STORE_CONNECT_API_PRIVATE_KEYConfigured).toBe(true);
      expect(adminView.APP_STORE_CONNECT_API_PRIVATE_KEY_SOURCE).toBe('产品线加密配置');
      expect(adminView.WECHAT_WEBHOOK_URLConfigured).toBe(true);
      expect(adminView.WECHAT_WEBHOOK_URL).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=alpha-webhook-secret');
      expect(adminView.WECHAT_WEBHOOK_URL_SOURCE).toBe('产品线加密配置');
      expect(adminView).not.toHaveProperty('JENKINS_TOKEN');
      expect(adminView).not.toHaveProperty('PGYER_API_KEY');
      expect(adminView).not.toHaveProperty('APP_STORE_CONNECT_API_PRIVATE_KEY');

      const encryptedRows = getDatabase().prepare(`
        SELECT key, value, encrypted FROM platform_product_line_configs
        WHERE product_line_id = ? AND key IN ('JENKINS_TOKEN', 'PGYER_API_KEY', 'WECHAT_WEBHOOK_URL')
      `).all(alpha.id) as Array<{ key: string; value: string; encrypted: number }>;
      expect(encryptedRows).toHaveLength(3);
      encryptedRows.forEach((row) => {
        expect(row.encrypted).toBe(1);
        expect(row.value).toMatch(/^enc:v1:/);
        expect(row.value).not.toContain('alpha-token');
        expect(row.value).not.toContain('alpha-pgyer-key');
        expect(row.value).not.toContain('alpha-webhook-secret');
      });
    } finally {
      if (previousJenkinsToken === undefined) delete process.env.JENKINS_TOKEN;
      else process.env.JENKINS_TOKEN = previousJenkinsToken;
      if (previousWeChatWebhook === undefined) delete process.env.WECHAT_WEBHOOK_URL;
      else process.env.WECHAT_WEBHOOK_URL = previousWeChatWebhook;
    }
  });

  it('generates internal identifiers when creating a product line with only name and bundle id', () => {
    const productLine = auth.createProductLine({
      name: '新 iOS 产品线',
      bundleId: 'com.example.newapp',
    })!;

    expect(productLine.key).toMatch(/^pl-[a-f0-9]{10}$/);
    expect(productLine.projectId).toBe(`${productLine.key}-ios`);
    expect(productLine.bundleId).toBe('com.example.newapp');
  });

  it('shows the effective legacy Jenkins defaults for the nn product line', () => {
    const config = productLineConfigService.adminView('nn') as Record<string, unknown>;
    expect(config.JENKINS_NN_JOB).toBe('nn');
    expect(config.JENKINS_NN_QA_JOB).toBe('nn-auto-quality');
    expect(config.JENKINS_NN_REPO_URL).toBe('http://git.leigod.top/nn_ios/nnios.git');
    if (!process.env.JENKINS_USER && !process.env.JENKINS_TOKEN) {
      expect(config.JENKINS_USER).toBe('anonymous');
      expect(config.JENKINS_TOKENConfigured).toBe(false);
    }
  });
});
