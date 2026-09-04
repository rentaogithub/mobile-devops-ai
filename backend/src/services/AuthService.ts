import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import { getDatabase } from '../database';
import logger from '../utils/logger';
import { platformConfigService } from './PlatformConfigService';

export type PlatformRole = 'guest' | 'tester' | 'developer' | 'product' | 'admin';

export interface PlatformProductLine {
  id: string;
  key: string;
  name: string;
  projectId: string;
  bundleId?: string;
  jenkinsBaseUrl?: string;
  active: boolean;
}

export interface ProductLineMembership extends PlatformProductLine {
  role: PlatformRole;
}

export interface PlatformUser {
  id: string;
  username: string;
  displayName: string;
  role: PlatformRole;
  active: boolean;
  productLines?: ProductLineMembership[];
}

export type PlatformRegistrationStatus = 'pending' | 'approved' | 'rejected';

export interface PlatformRegistrationRequest {
  id: string;
  username: string;
  displayName: string;
  requestedRole: PlatformRole;
  productLineId: string;
  productLineName?: string;
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

function productLineFromRow(row: any): PlatformProductLine | null {
  if (!row) return null;
  return {
    id: String(row.id || row.product_line_id),
    key: String(row.key || row.product_line_key),
    name: String(row.name || row.product_line_name),
    projectId: String(row.project_id),
    bundleId: row.bundle_id ? String(row.bundle_id) : undefined,
    jenkinsBaseUrl: row.jenkins_base_url ? String(row.jenkins_base_url) : undefined,
    active: Boolean(row.active ?? row.product_line_active),
  };
}

function userFromRow(row: any, productLines: ProductLineMembership[] = []): PlatformUser | null {
  if (!row) return null;
  const rawRole = String(row.role || '');
  const role = rawRole === 'viewer' ? 'guest' : (rawRole === 'operator' ? 'tester' : rawRole);
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: (['guest', 'tester', 'developer', 'product', 'admin'].includes(role) ? role : 'guest') as PlatformRole,
    active: Boolean(row.active),
    productLines,
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
    productLineId: String(row.product_line_id || 'nn'),
    productLineName: row.product_line_name ? String(row.product_line_name) : undefined,
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
  private membershipsForUser(userId: string, platformRole?: PlatformRole): ProductLineMembership[] {
    const db = getDatabase();
    const rows = platformRole === 'admin'
      ? db.prepare(`
          SELECT p.*, 'admin' AS membership_role
          FROM platform_product_lines p
          WHERE p.active = 1
          ORDER BY p.name COLLATE NOCASE
        `).all() as any[]
      : db.prepare(`
          SELECT p.*, m.role AS membership_role
          FROM platform_product_line_memberships m
          JOIN platform_product_lines p ON p.id = m.product_line_id
          WHERE m.user_id = ? AND p.active = 1
          ORDER BY p.name COLLATE NOCASE
        `).all(userId) as any[];

    return rows.map((row) => ({
      ...productLineFromRow(row)!,
      role: (VALID_ROLES.includes(row.membership_role as PlatformRole) ? row.membership_role : 'guest') as PlatformRole,
    }));
  }

  private hydrateUser(row: any): PlatformUser | null {
    if (!row) return null;
    const rawRole = String(row.role || 'guest');
    const normalizedRole = (rawRole === 'viewer' ? 'guest' : rawRole === 'operator' ? 'tester' : rawRole) as PlatformRole;
    return userFromRow(row, this.membershipsForUser(String(row.id), normalizedRole));
  }

  listProductLines(options: { includeInactive?: boolean } = {}): PlatformProductLine[] {
    const rows = getDatabase().prepare(`
      SELECT * FROM platform_product_lines
      ${options.includeInactive ? '' : 'WHERE active = 1'}
      ORDER BY name COLLATE NOCASE
    `).all() as any[];
    return rows.map(productLineFromRow).filter((item): item is PlatformProductLine => Boolean(item));
  }

  findProductLine(value: string): PlatformProductLine | null {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    return productLineFromRow(getDatabase().prepare(`
      SELECT * FROM platform_product_lines WHERE id = ? OR key = ? OR project_id = ? LIMIT 1
    `).get(normalized, normalized, normalized));
  }

  createProductLine(input: { key?: string; name: string; projectId?: string; bundleId?: string; jenkinsBaseUrl?: string }) {
    const name = String(input.name || '').trim().slice(0, 80);
    if (!name) throw new Error('请输入产品线名称');
    const requestedKey = String(input.key || '').trim().toLowerCase();
    if (requestedKey && !/^[a-z0-9][a-z0-9_-]{1,39}$/.test(requestedKey)) {
      throw new Error('产品线标识需为 2-40 位小写字母、数字、下划线或连字符');
    }
    let key = requestedKey || `pl-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    while (getDatabase().prepare('SELECT 1 FROM platform_product_lines WHERE key = ? LIMIT 1').get(key)) {
      key = `pl-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    }
    const projectId = String(input.projectId || `${key}-ios`).trim().slice(0, 120);
    const jenkinsBaseUrl = this.normalizeServiceUrl(input.jenkinsBaseUrl, 'Jenkins 服务地址');
    const timestamp = now();
    const id = randomUUID();
    getDatabase().prepare(`
      INSERT INTO platform_product_lines (id, key, name, project_id, bundle_id, jenkins_base_url, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, key, name, projectId, String(input.bundleId || '').trim() || null, jenkinsBaseUrl || null, timestamp, timestamp);
    return this.findProductLine(id);
  }

  updateProductLine(id: string, input: { name?: string; projectId?: string; bundleId?: string; jenkinsBaseUrl?: string; active?: boolean }) {
    const fields = ['updated_at = @updatedAt'];
    const params: Record<string, unknown> = { id, updatedAt: now() };
    if (input.name !== undefined) {
      const name = String(input.name || '').trim().slice(0, 80);
      if (!name) throw new Error('产品线名称不能为空');
      fields.push('name = @name');
      params.name = name;
    }
    if (input.projectId !== undefined) {
      const projectId = String(input.projectId || '').trim().slice(0, 120);
      if (!projectId) throw new Error('Workflow 项目标识不能为空');
      fields.push('project_id = @projectId');
      params.projectId = projectId;
    }
    if (input.bundleId !== undefined) {
      fields.push('bundle_id = @bundleId');
      params.bundleId = String(input.bundleId || '').trim() || null;
    }
    if (input.jenkinsBaseUrl !== undefined) {
      fields.push('jenkins_base_url = @jenkinsBaseUrl');
      params.jenkinsBaseUrl = this.normalizeServiceUrl(input.jenkinsBaseUrl, 'Jenkins 服务地址') || null;
    }
    if (input.active !== undefined) {
      if (id === 'nn' && input.active === false) throw new Error('默认 NN 产品线不能停用');
      fields.push('active = @active');
      params.active = input.active ? 1 : 0;
    }
    const result = getDatabase().prepare(`UPDATE platform_product_lines SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return result.changes ? this.findProductLine(id) : null;
  }

  private normalizeServiceUrl(value: unknown, label: string): string {
    const normalized = String(value || '').trim().replace(/\/+$/, '');
    if (!normalized) return '';
    try {
      const parsed = new URL(normalized);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
      return parsed.toString().replace(/\/+$/, '');
    } catch {
      throw new Error(`${label}必须是有效的 HTTP/HTTPS 地址`);
    }
  }

  setUserProductLines(userId: string, memberships: Array<{ productLineId: string; role: PlatformRole }>) {
    const db = getDatabase();
    const user = db.prepare('SELECT * FROM platform_users WHERE id = ?').get(userId) as any;
    if (!user) throw new Error('用户不存在');
    if (user.role === 'admin') return this.hydrateUser(user);

    const normalized = Array.from(new Map((memberships || []).map((item) => {
      const productLineId = String(item.productLineId || '').trim();
      return [productLineId, { ...item, productLineId }];
    })).values())
      .filter((item) => item.productLineId);
    normalized.forEach((item) => {
      validateRole(item.role, SELF_REGISTER_ROLES);
      const productLine = this.findProductLine(item.productLineId);
      if (!productLine || !productLine.active) throw new Error(`产品线 ${item.productLineId} 不存在或已停用`);
    });

    const timestamp = now();
    db.transaction(() => {
      db.prepare('DELETE FROM platform_product_line_memberships WHERE user_id = ?').run(userId);
      const insert = db.prepare(`
        INSERT INTO platform_product_line_memberships (product_line_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      normalized.forEach((item) => insert.run(item.productLineId, userId, item.role, timestamp, timestamp));
      const legacyRole = normalized[0]?.role || 'guest';
      db.prepare('UPDATE platform_users SET role = ?, updated_at = ? WHERE id = ?').run(legacyRole, timestamp, userId);
    })();
    return this.hydrateUser(db.prepare('SELECT * FROM platform_users WHERE id = ?').get(userId));
  }

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
    return this.hydrateUser(row);
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
    return this.hydrateUser(row);
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
    return this.hydrateUser(row);
  }

  findUserByUsername(username: string) {
    return this.hydrateUser(getDatabase().prepare('SELECT * FROM platform_users WHERE username = ? AND active = 1').get(normalizeUsername(username)));
  }

  listUsers() {
    return (getDatabase().prepare('SELECT * FROM platform_users ORDER BY created_at ASC').all() as any[])
      .map((row) => this.hydrateUser(row)).filter((item): item is PlatformUser => Boolean(item));
  }

  createUser(input: {
    username: string;
    displayName: string;
    password: string;
    role: PlatformRole;
    productLines?: Array<{ productLineId: string; role: PlatformRole }>;
  }) {
    const username = normalizeUsername(input.username);
    validateUsername(username);
    validatePassword(input.password);
    validateRole(input.role);
    if (input.role !== 'admin') {
      const memberships = input.productLines?.length ? input.productLines : [{ productLineId: 'nn', role: input.role }];
      memberships.forEach((membership) => {
        validateRole(membership.role, SELF_REGISTER_ROLES);
        const productLine = this.findProductLine(membership.productLineId);
        if (!productLine || !productLine.active) throw new Error(`产品线 ${membership.productLineId} 不存在或已停用`);
      });
    }
    const timestamp = now();
    const id = randomUUID();
    getDatabase().prepare(`
      INSERT INTO platform_users (id, username, display_name, password_hash, role, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, username, String(input.displayName || username).trim().slice(0, 120), this.hashPassword(input.password), input.role, timestamp, timestamp);
    if (input.role !== 'admin') {
      this.setUserProductLines(id, input.productLines?.length ? input.productLines : [{ productLineId: 'nn', role: input.role }]);
    }
    return this.hydrateUser(getDatabase().prepare('SELECT * FROM platform_users WHERE id = ?').get(id));
  }

  createRegistrationRequest(input: {
    username: string;
    displayName?: string;
    password: string;
    requestedRole: PlatformRole;
    productLineId?: string;
  }) {
    const db = getDatabase();
    const username = normalizeUsername(input.username);
    validateUsername(username);
    validateRegistrationPassword(username, input.password);
    validateRole(input.requestedRole, SELF_REGISTER_ROLES);
    const productLine = this.findProductLine(input.productLineId || 'nn');
    if (!productLine || !productLine.active) throw new Error('申请的产品线不存在或已停用');

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
        id, username, display_name, password_hash, requested_role, product_line_id, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      id,
      username,
      String(input.displayName || username).trim().slice(0, 120),
      this.hashPassword(input.password),
      input.requestedRole,
      productLine.id,
      timestamp,
      timestamp,
    );

    return registrationRequestFromRow(db.prepare('SELECT * FROM platform_user_registration_requests WHERE id = ?').get(id));
  }

  listRegistrationRequests() {
    return (getDatabase().prepare(`
      SELECT r.*, p.name AS product_line_name
      FROM platform_user_registration_requests r
      LEFT JOIN platform_product_lines p ON p.id = r.product_line_id
      ORDER BY
        CASE r.status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,
        r.created_at DESC
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
      const productLine = this.findProductLine(row.product_line_id || 'nn');
      if (!productLine || !productLine.active) throw new Error('申请的产品线不存在或已停用');
      db.prepare(`
        INSERT INTO platform_users (id, username, display_name, password_hash, role, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(userId, row.username, row.display_name, row.password_hash, row.requested_role, timestamp, timestamp);

      db.prepare(`
        INSERT INTO platform_product_line_memberships (product_line_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(productLine.id, userId, row.requested_role, timestamp, timestamp);

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
        user: this.hydrateUser(db.prepare('SELECT * FROM platform_users WHERE id = ?').get(userId)),
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

  updateUser(id: string, input: {
    displayName?: string;
    password?: string;
    role?: PlatformRole;
    active?: boolean;
    productLines?: Array<{ productLineId: string; role: PlatformRole }>;
  }) {
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
    if (input.productLines) this.setUserProductLines(id, input.productLines);
    return this.hydrateUser(getDatabase().prepare('SELECT * FROM platform_users WHERE id = ?').get(id));
  }

  changePassword(id: string, currentPassword: string, newPassword: string) {
    const row = getDatabase().prepare('SELECT password_hash FROM platform_users WHERE id = ? AND active = 1').get(id) as { password_hash?: string } | undefined;
    if (!row) throw new Error('用户不存在');
    if (!this.verifyPassword(currentPassword, String(row.password_hash || ''))) throw new Error('当前密码不正确');
    validatePassword(newPassword);
    getDatabase().prepare('UPDATE platform_users SET password_hash = ?, updated_at = ? WHERE id = ?').run(this.hashPassword(newPassword), now(), id);
    platformConfigService.setEncrypted('ADMIN_PASSWORD', newPassword, id);
    return this.hydrateUser(getDatabase().prepare('SELECT * FROM platform_users WHERE id = ?').get(id));
  }

  getPasswordForDisplay(id: string) {
    const row = getDatabase().prepare('SELECT password_hash FROM platform_users WHERE id = ? AND active = 1').get(id) as { password_hash?: string } | undefined;
    if (!row) return '';
    const saved = platformConfigService.getEncrypted('ADMIN_PASSWORD');
    if (saved && this.verifyPassword(saved, String(row.password_hash || ''))) return saved;
    const envPassword = String(process.env.ADMIN_PASSWORD || '').trim();
    return envPassword && this.verifyPassword(envPassword, String(row.password_hash || '')) ? envPassword : '';
  }

  deleteUser(id: string, actorId?: string) {
    const db = getDatabase();
    const user = db.prepare('SELECT id, role FROM platform_users WHERE id = ?').get(id) as { id: string; role: PlatformRole } | undefined;
    if (!user) throw new Error('用户不存在');
    if (actorId && user.id === actorId) throw new Error('不能删除当前登录账号');

    const remove = db.transaction(() => {
      // 显式删除会话，避免依赖 SQLite 外键开关状态。
      db.prepare('DELETE FROM platform_sessions WHERE user_id = ?').run(id);
      const result = db.prepare('DELETE FROM platform_users WHERE id = ?').run(id);
      if (result.changes === 0) throw new Error('用户不存在');
    });
    remove();
  }
}

export const authService = new AuthService();
