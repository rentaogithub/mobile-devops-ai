import { Router, Request, Response } from 'express';
import { networkInterfaces } from 'os';
import { getDatabase } from '../database';
import { adminMiddleware } from '../middleware/auth';
import { authService } from '../services/AuthService';
import logger from '../utils/logger';

const router = Router();

function ensureTable() {
  getDatabase().prepare(`
    CREATE TABLE IF NOT EXISTS service_access_stats (
      visitor_id TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'guest',
      username TEXT,
      display_name TEXT,
      platform_role TEXT,
      ip TEXT,
      access_host TEXT,
      user_agent TEXT,
      first_path TEXT,
      last_path TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      visit_count INTEGER NOT NULL DEFAULT 1
    )
  `).run();

  const columns = getDatabase().prepare('PRAGMA table_info(service_access_stats)').all() as { name: string }[];
  const ensureColumn = (name: string, definition: string) => {
    if (!columns.some((column) => column.name === name)) {
      getDatabase().prepare(`ALTER TABLE service_access_stats ADD COLUMN ${definition}`).run();
    }
  };
  ensureColumn('access_host', 'access_host TEXT');
  ensureColumn('username', 'username TEXT');
  ensureColumn('display_name', 'display_name TEXT');
  ensureColumn('platform_role', 'platform_role TEXT');
}

function normalizeRole(value: unknown): string {
  const role = normalizeText(value, 40);
  return ['guest', 'tester', 'developer', 'product', 'admin'].includes(role) ? role : '';
}

function accessRoleFromPlatformRole(role: string, isAdmin: boolean) {
  if (role) return role;
  return isAdmin ? 'admin' : 'user';
}

function rolePriorityExpression(alias: string) {
  return `CASE ${alias}.platform_role
    WHEN 'admin' THEN 5
    WHEN 'developer' THEN 4
    WHEN 'product' THEN 3
    WHEN 'tester' THEN 2
    WHEN 'guest' THEN 1
    ELSE CASE WHEN ${alias}.role = 'admin' THEN 5 ELSE 0 END
  END`;
}

function roleLabelSql(expression: string) {
  return `CASE ${expression}
    WHEN 5 THEN 'admin'
    WHEN 4 THEN 'developer'
    WHEN 3 THEN 'product'
    WHEN 2 THEN 'tester'
    WHEN 1 THEN 'guest'
    ELSE 'user'
  END`;
}

function latestValueSql(column: string) {
  return `COALESCE(
    MAX(CASE WHEN n.last_seen = latest.latest_seen THEN NULLIF(n.${column}, '') ELSE NULL END),
    MAX(NULLIF(n.${column}, '')),
    ''
  )`;
}

function preferredIdentityValueSql(column: string) {
  return `COALESCE(
    MAX(CASE WHEN NULLIF(n.username, '') IS NOT NULL THEN NULLIF(n.${column}, '') ELSE NULL END),
    ${latestValueSql(column)}
  )`;
}

function displayNameExpression() {
  return `COALESCE(NULLIF(n.display_name, ''), NULLIF(n.username, ''), NULLIF(n.visitor_id, ''))`;
}

function safeDisplayName(value: unknown, username: string) {
  const displayName = normalizeText(value, 80);
  return displayName || username;
}

function safeUsername(value: unknown) {
  const username = normalizeText(value, 80);
  return username.replace(/@nn\.com$/i, '');
}

function getRoleLabel(role: string) {
  const labels: Record<string, string> = {
    guest: '游客',
    tester: '测试',
    developer: '研发',
    product: '产品运营',
    admin: '管理员',
    user: '用户',
  };
  return labels[role] || role || '用户';
}

function buildIdentity(role: string, username: string, displayName: string) {
  const name = displayName || username;
  if (name) return `${getRoleLabel(role)}・${name}`;
  return getRoleLabel(role);
}

function normalizeText(value: unknown, maxLength = 500): string {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, maxLength);
}

function getClientIp(req: Request): string {
  const headerCandidates = [
    req.headers['cf-connecting-ip'],
    req.headers['x-real-ip'],
    req.headers['x-client-ip'],
    req.headers['x-forwarded-for'],
    req.ip,
    req.socket.remoteAddress,
  ];

  for (const candidate of headerCandidates) {
    const rawValue = Array.isArray(candidate) ? candidate[0] : candidate;
    if (typeof rawValue !== 'string' || !rawValue.trim()) continue;
    const ip = rawValue.split(',')[0].trim().replace(/^::ffff:/, '');
    if (ip) return ip;
  }

  return '';
}

