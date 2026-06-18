
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AppError, ErrorCode } from '../types';

const execAsync = promisify(exec);

export class FileHandlerService {
  private uploadDir: string;
  private dsymDir: string;
  private maxFileSize: number;

  constructor() {
    this.uploadDir = process.env.UPLOAD_DIR || '../../nn-ios-platform-data/uploads';
    this.dsymDir = process.env.DSYM_DIR || '../../nn-ios-platform-data/dsyms';
    this.maxFileSize = parseInt(process.env.MAX_FILE_SIZE || '524288000'); // 500MB

    // 确保目录存在
    this.ensureDirectories();
  }

  /**
   * 确保必要的目录存在
   */
  private ensureDirectories(): void {
    [this.uploadDir, this.dsymDir].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * 处理上传的文件
   */
  async processUploadedFile(file: Express.Multer.File): Promise<string> {
    // 验证文件大小
    if (file.size > this.maxFileSize) {
      throw new AppError(
        ErrorCode.FILE_TOO_LARGE,
        `文件大小超过限制 (${this.maxFileSize / 1024 / 1024}MB)`,
        413
      );
    }

    // 验证文件格式
    const isValid = await this.validateFileFormat(file);
    if (!isValid) {
      throw new AppError(
        ErrorCode.INVALID_FILE_FORMAT,
        '不支持的文件格式，请上传 .dSYM、.xcarchive 或 .zip 文件',
        400
      );
    }

    // 创建临时文件路径
    const tempPath = path.join(this.uploadDir, `temp_${Date.now()}_${file.originalname}`);

    // 移动文件到临时目录
    fs.renameSync(file.path, tempPath);

    return tempPath;
  }

  /**
   * 验证文件格式
   */
  async validateFileFormat(file: Express.Multer.File): Promise<boolean> {
    const filename = file.originalname.toLowerCase();

    // 检查文件扩展名
    if (filename.endsWith('.zip')) {
      return true;
    }

    if (filename.endsWith('.xcarchive')) {
      return true;
    }

    if (filename.endsWith('.tgz') || filename.endsWith('.tar.gz')) {
      return true;
    }

    // 检查是否是 dSYM 目录（通常会被压缩上传）
    if (filename.includes('.dsym')) {
      return true;
    }

    // 检查 MIME 类型
    const validMimeTypes = [
      'application/zip',
      'application/x-zip-compressed',
      'application/gzip',
      'application/x-gzip',
      'application/x-tar',
      'application/x-compressed-tar',
      'application/octet-stream',
    ];

    return validMimeTypes.includes(file.mimetype);
  }

  /**
   * 验证 dSYM 文件
   */
  async validateDSYM(dsymPath: string): Promise<boolean> {
    // 检查路径是否存在
    if (!fs.existsSync(dsymPath)) {
      return false;
    }

    // 检查是否是目录
    const stats = fs.statSync(dsymPath);
    if (!stats.isDirectory()) {
      return false;
    }

    // 检查是否包含 dSYM 结构
    // dSYM 目录结构: xxx.app.dSYM/Contents/Resources/DWARF/xxx
    const contentsPath = path.join(dsymPath, 'Contents');
    const resourcesPath = path.join(contentsPath, 'Resources');
    const dwarfPath = path.join(resourcesPath, 'DWARF');

    return (
      fs.existsSync(contentsPath) && fs.existsSync(resourcesPath) && fs.existsSync(dwarfPath)
    );
  }

  /**
   * 清理临时文件
   */
  async cleanupTempFile(filePath: string): Promise<void> {
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
      }
    } catch (error) {
      console.error(`Failed to cleanup temp file: ${filePath}`, error);
    }
  }

  /**
   * 清理上传过程产生的压缩包和解压目录。永久存储里的 dSYM 不会被删除。
   */
  async cleanupUploadArtifacts(tempPath?: string, extractedDsymPath?: string, permanentPath?: string): Promise<void> {
    const cleanupTargets = new Set<string>();

    if (tempPath && tempPath !== permanentPath) {
      cleanupTargets.add(tempPath);
    }

    const extractionRoot = extractedDsymPath ? this.findExtractionRoot(extractedDsymPath) : null;
    if (extractionRoot && extractionRoot !== permanentPath) {
      cleanupTargets.add(extractionRoot);
    }

    for (const target of cleanupTargets) {
      // 避免误删永久 dSYM 或其父目录
      if (permanentPath && (target === permanentPath || permanentPath.startsWith(`${target}${path.sep}`))) {
        continue;
      }
      await this.cleanupTempFile(target);
    }
  }

  private findExtractionRoot(filePath: string): string | null {
    let current = path.resolve(filePath);
    const uploadRoot = path.resolve(this.uploadDir);

    while (current.startsWith(uploadRoot)) {
      if (path.basename(current).startsWith('extracted_')) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return null;
  }

  /**
   * 移动 dSYM 到永久存储
   */
  async moveToPermanentStorage(dsymPath: string, uuid: string): Promise<string> {
    const targetDir = path.join(this.dsymDir, uuid);
    const dsymName = path.basename(dsymPath);
    const targetPath = path.join(targetDir, dsymName);

    // 如果目标路径已存在，先删除
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }

    // 确保目标目录存在
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // 移动文件
    fs.renameSync(dsymPath, targetPath);

    return targetPath;
  }

  /**
   * 获取文件大小
   */
  getFileSize(filePath: string): number {
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      return this.getDirectorySize(filePath);
    }
    return stats.size;
  }

  /**
   * 递归计算目录大小
   */
  private getDirectorySize(dirPath: string): number {
    let totalSize = 0;

    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);

      if (stats.isDirectory()) {
        totalSize += this.getDirectorySize(filePath);
      } else {
        totalSize += stats.size;
      }
    }

    return totalSize;
  }

  /**
   * 解压 zip 文件
   */
  async extractZip(zipPath: string): Promise<string> {
    try {
      const zip = new AdmZip(zipPath);
      const extractDir = path.join(this.uploadDir, `extracted_${Date.now()}`);

      // 创建解压目录
      if (!fs.existsSync(extractDir)) {
        fs.mkdirSync(extractDir, { recursive: true });
      }

      // 解压文件
      zip.extractAllTo(extractDir, true);

      // 查找 dSYM 文件
      const dsymPath = await this.findDSYMInDirectory(extractDir);
      if (!dsymPath) {
        throw new AppError(
          ErrorCode.INVALID_FILE_FORMAT,
          'ZIP 文件中未找到有效的 dSYM 文件。请确保 ZIP 包含 .dSYM 目录或 .xcarchive 文件',
          400
        );
      }

      return dsymPath;
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        ErrorCode.INVALID_FILE_FORMAT, 
        `解压 ZIP 文件失败: ${error.message}`, 
        400
      );
    }
  }

  /**
   * 解压 tar.gz 文件
   */
  async extractTarGz(tarPath: string): Promise<string> {
    try {
      const extractDir = path.join(this.uploadDir, `extracted_${Date.now()}`);

      // 创建解压目录
      if (!fs.existsSync(extractDir)) {
        fs.mkdirSync(extractDir, { recursive: true });
      }

      // 解压文件
      await tar.x({
        file: tarPath,
        cwd: extractDir,
      });

      // 查找 dSYM 文件
      const dsymPath = await this.findDSYMInDirectory(extractDir);
      if (!dsymPath) {
        throw new AppError(
          ErrorCode.INVALID_FILE_FORMAT,
          'TAR.GZ 文件中未找到有效的 dSYM 文件。请确保压缩包包含 .dSYM 目录或 .xcarchive 文件',
          400
        );
      }

      return dsymPath;
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        ErrorCode.INVALID_FILE_FORMAT, 
        `解压 TAR.GZ 文件失败: ${error.message}`, 
        400
      );
    }
  }

  /**
   * 从 xcarchive 中提取 dSYM
   */
  async extractFromXCArchive(archivePath: string): Promise<string[]> {
    // xcarchive 结构: xxx.xcarchive/dSYMs/xxx.app.dSYM
    const dsymsDir = path.join(archivePath, 'dSYMs');

    if (!fs.existsSync(dsymsDir)) {
      throw new AppError(
        ErrorCode.INVALID_FILE_FORMAT,
        'xcarchive 文件结构不正确，未找到 dSYMs 目录。请确保上传的是完整的 .xcarchive 文件',
        400
      );
    }

    const appDsyms: string[] = [];
    const frameworkDsyms: string[] = [];
    const files = fs.readdirSync(dsymsDir);

    for (const file of files) {
      if (file.endsWith('.dSYM')) {
        const dsymPath = path.join(dsymsDir, file);
        const isValid = await this.validateDSYM(dsymPath);
        if (isValid) {
          // 优先选择主应用的 dSYM（.app.dSYM）
          if (file.endsWith('.app.dSYM')) {
            appDsyms.push(dsymPath);
          } else {
            frameworkDsyms.push(dsymPath);
          }
        }
      }
    }

    // 优先返回主应用的 dSYM，然后是框架的 dSYM
    const dsymPaths = [...appDsyms, ...frameworkDsyms];

    if (dsymPaths.length === 0) {
      const fileList = files.join(', ');
      throw new AppError(
        ErrorCode.INVALID_FILE_FORMAT,
        `xcarchive 的 dSYMs 目录中未找到有效的 dSYM 文件。找到的文件: ${fileList || '(空)'}`,
        400
      );
    }

    return dsymPaths;
  }

  /**
   * 在目录中查找 dSYM 文件
   */
  async findDSYMInDirectory(dirPath: string): Promise<string | null> {
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      // 跳过 macOS 资源分叉目录和隐藏文件
      if (file === '__MACOSX' || file.startsWith('.')) {
        continue;
      }

      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);

      if (stats.isDirectory()) {
        // 检查是否是 dSYM 目录
        if (file.endsWith('.dSYM')) {
          const isValid = await this.validateDSYM(filePath);
          if (isValid) {
            return filePath;
          }
        }

        // 检查是否是 xcarchive
        if (file.endsWith('.xcarchive')) {
          const dsyms = await this.extractFromXCArchive(filePath);
          return dsyms[0]; // 返回第一个找到的 dSYM
        }

        // 递归搜索子目录
        const found = await this.findDSYMInDirectory(filePath);
        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  /**
   * 识别并处理 dSYM 文件
   */
  async identifyAndExtractDSYM(filePath: string): Promise<string> {
    const stats = fs.statSync(filePath);
    const fileName = path.basename(filePath);

    // 如果是目录
    if (stats.isDirectory()) {
      // 检查是否是 dSYM 目录
      if (filePath.endsWith('.dSYM')) {
        const isValid = await this.validateDSYM(filePath);
        if (isValid) {
          return filePath;
        }
        throw new AppError(
          ErrorCode.INVALID_FILE_FORMAT, 
          'dSYM 目录结构不完整，缺少必要的 Contents/Resources/DWARF 目录', 
          400
        );
      }

      // 检查是否是 xcarchive（使用原始文件名检查扩展名）
      if (fileName.endsWith('.xcarchive')) {
        const dsyms = await this.extractFromXCArchive(filePath);
        return dsyms[0];
      }

      // 在目录中查找 dSYM
      const found = await this.findDSYMInDirectory(filePath);
      if (found) {
        return found;
      }

      throw new AppError(
        ErrorCode.INVALID_FILE_FORMAT, 
        `目录 "${fileName}" 中未找到有效的 dSYM 文件。请确保上传的是 .dSYM 目录或 .xcarchive 文件`, 
        400
      );
    }

    // 如果是文件，检查是否是 zip 或 tar.gz（使用原始文件名检查扩展名）
    if (fileName.endsWith('.zip')) {
      return await this.extractZip(filePath);
    }

    if (fileName.endsWith('.tgz') || fileName.endsWith('.tar.gz')) {
      return await this.extractTarGz(filePath);
    }

    throw new AppError(
      ErrorCode.INVALID_FILE_FORMAT, 
      `不支持的文件格式 "${fileName}"。请上传 .zip、.tgz、.tar.gz 或 .xcarchive 文件`, 
      400
    );
  }

  /**
   * 提取 UUID
   */
  async extractUUID(dsymPath: string): Promise<string> {
    try {
      // 找到 DWARF 文件
      const dwarfPath = this.findDWARFFile(dsymPath);
      if (!dwarfPath) {
        console.error('未找到 DWARF 文件', { dsymPath });
        throw new AppError(ErrorCode.UUID_NOT_FOUND, '未找到 DWARF 文件', 400);
      }

      console.log('提取 UUID', { dsymPath, dwarfPath });

      // 使用 dwarfdump 命令提取 UUID
      const { stdout, stderr } = await execAsync(`dwarfdump --uuid "${dwarfPath}"`);

      console.log('dwarfdump 输出', { stdout: stdout.substring(0, 200), stderr });

      // 解析输出
      // 输出格式: UUID: XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX (arm64) /path/to/binary
      const uuidMatch = stdout.match(/UUID:\s+([A-F0-9-]+)/i);
      if (!uuidMatch) {
        console.error('无法从输出中提取 UUID', { stdout: stdout.substring(0, 500) });
        throw new AppError(ErrorCode.UUID_NOT_FOUND, '无法从 dSYM 文件中提取 UUID', 400);
      }

      console.log('成功提取 UUID', { uuid: uuidMatch[1] });
      return uuidMatch[1];
    } catch (error: any) {
      console.error('提取 UUID 失败', { error: error.message, stack: error.stack });
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(ErrorCode.UUID_NOT_FOUND, `提取 UUID 失败: ${error.message}`, 400);
    }
  }

  /**
   * 提取应用信息（名称、版本、架构）
   */
  async extractAppInfo(
    dsymPath: string
  ): Promise<{ appName: string; version: string; architecture: string; buildNumber?: string }> {
    try {
      // 找到 DWARF 文件
      const dwarfPath = this.findDWARFFile(dsymPath);
      if (!dwarfPath) {
        throw new AppError(
          ErrorCode.INVALID_FILE_FORMAT, 
          'dSYM 文件结构不完整，未找到 DWARF 调试符号文件', 
          400
        );
      }

      // 使用 dwarfdump 命令提取信息
      const { stdout } = await execAsync(`dwarfdump --uuid "${dwarfPath}"`);

      // 解析架构
      const archMatch = stdout.match(/\(([^)]+)\)/);
      const architecture = archMatch ? archMatch[1] : 'unknown';

      // 从路径中提取应用名称
      const dsymName = path.basename(dsymPath);
      const appName = dsymName
        .replace('.framework.dSYM', '')
        .replace('.app.dSYM', '')
        .replace('.dSYM', '');

      // 尝试从 Info.plist 中提取版本信息
      let version = '1.0.0';
      let buildNumber: string | undefined;

      const infoPlistPath = path.join(dsymPath, 'Contents', 'Info.plist');
      if (fs.existsSync(infoPlistPath)) {
        try {
          const { stdout: plistOutput } = await execAsync(
            `plutil -convert json -o - "${infoPlistPath}"`
          );
          const plistData = JSON.parse(plistOutput);
          version = plistData.CFBundleShortVersionString || plistData.CFBundleVersion || '1.0.0';
          buildNumber = plistData.CFBundleVersion;
        } catch (error) {
          // Info.plist 读取失败，使用默认值
          console.warn('无法读取 Info.plist，使用默认版本号', error);
        }
      } else {
        // 第三方库可能没有 Info.plist，尝试从二进制文件中提取版本
        console.warn('未找到 Info.plist，尝试从二进制文件提取版本号');
        
        // 针对 NNRtc 等特定库，尝试从 DWARF 文件中提取版本字符串
        if (appName.toLowerCase().includes('nnrtc') || appName.toLowerCase().includes('rtc')) {
          try {
            const extractedVersion = await this.extractVersionFromBinary(dwarfPath, appName);
            if (extractedVersion) {
              version = extractedVersion;
              console.log('从二进制文件提取到版本号', { appName, version });
            }
          } catch (error) {
            console.warn('从二进制文件提取版本失败', error);
          }
        }
      }

      return {
        appName,
        version,
        architecture,
        buildNumber,
      };
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        ErrorCode.INVALID_FILE_FORMAT, 
        `提取应用信息失败: ${error.message}`, 
        400
      );
    }
  }

  /**
   * 从二进制文件中提取版本信息
   * 尝试多种方法提取版本号
   */
  private async extractVersionFromBinary(binaryPath: string, appName: string): Promise<string | null> {
    try {
      // 方法1: 使用 strings 命令查找版本字符串
      // 常见的版本字符串模式: "1.0.0", "Version: 1.0.0", "v1.0.0" 等
      const { stdout } = await execAsync(`strings "${binaryPath}" | grep -E "^[0-9]+\\.[0-9]+\\.[0-9]+" | head -5`);
      
      if (stdout.trim()) {
        const lines = stdout.trim().split('\n');
        
        // 优先查找符合语义化版本的字符串 (x.y.z)
        for (const line of lines) {
          const versionMatch = line.match(/^(\d+\.\d+\.\d+)/);
          if (versionMatch) {
            const version = versionMatch[1];
            // 验证版本号是否合理（不是太大的数字）
            const parts = version.split('.').map(Number);
            if (parts.every(n => n < 1000)) {
              return version;
            }
          }
        }
      }

      // 方法2: 尝试使用 otool 查找版本信息
      try {
        const { stdout: otoolOutput } = await execAsync(`otool -L "${binaryPath}" | grep -i version`);
        if (otoolOutput.trim()) {
          const versionMatch = otoolOutput.match(/(\d+\.\d+\.\d+)/);
          if (versionMatch) {
            return versionMatch[1];
          }
        }
      } catch (error) {
        // otool 可能失败，继续尝试其他方法
      }

      // 方法3: 针对 NNRtc，尝试查找特定的版本标识
      if (appName.toLowerCase().includes('nnrtc')) {
        try {
          const { stdout: nnrtcVersion } = await execAsync(
            `strings "${binaryPath}" | grep -i "nnrtc" | grep -E "[0-9]+\\.[0-9]+" | head -3`
          );
          if (nnrtcVersion.trim()) {
            const lines = nnrtcVersion.trim().split('\n');
            for (const line of lines) {
              const versionMatch = line.match(/(\d+\.\d+(?:\.\d+)?)/);
              if (versionMatch) {
                return versionMatch[1];
              }
            }
          }
        } catch (error) {
          // 继续
        }
      }

      return null;
    } catch (error) {
      console.error('从二进制提取版本失败', error);
      return null;
    }
  }

  /**
   * 查找 DWARF 文件
   */
  private findDWARFFile(dsymPath: string): string | null {
    // 标准 dSYM 目录结构
    const dwarfDir = path.join(dsymPath, 'Contents', 'Resources', 'DWARF');
    
    console.log('查找 DWARF 文件', { dsymPath, dwarfDir });
    
    if (fs.existsSync(dwarfDir)) {
      const files = fs.readdirSync(dwarfDir);
      console.log('DWARF 目录内容', { dwarfDir, files });
      
      if (files.length > 0) {
        // 过滤掉 macOS 资源分叉文件（以 ._ 开头）和隐藏文件（以 . 开头）
        const validFiles = files.filter((file) => !file.startsWith('.'));

        if (validFiles.length > 0) {
          const dwarfPath = path.join(dwarfDir, validFiles[0]);
          console.log('找到 DWARF 文件', { dwarfPath });
          return dwarfPath;
        }
        
        console.warn('DWARF 目录中只有隐藏文件', { dwarfDir, files });
      }
    } else {
      console.warn('标准 DWARF 目录不存在', { dwarfDir });
      
      // 尝试递归查找 DWARF 目录
      try {
        const findDwarfRecursive = (dir: string, depth: number = 0): string | null => {
          if (depth > 5) return null; // 限制递归深度
          
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue; // 跳过隐藏文件
            
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory()) {
              // 检查是否是 DWARF 目录
              if (entry.name === 'DWARF') {
                const files = fs.readdirSync(fullPath);
                const validFiles = files.filter((file) => !file.startsWith('.'));
                if (validFiles.length > 0) {
                  const dwarfPath = path.join(fullPath, validFiles[0]);
                  console.log('递归找到 DWARF 文件', { dwarfPath });
                  return dwarfPath;
                }
              }
              
              // 递归查找子目录
              const found = findDwarfRecursive(fullPath, depth + 1);
              if (found) return found;
            }
          }
          
          return null;
        };
        
        const found = findDwarfRecursive(dsymPath);
        if (found) return found;
      } catch (error) {
        console.error('递归查找 DWARF 文件失败', { error });
      }
    }

    console.error('未找到 DWARF 文件', { dsymPath });
    return null;
  }
}
