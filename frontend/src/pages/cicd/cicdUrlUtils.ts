export function normalizeOpenUrl(url?: string) {
  if (!url) return '';
  try {
    const parsed = new URL(url, window.location.origin);
    if (['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
      parsed.hostname = window.location.hostname;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function openExternalUrl(url?: string) {
  const normalizedUrl = normalizeOpenUrl(url);
  if (!normalizedUrl) return;
  window.open(normalizedUrl, '_blank', 'noopener,noreferrer');
}

export function openPerformanceTrace(url?: string) {
  openExternalUrl(url);
}
