import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

/**
 * 清理服务 - 定期清理临时文件和缓存
 */
export class CleanupService {
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly uploadDir: string;
  private readonly maxAge: number; // 文件最大保留时间（毫秒）

  constructor() {
    this.uploadDir = process.env.UPLOAD_DIR || '../../dSYMTool-data/uploads';
    // 默认保留 24 小时
    const maxAgeHours = parseInt(process.env.CLEANUP_MAX_AGE_HOURS || '24', 10);
    this.maxAge = maxAgeHours * 60 * 60 * 1000;
  }

  /**
   * 启动定期清理任务
   */
  start() {
    // 默认每小时执行一次清理
    const intervalHours = parseInt(process.env.CLEANUP_INTERVAL_HOURS || '1', 10);
    const intervalMs = intervalHours * 60 * 60 * 1000;

    logger.info('启动定期清理服务', {
      interval: `${intervalHours} 小时`,
      maxAge: `${this.maxAge / (60 * 60 * 1000)} 小时`,
      uploadDir: this.uploadDir,
    });

    // 立即执行一次清理
    this.cleanup();

    // 设置定期清理
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, intervalMs);
  }

  /**
   * 停止清理任务
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.info('停止定期清理服务');
    }
  }

  /**
   * 执行清理
   */
  private async cleanup() {
    try {
      logger.info('开始清理临时文件');

      const stats = {
        scanned: 0,
        deleted: 0,
        errors: 0,
        freedSpace: 0,
      };

      // 清理上传目录
      await this.cleanupDirectory(this.uploadDir, stats);

      logger.info('清理完成', stats);
    } catch (error: any) {
      logger.error('清理失败', { error: error.message });
    }
  }

  /**
   * 清理指定目录
   */
  private async cleanupDirectory(
    dirPath: string,
    stats: { scanned: number; deleted: number; errors: number; freedSpace: number }
  ) {
    try {
      // 检查目录是否存在
      if (!fs.existsSync(dirPath)) {
        return;
      }

      const files = fs.readdirSync(dirPath);
      const now = Date.now();

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        stats.scanned++;

        try {
          const stat = fs.statSync(filePath);

          // 如果是目录，递归清理
          if (stat.isDirectory()) {
            await this.cleanupDirectory(filePath, stats);

            // 检查目录是否为空，如果为空则删除
            const remainingFiles = fs.readdirSync(filePath);
            if (remainingFiles.length === 0) {
              fs.rmdirSync(filePath);
              stats.deleted++;
              logger.debug('删除空目录', { path: filePath });
            }
            continue;
          }

          // 检查文件年龄
          const fileAge = now - stat.mtimeMs;
          if (fileAge > this.maxAge) {
            const fileSize = stat.size;
            fs.unlinkSync(filePath);
            stats.deleted++;
            stats.freedSpace += fileSize;
            logger.debug('删除过期文件', {
              path: filePath,
              age: `${(fileAge / (60 * 60 * 1000)).toFixed(2)} 小时`,
              size: `${(fileSize / 1024 / 1024).toFixed(2)} MB`,
            });
          }
        } catch (error: any) {
          stats.errors++;
          logger.warn('清理文件失败', { path: filePath, error: error.message });
        }
      }
    } catch (error: any) {
      logger.error('清理目录失败', { path: dirPath, error: error.message });
    }
  }

  /**
   * 手动触发清理
   */
  async manualCleanup(): Promise<{
    success: boolean;
    stats?: {
      scanned: number;
      deleted: number;
      errors: number;
      freedSpace: number;
    };
    error?: string;
  }> {
    try {
      logger.info('手动触发清理');

      const stats = {
        scanned: 0,
        deleted: 0,
        errors: 0,
        freedSpace: 0,
      };

      await this.cleanupDirectory(this.uploadDir, stats);

      return {
        success: true,
        stats,
      };
    } catch (error: any) {
      logger.error('手动清理失败', { error: error.message });
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 获取临时文件统计信息
   */
  async getStats(): Promise<{
    totalFiles: number;
    totalSize: number;
    oldFiles: number;
    oldFilesSize: number;
  }> {
    const stats = {
      totalFiles: 0,
      totalSize: 0,
      oldFiles: 0,
      oldFilesSize: 0,
    };

    try {
      await this.collectStats(this.uploadDir, stats);
    } catch (error: any) {
      logger.error('获取统计信息失败', { error: error.message });
    }

    return stats;
  }

  /**
   * 收集统计信息
   */
  private async collectStats(
    dirPath: string,
    stats: {
      totalFiles: number;
      totalSize: number;
      oldFiles: number;
      oldFilesSize: number;
    }
  ) {
    try {
      if (!fs.existsSync(dirPath)) {
        return;
      }

      const files = fs.readdirSync(dirPath);
      const now = Date.now();

      for (const file of files) {
        const filePath = path.join(dirPath, file);

        try {
          const stat = fs.statSync(filePath);

          if (stat.isDirectory()) {
            await this.collectStats(filePath, stats);
            continue;
          }

          stats.totalFiles++;
          stats.totalSize += stat.size;

          const fileAge = now - stat.mtimeMs;
          if (fileAge > this.maxAge) {
            stats.oldFiles++;
            stats.oldFilesSize += stat.size;
          }
        } catch (error) {
          // 忽略单个文件的错误
        }
      }
    } catch (error) {
      // 忽略目录错误
    }
  }
}

export default new CleanupService();
