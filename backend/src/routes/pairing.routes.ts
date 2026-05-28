import { Router, Request, Response } from 'express';
import pairingService from '../services/PairingService';
import logger from '../utils/logger';

const router = Router();

/**
 * POST /api/pairing/create
 * 浏览器创建配对会话，返回 pairingId 和 token 用于生成二维码
 */
router.post('/create', (req: Request, res: Response) => {
  try {
    const { pairingId, token } = pairingService.createSession();

    logger.info(`[Pairing] 浏览器创建配对会话: pairingId=${pairingId}`);

    res.json({
      success: true,
      data: { pairingId, token },
    });
  } catch (error: any) {
    logger.error(`[Pairing] 创建会话失败: ${error.message}`);
    res.status(500).json({ success: false, error: '创建配对会话失败' });
  }
});

/**
 * POST /api/pairing/confirm
 * App 扫码后调用，提交 deviceLogUrl 和设备信息
 *
 * Body:
 * - pairingId: string
 * - token: string
 * - deviceLogUrl: string (例如 http://10.1.107.116:8989)
 * - deviceInfo?: { name, model, systemVersion, ip }
 */
router.post('/confirm', (req: Request, res: Response) => {
  try {
    const { pairingId, token, deviceLogUrl, deviceInfo } = req.body;

    if (!pairingId || !token || !deviceLogUrl) {
      logger.warn(`[Pairing] App 扫码确认缺少参数: pairingId=${pairingId}, deviceLogUrl=${deviceLogUrl}`);
      res.status(400).json({
        success: false,
        error: '缺少必要参数: pairingId, token, deviceLogUrl',
      });
      return;
    }

    // 验证 deviceLogUrl 格式
    try {
      new URL(deviceLogUrl);
    } catch {
      logger.warn(`[Pairing] App 提交的 deviceLogUrl 格式无效: ${deviceLogUrl}`);
      res.status(400).json({
        success: false,
        error: 'deviceLogUrl 格式无效，需要完整的 URL（如 http://10.1.107.116:8989）',
      });
      return;
    }

    logger.info(`[Pairing] App 扫码确认配对: pairingId=${pairingId}, deviceLogUrl=${deviceLogUrl}, deviceInfo=${JSON.stringify(deviceInfo || {})}`);

    const result = pairingService.confirmPairing(pairingId, token, deviceLogUrl, deviceInfo);

    if (result.success) {
      logger.info(`[Pairing] 配对成功: pairingId=${pairingId}`);
      res.json({ success: true, message: '配对成功' });
    } else {
      logger.warn(`[Pairing] 配对失败: pairingId=${pairingId}, reason=${result.error}`);
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (error: any) {
    logger.error(`[Pairing] 确认配对失败: ${error.message}`);
    res.status(500).json({ success: false, error: '确认配对失败' });
  }
});

/**
 * GET /api/pairing/status/:pairingId
 * 浏览器轮询配对状态
 *
 * 返回:
 * - status: 'waiting' | 'paired' | 'expired'
 * - deviceLogUrl?: string (配对成功后返回)
 * - deviceInfo?: object (配对成功后返回)
 */
router.get('/status/:pairingId', (req: Request, res: Response) => {
  try {
    const { pairingId } = req.params;
    const result = pairingService.getSessionStatus(pairingId);

    if (!result) {
      logger.warn(`[Pairing] 轮询状态: 会话不存在 pairingId=${pairingId}`);
      res.status(404).json({
        success: false,
        error: '配对会话不存在或已过期',
      });
      return;
    }

    if (result.status === 'paired') {
      logger.info(`[Pairing] 轮询状态: 已配对 pairingId=${pairingId}, deviceLogUrl=${result.deviceLogUrl}`);
    }

    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error(`[Pairing] 查询状态失败: ${error.message}`);
    res.status(500).json({ success: false, error: '查询配对状态失败' });
  }
});

/**
 * DELETE /api/pairing/:pairingId
 * 删除配对会话（浏览器关闭页面时调用）
 */
router.delete('/:pairingId', (req: Request, res: Response) => {
  try {
    const { pairingId } = req.params;
    logger.info(`[Pairing] 删除配对会话: pairingId=${pairingId}`);
    pairingService.deleteSession(pairingId);
    res.json({ success: true, message: '会话已删除' });
  } catch (error: any) {
    logger.error(`[Pairing] 删除会话失败: ${error.message}`);
    res.status(500).json({ success: false, error: '删除会话失败' });
  }
});

export default router;
