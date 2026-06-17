import '../config/env';
import { Router, Request, Response } from 'express';
import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import podDepsResolver from '../services/PodDependencyResolver';

const router = Router();
const execFileAsync = promisify(execFile);

const JENKINS_BASE_URL = (process.env.JENKINS_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const DEFAULT_JOB_NAME = process.env.JENKINS_NN_JOB || 'nn';
const DEFAULT_QA_JOB_NAME = process.env.JENKINS_NN_QA_JOB || 'nn-auto-quality';
const DEFAULT_REPO_URL = process.env.JENKINS_NN_REPO_URL || 'http://git.leigod.top/nn_ios/nnios.git';
const DEPLOY_TARGETS = new Set(['Pgyer', 'TestFlight', 'AppStore']);
const QA_TEST_SUITES = new Set(['smoke', 'login', 'im', 'rtc', 'monkey', 'full']);
const QA_MONKEY_DURATION_SECONDS = new Set(['1800', '3600', '14400', '28800']);
const RELEASE_BUILD_LIST_LIMIT = Number(process.env.JENKINS_RELEASE_BUILD_LIST_LIMIT || 8);
const JENKINS_LIST_TIMEOUT_MS = Number(process.env.JENKINS_LIST_TIMEOUT_MS || 2500);
const JENKINS_BUILD_METADATA_TIMEOUT_MS = Number(process.env.JENKINS_BUILD_METADATA_TIMEOUT_MS || 1500);
const JENKINS_ORPHAN_BUILD_STALE_MS = Number(process.env.JENKINS_ORPHAN_BUILD_STALE_MS || 3 * 60 * 1000);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '..', 'nn-ios-platform-data');
const QUALITY_DEVICE_POOLS_CONFIG_PATH = path.join(DATA_DIR, 'quality-device-pools.json');
const LEGACY_SONIC_DEVICE_POOLS_CONFIG_PATH = path.join(DATA_DIR, 'sonic-device-pools.json');
const LOCAL_QUALITY_ARTIFACT_ROUTE = '/api/jenkins/nn/quality/local-artifact';

const ENV_FILE_CANDIDATES = [
  path.resolve(process.cwd(), 'backend/.env'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../backend/.env'),
];

function readEnvFileValue(key: string): string {
  for (const envFile of ENV_FILE_CANDIDATES) {
    if (!fs.existsSync(envFile)) continue;
    const lines = fs.readFileSync(envFile, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const equalIndex = trimmed.indexOf('=');
      if (equalIndex <= 0) continue;
      if (trimmed.slice(0, equalIndex).trim() !== key) continue;
      return trimmed.slice(equalIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return '';
}

function getRuntimeEnv(key: string): string {
  return process.env[key] || readEnvFileValue(key);
}

function normalizeQualitySuite(value?: string) {
  const text = String(value || 'smoke').trim();
  const lower = text.toLowerCase();
  if (/monkey|随机|猴子/i.test(text)) return 'monkey';
  if (/冒烟|smoke/i.test(text)) return 'smoke';
  if (/登录|login/i.test(text)) return 'login';
  if (/^im$|im\s*基础/i.test(text)) return 'im';
  if (/^rtc$|rtc\s*基础/i.test(text)) return 'rtc';
  if (/全量|full/i.test(text)) return 'full';
  return lower;
}

function getSonicConfig() {
  const apiBase = (getRuntimeEnv('SONIC_API_BASE') || 'http://127.0.0.1:5173/sonic-api').replace(/\/$/, '');
  return {
    apiBase,
    webUrl: (getRuntimeEnv('SONIC_WEB_URL') || 'http://127.0.0.1:5173/sonic-admin').replace(/\/$/, ''),
    apiProxyTarget: (getRuntimeEnv('SONIC_API_PROXY_TARGET') || 'http://127.0.0.1:8094').replace(/\/$/, ''),
    webProxyTarget: (getRuntimeEnv('SONIC_WEB_PROXY_TARGET') || 'http://127.0.0.1:3002').replace(/\/$/, ''),
    token: getRuntimeEnv('SONIC_TOKEN') || '',
    projectId: getRuntimeEnv('SONIC_PROJECT_ID') || 'nn-ios',
    testPlanId: getRuntimeEnv('SONIC_TEST_PLAN_ID') || 'smoke',
  };
}

function getPlatformRootDir() {
  const configured = String(getRuntimeEnv('NN_IOS_PLATFORM_DIR') || '').trim();
  if (configured) return configured;

  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), '..'),
  ];
  const matched = candidates.find((candidate) => (
    fs.existsSync(path.join(candidate, 'scripts/sonic/ios-quality.sh'))
  ));
  return matched || process.cwd();
}

function getConnectionErrorMessage(error: any) {
  const code = error?.code ? ` ${error.code}` : '';
  return error?.message ? `${error.message}${code}` : '连接失败';
}

interface QualityDevicePool {
  label: string;
  value: string;
  description: string;
  deviceId?: string;
  groupId?: string;
  devices?: Array<{
    label?: string;
    udid: string;
    description?: string;
    status?: string;
    online?: boolean;
    busy?: boolean;
    activeBuildNumber?: number;
    name?: string;
    marketName?: string;
    productVersion?: string;
    connType?: string;
  }>;
}

const DEFAULT_QUALITY_DEVICE_POOLS: QualityDevicePool[] = [
  {
    label: 'iOS 默认设备池',
    value: 'ios-default',
    description: '打包机当前可用 USB iOS 真机，适合日常冒烟质检。',
  },
  {
    label: 'iPhone 新系统池',
    value: 'ios-latest',
    description: '较新 iOS 系统真机，适合新系统兼容性检查。',
  },
  {
    label: 'iPhone 兼容性池',
    value: 'ios-compat',
    description: '覆盖较旧机型或系统版本，适合发布前兼容性回归。',
  },
];

interface ThirdSdkDependency {
  name: string;
  version: string;
  source: string;
}

function encodeJobPath(jobName: string) {
  return jobName
    .split('/')
    .filter(Boolean)
    .map((part) => `job/${encodeURIComponent(part)}`)
    .join('/');
}

function normalizeQualityDevicePool(pool: any): QualityDevicePool | null {
  const label = String(pool?.label || '').trim();
  const value = String(pool?.value || '').trim();
  if (!label || !value) return null;
  const devices = (Array.isArray(pool?.devices) ? pool.devices : [])
    .map((device: any) => ({
      label: String(device?.label || '').trim() || undefined,
      udid: String(device?.udid || device?.deviceId || device?.value || '').trim(),
      description: String(device?.description || '').trim() || undefined,
    }))
    .filter((device: any) => device.udid);
  return {
    label,
    value,
    description: String(pool?.description || '用于打包机本机 iOS 真机质检调度。').trim(),
    deviceId: pool?.deviceId ? String(pool.deviceId).trim() : undefined,
    groupId: pool?.groupId ? String(pool.groupId).trim() : undefined,
    devices,
  };
}

function getQualityDevicePools() {
  try {
    const configPath = fs.existsSync(QUALITY_DEVICE_POOLS_CONFIG_PATH)
      ? QUALITY_DEVICE_POOLS_CONFIG_PATH
      : LEGACY_SONIC_DEVICE_POOLS_CONFIG_PATH;
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const savedPools = (Array.isArray(config?.devicePools) ? config.devicePools : [])
        .map(normalizeQualityDevicePool)
        .filter(Boolean) as QualityDevicePool[];
      if (savedPools.length > 0) {
        return savedPools;
      }
    }
  } catch {
    // 配置文件损坏时回退到环境变量或默认配置。
  }

  const raw = String(process.env.SONIC_DEVICE_POOLS_JSON || '').trim();
  if (!raw) return DEFAULT_QUALITY_DEVICE_POOLS;

  try {
    const parsed = JSON.parse(raw);
    const pools = (Array.isArray(parsed) ? parsed : [])
      .map(normalizeQualityDevicePool)
      .filter(Boolean) as QualityDevicePool[];
    return pools.length > 0 ? pools : DEFAULT_QUALITY_DEVICE_POOLS;
  } catch {
    return DEFAULT_QUALITY_DEVICE_POOLS;
  }
}

function findQualityDevicePool(value: string) {
  return getQualityDevicePools().find((pool) => pool.value === value);
}

function sanitizeToken(value: string) {
  return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'default';
}

