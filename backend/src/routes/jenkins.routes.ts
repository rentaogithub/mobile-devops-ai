import '../config/env';
import { Router, Request, Response } from 'express';
import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import podDepsResolver from '../services/PodDependencyResolver';
import aiAnalysisService from '../services/AIAnalysisService';
import { getJenkinsBaseUrl } from '../config/externalServices';

const router = Router();
const execFileAsync = promisify(execFile);

const JENKINS_BASE_URL = getJenkinsBaseUrl();
const DEFAULT_JOB_NAME = process.env.JENKINS_NN_JOB || 'nn';
const DEFAULT_QA_JOB_NAME = process.env.JENKINS_NN_QA_JOB || 'nn-auto-quality';
const DEFAULT_REPO_URL = process.env.JENKINS_NN_REPO_URL || 'http://git.leigod.top/nn_ios/nnios.git';
const DEPLOY_TARGETS = new Set(['Pgyer', 'TestFlight', 'AppStore']);
const QA_TEST_SUITES = new Set(['smoke', 'im', 'rtc', 'monkey', 'stutter', 'full']);
const QA_STUTTER_SCENARIOS = new Set(['community', 'im', 'voice_room']);
const QA_MONKEY_DURATION_SECONDS = new Set(['300', '1800', '3600', '14400', '28800']);
const RELEASE_BUILD_LIST_LIMIT = Math.min(
  200,
  Math.max(20, Number(process.env.JENKINS_RELEASE_BUILD_LIST_LIMIT || 50) || 50),
);
const JENKINS_LIST_TIMEOUT_MS = Number(process.env.JENKINS_LIST_TIMEOUT_MS || 2500);
const JENKINS_BUILD_METADATA_TIMEOUT_MS = Number(process.env.JENKINS_BUILD_METADATA_TIMEOUT_MS || 1500);
const JENKINS_ORPHAN_BUILD_STALE_MS = Number(process.env.JENKINS_ORPHAN_BUILD_STALE_MS || 3 * 60 * 1000);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '..', 'nn-ios-platform-data');
const QUALITY_DEVICE_POOLS_CONFIG_PATH = path.join(DATA_DIR, 'quality-device-pools.json');
const LEGACY_SONIC_DEVICE_POOLS_CONFIG_PATH = path.join(DATA_DIR, 'sonic-device-pools.json');
const BUILD_FAILURE_ANALYSIS_CACHE_PATH = path.join(DATA_DIR, 'jenkins-build-failure-analysis.json');
const LOCAL_QUALITY_ARTIFACT_ROUTE = '/api/jenkins/nn/quality/local-artifact';
const QUALITY_HANG_ANALYSIS_CACHE = new Map<string, any>();

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
  if (/卡顿|stutter|hitch|jank/i.test(text)) return 'stutter';
  if (/冒烟|smoke/i.test(text)) return 'smoke';
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

function getNniosRepoLocalDir() {
  const configured = String(getRuntimeEnv('NNIOS_REPO_LOCAL') || '').trim();
  if (configured) return path.resolve(configured);

  const platformRoot = getPlatformRootDir();
  const candidates = [
    path.resolve(platformRoot, '..', 'nnios'),
    path.resolve(process.cwd(), '..', 'nnios'),
    path.resolve(process.cwd(), '..', '..', 'nnios'),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, '.git'))) || candidates[0];
}

function getMgitPublishRepos(repoDir: string) {
  const configPath = path.join(repoDir, 'podx.config.yml');
  if (!fs.existsSync(configPath)) return ['nnios'];
  const lines = fs.readFileSync(configPath, 'utf-8').split(/\r?\n/);
  const repos: string[] = [];
  let inPublishRepos = false;
  for (const line of lines) {
    if (/^publish_repos:\s*$/.test(line)) {
      inPublishRepos = true;
      continue;
    }
    if (!inPublishRepos) continue;
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s*-\s*([a-zA-Z0-9_.-]+)\s*$/);
    if (match) repos.push(match[1]);
  }
  return repos.length > 0 ? repos : ['nnios'];
}

function repoUrlForMgitRepo(repo: string) {
  const base = DEFAULT_REPO_URL.replace(/\/nnios\.git$/i, '');
  return `${base}/${repo}.git`;
}

