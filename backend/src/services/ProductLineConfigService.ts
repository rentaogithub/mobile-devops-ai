import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../database';
import { currentProductLineId } from './ProductLineContext';

export const PRODUCT_LINE_CONFIG_KEYS = [
  'JENKINS_USER', 'JENKINS_TOKEN', 'JENKINS_NN_JOB', 'JENKINS_NN_QA_JOB', 'JENKINS_NN_REPO_URL',
  'PGYER_API_KEY', 'PGYER_APP_KEY', 'PGYER_SHORTCUT_URL',
  'APP_STORE_CONNECT_API_KEY_ID', 'APP_STORE_CONNECT_API_ISSUER_ID', 'APP_STORE_CONNECT_API_PRIVATE_KEY', 'APP_STORE_CONNECT_APP_ID', 'APP_STORE_CONNECT_TESTFLIGHT_GROUPS',
  'WECHAT_WEBHOOK_URL',
] as const;

export type ProductLineConfigKey = typeof PRODUCT_LINE_CONFIG_KEYS[number];

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
}

export const productLineConfigService = new ProductLineConfigService();