function hashText(value: string) {
  let hash = 0;
  for (const char of value) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

function deviceKeyFromPool(pool: QualityDevicePool, fallback: string) {
  return String(pool.deviceId || pool.groupId || fallback || '').trim();
}

function deviceKeysFromPool(pool: QualityDevicePool, fallback: string) {
  const keys = (pool.devices || []).map((device) => device.udid).filter(Boolean);
  const legacyKey = deviceKeyFromPool(pool, '');
  if (legacyKey) keys.push(legacyKey);
  return Array.from(new Set(keys)).filter(Boolean).concat(keys.length === 0 ? [fallback] : []);
}

function deriveWdaPort(deviceKey: string, poolValue: string) {
  const configured = Number(getRuntimeEnv('QA_WDA_BASE_PORT') || 8100);
  const basePort = Number.isFinite(configured) && configured > 0 ? configured : 8100;
  const key = deviceKey || poolValue || 'ios-default';
  return basePort + (hashText(key) % 200);
}

function buildWdaUrl(deviceKey: string, poolValue: string) {
  const explicitUrl = String(getRuntimeEnv('QA_WDA_URL') || '').trim();
  if (explicitUrl && explicitUrl !== 'http://127.0.0.1:8100') return explicitUrl;
  return `http://127.0.0.1:${deriveWdaPort(deviceKey, poolValue)}`;
}

function isRecentlyActiveQualityBuild(buildNumber: number, buildDir: string, xml: string, logPath: string) {
  if (readXmlTag(xml, 'result')) return false;

  const progressFile = findLatestQualityFile(DEFAULT_QA_JOB_NAME, 'quality-progress.json', 0, buildNumber);
  const progress = progressFile ? readJsonFile(progressFile) : null;
  const progressUpdatedAt = Number(progress?.updatedAt || 0);
  if (progressUpdatedAt > 0) {
    return Date.now() - progressUpdatedAt <= JENKINS_ORPHAN_BUILD_STALE_MS;
  }

  const candidates = [progressFile, logPath, buildDir].filter(Boolean);
  const latestMtime = candidates.reduce((latest, candidate) => {
    if (!fs.existsSync(candidate)) return latest;
    return Math.max(latest, fs.statSync(candidate).mtimeMs);
  }, 0);
  return latestMtime > 0 && Date.now() - latestMtime <= JENKINS_ORPHAN_BUILD_STALE_MS;
}

function findActiveQualityBuildOnDevice(deviceKey: string) {
  if (!deviceKey) return null;
  const buildsDir = path.join(localJenkinsJobDir(DEFAULT_QA_JOB_NAME), 'builds');
  if (!fs.existsSync(buildsDir)) return null;
  const buildNumbers = fs.readdirSync(buildsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => b - a);

  for (const buildNumber of buildNumbers) {
    const buildDir = path.join(buildsDir, String(buildNumber));
    const buildXmlPath = path.join(buildDir, 'build.xml');
    const logPath = path.join(buildDir, 'log');
    const xml = fs.existsSync(buildXmlPath) ? fs.readFileSync(buildXmlPath, 'utf-8') : '';
    if (!isRecentlyActiveQualityBuild(buildNumber, buildDir, xml, logPath)) continue;
    const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').slice(-8192) : '';
    const buildDevice = readXmlParameter(xml, 'DEVICE_UDID') ||
      readXmlParameter(xml, 'DEVICE_SELECTOR') ||
      logText.match(/使用设备:\s*([^\n\r]+)/)?.[1]?.trim() ||
      '';
    if (buildDevice === deviceKey) return { buildNumber, deviceKey };
  }
  return null;
}

function selectAvailableDeviceFromPool(pool: QualityDevicePool, fallback: string) {
  const deviceKeys = deviceKeysFromPool(pool, fallback);
  for (const deviceKey of deviceKeys) {
    const activeBuild = findActiveQualityBuildOnDevice(deviceKey);
    if (!activeBuild) return { deviceKey, activeBuild: null, deviceKeys };
  }
  const firstDeviceKey = deviceKeys[0] || fallback;
  return { deviceKey: firstDeviceKey, activeBuild: findActiveQualityBuildOnDevice(firstDeviceKey), deviceKeys };
}

async function findTideviceCommand() {
  const candidates = [
    getRuntimeEnv('TIDEVICE_CMD'),
    path.join(process.env.HOME || '', '.local/bin/tidevice'),
    '/opt/homebrew/bin/tidevice',
    '/usr/local/bin/tidevice',
    'tidevice',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (candidate.includes('/')) {
        if (!fs.existsSync(candidate)) continue;
        return candidate;
      }
      await execFileAsync('which', [candidate], { timeout: 1000 });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return '';
}

async function listLocalIosDevices() {
  const tidevice = await findTideviceCommand();
  if (!tidevice) {
    return { devices: [] as any[], error: '未找到 tidevice，无法检测本机 iOS 设备在线状态' };
  }

  try {
    const { stdout } = await execFileAsync(tidevice, ['list', '--json'], { timeout: 5000 });
    const parsed = JSON.parse(stdout || '[]');
    const devices = (Array.isArray(parsed) ? parsed : []).map((device: any) => ({
      udid: String(device?.udid || '').trim(),
      serial: String(device?.serial || '').trim(),
      name: String(device?.name || '').trim(),
      marketName: String(device?.market_name || device?.marketName || '').trim(),
      productVersion: String(device?.product_version || device?.productVersion || '').trim(),
      connType: String(device?.conn_type || device?.connType || '').trim(),
    })).filter((device: any) => device.udid);
    return { devices, error: '' };
  } catch (error: any) {
    return { devices: [] as any[], error: error.message || '检测本机 iOS 设备失败' };
  }
}

async function getQualityDevicePoolRuntimeStatus() {
  const pools = getQualityDevicePools();
  const onlineResult = await listLocalIosDevices();
  const onlineByUdid = new Map(onlineResult.devices.map((device: any) => [device.udid, device]));
  const configuredUdids = new Set<string>();

  const poolsWithStatus = pools.map((pool) => {
    const configuredDevices = deviceKeysFromPool(pool, '')
      .filter(Boolean)
      .map((udid) => {
        configuredUdids.add(udid);
        const onlineDevice = onlineByUdid.get(udid) as any;
        const activeBuild = findActiveQualityBuildOnDevice(udid);
        return {
          udid,
          label: (pool.devices || []).find((device) => device.udid === udid)?.label || onlineDevice?.name || '',
          online: Boolean(onlineDevice),
          busy: Boolean(activeBuild),
          status: activeBuild ? 'busy' : (onlineDevice ? 'idle' : 'offline'),
          activeBuildNumber: activeBuild?.buildNumber,
          name: onlineDevice?.name || '',
          marketName: onlineDevice?.marketName || '',
          productVersion: onlineDevice?.productVersion || '',
          connType: onlineDevice?.connType || '',
        };
      });
    return {
      ...pool,
      devices: configuredDevices,
      stats: {
        total: configuredDevices.length,
        online: configuredDevices.filter((device) => device.online).length,
        idle: configuredDevices.filter((device) => device.status === 'idle').length,
        busy: configuredDevices.filter((device) => device.status === 'busy').length,
        offline: configuredDevices.filter((device) => device.status === 'offline').length,
      },
    };
  });

  const unassignedDevices = onlineResult.devices
    .filter((device: any) => !configuredUdids.has(device.udid))
    .map((device: any) => ({
      ...device,
      online: true,
      busy: Boolean(findActiveQualityBuildOnDevice(device.udid)),
      status: findActiveQualityBuildOnDevice(device.udid) ? 'busy' : 'unassigned',
      activeBuildNumber: findActiveQualityBuildOnDevice(device.udid)?.buildNumber,
    }));

  return {
    pools: poolsWithStatus,
    detectedDevices: onlineResult.devices,
    unassignedDevices,
    detector: {
      available: !onlineResult.error,
      error: onlineResult.error,
    },
  };
}

async function syncQualityJenkinsJobConfig() {
  const configPath = path.join(getPlatformRootDir(), 'scripts/jenkins/nn-auto-quality-config.xml');
  if (!fs.existsSync(configPath)) {
    throw new Error(`未找到 Jenkins 质检 Job 配置模板：${configPath}`);
  }
  const configXml = fs.readFileSync(configPath, 'utf-8');
  const jobPath = encodeJobPath(DEFAULT_QA_JOB_NAME);
  const crumb = await getCrumb();
  const jobUrl = `${JENKINS_BASE_URL}/${jobPath}`;
  const existsResponse = await axios.get(`${jobUrl}/api/json`, {
    timeout: 10000,
    validateStatus: () => true,
    ...buildAuthConfig(),
  });
  const targetUrl = existsResponse.status === 200
    ? `${jobUrl}/config.xml`
    : `${JENKINS_BASE_URL}/createItem?name=${encodeURIComponent(DEFAULT_QA_JOB_NAME)}`;
  const response = await axios.post(targetUrl, configXml, {
    timeout: 30000,
    headers: {
      ...crumb.headers,
      'Content-Type': 'application/xml',
    },
    validateStatus: (status) => status >= 200 && status < 400,
    ...buildAuthConfig(),
  });
  return {
    jobName: DEFAULT_QA_JOB_NAME,
    jobUrl: `${jobUrl}/`,
    configPath,
    status: response.status,
    concurrentBuild: /<concurrentBuild>true<\/concurrentBuild>/.test(configXml),
    hasWdaDerivedDataPath: /<name>WDA_DERIVED_DATA_PATH<\/name>/.test(configXml),
  };
}

function saveQualityDevicePools(pools: QualityDevicePool[]) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(QUALITY_DEVICE_POOLS_CONFIG_PATH, JSON.stringify({
    devicePools: pools,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function buildAuthConfig() {
  const username = process.env.JENKINS_USER || '';
  const token = process.env.JENKINS_TOKEN || '';
  if (!username || !token) {
    return {};
  }
  return {
    auth: {
      username,
      password: token,
    },
  };
}

async function getCrumb() {
  try {
    const response = await axios.get(`${JENKINS_BASE_URL}/crumbIssuer/api/json`, {
      timeout: 10000,
      ...buildAuthConfig(),
    });
    if (response.data?.crumbRequestField && response.data?.crumb) {
      const cookie = (response.headers['set-cookie'] || [])
        .map((item: string) => item.split(';')[0])
        .filter(Boolean)
        .join('; ');
      return {
        headers: {
          [response.data.crumbRequestField]: response.data.crumb,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      };
    }
  } catch {
    // Jenkins 可能未启用 crumb issuer，触发构建时再按实际响应处理。
  }
  return { headers: {} };
}

function normalizeJenkinsUrl(url?: string) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    const base = new URL(JENKINS_BASE_URL);
    parsed.protocol = base.protocol;
    parsed.host = base.host;
    return parsed.toString();
  } catch {
    return url;
  }
}

function buildJenkinsArtifactUrl(jobPath: string, buildNumber: number, relativePath: string) {
  const encodedPath = relativePath
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/artifact/${encodedPath}`;
}

function buildLocalQualityArtifactUrl(filePath: string) {
  return `${LOCAL_QUALITY_ARTIFACT_ROUTE}?path=${encodeURIComponent(filePath)}`;
}

function localJenkinsJobDir(jobName: string) {
  const jenkinsHome = process.env.JENKINS_HOME || path.join(process.env.HOME || '', '.jenkins');
  const parts = jobName.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  let jobDir = path.join(jenkinsHome, 'jobs', parts[0]);
  for (const part of parts.slice(1)) {
    jobDir = path.join(jobDir, 'jobs', part);
  }
  return jobDir;
}

function localJenkinsWorkspaceDir(jobName: string) {
  const jenkinsHome = process.env.JENKINS_HOME || path.join(process.env.HOME || '', '.jenkins');
  const leafName = jobName.split('/').filter(Boolean).pop() || jobName;
  return path.join(jenkinsHome, 'workspace', leafName);
}

function localJenkinsWorkspaceDirs(jobName: string) {
  const baseDir = localJenkinsWorkspaceDir(jobName);
  const parentDir = path.dirname(baseDir);
  const leafName = path.basename(baseDir);
  const dirs = [baseDir];
  if (fs.existsSync(parentDir)) {
    for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === leafName || entry.name.startsWith(`${leafName}@`)) {
        const dir = path.join(parentDir, entry.name);
        if (!dirs.includes(dir)) dirs.push(dir);
      }
    }
  }
  return dirs;
}

function readJsonFile(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function isPathInside(parentDir: string, candidatePath: string) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isAllowedLocalQualityArtifact(filePath: string) {
  const workspaceResultsDirs = localJenkinsWorkspaceDirs(DEFAULT_QA_JOB_NAME).map((workspaceDir) => path.join(workspaceDir, 'quality-results'));
  const jobBuildsDir = path.join(localJenkinsJobDir(DEFAULT_QA_JOB_NAME), 'builds');
  return workspaceResultsDirs.some((workspaceResultsDir) => isPathInside(workspaceResultsDir, filePath)) || isPathInside(jobBuildsDir, filePath);
}

function buildLocalQualityArtifactLinks(summaryFile: string, summary: any) {
  const summaryDir = path.dirname(summaryFile);
  const artifactPath = (name?: string) => (name ? path.join(summaryDir, name) : '');
  const artifactUrl = (name?: string) => {
    const filePath = artifactPath(name);
    return filePath && fs.existsSync(filePath) ? buildLocalQualityArtifactUrl(filePath) : '';
  };

  return {
    summaryUrl: buildLocalQualityArtifactUrl(summaryFile),
    screenshotUrl: artifactUrl(summary?.artifacts?.screenshot || 'screenshot.png'),
    deviceLogUrl: artifactUrl(summary?.artifacts?.deviceLog || 'device.log'),
    processesUrl: artifactUrl(summary?.artifacts?.processes || 'processes.json'),
    monkeyReportUrl: artifactUrl(summary?.artifacts?.monkeyReport),
    performanceSamplesUrl: artifactUrl(summary?.artifacts?.performanceSamples),
    performanceTraceUrl: artifactUrl(summary?.artifacts?.performanceTrace),
    crashReportsUrl: artifactUrl(summary?.artifacts?.crashReports),
    junitUrl: artifactUrl(summary?.artifacts?.junit || 'junit.xml'),
    qualityLogUrl: artifactUrl(summary?.artifacts?.qualityLog || 'quality.log'),
  };
}

function decodeXmlText(value?: string) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function readXmlTag(xml: string, tagName: string) {
  return decodeXmlText(xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`))?.[1]?.trim() || '');
}

function readXmlParameter(xml: string, name: string) {
  const blocks = xml.match(/<hudson\.model\.[^>]*ParameterValue>[\s\S]*?<\/hudson\.model\.[^>]*ParameterValue>/g) || [];
  for (const block of blocks) {
    if (readXmlTag(block, 'name') === name) return readXmlTag(block, 'value');
  }
  return '';
}

function listLocalSummaryArtifacts(archiveDir: string) {
  const resultsDir = path.join(archiveDir, 'quality-results');
  const artifacts: Array<{ fileName: string; relativePath: string }> = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (entry.name !== 'summary.json') continue;
      artifacts.push({
        fileName: entry.name,
        relativePath: path.relative(archiveDir, filePath).split(path.sep).join('/'),
      });
    }
  };
  if (fs.existsSync(resultsDir)) visit(resultsDir);
  return artifacts;
}

