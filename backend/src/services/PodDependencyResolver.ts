import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import logger from '../utils/logger';
import { productLineConfigService } from './ProductLineConfigService';
import { currentProductLineId } from './ProductLineContext';

/**
 * 基于 nnios 的 Podfile / third_sdk.rb 为各业务仓库的 podspec 依赖反查版本。
 *
 * 关键假设：
 * - nnios 仓库 URL 固定为 http://git.leigod.top/nn_ios/nnios.git
 * - 业务仓库某分支下每个 .podspec 声明了 s.dependency 'XXX', '...'
 * - nnios 同名分支下 Podfile 和/或 third_sdk.rb 里会用 pod 'XXX', '1.2.3' / :git => .. / :branch => ..
 *   的方式给定具体版本，反查时用 pod 名作为 key。
 */

export const NNIOS_REPO_URL = 'http://git.leigod.top/nn_ios/nnios.git';

function currentMainRepoUrl(): string {
  const config = productLineConfigService.podxConfig(currentProductLineId());
  const configured = config.jenkinsRepoUrl
    || config.publishRepoUrls.find((url) => extractRepoName(url).toLowerCase() === config.publishMainRepo.toLowerCase());
  if (configured) return configured;
  if (currentProductLineId() === 'nn') return NNIOS_REPO_URL;
  throw new Error(`当前产品线 ${currentProductLineId()} 未配置发布主仓库地址`);
}

export interface PodSpecDependency {
  /** 依赖的 pod 名（s.dependency 的第一个参数） */
  name: string;
  /** s.dependency 第二个参数（如 '1.0.0' / '~> 1.2' / undefined） */
  specRequirement?: string;
  /** 哪个 .podspec 文件里声明的（相对路径） */
  fromSpec: string;
}

export interface NniosPodSource {
  /** 来自 Podfile 还是 third_sdk.rb */
  sourceFile: 'Podfile' | 'third_sdk.rb';
  /** 在 nnios 中写的 pod 名（可能是 'Foo' 或 'Foo/Subspec'） */
  podName: string;
  /** 第二个参数给的版本号，如 '1.2.3' / '~> 2.0' */
  version?: string;
  /** :git => ... */
  git?: string;
  /** :branch => ... */
  branch?: string;
  /** :tag => ... */
  tag?: string;
  /** :commit => ... */
  commit?: string;
  /** :path => ... */
  pathRef?: string;
  /** 原始行内容（调试用） */
  raw: string;
}

export interface ResolvedDependency extends PodSpecDependency {
  /** 在 nnios 里是否命中 */
  resolved: boolean;
  /** 命中的信息（优先主 pod，其次任意 subspec） */
  match?: NniosPodSource;
  /** 所有匹配（主 pod + subspec），供 UI 展示 */
  allMatches: NniosPodSource[];
}

export interface RepoDependencyResult {
  repo: string;
  url: string;
  branch: string;
  ok: boolean;
  error?: string;
  specFiles: string[];
  dependencies: ResolvedDependency[];
}

export interface ResolveOptions {
  username?: string;
  password?: string;
  /** 缓存 nnios 解析结果（同一次请求里多仓库复用） */
  nniosIndex?: NniosIndex;
  /** 工作目录，默认系统临时目录 */
  workDir?: string;
}

export interface NniosIndex {
  branch: string;
  sources: NniosPodSource[];
  /** podName.toLowerCase() -> NniosPodSource[]，包含 Foo 和 Foo/Subspec */
  byName: Map<string, NniosPodSource[]>;
  /** 解析过程中未找到的文件（仅用于展示） */
  missingFiles: string[];
}

// -------------- shell helpers --------------

