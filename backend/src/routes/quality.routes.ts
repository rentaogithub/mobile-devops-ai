import '../config/env';
import { Router, Request, Response } from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const router = Router();

const JENKINS_BASE_URL = (process.env.JENKINS_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const DEFAULT_JOB_NAME = process.env.JENKINS_NN_JOB || 'nn';
const DEFAULT_QA_JOB_NAME = process.env.JENKINS_NN_QA_JOB || 'nn-auto-quality';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '..', 'nn-ios-platform-data');
const QUALITY_DEVICE_POOLS_CONFIG_PATH = path.join(DATA_DIR, 'quality-device-pools.json');
const LEGACY_SONIC_DEVICE_POOLS_CONFIG_PATH = path.join(DATA_DIR, 'sonic-device-pools.json');
const LOCAL_ARTIFACT_ROUTE = '/api/quality/artifacts/local';
const ACTIVE_TASK_STATUSES = new Set(['created', 'queued', 'preparing', 'installing', 'running', 'collecting', 'analyzing', 'reporting', 'notifying']);
const QUALITY_ORPHAN_TASK_STALE_MS = Number(process.env.JENKINS_ORPHAN_BUILD_STALE_MS || 10 * 60 * 1000);

const DEFAULT_QUALITY_DEVICE_POOLS = [
  { label: 'iOS 默认设备池', value: 'ios-default', description: '打包机当前可用 USB iOS 真机。' },
  { label: 'iPhone 新系统池', value: 'ios-latest', description: '较新 iOS 系统真机。' },
  { label: 'iPhone 兼容性池', value: 'ios-compat', description: '兼容性回归真机。' },
];

function encodeJobPath(jobName: string) {
  return jobName.split('/').filter(Boolean).map((part) => `job/${encodeURIComponent(part)}`).join('/');
}

function buildAuthConfig() {
  const username = process.env.JENKINS_USER || '';
  const token = process.env.JENKINS_TOKEN || '';
  return username && token ? { auth: { username, password: token } } : {};
}

async function getCrumb() {
  try {
    const response = await axios.get(`${JENKINS_BASE_URL}/crumbIssuer/api/json`, {
      timeout: 10000,
      ...buildAuthConfig(),
    });
    if (response.data?.crumbRequestField && response.data?.crumb) {
      return { headers: { [response.data.crumbRequestField]: response.data.crumb } };
    }
  } catch {
    // Jenkins may not have crumb issuer enabled.
  }
  return { headers: {} };
}

function localJenkinsJobDir(jobName: string) {
  const jenkinsHome = process.env.JENKINS_HOME || path.join(process.env.HOME || '', '.jenkins');
  const parts = jobName.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  let jobDir = path.join(jenkinsHome, 'jobs', parts[0]);
  for (const part of parts.slice(1)) jobDir = path.join(jobDir, 'jobs', part);
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

function getQualityDevicePools() {
  try {
    const configPath = fs.existsSync(QUALITY_DEVICE_POOLS_CONFIG_PATH)
      ? QUALITY_DEVICE_POOLS_CONFIG_PATH
      : LEGACY_SONIC_DEVICE_POOLS_CONFIG_PATH;
    if (!fs.existsSync(configPath)) return DEFAULT_QUALITY_DEVICE_POOLS;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const pools = (Array.isArray(config?.devicePools) ? config.devicePools : [])
      .map((pool: any) => ({
        ...pool,
        devices: (Array.isArray(pool?.devices) ? pool.devices : [])
          .map((device: any) => ({
            label: String(device?.label || '').trim() || undefined,
            udid: String(device?.udid || device?.deviceId || device?.value || '').trim(),
            description: String(device?.description || '').trim() || undefined,
          }))
          .filter((device: any) => device.udid),
      }));
    return pools.length > 0 ? pools : DEFAULT_QUALITY_DEVICE_POOLS;
  } catch {
    return DEFAULT_QUALITY_DEVICE_POOLS;
  }
}

function getPlatformRootDir() {
  const configured = String(process.env.NN_IOS_PLATFORM_DIR || '').trim();
  if (configured) return configured;
  const candidates = [process.cwd(), path.resolve(process.cwd(), '..')];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'scripts/sonic/ios-quality.sh'))) || process.cwd();
}

