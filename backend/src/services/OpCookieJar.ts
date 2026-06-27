import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

type StoredCookie = {
  name: string;
  value: string;
  expiresAt?: number;
};

type StoredOpAuth = {
  accessToken?: string;
  updatedAt?: number;
};

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '..', 'nn-ios-platform-data');
const COOKIE_JAR_PATH = process.env.OP_COOKIE_JAR_PATH || path.join(DATA_DIR, 'op-cookie-jar.json');
const OP_AUTH_PATH = process.env.OP_AUTH_PATH || path.join(DATA_DIR, 'op-auth.json');
const opSessionCookies = new Map<string, StoredCookie>();
let opAuth: StoredOpAuth = {};

function parseCookiePair(cookiePart: string): { name: string; value: string } | null {
  const equalIndex = cookiePart.indexOf('=');
  if (equalIndex <= 0) {
    return null;
  }

  const name = cookiePart.substring(0, equalIndex).trim();
  const value = cookiePart.substring(equalIndex + 1).trim();
  return name ? { name, value } : null;
}

function parseSetCookie(cookie: string): StoredCookie | null {
  const parts = cookie.split(';').map((part) => part.trim());
  const parsed = parseCookiePair(parts[0] || '');
  if (!parsed) {
    return null;
  }

  let expiresAt: number | undefined;
  for (const part of parts.slice(1)) {
    const [rawName, ...rawValue] = part.split('=');
    const attrName = rawName.trim().toLowerCase();
    const attrValue = rawValue.join('=').trim();

    if (attrName === 'max-age') {
      const maxAge = Number(attrValue);
      if (Number.isFinite(maxAge)) {
        expiresAt = Date.now() + maxAge * 1000;
      }
    } else if (attrName === 'expires') {
      const expiresTime = Date.parse(attrValue);
      if (!Number.isNaN(expiresTime)) {
        expiresAt = expiresTime;
      }
    }
  }

  return {
    name: parsed.name,
    value: parsed.value,
    expiresAt,
  };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function pruneExpiredCookies() {
  const now = Date.now();
  Array.from(opSessionCookies.entries()).forEach(([name, cookie]) => {
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
      opSessionCookies.delete(name);
    }
  });
}

function persistOpCookieJar() {
  try {
    ensureDataDir();
    pruneExpiredCookies();
    const cookies = Array.from(opSessionCookies.values());
    fs.writeFileSync(COOKIE_JAR_PATH, JSON.stringify({ cookies }, null, 2), { mode: 0o600 });
  } catch (error) {
    logger.warn('OP cookie 持久化失败', {
      path: COOKIE_JAR_PATH,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function persistOpAuth() {
  try {
    ensureDataDir();
    fs.writeFileSync(OP_AUTH_PATH, JSON.stringify(opAuth, null, 2), { mode: 0o600 });
  } catch (error) {
    logger.warn('OP auth 持久化失败', {
      path: OP_AUTH_PATH,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function loadOpCookieJar() {
  try {
    if (!fs.existsSync(COOKIE_JAR_PATH)) {
      return;
    }

    const raw = fs.readFileSync(COOKIE_JAR_PATH, 'utf8');
    const data = JSON.parse(raw) as { cookies?: StoredCookie[] };
    (data.cookies || []).forEach((cookie) => {
      if (cookie.name && cookie.value) {
        opSessionCookies.set(cookie.name, cookie);
      }
    });
    pruneExpiredCookies();
  } catch (error) {
    logger.warn('OP cookie 加载失败', {
      path: COOKIE_JAR_PATH,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function loadOpAuth() {
  try {
    if (!fs.existsSync(OP_AUTH_PATH)) {
      return;
    }

    const raw = fs.readFileSync(OP_AUTH_PATH, 'utf8');
    const data = JSON.parse(raw) as StoredOpAuth;
    if (typeof data.accessToken === 'string' && data.accessToken) {
      opAuth = {
        accessToken: data.accessToken,
        updatedAt: data.updatedAt,
      };
    }
  } catch (error) {
    logger.warn('OP auth 加载失败', {
      path: OP_AUTH_PATH,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

loadOpCookieJar();
loadOpAuth();

export function updateOpCookieJar(setCookie: string | string[] | undefined) {
  if (!setCookie) {
    return;
  }

  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  let changed = false;
  cookies.forEach((cookie) => {
    const parsed = parseSetCookie(cookie);
    if (!parsed) {
      return;
    }

    if (!parsed.value || (parsed.expiresAt !== undefined && parsed.expiresAt <= Date.now())) {
      opSessionCookies.delete(parsed.name);
    } else {
      opSessionCookies.set(parsed.name, parsed);
    }
    changed = true;
  });

  if (changed) {
    persistOpCookieJar();
  }
}

export function updateOpCookieJarFromCookieHeader(cookieHeader: string | undefined) {
  if (!cookieHeader) {
    return;
  }

  let changed = false;
  cookieHeader.split(';').forEach((part) => {
    const parsed = parseCookiePair(part);
    if (parsed) {
      opSessionCookies.set(parsed.name, parsed);
      changed = true;
    }
  });

  if (changed) {
    persistOpCookieJar();
  }
}

export function buildOpCookieHeader(extraCookie?: string): string | undefined {
  updateOpCookieJarFromCookieHeader(extraCookie);
  pruneExpiredCookies();

  if (opSessionCookies.size === 0) {
    return undefined;
  }

  return Array.from(opSessionCookies.values())
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export function updateOpAccessToken(token: string | undefined) {
  const normalizedToken = token?.trim();
  if (!normalizedToken || normalizedToken === opAuth.accessToken) {
    return;
  }

  opAuth = {
    accessToken: normalizedToken,
    updatedAt: Date.now(),
  };
  persistOpAuth();
}

export function getOpAccessToken(): string | undefined {
  return opAuth.accessToken;
}

export function clearOpCookieJar() {
  opSessionCookies.clear();
  opAuth = {};
  persistOpCookieJar();
  persistOpAuth();
}
