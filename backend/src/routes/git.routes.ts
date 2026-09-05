import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import gitBranchService, {
  BranchJobOptions,
  DEFAULT_REPOS,
  StreamEvent,
} from '../services/GitBranchService';
import podDepsResolver from '../services/PodDependencyResolver';
import { adminMiddleware } from '../middleware/auth';
import logger from '../utils/logger';
import { currentProductLineId } from '../services/ProductLineContext';
import { productLineConfigService } from '../services/ProductLineConfigService';

const router = Router();

// ============ Git 凭据管理 ============

/**
 * 读取 .env 文件中的 GIT_USERNAME / GIT_PASSWORD
 * 注意：运行时 process.env 已经加载了，但修改需要写回文件
 */
function getGitCredentials(): { username: string; password: string; configured: boolean } {
  const username = process.env.GIT_USERNAME || '';
  const password = process.env.GIT_PASSWORD || '';
  return { username, password, configured: !!(username && password) };
}

function setGitCredentials(username: string, password: string): void {
  // 更新运行时环境变量
  process.env.GIT_USERNAME = username;
  process.env.GIT_PASSWORD = password;

  // 写回 .env 文件
  const envPath = path.join(__dirname, '../../.env');
  if (!fs.existsSync(envPath)) return;

  let content = fs.readFileSync(envPath, 'utf-8');

  const setOrAppend = (key: string, value: string) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  };

  setOrAppend('GIT_USERNAME', username);
  setOrAppend('GIT_PASSWORD', password);

  fs.writeFileSync(envPath, content, 'utf-8');
  logger.info('Git 凭据已更新');
}

/**
 * GET /api/git/credentials
 * 获取当前 Git 凭据配置状态（不返回明文密码）
 */
router.get('/credentials', adminMiddleware, (_req: Request, res: Response) => {
  const { username, configured } = getGitCredentials();
  res.json({
    success: true,
    data: {
      username,
      hasPassword: configured,
    },
  });
});

/**
 * PUT /api/git/credentials
 * 设置 Git 凭据
 */
router.put('/credentials', adminMiddleware, (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ success: false, error: '请提供 username 和 password' });
  }
  setGitCredentials(username.trim(), password);
  res.json({ success: true, message: '凭据已保存' });
});

/**
 * DELETE /api/git/credentials
 * 清除 Git 凭据
 */
router.delete('/credentials', adminMiddleware, (_req: Request, res: Response) => {
  setGitCredentials('', '');
  res.json({ success: true, message: '凭据已清除' });
});

// ============ 辅助：合并凭据（请求体 > 全局配置） ============
function mergeCredentials(body: { username?: string; password?: string }): {
  username?: string;
  password?: string;
} {
  const global = getGitCredentials();
  return {
    username: body.username || global.username || undefined,
    password: body.password || global.password || undefined,
  };
}

function defaultReposForCurrentProductLine(): string[] {
  const repos = productLineConfigService.publishRepoUrls(currentProductLineId());
  return repos.length > 0 ? repos : DEFAULT_REPOS;
}

function requestedReposOrDefault(repos?: string[]): string[] {
  return Array.isArray(repos) && repos.length > 0 ? repos : defaultReposForCurrentProductLine();
}

/**
 * GET /api/git/default-repos
 * 返回脚本中硬编码的默认仓库列表和工作目录
 */
router.get('/default-repos', (_req: Request, res: Response) => {
  const podxConfig = productLineConfigService.podxConfig(currentProductLineId());
  res.json({
    success: true,
    data: {
      repos: defaultReposForCurrentProductLine(),
      baseBranch: podxConfig.publishBaseBranch,
      baseDir: gitBranchService.getBaseDir(),
      productLineId: podxConfig.productLineId,
      podx: podxConfig,
    },
  });
});

/**
 * POST /api/git/pod-deps
 * 扫描每个业务仓库（同名分支）下的 .podspec 依赖，并用 nnios 同名分支的
 * Podfile / third_sdk.rb 反查版本。
 *
 * body: { repos?: string[], branch: string, username?: string, password?: string }
 */