function runQuiet(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
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

function injectCredentials(url: string, username?: string, password?: string): string {
  if (!username || !password) return url;
  const m = url.match(/^(https?:\/\/)(?:[^@/]*@)?(.+)$/);
  if (!m) return url;
  return `${m[1]}${encodeURIComponent(username)}:${encodeURIComponent(password)}@${m[2]}`;
}

function extractRepoName(repoUrl: string): string {
  const cleaned = repoUrl.replace(/\/+$/g, '');
  const basename = cleaned.split('/').pop() || cleaned;
  return basename.replace(/\.git$/i, '');
}

/**
 * 浅克隆单个分支到临时目录，默认不拉 blob，再按需一次性拉取
 * 同时启用 --sparse 以降低 checkout 成本
 */
async function shallowClone(
  url: string,
  branch: string,
  workDir: string,
  creds?: { username?: string; password?: string },
  revision?: string
): Promise<string> {
  const authedUrl = injectCredentials(url, creds?.username, creds?.password);
  const name = extractRepoName(url);
  const dest = path.join(workDir, `${name}-${branch.replace(/[^\w.-]/g, '_')}-${Date.now()}`);

  const { code, stderr, stdout } = await runQuiet(
    'git',
    ['clone', '--depth=1', '--single-branch', '-b', branch, authedUrl, dest],
    { timeoutMs: 120000 }
  );
  if (code !== 0) {
    throw new Error((stderr || stdout || `git clone 失败 (exit ${code})`).trim());
  }
  if (revision && /^[0-9a-f]{7,40}$/i.test(revision)) {
    const checkout = await runQuiet('git', ['checkout', '--detach', revision], {
      cwd: dest,
      timeoutMs: 30000,
    });
    if (checkout.code !== 0) {
      const fetch = await runQuiet('git', ['fetch', '--depth=1', 'origin', revision], {
        cwd: dest,
        timeoutMs: 60000,
      });
      if (fetch.code !== 0) {
        throw new Error((fetch.stderr || fetch.stdout || `git fetch ${revision} 失败 (exit ${fetch.code})`).trim());
      }
      const checkoutFetched = await runQuiet('git', ['checkout', '--detach', revision], {
        cwd: dest,
        timeoutMs: 30000,
      });
      if (checkoutFetched.code !== 0) {
        throw new Error((checkoutFetched.stderr || checkoutFetched.stdout || `git checkout ${revision} 失败 (exit ${checkoutFetched.code})`).trim());
      }
    }
  }
  return dest;
}

// -------------- podspec 解析 --------------

/**
 * 扫描目录中的所有 .podspec 文件，解析其中的 s.dependency 语句
 * 忽略同一 spec 自身的 subspec 依赖（'SelfName/Subspec'）
 */
export function parsePodspecDependencies(rootDir: string): {
  specFiles: string[];
  deps: PodSpecDependency[];
} {
  const specFiles: string[] = [];
  const deps: PodSpecDependency[] = [];

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // 跳过 .git 等
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 跳过常见无关目录
        if (['node_modules', 'Pods', 'build', 'DerivedData', 'Example'].includes(entry.name)) {
          continue;
        }
        walk(p);
      } else if (entry.isFile() && /\.podspec$/i.test(entry.name)) {
        specFiles.push(p);
      }
    }
  };
  walk(rootDir);

  for (const file of specFiles) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const rel = path.relative(rootDir, file);
    const selfName = path.basename(file, '.podspec');

    // 匹配: s.dependency 'Foo', '1.2.3', '~> 1.2'
    // 或:    <spec>.dependency "Foo"
    const re = /^[^\S\r\n]*\w+\.dependency\s+(['"])([^'"]+)\1\s*(?:,\s*(['"])([^'"]+)\3)?/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const depName = m[2];
      const requirement = m[4];

      // 忽略自身 subspec 依赖
      if (depName === selfName) continue;
      if (depName.startsWith(`${selfName}/`)) continue;

      deps.push({
        name: depName,
        specRequirement: requirement,
        fromSpec: rel,
      });
    }
  }

  return { specFiles, deps };
}

// -------------- Podfile / third_sdk.rb 解析 --------------

/**
 * 解析单行 pod 声明，返回 NniosPodSource，匹配不到返回 null
 * 支持示例：
 *   pod 'Foo'
 *   pod 'Foo', '1.2.3'
 *   pod 'Foo', '~> 1.2'
 *   pod 'Foo', :git => 'http://...', :branch => 'develop'
 *   pod "Foo", :tag => '1.0.0'
 */
