import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../database';
import logger from '../utils/logger';
import { currentProductLineId } from './ProductLineContext';

export interface PairingSession {
  pairingId: string;
  productLineId: string;
  token: string;
  status: 'waiting' | 'paired' | 'expired';
  deviceInfo?: {
    deviceId?: string;
    name?: string;
    model?: string;
    systemVersion?: string;
    ip?: string;
    appDeviceId?: string;
    userId?: number | string;
    nickName?: string;
    nnNumber?: number | string;
  };
  createdAt: number;
  pairedAt?: number;
  lastActiveAt?: number;
}

/**
 * 配对服务 - 只管理浏览器与 App 的配对会话。
 * WebSocket 连接、日志缓存和转发由 BrowserLogWebSocketService 负责。
 */
class PairingService {
  private sessions: Map<string, PairingSession> = new Map();
  private readonly SESSION_TTL = 5 * 60 * 1000;
  private readonly PAIRED_SESSION_TTL = Number(process.env.REALTIME_LOG_PAIRED_SESSION_TTL_DAYS || 30) * 24 * 60 * 60 * 1000;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private get db() {
    return getDatabase();
  }

  constructor() {
    this.ensurePersistenceTable();
    this.loadSessions();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60 * 1000);
  }

  createSession(): { pairingId: string; token: string } {
    const pairingId = uuidv4();
    const token = uuidv4();

    const session: PairingSession = {
      pairingId,
      productLineId: currentProductLineId(),
      token,
      status: 'waiting',
      createdAt: Date.now(),
    };

    this.sessions.set(pairingId, session);
    this.saveSession(session);
    logger.info(`[Pairing] 创建配对会话: ${pairingId}`);
    return { pairingId, token };
  }

  validateSession(pairingId: string, token: string): { success: boolean; error?: string } {
    const session = this.sessions.get(pairingId);

    if (!session) {
      return { success: false, error: '配对会话不存在或已过期' };
    }
    if (session.token !== token) {
      return { success: false, error: '配对令牌无效' };
    }
    if (this.isExpired(session) && session.status === 'waiting') {
      session.status = 'expired';
      this.saveSession(session);
      return { success: false, error: '配对会话已过期，请重新扫码' };
    }

    return { success: true };
  }

  /**
   * App WebSocket 连接成功后标记为已配对。
   */
  confirmWebSocketPairing(pairingId: string, token: string): { success: boolean; error?: string } {
    const validateResult = this.validateSession(pairingId, token);
    if (!validateResult.success) {
      return validateResult;
    }

    const session = this.sessions.get(pairingId);
    if (!session) {
      return { success: false, error: '配对会话不存在或已过期' };
    }

    session.status = 'paired';
    session.pairedAt = Date.now();
    session.lastActiveAt = Date.now();
    this.saveSession(session);

    logger.info(`[Pairing] App WebSocket 已配对: pairingId=${pairingId}`);
    return { success: true };
  }

  touchSession(pairingId: string): void {
    const session = this.sessions.get(pairingId);
    if (!session) return;
    session.lastActiveAt = Date.now();
    this.saveSession(session);
  }

  updateDeviceInfo(pairingId: string, deviceInfo?: PairingSession['deviceInfo']): string[] {
    const session = this.sessions.get(pairingId);
    if (!session || !deviceInfo) return [];
    session.deviceInfo = deviceInfo;
    this.saveSession(session);
    return this.removeDuplicateDeviceSessions(session);
  }

  getSession(pairingId: string): PairingSession | null {
    return this.sessions.get(pairingId) || null;
  }

  listSessions(productLineId = currentProductLineId()): PairingSession[] {
    const uniqueSessions = new Map<string, PairingSession>();
    const sessionsWithoutIdentity: PairingSession[] = [];

    Array.from(this.sessions.values())
      .filter((session) => session.productLineId === productLineId && session.status === 'paired')
      .forEach((session) => {
        const identity = this.deviceIdentity(session.deviceInfo);
        if (!identity) {
          sessionsWithoutIdentity.push(session);
          return;
        }

        const existing = uniqueSessions.get(identity);
        if (!existing || this.sessionTime(session) > this.sessionTime(existing)) {
          uniqueSessions.set(identity, session);
        }
      });

    return [...uniqueSessions.values(), ...sessionsWithoutIdentity]
      .sort((left, right) => this.sessionTime(right) - this.sessionTime(left));
  }

  getSessionStatus(pairingId: string): {
    status: PairingSession['status'];
    deviceInfo?: PairingSession['deviceInfo'];
  } | null {
    const session = this.sessions.get(pairingId);
    if (!session) return null;

    if (this.isExpired(session) && session.status === 'waiting') {
      session.status = 'expired';
      this.saveSession(session);
    }

    return {
      status: session.status,
      deviceInfo: session.deviceInfo,
    };
  }

  deleteSession(pairingId: string, productLineId?: string): void {
    const session = this.sessions.get(pairingId);
    if (productLineId && session?.productLineId !== productLineId) return;
    this.sessions.delete(pairingId);
    if (productLineId) {
      this.db.prepare('DELETE FROM realtime_log_pairing_sessions WHERE pairing_id = ? AND product_line_id = ?').run(pairingId, productLineId);
    } else {
      this.db.prepare('DELETE FROM realtime_log_pairing_sessions WHERE pairing_id = ?').run(pairingId);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of this.sessions) {
      const ttl = session.status === 'paired' ? this.PAIRED_SESSION_TTL : this.SESSION_TTL;
      const baseTime = session.status === 'paired'
        ? (session.lastActiveAt || session.pairedAt || session.createdAt)
        : session.createdAt;
      if (now - baseTime > ttl) {
        this.deleteSession(id);
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

  private removeDuplicateDeviceSessions(currentSession: PairingSession): string[] {
    const currentIdentity = this.deviceIdentity(currentSession.deviceInfo);
    if (!currentIdentity) return [];

    const removedIds: string[] = [];
    for (const [id, session] of this.sessions) {
      if (id === currentSession.pairingId || session.status !== 'paired') continue;
      if (session.productLineId !== currentSession.productLineId || this.deviceIdentity(session.deviceInfo) !== currentIdentity) continue;
      this.deleteSession(id);
      removedIds.push(id);
    }
    if (removedIds.length > 0) {
      logger.info(`[Pairing] 移除同设备旧会话: current=${currentSession.pairingId}, removed=${removedIds.join(',')}`);
    }
    return removedIds;
  }

  private deviceIdentity(deviceInfo?: PairingSession['deviceInfo']): string | null {
    if (!deviceInfo) return null;
    const appDeviceId = this.normalized(deviceInfo.appDeviceId);
    if (appDeviceId) {
      return `appDevice:${appDeviceId}`;
    }

    const deviceId = this.normalized(deviceInfo.deviceId);
    if (deviceId) {
      return `device:${deviceId}`;
    }

    const user = this.normalized(deviceInfo.userId) || this.normalized(deviceInfo.nnNumber);
    const name = this.normalized(deviceInfo.name);
    const model = this.normalized(deviceInfo.model);
    if (!user || !name || !model) return null;
    return `fallback:${user}:${name}:${model}`;
  }

  private normalized(value: unknown): string {
    return String(value ?? '').trim();
  }

  private sessionTime(session: PairingSession): number {
    return session.lastActiveAt || session.pairedAt || session.createdAt;
  }

  private ensurePersistenceTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS realtime_log_pairing_sessions (
        pairing_id TEXT PRIMARY KEY,
        product_line_id TEXT NOT NULL DEFAULT 'nn',
        token TEXT NOT NULL,
        status TEXT NOT NULL,
        device_info TEXT,
        created_at INTEGER NOT NULL,
        paired_at INTEGER,
        last_active_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_realtime_log_pairing_status ON realtime_log_pairing_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_realtime_log_pairing_last_active_at ON realtime_log_pairing_sessions(last_active_at DESC);
    `);
    const columns = this.db.prepare('PRAGMA table_info(realtime_log_pairing_sessions)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'product_line_id')) {
      this.db.exec("ALTER TABLE realtime_log_pairing_sessions ADD COLUMN product_line_id TEXT NOT NULL DEFAULT 'nn'");
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_realtime_log_pairing_product ON realtime_log_pairing_sessions(product_line_id, status, last_active_at DESC)');
  }

  private loadSessions(): void {
    const rows = this.db.prepare(`
      SELECT pairing_id, product_line_id, token, status, device_info, created_at, paired_at, last_active_at
      FROM realtime_log_pairing_sessions
      WHERE status IN ('waiting', 'paired')
    `).all() as Array<{
      pairing_id: string;
      product_line_id: string;
      token: string;
      status: PairingSession['status'];
      device_info: string | null;
      created_at: number;
      paired_at: number | null;
      last_active_at: number | null;
    }>;

    rows.forEach((row) => {
      const session: PairingSession = {
        pairingId: row.pairing_id,
        productLineId: row.product_line_id || 'nn',
        token: row.token,
        status: row.status,
        deviceInfo: this.parseDeviceInfo(row.device_info),
        createdAt: row.created_at,
        pairedAt: row.paired_at ?? undefined,
        lastActiveAt: row.last_active_at ?? undefined,
      };
      if (session.status === 'waiting' && this.isExpired(session)) {
        session.status = 'expired';
        this.saveSession(session);
        return;
      }
      this.sessions.set(session.pairingId, session);
    });

    if (this.sessions.size > 0) {
      logger.info(`[Pairing] 恢复 ${this.sessions.size} 个实时日志配对会话`);
    }
  }

  private saveSession(session: PairingSession): void {
    this.db.prepare(`
      INSERT INTO realtime_log_pairing_sessions (
        pairing_id, product_line_id, token, status, device_info, created_at, paired_at, last_active_at, updated_at
      ) VALUES (
        @pairingId, @productLineId, @token, @status, @deviceInfo, @createdAt, @pairedAt, @lastActiveAt, @updatedAt
      )
      ON CONFLICT(pairing_id) DO UPDATE SET
        product_line_id = excluded.product_line_id,
        token = excluded.token,
        status = excluded.status,
        device_info = excluded.device_info,
        created_at = excluded.created_at,
        paired_at = excluded.paired_at,
        last_active_at = excluded.last_active_at,
        updated_at = excluded.updated_at
    `).run({
      pairingId: session.pairingId,
      productLineId: session.productLineId,
      token: session.token,
      status: session.status,
      deviceInfo: session.deviceInfo ? JSON.stringify(session.deviceInfo) : null,
      createdAt: session.createdAt,
      pairedAt: session.pairedAt ?? null,
      lastActiveAt: session.lastActiveAt ?? null,
      updatedAt: Date.now(),
    });
  }

  private parseDeviceInfo(value: string | null): PairingSession['deviceInfo'] | undefined {
    if (!value) return undefined;
    try {
      return JSON.parse(value) as PairingSession['deviceInfo'];
    } catch {
      return undefined;
    }
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