async function remoteBranchExists(repo: string, branch: string) {
  const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', repoUrlForMgitRepo(repo), branch], {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim().length > 0;
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

  const buildTimestamp = Number(readXmlTag(xml, 'timestamp')) || (fs.existsSync(buildDir) ? fs.statSync(buildDir).mtimeMs : 0);
  const summaryFile = findLatestQualityFile(DEFAULT_QA_JOB_NAME, 'summary.json', buildTimestamp, buildNumber);
  const summary = summaryFile ? readJsonFile(summaryFile) : null;
  const summaryStatus = String(summary?.status || '').toLowerCase();
  if (['passed', 'success', 'failed', 'unstable', 'canceled', 'cancelled', 'aborted'].includes(summaryStatus)) {
    return false;
  }

  const progressFile = findLatestQualityFile(DEFAULT_QA_JOB_NAME, 'quality-progress.json', 0, buildNumber);
  const progress = progressFile ? readJsonFile(progressFile) : null;
  if (isTerminalQualityProgress(progress)) return false;
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

function isTerminalQualityProgress(progress: any) {
  const status = String(progress?.status || '').toLowerCase();
  if (['passed', 'success', 'failed', 'unstable', 'canceled', 'cancelled', 'aborted'].includes(status)) return true;
  const percent = Number(progress?.progressPercent);
  const remaining = Number(progress?.remainingSeconds);
  return Number.isFinite(percent) && percent >= 100 && (!Number.isFinite(remaining) || remaining <= 0);
}

function reconcileQualityProgress(build: any, summary: any, progress?: any | null) {
  const currentProgress = progress || summary?.progress || null;
  const summaryStatus = String(summary?.status || '').toLowerCase();
  const buildResult = String(build?.result || '').toUpperCase();
  const finalStatus = summaryStatus ||
    (buildResult === 'SUCCESS' ? 'passed' : (buildResult === 'UNSTABLE' ? 'unstable' : (buildResult === 'FAILURE' ? 'failed' : (buildResult === 'ABORTED' ? 'aborted' : ''))));
  if (!finalStatus || build?.building) return currentProgress;
  if (!['passed', 'success', 'failed', 'unstable', 'canceled', 'cancelled', 'aborted'].includes(finalStatus)) return currentProgress;

  const progressStatus = String(currentProgress?.status || '').toLowerCase();
  const shouldOverride = !currentProgress ||
    progressStatus === 'running' ||
    (['failed', 'unstable', 'aborted'].includes(finalStatus) && !['failed', 'unstable', 'aborted', 'canceled', 'cancelled'].includes(progressStatus));
  if (!shouldOverride) return currentProgress;

  const failed = finalStatus === 'failed';
  const aborted = ['aborted', 'canceled', 'cancelled'].includes(finalStatus);
  return {
    ...(currentProgress || {}),
    status: finalStatus,
    phase: failed ? 'failed' : (aborted ? 'aborted' : 'complete'),
    message: summary?.message || currentProgress?.message || (failed ? '质检失败' : (aborted ? '质检已取消' : '质检完成')),
    progressPercent: Math.max(100, Number(currentProgress?.progressPercent || 0)),
    remainingSeconds: 0,
  };
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

function getPublicJenkinsBaseUrl(req: Request) {
  const configured = String(process.env.JENKINS_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  try {
    const base = new URL(JENKINS_BASE_URL);
    if (!['127.0.0.1', 'localhost', '::1'].includes(base.hostname)) return JENKINS_BASE_URL;
    const origin = String(req.get('origin') || '').trim();
    const originHost = origin ? new URL(origin).hostname : '';
    const requestHost = String(req.get('host') || '').split(':')[0];
    const publicHost = originHost || requestHost;
    if (publicHost && !['127.0.0.1', 'localhost', '::1'].includes(publicHost)) {
      base.hostname = publicHost;
    }
    return base.toString().replace(/\/$/, '');
  } catch {
    return JENKINS_BASE_URL;
  }
}

function publicJenkinsUrl(req: Request, url?: string) {
  if (!url) return url;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url, JENKINS_BASE_URL);
    const base = new URL(JENKINS_BASE_URL);
    const sameJenkinsPort = (parsed.port || (parsed.protocol === 'https:' ? '443' : '80')) === (base.port || (base.protocol === 'https:' ? '443' : '80'));
    const isLocalJenkinsHost = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
    const isConfiguredJenkinsHost = parsed.hostname === base.hostname;
    if (sameJenkinsPort && (isLocalJenkinsHost || isConfiguredJenkinsHost)) {
      const publicBase = new URL(getPublicJenkinsBaseUrl(req));
      parsed.protocol = publicBase.protocol;
      parsed.host = publicBase.host;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function publicJenkinsUrlsInValue(req: Request, value: any): any {
  if (typeof value === 'string') return publicJenkinsUrl(req, value);
  if (Array.isArray(value)) return value.map((item) => publicJenkinsUrlsInValue(req, item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicJenkinsUrlsInValue(req, item)]));
  }
  return value;
}

function internalJenkinsUrl(req: Request, url: string) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    const base = new URL(JENKINS_BASE_URL);
    const publicBase = new URL(getPublicJenkinsBaseUrl(req));
    if (parsed.origin === publicBase.origin) {
      parsed.protocol = base.protocol;
      parsed.host = base.host;
    }
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

function readBuildFailureAnalysisCache() {
  const cache = readJsonFile(BUILD_FAILURE_ANALYSIS_CACHE_PATH);
  return cache && typeof cache === 'object' ? cache : { analyses: {} };
}

function getSavedBuildFailureAnalysis(buildNumber: number) {
  const cache = readBuildFailureAnalysisCache();
  return cache?.analyses?.[String(buildNumber)] || null;
}

function saveBuildFailureAnalysis(buildNumber: number, analysis: any, context: any = {}) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const cache = readBuildFailureAnalysisCache();
  const nextCache = {
    ...cache,
    analyses: {
      ...(cache.analyses || {}),
      [String(buildNumber)]: {
        analysis,
        context,
        updatedAt: new Date().toISOString(),
      },
    },
  };
  const tmpPath = `${BUILD_FAILURE_ANALYSIS_CACHE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(nextCache, null, 2));
  fs.renameSync(tmpPath, BUILD_FAILURE_ANALYSIS_CACHE_PATH);
  return nextCache.analyses[String(buildNumber)];
}

function parseIpsJson(content: string) {
  const text = String(content || '').trim();
  if (!text) return null;
  const attempts = [
    text,
    text.split(/\r?\n/).slice(1).join('\n'),
  ];
  for (const attempt of attempts) {
    if (!attempt.trim().startsWith('{')) continue;
    try {
      return JSON.parse(attempt);
    } catch {
      // .ips 常见第一行是 metadata JSON，第二段才是报告主体。
    }
  }
  return null;
}

function usedImageName(image: any) {
  return String(image?.name || path.basename(String(image?.path || '')) || '');
}

function normalizeUuid(value?: string) {
  return String(value || '').trim().replace(/-/g, '').toUpperCase();
}

function findMainAppImage(report: any) {
  const images = Array.isArray(report?.usedImages) ? report.usedImages : [];
  const procName = String(report?.procName || report?.app_name || 'NNIM');
  return images.find((image: any) => {
    const name = usedImageName(image);
    const imagePath = String(image?.path || '');
    return name === procName && new RegExp(`/${procName}\\.app/${procName}$`).test(imagePath);
  }) || images.find((image: any) => usedImageName(image) === procName);
}

async function extractDsymUuid(dsymPath: string) {
  try {
    const { stdout } = await execFileAsync('dwarfdump', ['--uuid', dsymPath], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.match(/UUID:\s*([0-9a-f-]+)/i)?.[1] || '';
  } catch {
    return '';
  }
}

function findDsymBinaryPath(dsymPath: string) {
  const dwarfDir = path.join(dsymPath, 'Contents', 'Resources', 'DWARF');
  if (!fs.existsSync(dwarfDir)) return '';
  const entries = fs.readdirSync(dwarfDir, { withFileTypes: true }).filter((entry) => entry.isFile());
  const preferredName = path.basename(dsymPath).replace(/\.dSYM$/i, '').replace(/\.app$/i, '');
  const preferred = entries.find((entry) => entry.name === preferredName) || entries[0];
  return preferred ? path.join(dwarfDir, preferred.name) : '';
}

function listDsymDirectories(rootDir: string, limit = 80) {
  const results: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (results.length >= limit || depth > 5 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith('.dSYM')) {
        results.push(filePath);
        continue;
      }
      visit(filePath, depth + 1);
    }
  };
  visit(rootDir, 0);
  return results;
}

async function findDsymInArchiveByUuid(archivePath: string, uuid: string) {
  const dsymsDir = archivePath ? path.join(archivePath, 'dSYMs') : '';
  if (!dsymsDir || !fs.existsSync(dsymsDir)) return null;
  const targetUuid = normalizeUuid(uuid);
  for (const dsymPath of listDsymDirectories(dsymsDir)) {
    const dsymUuid = await extractDsymUuid(dsymPath);
    if (normalizeUuid(dsymUuid) === targetUuid) {
      const binaryPath = findDsymBinaryPath(dsymPath);
      if (binaryPath) return { dsymPath, binaryPath, uuid: dsymUuid };
    }
  }
  return null;
}

function frameDisplayName(report: any, frame: any) {
  const images = Array.isArray(report?.usedImages) ? report.usedImages : [];
  const image = Number.isInteger(frame?.imageIndex) ? images[frame.imageIndex] : null;
  const name = usedImageName(image) || String(frame?.imageName || '');
  const symbol = String(frame?.symbol || '').trim();
  const offset = Number(frame?.imageOffset);
  return {
    image: name || 'unknown',
    symbol: symbol || (Number.isFinite(offset) ? `${name || 'binary'} + ${offset}` : 'unknown'),
    offset: Number.isFinite(offset) ? offset : undefined,
  };
}

async function symbolicateIpsFramesWithDsym(report: any, frames: any[], image: any, dsymBinaryPath: string) {
  const base = Number(image?.base);
  if (!Number.isFinite(base)) return [];
  const addresses = frames
    .filter((frame) => Number.isInteger(frame?.imageIndex) && Number.isFinite(Number(frame?.imageOffset)))
    .map((frame) => `0x${(base + Number(frame.imageOffset)).toString(16)}`);
  if (addresses.length === 0) return [];
  const arch = String(image?.arch || 'arm64');
  const { stdout } = await execFileAsync('atos', ['-arch', arch, '-o', dsymBinaryPath, '-l', `0x${base.toString(16)}`, ...addresses], {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let index = 0;
  return frames.map((frame) => {
    if (!Number.isInteger(frame?.imageIndex) || !Number.isFinite(Number(frame?.imageOffset))) {
      return frameDisplayName(report, frame);
    }
    const fallback = frameDisplayName(report, frame);
    const symbol = lines[index++] || fallback.symbol;
    return {
      ...fallback,
      symbol,
    };
  });
}

async function resolveSourceArchivePath(summary: any) {
  const directArchivePath = String(summary?.xcarchivePath || summary?.archivePath || '').trim();
  if (directArchivePath && fs.existsSync(directArchivePath)) return directArchivePath;
  const sourceBuildNumber = Number(summary?.sourceBuildNumber || summary?.buildNumber || 0);
  if (!Number.isFinite(sourceBuildNumber) || sourceBuildNumber <= 0) return '';
  const metadata = await fetchBuildConsoleMetadata(encodeJobPath(DEFAULT_JOB_NAME), sourceBuildNumber);
  return metadata.xcarchivePath && fs.existsSync(metadata.xcarchivePath) ? metadata.xcarchivePath : '';
}

async function analyzeIpsHangStack(ipsPath: string, summary: any) {
  const stat = fs.statSync(ipsPath);
  const cacheKey = `${ipsPath}:${stat.mtimeMs}:${summary?.sourceBuildNumber || ''}`;
  if (QUALITY_HANG_ANALYSIS_CACHE.has(cacheKey)) return QUALITY_HANG_ANALYSIS_CACHE.get(cacheKey);

  const report = parseIpsJson(fs.readFileSync(ipsPath, 'utf-8'));
  if (!report) return null;
  const terminationReasons = Array.isArray(report?.termination?.reasons) ? report.termination.reasons.map(String) : [];
  const isWatchdog = /8BADF00D|watchdog/i.test(JSON.stringify(report?.termination || {})) || String(report?.bug_type || report?.bugType) === '309';
  if (!isWatchdog) return null;

  const images = Array.isArray(report?.usedImages) ? report.usedImages : [];
  const mainImage = findMainAppImage(report);
  const faultingThreadIndex = Number.isInteger(report?.faultingThread) ? report.faultingThread : 0;
  const threads = Array.isArray(report?.threads) ? report.threads : [];
  const faultingThread = threads[faultingThreadIndex] || threads.find((thread: any) => thread?.triggered) || threads[0];
  const mainFrames = (Array.isArray(faultingThread?.frames) ? faultingThread.frames : []).slice(0, 36);
  const appFrames = mainImage
    ? mainFrames.filter((frame: any) => Number.isInteger(frame?.imageIndex) && images[frame.imageIndex]?.uuid === mainImage.uuid)
    : [];
  const archivePath = await resolveSourceArchivePath(summary);
  const dsymMatch = mainImage?.uuid ? await findDsymInArchiveByUuid(archivePath, mainImage.uuid) : null;
  const symbolicatedAppFrames = dsymMatch && appFrames.length > 0
    ? await symbolicateIpsFramesWithDsym(report, appFrames, mainImage, dsymMatch.binaryPath)
    : [];
  const appFrameByOffset = new Map(symbolicatedAppFrames.map((frame: any) => [frame.offset, frame.symbol]));
  const topFrames = mainFrames.slice(0, 24).map((frame: any) => {
    const display = frameDisplayName(report, frame);
    return {
      ...display,
      symbol: appFrameByOffset.get(display.offset) || display.symbol,
    };
  });
  const suspiciousThreads = threads
    .map((thread: any, index: number) => {
      const frames = Array.isArray(thread?.frames) ? thread.frames : [];
      const hasSyncWait = frames.some((frame: any) => /DISPATCH_WAIT|dispatch_sync|ulock_wait/i.test(String(frame?.symbol || '')));
      const hasReachability = frames.some((frame: any) => /Reachability|PingHelper/i.test(String(frame?.symbol || '')));
      const queue = String(thread?.queue || '');
      if (!hasSyncWait && !hasReachability && !/heartbeat/i.test(queue)) return null;
      return {
        index,
        name: thread?.name || '',
        queue,
        frames: frames.slice(0, 10).map((frame: any) => frameDisplayName(report, frame)),
      };
    })
    .filter(Boolean)
    .slice(0, 5);

  const analysis = {
    file: path.basename(ipsPath),
    type: 'watchdog',
    bugType: String(report?.bug_type || report?.bugType || ''),
    code: '0x8BADF00D',
    event: terminationReasons.find((reason: string) => /WatchdogEvent/i.test(reason))?.replace(/^WatchdogEvent:\s*/i, '') || 'scene-update',
    reason: terminationReasons.find((reason: string) => /watchdog transgression|exhausted real/i.test(reason)) || '',
    captureTime: report?.captureTime || report?.timestamp || '',
    process: report?.procName || report?.app_name || 'NNIM',
    bundleId: report?.bundleID || report?.bundleId || '',
    version: report?.bundleShortVersion || report?.app_version || '',
    buildVersion: report?.bundleVersion || report?.build_version || '',
    mainThread: {
      index: faultingThreadIndex,
      name: faultingThread?.name || '',
      queue: faultingThread?.queue || '',
      summary: '主线程卡在 UIKit Accessibility hitTest / UITableViewAccessibility / CALayer 坐标转换，WDA 查询 UI 树时超过系统 10 秒 scene-update 限制。',
      frames: topFrames,
    },
    symbolication: {
      source: dsymMatch ? 'jenkins-xcarchive' : 'not-found',
      archivePath,
      dsymPath: dsymMatch?.dsymPath || '',
      uuid: mainImage?.uuid || '',
      message: dsymMatch ? '已使用当前 Jenkins 源构建 archive 内 dSYM 自动符号化' : '未在当前 Jenkins 源构建 archive 中找到匹配 dSYM',
    },
    suspiciousThreads,
    suggestions: [
      '检查当前页面 UITableView / 自定义 Cell / accessibilityElements 是否存在递归、过深层级或触发布局。',
      '检查 accessibilityFrame、hitTest、pointInside、layoutSubviews 中是否有同步等待或耗时逻辑。',
      '检查 RealReachability / PingHelper 的 dispatch_sync 等待链路，避免和主线程或串行队列互等。',
    ],
  };
  QUALITY_HANG_ANALYSIS_CACHE.set(cacheKey, analysis);
  return analysis;
}

async function enrichQualitySummaryWithHangStack(summary: any, summaryFile?: string) {
  if (!summary?.exceptionAnalysis?.crashReports?.files?.length || !summaryFile) return summary;
  const summaryDir = path.dirname(summaryFile);
  const analyses = [];
  for (const crashFile of summary.exceptionAnalysis.crashReports.files) {
    if (!String(crashFile).toLowerCase().endsWith('.ips')) continue;
    const ipsPath = path.join(summaryDir, crashFile);
    if (!fs.existsSync(ipsPath)) continue;
    try {
      const analysis = await analyzeIpsHangStack(ipsPath, summary);
      if (analysis) analyses.push(analysis);
    } catch {
      // 单个 ips 解析失败不影响质检列表展示。
    }
  }
  if (analyses.length === 0) return summary;
  return {
    ...summary,
    exceptionAnalysis: {
      ...summary.exceptionAnalysis,
      hangStackAnalysis: analyses,
    },
  };
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
  const firstArtifactUrl = (...names: Array<string | undefined>) => {
    for (const name of names) {
      const url = artifactUrl(name);
      if (url) return url;
    }
    return '';
  };

  return {
    summaryUrl: path.basename(summaryFile) === 'summary.json' ? buildLocalQualityArtifactUrl(summaryFile) : '',
    screenshotUrl: artifactUrl(summary?.artifacts?.screenshot || 'screenshot.png'),
    deviceLogUrl: artifactUrl(summary?.artifacts?.deviceLog || 'device.log'),
    processesUrl: artifactUrl(summary?.artifacts?.processes || 'processes.json'),
    monkeyReportUrl: artifactUrl(summary?.artifacts?.monkeyReport),
    performanceSamplesUrl: firstArtifactUrl(summary?.artifacts?.performanceSamples, 'performance-samples.jsonl'),
    performanceStuttersUrl: firstArtifactUrl(summary?.artifacts?.performanceStutters, 'performance-stutters.json'),
    performanceStacksUrl: firstArtifactUrl(summary?.artifacts?.performanceStacks, 'performance-stack-analysis.json'),
    performanceTraceUrl: firstArtifactUrl(summary?.artifacts?.performanceTrace, 'performance.trace.zip', 'performance.trace'),
    crashReportsUrl: artifactUrl(summary?.artifacts?.crashReports),
    junitUrl: artifactUrl(summary?.artifacts?.junit || 'junit.xml'),
    qualityLogUrl: artifactUrl(summary?.artifacts?.qualityLog || 'quality.log'),
  };
}

function existingLocalArtifactName(dir: string, ...names: string[]) {
  return names.find((name) => fs.existsSync(path.join(dir, name))) || '';
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

function readLocalQualityMetadata(jobName: string, build: any) {
  const metadataFile = findLatestQualityFile(jobName, 'metadata.json', Number(build?.timestamp || 0), Number(build?.number || 0));
  return metadataFile ? readJsonFile(metadataFile) : null;
}

function readLocalQualitySummaryWithPath(jobName: string, build: any) {
  const summaryFile = findLatestQualityFile(jobName, 'summary.json', Number(build?.timestamp || 0), Number(build?.number || 0));
  const summary = summaryFile ? readJsonFile(summaryFile) : null;
  if (summary) return { summary, filePath: summaryFile };

  const monkeyReportFile = findLatestQualityFile(jobName, 'monkey-report.json', Number(build?.timestamp || 0), Number(build?.number || 0));
  const monkeyReport = monkeyReportFile ? readJsonFile(monkeyReportFile) : null;
  if (!monkeyReport) return null;

  const resultDir = path.dirname(monkeyReportFile);
  const metadata = readJsonFile(path.join(resultDir, 'metadata.json')) || {};
  const progress = readJsonFile(path.join(resultDir, 'quality-progress.json')) || {};
  const status = String(monkeyReport.status || progress.status || '').trim() || (
    String(build?.result || '').toUpperCase() === 'SUCCESS' ? 'passed' : ''
  );
  const requestedDurationSeconds = Number(monkeyReport.requestedDurationSeconds || progress.requestedDurationSeconds || 0);
  const executedEvents = Number(monkeyReport.executedEvents || progress.executedEvents || 0);
  const artifacts = {
    monkeyReport: 'monkey-report.json',
    qualityLog: existingLocalArtifactName(resultDir, 'quality.log'),
    processes: existingLocalArtifactName(resultDir, 'processes.json', 'devicectl-processes.json'),
    performanceTrace: existingLocalArtifactName(resultDir, 'performance.trace.zip', 'performance.trace'),
    screenshot: existingLocalArtifactName(resultDir, 'screenshot.png'),
    junit: existingLocalArtifactName(resultDir, 'junit.xml'),
    crashReports: fs.existsSync(path.join(resultDir, 'crash-reports')) ? 'crash-reports' : '',
  };
  const fallbackSummary = {
    ...metadata,
    status,
    message: monkeyReport.message || progress.message || 'Monkey 测试已完成，但收尾阶段未生成 summary.json，已使用归档文件兜底展示。',
    testSuite: String(metadata.testSuite || 'monkey').trim().toLowerCase(),
    monkeyStatus: monkeyReport.status || status,
    monkeyMessage: monkeyReport.message || '',
    monkeyExecutedEvents: executedEvents,
    monkeyEventCount: Number(monkeyReport.requestedEvents || progress.requestedEvents || 0),
    artifacts,
    performanceAnalysis: {
      conclusion: { severity: status === 'passed' ? 'passed' : (status === 'failed' ? 'failed' : 'warning'), issues: [] },
      monkeyDurationMs: requestedDurationSeconds > 0 ? requestedDurationSeconds * 1000 : undefined,
      monkeyExecutedEvents: executedEvents,
      trace: {
        available: Boolean(artifacts.performanceTrace),
        segmentCount: fs.existsSync(path.join(resultDir, 'performance-traces')) ? fs.readdirSync(path.join(resultDir, 'performance-traces')).filter((item) => item.endsWith('.trace')).length : undefined,
      },
      samples: {
        sampleCount: 0,
      },
    },
  };
  return { summary: fallbackSummary, filePath: monkeyReportFile };
}

function readLocalQualitySummary(jobName: string, build: any) {
  return readLocalQualitySummaryWithPath(jobName, build)?.summary || null;
}

function normalizeQualitySummaryStatus(summary: any) {
  if (!summary || typeof summary !== 'object') return summary;
  const testSuite = String(summary?.testSuite || summary?.suite || '').toLowerCase();
  const isMonkeySuite = testSuite === 'monkey';
  const includeStutterMetrics = testSuite === 'stutter';
  const isStutterMetric = (item: any) => /stutter|framestutter|fps|卡顿|帧|hitch/i.test(String(item?.metric || item?.message || ''));
  const rawPerformanceIssues = Array.isArray(summary?.performanceAnalysis?.conclusion?.issues)
    ? summary.performanceAnalysis.conclusion.issues
    : [];
  const performanceIssues = includeStutterMetrics
    ? rawPerformanceIssues
    : rawPerformanceIssues.filter((item: any) => !isStutterMetric(item));
  const performanceSeverity = performanceIssues.some((item: any) => item?.severity === 'failed')
    ? 'failed'
    : (performanceIssues.length > 0 ? 'warning' : 'passed');
  const exceptionSeverity = String(summary?.exceptionAnalysis?.severity || '').toLowerCase();
  const severeActionCount = includeStutterMetrics ? Number(summary?.performanceAnalysis?.stutter?.severeActionCount || 0) : 0;
  const severeFrameHitchCount = includeStutterMetrics ? Number(summary?.performanceAnalysis?.frameStutter?.severeHitchCount || 0) : 0;
  const monkeyStatus = String(summary?.monkeyStatus || '').toLowerCase();
  const monkeyFailed = isMonkeySuite && ['failed', 'failure'].includes(monkeyStatus);
  const originalStatus = String(summary?.status || '').toLowerCase();
  const originalMessage = String(summary?.message || '');
  const onlyIgnoredPerformanceFailure = isMonkeySuite &&
    ['failed', 'failure'].includes(originalStatus) &&
    rawPerformanceIssues.length > 0 &&
    performanceIssues.length === 0 &&
    (!originalMessage || /stutter|framestutter|fps|卡顿|帧|hitch/i.test(originalMessage));
  const nextSummary = { ...summary };
  if (summary?.performanceAnalysis?.conclusion) {
    nextSummary.performanceAnalysis = {
      ...summary.performanceAnalysis,
      conclusion: {
        ...summary.performanceAnalysis.conclusion,
        severity: performanceSeverity,
        issues: performanceIssues,
      },
    };
  }
  if (exceptionSeverity === 'failed' || monkeyFailed || performanceSeverity === 'failed' || severeActionCount > 0 || severeFrameHitchCount > 0) {
    nextSummary.status = 'failed';
    const crashSample = summary?.exceptionAnalysis?.crashReports?.samples?.[0];
    const watchdogCount = Number(summary?.exceptionAnalysis?.watchdogCount || 0);
    const exceptionMessage = crashSample
      ? `检测到 ${crashSample.process || 'App'} ${watchdogCount > 0 || /watchdog|8badf00d/i.test(String(crashSample.exception || crashSample.reason || '')) ? 'Watchdog 卡死' : '崩溃'}：${crashSample.exception || crashSample.reason || crashSample.file || 'crash report'}`
      : '';
    const issueMessage = exceptionMessage ||
      (monkeyFailed ? (summary.message || 'Monkey 测试失败') : '') ||
      performanceIssues.find((item: any) => item?.severity === 'failed')?.message ||
      performanceIssues.find((item: any) => /stutter|卡顿|hitch/i.test(String(item?.metric || item?.message || '')))?.message;
    nextSummary.message = issueMessage || summary.message || '质检失败';
  } else if (onlyIgnoredPerformanceFailure) {
    nextSummary.status = performanceSeverity === 'warning' ? 'unstable' : 'passed';
    nextSummary.message = performanceSeverity === 'warning'
      ? (performanceIssues.find((item: any) => item?.message)?.message || '质检完成，存在基础性能风险')
      : '质检完成';
  } else if (['passed', 'success'].includes(String(nextSummary.status || '').toLowerCase()) && performanceSeverity === 'warning') {
    nextSummary.status = 'unstable';
    const issueMessage = performanceIssues.find((item: any) => item?.message)?.message;
    nextSummary.message = issueMessage || summary.message || '质检完成，存在性能风险';
  }
  return nextSummary;
}

async function enrichQualitySummaryWithSourceBuild(summary: any) {
  if (!summary || typeof summary !== 'object') return summary;
  const sourceBuildNumber = Number(summary.sourceBuildNumber || summary.buildNumber || 0);
  if (!Number.isFinite(sourceBuildNumber) || sourceBuildNumber <= 0) return summary;
  if (summary.publishChannel) return summary;
  try {
    const metadata = await fetchBuildConsoleMetadata(encodeJobPath(DEFAULT_JOB_NAME), sourceBuildNumber);
    return {
      ...summary,
      publishChannel: metadata.publishChannel || summary.publishChannel || '',
    };
  } catch {
    return summary;
  }
}

async function hasActiveQualityScriptProcess() {
  try {
    await execFileAsync('pgrep', ['-f', 'scripts/sonic/ios-quality.sh'], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

async function buildCompletedOverride(jobName: string, build: any, localSummary?: any | null, localProgress?: any | null) {
  if (!build?.building) return null;
  const normalizedLocalSummary = normalizeQualitySummaryStatus(localSummary);
  const summaryStatus = String(normalizedLocalSummary?.status || '').toLowerCase();
  const progressStatus = String(localProgress?.status || '').toLowerCase();
  const status = summaryStatus || (isTerminalQualityProgress(localProgress) ? progressStatus || 'passed' : '');
  if (!['passed', 'success', 'failed', 'unstable', 'canceled', 'cancelled', 'aborted'].includes(status)) return null;
  const buildNumber = Number(build.number);
  if (!Number.isFinite(buildNumber)) return null;
  const result = status === 'failed'
    ? 'FAILURE'
    : (status === 'unstable' ? 'UNSTABLE' : (status === 'canceled' || status === 'cancelled' || status === 'aborted' ? 'ABORTED' : 'SUCCESS'));
  return {
    building: false,
    result,
    duration: build.duration || Math.max(0, Date.now() - Number(build.timestamp || Date.now())),
    description: [build.description, '本机检测到质检 summary 已生成，Jenkins 构建状态未及时刷新，已按本地报告纠偏。'].filter(Boolean).join('\n'),
    completedMessage: normalizedLocalSummary?.message || localProgress?.message || (result === 'SUCCESS' ? '质检完成' : '质检失败'),
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

async function cleanupDeviceWebDriverAgent(deviceUdid?: string) {
  const udid = String(deviceUdid || '').trim();
  if (!udid) return 0;
  const outputPath = path.join(os.tmpdir(), `nn-quality-device-processes-${Date.now()}.json`);
  let terminated = 0;
  try {
    await execFileAsync('xcrun', ['devicectl', 'device', 'info', 'processes', '--device', udid, '--json-output', outputPath, '--quiet'], { timeout: 10000 });
    const data = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    const processes = Array.isArray(data?.result?.runningProcesses) ? data.result.runningProcesses : [];
    for (const processInfo of processes) {
      const text = JSON.stringify(processInfo);
      const pid = Number(processInfo?.processIdentifier);
      if (!pid || !/WebDriverAgent|WebDriverAgentRunner|xctrunner|AutomationModeUI|automationmode-writer/i.test(text)) continue;
      try {
        await execFileAsync('xcrun', ['devicectl', 'device', 'process', 'terminate', '--device', udid, '--pid', String(pid), '--kill', '--quiet'], { timeout: 10000 });
        terminated += 1;
      } catch {
        // 设备进程可能已退出，忽略。
      }
    }
  } catch {
    // devicectl 不可用或设备离线时只做本机进程清理。
  } finally {
    try {
      fs.rmSync(outputPath, { force: true });
    } catch {
      // ignore
    }
  }
  return terminated;
}

function escapeProcessPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function cleanupLocalQualityProcesses(deviceUdid?: string) {
  const udid = String(deviceUdid || '').trim();
  const escapedUdid = escapeProcessPattern(udid);
  const patterns = udid
    ? [
        `iproxy.*${escapedUdid}.*8100|iproxy.*8100.*${escapedUdid}`,
        `xcodebuild.*${escapedUdid}.*WebDriverAgentRunner|xcodebuild.*WebDriverAgentRunner.*${escapedUdid}`,
        `xcodebuild.*${escapedUdid}.*xctrunner|xcodebuild.*xctrunner.*${escapedUdid}`,
        `tidevice.*${escapedUdid}.*perf|tidevice.*perf.*${escapedUdid}`,
      ]
    : [
        'scripts/sonic/ios-quality.sh',
        'WebDriverAgentRunner',
        'xctrunner',
        'xcodebuild.*WebDriverAgentRunner',
        'xcodebuild.*xctrunner',
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
  const terminatedDeviceProcesses = await cleanupDeviceWebDriverAgent(deviceUdid);
  return { terminatedDeviceProcesses };
}

function parseBuildDescription(description?: string | null) {
  const text = (description || '').trim();
  if (!text) return { publishChannel: '', buildNumber: '' };

  const parts = text.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  const channelPart = parts.find((part) => normalizeDeployTarget(part) !== part || DEPLOY_TARGETS.has(part));
  const buildNumberPart = [...parts].reverse().find((part) => /^[0-9]+$/.test(part));
  return {
    publishChannel: channelPart ? normalizeDeployTarget(channelPart) : '',
    buildNumber: buildNumberPart || '',
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

function releaseVersionParts(branch: string) {
  const match = normalizeBranchName(branch).match(/^release\/(\d+(?:\.\d+){2,})$/);
  return match ? match[1].split('.').map((item) => Number(item)) : [];
}

function branchVersionParts(branch: string) {
  const match = normalizeBranchName(branch).match(/^(?:release|feature)\/(\d+(?:\.\d+){2,})(?:[_/-].*)?$/);
  return match ? match[1].split('.').map((item) => Number(item)) : [];
}

function compareReleaseBranchesDesc(a: string, b: string) {
  const av = releaseVersionParts(a);
  const bv = releaseVersionParts(b);
  const len = Math.max(av.length, bv.length);
  for (let index = 0; index < len; index += 1) {
    const diff = (bv[index] || 0) - (av[index] || 0);
    if (diff !== 0) return diff;
  }
  return normalizeBranchName(a).localeCompare(normalizeBranchName(b));
}

function compareBranchVersionsDesc(a: string, b: string) {
  const normalizedA = normalizeBranchName(a);
  const normalizedB = normalizeBranchName(b);
  const av = branchVersionParts(normalizedA);
  const bv = branchVersionParts(normalizedB);
  const hasVersionA = av.length > 0;
  const hasVersionB = bv.length > 0;
  if (hasVersionA && hasVersionB) {
    const len = Math.max(av.length, bv.length);
    for (let index = 0; index < len; index += 1) {
      const diff = (bv[index] || 0) - (av[index] || 0);
      if (diff !== 0) return diff;
    }
  } else if (hasVersionA) {
    return -1;
  } else if (hasVersionB) {
    return 1;
  }
  return normalizedA.localeCompare(normalizedB);
}

function compareBranchOptions(a: string, b: string) {
  const normalizedA = normalizeBranchName(a);
  const normalizedB = normalizeBranchName(b);
  if (normalizedA === 'develop') return -1;
  if (normalizedB === 'develop') return 1;
  const aIsRelease = isReleaseBranch(normalizedA);
  const bIsRelease = isReleaseBranch(normalizedB);
  if (aIsRelease && bIsRelease) return compareReleaseBranchesDesc(normalizedA, normalizedB);
  if (aIsRelease) return -1;
  if (bIsRelease) return 1;
  const aIsFeature = normalizedA.startsWith('feature/');
  const bIsFeature = normalizedB.startsWith('feature/');
  if (aIsFeature && bIsFeature) return compareBranchVersionsDesc(normalizedA, normalizedB);
  return normalizedA.localeCompare(normalizedB);
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
  const pgyerBuildNumber =
    plainConsoleText.match(/蒲公英版本[:：][^\n\r]*?build\s*\[([0-9]+)\]/i)?.[1] ||
    plainConsoleText.match(/BUILD_DESCRIPTION\s*=\s*(?:[^,\n\r]+[,，]\s*)?Pgyer[,，]\s*([0-9]+)/i)?.[1] ||
    plainConsoleText.match(/Description set:\s*(?:[^,\n\r]+[,，]\s*)?Pgyer[,，]\s*([0-9]+)/i)?.[1] ||
    '';
  const testFlightBuildNumber =
    plainConsoleText.match(/TestFlight渠道构建号[:：]\s*([0-9]+)/i)?.[1] ||
    '';
  const appStoreBuildNumber =
    plainConsoleText.match(/AppStore渠道构建号[:：]\s*([0-9]+)/i)?.[1] ||
    plainConsoleText.match(/苹果商店渠道构建号[:：]\s*([0-9]+)/i)?.[1] ||
    '';
  const testFlightAscVersion =
    plainConsoleText.match(/TestFlight渠道\s*ASC\s*版本[:：]\s*([0-9]+(?:\.[0-9]+)+)/i)?.[1] ||
    '';
  const appStoreAscVersion =
    plainConsoleText.match(/AppStore渠道\s*ASC\s*版本[:：]\s*([0-9]+(?:\.[0-9]+)+)/i)?.[1] ||
    plainConsoleText.match(/苹果商店渠道\s*ASC\s*版本[:：]\s*([0-9]+(?:\.[0-9]+)+)/i)?.[1] ||
    '';
  const projectBuildNumber =
    plainConsoleText.match(/Build号[:：]\s*([0-9]+)/)?.[1] ||
    plainConsoleText.match(/CURRENT_PROJECT_VERSION:\s*[^→\n]*→\s*([0-9]+)/)?.[1] ||
    plainConsoleText.match(/CURRENT_PROJECT_VERSION\s*=\s*([0-9]+)/)?.[1] ||
    '';
  const matchedTestFlightBuildNumber = testFlightAscVersion && appVersion && testFlightAscVersion !== appVersion
    ? ''
    : testFlightBuildNumber;
  const matchedAppStoreBuildNumber = appStoreAscVersion && appVersion && appStoreAscVersion !== appVersion
    ? ''
    : appStoreBuildNumber;
  const appleBuildNumber =
    matchedTestFlightBuildNumber ||
    matchedAppStoreBuildNumber ||
    plainConsoleText.match(/CHANNEL_BUILD_NUMBER\s*=\s*([0-9]+)/)?.[1] ||
    plainConsoleText.match(/渠道构建号[:：]\s*([0-9]+)/)?.[1] ||
    projectBuildNumber ||
    '';
  const buildNumber = publishChannel === 'Pgyer'
    ? pgyerBuildNumber
    : (publishChannel === 'TestFlight'
      ? (matchedTestFlightBuildNumber || projectBuildNumber || appleBuildNumber)
      : (publishChannel === 'AppStore' ? (matchedAppStoreBuildNumber || projectBuildNumber || appleBuildNumber) : appleBuildNumber));
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
    summaryArtifacts.find((artifact: any) => consoleSummary?.resultDirName && String(artifact?.relativePath || '') === `quality-results/${consoleSummary.resultDirName}/summary.json`)
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
      return normalizeQualitySummaryStatus({
        ...mergedSummary,
        artifacts: {
          summaryUrl,
          screenshotUrl: artifactUrl(summary.artifacts?.screenshot || 'screenshot.png'),
          deviceLogUrl: artifactUrl(summary.artifacts?.deviceLog || 'device.log'),
          processesUrl: artifactUrl(summary.artifacts?.processes || 'processes.json'),
          monkeyReportUrl: artifactUrl(summary.artifacts?.monkeyReport),
                    performanceSamplesUrl: artifactUrl(summary.artifacts?.performanceSamples || 'performance-samples.jsonl'),
                    performanceStuttersUrl: artifactUrl(summary.artifacts?.performanceStutters || 'performance-stutters.json'),
                    performanceStacksUrl: artifactUrl(summary.artifacts?.performanceStacks || 'performance-stack-analysis.json'),
                    performanceTraceUrl: artifactUrl(summary.artifacts?.performanceTrace || 'performance.trace.zip' || 'performance.trace'),
          crashReportsUrl: artifactUrl(summary.artifacts?.crashReports),
          junitUrl: artifactUrl(summary.artifacts?.junit || 'junit.xml'),
          qualityLogUrl: artifactUrl(summary.artifacts?.qualityLog || 'quality.log'),
        },
      });
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
    const result = String(build.result || '').toUpperCase();
    const status = result === 'SUCCESS'
      ? 'passed'
      : (result === 'UNSTABLE' ? 'unstable' : (result === 'FAILURE' ? 'failed' : (result === 'ABORTED' ? 'aborted' : '')));
    return {
      status,
      message: result === 'SUCCESS' ? '质检成功' : (result === 'ABORTED' ? '质检已取消或中断，未生成本次质检汇总' : (result === 'FAILURE' ? '质检失败，未生成本次质检汇总' : '')),
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

function flattenNumericValues(value: any, pathParts: string[] = [], output: Array<{ path: string; value: number }> = []) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    output.push({ path: pathParts.join('.').toLowerCase(), value });
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenNumericValues(item, [...pathParts, String(index)], output));
    return output;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => flattenNumericValues(item, [...pathParts, key], output));
  }
  return output;
}

function normalizeMemoryMegabytes(value: number) {
  if (value > 1024 * 1024) return value / 1024 / 1024;
  return value;
}

function normalizePerformanceMemoryMegabytes(keyPath: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const key = String(keyPath || '').toLowerCase();
  if (/virtual|vmsize|address|startabstime|procage|energyscore/.test(key)) return null;
  if (!/physfootprint|resident|resident_size|residentmemory|memresident|memrprvt|memrshrd|memanon|memcompressed|memory|rss/.test(key)) {
    return null;
  }
  return Number(normalizeMemoryMegabytes(value).toFixed(2));
}

function extractPerformanceMemoryMegabytes(item: any, values: Array<{ path: string; value: number }>) {
  const preferredKeys = [
    'physFootprint',
    'physicalFootprint',
    'memResidentSize',
    'residentSize',
    'residentMemory',
    'rss',
    'memRPrvt',
    'memAnon',
  ];
  for (const key of preferredKeys) {
    const directValue = item?.[key];
    if (typeof directValue === 'number' && Number.isFinite(directValue)) {
      const memoryMB = normalizePerformanceMemoryMegabytes(key, directValue);
      if (memoryMB !== null) return memoryMB;
    }
  }
  for (const { path: keyPath, value } of values) {
    const memoryMB = normalizePerformanceMemoryMegabytes(keyPath, value);
    if (memoryMB !== null) return memoryMB;
  }
  return null;
}

function summarizePerformanceSeries(values: Array<number | null | undefined>) {
  const validValues = values.filter((value): value is number => Number.isFinite(Number(value)));
  if (!validValues.length) return { avg: null, max: null, min: null };
  const sum = validValues.reduce((total, value) => total + value, 0);
  return {
    avg: Number((sum / validValues.length).toFixed(2)),
    max: Number(Math.max(...validValues).toFixed(2)),
    min: Number(Math.min(...validValues).toFixed(2)),
  };
}

function extractPerformanceTimestamp(item: any, fallbackIndex: number) {
  const directValue = item?.timeSeconds ?? item?.elapsedSeconds ?? item?.seconds ?? item?.timestamp ?? item?.ts ?? item?.time;
  if (typeof directValue === 'number' && Number.isFinite(directValue)) {
    if (directValue > 1_000_000_000) return fallbackIndex;
    return directValue;
  }
  if (typeof directValue === 'string') {
    const parsedNumber = Number(directValue);
    if (Number.isFinite(parsedNumber)) return parsedNumber > 1_000_000_000 ? fallbackIndex : parsedNumber;
    const parsedDate = Date.parse(directValue);
    if (Number.isFinite(parsedDate)) return fallbackIndex;
  }
  return fallbackIndex;
}

function parsePerformanceSamplesJsonl(content: string, maxSamples = 5000) {
  const lines = content.split(/\r?\n/);
  const samples: Array<{ index: number; timeSeconds: number; cpu: number | null; memoryMB: number | null; fps: number | null }> = [];
  const cpuValues: number[] = [];
  const memoryValues: number[] = [];
  const fpsValues: number[] = [];
  let parsedLineCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let item: any;
    try {
      item = JSON.parse(trimmed);
    } catch {
      continue;
    }
    parsedLineCount += 1;
    const values = flattenNumericValues(item);
    const cpu = values.find(({ path: keyPath, value }) => keyPath.includes('cpu') && value >= 0 && value <= 1000)?.value ?? null;
    const fps = values.find(({ path: keyPath, value }) => /fps|frame/.test(keyPath) && value >= 0 && value <= 240)?.value ?? null;
    const memoryMB = extractPerformanceMemoryMegabytes(item, values);
    if (cpu !== null) cpuValues.push(cpu);
    if (memoryMB !== null) memoryValues.push(memoryMB);
    if (fps !== null) fpsValues.push(fps);

    if (samples.length < maxSamples) {
      samples.push({
        index: parsedLineCount,
        timeSeconds: Number(extractPerformanceTimestamp(item, parsedLineCount).toFixed(2)),
        cpu: cpu === null ? null : Number(cpu.toFixed(2)),
        memoryMB,
        fps: fps === null ? null : Number(fps.toFixed(2)),
      });
    }
  }

  return {
    sampleCount: parsedLineCount,
    returnedSampleCount: samples.length,
    truncated: parsedLineCount > samples.length,
    samples,
    summary: {
      cpu: summarizePerformanceSeries(cpuValues),
      memoryMB: summarizePerformanceSeries(memoryValues),
      fps: summarizePerformanceSeries(fpsValues),
    },
  };
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
      .sort(compareBranchOptions);

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

    const responseData = {
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
      };
    res.json({
      success: true,
      data: publicJenkinsUrlsInValue(req, responseData),
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
    const savedFailureAnalysis = getSavedBuildFailureAnalysis(buildNumber);

    res.json({
      success: true,
      data: {
        jobName: DEFAULT_JOB_NAME,
        buildNumber,
        log,
        failureAnalysis: savedFailureAnalysis?.analysis,
        failureAnalysisUpdatedAt: savedFailureAnalysis?.updatedAt,
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

router.post('/nn/builds/:number/analyze-failure', async (req: Request, res: Response) => {
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

    const [buildResponse, logResponse] = await Promise.all([
      fetchJenkinsJobJson(`${jobPath}/${buildNumber}`, 'number,result,building,description,url'),
      axios.get(`${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/consoleText`, {
        timeout: 30000,
        responseType: 'text',
        ...buildAuthConfig(),
      }),
    ]);
    const build = buildResponse.data || {};
    const result = String(build.result || '').toUpperCase();
    const log = String(logResponse.data || '');
    const force = Boolean(req.body?.force);
    if (result && result !== 'FAILURE' && !/Finished:\s+FAILURE|fastlane finished with errors|构建失败|上传失败/i.test(log)) {
      res.status(400).json({
        success: false,
        error: '当前构建不是失败状态，无需失败分析',
      });
      return;
    }
    const saved = getSavedBuildFailureAnalysis(buildNumber);
    if (saved?.analysis && !force) {
      res.json({
        success: true,
        data: {
          jobName: DEFAULT_JOB_NAME,
          buildNumber,
          analysis: saved.analysis,
          updatedAt: saved.updatedAt,
          cached: true,
        },
      });
      return;
    }

    const buildParameters = await fetchBuildParameters(jobPath, buildNumber);
    const consoleMetadata = parseConsoleMetadata(log);
    const descriptionMetadata = parseBuildDescription(build.description);
    const context = {
      branchName: buildParameters.branchName,
      publishChannel: consoleMetadata.publishChannel || normalizeDeployTarget(descriptionMetadata.publishChannel),
      appVersion: consoleMetadata.appVersion,
      commitHash: consoleMetadata.commitHash || parseCheckoutRevision(log),
    };
    const analysis = await aiAnalysisService.analyzeBuildFailureLog({
      log,
      buildNumber,
      ...context,
    }, String(req.body?.apiKey || ''));
    const savedAnalysis = saveBuildFailureAnalysis(buildNumber, analysis, context);

    res.json({
      success: true,
      data: {
        jobName: DEFAULT_JOB_NAME,
        buildNumber,
        analysis,
        updatedAt: savedAnalysis.updatedAt,
        cached: false,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '失败分析构建失败原因失败'),
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
    const fetchUrl = internalJenkinsUrl(req, artifactUrl);
    const parsedUrl = new URL(fetchUrl, `http://local${LOCAL_QUALITY_ARTIFACT_ROUTE}`);
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
      : await fetchJenkinsTextArtifact(fetchUrl);
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
        url: publicJenkinsUrl(req, artifactUrl),
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

router.get('/nn/quality/performance-samples', async (req: Request, res: Response) => {
  try {
    const artifactUrl = String(req.query.url || '').trim();
    if (!artifactUrl) {
      res.status(400).json({ success: false, error: 'url 不能为空' });
      return;
    }
    const fetchUrl = internalJenkinsUrl(req, artifactUrl);
    const parsedUrl = new URL(fetchUrl, `http://local${LOCAL_QUALITY_ARTIFACT_ROUTE}`);
    const jenkinsUrl = new URL(JENKINS_BASE_URL);
    const isLocalQualityArtifact = parsedUrl.pathname === LOCAL_QUALITY_ARTIFACT_ROUTE;
    if (!isLocalQualityArtifact && (parsedUrl.origin !== jenkinsUrl.origin || !parsedUrl.pathname.includes('/artifact/'))) {
      res.status(400).json({ success: false, error: '只允许读取当前 Jenkins 的 artifact 文件' });
      return;
    }

    const preview = isLocalQualityArtifact
      ? await readLocalQualityTextArtifact(String(parsedUrl.searchParams.get('path') || ''), 8 * 1024 * 1024)
      : await fetchJenkinsTextArtifact(fetchUrl, 8 * 1024 * 1024);
    const parsed = parsePerformanceSamplesJsonl(preview.content);

    res.json({
      success: true,
      data: {
        url: publicJenkinsUrl(req, artifactUrl),
        contentType: preview.contentType,
        sourceTruncated: preview.truncated,
        ...parsed,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '读取性能采样失败'),
    });
  }
});

router.get('/nn/quality/builds', async (req: Request, res: Response) => {
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
      const localMetadata = readLocalQualityMetadata(DEFAULT_QA_JOB_NAME, build);
      const completedOverride = await buildCompletedOverride(DEFAULT_QA_JOB_NAME, build, localSummary, localProgress);
      const interruptedOverride = completedOverride ? null : await buildInterruptedOverride(DEFAULT_QA_JOB_NAME, build);
      const stateOverride = completedOverride || interruptedOverride;
      const normalizedBuild = stateOverride ? { ...build, ...stateOverride } : build;
      const qualitySummary = job.localFallback ? {
        status: normalizedBuild.result === 'SUCCESS' ? 'passed' : (normalizedBuild.result === 'UNSTABLE' ? 'unstable' : (normalizedBuild.result === 'FAILURE' ? 'failed' : '')),
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
            ...(localMetadata || {}),
            ...(localSummary || {}),
            artifacts: {
              ...(localSummary?.artifacts || {}),
              ...(qualitySummary.artifacts || {}),
              ...localArtifactLinks,
            },
            message: completedOverride?.completedMessage || localSummary?.message || qualitySummary.message,
          };
      const normalizedQualitySummary = normalizeQualitySummaryStatus(
        await enrichQualitySummaryWithSourceBuild(
          await enrichQualitySummaryWithHangStack(mergedQualitySummary, localSummaryResult?.filePath),
        ),
      );
      const outputQualitySummary = (!localSummary && normalizedBuild.result === 'ABORTED')
        ? {
            ...normalizedQualitySummary,
            status: 'aborted',
            message: normalizedQualitySummary.message || '质检已取消或中断，未生成本次质检汇总',
          }
        : (!localSummary && normalizedBuild.result === 'FAILURE'
            ? {
                ...normalizedQualitySummary,
                status: 'failed',
                message: normalizedQualitySummary.message || '质检失败，未生成本次质检汇总',
              }
            : normalizedQualitySummary);
      return {
        ...normalizedBuild,
        url: normalizeJenkinsUrl(normalizedBuild.url),
        artifacts: [],
        qualitySummary: {
          ...outputQualitySummary,
          progress: reconcileQualityProgress(normalizedBuild, outputQualitySummary, localProgress),
        },
      };
    }));
    const running = builds.filter((build: any) => build.building).length;
    const success = builds.filter((build: any) => build.result === 'SUCCESS').length;
    const finished = builds.filter((build: any) => !build.building && build.result).length;

    const responseData = {
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
      };
    res.json({
      success: true,
      data: publicJenkinsUrlsInValue(req, responseData),
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
      data: publicJenkinsUrlsInValue(req, {
        jobName: DEFAULT_JOB_NAME,
        deployTarget,
        branch,
        jenkinsBranch,
        url: `${JENKINS_BASE_URL}/${jobPath}/`,
      }),
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '触发 Jenkins 发布失败'),
      status: error.response?.status,
    });
  }
});

