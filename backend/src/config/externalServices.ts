import os from 'os';

const DEFAULT_SERVICE_HOST = '10.1.2.175';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function envValue(key: string, fallback = '') {
  const value = String(process.env[key] || '').trim();
  return value || fallback;
}

function isEnabled(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

export function localIPv4Addresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  Object.entries(interfaces).forEach(([name, items]) => {
    if (/^(utun|awdl|llw|bridge|vnic|vmnet)/.test(name)) return;
    items?.forEach((item) => {
      if (item.family !== 'IPv4' || item.internal) return;
      addresses.push(item.address);
    });
  });

  return Array.from(new Set(addresses));
}

export function getCurrentDeviceHost() {
  const configured = envValue('CURRENT_DEVICE_IP') || envValue('SERVICE_PUBLIC_HOST') || envValue('PLATFORM_PUBLIC_HOST');
  if (configured) return configured.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];

  const addresses = localIPv4Addresses();
  return (
    addresses.find((ip) => ip.startsWith('10.')) ||
    addresses.find((ip) => ip.startsWith('192.168.')) ||
    addresses.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) ||
    addresses[0] ||
    ''
  );
}

function resolveDefaultHostForCurrentDevice(hostname: string) {
  const shouldUseCurrentDeviceHost = isEnabled(process.env.USE_CURRENT_DEVICE_IP_FOR_DEFAULT_HOST, true);
  if (!shouldUseCurrentDeviceHost) return hostname;
  if (hostname !== DEFAULT_SERVICE_HOST && !LOOPBACK_HOSTS.has(hostname)) return hostname;
  return getCurrentDeviceHost() || DEFAULT_SERVICE_HOST;
}

export function resolveServiceUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    parsed.hostname = resolveDefaultHostForCurrentDevice(parsed.hostname);
    return trimTrailingSlash(parsed.toString());
  } catch {
    return trimTrailingSlash(rawUrl);
  }
}

export function encodeJenkinsJobPath(jobName: string) {
  return jobName
    .split('/')
    .filter(Boolean)
    .map((part) => `job/${encodeURIComponent(part)}`)
    .join('/');
}

export function getJenkinsBaseUrl() {
  return resolveServiceUrl(envValue('JENKINS_BASE_URL', `http://${DEFAULT_SERVICE_HOST}:8080`));
}

export function getNNRtcJenkinsConfig() {
  const baseUrl = trimTrailingSlash(
    envValue('NNRTC_JENKINS_BASE_URL', `http://${DEFAULT_SERVICE_HOST}:8080`)
  );
  const jobName = envValue('NNRTC_JENKINS_JOB', 'nnrtc-ios-build');
  const jobPath = encodeJenkinsJobPath(jobName);

  return {
    baseUrl,
    jobName,
    jobPath,
    jobUrl: `${baseUrl}/${jobPath}/`,
  };
}

export function getDSYMSourceConfig() {
  return {
    nnRtcArchiveSmbUrl: envValue('DSYM_NNRTC_ARCHIVE_SMB_URL'),
    screenShareUrl: envValue('DSYM_SCREEN_SHARE_URL'),
  };
}

export function getExternalServicesPublicConfig() {
  const nnrtcJenkins = getNNRtcJenkinsConfig();
  return {
    nnrtcJenkins: {
      baseUrl: nnrtcJenkins.baseUrl,
      jobName: nnrtcJenkins.jobName,
      jobUrl: nnrtcJenkins.jobUrl,
    },
    dsymSources: getDSYMSourceConfig(),
  };
}
