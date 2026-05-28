import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';

export interface PairingSession {
  pairingId: string;
  token: string;
  status: 'waiting' | 'paired' | 'expired';
  deviceLogUrl?: string;
  deviceInfo?: {
    name?: string;
    model?: string;
    systemVersion?: string;
    ip?: string;
  };
  createdAt: number;
  pairedAt?: number;
}

/**
 * 配对服务 - 管理浏览器与 App 之间的配对会话
 *
 * 流程：
 * 1. 浏览器请求创建配对会话，获得 pairingId + token，生成二维码
 * 2. App 扫描二维码，解析出 pairingId + token
 * 3. App 启动 NNBrowserLogServer，获取本机 IP:Port
 * 4. App 调用 confirm 接口，提交 deviceLogUrl + deviceInfo
 * 5. 浏览器通过轮询获取配对结果，拿到 deviceLogUrl
 * 6. 浏览器打开 deviceLogUrl 查看实时日志
 */
class PairingService {
  private sessions: Map<string, PairingSession> = new Map();
  private readonly SESSION_TTL = 5 * 60 * 1000; // 5 分钟过期
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    // 每分钟清理过期会话
    this.cleanupTimer = setInterval(() => this.cleanup(), 60 * 1000);
  }

  /**
   * 创建配对会话
   */
  createSession(): { pairingId: string; token: string } {
    const pairingId = uuidv4();
    const token = uuidv4();

    const session: PairingSession = {
      pairingId,
      token,
      status: 'waiting',
      createdAt: Date.now(),
    };

    this.sessions.set(pairingId, session);
    logger.info(`[Pairing] 创建配对会话: ${pairingId}`);

    return { pairingId, token };
  }

  /**
   * App 确认配对 - 提交设备日志 URL 和设备信息
   */
  confirmPairing(
    pairingId: string,
    token: string,
    deviceLogUrl: string,
    deviceInfo?: PairingSession['deviceInfo']
  ): { success: boolean; error?: string } {
    const session = this.sessions.get(pairingId);

    if (!session) {
      return { success: false, error: '配对会话不存在或已过期' };
    }

    if (session.token !== token) {
      return { success: false, error: '配对令牌无效' };
    }

    if (this.isExpired(session)) {
      session.status = 'expired';
      return { success: false, error: '配对会话已过期，请重新扫码' };
    }

    if (session.status === 'paired') {
      return { success: false, error: '该会话已被配对' };
    }

    // 更新会话状态
    session.status = 'paired';
    session.deviceLogUrl = deviceLogUrl;
    session.deviceInfo = deviceInfo;
    session.pairedAt = Date.now();

    logger.info(`[Pairing] 配对成功: ${pairingId}, deviceLogUrl: ${deviceLogUrl}`);

    return { success: true };
  }

  /**
   * 浏览器轮询配对状态
   */
  getSessionStatus(pairingId: string): {
    status: PairingSession['status'];
    deviceLogUrl?: string;
    deviceInfo?: PairingSession['deviceInfo'];
  } | null {
    const session = this.sessions.get(pairingId);

    if (!session) {
      return null;
    }

    if (this.isExpired(session) && session.status === 'waiting') {
      session.status = 'expired';
    }

    return {
      status: session.status,
      deviceLogUrl: session.deviceLogUrl,
      deviceInfo: session.deviceInfo,
    };
  }

  /**
   * 删除配对会话
   */
  deleteSession(pairingId: string): void {
    this.sessions.delete(pairingId);
  }

  /**
   * 清理过期会话
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, session] of this.sessions) {
      // 已配对的会话保留 30 分钟后清理
      const ttl = session.status === 'paired' ? 30 * 60 * 1000 : this.SESSION_TTL;
      if (now - session.createdAt > ttl) {
        this.sessions.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`[Pairing] 清理了 ${cleaned} 个过期会话`);
    }
  }

  private isExpired(session: PairingSession): boolean {
    return Date.now() - session.createdAt > this.SESSION_TTL;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }
}

const pairingService = new PairingService();
export default pairingService;
