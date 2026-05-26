import { Router, Request, Response } from 'express';
import cleanupService from '../services/CleanupService';
import logger from '../utils/logger';

const router = Router();

/**
 * GET /api/cleanup/stats
 * 获取临时文件统计信息
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await cleanupService.getStats();

    res.json({
      success: true,
      data: {
        totalFiles: stats.totalFiles,
        totalSize: stats.totalSize,
        totalSizeMB: (stats.totalSize / 1024 / 1024).toFixed(2),
        oldFiles: stats.oldFiles,
        oldFilesSize: stats.oldFilesSize,
        oldFilesSizeMB: (stats.oldFilesSize / 1024 / 1024).toFixed(2),
      },
    });
  } catch (error: any) {
    logger.error('获取清理统计失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: '获取统计信息失败',
    });
  }
});

/**
 * POST /api/cleanup/manual
 * 手动触发清理
 */
router.post('/manual', async (req: Request, res: Response) => {
  try {
    logger.info('收到手动清理请求', { ip: req.ip });

    const result = await cleanupService.manualCleanup();

    if (result.success) {
      res.json({
        success: true,
        message: '清理完成',
        data: {
          scanned: result.stats?.scanned,
          deleted: result.stats?.deleted,
          errors: result.stats?.errors,
          freedSpace: result.stats?.freedSpace,
          freedSpaceMB: ((result.stats?.freedSpace || 0) / 1024 / 1024).toFixed(2),
        },
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || '清理失败',
      });
    }
  } catch (error: any) {
    logger.error('手动清理失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: '清理失败',
    });
  }
});

export default router;
