import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import { getDatabase } from '../database';
import logger from '../utils/logger';

export type PlatformRole = 'guest' | 'tester' | 'developer' | 'product' | 'admin';

export interface PlatformUser {
  id: string;
  username: string;
  displayName: string;
  role: PlatformRole;
  active: boolean;
}

export type PlatformRegistrationStatus = 'pending' | 'approved' | 'rejected';

export interface PlatformRegistrationRequest {
  id: string;
  username: string;
  displayName: string;
  requestedRole: PlatformRole;
  status: PlatformRegistrationStatus;
  reviewerUserId?: string;
  reviewerUsername?: string;
  reviewMessage?: string;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
}

const SESSION_COOKIE = 'nn_platform_session';
const SESSION_TTL_MS = Math.max(60 * 60 * 1000, Number(process.env.AUTH_SESSION_TTL_HOURS || 24 * 30) * 60 * 60 * 1000);
const VALID_ROLES: PlatformRole[] = ['guest', 'tester', 'developer', 'product', 'admin'];
const SELF_REGISTER_ROLES: PlatformRole[] = ['guest', 'tester', 'developer', 'product'];

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

function sessionCookieHeader(token: string, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)) {
  const secure = process.env.NODE_ENV === 'production' && process.env.AUTH_COOKIE_SECURE !== 'false';
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function userFromRow(row: any): PlatformUser | null {
  if (!row) return null;
  const rawRole = String(row.role || '');
  const role = rawRole === 'viewer' ? 'guest' : (rawRole === 'operator' ? 'tester' : rawRole);
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: (['guest', 'tester', 'developer', 'product', 'admin'].includes(role) ? role : 'guest') as PlatformRole,
    active: Boolean(row.active),
  };
}

function registrationRequestFromRow(row: any): PlatformRegistrationRequest | null {
  if (!row) return null;
  const rawRole = String(row.requested_role || 'guest');
  const role = (VALID_ROLES.includes(rawRole as PlatformRole) ? rawRole : 'guest') as PlatformRole;
  const rawStatus = String(row.status || 'pending');
  const status = (['pending', 'approved', 'rejected'].includes(rawStatus) ? rawStatus : 'pending') as PlatformRegistrationStatus;
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    requestedRole: role,
    status,
    reviewerUserId: row.reviewer_user_id ? String(row.reviewer_user_id) : undefined,
    reviewerUsername: row.reviewer_username ? String(row.reviewer_username) : undefined,
    reviewMessage: row.review_message ? String(row.review_message) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : undefined,
  };
}

function normalizeUsername(value: string) {
  return String(value || '').trim().replace(/@nn\.com$/i, '').toLowerCase();
}

function validateUsername(username: string) {
  if (!/^[a-z0-9_.-]{2,64}$/.test(username)) throw new Error('NN 邮箱前缀需为 2-64 位字母、数字、点、下划线或连字符');
}

function validatePassword(password: string) {
  if (String(password || '').length < 8) throw new Error('密码至少 8 位');
}

function validateRegistrationPassword(username: string, password: string) {
  const value = String(password || '');
  if (value === `${username}123`) return;
  validatePassword(value);
}

