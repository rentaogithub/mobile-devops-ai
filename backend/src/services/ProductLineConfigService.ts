import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDatabase } from '../database';
import { currentProductLineId } from './ProductLineContext';

export const PRODUCT_LINE_CONFIG_KEYS = [
  'JENKINS_USER', 'JENKINS_TOKEN', 'JENKINS_NN_JOB', 'JENKINS_NN_QA_JOB', 'JENKINS_NN_REPO_URL',
  'PODX_TARGET_NAME', 'PODX_PRIVATE_SOURCE', 'PODX_GIT_BASE_URL',
  'PODX_PUBLISH_REPOS', 'PODX_PUBLISH_MAIN_REPO', 'PODX_PUBLISH_WORK_DIR', 'PODX_PUBLISH_BASE_BRANCH',
  'PGYER_API_KEY', 'PGYER_APP_KEY', 'PGYER_SHORTCUT_URL',
  'APP_STORE_CONNECT_API_KEY_ID', 'APP_STORE_CONNECT_API_ISSUER_ID', 'APP_STORE_CONNECT_API_PRIVATE_KEY', 'APP_STORE_CONNECT_APP_ID', 'APP_STORE_CONNECT_TESTFLIGHT_GROUPS',
  'WECHAT_WEBHOOK_URL',
] as const;

export type ProductLineConfigKey = typeof PRODUCT_LINE_CONFIG_KEYS[number];

export interface ProductLinePodxConfig {
  productLineId: string;
  targetName: string;
  privateSource: string;
  gitBaseUrl: string;
  overlayFile: string;
  publishRepos: string[];
  publishRepoUrls: string[];
  publishMainRepo: string;
  publishWorkDir: string;
  publishBaseBranch: string;
  jenkinsBaseUrl: string;
  jenkinsJob: string;
  jenkinsQualityJob: string;
  jenkinsRepoUrl: string;
}

export interface ProductLinePodxConfigSyncResult {
  productLineId: string;
  projectDirectory: string;
  configPath: string;
  repoUrl: string;
  cloned: boolean;
}

interface ProductLineRecord {
  id?: string;
  key?: string;
  name?: string;
  project_id?: string;
  bundle_id?: string;
  jenkins_base_url?: string;
}

const SECRET_KEYS = new Set<ProductLineConfigKey>([
  'JENKINS_TOKEN', 'PGYER_API_KEY', 'PGYER_APP_KEY',
  'APP_STORE_CONNECT_API_PRIVATE_KEY', 'WECHAT_WEBHOOK_URL',
]);

const URL_KEYS = new Set<ProductLineConfigKey>([
  'PGYER_SHORTCUT_URL', 'WECHAT_WEBHOOK_URL',
]);

function now() {
  return new Date().toISOString();
}

function readShellConfigValue(configPath: string, key: string) {
  try {
    if (!fs.existsSync(configPath)) return '';
    const line = fs.readFileSync(configPath, 'utf8')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => new RegExp(`^(?:export\\s+)?${key}=`).test(item));
    return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') : '';
  } catch {
    return '';
  }
}

function legacyJenkinsRepoDir() {
  const configured = String(process.env.NN_IOS_JENKINS_DIR || process.env.JENKINS_NN_IOS_JENKINS_DIR || '').trim();
  if (configured) return path.resolve(configured);
  const candidates = [
    path.resolve(process.cwd(), '../nn-ios-jekins'),
    path.resolve(process.cwd(), '../../nn-ios-jekins'),
    path.resolve(__dirname, '../../../../nn-ios-jekins'),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'cicd/jenkins/build_config.sh'))) || candidates[0];
}

