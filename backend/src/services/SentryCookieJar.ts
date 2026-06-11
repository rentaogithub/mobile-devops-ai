const sentrySessionCookies = new Map<string, string>();

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
  if (!setCookie) {
    return;
  }

  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  cookies.forEach((cookie) => {
    const parsed = parseCookiePair(cookie.split(';')[0]);
    if (!parsed) {
      return;
    }
    if (!parsed.value) {
      sentrySessionCookies.delete(parsed.name);
      return;
    }
    sentrySessionCookies.set(parsed.name, parsed.value);
  });
}

export function updateSentryCookieJarFromCookieHeader(cookieHeader: string | undefined) {
  if (!cookieHeader) {
    return;
  }

  cookieHeader.split(';').forEach((part) => {
    const parsed = parseCookiePair(part);
    if (parsed?.value) {
      sentrySessionCookies.set(parsed.name, parsed.value);
    }
  });
}

export function buildSentryCookieHeader(extraCookie?: string): string | undefined {
  updateSentryCookieJarFromCookieHeader(extraCookie);

  if (sentrySessionCookies.size === 0) {
    return undefined;
  }

  return Array.from(sentrySessionCookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

export function hasSentryCookie(name: string): boolean {
  return sentrySessionCookies.has(name);
}

export function getSentryCookie(name: string): string | undefined {
  return sentrySessionCookies.get(name);
}

export function clearSentryCookieJar() {
  sentrySessionCookies.clear();
}