function readLocalQualityBuilds(jobName: string, limit = 20) {
  const jobDir = localJenkinsJobDir(jobName);
  const buildsDir = path.join(jobDir, 'builds');
  if (!fs.existsSync(buildsDir)) return [];
  return fs.readdirSync(buildsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => b - a)
    .slice(0, limit)
    .map((buildNumber) => {
      const buildDir = path.join(buildsDir, String(buildNumber));
      const buildXmlPath = path.join(buildDir, 'build.xml');
      const logPath = path.join(buildDir, 'log');
      const xml = fs.existsSync(buildXmlPath) ? fs.readFileSync(buildXmlPath, 'utf-8') : '';
      const logTail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').slice(-4096) : '';
      const result = readXmlTag(xml, 'result') || logTail.match(/Finished:\s+([A-Z]+)/)?.[1] || '';
      const timestamp = Number(readXmlTag(xml, 'timestamp')) || fs.statSync(buildDir).mtimeMs;
      return {
        number: buildNumber,
        result,
        timestamp,
        duration: Number(readXmlTag(xml, 'duration')) || 0,
        building: !result,
        url: `${JENKINS_BASE_URL}/${encodeJobPath(jobName)}/${buildNumber}/`,
        description: readXmlTag(xml, 'description'),
        artifacts: listLocalSummaryArtifacts(path.join(buildDir, 'archive')),
      };
    });
}

