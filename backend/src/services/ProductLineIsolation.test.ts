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
import { CrashGovernanceService } from './CrashGovernanceService';
import { SymbolicationCacheService } from './SymbolicationCacheService';
import { buildSentryCookieHeader, updateSentryCookieJar } from './SentryCookieJar';

describe('product line isolation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-product-lines-'));
  const auth = new AuthService();
  const workflow = new WorkflowService();
  const crashGovernance = new CrashGovernanceService();
  const symbolicationCache = new SymbolicationCacheService();
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
        JENKINS_NN_REPO_URL: 'https://git.example.com/alpha_ios/alpha-ios.git',
        PODX_PRIVATE_SOURCE: 'https://git.example.com/alpha_ios/nnspec.git',
        PODX_PUBLISH_REPOS: 'alpha-core',
        PODX_PUBLISH_MAIN_REPO: 'alpha-ios',
        PODX_PUBLISH_WORK_DIR: '.mgit-publish/alpha',
        PODX_PUBLISH_BASE_BRANCH: 'develop',
        PGYER_API_KEY: 'alpha-pgyer-key',
        APP_STORE_CONNECT_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nalpha-private-key\n-----END PRIVATE KEY-----',
        APPLE_DEVICE_API_PRIVATE_KEY: 'development-private-key',
        APPLE_DEVICE_TEAM_ID: 'LX4548D2Q6',
        WECHAT_WEBHOOK_URL: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=alpha-webhook-secret',
      }, 'test-admin');

      await runWithProductLine({ ...alpha, role: 'admin' }, async () => {
        expect(getJenkinsBaseUrl()).toBe('https://10.20.30.40:9443/jenkins');
        expect(getJenkinsConfig()).toEqual(expect.objectContaining({
          username: 'alpha-ci',
          token: 'alpha-token',
          jobName: 'alpha/app-build',
          qualityJobName: 'alpha/app-quality',
          repoUrl: 'https://git.example.com/alpha_ios/alpha-ios.git',
        }));
        expect(productLineConfigService.podxConfig()).toEqual(expect.objectContaining({
          targetName: 'alpha_ios',
          privateSource: 'https://git.example.com/alpha_ios/nnspec.git',
          gitBaseUrl: 'https://git.example.com',
          overlayFile: 'Podfile.overlay',
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
        const podxConfigYaml = productLineConfigService.podxConfigYaml();
        expect(podxConfigYaml).toContain('product_line: "alpha"');
        expect(podxConfigYaml).toContain('target_name: "alpha_ios"');
        expect(podxConfigYaml).toContain('private_source: "https://git.example.com/alpha_ios/nnspec.git"');
        expect(podxConfigYaml).toContain('overlay_file: "Podfile.overlay"');
        expect(podxConfigYaml).toContain('publish_main_repo: "alpha-ios"');
        expect(podxConfigYaml).toContain('- "alpha-ios"');
        expect(podxConfigYaml).toContain('jenkins_job: "alpha/app-build"');
        expect(podxConfigYaml).not.toContain('default_product_line');
        expect(podxConfigYaml).not.toContain('product_lines:');
        expect(podxConfigYaml).not.toContain('alpha-token');
        expect(podxConfigYaml).not.toContain('alpha-pgyer-key');
        expect(podxConfigYaml).not.toContain('alpha-private-key');
        expect(podxConfigYaml).not.toContain('alpha-webhook-secret');
        const alphaProjectDir = path.join(tempDir, 'alpha-ios');
        fs.mkdirSync(path.join(alphaProjectDir, '.git'), { recursive: true });
        const syncResult = productLineConfigService.syncPodxConfigToProject(alpha.id, alphaProjectDir);
        expect(syncResult).toEqual(expect.objectContaining({
          projectDirectory: alphaProjectDir,
          configPath: path.join(alphaProjectDir, 'podx.config.yml'),
          cloned: false,
        }));
        expect(fs.readFileSync(syncResult.configPath, 'utf8')).toBe(podxConfigYaml);
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
      expect(adminView.PGYER_API_KEY).toBe('alpha-pgyer-key');
      expect(adminView.APP_STORE_CONNECT_API_PRIVATE_KEYConfigured).toBe(true);
      expect(adminView.APP_STORE_CONNECT_API_PRIVATE_KEY_SOURCE).toBe('产品线加密配置');
      expect(adminView.APP_STORE_CONNECT_API_PRIVATE_KEY_STORAGE).toEqual(expect.stringContaining('platform_product_line_configs'));
      expect(adminView.APP_STORE_CONNECT_API_PRIVATE_KEY_STORAGE).toEqual(expect.stringContaining('platform.sqlite'));
      expect(adminView.WECHAT_WEBHOOK_URLConfigured).toBe(true);
      expect(adminView.WECHAT_WEBHOOK_URL).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=alpha-webhook-secret');
      expect(adminView.WECHAT_WEBHOOK_URL_SOURCE).toBe('产品线加密配置');
      expect(adminView.JENKINS_TOKEN).toBe('alpha-token');
      expect(adminView).not.toHaveProperty('APP_STORE_CONNECT_API_PRIVATE_KEY');
      expect(adminView).not.toHaveProperty('APPLE_DEVICE_API_PRIVATE_KEY');
      expect(adminView.APPLE_DEVICE_API_PRIVATE_KEYConfigured).toBe(true);
      expect(adminView.APPLE_DEVICE_TEAM_ID).toBe('LX4548D2Q6');
      expect(productLineConfigService.get('APPLE_DEVICE_API_PRIVATE_KEY', alpha.id)).toBe('development-private-key');
      const deviceSecret = getDatabase().prepare("SELECT value FROM platform_product_line_configs WHERE product_line_id = ? AND key = 'APPLE_DEVICE_API_PRIVATE_KEY'").get(alpha.id) as { value: string };
      expect(deviceSecret.value).toMatch(/^enc:v1:/);

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
    expect(config.PODX_PRIVATE_SOURCE).toBe('http://git.leigod.top/nn_ios/nnspec.git');
    expect(config.PODX_PUBLISH_MAIN_REPO).toBe('nnios');
    expect(config.PODX_PUBLISH_BASE_BRANCH).toBe('develop');
    expect(String(config.PODX_PUBLISH_REPOS).split('\n')).toHaveLength(11);
    expect(String(config.PODX_PUBLISH_REPOS)).not.toContain('nnios');
    expect(productLineConfigService.podxConfig('nn').publishRepos).toHaveLength(12);
    if (!process.env.JENKINS_USER && !process.env.JENKINS_TOKEN) {
      expect(config.JENKINS_USER).toBe('anonymous');
      expect(config.JENKINS_TOKENConfigured).toBe(false);
    }
  });

  it('keeps an explicitly emptied component repository list instead of restoring defaults', () => {
    productLineConfigService.setMany('nn', { PODX_PUBLISH_REPOS: '' }, 'test-admin');

    const config = productLineConfigService.adminView('nn') as Record<string, unknown>;
    expect(config.PODX_PUBLISH_REPOS).toBe('');
    expect(productLineConfigService.podxConfig('nn').publishRepos).toEqual(['nnios']);
  });

  it('isolates Crash records, Sentry cookies and symbolication cache between product lines', async () => {
    const lineA = auth.createProductLine({ key: 'isolation-a', name: 'Isolation A' })!;
    const lineB = auth.createProductLine({ key: 'isolation-b', name: 'Isolation B' })!;
    const contextA = { ...lineA, role: 'admin' as const };
    const contextB = { ...lineB, role: 'admin' as const };

    await runWithProductLine(contextA, async () => {
      crashGovernance.upsertSentryIssue({ id: 'shared-sentry-id', title: 'A 产品线崩溃', level: 'error' });
      updateSentryCookieJar('sentrysid=line-a-session; Path=/');
      symbolicationCache.set('same crash log', ['same-uuid'], 'line-a-symbolicated');
      expect(crashGovernance.list({ keyword: 'A 产品线崩溃' })).toHaveLength(1);
    });

    await runWithProductLine(contextB, async () => {
      crashGovernance.upsertSentryIssue({ id: 'shared-sentry-id', title: 'B 产品线崩溃', level: 'error' });
      expect(crashGovernance.list({ keyword: 'A 产品线崩溃' })).toHaveLength(0);
      expect(crashGovernance.list({ keyword: 'B 产品线崩溃' })).toHaveLength(1);
      expect(buildSentryCookieHeader()).toBeUndefined();
      expect(symbolicationCache.get('same crash log', ['same-uuid'])).toBeNull();
      updateSentryCookieJar('sentrysid=line-b-session; Path=/');
      symbolicationCache.set('same crash log', ['same-uuid'], 'line-b-symbolicated');
    });

    await runWithProductLine(contextA, async () => {
      expect(buildSentryCookieHeader()).toContain('line-a-session');
      expect(buildSentryCookieHeader()).not.toContain('line-b-session');
      expect(symbolicationCache.get('same crash log', ['same-uuid'])?.symbolicatedLog).toBe('line-a-symbolicated');
      symbolicationCache.clear();
    });

    await runWithProductLine(contextB, async () => {
      expect(buildSentryCookieHeader()).toContain('line-b-session');
      expect(symbolicationCache.get('same crash log', ['same-uuid'])?.symbolicatedLog).toBe('line-b-symbolicated');
    });
  });

  it('rejects explicit Workflow IDs that are already owned by another product line', async () => {
    const lineA = auth.createProductLine({ key: 'workflow-a', name: 'Workflow A' })!;
    const lineB = auth.createProductLine({ key: 'workflow-b', name: 'Workflow B' })!;

    await runWithProductLine({ ...lineA, role: 'admin' }, async () => {
      workflow.createArtifact({ id: 'shared-artifact-id', artifactType: 'ios_app', name: 'A Artifact' });
      workflow.recordEvent({ id: 'shared-event-id', eventType: 'test', entityType: 'artifact', entityId: 'shared-artifact-id' });
    });

    await runWithProductLine({ ...lineB, role: 'admin' }, async () => {
      expect(() => workflow.createArtifact({ id: 'shared-artifact-id', artifactType: 'ios_app', name: 'B Artifact' }))
        .toThrow('Artifact ID 已被其他产品线占用');
      expect(() => workflow.recordEvent({ id: 'shared-event-id', eventType: 'test', entityType: 'artifact', entityId: 'shared-artifact-id' }))
        .toThrow('Workflow 事件 ID 已被其他产品线占用');
      expect(workflow.getArtifact('shared-artifact-id')).toBeNull();
    });
  });
});
