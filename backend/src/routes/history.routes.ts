import { Router, Request, Response } from 'express';
import historyService from '../services/HistoryService';
import reportGenerator from '../services/ReportGeneratorService';
import { adminMiddleware, requireAnyRole } from '../middleware/auth';
import logger from '../utils/logger';

const router = Router();
const crashAnalysisMiddleware = requireAnyRole(['tester', 'developer', 'admin']);

/**
 * GET /api/history/list
 * 获取所有历史记录（按版本分组）
 */
router.get('/list', async (req: Request, res: Response) => {
  try {
    const grouped = historyService.getAllHistoryGroupedByVersion();

    res.json({
      success: true,
      data: grouped,
    });
  } catch (error: any) {
    logger.error('获取历史记录失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: '获取历史记录失败',
    });
  }
});

/**
 * GET /api/history/version/:version
 * 根据主应用版本获取历史记录
 */
router.get('/version/:version', async (req: Request, res: Response) => {
  try {
    const { version } = req.params;
    const records = historyService.getHistoryByVersion(version);

    res.json({
      success: true,
      data: records,
    });
  } catch (error: any) {
    logger.error('获取历史记录失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: '获取历史记录失败',
    });
  }
});

/**
 * GET /api/history/:id
 * 根据 ID 获取历史记录详情
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const record = historyService.getHistoryById(parseInt(id));

    res.json({
      success: true,
      data: record,
    });
  } catch (error: any) {
    logger.error('获取历史记录失败', { error: error.message });
    res.status(404).json({
      success: false,
      error: '历史记录不存在',
    });
  }
});

/**
 * GET /api/history/statistics
 * 获取历史记录统计
 */
router.get('/stats/summary', async (req: Request, res: Response) => {
  try {
    const stats = historyService.getStatistics();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: any) {
    logger.error('获取统计信息失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: '获取统计信息失败',
    });
  }
});

/**
 * DELETE /api/history/:id
 * 删除历史记录（需要管理员权限）
 */
router.delete('/:id', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    historyService.deleteHistory(parseInt(id));

    res.json({
      success: true,
    });
  } catch (error: any) {
    logger.error('删除历史记录失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: '删除历史记录失败',
    });
  }
});

/**
 * DELETE /api/history/clear/all
 * 清空所有历史记录（需要管理员权限）
 */
router.delete('/clear/all', adminMiddleware, async (req: Request, res: Response) => {
  try {
    historyService.clearAllHistory();

    res.json({
      success: true,
    });
  } catch (error: any) {
    logger.error('清空历史记录失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: '清空历史记录失败',
    });
  }
});

/**
 * POST /api/history/:id/analyze
 * 对历史记录进行AI分析
 */
router.post('/:id/analyze', crashAnalysisMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { apiKey } = req.body;

    const analysis = await historyService.analyzeHistory(parseInt(id), apiKey || '');

    res.json({
      success: true,
      data: analysis,
    });
  } catch (error: any) {
    logger.error('AI分析失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || 'AI分析失败',
    });
  }
});

/**
 * GET /api/history/:id/download
 * 下载历史记录报告（ZIP格式，包含符号化日志和AI分析PDF）
 */
router.get('/:id/download', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const record = historyService.getHistoryById(parseInt(id));

    if (!record) {
      return res.status(404).json({
        success: false,
        error: '历史记录不存在',
      });
    }

    logger.info('生成下载报告', { 
      id: record.id,
      appVersion: record.appVersion,
      hasAIAnalysis: !!record.aiAnalysis
    });

    // 生成ZIP文件
    const zipBuffer = await reportGenerator.generateReportZip({
      symbolicatedLog: record.symbolicatedLog,
      originalLog: record.originalLog,
      analysis: record.aiAnalysis,
      appVersion: record.appVersion,
    });

    // 设置响应头
    const fileName = `crash_report_${record.appVersion}_${Date.now()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', zipBuffer.length);

    // 发送文件
    res.send(zipBuffer);

    logger.info('报告下载成功', { 
      id: record.id,
      fileName,
      size: zipBuffer.length
    });
  } catch (error: any) {
    logger.error('生成下载报告失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: '生成报告失败',
    });
  }
});

/**
 * PATCH /api/history/:id/fixed
 * 更新历史记录的修复状态
 */
router.patch('/:id/fixed', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { isFixed, fixedVersion, fixedRemark } = req.body;

    if (typeof isFixed !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'isFixed 必须是布尔值',
      });
    }

    if (isFixed && !fixedVersion) {
      return res.status(400).json({
        success: false,
        error: '标记为已修复时必须提供修复版本号',
      });
    }

    if (fixedRemark !== undefined && typeof fixedRemark !== 'string') {
      return res.status(400).json({
        success: false,
        error: '修复备注必须是字符串',
      });
    }

    if (String(fixedRemark || '').trim().length > 500) {
      return res.status(400).json({
        success: false,
        error: '修复备注不能超过 500 个字符',
      });
    }

    historyService.updateFixedStatus(parseInt(id, 10), isFixed, fixedVersion, fixedRemark);

    res.json({
      success: true,
      message: '修复状态已更新',
    });
  } catch (error: any) {
    logger.error('更新修复状态失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: '更新修复状态失败',
    });
  }
});

export default router;