function validateRole(role: PlatformRole, roles = VALID_ROLES) {
  if (!roles.includes(role)) throw new Error('角色无效');
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
    const row = getDatabase().prepare('SELECT * FROM platform_users WHERE username = ? AND active = 1').get(normalizeUsername(username)) as any;
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

    res.setHeader('Set-Cookie', sessionCookieHeader(token));
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

  refreshSession(req: Request, res: Response): PlatformUser | null {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return null;
    const row = getDatabase().prepare(`
      SELECT u.*, s.id AS session_id
      FROM platform_sessions s
      JOIN platform_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
    `).get(hashToken(token), now()) as any;
    if (!row) return null;
    const timestamp = now();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    getDatabase().prepare('UPDATE platform_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(timestamp, expiresAt, row.session_id);
    res.setHeader('Set-Cookie', sessionCookieHeader(token));
    return userFromRow(row);
  }

  findUserByUsername(username: string) {
    return userFromRow(getDatabase().prepare('SELECT * FROM platform_users WHERE username = ? AND active = 1').get(normalizeUsername(username)));
  }

  listUsers() {
    return (getDatabase().prepare('SELECT * FROM platform_users ORDER BY created_at ASC').all() as any[])
      .map(userFromRow).filter((item): item is PlatformUser => Boolean(item));
  }

  createUser(input: { username: string; displayName: string; password: string; role: PlatformRole }) {
    const username = normalizeUsername(input.username);
    validateUsername(username);
    validatePassword(input.password);
    validateRole(input.role);
    const timestamp = now();
    const id = randomUUID();
    getDatabase().prepare(`
      INSERT INTO platform_users (id, username, display_name, password_hash, role, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, username, String(input.displayName || username).trim().slice(0, 120), this.hashPassword(input.password), input.role, timestamp, timestamp);
    return userFromRow(getDatabase().prepare('SELECT * FROM platform_users WHERE id = ?').get(id));
  }

  createRegistrationRequest(input: { username: string; displayName?: string; password: string; requestedRole: PlatformRole }) {
    const db = getDatabase();
    const username = normalizeUsername(input.username);
    validateUsername(username);
    validateRegistrationPassword(username, input.password);
    validateRole(input.requestedRole, SELF_REGISTER_ROLES);

    const existingUser = db.prepare('SELECT id FROM platform_users WHERE username = ?').get(username);
    if (existingUser) throw new Error('该用户名已存在');

    const pendingRequest = db.prepare(`
      SELECT id FROM platform_user_registration_requests
      WHERE username = ? AND status = 'pending'
    `).get(username);
    if (pendingRequest) throw new Error('该用户名已有待审核注册申请');

    const timestamp = now();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO platform_user_registration_requests (
        id, username, display_name, password_hash, requested_role, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      id,
      username,
      String(input.displayName || username).trim().slice(0, 120),
      this.hashPassword(input.password),
      input.requestedRole,
      timestamp,
      timestamp,
    );

    return registrationRequestFromRow(db.prepare('SELECT * FROM platform_user_registration_requests WHERE id = ?').get(id));
  }

  listRegistrationRequests() {
    return (getDatabase().prepare(`
      SELECT * FROM platform_user_registration_requests
      ORDER BY
        CASE status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,
        created_at DESC
    `).all() as any[])
      .map(registrationRequestFromRow)
      .filter((item): item is PlatformRegistrationRequest => Boolean(item));
  }

  approveRegistrationRequest(id: string, reviewer: PlatformUser) {
    const db = getDatabase();
    const approve = db.transaction(() => {
      const row = db.prepare('SELECT * FROM platform_user_registration_requests WHERE id = ?').get(id) as any;
      if (!row) throw new Error('注册申请不存在');
      if (row.status !== 'pending') throw new Error('该注册申请已处理');
      const existingUser = db.prepare('SELECT id FROM platform_users WHERE username = ?').get(row.username);
      if (existingUser) throw new Error('该用户名已存在，无法通过申请');

      const timestamp = now();
      const userId = randomUUID();
      db.prepare(`
        INSERT INTO platform_users (id, username, display_name, password_hash, role, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(userId, row.username, row.display_name, row.password_hash, row.requested_role, timestamp, timestamp);

      db.prepare(`
        UPDATE platform_user_registration_requests
        SET status = 'approved',
            reviewer_user_id = ?,
            reviewer_username = ?,
            review_message = NULL,
            updated_at = ?,
            reviewed_at = ?
        WHERE id = ?
      `).run(reviewer.id, reviewer.username, timestamp, timestamp, id);

      return {
        request: registrationRequestFromRow(db.prepare('SELECT * FROM platform_user_registration_requests WHERE id = ?').get(id)),
        user: userFromRow(db.prepare('SELECT * FROM platform_users WHERE id = ?').get(userId)),
      };
    });
    return approve();
  }

  rejectRegistrationRequest(id: string, reviewer: PlatformUser, message?: string) {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM platform_user_registration_requests WHERE id = ?').get(id) as any;
    if (!row) throw new Error('注册申请不存在');
    if (row.status !== 'pending') throw new Error('该注册申请已处理');
    const timestamp = now();
    db.prepare(`
      UPDATE platform_user_registration_requests
      SET status = 'rejected',
          reviewer_user_id = ?,
          reviewer_username = ?,
          review_message = ?,
          updated_at = ?,
          reviewed_at = ?
      WHERE id = ?
    `).run(reviewer.id, reviewer.username, String(message || '管理员已拒绝').trim().slice(0, 300), timestamp, timestamp, id);
    return registrationRequestFromRow(db.prepare('SELECT * FROM platform_user_registration_requests WHERE id = ?').get(id));
  }

  updateUser(id: string, input: { displayName?: string; password?: string; role?: PlatformRole; active?: boolean }) {
    const fields = ['updated_at = @updatedAt'];
    const params: Record<string, unknown> = { id, updatedAt: now() };
    if (input.displayName !== undefined) { fields.push('display_name = @displayName'); params.displayName = input.displayName.trim().slice(0, 120); }
    if (input.password !== undefined) {
      validatePassword(input.password);
      fields.push('password_hash = @passwordHash'); params.passwordHash = this.hashPassword(input.password);
    }
    if (input.role !== undefined) {
      validateRole(input.role);
      fields.push('role = @role'); params.role = input.role;
    }
    if (input.active !== undefined) { fields.push('active = @active'); params.active = input.active ? 1 : 0; }
    getDatabase().prepare(`UPDATE platform_users SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return userFromRow(getDatabase().prepare('SELECT * FROM platform_users WHERE id = ?').get(id));
  }
}

export const authService = new AuthService();