function isPathInside(parentDir: string, candidatePath: string) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isAllowedArtifact(filePath: string) {
  return localJenkinsWorkspaceDirs(DEFAULT_QA_JOB_NAME).some((workspaceDir) => isPathInside(path.join(workspaceDir, 'quality-results'), filePath)) ||
    isPathInside(path.join(localJenkinsJobDir(DEFAULT_QA_JOB_NAME), 'builds'), filePath);
}

function localArtifactUrl(filePath: string) {
  return `${LOCAL_ARTIFACT_ROUTE}?path=${encodeURIComponent(filePath)}`;
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

function deviceKeyFromPool(pool: any, fallback: string) {
  return String(pool?.deviceId || pool?.groupId || fallback || '').trim();
}

function deviceKeysFromPool(pool: any, fallback: string) {
  const keys: string[] = (Array.isArray(pool?.devices) ? pool.devices : [])
    .map((device: any) => String(device?.udid || '').trim())
    .filter(Boolean);
  const legacyKey = deviceKeyFromPool(pool, '');
  if (legacyKey) keys.push(legacyKey);
  return Array.from(new Set<string>(keys)).filter(Boolean).concat(keys.length === 0 ? [fallback] : []);
}

function deriveWdaPort(deviceKey: string, poolValue: string) {
  const configured = Number(process.env.QA_WDA_BASE_PORT || 8100);
  const basePort = Number.isFinite(configured) && configured > 0 ? configured : 8100;
  const key = deviceKey || poolValue || 'ios-default';
  return basePort + (hashText(key) % 200);
}

function buildWdaUrl(deviceKey: string, poolValue: string) {
  const explicitUrl = String(process.env.QA_WDA_URL || '').trim();
  if (explicitUrl && explicitUrl !== 'http://127.0.0.1:8100') return explicitUrl;
  return `http://127.0.0.1:${deriveWdaPort(deviceKey, poolValue)}`;
}

function normalizeTaskId(value: string) {
  const text = String(value || '').trim();
  const buildNumber = Number(text.match(/(?:jenkins:)?(?:nn-auto-quality:)?(\d+)$/)?.[1] || text.match(/^qa-(\d+)-/)?.[1] || text);
  return Number.isFinite(buildNumber) && buildNumber > 0 ? buildNumber : 0;
}

function findBuildQualityFile(buildNumber: number, fileName: string) {
  const buildArchiveDir = path.join(localJenkinsJobDir(DEFAULT_QA_JOB_NAME), 'builds', String(buildNumber), 'archive', 'quality-results');
  const workspaceResultsDirs = localJenkinsWorkspaceDirs(DEFAULT_QA_JOB_NAME).map((workspaceDir) => path.join(workspaceDir, 'quality-results'));
  const candidates: string[] = [];
  for (const root of [buildArchiveDir, ...workspaceResultsDirs]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(`qa-${buildNumber}-`)) candidates.push(path.join(root, entry.name, fileName));
    }
  }
  const existing = candidates.filter((candidate) => fs.existsSync(candidate));
  existing.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return existing[0] || '';
}

function findBuildSummaryFile(buildNumber: number) {
  return findBuildQualityFile(buildNumber, 'summary.json');
}

function parseResultDirName(filePath: string) {
  const dirName = path.basename(path.dirname(filePath || ''));
  const match = dirName.match(/^qa-(\d+)-(.+)-([^-]+)$/);
  if (!match) return { sourceBuild: '', suite: '' };
  return { sourceBuild: match[2], suite: match[3] };
}

function readBuildLog(buildNumber: number) {
  const logPath = path.join(localJenkinsJobDir(DEFAULT_QA_JOB_NAME), 'builds', String(buildNumber), 'log');
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
}

function parseLogField(logText: string, pattern: RegExp) {
  return logText.match(pattern)?.[1]?.trim() || '';
}

function artifactLinksFromSummary(summaryFile: string, summary: any) {
  const dir = path.dirname(summaryFile);
  const artifactPath = (name?: string) => (name ? path.join(dir, name) : '');
  const artifactUrl = (name?: string) => {
    const filePath = artifactPath(name);
    return filePath && fs.existsSync(filePath) ? localArtifactUrl(filePath) : '';
  };
  const summaryUrl = artifactUrl('summary.json');
  return {
    report_url: artifactUrl('report.html') || summaryUrl,
    artifact_url: localArtifactUrl(dir),
    result_url: artifactUrl('result.json') || summaryUrl,
    issues_url: artifactUrl('issues.json'),
    summary_url: summaryUrl,
    summary_md_url: artifactUrl('summary.md'),
    screenshot_url: artifactUrl(summary?.artifacts?.screenshot || 'screenshot.png'),
    quality_log_url: artifactUrl(summary?.artifacts?.qualityLog || 'quality.log'),
    device_log_url: artifactUrl(summary?.artifacts?.deviceLog || 'device.log'),
    monkey_report_url: artifactUrl(summary?.artifacts?.monkeyReport),
    junit_url: artifactUrl(summary?.artifacts?.junit || 'junit.xml'),
  };
}

