import { ChildProcess, execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import logger from '../utils/logger';

const execFileAsync = promisify(execFile);

export interface DeviceControlDevice {
  udid: string;
  name: string;
  productType?: string;
  osVersion?: string;
  connectionType?: string;
  connected: boolean;
}

export interface DeviceControlWindowSize {
  width: number;
  height: number;
}

export type DeviceControlPhase = 'idle' | 'starting' | 'connected' | 'error';

export interface DeviceControlStatus {
  phase: DeviceControlPhase;
  device?: DeviceControlDevice;
  owner?: string;
  sessionId?: string;
  wdaUrl?: string;
  windowSize?: DeviceControlWindowSize;
  streamAvailable?: boolean;
  startedAt?: string;
  lastError?: string;
}

interface WdaResponse<T> {
  value?: T;
  sessionId?: string;
  status?: number;
}

export class DeviceControlError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
    this.name = 'DeviceControlError';
  }
}

function normalizeUdid(value: unknown) {
  return String(value || '').trim();
}

function safePathPart(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'device';
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function deviceControlPortCandidates(preferredPort: number, count = 20) {
  const preferred = Math.min(Math.max(Math.round(preferredPort) || 1024, 1024), 65535);
  const size = Math.min(Math.max(Math.round(count) || 1, 1), 100);
  return Array.from({ length: size }, (_, index) => 1024 + ((preferred - 1024 + index) % (65535 - 1024 + 1)));
}

function processEnvPath() {
  const configured = String(process.env.PATH || '').trim();
  const prefixes = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return [...prefixes, ...configured.split(':').filter(Boolean)].filter((item, index, all) => all.indexOf(item) === index).join(':');
}

export function wdaStartupDiagnostic(log: string, deviceName = '真机') {
  if (/device is locked|Unlock .+ to Continue/i.test(log)) return `设备已锁定，请解锁 ${deviceName} 后重试 WDA 连接`;
  if (/Developer Mode (?:is )?(?:disabled|not enabled)|enable Developer Mode/i.test(log)) return `请在 ${deviceName} 上开启开发者模式后重试`;
  if (/not paired|pairing.+failed|Unable to communicate with (?:the )?device/i.test(log)) return `无法与 ${deviceName} 通信，请确认设备已信任本机并重新连接`;
  if (/requires a provisioning profile|No profiles for|Signing for .+ requires a development team|CodeSign error/i.test(log)) {
    return 'WDA 签名或描述文件不可用，请检查 WDA_DEVELOPMENT_TEAM 和 WDA_BUNDLE_ID';
  }
  if (/\*\* (?:BUILD|TEST) FAILED \*\*/.test(log)) return 'WDA 构建或测试启动失败，请查看 wda-xcodebuild.log';
  return '';
}

export class DeviceControlService {
  private status: DeviceControlStatus = { phase: 'idle' };
  private sessionId = '';
  private activeWdaUrl = '';
  private iproxyProcess?: ChildProcess;
  private mjpegProxyProcess?: ChildProcess;
  private wdaProcess?: ChildProcess;
  private activeMjpegUrl = '';
  private connectPromise?: Promise<DeviceControlStatus>;
  private generation = 0;

  constructor() {
    const shutdown = () => {
      this.generation += 1;
      this.stopOwnedProcesses();
    };
    process.once('exit', shutdown);
    process.once('SIGTERM', () => {
      shutdown();
      process.exit(0);
    });
    process.once('SIGINT', () => {
      shutdown();
      process.exit(0);
    });
  }

  getStatus() {
    return { ...this.status };
  }

  async listDevices(): Promise<DeviceControlDevice[]> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-ios-device-control-'));
    const outputPath = path.join(tempDir, 'devices.json');
    try {
      await execFileAsync('xcrun', ['devicectl', 'list', 'devices', '--json-output', outputPath, '--quiet'], {
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, PATH: processEnvPath() },
      });
      const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      const rawDevices = Array.isArray(parsed?.result?.devices) ? parsed.result.devices : [];
      const devices: DeviceControlDevice[] = rawDevices
        .map((device: any): DeviceControlDevice | null => {
          const hardware = device?.hardwareProperties || {};
          const properties = device?.deviceProperties || {};
          const connection = device?.connectionProperties || {};
          const udid = normalizeUdid(hardware.udid || device?.identifier);
          if (!udid) return null;
          const productType = String(hardware.productType || '').trim();
          if (productType && !/^(iPhone|iPad|iPod)/.test(productType)) return null;
          const connectionText = JSON.stringify(connection).toLowerCase();
          const disconnected = /disconnected|unavailable|not.connected/.test(connectionText);
          return {
            udid,
            name: String(properties.name || hardware.marketingName || `iOS ${udid.slice(-6)}`).trim(),
            productType: productType || String(hardware.marketingName || '').trim() || undefined,
            osVersion: String(properties.osVersionNumber || properties.osBuildUpdate || '').trim() || undefined,
            connectionType: String(connection.transportType || connection.connectionType || '').trim() || undefined,
            connected: !disconnected,
          };
        })
        .filter((device: DeviceControlDevice | null): device is DeviceControlDevice => Boolean(device));
      return devices.sort((left, right) => Number(right.connected) - Number(left.connected) || left.name.localeCompare(right.name));
    } catch (error: any) {
      logger.warn('devicectl 读取真机失败，尝试 xctrace 兜底', { error: error?.message });
      return this.listDevicesWithXctrace();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async listDevicesWithXctrace(): Promise<DeviceControlDevice[]> {
    try {
      const { stdout } = await execFileAsync('xcrun', ['xctrace', 'list', 'devices'], {
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, PATH: processEnvPath() },
      });
      const devices: DeviceControlDevice[] = [];
      let inConnectedDevicesSection = false;
      for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '== Devices ==') {
          inConnectedDevicesSection = true;
          continue;
        }
        if (line.startsWith('==')) {
          inConnectedDevicesSection = false;
          continue;
        }
        if (!inConnectedDevicesSection || !line) continue;
        const match = line.match(/^(.+?)\s+\(([^()]+)\)\s+\(([0-9A-Fa-f-]{20,})\)$/);
        if (!match) continue;
        devices.push({
          name: match[1].trim(),
          osVersion: match[2].trim(),
          udid: match[3].trim(),
          connected: true,
        });
      }
      return devices;
    } catch (error: any) {
      throw new DeviceControlError(`无法读取本机 iOS 真机：${error?.message || '请确认 Xcode 和设备连接正常'}`, 503);
    }
  }

  assertAccess(actor: string, isAdmin: boolean) {
    if (!this.status.owner || this.status.owner === actor || isAdmin) return;
    throw new DeviceControlError(`操作台正由 ${this.status.owner} 使用`, 409);
  }

  async connect(udid: string, actor: string): Promise<DeviceControlStatus> {
    const normalizedUdid = normalizeUdid(udid);
    if (!normalizedUdid || normalizedUdid.length < 16) {
      throw new DeviceControlError('请选择有效的 iOS 真机');
    }

    if (this.connectPromise) {
      if (this.status.device?.udid === normalizedUdid && this.status.owner === actor) {
        return this.connectPromise;
      }
      throw new DeviceControlError(`操作台正由 ${this.status.owner || '其他用户'} 连接设备`, 409);
    }
    if (this.status.phase === 'connected') {
      if (this.status.device?.udid === normalizedUdid && this.status.owner === actor) {
        return this.getStatus();
      }
      throw new DeviceControlError(`操作台已连接 ${this.status.device?.name || this.status.device?.udid || '其他设备'}`, 409);
    }

    const devices = await this.listDevices();
    const device = devices.find((item) => item.udid.toLowerCase() === normalizedUdid.toLowerCase());
    if (!device) {
      throw new DeviceControlError('没有在本机发现该设备，请检查 USB、信任状态和开发者模式', 404);
    }
    if (!device.connected) {
      throw new DeviceControlError('设备当前不在线', 409);
    }

    const generation = ++this.generation;
    this.sessionId = '';
    this.activeWdaUrl = '';
    this.activeMjpegUrl = '';
    this.status = {
      phase: 'starting',
      device,
      owner: actor,
      startedAt: new Date().toISOString(),
    };
    this.connectPromise = this.startSession(device, generation)
      .catch((error: any) => {
        if (generation !== this.generation) throw error;
        const message = error?.message || 'WDA 启动失败';
        this.stopOwnedProcesses();
        this.sessionId = '';
        this.activeWdaUrl = '';
        this.activeMjpegUrl = '';
        this.status = {
          phase: 'error',
          device,
          owner: actor,
          startedAt: this.status.startedAt,
          lastError: message,
        };
        throw error;
      })
      .finally(() => {
        this.connectPromise = undefined;
      });
    return this.connectPromise;
  }

  private async startSession(device: DeviceControlDevice, generation: number): Promise<DeviceControlStatus> {
    const runtimeRoot = path.resolve(
      process.env.DEVICE_CONTROL_RUNTIME_DIR || path.join(os.tmpdir(), 'nn-ios-device-control-runtime'),
    );
    const deviceRuntime = path.join(runtimeRoot, safePathPart(device.udid));
    fs.mkdirSync(deviceRuntime, { recursive: true });
    const preferredWdaPort = Math.min(Math.max(Number(process.env.DEVICE_CONTROL_WDA_PORT) || 8200, 1024), 65535);
    const preferredMjpegPort = Math.min(Math.max(Number(process.env.DEVICE_CONTROL_MJPEG_PORT) || 9200, 1024), 65535);
    let localPort = preferredWdaPort;
    let localWdaUrl = `http://127.0.0.1:${localPort}`;

    const wdaAlreadyReady = await this.isWdaReady(localWdaUrl);
    if (!wdaAlreadyReady) {
      localPort = await this.findAvailableLocalPort(preferredWdaPort);
      localWdaUrl = `http://127.0.0.1:${localPort}`;
      if (localPort !== preferredWdaPort) {
        logger.warn('默认 WDA 端口已被占用，使用备选端口', { preferredWdaPort, localPort, udid: device.udid });
      }
      this.iproxyProcess = await this.spawnLogged(
        'iproxy',
        ['-u', device.udid, `${localPort}:8100`],
        path.join(deviceRuntime, 'wda-iproxy.log'),
      );
    }

    let mjpegPort = preferredMjpegPort;
    let localMjpegUrl = `http://127.0.0.1:${mjpegPort}`;
    if (!(await this.isMjpegReady(localMjpegUrl))) {
      mjpegPort = await this.findAvailableLocalPort(preferredMjpegPort);
      localMjpegUrl = `http://127.0.0.1:${mjpegPort}`;
      if (mjpegPort !== preferredMjpegPort) {
        logger.warn('默认 MJPEG 端口已被占用，使用备选端口', { preferredMjpegPort, mjpegPort, udid: device.udid });
      }
      this.mjpegProxyProcess = await this.spawnLogged(
        'iproxy',
        ['-u', device.udid, `${mjpegPort}:9100`],
        path.join(deviceRuntime, 'wda-mjpeg-iproxy.log'),
      );
    }

    let wdaLogPath = '';
    let wdaLogOffset = 0;
    if (!wdaAlreadyReady) {
      const wdaProject = this.findWdaProject();
      if (!wdaProject) {
        throw new DeviceControlError('未找到 WebDriverAgent.xcodeproj，请配置 WDA_PROJECT_PATH 或安装 Appium XCUITest Driver', 503);
      }
      const args = [
        '-project', wdaProject,
        '-scheme', process.env.WDA_SCHEME || 'WebDriverAgentRunner',
        '-destination', `id=${device.udid}`,
        '-derivedDataPath', path.join(deviceRuntime, 'derived-data'),
        '-allowProvisioningUpdates',
        'CODE_SIGN_STYLE=Automatic',
      ];
      const developmentTeam = process.env.WDA_DEVELOPMENT_TEAM || process.env.QA_WDA_DEVELOPMENT_TEAM || '';
      const bundleId = process.env.WDA_BUNDLE_ID || process.env.QA_WDA_BUNDLE_ID || '';
      if (developmentTeam) args.push(`DEVELOPMENT_TEAM=${developmentTeam}`);
      if (bundleId) args.push(`PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`);
      args.push('test');
      wdaLogPath = path.join(deviceRuntime, 'wda-xcodebuild.log');
      wdaLogOffset = fs.existsSync(wdaLogPath) ? fs.statSync(wdaLogPath).size : 0;
      this.wdaProcess = await this.spawnLogged('xcodebuild', args, wdaLogPath);
    }

    const timeoutSeconds = Math.min(Math.max(Number(process.env.DEVICE_CONTROL_WDA_START_TIMEOUT_SECONDS) || 300, 30), 900);
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (generation !== this.generation) {
        throw new DeviceControlError('WDA 连接已取消', 409);
      }
      if (await this.isWdaReady(localWdaUrl)) {
        this.activeWdaUrl = localWdaUrl;
        break;
      }
      const startupDiagnostic = wdaLogPath ? this.readWdaStartupDiagnostic(wdaLogPath, wdaLogOffset, device.name) : '';
      if (startupDiagnostic) throw new DeviceControlError(startupDiagnostic, 409);
      if (this.wdaProcess && (this.wdaProcess.exitCode !== null || this.wdaProcess.signalCode !== null)) {
        throw new DeviceControlError(`WDA 进程已退出（${this.wdaProcess.exitCode ?? this.wdaProcess.signalCode}），请查看 wda-xcodebuild.log`, 503);
      }
      await wait(2000);
    }
    if (!this.activeWdaUrl) {
      throw new DeviceControlError(`WDA 在 ${timeoutSeconds} 秒内未就绪，请检查设备开发者模式、签名和 WDA 日志`, 504);
    }

    const session = await this.wdaRequest<any>('POST', '/session', {
      capabilities: {
        alwaysMatch: {},
        firstMatch: [{}],
      },
    });
    this.sessionId = String(session.sessionId || session.value?.sessionId || '');
    if (!this.sessionId) {
      throw new DeviceControlError('WDA 已启动，但创建控制会话失败', 502);
    }
    try {
      await this.sessionRequest('POST', '/appium/settings', {
        settings: {
          waitForIdleTimeout: 0,
          animationCoolOffTimeout: 0,
          mjpegServerFramerate: Math.min(Math.max(Number(process.env.DEVICE_CONTROL_MJPEG_FPS) || 25, 1), 30),
          mjpegScalingFactor: Math.min(Math.max(Number(process.env.DEVICE_CONTROL_MJPEG_SCALE) || 60, 25), 100),
          mjpegServerScreenshotQuality: Math.min(Math.max(Number(process.env.DEVICE_CONTROL_MJPEG_QUALITY) || 30, 10), 100),
        },
      });
    } catch (error: any) {
      logger.debug('WDA 不支持全部低延迟设置，使用默认配置', { error: error?.message });
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await this.isMjpegReady(localMjpegUrl)) {
        this.activeMjpegUrl = localMjpegUrl;
        break;
      }
      await wait(200);
    }
    const windowSize = await this.readWindowSize();
    this.status = {
      phase: 'connected',
      device,
      owner: this.status.owner,
      sessionId: this.sessionId,
      wdaUrl: this.activeWdaUrl,
      windowSize,
      streamAvailable: Boolean(this.activeMjpegUrl),
      startedAt: this.status.startedAt,
    };
    logger.info('真机操作台已连接', { udid: device.udid, owner: this.status.owner, wdaUrl: this.activeWdaUrl });
    if (this.wdaProcess) this.monitorConnectedWdaProcess(this.wdaProcess, generation, device);
    return this.getStatus();
  }

  async disconnect(actor: string, isAdmin: boolean) {
    this.assertAccess(actor, isAdmin);
    this.generation += 1;
    if (this.sessionId && this.activeWdaUrl) {
      try {
        await this.wdaRequest('DELETE', `/session/${encodeURIComponent(this.sessionId)}`);
      } catch (error: any) {
        logger.debug('删除 WDA 控制会话失败，继续清理本机进程', { error: error?.message });
      }
    }
    this.stopOwnedProcesses();
    this.sessionId = '';
    this.activeWdaUrl = '';
    this.activeMjpegUrl = '';
    this.status = { phase: 'idle' };
    return this.getStatus();
  }

  async screenshot(actor: string, isAdmin: boolean) {
    this.assertConnected(actor, isAdmin);
    const response = await this.sessionRequest<string>('GET', '/screenshot');
    const encoded = String(response.value || '');
    if (!encoded) throw new DeviceControlError('WDA 未返回设备截图', 502);
    return Buffer.from(encoded, 'base64');
  }

  async source(actor: string, isAdmin: boolean) {
    this.assertConnected(actor, isAdmin);
    const response = await this.sessionRequest<string>('GET', '/source');
    return String(response.value || '');
  }

  getMjpegUrl(actor: string, isAdmin: boolean) {
    this.assertConnected(actor, isAdmin);
    if (!this.activeMjpegUrl) {
      throw new DeviceControlError('WDA 实时视频流尚未就绪', 503);
    }
    return this.activeMjpegUrl;
  }

  async tap(x: number, y: number, actor: string, isAdmin: boolean) {
    this.assertConnected(actor, isAdmin);
    const point = await this.normalizePoint(x, y);
    try {
      await this.sessionRequest('POST', '/wda/tap/0', point);
    } catch {
      await this.sessionRequest('POST', '/actions', {
        actions: [{
          type: 'pointer',
          id: 'finger1',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, origin: 'viewport', x: point.x, y: point.y },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 80 },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      });
    }
    return { point };
  }

  async swipe(startX: number, startY: number, endX: number, endY: number, durationMs: number, actor: string, isAdmin: boolean) {
    this.assertConnected(actor, isAdmin);
    const start = await this.normalizePoint(startX, startY);
    const end = await this.normalizePoint(endX, endY);
    const duration = Math.min(Math.max(Math.round(durationMs) || 350, 100), 3000);
    await this.sessionRequest('POST', '/actions', {
      actions: [{
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', x: start.x, y: start.y },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration, origin: 'viewport', x: end.x, y: end.y },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    return { start, end, durationMs: duration };
  }

  async input(text: string, actor: string, isAdmin: boolean) {
    this.assertConnected(actor, isAdmin);
    if (!text) throw new DeviceControlError('请输入要发送到设备的文本');
    if (text.length > 2000) throw new DeviceControlError('单次输入不能超过 2000 个字符');
    const payload = { value: Array.from(text), text };
    const endpoints = ['/element/active/value', '/keys', '/wda/keys'];
    let lastError: unknown;
    for (const endpoint of endpoints) {
      try {
        await this.sessionRequest('POST', endpoint, payload);
        return { length: text.length };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new DeviceControlError('WDA 文本输入失败', 502);
  }

  async keyboard(key: 'Search' | 'Return' | 'Done' | 'Dismiss', actor: string, isAdmin: boolean) {
    this.assertConnected(actor, isAdmin);
    if (key === 'Dismiss') {
      const endpoints = ['/wda/keyboard/dismiss', '/wda/keyboard/dismissWithKey'];
      let lastError: unknown;
      for (const endpoint of endpoints) {
        try {
          await this.sessionRequest('POST', endpoint, {});
          return { key };
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new DeviceControlError('WDA 收起键盘失败', 502);
    }
    const payload = { value: ['\n'], text: '\n' };
    const endpoints = ['/element/active/value', '/keys', '/wda/keys'];
    let lastError: unknown;
    for (const endpoint of endpoints) {
      try {
        await this.sessionRequest('POST', endpoint, payload);
        return { key };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new DeviceControlError(`WDA 键盘 ${key} 操作失败`, 502);
  }

  private assertConnected(actor: string, isAdmin: boolean) {
    this.assertAccess(actor, isAdmin);
    if (this.status.phase !== 'connected' || !this.sessionId || !this.activeWdaUrl) {
      throw new DeviceControlError('真机操作台尚未连接', 409);
    }
  }

  private async normalizePoint(x: number, y: number) {
    const size = this.status.windowSize || await this.readWindowSize();
    const point = {
      x: Math.min(Math.max(Math.round(Number(x)), 0), Math.max(size.width - 1, 0)),
      y: Math.min(Math.max(Math.round(Number(y)), 0), Math.max(size.height - 1, 0)),
    };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new DeviceControlError('操作坐标无效');
    }
    return point;
  }

  private async readWindowSize(): Promise<DeviceControlWindowSize> {
    const response = await this.sessionRequest<any>('GET', '/window/size');
    const width = Number(response.value?.width);
    const height = Number(response.value?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new DeviceControlError('无法读取设备逻辑分辨率', 502);
    }
    return { width, height };
  }

  private async sessionRequest<T = unknown>(method: string, endpoint: string, body?: unknown) {
    try {
      return await this.wdaRequest<T>(method, `/session/${encodeURIComponent(this.sessionId)}${endpoint}`, body);
    } catch (error: any) {
      const transportFailure = /ECONNRESET|ECONNREFUSED|socket hang up|broken pipe|WDA 请求超时/i.test(String(error?.message || ''));
      if (transportFailure && this.status.phase === 'connected' && !(await this.isWdaReady(this.activeWdaUrl))) {
        this.markConnectionLost(error?.message || 'WDA 连接已中断');
      }
      throw error;
    }
  }

  private async isWdaReady(url: string) {
    try {
      await this.wdaRequest('GET', '/status', undefined, url, 3000);
      return true;
    } catch {
      return false;
    }
  }

  private async isMjpegReady(url: string) {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ready);
      };
      const request = http.get(`${url.replace(/\/+$/, '')}/`, (response) => {
        const contentType = String(response.headers['content-type'] || '');
        response.once('data', () => {
          request.destroy();
          finish(response.statusCode === 200 && contentType.includes('multipart/x-mixed-replace'));
        });
        response.once('end', () => finish(false));
      });
      request.setTimeout(1500, () => request.destroy(new Error('MJPEG ready check timeout')));
      request.once('error', () => finish(false));
    });
  }

  private async findAvailableLocalPort(preferredPort: number) {
    for (const port of deviceControlPortCandidates(preferredPort)) {
      if (await this.canListenOnLocalPort(port)) return port;
    }
    throw new DeviceControlError(`WDA 本地端口 ${preferredPort} 附近均已被占用`, 503);
  }

  private canListenOnLocalPort(port: number) {
    return new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
  }

  private monitorConnectedWdaProcess(child: ChildProcess, generation: number, device: DeviceControlDevice) {
    const handleExit = () => {
      if (generation !== this.generation || this.wdaProcess !== child || this.status.phase !== 'connected') return;
      const exitReason = child.exitCode !== null ? `退出码 ${child.exitCode}` : `信号 ${child.signalCode || 'unknown'}`;
      this.markConnectionLost(`WDA 进程已退出（${exitReason}），请解锁 ${device.name} 后重新连接`);
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      queueMicrotask(handleExit);
    } else {
      child.once('exit', handleExit);
    }
  }

  private markConnectionLost(message: string) {
    const previous = this.status;
    this.generation += 1;
    this.stopOwnedProcesses();
    this.sessionId = '';
    this.activeWdaUrl = '';
    this.activeMjpegUrl = '';
    this.status = {
      phase: 'error',
      device: previous.device,
      owner: previous.owner,
      startedAt: previous.startedAt,
      lastError: message,
    };
    logger.warn('真机操作台 WDA 连接已中断', { message, udid: previous.device?.udid });
  }

  private async wdaRequest<T = unknown>(method: string, endpoint: string, body?: unknown, baseUrl = this.activeWdaUrl, timeoutMs = 15000): Promise<WdaResponse<T>> {
    if (!baseUrl) throw new DeviceControlError('WDA 地址尚未初始化', 409);
    const requestUrl = new URL(endpoint, `${baseUrl.replace(/\/+$/, '')}/`);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const transport = requestUrl.protocol === 'https:' ? https : http;
    return new Promise<WdaResponse<T>>((resolve, reject) => {
      const request = transport.request(requestUrl, {
        method,
        headers: payload ? {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
        } : undefined,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: any = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            reject(new DeviceControlError(`WDA 返回了无法解析的数据：${raw.slice(0, 200)}`, 502));
            return;
          }
          const wdaError = parsed?.value?.error || parsed?.value?.message;
          if ((response.statusCode || 500) >= 400 || parsed?.status && Number(parsed.status) !== 0 || parsed?.value?.error) {
            reject(new DeviceControlError(`WDA 操作失败：${wdaError || response.statusMessage || '未知错误'}`, 502));
            return;
          }
          resolve(parsed as WdaResponse<T>);
        });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`WDA 请求超时（${timeoutMs}ms）`)));
      request.on('error', (error) => reject(new DeviceControlError(error.message, 502)));
      if (payload) request.write(payload);
      request.end();
    });
  }

  private findWdaProject() {
    const configured = String(process.env.WDA_PROJECT_PATH || process.env.WDA_PROJECT || '').trim();
    const home = os.homedir();
    const candidates = [
      configured,
      path.join(home, '工作/sonic-agent/WebDriverAgent/WebDriverAgent.xcodeproj'),
      path.join(home, '工作/sonic-agent/sonic-ios-webdriveragent/WebDriverAgent.xcodeproj'),
      path.join(home, '工作/sonic-agent/plugins/WebDriverAgent/WebDriverAgent.xcodeproj'),
      path.join(home, '工作/sonic-agent/plugins/sonic-ios-webdriveragent/WebDriverAgent.xcodeproj'),
      path.join(home, 'sonic-agent/WebDriverAgent/WebDriverAgent.xcodeproj'),
      path.join(home, '.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj'),
      path.join(home, '.appium/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj'),
      '/opt/homebrew/lib/node_modules/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj',
      '/usr/local/lib/node_modules/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj',
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) || '';
  }

  private async spawnLogged(command: string, args: string[], logPath: string) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, 'a');
    const child = spawn(command, args, {
      detached: true,
      env: { ...process.env, PATH: processEnvPath() },
      stdio: ['ignore', fd, fd],
    });
    return new Promise<ChildProcess>((resolve, reject) => {
      const onError = (error: Error) => {
        fs.closeSync(fd);
        reject(new DeviceControlError(`无法启动 ${command}：${error.message}`, 503));
      };
      child.once('error', onError);
      child.once('spawn', () => {
        child.off('error', onError);
        fs.closeSync(fd);
        resolve(child);
      });
    });
  }

  private readWdaStartupDiagnostic(logPath: string, offset: number, deviceName: string) {
    try {
      const size = fs.statSync(logPath).size;
      if (size <= offset) return '';
      const start = Math.max(offset, size - (256 * 1024));
      const length = size - start;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(logPath, 'r');
      try {
        fs.readSync(fd, buffer, 0, length, start);
      } finally {
        fs.closeSync(fd);
      }
      return wdaStartupDiagnostic(buffer.toString('utf8'), deviceName);
    } catch {
      return '';
    }
  }

  private stopOwnedProcesses() {
    for (const child of [this.iproxyProcess, this.mjpegProxyProcess, this.wdaProcess]) {
      if (!child?.pid || child.exitCode !== null) continue;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* process already exited */ }
      }
    }
    this.iproxyProcess = undefined;
    this.mjpegProxyProcess = undefined;
    this.wdaProcess = undefined;
  }
}

export const deviceControlService = new DeviceControlService();
