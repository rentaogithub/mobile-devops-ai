import { getDatabase } from '../database';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const CONFIG_KEYS = ['OPENAI_API_KEY', 'RELEASE_VERIFY_PASSWORD', 'ADMIN_PASSWORD'] as const;
export type PlatformConfigKey = (typeof CONFIG_KEYS)[number];

function now() {
  return new Date().toISOString();
}

class PlatformConfigService {
  private ensureTable() {
    getDatabase().exec(`
      CREATE TABLE IF NOT EXISTS platform_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        updated_by TEXT
      )
    `);
  }

  get(key: PlatformConfigKey): string {
    this.ensureTable();
    const row = getDatabase().prepare('SELECT value FROM platform_config WHERE key = ?').get(key) as { value?: string } | undefined;
    if (row) return String(row.value || '');
    return String(process.env[key] || '').trim();
  }

  set(key: PlatformConfigKey, value: string, updatedBy?: string) {
    this.ensureTable();
    const normalized = String(value || '').trim();
    getDatabase().prepare(`
      INSERT INTO platform_config (key, value, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `).run(key, normalized, now(), updatedBy || null);
    process.env[key] = normalized;
  }

  private encryptionKey() {
    return createHash('sha256')
      .update(String(process.env.PLATFORM_CONFIG_ENCRYPTION_KEY || process.env.ADMIN_PASSWORD || process.env.AUTH_PASSWORD || 'platform-config'))
      .digest();
  }

  setEncrypted(key: PlatformConfigKey, value: string, updatedBy?: string) {
    this.ensureTable();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(String(value || ''), 'utf8'), cipher.final()]);
    const encoded = `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
    getDatabase().prepare(`
      INSERT INTO platform_config (key, value, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `).run(key, encoded, now(), updatedBy || null);
  }

  getEncrypted(key: PlatformConfigKey): string {
    this.ensureTable();
    const row = getDatabase().prepare('SELECT value FROM platform_config WHERE key = ?').get(key) as { value?: string } | undefined;
    const value = String(row?.value || '');
    if (!value.startsWith('enc:v1:')) return '';
    try {
      const [, , ivText, tagText, encryptedText] = value.split(':');
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), Buffer.from(ivText, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  clear(key: PlatformConfigKey, updatedBy?: string) {
    this.set(key, '', updatedBy);
  }

  status() {
    return {
      aiApiKeyConfigured: Boolean(this.get('OPENAI_API_KEY')),
      releaseVerificationPasswordConfigured: Boolean(this.get('RELEASE_VERIFY_PASSWORD')),
    };
  }

  adminView() {
    return {
      ...this.status(),
      aiApiKey: this.get('OPENAI_API_KEY'),
      releaseVerificationPassword: this.get('RELEASE_VERIFY_PASSWORD'),
    };
  }
}

export const platformConfigService = new PlatformConfigService();