function findLatestQualityFile(jobName: string, fileName: string, buildTimestamp?: number, buildNumber?: number) {
  const resultsDirs = localJenkinsWorkspaceDirs(jobName)
    .map((workspaceDir) => path.join(workspaceDir, 'quality-results'))
    .filter((resultsDir) => fs.existsSync(resultsDir));
  if (resultsDirs.length === 0) return '';
  const normalizedBuildNumber = buildNumber ? String(buildNumber) : '';
  const minMtime = Number(buildTimestamp || 0) - 5 * 60 * 1000;
  let latest = { filePath: '', mtimeMs: 0 };
  for (const resultsDir of resultsDirs) {
    for (const entry of fs.readdirSync(resultsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (normalizedBuildNumber && !entry.name.startsWith(`qa-${normalizedBuildNumber}-`)) continue;
      const candidate = path.join(resultsDir, entry.name, fileName);
      if (!fs.existsSync(candidate)) continue;
      const stat = fs.statSync(candidate);
      if (minMtime > 0 && stat.mtimeMs < minMtime) continue;
      if (stat.mtimeMs > latest.mtimeMs) {
        latest = { filePath: candidate, mtimeMs: stat.mtimeMs };
      }
    }
  }
  return latest.filePath;
}

function readLocalQualityProgress(jobName: string, build: any) {
  const progressFile = findLatestQualityFile(jobName, 'quality-progress.json', Number(build?.timestamp || 0), Number(build?.number || 0));
  return progressFile ? readJsonFile(progressFile) : null;
}

function readLocalQualitySummaryWithPath(jobName: string, build: any) {
  const summaryFile = findLatestQualityFile(jobName, 'summary.json', Number(build?.timestamp || 0), Number(build?.number || 0));
  const summary = summaryFile ? readJsonFile(summaryFile) : null;
  return summary ? { summary, filePath: summaryFile } : null;
}

function readLocalQualitySummary(jobName: string, build: any) {
  return readLocalQualitySummaryWithPath(jobName, build)?.summary || null;
}

async function hasActiveQualityScriptProcess() {
  try {
    await execFileAsync('pgrep', ['-f', 'scripts/sonic/ios-quality.sh'], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

async function buildCompletedOverride(jobName: string, build: any, localSummary?: any | null) {
  if (!build?.building || !localSummary?.status) return null;
  const status = String(localSummary.status || '').toLowerCase();
  if (status !== 'passed' && status !== 'failed') return null;
  const buildNumber = Number(build.number);
  if (!Number.isFinite(buildNumber)) return null;
  const result = status === 'passed' ? 'SUCCESS' : 'FAILURE';
  return {
    building: false,
    result,
    duration: build.duration || Math.max(0, Date.now() - Number(build.timestamp || Date.now())),
    description: [build.description, '本机检测到质检 summary 已生成，Jenkins 构建状态未及时刷新，已按本地报告纠偏。'].filter(Boolean).join('\n'),
    completedMessage: localSummary.message || (result === 'SUCCESS' ? '质检完成' : '质检失败'),
  };
}

async function buildInterruptedOverride(jobName: string, build: any) {
  if (!build?.building) return null;
  const buildNumber = Number(build.number);
  if (!Number.isFinite(buildNumber)) return null;

  const buildDir = path.join(localJenkinsJobDir(jobName), 'builds', String(buildNumber));
  const logFile = path.join(buildDir, 'log');
  const buildXml = path.join(buildDir, 'build.xml');
  if (!fs.existsSync(logFile) || fs.existsSync(buildXml)) return null;

  const stat = fs.statSync(logFile);
  const staleMs = Date.now() - stat.mtimeMs;
  if (staleMs < JENKINS_ORPHAN_BUILD_STALE_MS) return null;
  if (await hasActiveQualityScriptProcess()) return null;

  return {
    building: false,
    result: 'FAILURE',
    duration: build.duration || Math.max(0, Date.now() - Number(build.timestamp || stat.mtimeMs)),
    description: [build.description, '本机检测到质检执行进程已退出，Jenkins 构建记录未正常收尾。'].filter(Boolean).join('\n'),
    interruptedMessage: '质检执行进程已退出，Jenkins 构建记录未正常收尾，已按中断处理。',
  };
}

async function stopJenkinsBuild(jobName: string, buildNumber: number) {
  const jobPath = encodeJobPath(jobName);
  const crumb = await getCrumb();
  await axios.post(`${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/stop`, null, {
    timeout: 30000,
    headers: {
      ...crumb.headers,
    },
    ...buildAuthConfig(),
  });
  return jobPath;
}

async function cleanupLocalQualityProcesses() {
  const patterns = [
    'scripts/sonic/ios-quality.sh',
    'WebDriverAgentRunner',
    'xcodebuild.*WebDriverAgentRunner',
    'iproxy.*8100',
    'tidevice.*perf',
  ];
  await Promise.all(patterns.map(async (pattern) => {
    try {
      await execFileAsync('pkill', ['-f', pattern], { timeout: 1500 });
    } catch {
      // 没有匹配进程时 pkill 会返回非 0，忽略即可。
    }
  }));
}

function parseBuildDescription(description?: string | null) {
  const text = (description || '').trim();
  const match = text.match(/^([^,，]+)[,，]\s*(.+)$/);
  if (!match) {
    return {
      publishChannel: text || '',
      buildNumber: '',
    };
  }
  return {
    publishChannel: match[1].trim(),
    buildNumber: match[2].trim(),
  };
}

function normalizeDeployTarget(value?: string) {
  const text = (value || '').replace(/[,，]/g, '').trim();
  if (!text) return '';
  if (/pgyer|蒲公英/i.test(text)) return 'Pgyer';
  if (/test\s*flight/i.test(text)) return 'TestFlight';
  if (/app\s*store|苹果商店/i.test(text)) return 'AppStore';
  return text;
}

function isReleaseBranch(branch: string) {
  return /^(?:origin\/)?release\/\d+(?:\.\d+){2,}$/.test(branch.trim());
}

function normalizeBranchName(branch: string) {
  return branch.trim().replace(/^origin\//, '');
}

function toJenkinsBranch(branch: string) {
  const trimmed = branch.trim();
  if (!trimmed || trimmed.startsWith('origin/') || trimmed.startsWith('refs/')) {
    return trimmed;
  }
  return `origin/${trimmed}`;
}

function extractErrorMessage(error: any, fallback: string) {
  const data = error.response?.data;
  if (typeof data === 'string') {
    const text = data
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text || error.message || fallback;
  }
  return data?.message || data?.error || error.message || fallback;
}

function getGitCredentials() {
  return {
    username: process.env.GIT_USERNAME || undefined,
    password: process.env.GIT_PASSWORD || undefined,
  };
}

function parseConsoleMetadata(consoleText: string) {
  const plainConsoleText = consoleText.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  const appVersion =
    plainConsoleText.match(/ASC_VERSION\s*=\s*([0-9]+(?:\.[0-9]+)+)/)?.[1] ||
    plainConsoleText.match(/版本号[:：]\s*([0-9]+(?:\.[0-9]+)+)/)?.[1] ||
    plainConsoleText.match(/显示版本[:：]\s*([0-9]+(?:\.[0-9]+)+)/)?.[1] ||
    plainConsoleText.match(/MARKETING_VERSION:\s*[^→\n]*→\s*([0-9]+(?:\.[0-9]+)+)/)?.[1] ||
    '';
  const publishChannel = normalizeDeployTarget(
    plainConsoleText.match(/发布渠道[:：]\s*([^\n\r]+)/)?.[1],
  );
  const packageUrl =
    plainConsoleText.match(/蒲公英链接[:：]\s*(https?:\/\/\S+)/)?.[1] ||
    plainConsoleText.match(/蒲公英版本[:：].*?\((https?:\/\/[^)\s]+)/)?.[1] ||
    plainConsoleText.match(/build\s*\[[0-9]+\]\((https?:\/\/[^)\s]+)\)/i)?.[1] ||
    '';
  const installPackageUrl = (
    plainConsoleText.match(/IPA\s*构建成功[:：]\s*(\/[^\r\n]+?\.ipa)\b/i)?.[1] ||
    plainConsoleText.match(/Successfully exported and signed the ipa file:\s*\r?\n\s*(\/[^\r\n]+?\.ipa)\b/i)?.[1] ||
    plainConsoleText.match(/发现IPA文件[:：]\s*([^\r\n]+?\.ipa)\b/i)?.[1] ||
    plainConsoleText.match(/IPA文件[:：]\s*([^\r\n]+?\.ipa)\b/i)?.[1] ||
    ''
  ).trim();
  const buildNumber =
    plainConsoleText.match(/CHANNEL_BUILD_NUMBER\s*=\s*([0-9]+)/)?.[1] ||
    plainConsoleText.match(/渠道构建号[:：]\s*([0-9]+)/)?.[1] ||
    plainConsoleText.match(/(?:蒲公英|Pgyer|TestFlight|AppStore|苹果商店)\s*构建号[:：]\s*([0-9]+)/i)?.[1] ||
    plainConsoleText.match(/CURRENT_PROJECT_VERSION:\s*[^→\n]*→\s*([0-9]+)/)?.[1] ||
    (packageUrl ? plainConsoleText.match(/build\s*\[([0-9]+)\]\((https?:\/\/[^)\s]+)\)/i)?.[1] : '') ||
    '';
  const archivePath = (
    plainConsoleText.match(/-archivePath\s+(.+?\.xcarchive)/)?.[1] ||
    plainConsoleText.match(/archivePath\s+(.+?\.xcarchive)/)?.[1] ||
    ''
  ).replace(/\\/g, '').trim();
  const archiveRelativePath = archivePath.match(/\/Archives\/(.+)$/)?.[1] || '';
  const archiveUrl = archiveRelativePath
    ? `smb://127.0.0.1/Archives/${encodeURI(archiveRelativePath)}`
    : '';

  return {
    appVersion,
    publishChannel,
    commitHash: parseCheckoutRevision(consoleText),
    buildNumber,
    packageUrl,
    installPackageUrl,
    channelQrUrl: publishChannel === 'Pgyer' ? packageUrl : '',
    xcarchivePath: archivePath,
    archiveUrl,
  };
}

function parseCheckoutRevision(consoleText: string) {
  return (
    consoleText.match(/Checking out Revision\s+([0-9a-f]{7,40})/i)?.[1] ||
    consoleText.match(/git checkout -f\s+([0-9a-f]{7,40})/i)?.[1] ||
    consoleText.match(/git rev-list --no-walk\s+([0-9a-f]{7,40})/i)?.[1] ||
    ''
  );
}

async function fetchBuildConsoleMetadata(jobPath: string, buildNumber: number) {
  try {
    const response = await axios.get(`${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/consoleText`, {
      timeout: JENKINS_BUILD_METADATA_TIMEOUT_MS,
      ...buildAuthConfig(),
    });
    return parseConsoleMetadata(String(response.data || ''));
  } catch {
    return {
      appVersion: '',
      publishChannel: '',
      commitHash: '',
      buildNumber: '',
      packageUrl: '',
      installPackageUrl: '',
      channelQrUrl: '',
      xcarchivePath: '',
      archiveUrl: '',
    };
  }
}

function parseQualityConsoleSummary(consoleText: string) {
  const plain = consoleText.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  const toNumber = (value?: string) => {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const sourceBuildNumber = plain.match(/源构建:\s*([^\n\r]+)/)?.[1]?.trim() || '';
  const branch = plain.match(/分支:\s*([^\n\r]+)/)?.[1]?.trim() || '';
  const commitHash = plain.match(/Commit:\s*([0-9a-f]{7,40})/i)?.[1]?.trim() || '';
  const appVersion = plain.match(/APP版本:\s*([^\n\r]+)/)?.[1]?.trim() || '';
  const testSuite = plain.match(/测试套件:\s*([^\n\r]+)/)?.[1]?.trim() || '';
  const devicePoolMatch = plain.match(/设备池:\s*([^\n\r]+)/)?.[1]?.trim() || '';
  const deviceUdid = plain.match(/使用设备:\s*([^\n\r]+)/)?.[1]?.trim() || '';
  const launchDurationMs = toNumber(plain.match(/启动命令耗时:\s*(\d+)ms/i)?.[1]);
  const coldStartReadyMs = toNumber(plain.match(/冷启动稳定耗时:\s*(\d+)ms/i)?.[1]);
  const coldStartWaitSeconds = toNumber(plain.match(/稳定等待\s*(\d+)s/i)?.[1]);
  const monkeyMatch = plain.match(/Monkey 结果:\s*([^，,\n\r]+)[，,]\s*执行\s*(\d+)\/(\d+)\s*次[，,]?\s*([^\n\r]*)/i);
  const resultDirName = plain.match(/质检结果目录:\s*.*\/quality-results\/([^/\s]+)/)?.[1]?.trim() || '';
  const bundleId = (
    plain.match(/启动 App:\s*([^\n\r]+)/)?.[1]?.trim() ||
    plain.match(/Launched application with\s+([^\s]+)\s+bundle identifier/i)?.[1]?.trim() ||
    ''
  );
  const message = plain.match(/ERROR:\s*([^\n\r]+)/)?.[1]?.trim() || (
    /Finished:\s+SUCCESS/.test(plain) ? '安装和启动成功' : ''
  );
  const status = /Finished:\s+SUCCESS/.test(plain)
    ? 'passed'
    : (/Finished:\s+FAILURE|ERROR:/i.test(plain) ? 'failed' : '');

  return {
    status,
    message,
    sourceBuildNumber,
    branch,
    commitHash,
    appVersion,
    testSuite,
    devicePool: '',
    devicePoolLabel: devicePoolMatch.replace(/\s*\([^)]+\)\s*$/, ''),
    deviceUdid,
    bundleId,
    launchMethod: /Launched application with/i.test(plain) ? 'devicectl' : '',
    launchDurationMs,
    coldStartReadyMs,
    coldStartWaitSeconds,
    monkeyStatus: monkeyMatch?.[1]?.trim() || '',
    monkeyExecutedEvents: toNumber(monkeyMatch?.[2]),
    monkeyEventCount: toNumber(monkeyMatch?.[3]),
    monkeyMessage: monkeyMatch?.[4]?.trim() || '',
    resultDirName,
  };
}

async function fetchQualityConsoleSummary(jobPath: string, buildNumber: number) {
  const response = await axios.get(`${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/consoleText`, {
    timeout: 10000,
    responseType: 'text',
    ...buildAuthConfig(),
  });
  return parseQualityConsoleSummary(String(response.data || ''));
}

async function fetchQualitySummary(jobPath: string, build: any) {
  const buildNumber = Number(build.number);
  const artifacts = Array.isArray(build.artifacts) ? build.artifacts : [];
  let consoleSummary: any | null = null;
  try {
    consoleSummary = await fetchQualityConsoleSummary(jobPath, buildNumber);
  } catch {
    consoleSummary = null;
  }
  const summaryArtifacts = artifacts.filter((artifact: any) => String(artifact?.relativePath || '').endsWith('/summary.json'));
  const summaryArtifact = (
    summaryArtifacts.find((artifact: any) => String(artifact?.relativePath || '').includes(`/qa-${buildNumber}-`)) ||
    summaryArtifacts.find((artifact: any) => String(artifact?.relativePath || '').startsWith(`quality-results/qa-${buildNumber}-`)) ||
    summaryArtifacts.find((artifact: any) => consoleSummary?.resultDirName && String(artifact?.relativePath || '') === `quality-results/${consoleSummary.resultDirName}/summary.json`) ||
    summaryArtifacts[summaryArtifacts.length - 1]
  );

  if (summaryArtifact?.relativePath) {
    const summaryUrl = buildJenkinsArtifactUrl(jobPath, buildNumber, summaryArtifact.relativePath);
    try {
      const response = await axios.get(summaryUrl, {
        timeout: 10000,
        responseType: 'json',
        ...buildAuthConfig(),
      });
      const summary = response.data || {};
      const summaryDir = path.posix.dirname(summaryArtifact.relativePath);
      const artifactRel = (name?: string) => (name ? path.posix.join(summaryDir, name) : '');
      const artifactUrl = (name?: string) => (name ? buildJenkinsArtifactUrl(jobPath, buildNumber, artifactRel(name)) : '');
      const mergedSummary = {
        ...(consoleSummary || {}),
        ...summary,
      };
      if (build.result === 'FAILURE' && consoleSummary?.status === 'failed') {
        mergedSummary.status = 'failed';
        mergedSummary.message = consoleSummary.message || mergedSummary.message;
      }
      return {
        ...mergedSummary,
        artifacts: {
          summaryUrl,
          screenshotUrl: artifactUrl(summary.artifacts?.screenshot || 'screenshot.png'),
          deviceLogUrl: artifactUrl(summary.artifacts?.deviceLog || 'device.log'),
          processesUrl: artifactUrl(summary.artifacts?.processes || 'processes.json'),
          monkeyReportUrl: artifactUrl(summary.artifacts?.monkeyReport),
          performanceSamplesUrl: artifactUrl(summary.artifacts?.performanceSamples),
          performanceTraceUrl: artifactUrl(summary.artifacts?.performanceTrace),
          crashReportsUrl: artifactUrl(summary.artifacts?.crashReports),
          junitUrl: artifactUrl(summary.artifacts?.junit || 'junit.xml'),
          qualityLogUrl: artifactUrl(summary.artifacts?.qualityLog || 'quality.log'),
        },
      };
    } catch {
      // summary artifact 读取失败时继续走 console 兜底。
    }
  }

  try {
    return {
      ...(consoleSummary || await fetchQualityConsoleSummary(jobPath, buildNumber)),
      artifacts: {},
    };
  } catch {
    return {
      status: build.result === 'SUCCESS' ? 'passed' : (build.result === 'FAILURE' ? 'failed' : ''),
      message: build.result === 'SUCCESS' ? '质检成功' : '',
      artifacts: {},
    };
  }
}

async function fetchJenkinsTextArtifact(url: string, limitBytes = 1024 * 1024) {
  const response = await axios.get(url, {
    timeout: 15000,
    responseType: 'stream',
    ...buildAuthConfig(),
  });

  return await new Promise<{ content: string; truncated: boolean; contentType: string }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    const stream = response.data;
    stream.on('data', (chunk: Buffer) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = limitBytes - total;
      if (remaining > 0) {
        chunks.push(buffer.subarray(0, remaining));
        total += Math.min(buffer.length, remaining);
      }
      if (buffer.length > remaining) {
        truncated = true;
        stream.destroy();
      }
    });
    stream.on('end', () => {
      resolve({
        content: Buffer.concat(chunks).toString('utf-8'),
        truncated,
        contentType: String(response.headers['content-type'] || ''),
      });
    });
    stream.on('error', (error: Error) => {
      if (truncated) {
        resolve({
          content: Buffer.concat(chunks).toString('utf-8'),
          truncated,
          contentType: String(response.headers['content-type'] || ''),
        });
        return;
      }
      reject(error);
    });
  });
}

