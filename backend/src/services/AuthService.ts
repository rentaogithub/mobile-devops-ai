import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import { getDatabase } from '../database';
import logger from '../utils/logger';

export type PlatformRole = 'viewer' | 'operator' | 'admin';

export interface PlatformUser {
  id: string;
  username: string;
  displayName: string;
  role: PlatformRole;
  active: boolean;
}

const SESSION_COOKIE = 'nn_platform_session';
const SESSION_TTL_MS = Math.max(60 * 60 * 1000, Number(process.env.AUTH_SESSION_TTL_HOURS || 12) * 60 * 60 * 1000);

function now() {
  return new Date().toISOString();
}

function hashToken(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function parseCookies(req: Request): Record<string, string> {
  const header = String(req.headers.cookie || '');
  return Object.fromEntries(header.split(';').map((item) => {
    const index = item.indexOf('=');
    if (index < 0) return ['', ''];
    return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function userFromRow(row: any): PlatformUser | null {
  if (!row) return null;
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: (['viewer', 'operator', 'admin'].includes(row.role) ? row.role : 'viewer') as PlatformRole,
    active: Boolean(row.active),
  };
}

export class AuthService {
  initializeBootstrapUser() {
    const db = getDatabase();
    const existing = db.prepare('SELECT COUNT(*) AS count FROM platform_users').get() as { count: number };
    if (existing.count > 0) return;

    const password = String(process.env.ADMIN_PASSWORD || process.env.AUTH_PASSWORD || '').trim();
    if (!password) {
      logger.warn('未创建初始实名管理员：请配置 ADMIN_PASSWORD 后重启服务');
      return;
    }

    const username = String(process.env.ADMIN_USERNAME || 'admin').trim() || 'admin';
    const timestamp = now();
    db.prepare(`
      INSERT INTO platform_users (id, username, display_name, password_hash, role, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'admin', 1, ?, ?)
    `).run(randomUUID(), username, process.env.ADMIN_DISPLAY_NAME || '平台管理员', this.hashPassword(password), timestamp, timestamp);
    logger.info('已创建初始实名管理员', { username });
  }

  hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const derived = scryptSync(password, salt, 64).toString('hex');
    return `scrypt$${salt}$${derived}`;
  }

  verifyPassword(password: string, encoded: string): boolean {
    const [algorithm, salt, expectedHex] = String(encoded || '').split('$');
    if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = scryptSync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  authenticate(username: string, password: string): PlatformUser | null {
    const row = getDatabase().prepare('SELECT * FROM platform_users WHERE username = ? AND active = 1').get(username) as any;
    if (!row || !this.verifyPassword(password, row.password_hash)) return null;
    return userFromRow(row);
  }

  createSession(user: PlatformUser, req: Request, res: Response) {
    const token = randomBytes(32).toString('base64url');
    const timestamp = now();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    getDatabase().prepare(`
      INSERT INTO platform_sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), user.id, hashToken(token), expiresAt, timestamp, timestamp, req.ip, String(req.headers['user-agent'] || '').slice(0, 500));

    const secure = process.env.NODE_ENV === 'production' && process.env.AUTH_COOKIE_SECURE !== 'false';
    res.setHeader('Set-Cookie', [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      secure ? 'Secure' : '',
    ].filter(Boolean).join('; '));
  }

  clearSession(req: Request, res: Response) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) getDatabase().prepare('DELETE FROM platform_sessions WHERE token_hash = ?').run(hashToken(token));
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  getSessionUser(req: Request): PlatformUser | null {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return null;
    const row = getDatabase().prepare(`
      SELECT u.*, s.id AS session_id
      FROM platform_sessions s
      JOIN platform_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
    `).get(hashToken(token), now()) as any;
    if (!row) return null;
    getDatabase().prepare('UPDATE platform_sessions SET last_seen_at = ? WHERE id = ?').run(now(), row.session_id);
    return userFromRow(row);
  }

  findUserByUsername(username: string) {
    return userFromRow(getDatabase().prepare('SELECT * FROM platform_users WHERE username = ? AND active = 1').get(username));
  }

  listUsers() {
    return (getDatabase().prepare('SELECT * FROM platform_users ORDER BY created_at ASC').all() as any[])
      .map(userFromRow).filter((item): item is PlatformUser => Boolean(item));
  }

  createUser(input: { username: string; displayName: string; password: string; role: PlatformRole }) {
    const username = String(input.username || '').trim();
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) throw new Error('用户名需为 3-64 位字母、数字、点、下划线或连字符');
    if (String(input.password || '').length < 8) throw new Error('密码至少 8 位');
    if (!['viewer', 'operator', 'admin'].includes(input.role)) throw new Error('角色无效');
    const timestamp = now();
    const id = randomUUID();
    getDatabase().prepare(`
      INSERT INTO platform_users (id, username, display_name, password_hash, role, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, username, String(input.displayName || username).trim().slice(0, 120), this.hashPassword(input.password), input.role, timestamp, timestamp);
    return userFromRow(getDatabase().prepare('SELECT * FROM platform_users WHERE id = ?').get(id));
  }

  updateUser(id: string, input: { displayName?: string; password?: string; role?: PlatformRole; active?: boolean }) {
    const fields = ['updated_at = @updatedAt'];
    const params: Record<string, unknown> = { id, updatedAt: now() };
    if (input.displayName !== undefined) { fields.push('display_name = @displayName'); params.displayName = input.displayName.trim().slice(0, 120); }
    if (input.password !== undefined) {
      if (input.password.length < 8) throw new Error('密码至少 8 位');
      fields.push('password_hash = @passwordHash'); params.passwordHash = this.hashPassword(input.password);
    }
    if (input.role !== undefined) {
      if (!['viewer', 'operator', 'admin'].includes(input.role)) throw new Error('角色无效');
      fields.push('role = @role'); params.role = input.role;
    }
    if (input.active !== undefined) { fields.push('active = @active'); params.active = input.active ? 1 : 0; }
    getDatabase().prepare(`UPDATE platform_users SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return userFromRow(getDatabase().prepare('SELECT * FROM platform_users WHERE id = ?').get(id));
  }
}

export const authService = new AuthService();