function legacyNNConfigValue(key: ProductLineConfigKey) {
  const repoDir = legacyJenkinsRepoDir();
  const buildConfigPath = path.join(repoDir, 'cicd/jenkins/build_config.sh');
  if (key === 'PGYER_API_KEY' || key === 'PGYER_APP_KEY' || key === 'WECHAT_WEBHOOK_URL') {
    return readShellConfigValue(buildConfigPath, key);
  }
  if (key === 'PGYER_SHORTCUT_URL') {
    const shortcut = readShellConfigValue(buildConfigPath, key) || 'iC0d';
    return /^https?:\/\//i.test(shortcut) ? shortcut : `https://www.pgyer.com/${shortcut.replace(/^\/+/, '')}`;
  }
  if (key === 'APP_STORE_CONNECT_API_PRIVATE_KEY') {
    const configuredPath = String(process.env.APP_STORE_CONNECT_API_KEY_PATH || readShellConfigValue(buildConfigPath, 'APP_STORE_CONNECT_API_KEY_PATH') || '').trim();
    if (!configuredPath) return '';
    const resolvedPath = path.isAbsolute(configuredPath) ? configuredPath : path.resolve(repoDir, configuredPath);
    try {
      return fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf8').trim() : '';
    } catch {
      return '';
    }
  }
  return '';
}

function appStorePrivateKeySource(productLineId: string) {
  try {
    const row = getDatabase().prepare(`
      SELECT value FROM platform_product_line_configs
      WHERE product_line_id = ? AND key = 'APP_STORE_CONNECT_API_PRIVATE_KEY'
    `).get(productLineId) as { value?: string } | undefined;
    if (row?.value) return '产品线加密配置';
  } catch {
    // 数据库未初始化时继续检查 nn 的历史配置来源。
  }
  if (productLineId !== 'nn') return '';
  if (String(process.env.APP_STORE_CONNECT_API_PRIVATE_KEY || '').trim()) return '环境变量中的私钥';
  const repoDir = legacyJenkinsRepoDir();
  const buildConfigPath = path.join(repoDir, 'cicd/jenkins/build_config.sh');
  const configuredPath = String(process.env.APP_STORE_CONNECT_API_KEY_PATH || readShellConfigValue(buildConfigPath, 'APP_STORE_CONNECT_API_KEY_PATH') || '').trim();
  if (!configuredPath) return '';
  const resolvedPath = path.isAbsolute(configuredPath) ? configuredPath : path.resolve(repoDir, configuredPath);
  return fs.existsSync(resolvedPath) ? path.basename(resolvedPath) : '';
}

function weChatWebhookSource(productLineId: string) {
  try {
    const row = getDatabase().prepare(`
      SELECT value FROM platform_product_line_configs
      WHERE product_line_id = ? AND key = 'WECHAT_WEBHOOK_URL'
    `).get(productLineId) as { value?: string } | undefined;
    if (row?.value) return '产品线加密配置';
  } catch {
    // 数据库未初始化时继续检查 nn 的历史配置来源。
  }
  if (productLineId !== 'nn') return '';
  if (String(process.env.WECHAT_WEBHOOK_URL || '').trim()) return '环境变量';
  const buildConfigPath = path.join(legacyJenkinsRepoDir(), 'cicd/jenkins/build_config.sh');
  return readShellConfigValue(buildConfigPath, 'WECHAT_WEBHOOK_URL')
    ? 'nn-ios-jekins/cicd/jenkins/build_config.sh'
    : '';
}

function trimTrailingSlash(value: string) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function splitList(value: string) {
  return String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function repoNameFromUrl(url: string) {
  const text = trimTrailingSlash(url);
  return path.basename(text).replace(/\.git$/i, '');
}

function isGitUrl(value: string) {
  return /^(?:https?:\/\/|git@|ssh:\/\/)/i.test(String(value || '').trim());
}

function defaultGitWorkspaceDir() {
  return path.resolve(
    process.env.GIT_WORK_DIR ||
      path.join(process.env.UPLOAD_DIR || path.join(os.homedir(), '.nn-ios-platform-data'), '../git-workspace')
  );
}

function yamlScalar(value: string | boolean) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value || '');
  return JSON.stringify(text);
}

class ProductLineConfigService {
  private encryptionKey() {
    return createHash('sha256')
      .update(String(process.env.PLATFORM_CONFIG_ENCRYPTION_KEY || process.env.ADMIN_PASSWORD || process.env.AUTH_PASSWORD || 'product-line-config'))
      .digest();
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
  }