router.post('/nn/release-branch', async (req: Request, res: Response) => {
  try {
    const targetBranch = normalizeBranchName(String(req.body?.targetBranch || req.body?.branch || ''));
    const baseBranch = normalizeBranchName(String(req.body?.baseBranch || 'develop')) || 'develop';
    const repoDir = getNniosRepoLocalDir();

    if (!targetBranch) {
      res.status(400).json({
        success: false,
        error: '请输入新分支名称',
      });
      return;
    }
    if (targetBranch === baseBranch) {
      res.status(400).json({
        success: false,
        error: '新分支不能与基准分支相同',
      });
      return;
    }
    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      res.status(400).json({
        success: false,
        error: `nnios 工作区不存在或不是 Git 仓库：${repoDir}`,
      });
      return;
    }

    try {
      await execFileAsync('git', ['check-ref-format', '--branch', targetBranch], { timeout: 10000 });
      await execFileAsync('git', ['check-ref-format', '--branch', baseBranch], { timeout: 10000 });
    } catch {
      res.status(400).json({
        success: false,
        error: '分支名称不是合法的 Git 分支名',
      });
      return;
    }

    const commands: Array<{ command: string; output: string }> = [];
    const publishRepos = getMgitPublishRepos(repoDir);
    const existingRepos: string[] = [];
    for (const repo of publishRepos) {
      if (await remoteBranchExists(repo, targetBranch)) {
        existingRepos.push(repo);
      }
    }
    if (existingRepos.length === publishRepos.length) {
      commands.push({
        command: `mgit publish ${targetBranch}`,
        output: `目标分支已存在，跳过重复 publish：${existingRepos.join(', ')}`,
      });
      res.json({
        success: true,
        data: {
          repoDir,
          targetBranch,
          baseBranch,
          commands,
          skipped: true,
        },
      });
      return;
    }

    const runCommand = async (bin: string, args: string[]) => {
      const command = [bin, ...args].join(' ');
      try {
        const { stdout, stderr } = await execFileAsync(bin, args, {
          cwd: repoDir,
          timeout: 10 * 60 * 1000,
          maxBuffer: 20 * 1024 * 1024,
        });
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();
        commands.push({ command, output });
      } catch (error: any) {
        const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim();
        commands.push({ command, output });
        throw new Error(`${command} 执行失败：${output || error.message}`);
      }
    };
    const runMgit = async (args: string[]) => {
      await runCommand('mgit', args);
    };

    await runMgit(['checkout', baseBranch]);
    await runMgit(['pull', '--ff-only']);
    await runMgit(['publish', targetBranch]);

    res.json({
      success: true,
      data: {
        repoDir,
        targetBranch,
        baseBranch,
        commands,
      },
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '拉取 nnios 新分支失败'),
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
    await cleanupLocalQualityProcesses(String(req.body?.deviceUdid || req.body?.device_udid || '').trim());

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

router.post('/nn/quality/wda/cleanup', async (req: Request, res: Response) => {
  try {
    const deviceUdid = String(req.body?.deviceUdid || req.body?.device_udid || '').trim();
    const result = await cleanupLocalQualityProcesses(deviceUdid);
    res.json({
      success: true,
      data: {
        ...result,
        deviceUdid,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || '清理 WDA 失败',
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
    const rawPackageUrl = String(req.body?.packageUrl || '').trim();
    const xcarchivePath = String(req.body?.xcarchivePath || '').trim();
    const archiveUrl = String(req.body?.archiveUrl || '').trim();
    const publishChannel = normalizeDeployTarget(String(req.body?.publishChannel || req.body?.deployTarget || ''));
    const forceInstalledProductionApp = publishChannel === 'TestFlight' || publishChannel === 'AppStore';
    const skipInstall = forceInstalledProductionApp || req.body?.skipInstall === true || String(req.body?.skipInstall || '').trim() === '1';
    const defaultAppBundleId = skipInstall ? 'com.nnhuyu.im' : 'com.nndev.im';
    const appBundleId = String(req.body?.appBundleId || req.body?.bundleId || getRuntimeEnv('QA_APP_BUNDLE_ID') || defaultAppBundleId).trim();
    const packageUrl = skipInstall ? `skip-install:${appBundleId}` : rawPackageUrl;
    const rawTestSuite = String(req.body?.testSuite || 'smoke').trim();
    const testSuite = normalizeQualitySuite(rawTestSuite);
    const devicePool = String(req.body?.devicePool || 'ios-default').trim();
    const requestedDeviceUdid = String(req.body?.deviceUdid || req.body?.device_udid || '').trim();
    const rawMonkeyDurationSeconds = String(req.body?.monkeyDurationSeconds || '').trim();
    const rawStutterScenario = String(req.body?.stutterScenario || req.body?.scenario || 'community').trim().toLowerCase();
    const normalizedStutterScenario = ['rtc', 'room', 'voice', 'voice-room', 'voiceroom', '语音房'].includes(rawStutterScenario)
      ? 'voice_room'
      : rawStutterScenario;
    const stutterScenario = QA_STUTTER_SCENARIOS.has(normalizedStutterScenario) ? normalizedStutterScenario : 'community';
    const timedQualitySuite = testSuite === 'monkey' || testSuite === 'stutter';
    const monkeyDurationSeconds = timedQualitySuite
      ? (rawMonkeyDurationSeconds || getRuntimeEnv('QA_MONKEY_DURATION_SECONDS') || '14400')
      : (getRuntimeEnv('QA_MONKEY_DURATION_SECONDS') || '14400');

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
    if (timedQualitySuite && !QA_MONKEY_DURATION_SECONDS.has(monkeyDurationSeconds)) {
      res.status(400).json({
        success: false,
        error: `执行时长无效：${rawMonkeyDurationSeconds || '-'}，可选值：5分钟、0.5小时、1小时、4小时、8小时`,
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

    const devicePoolLabel = selectedDevicePool.label;
    const crumb = await getCrumb();
    const monkeyBusinessMapPath = getRuntimeEnv('QA_MONKEY_BUSINESS_MAP_PATH')
      || path.join(getPlatformRootDir(), 'config', 'nnios-business-map.json');
    const params = new URLSearchParams({
      SOURCE_JOB: DEFAULT_JOB_NAME,
      SOURCE_BUILD_NUMBER: buildNumber,
      BRANCH: branch,
      COMMIT_HASH: commitHash,
      APP_VERSION: appVersion,
      PACKAGE_URL: packageUrl,
      XCARCHIVE_PATH: xcarchivePath,
      ARCHIVE_URL: archiveUrl,
      TEST_SUITE: testSuite,
      REQUESTED_TEST_SUITE: testSuite,
      RUN_MONKEY: testSuite === 'monkey' ? '1' : '0',
      DEVICE_POOL: devicePool,
      DEVICE_POOL_LABEL: devicePoolLabel,
      DEVICE_UDID: deviceKey,
      DEVICE_SELECTOR: deviceKey,
      DEVICE_CLOUD: 'LocalMac',
      QUALITY_RUNNER: testSuite === 'monkey' ? 'local-ios-device-monkey' : (testSuite === 'stutter' ? 'local-ios-device-stutter' : 'local-ios-device'),
      QA_RUNNER_MODE: testSuite === 'monkey' ? 'local-usb-monkey' : (testSuite === 'stutter' ? 'local-usb-stutter' : 'local-usb'),
      APP_BUNDLE_ID: appBundleId,
      SKIP_APP_INSTALL: skipInstall ? '1' : '0',
      COLD_START_DETECT_SCREEN: testSuite === 'stutter' ? '0' : (getRuntimeEnv('QA_COLD_START_DETECT_SCREEN') || '1'),
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
      STUTTER_SCENARIO: testSuite === 'stutter' ? stutterScenario : '',
      MONKEY_INTERVAL_SECONDS: getRuntimeEnv('QA_MONKEY_INTERVAL_SECONDS') || '0.45',
      MONKEY_MAX_REPORTED_EVENTS: getRuntimeEnv('QA_MONKEY_MAX_REPORTED_EVENTS') || '1000',
      MONKEY_BACK_INTERVAL_EVENTS: getRuntimeEnv('QA_MONKEY_BACK_INTERVAL_EVENTS') || '25',
      MONKEY_STUCK_EVENTS: getRuntimeEnv('QA_MONKEY_STUCK_EVENTS') || '18',
      MONKEY_STUCK_CHECK_INTERVAL_EVENTS: getRuntimeEnv('QA_MONKEY_STUCK_CHECK_INTERVAL_EVENTS') || '12',
      MONKEY_BACK_ACTION_PROBABILITY: getRuntimeEnv('QA_MONKEY_BACK_ACTION_PROBABILITY') || '0.12',
      MONKEY_BACK_TAP_PROBABILITY: getRuntimeEnv('QA_MONKEY_BACK_TAP_PROBABILITY') || '0.35',
      MONKEY_AVOID_TOP_BAR: getRuntimeEnv('QA_MONKEY_AVOID_TOP_BAR') || '1',
      MONKEY_HEARTBEAT_INTERVAL_SECONDS: getRuntimeEnv('QA_MONKEY_HEARTBEAT_INTERVAL_SECONDS') || '10',
      MONKEY_FORBIDDEN_TEXTS: getRuntimeEnv('QA_MONKEY_FORBIDDEN_TEXTS') || 'debug,Debug,DEBUG,调试,调试工具,日志,控制台,FLEX,Doraemon,DoraemonKit,DoraemonEntryWindow,DoKit,Dokit,www.dokit.cn',
      MONKEY_FORBIDDEN_PAGE_TEXTS: getRuntimeEnv('QA_MONKEY_FORBIDDEN_PAGE_TEXTS') || 'DoKit,Dokit,www.dokit.cn,DoraemonEntryWindow',
      MONKEY_FORBIDDEN_REGION_RATIO: getRuntimeEnv('QA_MONKEY_FORBIDDEN_REGION_RATIO') || '0.78,0.18,1.0,0.72',
      MONKEY_FORBIDDEN_PADDING: getRuntimeEnv('QA_MONKEY_FORBIDDEN_PADDING') || '16',
      MONKEY_BUSINESS_AWARE: testSuite === 'monkey' ? (getRuntimeEnv('QA_MONKEY_BUSINESS_AWARE') || '1') : '0',
      MONKEY_BUSINESS_MAP_PATH: monkeyBusinessMapPath,
      MONKEY_BUSINESS_DOMAINS: getRuntimeEnv('QA_MONKEY_BUSINESS_DOMAINS') || 'login,im,community,voice_room,profile,playwith',
      MONKEY_GUARDED_ACTION_POLICY: getRuntimeEnv('QA_MONKEY_GUARDED_ACTION_POLICY') || 'read_only',
      MONKEY_BUSINESS_WEIGHT_CORE: getRuntimeEnv('QA_MONKEY_BUSINESS_WEIGHT_CORE') || '40',
      MONKEY_BUSINESS_WEIGHT_EXPAND: getRuntimeEnv('QA_MONKEY_BUSINESS_WEIGHT_EXPAND') || '25',
      MONKEY_BUSINESS_WEIGHT_RECOVERY: getRuntimeEnv('QA_MONKEY_BUSINESS_WEIGHT_RECOVERY') || '20',
      MONKEY_BUSINESS_WEIGHT_POPUP: getRuntimeEnv('QA_MONKEY_BUSINESS_WEIGHT_POPUP') || '10',
      MONKEY_BUSINESS_WEIGHT_RANDOM: getRuntimeEnv('QA_MONKEY_BUSINESS_WEIGHT_RANDOM') || '5',
      MONKEY_BUSINESS_NAV_INTERVAL_EVENTS: getRuntimeEnv('QA_MONKEY_BUSINESS_NAV_INTERVAL_EVENTS') || '8',
      PERFORMANCE_SAMPLING: getRuntimeEnv('QA_PERFORMANCE_SAMPLING') || '1',
      PERFORMANCE_SAMPLER: getRuntimeEnv('QA_PERFORMANCE_SAMPLER') || 'auto',
      PERFORMANCE_SAMPLE_TYPES: getRuntimeEnv('QA_PERFORMANCE_SAMPLE_TYPES') || 'cpu,memory',
      PERFORMANCE_XCTRACE_TEMPLATE: testSuite === 'stutter'
        ? (getRuntimeEnv('QA_STUTTER_XCTRACE_TEMPLATE') || 'Animation Hitches')
        : (getRuntimeEnv('QA_PERFORMANCE_XCTRACE_TEMPLATE') || 'Activity Monitor'),
      PERFORMANCE_FRAME_XCTRACE: testSuite === 'stutter' ? '0' : (getRuntimeEnv('QA_PERFORMANCE_FRAME_XCTRACE') || '0'),
      PYMOBILEDEVICE3_TUNNELD_AUTO_START: getRuntimeEnv('QA_PYMOBILEDEVICE3_TUNNELD_AUTO_START') || '1',
      PYMOBILEDEVICE3_TUNNELD_HOST: getRuntimeEnv('QA_PYMOBILEDEVICE3_TUNNELD_HOST') || '127.0.0.1',
      PYMOBILEDEVICE3_TUNNELD_PORT: getRuntimeEnv('QA_PYMOBILEDEVICE3_TUNNELD_PORT') || '49151',
      PYMOBILEDEVICE3_TUNNELD_PROTOCOL: getRuntimeEnv('QA_PYMOBILEDEVICE3_TUNNELD_PROTOCOL') || 'tcp',
      PERF_COLD_START_WARN_MS: getRuntimeEnv('QA_PERF_COLD_START_WARN_MS') || '8000',
      PERF_COLD_START_SLOW_MS: getRuntimeEnv('QA_PERF_COLD_START_SLOW_MS') || '15000',
      PERF_CPU_AVG_WARN: getRuntimeEnv('QA_PERF_CPU_AVG_WARN') || '80',
      PERF_MEMORY_PEAK_WARN_MB: getRuntimeEnv('QA_PERF_MEMORY_PEAK_WARN_MB') || '1500',
      PERF_FPS_AVG_WARN: getRuntimeEnv('QA_PERF_FPS_AVG_WARN') || '45',
      PERF_FPS_MIN_WARN: getRuntimeEnv('QA_PERF_FPS_MIN_WARN') || '20',
      PERF_STUTTER_ACTION_WARN_MS: getRuntimeEnv('QA_PERF_STUTTER_ACTION_WARN_MS') || '2500',
      PERF_STUTTER_ACTION_SEVERE_MS: getRuntimeEnv('QA_PERF_STUTTER_ACTION_SEVERE_MS') || '5000',
      PERF_STUTTER_COUNT_WARN: getRuntimeEnv('QA_PERF_STUTTER_COUNT_WARN') || '3',
      PERF_FRAME_STUTTER_WARN_MS: getRuntimeEnv('QA_PERF_FRAME_STUTTER_WARN_MS') || '16.67',
      PERF_FRAME_STUTTER_SEVERE_MS: getRuntimeEnv('QA_PERF_FRAME_STUTTER_SEVERE_MS') || '33.34',
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
      data: publicJenkinsUrlsInValue(req, {
        jobName: DEFAULT_QA_JOB_NAME,
        sourceBuildNumber: buildNumber,
        testSuite,
        devicePool,
        url: `${JENKINS_BASE_URL}/${jobPath}/`,
      }),
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