async function readLocalQualityTextArtifact(filePath: string, limitBytes = 1024 * 1024) {
  const resolvedPath = path.resolve(filePath);
  if (!isAllowedLocalQualityArtifact(resolvedPath) || !fs.existsSync(resolvedPath)) {
    throw new Error('本机质检文件不存在或不允许访问');
  }
  const stat = fs.statSync(resolvedPath);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(resolvedPath).slice(0, 500);
    return {
      content: entries.join('\n'),
      truncated: false,
      contentType: 'text/plain',
    };
  }
  if (/\.(trace|ipa|png|jpg|jpeg|zip)$/i.test(resolvedPath)) {
    throw new Error('该文件不是文本格式，请使用打开/下载查看');
  }
  const file = fs.openSync(resolvedPath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, limitBytes));
    const bytesRead = fs.readSync(file, buffer, 0, buffer.length, 0);
    return {
      content: buffer.subarray(0, bytesRead).toString('utf-8'),
      truncated: stat.size > limitBytes,
      contentType: /\.json$/i.test(resolvedPath) ? 'application/json' : (/\.xml$/i.test(resolvedPath) ? 'application/xml' : 'text/plain'),
    };
  } finally {
    fs.closeSync(file);
  }
}

async function fetchThirdSdkDependencies(branch: string, revision?: string): Promise<{
  branch: string;
  revision?: string;
  dependencies: ThirdSdkDependency[];
  missingFiles: string[];
  error?: string;
}> {
  try {
    const normalizedBranch = normalizeBranchName(branch || 'develop') || 'develop';
    const normalizedRevision = revision && /^[0-9a-f]{7,40}$/i.test(revision) ? revision : undefined;
    const index = await podDepsResolver.loadNniosIndex(normalizedBranch, getGitCredentials(), undefined, normalizedRevision);
    const dependencies = index.sources
      .filter((item) => item.sourceFile === 'third_sdk.rb')
      .map((item) => ({
        name: item.podName,
        version: item.version || item.tag || item.branch || item.commit || item.pathRef || '-',
        source: item.raw,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      branch: index.branch,
      revision: normalizedRevision,
      dependencies,
      missingFiles: index.missingFiles.filter((file) => file === 'third_sdk.rb'),
    };
  } catch (error: any) {
    return {
      branch: normalizeBranchName(branch || 'develop') || 'develop',
      revision,
      dependencies: [],
      missingFiles: [],
      error: error.message || '读取 third_sdk.rb 失败',
    };
  }
}

async function fetchBuildParameters(jobPath: string, buildNumber: number) {
  try {
    const response = await axios.get(`${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/api/json`, {
      timeout: JENKINS_BUILD_METADATA_TIMEOUT_MS,
      params: {
        tree: 'actions[parameters[name,value]]',
      },
      ...buildAuthConfig(),
    });
    const parameters = (response.data?.actions || [])
      .flatMap((action: any) => Array.isArray(action.parameters) ? action.parameters : []);
    const getParam = (name: string) => parameters.find((item: any) => item.name === name)?.value;
    return {
      branchName: String(getParam('branch') || '').replace(/^origin\//, ''),
    };
  } catch {
    return {
      branchName: '',
    };
  }
}

async function resolveChannelBuildNumber(
  publishChannel: string,
  currentBuildNumber: string,
  jenkinsBuildNumber: number,
) {
  const normalizedChannel = normalizeDeployTarget(publishChannel);
  const normalizedCurrent = String(currentBuildNumber || '').trim();
  if (normalizedChannel === 'Pgyer') {
    return normalizedCurrent;
  }
  if (normalizedChannel !== 'AppStore' && normalizedChannel !== 'TestFlight') {
    return normalizedCurrent === String(jenkinsBuildNumber) ? '' : normalizedCurrent;
  }

  return normalizedCurrent === String(jenkinsBuildNumber) ? '' : normalizedCurrent;
}

async function fetchJenkinsJobJson(jobPath: string, tree?: string) {
  const url = `${JENKINS_BASE_URL}/${jobPath}/api/json`;
  if (tree) {
    try {
      return await axios.get(url, {
        timeout: JENKINS_LIST_TIMEOUT_MS,
        params: { tree },
        ...buildAuthConfig(),
      });
    } catch (error: any) {
      if (error.response?.status >= 500) {
        return axios.get(url, {
          timeout: JENKINS_LIST_TIMEOUT_MS,
          ...buildAuthConfig(),
        });
      }
      throw error;
    }
  }
  return axios.get(url, {
    timeout: JENKINS_LIST_TIMEOUT_MS,
    ...buildAuthConfig(),
  });
}

router.get('/nn/branches', async (_req: Request, res: Response) => {
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', DEFAULT_REPO_URL], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    const branches = stdout
      .split('\n')
      .map((line) => line.match(/refs\/heads\/(.+)$/)?.[1])
      .filter((branch): branch is string => Boolean(branch))
      .filter((branch) => !branch.includes('HEAD'))
      .sort((a, b) => {
        if (a === 'develop') return -1;
        if (b === 'develop') return 1;
        if (a.startsWith('release/') && !b.startsWith('release/')) return -1;
        if (!a.startsWith('release/') && b.startsWith('release/')) return 1;
        return b.localeCompare(a);
      });

    res.json({
      success: true,
      data: branches,
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: error.message || '查询 Jenkins 分支列表失败',
    });
  }
});

router.get('/nn/builds', async (req: Request, res: Response) => {
  try {
    const jobPath = encodeJobPath(DEFAULT_JOB_NAME);
    const deployTargetFilter = normalizeDeployTarget(String(req.query.deployTarget || ''));
    const tree = [
      'displayName',
      'fullName',
      'url',
      'buildable',
      'color',
      'lastBuild[number,result,timestamp,duration,building,url,description]',
      `builds[number,result,timestamp,duration,building,url,description]{0,${RELEASE_BUILD_LIST_LIMIT}}`,
    ].join(',');
    const response = await fetchJenkinsJobJson(jobPath, tree);

    const job = response.data || {};
    const rawBuilds = Array.isArray(job.builds) ? job.builds.slice(0, RELEASE_BUILD_LIST_LIMIT) : [];
    const buildsWithMetadata = await Promise.all(rawBuilds.map(async (build: any) => {
      const descriptionMetadata = parseBuildDescription(build.description);
      const [consoleMetadata, buildParameters] = await Promise.all([
        fetchBuildConsoleMetadata(jobPath, build.number),
        fetchBuildParameters(jobPath, build.number),
      ]);
      const publishChannel = consoleMetadata.publishChannel || normalizeDeployTarget(descriptionMetadata.publishChannel);
      const appVersion = consoleMetadata.appVersion;
      const buildNumber = await resolveChannelBuildNumber(
        publishChannel,
        consoleMetadata.buildNumber || descriptionMetadata.buildNumber,
        build.number,
      );
      return {
        ...build,
        url: normalizeJenkinsUrl(build.url),
        branchName: buildParameters.branchName,
        publishChannel,
        commitHash: consoleMetadata.commitHash,
        buildNumber,
        appVersion,
        packageUrl: consoleMetadata.packageUrl,
        installPackageUrl: consoleMetadata.installPackageUrl,
        channelQrUrl: consoleMetadata.channelQrUrl,
        xcarchivePath: consoleMetadata.xcarchivePath,
        archiveUrl: consoleMetadata.archiveUrl,
      };
    }));
    const builds = deployTargetFilter
      ? buildsWithMetadata.filter((build: any) => normalizeDeployTarget(build.publishChannel) === deployTargetFilter)
      : buildsWithMetadata;
    const running = builds.filter((build: any) => build.building).length;
    const success = builds.filter((build: any) => build.result === 'SUCCESS').length;
    const finished = builds.filter((build: any) => !build.building && build.result).length;
    const lastBuild = job.lastBuild
      ? {
          ...job.lastBuild,
          url: normalizeJenkinsUrl(job.lastBuild.url),
          ...parseBuildDescription(job.lastBuild.description),
        }
      : job.lastBuild;

    res.json({
      success: true,
      data: {
        job: {
          name: job.displayName || DEFAULT_JOB_NAME,
          fullName: job.fullName || DEFAULT_JOB_NAME,
          url: normalizeJenkinsUrl(job.url) || `${JENKINS_BASE_URL}/${jobPath}/`,
          buildable: job.buildable !== false,
          color: job.color,
          lastBuild,
        },
        stats: {
          total: builds.length,
          running,
          latestBuild: job.lastBuild?.number || '-',
          successRate: finished > 0 ? `${Math.round((success / finished) * 100)}%` : '-',
        },
        builds,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '查询 Jenkins 构建列表失败'),
      status: error.response?.status,
    });
  }
});

router.get('/nn/builds/:number/log', async (req: Request, res: Response) => {
  try {
    const jobPath = encodeJobPath(DEFAULT_JOB_NAME);
    const buildNumber = Number(req.params.number);
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) {
      res.status(400).json({
        success: false,
        error: '构建号无效',
      });
      return;
    }

    const response = await axios.get(`${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/consoleText`, {
      timeout: 30000,
      responseType: 'text',
      ...buildAuthConfig(),
    });
    const log = String(response.data || '');
    const buildParameters = await fetchBuildParameters(jobPath, buildNumber);
    const checkoutRevision = parseCheckoutRevision(log);
    const thirdSdk = await fetchThirdSdkDependencies(buildParameters.branchName || 'develop', checkoutRevision);

    res.json({
      success: true,
      data: {
        jobName: DEFAULT_JOB_NAME,
        buildNumber,
        log,
        thirdSdkBranch: thirdSdk.branch,
        thirdSdkRevision: thirdSdk.revision,
        thirdSdkDependencies: thirdSdk.dependencies,
        thirdSdkMissingFiles: thirdSdk.missingFiles,
        thirdSdkError: thirdSdk.error,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '获取 Jenkins 打包日志失败'),
      status: error.response?.status,
    });
  }
});

router.get('/nn/quality/local-artifact', async (req: Request, res: Response) => {
  try {
    const filePath = path.resolve(String(req.query.path || ''));
    if (!isAllowedLocalQualityArtifact(filePath) || !fs.existsSync(filePath)) {
      res.status(404).send('Not found');
      return;
    }
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      res.type('text/plain').send(fs.readdirSync(filePath).join('\n'));
      return;
    }
    res.sendFile(filePath);
  } catch (error: any) {
    res.status(500).send(error.message || '读取本机质检文件失败');
  }
});

