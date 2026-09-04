import os from 'os';
import { getDatabase } from '../database';
import { currentProductLineId } from '../services/ProductLineContext';
import { productLineConfigService, ProductLineConfigKey } from '../services/ProductLineConfigService';

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

export function getJenkinsBaseUrl(productLineId = currentProductLineId()) {
  try {
    const row = getDatabase().prepare(`
      SELECT jenkins_base_url FROM platform_product_lines WHERE id = ? AND active = 1
    `).get(productLineId) as { jenkins_base_url?: string } | undefined;
    const configured = String(row?.jenkins_base_url || '').trim();
    // 产品线显式配置可能指向另一台机器，必须原样使用其域名/IP，不能改写为平台本机地址。
    if (configured) return trimTrailingSlash(configured);
  } catch {
    // 数据库尚未初始化时继续使用环境变量，兼容启动早期调用。
  }
  if (productLineId !== 'nn') return '';
  return resolveServiceUrl(envValue('JENKINS_BASE_URL', `http://${DEFAULT_SERVICE_HOST}:8080`));
}

export function getProductLineConfig(key: ProductLineConfigKey, productLineId = currentProductLineId()) {
  return productLineConfigService.get(key, productLineId);
}

export function getJenkinsConfig(productLineId = currentProductLineId()) {
  const isLegacyProductLine = productLineId === 'nn';
  return {
    baseUrl: getJenkinsBaseUrl(productLineId),
    username: getProductLineConfig('JENKINS_USER', productLineId),
    token: getProductLineConfig('JENKINS_TOKEN', productLineId),
    jobName: getProductLineConfig('JENKINS_NN_JOB', productLineId) || (isLegacyProductLine ? 'nn' : ''),
    qualityJobName: getProductLineConfig('JENKINS_NN_QA_JOB', productLineId) || (isLegacyProductLine ? 'nn-auto-quality' : ''),
    repoUrl: getProductLineConfig('JENKINS_NN_REPO_URL', productLineId) || (isLegacyProductLine ? 'http://git.leigod.top/nn_ios/nnios.git' : ''),
  };
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
