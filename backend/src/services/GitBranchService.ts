import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../utils/logger';

export type PushMode = 'normal' | 'skip' | 'set-upstream';

export interface BranchJobRepo {
  url: string;
}

export interface BranchJobOptions {
  targetBranch: string;
  baseBranch?: string;
  repos: string[];
  pullEnabled?: boolean;
  pushMode?: PushMode;
  /** 可选：URL 中注入的 http 凭据 */
  username?: string;
  password?: string;
  /** 可选：自定义工作目录，默认为 BASE_DIR */
  baseDir?: string;
  /** nnios 仓库的 Podfile 会被修改，将所有 branch: '...' 替换为目标分支 */
  modifyPodfile?: boolean;
  /** true 时即使目标分支已存在也继续执行（相当于强制覆盖本地并 push） */
  force?: boolean;
}

export interface RemoteBranchCheckItem {
  repo: string;
  url: string;
  /** 远端是否已经存在 targetBranch */
  targetExists: boolean;
  /** 远端是否存在 baseBranch */
  baseExists: boolean;
  /** 探测是否成功，false 说明连通/认证有问题 */
  reachable: boolean;
  error?: string;
}

export interface RemoteBranchCheckResult {
  targetBranch: string;
  baseBranch: string;
  items: RemoteBranchCheckItem[];
  /** 已经存在 targetBranch 的仓库名列表 */
  existingRepos: string[];
  /** 不存在 baseBranch 的仓库名列表 */
  missingBaseRepos: string[];
  /** 探测失败的仓库名列表 */
  unreachableRepos: string[];
}

export interface LogEvent {
  type: 'log';
  repo?: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

export interface ResultEvent {
  type: 'result';
  repo: string;
  status: 'success' | 'failed' | 'skipped';
  message?: string;
}

export interface DoneEvent {
  type: 'done';
  success: boolean;
  failures: string[];
}

export type StreamEvent = LogEvent | ResultEvent | DoneEvent;

export type EventSink = (evt: StreamEvent) => void;

const DEFAULT_BASE_DIR = path.resolve(
  process.env.GIT_WORK_DIR ||
    path.join(process.env.UPLOAD_DIR || path.join(os.homedir(), '.nn-ios-platform-data'), '../git-workspace')
);

/** 脚本中硬编码的默认仓库列表 */
export const DEFAULT_REPOS: string[] = [
  'http://git.leigod.top/nn_ios/nnios.git',
  'http://git.leigod.top/nn_ios/nnbusscom.git',
  'http://git.leigod.top/nn_ios/nnimmanager.git',
  'http://git.leigod.top/nn_ios/nnbascicommon.git',
  'http://git.leigod.top/nn_ios/nnapperance.git',
  'http://git.leigod.top/nn_ios/nncategory.git',
  'http://git.leigod.top/nn_ios/nnlogmodule.git',
  'http://git.leigod.top/nn_ios/nnnetwork.git',
  'http://git.leigod.top/nn_ios/nnrealreachability.git',
  'http://git.leigod.top/nn_ios/nnyytext.git',
  'http://git.leigod.top/nn_ios/nngeneral.git',
  'http://git.leigod.top/nn_ios/nnswiftscan.git',
];

function extractRepoName(repoUrl: string): string {
  const cleaned = repoUrl.replace(/\/+$/g, '');
  const basename = cleaned.split('/').pop() || cleaned;
  return basename.replace(/\.git$/i, '');
}

function injectCredentials(url: string, username?: string, password?: string): string {
  if (!username || !password) return url;
  // 仅对 http/https 协议注入
  const httpMatch = url.match(/^(https?:\/\/)(?:[^@/]*@)?(.+)$/);
  if (!httpMatch) return url;
  const encodedUser = encodeURIComponent(username);
  const encodedPass = encodeURIComponent(password);
  return `${httpMatch[1]}${encodedUser}:${encodedPass}@${httpMatch[2]}`;
}

function maskUrl(url: string): string {
  return url.replace(/\/\/([^/@]+)@/, '//***@');
}

/** 安静执行 git，不走日志 sink，收集 stdout 返回 */
function runGitQuiet(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      env: { ...process.env, ...(opts.env || {}), GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + (stderr ? '\n' : '') + err.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 执行 git 命令并把 stdout/stderr 按行推给 sink */
function runGit(
  args: string[],
  cwd: string | undefined,
  sink: EventSink,
  repo: string,
  opts: { env?: NodeJS.ProcessEnv; maskInLog?: string[] } = {}
): Promise<number> {
  return new Promise((resolve) => {
    const displayCmd = ['git', ...args]
      .map((a) => {
        let s = a;
        (opts.maskInLog || []).forEach((m) => {
          if (m && s.includes(m)) s = s.replace(m, maskUrl(m));
        });
        return s;
      })
      .join(' ');

    sink({ type: 'log', repo, level: 'debug', message: `$ ${displayCmd}` });

    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...(opts.env || {}), GIT_TERMINAL_PROMPT: '0' },
    });

    const emit = (data: Buffer | string, level: 'info' | 'error') => {
      const text = data.toString();
      text.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trimEnd();
        if (trimmed.length > 0) {
          sink({ type: 'log', repo, level, message: trimmed });
        }
      });
    };

