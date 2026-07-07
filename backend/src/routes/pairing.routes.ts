import { Router, Request, Response } from 'express';
import os from 'os';
import pairingService from '../services/PairingService';
import { browserLogWebSocketService } from '../services/BrowserLogWebSocketService';
import { adminMiddleware } from '../middleware/auth';
import logger from '../utils/logger';

const router = Router();

function localIPv4Addresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  Object.entries(interfaces).forEach(([name, items]) => {
    if (/^(utun|awdl|llw|bridge|vnic)/.test(name)) return;
    items?.forEach((item) => {
      if (item.family !== 'IPv4' || item.internal) return;
      addresses.push(item.address);
    });
  });

  return Array.from(new Set(addresses));
}

function makeWebSocketUrls(req: Request, preferredHost?: string): string[] {
  const configuredWsUrl = process.env.REALTIME_LOG_WS_URL || process.env.BROWSER_LOG_WS_URL;
  if (configuredWsUrl) {
    return [configuredWsUrl];
  }

  const port = process.env.PORT || '3000';
  const wsUrls: string[] = [];
  const normalizedPreferredHost = preferredHost?.split(':')[0];
  if (normalizedPreferredHost && !['127.0.0.1', 'localhost'].includes(normalizedPreferredHost)) {
    wsUrls.push(`ws://${normalizedPreferredHost}:${port}/ws/logs`);
  }

  const requestHost = req.get('host') || '';

  if (requestHost && !requestHost.startsWith('127.0.0.1') && !requestHost.startsWith('localhost')) {
    const hostOnly = requestHost.split(':')[0];
    wsUrls.push(`ws://${hostOnly}:${port}/ws/logs`);
  }

  localIPv4Addresses().forEach((ip) => {
    const url = `ws://${ip}:${port}/ws/logs`;
    if (!wsUrls.includes(url)) {
      wsUrls.push(url);
    }
  });

  return wsUrls;
}

function makeHttpBaseUrl(req: Request): string {
  const host = req.get('host') || `127.0.0.1:${process.env.PORT || '3000'}`;
  const protocol = req.protocol || 'http';
  return `${protocol}://${host}`;
}

function makeLogViewerUrl(req: Request, pairingId: string, token: string, wsUrl: string): string {
  const url = new URL('/logs/view', makeHttpBaseUrl(req));
  url.searchParams.set('pairingId', pairingId);
  url.searchParams.set('token', token);
  url.searchParams.set('wsUrl', wsUrl);
  return url.toString();
}

/**
 * POST /api/pairing/create
 * 浏览器创建配对会话，返回 pairingId 和 token 用于生成二维码
 *
 * 二维码内容包含 wsUrls，App 扫码后通过后端 WebSocket relay 推送日志。
 */
router.post('/create', (req: Request, res: Response) => {
  try {
    const { pairingId, token } = pairingService.createSession();
    const pageHost = typeof req.body?.pageHost === 'string' ? req.body.pageHost : undefined;
    const wsUrls = makeWebSocketUrls(req, pageHost);

    logger.info(`[Pairing] 浏览器创建配对会话: pairingId=${pairingId}, wsUrls=${wsUrls.join(',')}`);

    res.json({
      success: true,
      data: {
        pairingId,
        token,
        wsUrl: wsUrls[0] || '',
        wsUrls,
      },
    });
  } catch (error: any) {
    logger.error(`[Pairing] 创建会话失败: ${error.message}`);
    res.status(500).json({ success: false, error: '创建配对会话失败' });
  }
});

/**
 * GET /api/pairing/status/:pairingId
 * 浏览器轮询配对状态（等待 App 扫码连接 WebSocket）
 */
router.get('/status/:pairingId', (req: Request, res: Response) => {
  try {
    const { pairingId } = req.params;
    const result = pairingService.getSessionStatus(pairingId);
    const session = pairingService.getSession(pairingId);

    if (!result || !session) {
      res.status(404).json({
        success: false,
        error: '配对会话不存在或已过期',
      });
      return;
    }

    if (result.status === 'paired') {
      logger.info(`[Pairing] 轮询状态: 已配对 pairingId=${pairingId}`);
    }

    const wsUrls = makeWebSocketUrls(req);
    const wsUrl = wsUrls[0] || '';
    res.json({
      success: true,
      data: {
        ...result,
        wsUrl,
        wsUrls,
        deviceLogUrl: wsUrl ? makeLogViewerUrl(req, pairingId, session.token, wsUrl) : '',
      },
    });
  } catch (error: any) {
    logger.error(`[Pairing] 查询状态失败: ${error.message}`);
    res.status(500).json({ success: false, error: '查询配对状态失败' });
  }
});

/**
 * GET /api/pairing/devices
 * 查询已配对设备，便于从服务端页面直接进入日志流。
 */
router.get('/devices', (req: Request, res: Response) => {
  try {
    const wsUrls = makeWebSocketUrls(req);
    const wsUrl = wsUrls[0] || '';
    const devices = pairingService.listSessions().map((session) => ({
      pairingId: session.pairingId,
      token: session.token,
      status: session.status,
      deviceInfo: session.deviceInfo,
      wsUrl,
      wsUrls,
      deviceLogUrl: wsUrl ? makeLogViewerUrl(req, session.pairingId, session.token, wsUrl) : '',
      appConnected: browserLogWebSocketService.isAppConnected(session.pairingId),
      recentLogCount: browserLogWebSocketService.getRecentLogCount(session.pairingId),
      createdAt: session.createdAt,
      pairedAt: session.pairedAt,
      lastActiveAt: session.lastActiveAt,
    }));

    res.json({
      success: true,
      data: devices,
    });
  } catch (error: any) {
    logger.error(`[Pairing] 查询设备列表失败: ${error.message}`);
    res.status(500).json({ success: false, error: '查询设备列表失败' });
  }
});

/**
 * DELETE /api/pairing/:pairingId
 * 删除配对会话
 */
router.delete('/:pairingId', adminMiddleware, (req: Request, res: Response) => {
  try {
    const { pairingId } = req.params;
    logger.info(`[Pairing] 删除配对会话: pairingId=${pairingId}`);
    browserLogWebSocketService.closeSession(pairingId);
    pairingService.deleteSession(pairingId);
    res.json({ success: true, message: '会话已删除' });
  } catch (error: any) {
    logger.error(`[Pairing] 删除会话失败: ${error.message}`);
    res.status(500).json({ success: false, error: '删除会话失败' });
  }
});

export default router;