export function parsePodLine(line: string, sourceFile: 'Podfile' | 'third_sdk.rb'): NniosPodSource | null {
  // 跳过注释和空行（整行 # ...，或单引号引起的名字前的 #）
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // 允许行内注释，去掉 # 到行末的部分（粗略处理，避免把字符串里 # 当注释）
  const withoutComment = stripInlineComment(trimmed);

  const nameMatch = withoutComment.match(/^pod\s+(['"])([^'"]+)\1\s*(.*)$/);
  if (!nameMatch) return null;
  const podName = nameMatch[2];
  const rest = nameMatch[3] || '';

  const result: NniosPodSource = {
    sourceFile,
    podName,
    raw: line.trim(),
  };

  // 第二个位置参数（版本或 requirement）
  // 只有当 rest 以逗号开头、且紧跟一个字符串字面量时才视为 version
  const versionMatch = rest.match(/^,\s*(['"])([^'"]+)\1\s*(.*)$/);
  if (versionMatch) {
    result.version = versionMatch[2];
  }

  // 解析所有 :key => 'value' 对
  const optRe = /:(\w+)\s*=>\s*(['"])([^'"]+)\2/g;
  let m: RegExpExecArray | null;
  while ((m = optRe.exec(rest))) {
    const key = m[1];
    const value = m[3];
    switch (key) {
      case 'git':
        result.git = value;
        break;
      case 'branch':
        result.branch = value;
        break;
      case 'tag':
        result.tag = value;
        break;
      case 'commit':
        result.commit = value;
        break;
      case 'path':
        result.pathRef = value;
        break;
    }
  }

  return result;
}

function stripInlineComment(s: string): string {
  // 只处理引号外的 #
  let inQuote: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === inQuote && s[i - 1] !== '\\') inQuote = null;
    } else {
      if (ch === "'" || ch === '"') inQuote = ch;
      else if (ch === '#') return s.slice(0, i).trim();
    }
  }
  return s;
}

export function parseNniosRubyFile(content: string, sourceFile: 'Podfile' | 'third_sdk.rb'): NniosPodSource[] {
  const out: NniosPodSource[] = [];
  for (const line of content.split(/\r?\n/)) {
    const parsed = parsePodLine(line, sourceFile);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function buildNniosIndex(
  branch: string,
  podfileContent: string | null,
  thirdSdkContent: string | null
): NniosIndex {
  const sources: NniosPodSource[] = [];
  const missingFiles: string[] = [];

  if (podfileContent != null) {
    sources.push(...parseNniosRubyFile(podfileContent, 'Podfile'));
  } else {
    missingFiles.push('Podfile');
  }
  if (thirdSdkContent != null) {
    sources.push(...parseNniosRubyFile(thirdSdkContent, 'third_sdk.rb'));
  } else {
    missingFiles.push('third_sdk.rb');
  }

  const byName = new Map<string, NniosPodSource[]>();
  for (const src of sources) {
    const keyFull = src.podName.toLowerCase();
    const arr = byName.get(keyFull) || [];
    arr.push(src);
    byName.set(keyFull, arr);
    // 如果是 Foo/Sub 也给主名建一个映射，便于反查时找得到
    const slashIdx = src.podName.indexOf('/');
    if (slashIdx > 0) {
      const mainKey = src.podName.slice(0, slashIdx).toLowerCase();
      const a2 = byName.get(mainKey) || [];
      a2.push(src);
      byName.set(mainKey, a2);
    }
  }

  return { branch, sources, byName, missingFiles };
}

// -------------- 主流程 --------------

export class PodDependencyResolver {
  /**
   * 解析 nnios 仓库指定分支的 Podfile / third_sdk.rb
   * 返回 Index；文件缺失时 missingFiles 会记录
   */
  async loadNniosIndex(
    branch: string,
    creds?: { username?: string; password?: string },
    workDir?: string,
    revision?: string
  ): Promise<NniosIndex> {
    const tmpRoot = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'pod-deps-'));
    let repoDir: string | undefined;
    try {
      repoDir = await shallowClone(currentMainRepoUrl(), branch, tmpRoot, creds, revision);

      const read = (rel: string): string | null => {
        const p = path.join(repoDir!, rel);
        return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
      };

      const podfile = read('Podfile');
      // third_sdk.rb 位置可能在根也可能在子目录，先尝试根，再 glob 扫一层
      let thirdSdk = read('third_sdk.rb');
      if (thirdSdk == null) {
        const found = findFileByName(repoDir, 'third_sdk.rb', 3);
        if (found) thirdSdk = fs.readFileSync(found, 'utf-8');
      }

      return buildNniosIndex(branch, podfile, thirdSdk);
    } finally {
      if (repoDir && fs.existsSync(repoDir)) {
        try {
          fs.rmSync(repoDir, { recursive: true, force: true });
        } catch (err: any) {
          logger.warn('清理 nnios 临时目录失败', { dir: repoDir, error: err.message });
        }
      }
      if (!workDir && fs.existsSync(tmpRoot)) {
        try {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * 解析单个仓库 + 分支的 podspec 依赖，用 nniosIndex 回填版本
   */
  async resolveRepo(
    repoUrl: string,
    branch: string,
    nniosIndex: NniosIndex,
    opts: ResolveOptions = {}
  ): Promise<RepoDependencyResult> {
    const name = extractRepoName(repoUrl);
    const tmpRoot = opts.workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'pod-deps-'));
    let repoDir: string | undefined;

    try {
      repoDir = await shallowClone(repoUrl, branch, tmpRoot, {
        username: opts.username,
        password: opts.password,
      });

      const { specFiles, deps } = parsePodspecDependencies(repoDir);

      const resolved: ResolvedDependency[] = deps.map((d) => {
        const matches = nniosIndex.byName.get(d.name.toLowerCase()) || [];
        // 优先非 subspec（podName 里不含 '/'）
        const main = matches.find((m) => !m.podName.includes('/')) || matches[0];
        return {
          ...d,
          resolved: matches.length > 0,
          match: main,
          allMatches: matches,
        };
      });

      // 去重 + 稳定排序：按 name 再按 fromSpec
      const seen = new Set<string>();
      const uniq = resolved.filter((d) => {
        const k = `${d.name}\u0001${d.specRequirement || ''}\u0001${d.fromSpec}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      uniq.sort(
        (a, b) => a.name.localeCompare(b.name) || a.fromSpec.localeCompare(b.fromSpec)
      );

      return {
        repo: name,
        url: repoUrl,
        branch,
        ok: true,
        specFiles: specFiles.map((p) => path.relative(repoDir!, p)),
        dependencies: uniq,
      };
    } catch (err: any) {
      logger.warn('解析仓库 podspec 依赖失败', { repo: name, branch, error: err.message });
      return {
        repo: name,
        url: repoUrl,
        branch,
        ok: false,
        error: err.message,
        specFiles: [],
        dependencies: [],
      };
    } finally {
      if (repoDir && fs.existsSync(repoDir)) {
        try {
          fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      if (!opts.workDir && fs.existsSync(tmpRoot)) {
        try {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * 批量解析多个仓库，共享同一份 nniosIndex
   */
  async resolveMany(
    repoUrls: string[],
    branch: string,
    opts: ResolveOptions = {}
  ): Promise<{
    nnios: { branch: string; missingFiles: string[]; sourceCount: number };
    results: RepoDependencyResult[];
  }> {
    const workDir = opts.workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'pod-deps-'));
    try {
      const nniosIndex =
        opts.nniosIndex ||
        (await this.loadNniosIndex(branch, { username: opts.username, password: opts.password }, workDir));

      // 对 nnios 仓库本身，不再重复扫自己的 podspec 依赖（可能没有 podspec）
      const mainRepoUrl = currentMainRepoUrl();
      const toResolve = repoUrls.filter((u) => extractRepoName(u) !== extractRepoName(mainRepoUrl));

      const results = await Promise.all(
        toResolve.map((u) =>
          this.resolveRepo(u, branch, nniosIndex, {
            username: opts.username,
            password: opts.password,
            workDir,
          })
        )
      );

      return {
        nnios: {
          branch: nniosIndex.branch,
          missingFiles: nniosIndex.missingFiles,
          sourceCount: nniosIndex.sources.length,
        },
        results,
      };
    } finally {
      if (!opts.workDir && fs.existsSync(workDir)) {
        try {
          fs.rmSync(workDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }
}

function findFileByName(root: string, name: string, maxDepth: number): string | null {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory() && depth < maxDepth) {
        if (['node_modules', 'Pods', 'build', 'DerivedData'].includes(e.name)) continue;
        queue.push({ dir: p, depth: depth + 1 });
      }
    }
  }
  return null;
}

export default new PodDependencyResolver();