router.post('/pod-deps', adminMiddleware, async (req: Request, res: Response) => {
  const body = (req.body || {}) as {
    repos?: string[];
    branch?: string;
    username?: string;
    password?: string;
  };
  const branch = (body.branch || '').trim();
  const repos = requestedReposOrDefault(body.repos);

  if (!branch) {
    return res.status(400).json({ success: false, error: 'branch 不能为空' });
  }

  try {
    const creds = mergeCredentials(body);
    const data = await podDepsResolver.resolveMany(repos, branch, {
      username: creds.username,
      password: creds.password,
    });
    res.json({ success: true, data });
  } catch (err: any) {
    logger.error('解析 podspec 依赖失败', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/git/branches
 * 批量列出多个仓库的远端分支
 */
router.post('/branches', adminMiddleware, async (req: Request, res: Response) => {
  const body = (req.body || {}) as {
    repos?: string[];
    username?: string;
    password?: string;
  };
  const repos = requestedReposOrDefault(body.repos);

  try {
    const creds = mergeCredentials(body);
    const data = await gitBranchService.listRemoteBranchesBatch(repos, {
      username: creds.username,
      password: creds.password,
    });
    res.json({ success: true, data });
  } catch (err: any) {
    logger.error('列远端分支失败', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/git/branch-jobs/precheck
 * 预检：远端是否已有 targetBranch / baseBranch
 * 不会写本地磁盘，可在点击“开始执行”前调用
 */
router.post('/branch-jobs/precheck', adminMiddleware, async (req: Request, res: Response) => {
  const body = (req.body || {}) as {
    targetBranch?: string;
    baseBranch?: string;
    repos?: string[];
    username?: string;
    password?: string;
  };

  const targetBranch = (body.targetBranch || '').trim();
  const baseBranch = (body.baseBranch || 'develop').trim();
  const repos = requestedReposOrDefault(body.repos);

  if (!targetBranch) {
    return res.status(400).json({ success: false, error: 'targetBranch 不能为空' });
  }
  if (targetBranch === baseBranch) {
    return res.status(400).json({ success: false, error: '目标分支不能与基准分支相同' });
  }

  try {
    const creds = mergeCredentials(body);
    const result = await gitBranchService.checkRemoteBranches(repos, targetBranch, baseBranch, {
      username: creds.username,
      password: creds.password,
    });
    res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error('分支预检失败', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/git/branch-jobs/stream
 * 批量建分支，返回 NDJSON 流（每行一个 JSON 事件）
 * 需要管理员权限
 */
router.post('/branch-jobs/stream', adminMiddleware, async (req: Request, res: Response) => {
  const body = (req.body || {}) as Partial<BranchJobOptions>;

  const creds = mergeCredentials(body);
  const options: BranchJobOptions = {
    targetBranch: (body.targetBranch || '').trim(),
    baseBranch: (body.baseBranch || 'develop').trim(),
    pullEnabled: !!body.pullEnabled,
    pushMode: body.pushMode || 'normal',
    repos: requestedReposOrDefault(body.repos),
    username: creds.username,
    password: creds.password,
    baseDir: body.baseDir,
    modifyPodfile: body.modifyPodfile !== false,
    force: !!body.force,
  };

  // 基本校验（流里也会再校验一次，但这里直接返回 400 更友好）
  if (!options.targetBranch) {
    return res.status(400).json({ success: false, error: 'targetBranch 不能为空' });
  }
  if (options.targetBranch === options.baseBranch) {
    return res.status(400).json({ success: false, error: '目标分支不能与基准分支相同' });
  }

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  // flush headers 立即发送
  if (typeof (res as any).flushHeaders === 'function') {
    (res as any).flushHeaders();
  }

  let clientClosed = false;
  req.on('close', () => {
    clientClosed = true;
  });

  const sink = (evt: StreamEvent) => {
    if (clientClosed) return;
    try {
      res.write(JSON.stringify(evt) + '\n');
    } catch (err: any) {
      logger.warn('NDJSON 写入失败', { error: err.message });
    }
  };

  logger.info('开始批量建分支任务', {
    targetBranch: options.targetBranch,
    baseBranch: options.baseBranch,
    pushMode: options.pushMode,
    pullEnabled: options.pullEnabled,
    repoCount: options.repos.length,
  });

  try {
    await gitBranchService.createBranchBatch(options, sink);
  } catch (err: any) {
    logger.error('批量建分支任务异常', { error: err.message });
    sink({ type: 'log', level: 'error', message: `任务异常: ${err.message}` });
    sink({ type: 'done', success: false, failures: ['内部错误'] });
  } finally {
    if (!clientClosed) res.end();
  }
});

export default router;