router.get('/nn/quality/artifact-preview', async (req: Request, res: Response) => {
  try {
    const artifactUrl = String(req.query.url || '').trim();
    if (!artifactUrl) {
      res.status(400).json({ success: false, error: 'url 不能为空' });
      return;
    }
    const parsedUrl = new URL(artifactUrl, `http://local${LOCAL_QUALITY_ARTIFACT_ROUTE}`);
    const jenkinsUrl = new URL(JENKINS_BASE_URL);
    const isLocalQualityArtifact = parsedUrl.pathname === LOCAL_QUALITY_ARTIFACT_ROUTE;
    if (!isLocalQualityArtifact && (parsedUrl.origin !== jenkinsUrl.origin || !parsedUrl.pathname.includes('/artifact/'))) {
      res.status(400).json({ success: false, error: '只允许预览当前 Jenkins 的 artifact 文件' });
      return;
    }
    if (/\.(trace|ipa|png|jpg|jpeg|zip)$/i.test(parsedUrl.pathname)) {
      res.status(400).json({ success: false, error: '该文件不是文本格式，请使用打开/下载查看' });
      return;
    }

    const preview = isLocalQualityArtifact
      ? await readLocalQualityTextArtifact(String(parsedUrl.searchParams.get('path') || ''))
      : await fetchJenkinsTextArtifact(artifactUrl);
    let content = preview.content;
    let format: 'text' | 'json' | 'xml' = 'text';
    if (/\.json($|[?#])/i.test(parsedUrl.pathname) || /application\/json/i.test(preview.contentType)) {
      try {
        content = JSON.stringify(JSON.parse(content), null, 2);
        format = 'json';
      } catch {
        format = 'text';
      }
    } else if (/\.xml($|[?#])/i.test(parsedUrl.pathname) || /xml/i.test(preview.contentType)) {
      format = 'xml';
    }

    res.json({
      success: true,
      data: {
        url: artifactUrl,
        content,
        contentType: preview.contentType,
        format,
        truncated: preview.truncated,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '读取质检结果文件失败'),
    });
  }
});

router.get('/nn/quality/builds', async (_req: Request, res: Response) => {
  try {
    const jobPath = encodeJobPath(DEFAULT_QA_JOB_NAME);
    const tree = [
      'displayName',
      'fullName',
      'url',
      'buildable',
      'color',
      'lastBuild[number,result,timestamp,duration,building,url,description]',
      'builds[number,result,timestamp,duration,building,url,description,artifacts[fileName,relativePath]]{0,20}',
    ].join(',');
    let job: any;
    try {
      const response = await fetchJenkinsJobJson(jobPath, tree);
      job = response.data || {};
    } catch (error) {
      const localBuilds = readLocalQualityBuilds(DEFAULT_QA_JOB_NAME);
      if (localBuilds.length === 0) throw error;
      job = {
        displayName: DEFAULT_QA_JOB_NAME,
        fullName: DEFAULT_QA_JOB_NAME,
        url: `${JENKINS_BASE_URL}/${jobPath}/`,
        buildable: true,
        color: 'notbuilt',
        lastBuild: localBuilds[0],
        builds: localBuilds,
        localFallback: true,
      };
    }
    const builds = await Promise.all((Array.isArray(job.builds) ? job.builds : []).map(async (build: any) => {
      const localSummaryResult = readLocalQualitySummaryWithPath(DEFAULT_QA_JOB_NAME, build);
      const localSummary = localSummaryResult?.summary || null;
      const localArtifactLinks = localSummaryResult?.filePath
        ? buildLocalQualityArtifactLinks(localSummaryResult.filePath, localSummary)
        : {};
      const localProgress = readLocalQualityProgress(DEFAULT_QA_JOB_NAME, build);
      const completedOverride = await buildCompletedOverride(DEFAULT_QA_JOB_NAME, build, localSummary);
      const interruptedOverride = completedOverride ? null : await buildInterruptedOverride(DEFAULT_QA_JOB_NAME, build);
      const stateOverride = completedOverride || interruptedOverride;
      const normalizedBuild = stateOverride ? { ...build, ...stateOverride } : build;
      const qualitySummary = job.localFallback ? {
        status: normalizedBuild.result === 'SUCCESS' || normalizedBuild.result === 'UNSTABLE' ? 'passed' : (normalizedBuild.result === 'FAILURE' ? 'failed' : ''),
        message: normalizedBuild.result === 'UNSTABLE' ? '质检完成，Jenkins 标记为 UNSTABLE' : '',
        artifacts: {},
      } : await fetchQualitySummary(jobPath, normalizedBuild);
      const mergedQualitySummary = interruptedOverride
        ? {
            ...qualitySummary,
            status: 'failed',
            message: interruptedOverride.interruptedMessage,
          }
        : {
            ...qualitySummary,
            ...(localSummary || {}),
            artifacts: {
              ...(localSummary?.artifacts || {}),
              ...localArtifactLinks,
              ...(qualitySummary.artifacts || {}),
            },
            message: completedOverride?.completedMessage || localSummary?.message || qualitySummary.message,
          };
      return {
        ...normalizedBuild,
        url: normalizeJenkinsUrl(normalizedBuild.url),
        artifacts: [],
        qualitySummary: {
          ...mergedQualitySummary,
          progress: localProgress || mergedQualitySummary.progress,
        },
      };
    }));
    const running = builds.filter((build: any) => build.building).length;
    const success = builds.filter((build: any) => build.result === 'SUCCESS').length;
    const finished = builds.filter((build: any) => !build.building && build.result).length;

    res.json({
      success: true,
      data: {
        job: {
          name: job.displayName || DEFAULT_QA_JOB_NAME,
          fullName: job.fullName || DEFAULT_QA_JOB_NAME,
          url: normalizeJenkinsUrl(job.url) || `${JENKINS_BASE_URL}/${jobPath}/`,
          buildable: job.buildable !== false,
          color: job.color,
        },
        stats: {
          total: builds.length,
          running,
          latestBuild: job.lastBuild?.number || '-',
          successRate: finished > 0 ? `${Math.round((success / finished) * 100)}%` : '-',
        },
        builds,
      },
    });
  } catch (error: any) {
    if (error.response?.status === 404) {
      res.status(404).json({
        success: false,
        error: `未找到 Jenkins 自动质检 Job：${DEFAULT_QA_JOB_NAME}，请先在 Jenkins 中创建或通过 JENKINS_NN_QA_JOB 配置正确 Job 名称`,
        status: 404,
      });
      return;
    }
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '查询 Jenkins 自动质检列表失败'),
      status: error.response?.status,
    });
  }
});

router.get('/nn/quality/sonic/status', async (_req: Request, res: Response) => {
  const sonicConfig = getSonicConfig();
  const configured = Boolean(sonicConfig.apiBase);
  const status = {
    configured,
    apiBase: sonicConfig.apiBase || '',
    webUrl: sonicConfig.webUrl || '',
    apiProxyTarget: sonicConfig.apiProxyTarget || '',
    webProxyTarget: sonicConfig.webProxyTarget || '',
    tokenConfigured: Boolean(sonicConfig.token),
    projectId: sonicConfig.projectId || '',
    testPlanId: sonicConfig.testPlanId || '',
    reachable: false,
    message: configured
      ? (sonicConfig.token ? 'Sonic 已配置，等待连通性检测' : 'Sonic API 已配置，Token 未配置')
      : '未配置 SONIC_API_BASE',
  };

  if (!configured) {
    res.json({
      success: true,
      data: status,
    });
    return;
  }

  try {
    const apiTargetResponse = await axios.get(`${sonicConfig.apiProxyTarget}/`, {
      timeout: 5000,
      validateStatus: () => true,
    });
    const webTargetResponse = await axios.get(`${sonicConfig.webProxyTarget}/`, {
      timeout: 5000,
      validateStatus: () => true,
    });
    const response = await axios.get(`${sonicConfig.apiBase}/`, {
      timeout: 5000,
      headers: sonicConfig.token ? {
        Authorization: `Bearer ${sonicConfig.token}`,
      } : undefined,
      validateStatus: () => true,
    });
    res.json({
      success: true,
      data: {
        ...status,
        reachable: response.status >= 200 && response.status < 500,
        message: `Sonic API ${response.status}，代理目标 API ${apiTargetResponse.status}，Web ${webTargetResponse.status}`,
      },
    });
  } catch (error: any) {
    const targetMessage = getConnectionErrorMessage(error);
    res.json({
      success: true,
      data: {
        ...status,
        reachable: false,
        message: `Sonic 代理目标未启动或不可达：${targetMessage}。请确认 Sonic Server(API ${sonicConfig.apiProxyTarget}) 和 Sonic Web(${sonicConfig.webProxyTarget}) 已启动。`,
      },
    });
  }
});

router.get('/nn/quality/sonic/device-pools', async (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: getQualityDevicePools(),
  });
});

