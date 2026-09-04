import { getDatabase } from '../database';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import * as tar from 'tar';
import AdmZip from 'adm-zip';
import logger from '../utils/logger';
import { FileHandlerService } from './FileHandlerService';
import { StorageService } from './StorageService';
import symbolicationCache from './SymbolicationCacheService';

export interface PodComponent {
  id: number;
  name: string;
  version: string;
  summary: string;
  homepage: string;
  source_zip_url: string;
  podspec_content: string;
  upload_time: string;
  status: 'uploaded' | 'published' | 'failed';
  error_message?: string;
  warning_message?: string;
  package_type?: 'release' | 'test';
  build_id?: string;
  nnios_branch?: string;
}

interface PodUploadParams {
  name: string;
  version: string;
  lib_type?: 'framework' | 'static_library'; // 库类型：framework 或 .a 静态库
  lib_name?: string;          // 库文件名，如 NNRtc.framework 或 libNNRtc.a
  summary?: string;
  homepage?: string;
  authors?: string;
  license?: string;
  platform_version?: string;
  dependencies?: string;      // JSON string of [{name, version}]
  sys_frameworks?: string;    // 系统 frameworks，逗号分隔
  sys_libraries?: string;     // 系统 libraries，逗号分隔
  target_branch?: string;     // 发布后同步到 nnios 的目标分支
  package_type?: 'release' | 'test';
  build_id?: string;
  nnios_branch?: string;
}

export interface LeigodIMSDKVersion {
  version: string;
  path: string;
  packageName?: string;
  hasFramework: boolean;
  hasDSYM: boolean;
  updatedAt?: string;
}

const NEXUS_BASE_URL = 'http://172.31.4.4:9091/repository/nn_ios';
const NEXUS_USER = 'admin';
const NEXUS_PASS = 'admin123';
const SPEC_REPO_URL = 'http://rentao:renyang%40666@git.leigod.top/nn_ios/nnspec.git';
const SPEC_REPO_LOCAL = path.join(process.env.UPLOAD_DIR || '/tmp', '../pods-spec-repo');
const NNIOS_REPO_URL = process.env.NNIOS_REPO_URL || 'http://git.leigod.top/nn_ios/nnios.git';
const NNIOS_REPO_LOCAL = path.resolve(
  process.env.NNIOS_REPO_LOCAL ||
    path.join(process.env.GIT_WORK_DIR || path.join(process.env.UPLOAD_DIR || '/tmp', '../git-workspace'), 'nnios')
);
const LEIGOD_IM_SDK_DIR_CANDIDATES = [
  process.env.LEIGOD_IM_SDK_DIR,
  '/Volumes/IMSDK',
  '/Volumes/share/IMSDK',
  '/Volumes/share',
].filter(Boolean) as string[];
const LEIGOD_IM_SDK_SMB_URL = 'smb://192.168.3.30/share/IMSDK';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNNRtcTestVersion(version?: string) {
  return /(?:_test|-test)$/.test(String(version || ''));
}

function isPrivateNniosComponent(name: string) {
  return ['NNRtc', 'leigod_im_cross_sdk'].includes(String(name || '').trim());
}

function arrayify<T = any>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeNNRtcTestVersion(version: string) {
  if (version.endsWith('-test')) return version;
  if (version.endsWith('_test')) return version.replace(/_test$/, '-test');
  return `${version}-test`;
}

