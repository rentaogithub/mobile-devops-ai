import '../config/env';
import { Router, Request, Response } from 'express';
import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import podDepsResolver from '../services/PodDependencyResolver';
import aiAnalysisService from '../services/AIAnalysisService';
import { FileHandlerService, StorageService } from '../services';
import { PodService } from '../services/PodService';
import symbolicationCache from '../services/SymbolicationCacheService';
import logger from '../utils/logger';
import { buildMgitPublishArgs } from '../utils/mgit';
import { AppError, ErrorCode } from '../types';
import { getJenkinsBaseUrl } from '../config/externalServices';
import { workflowIntegrationService } from '../services/WorkflowIntegrationService';
import { workflowService } from '../services/WorkflowService';
import { JenkinsReleaseError, jenkinsAssistantService } from '../services/JenkinsAssistantService';
import { requireAnyRole, requireRole } from '../middleware/auth';

const router = Router();
const execFileAsync = promisify(execFile);
const cicdTestReleaseMiddleware = requireAnyRole(['tester', 'developer', 'admin']);
const cicdDeveloperMiddleware = requireAnyRole(['developer', 'admin']);
const cicdProductReleaseMiddleware = requireAnyRole(['product', 'admin']);
const cicdReleaseMiddleware = requireAnyRole(['tester', 'developer', 'product', 'admin']);
const cicdAdminMiddleware = requireRole('admin');

const adminOnlyAppleReleaseMiddleware = (req: Request, res: Response, next: () => void) => {
  const deployTarget = normalizeDeployTarget(String(req.body?.deployTarget || ''));
  if (deployTarget === 'Pgyer' || deployTarget === 'TestFlight') {
    return cicdTestReleaseMiddleware(req, res, next);
  }
  if (deployTarget === 'AppStore') {
    return cicdProductReleaseMiddleware(req, res, next);
  }
  return cicdTestReleaseMiddleware(req, res, next);
};

const JENKINS_BASE_URL = getJenkinsBaseUrl();
const DEFAULT_JOB_NAME = process.env.JENKINS_NN_JOB || 'nn';
const DEFAULT_QA_JOB_NAME = process.env.JENKINS_NN_QA_JOB || 'nn-auto-quality';
const DEFAULT_REPO_URL = process.env.JENKINS_NN_REPO_URL || 'http://git.leigod.top/nn_ios/nnios.git';
const DEPLOY_TARGETS = new Set(['Pgyer', 'TestFlight', 'AppStore']);
const QA_TEST_SUITES = new Set(['smoke', 'im', 'rtc', 'monkey', 'stutter', 'business_flow', 'full']);
const QA_STUTTER_SCENARIOS = new Set(['community', 'im', 'voice_room']);
const QA_MONKEY_DURATION_SECONDS = new Set(['300', '1800', '3600', '14400', '28800']);
const RELEASE_BUILD_LIST_LIMIT = Math.min(
  200,
  Math.max(20, Number(process.env.JENKINS_RELEASE_BUILD_LIST_LIMIT || 50) || 50),
);
const RELEASE_BRANCH_BUILD_SCAN_LIMIT = Math.min(
  500,
  Math.max(RELEASE_BUILD_LIST_LIMIT, Number(process.env.JENKINS_RELEASE_BRANCH_BUILD_SCAN_LIMIT || 200) || 200),
);
const RELEASE_BRANCH_LIST_BUILD_SCAN_LIMIT = Math.min(
  500,
  Math.max(RELEASE_BRANCH_BUILD_SCAN_LIMIT, Number(process.env.JENKINS_RELEASE_BRANCH_LIST_BUILD_SCAN_LIMIT || RELEASE_BRANCH_BUILD_SCAN_LIMIT) || RELEASE_BRANCH_BUILD_SCAN_LIMIT),
);
const JENKINS_LIST_TIMEOUT_MS = Number(process.env.JENKINS_LIST_TIMEOUT_MS || 2500);
const JENKINS_BUILD_METADATA_TIMEOUT_MS = Number(process.env.JENKINS_BUILD_METADATA_TIMEOUT_MS || 1500);
const JENKINS_ORPHAN_BUILD_STALE_MS = Number(process.env.JENKINS_ORPHAN_BUILD_STALE_MS || 3 * 60 * 1000);
const RELEASE_SYNC_INTERVAL_MS = Math.max(15000, Number(process.env.JENKINS_RELEASE_SYNC_INTERVAL_MS || 60000) || 60000);
const RELEASE_SYNC_SCAN_LIMIT = Math.min(80, Math.max(10, Number(process.env.JENKINS_RELEASE_SYNC_SCAN_LIMIT || 40) || 40));
const RELEASE_SYNC_CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.JENKINS_RELEASE_SYNC_CONCURRENCY || 4) || 4));
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '..', 'nn-ios-platform-data');
const QUALITY_DEVICE_POOLS_CONFIG_PATH = path.join(DATA_DIR, 'quality-device-pools.json');
const LEGACY_SONIC_DEVICE_POOLS_CONFIG_PATH = path.join(DATA_DIR, 'sonic-device-pools.json');
const BUILD_FAILURE_ANALYSIS_CACHE_PATH = path.join(DATA_DIR, 'jenkins-build-failure-analysis.json');
const BUILD_DSYM_SYNC_CACHE_PATH = path.join(DATA_DIR, 'jenkins-build-dsym-sync.json');
const PACKAGE_SIZE_ANALYSIS_CACHE_PATH = path.join(DATA_DIR, 'jenkins-package-size-analysis.json');
const TESTFLIGHT_DISTRIBUTION_CACHE_PATH = path.join(DATA_DIR, 'jenkins-testflight-distribution.json');
const APPSTORE_RELEASE_CACHE_PATH = path.join(DATA_DIR, 'jenkins-appstore-release.json');
const RELEASE_REQUEST_CACHE_PATH = path.join(DATA_DIR, 'jenkins-release-requests.json');
const RELEASE_ORDER_CACHE_PATH = path.join(DATA_DIR, 'jenkins-release-orders.json');
const JENKINS_BRANCH_CACHE_PATH = path.join(DATA_DIR, 'jenkins-branches.json');
const LOCAL_QUALITY_ARTIFACT_ROUTE = '/api/jenkins/nn/quality/local-artifact';
const QUALITY_HANG_ANALYSIS_CACHE = new Map<string, any>();
const fileHandler = new FileHandlerService();
const storage = new StorageService();
const podService = new PodService();
const BUILD_DSYM_SYNC_RUNNING = new Set<string>();
const TESTFLIGHT_DISTRIBUTION_RUNNING = new Set<string>();
const APPSTORE_RELEASE_RUNNING = new Set<string>();
let RELEASE_SYNC_RUNNING = false;
const ASC_API_BASE = 'https://api.appstoreconnect.apple.com/v1';
const TESTFLIGHT_DISTRIBUTION_POLL_INTERVAL_MS = Math.max(
  5000,
  Number(process.env.TESTFLIGHT_DISTRIBUTION_POLL_INTERVAL_MS || 30000) || 30000,
);
const TESTFLIGHT_DISTRIBUTION_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.TESTFLIGHT_DISTRIBUTION_MAX_ATTEMPTS || 80) || 80,
);
const APPSTORE_RELEASE_APPROVED_STATUSES = new Set(['pending_release', 'ready_for_distribution', 'ready_for_sale']);

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

function appStoreReleaseApprovedTitle(status?: string) {
  if (status === 'pending_release') return '审核通过，等待开发者发布';
  if (status === 'ready_for_distribution') return '审核通过，可供分发';
  if (status === 'ready_for_sale') return '已上架 App Store';
  return '审核通过';
}

function shouldNotifyAppStoreReleaseApproved(previous: any, nextRelease: any) {
  const nextStatus = String(nextRelease?.status || '');
  if (!APPSTORE_RELEASE_APPROVED_STATUSES.has(nextStatus)) return false;
  if (nextRelease?.reviewApprovalNotifiedAt) return false;
  const previousStatus = String(previous?.status || '');
  return !APPSTORE_RELEASE_APPROVED_STATUSES.has(previousStatus);
}

async function sendWeChatRobotMarkdown(content: string) {
  const webhookUrl = String(getRuntimeEnv('WECHAT_WEBHOOK_URL') || '').trim();
  if (!webhookUrl) {
    logger.warn('企业微信机器人 Webhook 未配置，跳过消息发送');
    return;
  }
  const response = await axios.post(webhookUrl, {
    msgtype: 'markdown',
    markdown: { content },
    at: { isAtAll: true },
  }, {
    timeout: 10000,
    headers: { 'Content-Type': 'application/json' },
  });
  if (response.data?.errcode && response.data.errcode !== 0) {
    throw new Error(response.data?.errmsg || '企业微信机器人消息发送失败');
  }
}

function buildAppStoreReleaseApprovedMessage(jenkinsBuildNumber: number, release: any) {
  const appVersion = String(release?.appVersion || '-');
  const channelBuildNumber = String(release?.buildNumber || '-');
  const branchName = String(release?.branchName || '-');
  const statusText = appStoreReleaseApprovedTitle(String(release?.status || ''));
  return `🎉 NNIM iOS 苹果商店包审核通过

APP版本: ${appVersion}
Bundle ID: com.nnhuyu.im
发布渠道: AppStore
Jenkins构建号: ${jenkinsBuildNumber}
苹果构建号: ${channelBuildNumber}
分支名称: ${branchName}
状态: ${statusText}`;
}

function notifyAppStoreReleaseApproved(jenkinsBuildNumber: number, release: any) {
  const message = buildAppStoreReleaseApprovedMessage(jenkinsBuildNumber, release);
  void sendWeChatRobotMarkdown(message)
    .then(() => logger.info('App Store 审核通过企业微信通知发送成功', {
      buildNumber: jenkinsBuildNumber,
      appVersion: release?.appVersion,
      channelBuildNumber: release?.buildNumber,
      status: release?.status,
    }))
    .catch((error) => logger.warn('App Store 审核通过企业微信通知发送失败', {
      buildNumber: jenkinsBuildNumber,
      error: error?.message,
    }));
}

function normalizeQualitySuite(value?: string) {
  const text = String(value || 'smoke').trim();
  const lower = text.toLowerCase();
  if (/monkey|随机|猴子/i.test(text)) return 'monkey';
  if (/卡顿|stutter|hitch|jank/i.test(text)) return 'stutter';
  if (/business[_-]?flow|业务.*编排|自定义.*质检|自定义.*测试/i.test(text)) return 'business_flow';
  if (/冒烟|smoke/i.test(text)) return 'smoke';
  if (/^im$|im\s*基础/i.test(text)) return 'im';
  if (/^rtc$|rtc\s*基础/i.test(text)) return 'rtc';
  if (/全量|full/i.test(text)) return 'full';
  return lower;
}

function readBusinessFlowPresetFeatures() {
  try {
    const presetPath = path.join(getPlatformRootDir(), 'config', 'nnios-business-flow-presets.json');
    const parsed = JSON.parse(fs.readFileSync(presetPath, 'utf-8'));
    return Array.isArray(parsed?.features) ? parsed.features : [];
  } catch {
    return [];
  }
}

