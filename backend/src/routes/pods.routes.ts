import { Router, Request, Response } from 'express';
import multer from 'multer';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import podService from '../services/PodService';
import logger from '../utils/logger';
import { adminMiddleware } from '../middleware/auth';

const router = Router();
const NNRTC_JENKINS_BASE_URL = (process.env.NNRTC_JENKINS_BASE_URL || 'http://10.1.3.177:8080').replace(/\/$/, '');
const NNRTC_JENKINS_JOB = process.env.NNRTC_JENKINS_JOB || 'nnrtc-ios-build';
const UPLOAD_DIR = process.env.UPLOAD_DIR || '../../nn-ios-platform-data/uploads';
const DATA_DIR = process.env.DATA_DIR || path.resolve(UPLOAD_DIR, '..');
const NNRTC_TASKS_PATH = process.env.NNRTC_POD_TASKS_PATH || path.join(DATA_DIR, 'nnrtc-pod-tasks.json');

type NNRtcTaskStatus = 'pending' | 'running' | 'success' | 'failed';
interface NNRtcTask {
  id: string;
  type: 'publish' | 'replace';
  status: NNRtcTaskStatus;
  progress: number;
  message: string;
  logs: string[];
  data?: any;
  warning?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const nnrtcTasks = new Map<string, NNRtcTask>();

function persistNNRtcTasks() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tasks = Array.from(nnrtcTasks.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100);
    fs.writeFileSync(NNRTC_TASKS_PATH, JSON.stringify({ tasks, updatedAt: Date.now() }, null, 2), 'utf-8');
  } catch (error: any) {
    logger.warn('保存 NNRtc Pod 任务失败', { error: error.message });
  }
}

function loadNNRtcTasks() {
  try {
    if (!fs.existsSync(NNRTC_TASKS_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(NNRTC_TASKS_PATH, 'utf-8'));
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    for (const item of tasks) {
      if (!item?.id) continue;
      const task: NNRtcTask = {
        id: String(item.id),
        type: item.type === 'replace' ? 'replace' : 'publish',
        status: ['pending', 'running', 'success', 'failed'].includes(item.status) ? item.status : 'failed',
        progress: Number(item.progress) || 0,
        message: String(item.message || ''),
        logs: Array.isArray(item.logs) ? item.logs.map(String) : [],
        data: item.data,
        warning: item.warning ? String(item.warning) : undefined,
        error: item.error ? String(item.error) : undefined,
        createdAt: Number(item.createdAt) || Date.now(),
        updatedAt: Number(item.updatedAt) || Date.now(),
      };
      if (task.status === 'pending' || task.status === 'running') {
        task.status = 'failed';
        task.progress = 100;
        task.error = '服务重启，任务已中断';
        task.message = '服务重启，任务已中断';
        task.logs.push(task.message);
        task.updatedAt = Date.now();
      }
      nnrtcTasks.set(task.id, task);
    }
    persistNNRtcTasks();
  } catch (error: any) {
    logger.warn('加载 NNRtc Pod 任务失败', { error: error.message });
  }
}

loadNNRtcTasks();

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '524288000'),
  },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    if (name.endsWith('.zip') || name.endsWith('.tgz') || name.endsWith('.tar.gz') ||
        name.endsWith('.framework') || name.endsWith('.a') ||
        file.mimetype === 'application/zip' || file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('仅支持 .zip、.tgz、.tar.gz、.framework、.a 格式文件'));
    }
  },
});

