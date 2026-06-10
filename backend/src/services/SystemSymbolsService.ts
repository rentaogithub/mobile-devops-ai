import fs from 'fs';
import path from 'path';
import os from 'os';
import { IncomingMessage } from 'http';
import AdmZip from 'adm-zip';
import logger from '../utils/logger';

export interface SystemSymbolInfo {
  binaryName: string;
  dsymPath: string;
  iosVersion: string;
}

export class SystemSymbolsService {
  private xcodeSymbolsPath: string;
  private enabled: boolean | null = null;
  private symbolCache: Map<string, string> = new Map();
  private autoUpdateTasks: Map<string, Promise<boolean>> = new Map();

  constructor() {
    const defaultPath = path.join(
      os.homedir(),
      'Library/Developer/Xcode/iOS DeviceSupport'
    );
    this.xcodeSymbolsPath = process.env.XCODE_SYMBOLS_PATH
      ? process.env.XCODE_SYMBOLS_PATH.replace('~', os.homedir())
      : defaultPath;

    // 延迟初始化 enabled 状态
    this.initializeEnabled();
  }

  private initializeEnabled() {
    // 确保在运行时读取环境变量
    const envValue = process.env.ENABLE_SYSTEM_SYMBOLICATION;
    this.enabled = envValue === 'true';

    logger.info('SystemSymbolsService 初始化', {
      enabled: this.enabled,
      envValue,
      xcodeSymbolsPath: this.xcodeSymbolsPath,
      pathExists: fs.existsSync(this.xcodeSymbolsPath),
    });

    if (this.enabled) {
      logger.info('系统符号化已启用', { xcodeSymbolsPath: this.xcodeSymbolsPath });
    } else {
      logger.warn('系统符号化未启用', {
        envValue,
        expected: 'true',
      });
    }
  }

  /**
   * 检查系统符号化是否启用
   */
  isEnabled(): boolean {
    if (this.enabled === null) {
      this.initializeEnabled();
    }
    return this.enabled === true && fs.existsSync(this.xcodeSymbolsPath);
  }

  /**
   * 查找系统库的 dSYM
   */
  async findSystemDSYM(binaryName: string, iosVersion?: string): Promise<string | null> {
    if (!this.isEnabled()) {
      return null;
    }

    // 检查缓存
    const cacheKey = `${binaryName}_${iosVersion || 'any'}`;
    if (this.symbolCache.has(cacheKey)) {
      return this.symbolCache.get(cacheKey)!;
    }

    try {
      // 如果指定了 iOS 版本，优先查找该版本
      if (iosVersion) {
        const dsymPath = await this.searchInVersion(binaryName, iosVersion);
        if (dsymPath) {
          this.symbolCache.set(cacheKey, dsymPath);
          return dsymPath;
        }

        const updated = await this.ensureSymbolsForVersion(iosVersion);
        if (updated) {
          const updatedDSYMPath = await this.searchInVersion(binaryName, iosVersion);
          if (updatedDSYMPath) {
            this.symbolCache.set(cacheKey, updatedDSYMPath);
            return updatedDSYMPath;
          }
        }
      }

      // 搜索所有版本
      const dsymPath = await this.searchAllVersions(binaryName);
      if (dsymPath) {
        this.symbolCache.set(cacheKey, dsymPath);
      }
      return dsymPath;
    } catch (error) {
      logger.error('查找系统符号失败', { binaryName, error });
      return null;
    }
  }

  /**
   * 在特定 iOS 版本中搜索
   */
  private async searchInVersion(binaryName: string, iosVersion: string): Promise<string | null> {
    // iOS 版本目录格式: 15.0, 15.0 (19A346), iPhone12,1 26.2 (23C55)
    const versionDirs = fs
      .readdirSync(this.xcodeSymbolsPath)
      .filter((dir) => this.isMatchingVersionDirectory(dir, iosVersion));

    for (const versionDir of versionDirs) {
      const symbolsPath = path.join(this.xcodeSymbolsPath, versionDir, 'Symbols');
      if (!fs.existsSync(symbolsPath)) {
        continue;
      }

      const dsymPath = this.searchInDirectory(symbolsPath, binaryName);
      if (dsymPath) {
        logger.info('找到系统符号', { binaryName, iosVersion: versionDir, dsymPath });
        return dsymPath;
      }
    }

    return null;
  }