function normalizeBusinessFlowPlan(input: any) {
  const plan = input && typeof input === 'object' ? input : {};
  const presetFeatures = readBusinessFlowPresetFeatures();
  const featureMap = new Map<string, any>();
  for (const feature of presetFeatures) {
    const id = String(feature?.id || feature?.path || '').trim();
    if (id) featureMap.set(id, feature);
  }
  const requestedFeatureIds = Array.isArray(plan.featureIds)
    ? plan.featureIds.map((item: any) => String(item || '').trim()).filter(Boolean)
    : [];
  let steps: any[] = [];
  if (requestedFeatureIds.length > 0) {
    const missing = requestedFeatureIds.filter((id: string) => !featureMap.has(id));
    if (missing.length > 0) {
      throw new Error(`业务功能不存在：${missing.join(', ')}`);
    }
    steps = requestedFeatureIds.map((id: string) => featureMap.get(id));
  } else if (Array.isArray(plan.steps)) {
    steps = plan.steps;
  }
  steps = steps
    .map((step: any, index: number) => {
      const type = String(step?.type || 'business_action').trim();
      const domain = String(step?.domain || '').trim();
      const businessPath = String(step?.path || step?.businessPath || '').trim();
      const id = String(step?.id || businessPath || `${type}_${index + 1}`).trim();
      if (type !== 'launch' && type !== 'business_action' && type !== 'monkey_explore') {
        throw new Error(`业务编排步骤类型无效：${type}`);
      }
      if (type !== 'launch' && (!domain || !businessPath)) {
        throw new Error(`业务编排步骤缺少业务域或路径：${id}`);
      }
      return {
        id,
        type,
        label: String(step?.label || step?.pageName || businessPath || '启动 App').trim(),
        domain,
        path: businessPath,
        durationSeconds: Math.max(5, Math.min(1800, Number(step?.durationSeconds || (type === 'launch' ? 15 : 60)) || 60)),
        labels: Array.isArray(step?.labels) ? step.labels.map((item: any) => String(item || '').trim()).filter(Boolean).slice(0, 8) : [],
        goal: String(step?.goal || '').trim(),
        entryLanguage: Array.isArray(step?.entryLanguage) ? step.entryLanguage.map((item: any) => String(item || '').trim()).filter(Boolean).slice(0, 12) : [],
        targetLanguage: Array.isArray(step?.targetLanguage) ? step.targetLanguage.map((item: any) => String(item || '').trim()).filter(Boolean).slice(0, 16) : [],
        beforeLanguage: Array.isArray(step?.beforeLanguage) ? step.beforeLanguage.map((item: any) => String(item || '').trim()).filter(Boolean).slice(0, 16) : [],
        afterLanguage: Array.isArray(step?.afterLanguage) ? step.afterLanguage.map((item: any) => String(item || '').trim()).filter(Boolean).slice(0, 16) : [],
        forbiddenLanguage: Array.isArray(step?.forbiddenLanguage) ? step.forbiddenLanguage.map((item: any) => String(item || '').trim()).filter(Boolean).slice(0, 24) : [],
        actions: Array.isArray(step?.actions) ? step.actions.map((action: any) => ({
          intent: String(action?.intent || action?.type || '').trim(),
          text: String(action?.text || action?.value || '').trim(),
          seconds: Number.isFinite(Number(action?.seconds)) ? Number(action.seconds) : undefined,
          randomTextPool: Array.isArray(action?.randomTextPool)
            ? action.randomTextPool.map((item: any) => String(item || '').trim()).filter(Boolean).map((item: string) => item.slice(0, 32)).slice(0, 20)
            : undefined,
          rememberAs: String(action?.rememberAs || '').trim().slice(0, 64) || undefined,
        })).filter((action: any) => action.intent).slice(0, 12) : [],
        sourceEvidence: Array.isArray(step?.sourceEvidence) ? step.sourceEvidence.map((item: any) => String(item || '').trim()).filter(Boolean).slice(0, 12) : [],
        passCondition: String(step?.passCondition || '').trim(),
        fallbackXRatio: Number.isFinite(Number(step?.fallbackXRatio)) ? Number(step.fallbackXRatio) : undefined,
        fallbackYRatio: Number.isFinite(Number(step?.fallbackYRatio)) ? Number(step.fallbackYRatio) : undefined,
      };
    });
  if (steps.length === 0) {
    throw new Error('请选择至少一个业务功能');
  }
  if (steps[0]?.type !== 'launch') {
    steps.unshift({ id: 'launch', type: 'launch', label: '启动 App', durationSeconds: 15, domain: '', path: '', labels: [] });
  }
  const domains = Array.from(new Set(steps.map((step) => step.domain).filter(Boolean)));
  return {
    version: 1,
    name: String(plan.name || '自定义业务编排').trim() || '自定义业务编排',
    maxDurationSeconds: QA_MONKEY_DURATION_SECONDS.has(String(plan.maxDurationSeconds || ''))
      ? Number(plan.maxDurationSeconds)
      : undefined,
    riskPolicy: String(plan.riskPolicy || 'read_only').trim() || 'read_only',
    stopOnFailure: plan.stopOnFailure !== false,
    featureIds: requestedFeatureIds,
    targetDomains: domains,
    steps,
  };
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

function readShellConfigValue(configPath: string, key: string): string {
  try {
    if (!fs.existsSync(configPath)) return '';
    const lines = fs.readFileSync(configPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(new RegExp(`^(?:export\\s+)?${key}=([\\s\\S]*)$`));
      if (!match) continue;
      return String(match[1] || '').trim().replace(/^['"]|['"]$/g, '');
    }
  } catch {
    return '';
  }
  return '';
}

function getJenkinsRepoLocalDir() {
  const configured = String(getRuntimeEnv('NN_IOS_JENKINS_DIR') || getRuntimeEnv('JENKINS_NN_IOS_JENKINS_DIR') || '').trim();
  if (configured) return path.resolve(configured);
  const platformRoot = getPlatformRootDir();
  const candidates = [
    path.resolve(platformRoot, '..', 'nn-ios-jekins'),
    path.resolve(process.cwd(), '..', 'nn-ios-jekins'),
    path.resolve(process.cwd(), '..', '..', 'nn-ios-jekins'),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'cicd/jenkins/build_config.sh'))) || candidates[0];
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
    (['passed', 'success'].includes(finalStatus) && ['failed', 'failure', 'unstable', 'aborted', 'canceled', 'cancelled'].includes(progressStatus)) ||
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

const REQUIRED_QUALITY_JOB_CONFIG_MARKERS = [
  '<name>BUSINESS_FLOW_PLAN_JSON</name>',
  '<name>PLATFORM_TASK_ID</name>',
  'business_flow',
];

async function ensureQualityJenkinsJobConfigFresh() {
  const jobPath = encodeJobPath(DEFAULT_QA_JOB_NAME);
  const configUrl = `${JENKINS_BASE_URL}/${jobPath}/config.xml`;
  let configXml = '';
  try {
    const response = await axios.get(configUrl, {
      timeout: 10000,
      responseType: 'text',
      transformResponse: [(data) => data],
      validateStatus: () => true,
      ...buildAuthConfig(),
    });
    if (response.status === 200 && typeof response.data === 'string') {
      configXml = response.data;
    }
  } catch {
    configXml = '';
  }
  const missingMarkers = REQUIRED_QUALITY_JOB_CONFIG_MARKERS.filter((marker) => !configXml.includes(marker));
  if (missingMarkers.length === 0) {
    return { synced: false, missingMarkers: [] };
  }
  const syncResult = await syncQualityJenkinsJobConfig();
  return { synced: true, missingMarkers, syncResult };
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

function readBuildDsymSyncCache() {
  const cache = readJsonFile(BUILD_DSYM_SYNC_CACHE_PATH);
  return cache && typeof cache === 'object' ? cache : { builds: {} };
}

function getSavedBuildDsymSync(buildNumber: number) {
  const cache = readBuildDsymSyncCache();
  return cache?.builds?.[String(buildNumber)] || null;
}

function saveBuildDsymSync(buildNumber: number, sync: any) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const cache = readBuildDsymSyncCache();
  const nextCache = {
    ...cache,
    builds: {
      ...(cache.builds || {}),
      [String(buildNumber)]: {
        ...sync,
        updatedAt: new Date().toISOString(),
      },
    },
  };
  const tmpPath = `${BUILD_DSYM_SYNC_CACHE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(nextCache, null, 2));
  fs.renameSync(tmpPath, BUILD_DSYM_SYNC_CACHE_PATH);
  return nextCache.builds[String(buildNumber)];
}

function readPackageSizeAnalysisCache() {
  const cache = readJsonFile(PACKAGE_SIZE_ANALYSIS_CACHE_PATH);
  return cache && typeof cache === 'object' ? cache : { builds: {} };
}

function getSavedPackageSizeAnalysis(buildNumber: number) {
  const cache = readPackageSizeAnalysisCache();
  return cache?.builds?.[String(buildNumber)] || null;
}

function savePackageSizeAnalysis(buildNumber: number, analysis: any) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const cache = readPackageSizeAnalysisCache();
  const updatedAt = new Date().toISOString();
  const nextCache = {
    ...cache,
    builds: {
      ...(cache.builds || {}),
      [String(buildNumber)]: {
        ...analysis,
        cached: false,
        updatedAt,
      },
    },
  };
  const tmpPath = `${PACKAGE_SIZE_ANALYSIS_CACHE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(nextCache, null, 2));
  fs.renameSync(tmpPath, PACKAGE_SIZE_ANALYSIS_CACHE_PATH);
  return nextCache.builds[String(buildNumber)];
}

function readTestFlightDistributionCache() {
  const cache = readJsonFile(TESTFLIGHT_DISTRIBUTION_CACHE_PATH);
  return cache && typeof cache === 'object' ? cache : { builds: {} };
}

function getSavedTestFlightDistribution(buildNumber: number) {
  const cache = readTestFlightDistributionCache();
  return cache?.builds?.[String(buildNumber)] || null;
}

function saveTestFlightDistribution(buildNumber: number, distribution: any) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const cache = readTestFlightDistributionCache();
  const previous = cache?.builds?.[String(buildNumber)] || {};
  const nextCache = {
    ...cache,
    builds: {
      ...(cache.builds || {}),
      [String(buildNumber)]: {
        ...previous,
        ...distribution,
        updatedAt: new Date().toISOString(),
      },
    },
  };
  const tmpPath = `${TESTFLIGHT_DISTRIBUTION_CACHE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(nextCache, null, 2));
  fs.renameSync(tmpPath, TESTFLIGHT_DISTRIBUTION_CACHE_PATH);
  const nextDistribution = nextCache.builds[String(buildNumber)];
  const distributionStatus = String(nextDistribution?.status || '');
  const eventStatus = distributionStatus === 'distributed'
    ? 'success'
    : (distributionStatus === 'failed' ? 'error' : (distributionStatus === 'skipped' || distributionStatus === 'unconfirmed' ? 'warning' : 'processing'));
  updateReleaseOrderByBuild(buildNumber, {
    status: distributionStatus === 'distributed' ? 'published' : (distributionStatus === 'failed' ? 'failed' : 'syncing'),
    phase: `testflight_${distributionStatus || 'syncing'}`,
    failureReason: distributionStatus === 'failed' ? String(nextDistribution?.message || 'TestFlight 自动分发失败') : '',
  }, releaseOrderEvent(
    `testflight.${distributionStatus || 'updated'}`,
    'TestFlight 状态同步',
    eventStatus,
    String(nextDistribution?.message || ''),
    {
      appStoreBuildId: nextDistribution?.appStoreBuildId,
      processingState: nextDistribution?.processingState,
      internalBuildState: nextDistribution?.internalBuildState,
      externalBuildState: nextDistribution?.externalBuildState,
    },
  ));
  return nextDistribution;
}

function readAppStoreReleaseCache() {
  const cache = readJsonFile(APPSTORE_RELEASE_CACHE_PATH);
  return cache && typeof cache === 'object' ? cache : { builds: {} };
}

function getSavedAppStoreRelease(buildNumber: number) {
  const cache = readAppStoreReleaseCache();
  return cache?.builds?.[String(buildNumber)] || null;
}

function saveAppStoreRelease(buildNumber: number, release: any) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const cache = readAppStoreReleaseCache();
  const previous = cache?.builds?.[String(buildNumber)] || {};
  const updatedAt = new Date().toISOString();
  const nextRelease = {
    ...previous,
    ...release,
    updatedAt,
  };
  const shouldNotifyApproved = shouldNotifyAppStoreReleaseApproved(previous, nextRelease);
  if (shouldNotifyApproved) {
    nextRelease.reviewApprovalNotifiedAt = updatedAt;
  }
  const nextCache = {
    ...cache,
    builds: {
      ...(cache.builds || {}),
      [String(buildNumber)]: nextRelease,
    },
  };
  const tmpPath = `${APPSTORE_RELEASE_CACHE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(nextCache, null, 2));
  fs.renameSync(tmpPath, APPSTORE_RELEASE_CACHE_PATH);
  const nextStatus = String(nextRelease?.status || '');
  const eventStatus = ['ready_for_sale', 'ready_for_distribution'].includes(nextStatus)
    ? 'success'
    : (['failed', 'rejected', 'developer_action_needed'].includes(nextStatus) ? 'error' : (['skipped', 'unconfirmed', 'pending_agreement'].includes(nextStatus) ? 'warning' : 'processing'));
  updateReleaseOrderByBuild(buildNumber, {
    status: nextStatus === 'ready_for_sale' ? 'published' : (eventStatus === 'error' ? 'failed' : 'syncing'),
    phase: `appstore_${nextStatus || 'syncing'}`,
    failureReason: eventStatus === 'error' ? String(nextRelease?.failureReason || nextRelease?.message || 'App Store 自动发布异常') : '',
  }, releaseOrderEvent(
    `appstore.${nextStatus || 'updated'}`,
    'App Store 状态同步',
    eventStatus,
    String(nextRelease?.failureReason || nextRelease?.message || nextRelease?.appStoreState || ''),
    {
      appStoreBuildId: nextRelease?.appStoreBuildId,
      appStoreVersionId: nextRelease?.appStoreVersionId,
      reviewSubmissionId: nextRelease?.reviewSubmissionId,
      appStoreState: nextRelease?.appStoreState,
      releaseType: nextRelease?.releaseType,
    },
  ));
  if (shouldNotifyApproved) {
    notifyAppStoreReleaseApproved(buildNumber, nextRelease);
  }
  return nextCache.builds[String(buildNumber)];
}

function readReleaseRequestCache() {
  const cache = readJsonFile(RELEASE_REQUEST_CACHE_PATH);
  return cache && typeof cache === 'object' ? cache : { requests: [], builds: {} };
}

function writeReleaseRequestCache(cache: any) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmpPath = `${RELEASE_REQUEST_CACHE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2));
  fs.renameSync(tmpPath, RELEASE_REQUEST_CACHE_PATH);
}

function saveReleaseRequestArchive(request: any) {
  const cache = readReleaseRequestCache();
  const requests = Array.isArray(cache.requests) ? cache.requests : [];
  const nextRequest = {
    id: crypto.randomUUID(),
    branch: normalizeBranchName(String(request.branch || '')),
    deployTarget: normalizeDeployTarget(String(request.deployTarget || '')),
    releaseNotes: normalizeTestFlightWhatsNew(request.releaseNotes),
    submittedAt: new Date().toISOString(),
    queueUrl: request.queueUrl || '',
  };
  const nextCache = {
    ...cache,
    requests: [nextRequest, ...requests].slice(0, 200),
    builds: cache.builds || {},
  };
  writeReleaseRequestCache(nextCache);
  return nextRequest;
}

function getArchivedReleaseRequestForBuild(buildNumber: number) {
  const cache = readReleaseRequestCache();
  return cache?.builds?.[String(buildNumber)] || null;
}

function matchReleaseRequestForBuild(build: any, branchName: string, publishChannel: string) {
  const buildNumber = Number(build?.number);
  if (!Number.isFinite(buildNumber) || buildNumber <= 0) return null;
  const cache = readReleaseRequestCache();
  const existing = cache?.builds?.[String(buildNumber)];
  if (existing) return existing;

  const normalizedBranch = normalizeBranchName(branchName || '');
  const normalizedChannel = normalizeDeployTarget(publishChannel || '');
  const buildTimestamp = Number(build?.timestamp || 0);
  if (!normalizedBranch || !normalizedChannel || !buildTimestamp) return null;

  const requests = Array.isArray(cache.requests) ? cache.requests : [];
  const matched = requests
    .filter((request: any) => {
      if (request.buildNumber) return false;
      if (normalizeBranchName(String(request.branch || '')) !== normalizedBranch) return false;
      if (normalizeDeployTarget(String(request.deployTarget || '')) !== normalizedChannel) return false;
      const submittedAt = Date.parse(String(request.submittedAt || ''));
      return Number.isFinite(submittedAt) &&
        buildTimestamp >= submittedAt - 5 * 60 * 1000 &&
        buildTimestamp <= submittedAt + 2 * 60 * 60 * 1000;
    })
    .sort((a: any, b: any) => Date.parse(String(b.submittedAt || '')) - Date.parse(String(a.submittedAt || '')))[0];
  if (!matched) return null;

  const archived = {
    ...matched,
    buildNumber,
    matchedAt: new Date().toISOString(),
  };
  const nextRequests = requests.map((request: any) => request.id === matched.id ? archived : request);
  writeReleaseRequestCache({
    ...cache,
    requests: nextRequests,
    builds: {
      ...(cache.builds || {}),
      [String(buildNumber)]: archived,
    },
  });
  return archived;
}

function readReleaseOrderCache() {
  const cache = readJsonFile(RELEASE_ORDER_CACHE_PATH);
  return cache && typeof cache === 'object' ? cache : { orders: [], builds: {} };
}

function writeReleaseOrderCache(cache: any) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmpPath = `${RELEASE_ORDER_CACHE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2));
  fs.renameSync(tmpPath, RELEASE_ORDER_CACHE_PATH);
}

function releaseOrderEvent(type: string, title: string, status: string, detail?: string, payload?: any) {
  return {
    id: crypto.randomUUID(),
    type,
    title,
    status,
    detail: detail || '',
    payload: payload || undefined,
    at: new Date().toISOString(),
  };
}

function createReleaseOrder(input: any) {
  const now = new Date().toISOString();
  const normalizedDeployTarget = normalizeDeployTarget(String(input.deployTarget || 'Pgyer')) || 'Pgyer';
  const normalizedBranch = normalizeBranchName(String(input.branch || ''));
  const releaseOrder = {
    id: crypto.randomUUID(),
    branch: normalizedBranch,
    deployTarget: normalizedDeployTarget,
    appVersion: String(input.appVersion || appVersionFromReleaseBranch(normalizedBranch) || '').trim(),
    releaseNotes: normalizeTestFlightWhatsNew(input.releaseNotes || input.testFlightWhatsNew),
    gateBuildNumber: input.gateBuildNumber ? Number(input.gateBuildNumber) : undefined,
    releaseGateOverrideReason: String(input.releaseGateOverrideReason || '').trim(),
    jenkinsQueueUrl: String(input.queueUrl || ''),
    jenkinsBuildNumber: input.jenkinsBuildNumber ? Number(input.jenkinsBuildNumber) : undefined,
    channelBuildNumber: String(input.channelBuildNumber || ''),
    status: String(input.status || 'queued'),
    phase: String(input.phase || 'jenkins_queued'),
    failureReason: String(input.failureReason || ''),
    createdAt: now,
    updatedAt: now,
    events: [
      releaseOrderEvent('release.created', '创建发布单', 'success', `${normalizedDeployTarget} / ${normalizedBranch}`),
    ],
  };
  const cache = readReleaseOrderCache();
  writeReleaseOrderCache({
    ...cache,
    orders: [releaseOrder, ...(Array.isArray(cache.orders) ? cache.orders : [])].slice(0, 500),
    builds: cache.builds || {},
  });
  return releaseOrder;
}

function saveReleaseOrder(orderId: string, patch: any = {}, event?: any) {
  if (!orderId) return null;
  const cache = readReleaseOrderCache();
  const orders = Array.isArray(cache.orders) ? cache.orders : [];
  let updatedOrder: any = null;
  const nextOrders = orders.map((order: any) => {
    if (String(order?.id || '') !== orderId) return order;
    const currentEvents = Array.isArray(order.events) ? order.events : [];
    const lastEvent = currentEvents[currentEvents.length - 1];
    const shouldAppendEvent = Boolean(event) && !(
      lastEvent &&
      lastEvent.type === event.type &&
      lastEvent.status === event.status &&
      String(lastEvent.detail || '') === String(event.detail || '')
    );
    const nextEvents = shouldAppendEvent ? [...currentEvents, event] : currentEvents;
    updatedOrder = {
      ...order,
      ...patch,
      updatedAt: new Date().toISOString(),
      events: nextEvents.slice(-80),
    };
    return updatedOrder;
  });
  if (!updatedOrder) return null;
  const nextBuilds = { ...(cache.builds || {}) };
  if (updatedOrder.jenkinsBuildNumber) {
    nextBuilds[String(updatedOrder.jenkinsBuildNumber)] = updatedOrder;
  }
  writeReleaseOrderCache({
    ...cache,
    orders: nextOrders,
    builds: nextBuilds,
  });
  return updatedOrder;
}

function getReleaseOrderForBuild(buildNumber: number) {
  const cache = readReleaseOrderCache();
  return cache?.builds?.[String(buildNumber)] || null;
}

function latestUnlinkedReleaseOrder(branchName: string, deployTarget: string, buildTimestamp: number) {
  const cache = readReleaseOrderCache();
  const normalizedBranch = normalizeBranchName(branchName || '');
  const normalizedChannel = normalizeDeployTarget(deployTarget || '');
  const orders = Array.isArray(cache.orders) ? cache.orders : [];
  return orders
    .filter((order: any) => {
      if (order.jenkinsBuildNumber) return false;
      if (normalizeBranchName(String(order.branch || '')) !== normalizedBranch) return false;
      if (normalizeDeployTarget(String(order.deployTarget || '')) !== normalizedChannel) return false;
      const createdAt = Date.parse(String(order.createdAt || order.submittedAt || ''));
      return Number.isFinite(createdAt) &&
        buildTimestamp >= createdAt - 5 * 60 * 1000 &&
        buildTimestamp <= createdAt + 2 * 60 * 60 * 1000;
    })
    .sort((a: any, b: any) => Date.parse(String(b.createdAt || '')) - Date.parse(String(a.createdAt || '')))[0] || null;
}

function releaseOrderPhaseFromBuild(build: any, publishChannel: string) {
  if (build?.building) return { status: 'running', phase: 'jenkins_building', title: 'Jenkins 构建中', eventStatus: 'processing' };
  const result = String(build?.result || '').toUpperCase();
  if (result === 'SUCCESS') {
    if (normalizeDeployTarget(publishChannel) === 'Pgyer') return { status: 'published', phase: 'pgyer_uploaded', title: '蒲公英发布完成', eventStatus: 'success' };
    return { status: 'uploaded', phase: 'jenkins_success', title: 'Jenkins 打包上传完成', eventStatus: 'success' };
  }
  if (result === 'ABORTED') return { status: 'canceled', phase: 'jenkins_aborted', title: 'Jenkins 构建已取消', eventStatus: 'warning' };
  if (result) return { status: 'failed', phase: 'jenkins_failed', title: 'Jenkins 构建失败', eventStatus: 'error' };
  return { status: 'unknown', phase: 'jenkins_unknown', title: '等待 Jenkins 状态', eventStatus: 'default' };
}

function matchReleaseOrderForBuild(build: any, branchName: string, publishChannel: string, metadata: any = {}) {
  const buildNumber = Number(build?.number);
  if (!Number.isFinite(buildNumber) || buildNumber <= 0) return null;
  const existing = getReleaseOrderForBuild(buildNumber);
  const normalizedBranch = normalizeBranchName(branchName || '');
  const normalizedChannel = normalizeDeployTarget(publishChannel || '');
  const buildTimestamp = Number(build?.timestamp || 0);
  let order = existing || latestUnlinkedReleaseOrder(normalizedBranch, normalizedChannel, buildTimestamp);
  if (!order) return null;

  const phase = releaseOrderPhaseFromBuild(build, normalizedChannel);
  const existingPhase = String(order.phase || '');
  const hasChannelSyncPhase = /^(appstore|testflight)_/.test(existingPhase);
  const patch = {
    jenkinsBuildNumber: buildNumber,
    jenkinsBuildUrl: normalizeJenkinsUrl(build?.url),
    branch: normalizedBranch || order.branch,
    deployTarget: normalizedChannel || order.deployTarget,
    appVersion: String(metadata.appVersion || order.appVersion || appVersionFromReleaseBranch(normalizedBranch) || '').trim(),
    channelBuildNumber: String(metadata.buildNumber || order.channelBuildNumber || '').trim(),
    status: hasChannelSyncPhase ? order.status : phase.status,
    phase: hasChannelSyncPhase ? order.phase : phase.phase,
    failureReason: phase.status === 'failed' ? 'Jenkins 构建失败，请查看构建日志' : String(order.failureReason || ''),
  };
  const alreadyRecorded = Array.isArray(order.events) && order.events.some((event: any) => event.type === `release.${phase.phase}`);
  order = saveReleaseOrder(order.id, patch, alreadyRecorded || hasChannelSyncPhase
    ? undefined
    : releaseOrderEvent(`release.${phase.phase}`, phase.title, phase.eventStatus, `Jenkins #${buildNumber}`));
  return order;
}

function updateReleaseOrderByBuild(buildNumber: number, patch: any, event?: any) {
  const order = getReleaseOrderForBuild(buildNumber);
  if (!order?.id) return null;
  return saveReleaseOrder(order.id, patch, event);
}

function readBranchCache() {
  const cache = readJsonFile(JENKINS_BRANCH_CACHE_PATH);
  const branches = Array.isArray(cache?.branches) ? cache.branches : [];
  return branches.map((item: any) => normalizeBranchName(String(item || ''))).filter(Boolean);
}

function saveBranchCache(branches: string[]) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const uniqueBranches = Array.from(new Set(branches.map(normalizeBranchName).filter(Boolean))).sort(compareBranchOptions);
  const tmpPath = `${JENKINS_BRANCH_CACHE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({
    branches: uniqueBranches,
    updatedAt: new Date().toISOString(),
  }, null, 2));
  fs.renameSync(tmpPath, JENKINS_BRANCH_CACHE_PATH);
  return uniqueBranches;
}

function readApplePrivateKey() {
  const inlineKey = getRuntimeEnv('APP_STORE_CONNECT_API_PRIVATE_KEY').trim();
  if (inlineKey) return inlineKey.replace(/\\n/g, '\n');

  const keyPath = getRuntimeEnv('APP_STORE_CONNECT_API_KEY_PATH').trim();
  if (!keyPath) return '';
  const resolved = path.isAbsolute(keyPath) ? keyPath : path.resolve(process.cwd(), keyPath);
  return fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf-8') : '';
}

function base64Url(input: Buffer | string) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createAppleJwt() {
  const keyId = getRuntimeEnv('APP_STORE_CONNECT_API_KEY_ID').trim();
  const issuerId = getRuntimeEnv('APP_STORE_CONNECT_API_ISSUER_ID').trim();
  const privateKey = readApplePrivateKey();
  const missing = [
    !keyId ? 'APP_STORE_CONNECT_API_KEY_ID' : '',
    !issuerId ? 'APP_STORE_CONNECT_API_ISSUER_ID' : '',
    !privateKey ? 'APP_STORE_CONNECT_API_KEY_PATH 或 APP_STORE_CONNECT_API_PRIVATE_KEY' : '',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`App Store Connect API Key 未配置完整：${missing.join('、')}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = {
    iss: issuerId,
    iat: now,
    exp: now + 20 * 60,
    aud: 'appstoreconnect-v1',
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64Url(signature)}`;
}

async function requestAppStoreConnect<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  data?: any,
): Promise<T> {
  const response = await axios.request<T>({
    method,
    url,
    data,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${createAppleJwt()}`,
      'Content-Type': 'application/json',
    },
  });
  return response.data;
}