function summarizeIssues(summary: any) {
  const issues: any[] = [];
  const exception = summary?.exceptionAnalysis || {};
  const crashReports = exception?.crashReports || {};
  for (const sample of crashReports.samples || []) {
    const title = sample.exception || sample.process || sample.file || 'Crash report';
    issues.push({
      id: `issue_${issues.length + 1}`,
      type: 'crash',
      severity: 'blocker',
      title,
      fingerprint: ['crash', sample.process, sample.exception, sample.reason].filter(Boolean).join('|') || title,
      is_new: false,
      count: 1,
      screen: '',
      artifact_refs: { stack: sample.file },
    });
  }
  for (const issue of summary?.performanceAnalysis?.conclusion?.issues || []) {
    issues.push({
      id: `issue_${issues.length + 1}`,
      type: 'performance',
      severity: issue.severity === 'failed' ? 'blocker' : 'warning',
      title: issue.message || issue.metric || 'Performance issue',
      fingerprint: ['performance', issue.metric, issue.message].filter(Boolean).join('|'),
      is_new: false,
      count: 1,
      screen: '',
      artifact_refs: {},
    });
  }
  return issues;
}

function mapBuildToTask(buildNumber: number) {
  const buildDir = path.join(localJenkinsJobDir(DEFAULT_QA_JOB_NAME), 'builds', String(buildNumber));
  const buildXml = fs.existsSync(path.join(buildDir, 'build.xml'))
    ? fs.readFileSync(path.join(buildDir, 'build.xml'), 'utf-8')
    : '';
  const result = readXmlTag(buildXml, 'result');
  const summaryFile = findBuildSummaryFile(buildNumber);
  const progressFile = summaryFile ? path.join(path.dirname(summaryFile), 'quality-progress.json') : findBuildQualityFile(buildNumber, 'quality-progress.json');
  const resultDirMeta = parseResultDirName(summaryFile || progressFile);
  const buildLog = buildXml ? '' : readBuildLog(buildNumber);
  const summary = summaryFile ? readJsonFile(summaryFile) : null;
  const resultJson = summaryFile ? readJsonFile(path.join(path.dirname(summaryFile), 'result.json')) : null;
  const progress = progressFile ? readJsonFile(progressFile) : null;
  const requestedSuite = summary?.testSuite ||
    readXmlParameter(buildXml, 'REQUESTED_TEST_SUITE') ||
    readXmlParameter(buildXml, 'TEST_SUITE') ||
    resultDirMeta.suite ||
    parseLogField(buildLog, /测试套件:\s*([^\n\r]+)/);
  const issues = resultJson?.issues || (summary ? summarizeIssues(summary) : []);
  const status = resultJson?.status || (
    result === 'ABORTED' ? 'canceled' :
      result === 'FAILURE' ? 'failed' :
        result === 'UNSTABLE' ? 'unstable' :
          result === 'SUCCESS' ? 'success' :
            'running'
  );
  const links = summaryFile ? artifactLinksFromSummary(summaryFile, summary) : {};
  const sourceBuild = summary?.sourceBuildNumber ||
    readXmlParameter(buildXml, 'SOURCE_BUILD_NUMBER') ||
    resultDirMeta.sourceBuild ||
    parseLogField(buildLog, /源构建:\s*([^\n\r]+)/);
  const deviceUdid = summary?.deviceUdid ||
    readXmlParameter(buildXml, 'DEVICE_UDID') ||
    readXmlParameter(buildXml, 'DEVICE_SELECTOR') ||
    parseLogField(buildLog, /使用设备:\s*([^\n\r]+)/);
  const wdaUrl = summary?.wdaUrl ||
    readXmlParameter(buildXml, 'WDA_URL') ||
    parseLogField(buildLog, /WDA 已可访问:\s*([^\s\n\r]+)/) ||
    parseLogField(buildLog, /WDA 当前不可访问:\s*([^\s\n\r]+)/);
  const task = {
    task_id: `jenkins:${DEFAULT_QA_JOB_NAME}:${buildNumber}`,
    task_type: requestedSuite === 'monkey' ? 'ios_monkey' : `ios_${requestedSuite || 'quality'}`,
    status,
    progress: progress?.progressPercent ?? (status === 'running' ? 0 : 100),
    progress_updated_at: progress?.updatedAt,
    project_id: 'nn-ios',
    app_name: 'NNIM',
    app_version: summary?.appVersion || readXmlParameter(buildXml, 'APP_VERSION'),
    build: sourceBuild,
    created_by: 'jenkins',
    created_at: new Date(Number(readXmlTag(buildXml, 'timestamp')) || fs.statSync(buildDir).mtimeMs).toISOString(),
    started_at: null,
    finished_at: result ? new Date((Number(readXmlTag(buildXml, 'timestamp')) || 0) + (Number(readXmlTag(buildXml, 'duration')) || 0)).toISOString() : null,
    config: {
      duration_minutes: Math.round(Number(progress?.requestedDurationSeconds || 0) / 60) || undefined,
      seed: summary?.monkeySeed || readXmlParameter(buildXml, 'MONKEY_SEED') || undefined,
      max_actions: summary?.monkeyEventCount,
      device_pool: summary?.devicePool || readXmlParameter(buildXml, 'DEVICE_POOL') || parseLogField(buildLog, /设备池:\s*[^(]*\(([^)]+)\)/),
      device_udid: deviceUdid || undefined,
      wda_url: wdaUrl || undefined,
      blacklist_profile: 'default',
    },
    result: {
      passed: summary?.status === 'passed' && issues.filter((issue: any) => issue.severity === 'blocker').length === 0,
      crash_count: summary?.exceptionAnalysis?.crashCount || 0,
      oom_count: summary?.exceptionAnalysis?.memoryIssueCount || 0,
      stuck_count: summary?.exceptionAnalysis?.watchdogCount || 0,
      white_screen_count: summary?.screenAnalysis?.whiteScreenCount || 0,
      duration_seconds: Math.round((summary?.performanceAnalysis?.monkeyDurationMs || 0) / 1000) || undefined,
      total_actions: summary?.monkeyExecutedEvents || summary?.performanceAnalysis?.monkeyExecutedEvents || 0,
      report_url: (links as any).report_url,
      artifact_url: (links as any).artifact_url,
    },
    summary,
    issues,
    links,
  };
  return task;
}