router.get('/nn/quality/sonic/device-pools/status', async (_req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      data: await getQualityDevicePoolRuntimeStatus(),
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || '读取质检设备池状态失败',
    });
  }
});

router.put('/nn/quality/sonic/device-pools', async (req: Request, res: Response) => {
  try {
    const pools = (Array.isArray(req.body?.devicePools) ? req.body.devicePools : [])
      .map(normalizeQualityDevicePool)
      .filter(Boolean) as QualityDevicePool[];

    if (pools.length === 0) {
      res.status(400).json({
        success: false,
        error: '至少需要配置一个质检设备池',
      });
      return;
    }

    const values = new Set<string>();
    for (const pool of pools) {
      if (values.has(pool.value)) {
        res.status(400).json({
          success: false,
          error: `设备池 value 重复：${pool.value}`,
        });
        return;
      }
      values.add(pool.value);
    }

    saveQualityDevicePools(pools);

    res.json({
      success: true,
      data: pools,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || '保存质检设备池失败',
    });
  }
});

router.post('/nn/quality/job/sync', async (_req: Request, res: Response) => {
  try {
    const data = await syncQualityJenkinsJobConfig();
    res.json({
      success: true,
      data,
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '同步 Jenkins 自动质检 Job 配置失败'),
      status: error.response?.status,
    });
  }
});

router.post('/nn/build', async (req: Request, res: Response) => {
  try {
    const jobPath = encodeJobPath(DEFAULT_JOB_NAME);
    const deployTarget = String(req.body?.deployTarget || 'Pgyer');
    const verificationPassword = String(req.body?.verificationPassword || '');
    const branch = normalizeBranchName(String(req.body?.branch || 'develop'));
    const jenkinsBranch = toJenkinsBranch(branch);

    if (!DEPLOY_TARGETS.has(deployTarget)) {
      res.status(400).json({
        success: false,
        error: '发布渠道无效',
      });
      return;
    }
    if (deployTarget !== 'Pgyer' && !isReleaseBranch(branch)) {
      res.status(400).json({
        success: false,
        error: 'TestFlight / 苹果商店只能选择 release/x.x.x 格式分支',
      });
      return;
    }
    if (deployTarget !== 'Pgyer' && !verificationPassword.trim()) {
      res.status(400).json({
        success: false,
        error: 'TestFlight / 苹果商店发布需要填写验证密码',
      });
      return;
    }

    const crumb = await getCrumb();
    const params = new URLSearchParams({
      branch,
      DEPLOY_TARGET: deployTarget,
      VERIFICATION_PASSWORD: verificationPassword,
      NOTIFY_WECHAT_ON_SUCCESS: 'true',
      FORCE_PRIVATE_POD_UPDATE: 'false',
    });
    params.set('branch', jenkinsBranch);

    await axios.post(`${JENKINS_BASE_URL}/${jobPath}/buildWithParameters`, params.toString(), {
      timeout: 30000,
      headers: {
        ...crumb.headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      ...buildAuthConfig(),
    });

    res.json({
      success: true,
      data: {
        jobName: DEFAULT_JOB_NAME,
        deployTarget,
        branch,
        jenkinsBranch,
        url: `${JENKINS_BASE_URL}/${jobPath}/`,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '触发 Jenkins 发布失败'),
      status: error.response?.status,
    });
  }
});

router.post('/nn/builds/:number/stop', async (req: Request, res: Response) => {
  try {
    const buildNumber = Number(req.params.number);
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) {
      res.status(400).json({
        success: false,
        error: '构建号无效',
      });
      return;
    }

    await stopJenkinsBuild(DEFAULT_JOB_NAME, buildNumber);

    res.json({
      success: true,
      data: {
        jobName: DEFAULT_JOB_NAME,
        buildNumber,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '取消 Jenkins 构建失败'),
      status: error.response?.status,
    });
  }
});

router.post('/nn/quality/builds/:number/stop', async (req: Request, res: Response) => {
  try {
    const buildNumber = Number(req.params.number);
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) {
      res.status(400).json({
        success: false,
        error: '质检任务号无效',
      });
      return;
    }

    await stopJenkinsBuild(DEFAULT_QA_JOB_NAME, buildNumber);

    res.json({
      success: true,
      data: {
        jobName: DEFAULT_QA_JOB_NAME,
        buildNumber,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '停止自动质检任务失败'),
      status: error.response?.status,
    });
  }
});