function testFlightGroupTokens() {
  return String(getRuntimeEnv('APP_STORE_CONNECT_TESTFLIGHT_GROUPS') || getRuntimeEnv('TESTFLIGHT_BETA_GROUPS') || '')
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function testFlightDefaultWhatsNew() {
  return String(getRuntimeEnv('TESTFLIGHT_WHATS_NEW') || getRuntimeEnv('APP_STORE_CONNECT_TESTFLIGHT_WHATS_NEW') || '修复已知问题，优化体验。').trim();
}

function testFlightAppId() {
  return String(getRuntimeEnv('APP_STORE_CONNECT_APP_ID') || getRuntimeEnv('ASC_APP_ID') || '').trim();
}

function normalizeTestFlightWhatsNew(value?: string) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
}

async function findAppStoreBuild(appId: string, appVersion: string, buildNumber: string) {
  const params = new URLSearchParams({
    'filter[app]': appId,
    'filter[version]': buildNumber,
    'filter[preReleaseVersion.version]': appVersion,
    limit: '10',
    include: 'preReleaseVersion',
  });
  const response = await requestAppStoreConnect<any>('GET', `${ASC_API_BASE}/builds?${params.toString()}`);
  const builds = Array.isArray(response?.data) ? response.data : [];
  return builds.find((item: any) => String(item?.attributes?.version || '') === buildNumber) || builds[0] || null;
}

async function fetchBuildBetaDetail(buildId: string) {
  const response = await requestAppStoreConnect<any>('GET', `${ASC_API_BASE}/builds/${encodeURIComponent(buildId)}/buildBetaDetail`);
  return response?.data?.attributes || null;
}

async function submitBetaAppReview(buildId: string) {
  try {
    const response = await requestAppStoreConnect<any>('POST', `${ASC_API_BASE}/betaAppReviewSubmissions`, {
      data: {
        type: 'betaAppReviewSubmissions',
        relationships: {
          build: {
            data: {
              type: 'builds',
              id: buildId,
            },
          },
        },
      },
    });
    return response?.data || null;
  } catch (error: any) {
    const status = error?.response?.status;
    const code = String(error?.response?.data?.errors?.[0]?.code || '');
    const detail = String(error?.response?.data?.errors?.[0]?.detail || '');
    if (status === 409 || /already|exists|invalid state/i.test(`${code} ${detail}`)) {
      return null;
    }
    throw error;
  }
}

async function fetchBuildAppStoreVersion(buildId: string) {
  const response = await requestAppStoreConnect<any>('GET', `${ASC_API_BASE}/builds/${encodeURIComponent(buildId)}/appStoreVersion`);
  return response?.data || null;
}

async function fetchAppStoreVersionsByVersion(appId: string, appVersion: string) {
  const params = new URLSearchParams({
    'filter[versionString]': appVersion,
    'filter[platform]': 'IOS',
    limit: '10',
  });
  const response = await requestAppStoreConnect<any>('GET', `${ASC_API_BASE}/apps/${encodeURIComponent(appId)}/appStoreVersions?${params.toString()}`);
  return Array.isArray(response?.data) ? response.data : [];
}

async function fetchRecentAppStoreVersions(appId: string) {
  const params = new URLSearchParams({
    'filter[platform]': 'IOS',
    limit: '50',
  });
  const response = await requestAppStoreConnect<any>('GET', `${ASC_API_BASE}/apps/${encodeURIComponent(appId)}/appStoreVersions?${params.toString()}`);
  return Array.isArray(response?.data) ? response.data : [];
}

async function submitAppStoreReview(appStoreVersionId: string) {
  const submission = await requestAppStoreConnect<any>('POST', `${ASC_API_BASE}/reviewSubmissions`, {
    data: {
      type: 'reviewSubmissions',
      relationships: {
        app: {
          data: {
            type: 'apps',
            id: testFlightAppId(),
          },
        },
      },
    },
  });
  const reviewSubmissionId = String(submission?.data?.id || '');
  if (!reviewSubmissionId) {
    throw new Error('创建 App Store 审核提交失败');
  }
  await requestAppStoreConnect<any>('POST', `${ASC_API_BASE}/reviewSubmissionItems`, {
    data: {
      type: 'reviewSubmissionItems',
      relationships: {
        reviewSubmission: {
          data: {
            type: 'reviewSubmissions',
            id: reviewSubmissionId,
          },
        },
        appStoreVersion: {
          data: {
            type: 'appStoreVersions',
            id: appStoreVersionId,
          },
        },
      },
    },
  });
  await requestAppStoreConnect<any>('PATCH', `${ASC_API_BASE}/reviewSubmissions/${encodeURIComponent(reviewSubmissionId)}`, {
    data: {
      type: 'reviewSubmissions',
      id: reviewSubmissionId,
      attributes: {
        submitted: true,
      },
    },
  });
  return reviewSubmissionId;
}

async function cancelAppStoreReview(appStoreVersionSubmissionId: string) {
  await requestAppStoreConnect<any>('DELETE', `${ASC_API_BASE}/appStoreVersionSubmissions/${encodeURIComponent(appStoreVersionSubmissionId)}`);
}

function appStoreVersionStateStatus(appStoreState: string) {
  switch (appStoreState) {
    case 'PREPARE_FOR_SUBMISSION':
      return { status: 'ready_for_review', message: '已准备好，可提交 App Store 审核' };
    case 'WAITING_FOR_REVIEW':
      return { status: 'waiting_for_review', message: '已提交 App Store 审核，等待审核' };
    case 'IN_REVIEW':
      return { status: 'in_review', message: 'App Store 审核中' };
    case 'PENDING_DEVELOPER_RELEASE':
      return { status: 'pending_release', message: '审核通过，等待开发者发布' };
    case 'READY_FOR_DISTRIBUTION':
      return { status: 'ready_for_distribution', message: '可供分发' };
    case 'READY_FOR_SALE':
      return { status: 'ready_for_sale', message: '已上架 App Store' };
    case 'REJECTED':
    case 'METADATA_REJECTED':
      return { status: 'rejected', message: 'App Store 审核被拒' };
    case 'DEVELOPER_REJECTED':
      return { status: 'developer_rejected', message: '开发者已取消 App Store 审核' };
    case 'DEVELOPER_ACTION_NEEDED':
      return { status: 'developer_action_needed', message: 'App Store 审核需要开发者处理' };
    case 'INVALID_BINARY':
      return { status: 'failed', message: 'App Store 构建无效' };
    case 'PENDING_AGREEMENT':
      return { status: 'pending_agreement', message: '协议待处理，需在 App Store Connect 完成协议' };
    default:
      return { status: 'unconfirmed', message: appStoreState ? `App Store 状态为 ${appStoreState}` : '无法确认 App Store 审核状态' };
  }
}

function isBlockingAppStoreReleaseState(appStoreState: string) {
  return [
    'WAITING_FOR_REVIEW',
    'IN_REVIEW',
    'PENDING_DEVELOPER_RELEASE',
    'READY_FOR_DISTRIBUTION',
    'READY_FOR_SALE',
  ].includes(String(appStoreState || '').toUpperCase());
}

function isAppStoreVersionFloorState(appStoreState: string) {
  return [
    'WAITING_FOR_REVIEW',
    'IN_REVIEW',
    'PENDING_DEVELOPER_RELEASE',
    'READY_FOR_DISTRIBUTION',
    'READY_FOR_SALE',
  ].includes(String(appStoreState || '').toUpperCase());
}

function appVersionFromReleaseBranch(branch: string) {
  const match = normalizeBranchName(branch).match(/^release\/(\d+(?:\.\d+){2,})$/);
  return match?.[1] || '';
}