function compareVersionNameDesc(a: string, b: string): number {
  const tokenize = (value: string) => value
    .split(/([0-9]+)/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
  const left = tokenize(a);
  const right = tokenize(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return 1;
    if (r === undefined) return -1;
    if (l === r) continue;
    if (typeof l === 'number' && typeof r === 'number') return r - l;
    return String(r).localeCompare(String(l), 'zh-CN', { numeric: true });
  }
  return 0;
}

export class PodService {
  private get db() {
    return getDatabase();
  }
  private fileHandler = new FileHandlerService();
  private storage = new StorageService();

  /**
   * 初始化 pods_components 表
   */
  initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pods_components (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        summary TEXT DEFAULT '',
        homepage TEXT DEFAULT '',
        source_zip_url TEXT NOT NULL,
        podspec_content TEXT NOT NULL,
        upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'uploaded',
        error_message TEXT,
        package_type TEXT,
        build_id TEXT,
        nnios_branch TEXT,
        UNIQUE(name, version)
      );
      CREATE INDEX IF NOT EXISTS idx_pod_name ON pods_components(name);
      CREATE INDEX IF NOT EXISTS idx_pod_version ON pods_components(name, version);
    `);

    const columns = (this.db.prepare('PRAGMA table_info(pods_components)').all() as any[])
      .map((column) => column.name);
    if (!columns.includes('package_type')) {
      this.db.prepare('ALTER TABLE pods_components ADD COLUMN package_type TEXT').run();
    }
    if (!columns.includes('build_id')) {
      this.db.prepare('ALTER TABLE pods_components ADD COLUMN build_id TEXT').run();
    }
    if (!columns.includes('nnios_branch')) {
      this.db.prepare('ALTER TABLE pods_components ADD COLUMN nnios_branch TEXT').run();
    }

    // 异步确保需要的第三方 spec repos 已注册（不阻塞启动）
    this.ensureSpecRepos().catch((err) => {
      logger.warn('确保 spec repos 失败', { error: err.message });
    });
    this.cleanupNNRtcTestDSYMs().catch((err) => {
      logger.warn('清理 NNRtc 测试包 dSYM 失败', { error: err.message });
    });
  }

  /**
   * 自动注册需要的第三方 spec repos（如 aliyun-specs）
   * 已经存在则跳过；执行幂等
   */
  private async ensureSpecRepos(): Promise<void> {
    const wanted: Array<{ name: string; url: string }> = [
      { name: 'aliyun-specs', url: 'https://github.com/aliyun/aliyun-specs.git' },
    ];

    let listOutput = '';
    try {
      listOutput = execSync('pod repo list 2>/dev/null', { encoding: 'utf-8', timeout: 15000 });
    } catch {
      // pod 命令不可用，直接放弃
      return;
    }

    for (const repo of wanted) {
      // pod repo list 输出里 URL 行类似 "- URL:  https://github.com/aliyun/aliyun-specs.git"
      const alreadyAdded = listOutput.includes(repo.url);
      if (alreadyAdded) continue;

      logger.info('注册 spec 仓库', { name: repo.name, url: repo.url });
      try {
        execSync(`pod repo add ${repo.name} ${repo.url}`, {
          encoding: 'utf-8',
          timeout: 120000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        logger.info('spec 仓库注册成功', { name: repo.name });
      } catch (err: any) {
        logger.warn('注册 spec 仓库失败', {
          name: repo.name,
          url: repo.url,
          error: err.message,
        });
      }
    }
  }

  /**
   * 上传 zip 到 Nexus 仓库（带认证）
   */
  async uploadToNexus(filePath: string, name: string, version: string): Promise<string> {
    const targetUrl = `${NEXUS_BASE_URL}/${name}/${version}.zip`;

    logger.info('上传组件到 Nexus', { name, version, targetUrl });

    try {
      const cmd = `curl -s -w "%{http_code}" -u "${NEXUS_USER}:${NEXUS_PASS}" --upload-file "${filePath}" "${targetUrl}"`;
      const result = execSync(cmd, { encoding: 'utf-8', timeout: 120000 });

      const statusCode = result.trim().slice(-3);
      const statusNum = parseInt(statusCode, 10);

      if (statusNum >= 200 && statusNum < 300) {
        logger.info('Nexus 上传成功', { name, version, statusCode });
        return targetUrl;
      } else {
        throw new Error(`Nexus 上传失败，HTTP 状态码: ${statusCode}`);
      }
    } catch (error: any) {
      logger.error('Nexus 上传失败', { name, version, error: error.message });
      throw new Error(`上传到 Nexus 失败: ${error.message}`);
    }
  }

  /**
   * 将上传的文件自动打包为 zip
   * 支持：.zip（直接使用）、.framework（zip 打包）、.a（zip 打包）
   * 如果上传的是 zip 文件则直接返回原路径
   */
  async packToZip(filePath: string, originalName: string): Promise<{ zipPath: string; needCleanup: boolean }> {
    const ext = path.extname(originalName).toLowerCase();

    // 已经是 zip，直接使用
    if (ext === '.zip') {
      return { zipPath: filePath, needCleanup: false };
    }

    const uploadDir = process.env.UPLOAD_DIR || '/tmp';
    const zipPath = path.join(uploadDir, `pod_${Date.now()}.zip`);

    if (ext === '.a') {
      // .a 静态库：直接压缩文件
      logger.info('打包 .a 文件为 zip', { originalName });
      // 先把文件重命名为原始文件名，再压缩
      const tempDir = path.join(uploadDir, `pod_pack_${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      const targetFile = path.join(tempDir, originalName);
      fs.copyFileSync(filePath, targetFile);
      execSync(`cd "${tempDir}" && zip -r "${zipPath}" "${originalName}"`, {
        encoding: 'utf-8',
        timeout: 60000,
      });
      // 清理临时目录
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { zipPath, needCleanup: true };
    }

    if (ext === '.framework' || originalName.endsWith('.framework.zip')) {
      // .framework 通常作为目录上传，但 multer 只能接收单文件
      // 如果用户上传的是 framework 压缩后的文件（无 .zip 后缀），直接当 zip 用
      // 实际上浏览器上传文件夹会被压缩，这里兜底处理
      logger.info('打包 framework 文件为 zip', { originalName });
      const tempDir = path.join(uploadDir, `pod_pack_${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      const targetFile = path.join(tempDir, originalName);
      fs.copyFileSync(filePath, targetFile);
      execSync(`cd "${tempDir}" && zip -r "${zipPath}" "${originalName}"`, {
        encoding: 'utf-8',
        timeout: 60000,
      });
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { zipPath, needCleanup: true };
    }

    // 其他格式：直接压缩
    logger.info('打包文件为 zip', { originalName, ext });
    const tempDir = path.join(uploadDir, `pod_pack_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const targetFile = path.join(tempDir, originalName);
    fs.copyFileSync(filePath, targetFile);
    execSync(`cd "${tempDir}" && zip -r "${zipPath}" "${originalName}"`, {
      encoding: 'utf-8',
      timeout: 60000,
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
    return { zipPath, needCleanup: true };
  }

  /**
   * 生成 podspec 内容
   */
  generatePodspec(params: PodUploadParams, sha256?: string): string {
    const {
      name,
      version,
      lib_type = 'framework',
      lib_name,
      summary = `${name} iOS 组件`,
      homepage = `http://git.leigod.top/nn_ios/${name}`,
      authors = 'NN iOS Team',
      license = 'MIT',
      platform_version = '12.0',
      dependencies,
      sys_frameworks,
      sys_libraries,
    } = params;

    const sourceUrl = `${NEXUS_BASE_URL}/${name}/${version}.zip`;

    let sourceLine: string;
    if (sha256) {
      sourceLine = `  s.source       = { :http => '${sourceUrl}', :sha256 => '${sha256}' }`;
    } else {
      sourceLine = `  s.source       = { :http => '${sourceUrl}' }`;
    }

    let spec = `Pod::Spec.new do |s|
  s.name         = '${name}'
  s.version      = '${version}'
  s.summary      = '${summary}'
  s.homepage     = '${homepage}'
  s.license      = { :type => '${license}' }
  s.authors      = '${authors}'
${sourceLine}
  s.platform     = :ios, '${platform_version}'
`;

    if (lib_type === 'static_library') {
      // .a 静态库
      const aName = lib_name || `lib${name}.a`;
      const baseName = aName.replace(/^lib/, '').replace(/\.a$/, '');
      spec += `  s.vendored_libraries   = '${aName}'\n`;
      spec += `  s.public_header_files  = '${baseName}.Headers/**/*.h'\n`;
      spec += `  s.source_files         = '${baseName}.Headers/**/*.h'\n`;
    } else {
      // framework（默认）
      const fwName = lib_name || `${name}.framework`;
      spec += `  s.vendored_frameworks = '${fwName}'\n`;
      // 如果 framework 路径包含子目录，添加 preserve_paths
      if (fwName.includes('/')) {
        spec += `  s.preserve_paths      = '${fwName}'\n`;
      }
    }

    // 系统 frameworks
    if (sys_frameworks) {
      const fws = sys_frameworks.split(',').map(f => `'${f.trim()}'`).filter(f => f !== "''").join(', ');
      if (fws) {
        spec += `  s.frameworks          = ${fws}\n`;
      }
    }

    // 系统 libraries
    if (sys_libraries) {
      const libs = sys_libraries.split(',').map(l => `'${l.trim()}'`).filter(l => l !== "''").join(', ');
      if (libs) {
        spec += `  s.libraries           = ${libs}\n`;
      }
    }

    // Pod 依赖
    if (dependencies) {
      try {
        const deps = JSON.parse(dependencies);
        if (Array.isArray(deps)) {
          deps.forEach((dep: { name: string; version?: string }) => {
            if (dep.version) {
              spec += `  s.dependency '${dep.name}', '${dep.version}'\n`;
            } else {
              spec += `  s.dependency '${dep.name}'\n`;
            }
          });
        }
      } catch {
        // 忽略解析错误
      }
    }

    spec += `end\n`;
    return spec;
  }

  /**
   * 同步 podspec 到 git 仓库
   */
  async syncToSpecRepo(name: string, version: string, podspecContent: string): Promise<void> {
    logger.info('同步 podspec 到 spec 仓库', { name, version });

    try {
      // 确保本地 spec 仓库存在
      if (!fs.existsSync(SPEC_REPO_LOCAL)) {
        logger.info('克隆 spec 仓库', { url: SPEC_REPO_URL });
        execSync(`git clone "${SPEC_REPO_URL}" "${SPEC_REPO_LOCAL}"`, {
          encoding: 'utf-8',
          timeout: 60000,
        });
      } else {
        // 拉取最新代码
        execSync('git pull origin master || git pull origin main || true', {
          cwd: SPEC_REPO_LOCAL,
          encoding: 'utf-8',
          timeout: 30000,
        });
      }

      // 创建目录结构: name/version/name.podspec
      const specDir = path.join(SPEC_REPO_LOCAL, name, version);
      fs.mkdirSync(specDir, { recursive: true });

      // 写入 podspec 文件
      const specFilePath = path.join(specDir, `${name}.podspec`);
      fs.writeFileSync(specFilePath, podspecContent, 'utf-8');

      // Git add, commit, push
      execSync('git add -A', { cwd: SPEC_REPO_LOCAL, encoding: 'utf-8' });

      const commitMsg = `[Auto] Update ${name} ${version}`;
      execSync(`git commit -m "${commitMsg}" --allow-empty`, {
        cwd: SPEC_REPO_LOCAL,
        encoding: 'utf-8',
      });

      execSync('git push origin HEAD', {
        cwd: SPEC_REPO_LOCAL,
        encoding: 'utf-8',
        timeout: 30000,
      });

      logger.info('Spec 仓库同步成功', { name, version });
    } catch (error: any) {
      logger.error('Spec 仓库同步失败', { name, version, error: error.message });
      throw new Error(`同步 spec 仓库失败: ${error.message}`);
    }
  }

  /**
   * 同版本重新发布前清理服务器本机的 podx 缓存。
   */
  private cleanPodxCache(name: string): void {
    try {
      logger.info('检测到相同版本组件，执行 podx clean', { name });
      const podxWorkDir = fs.existsSync(path.join(NNIOS_REPO_LOCAL, 'Podfile'))
        ? NNIOS_REPO_LOCAL
        : process.cwd();
      execSync(`podx clean ${shellQuote(name)}`, {
        encoding: 'utf-8',
        timeout: 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: podxWorkDir,
        env: {
          ...process.env,
          PATH: [
            path.join(process.env.HOME || '/Users/a1', '.local/bin'),
            '/opt/homebrew/bin',
            '/usr/local/bin',
            process.env.PATH || '',
          ].join(':'),
        },
      });
      logger.info('podx clean 执行成功', { name, cwd: podxWorkDir });
    } catch (error: any) {
      const detail = error.stderr?.toString?.() || error.stdout?.toString?.() || error.message;
      logger.error('podx clean 执行失败', { name, error: detail });
      throw new Error(`已存在相同版本，执行 podx clean ${name} 失败: ${detail}`);
    }
  }

  private normalizeNniosBranch(branch?: string): string | undefined {
    const normalized = (branch || '').trim().replace(/^origin\//, '');
    if (!normalized) return undefined;
    try {
      execSync(`git check-ref-format --branch ${shellQuote(normalized)}`, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error('nnios 目标分支名称不是合法的 git 分支');
    }
    return normalized;
  }

  private assertNniosBranchExists(branch: string): void {
    try {
      execSync(`git ls-remote --exit-code --heads ${shellQuote(NNIOS_REPO_URL)} ${shellQuote(branch)}`, {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      throw new Error(`nnios 分支 ${branch} 不存在或无法访问: ${error.message}`);
    }
  }

  private checkoutNniosBranch(branch: string): string {
    const targetBranch = this.normalizeNniosBranch(branch);
    if (!targetBranch) {
      throw new Error('nnios 目标分支不能为空');
    }

    this.assertNniosBranchExists(targetBranch);
    if (!fs.existsSync(path.join(NNIOS_REPO_LOCAL, '.git'))) {
      fs.mkdirSync(path.dirname(NNIOS_REPO_LOCAL), { recursive: true });
      execSync(`git clone ${shellQuote(NNIOS_REPO_URL)} ${shellQuote(NNIOS_REPO_LOCAL)}`, {
        encoding: 'utf-8',
        timeout: 120000,
      });
    }

    execSync('git fetch origin --prune', { cwd: NNIOS_REPO_LOCAL, encoding: 'utf-8', timeout: 60000 });
    execSync(`git checkout -B ${shellQuote(targetBranch)} ${shellQuote(`origin/${targetBranch}`)}`, {
      cwd: NNIOS_REPO_LOCAL,
      encoding: 'utf-8',
      timeout: 60000,
    });
    execSync(`git pull --ff-only origin ${shellQuote(targetBranch)}`, {
      cwd: NNIOS_REPO_LOCAL,
      encoding: 'utf-8',
      timeout: 60000,
    });

    return targetBranch;
  }

  private findPodVersionInRuby(content: string, name: string): string | null {
    const escapedName = escapeRegExp(name);
    const pattern = new RegExp(
      `^\\s*(?:xcpod|pod)\\s+['"]${escapedName}['"]\\s*,\\s*['"]([^'"]+)['"]`,
      'm'
    );
    return content.match(pattern)?.[1] || null;
  }

  private getNniosPodVersion(name: string, branch: string): { branch: string; version: string | null } {
    const targetBranch = this.checkoutNniosBranch(branch);
    const candidateFiles = ['Podfile', path.join('NNIM', 'third_sdk.rb')];

    for (const relativePath of candidateFiles) {
      const filePath = path.join(NNIOS_REPO_LOCAL, relativePath);
      if (!fs.existsSync(filePath)) continue;

      const version = this.findPodVersionInRuby(fs.readFileSync(filePath, 'utf-8'), name);
      if (version) {
        return { branch: targetBranch, version };
      }
    }

    return { branch: targetBranch, version: null };
  }

  private verifyNniosThirdSdkVersion(name: string, version: string, branch: string): void {
    const thirdSdkPath = path.join(NNIOS_REPO_LOCAL, 'NNIM', 'third_sdk.rb');
    if (!fs.existsSync(thirdSdkPath)) {
      throw new Error(`nnios/${branch} 缺少 NNIM/third_sdk.rb，无法确认 ${name} 版本`);
    }

    const actualVersion = this.findPodVersionInRuby(fs.readFileSync(thirdSdkPath, 'utf-8'), name);
    if (actualVersion !== version) {
      throw new Error(
        `nnios/${branch} 的 NNIM/third_sdk.rb 未同步到 ${name}@${version}，当前为 ${actualVersion || '未找到'}`
      );
    }

    logger.info('nnios third_sdk.rb 版本确认成功', {
      name,
      version,
      targetBranch: branch,
      relativePath: 'NNIM/third_sdk.rb',
    });
  }

  private updatePodVersionInRuby(content: string, name: string, version: string): { content: string; changed: boolean } {
    const escapedName = escapeRegExp(name);
    let changed = false;

    const withVersionPattern = new RegExp(
      `(^\\s*(?:xcpod|pod)\\s+['"]${escapedName}['"]\\s*,\\s*)['"][^'"]+['"]([^\\n]*)`,
      'm'
    );
    const dedupe = (text: string) => {
      let seen = false;
      return text
        .split('\n')
        .filter((line) => {
          if (!new RegExp(`^\\s*(?:xcpod|pod)\\s+['"]${escapedName}['"]`).test(line)) return true;
          if (!seen) {
            seen = true;
            return true;
          }
          changed = true;
          return false;
        })
        .join('\n');
    };

    const placeExternalPodInExternalSection = (text: string) => {
      const lines = text.split('\n');
      const podLinePattern = new RegExp(`^\\s*(?:xcpod|pod)\\s+['"]${escapedName}['"]`);
      const podIndex = lines.findIndex((line) => podLinePattern.test(line));
      let externalIndex = lines.findIndex((line) => /^\s*#\s*外部组件\s*$/.test(line));
      if (podIndex < 0 || externalIndex < 0 || podIndex === externalIndex + 1) return text;
      const [podLine] = lines.splice(podIndex, 1);
      externalIndex = lines.findIndex((line) => /^\s*#\s*外部组件\s*$/.test(line));
      const insertIndex = lines.findIndex((line, index) => index > externalIndex && /^\s*(?:#|end\s*$)/.test(line));
      lines.splice(insertIndex >= 0 ? insertIndex : externalIndex + 1, 0, podLine);
      changed = true;
      return lines.join('\n');
    };

    if (withVersionPattern.test(content)) {
      const replaced = content.replace(withVersionPattern, (match, prefix, suffix) => {
        const nextLine = `${prefix}'${version}'${suffix || ''}`;
        changed = nextLine !== match;
        return nextLine;
      });
      return { content: placeExternalPodInExternalSection(dedupe(replaced)), changed };
    }

    const noVersionPattern = new RegExp(`(^\\s*pod\\s+['"]${escapedName}['"])([^\\n]*)`, 'm');
    if (noVersionPattern.test(content)) {
      const replaced = content.replace(noVersionPattern, (match, prefix, suffix) => {
        const cleanSuffix = String(suffix || '').replace(/^\s*,?\s*/, '');
        const nextLine = `${prefix}, '${version}'${cleanSuffix ? `, ${cleanSuffix}` : ''}`;
        changed = nextLine !== match;
        return nextLine;
      });
      return { content: placeExternalPodInExternalSection(dedupe(replaced)), changed };
    }

    return { content, changed: false };
  }

  private appendPodToThirdSdk(content: string, name: string, version: string): { content: string; changed: boolean } {
    const marker = /^\s*end\s*$/gm;
    const matches = [...content.matchAll(marker)];
    if (matches.length === 0) {
      return { content, changed: false };
    }

    const last = matches[matches.length - 1];
    const insertAt = last.index ?? content.length;
    const sectionTitle = isPrivateNniosComponent(name) ? '内部组件' : '外部组件';
    const line = `    pod   '${name}', '${version}'\n`;
    return {
      content: `${content.slice(0, insertAt)}\n    # ${sectionTitle}\n${line}${content.slice(insertAt)}`,
      changed: true,
    };
  }

  /**
   * 发布成功后，将当前组件版本同步到 nnios 指定分支。
   */
  private syncVersionToNnios(name: string, version: string, branch?: string): void {
    const targetBranch = this.normalizeNniosBranch(branch);
    if (!targetBranch) return;

    this.assertNniosBranchExists(targetBranch);
    logger.info('同步组件版本到 nnios', { name, version, targetBranch, repo: NNIOS_REPO_LOCAL });

    try {
      this.checkoutNniosBranch(targetBranch);

      const candidateFiles = ['Podfile', path.join('NNIM', 'third_sdk.rb')];
      let changed = false;
      let matchedExisting = false;

      for (const relativePath of candidateFiles) {
        const filePath = path.join(NNIOS_REPO_LOCAL, relativePath);
        if (!fs.existsSync(filePath)) continue;

        const original = fs.readFileSync(filePath, 'utf-8');
        const updated = this.updatePodVersionInRuby(original, name, version);
        if (updated.changed) {
          fs.writeFileSync(filePath, updated.content, 'utf-8');
          changed = true;
          matchedExisting = true;
          logger.info('更新 nnios 组件版本声明', { relativePath, name, version });
        }
      }

      if (!matchedExisting) {
        const thirdSdkPath = path.join(NNIOS_REPO_LOCAL, 'NNIM', 'third_sdk.rb');
        if (!fs.existsSync(thirdSdkPath)) {
          throw new Error('未找到组件声明，且 NNIM/third_sdk.rb 不存在，无法追加');
        }
        const original = fs.readFileSync(thirdSdkPath, 'utf-8');
        const appended = this.appendPodToThirdSdk(original, name, version);
        if (!appended.changed) {
          throw new Error('未找到组件声明，且无法定位 third_sdk.rb 追加位置');
        }
        fs.writeFileSync(thirdSdkPath, appended.content, 'utf-8');
        changed = true;
        logger.info('追加 nnios 组件版本声明', { relativePath: 'NNIM/third_sdk.rb', name, version });
      }

      if (!changed) {
        logger.info('nnios 组件版本无需更新', { name, version, targetBranch });
        return;
      }

      const diffNameOnly = execSync('git diff --name-only', {
        cwd: NNIOS_REPO_LOCAL,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
      if (!diffNameOnly) {
        logger.info('nnios 工作区无变更，跳过提交', { name, version, targetBranch });
        this.verifyNniosThirdSdkVersion(name, version, targetBranch);
        return;
      }

      execSync('git add Podfile NNIM/third_sdk.rb', { cwd: NNIOS_REPO_LOCAL, encoding: 'utf-8' });
      execSync(`git commit -m ${shellQuote(`chore: update ${name} to ${version}`)}`, {
        cwd: NNIOS_REPO_LOCAL,
        encoding: 'utf-8',
        timeout: 60000,
      });
      execSync(`git push origin ${shellQuote(targetBranch)}`, {
        cwd: NNIOS_REPO_LOCAL,
        encoding: 'utf-8',
        timeout: 60000,
      });

      this.verifyNniosThirdSdkVersion(name, version, targetBranch);
      logger.info('nnios 分支同步成功', { name, version, targetBranch });
    } catch (error: any) {
      logger.error('同步组件版本到 nnios 失败', { name, version, targetBranch, error: error.message });
      throw new Error(`同步到 nnios/${targetBranch} 失败: ${error.message}`);
    }
  }

  /**
   * 从 spec 仓库中删除指定版本或整个组件目录
   * @param name 组件名称
   * @param version 版本号（不传则删除整个组件目录）
   */
  private async deleteFromSpecRepo(name: string, version?: string): Promise<void> {
    try {
      if (!fs.existsSync(SPEC_REPO_LOCAL)) {
        logger.warn('spec 仓库本地目录不存在，跳过删除', { name, version });
        return;
      }

      // 拉取最新
      execSync('git pull origin master || git pull origin main || true', {
        cwd: SPEC_REPO_LOCAL,
        encoding: 'utf-8',
        timeout: 30000,
      });

      // 确定要删除的目录
      const targetDir = version
        ? path.join(SPEC_REPO_LOCAL, name, version)
        : path.join(SPEC_REPO_LOCAL, name);

      if (!fs.existsSync(targetDir)) {
        logger.info('spec 仓库中目录不存在，无需删除', { name, version, targetDir });
        return;
      }

      // 删除目录
      fs.rmSync(targetDir, { recursive: true, force: true });

      // 如果删除的是版本目录，检查组件目录是否为空，为空也删掉
      if (version) {
        const componentDir = path.join(SPEC_REPO_LOCAL, name);
        if (fs.existsSync(componentDir) && fs.readdirSync(componentDir).length === 0) {
          fs.rmSync(componentDir, { recursive: true, force: true });
        }
      }

      // Git add, commit, push
      execSync('git add -A', { cwd: SPEC_REPO_LOCAL, encoding: 'utf-8' });

      const what = version ? `${name}/${version}` : name;
      try {
        execSync(`git commit -m "[Auto] Remove ${what}"`, {
          cwd: SPEC_REPO_LOCAL,
          encoding: 'utf-8',
        });
        execSync('git push origin HEAD', {
          cwd: SPEC_REPO_LOCAL,
          encoding: 'utf-8',
          timeout: 30000,
        });
        logger.info('spec 仓库删除成功', { name, version });
      } catch {
        // 没有变更（目录已经不存在）时 commit 会失败，忽略
        logger.info('spec 仓库无变更需要提交', { name, version });
      }
    } catch (error: any) {
      // 删除 spec 仓库失败不应阻断主流程
      logger.error('删除 spec 仓库失败', { name, version, error: error.message });
    }
  }

  /**
   * 自动检测 zip 包内的库类型和文件名
   * 解压后扫描是否包含 .framework 或 .a 文件
   */
  detectLibType(zipPath: string): { lib_type: 'framework' | 'static_library'; lib_name: string } | null {
    try {
      // 用 unzip -l 列出 zip 内容，不实际解压
      // 输出格式：  Length      Date    Time    Name
      //            --------  ---------- -----   ----
      //                   0  04-23-2026 21:10   QTCommon_1.5.8.PX/QTCommon.xcframework/
      const listing = execSync(`unzip -l "${zipPath}"`, { encoding: 'utf-8', timeout: 10000 });
      const lines = listing.split('\n');

      // 查找 .xcframework 目录（优先级高于 .framework）— 保留完整相对路径
      for (const line of lines) {
        const match = line.match(/\s+((\S+\.xcframework)\/)\s*$/);
        if (match) {
          const fwPath = match[2]; // e.g. QTCommon_1.5.8.PX/QTCommon.xcframework
          logger.info('自动检测到 xcframework', { lib_name: fwPath });
          return { lib_type: 'framework', lib_name: fwPath };
        }
      }

      // 查找 .framework 目录 — 保留完整相对路径
      for (const line of lines) {
        const match = line.match(/\s+((\S+\.framework)\/)\s*$/);
        if (match) {
          const fwPath = match[2]; // e.g. leigod_im_cross_sdk.framework 或 prefix/xxx.framework
          logger.info('自动检测到 framework', { lib_name: fwPath });
          return { lib_type: 'framework', lib_name: fwPath };
        }
      }

      // 查找 .a 文件 — 只匹配行尾的文件名部分
      for (const line of lines) {
        const match = line.match(/\s+(\S+\.a)\s*$/);
        if (match) {
          const aFile = match[1]; // e.g. libNNRtc.a
          // 去掉路径前缀，只取文件名
          const aName = aFile.split('/').pop() || aFile;
          logger.info('自动检测到静态库', { lib_name: aName });
          return { lib_type: 'static_library', lib_name: aName };
        }
      }

      return null;
    } catch (error: any) {
      logger.warn('自动检测库类型失败', { error: error.message });
      return null;
    }
  }

  private validateFrameworkNameMatchesComponent(componentName: string, detected: { lib_type: 'framework' | 'static_library'; lib_name: string } | null): void {
    if (!detected || detected.lib_type !== 'framework') return;

    const frameworkName = path.basename(detected.lib_name)
      .replace(/\.xcframework$/i, '')
      .replace(/\.framework$/i, '');
    if (frameworkName !== componentName) {
      throw new Error(`上传包内 framework 名称 ${path.basename(detected.lib_name)} 与组件名 ${componentName} 不一致`);
    }
  }

  private findDirectoryByName(rootDir: string, dirName: string): string | null {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '__MACOSX' || entry.name.startsWith('.')) continue;
      const fullPath = path.join(rootDir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === dirName) return fullPath;
      const nested = this.findDirectoryByName(fullPath, dirName);
      if (nested) return nested;
    }
    return null;
  }

  private isSupportedFrameworkPackage(fileName: string): boolean {
    const lowerName = fileName.toLowerCase();
    return !path.basename(fileName).startsWith('._') &&
      (lowerName.endsWith('.zip') || lowerName.endsWith('.tgz') || lowerName.endsWith('.tar.gz'));
  }

  private getLeigodIMSDKRoot(): string {
    const root = LEIGOD_IM_SDK_DIR_CANDIDATES.find((candidate) => {
      try {
        return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    });
    if (!root) {
      this.openLeigodIMSDKShare();
      throw new Error(`IMSDK 共享目录未挂载，已尝试打开 ${LEIGOD_IM_SDK_SMB_URL}。请完成登录后重试，或配置 LEIGOD_IM_SDK_DIR`);
    }
    return root;
  }

  private openLeigodIMSDKShare(): void {
    if (process.platform !== 'darwin') return;
    try {
      execSync(`open ${shellQuote(LEIGOD_IM_SDK_SMB_URL)}`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: 'ignore',
      });
      logger.info('已尝试打开 IMSDK SMB 共享目录', { url: LEIGOD_IM_SDK_SMB_URL });
    } catch (error: any) {
      logger.warn('打开 IMSDK SMB 共享目录失败', { url: LEIGOD_IM_SDK_SMB_URL, error: error.message });
    }
  }

  private resolveLeigodIMSDKVersionDir(version: string): string {
    const cleanVersion = String(version || '').trim();
    if (!cleanVersion || cleanVersion.includes('/') || cleanVersion.includes('\\') || cleanVersion.includes('..')) {
      throw new Error('IMSDK 版本号不合法');
    }
    const root = this.getLeigodIMSDKRoot();
    const versionDir = path.join(root, cleanVersion);
    if (!fs.existsSync(versionDir) || !fs.statSync(versionDir).isDirectory()) {
      throw new Error(`IMSDK 共享目录中未找到版本 ${cleanVersion}`);
    }
    return versionDir;
  }

  private findLeigodIMSDKPackage(versionDir: string): string | null {
    const entries = fs.readdirSync(versionDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && this.isSupportedFrameworkPackage(entry.name))
      .map((entry) => path.join(versionDir, entry.name));
    if (files.length === 0) return null;

    const preferred = files.find((file) => /^leigod_im_cross_sdk.*\.(zip|tgz|tar\.gz)$/i.test(path.basename(file)));
    return preferred || files[0];
  }

  private getHighestComponentVersion(name: string): string {
    const rows = this.db
      .prepare('SELECT version FROM pods_components WHERE name = ?')
      .all(name) as Array<{ version: string }>;
    return rows
      .map((row) => String(row.version || '').trim())
      .filter(Boolean)
      .sort(compareVersionNameDesc)[0] || '';
  }

  listLeigodIMSDKVersions(): LeigodIMSDKVersion[] {
    const root = this.getLeigodIMSDKRoot();
    const currentHighestVersion = this.getHighestComponentVersion('leigod_im_cross_sdk');
    const entries = fs.readdirSync(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && /^\d+(?:\.\d+)+(?:[._-][A-Za-z0-9]+)*$/.test(entry.name))
      .map((entry) => {
        const versionDir = path.join(root, entry.name);
        const frameworkPath = path.join(versionDir, 'leigod_im_cross_sdk.framework');
        const dsymPath = path.join(versionDir, 'leigod_im_cross_sdk.dSYM');
        const packagePath = this.findLeigodIMSDKPackage(versionDir);
        const stat = fs.statSync(versionDir);
        return {
          version: entry.name,
          path: versionDir,
          packageName: undefined,
          hasFramework: fs.existsSync(frameworkPath),
          hasDSYM: false,
          updatedAt: stat.mtime.toISOString(),
        };
      })
      .filter((item) => Boolean(this.findLeigodIMSDKPackage(item.path)))
      .filter((item) => !currentHighestVersion || compareVersionNameDesc(item.version, currentHighestVersion) < 0)
      .sort((a, b) => compareVersionNameDesc(a.version, b.version))
      .slice(0, 8);
  }

  private async prepareFrameworkDSYMFromDirectory(
    versionDir: string,
    componentName: string
  ): Promise<{
    workDir: string;
    frameworkPath: string;
    dsymPath?: string;
    frameworkZipPath: string;
  }> {
    const frameworkName = `${componentName}.framework`;
    const dsymName = `${componentName}.dSYM`;
    const frameworkPath = this.findDirectoryByName(versionDir, frameworkName);
    if (!frameworkPath) {
      throw new Error(`IMSDK 版本目录内未找到 ${frameworkName}`);
    }
    const uploadDir = process.env.UPLOAD_DIR || '/tmp';
    const safeName = componentName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const workDir = path.join(uploadDir, `${safeName}_smb_${Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });
    const sourceDsymPath = this.findDirectoryByName(versionDir, dsymName) || undefined;
    const dsymPath = sourceDsymPath ? path.join(workDir, dsymName) : undefined;
    if (sourceDsymPath && dsymPath) {
      fs.cpSync(sourceDsymPath, dsymPath, { recursive: true });
    }
    const frameworkZipPath = path.join(uploadDir, `${safeName}_${Date.now()}.zip`);
    execSync(`cd ${shellQuote(path.dirname(frameworkPath))} && zip -r ${shellQuote(frameworkZipPath)} ${shellQuote(path.basename(frameworkPath))}`, {
      encoding: 'utf-8',
      timeout: 120000,
    });
    return { workDir, frameworkPath, dsymPath, frameworkZipPath };
  }

  private async extractFrameworkDSYMPackage(
    packagePath: string,
    originalFileName: string | undefined,
    componentName: string,
    requireDSYM = false
  ): Promise<{
    workDir: string;
    frameworkPath: string;
    dsymPath?: string;
    frameworkZipPath: string;
  }> {
    const uploadDir = process.env.UPLOAD_DIR || '/tmp';
    const safeName = componentName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const workDir = path.join(uploadDir, `${safeName}_pkg_${Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });

    try {
      const lowerName = (originalFileName || packagePath).toLowerCase();
      if (lowerName.endsWith('.tgz') || lowerName.endsWith('.tar.gz')) {
        await tar.x({ file: packagePath, cwd: workDir });
      } else if (lowerName.endsWith('.zip')) {
        new AdmZip(packagePath).extractAllTo(workDir, true);
      } else {
        throw new Error('仅支持 .zip、.tgz 或 .tar.gz 包');
      }

      const frameworkName = `${componentName}.framework`;
      const dsymName = `${componentName}.dSYM`;
      const frameworkPath = this.findDirectoryByName(workDir, frameworkName);
      const dsymPath = this.findDirectoryByName(workDir, dsymName);
      if (!frameworkPath) {
        throw new Error(`包内未找到 ${frameworkName}`);
      }
      if (requireDSYM && !dsymPath) {
        throw new Error(`包内未找到 ${dsymName}`);
      }

      const frameworkZipPath = path.join(uploadDir, `${safeName}_${Date.now()}.zip`);
      execSync(`cd ${shellQuote(path.dirname(frameworkPath))} && zip -r ${shellQuote(frameworkZipPath)} ${shellQuote(path.basename(frameworkPath))}`, {
        encoding: 'utf-8',
        timeout: 120000,
      });

      return { workDir, frameworkPath, dsymPath: dsymPath || undefined, frameworkZipPath };
    } catch (error) {
      fs.rmSync(workDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async extractNNRtcPackage(packagePath: string, originalFileName?: string, requireDSYM = true) {
    return this.extractFrameworkDSYMPackage(packagePath, originalFileName, 'NNRtc', requireDSYM);
  }

  private async saveComponentDSYM(componentName: string, dsymPath: string, version: string): Promise<void> {
    const uuid = await this.fileHandler.extractUUID(dsymPath);
    const appInfo = await this.fileHandler.extractAppInfo(dsymPath);
    const appName = appInfo.appName || componentName;

    const sameVersionDsyms = await this.storage.findByAppNameAndVersion(appName, version);
    for (const existing of sameVersionDsyms) {
      logger.info('覆盖组件同版本 dSYM，删除旧记录', {
        componentName,
        appName: existing.appName,
        version: existing.version,
        uuid: existing.uuid,
      });
      await this.storage.deleteDSYM(existing.uuid);
    }

    const uuidOwner = await this.storage.findByUUID(uuid);
    if (uuidOwner) {
      if (uuidOwner.appName === appName) {
        logger.info('覆盖组件同 UUID dSYM，删除旧记录', {
          componentName,
          appName: uuidOwner.appName,
          version: uuidOwner.version,
          uuid: uuidOwner.uuid,
        });
        await this.storage.deleteDSYM(uuidOwner.uuid);
      } else {
        throw new Error(`${componentName}.dSYM UUID ${uuid} 已存在于 ${uuidOwner.appName}@${uuidOwner.version}`);
      }
    }

    const permanentPath = await this.fileHandler.moveToPermanentStorage(dsymPath, uuid);
    const fileSize = this.fileHandler.getFileSize(permanentPath);
    await this.storage.saveDSYMInfo({
      uuid,
      appName,
      version,
      buildNumber: appInfo.buildNumber,
      architecture: appInfo.architecture,
      filePath: permanentPath,
      fileSize,
    });
    logger.info('组件 dSYM 已同步到 dSYM 管理', { componentName, uuid, appName, version });
    symbolicationCache.clear();
    logger.info('已清除符号化缓存（组件 dSYM 更新）', { componentName, uuid, appName, version });
  }

  private async saveNNRtcDSYM(dsymPath: string, version: string): Promise<void> {
    return this.saveComponentDSYM('NNRtc', dsymPath, version);
  }

  private async deleteComponentDSYMs(componentName: string, version: string): Promise<void> {
    const dsyms = await this.storage.findByAppNameAndVersion(componentName, version);
    if (dsyms.length === 0) {
      logger.info('未找到需要删除的组件 dSYM', { componentName, version });
      return;
    }

    for (const dsym of dsyms) {
      logger.info('删除组件版本对应 dSYM', {
        componentName,
        version,
        uuid: dsym.uuid,
        filePath: dsym.filePath,
      });
      await this.storage.deleteDSYM(dsym.uuid);
    }
    symbolicationCache.clear();
    logger.info('已清除符号化缓存（组件 dSYM 删除）', { componentName, version });
  }

  private async deleteNNRtcDSYMs(version: string): Promise<void> {
    return this.deleteComponentDSYMs('NNRtc', version);
  }

  async hasNNRtcDSYM(version: string): Promise<boolean> {
    const dsyms = await this.storage.findByAppNameAndVersion('NNRtc', version);
    return dsyms.length > 0;
  }

  async associateComponentDSYMWithAppVersion(componentName: string, version: string, appVersion: string): Promise<void> {
    const cleanAppVersion = String(appVersion || '').trim();
    if (!cleanAppVersion) return;
    const dsyms = await this.storage.findByAppNameAndVersion(componentName, version);
    for (const dsym of dsyms) {
      const nextVersions = Array.from(new Set([...(dsym.relatedAppVersions || []), cleanAppVersion]));
      await this.storage.updateDSYMInfo(dsym.uuid, { relatedAppVersions: nextVersions });
    }
  }

  async syncNNRtcDSYMFromPackage(packagePath: string, originalFileName: string, version: string, buildId?: string): Promise<void> {
    if (isNNRtcTestVersion(version)) {
      await this.deleteNNRtcDSYMs(version);
      return;
    }

    const extracted = await this.extractNNRtcPackage(packagePath, originalFileName, true);
    try {
      if (!extracted.dsymPath) {
        throw new Error('包内未找到 NNRtc.dSYM');
      }
      await this.saveNNRtcDSYM(extracted.dsymPath, version);
      if (buildId) {
        this.db
          .prepare('UPDATE pods_components SET build_id = ? WHERE name = ? AND version = ?')
          .run(buildId, 'NNRtc', version);
      }
    } finally {
      fs.rmSync(extracted.workDir, { recursive: true, force: true });
      fs.rmSync(extracted.frameworkZipPath, { force: true });
    }
  }

  private async cleanupNNRtcTestDSYMs(): Promise<void> {
    const dsyms = (await this.storage.getAllDSYMs())
      .filter((item) => item.appName === 'NNRtc' && isNNRtcTestVersion(item.version));
    if (dsyms.length === 0) return;

    for (const dsym of dsyms) {
      logger.info('清理 NNRtc 测试包 dSYM', {
        version: dsym.version,
        uuid: dsym.uuid,
        filePath: dsym.filePath,
      });
      await this.storage.deleteDSYM(dsym.uuid);
    }
    symbolicationCache.clear();
    logger.info('已清除符号化缓存（NNRtc 测试包 dSYM 清理）', { count: dsyms.length });
  }

  async publishNNRtcPackage(packagePath: string, originalFileName: string, params: PodUploadParams): Promise<PodComponent> {
    if (params.name !== 'NNRtc') {
      throw new Error('NNRtc 包发布仅支持组件 NNRtc');
    }
    const isTestPackage = params.package_type === 'test' || isNNRtcTestVersion(params.version);
    const normalizedParams = isTestPackage
      ? { ...params, version: normalizeNNRtcTestVersion(params.version) }
      : params;
    const syncDSYM = !isTestPackage;
    const extracted = await this.extractNNRtcPackage(packagePath, originalFileName, syncDSYM);
    try {
      const component = await this.publish(extracted.frameworkZipPath, 'NNRtc.zip', {
        ...normalizedParams,
        package_type: isTestPackage ? 'test' : 'release',
        lib_type: 'framework',
        lib_name: 'NNRtc.framework',
      });
      if (syncDSYM && extracted.dsymPath && component.status === 'published') {
        try {
          await this.saveNNRtcDSYM(extracted.dsymPath, params.version);
        } catch (error: any) {
          component.warning_message = `NNRtc Pod 已发布成功，但 dSYM 同步失败: ${error.message}`;
          logger.error('NNRtc dSYM 同步失败，Pod 发布已完成', {
            version: normalizedParams.version,
            error: error.message,
          });
        }
      }
      if (!syncDSYM && component.status === 'published') {
        await this.deleteNNRtcDSYMs(normalizedParams.version);
      }
      return component;
    } finally {
      fs.rmSync(extracted.workDir, { recursive: true, force: true });
      fs.rmSync(extracted.frameworkZipPath, { force: true });
    }
  }

  async replaceNNRtcPackage(version: string, packagePath: string, originalFileName: string, targetBranch: string, buildId?: string, syncDSYM = true): Promise<PodComponent> {
    const shouldSyncDSYM = syncDSYM && !isNNRtcTestVersion(version);
    const extracted = await this.extractNNRtcPackage(packagePath, originalFileName, shouldSyncDSYM);
    try {
      const component = await this.replaceZip('NNRtc', version, extracted.frameworkZipPath, 'NNRtc.zip', targetBranch);
      if (buildId) {
        this.db
          .prepare('UPDATE pods_components SET build_id = ? WHERE name = ? AND version = ?')
          .run(buildId, 'NNRtc', version);
        component.build_id = buildId;
      }
      if (!shouldSyncDSYM) {
        this.db
          .prepare('UPDATE pods_components SET package_type = ?, nnios_branch = ? WHERE name = ? AND version = ?')
          .run('test', targetBranch, 'NNRtc', version);
        component.package_type = 'test';
        component.nnios_branch = targetBranch;
      }
      if (shouldSyncDSYM && extracted.dsymPath && component.status === 'published') {
        try {
          await this.saveNNRtcDSYM(extracted.dsymPath, version);
        } catch (error: any) {
          component.warning_message = `NNRtc Pod 已替换成功，但 dSYM 同步失败: ${error.message}`;
          logger.error('NNRtc dSYM 同步失败，Pod 替换已完成', {
            version,
            error: error.message,
          });
        }
      }
      if (!shouldSyncDSYM && component.status === 'published') {
        await this.deleteNNRtcDSYMs(version);
      }
      return component;
    } finally {
      fs.rmSync(extracted.workDir, { recursive: true, force: true });
      fs.rmSync(extracted.frameworkZipPath, { force: true });
    }
  }

  async publishLeigodIMCrossSDKPackage(packagePath: string, originalFileName: string, params: PodUploadParams): Promise<PodComponent> {
    if (params.name !== 'leigod_im_cross_sdk') {
      throw new Error('leigod_im_cross_sdk 包发布仅支持组件 leigod_im_cross_sdk');
    }

    const extracted = await this.extractFrameworkDSYMPackage(packagePath, originalFileName, 'leigod_im_cross_sdk', false);
    try {
      const component = await this.publish(extracted.frameworkZipPath, 'leigod_im_cross_sdk.zip', {
        ...params,
        lib_type: 'framework',
        lib_name: 'leigod_im_cross_sdk.framework',
      });

      if (extracted.dsymPath && component.status === 'published') {
        try {
          await this.saveComponentDSYM('leigod_im_cross_sdk', extracted.dsymPath, params.version);
        } catch (error: any) {
          component.warning_message = `leigod_im_cross_sdk Pod 已发布成功，但 dSYM 同步失败: ${error.message}`;
          logger.error('leigod_im_cross_sdk dSYM 同步失败，Pod 发布已完成', {
            version: params.version,
            error: error.message,
          });
        }
      }

      return component;
    } finally {
      fs.rmSync(extracted.workDir, { recursive: true, force: true });
      fs.rmSync(extracted.frameworkZipPath, { force: true });
    }
  }

  async publishLeigodIMCrossSDKFromIMSDK(version: string, params: Omit<PodUploadParams, 'name' | 'version'>): Promise<PodComponent> {
    const versionDir = this.resolveLeigodIMSDKVersionDir(version);
    const packagePath = this.findLeigodIMSDKPackage(versionDir);
    const extracted = packagePath
      ? await this.extractFrameworkDSYMPackage(packagePath, path.basename(packagePath), 'leigod_im_cross_sdk', false)
      : await this.prepareFrameworkDSYMFromDirectory(versionDir, 'leigod_im_cross_sdk');

    try {
      const component = await this.publish(extracted.frameworkZipPath, 'leigod_im_cross_sdk.zip', {
        ...params,
        name: 'leigod_im_cross_sdk',
        version,
        lib_type: 'framework',
        lib_name: 'leigod_im_cross_sdk.framework',
      });

      if (extracted.dsymPath && component.status === 'published') {
        try {
          await this.saveComponentDSYM('leigod_im_cross_sdk', extracted.dsymPath, version);
        } catch (error: any) {
          component.warning_message = `leigod_im_cross_sdk Pod 已发布成功，但 dSYM 同步失败: ${error.message}`;
          logger.error('leigod_im_cross_sdk IMSDK dSYM 同步失败，Pod 发布已完成', {
            version,
            error: error.message,
          });
        }
      }

      return component;
    } finally {
      fs.rmSync(extracted.workDir, { recursive: true, force: true });
      fs.rmSync(extracted.frameworkZipPath, { force: true });
    }
  }

  async replaceLeigodIMCrossSDKPackage(version: string, packagePath: string, originalFileName: string, targetBranch: string): Promise<PodComponent> {
    const extracted = await this.extractFrameworkDSYMPackage(packagePath, originalFileName, 'leigod_im_cross_sdk', false);
    try {
      const component = await this.replaceZip('leigod_im_cross_sdk', version, extracted.frameworkZipPath, 'leigod_im_cross_sdk.zip', targetBranch);

      if (extracted.dsymPath && component.status === 'published') {
        try {
          await this.saveComponentDSYM('leigod_im_cross_sdk', extracted.dsymPath, version);
        } catch (error: any) {
          component.warning_message = `leigod_im_cross_sdk Pod 已替换成功，但 dSYM 同步失败: ${error.message}`;
          logger.error('leigod_im_cross_sdk dSYM 同步失败，Pod 替换已完成', {
            version,
            error: error.message,
          });
        }
      }

      return component;
    } finally {
      fs.rmSync(extracted.workDir, { recursive: true, force: true });
      fs.rmSync(extracted.frameworkZipPath, { force: true });
    }
  }

  async replaceLeigodIMCrossSDKFromIMSDK(version: string, targetBranch: string): Promise<PodComponent> {
    const versionDir = this.resolveLeigodIMSDKVersionDir(version);
    const packagePath = this.findLeigodIMSDKPackage(versionDir);
    if (!packagePath) {
      throw new Error(`IMSDK ${version} 目录下未找到可替换的 zip/tgz/tar.gz 包`);
    }
    const extracted = await this.extractFrameworkDSYMPackage(packagePath, path.basename(packagePath), 'leigod_im_cross_sdk', false);

    try {
      const component = await this.replaceZip('leigod_im_cross_sdk', version, extracted.frameworkZipPath, 'leigod_im_cross_sdk.zip', targetBranch);

      if (extracted.dsymPath && component.status === 'published') {
        try {
          await this.saveComponentDSYM('leigod_im_cross_sdk', extracted.dsymPath, version);
        } catch (error: any) {
          component.warning_message = `leigod_im_cross_sdk Pod 已替换成功，但 dSYM 同步失败: ${error.message}`;
          logger.error('leigod_im_cross_sdk IMSDK dSYM 同步失败，Pod 替换已完成', {
            version,
            error: error.message,
          });
        }
      }

      return component;
    } finally {
      fs.rmSync(extracted.workDir, { recursive: true, force: true });
      fs.rmSync(extracted.frameworkZipPath, { force: true });
    }
  }

  /**
   * 完整的发布流程：自动打包 zip + 检测库类型 + 上传 Nexus + 生成 podspec + 同步 spec 仓库
   */
  async publish(
    filePath: string,
    originalFileName: string,
    params: PodUploadParams
  ): Promise<PodComponent> {
    const { name, version } = params;

    // 已发布相同版本时，先清理服务器本机 podx 缓存，再继续覆盖发布。
    const existing = await this.getOne(name, version);
    if (existing) {
      this.cleanPodxCache(name);
    }

    // 1. 自动打包为 zip
    let zipPath: string;
    let needCleanupZip = false;
    try {
      const packResult = await this.packToZip(filePath, originalFileName);
      zipPath = packResult.zipPath;
      needCleanupZip = packResult.needCleanup;
    } catch (error: any) {
      throw new Error(`打包 zip 失败: ${error.message}`);
    }

    // 2. 自动检测库类型，并校验 framework 名称与组件名一致。
    const detected = this.detectLibType(zipPath);
    this.validateFrameworkNameMatchesComponent(name, detected);
    if (!params.lib_type || !params.lib_name) {
      if (detected) {
        if (!params.lib_type) {
          params.lib_type = detected.lib_type;
          logger.info('自动设置库类型', { lib_type: detected.lib_type });
        }
        if (!params.lib_name) {
          params.lib_name = detected.lib_name;
          logger.info('自动设置库文件名', { lib_name: detected.lib_name });
        }
      }
    }

    // 3. 计算 zip 文件的 sha256
    const fileBuffer = fs.readFileSync(zipPath);
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    logger.info('zip 文件 sha256', { name, version, sha256 });

    // 4. 生成 podspec（带 sha256）
    const podspecContent = this.generatePodspec(params, sha256);

    // 5. 上传 zip 到 Nexus
    let sourceZipUrl: string;
    try {
      sourceZipUrl = await this.uploadToNexus(zipPath, name, version);
    } catch (error: any) {
      // 清理临时 zip
      if (needCleanupZip && fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
      }
      this.saveComponent({
        name,
        version,
        summary: params.summary || '',
        homepage: params.homepage || '',
        source_zip_url: `${NEXUS_BASE_URL}/${name}/${version}.zip`,
        podspec_content: podspecContent,
        status: 'failed',
        error_message: error.message,
      });
      throw error;
    }

    // 清理临时 zip
    if (needCleanupZip && fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    // 6. 同步 podspec 到 git 仓库
    let status: 'published' | 'failed' = 'published';
    let errorMessage: string | undefined;
    try {
      await this.syncToSpecRepo(name, version, podspecContent);
    } catch (error: any) {
      status = 'failed';
      errorMessage = `Nexus 上传成功，但 spec 仓库同步失败: ${error.message}`;
      logger.warn('Spec 同步失败，但 Nexus 上传已成功', { name, version });
    }

    // 7. 同步当前组件版本到 nnios 指定分支
    if (status === 'published' && params.target_branch) {
      try {
        this.syncVersionToNnios(name, version, params.target_branch);
      } catch (error: any) {
        status = 'failed';
        errorMessage = error.message;
      }
    }

    // 8. 保存到数据库
    const component = this.saveComponent({
      name,
      version,
      summary: params.summary || '',
      homepage: params.homepage || '',
      source_zip_url: sourceZipUrl,
      podspec_content: podspecContent,
      status,
      error_message: errorMessage,
      package_type: params.package_type,
      build_id: params.build_id,
      nnios_branch: params.package_type === 'test' ? params.target_branch : undefined,
    });

    return component;
  }

  async publishMetadata(params: PodUploadParams): Promise<PodComponent> {
    const { name, version } = params;

    if (!params.lib_type) {
      params.lib_type = 'framework';
    }
    if (!params.lib_name) {
      params.lib_name = params.lib_type === 'static_library' ? `lib${name}.a` : `${name}.framework`;
    }

    const existing = await this.getOne(name, version);
    if (existing) {
      this.cleanPodxCache(name);
    }

    const podspecContent = this.generatePodspec(params);
    let status: 'published' | 'failed' = 'published';
    let errorMessage: string | undefined;
    try {
      await this.syncToSpecRepo(name, version, podspecContent);
    } catch (error: any) {
      status = 'failed';
      errorMessage = `spec 仓库同步失败: ${error.message}`;
      logger.warn('元信息发布 Spec 同步失败', { name, version, error: error.message });
    }

    if (status === 'published' && params.target_branch) {
      try {
        this.syncVersionToNnios(name, version, params.target_branch);
      } catch (error: any) {
        status = 'failed';
        errorMessage = error.message;
      }
    }

    return this.saveComponent({
      name,
      version,
      summary: params.summary || '',
      homepage: params.homepage || '',
      source_zip_url: `${NEXUS_BASE_URL}/${name}/${version}.zip`,
      podspec_content: podspecContent,
      status,
      error_message: errorMessage,
      package_type: params.package_type,
      build_id: params.build_id,
      nnios_branch: params.package_type === 'test' ? params.target_branch : undefined,
    });
  }

  /**
   * 保存组件信息到数据库（同名同版本自动覆盖）
   */
  private saveComponent(data: {
    name: string;
    version: string;
    summary: string;
    homepage: string;
    source_zip_url: string;
    podspec_content: string;
    status: string;
    error_message?: string;
    package_type?: 'release' | 'test';
    build_id?: string;
    nnios_branch?: string;
  }): PodComponent {
    // 使用 REPLACE 实现 upsert，覆盖同名同版本记录，刷新 upload_time
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO pods_components 
        (name, version, summary, homepage, source_zip_url, podspec_content, status, error_message, package_type, build_id, nnios_branch, upload_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `);

    const result = stmt.run(
      data.name,
      data.version,
      data.summary,
      data.homepage,
      data.source_zip_url,
      data.podspec_content,
      data.status,
      data.error_message || null,
      data.package_type || null,
      data.build_id || null,
      data.nnios_branch || null
    );

    const row = this.db
      .prepare('SELECT * FROM pods_components WHERE id = ?')
      .get(result.lastInsertRowid) as any;

    return this.mapRow(row);
  }

  /**
   * 获取所有组件（按名称分组，每个名称取最新版本）
   */
  async getAll(): Promise<PodComponent[]> {
    const rows = this.db
      .prepare('SELECT * FROM pods_components ORDER BY name ASC, upload_time DESC')
      .all() as any[];
    return rows.map(this.mapRow);
  }

  /**
   * 获取指定组件的所有版本
   */
  async getVersions(name: string): Promise<PodComponent[]> {
    const rows = this.db
      .prepare('SELECT * FROM pods_components WHERE name = ? ORDER BY upload_time DESC')
      .all(name) as any[];
    return rows.map(this.mapRow);
  }

  /**
   * 获取组件名称列表（去重）
   */
  async getComponentNames(): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT DISTINCT name FROM pods_components ORDER BY name ASC')
      .all() as any[];
    return rows.map((r: any) => r.name);
  }

  /**
   * 删除 Nexus 上的 zip 文件
   */
  async deleteFromNexus(name: string, version: string): Promise<void> {
    const targetUrl = `${NEXUS_BASE_URL}/${name}/${version}.zip`;
    logger.info('删除 Nexus 文件', { name, version, targetUrl });

    try {
      const cmd = `curl -s -w "%{http_code}" -u "${NEXUS_USER}:${NEXUS_PASS}" -X DELETE "${targetUrl}"`;
      const result = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
      const statusCode = result.trim().slice(-3);
      const statusNum = parseInt(statusCode, 10);

      if (statusNum >= 200 && statusNum < 300 || statusNum === 404) {
        logger.info('Nexus 文件删除成功', { name, version, statusCode });
      } else {
        logger.warn('Nexus 文件删除失败', { name, version, statusCode });
      }
    } catch (error: any) {
      logger.warn('Nexus 文件删除异常', { name, version, error: error.message });
    }
  }

  /**
   * 删除指定组件版本（同时删除 Nexus 文件）
   */
  async checkDeleteVersion(name: string, version: string, targetBranch?: string): Promise<{
    canDelete: boolean;
    branch: string;
    currentVersion: string | null;
    fallbackVersion?: string;
    reason?: string;
  }> {
    const component = await this.getOne(name, version);
    if (!component) {
      throw new Error(`组件 ${name}@${version} 不存在`);
    }
    const isTestPackage = component.package_type === 'test' || (name === 'NNRtc' && isNNRtcTestVersion(version));
    const branch = targetBranch || (isTestPackage ? component.nnios_branch : undefined);
    if (!branch) {
      return {
        canDelete: true,
        branch: '',
        currentVersion: null,
      };
    }

    const remainingVersions = (await this.getVersions(name)).filter((item) => item.version !== version);
    const currentRef = this.getNniosPodVersion(name, branch);
    const fallbackVersion = currentRef.version === version ? remainingVersions[0]?.version : undefined;
    if (currentRef.version === version && !fallbackVersion) {
      return {
        canDelete: false,
        branch: currentRef.branch,
        currentVersion: currentRef.version,
        reason: `nnios/${currentRef.branch} 正在引用 ${name}@${version}，且没有可回退版本，禁止删除`,
      };
    }

    return {
      canDelete: true,
      branch: currentRef.branch,
      currentVersion: currentRef.version,
      fallbackVersion,
    };
  }

  async deleteVersion(name: string, version: string, targetBranch?: string): Promise<{ fallbackVersion?: string; warning?: string }> {
    const component = await this.getOne(name, version);
    if (!component) {
      throw new Error(`组件 ${name}@${version} 不存在`);
    }
    let fallbackVersion: string | undefined;

    if (targetBranch) {
      const remainingVersions = (await this.getVersions(name)).filter((item) => item.version !== version);
      const currentRef = this.getNniosPodVersion(name, targetBranch);

      if (currentRef.version === version) {
        fallbackVersion = remainingVersions[0]?.version;
        if (!fallbackVersion) {
          throw new Error(`nnios/${currentRef.branch} 正在引用 ${name}@${version}，且没有可回退版本，禁止删除`);
        }
        logger.info('删除版本前回退 nnios 组件版本', {
          name,
          version,
          targetBranch: currentRef.branch,
          fallbackVersion,
        });
        this.syncVersionToNnios(name, fallbackVersion, currentRef.branch);
      } else {
        logger.info('删除版本无需回退 nnios 组件版本', {
          name,
          version,
          targetBranch: currentRef.branch,
          currentVersion: currentRef.version,
        });
      }
    } else {
      logger.info('删除版本未指定 nnios 分支，跳过 nnios 引用检查和回退', {
        name,
        version,
      });
    }

    const stmt = this.db.prepare('DELETE FROM pods_components WHERE name = ? AND version = ?');
    stmt.run(name, version);

    // 删除 Nexus 上的文件
    await this.deleteFromNexus(name, version);
    // 删除 spec 仓库中的版本目录
    await this.deleteFromSpecRepo(name, version);
    let warning: string | undefined;
    if (name === 'NNRtc' || name === 'leigod_im_cross_sdk') {
      try {
        await this.deleteComponentDSYMs(name, version);
      } catch (error: any) {
        warning = `${name}@${version} 已删除，但对应 dSYM 清理失败: ${error.message}`;
        logger.error('删除组件版本后清理 dSYM 失败', { name, version, error: error.message });
      }
    }

    return { fallbackVersion, warning };
  }

  /**
   * 删除整个组件（所有版本 + Nexus 文件）
   */
  async deleteComponent(name: string): Promise<{ deletedVersions: number; warning?: string }> {
    const versions = await this.getVersions(name);
    if (versions.length === 0) {
      throw new Error(`组件 ${name} 不存在`);
    }

    // 逐个删除 Nexus 文件
    const dsymWarnings: string[] = [];
    for (const v of versions) {
      await this.deleteFromNexus(name, v.version);
      if (name === 'NNRtc' || name === 'leigod_im_cross_sdk') {
        try {
          await this.deleteComponentDSYMs(name, v.version);
        } catch (error: any) {
          dsymWarnings.push(`${v.version}: ${error.message}`);
          logger.error('删除组件后清理 dSYM 失败', { name, version: v.version, error: error.message });
        }
      }
    }

    // 删除数据库记录
    const stmt = this.db.prepare('DELETE FROM pods_components WHERE name = ?');
    const result = stmt.run(name);
    logger.info('删除整个组件', { name, deletedVersions: result.changes });

    // 删除 spec 仓库中的整个组件目录（包含所有版本）
    await this.deleteFromSpecRepo(name);

    return {
      deletedVersions: result.changes,
      warning: dsymWarnings.length > 0 ? `${name} 组件已删除，但部分 dSYM 清理失败: ${dsymWarnings.join('; ')}` : undefined,
    };
  }

  /**
   * 获取单个组件
   */
  async getOne(name: string, version: string): Promise<PodComponent | null> {
    const row = this.db
      .prepare('SELECT * FROM pods_components WHERE name = ? AND version = ?')
      .get(name, version) as any;
    return row ? this.mapRow(row) : null;
  }

  /**
   * 更新已发布组件的 podspec 内容，并同步到远程仓库
   */
  async updatePodspec(name: string, version: string, podspecContent: string, targetBranch: string): Promise<PodComponent> {
    const component = await this.getOne(name, version);
    if (!component) {
      throw new Error(`组件 ${name}@${version} 不存在`);
    }

    this.cleanPodxCache(name);

    // 1. 同步新的 podspec 到 git 仓库
    await this.syncToSpecRepo(name, version, podspecContent);

    let status: 'published' | 'failed' = 'published';
    let errorMessage: string | undefined;
    try {
      this.syncVersionToNnios(name, version, targetBranch);
    } catch (error: any) {
      status = 'failed';
      errorMessage = error.message;
    }

    // 2. 更新数据库
    this.db
      .prepare('UPDATE pods_components SET podspec_content = ?, status = ?, error_message = ? WHERE name = ? AND version = ?')
      .run(podspecContent, status, errorMessage || null, name, version);

    logger.info('Podspec 更新成功', { name, version, targetBranch, status });

    return { ...component, podspec_content: podspecContent, status, error_message: errorMessage };
  }

  /**
   * 重新上传 zip 文件（替换已有版本的二进制）
   * 重新上传到 Nexus、重新计算 sha256、重新生成 podspec、同步 spec 仓库
   */
  async replaceZip(
    name: string,
    version: string,
    filePath: string,
    originalFileName: string,
    targetBranch: string
  ): Promise<PodComponent> {
    const component = await this.getOne(name, version);
    if (!component) {
      throw new Error(`组件 ${name}@${version} 不存在`);
    }

    this.cleanPodxCache(name);

    // 1. 自动打包为 zip
    let zipPath: string;
    let needCleanupZip = false;
    try {
      const packResult = await this.packToZip(filePath, originalFileName);
      zipPath = packResult.zipPath;
      needCleanupZip = packResult.needCleanup;
    } catch (error: any) {
      throw new Error(`打包 zip 失败: ${error.message}`);
    }

    // 2. 自动检测库类型，并校验 framework 名称与组件名一致。
    const detected = this.detectLibType(zipPath);
    this.validateFrameworkNameMatchesComponent(name, detected);
    const lib_type = detected?.lib_type || 'framework';
    const lib_name = detected?.lib_name || `${name}.framework`;

    // 3. 计算 sha256
    const fileBuffer = fs.readFileSync(zipPath);
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    logger.info('替换 zip sha256', { name, version, sha256 });

    // 4. 从旧 podspec 解析保留的字段（sys_frameworks, sys_libraries 等）
    const oldSpec = component.podspec_content;
    let sys_frameworks: string | undefined;
    let sys_libraries: string | undefined;
    const fwMatch = oldSpec.match(/^\s*s\.frameworks\s*=\s*(.+)$/m);
    if (fwMatch) sys_frameworks = fwMatch[1].replace(/'/g, '').trim();
    const libMatch = oldSpec.match(/^\s*s\.libraries\s*=\s*(.+)$/m);
    if (libMatch) sys_libraries = libMatch[1].replace(/'/g, '').trim();

    // 5. 生成新 podspec
    const podspecContent = this.generatePodspec({
      name, version, lib_type, lib_name, sys_frameworks, sys_libraries,
    }, sha256);

    // 6. 上传到 Nexus（覆盖）
    let sourceZipUrl: string;
    try {
      sourceZipUrl = await this.uploadToNexus(zipPath, name, version);
    } catch (error: any) {
      if (needCleanupZip && fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      throw error;
    }

    if (needCleanupZip && fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    // 7. 同步 podspec 到 git 仓库
    let status: 'published' | 'failed' = 'published';
    let errorMessage: string | undefined;
    try {
      await this.syncToSpecRepo(name, version, podspecContent);
    } catch (error: any) {
      status = 'failed';
      errorMessage = `Nexus 上传成功，但 spec 仓库同步失败: ${error.message}`;
    }

    // 8. 同步当前组件版本到 nnios 指定分支
    if (status === 'published') {
      try {
        this.syncVersionToNnios(name, version, targetBranch);
      } catch (error: any) {
        status = 'failed';
        errorMessage = error.message;
      }
    }

    // 9. 更新数据库
    this.db
      .prepare(`UPDATE pods_components SET source_zip_url = ?, podspec_content = ?, status = ?, error_message = ?, upload_time = datetime('now', 'localtime') WHERE name = ? AND version = ?`)
      .run(sourceZipUrl, podspecContent, status, errorMessage || null, name, version);

    logger.info('zip 替换成功', { name, version, targetBranch, status });

    return {
      ...component,
      source_zip_url: sourceZipUrl,
      podspec_content: podspecContent,
      status,
      error_message: errorMessage,
    };
  }

  /**
   * 重试发布（重新同步 spec 仓库）
   */
  async retrySync(name: string, version: string, targetBranch: string): Promise<PodComponent> {
    const component = await this.getOne(name, version);
    if (!component) {
      throw new Error(`组件 ${name}@${version} 不存在`);
    }

    try {
      this.cleanPodxCache(name);
      await this.syncToSpecRepo(name, version, component.podspec_content);

      let status: 'published' | 'failed' = 'published';
      let errorMessage: string | undefined;
      try {
        this.syncVersionToNnios(name, version, targetBranch);
      } catch (error: any) {
        status = 'failed';
        errorMessage = error.message;
      }

      this.db
        .prepare('UPDATE pods_components SET status = ?, error_message = ? WHERE name = ? AND version = ?')
        .run(status, errorMessage || null, name, version);

      return { ...component, status, error_message: errorMessage };
    } catch (error: any) {
      this.db
        .prepare('UPDATE pods_components SET error_message = ? WHERE name = ? AND version = ?')
        .run(error.message, name, version);
      throw error;
    }
  }

  /**
   * 仅同步当前组件版本到 nnios 指定分支的 Podfile / third_sdk.rb。
   */
  async syncVersionToBranch(name: string, version: string, targetBranch?: string): Promise<PodComponent> {
    const component = await this.getOne(name, version);
    if (!component) {
      throw new Error(`组件 ${name}@${version} 不存在`);
    }
    const isTestPackage = component.package_type === 'test' || isNNRtcTestVersion(component.version);
    const branch = targetBranch || (isTestPackage ? component.nnios_branch : undefined);
    if (!branch) {
      throw new Error('请选择 nnios 分支');
    }

    try {
      this.syncVersionToNnios(name, version, branch);
      this.db
        .prepare('UPDATE pods_components SET status = ?, error_message = NULL, nnios_branch = CASE WHEN ? THEN ? ELSE nnios_branch END WHERE name = ? AND version = ?')
        .run('published', isTestPackage ? 1 : 0, branch, name, version);

      return { ...component, status: 'published', error_message: undefined, nnios_branch: isTestPackage ? branch : component.nnios_branch };
    } catch (error: any) {
      this.db
        .prepare('UPDATE pods_components SET status = ?, error_message = ? WHERE name = ? AND version = ?')
        .run('failed', error.message, name, version);
      throw error;
    }
  }

  /**
   * 直接从源码编译 framework（绕过 CocoaPods pod install）
   * 适用于纯 C/C++ 库（如 libwebp）pod install 会报错的场景
   * 流程：git clone → 收集源文件 → xcrun clang 编译 → libtool 打静态库 → 包装为 .framework → zip → Nexus
   */
  private async buildDirectFromSource(
    spec: any,
    podName: string,
    version: string,
    pubVer: string,
    workDir: string,
    prepareCommand?: string,
    targetBranch?: string
  ): Promise<PodComponent> {
    const gitUrl = spec.source.git;
    const tag = spec.source.tag || `v${version}`;
    const cloneDir = path.join(workDir, 'source');

    logger.info('直接编译：克隆源码', { podName, gitUrl, tag });

    // 1. Clone
    const gitUrls = gitUrl.includes('github.com')
      ? [
          gitUrl.replace('https://github.com/', 'https://ghfast.top/https://github.com/'),
          gitUrl,
        ]
      : [gitUrl];

    let cloned = false;
    for (const tryUrl of gitUrls) {
      try {
        execSync(`git clone --depth 1 --branch "${tag}" "${tryUrl}" "${cloneDir}"`, {
          encoding: 'utf-8',
          timeout: 120000,
        });
        cloned = true;
        break;
      } catch {
        if (fs.existsSync(cloneDir)) fs.rmSync(cloneDir, { recursive: true, force: true });
      }
    }
    if (!cloned) throw new Error(`git clone 失败：${gitUrl} tag=${tag}`);

    // 2. 收集所有 C/ObjC/C++ 源文件（从 subspecs 的 source_files 或 spec 根）
    const srcPatterns = this.collectSourceFilePatterns(spec);

    // 用 glob 展开（简单处理：用 find + wildcard）
    const allSrcFiles: string[] = [];
    const allHeaderDirs = new Set<string>();

    for (const pattern of srcPatterns) {
      // 拆成目录 + 通配符
      // 支持 src/webp/*.{h,c} → 用 find 过滤
      const baseDir = pattern.replace(/\/\*.*$/, '').replace(/\/[^/]*\{[^}]+\}$/, '');
      const searchDir = path.join(cloneDir, baseDir);
      if (!fs.existsSync(searchDir)) continue;

      try {
        const found = execSync(
          `find "${searchDir}" -maxdepth 2 \\( -name "*.c" -o -name "*.m" -o -name "*.cc" -o -name "*.cpp" -o -name "*.S" \\) -type f`,
          { encoding: 'utf-8', timeout: 10000 }
        ).trim().split('\n').filter(Boolean);
        allSrcFiles.push(...found);
      } catch { /* empty */ }

      // 收集 header 搜索路径
      try {
        const hdrs = execSync(
          `find "${searchDir}" -maxdepth 2 -name "*.h" -type f`,
          { encoding: 'utf-8', timeout: 10000 }
        ).trim().split('\n').filter(Boolean);
        for (const h of hdrs) {
          allHeaderDirs.add(path.dirname(h));
        }
      } catch { /* empty */ }
    }

    // 也加上根目录和 src 目录
    allHeaderDirs.add(cloneDir);
    if (fs.existsSync(path.join(cloneDir, 'src'))) allHeaderDirs.add(path.join(cloneDir, 'src'));

    if (allSrcFiles.length === 0) {
      throw new Error(`直接编译失败：未找到任何源文件（patterns: ${srcPatterns.join(', ')}）`);
    }

    const uniqueSrc = [...new Set(allSrcFiles)];
    logger.info('直接编译：收集源文件', { count: uniqueSrc.length, headerDirs: allHeaderDirs.size });

    // 3. 编译
    const buildDir = path.join(workDir, 'build');
    const objDir = path.join(buildDir, 'obj');
    fs.mkdirSync(objDir, { recursive: true });

    const arch = 'arm64';
    const sdk = 'iphoneos';
    const minIos = spec.platforms?.ios || '12.0';
    const headerFlags = [...allHeaderDirs].map(d => `-I"${d}"`).join(' ');

    // 编译所有 .c/.m → .o
    const objFiles: string[] = [];
    for (const srcFile of uniqueSrc) {
      const baseName = path.basename(srcFile, path.extname(srcFile));
      const objFile = path.join(objDir, `${baseName}_${objFiles.length}.o`);
      const ext = path.extname(srcFile);
      const isObjC = ext === '.m';
      const isCpp = ext === '.cc' || ext === '.cpp';

      let langFlag = '-x c';
      if (isObjC) langFlag = '-x objective-c';
      if (isCpp) langFlag = '-x c++';

      try {
        execSync(
          `xcrun clang ${langFlag} -arch ${arch} -isysroot $(xcrun --sdk ${sdk} --show-sdk-path) ` +
          `-miphoneos-version-min=${minIos} ${headerFlags} -O2 -DNDEBUG -fPIC ` +
          `-c "${srcFile}" -o "${objFile}"`,
          { encoding: 'utf-8', timeout: 30000 }
        );
        objFiles.push(objFile);
      } catch (err: any) {
        logger.warn('编译文件失败（跳过）', { file: srcFile, error: err.message?.slice(0, 200) });
      }
    }

    if (objFiles.length === 0) {
      throw new Error('直接编译失败：所有源文件编译失败');
    }
    logger.info('直接编译：.o 文件', { count: objFiles.length });

    // 4. 打包为静态库 .a
    const staticLib = path.join(buildDir, `lib${podName}.a`);
    execSync(`xcrun libtool -static -o "${staticLib}" ${objFiles.map(f => `"${f}"`).join(' ')}`, {
      encoding: 'utf-8',
      timeout: 30000,
    });

    // 5. 包装为 .framework
    const fwName = `${podName}.framework`;
    const fwDir = path.join(buildDir, fwName);
    fs.mkdirSync(path.join(fwDir, 'Headers'), { recursive: true });

    // 复制静态库为 framework binary
    fs.copyFileSync(staticLib, path.join(fwDir, podName));

    // 复制 public headers
    const publicHeaders: string[] = [];
    // 从 spec 的 public_header_files 或所有 headers
    let headerPatterns: string[] = [];
    if (spec.public_header_files) {
      headerPatterns = Array.isArray(spec.public_header_files) ? spec.public_header_files : [spec.public_header_files];
    }
    // 从 subspecs
    if (spec.subspecs) {
      for (const sub of spec.subspecs) {
        if (sub.public_header_files) {
          const h = Array.isArray(sub.public_header_files) ? sub.public_header_files : [sub.public_header_files];
          headerPatterns.push(...h);
        }
      }
    }

    // 如果没有 public_header_files，找所有 .h
    if (headerPatterns.length === 0) {
      const allHeaders = execSync(
        `find "${cloneDir}" -name "*.h" -not -path "*/.git/*" -type f`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim().split('\n').filter(Boolean);
      // 只取 src/ 和根下的
      for (const h of allHeaders) {
        const rel = path.relative(cloneDir, h);
        if (!rel.startsWith('examples') && !rel.startsWith('tests') && !rel.startsWith('man')) {
          publicHeaders.push(h);
        }
      }
    } else {
      for (const pat of headerPatterns) {
        const baseDir = pat.replace(/\/\*.*$/, '').replace(/\/[^/]*\{[^}]+\}$/, '');
        const searchDir = path.join(cloneDir, baseDir);
        if (!fs.existsSync(searchDir)) continue;
        try {
          const found = execSync(
            `find "${searchDir}" -maxdepth 2 -name "*.h" -type f`,
            { encoding: 'utf-8', timeout: 10000 }
          ).trim().split('\n').filter(Boolean);
          publicHeaders.push(...found);
        } catch { /* */ }
      }
    }

    for (const h of [...new Set(publicHeaders)]) {
      fs.copyFileSync(h, path.join(fwDir, 'Headers', path.basename(h)));
    }

    // 写 module.modulemap
    const modulemapContent = `framework module ${podName} {\n  umbrella header "${podName}.h"\n  export *\n  module * { export * }\n}\n`;
    const modulesDir = path.join(fwDir, 'Modules');
    fs.mkdirSync(modulesDir, { recursive: true });
    fs.writeFileSync(path.join(modulesDir, 'module.modulemap'), modulemapContent, 'utf-8');

    // 写 umbrella header
    const umbrellaLines = publicHeaders
      .map(h => `#import <${podName}/${path.basename(h)}>`)
      .join('\n');
    fs.writeFileSync(path.join(fwDir, 'Headers', `${podName}.h`), umbrellaLines + '\n', 'utf-8');

    // 写 Info.plist
    const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.pods.${podName}</string>
  <key>CFBundleName</key><string>${podName}</string>
  <key>CFBundleVersion</key><string>${pubVer}</string>
  <key>CFBundleShortVersionString</key><string>${pubVer}</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
</dict>
</plist>`;
    fs.writeFileSync(path.join(fwDir, 'Info.plist'), infoPlist, 'utf-8');

    logger.info('直接编译：framework 打包完成', { headers: publicHeaders.length, fwDir });

    // 6. Zip
    const zipPath = path.join(workDir, `${podName}_${pubVer}.zip`);
    execSync(`cd "${buildDir}" && zip -r "${zipPath}" "${fwName}"`, {
      encoding: 'utf-8',
      timeout: 30000,
    });

    // 7. sha256 + upload Nexus + generate podspec + sync + save
    const fileBuffer = fs.readFileSync(zipPath);
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // 生成 podspec，包含 subspec 别名（让依赖 libwebp/WebP 等写法的库能正常解析）
    const sourceUrl = `${NEXUS_BASE_URL}/${podName}/${pubVer}.zip`;
    let podspecContent = `Pod::Spec.new do |s|
  s.name         = '${podName}'
  s.version      = '${pubVer}'
  s.summary      = '${(spec.summary || `${podName} iOS 组件`).replace(/'/g, "\\'")}'
  s.homepage     = '${spec.homepage || gitUrl}'
  s.license      = { :type => 'MIT' }
  s.authors      = '${spec.authors ? (typeof spec.authors === 'string' ? spec.authors : Object.keys(spec.authors).join(', ')) : 'iOS Team'}'
  s.source       = { :http => '${sourceUrl}', :sha256 => '${sha256}' }
  s.platform     = :ios, '${minIos}'
  s.vendored_frameworks = '${fwName}'
${prepareCommand ? `\n  s.prepare_command = <<-CMD\n${prepareCommand}\n  CMD\n` : `
  s.prepare_command = <<-CMD
    set -e
    WEBP_BINARY="${fwName}/${podName}"
    TMP_BINARY="${fwName}/${podName}.dynamic"
    WEBP_INFO_PLIST="${fwName}/Info.plist"

    if file "$WEBP_BINARY" | grep -q 'current ar archive'; then
      xcrun --sdk iphoneos clang \\\\
        -target arm64-apple-ios${minIos} \\\\
        -dynamiclib \\\\
        -all_load "$WEBP_BINARY" \\\\
        -install_name @rpath/${fwName}/${podName} \\\\
        -o "$TMP_BINARY"
      mv "$TMP_BINARY" "$WEBP_BINARY"
    fi

    /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable ${podName}" "$WEBP_INFO_PLIST" 2>/dev/null || \\\\
      /usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string ${podName}" "$WEBP_INFO_PLIST"
    /usr/libexec/PlistBuddy -c "Set :CFBundlePackageType FMWK" "$WEBP_INFO_PLIST" 2>/dev/null || \\\\
      /usr/libexec/PlistBuddy -c "Add :CFBundlePackageType string FMWK" "$WEBP_INFO_PLIST"
  CMD
`}
`;

    // 添加 subspec 别名：每个原始 subspec 创建一个空 subspec 指向同一 framework
    if (spec.subspecs && Array.isArray(spec.subspecs)) {
      const subNames = spec.subspecs.map((s: any) => s.name || s).filter(Boolean);
      if (subNames.length > 0) {
        podspecContent += `\n  # Subspec aliases (all point to the same binary)\n`;
        for (const subName of subNames) {
          podspecContent += `  s.subspec '${subName}' do |ss|\n    ss.vendored_frameworks = '${fwName}'\n  end\n`;
        }
        podspecContent += `  s.default_subspecs = [${subNames.map((n: string) => `'${n}'`).join(', ')}]\n`;
      }
    }

    podspecContent += `end\n`;

    let nexusUrl: string;
    try {
      nexusUrl = await this.uploadToNexus(zipPath, podName, pubVer);
    } catch (err: any) {
      throw new Error(`Nexus 上传失败: ${err.message}`);
    }

    let status: 'published' | 'failed' = 'published';
    let errorMessage: string | undefined;
    try {
      await this.syncToSpecRepo(podName, pubVer, podspecContent);
    } catch (err: any) {
      status = 'failed';
      errorMessage = `Nexus 上传成功，但 spec 仓库同步失败: ${err.message}`;
    }

    if (status === 'published' && targetBranch) {
      try {
        this.syncVersionToNnios(podName, pubVer, targetBranch);
      } catch (error: any) {
        status = 'failed';
        errorMessage = error.message;
      }
    }

    const component = this.saveComponent({
      name: podName,
      version: pubVer,
      summary: spec.summary || '',
      homepage: spec.homepage || '',
      source_zip_url: nexusUrl,
      podspec_content: podspecContent,
      status,
      error_message: errorMessage,
    });

    logger.info('直接编译发布成功', { podName, version, pubVer, objCount: objFiles.length, status });
    return component;
  }

  private collectSourceFilePatterns(spec: any): string[] {
    const patterns: string[] = [];
    if (spec.subspecs && Array.isArray(spec.subspecs)) {
      for (const sub of spec.subspecs) {
        patterns.push(...arrayify<string>(sub.source_files));
      }
    }
    patterns.push(...arrayify<string>(spec.source_files));
    return patterns.filter(Boolean);
  }

  private supportsDirectSourceBuild(spec: any): boolean {
    const patterns = this.collectSourceFilePatterns(spec);
    if (patterns.length === 0) return false;
    const joined = patterns.join(' ');
    if (/\.(swift|metal|mm)\b/i.test(joined)) return false;
    return /\.(c|m|cc|cpp|cxx|S|h)\b/i.test(joined) || /[{}*]/.test(joined);
  }

  /**
   * 递归清除 JSON 对象中值为 null 的字段
   * 解决 CocoaPods 解析 podspec 时遇到 null 值导致 "no implicit conversion of nil into String"
   */
  private cleanNullFields(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map(item => this.cleanNullFields(item));
    }
    if (obj && typeof obj === 'object') {
      const cleaned: any = {};
      for (const [key, value] of Object.entries(obj)) {
        if (value === null || value === undefined) continue;
        cleaned[key] = this.cleanNullFields(value);
      }
      return cleaned;
    }
    return obj;
  }

  private mapRow(row: any): PodComponent {
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      summary: row.summary || '',
      homepage: row.homepage || '',
      source_zip_url: row.source_zip_url,
      podspec_content: row.podspec_content,
      upload_time: row.upload_time,
      status: row.status,
      error_message: row.error_message || undefined,
      package_type: row.package_type || (row.name === 'NNRtc' ? (isNNRtcTestVersion(row.version) ? 'test' : 'release') : undefined),
      build_id: row.build_id || undefined,
      nnios_branch: row.nnios_branch || undefined,
    };
  }

  /**
   * 在本地已注册的 spec repos 中找指定 pod、版本的 podspec 文件
   * 返回 podspec 文件的绝对路径，找不到返回 null
   */
  private findLocalPodspecFile(podName: string, version?: string): string | null {
    const reposRoot = path.join(process.env.HOME || '', '.cocoapods/repos');
    if (!fs.existsSync(reposRoot)) return null;

    let repoEntries: string[] = [];
    try {
      repoEntries = fs.readdirSync(reposRoot);
    } catch {
      return null;
    }

    /** 给定 podDir，寻找指定版本（或最新版本）的 .podspec / .podspec.json */
    const lookup = (podDir: string): string | null => {
      if (!fs.existsSync(podDir)) return null;
      let versions: string[] = [];
      try {
        versions = fs.readdirSync(podDir);
      } catch {
        return null;
      }
      const candidates = version ? [version] : this.sortVersionsDesc(versions);
      for (const v of candidates) {
        const dir = path.join(podDir, v);
        if (!fs.existsSync(dir)) continue;
        const json = path.join(dir, `${podName}.podspec.json`);
        if (fs.existsSync(json)) return json;
        const ruby = path.join(dir, `${podName}.podspec`);
        if (fs.existsSync(ruby)) return ruby;
      }
      return null;
    };

    for (const repo of repoEntries) {
      const repoDir = path.join(reposRoot, repo);
      try {
        if (!fs.statSync(repoDir).isDirectory()) continue;
      } catch {
        continue;
      }

      // 普通 spec repo: <repo>/Specs/<Name> 或 <repo>/<Name>
      const direct = lookup(path.join(repoDir, 'Specs', podName));
      if (direct) return direct;
      const flat = lookup(path.join(repoDir, podName));
      if (flat) return flat;

      // CDN trunk sharding: <repo>/Specs/<x>/<y>/<z>/<Name>
      const trunkSpecs = path.join(repoDir, 'Specs');
      if (!fs.existsSync(trunkSpecs)) continue;
      try {
        for (const x of fs.readdirSync(trunkSpecs)) {
          if (x.length !== 1) continue;
          const xp = path.join(trunkSpecs, x);
          for (const y of fs.readdirSync(xp)) {
            if (y.length !== 1) continue;
            const yp = path.join(xp, y);
            for (const z of fs.readdirSync(yp)) {
              if (z.length !== 1) continue;
              const found = lookup(path.join(yp, z, podName));
              if (found) return found;
            }
          }
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  /**
   * 把本地 podspec 文件（Ruby 或 JSON）解析成 JSON 对象
   * 优先：podspec.json 直接读；podspec(Ruby) 用 `pod ipc spec` 转 JSON
   */
  private parseLocalPodspec(specPath: string): any {
    if (specPath.endsWith('.json')) {
      return JSON.parse(fs.readFileSync(specPath, 'utf-8'));
    }
    const out = execSync(`pod ipc spec "${specPath}"`, {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(out);
  }

  private getCocoaPodsCdnShard(podName: string): string {
    return crypto.createHash('md5').update(podName).digest('hex').slice(0, 3).split('').join('/');
  }

  private fetchOfficialPodspecFromCdn(podName: string, version: string): any | null {
    const shard = this.getCocoaPodsCdnShard(podName);
    const url = `https://cdn.cocoapods.org/Specs/${shard}/${encodeURIComponent(podName)}/${encodeURIComponent(version)}/${encodeURIComponent(podName)}.podspec.json`;
    try {
      const result = execSync(`curl -fsSL --retry 2 --retry-delay 2 --connect-timeout 15 --max-time 60 ${shellQuote(url)}`, {
        encoding: 'utf-8',
        timeout: 70000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return JSON.parse(result);
    } catch (error: any) {
      logger.warn('CocoaPods CDN 获取 podspec 失败', { podName, version, url, error: error.message });
      return null;
    }
  }

  private listVersionsFromCocoaPodsCdn(podName: string): string[] {
    const shard = this.getCocoaPodsCdnShard(podName);
    const url = `https://cdn.cocoapods.org/all_pods_versions_${shard.replace(/\//g, '_')}.txt`;
    try {
      const result = execSync(`curl -fsSL --retry 2 --retry-delay 2 --connect-timeout 15 --max-time 60 ${shellQuote(url)}`, {
        encoding: 'utf-8',
        timeout: 70000,
        maxBuffer: 20 * 1024 * 1024,
      });
      const line = result
        .split('\n')
        .find((item) => item.startsWith(`${podName}/`));
      return line ? line.split('/').slice(1).filter(Boolean) : [];
    } catch (error: any) {
      logger.warn('CocoaPods CDN 获取版本列表失败', { podName, url, error: error.message });
      return [];
    }
  }

  /**
   * 查询官方组件的 podspec
   * 先扫本地 spec repos（含 aliyun-specs / nnspec / trunk），命中则用 pod ipc spec 转 JSON；
   * 找不到再退回到 `pod spec cat`（仅对 trunk 有效）
   */
  async fetchOfficialPodspec(podName: string, version?: string): Promise<any> {
    // 1. 本地命中
    const localPath = this.findLocalPodspecFile(podName, version);
    if (localPath) {
      try {
        return this.parseLocalPodspec(localPath);
      } catch (err: any) {
        logger.warn('解析本地 podspec 失败，尝试 pod spec cat', {
          podName,
          version,
          path: localPath,
          error: err.message,
        });
        // fallthrough
      }
    }

    // 2. 优先走 CocoaPods CDN：部分 pod/version（如 libwebp@1.6.0）在 pod spec cat 查不到，但 CDN 上存在。
    if (version) {
      const spec = this.fetchOfficialPodspecFromCdn(podName, version);
      if (spec) return spec;
    }

    // 3. 退回 pod spec cat（trunk 上的 pod 通常有 .podspec.json）
    let specCatError = '';
    try {
      const escapedName = podName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const versionFlag = version ? ` --version=${version}` : '';
      const cmd = `pod spec cat "^${escapedName}$" --regex${versionFlag} 2>/dev/null`;
      const result = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
      return JSON.parse(result);
    } catch (error: any) {
      specCatError = error.message;
      logger.warn('pod spec cat 获取官方 podspec 失败', { podName, version, error: error.message });
    }

    throw new Error(`获取官方 podspec 失败: ${specCatError || `${podName}${version ? `@${version}` : ''} 不存在`}`);
  }

  /**
   * 排序版本号（语义化降序）
   */
  private sortVersionsDesc(versions: string[]): string[] {
    const unique = [...new Set(versions)];
    unique.sort((a, b) => {
      const pa = a.split('.');
      const pb = b.split('.');
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const sa = pa[i] || '';
        const sb = pb[i] || '';
        const na = Number(sa);
        const nb = Number(sb);
        if (!isNaN(na) && !isNaN(nb)) {
          if (na !== nb) return nb - na;
        } else {
          if (sa !== sb) return sb.localeCompare(sa);
        }
      }
      return 0;
    });
    return unique;
  }

  /**
   * 扫描本地 ~/.cocoapods/repos 下所有 spec 仓库，找出该 pod 的全部版本目录
   * 支持普通 git repo 和 CDN trunk 的目录结构
   */
  private listVersionsFromLocalSpecRepos(podName: string): string[] {
    const reposRoot = path.join(process.env.HOME || '', '.cocoapods/repos');
    if (!fs.existsSync(reposRoot)) return [];

    const found = new Set<string>();
    let repoEntries: string[] = [];
    try {
      repoEntries = fs.readdirSync(reposRoot);
    } catch {
      return [];
    }

    for (const repo of repoEntries) {
      const repoDir = path.join(reposRoot, repo);
      if (!fs.statSync(repoDir).isDirectory()) continue;

      // 候选位置：
      // - <repo>/Specs/<Name>/<version>/<Name>.podspec
      // - <repo>/Specs/<a>/<b>/<c>/<Name>/<version>/<Name>.podspec   (trunk CDN sharding)
      // - <repo>/<Name>/<version>/<Name>.podspec                      (有些 repo 没有 Specs/)
      const candidates = [
        path.join(repoDir, 'Specs', podName),
        path.join(repoDir, podName),
      ];
      // trunk CDN: Specs/<x>/<y>/<z>/<Name>，x/y/z 是 podName 的 hash 前 3 位的目录
      const trunkSpecs = path.join(repoDir, 'Specs');
      if (fs.existsSync(trunkSpecs)) {
        try {
          const xs = fs.readdirSync(trunkSpecs);
          for (const x of xs) {
            if (x.length !== 1) continue; // CDN sharding 是单字符目录
            const xp = path.join(trunkSpecs, x);
            try {
              const ys = fs.readdirSync(xp);
              for (const y of ys) {
                if (y.length !== 1) continue;
                const yp = path.join(xp, y);
                try {
                  const zs = fs.readdirSync(yp);
                  for (const z of zs) {
                    if (z.length !== 1) continue;
                    candidates.push(path.join(yp, z, podName));
                  }
                } catch { /* ignore */ }
              }
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }

      for (const podDir of candidates) {
        if (!fs.existsSync(podDir)) continue;
        try {
          const versions = fs.readdirSync(podDir);
          for (const v of versions) {
            const specFile = path.join(podDir, v, `${podName}.podspec`);
            const jsonFile = path.join(podDir, v, `${podName}.podspec.json`);
            if (fs.existsSync(specFile) || fs.existsSync(jsonFile)) {
              found.add(v);
            }
          }
        } catch {
          // ignore
        }
      }
    }

    return [...found];
  }

  private listVersionsFromPodTrunkInfo(podName: string): string[] {
    try {
      const result = execSync(`pod trunk info ${shellQuote(podName)} 2>/dev/null`, { encoding: 'utf-8', timeout: 30000 });
      const versions: string[] = [];
      for (const line of result.split('\n')) {
        const match = line.match(/^\s+-\s+([\d.]+[A-Za-z0-9._-]*)/);
        if (match) versions.push(match[1]);
      }
      return versions;
    } catch (error: any) {
      logger.warn('pod trunk info 获取官方版本失败', { podName, error: error.message });
      return [];
    }
  }

  /**
   * 查询官方组件的可用版本列表
   * 合并：本地已添加的 spec repos（含 aliyun、trunk 等） + pod trunk info，避免本地 CDN/镜像缓存落后漏版本
   */
  async fetchOfficialVersions(podName: string): Promise<string[]> {
    const versions = new Set<string>();

    // 1. 扫本地 spec repos，能拿到所有第三方源的版本列表
    const local = this.listVersionsFromLocalSpecRepos(podName);
    local.forEach((version) => versions.add(version));

    // 2. 合并官方 trunk，避免本地 CocoaPods CDN/镜像缓存未更新时漏最新版本
    const trunk = this.listVersionsFromPodTrunkInfo(podName);
    trunk.forEach((version) => versions.add(version));

    // 3. 合并 CocoaPods CDN 索引，pod spec cat/trunk info 找不到的 pod 也能补齐版本
    const cdn = this.listVersionsFromCocoaPodsCdn(podName);
    cdn.forEach((version) => versions.add(version));

    if (versions.size > 0) {
      return this.sortVersionsDesc([...versions]);
    }

    // 4. 最后兜底：pod spec cat 至少能拿到当前最新版本
    try {
      const spec = await this.fetchOfficialPodspec(podName);
      if (spec?.version) return [spec.version];
    } catch {
      // ignore
    }

    throw new Error(`获取 ${podName} 版本列表失败`);
  }

  /**
   * 获取组件的第三方依赖列表，并检查哪些已在内部仓库中存在
   * 用于发布前提示用户先发布缺失的依赖
   */
  async checkDependencies(podName: string, version: string): Promise<{
    dependencies: Array<{
      name: string;
      versionRequirement: string;
      existsInInternal: boolean;
      internalVersions: string[];
      officialVersions: string[];
    }>;
    allSatisfied: boolean;
    subspecs: string[];
    defaultSubspecs: string[];
  }> {
    const spec = await this.fetchOfficialPodspec(podName, version);

    // 收集所有第三方依赖（顶层 + subspecs）
    const allDeps: Record<string, string[]> = {};

    // 顶层依赖
    if (spec.dependencies) {
      for (const [depName, depVersions] of Object.entries(spec.dependencies)) {
        allDeps[depName] = Array.isArray(depVersions) ? depVersions as string[] : [];
      }
    }

    // 从 subspecs 收集依赖（同 Podfile 逻辑：有 default 只取 default，否则取全部）
    if (spec.subspecs && Array.isArray(spec.subspecs)) {
      const subsToCheck = spec.default_subspecs
        ? (Array.isArray(spec.default_subspecs) ? spec.default_subspecs : [spec.default_subspecs])
        : spec.subspecs.map((s: any) => s.name);

      for (const subName of subsToCheck) {
        const sub = spec.subspecs.find((s: any) => s.name === subName);
        if (sub?.dependencies) {
          for (const [depName, depVersions] of Object.entries(sub.dependencies)) {
            // 跳过自身 subspec 的内部依赖（如 SVGAPlayer/ProtoFiles）
            if (depName.startsWith(`${podName}/`)) continue;
            allDeps[depName] = Array.isArray(depVersions) ? depVersions as string[] : [];
          }
        }
      }
    }

    // 检查每个依赖是否在内部仓库中存在，并获取官方可用版本
    const results = [];
    for (const [depName, depVersions] of Object.entries(allDeps)) {
      // SDWebImage/Core 这种 subspec 依赖，用主组件名 SDWebImage 去查内部仓库
      const mainPodName = depName.includes('/') ? depName.split('/')[0] : depName;
      const internalVersions = await this.getVersions(mainPodName);

      // 获取官方版本列表（用于未发布的依赖选择版本）
      let officialVersions: string[] = [];
      if (internalVersions.length === 0) {
        try {
          officialVersions = await this.fetchOfficialVersions(mainPodName);
          // 只取前 20 个版本
          officialVersions = officialVersions.slice(0, 20);
        } catch {
          // 获取失败不阻断
        }
      }

      results.push({
        name: depName,
        versionRequirement: depVersions.length > 0 ? depVersions.join(', ') : '任意版本',
        existsInInternal: internalVersions.length > 0,
        internalVersions: internalVersions.map(v => v.version),
        officialVersions,
      });
    }

    return {
      dependencies: results,
      allSatisfied: results.every(d => d.existsInInternal),
      subspecs: spec.subspecs ? spec.subspecs.map((s: any) => s.name) : [],
      defaultSubspecs: spec.default_subspecs
        ? (Array.isArray(spec.default_subspecs) ? spec.default_subspecs : [spec.default_subspecs])
        : [],
    };
  }

  /**
   * 从官方 CocoaPods 导入组件到内部仓库
   * 下载官方 zip → 上传 Nexus → 生成内部 podspec → 同步 NNSpec
   */
  async importFromOfficial(podName: string, version: string, publishVersion?: string, prepareCommand?: string, targetBranch?: string): Promise<PodComponent> {
    // publishVersion: 内部发布用的版本号，可追加后缀如 1.4.0.1
    const pubVer = publishVersion || version;

    // 检查是否已存在（用发布版本号）
    const existing = await this.getOne(podName, pubVer);
    if (existing) {
      throw new Error(`${podName}@${pubVer} 已存在`);
    }

    // 1. 获取官方 podspec（用原始 version 从源获取）
    logger.info('获取官方 podspec', { podName, version, publishVersion: pubVer });
    const spec = await this.fetchOfficialPodspec(podName, version);

    // 2. 下载源文件（支持 http 和 git 两种方式）
    const uploadDir = process.env.UPLOAD_DIR || '/tmp';
    const tempZip = path.join(uploadDir, `official_${podName}_${version}_${Date.now()}.zip`);

    if (spec.source?.http) {
      // HTTP 下载
      const sourceUrl = spec.source.http;
      logger.info('下载官方 SDK (http)', { podName, version, url: sourceUrl });
      // GitHub 下载加速：尝试镜像站，失败后回退到原始地址
      const mirrors = [
        (url: string) => url.replace('https://github.com/', 'https://ghfast.top/https://github.com/'),
        (url: string) => url.replace('https://github.com/', 'https://mirror.ghproxy.com/https://github.com/'),
        (url: string) => url, // 原始地址作为最后的 fallback
      ];
      const urlsToTry = sourceUrl.includes('github.com')
        ? mirrors.map(fn => fn(sourceUrl))
        : [sourceUrl];

      let downloaded = false;
      for (const tryUrl of urlsToTry) {
        try {
          logger.info('尝试下载', { url: tryUrl });
          execSync(`curl -L --retry 2 --retry-delay 3 --connect-timeout 15 --max-time 300 -o "${tempZip}" "${tryUrl}"`, {
            encoding: 'utf-8',
            timeout: 360000,
          });
          // 检查文件是否有效（大于 1KB）
          const stat = fs.statSync(tempZip);
          if (stat.size > 1024) {
            downloaded = true;
            logger.info('下载成功', { url: tryUrl, size: stat.size });
            break;
          }
          fs.unlinkSync(tempZip);
        } catch {
          logger.warn('下载失败，尝试下一个镜像', { url: tryUrl });
          if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
        }
      }
      if (!downloaded) {
        throw new Error(`下载官方 SDK 失败：所有镜像均超时，请手动下载后使用"上传本地组件"功能`);
      }
    } else if (spec.source?.git) {
      // Git 克隆后打包为 zip
      const gitUrl = spec.source.git;
      const tag = spec.source.tag || version;
      const tempCloneDir = path.join(uploadDir, `official_clone_${Date.now()}`);
      const cloneDirName = podName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const actualCloneDir = path.join(tempCloneDir, cloneDirName);
      logger.info('克隆官方仓库 (git)', { podName, version, git: gitUrl, tag });

      try {
        fs.mkdirSync(tempCloneDir, { recursive: true });

        // GitHub 仓库加速：尝试镜像站
        const gitUrls = gitUrl.includes('github.com')
          ? [
              gitUrl.replace('https://github.com/', 'https://ghfast.top/https://github.com/'),
              gitUrl.replace('https://github.com/', 'https://mirror.ghproxy.com/https://github.com/'),
              gitUrl,
            ]
          : [gitUrl];

        let cloned = false;
        for (const tryGitUrl of gitUrls) {
          try {
            let cloneCmd = `git clone --depth 1`;
            if (tag) cloneCmd += ` --branch "${tag}"`;
            if (spec.source.submodules) cloneCmd += ` --recurse-submodules`;
            cloneCmd += ` "${tryGitUrl}" "${actualCloneDir}"`;

            logger.info('尝试 git clone', { url: tryGitUrl });
            execSync(cloneCmd, { encoding: 'utf-8', timeout: 180000 });
            cloned = true;
            break;
          } catch {
            logger.warn('git clone 失败，尝试下一个镜像', { url: tryGitUrl });
            if (fs.existsSync(actualCloneDir)) fs.rmSync(actualCloneDir, { recursive: true, force: true });
          }
        }
        if (!cloned) {
          throw new Error('所有镜像均克隆失败');
        }

        // 删除 .git 目录减小体积
        const gitDir = path.join(actualCloneDir, '.git');
        if (fs.existsSync(gitDir)) fs.rmSync(gitDir, { recursive: true, force: true });

        // 打包为 zip（目录名与 pathPrefix 一致）
        execSync(`cd "${tempCloneDir}" && zip -r "${tempZip}" "${cloneDirName}"`, {
          encoding: 'utf-8',
          timeout: 60000,
        });

        // 清理克隆目录
        fs.rmSync(tempCloneDir, { recursive: true, force: true });
      } catch (error: any) {
        // 清理
        if (fs.existsSync(tempCloneDir)) fs.rmSync(tempCloneDir, { recursive: true, force: true });
        throw new Error(`克隆官方仓库失败: ${error.message}`);
      }
    } else {
      throw new Error('官方 podspec 中未找到支持的下载方式（需要 http 或 git）');
    }

    if (!fs.existsSync(tempZip)) {
      throw new Error('下载官方 SDK 失败：文件不存在');
    }

    // 3. 计算 sha256
    const fileBuffer = fs.readFileSync(tempZip);
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // 4. 基于官方 podspec 生成内部 podspec（保留原始路径，只替换 source）
    const podspecContent = this.generateOfficialPodspec(spec, podName, pubVer, sha256, prepareCommand);

    // 5. 上传到 Nexus
    let nexusUrl: string;
    try {
      nexusUrl = await this.uploadToNexus(tempZip, podName, pubVer);
    } catch (error: any) {
      fs.unlinkSync(tempZip);
      throw error;
    }
    fs.unlinkSync(tempZip);

    // 6. 同步 podspec 到 NNSpec
    let status: 'published' | 'failed' = 'published';
    let errorMessage: string | undefined;
    try {
      await this.syncToSpecRepo(podName, pubVer, podspecContent);
    } catch (error: any) {
      status = 'failed';
      errorMessage = `Nexus 上传成功，但 spec 仓库同步失败: ${error.message}`;
    }

    if (status === 'published' && targetBranch) {
      try {
        this.syncVersionToNnios(podName, pubVer, targetBranch);
      } catch (error: any) {
        status = 'failed';
        errorMessage = error.message;
      }
    }

    // 7. 保存到数据库
    const component = this.saveComponent({
      name: podName,
      version: pubVer,
      summary: spec.summary || '',
      homepage: spec.source?.git || spec.source?.http || spec.homepage || '',
      source_zip_url: nexusUrl,
      podspec_content: podspecContent,
      status,
      error_message: errorMessage,
    });

    logger.info('官方组件导入成功', { podName, version, publishVersion: pubVer, status });
    return component;
  }

  /**
   * 从源码编译为二进制 framework 并发布
   * 使用 xcodebuild 编译源码 Pod 为真机 .framework 或 .a
   */
  async buildBinaryFromSource(podName: string, version: string, outputType: 'framework' | 'static_library' = 'framework', depVersionOverrides?: Record<string, string>, selectedSubspecs?: string[], publishVersion?: string, prepareCommand?: string, targetBranch?: string): Promise<PodComponent> {
    const pubVer = publishVersion || version;
    logger.info('buildBinaryFromSource 调用参数', { podName, version, outputType, depVersionOverrides, selectedSubspecs, publishVersion: pubVer });
    const existing = await this.getOne(podName, pubVer);
    if (existing) {
      throw new Error(`${podName}@${pubVer} 已存在`);
    }

    const uploadDir = process.env.UPLOAD_DIR || '/tmp';
    const workDir = path.join(uploadDir, `build_${podName}_${Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });

    try {
      // 1. 获取官方 podspec
      logger.info('编译源码组件', { podName, version, outputType });
      const spec = await this.fetchOfficialPodspec(podName, version);

      // 检测是否是预编译二进制库（自带 vendored_frameworks 或 vendored_libraries）
      // 如果是，自动调整 outputType 以匹配实际产物类型
      const hasVendoredFrameworks = spec.vendored_frameworks || spec.subspecs?.some((s: any) => s.vendored_frameworks);
      const hasVendoredLibraries = spec.vendored_libraries || spec.subspecs?.some((s: any) => s.vendored_libraries);
      const hasSourceFiles = spec.source_files || spec.subspecs?.some((s: any) => s.source_files);

      // 如果既没有源码也没有 vendored 产物（如 SwiftLint 这种命令行工具），直接走导入流程
      if (!hasSourceFiles && !hasVendoredFrameworks && !hasVendoredLibraries) {
        logger.info('检测到非编译型组件（无源码、无二进制产物），切换为直接导入', { podName });
        // 清理工作目录
        if (fs.existsSync(workDir)) {
          fs.rmSync(workDir, { recursive: true, force: true });
        }
        return this.importFromOfficial(podName, version, pubVer, prepareCommand, targetBranch);
      }

      if (hasVendoredLibraries && !hasVendoredFrameworks && outputType === 'framework') {
        logger.info('检测到预编译 .a 静态库，自动切换 outputType 为 static_library', { podName });
        outputType = 'static_library';
      } else if (hasVendoredFrameworks && !hasVendoredLibraries && outputType === 'static_library') {
        logger.info('检测到预编译 .framework，自动切换 outputType 为 framework', { podName });
        outputType = 'framework';
      }

      // 2. 从 pod lib create 模板生成合法 Xcode 工程（避免手写 pbxproj 的转义问题）
      const projectDir = path.join(workDir, 'BuildProject');
      const targetName = 'BuildTarget';
      const iosVersion = spec.platforms?.ios || '12.0';
      logger.info('从 CocoaPods 模板生成工程', { podName, version });

      this.scaffoldProjectFromPodTemplate(projectDir, targetName, podName, version, iosVersion, outputType, spec, selectedSubspecs);

      // 3. pod install（带重试，git clone 大仓库可能较慢）
      // 临时设置 git URL 替换，让 CocoaPods clone GitHub 仓库时走镜像加速
      logger.info('执行 pod install', { podName, version, cwd: projectDir });
      let gitMirrorSet = false;
      try {
        execSync('git config --global url."https://ghfast.top/https://github.com/".insteadOf "https://github.com/"', { encoding: 'utf-8' });
        gitMirrorSet = true;
        logger.info('已设置 git GitHub 镜像加速');
      } catch {
        logger.warn('设置 git 镜像失败，将使用原始地址');
      }

      const podInstallTimeout = 600000; // 10 分钟
      const maxRetries = 2;
      let podInstalled = false;

      try {
        for (let attempt = 0; attempt <= maxRetries && !podInstalled; attempt++) {
          const useRepoUpdate = attempt > 0;
          const cmd = useRepoUpdate ? 'pod install --repo-update 2>&1' : 'pod install --no-repo-update 2>&1';
          logger.info(`pod install 尝试 ${attempt + 1}/${maxRetries + 1}`, { cmd });

          try {
            execSync(cmd, {
              cwd: projectDir,
              encoding: 'utf-8',
              timeout: podInstallTimeout,
              maxBuffer: 10 * 1024 * 1024,
            });
            podInstalled = true;
          } catch (podErr: any) {
            const errOutput = ((podErr.stdout || '') + '\n' + (podErr.stderr || '')).trim();
            const last20 = errOutput.split('\n').slice(-20).join('\n');
            logger.warn(`pod install 尝试 ${attempt + 1} 失败`, { output: last20 });

            if (attempt === maxRetries) {
              // pod install 最终失败，尝试直接编译 fallback（仅适用于无外部依赖的纯 C/C++ 库如 libwebp）
              const hasDependencies = spec.dependencies && Object.keys(spec.dependencies).length > 0;
              const subspecHasDeps = spec.subspecs?.some((s: any) =>
                s.dependencies && Object.keys(s.dependencies).some((d: string) => !d.startsWith(`${podName}/`))
              );
              const canDirectBuild = spec.source?.git && hasSourceFiles &&
                !hasVendoredFrameworks && !hasVendoredLibraries &&
                !hasDependencies && !subspecHasDeps &&
                this.supportsDirectSourceBuild(spec);

              if (canDirectBuild) {
                logger.info('pod install 失败，尝试直接编译 fallback（无外部依赖的纯 C/C++ 库）', { podName, version });
                // 恢复 git 配置
                if (gitMirrorSet) {
                  try { execSync('git config --global --unset url."https://ghfast.top/https://github.com/".insteadOf', { encoding: 'utf-8' }); } catch { /* */ }
                  gitMirrorSet = false;
                }
                const result = await this.buildDirectFromSource(spec, podName, version, pubVer, workDir, prepareCommand, targetBranch);
                return result;
              }
              throw new Error(`pod install 失败（已重试 ${maxRetries} 次）:\n${last20}`);
            }
            execSync('sleep 3', { encoding: 'utf-8' });
          }
        }
      } finally {
        // 恢复 git 配置，避免影响其他 git 操作
        if (gitMirrorSet) {
          try {
            execSync('git config --global --unset url."https://ghfast.top/https://github.com/".insteadOf', { encoding: 'utf-8' });
            logger.info('已恢复 git 配置');
          } catch {
            // 忽略
          }
        }
      }

      // 3.5 源码兼容性 patch（pod install 后、编译前）
      // 修复老库在新版 Xcode/SDK 下的编译错误
      const podsDir = path.join(projectDir, 'Pods');
      if (fs.existsSync(podsDir)) {
        try {
          // 先给所有源码文件加写权限（CocoaPods 下载的文件可能是只读的）
          execSync(`find "${podsDir}" -name "*.m" -exec chmod u+w {} +`, { encoding: 'utf-8' });

          // 查找使用了 OSAtomicCompareAndSwapPtrBarrier 的 .m 文件
          const problematicFiles = execSync(
            `grep -rl "OSAtomicCompareAndSwapPtrBarrier" "${podsDir}" --include="*.m" 2>/dev/null || true`,
            { encoding: 'utf-8' }
          ).trim();

          if (problematicFiles) {
            for (const filePath of problematicFiles.split('\n').filter(Boolean)) {
              let content = fs.readFileSync(filePath, 'utf-8');
              // 在文件头部添加宏定义，将 OSAtomicCompareAndSwapPtrBarrier 重定向到 __sync 内建函数
              // 这比正则替换函数调用更安全，不会破坏括号匹配
              const patch = [
                '#include <stdatomic.h>',
                '#define OSAtomicCompareAndSwapPtrBarrier(Old, New, Ptr) __sync_bool_compare_and_swap(Ptr, Old, New)',
                '',
              ].join('\n');
              if (!content.includes('__sync_bool_compare_and_swap') && !content.includes('#define OSAtomicCompareAndSwapPtrBarrier')) {
                content = patch + content;
                fs.writeFileSync(filePath, content, 'utf-8');
                logger.info('Patch: 添加 OSAtomicCompareAndSwapPtrBarrier 宏重定向', { file: path.basename(filePath) });
              }
            }
          }
        } catch (patchErr: any) {
          logger.warn('源码 patch 失败（非致命）', { error: patchErr.message?.substring(0, 200) });
        }
      }

      // 4. xcodebuild 编译真机版本
      logger.info('xcodebuild 编译', { podName, version });
      const buildDir = path.join(workDir, 'build');

      // 列出可用 scheme
      const workspaceName = `${targetName}.xcworkspace`;
      const schemeList = execSync(
        `xcodebuild -workspace ${workspaceName} -list 2>&1`,
        { cwd: projectDir, encoding: 'utf-8', timeout: 30000 }
      );
      logger.info('可用 schemes', { schemes: schemeList.trim() });

      // 从 Pods 工程中直接编译目标 pod
      const podsProjectPath = path.join(projectDir, 'Pods', 'Pods.xcodeproj');
      const usePodsProject = fs.existsSync(podsProjectPath);

      // 先列出 Pods 工程中的 targets，确认目标 pod target 存在
      if (usePodsProject) {
        try {
          const targetList = execSync(
            `xcodebuild -project Pods/Pods.xcodeproj -list 2>&1`,
            { cwd: projectDir, encoding: 'utf-8', timeout: 30000 }
          );
          logger.info('Pods 工程 targets', { targets: targetList.trim() });
        } catch (e: any) {
          logger.warn('列出 Pods targets 失败', { error: e.message?.substring(0, 300) });
        }
      }

      // 用 -project + -target 时不能用 -derivedDataPath，改用 SYMROOT/OBJROOT 指定输出目录
      // 同时强制覆盖 IPHONEOS_DEPLOYMENT_TARGET，避免老库声明的低版本不被新 SDK 支持
      // 加 GCC_TREAT_INCOMPATIBLE_POINTER_TYPE_WARNINGS_AS_ERRORS=NO 和 OTHER_CFLAGS 抑制老代码编译错误
      const minTarget = parseFloat(iosVersion) < 13.0 ? '13.0' : iosVersion;
      const commonFlags = `BUILD_LIBRARY_FOR_DISTRIBUTION=YES SKIP_INSTALL=NO ` +
        `ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO ` +
        `IPHONEOS_DEPLOYMENT_TARGET=${minTarget} ` +
        `GCC_TREAT_INCOMPATIBLE_POINTER_TYPE_WARNINGS_AS_ERRORS=NO ` +
        `CLANG_ENABLE_EXPLICIT_MODULES=NO ` +
        `OTHER_CFLAGS='$(inherited) -Wno-error=incompatible-function-pointer-types -Wno-deprecated-non-prototype -Wno-error=conflicting-types'`;
      const buildCmd = usePodsProject
        ? `xcodebuild build -project Pods/Pods.xcodeproj -target "${podName}" ` +
          `-configuration Release -sdk iphoneos ` +
          `SYMROOT="${buildDir}/Build/Products" OBJROOT="${buildDir}/Build/Intermediates.noindex" ` +
          commonFlags
        : `xcodebuild build -workspace ${workspaceName} -scheme "${podName}" ` +
          `-configuration Release -sdk iphoneos -derivedDataPath "${buildDir}" ` +
          commonFlags;

      // 用 shell 执行 xcodebuild，通过退出码判断成功/失败
      // 加 || true 确保 shell 不会因为 xcodebuild 失败而抛异常，我们自己检查退出码
      let buildOutput: string;
      try {
        buildOutput = execSync(`${buildCmd} 2>&1; echo "XCODEBUILD_EXIT_CODE:$?"`, {
          cwd: projectDir,
          encoding: 'utf-8',
          timeout: 300000,
          maxBuffer: 50 * 1024 * 1024, // 50MB，xcodebuild 输出很大
        });
      } catch (buildError: any) {
        // maxBuffer 超限或超时
        const output = (buildError.stdout || '') + '\n' + (buildError.stderr || '');
        const lines = output.trim().split('\n').slice(-50).join('\n');
        logger.error('xcodebuild 执行异常', { output: lines });
        throw new Error(`xcodebuild 执行异常:\n${lines}`);
      }

      // 从输出中提取退出码
      const exitCodeMatch = buildOutput.match(/XCODEBUILD_EXIT_CODE:(\d+)/);
      const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : -1;
      // 去掉退出码标记行
      buildOutput = buildOutput.replace(/XCODEBUILD_EXIT_CODE:\d+\n?$/, '');

      const outputLines = buildOutput.trim().split('\n');
      const last30 = outputLines.slice(-30).join('\n');

      if (exitCode !== 0) {
        // 提取包含 error: 的行，比只取最后 N 行更有用
        const errorLines = outputLines.filter(l => l.includes('error:') || l.includes('** BUILD FAILED **'));
        const errorSummary = errorLines.length > 0
          ? errorLines.slice(0, 20).join('\n')
          : outputLines.slice(-30).join('\n');
        logger.error('xcodebuild 编译失败', { exitCode, output: errorSummary });
        throw new Error(`xcodebuild 编译失败 (exit ${exitCode}):\n${errorSummary}`);
      }
      logger.info('编译成功', { output: last30 });

      // 5. 查找编译产物
      // -project + SYMROOT 模式: 产物在 buildDir/Build/Products/Release-iphoneos/
      // -workspace + derivedDataPath 模式: 产物在 buildDir/Build/Products/Release-iphoneos/
      const productsDir = path.join(buildDir, 'Build', 'Products', 'Release-iphoneos');
      if (!fs.existsSync(productsDir)) {
        // fallback: 搜索整个 buildDir
        if (!fs.existsSync(buildDir)) {
          throw new Error(`编译产物目录不存在: ${buildDir}，xcodebuild 可能未正确执行`);
        }
        logger.warn('标准产物目录不存在，将搜索整个 buildDir', { productsDir });
      }

      const searchDir = fs.existsSync(productsDir) ? productsDir : buildDir;

      let artifactPath = '';
      let artifactName = '';

      if (outputType === 'framework') {
        // use_frameworks! 模式下，framework 产物在 Release-iphoneos/ 中
        const fwSearch = execSync(
          `find "${searchDir}" -name "${podName}.framework" -type d 2>/dev/null | head -1`,
          { encoding: 'utf-8' }
        ).trim();
        let fwPath = fwSearch || execSync(
          `find "${searchDir}" -name "*.framework" -type d ` +
          `-not -name "Pods_${targetName}_Example.framework" ` +
          `-not -path "*/Pods_*.framework" ` +
          `2>/dev/null | head -1`,
          { encoding: 'utf-8' }
        ).trim();
        if (!fwPath) {
          // 检查 Pods 源码目录（预编译二进制库自带 .framework）
          const podsVendoredFw = execSync(
            `find "${path.join(projectDir, 'Pods', podName)}" -name "*.framework" -type d 2>/dev/null | head -1`,
            { encoding: 'utf-8' }
          ).trim();
          if (podsVendoredFw) {
            fwPath = podsVendoredFw;
            logger.info('使用 Pods 源码目录中的预编译 .framework', { fwPath });
          } else {
            const allProducts = execSync(
              `find "${buildDir}" \\( -name "*.framework" -o -name "*.a" \\) 2>/dev/null || true`,
              { encoding: 'utf-8' }
            ).trim();
            logger.error('未找到 framework，所有编译产物', { allProducts });
            throw new Error(`编译产物中未找到 .framework。所有产物: ${allProducts || '无'}`);
          }
        }
        artifactPath = fwPath;
        artifactName = path.basename(fwPath);
      } else {
        // 搜索 .a 文件，pod 名中的横杠可能被替换为下划线
        const safeName = podName.replace(/-/g, '_');
        const aSearch = execSync(
          `find "${searchDir}" -name "lib${podName}.a" -o -name "lib${safeName}.a" 2>/dev/null | head -1`,
          { encoding: 'utf-8' }
        ).trim();
        const aPath = aSearch || execSync(
          `find "${searchDir}" -name "*.a" -not -name "libPods*" 2>/dev/null | head -1`,
          { encoding: 'utf-8' }
        ).trim();
        // 如果 searchDir 没找到，扩大到整个 buildDir
        const finalPath = aPath || execSync(
          `find "${buildDir}" -name "*.a" -not -name "libPods*" 2>/dev/null | head -1`,
          { encoding: 'utf-8' }
        ).trim();
        // 如果编译产物中也没有，检查 Pods 源码目录（预编译二进制库如 libyuv-iOS 自带 .a）
        const podsVendoredPath = !finalPath ? execSync(
          `find "${path.join(projectDir, 'Pods', podName)}" -name "*.a" 2>/dev/null | head -1`,
          { encoding: 'utf-8' }
        ).trim() : '';
        const resultPath = finalPath || podsVendoredPath;
        if (!resultPath) {
          const allProducts = execSync(
            `find "${buildDir}" \\( -name "*.a" -o -name "*.framework" \\) 2>/dev/null || true`,
            { encoding: 'utf-8' }
          ).trim();
          logger.error('未找到 .a，所有编译产物', { allProducts, searchDir });
          throw new Error(`编译产物中未找到 .a。所有产物: ${allProducts || '无'}`);
        }
        artifactPath = resultPath;
        artifactName = path.basename(resultPath);
        if (podsVendoredPath) {
          logger.info('使用 Pods 源码目录中的预编译 .a', { artifactPath });
        }
      }

      logger.info('编译产物', { artifactName, artifactPath });

      // 6. 打包为 zip（framework 包含头文件；.a 需要额外收集头文件）
      const tempZip = path.join(uploadDir, `built_${podName}_${version}.zip`);
      const packDir = path.join(workDir, 'pack');
      fs.mkdirSync(packDir, { recursive: true });

      if (outputType === 'framework') {
        // 复制 framework 到打包目录
        execSync(`cp -R "${artifactPath}" "${packDir}/"`, { encoding: 'utf-8' });

        // 检查 framework 内是否包含 Headers 目录
        const fwInPack = path.join(packDir, artifactName);
        const headersInFw = path.join(fwInPack, 'Headers');
        const fwContents = execSync(`ls -la "${fwInPack}/"`, { encoding: 'utf-8' }).trim();
        logger.info('framework 内容', { contents: fwContents });

        if (!fs.existsSync(headersInFw) || fs.readdirSync(headersInFw).length === 0) {
          // Headers 目录不存在或为空，从编译产物中收集头文件
          logger.warn('framework 中缺少 Headers，尝试从编译产物中收集');
          fs.mkdirSync(headersInFw, { recursive: true });

          // 方法1: 从 Pods 源码目录收集公开头文件
          const podsSourceDir = path.join(projectDir, 'Pods', podName);
          if (fs.existsSync(podsSourceDir)) {
            const headers = execSync(
              `find "${podsSourceDir}" -name "*.h" 2>/dev/null || true`,
              { encoding: 'utf-8' }
            ).trim();
            if (headers) {
              execSync(`find "${podsSourceDir}" -name "*.h" -exec cp {} "${headersInFw}/" \\;`, { encoding: 'utf-8' });
              logger.info('从 Pods 源码目录收集头文件', { count: headers.split('\n').length });
            }
          }

          // 方法2: 从编译中间产物中查找头文件
          if (fs.readdirSync(headersInFw).length === 0) {
            const headerSearch = execSync(
              `find "${buildDir}" -path "*/${podName}/*.h" 2>/dev/null | head -20 || true`,
              { encoding: 'utf-8' }
            ).trim();
            if (headerSearch) {
              const headerFiles = headerSearch.split('\n');
              for (const h of headerFiles) {
                if (h && fs.existsSync(h)) {
                  const dest = path.join(headersInFw, path.basename(h));
                  if (!fs.existsSync(dest)) {
                    fs.copyFileSync(h, dest);
                  }
                }
              }
              logger.info('从编译中间产物收集头文件', { count: headerFiles.length });
            }
          }

          // 生成 umbrella header（如果不存在）
          const umbrellaHeader = path.join(headersInFw, `${podName}.h`);
          if (!fs.existsSync(umbrellaHeader)) {
            const allHeaders = fs.readdirSync(headersInFw).filter(f => f.endsWith('.h') && f !== `${podName}.h`);
            const imports = allHeaders.map(h => `#import <${podName}/${h}>`).join('\n');
            fs.writeFileSync(umbrellaHeader, `#import <Foundation/Foundation.h>\n${imports}\n`, 'utf-8');
            logger.info('生成 umbrella header', { headerCount: allHeaders.length });
          }
        }

        // 确保有 module.modulemap
        const modulesDir = path.join(fwInPack, 'Modules');
        const modulemapPath = path.join(modulesDir, 'module.modulemap');
        if (!fs.existsSync(modulemapPath)) {
          fs.mkdirSync(modulesDir, { recursive: true });
          const modulemap = `framework module ${podName} {\n  umbrella header "${podName}.h"\n  export *\n  module * { export * }\n}\n`;
          fs.writeFileSync(modulemapPath, modulemap, 'utf-8');
          logger.info('生成 module.modulemap');
        }

        const finalContents = execSync(`find "${fwInPack}" -type f | head -30`, { encoding: 'utf-8' }).trim();
        logger.info('最终 framework 内容', { contents: finalContents });
      } else {
        // 复制 .a 和头文件
        execSync(`cp "${artifactPath}" "${packDir}/"`, { encoding: 'utf-8' });
        const headersTarget = path.join(packDir, `${podName}.Headers`);
        fs.mkdirSync(headersTarget, { recursive: true });

        // 方法1: 从编译产物目录查找头文件
        const headerDir = execSync(
          `find "${buildDir}" -path "*/Release-iphoneos/${podName}/*.h" -exec dirname {} \\; 2>/dev/null | sort -u | head -1`,
          { encoding: 'utf-8' }
        ).trim();
        if (headerDir) {
          execSync(`cp -R "${headerDir}/"*.h "${headersTarget}/" 2>/dev/null || true`, { encoding: 'utf-8' });
        }

        // 方法2: 从编译中间产物的 public headers 目录查找
        if (fs.readdirSync(headersTarget).filter(f => f.endsWith('.h')).length === 0) {
          const publicHeaderDir = execSync(
            `find "${buildDir}" -path "*/${podName}.build/*/public_headers" -type d 2>/dev/null | head -1`,
            { encoding: 'utf-8' }
          ).trim();
          if (publicHeaderDir) {
            execSync(`cp "${publicHeaderDir}/"*.h "${headersTarget}/" 2>/dev/null || true`, { encoding: 'utf-8' });
            logger.info('从 public_headers 目录收集头文件', { dir: publicHeaderDir });
          }
        }

        // 方法3: 从 Pods 源码目录收集（源码库的头文件在这里）
        if (fs.readdirSync(headersTarget).filter(f => f.endsWith('.h')).length === 0) {
          const podsSourceDir = path.join(projectDir, 'Pods', podName);
          if (fs.existsSync(podsSourceDir)) {
            execSync(`find "${podsSourceDir}" -name "*.h" -exec cp {} "${headersTarget}/" \\;`, { encoding: 'utf-8' });
            logger.info('从 Pods 源码目录收集头文件', { dir: podsSourceDir });
          }
        }

        const headerCount = fs.readdirSync(headersTarget).filter(f => f.endsWith('.h')).length;
        logger.info('收集到的头文件', { count: headerCount, files: fs.readdirSync(headersTarget).join(', ') });

        if (headerCount === 0) {
          logger.warn('未找到任何头文件，zip 中将不包含 Headers');
        }
      }

      execSync(`cd "${packDir}" && zip -r "${tempZip}" .`, {
        encoding: 'utf-8',
        timeout: 60000,
      });

      // 7. 计算 sha256
      const fileBuffer = fs.readFileSync(tempZip);
      const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      // 8. 生成 podspec（基于原始官方 podspec，保留 dependencies/swift_versions 等完整信息）
      const podspecContent = this.generateBinaryPodspec(spec, podName, pubVer, outputType, artifactName, sha256, depVersionOverrides, selectedSubspecs, prepareCommand);

      // 9. 上传到 Nexus
      let nexusUrl: string;
      try {
        nexusUrl = await this.uploadToNexus(tempZip, podName, pubVer);
      } catch (error: any) {
        fs.unlinkSync(tempZip);
        throw error;
      }
      fs.unlinkSync(tempZip);

      // 10. 同步 podspec
      let status: 'published' | 'failed' = 'published';
      let errorMessage: string | undefined;
      try {
        await this.syncToSpecRepo(podName, pubVer, podspecContent);
      } catch (error: any) {
        status = 'failed';
        errorMessage = `Nexus 上传成功，但 spec 仓库同步失败: ${error.message}`;
      }

      if (status === 'published' && targetBranch) {
        try {
          this.syncVersionToNnios(podName, pubVer, targetBranch);
        } catch (error: any) {
          status = 'failed';
          errorMessage = error.message;
        }
      }

      // 11. 保存到数据库
      const component = this.saveComponent({
        name: podName,
        version: pubVer,
        summary: spec.summary || '',
        homepage: spec.homepage || '',
        source_zip_url: nexusUrl,
        podspec_content: podspecContent,
        status,
        error_message: errorMessage,
      });

      logger.info('源码编译发布成功', { podName, version, publishVersion: pubVer, outputType, status });
      return component;
    } finally {
      // 清理工作目录
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * 从静态模板文件生成合法的 Xcode 工程
   * 使用项目内置的 pbxproj 模板（来自 CocoaPods 官方模板），替换占位符后生成完整工程
   * 不依赖网络，不依赖 pod lib create
   */
  private scaffoldProjectFromPodTemplate(
    projectDir: string,
    targetName: string,
    podName: string,
    version: string,
    iosVersion: string,
    outputType: 'framework' | 'static_library' = 'framework',
    spec?: any,
    selectedSubspecs?: string[]
  ): void {
    fs.mkdirSync(projectDir, { recursive: true });

    // 1. 从模板文件读取 pbxproj 并替换占位符
    const templatePath = path.join(__dirname, '..', 'templates', 'project.pbxproj.template');
    if (!fs.existsSync(templatePath)) {
      throw new Error(`pbxproj 模板文件不存在: ${templatePath}`);
    }
    let pbxproj = fs.readFileSync(templatePath, 'utf-8');
    pbxproj = pbxproj.replace(/__TARGET__/g, targetName);

    // 2. 创建 xcodeproj 目录和 pbxproj 文件
    const xcodeprojDir = path.join(projectDir, `${targetName}.xcodeproj`);
    fs.mkdirSync(xcodeprojDir, { recursive: true });
    fs.writeFileSync(path.join(xcodeprojDir, 'project.pbxproj'), pbxproj, 'utf-8');

    // 创建 xcworkspace
    const workspaceDir = path.join(xcodeprojDir, 'project.xcworkspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'contents.xcworkspacedata'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version="1.0">\n  <FileRef location="self:${targetName}.xcodeproj"></FileRef>\n</Workspace>\n`,
      'utf-8'
    );

    // 3. 创建源文件目录和最小源文件（pod install 需要 target 有源文件）
    const srcDir = path.join(projectDir, targetName);
    fs.mkdirSync(srcDir, { recursive: true });

    // Info.plist
    fs.writeFileSync(path.join(srcDir, `${targetName}-Info.plist`), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>UILaunchStoryboardName</key><string>LaunchScreen</string>
  <key>UIMainStoryboardFile</key><string>Main</string>
</dict>
</plist>`, 'utf-8');

    // main.m
    fs.writeFileSync(path.join(srcDir, 'main.m'),
      '#import <UIKit/UIKit.h>\n#import "AppDelegate.h"\nint main(int argc, char * argv[]) {\n  @autoreleasepool {\n    return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));\n  }\n}\n',
      'utf-8'
    );

    // AppDelegate
    fs.writeFileSync(path.join(srcDir, 'AppDelegate.h'),
      '#import <UIKit/UIKit.h>\n@interface AppDelegate : UIResponder <UIApplicationDelegate>\n@property (strong, nonatomic) UIWindow *window;\n@end\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(srcDir, 'AppDelegate.m'),
      '#import "AppDelegate.h"\n@implementation AppDelegate\n@end\n',
      'utf-8'
    );

    // ViewController
    fs.writeFileSync(path.join(srcDir, 'ViewController.h'),
      '#import <UIKit/UIKit.h>\n@interface ViewController : UIViewController\n@end\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(srcDir, 'ViewController.m'),
      '#import "ViewController.h"\n@implementation ViewController\n@end\n',
      'utf-8'
    );

    // Prefix header
    fs.writeFileSync(path.join(srcDir, `${targetName}-Prefix.pch`),
      '#import <Availability.h>\n#ifndef __IPHONE_5_0\n#warning "This project uses features only available in iOS SDK 5.0 and later."\n#endif\n#ifdef __OBJC__\n#import <UIKit/UIKit.h>\n#import <Foundation/Foundation.h>\n#endif\n',
      'utf-8'
    );

    // Storyboards (minimal)
    const baseLprojDir = path.join(srcDir, 'Base.lproj');
    fs.mkdirSync(baseLprojDir, { recursive: true });
    fs.writeFileSync(path.join(baseLprojDir, 'Main.storyboard'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0" toolsVersion="13122.16" targetRuntime="AppleSDK" propertyAccessControl="none" useAutolayout="YES" useTraitCollections="YES" useSafeAreas="YES" colorMatched="YES" initialViewController="BYZ-38-t0r">\n  <scenes>\n    <scene sceneID="tne-QT-ifu">\n      <objects>\n        <viewController id="BYZ-38-t0r" customClass="ViewController" sceneMemberID="viewController"/>\n      </objects>\n    </scene>\n  </scenes>\n</document>\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(baseLprojDir, 'LaunchScreen.storyboard'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0" toolsVersion="13122.16" targetRuntime="AppleSDK" propertyAccessControl="none" useAutolayout="YES" launchScreen="YES" useTraitCollections="YES" useSafeAreas="YES" colorMatched="YES" initialViewController="01J-lp-oVM">\n  <scenes>\n    <scene sceneID="EHf-IW-A2E">\n      <objects>\n        <viewController id="01J-lp-oVM" sceneMemberID="viewController"/>\n      </objects>\n    </scene>\n  </scenes>\n</document>\n',
      'utf-8'
    );

    // Images.xcassets
    const assetsDir = path.join(srcDir, 'Images.xcassets', 'AppIcon.appiconset');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'Contents.json'), '{"images":[],"info":{"version":1,"author":"xcode"}}\n', 'utf-8');

    // en.lproj/InfoPlist.strings
    const enLprojDir = path.join(srcDir, 'en.lproj');
    fs.mkdirSync(enLprojDir, { recursive: true });
    fs.writeFileSync(path.join(enLprojDir, 'InfoPlist.strings'), '/* Localized versions of Info.plist keys */\n', 'utf-8');

    // 4. 写入 Podfile
    const useFrameworks = outputType === 'framework' ? "use_frameworks!\n" : '';
    const minDeployTarget = parseFloat(iosVersion) < 13.0 ? '13.0' : iosVersion;

    // source 声明，确保能找到官方和第三方 spec repos
    // 内部 nnspec 排最前，优先使用已发布的内部二进制版本（如 libwebp.framework）
    const sources = [
      "source 'http://git.leigod.top/nn_ios/nnspec.git'",
      "source 'https://cdn.cocoapods.org/'",
      "source 'https://github.com/aliyun/aliyun-specs.git'",
    ].join('\n');

    // 生成 pod 引用行：
    // - 如果用户指定了 subspecs，只引入指定的
    // - 未指定 subspecs 时引入全部，与前端“不选则引入全部”的语义一致
    // - 如果存在 default_subspecs，主 pod 只会引入默认子规格，因此必须显式列出所有要编译的 subspec
    // - 如果没有 subspecs，直接引入主 pod
    let podLines = '';
    const subspecs = spec?.subspecs;
    const allSubNames: string[] = (subspecs && Array.isArray(subspecs))
      ? subspecs.map((s: any) => s.name || s)
      : [];

    if (selectedSubspecs && selectedSubspecs.length > 0) {
      // 用户指定了要编译的 subspecs
      const hasDefaultSubspecs = Boolean(spec.default_subspecs);
      // 没有 default_subspecs 时，主 pod 才等价于引入全部 subspecs。
      const isAllSelected = allSubNames.length > 0 &&
        selectedSubspecs.length >= allSubNames.length &&
        allSubNames.every((n: string) => selectedSubspecs.includes(n));

      if (isAllSelected && !hasDefaultSubspecs) {
        podLines = `  pod '${podName}', '${version}'\n`;
        logger.info('用户选择了全部 subspecs，使用主 pod', { podName });
      } else {
        for (const subName of selectedSubspecs) {
          podLines += `  pod '${podName}/${subName}', '${version}'\n`;
        }
        logger.info('引入用户选择的 subspecs', { podName, subspecs: selectedSubspecs });
      }
    } else if (subspecs && Array.isArray(subspecs) && subspecs.length > 0) {
      const defaultSubs = spec.default_subspecs;
      if (!defaultSubs) {
        podLines = `  pod '${podName}', '${version}'\n`;
        logger.info('直接引入主 pod（全部 subspecs）', { podName });
      } else {
        for (const subName of allSubNames) {
          podLines += `  pod '${podName}/${subName}', '${version}'\n`;
        }
        logger.info('未指定 subspecs，显式引入全部 subspecs', { podName, subspecs: allSubNames });
      }
    } else {
      podLines = `  pod '${podName}', '${version}'\n`;
    }

    const podDslPatch = `# 平台临时编译工程需要使用 CocoaPods 原生 pod DSL，避免全局 podx/nn_binary 插件改写 pod(...) 后影响官方组件解析。
module NNPlatformPlainPodDSL
  def pod(name = nil, *requirements)
    raise StandardError, 'A dependency requires a name.' unless name
    current_target_definition.store_pod(name, *requirements)
  end
end
Pod::Podfile::DSL.prepend(NNPlatformPlainPodDSL)
`;

    const podfile = `${sources}
${podDslPatch}
${useFrameworks}platform :ios, '${minDeployTarget}'

target '${targetName}_Example' do
${podLines}end

post_install do |installer|
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |config|
      current = config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
      if current && current.to_f < ${minDeployTarget}
        config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${minDeployTarget}'
      end
      # 禁用 explicit modules，兼容老库（如 SVGAPlayer 的 Protobuf 生成代码）
      config.build_settings['CLANG_ENABLE_EXPLICIT_MODULES'] = 'NO'
      # 抑制老代码的编译错误
      config.build_settings['GCC_TREAT_INCOMPATIBLE_POINTER_TYPE_WARNINGS_AS_ERRORS'] = 'NO'
      existing = config.build_settings['OTHER_CFLAGS'] || '$(inherited)'
      config.build_settings['OTHER_CFLAGS'] = existing + ' -Wno-error -Wno-incompatible-function-pointer-types -Wno-deprecated-non-prototype'
    end
  end
end
`;
    fs.writeFileSync(path.join(projectDir, 'Podfile'), podfile, 'utf-8');

    logger.info('工程脚手架生成完成（静态模板）', {
      projectDir,
      targetName,
      podName,
      version,
    });
  }

  /**
   * 基于原始官方 podspec 生成二进制版本的 podspec
   * 保留 dependencies、swift_versions、frameworks、libraries、xcconfig 等完整信息
   * 从 default_subspecs 对应的 subspec 中合并配置（如 GRDB.swift 的 standard subspec）
   */
  private generateBinaryPodspec(
    spec: any,
    name: string,
    version: string,
    outputType: 'framework' | 'static_library',
    artifactName: string,
    sha256: string,
    depVersionOverrides?: Record<string, string>,
    selectedSubspecs?: string[],
    prepareCommand?: string
  ): string {
    const internalUrl = `${NEXUS_BASE_URL}/${name}/${version}.zip`;
    const platform = spec.platforms?.ios || '12.0';
    const summary = spec.summary || `${name} iOS SDK`;
    const homepage = spec.homepage || `https://cocoapods.org/pods/${name}`;
    const authors = typeof spec.authors === 'object' ? Object.keys(spec.authors).join(', ') : (spec.authors || name);
    const licenseType = spec.license?.type || spec.license || 'MIT';

    // 合并 default subspec 的配置到顶层
    // 例如 GRDB.swift 的 default_subspecs 是 "standard"，需要把 standard 的 frameworks/libraries/xcconfig/dependencies 合并
    let mergedSpec = { ...spec };
    if (spec.subspecs && Array.isArray(spec.subspecs) && spec.subspecs.length > 0) {
      // 优先用用户选择的 subspecs；未选择时合并全部，与编译阶段的语义一致。
      const defaultSubNames = selectedSubspecs && selectedSubspecs.length > 0
        ? selectedSubspecs
        : spec.subspecs.map((s: any) => s.name);

      for (const subName of defaultSubNames) {
        const sub = spec.subspecs.find((s: any) => s.name === subName);
        if (sub) {
          logger.info('合并 default subspec 配置', { subName, keys: Object.keys(sub) });
          // 合并 frameworks
          if (sub.frameworks) {
            const existing = mergedSpec.frameworks ? (Array.isArray(mergedSpec.frameworks) ? mergedSpec.frameworks : [mergedSpec.frameworks]) : [];
            const subFw = Array.isArray(sub.frameworks) ? sub.frameworks : [sub.frameworks];
            mergedSpec.frameworks = [...existing, ...subFw];
          }
          // 合并 libraries
          if (sub.libraries) {
            const existing = mergedSpec.libraries ? (Array.isArray(mergedSpec.libraries) ? mergedSpec.libraries : [mergedSpec.libraries]) : [];
            const subLibs = Array.isArray(sub.libraries) ? sub.libraries : [sub.libraries];
            mergedSpec.libraries = [...existing, ...subLibs];
          }
          // 合并 dependencies（过滤掉自身 subspec 的内部依赖，如 SVGAPlayer/ProtoFiles）
          if (sub.dependencies) {
            const filteredDeps: Record<string, any> = {};
            for (const [depName, depVer] of Object.entries(sub.dependencies)) {
              if (!depName.startsWith(`${name}/`)) {
                filteredDeps[depName] = depVer;
              }
            }
            mergedSpec.dependencies = { ...(mergedSpec.dependencies || {}), ...filteredDeps };
          }
          // 合并 xcconfig / pod_target_xcconfig
          if (sub.xcconfig) {
            mergedSpec.pod_target_xcconfig = { ...(mergedSpec.pod_target_xcconfig || {}), ...sub.xcconfig };
          }
          if (sub.pod_target_xcconfig) {
            mergedSpec.pod_target_xcconfig = { ...(mergedSpec.pod_target_xcconfig || {}), ...sub.pod_target_xcconfig };
          }
          if (sub.user_target_xcconfig) {
            mergedSpec.user_target_xcconfig = { ...(mergedSpec.user_target_xcconfig || {}), ...sub.user_target_xcconfig };
          }
          // 合并 compiler_flags
          if (sub.compiler_flags) {
            mergedSpec.compiler_flags = mergedSpec.compiler_flags
              ? `${mergedSpec.compiler_flags} ${sub.compiler_flags}`
              : sub.compiler_flags;
          }
          // 合并 weak_frameworks
          if (sub.weak_frameworks) {
            const existing = mergedSpec.weak_frameworks ? (Array.isArray(mergedSpec.weak_frameworks) ? mergedSpec.weak_frameworks : [mergedSpec.weak_frameworks]) : [];
            const subWf = Array.isArray(sub.weak_frameworks) ? sub.weak_frameworks : [sub.weak_frameworks];
            mergedSpec.weak_frameworks = [...existing, ...subWf];
          }
        }
      }
    }

    let podspec = `Pod::Spec.new do |s|
  s.name         = '${name}'
  s.version      = '${version}'
  s.summary      = '${summary}'
  s.homepage     = '${homepage}'
  s.license      = { :type => '${licenseType}' }
  s.authors      = '${authors}'
  s.source       = { :http => '${internalUrl}', :sha256 => '${sha256}' }
  s.platform     = :ios, '${platform}'
`;

    // 编译产物
    if (outputType === 'static_library') {
      const aName = artifactName || `lib${name}.a`;
      const baseName = aName.replace(/^lib/, '').replace(/\.a$/, '');
      podspec += `  s.vendored_libraries   = '${aName}'\n`;
      podspec += `  s.public_header_files  = '${baseName}.Headers/**/*.h'\n`;
      podspec += `  s.source_files         = '${baseName}.Headers/**/*.h'\n`;
    } else {
      const fwName = artifactName || `${name}.framework`;
      podspec += `  s.vendored_frameworks = '${fwName}'\n`;
    }

    // swift_versions
    if (mergedSpec.swift_versions) {
      const sv = Array.isArray(mergedSpec.swift_versions) ? mergedSpec.swift_versions : [mergedSpec.swift_versions];
      podspec += `  s.swift_versions      = [${sv.map((v: string) => `'${v}'`).join(', ')}]\n`;
    } else if (mergedSpec.swift_version) {
      podspec += `  s.swift_version       = '${mergedSpec.swift_version}'\n`;
    }

    // frameworks（合并顶层和 ios 平台的）
    const allFrameworks: string[] = [];
    if (mergedSpec.frameworks) {
      const fw = Array.isArray(mergedSpec.frameworks) ? mergedSpec.frameworks : [mergedSpec.frameworks];
      allFrameworks.push(...fw);
    }
    if (mergedSpec.ios?.frameworks) {
      const fw = Array.isArray(mergedSpec.ios.frameworks) ? mergedSpec.ios.frameworks : [mergedSpec.ios.frameworks];
      allFrameworks.push(...fw);
    }
    if (allFrameworks.length > 0) {
      podspec += `  s.frameworks          = ${[...new Set(allFrameworks)].map((f: string) => `'${f}'`).join(', ')}\n`;
    }

    // weak_frameworks
    if (mergedSpec.weak_frameworks && mergedSpec.weak_frameworks.length > 0) {
      const wf = Array.isArray(mergedSpec.weak_frameworks) ? mergedSpec.weak_frameworks : [mergedSpec.weak_frameworks];
      podspec += `  s.weak_frameworks     = ${[...new Set(wf as string[])].map((f: string) => `'${f}'`).join(', ')}\n`;
    }

    // libraries
    const allLibraries: string[] = [];
    if (mergedSpec.libraries) {
      const libs = Array.isArray(mergedSpec.libraries) ? mergedSpec.libraries : [mergedSpec.libraries];
      allLibraries.push(...libs);
    }
    if (mergedSpec.ios?.libraries) {
      const libs = Array.isArray(mergedSpec.ios.libraries) ? mergedSpec.ios.libraries : [mergedSpec.ios.libraries];
      allLibraries.push(...libs);
    }
    if (allLibraries.length > 0) {
      podspec += `  s.libraries           = ${[...new Set(allLibraries)].map((l: string) => `'${l}'`).join(', ')}\n`;
    }

    // requires_arc
    if (mergedSpec.requires_arc === false) {
      podspec += `  s.requires_arc        = false\n`;
    }

    // compiler_flags
    if (mergedSpec.compiler_flags) {
      const flags = Array.isArray(mergedSpec.compiler_flags) ? mergedSpec.compiler_flags.join(' ') : mergedSpec.compiler_flags;
      podspec += `  s.compiler_flags      = '${flags}'\n`;
    }

    // pod_target_xcconfig（包含从 subspec 合并的 xcconfig）
    if (mergedSpec.pod_target_xcconfig && Object.keys(mergedSpec.pod_target_xcconfig).length > 0) {
      const entries = Object.entries(mergedSpec.pod_target_xcconfig)
        .map(([k, v]) => `'${k}' => '${v}'`).join(', ');
      podspec += `  s.pod_target_xcconfig = { ${entries} }\n`;
    }

    // user_target_xcconfig
    if (mergedSpec.user_target_xcconfig && Object.keys(mergedSpec.user_target_xcconfig).length > 0) {
      const entries = Object.entries(mergedSpec.user_target_xcconfig)
        .map(([k, v]) => `'${k}' => '${v}'`).join(', ');
      podspec += `  s.user_target_xcconfig = { ${entries} }\n`;
    }

    // dependencies（包含从 subspec 合并的依赖）
    // depVersionOverrides 仅用于临时 Podfile 编译解析；生成内部 podspec 时保留官方依赖约束，
    // 避免把 `~> 1.0`、`> 1.0` 这类兼容范围收窄成某个内部已发布版本。
    if (mergedSpec.dependencies && Object.keys(mergedSpec.dependencies).length > 0) {
      for (const [depName, depVersions] of Object.entries(mergedSpec.dependencies)) {
        const versions = Array.isArray(depVersions) ? depVersions : [];
        if (versions.length > 0) {
          podspec += `  s.dependency '${depName}', ${(versions as string[]).map((v: string) => `'${v}'`).join(', ')}\n`;
        } else {
          const override = depVersionOverrides?.[depName];
          if (override) {
            podspec += `  s.dependency '${depName}', '${override}'\n`;
          } else {
            podspec += `  s.dependency '${depName}'\n`;
          }
        }
      }
    }

    // resource_bundles
    if (mergedSpec.resource_bundles) {
      for (const [bundleName, patterns] of Object.entries(mergedSpec.resource_bundles)) {
        const p = Array.isArray(patterns) ? patterns : [patterns];
        podspec += `  s.resource_bundles    = { '${bundleName}' => [${(p as string[]).map((f: string) => `'${f}'`).join(', ')}] }\n`;
      }
    }

    // resources
    if (mergedSpec.resources) {
      const res = Array.isArray(mergedSpec.resources) ? mergedSpec.resources : [mergedSpec.resources];
      podspec += `  s.resources           = ${res.map((r: string) => `'${r}'`).join(', ')}\n`;
    }

    // 为原始 subspecs 创建空的别名 subspec
    // 这样依赖 SDWebImage/Core 的库在 pod install 时能找到对应的 subspec
    // 所有 subspec 都指向同一个二进制产物（已经包含了所有代码）
    if (spec.subspecs && Array.isArray(spec.subspecs) && spec.subspecs.length > 0) {
      const subsToAlias = selectedSubspecs && selectedSubspecs.length > 0
        ? selectedSubspecs
        : spec.subspecs.map((s: any) => s.name);

      // 设置 default_subspecs 避免引入所有 subspec
      if (spec.default_subspecs) {
        const ds = Array.isArray(spec.default_subspecs) ? spec.default_subspecs : [spec.default_subspecs];
        podspec += `  s.default_subspecs   = [${ds.map((d: string) => `'${d}'`).join(', ')}]\n`;
      }

      // 确定 vendored 声明（subspec 里需要重复声明，不会继承顶层）
      const vendoredLine = outputType === 'static_library'
        ? `    ss.vendored_libraries  = '${artifactName || `lib${name}.a`}'\n`
        : `    ss.vendored_frameworks = '${artifactName || `${name}.framework`}'\n`;

      for (const subName of subsToAlias) {
        podspec += `\n  s.subspec '${subName}' do |ss|\n`;
        podspec += vendoredLine;
        podspec += `  end\n`;
      }
    }

    // 注入自定义 prepare_command
    if (prepareCommand) {
      podspec += `\n  s.prepare_command = <<-CMD\n${prepareCommand}\n  CMD\n`;
    }

    podspec += `end\n`;
    return podspec;
  }

  /**
   * 基于官方 podspec JSON 生成内部 podspec，保留原始路径，只替换 source 为内部 Nexus
   */
  private generateOfficialPodspec(spec: any, name: string, version: string, sha256: string, prepareCommand?: string): string {
    const internalUrl = `${NEXUS_BASE_URL}/${name}/${version}.zip`;
    const platform = spec.platforms?.ios || '12.0';
    const summary = spec.summary || `${name} iOS SDK`;
    const homepage = spec.homepage || `https://cocoapods.org/pods/${name}`;
    const authors = typeof spec.authors === 'object' ? Object.keys(spec.authors).join(', ') : (spec.authors || name);
    const licenseType = spec.license?.type || spec.license || 'MIT';

    // 对 git 源，zip 内会有一层目录包裹，需要加前缀
    const isGitSource = !!spec.source?.git;
    const pathPrefix = isGitSource ? `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}/` : '';
    const prefixPath = (p: string) => isGitSource ? `${pathPrefix}${p}` : p;

    let podspec = `Pod::Spec.new do |s|
  s.name         = '${name}'
  s.version      = '${version}'
  s.summary      = '${summary}'
  s.homepage     = '${homepage}'
  s.license      = { :type => '${licenseType}' }
  s.authors      = '${authors}'
  s.source       = { :http => '${internalUrl}', :sha256 => '${sha256}' }
  s.platform     = :ios, '${platform}'
`;

    // 收集所有字段（包括 subspecs 中的）合并到顶层
    const allVendoredFrameworks: string[] = [];
    const allVendoredLibraries: string[] = [];
    const allSourceFiles: string[] = [];
    const allPublicHeaders: string[] = [];
    const allResources: string[] = [];

    // 顶层字段
    const collectFields = (obj: any) => {
      if (obj.vendored_frameworks) {
        const vf = Array.isArray(obj.vendored_frameworks) ? obj.vendored_frameworks : [obj.vendored_frameworks];
        allVendoredFrameworks.push(...vf);
      }
      if (obj.vendored_libraries) {
        const vl = Array.isArray(obj.vendored_libraries) ? obj.vendored_libraries : [obj.vendored_libraries];
        allVendoredLibraries.push(...vl);
      }
      if (obj.source_files) {
        const sf = Array.isArray(obj.source_files) ? obj.source_files : [obj.source_files];
        allSourceFiles.push(...sf);
      }
      if (obj.public_header_files) {
        const ph = Array.isArray(obj.public_header_files) ? obj.public_header_files : [obj.public_header_files];
        allPublicHeaders.push(...ph);
      }
      if (obj.resources) {
        const res = Array.isArray(obj.resources) ? obj.resources : [obj.resources];
        allResources.push(...res);
      }
    };

    collectFields(spec);
    // 从 subspecs 中收集
    if (spec.subspecs && Array.isArray(spec.subspecs)) {
      for (const sub of spec.subspecs) {
        collectFields(sub);
      }
    }

    if (allVendoredFrameworks.length > 0) {
      podspec += `  s.vendored_frameworks = ${allVendoredFrameworks.map(f => `'${prefixPath(f)}'`).join(', ')}\n`;
    }
    if (allVendoredLibraries.length > 0) {
      podspec += `  s.vendored_libraries  = ${allVendoredLibraries.map(l => `'${prefixPath(l)}'`).join(', ')}\n`;
    }
    if (allSourceFiles.length > 0) {
      podspec += `  s.source_files        = ${allSourceFiles.map(f => `'${prefixPath(f)}'`).join(', ')}\n`;
    }
    if (allPublicHeaders.length > 0) {
      podspec += `  s.public_header_files = ${allPublicHeaders.map(f => `'${prefixPath(f)}'`).join(', ')}\n`;
    }
    if (allResources.length > 0) {
      podspec += `  s.resources           = ${allResources.map(r => `'${prefixPath(r)}'`).join(', ')}\n`;
    }

    // resource_bundles
    if (spec.resource_bundles) {
      for (const [bundleName, patterns] of Object.entries(spec.resource_bundles)) {
        const p = Array.isArray(patterns) ? patterns : [patterns];
        podspec += `  s.resource_bundles    = { '${bundleName}' => [${(p as string[]).map((f: string) => `'${prefixPath(f)}'`).join(', ')}] }\n`;
      }
    }

    // frameworks
    if (spec.frameworks) {
      const fw = Array.isArray(spec.frameworks) ? spec.frameworks : [spec.frameworks];
      podspec += `  s.frameworks          = ${fw.map((f: string) => `'${f}'`).join(', ')}\n`;
    }

    // weak_frameworks
    if (spec.weak_frameworks) {
      const wf = Array.isArray(spec.weak_frameworks) ? spec.weak_frameworks : [spec.weak_frameworks];
      podspec += `  s.weak_frameworks     = ${wf.map((f: string) => `'${f}'`).join(', ')}\n`;
    }

    // libraries
    if (spec.libraries) {
      const libs = Array.isArray(spec.libraries) ? spec.libraries : [spec.libraries];
      podspec += `  s.libraries           = ${libs.map((l: string) => `'${l}'`).join(', ')}\n`;
    }

    // requires_arc
    if (spec.requires_arc === false) {
      podspec += `  s.requires_arc        = false\n`;
    }

    // pod_target_xcconfig
    if (spec.pod_target_xcconfig) {
      const entries = Object.entries(spec.pod_target_xcconfig)
        .map(([k, v]) => `'${k}' => '${v}'`).join(', ');
      podspec += `  s.pod_target_xcconfig = { ${entries} }\n`;
    }

    // user_target_xcconfig
    if (spec.user_target_xcconfig) {
      const entries = Object.entries(spec.user_target_xcconfig)
        .map(([k, v]) => `'${k}' => '${v}'`).join(', ');
      podspec += `  s.user_target_xcconfig = { ${entries} }\n`;
    }

    // dependencies
    if (spec.dependencies) {
      for (const [depName, depVersions] of Object.entries(spec.dependencies)) {
        const versions = Array.isArray(depVersions) ? depVersions : [];
        if (versions.length > 0) {
          podspec += `  s.dependency '${depName}', ${(versions as string[]).map((v: string) => `'${v}'`).join(', ')}\n`;
        } else {
          podspec += `  s.dependency '${depName}'\n`;
        }
      }
    }

    // 注入自定义 prepare_command
    if (prepareCommand) {
      podspec += `\n  s.prepare_command = <<-CMD\n${prepareCommand}\n  CMD\n`;
    }

    podspec += `end\n`;
    return podspec;
  }
}

export default new PodService();