  private decrypt(value: string) {
    if (!value.startsWith('enc:v1:')) return value;
    try {
      const [, , ivText, tagText, encryptedText] = value.split(':');
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), Buffer.from(ivText, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  get(key: ProductLineConfigKey, productLineId = currentProductLineId()): string {
    try {
      const row = getDatabase().prepare(`
        SELECT value, encrypted FROM platform_product_line_configs WHERE product_line_id = ? AND key = ?
      `).get(productLineId, key) as { value?: string; encrypted?: number } | undefined;
      if (row) return row.encrypted ? this.decrypt(String(row.value || '')) : String(row.value || '');
    } catch {
      // 数据库尚未初始化或测试已关闭数据库时，nn 继续兼容环境变量。
    }
    if (productLineId !== 'nn') return '';
    return String(process.env[key] || '').trim() || legacyNNConfigValue(key);
  }

  setMany(productLineId: string, values: Partial<Record<ProductLineConfigKey, unknown>>, updatedBy?: string) {
    const db = getDatabase();
    const productLine = db.prepare('SELECT id FROM platform_product_lines WHERE id = ?').get(productLineId);
    if (!productLine) throw new Error('产品线不存在');
    const upsert = db.prepare(`
      INSERT INTO platform_product_line_configs (product_line_id, key, value, encrypted, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_line_id, key) DO UPDATE SET
        value = excluded.value, encrypted = excluded.encrypted, updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `);
    db.transaction(() => {
      for (const key of PRODUCT_LINE_CONFIG_KEYS) {
        if (!(key in values)) continue;
        const normalized = String(values[key] ?? '').trim();
        if (normalized && URL_KEYS.has(key)) {
          try {
            const parsed = new URL(normalized);
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
          } catch {
            throw new Error(`${key} 必须是有效的 HTTP/HTTPS 地址`);
          }
        }
        const secret = SECRET_KEYS.has(key);
        upsert.run(productLineId, key, secret && normalized ? this.encrypt(normalized) : normalized, secret ? 1 : 0, now(), updatedBy || null);
      }
    })();
    return this.adminView(productLineId);
  }

  adminView(productLineId: string) {
    const values: Record<string, string | boolean> = {};
    for (const key of PRODUCT_LINE_CONFIG_KEYS) {
      const value = this.get(key, productLineId);
      if (SECRET_KEYS.has(key)) values[`${key}Configured`] = Boolean(value);
      else values[key] = value;
    }
    if (productLineId === 'nn') {
      values.JENKINS_NN_JOB ||= 'nn';
      values.JENKINS_NN_QA_JOB ||= 'nn-auto-quality';
      values.JENKINS_NN_REPO_URL ||= 'http://git.leigod.top/nn_ios/nnios.git';
      if (!values.JENKINS_USER && !values.JENKINS_TOKENConfigured) {
        values.JENKINS_USER = 'anonymous';
      }
    }
    if (values.APP_STORE_CONNECT_API_PRIVATE_KEYConfigured) {
      values.APP_STORE_CONNECT_API_PRIVATE_KEY_SOURCE = appStorePrivateKeySource(productLineId) || '已安全加载';
    }
    if (values.WECHAT_WEBHOOK_URLConfigured) {
      const webhook = this.get('WECHAT_WEBHOOK_URL', productLineId);
      values.WECHAT_WEBHOOK_URL = webhook;
      values.WECHAT_WEBHOOK_URL_SOURCE = weChatWebhookSource(productLineId) || '已安全加载';
    }
    return values;
  }

  podxConfig(productLineId = currentProductLineId()): ProductLinePodxConfig {
    const productLine = this.findProductLine(productLineId);
    const jenkinsRepoUrl = this.get('JENKINS_NN_REPO_URL', productLineId)
      || (productLineId === 'nn' ? 'http://git.leigod.top/nn_ios/nnios.git' : '');
    const targetName = this.get('PODX_TARGET_NAME', productLineId)
      || (productLineId === 'nn' ? 'nn_ios' : productLine?.key || productLineId);
    const gitBaseUrl = this.get('PODX_GIT_BASE_URL', productLineId)
      || this.gitBaseUrlFromRepoUrl(jenkinsRepoUrl, targetName)
      || (productLineId === 'nn' ? 'http://git.leigod.top' : '');
    const privateSource = this.get('PODX_PRIVATE_SOURCE', productLineId)
      || (gitBaseUrl && targetName ? `${trimTrailingSlash(gitBaseUrl)}/${targetName}/nnspec.git` : '');
    const publishRepos = splitList(this.get('PODX_PUBLISH_REPOS', productLineId));
    const publishMainRepo = this.get('PODX_PUBLISH_MAIN_REPO', productLineId)
      || (jenkinsRepoUrl ? repoNameFromUrl(jenkinsRepoUrl) : '');
    const publishRepoUrls = this.publishRepoUrlsFromConfig(publishRepos, gitBaseUrl, targetName);

    return {
      productLineId,
      targetName,
      privateSource,
      gitBaseUrl,
      overlayFile: 'Podfile.overlay',
      publishRepos,
      publishRepoUrls,
      publishMainRepo,
      publishWorkDir: this.get('PODX_PUBLISH_WORK_DIR', productLineId) || `.mgit-publish/${productLine?.key || productLineId}`,
      publishBaseBranch: this.get('PODX_PUBLISH_BASE_BRANCH', productLineId) || 'develop',
      jenkinsBaseUrl: productLine?.jenkins_base_url || '',
      jenkinsJob: this.get('JENKINS_NN_JOB', productLineId) || (productLineId === 'nn' ? 'nn' : ''),
      jenkinsQualityJob: this.get('JENKINS_NN_QA_JOB', productLineId) || (productLineId === 'nn' ? 'nn-auto-quality' : ''),
      jenkinsRepoUrl,
    };
  }

  podxEnvironment(productLineId = currentProductLineId()): Record<string, string> {
    const config = this.podxConfig(productLineId);
    return {
      PODX_PRODUCT_LINE: productLineId,
      PODX_TARGET_NAME: config.targetName,
      PODX_PRIVATE_SOURCE: config.privateSource,
      PODX_GIT_BASE_URL: config.gitBaseUrl,
      PODX_OVERLAY_FILE: config.overlayFile,
      PODX_PUBLISH_REPOS: config.publishRepos.join(','),
      PODX_PUBLISH_MAIN_REPO: config.publishMainRepo,
      PODX_PUBLISH_WORK_DIR: config.publishWorkDir,
      PODX_PUBLISH_BASE_BRANCH: config.publishBaseBranch,
      JENKINS_BASE_URL: config.jenkinsBaseUrl,
      JENKINS_NN_JOB: config.jenkinsJob,
      JENKINS_NN_QA_JOB: config.jenkinsQualityJob,
      JENKINS_NN_REPO_URL: config.jenkinsRepoUrl,
    };
  }

  podxConfigYaml(productLineId = currentProductLineId()): string {
    const productLine = this.findProductLine(productLineId);
    const config = this.podxConfig(productLineId);
    const lineKey = String(productLine?.key || config.productLineId).trim();
    const lines = [
      `product_line: ${yamlScalar(lineKey)}`,
      `target_name: ${yamlScalar(config.targetName)}`,
      `private_source: ${yamlScalar(config.privateSource)}`,
      `git_base_url: ${yamlScalar(config.gitBaseUrl)}`,
      `overlay_file: ${yamlScalar(config.overlayFile)}`,
      `publish_work_dir: ${yamlScalar(config.publishWorkDir)}`,
      `publish_base_branch: ${yamlScalar(config.publishBaseBranch)}`,
      'publish_pipeline_gate: false',
    ];

    if (config.publishMainRepo) lines.push(`publish_main_repo: ${yamlScalar(config.publishMainRepo)}`);
    if (config.publishRepos.length) {
      lines.push('publish_repos:');
      config.publishRepos.forEach((repo) => lines.push(`  - ${yamlScalar(repo)}`));
    } else if (config.publishMainRepo) {
      lines.push('publish_repos:');
      lines.push(`  - ${yamlScalar(config.publishMainRepo)}`);
    } else {
      lines.push('publish_repos: []');
    }
    if (config.jenkinsBaseUrl) lines.push(`jenkins_base_url: ${yamlScalar(config.jenkinsBaseUrl)}`);
    if (config.jenkinsJob) lines.push(`jenkins_job: ${yamlScalar(config.jenkinsJob)}`);
    if (config.jenkinsQualityJob) lines.push(`jenkins_quality_job: ${yamlScalar(config.jenkinsQualityJob)}`);
    if (config.jenkinsRepoUrl) lines.push(`jenkins_repo_url: ${yamlScalar(config.jenkinsRepoUrl)}`);
    lines.push(
      '',
      '# 当前主工程只对应一个产品线；多产品线由 nn-ios-platform 在不同主工程中分别维护。'
    );
    return lines.join('\n');
  }

  syncPodxConfigToProject(productLineId = currentProductLineId(), requestedProjectDirectory = ''): ProductLinePodxConfigSyncResult {
    const config = this.podxConfig(productLineId);
    const repoUrl = config.jenkinsRepoUrl || this.mainRepoUrlFromConfig(config);
    const projectDirectory = this.resolveMainProjectDirectory(config, repoUrl, requestedProjectDirectory);
    const cloned = this.ensureMainProjectDirectory(projectDirectory, repoUrl, Boolean(requestedProjectDirectory));
    const configPath = path.join(projectDirectory, 'podx.config.yml');
    fs.writeFileSync(configPath, this.podxConfigYaml(productLineId), 'utf8');
    return {
      productLineId,
      projectDirectory,
      configPath,
      repoUrl,
      cloned,
    };
  }

  publishRepoUrls(productLineId = currentProductLineId()): string[] {
    return this.podxConfig(productLineId).publishRepoUrls;
  }

  private findProductLine(productLineId: string): ProductLineRecord | undefined {
    try {
      return getDatabase().prepare(`
        SELECT id, key, name, project_id, bundle_id, jenkins_base_url
        FROM platform_product_lines
        WHERE id = ? OR key = ? OR project_id = ?
        LIMIT 1
      `).get(productLineId, productLineId, productLineId) as ProductLineRecord | undefined;
    } catch {
      return undefined;
    }
  }

  private gitBaseUrlFromRepoUrl(repoUrl: string, targetName: string) {
    const value = trimTrailingSlash(repoUrl);
    if (!value || !targetName) return '';
    const marker = `/${targetName}/`;
    const index = value.indexOf(marker);
    return index > 0 ? value.slice(0, index) : '';
  }

  private publishRepoUrlsFromConfig(repos: string[], gitBaseUrl: string, targetName: string) {
    const base = trimTrailingSlash(gitBaseUrl);
    return repos.map((repo) => {
      if (isGitUrl(repo)) return repo;
      if (!base || !targetName) return '';
      return `${base}/${targetName}/${repo}.git`;
    }).filter(Boolean);
  }

  private mainRepoUrlFromConfig(config: ProductLinePodxConfig) {
    if (!config.publishMainRepo) return '';
    if (isGitUrl(config.publishMainRepo)) return config.publishMainRepo;
    const base = trimTrailingSlash(config.gitBaseUrl);
    if (!base || !config.targetName) return '';
    return `${base}/${config.targetName}/${config.publishMainRepo}.git`;
  }

  private resolveMainProjectDirectory(config: ProductLinePodxConfig, repoUrl: string, requestedProjectDirectory: string) {
    const requested = String(requestedProjectDirectory || '').trim();
    if (requested) return path.resolve(requested);
    const repoName = repoNameFromUrl(repoUrl || config.publishMainRepo || config.productLineId);
    if (!repoName) throw new Error('未配置主工程仓库，无法同步 podx.config.yml');
    return path.join(defaultGitWorkspaceDir(), repoName);
  }

  private ensureMainProjectDirectory(projectDirectory: string, repoUrl: string, explicitDirectory: boolean) {
    if (fs.existsSync(path.join(projectDirectory, '.git'))) return false;
    if (fs.existsSync(projectDirectory) && fs.readdirSync(projectDirectory).length > 0) {
      throw new Error(`目标目录不是 Git 仓库：${projectDirectory}`);
    }
    if (explicitDirectory) {
      fs.mkdirSync(projectDirectory, { recursive: true });
      return false;
    }
    if (!repoUrl) throw new Error('未配置主工程仓库地址，无法自动 clone');
    fs.mkdirSync(path.dirname(projectDirectory), { recursive: true });
    execFileSync('git', ['clone', repoUrl, projectDirectory], {
      stdio: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return true;
  }
}

export const productLineConfigService = new ProductLineConfigService();
