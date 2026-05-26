import { Router, Request, Response } from 'express';
import weChatWorkService from '../services/WeChatWorkService';
import historyService from '../services/HistoryService';
import { AppError, ErrorCode } from '../types';
import logger from '../utils/logger';

const router = Router();

/**
 * POST /api/wechat/share
 * 分享崩溃报告到企业微信
 */
router.post('/share', async (req: Request, res: Response) => {
  try {
    const { historyId, toUser, toParty, assignee, messageType } = req.body;

    if (!historyId) {
      throw new AppError(ErrorCode.INVALID_CRASH_LOG, '未提供历史记录 ID', 400);
    }

    // 检查企业微信配置
    if (!weChatWorkService.isConfigured()) {
      throw new AppError(
        ErrorCode.INVALID_CRASH_LOG,
        '企业微信未配置，请联系管理员配置 WECHAT_WORK_CORP_ID、WECHAT_WORK_AGENT_ID 和 WECHAT_WORK_SECRET',
        400
      );
    }

    // 获取历史记录
    const record = historyService.getHistoryById(historyId);
    if (!record) {
      throw new AppError(ErrorCode.INVALID_CRASH_LOG, '历史记录不存在', 404);
    }

    // 构建详情 URL
    const baseUrl = process.env.BASE_URL || 'http://localhost:5173';
    const detailUrl = `${baseUrl}/history?id=${historyId}`;

    // 提取严重程度
    const severity = record.aiAnalysis?.severity || 'medium';

    // 构建消息内容
    const reportMessage = {
      appVersion: record.appVersion,
      crashType: record.crashType || '未知',
      crashLocation: record.crashLocation,
      crashModule: record.crashModule,
      severity,
      assignee,
      detailUrl,
      createdAt: record.createdAt,
    };

    // 根据消息类型发送
    if (messageType === 'markdown') {
      await weChatWorkService.sendMarkdownMessage(reportMessage, toUser, toParty);
    } else {
      await weChatWorkService.sendCrashReportCard(reportMessage, toUser, toParty);
    }

    logger.info('崩溃报告已分享到企业微信', {
      historyId,
      toUser,
      toParty,
      assignee,
    });

    res.json({
      success: true,
      message: '分享成功',
    });
  } catch (error: any) {
    logger.error('分享到企业微信失败', { error: error.message });

    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message || '分享失败',
      });
    }
  }
});

/**
 * GET /api/wechat/config
 * 检查企业微信配置状态
 */
router.get('/config', async (req: Request, res: Response) => {
  try {
    const isConfigured = weChatWorkService.isConfigured();

    res.json({
      success: true,
      data: {
        configured: isConfigured,
      },
    });
  } catch (error: any) {
    logger.error('检查企业微信配置失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: '检查配置失败',
    });
  }
});

/**
 * POST /api/wechat/test
 * 测试企业微信消息发送
 */
router.post('/test', async (req: Request, res: Response) => {
  try {
    const { toUser } = req.body;

    if (!weChatWorkService.isConfigured()) {
      throw new AppError(
        ErrorCode.INVALID_CRASH_LOG,
        '企业微信未配置',
        400
      );
    }

    await weChatWorkService.sendTextMessage(
      '🎉 企业微信集成测试成功！\n\niOS 崩溃符号化系统已成功连接到企业微信。',
      toUser
    );

    res.json({
      success: true,
      message: '测试消息发送成功',
    });
  } catch (error: any) {
    logger.error('测试企业微信消息失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '测试失败',
    });
  }
});

export default router;