function parseVersionParts(version: string) {
  return String(version || '')
    .trim()
    .split('.')
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function compareAppVersions(a: string, b: string) {
  const av = parseVersionParts(a);
  const bv = parseVersionParts(b);
  const len = Math.max(av.length, bv.length);
  for (let index = 0; index < len; index += 1) {
    const diff = (av[index] || 0) - (bv[index] || 0);
    if (diff !== 0) return diff;
  }
  return String(a || '').localeCompare(String(b || ''));
}

async function checkAppStoreReleaseBlocker(branch: string) {
  const normalizedBranch = normalizeBranchName(branch);
  const appVersion = appVersionFromReleaseBranch(normalizedBranch);
  if (!appVersion) {
    return {
      blocked: false,
      branch: normalizedBranch,
      appVersion,
      appStoreState: '',
      status: '',
      message: '当前分支不是 release/x.x.x 格式，跳过苹果商店版本状态检查',
    };
  }

  const appId = testFlightAppId();
  if (!appId) {
    throw new JenkinsReleaseError('未配置 APP_STORE_CONNECT_APP_ID，无法检查苹果商店版本状态', 400);
  }

  const versions = await fetchAppStoreVersionsByVersion(appId, appVersion);
  const exactVersion = versions.find((item: any) => String(item?.attributes?.versionString || '') === appVersion) || versions[0] || null;
  const appStoreState = String(exactVersion?.attributes?.appStoreState || exactVersion?.attributes?.appVersionState || '');
  const stateStatus = appStoreVersionStateStatus(appStoreState);
  const blocked = Boolean(exactVersion?.id) && isBlockingAppStoreReleaseState(appStoreState);
  const recentVersions = await fetchRecentAppStoreVersions(appId);
  const higherVersion = recentVersions
    .map((item: any) => {
      const versionString = String(item?.attributes?.versionString || '');
      const state = String(item?.attributes?.appStoreState || item?.attributes?.appVersionState || '');
      return {
        id: item?.id || '',
        versionString,
        state,
        stateStatus: appStoreVersionStateStatus(state),
      };
    })
    .filter((item: any) => item.versionString && isAppStoreVersionFloorState(item.state) && compareAppVersions(item.versionString, appVersion) > 0)
    .sort((a: any, b: any) => compareAppVersions(b.versionString, a.versionString))[0];
  if (higherVersion) {
    return {
      blocked: true,
      branch: normalizedBranch,
      appVersion,
      appStoreVersionId: higherVersion.id,
      appStoreState: higherVersion.state,
      status: higherVersion.stateStatus.status,
      latestAppStoreVersion: higherVersion.versionString,
      message: `当前发布版本 ${appVersion} 低于商店版本 ${higherVersion.versionString}，不能发布`,
    };
  }

  if (blocked) {
    return {
      blocked: true,
      branch: normalizedBranch,
      appVersion,
      appStoreVersionId: exactVersion?.id || '',
      appStoreState,
      status: stateStatus.status,
      message: `当前发布版本 ${appVersion} 为「${stateStatus.message}」，不能重复发布`,
    };
  }

  return {
    blocked: false,
    branch: normalizedBranch,
    appVersion,
    appStoreVersionId: exactVersion?.id || '',
    appStoreState,
    status: stateStatus.status,
    message: blocked
      ? `当前发布版本 ${appVersion} 为「${stateStatus.message}」，不能重复发布`
      : (exactVersion?.id ? stateStatus.message : `未找到 ${appVersion} 对应的 App Store 版本，可继续发布`),
  };
}

function testFlightExternalStateStatus(externalBuildState: string) {
  switch (externalBuildState) {
    case 'IN_BETA_TESTING':
      return { status: 'distributed', message: '已自动分发到 TestFlight 测试组' };
    case 'READY_FOR_BETA_SUBMISSION':
      return { status: 'ready_for_submission', message: '已加入外部测试组，等待提交 Beta App Review' };
    case 'IN_BETA_REVIEW':
      return { status: 'in_beta_review', message: 'Beta App Review 审核中' };
    case 'BETA_REJECTED':
      return { status: 'failed', message: 'Beta App Review 被拒绝' };
    case 'EXPIRED':
      return { status: 'failed', message: 'TestFlight 构建已过期' };
    case 'PROCESSING':
      return { status: 'waiting_processing', message: 'App Store Connect 正在处理 TestFlight 构建' };
    case 'PROCESSING_EXCEPTION':
      return { status: 'failed', message: 'App Store Connect 构建处理异常' };
    case 'MISSING_EXPORT_COMPLIANCE':
      return { status: 'unconfirmed', message: '缺少出口合规信息，无法分发外部测试' };
    default:
      return { status: 'unconfirmed', message: externalBuildState ? `外部测试状态为 ${externalBuildState}` : '无法确认外部测试状态' };
  }
}

async function resolveTestFlightGroups(appId: string, groupTokens: string[]) {
  const groups: any[] = [];
  const cachedGroupsResponse = await requestAppStoreConnect<any>('GET', `${ASC_API_BASE}/betaGroups?${new URLSearchParams({
    'filter[app]': appId,
    limit: '200',
  }).toString()}`);
  const allGroups = Array.isArray(cachedGroupsResponse?.data) ? cachedGroupsResponse.data : [];
  for (const token of groupTokens) {
    if (/^id:/i.test(token)) {
      groups.push({ id: token.replace(/^id:/i, '').trim(), attributes: { name: token } });
      continue;
    }
    const matched = allGroups.find((group: any) => String(group?.id || '') === token || String(group?.attributes?.name || '') === token);
    if (!matched) {
      throw new Error(`未找到 TestFlight 测试组：${token}`);
    }
    groups.push(matched);
  }
  return groups;
}

async function upsertBetaBuildLocalization(buildId: string, whatsNew: string) {
  const normalizedWhatsNew = normalizeTestFlightWhatsNew(whatsNew);
  if (!normalizedWhatsNew) return null;
  const locale = String(getRuntimeEnv('TESTFLIGHT_WHATS_NEW_LOCALE') || 'zh-Hans').trim() || 'zh-Hans';
  const listResponse = await requestAppStoreConnect<any>('GET', `${ASC_API_BASE}/builds/${encodeURIComponent(buildId)}/betaBuildLocalizations?${new URLSearchParams({
    limit: '200',
  }).toString()}`);
  const localizations = Array.isArray(listResponse?.data) ? listResponse.data : [];
  const existing = localizations.find((item: any) => String(item?.attributes?.locale || '') === locale) || null;
  if (existing?.id) {
    return requestAppStoreConnect<any>('PATCH', `${ASC_API_BASE}/betaBuildLocalizations/${encodeURIComponent(existing.id)}`, {
      data: {
        type: 'betaBuildLocalizations',
        id: existing.id,
        attributes: {
          whatsNew: normalizedWhatsNew,
        },
      },
    });
  }
  return requestAppStoreConnect<any>('POST', `${ASC_API_BASE}/betaBuildLocalizations`, {
    data: {
      type: 'betaBuildLocalizations',
      attributes: {
        locale,
        whatsNew: normalizedWhatsNew,
      },
      relationships: {
        build: {
          data: {
            type: 'builds',
            id: buildId,
          },
        },
      },
    },
  });
}

async function upsertAppStoreVersionReleaseNotes(appStoreVersionId: string, releaseNotes: string) {
  const normalizedReleaseNotes = normalizeTestFlightWhatsNew(releaseNotes);
  if (!appStoreVersionId || !normalizedReleaseNotes) return null;
  const locale = String(getRuntimeEnv('APPSTORE_RELEASE_NOTES_LOCALE') || getRuntimeEnv('TESTFLIGHT_WHATS_NEW_LOCALE') || 'zh-Hans').trim() || 'zh-Hans';
  const listResponse = await requestAppStoreConnect<any>('GET', `${ASC_API_BASE}/appStoreVersions/${encodeURIComponent(appStoreVersionId)}/appStoreVersionLocalizations?${new URLSearchParams({
    limit: '200',
  }).toString()}`);
  const localizations = Array.isArray(listResponse?.data) ? listResponse.data : [];
  const existing = localizations.find((item: any) => String(item?.attributes?.locale || '') === locale) || null;
  if (existing?.id) {
    return requestAppStoreConnect<any>('PATCH', `${ASC_API_BASE}/appStoreVersionLocalizations/${encodeURIComponent(existing.id)}`, {
      data: {
        type: 'appStoreVersionLocalizations',
        id: existing.id,
        attributes: {
          whatsNew: normalizedReleaseNotes,
        },
      },
    });
  }
  return requestAppStoreConnect<any>('POST', `${ASC_API_BASE}/appStoreVersionLocalizations`, {
    data: {
      type: 'appStoreVersionLocalizations',
      attributes: {
        locale,
        whatsNew: normalizedReleaseNotes,
      },
      relationships: {
        appStoreVersion: {
          data: {
            type: 'appStoreVersions',
            id: appStoreVersionId,
          },
        },
      },
    },
  });
}

async function setAppStoreVersionAutomaticRelease(appStoreVersionId: string) {
  if (!appStoreVersionId) return null;
  return requestAppStoreConnect<any>('PATCH', `${ASC_API_BASE}/appStoreVersions/${encodeURIComponent(appStoreVersionId)}`, {
    data: {
      type: 'appStoreVersions',
      id: appStoreVersionId,
      attributes: {
        releaseType: 'AFTER_APPROVAL',
      },
    },
  });
}

async function addBuildToBetaGroup(buildId: string, groupId: string) {
  try {
    await requestAppStoreConnect<any>('POST', `${ASC_API_BASE}/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`, {
      data: [{
        type: 'builds',
        id: buildId,
      }],
    });
  } catch (error: any) {
    const status = error?.response?.status;
    const code = error?.response?.data?.errors?.[0]?.code;
    if (status === 409 || code === 'ENTITY_ERROR.RELATIONSHIP.INVALID') {
      return;
    }
    throw error;
  }
}

function appStoreConnectErrorMessage(error: any, fallback: string) {
  const appleError = error?.response?.data?.errors?.[0];
  return appleError?.detail || appleError?.title || error?.message || fallback;
}

function scheduleTestFlightDistribution(build: any, options: { attempt?: number } = {}) {
  const buildNumber = Number(build?.number);
  if (!Number.isFinite(buildNumber) || buildNumber <= 0) return;
  if (normalizeDeployTarget(build?.publishChannel) !== 'TestFlight') return;
  if (build?.building || String(build?.result || '').toUpperCase() !== 'SUCCESS') return;

  const cacheKey = String(buildNumber);
  const saved = getSavedTestFlightDistribution(buildNumber);
  if (saved?.status === 'distributed' && saved?.externalBuildState === 'IN_BETA_TESTING') return;
  if (TESTFLIGHT_DISTRIBUTION_RUNNING.has(cacheKey)) return;

  const appId = testFlightAppId();
  const groupTokens = testFlightGroupTokens();
  const appVersion = String(build?.appVersion || '').trim();
  const channelBuildNumber = String(build?.buildNumber || '').trim();
  const whatsNew = normalizeTestFlightWhatsNew(build?.testFlightWhatsNew) || testFlightDefaultWhatsNew();
  if (!appId || groupTokens.length === 0) {
    saveTestFlightDistribution(buildNumber, {
      status: 'skipped',
      appVersion,
      buildNumber: channelBuildNumber,
      message: !appId ? '未配置 APP_STORE_CONNECT_APP_ID' : '未配置 APP_STORE_CONNECT_TESTFLIGHT_GROUPS',
    });
    return;
  }
  if (!appVersion || !channelBuildNumber) {
    saveTestFlightDistribution(buildNumber, {
      status: 'skipped',
      appVersion,
      buildNumber: channelBuildNumber,
      message: '缺少 App 版本或渠道构建号，无法匹配 App Store Connect 构建',
    });
    return;
  }

  TESTFLIGHT_DISTRIBUTION_RUNNING.add(cacheKey);
  if (saved?.status !== 'waiting_processing') {
    saveTestFlightDistribution(buildNumber, {
      status: 'waiting_processing',
      appVersion,
      buildNumber: channelBuildNumber,
      message: '等待 App Store Connect 构建处理完成',
    });
  }

  void (async () => {
    const attempt = options.attempt || 0;
    try {
      const appStoreBuild = await findAppStoreBuild(appId, appVersion, channelBuildNumber);
      if (!appStoreBuild?.id) {
        saveTestFlightDistribution(buildNumber, {
          status: 'uploaded',
          appVersion,
          buildNumber: channelBuildNumber,
          message: `Jenkins 已成功上传到 App Store Connect。平台暂时无法通过 App Store Connect API 确认处理/测试状态，请确认 APP_STORE_CONNECT_APP_ID 与 API Key 属于正式包所在团队`,
        });
        return;
      }
      const processingState = String(appStoreBuild?.attributes?.processingState || '');
      if (processingState && processingState !== 'VALID') {
        if (attempt + 1 >= TESTFLIGHT_DISTRIBUTION_MAX_ATTEMPTS || /FAILED|INVALID/i.test(processingState)) {
          saveTestFlightDistribution(buildNumber, {
            status: 'failed',
            appVersion,
            buildNumber: channelBuildNumber,
            appStoreBuildId: appStoreBuild.id,
            processingState,
            message: `App Store Connect 构建状态为 ${processingState}`,
          });
          return;
        }
        saveTestFlightDistribution(buildNumber, {
          status: 'waiting_processing',
          appVersion,
          buildNumber: channelBuildNumber,
          appStoreBuildId: appStoreBuild.id,
          processingState,
          message: `App Store Connect 构建状态为 ${processingState}，等待处理完成`,
        });
        setTimeout(() => scheduleTestFlightDistribution(build, { attempt: attempt + 1 }), TESTFLIGHT_DISTRIBUTION_POLL_INTERVAL_MS);
        return;
      }

      await upsertBetaBuildLocalization(appStoreBuild.id, whatsNew);
      const groups = await resolveTestFlightGroups(appId, groupTokens);
      const distributableGroups = groups.filter((group) => !group.attributes?.isInternalGroup);
      for (const group of distributableGroups) {
        await addBuildToBetaGroup(appStoreBuild.id, group.id);
      }
      let betaDetail = await fetchBuildBetaDetail(appStoreBuild.id);
      let internalBuildState = String(betaDetail?.internalBuildState || '');
      let externalBuildState = String(betaDetail?.externalBuildState || '');
      let betaAppReviewSubmissionId = '';
      if (distributableGroups.length > 0 && externalBuildState === 'READY_FOR_BETA_SUBMISSION') {
        const submission = await submitBetaAppReview(appStoreBuild.id);
        betaAppReviewSubmissionId = String(submission?.id || '');
        betaDetail = await fetchBuildBetaDetail(appStoreBuild.id);
        internalBuildState = String(betaDetail?.internalBuildState || internalBuildState);
        externalBuildState = String(betaDetail?.externalBuildState || externalBuildState);
      }
      const externalStatus = distributableGroups.length > 0
        ? testFlightExternalStateStatus(externalBuildState)
        : { status: 'distributed', message: 'App Store Connect 构建已处理完成，内部测试组无需手动分发' };
      saveTestFlightDistribution(buildNumber, {
        status: externalStatus.status,
        appVersion,
        buildNumber: channelBuildNumber,
        appStoreBuildId: appStoreBuild.id,
        processingState,
        internalBuildState,
        externalBuildState,
        betaAppReviewSubmissionId,
        groups: distributableGroups.map((group) => ({
          id: group.id,
          name: group.attributes?.name || group.id,
        })),
        whatsNew,
        message: externalStatus.message,
      });
    } catch (error: any) {
      if (attempt + 1 < TESTFLIGHT_DISTRIBUTION_MAX_ATTEMPTS && !error?.response) {
        setTimeout(() => scheduleTestFlightDistribution(build, { attempt: attempt + 1 }), TESTFLIGHT_DISTRIBUTION_POLL_INTERVAL_MS);
        return;
      }
      saveTestFlightDistribution(buildNumber, {
        status: 'failed',
        appVersion,
        buildNumber: channelBuildNumber,
        message: appStoreConnectErrorMessage(error, 'TestFlight 自动分发失败'),
      });
      logger.warn('TestFlight 自动分发失败', { buildNumber, error: error?.message });
    } finally {
      TESTFLIGHT_DISTRIBUTION_RUNNING.delete(cacheKey);
    }
  })();
}

function scheduleAppStoreRelease(build: any, options: { attempt?: number } = {}) {
  const buildNumber = Number(build?.number);
  if (!Number.isFinite(buildNumber) || buildNumber <= 0) return;
  if (normalizeDeployTarget(build?.publishChannel) !== 'AppStore') return;
  if (build?.building || String(build?.result || '').toUpperCase() !== 'SUCCESS') return;

  const cacheKey = String(buildNumber);
  const saved = getSavedAppStoreRelease(buildNumber);
  if (saved?.status === 'ready_for_sale' && saved?.reviewApprovalNotifiedAt) return;
  if (APPSTORE_RELEASE_RUNNING.has(cacheKey)) return;

  const appId = testFlightAppId();
  const appVersion = String(build?.appVersion || '').trim();
  const channelBuildNumber = String(build?.buildNumber || '').trim();
  const branchName = normalizeBranchName(String(build?.branchName || ''));
  const releaseNotes = normalizeTestFlightWhatsNew(build?.testFlightWhatsNew);
  if (!appId) {
    saveAppStoreRelease(buildNumber, {
      status: 'skipped',
      appVersion,
      buildNumber: channelBuildNumber,
      branchName,
      message: '未配置 APP_STORE_CONNECT_APP_ID',
    });
    return;
  }
  if (!appVersion || !channelBuildNumber) {
    saveAppStoreRelease(buildNumber, {
      status: 'skipped',
      appVersion,
      buildNumber: channelBuildNumber,
      branchName,
      message: '缺少 App 版本或渠道构建号，无法匹配 App Store Connect 构建',
    });
    return;
  }

  APPSTORE_RELEASE_RUNNING.add(cacheKey);
  if (!['waiting_for_review', 'in_review', 'pending_release'].includes(String(saved?.status || '')) && saved?.status !== 'waiting_processing') {
    saveAppStoreRelease(buildNumber, {
      status: 'waiting_processing',
      appVersion,
      buildNumber: channelBuildNumber,
      branchName,
      message: '等待 App Store Connect 构建处理完成',
    });
  }

  void (async () => {
    const attempt = options.attempt || 0;
    try {
      const appStoreBuild = await findAppStoreBuild(appId, appVersion, channelBuildNumber);
      if (!appStoreBuild?.id) {
        saveAppStoreRelease(buildNumber, {
          status: 'uploaded',
          appVersion,
          buildNumber: channelBuildNumber,
          branchName,
          message: 'Jenkins 已成功上传到 App Store Connect，暂未匹配到正式包构建',
        });
        return;
      }
      const processingState = String(appStoreBuild?.attributes?.processingState || '');
      if (processingState && processingState !== 'VALID') {
        saveAppStoreRelease(buildNumber, {
          status: /FAILED|INVALID/i.test(processingState) ? 'failed' : 'waiting_processing',
          appVersion,
          buildNumber: channelBuildNumber,
          branchName,
          appStoreBuildId: appStoreBuild.id,
          processingState,
          message: `App Store Connect 构建状态为 ${processingState}`,
          failureReason: /FAILED|INVALID/i.test(processingState) ? `App Store Connect 构建状态为 ${processingState}` : '',
        });
        if (attempt + 1 < TESTFLIGHT_DISTRIBUTION_MAX_ATTEMPTS && !/FAILED|INVALID/i.test(processingState)) {
          setTimeout(() => scheduleAppStoreRelease(build, { attempt: attempt + 1 }), TESTFLIGHT_DISTRIBUTION_POLL_INTERVAL_MS);
        }
        return;
      }

      const appStoreVersion = await fetchBuildAppStoreVersion(appStoreBuild.id);
      const appStoreVersionId = String(appStoreVersion?.id || '');
      const appStoreState = String(appStoreVersion?.attributes?.appStoreState || appStoreVersion?.attributes?.appVersionState || '');
      const appStoreReleaseType = String(appStoreVersion?.attributes?.releaseType || '');
      if (appStoreVersionId && appStoreState === 'PREPARE_FOR_SUBMISSION' && !saved?.reviewSubmissionId) {
        await upsertAppStoreVersionReleaseNotes(appStoreVersionId, releaseNotes);
        await setAppStoreVersionAutomaticRelease(appStoreVersionId);
        const reviewSubmissionId = await submitAppStoreReview(appStoreVersionId);
        const latestVersion = await fetchBuildAppStoreVersion(appStoreBuild.id);
        const latestState = String(latestVersion?.attributes?.appStoreState || latestVersion?.attributes?.appVersionState || appStoreState);
        const latestStatus = appStoreVersionStateStatus(latestState);
        saveAppStoreRelease(buildNumber, {
          status: latestStatus.status,
          appVersion,
          buildNumber: channelBuildNumber,
          branchName,
          appStoreBuildId: appStoreBuild.id,
          appStoreVersionId,
          reviewSubmissionId,
          processingState,
          appStoreState: latestState,
          releaseNotes,
          releaseType: 'AFTER_APPROVAL',
          message: latestStatus.message,
          failureReason: ['rejected', 'developer_action_needed', 'pending_agreement', 'failed'].includes(String(latestStatus.status)) ? latestStatus.message : '',
        });
        return;
      }
      const stateStatus = appStoreVersionStateStatus(appStoreState);
      saveAppStoreRelease(buildNumber, {
        status: stateStatus.status,
        appVersion,
        buildNumber: channelBuildNumber,
        branchName,
        appStoreBuildId: appStoreBuild.id,
        appStoreVersionId,
        processingState,
        appStoreState,
        releaseNotes,
        releaseType: appStoreReleaseType,
        message: stateStatus.message,
        failureReason: ['rejected', 'developer_action_needed', 'pending_agreement', 'failed'].includes(String(stateStatus.status)) ? stateStatus.message : '',
      });
    } catch (error: any) {
      saveAppStoreRelease(buildNumber, {
        status: 'failed',
        appVersion,
        buildNumber: channelBuildNumber,
        branchName,
        message: appStoreConnectErrorMessage(error, 'App Store 发布状态查询失败'),
      });
      logger.warn('App Store 发布状态查询失败', { buildNumber, error: error?.message });
    } finally {
      APPSTORE_RELEASE_RUNNING.delete(cacheKey);
    }
  })();
}

function normalizeDSYMVersion(value?: string) {
  return String(value || '').trim();
}

function isMainAppDSYMName(appName: string) {
  return ['NNIM', 'nnios', 'NN'].includes(String(appName || '').trim()) || /NNIM/i.test(appName);
}

async function saveMainAppDSYMFromXcarchive(xcarchivePath: string, appVersion: string) {
  const archivePath = String(xcarchivePath || '').trim();
  const desiredVersion = normalizeDSYMVersion(appVersion);
  if (!archivePath) {
    throw new AppError(ErrorCode.INVALID_FILE_FORMAT, '当前构建未记录 xcarchivePath，无法自动同步主包 dSYM', 400);
  }
  if (!archivePath.endsWith('.xcarchive')) {
    throw new AppError(ErrorCode.INVALID_FILE_FORMAT, '当前构建产物不是 .xcarchive，无法自动同步主包 dSYM', 400);
  }
  if (!fs.existsSync(archivePath)) {
    throw new AppError(ErrorCode.INVALID_FILE_FORMAT, `服务器本机未找到 xcarchive：${archivePath}`, 404);
  }
  if (!desiredVersion) {
    throw new AppError(ErrorCode.INVALID_FILE_FORMAT, '当前构建未解析到 APP 版本，无法关联 dSYM', 400);
  }

  const archiveDSYMPath = await fileHandler.identifyAndExtractDSYM(archivePath);
  const uuid = await fileHandler.extractUUID(archiveDSYMPath);
  const appInfo = await fileHandler.extractAppInfo(archiveDSYMPath);
  const appName = isMainAppDSYMName(appInfo.appName) ? 'NNIM' : appInfo.appName;
  const version = desiredVersion || appInfo.version;
  const existingByUuid = await storage.findByUUID(uuid);
  if (existingByUuid) {
    const updates: { version?: string; notes?: string } = {};
    if (existingByUuid.version !== version) updates.version = version;
    const nextNotes = existingByUuid.notes || `自动同步自 AppStore 构建 archive`;
    if (nextNotes !== existingByUuid.notes) updates.notes = nextNotes;
    if (Object.keys(updates).length > 0) {
      await storage.updateDSYMInfo(uuid, updates);
    }
    return {
      ...(await storage.findByUUID(uuid))!,
      skipped: true,
      message: `主包 dSYM 已存在，已确认版本 ${version}`,
    };
  }

  const sameVersionDsyms = await storage.findByAppNameAndVersion(appName, version);
  for (const existing of sameVersionDsyms) {
    logger.info('覆盖 AppStore 主包同版本 dSYM，删除旧记录', {
      appName: existing.appName,
      version: existing.version,
      uuid: existing.uuid,
    });
    await storage.deleteDSYM(existing.uuid);
  }

  const uploadDir = process.env.UPLOAD_DIR || '../../nn-ios-platform-data/uploads';
  const tempDir = path.join(uploadDir, `appstore_dsym_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  let dsymPath = '';
  let permanentPath = '';
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    dsymPath = path.join(tempDir, path.basename(archiveDSYMPath));
    fs.cpSync(archiveDSYMPath, dsymPath, { recursive: true });
    const permanent = await fileHandler.moveToPermanentStorage(dsymPath, uuid);
    permanentPath = permanent;
    const fileSize = fileHandler.getFileSize(permanent);
    const saved = await storage.saveDSYMInfo({
      uuid,
      appName,
      version,
      buildNumber: appInfo.buildNumber,
      architecture: appInfo.architecture,
      filePath: permanent,
      fileSize,
      notes: '自动同步自 AppStore 构建 archive',
    });
    symbolicationCache.clear();
    logger.info('AppStore 主包 dSYM 已自动同步', { uuid, appName, version, xcarchivePath: archivePath });
    return {
      ...saved,
      skipped: false,
      message: `主包 dSYM 已同步：${saved.appName}@${saved.version}`,
    };
  } finally {
    await fileHandler.cleanupUploadArtifacts(tempDir, dsymPath, permanentPath);
  }
}

function pickDSYMSyncComponentDependencies(dependencies: ThirdSdkDependency[]) {
  const targetNames = new Set(['leigod_im_cross_sdk', 'NNRtc']);
  return dependencies
    .filter((item) => targetNames.has(item.name))
    .map((item) => ({
      name: item.name,
      version: String(item.version || '').trim(),
    }))
    .filter((item) => item.version && item.version !== '-');
}

async function linkExistingComponentDSYMsToAppVersion(dependencies: ThirdSdkDependency[], appVersion: string) {
  const components = [];
  for (const dependency of pickDSYMSyncComponentDependencies(dependencies)) {
    const dsyms = await storage.findByAppNameAndVersion(dependency.name, dependency.version);
    if (dsyms.length === 0) {
      components.push({
        ...dependency,
        status: 'missing',
        message: `dSYM 管理中未找到 ${dependency.name}@${dependency.version}`,
      });
      continue;
    }
    await podService.associateComponentDSYMWithAppVersion(dependency.name, dependency.version, appVersion);
    components.push({
      ...dependency,
      status: 'linked',
      uuids: dsyms.map((dsym) => dsym.uuid),
      message: `已关联 ${dependency.name}@${dependency.version} 到主包 ${appVersion}`,
    });
  }
  return components;
}

async function syncAppStoreBuildDsyms(buildNumber: number, options: { force?: boolean } = {}) {
  const cacheKey = String(buildNumber);
  const existing = getSavedBuildDsymSync(buildNumber);
  if (!options.force && existing && ['success', 'partial', 'running'].includes(String(existing.status || ''))) {
    return existing;
  }
  if (BUILD_DSYM_SYNC_RUNNING.has(cacheKey)) {
    return saveBuildDsymSync(buildNumber, {
      ...(existing || {}),
      buildNumber,
      status: 'running',
      message: 'dSYM 自动同步正在进行中',
    });
  }

  BUILD_DSYM_SYNC_RUNNING.add(cacheKey);
  saveBuildDsymSync(buildNumber, {
    ...(existing || {}),
    buildNumber,
    status: 'running',
    message: '正在同步 AppStore 主包 dSYM，并关联组件库 dSYM',
  });

  try {
    const jobPath = encodeJobPath(DEFAULT_JOB_NAME);
    const [buildResponse, logResponse] = await Promise.all([
      fetchJenkinsJobJson(`${jobPath}/${buildNumber}`, 'number,result,building,description,url'),
      axios.get(`${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/consoleText`, {
        timeout: 30000,
        responseType: 'text',
        ...buildAuthConfig(),
      }),
    ]);
    const build = buildResponse.data || {};
    const log = String(logResponse.data || '');
    const consoleMetadata = parseConsoleMetadata(log);
    const descriptionMetadata = parseBuildDescription(build.description);
    const publishChannel = consoleMetadata.publishChannel || normalizeDeployTarget(descriptionMetadata.publishChannel);
    if (normalizeDeployTarget(publishChannel) !== 'AppStore') {
      throw new Error('当前构建不是苹果商店包，无需同步 AppStore dSYM');
    }
    if (build.building || String(build.result || '').toUpperCase() !== 'SUCCESS') {
      throw new Error('当前 AppStore 构建尚未成功完成，暂不同步 dSYM');
    }

    const buildParameters = await fetchBuildParameters(jobPath, buildNumber);
    const checkoutRevision = parseCheckoutRevision(log);
    const thirdSdk = await fetchThirdSdkDependencies(buildParameters.branchName || 'develop', checkoutRevision);
    const appVersion = consoleMetadata.appVersion;
    const main = await saveMainAppDSYMFromXcarchive(consoleMetadata.xcarchivePath, appVersion);
    const components = await linkExistingComponentDSYMsToAppVersion(thirdSdk.dependencies, appVersion);
    const missing = components.filter((item) => item.status === 'missing');
    const status = missing.length > 0 ? 'partial' : 'success';
    return saveBuildDsymSync(buildNumber, {
      buildNumber,
      status,
      message: missing.length > 0
        ? `主包 dSYM 已同步，${missing.length} 个组件 dSYM 未在 dSYM 管理中找到`
        : '主包与组件库 dSYM 已同步关联',
      appVersion,
      publishChannel,
      xcarchivePath: consoleMetadata.xcarchivePath,
      main,
      components,
      thirdSdkBranch: thirdSdk.branch,
      thirdSdkRevision: thirdSdk.revision,
      thirdSdkError: thirdSdk.error,
    });
  } catch (error: any) {
    logger.error('AppStore dSYM 自动同步失败', { buildNumber, error: error.message });
    return saveBuildDsymSync(buildNumber, {
      buildNumber,
      status: 'failed',
      message: error.message || 'AppStore dSYM 自动同步失败',
    });
  } finally {
    BUILD_DSYM_SYNC_RUNNING.delete(cacheKey);
  }
}

function scheduleAppStoreBuildDsymSync(build: any) {
  const buildNumber = Number(build?.number);
  if (!Number.isFinite(buildNumber) || buildNumber <= 0) return;
  if (normalizeDeployTarget(build?.publishChannel) !== 'AppStore') return;
  if (build?.building || String(build?.result || '').toUpperCase() !== 'SUCCESS') return;
  const saved = getSavedBuildDsymSync(buildNumber);
  if (saved && ['success', 'partial', 'running'].includes(String(saved.status || ''))) return;
  void syncAppStoreBuildDsyms(buildNumber).catch((error) => {
    logger.error('后台触发 AppStore dSYM 自动同步失败', { buildNumber, error: error.message });
  });
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
    businessFlowReportUrl: artifactUrl(summary?.artifacts?.businessFlowReport),
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

function parseQualityTime(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value).trim();
  const parsed = Date.parse(text.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseQualityArtifactFilenameTime(value?: string) {
  const match = String(value || '').match(/(20\d{2})[-_](\d{2})[-_](\d{2})[-_](\d{2})(\d{2})(\d{2})/);
  if (!match) return 0;
  const parsed = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sanitizeQualityCrashReports(summary: any) {
  if (!summary?.exceptionAnalysis?.crashReports) return summary;
  const startedAtMs = parseQualityTime(summary.startedAt || summary.qualityStartedAt || summary.started_at);
  if (!startedAtMs) return summary;
  const minTimeMs = startedAtMs - 60 * 1000;
  const maxTimeMs = Date.now() + 10 * 60 * 1000;
  const inWindow = (item: any) => {
    const timestampMs = parseQualityTime(item?.timestamp) || parseQualityArtifactFilenameTime(item?.file || item);
    return !timestampMs || (timestampMs >= minTimeMs && timestampMs <= maxTimeMs);
  };
  const crashReports = summary.exceptionAnalysis.crashReports;
  const samples = Array.isArray(crashReports.samples) ? crashReports.samples.filter(inWindow) : [];
  const sampleFiles = new Set(samples.map((item: any) => String(item?.file || '')).filter(Boolean));
  const files = Array.isArray(crashReports.files)
    ? crashReports.files.filter((file: any) => sampleFiles.has(String(file)) || inWindow(file))
    : [];
  const nextSummary = {
    ...summary,
    exceptionAnalysis: {
      ...summary.exceptionAnalysis,
      crashReports: {
        ...crashReports,
        count: files.length,
        files,
        samples,
      },
    },
  };
  const crashCount = Number(nextSummary.exceptionAnalysis.crashCount || 0);
  const removedAllCrashReports = Number(crashReports.count || crashReports.files?.length || crashReports.samples?.length || 0) > 0 && files.length === 0 && samples.length === 0;
  if (removedAllCrashReports && crashCount <= Number(crashReports.count || 0)) {
    nextSummary.exceptionAnalysis.crashCount = 0;
  } else if (files.length > 0) {
    nextSummary.exceptionAnalysis.crashCount = Math.max(crashCount, files.length);
  }
  if (
    String(nextSummary.exceptionAnalysis.severity || '').toLowerCase() === 'failed' &&
    Number(nextSummary.exceptionAnalysis.crashCount || 0) === 0 &&
    Number(nextSummary.exceptionAnalysis.exceptionCount || 0) === 0 &&
    Number(nextSummary.exceptionAnalysis.watchdogCount || 0) === 0 &&
    Number(nextSummary.exceptionAnalysis.memoryIssueCount || 0) === 0
  ) {
    nextSummary.exceptionAnalysis.severity = Number(nextSummary.exceptionAnalysis.errorCount || 0) > 0 ? 'warning' : 'passed';
  }
  return nextSummary;
}

function normalizeQualitySummaryStatus(summary: any) {
  if (!summary || typeof summary !== 'object') return summary;
  summary = sanitizeQualityCrashReports(summary);
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
  const completedMonkeyButOriginalFailure = isMonkeySuite &&
    ['failed', 'failure'].includes(originalStatus) &&
    ['passed', 'success'].includes(monkeyStatus) &&
    !['failed', 'failure'].includes(exceptionSeverity) &&
    performanceSeverity !== 'failed' &&
    severeActionCount === 0 &&
    severeFrameHitchCount === 0 &&
    /完成|通过|completed|passed/i.test(originalMessage);
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
  } else if (completedMonkeyButOriginalFailure) {
    nextSummary.status = performanceSeverity === 'warning' ? 'unstable' : 'passed';
    nextSummary.message = performanceSeverity === 'warning'
      ? (performanceIssues.find((item: any) => item?.message)?.message || '质检完成，存在基础性能风险')
      : (summary.message || '质检完成');
  } else if (['passed', 'success'].includes(String(nextSummary.status || '').toLowerCase()) && performanceSeverity === 'warning') {
    nextSummary.status = 'unstable';
    const issueMessage = performanceIssues.find((item: any) => item?.message)?.message;
    nextSummary.message = issueMessage || summary.message || '质检完成，存在性能风险';
  }
  if (isMonkeySuite && nextSummary.performanceAnalysis) {
    const { stutter, frameStutter, stackAnalysis, ...monkeyPerformance } = nextSummary.performanceAnalysis;
    nextSummary.performanceAnalysis = {
      ...monkeyPerformance,
      actionLatency: stutter ? { ...stutter, method: 'monkey_action_latency' } : undefined,
    };
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

function resolveSourceBuildArtifactPath(value?: string) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text) || text.startsWith('file://') || path.isAbsolute(text)) return text;
  if (/\.ipa(?:$|[?#])/i.test(text)) {
    return path.join(localJenkinsWorkspaceDir(DEFAULT_JOB_NAME), text);
  }
  return text;
}

function parseConsoleMetadata(consoleText: string) {
  const plainConsoleText = consoleText.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  const appVersion =
    plainConsoleText.match(/ASC_VERSION\s*=\s*([0-9]+(?:\.[0-9]+)+)/)?.[1] ||
    plainConsoleText.match(/APP版本信息[:：]?[\s\S]{0,160}(?:^|\n)\s*版本号[:：]\s*([0-9]+(?:\.[0-9]+)+)/m)?.[1] ||
    plainConsoleText.match(/(?:^|\n)\s*显示版本[:：]\s*([0-9]+(?:\.[0-9]+)+)/m)?.[1] ||
    plainConsoleText.match(/(?:^|\n)\s*版本号[:：]\s*([0-9]+(?:\.[0-9]+)+)/m)?.[1] ||
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
  const installPackageUrl = resolveSourceBuildArtifactPath(
    plainConsoleText.match(/IPA\s*构建成功[:：]\s*(\/[^\r\n]+?\.ipa)\b/i)?.[1] ||
    plainConsoleText.match(/Successfully exported and signed the ipa file:\s*\r?\n\s*(\/[^\r\n]+?\.ipa)\b/i)?.[1] ||
    plainConsoleText.match(/发现IPA文件[:：]\s*([^\r\n]+?\.ipa)\b/i)?.[1] ||
    plainConsoleText.match(/IPA文件[:：]\s*([^\r\n]+?\.ipa)\b/i)?.[1] ||
    ''
  );
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
    consoleText.match(/最终源码Commit[:：]\s*([0-9a-f]{7,40})/i)?.[1] ||
    consoleText.match(/"source_synced_commit"\s*:\s*"([0-9a-f]{7,40})"/i)?.[1] ||
    consoleText.match(/"source_remote_commit"\s*:\s*"([0-9a-f]{7,40})"/i)?.[1] ||
    consoleText.match(/Checking out Revision\s+([0-9a-f]{7,40})/i)?.[1] ||
    consoleText.match(/git checkout -f\s+([0-9a-f]{7,40})/i)?.[1] ||
    consoleText.match(/git rev-list --no-walk\s+([0-9a-f]{7,40})/i)?.[1] ||
    ''
  );
}

function formatBytes(bytes?: number) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 100 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function normalizeLocalArtifactPath(value?: string) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('file://')) {
    try {
      return decodeURI(new URL(text).pathname);
    } catch {
      return text.replace(/^file:\/\//i, '');
    }
  }
  if (/^https?:\/\//i.test(text)) return '';
  if (text.startsWith('smb://')) return '';
  return text;
}

function packageSizeEntryLabel(type: string, name: string) {
  if (name) return name;
  const labels: Record<string, string> = {
    executable: '主可执行文件',
    framework: 'Frameworks',
    dylib: '动态库',
    plugin: 'PlugIns',
    asset: 'Assets.car',
    bundle: 'Bundle 资源',
    resource: '资源文件',
    swiftSupport: 'SwiftSupport',
    symbol: '符号文件',
    other: '其他',
  };
  return labels[type] || '其他';
}

function classifyIpaEntry(entryName: string) {
  const normalized = entryName.replace(/\\/g, '/');
  const appMatch = normalized.match(/^Payload\/[^/]+\.app\/(.+)$/);
  if (!appMatch) {
    if (normalized.startsWith('SwiftSupport/')) {
      return { key: 'swiftSupport:SwiftSupport', type: 'swiftSupport', name: 'SwiftSupport', path: 'SwiftSupport' };
    }
    if (/\.dSYM\//.test(normalized) || normalized.startsWith('Symbols/')) {
      return { key: 'symbol:Symbols', type: 'symbol', name: 'Symbols', path: 'Symbols' };
    }
    return { key: 'other:IPA 其他文件', type: 'other', name: 'IPA 其他文件', path: normalized.split('/')[0] || normalized };
  }

  const appRelativePath = appMatch[1];
  const framework = appRelativePath.match(/^Frameworks\/([^/]+\.framework)\//);
  if (framework) {
    return { key: `framework:${framework[1]}`, type: 'framework', name: framework[1], path: `Frameworks/${framework[1]}` };
  }
  const dylib = appRelativePath.match(/^Frameworks\/([^/]+\.dylib)$/) || appRelativePath.match(/^([^/]+\.dylib)$/);
  if (dylib) {
    return { key: `dylib:${dylib[1]}`, type: 'dylib', name: dylib[1], path: appRelativePath };
  }
  const plugin = appRelativePath.match(/^PlugIns\/([^/]+)/);
  if (plugin) {
    return { key: `plugin:${plugin[1]}`, type: 'plugin', name: plugin[1], path: `PlugIns/${plugin[1]}` };
  }
  if (appRelativePath === 'Assets.car' || appRelativePath.endsWith('/Assets.car')) {
    const parts = appRelativePath.split('/');
    return { key: `asset:${appRelativePath}`, type: 'asset', name: parts[parts.length - 1] || 'Assets.car', path: appRelativePath };
  }
  const bundle = appRelativePath.match(/^([^/]+\.bundle)\//) || appRelativePath.match(/^Frameworks\/[^/]+\.framework\/([^/]+\.bundle)\//);
  if (bundle) {
    return { key: `bundle:${bundle[1]}`, type: 'bundle', name: bundle[1], path: appRelativePath.split('/').slice(0, 2).join('/') };
  }
  if (!appRelativePath.includes('/') && !/\.[a-z0-9]{1,8}$/i.test(appRelativePath)) {
    return { key: `executable:${appRelativePath}`, type: 'executable', name: appRelativePath, path: appRelativePath };
  }
  return { key: 'resource:App 资源', type: 'resource', name: 'App 资源', path: 'Payload/*.app' };
}

function analyzeLocalIpaPackageSize(ipaPath: string) {
  const zip = new AdmZip(ipaPath);
  const groups = new Map<string, { type: string; name: string; path: string; bytes: number; fileCount: number }>();

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const bytes = Number(entry.header?.size || 0);
    const classified = classifyIpaEntry(entry.entryName);
    const current = groups.get(classified.key) || {
      type: classified.type,
      name: classified.name,
      path: classified.path,
      bytes: 0,
      fileCount: 0,
    };
    current.bytes += bytes;
    current.fileCount += 1;
    groups.set(classified.key, current);
  }

  const totalBytes = fs.statSync(ipaPath).size;
  const uncompressedBytes = Array.from(groups.values()).reduce((sum, item) => sum + item.bytes, 0);
  const entries = Array.from(groups.values())
    .filter((item) => item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .map((item, index) => ({
      key: `${item.type}-${item.name || index}`,
      type: item.type,
      name: packageSizeEntryLabel(item.type, item.name),
      path: item.path,
      bytes: item.bytes,
      text: formatBytes(item.bytes),
      percent: uncompressedBytes > 0 ? Number(((item.bytes / uncompressedBytes) * 100).toFixed(1)) : 0,
      fileCount: item.fileCount,
    }));

  return {
    totalBytes,
    totalText: formatBytes(totalBytes),
    uncompressedBytes,
    uncompressedText: formatBytes(uncompressedBytes),
    entries,
  };
}

async function fetchRemoteContentLength(url: string) {
  try {
    const response = await axios.head(url, {
      timeout: 10000,
      maxRedirects: 5,
      ...buildAuthConfig(),
    });
    const length = Number(response.headers?.['content-length']);
    return Number.isFinite(length) && length > 0 ? length : 0;
  } catch {
    return 0;
  }
}

function buildPackageSizeComparison(current: any, baseline: any | null) {
  if (!baseline) return null;
  const deltaBytes = Number(current.totalBytes || 0) - Number(baseline.totalBytes || 0);
  const deltaUncompressedBytes = Number(current.uncompressedBytes || 0) - Number(baseline.uncompressedBytes || 0);
  const baselineTotalBytes = Number(baseline.totalBytes || 0);
  const baselineUncompressedBytes = Number(baseline.uncompressedBytes || 0);
  const baselineEntries = new Map<string, any>();
  for (const entry of Array.isArray(baseline.entries) ? baseline.entries : []) {
    baselineEntries.set(`${entry.type}:${entry.name}`, entry);
  }
  const entryDiffs = (Array.isArray(current.entries) ? current.entries : []).map((entry: any) => {
    const previous = baselineEntries.get(`${entry.type}:${entry.name}`);
    const entryDeltaBytes = Number(entry.bytes || 0) - Number(previous?.bytes || 0);
    const previousBytes = Number(previous?.bytes || 0);
    return {
      key: entry.key,
      type: entry.type,
      name: entry.name,
      path: entry.path,
      bytes: Number(entry.bytes || 0),
      text: entry.text || formatBytes(entry.bytes),
      baselineBytes: previousBytes,
      baselineText: formatBytes(previousBytes),
      deltaBytes: entryDeltaBytes,
      deltaText: `${entryDeltaBytes >= 0 ? '+' : '-'}${formatBytes(Math.abs(entryDeltaBytes))}`,
      deltaPercent: previousBytes > 0 ? Number(((entryDeltaBytes / previousBytes) * 100).toFixed(1)) : null,
    };
  }).sort((a: any, b: any) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));

  return {
    baseline: {
      buildNumber: baseline.buildNumber,
      appVersion: baseline.appVersion,
      publishChannel: baseline.publishChannel,
      channelBuildNumber: baseline.channelBuildNumber,
      branchName: baseline.branchName,
      totalBytes: baseline.totalBytes,
      totalText: baseline.totalText,
      uncompressedBytes: baseline.uncompressedBytes,
      uncompressedText: baseline.uncompressedText,
      updatedAt: baseline.updatedAt,
    },
    totalBytes: Number(current.totalBytes || 0),
    baselineTotalBytes,
    deltaBytes,
    deltaText: `${deltaBytes >= 0 ? '+' : '-'}${formatBytes(Math.abs(deltaBytes))}`,
    deltaPercent: baselineTotalBytes > 0 ? Number(((deltaBytes / baselineTotalBytes) * 100).toFixed(1)) : null,
    uncompressedBytes: Number(current.uncompressedBytes || 0),
    baselineUncompressedBytes,
    deltaUncompressedBytes,
    deltaUncompressedText: `${deltaUncompressedBytes >= 0 ? '+' : '-'}${formatBytes(Math.abs(deltaUncompressedBytes))}`,
    deltaUncompressedPercent: baselineUncompressedBytes > 0 ? Number(((deltaUncompressedBytes / baselineUncompressedBytes) * 100).toFixed(1)) : null,
    entries: entryDiffs,
  };
}

async function fetchBuildConsoleText(jobPath: string, buildNumber: number) {
  try {
    const response = await axios.get(`${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/consoleText`, {
      timeout: 30000,
      responseType: 'text',
      ...buildAuthConfig(),
    });
    return String(response.data || '');
  } catch {
    const localLogPath = path.join(localJenkinsJobDir(DEFAULT_JOB_NAME), 'builds', String(buildNumber), 'log');
    if (fs.existsSync(localLogPath)) {
      return fs.readFileSync(localLogPath, 'utf-8');
    }
    return '';
  }
}

async function resolvePackageSizeBuildContext(jobPath: string, buildNumber: number, log: string) {
  const [buildParameters, buildResponse] = await Promise.all([
    fetchBuildParameters(jobPath, buildNumber).catch(() => ({ branchName: '' })),
    fetchJenkinsJobJson(`${jobPath}/${buildNumber}`, 'number,result,building,description,url,timestamp').catch(() => ({ data: {} })),
  ]);
  const buildInfo = buildResponse.data || {};
  const metadata = parseConsoleMetadata(log);
  const descriptionMetadata = parseBuildDescription(buildInfo.description);
  const branchName = normalizeBranchName(String(buildParameters.branchName || ''));
  return {
    metadata,
    branchName,
    result: String(buildInfo.result || ''),
    building: Boolean(buildInfo.building),
    timestamp: Number(buildInfo.timestamp || 0),
    publishChannel: metadata.publishChannel || normalizeDeployTarget(descriptionMetadata.publishChannel),
    appVersion: metadata.appVersion || appVersionFromReleaseBranch(branchName),
    channelBuildNumber: metadata.buildNumber || descriptionMetadata.buildNumber || '',
  };
}

async function findPreviousReleaseBuild(jobPath: string, currentBuildNumber: number, current: any) {
  const currentVersion = String(current.appVersion || appVersionFromReleaseBranch(current.branchName || '') || '').trim();
  const currentChannel = normalizeDeployTarget(current.publishChannel || '');
  if (!currentVersion || !currentChannel) return null;

  const response = await fetchJenkinsJobJson(jobPath, `builds[number,result,timestamp,duration,building,url,description]{0,${RELEASE_BRANCH_BUILD_SCAN_LIMIT}}`);
  const builds = Array.isArray(response.data?.builds) ? response.data.builds : [];
  const candidates: any[] = [];
  for (const build of builds) {
    const candidateBuildNumber = Number(build?.number);
    if (!Number.isFinite(candidateBuildNumber) || candidateBuildNumber <= 0 || candidateBuildNumber === currentBuildNumber) continue;
    if (build?.building || String(build?.result || '').toUpperCase() !== 'SUCCESS') continue;
    const log = await fetchBuildConsoleText(jobPath, candidateBuildNumber);
    const context = await resolvePackageSizeBuildContext(jobPath, candidateBuildNumber, log);
    const branchName = normalizeBranchName(context.branchName || '');
    const appVersion = context.appVersion || appVersionFromReleaseBranch(branchName);
    if (!isReleaseBranch(branchName)) continue;
    if (normalizeDeployTarget(context.publishChannel) !== currentChannel) continue;
    if (!appVersion || compareAppVersions(appVersion, currentVersion) >= 0) continue;
    candidates.push({
      buildNumber: candidateBuildNumber,
      branchName,
      appVersion,
      publishChannel: context.publishChannel,
      channelBuildNumber: context.channelBuildNumber,
      timestamp: Number(build?.timestamp || context.timestamp || 0),
    });
  }
  candidates.sort((a, b) => {
    const versionDiff = compareAppVersions(b.appVersion, a.appVersion);
    if (versionDiff !== 0) return versionDiff;
    return Number(b.buildNumber || 0) - Number(a.buildNumber || 0);
  });
  return candidates[0] || null;
}

async function analyzeAndSavePackageSize(jobPath: string, buildNumber: number, options: { force?: boolean; includeComparison?: boolean } = {}) {
  const force = Boolean(options.force);
  const saved = getSavedPackageSizeAnalysis(buildNumber);
  if (!force && saved) {
    return {
      ...saved,
      cached: true,
    };
  }

  const log = await fetchBuildConsoleText(jobPath, buildNumber);
  const context = await resolvePackageSizeBuildContext(jobPath, buildNumber, log);
  const metadata = context.metadata;
  const candidateValues = [
    metadata.installPackageUrl,
    metadata.packageUrl,
  ].filter(Boolean);
  const localIpaPath = candidateValues.map(normalizeLocalArtifactPath).find((value) => value && fs.existsSync(value) && fs.statSync(value).isFile()) || '';
  const remoteUrl = candidateValues.find((value) => /^https?:\/\//i.test(value)) || '';
  const warnings: string[] = [];

  let analysis = {
    totalBytes: 0,
    totalText: '0 B',
    uncompressedBytes: 0,
    uncompressedText: '0 B',
    entries: [] as Array<{
      key: string;
      type: string;
      name: string;
      path: string;
      bytes: number;
      text: string;
      percent: number;
      fileCount: number;
    }>,
  };

  if (localIpaPath) {
    analysis = analyzeLocalIpaPackageSize(localIpaPath);
  } else if (remoteUrl) {
    const remoteBytes = await fetchRemoteContentLength(remoteUrl);
    analysis.totalBytes = remoteBytes;
    analysis.totalText = formatBytes(remoteBytes);
    warnings.push(remoteBytes > 0
      ? '当前只获取到远端安装包总大小，未找到本地 IPA，无法展开内部结构。'
      : '未找到本地 IPA，远端安装包大小也无法读取。');
  } else {
    warnings.push('构建日志中未解析到 IPA 路径或安装包地址。');
  }

  const result = {
    jobName: DEFAULT_JOB_NAME,
    buildNumber,
    appVersion: context.appVersion,
    publishChannel: context.publishChannel,
    channelBuildNumber: context.channelBuildNumber,
    branchName: context.branchName,
    ipaPath: localIpaPath,
    ipaUrl: remoteUrl || metadata.packageUrl || '',
    warnings,
    ...analysis,
  };
  const savedAnalysis = savePackageSizeAnalysis(buildNumber, result);
  return {
    ...savedAnalysis,
    cached: false,
  };
}

async function fetchBuildConsoleMetadata(jobPath: string, buildNumber: number) {
  try {
    const response = await axios.get(`${JENKINS_BASE_URL}/${jobPath}/${buildNumber}/consoleText`, {
      timeout: JENKINS_BUILD_METADATA_TIMEOUT_MS,
      ...buildAuthConfig(),
    });
    return parseConsoleMetadata(String(response.data || ''));
  } catch {
    try {
      const decodedJobName = decodeURIComponent(jobPath).replace(/\/job\//g, '/').replace(/^job\//, '');
      const localLogPath = path.join(localJenkinsJobDir(decodedJobName), 'builds', String(buildNumber), 'log');
      if (fs.existsSync(localLogPath)) {
        return parseConsoleMetadata(fs.readFileSync(localLogPath, 'utf-8'));
      }
    } catch {
      // ignore local fallback errors
    }
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
          businessFlowReportUrl: artifactUrl(summary.artifacts?.businessFlowReport),
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
      testFlightWhatsNew: String(getParam('TESTFLIGHT_WHATS_NEW') || ''),
    };
  } catch {
    return {
      branchName: '',
      testFlightWhatsNew: '',
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

async function findLatestSuccessfulTestFlightBuild(branch: string) {
  const normalizedBranch = normalizeBranchName(branch);
  if (!normalizedBranch) return null;
  const jobPath = encodeJobPath(DEFAULT_JOB_NAME);
  const response = await fetchJenkinsJobJson(jobPath, `builds[number,result,building,description]{0,${RELEASE_BRANCH_BUILD_SCAN_LIMIT}}`);
  const builds = Array.isArray(response.data?.builds) ? response.data.builds : [];
  const candidates: any[] = [];
  for (const build of builds) {
    const buildNumber = Number(build?.number);
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) continue;
    if (build?.building || String(build?.result || '').toUpperCase() !== 'SUCCESS') continue;
    const descriptionMetadata = parseBuildDescription(build.description);
    const [consoleMetadata, buildParameters] = await Promise.all([
      fetchBuildConsoleMetadata(jobPath, buildNumber).catch(() => ({} as any)),
      fetchBuildParameters(jobPath, buildNumber).catch(() => ({ branchName: '', testFlightWhatsNew: '' })),
    ]);
    const publishChannel = consoleMetadata.publishChannel || normalizeDeployTarget(descriptionMetadata.publishChannel);
    if (normalizeDeployTarget(publishChannel) !== 'TestFlight') continue;
    const buildBranch = normalizeBranchName(buildParameters.branchName || '');
    const buildAppVersion = String(consoleMetadata.appVersion || '').trim();
    if (buildBranch !== normalizedBranch) continue;
    candidates.push({
      number: buildNumber,
      branchName: buildBranch,
      appVersion: buildAppVersion,
      publishChannel: 'TestFlight',
    });
  }
  return candidates.sort((a, b) => Number(b.number || 0) - Number(a.number || 0))[0] || null;
}

async function assertAppStoreReleasePreconditions(branch: string, appVersion: string, gateBuildNumber?: number) {
  const normalizedBranch = normalizeBranchName(branch);
  const releaseBranchVersion = appVersionFromReleaseBranch(normalizedBranch);
  const normalizedAppVersion = String(appVersion || releaseBranchVersion || '').trim();
  if (!releaseBranchVersion) {
    throw new JenkinsReleaseError('苹果商店发布仅允许 release/x.x.x 分支', 400);
  }
  if (normalizedAppVersion && normalizedAppVersion !== releaseBranchVersion) {
    throw new JenkinsReleaseError(`发布版本 ${normalizedAppVersion} 与发布分支版本 ${releaseBranchVersion} 不一致`, 400);
  }
  if (!gateBuildNumber) return;
  const latestTestFlightBuild = await findLatestSuccessfulTestFlightBuild(normalizedBranch);
  if (!latestTestFlightBuild?.number) {
    throw new JenkinsReleaseError(`未找到分支 ${normalizedBranch} 对应的 TestFlight 成功构建，无法使用门禁源`, 400);
  }
  if (Number(gateBuildNumber) !== Number(latestTestFlightBuild.number)) {
    throw new JenkinsReleaseError(`门禁源必须选择同分支的最新 TestFlight 成功构建 #${latestTestFlightBuild.number}`, 400, { latestTestFlightBuild });
  }
}

type ReleasePreflightCheckStatus = 'passed' | 'warning' | 'blocked';

function buildReleasePreflightCheck(key: string, label: string, status: ReleasePreflightCheckStatus, message: string, details?: any) {
  return { key, label, status, message, details };
}

function ascConfigStatus() {
  const keyPath = String(getRuntimeEnv('APP_STORE_CONNECT_API_KEY_PATH') || '').trim();
  const keyId = String(getRuntimeEnv('APP_STORE_CONNECT_API_KEY_ID') || '').trim();
  const issuerId = String(getRuntimeEnv('APP_STORE_CONNECT_API_ISSUER_ID') || '').trim();
  const appId = String(getRuntimeEnv('APP_STORE_CONNECT_APP_ID') || '').trim();
  return {
    configured: Boolean(keyPath && keyId && issuerId && appId),
    keyPathConfigured: Boolean(keyPath),
    keyFileExists: keyPath ? fs.existsSync(keyPath) : false,
    keyIdConfigured: Boolean(keyId),
    issuerIdConfigured: Boolean(issuerId),
    appIdConfigured: Boolean(appId),
  };
}

function pgyerConfigStatus() {
  const platformApiKeyConfigured = Boolean(String(getRuntimeEnv('PGYER_API_KEY') || '').trim());
  const platformAppKeyConfigured = Boolean(String(getRuntimeEnv('PGYER_APP_KEY') || '').trim());
  const platformShortcutConfigured = Boolean(String(getRuntimeEnv('PGYER_SHORTCUT_URL') || '').trim());
  const jenkinsConfigPath = path.join(getJenkinsRepoLocalDir(), 'cicd/jenkins/build_config.sh');
  const jenkinsApiKeyConfigured = Boolean(readShellConfigValue(jenkinsConfigPath, 'PGYER_API_KEY'));
  const jenkinsAppKeyConfigured = Boolean(readShellConfigValue(jenkinsConfigPath, 'PGYER_APP_KEY'));
  const jenkinsShortcutConfigured = Boolean(readShellConfigValue(jenkinsConfigPath, 'PGYER_SHORTCUT_URL'));
  return {
    configured: platformApiKeyConfigured || jenkinsApiKeyConfigured,
    apiKeyConfigured: platformApiKeyConfigured || jenkinsApiKeyConfigured,
    platformApiKeyConfigured,
    jenkinsApiKeyConfigured,
    appKeyConfigured: platformAppKeyConfigured || jenkinsAppKeyConfigured,
    shortcutConfigured: platformShortcutConfigured || jenkinsShortcutConfigured,
    jenkinsConfigPath,
  };
}

function privatePodSyncConfigStatus() {
  const jenkinsConfigPath = path.join(getJenkinsRepoLocalDir(), 'cicd/jenkins/build_config.sh');
  const skipRemoteCheck = String(getRuntimeEnv('SKIP_POD_REMOTE_CHECK') || readShellConfigValue(jenkinsConfigPath, 'SKIP_POD_REMOTE_CHECK') || 'false').trim().toLowerCase() === 'true';
  const ttlRaw = String(getRuntimeEnv('POD_HEAD_CHECK_TTL_SECONDS') || readShellConfigValue(jenkinsConfigPath, 'POD_HEAD_CHECK_TTL_SECONDS') || '0').trim();
  const ttlSeconds = Number(ttlRaw);
  const allowDevelopFallback = String(getRuntimeEnv('ALLOW_PRIVATE_POD_DEVELOP_FALLBACK') || readShellConfigValue(jenkinsConfigPath, 'ALLOW_PRIVATE_POD_DEVELOP_FALLBACK') || 'false').trim().toLowerCase() === 'true';
  const strictBranch = String(getRuntimeEnv('STRICT_PRIVATE_POD_BRANCH') || readShellConfigValue(jenkinsConfigPath, 'STRICT_PRIVATE_POD_BRANCH') || 'false').trim().toLowerCase() === 'true';
  return {
    configured: true,
    skipRemoteCheck,
    ttlSeconds: Number.isFinite(ttlSeconds) ? ttlSeconds : 0,
    ttlRaw,
    allowDevelopFallback,
    strictBranch,
    jenkinsConfigPath,
  };
}

async function buildReleasePreflight(input: {
  branch: string;
  deployTarget: string;
  appVersion?: string;
  gateBuildNumber?: number;
  testFlightWhatsNew?: string;
}) {
  const checks: any[] = [];
  const branch = normalizeBranchName(input.branch || '');
  const deployTarget = normalizeDeployTarget(input.deployTarget || 'Pgyer');
  const releaseBranchVersion = appVersionFromReleaseBranch(branch);
  const requestedAppVersion = String(input.appVersion || releaseBranchVersion || '').trim();
  const releaseNotes = normalizeTestFlightWhatsNew(input.testFlightWhatsNew);

  checks.push(buildReleasePreflightCheck(
    'branch',
    '发布分支',
    branch ? 'passed' : 'blocked',
    branch ? `发布分支：${branch}` : '发布分支不能为空',
  ));
  checks.push(buildReleasePreflightCheck(
    'deploy_target',
    '发布渠道',
    DEPLOY_TARGETS.has(deployTarget) ? 'passed' : 'blocked',
    DEPLOY_TARGETS.has(deployTarget) ? `发布渠道：${deployTarget}` : '发布渠道无效',
  ));

  const privatePodSync = privatePodSyncConfigStatus();
  const privatePodSyncBlocked = privatePodSync.skipRemoteCheck && deployTarget !== 'Pgyer';
  checks.push(buildReleasePreflightCheck(
    'private_pod_sync',
    '私有组件同步',
    privatePodSyncBlocked ? 'blocked' : (privatePodSync.skipRemoteCheck || privatePodSync.ttlSeconds > 0 ? 'warning' : 'passed'),
    privatePodSyncBlocked
      ? '发布渠道禁止跳过私有 Pod 远端 HEAD 检查，否则可能复用旧组件'
      : (privatePodSync.skipRemoteCheck
        ? '已跳过私有 Pod 远端 HEAD 检查，可能复用旧组件'
        : (privatePodSync.ttlSeconds > 0
          ? `私有 Pod HEAD 使用 ${privatePodSync.ttlSeconds} 秒 TTL 缓存，短时间内可能无法感知组件新提交`
          : '每次发布都会检查私有 Pod 远端 HEAD，并校验最终安装 Commit')),
    privatePodSync,
  ));

  if (deployTarget !== 'Pgyer') {
    checks.push(buildReleasePreflightCheck(
      'release_branch',
      'Release 分支',
      isReleaseBranch(branch) ? 'passed' : 'blocked',
      isReleaseBranch(branch) ? '符合 release/x.x.x 分支规则' : 'TestFlight/App Store 仅允许 release/x.x.x 分支',
    ));
    checks.push(buildReleasePreflightCheck(
      'version_match',
      '版本一致性',
      releaseBranchVersion && (!requestedAppVersion || requestedAppVersion === releaseBranchVersion) ? 'passed' : 'blocked',
      releaseBranchVersion
        ? (requestedAppVersion && requestedAppVersion !== releaseBranchVersion
          ? `发布版本 ${requestedAppVersion} 与分支版本 ${releaseBranchVersion} 不一致`
          : `App 版本与分支版本一致：${releaseBranchVersion}`)
        : '无法从 release 分支解析 App 版本',
    ));
    checks.push(buildReleasePreflightCheck(
      'release_notes',
      '发布文案',
      releaseNotes.length > 4 ? 'passed' : 'blocked',
      releaseNotes.length > 4 ? '发布文案已填写' : 'TestFlight/App Store 发布文案必填，且必须超过 4 个字',
    ));
    const ascStatus = ascConfigStatus();
    checks.push(buildReleasePreflightCheck(
      'asc_config',
      'App Store Connect 配置',
      ascStatus.configured && (!ascStatus.keyPathConfigured || ascStatus.keyFileExists) ? 'passed' : 'blocked',
      ascStatus.configured
        ? (ascStatus.keyFileExists ? 'ASC API 配置可用' : 'ASC API Key 文件路径不存在')
        : '缺少 APP_STORE_CONNECT_API_KEY_PATH/ID/ISSUER_ID/APP_ID 配置',
      ascStatus,
    ));
  } else {
    const pgyerStatus = pgyerConfigStatus();
    checks.push(buildReleasePreflightCheck(
    'pgyer_config',
    '蒲公英配置',
      pgyerStatus.apiKeyConfigured ? 'passed' : 'warning',
      pgyerStatus.apiKeyConfigured
        ? (pgyerStatus.platformApiKeyConfigured ? '平台已配置蒲公英 API Key' : 'Jenkins build_config 已配置蒲公英 API Key')
        : '未检测到 PGYER_API_KEY，Jenkins 侧可能会发布失败',
      pgyerStatus,
    ));
  }

  if (deployTarget === 'AppStore') {
    try {
      const guard = await checkAppStoreReleaseBlocker(branch);
      checks.push(buildReleasePreflightCheck(
        'appstore_version_state',
        'ASC 版本状态',
        guard.blocked ? 'blocked' : 'passed',
        guard.message || 'ASC 版本状态允许发布',
        guard,
      ));
    } catch (error: any) {
      checks.push(buildReleasePreflightCheck(
        'appstore_version_state',
        'ASC 版本状态',
        'blocked',
        extractErrorMessage(error, '检查苹果商店版本状态失败'),
      ));
    }

    if (input.gateBuildNumber) {
      try {
        await assertAppStoreReleasePreconditions(branch, requestedAppVersion, Number(input.gateBuildNumber));
        checks.push(buildReleasePreflightCheck(
          'optional_gate_source',
          '可选门禁源',
          'passed',
          `已选择同分支最新 TestFlight 成功构建 #${Number(input.gateBuildNumber)}`,
        ));
      } catch (error: any) {
        checks.push(buildReleasePreflightCheck(
          'optional_gate_source',
          '可选门禁源',
          'blocked',
          extractErrorMessage(error, '门禁源不符合发布要求'),
          error instanceof JenkinsReleaseError ? error.data : undefined,
        ));
      }
    } else {
      checks.push(buildReleasePreflightCheck(
        'optional_gate_source',
        '可选门禁源',
        'warning',
        '未选择门禁源，将跳过质量门禁评分',
      ));
    }
  }

  const blockers = checks.filter((check) => check.status === 'blocked');
  const warnings = checks.filter((check) => check.status === 'warning');
  return {
    passed: blockers.length === 0,
    branch,
    deployTarget,
    appVersion: requestedAppVersion,
    blockers,
    warnings,
    checks,
  };
}

async function loadReleaseBuildForSync(jobPath: string, build: any) {
  const buildNumber = Number(build?.number);
  if (!Number.isFinite(buildNumber) || buildNumber <= 0) return null;
  const descriptionMetadata = parseBuildDescription(build.description);
  const [consoleMetadata, buildParameters] = await Promise.all([
    fetchBuildConsoleMetadata(jobPath, buildNumber).catch(() => ({} as any)),
    fetchBuildParameters(jobPath, buildNumber).catch(() => ({ branchName: '', testFlightWhatsNew: '' })),
  ]);
  const publishChannel = consoleMetadata.publishChannel || normalizeDeployTarget(descriptionMetadata.publishChannel);
  if (!normalizeDeployTarget(publishChannel)) return null;
  const channelBuildNumber = await resolveChannelBuildNumber(
    publishChannel,
    consoleMetadata.buildNumber || descriptionMetadata.buildNumber,
    buildNumber,
  );
  const branchName = normalizeBranchName(buildParameters.branchName || '');
  const releaseOrder = matchReleaseOrderForBuild(build, branchName, publishChannel, {
    appVersion: consoleMetadata.appVersion,
    buildNumber: channelBuildNumber,
  });
  const archivedReleaseRequest = getArchivedReleaseRequestForBuild(buildNumber) ||
    matchReleaseRequestForBuild(build, branchName, publishChannel);
  const testFlightWhatsNew = buildParameters.testFlightWhatsNew || archivedReleaseRequest?.releaseNotes || releaseOrder?.releaseNotes || '';
  return {
    ...build,
    url: normalizeJenkinsUrl(build.url),
    branchName,
    publishChannel,
    commitHash: consoleMetadata.commitHash,
    buildNumber: channelBuildNumber,
    appVersion: consoleMetadata.appVersion || appVersionFromReleaseBranch(branchName),
    testFlightWhatsNew,
    packageUrl: consoleMetadata.packageUrl,
    installPackageUrl: consoleMetadata.installPackageUrl,
    channelQrUrl: consoleMetadata.channelQrUrl,
    xcarchivePath: consoleMetadata.xcarchivePath,
    archiveUrl: consoleMetadata.archiveUrl,
    releaseOrder,
  };
}

async function syncRecentReleaseBuilds(reason = 'timer') {
  if (RELEASE_SYNC_RUNNING) return { skipped: true, reason: 'running' };
  RELEASE_SYNC_RUNNING = true;
  const startedAt = Date.now();
  try {
    const jobPath = encodeJobPath(DEFAULT_JOB_NAME);
    const tree = `builds[number,result,timestamp,duration,building,url,description]{0,${RELEASE_SYNC_SCAN_LIMIT}}`;
    const response = await fetchJenkinsJobJson(jobPath, tree);
    const rawBuilds = Array.isArray(response.data?.builds) ? response.data.builds : [];
    const syncedBuilds: any[] = [];
    for (let index = 0; index < rawBuilds.length; index += RELEASE_SYNC_CONCURRENCY) {
      const batch = rawBuilds.slice(index, index + RELEASE_SYNC_CONCURRENCY);
      const loadedBuilds = await Promise.all(batch.map(async (rawBuild: any) => {
        try {
          return await loadReleaseBuildForSync(jobPath, rawBuild);
        } catch (error: any) {
          logger.warn('CI/CD 发布状态单条同步失败', {
            reason,
            buildNumber: rawBuild?.number,
            error: error?.message,
          });
          return null;
        }
      }));
      for (const build of loadedBuilds) {
        if (!build) continue;
        syncedBuilds.push(build);
        scheduleAppStoreBuildDsymSync(build);
        scheduleTestFlightDistribution(build);
        scheduleAppStoreRelease(build);
      }
    }
    if (syncedBuilds.length > 0) {
      workflowIntegrationService.syncJenkinsBuilds(syncedBuilds);
    }
    return {
      skipped: false,
      reason,
      count: syncedBuilds.length,
      elapsedMs: Date.now() - startedAt,
      syncedAt: new Date().toISOString(),
    };
  } catch (error: any) {
    logger.warn('CI/CD 发布状态后台同步失败', { reason, error: error?.message });
    return {
      skipped: false,
      reason,
      error: error?.message || 'CI/CD 发布状态后台同步失败',
      elapsedMs: Date.now() - startedAt,
      syncedAt: new Date().toISOString(),
    };
  } finally {
    RELEASE_SYNC_RUNNING = false;
  }
}

function startReleaseStatusSyncer() {
  if (String(process.env.JENKINS_RELEASE_SYNC_DISABLED || '').toLowerCase() === 'true') return;
  setTimeout(() => {
    void syncRecentReleaseBuilds('startup');
  }, 5000).unref?.();
  setInterval(() => {
    void syncRecentReleaseBuilds('timer');
  }, RELEASE_SYNC_INTERVAL_MS).unref?.();
}

async function fetchRecentJenkinsBuildBranches(jobPath: string) {
  const tree = `builds[number]{0,${RELEASE_BRANCH_LIST_BUILD_SCAN_LIMIT}}`;
  const response = await fetchJenkinsJobJson(jobPath, tree);
  const builds = Array.isArray(response.data?.builds) ? response.data.builds : [];
  const branches = await Promise.all(builds.map(async (build: any) => {
    const buildNumber = Number(build?.number);
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) return '';
    const parameters = await fetchBuildParameters(jobPath, buildNumber);
    return normalizeBranchName(parameters.branchName || '');
  }));
  return branches.filter(Boolean);
}

router.get('/nn/branches', async (_req: Request, res: Response) => {
  const warnings: string[] = [];
  let remoteBranches: string[] = [];
  let buildBranches: string[] = [];

  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', DEFAULT_REPO_URL], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    remoteBranches = stdout
      .split('\n')
      .map((line) => line.match(/refs\/heads\/(.+)$/)?.[1])
      .filter((branch): branch is string => Boolean(branch))
      .filter((branch) => !branch.includes('HEAD'))
      .map(normalizeBranchName);
  } catch (error: any) {
    const message = error.message || 'Git 远端分支查询失败';
    warnings.push(message);
    logger.warn(`查询 Git 远端分支失败: ${message}`);
  }

  try {
    buildBranches = await fetchRecentJenkinsBuildBranches(encodeJobPath(DEFAULT_JOB_NAME));
  } catch (error: any) {
    const message = error.message || 'Jenkins 历史构建分支查询失败';
    warnings.push(message);
    logger.warn(`查询 Jenkins 历史构建分支失败: ${message}`);
  }

  let branches = Array.from(new Set([...remoteBranches, ...buildBranches]))
    .filter(Boolean)
    .sort(compareBranchOptions);

  if (branches.length > 0) {
    branches = saveBranchCache(branches);
  } else {
    branches = readBranchCache();
  }

  res.json({
    success: true,
    data: branches,
    warnings,
    stale: remoteBranches.length === 0 && buildBranches.length === 0 && branches.length > 0,
  });
});

router.get('/nn/builds', async (req: Request, res: Response) => {
  try {
    const jobPath = encodeJobPath(DEFAULT_JOB_NAME);
    const deployTargetFilter = normalizeDeployTarget(String(req.query.deployTarget || ''));
    const branchFilter = normalizeBranchName(String(req.query.branch || ''));
    const buildListLimit = branchFilter ? RELEASE_BRANCH_BUILD_SCAN_LIMIT : RELEASE_BUILD_LIST_LIMIT;
    const tree = [
      'displayName',
      'fullName',
      'url',
      'buildable',
      'color',
      'lastBuild[number,result,timestamp,duration,building,url,description]',
      `builds[number,result,timestamp,duration,building,url,description]{0,${buildListLimit}}`,
    ].join(',');
    const response = await fetchJenkinsJobJson(jobPath, tree);

    const job = response.data || {};
    const rawBuilds = Array.isArray(job.builds) ? job.builds.slice(0, buildListLimit) : [];
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
      const branchName = buildParameters.branchName;
      const archivedReleaseRequest = matchReleaseRequestForBuild(build, branchName, publishChannel);
      const releaseOrder = matchReleaseOrderForBuild(build, branchName, publishChannel, {
        appVersion,
        buildNumber,
      });
      const testFlightWhatsNew = buildParameters.testFlightWhatsNew || archivedReleaseRequest?.releaseNotes || releaseOrder?.releaseNotes || '';
	      return {
	        ...build,
	        url: normalizeJenkinsUrl(build.url),
	        branchName,
	        publishChannel,
	        commitHash: consoleMetadata.commitHash,
        buildNumber,
        appVersion,
        testFlightWhatsNew,
        packageUrl: consoleMetadata.packageUrl,
	        installPackageUrl: consoleMetadata.installPackageUrl,
	        channelQrUrl: consoleMetadata.channelQrUrl,
	        xcarchivePath: consoleMetadata.xcarchivePath,
	        archiveUrl: consoleMetadata.archiveUrl,
	        dsymSync: getSavedBuildDsymSync(build.number),
	        testFlightDistribution: getSavedTestFlightDistribution(build.number),
	        appStoreRelease: getSavedAppStoreRelease(build.number),
          releaseOrder,
	      };
	    }));
	    buildsWithMetadata.forEach(scheduleAppStoreBuildDsymSync);
	    buildsWithMetadata.forEach((build: any) => scheduleTestFlightDistribution(build));
	    buildsWithMetadata.forEach((build: any) => scheduleAppStoreRelease(build));
	    workflowIntegrationService.syncJenkinsBuilds(buildsWithMetadata);
	    const builds = buildsWithMetadata.filter((build: any) => (
	      (!deployTargetFilter || normalizeDeployTarget(build.publishChannel) === deployTargetFilter) &&
	      (!branchFilter || normalizeBranchName(build.branchName || '') === branchFilter)
	    ));
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
	    const buildMetadata = parseConsoleMetadata(log);
	    const buildResponse = await fetchJenkinsJobJson(`${jobPath}/${buildNumber}`, 'number,result,building,description,url');
	    const buildInfo = buildResponse.data || {};
	    const publishChannel = buildMetadata.publishChannel || normalizeDeployTarget(parseBuildDescription(buildInfo.description).publishChannel);
	    const archivedReleaseRequest = getArchivedReleaseRequestForBuild(buildNumber) ||
	      matchReleaseRequestForBuild(buildInfo, buildParameters.branchName, publishChannel);
      const releaseOrder = matchReleaseOrderForBuild(buildInfo, buildParameters.branchName, publishChannel, {
        appVersion: buildMetadata.appVersion,
        buildNumber: buildMetadata.buildNumber,
      });
	    const testFlightWhatsNew = buildParameters.testFlightWhatsNew || archivedReleaseRequest?.releaseNotes || releaseOrder?.releaseNotes || '';
	    const dsymSync = getSavedBuildDsymSync(buildNumber);
	    const testFlightDistribution = getSavedTestFlightDistribution(buildNumber);
	    const appStoreRelease = getSavedAppStoreRelease(buildNumber);
	    scheduleAppStoreBuildDsymSync({
	      ...buildInfo,
	      publishChannel,
	    });
	    scheduleTestFlightDistribution({
	      ...buildInfo,
	      publishChannel,
	      appVersion: buildMetadata.appVersion,
	      buildNumber: buildMetadata.buildNumber,
	      testFlightWhatsNew,
	    });
	    scheduleAppStoreRelease({
	      ...buildInfo,
	      publishChannel,
	      appVersion: buildMetadata.appVersion,
	      buildNumber: buildMetadata.buildNumber,
	      branchName: buildParameters.branchName,
	    });

	    res.json({
	      success: true,
	      data: {
	        jobName: DEFAULT_JOB_NAME,
	        buildNumber,
	        log,
	        failureAnalysis: savedFailureAnalysis?.analysis,
	        failureAnalysisUpdatedAt: savedFailureAnalysis?.updatedAt,
	        dsymSync,
	        testFlightWhatsNew,
	        testFlightDistribution,
	        appStoreRelease,
          releaseOrder,
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

router.get('/nn/builds/:number/package-size', async (req: Request, res: Response) => {
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

    const force = ['1', 'true', 'yes'].includes(String(req.query.force || '').toLowerCase());
    const currentAnalysis = await analyzeAndSavePackageSize(jobPath, buildNumber, { force });
    const previousReleaseBuild = await findPreviousReleaseBuild(jobPath, buildNumber, currentAnalysis);
    let comparison = null;
    const comparisonWarnings = [...(currentAnalysis.warnings || [])];
    if (previousReleaseBuild?.buildNumber) {
      const baselineAnalysis = await analyzeAndSavePackageSize(jobPath, previousReleaseBuild.buildNumber, { force: false });
      comparison = buildPackageSizeComparison(currentAnalysis, baselineAnalysis);
    } else {
      comparisonWarnings.push('未找到可对比的前一个 release 成功构建。');
    }

    const savedAnalysis = savePackageSizeAnalysis(buildNumber, {
      ...currentAnalysis,
      cached: false,
      warnings: Array.from(new Set(comparisonWarnings)),
      comparison,
    });

    res.json({
      success: true,
      data: {
        ...savedAnalysis,
        cached: currentAnalysis.cached && !force,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: extractErrorMessage(error, '分析包体积失败'),
    });
  }
});

router.post('/nn/builds/:number/sync-dsyms', cicdDeveloperMiddleware, async (req: Request, res: Response) => {
  try {
    const buildNumber = Number(req.params.number);
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) {
      res.status(400).json({
        success: false,
        error: '构建号无效',
      });
      return;
    }

    const result = await syncAppStoreBuildDsyms(buildNumber, { force: Boolean(req.body?.force) });
    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || '同步 AppStore dSYM 失败',
    });
  }
});

router.post('/nn/builds/:number/submit-app-store-review', cicdProductReleaseMiddleware, async (req: Request, res: Response) => {
  try {
    const buildNumber = Number(req.params.number);
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) {
      res.status(400).json({
        success: false,
        error: '构建号无效',
      });
      return;
    }

    const jobPath = encodeJobPath(DEFAULT_JOB_NAME);
    const [buildMetadata, buildParameters] = await Promise.all([
      fetchBuildConsoleMetadata(jobPath, buildNumber),
      fetchBuildParameters(jobPath, buildNumber),
    ]);
    const appId = testFlightAppId();
    const appVersion = String(buildMetadata.appVersion || '').trim();
    const channelBuildNumber = String(buildMetadata.buildNumber || '').trim();
    const branchName = normalizeBranchName(String(buildParameters.branchName || ''));
    const releaseNotes = normalizeTestFlightWhatsNew(buildParameters.testFlightWhatsNew);
    if (!appId || !appVersion || !channelBuildNumber) {
      res.status(400).json({
        success: false,
        error: '缺少 APP_STORE_CONNECT_APP_ID、App 版本或渠道构建号，无法提交 App Store 审核',
      });
      return;
    }

    const appStoreBuild = await findAppStoreBuild(appId, appVersion, channelBuildNumber);
    if (!appStoreBuild?.id) {
      res.status(404).json({
        success: false,
        error: '未在 App Store Connect 匹配到正式包构建',
      });
      return;
    }
    const appStoreVersion = await fetchBuildAppStoreVersion(appStoreBuild.id);
    const appStoreVersionId = String(appStoreVersion?.id || '');
    if (!appStoreVersionId) {
      res.status(404).json({
        success: false,
        error: '未找到当前构建关联的 App Store Version，请先在 App Store Connect 完成版本信息',
      });
      return;
    }

    const appStoreState = String(appStoreVersion?.attributes?.appStoreState || appStoreVersion?.attributes?.appVersionState || '');
    if (!['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED'].includes(appStoreState)) {
      const stateStatus = appStoreVersionStateStatus(appStoreState);
      const release = saveAppStoreRelease(buildNumber, {
        status: stateStatus.status,
        appVersion,
        buildNumber: channelBuildNumber,
        branchName,
        appStoreBuildId: appStoreBuild.id,
        appStoreVersionId,
        processingState: String(appStoreBuild?.attributes?.processingState || ''),
        appStoreState,
        message: stateStatus.message,
        failureReason: ['rejected', 'developer_action_needed', 'pending_agreement', 'failed'].includes(String(stateStatus.status)) ? stateStatus.message : '',
      });
      res.json({
        success: true,
        data: release,
        message: stateStatus.message,
      });
      return;
    }

    await upsertAppStoreVersionReleaseNotes(appStoreVersionId, releaseNotes);
    await setAppStoreVersionAutomaticRelease(appStoreVersionId);
    const reviewSubmissionId = await submitAppStoreReview(appStoreVersionId);
    const latestVersion = await fetchBuildAppStoreVersion(appStoreBuild.id);
    const latestState = String(latestVersion?.attributes?.appStoreState || latestVersion?.attributes?.appVersionState || appStoreState);
    const stateStatus = appStoreVersionStateStatus(latestState);
    const release = saveAppStoreRelease(buildNumber, {
      status: stateStatus.status,
      appVersion,
      buildNumber: channelBuildNumber,
      branchName,
      appStoreBuildId: appStoreBuild.id,
      appStoreVersionId,
      reviewSubmissionId,
      processingState: String(appStoreBuild?.attributes?.processingState || ''),
      appStoreState: latestState,
      releaseNotes,
      releaseType: 'AFTER_APPROVAL',
      message: stateStatus.message,
      failureReason: ['rejected', 'developer_action_needed', 'pending_agreement', 'failed'].includes(String(stateStatus.status)) ? stateStatus.message : '',
    });
    res.json({
      success: true,
      data: release,
      message: '已提交 App Store 审核',
    });
  } catch (error: any) {
    res.status(error.response?.status || 500).json({
      success: false,
      error: appStoreConnectErrorMessage(error, '提交 App Store 审核失败'),
    });
  }
});