router.post('/nn/quality', async (req: Request, res: Response) => {
  try {
    const jobPath = encodeJobPath(DEFAULT_QA_JOB_NAME);
    const sonicConfig = getSonicConfig();
    const buildNumber = String(req.body?.buildNumber || '').trim();
    const branch = normalizeBranchName(String(req.body?.branch || ''));
    const commitHash = String(req.body?.commitHash || '').trim();
    const appVersion = String(req.body?.appVersion || '').trim();
    const packageUrl = String(req.body?.packageUrl || '').trim();
    const xcarchivePath = String(req.body?.xcarchivePath || '').trim();
    const archiveUrl = String(req.body?.archiveUrl || '').trim();
    const rawTestSuite = String(req.body?.testSuite || 'smoke').trim();
    const testSuite = normalizeQualitySuite(rawTestSuite);
    const jenkinsTestSuite = testSuite === 'monkey' ? 'smoke' : testSuite;
    const devicePool = String(req.body?.devicePool || 'ios-default').trim();
    const requestedDeviceUdid = String(req.body?.deviceUdid || req.body?.device_udid || '').trim();
    const rawMonkeyDurationSeconds = String(req.body?.monkeyDurationSeconds || '').trim();
    const monkeyDurationSeconds = testSuite === 'monkey'
      ? (rawMonkeyDurationSeconds || getRuntimeEnv('QA_MONKEY_DURATION_SECONDS') || '28800')
      : (getRuntimeEnv('QA_MONKEY_DURATION_SECONDS') || '28800');

    if (!buildNumber) {
      res.status(400).json({
        success: false,
        error: '请选择需要质检的构建',
      });
      return;
    }
    if (!QA_TEST_SUITES.has(testSuite)) {
      res.status(400).json({
        success: false,
        error: `质检套件无效：${rawTestSuite || '-'}，可选值：${Array.from(QA_TEST_SUITES).join(', ')}`,
      });
      return;
    }
    if (testSuite === 'monkey' && !QA_MONKEY_DURATION_SECONDS.has(monkeyDurationSeconds)) {
      res.status(400).json({
        success: false,
        error: `Monkey 执行时长无效：${rawMonkeyDurationSeconds || '-'}，可选值：0.5小时、1小时、4小时、8小时`,
      });
      return;
    }
    const selectedDevicePool = findQualityDevicePool(devicePool);
    if (!selectedDevicePool) {
      res.status(400).json({
        success: false,
        error: '设备池无效，请在平台质检设备池配置中选择',
      });
      return;
    }
    const selectedDevice = requestedDeviceUdid
      ? {
          deviceKey: requestedDeviceUdid,
          activeBuild: findActiveQualityBuildOnDevice(requestedDeviceUdid),
          deviceKeys: deviceKeysFromPool(selectedDevicePool, devicePool),
        }
      : selectAvailableDeviceFromPool(selectedDevicePool, devicePool);
    if (requestedDeviceUdid && !selectedDevice.deviceKeys.includes(requestedDeviceUdid)) {
      res.status(400).json({
        success: false,
        error: `设备 ${requestedDeviceUdid} 不属于设备池 ${devicePool}`,
      });
      return;
    }
    const deviceKey = selectedDevice.deviceKey;
    const wdaUrl = buildWdaUrl(deviceKey, devicePool);
    if (selectedDevice.activeBuild) {
      res.status(409).json({
        success: false,
        error: `设备池 ${devicePool} 内设备均被占用，当前设备 ${deviceKey} 已被质检任务 #${selectedDevice.activeBuild.buildNumber} 占用，请选择其他设备池或等待任务结束`,
      });
      return;
    }

    const devicePoolLabel = testSuite === 'monkey'
      ? `${selectedDevicePool.label} [suite:monkey]`
      : selectedDevicePool.label;
    const crumb = await getCrumb();
    const params = new URLSearchParams({
      SOURCE_JOB: DEFAULT_JOB_NAME,
      SOURCE_BUILD_NUMBER: buildNumber,
      BRANCH: branch,
      COMMIT_HASH: commitHash,
      APP_VERSION: appVersion,
      PACKAGE_URL: packageUrl,
      XCARCHIVE_PATH: xcarchivePath,
      ARCHIVE_URL: archiveUrl,
      TEST_SUITE: jenkinsTestSuite,
      REQUESTED_TEST_SUITE: testSuite,
      RUN_MONKEY: testSuite === 'monkey' ? '1' : '0',
      DEVICE_POOL: devicePool,
      DEVICE_POOL_LABEL: devicePoolLabel,
      DEVICE_UDID: deviceKey,
      DEVICE_SELECTOR: deviceKey,
      DEVICE_CLOUD: 'LocalMac',
      QUALITY_RUNNER: testSuite === 'monkey' ? 'local-ios-device-monkey' : 'local-ios-device',
      QA_RUNNER_MODE: testSuite === 'monkey' ? 'local-usb-monkey' : 'local-usb',
      APP_BUNDLE_ID: getRuntimeEnv('QA_APP_BUNDLE_ID') || 'com.nndev.im',
      COLD_START_DETECT_SCREEN: getRuntimeEnv('QA_COLD_START_DETECT_SCREEN') || '1',
      COLD_START_READY_TIMEOUT_SECONDS: getRuntimeEnv('QA_COLD_START_READY_TIMEOUT_SECONDS') || '45',
      COLD_START_READY_TEXT: getRuntimeEnv('QA_COLD_START_READY_TEXT') || '',
      WDA_URL: wdaUrl,
      WDA_AUTO_START: getRuntimeEnv('QA_WDA_AUTO_START') || '1',
      WDA_AUTO_INSTALL: getRuntimeEnv('QA_WDA_AUTO_INSTALL') || '1',
      WDA_PROJECT_PATH: getRuntimeEnv('QA_WDA_PROJECT_PATH') || '',
      WDA_START_TIMEOUT_SECONDS: getRuntimeEnv('QA_WDA_START_TIMEOUT_SECONDS') || '300',
      WDA_DEVELOPMENT_TEAM: getRuntimeEnv('QA_WDA_DEVELOPMENT_TEAM') || '',
      WDA_BUNDLE_ID: getRuntimeEnv('QA_WDA_BUNDLE_ID') || '',
      WDA_DERIVED_DATA_PATH: path.join(localJenkinsWorkspaceDir(DEFAULT_QA_JOB_NAME), 'quality-cache', 'wda-derived-data', sanitizeToken(deviceKey || devicePool)),
      WDA_XCODEBUILD_EXTRA_ARGS: getRuntimeEnv('QA_WDA_XCODEBUILD_EXTRA_ARGS') || '',
      MONKEY_EVENT_COUNT: getRuntimeEnv('QA_MONKEY_EVENT_COUNT') || '30',
      MONKEY_DURATION_SECONDS: monkeyDurationSeconds,
      MONKEY_INTERVAL_SECONDS: getRuntimeEnv('QA_MONKEY_INTERVAL_SECONDS') || '0.35',
      MONKEY_MAX_REPORTED_EVENTS: getRuntimeEnv('QA_MONKEY_MAX_REPORTED_EVENTS') || '1000',
      MONKEY_BACK_INTERVAL_EVENTS: getRuntimeEnv('QA_MONKEY_BACK_INTERVAL_EVENTS') || '25',
      MONKEY_STUCK_EVENTS: getRuntimeEnv('QA_MONKEY_STUCK_EVENTS') || '18',
      MONKEY_STUCK_CHECK_INTERVAL_EVENTS: getRuntimeEnv('QA_MONKEY_STUCK_CHECK_INTERVAL_EVENTS') || '5',
      MONKEY_BACK_ACTION_PROBABILITY: getRuntimeEnv('QA_MONKEY_BACK_ACTION_PROBABILITY') || '0.12',
      MONKEY_BACK_TAP_PROBABILITY: getRuntimeEnv('QA_MONKEY_BACK_TAP_PROBABILITY') || '0.35',
      MONKEY_AVOID_TOP_BAR: getRuntimeEnv('QA_MONKEY_AVOID_TOP_BAR') || '1',
      MONKEY_HEARTBEAT_INTERVAL_SECONDS: getRuntimeEnv('QA_MONKEY_HEARTBEAT_INTERVAL_SECONDS') || '60',
      MONKEY_FORBIDDEN_TEXTS: getRuntimeEnv('QA_MONKEY_FORBIDDEN_TEXTS') || 'debug,Debug,DEBUG,调试,调试工具,日志,控制台,FLEX,Doraemon,DoraemonKit,DoraemonEntryWindow,DoKit,Dokit,www.dokit.cn',
      MONKEY_FORBIDDEN_PAGE_TEXTS: getRuntimeEnv('QA_MONKEY_FORBIDDEN_PAGE_TEXTS') || 'DoKit,Dokit,www.dokit.cn,DoraemonEntryWindow',
      MONKEY_FORBIDDEN_REGION_RATIO: getRuntimeEnv('QA_MONKEY_FORBIDDEN_REGION_RATIO') || '0.78,0.18,1.0,0.72',
      MONKEY_FORBIDDEN_PADDING: getRuntimeEnv('QA_MONKEY_FORBIDDEN_PADDING') || '16',
      PERFORMANCE_SAMPLING: getRuntimeEnv('QA_PERFORMANCE_SAMPLING') || '1',
      PERFORMANCE_SAMPLER: getRuntimeEnv('QA_PERFORMANCE_SAMPLER') || 'auto',
      PERFORMANCE_SAMPLE_TYPES: getRuntimeEnv('QA_PERFORMANCE_SAMPLE_TYPES') || 'cpu,memory,fps',
      PERFORMANCE_XCTRACE_TEMPLATE: getRuntimeEnv('QA_PERFORMANCE_XCTRACE_TEMPLATE') || 'Activity Monitor',
      PERF_COLD_START_WARN_MS: getRuntimeEnv('QA_PERF_COLD_START_WARN_MS') || '8000',
      PERF_COLD_START_SLOW_MS: getRuntimeEnv('QA_PERF_COLD_START_SLOW_MS') || '15000',
      PERF_CPU_AVG_WARN: getRuntimeEnv('QA_PERF_CPU_AVG_WARN') || '80',
      PERF_MEMORY_PEAK_WARN_MB: getRuntimeEnv('QA_PERF_MEMORY_PEAK_WARN_MB') || '1500',
      PERF_FPS_AVG_WARN: getRuntimeEnv('QA_PERF_FPS_AVG_WARN') || '45',
      PERF_FPS_MIN_WARN: getRuntimeEnv('QA_PERF_FPS_MIN_WARN') || '20',
      NN_IOS_PLATFORM_DIR: getPlatformRootDir(),
      // 兼容仍在使用旧 Jenkins 参数或 Sonic 任务脚本的环境。
      SONIC_DEVICE_GROUP_ID: selectedDevicePool.groupId || '',
      SONIC_API_BASE: sonicConfig.apiBase,
      SONIC_PROJECT_ID: sonicConfig.projectId,
      SONIC_TEST_PLAN_ID: sonicConfig.testPlanId,
    });

    await axios.post(`${JENKINS_BASE_URL}/${jobPath}/buildWithParameters`, params.toString(), {
      timeout: 30000,
      headers: {
        ...crumb.headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      ...buildAuthConfig(),
    });

    res.json({
      success: true,
      data: {
        jobName: DEFAULT_QA_JOB_NAME,
        sourceBuildNumber: buildNumber,
        testSuite,
        devicePool,
        url: `${JENKINS_BASE_URL}/${jobPath}/`,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '触发 Jenkins 自动质检失败'),
      status: error.response?.status,
    });
  }
});

export default router;
