import fs from 'fs';
import path from 'path';
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

  constructor() {
    const defaultPath = path.join(
      require('os').homedir(),
      'Library/Developer/Xcode/iOS DeviceSupport'
    );
    this.xcodeSymbolsPath = process.env.XCODE_SYMBOLS_PATH
      ? process.env.XCODE_SYMBOLS_PATH.replace('~', require('os').homedir())
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
    const match = crashLog.match(/OS Version:\s+iPhone OS\s+([\d.]+)/i);
    if (match) {
      return match[1];
    }

    // OS Version: iOS 26.2 (23C55)
    const iosMatch = crashLog.match(/OS Version:\s+iOS\s+([\d.]+)/i);
    if (iosMatch) {
      return iosMatch[1];
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
      'libobjc.A.dylib',
      'libsystem_kernel.dylib',
      'libsystem_pthread.dylib',
      'libdispatch.dylib',
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