    child.stdout.on('data', (d) => emit(d, 'info'));
    child.stderr.on('data', (d) => emit(d, 'info'));
    child.on('error', (err) => {
      sink({ type: 'log', repo, level: 'error', message: `git 启动失败: ${err.message}` });
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
}

export class GitBranchService {
  /** 供路由获取默认仓库配置 */
  getDefaultRepos(): string[] {
    return DEFAULT_REPOS;
  }

  /** 工作目录（方便前端展示或排查） */
  getBaseDir(custom?: string): string {
    return custom ? path.resolve(custom) : DEFAULT_BASE_DIR;
  }

  /**
   * 列出单个仓库的全部远端分支名
   * 返回的分支按字母序；默认分支（HEAD -> refs/heads/xxx）会被标记
   */
  async listRemoteBranches(
    repoUrl: string,
    creds?: { username?: string; password?: string }
  ): Promise<{
    repo: string;
    url: string;
    defaultBranch?: string;
    branches: Array<{ name: string; sha: string; isDefault: boolean }>;
  }> {
    const url = repoUrl.trim();
    const name = extractRepoName(url);
    const authedUrl = injectCredentials(url, creds?.username, creds?.password);

    // 同时查询 HEAD（获取默认分支）和所有 heads
    const { code, stdout, stderr } = await runGitQuiet(
      ['ls-remote', '--symref', '--heads', authedUrl],
      { timeoutMs: 30000 }
    );
    if (code !== 0) {
      throw new Error((stderr || stdout || `git ls-remote 失败 (exit ${code})`).trim());
    }

    // 第一行通常形如: ref: refs/heads/master\tHEAD
    let defaultBranch: string | undefined;
    const branches: Array<{ name: string; sha: string; isDefault: boolean }> = [];

    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('ref:')) {
        const m = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/);
        if (m) defaultBranch = m[1];
        continue;
      }
      // <sha>\trefs/heads/<branch>
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const [sha, ref] = parts;
      const bm = ref.match(/^refs\/heads\/(.+)$/);
      if (!bm) continue;
      branches.push({ name: bm[1], sha, isDefault: false });
    }

    if (defaultBranch) {
      for (const b of branches) {
        if (b.name === defaultBranch) b.isDefault = true;
      }
    }

    branches.sort((a, b) => {
      // 默认分支排最前
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return a.name.localeCompare(b.name);
    });

