import fs from 'fs';
import path from 'path';
import { currentProductLineId } from './ProductLineContext';

interface SentryCookieJarState {
  cookies: Map<string, string>;
  loaded: boolean;
  updatedAt: number;
}

const cookieJars = new Map<string, SentryCookieJarState>();

function currentCookieJar() {
  const productLineId = currentProductLineId();
  let state = cookieJars.get(productLineId);
  if (!state) {
    state = { cookies: new Map(), loaded: false, updatedAt: 0 };
    cookieJars.set(productLineId, state);
  }
  return { productLineId, state };
}

function isSentryCookieName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith('sentry') ||
    ['sc', 'csrf', 'csrftoken', 'sessionid'].includes(normalized);
}

function getDefaultDatabasePath(): string {
  const projectRoot = path.resolve(__dirname, '../../../');
  return path.resolve(process.env.DB_PATH || path.join(projectRoot, 'nn-ios-platform-data', 'database.sqlite'));
}

function getCookieJarPath(productLineId = currentProductLineId()): string {
  const basePath = path.resolve(
    process.env.SENTRY_COOKIE_JAR_PATH ||
    path.join(path.dirname(getDefaultDatabasePath()), 'sentry-cookie-jar.json')
  );
  if (productLineId === 'nn') return basePath;
  const extension = path.extname(basePath) || '.json';
  return `${basePath.slice(0, -extension.length)}.${productLineId.replace(/[^A-Za-z0-9_.-]/g, '_')}${extension}`;
}

function loadCookieJar() {
  const { productLineId, state } = currentCookieJar();
  if (state.loaded) {
    return;
  }
  state.loaded = true;

  try {
    const filePath = getCookieJarPath(productLineId);
    if (!fs.existsSync(filePath)) {
      return;
    }

    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      updatedAt?: number;
      cookies?: Record<string, string>;
    };
    Object.entries(payload.cookies || {}).forEach(([name, value]) => {
      if (name && value) {
        state.cookies.set(name, value);
      }
    });
    state.updatedAt = Number(payload.updatedAt || 0);
  } catch {
    state.cookies.clear();
    state.updatedAt = 0;
  }
}

function persistCookieJar() {
  const { productLineId, state } = currentCookieJar();
  const filePath = getCookieJarPath(productLineId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  state.updatedAt = Date.now();
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      updatedAt: state.updatedAt,
      cookies: Object.fromEntries(state.cookies.entries()),
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
  const { state } = currentCookieJar();
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
      state.cookies.delete(parsed.name);
      changed = true;
      return;
    }
    state.cookies.set(parsed.name, parsed.value);
    changed = true;
  });

  if (changed) {
    persistCookieJar();
  }
}

export function updateSentryCookieJarFromCookieHeader(cookieHeader: string | undefined) {
  loadCookieJar();
  const { state } = currentCookieJar();
  if (!cookieHeader) {
    return;
  }

  let changed = false;
  cookieHeader.split(';').forEach((part) => {
    const parsed = parseCookiePair(part);
    if (parsed?.value && isSentryCookieName(parsed.name)) {
      state.cookies.set(parsed.name, parsed.value);
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
  const { state } = currentCookieJar();

  if (state.cookies.size === 0) {
    return undefined;
  }

  return Array.from(state.cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

export function hasSentryCookie(name: string): boolean {
  loadCookieJar();
  return currentCookieJar().state.cookies.has(name);
}

export function getSentryCookie(name: string): string | undefined {
  loadCookieJar();
  return currentCookieJar().state.cookies.get(name);
}

export function getSentryCookieJarUpdatedAt(): number {
  loadCookieJar();
  return currentCookieJar().state.updatedAt;
}

export function clearSentryCookieJar() {
  loadCookieJar();
  currentCookieJar().state.cookies.clear();
  persistCookieJar();
}