router.post('/nn/builds/:number/cancel-app-store-review', cicdProductReleaseMiddleware, async (req: Request, res: Response) => {
  try {
    const buildNumber = Number(req.params.number);
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) {
      res.status(400).json({
        success: false,
        error: '构建号无效',
      });
      return;
    }

    const jobPath = encodeJobPath(DEFAULT_JOB_NAME);
    const [buildMetadata, buildParameters] = await Promise.all([
      fetchBuildConsoleMetadata(jobPath, buildNumber),
      fetchBuildParameters(jobPath, buildNumber),
    ]);
    const appId = testFlightAppId();
    const appVersion = String(buildMetadata.appVersion || '').trim();
    const channelBuildNumber = String(buildMetadata.buildNumber || '').trim();
    const branchName = normalizeBranchName(String(buildParameters.branchName || ''));
    if (!appId || !appVersion || !channelBuildNumber) {
      res.status(400).json({
        success: false,
        error: '缺少 APP_STORE_CONNECT_APP_ID、App 版本或渠道构建号，无法取消 App Store 审核',
      });
      return;
    }

    const appStoreBuild = await findAppStoreBuild(appId, appVersion, channelBuildNumber);
    if (!appStoreBuild?.id) {
      res.status(404).json({
        success: false,
        error: '未在 App Store Connect 匹配到正式包构建',
      });
      return;
    }
    const appStoreVersion = await fetchBuildAppStoreVersion(appStoreBuild.id);
    const appStoreVersionId = String(appStoreVersion?.id || '');
    if (!appStoreVersionId) {
      res.status(404).json({
        success: false,
        error: '未找到当前构建关联的 App Store Version',
      });
      return;
    }

    const appStoreState = String(appStoreVersion?.attributes?.appStoreState || appStoreVersion?.attributes?.appVersionState || '');
    if (!['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(appStoreState)) {
      const stateStatus = appStoreVersionStateStatus(appStoreState);
      const release = saveAppStoreRelease(buildNumber, {
        status: stateStatus.status,
        appVersion,
        buildNumber: channelBuildNumber,
        branchName,
        appStoreBuildId: appStoreBuild.id,
        appStoreVersionId,
        processingState: String(appStoreBuild?.attributes?.processingState || ''),
        appStoreState,
        message: stateStatus.message,
        failureReason: ['rejected', 'developer_action_needed', 'pending_agreement', 'failed'].includes(String(stateStatus.status)) ? stateStatus.message : '',
      });
      res.json({
        success: true,
        data: release,
        message: stateStatus.message,
      });
      return;
    }

    await cancelAppStoreReview(appStoreVersionId);
    const latestVersion = await fetchBuildAppStoreVersion(appStoreBuild.id);
    const latestState = String(latestVersion?.attributes?.appStoreState || latestVersion?.attributes?.appVersionState || 'DEVELOPER_REJECTED');
    const stateStatus = appStoreVersionStateStatus(latestState);
    const release = saveAppStoreRelease(buildNumber, {
      status: stateStatus.status,
      appVersion,
      buildNumber: channelBuildNumber,
      branchName,
      appStoreBuildId: appStoreBuild.id,
      appStoreVersionId,
      processingState: String(appStoreBuild?.attributes?.processingState || ''),
      appStoreState: latestState,
      message: stateStatus.message,
      failureReason: ['developer_rejected', 'rejected', 'developer_action_needed', 'pending_agreement', 'failed'].includes(String(stateStatus.status)) ? stateStatus.message : '',
    });
    res.json({
      success: true,
      data: release,
      message: '已停止 App Store 审核',
    });
  } catch (error: any) {
    res.status(error.response?.status || 500).json({
      success: false,
      error: appStoreConnectErrorMessage(error, '停止 App Store 审核失败'),
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
      workflowIntegrationService.recordBuildFailure({
        number: buildNumber,
        result: build.result || 'FAILURE',
        building: build.building,
        url: normalizeJenkinsUrl(build.url),
      }, saved.analysis);
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
    workflowIntegrationService.recordBuildFailure({
      number: buildNumber,
      result: build.result || 'FAILURE',
      building: build.building,
      url: normalizeJenkinsUrl(build.url),
      branchName: context.branchName,
      publishChannel: context.publishChannel,
      appVersion: context.appVersion,
      commitHash: context.commitHash,
    }, analysis);

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

router.get('/nn/quality/local-artifact', cicdTestReleaseMiddleware, async (req: Request, res: Response) => {
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

router.get('/nn/quality/artifact-preview', cicdTestReleaseMiddleware, async (req: Request, res: Response) => {
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

router.get('/nn/quality/performance-samples', cicdTestReleaseMiddleware, async (req: Request, res: Response) => {
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

router.get('/nn/quality/builds', cicdTestReleaseMiddleware, async (req: Request, res: Response) => {
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
	    const qualityStatusOf = (build: any) => String(build.qualitySummary?.status || build.qualitySummary?.progress?.status || '').toLowerCase();
	    const success = builds.filter((build: any) => ['passed', 'success'].includes(qualityStatusOf(build)) || (!qualityStatusOf(build) && build.result === 'SUCCESS')).length;
	    const finished = builds.filter((build: any) => !build.building && (build.result || qualityStatusOf(build))).length;

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

router.get('/nn/quality/sonic/status', cicdTestReleaseMiddleware, async (_req: Request, res: Response) => {
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

router.get('/nn/quality/sonic/device-pools', cicdTestReleaseMiddleware, async (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: getQualityDevicePools(),
  });
});

router.get('/nn/quality/sonic/device-pools/status', cicdTestReleaseMiddleware, async (_req: Request, res: Response) => {
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

router.put('/nn/quality/sonic/device-pools', cicdAdminMiddleware, async (req: Request, res: Response) => {
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

router.post('/nn/quality/job/sync', cicdAdminMiddleware, async (_req: Request, res: Response) => {
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

router.post('/nn/release-gate/preview', cicdReleaseMiddleware, async (req: Request, res: Response) => {
  try {
    const gateBuildNumber = Number(req.body?.gateBuildNumber);
    const branch = normalizeBranchName(String(req.body?.branch || ''));
    const data = await jenkinsAssistantService.previewReleaseGate({ gateBuildNumber, branch });
    res.json({
      success: true,
      data: publicJenkinsUrlsInValue(req, data),
    });
  } catch (error: any) {
    const status = error instanceof JenkinsReleaseError ? error.statusCode : 502;
    res.status(status).json({
      success: false,
      error: extractErrorMessage(error, '发布质量门禁预检失败'),
      ...(error instanceof JenkinsReleaseError && error.data ? { data: error.data } : {}),
    });
  }
});

router.post('/nn/app-store/release-guard', cicdProductReleaseMiddleware, async (req: Request, res: Response) => {
  try {
    const branch = normalizeBranchName(String(req.body?.branch || ''));
    if (!isReleaseBranch(branch)) {
      res.status(400).json({
        success: false,
        error: '苹果商店发布仅允许 release/x.x.x 分支',
      });
      return;
    }
    const guard = await checkAppStoreReleaseBlocker(branch);
    res.json({
      success: true,
      data: guard,
      message: guard.message,
    });
  } catch (error: any) {
    const status = error instanceof JenkinsReleaseError ? error.statusCode : 502;
    res.status(status).json({
      success: false,
      error: extractErrorMessage(error, '检查苹果商店版本状态失败'),
      status: error.response?.status || status,
      ...(error instanceof JenkinsReleaseError && error.data ? { data: error.data } : {}),
    });
  }
});

router.post('/nn/release/preflight', cicdReleaseMiddleware, async (req: Request, res: Response) => {
  try {
    const data = await buildReleasePreflight({
      branch: String(req.body?.branch || ''),
      deployTarget: String(req.body?.deployTarget || 'Pgyer'),
      appVersion: String(req.body?.appVersion || '').trim(),
      gateBuildNumber: req.body?.gateBuildNumber ? Number(req.body.gateBuildNumber) : undefined,
      testFlightWhatsNew: String(req.body?.testFlightWhatsNew || '').trim(),
    });
    res.status(data.passed ? 200 : 409).json({
      success: data.passed,
      data,
      error: data.passed ? undefined : data.blockers.map((item: any) => item.message).join('；'),
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: extractErrorMessage(error, '发布前预检失败'),
      status: error.response?.status,
    });
  }
});

router.get('/nn/cicd/health', cicdReleaseMiddleware, async (_req: Request, res: Response) => {
  const checks: any[] = [];
  const startedAt = Date.now();
  try {
    await fetchJenkinsJobJson(encodeJobPath(DEFAULT_JOB_NAME), 'displayName,buildable,color');
    checks.push(buildReleasePreflightCheck('jenkins', 'Jenkins', 'passed', 'Jenkins 主 Job 可访问'));
  } catch (error: any) {
    checks.push(buildReleasePreflightCheck('jenkins', 'Jenkins', 'blocked', extractErrorMessage(error, 'Jenkins 主 Job 不可访问')));
  }

  const ascStatus = ascConfigStatus();
  checks.push(buildReleasePreflightCheck(
    'asc',
    'App Store Connect',
    ascStatus.configured && (!ascStatus.keyPathConfigured || ascStatus.keyFileExists) ? 'passed' : 'warning',
    ascStatus.configured
      ? (ascStatus.keyFileExists ? 'ASC API 配置已就绪' : 'ASC API Key 文件路径不存在')
      : 'ASC API 配置不完整，TestFlight/App Store 自动化不可用',
    ascStatus,
  ));

  const pgyerStatus = pgyerConfigStatus();
  checks.push(buildReleasePreflightCheck(
    'pgyer',
    '蒲公英',
    pgyerStatus.apiKeyConfigured ? 'passed' : 'warning',
    pgyerStatus.apiKeyConfigured
      ? (pgyerStatus.platformApiKeyConfigured ? '平台已配置蒲公英 API Key' : 'Jenkins build_config 已配置蒲公英 API Key')
      : '未配置 PGYER_API_KEY',
    pgyerStatus,
  ));

  checks.push(buildReleasePreflightCheck(
    'data_dir',
    '平台数据目录',
    fs.existsSync(DATA_DIR) ? 'passed' : 'warning',
    fs.existsSync(DATA_DIR) ? `数据目录可访问：${DATA_DIR}` : `数据目录不存在，将在写入时创建：${DATA_DIR}`,
  ));

  const qualityPools = getQualityDevicePools();
  checks.push(buildReleasePreflightCheck(
    'device_pools',
    '质检设备池',
    Array.isArray(qualityPools) && qualityPools.length > 0 ? 'passed' : 'warning',
    Array.isArray(qualityPools) && qualityPools.length > 0 ? `已配置 ${qualityPools.length} 个设备池` : '未配置质检设备池',
  ));

  const privatePodSync = privatePodSyncConfigStatus();
  checks.push(buildReleasePreflightCheck(
    'private_pod_sync',
    '私有组件同步',
    privatePodSync.skipRemoteCheck ? 'blocked' : (privatePodSync.ttlSeconds > 0 ? 'warning' : 'passed'),
    privatePodSync.skipRemoteCheck
      ? 'SKIP_POD_REMOTE_CHECK=true，会跳过私有组件远端 HEAD 检查，发布包可能复用旧组件'
      : (privatePodSync.ttlSeconds > 0
        ? `POD_HEAD_CHECK_TTL_SECONDS=${privatePodSync.ttlSeconds}，短时间内可能无法感知组件新提交`
        : '每次构建都会检查私有组件远端 HEAD'),
    privatePodSync,
  ));

  const blockers = checks.filter((check) => check.status === 'blocked');
  const warnings = checks.filter((check) => check.status === 'warning');
  res.json({
    success: blockers.length === 0,
    data: {
      healthy: blockers.length === 0,
      blockers,
      warnings,
      checks,
      checkedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
    },
  });
});

router.post('/nn/build', adminOnlyAppleReleaseMiddleware, async (req: Request, res: Response) => {
  let releaseOrder: any = null;
  try {
    const gateBuildNumberValue = req.body?.gateBuildNumber;
    const hasReleaseGate = gateBuildNumberValue !== undefined && gateBuildNumberValue !== null && String(gateBuildNumberValue).trim() !== '';
    const deployTarget = String(req.body?.deployTarget || 'Pgyer') as 'Pgyer' | 'TestFlight' | 'AppStore';
    const branch = String(req.body?.branch || 'develop');
    const preflight = await buildReleasePreflight({
      branch,
      deployTarget,
      appVersion: String(req.body?.appVersion || '').trim(),
      gateBuildNumber: hasReleaseGate ? Number(gateBuildNumberValue) : undefined,
      testFlightWhatsNew: String(req.body?.testFlightWhatsNew || '').trim(),
    });
    if (!preflight.passed) {
      throw new JenkinsReleaseError(preflight.blockers.map((item: any) => item.message).join('；'), 400, { preflight });
    }
    releaseOrder = createReleaseOrder({
      branch,
      deployTarget,
      appVersion: String(req.body?.appVersion || '').trim(),
      gateBuildNumber: hasReleaseGate ? Number(gateBuildNumberValue) : undefined,
      releaseGateOverrideReason: String(req.body?.releaseGateOverrideReason || '').trim(),
      releaseNotes: String(req.body?.testFlightWhatsNew || '').trim(),
      status: 'preflight_passed',
      phase: 'preflight_passed',
    });
    saveReleaseOrder(releaseOrder.id, {
      status: 'queued',
      phase: 'jenkins_queued',
    }, releaseOrderEvent('release.preflight_passed', '发布前预检通过', 'success'));
    if (normalizeDeployTarget(deployTarget) === 'AppStore') {
      const guard = await checkAppStoreReleaseBlocker(branch);
      if (guard.blocked) {
        throw new JenkinsReleaseError(guard.message, 409, { appStoreReleaseGuard: guard });
      }
      await assertAppStoreReleasePreconditions(
        branch,
        String(req.body?.appVersion || '').trim(),
        hasReleaseGate ? Number(gateBuildNumberValue) : undefined,
      );
    }
    const data = await jenkinsAssistantService.triggerRelease({
      branch,
      deployTarget,
      appVersion: String(req.body?.appVersion || '').trim(),
      verificationPassword: String(req.body?.verificationPassword || ''),
      gateBuildNumber: hasReleaseGate ? Number(gateBuildNumberValue) : undefined,
      releaseGateOverrideReason: String(req.body?.releaseGateOverrideReason || '').trim(),
      testFlightWhatsNew: String(req.body?.testFlightWhatsNew || '').trim(),
    });
    if (releaseOrder?.id) {
      releaseOrder = saveReleaseOrder(releaseOrder.id, {
        jenkinsQueueUrl: data?.queueUrl || data?.url || '',
        status: 'queued',
        phase: 'jenkins_queued',
      }, releaseOrderEvent('release.jenkins_queued', '已触发 Jenkins 发布', 'processing', data?.queueUrl || data?.url || ''));
    }
    if (normalizeDeployTarget(deployTarget) !== 'Pgyer') {
      saveReleaseRequestArchive({
        branch,
        deployTarget,
        releaseNotes: String(req.body?.testFlightWhatsNew || '').trim(),
        queueUrl: data?.queueUrl || '',
      });
    }

    res.json({
      success: true,
      data: publicJenkinsUrlsInValue(req, {
        ...data,
        releaseOrder,
      }),
    });
  } catch (error: any) {
    if (releaseOrder?.id) {
      saveReleaseOrder(releaseOrder.id, {
        status: 'failed',
        phase: 'trigger_failed',
        failureReason: extractErrorMessage(error, '触发 Jenkins 发布失败'),
      }, releaseOrderEvent('release.trigger_failed', '触发发布失败', 'error', extractErrorMessage(error, '触发 Jenkins 发布失败')));
    }
    const status = error instanceof JenkinsReleaseError ? error.statusCode : 502;
    res.status(status).json({
      success: false,
      error: extractErrorMessage(error, '触发 Jenkins 发布失败'),
      status: error.response?.status || status,
      ...(error instanceof JenkinsReleaseError && error.data ? { data: error.data } : {}),
    });
  }
});

router.post('/nn/release-branch', cicdDeveloperMiddleware, async (req: Request, res: Response) => {
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
        command: `mgit ${buildMgitPublishArgs(targetBranch, baseBranch).join(' ')}`,
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
    await runMgit(buildMgitPublishArgs(targetBranch, baseBranch));

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

router.post('/nn/builds/:number/stop', cicdTestReleaseMiddleware, async (req: Request, res: Response) => {
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

router.post('/nn/quality/builds/:number/stop', cicdTestReleaseMiddleware, async (req: Request, res: Response) => {
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

router.post('/nn/quality/wda/cleanup', cicdTestReleaseMiddleware, async (req: Request, res: Response) => {
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

router.post('/nn/quality', cicdTestReleaseMiddleware, async (req: Request, res: Response) => {
  try {
    const jobPath = encodeJobPath(DEFAULT_QA_JOB_NAME);
    const sonicConfig = getSonicConfig();
    const buildNumber = String(req.body?.buildNumber || '').trim();
    let branch = normalizeBranchName(String(req.body?.branch || ''));
    let commitHash = String(req.body?.commitHash || '').trim();
    let appVersion = String(req.body?.appVersion || '').trim();
    let rawPackageUrl = resolveSourceBuildArtifactPath(String(req.body?.packageUrl || '').trim());
    let xcarchivePath = String(req.body?.xcarchivePath || '').trim();
    let archiveUrl = String(req.body?.archiveUrl || '').trim();
    let publishChannel = normalizeDeployTarget(String(req.body?.publishChannel || req.body?.deployTarget || ''));
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
    let businessFlowPlan: any = null;
    if (testSuite === 'business_flow') {
      try {
        businessFlowPlan = normalizeBusinessFlowPlan(req.body?.businessFlowPlan || req.body?.businessFlow || {});
      } catch (error: any) {
        res.status(400).json({
          success: false,
          error: error?.message || '业务编排配置无效',
        });
        return;
      }
    }
    const timedQualitySuite = testSuite === 'monkey' || testSuite === 'stutter' || testSuite === 'business_flow';
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
    if (!appVersion || !rawPackageUrl || !xcarchivePath || !archiveUrl || !publishChannel || !commitHash) {
      const sourceMetadata = await fetchBuildConsoleMetadata(encodeJobPath(DEFAULT_JOB_NAME), Number(buildNumber));
      appVersion = appVersion || sourceMetadata.appVersion || '';
      publishChannel = publishChannel || sourceMetadata.publishChannel || '';
      commitHash = commitHash || sourceMetadata.commitHash || '';
      rawPackageUrl = rawPackageUrl || sourceMetadata.installPackageUrl || sourceMetadata.packageUrl || '';
      xcarchivePath = xcarchivePath || sourceMetadata.xcarchivePath || '';
      archiveUrl = archiveUrl || sourceMetadata.archiveUrl || '';
    }
    const forceInstalledProductionApp = publishChannel === 'TestFlight' || publishChannel === 'AppStore';
    const skipInstall = forceInstalledProductionApp || req.body?.skipInstall === true || String(req.body?.skipInstall || '').trim() === '1';
    const defaultAppBundleId = skipInstall ? 'com.nnhuyu.im' : 'com.nndev.im';
    const appBundleId = String(req.body?.appBundleId || req.body?.bundleId || getRuntimeEnv('QA_APP_BUNDLE_ID') || defaultAppBundleId).trim();
    const packageUrl = skipInstall ? `skip-install:${appBundleId}` : rawPackageUrl;
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
    if (testSuite === 'business_flow') {
      try {
        await ensureQualityJenkinsJobConfigFresh();
      } catch (error: any) {
        res.status(502).json({
          success: false,
          error: `同步 Jenkins 质检 Job 配置失败：${extractErrorMessage(error, error?.message || 'unknown')}`,
        });
        return;
      }
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
    const platformTask = workflowService.upsertTask({
      taskType: `ios_${testSuite}`,
      suite: testSuite,
      status: 'created',
      source: 'jenkins',
      buildNumber,
      commitHash,
      branch,
      deviceUdid: deviceKey,
      progress: 0,
      config: { testSuite, devicePool, deviceKey, publishChannel, appVersion, skipInstall, businessFlowPlan },
    });
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
      QUALITY_RUNNER: testSuite === 'monkey' ? 'local-ios-device-monkey' : (testSuite === 'stutter' ? 'local-ios-device-stutter' : (testSuite === 'business_flow' ? 'local-ios-device-business-flow' : 'local-ios-device')),
      QA_RUNNER_MODE: testSuite === 'monkey' ? 'local-usb-monkey' : (testSuite === 'stutter' ? 'local-usb-stutter' : (testSuite === 'business_flow' ? 'local-usb-business-flow' : 'local-usb')),
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
      MONKEY_BUSINESS_AWARE: testSuite === 'monkey' || testSuite === 'business_flow' ? (getRuntimeEnv('QA_MONKEY_BUSINESS_AWARE') || '1') : '0',
      MONKEY_BUSINESS_MAP_PATH: monkeyBusinessMapPath,
      MONKEY_BUSINESS_DOMAINS: businessFlowPlan?.targetDomains?.join(',') || getRuntimeEnv('QA_MONKEY_BUSINESS_DOMAINS') || 'login,im,community,voice_room,profile,playwith',
      MONKEY_GUARDED_ACTION_POLICY: businessFlowPlan?.riskPolicy || getRuntimeEnv('QA_MONKEY_GUARDED_ACTION_POLICY') || 'read_only',
      BUSINESS_FLOW_PLAN_JSON: businessFlowPlan ? JSON.stringify(businessFlowPlan) : '',
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
      PLATFORM_TASK_ID: String(platformTask?.id || ''),
      // 兼容仍在使用旧 Jenkins 参数或 Sonic 任务脚本的环境。
      SONIC_DEVICE_GROUP_ID: selectedDevicePool.groupId || '',
      SONIC_API_BASE: sonicConfig.apiBase,
      SONIC_PROJECT_ID: sonicConfig.projectId,
      SONIC_TEST_PLAN_ID: sonicConfig.testPlanId,
    });

    const queueResponse = await axios.post(`${JENKINS_BASE_URL}/${jobPath}/buildWithParameters`, params.toString(), {
      timeout: 30000,
      headers: {
        ...crumb.headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      ...buildAuthConfig(),
    });
    const queuedTask = workflowService.upsertTask({
      id: platformTask?.id,
      taskType: `ios_${testSuite}`,
      suite: testSuite,
      status: 'queued',
      source: 'jenkins',
      externalId: String(queueResponse.headers.location || ''),
      externalUrl: normalizeJenkinsUrl(queueResponse.headers.location || ''),
      buildNumber,
      commitHash,
      branch,
      deviceUdid: deviceKey,
      progress: 0,
      config: { testSuite, devicePool, deviceKey, publishChannel, appVersion, skipInstall, businessFlowPlan },
    });

    res.json({
      success: true,
      data: publicJenkinsUrlsInValue(req, {
        jobName: DEFAULT_QA_JOB_NAME,
        sourceBuildNumber: buildNumber,
        testSuite,
        devicePool,
        platformTaskId: queuedTask?.id,
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

startReleaseStatusSyncer();

export default router;