function requireTargetBranch(value: unknown): string {
  const targetBranch = String(value || '').trim();
  if (!targetBranch) {
    const error = new Error('同步到 nnios 分支不能为空') as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  return targetBranch;
}

function isNNRtcPackageFile(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  return lowerName.endsWith('.zip') || lowerName.endsWith('.tgz') || lowerName.endsWith('.tar.gz');
}

function isNNRtcTestVersion(version?: string) {
  return /(?:_test|-test)$/.test(String(version || ''));
}

function encodeJobPath(jobName: string) {
  return jobName
    .split('/')
    .filter(Boolean)
    .map((part) => `job/${encodeURIComponent(part)}`)
    .join('/');
}

function buildJenkinsAuthConfig() {
  const username = process.env.NNRTC_JENKINS_USER || process.env.JENKINS_USER || '';
  const token = process.env.NNRTC_JENKINS_TOKEN || process.env.JENKINS_TOKEN || '';
  if (!username || !token) return {};
  return { auth: { username, password: token } };
}

function createNNRtcTask(type: NNRtcTask['type']): NNRtcTask {
  const now = Date.now();
  const task: NNRtcTask = {
    id: `nnrtc_${type}_${now}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    status: 'pending',
    progress: 0,
    message: '等待开始',
    logs: [],
    createdAt: now,
    updatedAt: now,
  };
  nnrtcTasks.set(task.id, task);
  persistNNRtcTasks();
  return task;
}

function updateNNRtcTask(task: NNRtcTask, patch: Partial<NNRtcTask>) {
  Object.assign(task, patch, { updatedAt: Date.now() });
  if (patch.message) task.logs.push(patch.message);
  nnrtcTasks.set(task.id, task);
  persistNNRtcTasks();
}

function scheduleTaskCleanup() {
  const expireAt = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, task] of nnrtcTasks.entries()) {
    if (task.updatedAt < expireAt) nnrtcTasks.delete(id);
  }
  persistNNRtcTasks();
}

function findNNRtcArtifact(artifacts: any[]) {
  return artifacts.find((item: any) => {
    const fileName = String(item?.fileName || '').toLowerCase();
    const relativePath = String(item?.relativePath || '').toLowerCase();
    return fileName === 'nrt.tgz' || fileName === 'nrtc.tgz' || fileName === 'nnrtc.tgz' ||
      relativePath.endsWith('/nrt.tgz') || relativePath.endsWith('/nrtc.tgz') || relativePath.endsWith('/nnrtc.tgz');
  });
}

function isNNRtcReleaseBuildForVersion(branchName: string, version: string) {
  const normalized = String(branchName || '').replace(/^origin\//, '');
  return normalized === `release_${version}` || normalized === `release/${version}`;
}

async function listNNRtcJenkinsBuilds(limit = 30): Promise<Array<{
  number: number;
  result: string;
  branchName: string;
  timestamp?: number;
  url?: string;
  artifactPath: string;
}>> {
  const jobPath = encodeJobPath(NNRTC_JENKINS_JOB);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
  const response = await axios.get(`${NNRTC_JENKINS_BASE_URL}/${jobPath}/api/json`, {
    timeout: 30000,
    params: {
      tree: `builds[number,result,timestamp,url,actions[parameters[name,value]],artifacts[fileName,relativePath]]{0,${safeLimit}}`,
    },
    ...buildJenkinsAuthConfig(),
  });
  const builds = Array.isArray(response.data?.builds) ? response.data.builds : [];
  return builds
    .map((build: any) => {
      const artifact = findNNRtcArtifact(Array.isArray(build?.artifacts) ? build.artifacts : []);
      if (!artifact) return null;
      if (String(build.result || '') !== 'SUCCESS') return null;
      const parameters = (Array.isArray(build?.actions) ? build.actions : [])
        .flatMap((action: any) => Array.isArray(action?.parameters) ? action.parameters : []);
      const branchName = String(
        parameters.find((item: any) => String(item?.name || '').toUpperCase() === 'BRANCH')?.value ||
        parameters.find((item: any) => /branch/i.test(String(item?.name || '')))?.value ||
        ''
      ).replace(/^origin\//, '');
      return {
        number: Number(build.number),
        result: String(build.result || ''),
        branchName,
        timestamp: Number(build.timestamp) || undefined,
        url: build.url ? String(build.url) : undefined,
        artifactPath: String(artifact.relativePath || artifact.fileName || ''),
      };
    })
    .filter(Boolean) as Array<{
      number: number;
      result: string;
      branchName: string;
      timestamp?: number;
      url?: string;
      artifactPath: string;
    }>;
}

async function downloadNNRtcJenkinsArtifact(buildNumber: string): Promise<{ filePath: string; fileName: string; artifactUrl: string }> {
  const build = String(buildNumber || '').trim();
  if (!/^\d+$/.test(build)) {
    const error = new Error('NNRtc Jenkins 构建号必须是数字') as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const jobPath = encodeJobPath(NNRTC_JENKINS_JOB);
  const apiUrl = `${NNRTC_JENKINS_BASE_URL}/${jobPath}/${build}/api/json`;
  const metaResponse = await axios.get(apiUrl, {
    timeout: 30000,
    params: { tree: 'artifacts[fileName,relativePath]' },
    ...buildJenkinsAuthConfig(),
  });
  const artifacts = Array.isArray(metaResponse.data?.artifacts) ? metaResponse.data.artifacts : [];
  const artifact = findNNRtcArtifact(artifacts);

  if (!artifact?.relativePath) {
    const names = artifacts.map((item: any) => item?.relativePath || item?.fileName).filter(Boolean).join(', ');
    throw new Error(`构建 #${build} 未找到 nrt.tgz/nrtc.tgz/nnrtc.tgz artifact${names ? `，当前 artifacts: ${names}` : ''}`);
  }

  const fileName = String(artifact.fileName || path.basename(artifact.relativePath));
  const artifactUrl = `${NNRTC_JENKINS_BASE_URL}/${jobPath}/${build}/artifact/${String(artifact.relativePath).split('/').map(encodeURIComponent).join('/')}`;
  const filePath = path.join(UPLOAD_DIR, `nnrtc_jenkins_${build}_${Date.now()}_${fileName}`);
  const response = await axios.get(artifactUrl, {
    responseType: 'stream',
    timeout: 600000,
    ...buildJenkinsAuthConfig(),
  });

  await new Promise<void>((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    response.data.on('error', reject);
  });

  return { filePath, fileName, artifactUrl };
}

/**
 * POST /api/pods/publish
 * 上传并发布 Pod 组件（需要管理员权限）
 */
router.post('/publish', adminMiddleware, upload.single('file'), async (req: Request, res: Response) => {
  let tempPath: string | undefined;

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '未上传文件' });
    }

    const { name, version, lib_type, lib_name, summary, homepage, authors, license,
      platform_version, dependencies, sys_frameworks, sys_libraries, target_branch, package_type, build_id } = req.body;

    if (!name || !version) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: '组件名称和版本号为必填项' });
    }

    tempPath = req.file.path;

    const targetBranch = requireTargetBranch(target_branch);

    logger.info('收到 Pod 组件发布请求', { name, version, lib_type, target_branch: targetBranch, filename: req.file.originalname });

    const nnrtcPackageType: 'release' | 'test' | undefined = name === 'NNRtc'
      ? (package_type === 'test' || isNNRtcTestVersion(version) ? 'test' : 'release')
      : undefined;
    const params = {
      name, version, lib_type, lib_name, summary, homepage, authors, license,
      platform_version, dependencies, sys_frameworks, sys_libraries, target_branch: targetBranch,
      package_type: nnrtcPackageType,
      build_id,
    };
    const component = name === 'NNRtc' && isNNRtcPackageFile(req.file.originalname)
      ? await podService.publishNNRtcPackage(tempPath, req.file.originalname, params)
      : await podService.publish(tempPath, req.file.originalname, params);

    // 清理临时文件
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    res.json({ success: true, data: component, warning: component.warning_message });
  } catch (error: any) {
    logger.error('Pod 组件发布失败', { error: error.message });

    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pods/nnrtc/jenkins/builds
 * 获取 NNRtc Jenkins 最近包含 tgz artifact 的构建列表
 */
router.get('/nnrtc/jenkins/builds', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const builds = await listNNRtcJenkinsBuilds(Number(req.query.limit || 30));
    res.json({ success: true, data: builds });
  } catch (error: any) {
    logger.error('获取 NNRtc Jenkins 构建列表失败', { error: error.message });
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pods/nnrtc/jenkins/publish
 * 从 NNRtc Jenkins 指定构建 artifact 发布组件（需要管理员权限）
 */
router.post('/nnrtc/jenkins/publish', adminMiddleware, async (req: Request, res: Response) => {
  let tempPath: string | undefined;

  try {
    const { build_number, version, target_branch, sys_frameworks, sys_libraries, package_type } = req.body;
    if (!version) {
      return res.status(400).json({ success: false, error: '版本号为必填项' });
    }
    const targetBranch = requireTargetBranch(target_branch);
    const artifact = await downloadNNRtcJenkinsArtifact(build_number);
    tempPath = artifact.filePath;

    logger.info('从 Jenkins artifact 发布 NNRtc', {
      build_number,
      version,
      target_branch: targetBranch,
      artifactUrl: artifact.artifactUrl,
    });

    const component = await podService.publishNNRtcPackage(tempPath, artifact.fileName, {
      name: 'NNRtc',
      version,
      lib_type: 'framework',
      lib_name: 'NNRtc.framework',
      sys_frameworks,
      sys_libraries,
      target_branch: targetBranch,
      package_type: package_type === 'test' || isNNRtcTestVersion(version) ? 'test' : 'release',
      build_id: String(build_number || ''),
    });

    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.json({ success: true, data: component, warning: component.warning_message });
  } catch (error: any) {
    logger.error('从 Jenkins 发布 NNRtc 失败', { error: error.message });
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pods/nnrtc/jenkins/publish-task
 * 后台任务：从 NNRtc Jenkins 指定构建 artifact 发布组件（需要管理员权限）
 */
router.post('/nnrtc/jenkins/publish-task', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { build_number, version, target_branch, sys_frameworks, sys_libraries, package_type } = req.body;
    if (!version) return res.status(400).json({ success: false, error: '版本号为必填项' });
    const targetBranch = requireTargetBranch(target_branch);
    const task = createNNRtcTask('publish');
    scheduleTaskCleanup();
    res.json({ success: true, data: task });

    setImmediate(async () => {
      let tempPath: string | undefined;
      try {
        updateNNRtcTask(task, { status: 'running', progress: 10, message: `开始发布 NNRtc@${version}` });
        updateNNRtcTask(task, { progress: 25, message: `下载 Jenkins 构建 #${build_number}` });
        const artifact = await downloadNNRtcJenkinsArtifact(build_number);
        tempPath = artifact.filePath;
        const isTestPackage = package_type === 'test' || isNNRtcTestVersion(version);
        updateNNRtcTask(task, {
          progress: 45,
          message: isTestPackage ? '提取 NNRtc.framework 并发布测试包 Pod' : '提取 NNRtc.framework / NNRtc.dSYM 并发布 Pod',
        });
        const component = await podService.publishNNRtcPackage(tempPath, artifact.fileName, {
          name: 'NNRtc',
          version,
          lib_type: 'framework',
          lib_name: 'NNRtc.framework',
          sys_frameworks,
          sys_libraries,
          target_branch: targetBranch,
          package_type: isTestPackage ? 'test' : 'release',
          build_id: String(build_number || ''),
        });
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        updateNNRtcTask(task, {
          status: 'success',
          progress: 100,
          message: component.warning_message || `NNRtc@${version} 发布完成`,
          data: component,
          warning: component.warning_message,
        });
      } catch (error: any) {
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        logger.error('NNRtc 发布任务失败', { taskId: task.id, error: error.message });
        updateNNRtcTask(task, {
          status: 'failed',
          progress: 100,
          message: `发布失败: ${error.message}`,
          error: error.message,
        });
      }
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pods/nnrtc/:version/jenkins/replace
 * 从 NNRtc Jenkins 指定构建 artifact 替换已有版本（需要管理员权限）
 */
router.post('/nnrtc/:version/jenkins/replace', adminMiddleware, async (req: Request, res: Response) => {
  let tempPath: string | undefined;

  try {
    const { build_number, target_branch } = req.body;
    const targetBranch = requireTargetBranch(target_branch);
    const artifact = await downloadNNRtcJenkinsArtifact(build_number);
    tempPath = artifact.filePath;

    logger.info('从 Jenkins artifact 替换 NNRtc 二进制', {
      build_number,
      version: req.params.version,
      target_branch: targetBranch,
      artifactUrl: artifact.artifactUrl,
    });

    const current = await podService.getOne('NNRtc', req.params.version);
    const isTestPackage = current?.package_type === 'test' || isNNRtcTestVersion(req.params.version);
    const component = await podService.replaceNNRtcPackage(
      req.params.version,
      tempPath,
      artifact.fileName,
      targetBranch,
      String(build_number || ''),
      !isTestPackage
    );

    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.json({ success: true, data: component, warning: component.warning_message });
  } catch (error: any) {
    logger.error('从 Jenkins 替换 NNRtc 失败', { error: error.message });
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pods/nnrtc/:version/jenkins/replace-task
 * 后台任务：从 NNRtc Jenkins 指定构建 artifact 替换已有版本（需要管理员权限）
 */
router.post('/nnrtc/:version/jenkins/replace-task', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { build_number, target_branch } = req.body;
    const targetBranch = requireTargetBranch(target_branch);
    const task = createNNRtcTask('replace');
    scheduleTaskCleanup();
    res.json({ success: true, data: task });

    setImmediate(async () => {
      let tempPath: string | undefined;
      try {
        updateNNRtcTask(task, { status: 'running', progress: 10, message: `开始替换 NNRtc@${req.params.version}` });
        updateNNRtcTask(task, { progress: 25, message: `下载 Jenkins 构建 #${build_number}` });
        const artifact = await downloadNNRtcJenkinsArtifact(build_number);
        tempPath = artifact.filePath;
        const current = await podService.getOne('NNRtc', req.params.version);
        const syncDSYM = !(current?.package_type === 'test' || isNNRtcTestVersion(req.params.version));
        updateNNRtcTask(task, {
          progress: 45,
          message: syncDSYM ? '提取 NNRtc.framework / NNRtc.dSYM 并替换 Pod' : '提取 NNRtc.framework 并替换测试包 Pod',
        });
        const component = await podService.replaceNNRtcPackage(req.params.version, tempPath, artifact.fileName, targetBranch, String(build_number || ''), syncDSYM);
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        updateNNRtcTask(task, {
          status: 'success',
          progress: 100,
          message: component.warning_message || `NNRtc@${req.params.version} 替换完成`,
          data: component,
          warning: component.warning_message,
        });
      } catch (error: any) {
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        logger.error('NNRtc 替换任务失败', { taskId: task.id, error: error.message });
        updateNNRtcTask(task, {
          status: 'failed',
          progress: 100,
          message: `替换失败: ${error.message}`,
          error: error.message,
        });
      }
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pods/nnrtc/tasks
 * 查询最近 NNRtc 发布/替换任务
 */
router.get('/nnrtc/tasks', adminMiddleware, async (_req: Request, res: Response) => {
  const tasks = Array.from(nnrtcTasks.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ success: true, data: tasks });
});

/**
 * GET /api/pods/nnrtc/tasks/:taskId
 * 查询 NNRtc 发布/替换任务进度
 */
router.get('/nnrtc/tasks/:taskId', adminMiddleware, async (req: Request, res: Response) => {
  const task = nnrtcTasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ success: false, error: '任务不存在或已过期' });
  res.json({ success: true, data: task, warning: task.warning });
});

/**
 * POST /api/pods/nnrtc/:version/dsym/backfill
 * 从 Jenkins release 构建补齐 NNRtc 正式包 dSYM，不重新发布 Pod
 */
router.post('/nnrtc/:version/dsym/backfill', adminMiddleware, async (req: Request, res: Response) => {
  let tempPath: string | undefined;

  try {
    const version = req.params.version;
    if (isNNRtcTestVersion(version)) {
      await podService.syncNNRtcDSYMFromPackage('', '', version);
      return res.json({ success: true, data: { version, skipped: true }, warning: '测试包不需要 dSYM，已清理同版本 dSYM' });
    }

    const existing = await podService.hasNNRtcDSYM(version);
    if (existing && !req.body?.force) {
      return res.json({ success: true, data: { version, exists: true } });
    }

    const buildNumber = String(req.body?.build_number || '').trim();
    let targetBuild = buildNumber;
    if (!targetBuild) {
      const builds = await listNNRtcJenkinsBuilds(100);
      const matched = builds.find((build) => isNNRtcReleaseBuildForVersion(build.branchName, version));
      if (!matched) {
        throw new Error(`未找到 release_${version} 对应的 NNRtc Jenkins 构建`);
      }
      targetBuild = String(matched.number);
    }

    const artifact = await downloadNNRtcJenkinsArtifact(targetBuild);
    tempPath = artifact.filePath;
    await podService.syncNNRtcDSYMFromPackage(tempPath, artifact.fileName, version, targetBuild);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

    res.json({ success: true, data: { version, buildNumber: targetBuild, artifactUrl: artifact.artifactUrl } });
  } catch (error: any) {
    logger.error('补齐 NNRtc dSYM 失败', { version: req.params.version, error: error.message });
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pods/list
 * 获取所有组件列表
 */
router.get('/list', async (_req: Request, res: Response) => {
  try {
    const components = await podService.getAll();
    res.json({ success: true, data: components });
  } catch (error: any) {
    logger.error('获取组件列表失败', { error: error.message });
    res.status(500).json({ success: false, error: '获取列表失败' });
  }
});

/**
 * GET /api/pods/names
 * 获取组件名称列表
 */
router.get('/names', async (_req: Request, res: Response) => {
  try {
    const names = await podService.getComponentNames();
    res.json({ success: true, data: names });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pods/:name/versions
 * 获取指定组件的所有版本
 */
router.get('/:name/versions', async (req: Request, res: Response) => {
  try {
    const versions = await podService.getVersions(req.params.name);
    res.json({ success: true, data: versions });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pods/:name/:version
 * 获取指定组件版本详情
 */
router.get('/:name/:version', async (req: Request, res: Response) => {
  try {
    const component = await podService.getOne(req.params.name, req.params.version);
    if (!component) {
      return res.status(404).json({ success: false, error: '组件不存在' });
    }
    res.json({ success: true, data: component, warning: component.warning_message });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pods/:name/:version/retry
 * 重试同步 spec 仓库（需要管理员权限）
 */
router.post('/:name/:version/retry', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const targetBranch = requireTargetBranch(req.body?.target_branch);
    const component = await podService.retrySync(req.params.name, req.params.version, targetBranch);
    res.json({ success: true, data: component });
  } catch (error: any) {
    logger.error('重试同步失败', { error: error.message });
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pods/:name/:version/sync-branch
 * 将当前组件版本同步到指定 nnios 分支（需要管理员权限）
 */
router.post('/:name/:version/sync-branch', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const current = await podService.getOne(req.params.name, req.params.version);
    const isTestPackage = current?.package_type === 'test' || isNNRtcTestVersion(req.params.version);
    const targetBranch = req.body?.target_branch
      ? requireTargetBranch(req.body.target_branch)
      : (isTestPackage ? undefined : requireTargetBranch(req.body?.target_branch));
    const component = await podService.syncVersionToBranch(req.params.name, req.params.version, targetBranch);
    res.json({ success: true, data: component });
  } catch (error: any) {
    logger.error('同步组件版本到 nnios 分支失败', { error: error.message });
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/pods/:name/:version/podspec
 * 更新 podspec 内容并同步到远程仓库（需要管理员权限）
 */
router.put('/:name/:version/podspec', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { podspec_content, target_branch } = req.body;
    if (!podspec_content) {
      return res.status(400).json({ success: false, error: 'podspec 内容不能为空' });
    }
    const targetBranch = requireTargetBranch(target_branch);
    const component = await podService.updatePodspec(req.params.name, req.params.version, podspec_content, targetBranch);
    res.json({ success: true, data: component });
  } catch (error: any) {
    logger.error('更新 podspec 失败', { error: error.message });
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pods/:name/:version/replace
 * 重新上传 zip 文件替换已有版本（需要管理员权限）
 */
router.post('/:name/:version/replace', adminMiddleware, upload.single('file'), async (req: Request, res: Response) => {
  let tempPath: string | undefined;
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '未上传文件' });
    }
    tempPath = req.file.path;
    const { target_branch } = req.body;
    const targetBranch = requireTargetBranch(target_branch);

    let component;
    if (req.params.name === 'NNRtc' && isNNRtcPackageFile(req.file.originalname)) {
      const current = await podService.getOne(req.params.name, req.params.version);
      const syncDSYM = !(current?.package_type === 'test' || isNNRtcTestVersion(req.params.version));
      component = await podService.replaceNNRtcPackage(req.params.version, tempPath, req.file.originalname, targetBranch, undefined, syncDSYM);
    } else {
      component = await podService.replaceZip(req.params.name, req.params.version, tempPath, req.file.originalname, targetBranch);
    }

    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.json({ success: true, data: component });
  } catch (error: any) {
    logger.error('替换 zip 失败', { error: error.message });
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pods/official/:name/versions
 * 查询官方 CocoaPods 组件的可用版本列表
 */
router.get('/official/:name/versions', async (req: Request, res: Response) => {
  try {
    const versions = await podService.fetchOfficialVersions(req.params.name);
    res.json({ success: true, data: versions });
  } catch (error: any) {
    logger.error('获取官方版本列表失败', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pods/official/:name/:version/dependencies
 * 查询官方组件的依赖列表，检查哪些已在内部仓库中
 */
router.get('/official/:name/:version/dependencies', async (req: Request, res: Response) => {
  try {
    const result = await podService.checkDependencies(req.params.name, req.params.version);
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error('检查依赖失败', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pods/official/import
 * 从官方 CocoaPods 导入组件到内部仓库（需要管理员权限）
 */
router.post('/official/import', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { name, version, buildBinary, outputType, depVersionOverrides, selectedSubspecs, internalVersion, prepareCommand, target_branch } = req.body;
    if (!name || !version) {
      return res.status(400).json({ success: false, error: '组件名称和版本号为必填项' });
    }
    const targetBranch = requireTargetBranch(target_branch);

    // internalVersion: 用户自定义发布版本号（如 1.4.0.1），若不传则与 version 相同
    const publishVersion = (internalVersion || '').trim() || version;

    let component;
    if (buildBinary) {
      // 源码编译为二进制
      component = await podService.buildBinaryFromSource(name, version, outputType || 'framework', depVersionOverrides, selectedSubspecs, publishVersion, prepareCommand, targetBranch);
    } else {
      // 直接导入（二进制 SDK）
      component = await podService.importFromOfficial(name, version, publishVersion, prepareCommand, targetBranch);
    }

    res.json({ success: true, data: component });
  } catch (error: any) {
    logger.error('导入官方组件失败', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/pods/:name/:version
 * 删除指定组件版本（需要管理员权限）
 */
router.delete('/:name/:version', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const targetBranch = req.query.target_branch ? requireTargetBranch(req.query.target_branch) : undefined;
    const result = await podService.deleteVersion(req.params.name, req.params.version, targetBranch);
    res.json({ success: true, data: result, warning: result.warning });
  } catch (error: any) {
    logger.error('删除组件版本失败', { error: error.message });
    res.status(error.statusCode || (error.message.includes('不存在') ? 404 : 500)).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /api/pods/:name
 * 删除整个组件（所有版本，需要管理员权限）
 */
router.delete('/:name', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const result = await podService.deleteComponent(req.params.name);
    res.json({ success: true, data: { deletedVersions: result.deletedVersions }, warning: result.warning });
  } catch (error: any) {
    logger.error('删除组件失败', { error: error.message });
    res.status(error.message.includes('不存在') ? 404 : 500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