function isLoopbackAddress(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/^::ffff:/, '');
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized.startsWith('127.')
  );
}

function getLocalNetworkIp(): string {
  const interfaces = networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }
  return '';
}

function resolveDisplayIp(rawIp: string, accessHost: string): string {
  if (rawIp && !isLoopbackAddress(rawIp)) {
    return rawIp;
  }

  if (accessHost && !isLoopbackAddress(accessHost)) {
    return accessHost;
  }

  return getLocalNetworkIp() || rawIp || accessHost;
}

function getHostOnly(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '';
  if (normalized.startsWith('[')) {
    const endIndex = normalized.indexOf(']');
    return endIndex >= 0 ? normalized.slice(1, endIndex) : normalized;
  }
  return normalized.split(':')[0];
}

router.post('/track', (req: Request, res: Response) => {
  try {
    ensureTable();
    const visitorId = normalizeText(req.body?.visitorId, 120);
    if (!visitorId) {
      res.status(400).json({ success: false, error: '缺少访问者标识' });
      return;
    }

    const now = new Date().toISOString();
    const sessionUser = authService.getSessionUser(req);
    const username = safeUsername(req.body?.username || sessionUser?.username || '');
    const displayName = safeDisplayName(req.body?.displayName || sessionUser?.displayName || '', username);
    const platformRole = normalizeRole(req.body?.role || sessionUser?.role || '');
    const role = accessRoleFromPlatformRole(platformRole, req.body?.isAdmin === true || sessionUser?.role === 'admin');
    const path = normalizeText(req.body?.path, 300) || '/';
    const accessHost = normalizeText(req.body?.accessHost, 120);
    const userAgent = normalizeText(req.headers['user-agent'], 500);
    const ip = normalizeText(resolveDisplayIp(getClientIp(req), accessHost), 120);

    getDatabase().prepare(`
      INSERT INTO service_access_stats (
        visitor_id,
        role,
        username,
        display_name,
        platform_role,
        ip,
        access_host,
        user_agent,
        first_path,
        last_path,
        first_seen,
        last_seen,
        visit_count
      ) VALUES (
        @visitorId,
        @role,
        @username,
        @displayName,
        @platformRole,
        @ip,
        @accessHost,
        @userAgent,
        @path,
        @path,
        @now,
        @now,
        1
      )
      ON CONFLICT(visitor_id) DO UPDATE SET
        role = excluded.role,
        username = excluded.username,
        display_name = excluded.display_name,
        platform_role = excluded.platform_role,
        ip = excluded.ip,
        access_host = excluded.access_host,
        user_agent = excluded.user_agent,
        last_path = excluded.last_path,
        last_seen = excluded.last_seen,
        visit_count = service_access_stats.visit_count + 1
    `).run({ visitorId, role, username, displayName, platformRole, ip, accessHost, userAgent, path, now });

    res.json({ success: true });
  } catch (error: any) {
    logger.error(`记录服务访问失败: ${error.message}`);
    res.status(500).json({ success: false, error: '记录服务访问失败' });
  }
});

