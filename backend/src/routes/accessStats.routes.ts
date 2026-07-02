import { Router, Request, Response } from 'express';
import { networkInterfaces } from 'os';
import { getDatabase } from '../database';
import { adminMiddleware } from '../middleware/auth';
import logger from '../utils/logger';

const router = Router();

function ensureTable() {
  getDatabase().prepare(`
    CREATE TABLE IF NOT EXISTS service_access_stats (
      visitor_id TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'guest',
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
  const hasAccessHost = columns.some((column) => column.name === 'access_host');
  if (!hasAccessHost) {
    getDatabase().prepare('ALTER TABLE service_access_stats ADD COLUMN access_host TEXT').run();
  }
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
    const role = req.body?.isAdmin === true ? 'admin' : 'user';
    const path = normalizeText(req.body?.path, 300) || '/';
    const accessHost = normalizeText(req.body?.accessHost, 120);
    const userAgent = normalizeText(req.headers['user-agent'], 500);
    const ip = normalizeText(resolveDisplayIp(getClientIp(req), accessHost), 120);

    getDatabase().prepare(`
      INSERT INTO service_access_stats (
        visitor_id,
        role,
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
        ip = excluded.ip,
        access_host = excluded.access_host,
        user_agent = excluded.user_agent,
        last_path = excluded.last_path,
        last_seen = excluded.last_seen,
        visit_count = service_access_stats.visit_count + 1
    `).run({ visitorId, role, ip, accessHost, userAgent, path, now });

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
      SELECT
        COUNT(*) AS totalVisitors,
        COALESCE(SUM(visit_count), 0) AS totalVisits,
        COALESCE(SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END), 0) AS adminVisitors,
        COALESCE(SUM(CASE WHEN date(last_seen) = date('now') THEN 1 ELSE 0 END), 0) AS todayVisitors,
        COALESCE(SUM(CASE WHEN date(last_seen) = date('now') THEN visit_count ELSE 0 END), 0) AS todayVisits
      FROM service_access_stats
    `).get();

    const recentVisitors = db.prepare(`
      SELECT
        visitor_id AS visitorId,
        role,
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
        END AS ip,
        access_host AS accessHost,
        user_agent AS userAgent,
        first_path AS firstPath,
        last_path AS lastPath,
        first_seen AS firstSeen,
        last_seen AS lastSeen,
        visit_count AS visitCount
      FROM service_access_stats
      ORDER BY last_seen DESC
      LIMIT 100
    `).all({ requestAccessHost, localNetworkIp });

    const topPaths = db.prepare(`
      SELECT last_path AS path, COUNT(*) AS visitors, COALESCE(SUM(visit_count), 0) AS visits
      FROM service_access_stats
      WHERE last_path IS NOT NULL AND last_path != ''
      GROUP BY last_path
      ORDER BY visits DESC
      LIMIT 10
    `).all();

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
