import fs from 'fs';
import os from 'os';
import path from 'path';
import childProcess from 'child_process';
import { closeDatabase, getDatabase, initializeDatabase } from '../database';
import { applicationService } from './ApplicationService';
import { authService } from './AuthService';
import { componentLibraryService, runWithComponentLibrary } from './ComponentLibraryService';
import { productLineConfigService } from './ProductLineConfigService';
import { currentProductLineId, runWithProductLine } from './ProductLineContext';
import { PodService } from './PodService';
import { assistantInsightService } from './AssistantInsightService';

describe('shared component libraries', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'component-library-'));
  let beta: any;
  let ios: any;
  let android: any;
  const pods = new PodService();
  const scoped = <T>(fn: () => T) => runWithProductLine({ ...beta, application: ios, role: 'admin' }, fn);
  beforeAll(() => {
    closeDatabase(); process.env.DB_PATH = path.join(temp, 'test.sqlite'); initializeDatabase();
    // Table setup must not register CocoaPods repos or clean real symbol files.
    jest.spyOn(pods as any, 'ensureSpecRepos').mockResolvedValue(undefined);
    jest.spyOn(pods as any, 'cleanupNNRtcTestDSYMs').mockResolvedValue(undefined);
    pods.initTable();
    beta = authService.createProductLine({ name: 'Beta', key: 'library-beta' })!;
    ios = applicationService.list(beta.id)[0];
    android = applicationService.create(beta.id, { platform: 'android', name: 'Beta Android', packageId: 'com.test.beta' });
    const insert = getDatabase().prepare(`INSERT INTO pods_components (product_line_id,name,version,source_zip_url,podspec_content,status,nnios_branch) VALUES (?, 'SharedCore', '1.0', ?, ?, 'published', 'owner-branch')`);
    insert.run('nn', 'https://nexus.example/SharedCore/1.0.zip', "s.name = 'SharedCore'\ns.dependency 'BaseCore', '~> 1.0'");
    insert.run(beta.id, 'https://beta.example/SharedCore/1.0.zip', "s.name = 'SharedCore'");
    productLineConfigService.setMany('nn', { PODS_NEXUS_BASE_URL: 'https://nexus.example/ios', PODX_PRIVATE_SOURCE: 'https://git.example/shared/specs.git' });
    productLineConfigService.setMany(beta.id, { PODS_NEXUS_BASE_URL: 'https://beta.example/ios', PODX_PRIVATE_SOURCE: 'https://git.example/beta/specs.git', JENKINS_NN_REPO_URL: 'https://git.example/beta/app.git', PODX_PUBLISH_WORK_DIR: '/tmp/beta-project', PODX_PUBLISH_REPOS: 'beta-core' });
  });
  beforeEach(() => {
    ios = applicationService.update(beta.id, ios.id, { services: ['podx'], componentLibraryId: 'ios:nn' });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => { closeDatabase(); delete process.env.DB_PATH; fs.rmSync(temp, { recursive: true, force: true }); });

  it('shares one catalog across products without merging their existing versions', async () => {
    await scoped(async () => {
      expect((await pods.getOne('SharedCore', '1.0'))?.source_zip_url).toBe('https://nexus.example/SharedCore/1.0.zip');
      expect(await pods.getComponentNames()).toEqual(['SharedCore']);
      expect(componentLibraryService.status()).toMatchObject({ id: 'ios:nn', shared: true });
      applicationService.update(beta.id, ios.id, { componentLibraryId: `ios:${beta.id}` });
      expect((await pods.getAll())[0].source_zip_url).toBe('https://beta.example/SharedCore/1.0.zip');
    });
    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM pods_components').get()).toEqual({ count: 2 });
  });
  it('preserves explicit bindings and legacy catalogs through idempotent migrations', () => {
    initializeDatabase(); initializeDatabase();
    expect(applicationService.get(ios.id, beta.id)?.componentLibraryId).toBe('ios:nn');
    expect(applicationService.list('nn')[0].componentLibraryId).toBe('ios:nn');
    expect(componentLibraryService.list()).toHaveLength(2);
  });
  it('rejects unknown and cross-system library bindings without enabling Podx on Android', () => {
    expect(() => applicationService.update(beta.id, ios.id, { componentLibraryId: 'missing' })).toThrow('不存在');
    expect(() => applicationService.update(beta.id, android.id, { componentLibraryId: 'ios:nn' })).toThrow('相同系统');
    expect(() => applicationService.update(beta.id, android.id, { services: ['podx'] })).toThrow('不支持');
    runWithProductLine({ ...beta, application: android, role: 'admin' }, () => expect(() => componentLibraryService.resolve()).toThrow('仅支持 iOS'));
  });
  it('keeps an in-flight publication on its original library when the binding changes', async () => scoped(async () => {
    await runWithComponentLibrary(async () => {
      applicationService.update(beta.id, ios.id, { componentLibraryId: `ios:${beta.id}` });
      await Promise.resolve();
      expect(componentLibraryService.resolve().id).toBe('ios:nn');
      expect((await pods.getOne('SharedCore', '1.0'))?.source_zip_url).toContain('nexus.example');
    });
    expect(componentLibraryService.resolve().id).toBe(`ios:${beta.id}`);
  }));
  it('uses shared Nexus/Specs while retaining the consuming project and Git namespace', () => scoped(() => {
    expect(pods.generatePodspec({ name: 'NewCore', version: '2.0' })).toContain('https://nexus.example/ios/NewCore/2.0.zip');
    expect(productLineConfigService.podxConfig()).toMatchObject({ privateSource: 'https://git.example/shared/specs.git', targetName: 'beta', jenkinsRepoUrl: 'https://git.example/beta/app.git', publishWorkDir: '/tmp/beta-project' });
    expect(productLineConfigService.podxConfigYaml()).toContain('https://git.example/shared/specs.git');
    expect(productLineConfigService.get('PODS_NEXUS_BASE_URL', beta.id)).toBe('https://beta.example/ios');
  }));
  it('queries the shared catalog for AI dependency analysis', async () => scoped(async () => {
    const result = await assistantInsightService.analyzePodImpact('SharedCore', '1.0');
    expect(JSON.stringify(result)).toContain('BaseCore');
  }));
  it('blocks deletion and overwriting shared versions before external effects', async () => scoped(async () => {
    const external = jest.spyOn(childProcess, 'execSync').mockImplementation(() => { throw new Error('unexpected external call'); });
    expect(await pods.checkDeleteVersion('SharedCore', '1.0')).toMatchObject({ canDelete: false });
    await expect(pods.deleteVersion('SharedCore', '1.0')).rejects.toThrow('不可覆盖或删除');
    await expect(pods.deleteComponent('SharedCore')).rejects.toThrow('不可覆盖或删除');
    await expect(pods.uploadToNexus('/unused.zip', 'SharedCore', '1.0')).rejects.toThrow('不可覆盖或删除');
    await expect(pods.updatePodspec('SharedCore', '1.0', 'replacement', 'beta')).rejects.toThrow('不可覆盖或删除');
    expect(external).not.toHaveBeenCalled();
  }));
  it('keeps shared artifact status and branch intact when a consumer sync succeeds or fails', async () => scoped(async () => {
    const sync = jest.spyOn(pods as any, 'syncVersionToNnios').mockImplementation(() => {
      expect(currentProductLineId()).toBe(beta.id);
    });
    await pods.syncVersionToBranch('SharedCore', '1.0', 'beta-release');
    expect(sync).toHaveBeenCalledWith('SharedCore', '1.0', 'beta-release');
    sync.mockImplementation(() => { throw new Error('consumer branch failed'); });
    await expect(pods.syncVersionToBranch('SharedCore', '1.0', 'beta-release')).rejects.toThrow('consumer branch failed');
    expect(await pods.getOne('SharedCore', '1.0')).toMatchObject({ status: 'published', nnios_branch: 'owner-branch' });
  }));
  it('publishes a new catalog record once for all bound products', async () => scoped(async () => {
    (pods as any).saveComponent({ name: 'NewSharedCore', version: '2.0', summary: '', homepage: '', source_zip_url: 'https://nexus.example/new.zip', podspec_content: '', status: 'published' });
    const ownerRows = getDatabase().prepare("SELECT product_line_id FROM pods_components WHERE name = 'NewSharedCore'").all();
    expect(ownerRows).toEqual([{ product_line_id: 'nn' }]);
    expect(await pods.getComponentNames()).toContain('NewSharedCore');
    expect(await runWithProductLine({ ...authService.findProductLine('nn')!, role: 'admin' }, () => pods.getComponentNames())).toContain('NewSharedCore');
  }));
});