function listAllLocalMonkeyTasks() {
  const buildsDir = path.join(localJenkinsJobDir(DEFAULT_QA_JOB_NAME), 'builds');
  if (!fs.existsSync(buildsDir)) return [];
  return fs.readdirSync(buildsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => b - a)
    .map(mapBuildToTask)
    .filter((task) => task.task_type === 'ios_monkey');
}

function isActiveTask(task: any) {
  if (!ACTIVE_TASK_STATUSES.has(String(task?.status || ''))) return false;
  const updatedAt = Number(task?.progress_updated_at || 0);
  if (updatedAt > 0 && Date.now() - updatedAt > QUALITY_ORPHAN_TASK_STALE_MS) return false;
  const createdAt = Date.parse(String(task?.created_at || ''));
  if (!updatedAt && Number.isFinite(createdAt) && Date.now() - createdAt > QUALITY_ORPHAN_TASK_STALE_MS) return false;
  return true;
}

function listLocalTasks() {
  const tasks = listAllLocalMonkeyTasks();
  const activeTasks = tasks.filter(isActiveTask);
  const latestCompletedTask = tasks.find((task) => !isActiveTask(task));
  return latestCompletedTask ? [...activeTasks, latestCompletedTask] : activeTasks;
}

function findActiveTaskOnDevice(deviceKey: string) {
  if (!deviceKey) return null;
  return listAllLocalMonkeyTasks().find((task: any) => {
    if (!isActiveTask(task)) return false;
    const taskDevice = String(task?.config?.device_udid || task?.summary?.deviceUdid || '').trim();
    return taskDevice && taskDevice === deviceKey;
  }) || null;
}

function selectAvailableDeviceFromPool(pool: any, fallback: string) {
  const deviceKeys = deviceKeysFromPool(pool, fallback);
  for (const deviceKey of deviceKeys) {
    const activeTask = findActiveTaskOnDevice(deviceKey);
    if (!activeTask) return { deviceKey, activeTask: null, deviceKeys };
  }
  const firstDeviceKey = deviceKeys[0] || fallback;
  return { deviceKey: firstDeviceKey, activeTask: findActiveTaskOnDevice(firstDeviceKey), deviceKeys };
}