router.get('/summary', adminMiddleware, (req: Request, res: Response) => {
  try {
    ensureTable();
    const db = getDatabase();
    const requestAccessHost = getHostOnly(String(req.headers['x-forwarded-host'] || req.get('host') || ''));
    const localNetworkIp = getLocalNetworkIp();
    const totals = db.prepare(`
      WITH normalized AS (
        SELECT
          CASE
            WHEN (ip = '127.0.0.1' OR ip = 'localhost' OR ip = '::1' OR ip LIKE '127.%')
            THEN CASE
              WHEN access_host IS NOT NULL
                AND access_host NOT IN ('127.0.0.1', 'localhost', '::1')
                AND access_host NOT LIKE '127.%'
              THEN access_host
              WHEN @requestAccessHost IS NOT NULL
                AND @requestAccessHost NOT IN ('127.0.0.1', 'localhost', '::1')
                AND @requestAccessHost NOT LIKE '127.%'
              THEN @requestAccessHost
              ELSE @localNetworkIp
            END
            ELSE ip
          END AS display_ip,
          role,
          platform_role,
          last_seen,
          visit_count
        FROM service_access_stats
      )
      SELECT
        COUNT(DISTINCT display_ip) AS totalVisitors,
        COALESCE(SUM(visit_count), 0) AS totalVisits,
        COUNT(DISTINCT CASE WHEN role = 'admin' OR platform_role = 'admin' THEN display_ip END) AS adminVisitors,
        COUNT(DISTINCT CASE WHEN date(last_seen) = date('now') THEN display_ip END) AS todayVisitors,
        COALESCE(SUM(CASE WHEN date(last_seen) = date('now') THEN visit_count ELSE 0 END), 0) AS todayVisits
      FROM normalized
    `).get({ requestAccessHost, localNetworkIp });

    const recentVisitors = (db.prepare(`
      WITH normalized AS (
        SELECT
          visitor_id,
          role,
          username,
          display_name,
          platform_role,
          CASE
            WHEN (ip = '127.0.0.1' OR ip = 'localhost' OR ip = '::1' OR ip LIKE '127.%')
            THEN CASE
              WHEN access_host IS NOT NULL
                AND access_host NOT IN ('127.0.0.1', 'localhost', '::1')
                AND access_host NOT LIKE '127.%'
              THEN access_host
              WHEN @requestAccessHost IS NOT NULL
                AND @requestAccessHost NOT IN ('127.0.0.1', 'localhost', '::1')
                AND @requestAccessHost NOT LIKE '127.%'
              THEN @requestAccessHost
              ELSE @localNetworkIp
            END
            ELSE ip
          END AS display_ip,
          access_host,
          user_agent,
          first_path,
          last_path,
          first_seen,
          last_seen,
          visit_count
        FROM service_access_stats
      ),
      latest AS (
        SELECT display_ip, MAX(last_seen) AS latest_seen
        FROM normalized
        GROUP BY display_ip
      )
      SELECT
        n.display_ip AS visitorId,
        ${roleLabelSql(`MAX(${rolePriorityExpression('n')})`)} AS role,
        ${preferredIdentityValueSql('username')} AS username,
        ${preferredIdentityValueSql('display_name')} AS displayName,
        ${preferredIdentityValueSql('platform_role')} AS platformRole,
        ${latestValueSql('visitor_id')} AS latestVisitorId,
        n.display_ip AS ip,
        MAX(n.access_host) AS accessHost,
        '' AS userAgent,
        MIN(n.first_path) AS firstPath,
        MAX(CASE WHEN n.last_seen = latest.latest_seen THEN n.last_path ELSE '' END) AS lastPath,
        MIN(n.first_seen) AS firstSeen,
        MAX(n.last_seen) AS lastSeen,
        COALESCE(SUM(n.visit_count), 0) AS visitCount
      FROM normalized n
      JOIN latest ON latest.display_ip = n.display_ip
      GROUP BY n.display_ip
      ORDER BY MAX(n.last_seen) DESC
      LIMIT 100
    `).all({ requestAccessHost, localNetworkIp }) as any[]).map((visitor) => {
      const username = safeUsername(visitor.username || '');
      const displayName = safeDisplayName(visitor.displayName || '', username);
      const role = normalizeText(visitor.platformRole || visitor.role || 'user', 40);
      return {
        ...visitor,
        username,
        displayName,
        role,
        identity: buildIdentity(role, username, displayName),
      };
    });

    const topPaths = db.prepare(`
      WITH normalized AS (
        SELECT
          CASE
            WHEN (ip = '127.0.0.1' OR ip = 'localhost' OR ip = '::1' OR ip LIKE '127.%')
            THEN CASE
              WHEN access_host IS NOT NULL
                AND access_host NOT IN ('127.0.0.1', 'localhost', '::1')
                AND access_host NOT LIKE '127.%'
              THEN access_host
              WHEN @requestAccessHost IS NOT NULL
                AND @requestAccessHost NOT IN ('127.0.0.1', 'localhost', '::1')
                AND @requestAccessHost NOT LIKE '127.%'
              THEN @requestAccessHost
              ELSE @localNetworkIp
            END
            ELSE ip
          END AS display_ip,
          last_path,
          visit_count
        FROM service_access_stats
      )
      SELECT last_path AS path, COUNT(DISTINCT display_ip) AS visitors, COALESCE(SUM(visit_count), 0) AS visits
      FROM normalized
      WHERE last_path IS NOT NULL AND last_path != ''
      GROUP BY last_path
      ORDER BY visits DESC
      LIMIT 10
    `).all({ requestAccessHost, localNetworkIp });

    res.json({
      success: true,
      data: {
        totals,
        recentVisitors,
        topPaths,
      },
    });
  } catch (error: any) {
    logger.error(`获取服务访问统计失败: ${error.message}`);
    res.status(500).json({ success: false, error: '获取服务访问统计失败' });
  }
});

export default router;