  private isMatchingVersionDirectory(directoryName: string, iosVersion: string): boolean {
    const escapedVersion = iosVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${escapedVersion}(\\s|\\(|$)`).test(directoryName);
  }

  private async ensureSymbolsForVersion(iosVersion: string): Promise<boolean> {
    if (!this.isAutoUpdateEnabled()) {
      return false;
    }

    const versionKey = this.normalizeVersionKey(iosVersion);
    const existingTask = this.autoUpdateTasks.get(versionKey);
    if (existingTask) {
      return existingTask;
    }

    const task = this.autoUpdateSymbolsForVersion(iosVersion)
      .catch((error) => {
        logger.warn('自动更新 iOS 系统符号失败', { iosVersion, error: error.message });
        return false;
      })
      .finally(() => {
        this.autoUpdateTasks.delete(versionKey);
      });

    this.autoUpdateTasks.set(versionKey, task);
    return task;
  }

  private isAutoUpdateEnabled(): boolean {
    return process.env.AUTO_UPDATE_SYSTEM_SYMBOLS !== 'false';
  }

  private normalizeVersionKey(iosVersion: string): string {
    return iosVersion.trim().replace(/\s+/g, ' ');
  }

  private async autoUpdateSymbolsForVersion(iosVersion: string): Promise<boolean> {
    const importDir = this.expandHome(process.env.IOS_DEVICE_SUPPORT_IMPORT_DIR || '');
    if (importDir) {
      const imported = await this.importSymbolsFromLocalDirectory(importDir, iosVersion);
      if (imported) {
        return true;
      }
    }

    const urls = this.buildDownloadURLs(iosVersion);
    for (const url of urls) {
      const imported = await this.downloadAndImportSymbols(url, iosVersion);
      if (imported) {
        return true;
      }
    }

    logger.warn('没有可用的系统符号自动更新来源', {
      iosVersion,
      importDir: importDir || undefined,
      urlCount: urls.length,
      hint:
        '可配置 IOS_DEVICE_SUPPORT_IMPORT_DIR、IOS_DEVICE_SUPPORT_URLS 或 IOS_DEVICE_SUPPORT_URL_TEMPLATE',
    });
    return false;
  }

  private buildDownloadURLs(iosVersion: string): string[] {
    const explicitURLs = (process.env.IOS_DEVICE_SUPPORT_URLS || '')
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean);

    const template = process.env.IOS_DEVICE_SUPPORT_URL_TEMPLATE;
    const urls = [...explicitURLs];
    if (template) {
      urls.push(this.renderURLTemplate(template, iosVersion));
    }

    return [...new Set(urls)];
  }

  private renderURLTemplate(template: string, iosVersion: string): string {
    const version = iosVersion.match(/([\d.]+)/)?.[1] || iosVersion;
    const build = iosVersion.match(/\(([^)]+)\)/)?.[1] || '';
    const versionDir = iosVersion;
    const replacements: Record<string, string> = {
      version,
      build,
      versionDir,
      encodedVersion: encodeURIComponent(version),
      encodedBuild: encodeURIComponent(build),
      encodedVersionDir: encodeURIComponent(versionDir),
    };

    return template.replace(/\{(\w+)\}/g, (_match, key) => replacements[key] || '');
  }

  private async importSymbolsFromLocalDirectory(importDir: string, iosVersion: string): Promise<boolean> {
    if (!fs.existsSync(importDir)) {
      logger.warn('系统符号导入目录不存在', { importDir, iosVersion });
      return false;
    }

    const entries = fs.readdirSync(importDir).map((name) => path.join(importDir, name));
    const matchingEntries = entries.filter((entry) => this.isCandidateSymbolPackage(entry, iosVersion));

    for (const entry of matchingEntries) {
      const imported = this.importSymbolPackage(entry, iosVersion);
      if (imported) {
        logger.info('已从本地目录导入 iOS 系统符号', { iosVersion, entry });
        return true;
      }
    }

    logger.warn('本地导入目录未找到匹配的 iOS 系统符号包', { importDir, iosVersion });
    return false;
  }

  private isCandidateSymbolPackage(entryPath: string, iosVersion: string): boolean {
    const name = path.basename(entryPath);
    const version = iosVersion.match(/([\d.]+)/)?.[1] || iosVersion;
    const build = iosVersion.match(/\(([^)]+)\)/)?.[1] || '';

    return name.includes(version) || (!!build && name.includes(build));
  }

  private async downloadAndImportSymbols(url: string, iosVersion: string): Promise<boolean> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-device-support-'));
    const outputPath = path.join(tempDir, 'symbols.zip');

    try {
      logger.info('开始下载 iOS 系统符号', { iosVersion, url });
      await this.downloadFile(url, outputPath);
      const imported = this.importSymbolPackage(outputPath, iosVersion);
      if (imported) {
        logger.info('iOS 系统符号下载并导入完成', { iosVersion, url });
      }
      return imported;
    } catch (error: any) {
      logger.warn('下载 iOS 系统符号失败', { iosVersion, url, error: error.message });
      return false;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async downloadFile(url: string, outputPath: string): Promise<void> {
    const protocol = await import(url.startsWith('https:') ? 'https' : 'http');

    await new Promise<void>((resolve, reject) => {
      const request = protocol.get(url, (response: IncomingMessage) => {
        const statusCode = response.statusCode || 0;
        const location = response.headers.location;
        if (statusCode >= 300 && statusCode < 400 && location) {
          response.resume();
          this.downloadFile(new URL(location, url).toString(), outputPath).then(resolve, reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error(`HTTP ${statusCode}`));
          return;
        }

        const fileStream = fs.createWriteStream(outputPath);
        response.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(() => resolve()));
        fileStream.on('error', reject);
      });

      request.on('error', reject);
      request.setTimeout(10 * 60 * 1000, () => {
        request.destroy(new Error('下载系统符号超时'));
      });
    });
  }

  private importSymbolPackage(packagePath: string, iosVersion: string): boolean {
    const stat = fs.statSync(packagePath);
    if (stat.isDirectory()) {
      return this.copySymbolDirectory(packagePath, iosVersion);
    }

    if (!packagePath.endsWith('.zip')) {
      logger.warn('不支持的系统符号包格式', { packagePath, iosVersion });
      return false;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-device-support-unzip-'));
    try {
      const zip = new AdmZip(packagePath);
      zip.extractAllTo(tempDir, true);
      return this.copySymbolDirectory(tempDir, iosVersion);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private copySymbolDirectory(sourceDir: string, iosVersion: string): boolean {
    const symbolDirs = this.findSymbolDirectories(sourceDir, iosVersion);
    for (const symbolDir of symbolDirs) {
      const sourceVersionDir = path.dirname(symbolDir);
      const targetVersionDir = path.join(this.xcodeSymbolsPath, path.basename(sourceVersionDir));
      fs.mkdirSync(this.xcodeSymbolsPath, { recursive: true });
      fs.cpSync(sourceVersionDir, targetVersionDir, { recursive: true, force: true });
      logger.info('已安装 iOS DeviceSupport 系统符号', {
        iosVersion,
        sourceVersionDir,
        targetVersionDir,
      });
      return true;
    }

    logger.warn('系统符号包中未找到匹配的 Symbols 目录', { sourceDir, iosVersion });
    return false;
  }

  private findSymbolDirectories(rootDir: string, iosVersion: string): string[] {
    const result: string[] = [];
    const stack = [rootDir];

    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const fullPath = path.join(current, entry.name);
        if (entry.name === 'Symbols' && this.isMatchingVersionDirectory(path.basename(current), iosVersion)) {
          result.push(fullPath);
          continue;
        }

        stack.push(fullPath);
      }
    }

    return result;
  }

  private expandHome(value: string): string {
    if (!value) {
      return value;
    }
    return value.replace(/^~(?=$|\/)/, os.homedir());
  }

  /**
   * 搜索所有版本（从新到旧）
   */
  private async searchAllVersions(binaryName: string): Promise<string | null> {
    if (!fs.existsSync(this.xcodeSymbolsPath)) {
      logger.warn('系统符号路径不存在', { path: this.xcodeSymbolsPath });
      return null;
    }

    const versionDirs = fs
      .readdirSync(this.xcodeSymbolsPath)
      .filter((dir) => {
        try {
          const stat = fs.statSync(path.join(this.xcodeSymbolsPath, dir));
          return stat.isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse(); // 从新版本开始搜索

    logger.info(`搜索系统符号`, { binaryName, totalDirs: versionDirs.length });

    for (const versionDir of versionDirs) {
      const symbolsPath = path.join(this.xcodeSymbolsPath, versionDir, 'Symbols');
      if (!fs.existsSync(symbolsPath)) {
        continue;
      }

      const dsymPath = this.searchInDirectory(symbolsPath, binaryName);
      if (dsymPath) {
        logger.info('找到系统符号', { binaryName, iosVersion: versionDir, dsymPath });
        return dsymPath;
      }
    }

    logger.warn('未在任何版本中找到系统符号', { binaryName, searchedDirs: versionDirs.length });
    return null;
  }

  /**
   * 在目录中搜索二进制文件
   */
  private searchInDirectory(dir: string, binaryName: string): string | null {
    // 常见的系统库路径
    const commonPaths = [
      path.join(dir, 'System', 'Library', 'Frameworks', `${binaryName}.framework`, binaryName),
      path.join(
        dir,
        'System',
        'Library',
        'PrivateFrameworks',
        `${binaryName}.framework`,
        binaryName
      ),
      path.join(dir, 'usr', 'lib', binaryName),
      path.join(dir, 'usr', 'lib', `${binaryName}.dylib`),
      path.join(dir, 'usr', 'lib', 'system', binaryName),
      path.join(dir, 'usr', 'lib', 'system', `${binaryName}.dylib`),
    ];

    for (const filePath of commonPaths) {
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }

    return null;
  }

  /**
   * 从崩溃日志中提取 iOS 版本
   */
  extractIOSVersion(crashLog: string): string | undefined {
    // OS Version: iPhone OS 15.0 (19A346)
    const match = crashLog.match(/OS Version:\s+iPhone OS\s+([\d.]+)(?:\s+\(([^)]+)\))?/i);
    if (match) {
      return match[2] ? `${match[1]} (${match[2]})` : match[1];
    }

    // OS Version: iOS 26.2 (23C55)
    const iosMatch = crashLog.match(/OS Version:\s+iOS\s+([\d.]+)(?:\s+\(([^)]+)\))?/i);
    if (iosMatch) {
      return iosMatch[2] ? `${iosMatch[1]} (${iosMatch[2]})` : iosMatch[1];
    }

    // iOS Version: 15.0
    const match2 = crashLog.match(/iOS Version:\s+([\d.]+)/i);
    if (match2) {
      return match2[1];
    }

    return undefined;
  }

  /**
   * 获取系统库列表
   */
  getSystemLibraries(): string[] {
    return [
      'Foundation',
      'UIKit',
      'UIKitCore',
      'CoreFoundation',
      'GraphicsServices',
      'libobjc.A.dylib',
      'libsystem_kernel.dylib',
      'libsystem_pthread.dylib',
      'libdispatch.dylib',
      'dyld',
      'CoreGraphics',
      'ImageIO',
      'QuartzCore',
      'CoreAnimation',
      'AVFoundation',
      'CoreMedia',
      'CoreVideo',
      'Metal',
      'MetalKit',
    ];
  }

  /**
   * 判断是否是系统库
   */
  isSystemLibrary(binaryName: string): boolean {
    const systemLibs = this.getSystemLibraries();
    return systemLibs.some(
      (lib) => binaryName === lib || binaryName.startsWith(lib) || lib.includes(binaryName)
    );
  }
}