async function triggerJenkinsMonkey(payload: any) {
  const app = payload.app || {};
  const monkey = payload.monkey || {};
  const devicePool = String(monkey.device_pool || payload.devicePool || 'ios-default').trim();
  const pool = getQualityDevicePools().find((item: any) => item.value === devicePool) || getQualityDevicePools()[0];
  const selectedDevice = selectAvailableDeviceFromPool(pool, devicePool);
  const deviceKey = selectedDevice.deviceKey;
  if (selectedDevice.activeTask) {
    throw new Error(`设备池 ${devicePool} 内设备均被占用，当前设备 ${deviceKey} 已被任务 ${selectedDevice.activeTask.task_id} 占用，请选择其他设备池或等待任务结束`);
  }
  const sourceBuild = String(app.build || payload.buildNumber || payload.sourceBuildNumber || '').trim();
  if (!sourceBuild) throw new Error('app.build 或 buildNumber 不能为空');
  const durationMinutes = Number(monkey.duration_minutes || payload.durationMinutes || 120);
  const durationSeconds = Math.max(1, Math.round(durationMinutes * 60));
  const wdaUrl = buildWdaUrl(deviceKey, devicePool);
  const jobPath = encodeJobPath(DEFAULT_QA_JOB_NAME);
  const crumb = await getCrumb();
  const params = new URLSearchParams({
    SOURCE_JOB: DEFAULT_JOB_NAME,
    SOURCE_BUILD_NUMBER: sourceBuild,
    BRANCH: String(payload.branch || app.branch || ''),
    COMMIT_HASH: String(payload.commitHash || app.commit_hash || ''),
    APP_VERSION: String(app.version || payload.appVersion || ''),
    PACKAGE_URL: String(app.ipa_url || payload.packageUrl || ''),
    XCARCHIVE_PATH: String(app.xcarchive_path || payload.xcarchivePath || ''),
    ARCHIVE_URL: String(app.archive_url || payload.archiveUrl || ''),
    TEST_SUITE: 'smoke',
    REQUESTED_TEST_SUITE: 'monkey',
    RUN_MONKEY: '1',
    DEVICE_POOL: devicePool,
    DEVICE_POOL_LABEL: `${pool.label || devicePool} [suite:monkey]`,
    DEVICE_UDID: deviceKey,
    DEVICE_SELECTOR: deviceKey,
    DEVICE_CLOUD: 'LocalMac',
    QUALITY_TASK_TYPE: 'ios_monkey',
    QUALITY_RUNNER: 'local-ios-device-monkey',
    QA_RUNNER_MODE: 'local-usb-monkey',
    APP_BUNDLE_ID: String(app.bundle_id || process.env.QA_APP_BUNDLE_ID || 'com.nndev.im'),
    WDA_URL: wdaUrl,
    WDA_AUTO_START: String(process.env.QA_WDA_AUTO_START || '1'),
    WDA_AUTO_INSTALL: String(process.env.QA_WDA_AUTO_INSTALL || '1'),
    WDA_PROJECT_PATH: String(process.env.QA_WDA_PROJECT_PATH || ''),
    WDA_START_TIMEOUT_SECONDS: String(process.env.QA_WDA_START_TIMEOUT_SECONDS || '300'),
    WDA_DEVELOPMENT_TEAM: String(process.env.QA_WDA_DEVELOPMENT_TEAM || ''),
    WDA_BUNDLE_ID: String(process.env.QA_WDA_BUNDLE_ID || ''),
    WDA_DERIVED_DATA_PATH: path.join(localJenkinsWorkspaceDir(DEFAULT_QA_JOB_NAME), 'quality-cache', 'wda-derived-data', sanitizeToken(deviceKey || devicePool)),
    WDA_XCODEBUILD_EXTRA_ARGS: String(process.env.QA_WDA_XCODEBUILD_EXTRA_ARGS || ''),
    MONKEY_DURATION_SECONDS: String(durationSeconds),
    MONKEY_EVENT_COUNT: String(monkey.max_actions || process.env.QA_MONKEY_EVENT_COUNT || '30'),
    MONKEY_SEED: monkey.seed ? String(monkey.seed) : '',
    MONKEY_INTERVAL_SECONDS: String(monkey.interval_seconds || process.env.QA_MONKEY_INTERVAL_SECONDS || '0.35'),
    MONKEY_FORBIDDEN_TEXTS: String(monkey.text_blacklist || process.env.QA_MONKEY_FORBIDDEN_TEXTS || ''),
    MONKEY_FORBIDDEN_PAGE_TEXTS: String(monkey.page_blacklist || process.env.QA_MONKEY_FORBIDDEN_PAGE_TEXTS || ''),
    NN_IOS_PLATFORM_DIR: getPlatformRootDir(),
  });

  const response = await axios.post(`${JENKINS_BASE_URL}/${jobPath}/buildWithParameters`, params.toString(), {
    timeout: 30000,
    headers: { ...crumb.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    validateStatus: (status) => status >= 200 && status < 400,
    ...buildAuthConfig(),
  });

  return {
    task_id: `jenkins:${DEFAULT_QA_JOB_NAME}:queued:${Date.now()}`,
    status: 'queued',
    queue_url: response.headers.location || '',
    job_url: `${JENKINS_BASE_URL}/${jobPath}/`,
  };
}

router.post('/tasks', async (req: Request, res: Response) => {
  try {
    const taskType = String(req.body?.task_type || '').trim();
    if (taskType !== 'ios_monkey') {
      res.status(400).json({ success: false, error: '当前仅支持 task_type=ios_monkey' });
      return;
    }
    const data = await triggerJenkinsMonkey(req.body);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(502).json({ success: false, error: error.message || '创建 Monkey 任务失败' });
  }
});

router.get('/tasks', (_req: Request, res: Response) => {
  res.json({ success: true, data: { tasks: listLocalTasks() } });
});

router.get('/tasks/:taskId', (req: Request, res: Response) => {
  const buildNumber = normalizeTaskId(req.params.taskId);
  if (!buildNumber) {
    res.status(404).json({ success: false, error: '任务不存在或仍在 Jenkins 队列中' });
    return;
  }
  res.json({ success: true, data: mapBuildToTask(buildNumber) });
});

router.get('/tasks/:taskId/issues', (req: Request, res: Response) => {
  const buildNumber = normalizeTaskId(req.params.taskId);
  if (!buildNumber) {
    res.status(404).json({ success: false, error: '任务不存在' });
    return;
  }
  const task = mapBuildToTask(buildNumber);
  res.json({ success: true, data: { task_id: task.task_id, issues: task.issues || [] } });
});

router.post('/tasks/:taskId/rerun', async (req: Request, res: Response) => {
  try {
    const buildNumber = normalizeTaskId(req.params.taskId);
    if (!buildNumber) throw new Error('任务不存在');
    const task = mapBuildToTask(buildNumber);
    const seedStrategy = String(req.body?.seed_strategy || 'reuse');
    const data = await triggerJenkinsMonkey({
      buildNumber: task.build,
      branch: task.summary?.branch,
      commitHash: task.summary?.commitHash,
      app: {
        version: task.app_version,
        bundle_id: task.summary?.bundleId || task.summary?.detectedBundleId,
      },
      monkey: {
        duration_minutes: task.config.duration_minutes || 120,
        seed: seedStrategy === 'new' ? '' : task.config.seed,
        max_actions: task.config.max_actions,
        device_pool: task.config.device_pool || 'ios-default',
      },
    });
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(502).json({ success: false, error: error.message || '重跑 Monkey 任务失败' });
  }
});

router.post('/tasks/:taskId/cancel', async (req: Request, res: Response) => {
  try {
    const buildNumber = normalizeTaskId(req.params.taskId);
    if (!buildNumber) throw new Error('任务不存在');
    const crumb = await getCrumb();
    await axios.post(`${JENKINS_BASE_URL}/${encodeJobPath(DEFAULT_QA_JOB_NAME)}/${buildNumber}/stop`, null, {
      timeout: 30000,
      headers: crumb.headers,
      ...buildAuthConfig(),
    });
    res.json({ success: true, data: { task_id: `jenkins:${DEFAULT_QA_JOB_NAME}:${buildNumber}`, status: 'canceled' } });
  } catch (error: any) {
    res.status(502).json({ success: false, error: error.message || '终止 Monkey 任务失败' });
  }
});

router.get('/artifacts/local', (req: Request, res: Response) => {
  const filePath = path.resolve(String(req.query.path || ''));
  if (!isAllowedArtifact(filePath) || !fs.existsSync(filePath)) {
    res.status(404).send('Not found');
    return;
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    res.type('text/plain').send(fs.readdirSync(filePath).join('\n'));
    return;
  }
  res.sendFile(filePath);
});

export default router;
