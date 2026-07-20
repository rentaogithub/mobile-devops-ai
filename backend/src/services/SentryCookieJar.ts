import fs from 'fs';
import path from 'path';

const sentrySessionCookies = new Map<string, string>();
let isLoaded = false;
let cookieJarUpdatedAt = 0;

function isSentryCookieName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith('sentry') ||
    ['sc', 'csrf', 'csrftoken', 'sessionid'].includes(normalized);
}

function getDefaultDatabasePath(): string {
  const projectRoot = path.resolve(__dirname, '../../../');
  return path.resolve(process.env.DB_PATH || path.join(projectRoot, 'nn-ios-platform-data', 'database.sqlite'));
}

function getCookieJarPath(): string {
  return path.resolve(
    process.env.SENTRY_COOKIE_JAR_PATH ||
    path.join(path.dirname(getDefaultDatabasePath()), 'sentry-cookie-jar.json')
  );
}

function loadCookieJar() {
  if (isLoaded) {
    return;
  }
  isLoaded = true;

  try {
    const filePath = getCookieJarPath();
    if (!fs.existsSync(filePath)) {
      return;
    }

    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      updatedAt?: number;
      cookies?: Record<string, string>;
    };
    Object.entries(payload.cookies || {}).forEach(([name, value]) => {
      if (name && value) {
        sentrySessionCookies.set(name, value);
      }
    });
    cookieJarUpdatedAt = Number(payload.updatedAt || 0);
  } catch {
    sentrySessionCookies.clear();
    cookieJarUpdatedAt = 0;
  }
}

function persistCookieJar() {
  const filePath = getCookieJarPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  cookieJarUpdatedAt = Date.now();
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      updatedAt: cookieJarUpdatedAt,
      cookies: Object.fromEntries(sentrySessionCookies.entries()),
    }, null, 2)
  );
}

function parseCookiePair(cookiePart: string): { name: string; value: string } | null {
  const equalIndex = cookiePart.indexOf('=');
  if (equalIndex <= 0) {
    return null;
  }

  const name = cookiePart.substring(0, equalIndex).trim();
  const value = cookiePart.substring(equalIndex + 1).trim();
  if (!name) {
    return null;
  }

  return { name, value };
}

export function updateSentryCookieJar(setCookie: string | string[] | undefined) {
  loadCookieJar();
  if (!setCookie) {
    return;
  }

  let changed = false;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  cookies.forEach((cookie) => {
    const parsed = parseCookiePair(cookie.split(';')[0]);
    if (!parsed) {
      return;
    }
    if (!parsed.value) {
      sentrySessionCookies.delete(parsed.name);
      changed = true;
      return;
    }
    sentrySessionCookies.set(parsed.name, parsed.value);
    changed = true;
  });

  if (changed) {
    persistCookieJar();
  }
}

export function updateSentryCookieJarFromCookieHeader(cookieHeader: string | undefined) {
  loadCookieJar();
  if (!cookieHeader) {
    return;
  }

  let changed = false;
  cookieHeader.split(';').forEach((part) => {
    const parsed = parseCookiePair(part);
    if (parsed?.value && isSentryCookieName(parsed.name)) {
      sentrySessionCookies.set(parsed.name, parsed.value);
      changed = true;
    }
  });

  if (changed) {
    persistCookieJar();
  }
}

export function buildSentryCookieHeader(extraCookie?: string): string | undefined {
  loadCookieJar();
  updateSentryCookieJarFromCookieHeader(extraCookie);

  if (sentrySessionCookies.size === 0) {
    return undefined;
  }

  return Array.from(sentrySessionCookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

export function hasSentryCookie(name: string): boolean {
  loadCookieJar();
  return sentrySessionCookies.has(name);
}

export function getSentryCookie(name: string): string | undefined {
  loadCookieJar();
  return sentrySessionCookies.get(name);
}

export function getSentryCookieJarUpdatedAt(): number {
  loadCookieJar();
  return cookieJarUpdatedAt;
}

export function clearSentryCookieJar() {
  loadCookieJar();
  sentrySessionCookies.clear();
  persistCookieJar();
}
