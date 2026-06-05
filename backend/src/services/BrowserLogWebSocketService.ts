import crypto from 'crypto';
import { IncomingMessage, Server } from 'http';
import { Socket } from 'net';
import { URL } from 'url';
import pairingService, { PairingSession } from './PairingService';
import logger from '../utils/logger';

type ClientRole = 'app' | 'browser';

interface BrowserLogClient {
  id: string;
  pairingId: string;
  role: ClientRole;
  socket: Socket;
  receiveBuffer: Buffer;
}

type LogChannel = 'business' | 'im' | 'rtc';

interface RecentLogEntry {
  line: string;
  channel: LogChannel;
  timestamp: string;
}

class BrowserLogWebSocketService {
  private readonly clients = new Map<string, BrowserLogClient>();
  private readonly recentLogs = new Map<string, RecentLogEntry[]>();
  private readonly maxRecentLogCount = 500;

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as Socket, head);
    });
    logger.info('[BrowserLogWS] relay attached at /ws/logs');
  }

  closeSession(pairingId: string): void {
    for (const client of this.clients.values()) {
      if (client.pairingId === pairingId) {
        client.socket.end();
        client.socket.destroy();
        this.clients.delete(client.id);
      }
    }
    this.recentLogs.delete(pairingId);
  }

  private handleUpgrade(req: IncomingMessage, socket: Socket, head?: Buffer): void {
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url || '', `http://${host}`);
    if (url.pathname !== '/ws/logs') {
      socket.destroy();
      return;
    }

    const role = url.searchParams.get('role') as ClientRole | null;
    const pairingId = url.searchParams.get('pairingId') || '';
    const token = url.searchParams.get('token') || '';
    if ((role !== 'app' && role !== 'browser') || !pairingId || !token) {
      this.closeWithHttpError(socket, 400, 'Bad Request');
      return;
    }

    const validateResult = role === 'app'
      ? pairingService.confirmWebSocketPairing(pairingId, token)
      : pairingService.validateSession(pairingId, token);
    if (!validateResult.success) {
      this.closeWithHttpError(socket, 403, validateResult.error || 'Forbidden');
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      this.closeWithHttpError(socket, 400, 'Missing WebSocket Key');
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'));

    const client: BrowserLogClient = {
      id: crypto.randomUUID(),
      pairingId,
      role,
      socket,
      receiveBuffer: Buffer.alloc(0),
    };
    this.clients.set(client.id, client);
    logger.info(`[BrowserLogWS] ${role} connected: pairingId=${pairingId}`);

    if (role === 'browser') {
      this.sendJSON(client, { type: 'status', status: 'connected' });
      this.sendRecentLogs(client);
      const status = pairingService.getSessionStatus(pairingId);
      if (status?.deviceInfo) {
        this.sendJSON(client, { type: 'deviceInfo', deviceInfo: status.deviceInfo });
      }
      this.sendJSON(client, {
        type: 'status',
        status: this.hasAppClient(pairingId) ? 'app_connected' : 'waiting_app',
      });
    } else {
      pairingService.touchSession(pairingId);
      this.clearLogs(pairingId);
      this.broadcastToBrowsers(pairingId, {
        type: 'clear_logs',
        reason: 'app_connected',
        timestamp: new Date().toISOString(),
      });
      this.broadcastToBrowsers(pairingId, { type: 'status', status: 'app_connected' });
    this.appendLog(pairingId, '[NNRealtimeLog] app connected', 'business');
    }

    socket.on('data', (data) => this.handleFrame(client, data));
    socket.on('close', () => this.removeClient(client));
    socket.on('error', () => this.removeClient(client));
    if (head && head.length > 0) {
      this.handleFrame(client, head);
    }
  }

  private handleFrame(client: BrowserLogClient, data: Buffer): void {
    const decoded = this.decodeTextFrames(Buffer.concat([client.receiveBuffer, data]));
    client.receiveBuffer = decoded.remaining;
    const messages = decoded.messages;
    messages.forEach((message) => this.handleMessage(client, message));
  }

  private handleMessage(client: BrowserLogClient, message: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(message);
    } catch {
      if (client.role === 'app') {
        this.appendLog(client.pairingId, message, 'business');
      }
      return;
    }

    if (client.role === 'browser') {
      this.handleBrowserMessage(client, parsed);
      return;
    }

    if (parsed?.type === 'deviceInfo') {
      const deviceInfo = parsed.deviceInfo as PairingSession['deviceInfo'];
      const duplicatePairingIds = pairingService.updateDeviceInfo(client.pairingId, deviceInfo);
      duplicatePairingIds.forEach((pairingId) => this.closeSession(pairingId));
      this.broadcastToBrowsers(client.pairingId, { type: 'deviceInfo', deviceInfo });
      return;
    }

    if (parsed?.type === 'heartbeat') {
      pairingService.touchSession(client.pairingId);
      this.broadcastToBrowsers(client.pairingId, {
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (parsed?.type === 'appDisconnect') {
      pairingService.touchSession(client.pairingId);
      this.broadcastToBrowsers(client.pairingId, {
        type: 'status',
        status: 'app_disconnected',
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'manual',
        timestamp: new Date().toISOString(),
      });
      client.socket.end();
      client.socket.destroy();
      this.clients.delete(client.id);
      return;
    }

    if (this.isLogArchiveMessage(parsed)) {
      this.broadcastToBrowsers(client.pairingId, parsed);
      return;
    }

    const line = typeof parsed?.line === 'string'
      ? parsed.line
      : (typeof parsed?.message === 'string' ? parsed.message : message);
    this.appendLog(client.pairingId, line, this.normalizeLogChannel(parsed?.channel, line, parsed?.sdkMarker));
  }

  private handleBrowserMessage(client: BrowserLogClient, parsed: any): void {
    if (parsed?.type !== 'command') return;
    const payload = {
      type: 'command',
      command: parsed.command,
      requestId: typeof parsed.requestId === 'string' ? parsed.requestId : crypto.randomUUID(),
    };
    const forwardedCount = this.forwardToApps(client.pairingId, payload);
    if (forwardedCount <= 0) {
      if (payload.command === 'refreshLogs') {
        this.sendJSON(client, { type: 'status', status: 'waiting_app' });
        return;
      }
      this.sendJSON(client, {
        type: 'logArchiveFailed',
        requestId: payload.requestId,
        message: 'App 未连接，无法下载日志',
      });
    }
  }

  private isLogArchiveMessage(parsed: any): boolean {
    return [
      'logArchivePreparing',
      'logArchiveStart',
      'logArchiveChunk',
      'logArchiveFinished',
      'logArchiveFailed',
    ].includes(parsed?.type);
  }

  private appendLog(pairingId: string, line: string, channel: LogChannel): void {
    pairingService.touchSession(pairingId);
    const logs = this.recentLogs.get(pairingId) || [];
    const timestamp = new Date().toISOString();
    logs.push({ line, channel, timestamp });
    if (logs.length > this.maxRecentLogCount) {
      logs.splice(0, logs.length - this.maxRecentLogCount);
    }
    this.recentLogs.set(pairingId, logs);
    this.broadcastToBrowsers(pairingId, {
      type: 'log',
      line,
      channel,
      timestamp,
    });
  }

  private clearLogs(pairingId: string): void {
    this.recentLogs.delete(pairingId);
  }

  private sendRecentLogs(client: BrowserLogClient): void {
    const logs = this.recentLogs.get(client.pairingId) || [];
    logs.forEach((entry) => {
      this.sendJSON(client, {
        type: 'log',
        line: entry.line,
        channel: entry.channel,
        timestamp: entry.timestamp,
        cached: true,
      });
    });
  }

  private normalizeLogChannel(channel: unknown, line?: string, sdkMarker?: unknown): LogChannel {
    if (channel === 'im' || channel === 'rtc') {
      return channel;
    }
    if (sdkMarker === '[IMSDK]') {
      return 'im';
    }
    if (sdkMarker === '[RTCSDK]') {
      return 'rtc';
    }
    if (line && this.isIMLogLine(line)) {
      return 'im';
    }
    if (line && this.isRTCLogLine(line)) {
      return 'rtc';
    }
    return 'business';
  }

  private isIMLogLine(line: string): boolean {
    return line.includes('[IMSDK]');
  }

  private isRTCLogLine(line: string): boolean {
    return line.includes('[RTCSDK]');
  }

  private broadcastToBrowsers(pairingId: string, payload: unknown): void {
    for (const client of this.clients.values()) {
      if (client.role === 'browser' && client.pairingId === pairingId) {
        this.sendJSON(client, payload);
      }
    }
  }

  private forwardToApps(pairingId: string, payload: unknown): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.role === 'app' && client.pairingId === pairingId) {
        this.sendJSON(client, payload);
        count++;
      }
    }
    return count;
  }

  private hasAppClient(pairingId: string): boolean {
    return this.isAppConnected(pairingId);
  }

  isAppConnected(pairingId: string): boolean {
    for (const client of this.clients.values()) {
      if (client.role === 'app' && client.pairingId === pairingId) {
        return true;
      }
    }
    return false;
  }

  getRecentLogCount(pairingId: string): number {
    return this.recentLogs.get(pairingId)?.length || 0;
  }

  private sendJSON(client: BrowserLogClient, payload: unknown): void {
    this.sendText(client.socket, JSON.stringify(payload));
  }

  private sendText(socket: Socket, text: string): void {
    if (socket.destroyed) return;

    const payload = Buffer.from(text);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  }

  private decodeTextFrames(buffer: Buffer): { messages: string[]; remaining: Buffer } {
    const messages: string[] = [];
    let offset = 0;

    while (offset + 2 <= buffer.length) {
      const frameStart = offset;
      const firstByte = buffer[offset];
      const opcode = firstByte & 0x0f;
      const secondByte = buffer[offset + 1];
      const masked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      offset += 2;

      if (payloadLength === 126) {
        if (offset + 2 > buffer.length) {
          return { messages, remaining: buffer.subarray(frameStart) };
        }
        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (offset + 8 > buffer.length) {
          return { messages, remaining: buffer.subarray(frameStart) };
        }
        const bigLength = buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          return { messages, remaining: Buffer.alloc(0) };
        }
        payloadLength = Number(bigLength);
        offset += 8;
      }

      let mask: Buffer | null = null;
      if (masked) {
        if (offset + 4 > buffer.length) {
          return { messages, remaining: buffer.subarray(frameStart) };
        }
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (offset + payloadLength > buffer.length) {
        return { messages, remaining: buffer.subarray(frameStart) };
      }
      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
      offset += payloadLength;

      if (mask) {
        for (let index = 0; index < payload.length; index++) {
          payload[index] ^= mask[index % 4];
        }
      }

      if (opcode === 0x8) {
        return { messages, remaining: Buffer.alloc(0) };
      }
      if (opcode === 0x1) {
        messages.push(payload.toString('utf8'));
      }
    }

    return { messages, remaining: offset < buffer.length ? buffer.subarray(offset) : Buffer.alloc(0) };
  }

  private removeClient(client: BrowserLogClient): void {
    if (!this.clients.delete(client.id)) return;
    logger.info(`[BrowserLogWS] ${client.role} disconnected: pairingId=${client.pairingId}`);
    if (client.role === 'app') {
      this.broadcastToBrowsers(client.pairingId, { type: 'status', status: 'app_disconnected' });
    }
  }

  private closeWithHttpError(socket: Socket, statusCode: number, message: string): void {
    socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }
}

export const browserLogWebSocketService = new BrowserLogWebSocketService();