    return { repo: name, url, defaultBranch, branches };
  }

  /**
   * 批量列远端分支，失败的仓库返回 error 字段
   */
  async listRemoteBranchesBatch(
    repoUrls: string[],
    creds?: { username?: string; password?: string }
  ): Promise<
    Array<{
      repo: string;
      url: string;
      ok: boolean;
      defaultBranch?: string;
      branches?: Array<{ name: string; sha: string; isDefault: boolean }>;
      error?: string;
    }>
  > {
    return Promise.all(
      repoUrls.map(async (u) => {
        try {
          const r = await this.listRemoteBranches(u, creds);
          return { repo: r.repo, url: r.url, ok: true, defaultBranch: r.defaultBranch, branches: r.branches };
        } catch (err: any) {
          return { repo: extractRepoName(u), url: u, ok: false, error: err.message };
        }
      })
    );
  }

  /**
   * 用 git ls-remote --heads 探测每个远端仓库是否已存在 targetBranch / baseBranch
   * 不会在本地落盘任何文件
   */
  async checkRemoteBranches(
    repos: string[],
    targetBranch: string,
    baseBranch: string,
    creds?: { username?: string; password?: string }
  ): Promise<RemoteBranchCheckResult> {
    const existingRepos: string[] = [];
    const missingBaseRepos: string[] = [];
    const unreachableRepos: string[] = [];

    const items = await Promise.all(
      repos.map(async (rawUrl) => {
        const url = rawUrl.trim();
        const name = extractRepoName(url);
        const authedUrl = injectCredentials(url, creds?.username, creds?.password);

        const { code, stdout, stderr } = await runGitQuiet(
          ['ls-remote', '--heads', authedUrl, targetBranch, baseBranch],
          { timeoutMs: 30000 }
        );

        const item: RemoteBranchCheckItem = {
          repo: name,
          url,
          targetExists: false,
          baseExists: false,
          reachable: code === 0,
        };

        if (code !== 0) {
          item.error = (stderr || stdout || `git ls-remote 失败 (exit ${code})`).trim();
          unreachableRepos.push(name);
          logger.warn('分支预检失败', { repo: name, error: item.error });
          return item;
        }

        // stdout 每行形如:  <sha>\trefs/heads/<branch>
        const refs = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => l.split(/\s+/).pop() || '');

        item.targetExists = refs.includes(`refs/heads/${targetBranch}`);
        item.baseExists = refs.includes(`refs/heads/${baseBranch}`);

        if (item.targetExists) existingRepos.push(name);
        if (!item.baseExists) missingBaseRepos.push(name);

        return item;
      })
    );

    return {
      targetBranch,
      baseBranch,
      items,
      existingRepos,
      missingBaseRepos,
      unreachableRepos,
    };
  }

  /**
   * 批量建分支主流程，事件流推给 sink
   * 对应脚本的整体行为
   */
  async createBranchBatch(options: BranchJobOptions, sink: EventSink): Promise<DoneEvent> {
    const {
      targetBranch,
      baseBranch = 'develop',
      pullEnabled = false,
      pushMode = 'normal',
      repos,
      username,
      password,
      modifyPodfile = true,
      force = false,
    } = options;

    const failures: string[] = [];

    // 参数校验
    if (!targetBranch) {
      const done: DoneEvent = { type: 'done', success: false, failures: ['参数错误：目标分支名不能为空'] };
      sink(done);
      return done;
    }
    if (targetBranch === baseBranch) {
      const done: DoneEvent = { type: 'done', success: false, failures: ['参数错误：目标分支不能和基准分支相同'] };
      sink(done);
      return done;
    }
    if (!['normal', 'skip', 'set-upstream'].includes(pushMode)) {
      const done: DoneEvent = { type: 'done', success: false, failures: [`参数错误：未知的推送模式 ${pushMode}`] };
      sink(done);
      return done;
    }
    if (!Array.isArray(repos) || repos.length === 0) {
      const done: DoneEvent = { type: 'done', success: false, failures: ['参数错误：仓库列表不能为空'] };
      sink(done);
      return done;
    }

    const baseDir = this.getBaseDir(options.baseDir);
    fs.mkdirSync(baseDir, { recursive: true });

    sink({
      type: 'log',
      level: 'info',
      message: `开始任务：target=${targetBranch} base=${baseBranch} pull=${pullEnabled} push=${pushMode} force=${force} baseDir=${baseDir} repos=${repos.length}`,
    });

    // === 预检：远端分支校验 ===
    sink({
      type: 'log',
      level: 'info',
      message: `预检：ls-remote 检测 ${repos.length} 个仓库...`,
    });
    let preCheck: RemoteBranchCheckResult;
    try {
      preCheck = await this.checkRemoteBranches(repos, targetBranch, baseBranch, { username, password });
    } catch (err: any) {
      const done: DoneEvent = { type: 'done', success: false, failures: [`预检异常: ${err.message}`] };
      sink({ type: 'log', level: 'error', message: done.failures[0] });
      sink(done);
      return done;
    }

    // 标记不可达仓库为失败并剔除出后续流程
    const skipRepos = new Set<string>();
    for (const item of preCheck.items) {
      if (!item.reachable) {
        sink({ type: 'log', repo: item.repo, level: 'error', message: `无法连通远端: ${item.error || '未知错误'}` });
        sink({ type: 'result', repo: item.repo, status: 'failed', message: item.error || '无法连通远端' });
        failures.push(item.repo);
        skipRepos.add(item.repo);
        continue;
      }
      if (!item.baseExists) {
        sink({
          type: 'log',
          repo: item.repo,
          level: 'error',
          message: `基准分支 ${baseBranch} 在远端不存在`,
        });
        sink({ type: 'result', repo: item.repo, status: 'failed', message: `远端无 ${baseBranch}` });
        failures.push(item.repo);
        skipRepos.add(item.repo);
        continue;
      }
      if (item.targetExists) {
        if (!force) {
          sink({
            type: 'log',
            repo: item.repo,
            level: 'warn',
            message: `目标分支 ${targetBranch} 已存在，未开启强制模式，跳过`,
          });
          sink({ type: 'result', repo: item.repo, status: 'skipped', message: `${targetBranch} 已存在` });
          skipRepos.add(item.repo);
        } else {
          sink({
            type: 'log',
            repo: item.repo,
            level: 'warn',
            message: `目标分支 ${targetBranch} 已存在，强制模式开启，将覆盖推送`,
          });
        }
      }
    }

    if (skipRepos.size === preCheck.items.length) {
      sink({
        type: 'log',
        level: 'warn',
        message: '所有仓库都已跳过或失败，结束任务',
      });
      const done: DoneEvent = { type: 'done', success: failures.length === 0, failures };
      sink(done);
      return done;
    }

    for (const rawUrl of repos) {
      const repoUrl = rawUrl.trim();
      if (!repoUrl) continue;

      const name = extractRepoName(repoUrl);
      if (skipRepos.has(name)) continue;
      const repoDir = path.join(baseDir, name);

      try {
        // 对应脚本：如果本地目录已存在则清理
        if (fs.existsSync(repoDir)) {
          sink({ type: 'log', repo: name, level: 'info', message: `清理已有目录 ${repoDir}` });
          fs.rmSync(repoDir, { recursive: true, force: true });
        }

        // 克隆
        const cloneUrl = injectCredentials(repoUrl, username, password);
        sink({ type: 'log', repo: name, level: 'info', message: `克隆 ${maskUrl(repoUrl)} -> ${repoDir}` });
        const cloneCode = await runGit(['clone', cloneUrl, repoDir], undefined, sink, name, {
          maskInLog: [cloneUrl],
        });
        if (cloneCode !== 0) {
          throw new Error(`git clone 失败 (exit ${cloneCode})`);
        }

        // 拉取 baseBranch
        sink({ type: 'log', repo: name, level: 'info', message: `fetch origin/${baseBranch}` });
        const fetchCode = await runGit(['fetch', 'origin', baseBranch], repoDir, sink, name);
        if (fetchCode !== 0) throw new Error(`git fetch 失败 (exit ${fetchCode})`);

        // 切到 baseBranch
        sink({ type: 'log', repo: name, level: 'info', message: `checkout ${baseBranch}` });
        const coBaseCode = await runGit(['checkout', baseBranch], repoDir, sink, name);
        if (coBaseCode !== 0) throw new Error(`git checkout ${baseBranch} 失败 (exit ${coBaseCode})`);

        // 可选 pull
        if (pullEnabled) {
          sink({ type: 'log', repo: name, level: 'info', message: `pull --ff-only origin/${baseBranch}` });
          const pullCode = await runGit(['pull', '--ff-only', 'origin', baseBranch], repoDir, sink, name);
          if (pullCode !== 0) throw new Error(`git pull 失败 (exit ${pullCode})`);
        } else {
          sink({ type: 'log', repo: name, level: 'info', message: 'pull 已禁用，跳过' });
        }

        // 基于 baseBranch 创建/重置 targetBranch
        sink({ type: 'log', repo: name, level: 'info', message: `创建/重置 ${targetBranch} 基于 ${baseBranch}` });
        const createCode = await runGit(
          ['checkout', '-B', targetBranch, baseBranch],
          repoDir,
          sink,
          name
        );
        if (createCode !== 0) throw new Error(`git checkout -B ${targetBranch} 失败 (exit ${createCode})`);

        // nnios 仓库特殊处理：修改 Podfile
        if (modifyPodfile && name === 'nnios') {
          const podfilePath = path.join(repoDir, 'Podfile');
          if (fs.existsSync(podfilePath)) {
            sink({ type: 'log', repo: name, level: 'info', message: `修改 Podfile branch: 为 ${targetBranch}` });
            const original = fs.readFileSync(podfilePath, 'utf-8');
            const updated = original.replace(
              /(branch:\s*)(['"])[^'"]*\2/g,
              (_match, prefix) => `${prefix}'${targetBranch}'`
            );
            if (updated !== original) {
              fs.writeFileSync(podfilePath, updated, 'utf-8');
              const addCode = await runGit(['add', 'Podfile'], repoDir, sink, name);
              if (addCode !== 0) throw new Error(`git add Podfile 失败 (exit ${addCode})`);
              const commitCode = await runGit(
                ['commit', '-m', `chore: update Podfile branch to ${targetBranch}`],
                repoDir,
                sink,
                name
              );
              if (commitCode !== 0) throw new Error(`git commit Podfile 失败 (exit ${commitCode})`);
            } else {
              sink({
                type: 'log',
                repo: name,
                level: 'info',
                message: 'Podfile 无 branch: 引用可替换，跳过提交',
              });
            }
          } else {
            sink({ type: 'log', repo: name, level: 'warn', message: 'Podfile 不存在，跳过修改' });
          }
        }

        // 推送
        if (pushMode === 'skip') {
          sink({ type: 'log', repo: name, level: 'info', message: '推送已跳过' });
        } else {
          const pushArgs = ['push'];
          if (pushMode === 'set-upstream') pushArgs.push('--set-upstream');
          pushArgs.push('origin', targetBranch);
          sink({
            type: 'log',
            repo: name,
            level: 'info',
            message: `推送 origin/${targetBranch}${pushMode === 'set-upstream' ? ' (--set-upstream)' : ''}`,
          });
          const pushCode = await runGit(pushArgs, repoDir, sink, name);
          if (pushCode !== 0) throw new Error(`git push 失败 (exit ${pushCode})`);
        }

        sink({ type: 'result', repo: name, status: 'success' });
      } catch (err: any) {
        logger.error('批量建分支失败', { repo: name, error: err.message });
        sink({ type: 'log', repo: name, level: 'error', message: err.message });
        sink({ type: 'result', repo: name, status: 'failed', message: err.message });
        failures.push(name);
      }
    }

    const done: DoneEvent = {
      type: 'done',
      success: failures.length === 0,
      failures,
    };
    sink(done);
    return done;
  }
}

export default new GitBranchService();
