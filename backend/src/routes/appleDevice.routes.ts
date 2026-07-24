import '../config/env';
import express, { Router, Request } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import { execFileSync } from 'child_process';
import logger from '../utils/logger';
import { adminMiddleware } from '../middleware/auth';
import { getDatabase } from '../database';

const router = Router();
const appleConfigUpload = multer({
  dest: process.env.UPLOAD_DIR || '../../nn-ios-platform-data/uploads',
  limits: { fileSize: 1024 * 1024 },
});

type EnrollmentStatus = 'pending' | 'completed';

interface EnrollmentSession {
  id: string;
  createdAt: number;
  status: EnrollmentStatus;
  device?: {
    udid: string;
    name?: string;
    product?: string;
    version?: string;
    serial?: string;
  };
}

interface LocalAppleDeviceInfo {
  udid: string;
  name?: string;
  product?: string;
  version?: string;
  serial?: string;
}

type RegistrationRequestStatus = 'pending' | 'registered' | 'rejected';

interface RegistrationRequest {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: RegistrationRequestStatus;
  udid: string;
  name: string;
  platform: string;
  source?: {
    product?: string;
    version?: string;
    serial?: string;
  };
  appleDeviceId?: string;
  appleStatus?: string;
  message?: string;
}

const sessions = new Map<string, EnrollmentSession>();
const SESSION_TTL_MS = 30 * 60 * 1000;
const ASC_API_BASE = 'https://api.appstoreconnect.apple.com/v1';
let appleDeviceTablesReady = false;

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

function publicBaseUrl(req: Request) {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.PLATFORM_PUBLIC_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

function platformPageUrl(req: Request) {
  return publicBaseUrl(req).replace(/:3000$/, ':5173');
}

function normalizeUdid(value: unknown) {
  return String(value || '').trim().toUpperCase();
}

function isValidUdid(udid: string) {
  return /^[A-F0-9]{24,40}$/.test(udid) || /^[A-F0-9]{8}-[A-F0-9]{16}$/.test(udid);
}

function createFallbackDeviceName(udid: string) {
  const suffix = normalizeUdid(udid).replace(/-/g, '').slice(-6) || crypto.randomBytes(3).toString('hex').toUpperCase();
  return `iPhone-${crypto.randomBytes(2).toString('hex').toUpperCase()}-${suffix}`;
}

function ensureAppleDeviceTables() {
  if (appleDeviceTablesReady) return;
  getDatabase().exec(`
    CREATE TABLE IF NOT EXISTS apple_developer_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      udid TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL DEFAULT 'IOS',
      status TEXT NOT NULL DEFAULT '',
      device_class TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      added_date TEXT NOT NULL DEFAULT '',
      synced_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_apple_developer_devices_platform ON apple_developer_devices(platform, added_date DESC);
    CREATE TABLE IF NOT EXISTS apple_device_registration_requests (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      udid TEXT NOT NULL,
      name TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'IOS',
      source_json TEXT NOT NULL DEFAULT '{}',
      apple_device_id TEXT,
      apple_status TEXT,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_apple_device_registration_requests_status ON apple_device_registration_requests(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_apple_device_registration_requests_udid ON apple_device_registration_requests(udid);
  `);
  appleDeviceTablesReady = true;
}

function registrationRequestFromRow(row: any): RegistrationRequest {
  let source = {};
  try {
    source = JSON.parse(row.source_json || '{}');
  } catch {
    source = {};
  }
  return {
    id: row.id,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    status: row.status,
    udid: row.udid,
    name: row.name,
    platform: row.platform,
    source,
    appleDeviceId: row.apple_device_id || undefined,
    appleStatus: row.apple_status || undefined,
    message: row.message || undefined,
  };
}

function saveRegistrationRequest(request: RegistrationRequest) {
  ensureAppleDeviceTables();
  getDatabase().prepare(`
    INSERT INTO apple_device_registration_requests (
      id, created_at, updated_at, status, udid, name, platform, source_json, apple_device_id, apple_status, message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at,
      status = excluded.status,
      udid = excluded.udid,
      name = excluded.name,
      platform = excluded.platform,
      source_json = excluded.source_json,
      apple_device_id = excluded.apple_device_id,
      apple_status = excluded.apple_status,
      message = excluded.message
  `).run(
    request.id,
    request.createdAt,
    request.updatedAt,
    request.status,
    request.udid,
    request.name,
    request.platform,
    JSON.stringify(request.source || {}),
    request.appleDeviceId || null,
    request.appleStatus || null,
    request.message || null,
  );
}

function getRegistrationRequest(id: string) {
  ensureAppleDeviceTables();
  const row = getDatabase().prepare('SELECT * FROM apple_device_registration_requests WHERE id = ?').get(id);
  return row ? registrationRequestFromRow(row) : null;
}

function listRegistrationRequests() {
  ensureAppleDeviceTables();
  return (getDatabase().prepare(`
    SELECT * FROM apple_device_registration_requests
    ORDER BY created_at DESC
    LIMIT 100
  `).all() as any[]).map(registrationRequestFromRow);
}

function findPendingRegistrationRequest(udid: string) {
  ensureAppleDeviceTables();
  const row = getDatabase().prepare(`
    SELECT * FROM apple_device_registration_requests
    WHERE status = 'pending' AND udid = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(udid);
  return row ? registrationRequestFromRow(row) : null;
}

function appleDeviceFromRow(row: any) {
  return {
    id: row.id,
    name: row.name || '',
    udid: row.udid || '',
    platform: row.platform || '',
    status: row.status || '',
    deviceClass: row.device_class || '',
    model: row.model || '',
    addedDate: row.added_date || '',
  };
}

function listCachedAppleDevices(platform: string) {
  ensureAppleDeviceTables();
  const rows = getDatabase().prepare(`
    SELECT * FROM apple_developer_devices
    WHERE platform = ?
    ORDER BY added_date DESC
    LIMIT 500
  `).all(platform) as any[];
  return rows.map(appleDeviceFromRow);
}

function findCachedAppleDeviceByUdid(udid: string) {
  ensureAppleDeviceTables();
  const normalized = normalizeUdid(udid).replace(/-/g, '');
  if (!normalized) return null;
  const row = getDatabase().prepare(`
    SELECT * FROM apple_developer_devices
    WHERE REPLACE(UPPER(udid), '-', '') = ?
    LIMIT 1
  `).get(normalized);
  return row ? appleDeviceFromRow(row) : null;
}

function saveAppleDevices(devices: ReturnType<typeof normalizeAppleDevice>[]) {
  ensureAppleDeviceTables();
  const now = Date.now();
  const stmt = getDatabase().prepare(`
    INSERT INTO apple_developer_devices (
      id, name, udid, platform, status, device_class, model, added_date, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(udid) DO UPDATE SET
      id = excluded.id,
      name = excluded.name,
      platform = excluded.platform,
      status = excluded.status,
      device_class = excluded.device_class,
      model = excluded.model,
      added_date = excluded.added_date,
      synced_at = excluded.synced_at
  `);
  const tx = getDatabase().transaction((items: ReturnType<typeof normalizeAppleDevice>[]) => {
    for (const device of items) {
      stmt.run(
        device.id,
        device.name,
        device.udid,
        device.platform,
        device.status,
        device.deviceClass,
        device.model,
        device.addedDate,
        now,
      );
    }
  });
  tx(devices);
}

function readLocalAppleDevicesByDevicectl(): LocalAppleDeviceInfo[] {
  const outputPath = path.join(os.tmpdir(), `nn-ios-devicectl-devices-${process.pid}-${Date.now()}.json`);
  try {
    execFileSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', outputPath, '--quiet'], {
      timeout: 10000,
      stdio: 'ignore',
    });
    const raw = fs.readFileSync(outputPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const devices = Array.isArray(parsed?.result?.devices) ? parsed.result.devices : [];
    return devices
      .map((device: any) => {
        const hardware = device?.hardwareProperties || {};
        const properties = device?.deviceProperties || {};
        const udid = normalizeUdid(hardware.udid || '');
        if (!isValidUdid(udid)) return null;
        return {
          udid,
          name: String(properties.name || '').trim(),
          product: String(hardware.productType || hardware.marketingName || '').trim(),
          version: String(properties.osVersionNumber || properties.osBuildUpdate || '').trim(),
          serial: String(hardware.serialNumber || '').trim(),
        };
      })
      .filter(Boolean) as LocalAppleDeviceInfo[];
  } catch (error: any) {
    logger.debug('读取本机 iOS 设备名称失败', { error: error?.message });
    return [];
  } finally {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {
      // ignore temporary file cleanup failure
    }
  }
}

function enrichEnrollmentDeviceFromLocal(session: EnrollmentSession) {
  const udid = normalizeUdid(session.device?.udid);
  if (!isValidUdid(udid)) return session;
  const localDevice = readLocalAppleDevicesByDevicectl().find((device) => normalizeUdid(device.udid) === udid);
  if (!localDevice) {
    session.device = {
      ...session.device,
      udid,
      name: session.device?.name || createFallbackDeviceName(udid),
    };
    return session;
  }
  session.device = {
    udid,
    name: session.device?.name || localDevice.name || createFallbackDeviceName(udid),
    product: session.device?.product || localDevice.product,
    version: session.device?.version || localDevice.version,
    serial: session.device?.serial || localDevice.serial,
  };
  return session;
}

function readApplePrivateKey() {
  const inlineKey = String(process.env.APP_STORE_CONNECT_API_PRIVATE_KEY || '').trim();
  if (inlineKey) return inlineKey.replace(/\\n/g, '\n');

  const keyPath = String(process.env.APP_STORE_CONNECT_API_KEY_PATH || '').trim();
  if (!keyPath) return '';
  const resolved = path.isAbsolute(keyPath) ? keyPath : path.resolve(process.cwd(), keyPath);
  return fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf-8') : '';
}

function appleKeyPathInfo() {
  const keyPath = String(process.env.APP_STORE_CONNECT_API_KEY_PATH || '').trim();
  if (!keyPath) {
    return { keyPathConfigured: false };
  }
  const resolved = path.isAbsolute(keyPath) ? keyPath : path.resolve(process.cwd(), keyPath);
  const keyFileName = path.basename(resolved);
  const exists = fs.existsSync(resolved);
  return {
    keyPathConfigured: true,
    keyFileName,
    keyFileExists: exists,
    keyLooksLikeSubscriptionKey: /^SubscriptionKey_/i.test(keyFileName),
    keyLooksLikeAppStoreConnectKey: /^AuthKey_/i.test(keyFileName),
  };
}

function appleConfigStatus() {
  const keyId = String(process.env.APP_STORE_CONNECT_API_KEY_ID || '').trim();
  const issuerId = String(process.env.APP_STORE_CONNECT_API_ISSUER_ID || '').trim();
  const keyPath = String(process.env.APP_STORE_CONNECT_API_KEY_PATH || '').trim();
  const privateKey = readApplePrivateKey();
  const keyInfo = appleKeyPathInfo();
  const missing = [
    !keyId ? 'APP_STORE_CONNECT_API_KEY_ID' : '',
    !issuerId ? 'APP_STORE_CONNECT_API_ISSUER_ID' : '',
    !privateKey ? 'APP_STORE_CONNECT_API_KEY_PATH 或 APP_STORE_CONNECT_API_PRIVATE_KEY' : '',
  ].filter(Boolean);
  const warnings = [
    keyInfo.keyLooksLikeSubscriptionKey
      ? '当前私钥文件名像 Subscription Key，通常不能访问 Apple Developer 设备管理接口；请使用 App Store Connect API 的 AuthKey_*.p8。'
      : '',
    keyInfo.keyPathConfigured && !keyInfo.keyFileExists
      ? 'APP_STORE_CONNECT_API_KEY_PATH 指向的私钥文件不存在。'
      : '',
  ].filter(Boolean);
  return { configured: missing.length === 0, missing, warnings, keyId, issuerId, keyPath, ...keyInfo };
}

function backendEnvPath() {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), 'backend/.env'),
    path.resolve(__dirname, '../../.env'),
    path.resolve(__dirname, '../../../backend/.env'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return found || path.resolve(process.cwd(), '.env');
}

function dataSecretsDir() {
  if (process.env.APP_STORE_CONNECT_API_KEY_PATH) {
    return path.dirname(path.resolve(process.env.APP_STORE_CONNECT_API_KEY_PATH));
  }
  if (process.env.DB_PATH) {
    return path.join(path.dirname(path.resolve(process.env.DB_PATH)), 'secrets');
  }
  return path.resolve(process.env.DATA_DIR || path.join(process.cwd(), '..', 'nn-ios-platform-data'), 'secrets');
}

function updateEnvValues(updates: Record<string, string>) {
  const envPath = backendEnvPath();
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const keys = new Set(Object.keys(updates));
  const seen = new Set<string>();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !keys.has(match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });
  for (const key of keys) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${updates[key]}`);
    }
  }
  fs.writeFileSync(envPath, nextLines.join('\n').replace(/\n*$/, '\n'), 'utf-8');
  Object.entries(updates).forEach(([key, value]) => {
    process.env[key] = value;
  });
  return envPath;
}

function markdownEscape(value: unknown) {
  return String(value || '').replace(/\r?\n/g, ' ').trim();
}

async function notifyAppleDeviceApproval(req: Request, request: RegistrationRequest) {
  const webhookUrl = String(process.env.APPLE_DEVICE_APPROVAL_WEBHOOK_URL || '').trim();
  if (!webhookUrl) return;
  const approvalUrl = `${platformPageUrl(req)}/cicd/devices`;
  const sourceText = [request.source?.product, request.source?.version, request.source?.serial]
    .filter(Boolean)
    .map(markdownEscape)
    .join(' / ') || '-';
  const content = [
    '### iOS 设备注册申请待审批',
    `> 设备名称：${markdownEscape(request.name)}`,
    `> UDID：\`${markdownEscape(request.udid)}\``,
    `> 设备信息：${sourceText}`,
    `> 平台：${markdownEscape(request.platform)}`,
    `> 申请时间：${new Date(request.createdAt).toLocaleString('zh-CN', { hour12: false })}`,
    '',
    `[打开平台审批](${approvalUrl})`,
  ].join('\n');
  try {
    await axios.post(webhookUrl, {
      msgtype: 'markdown',
      markdown: { content },
    }, { timeout: 10000 });
    logger.info('Apple 设备注册申请审批通知已发送', { requestId: request.id, udid: request.udid });
  } catch (error: any) {
    logger.warn('发送 Apple 设备注册申请审批通知失败', { error: error?.message, requestId: request.id, udid: request.udid });
  }
}

function appleDeviceApiErrorMessage(error: any, fallback: string) {
  const appleError = error?.response?.data?.errors?.[0];
  if (appleError?.code === 'NOT_AUTHORIZED') {
    const status = appleConfigStatus();
    const keyHint = status.keyLooksLikeSubscriptionKey
      ? `当前配置的是 ${status.keyFileName}，它像 Subscription Key，不是设备管理接口需要的 AuthKey_*.p8。`
      : '请确认使用的是 App Store Connect API Team Key，并且账号具备管理 Certificates, Identifiers & Profiles 的权限。';
    return {
      appleError,
      message: `${keyHint}Apple 返回 NOT_AUTHORIZED，暂时无法拉取或注册开发者设备列表。`,
    };
  }
  return {
    appleError,
    message: appleError?.detail || appleError?.title || error?.message || fallback,
  };
}

async function registerAppleDeviceToDeveloper(udid: string, name: string, platform: string) {
  const existing = await requestApple<any>('GET', `${ASC_API_BASE}/devices?filter[udid]=${encodeURIComponent(udid)}&limit=1`);
  const existedDevice = Array.isArray(existing?.data) ? existing.data[0] : null;
  if (existedDevice?.id) {
    return {
      id: existedDevice.id,
      udid,
      name: existedDevice.attributes?.name || name,
      platform: existedDevice.attributes?.platform || platform,
      status: existedDevice.attributes?.status,
      alreadyExists: true,
      message: '该设备已存在于 Apple Developer 账号',
    };
  }

  const created = await requestApple<any>('POST', `${ASC_API_BASE}/devices`, {
    data: {
      type: 'devices',
      attributes: {
        name,
        platform,
        udid,
      },
    },
  });
  const device = created?.data;
  return {
    id: device?.id,
    udid,
    name: device?.attributes?.name || name,
    platform: device?.attributes?.platform || platform,
    status: device?.attributes?.status,
    alreadyExists: false,
    message: '设备已注册到 Apple Developer',
  };
}

function base64Url(input: Buffer | string) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createAppleJwt() {
  const keyId = String(process.env.APP_STORE_CONNECT_API_KEY_ID || '').trim();
  const issuerId = String(process.env.APP_STORE_CONNECT_API_ISSUER_ID || '').trim();
  const privateKey = readApplePrivateKey();
  if (!keyId || !issuerId || !privateKey) {
    throw new Error(`App Store Connect API Key 未配置完整：${appleConfigStatus().missing.join('、')}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = {
    iss: issuerId,
    iat: now,
    exp: now + 20 * 60,
    aud: 'appstoreconnect-v1',
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64Url(signature)}`;
}

async function requestApple<T>(method: 'GET' | 'POST', url: string, data?: any): Promise<T> {
  const token = createAppleJwt();
  const response = await axios.request<T>({
    method,
    url,
    data,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  return response.data;
}

function normalizeAppleDevice(device: any) {
  const attributes = device?.attributes || {};
  return {
    id: device?.id,
    name: attributes.name || '',
    udid: attributes.udid || '',
    platform: attributes.platform || '',
    status: attributes.status || '',
    deviceClass: attributes.deviceClass || '',
    model: attributes.model || '',
    addedDate: attributes.addedDate || '',
  };
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function createMobileConfig(baseUrl: string, sessionId: string) {
  const callbackUrl = `${baseUrl}/api/apple-devices/enroll/${encodeURIComponent(sessionId)}/callback`;
  const payloadUuid = crypto.randomUUID();
  const profileUuid = crypto.randomUUID();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <dict>
    <key>URL</key>
    <string>${escapeXml(callbackUrl)}</string>
    <key>DeviceAttributes</key>
    <array>
      <string>UDID</string>
      <string>DEVICE_NAME</string>
      <string>PRODUCT</string>
      <string>VERSION</string>
      <string>SERIAL</string>
    </array>
  </dict>
  <key>PayloadDescription</key>
  <string>采集 iOS 设备 Identifier，用于注册 Apple 开发者设备。</string>
  <key>PayloadDisplayName</key>
  <string>NN iOS 设备注册</string>
  <key>PayloadIdentifier</key>
  <string>com.nn-ios-platform.device-enroll.${escapeXml(sessionId)}</string>
  <key>PayloadOrganization</key>
  <string>NN iOS Platform</string>
  <key>PayloadType</key>
  <string>Profile Service</string>
  <key>PayloadUUID</key>
  <string>${profileUuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadContentUUID</key>
  <string>${payloadUuid}</string>
</dict>
</plist>`;
}

function createCompletionMobileConfig(req: Request, session: EnrollmentSession) {
  const profileUuid = crypto.randomUUID();
  const webClipUuid = crypto.randomUUID();
  const platformUrl = publicBaseUrl(req).replace(/:3000$/, ':5173');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>FullScreen</key>
      <false/>
      <key>IsRemovable</key>
      <true/>
      <key>Label</key>
      <string>NN 设备注册</string>
      <key>PayloadDescription</key>
      <string>打开 NN iOS 移动管理平台。</string>
      <key>PayloadDisplayName</key>
      <string>NN 设备注册</string>
      <key>PayloadIdentifier</key>
      <string>com.nn-ios-platform.device-enroll.webclip.${escapeXml(session.id)}</string>
      <key>PayloadType</key>
      <string>com.apple.webClip.managed</string>
      <key>PayloadUUID</key>
      <string>${webClipUuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>Precomposed</key>
      <false/>
      <key>URL</key>
      <string>${escapeXml(platformUrl)}/cicd/devices</string>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>设备 Identifier 已采集。UDID：${escapeXml(session.device?.udid || '')}</string>
  <key>PayloadDisplayName</key>
  <string>NN iOS 设备注册完成</string>
  <key>PayloadIdentifier</key>
  <string>com.nn-ios-platform.device-enroll.completed.${escapeXml(session.id)}</string>
  <key>PayloadOrganization</key>
  <string>NN iOS Platform</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${profileUuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>`;
}

function createEnrollmentCompletedHtml(req: Request, session: EnrollmentSession) {
  const platformUrl = publicBaseUrl(req).replace(/:3000$/, ':5173');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Identifier 已采集</title>
  <style>
    body { margin: 0; padding: 28px 18px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f8fb; color: #1f2937; }
    main { max-width: 520px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 22px; box-shadow: 0 8px 30px rgba(15, 23, 42, .08); }
    h1 { font-size: 22px; margin: 0 0 12px; }
    p { line-height: 1.6; color: #4b5563; }
    code { word-break: break-all; display: block; padding: 10px; background: #f3f4f6; border-radius: 8px; color: #111827; }
    a { display: inline-block; margin-top: 12px; padding: 12px 16px; color: #fff; background: #1677ff; border-radius: 8px; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <h1>Identifier 已采集</h1>
    <p>平台已收到这台设备的 Identifier，请回到电脑上的 iOS 移动管理平台查看注册结果。</p>
    <code>${escapeXml(session.device?.udid || '')}</code>
    <a href="${escapeXml(platformUrl)}/cicd/devices">回到平台</a>
  </main>
</body>
</html>`;
}

function parsePlistValue(text: string, key: string) {
  const pattern = new RegExp(`<key>\\s*${key}\\s*</key>[\\s\\S]*?<string>([\\s\\S]*?)</string>`, 'i');
  const match = text.match(pattern);
  if (!match) return '';
  return match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function extractPlistXml(text: string) {
  const xmlStart = text.indexOf('<?xml');
  const plistStart = text.indexOf('<plist');
  const start = xmlStart >= 0 ? xmlStart : plistStart;
  const end = text.lastIndexOf('</plist>');
  if (start >= 0 && end >= start) {
    return text.slice(start, end + '</plist>'.length);
  }
  return text;
}

function parsePlistKeys(text: string) {
  return Array.from(text.matchAll(/<key>\s*([\s\S]*?)\s*<\/key>/gi))
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function parseProfileServiceCallbackBody(body: unknown) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf-8');
  const text = buffer.toString('utf-8');
  if (text.includes('<plist')) {
    return extractPlistXml(text);
  }

  const commands = [
    ['smime', '-verify', '-inform', 'DER', '-noverify'],
    ['cms', '-verify', '-inform', 'DER', '-noverify'],
  ];
  for (const args of commands) {
    try {
      const decoded = execFileSync('/usr/bin/openssl', args, {
        input: buffer,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).toString('utf-8');
      if (decoded.includes('<plist')) {
        return extractPlistXml(decoded);
      }
    } catch (error: any) {
      logger.warn('解析 iOS 设备采集签名回调失败，尝试下一种方式', { command: args[0], error: error?.message });
    }
  }

  return text;
}

router.get('/status', (_req, res) => {
  res.json({ success: true, data: appleConfigStatus() });
});

router.post('/config', adminMiddleware, appleConfigUpload.single('keyFile'), (req, res) => {
  try {
    const keyId = String(req.body?.keyId || '').trim();
    const issuerId = String(req.body?.issuerId || '').trim();
    let keyPath = String(req.body?.keyPath || '').trim();

    if (!keyId || !issuerId) {
      res.status(400).json({ success: false, error: '请填写 Key ID 和 Issuer ID' });
      return;
    }

    if (req.file) {
      const originalName = path.basename(req.file.originalname || `AuthKey_${keyId}.p8`);
      if (!/^AuthKey_[A-Z0-9]+\.p8$/i.test(originalName)) {
        fs.unlinkSync(req.file.path);
        res.status(400).json({ success: false, error: '请上传 App Store Connect API 的 AuthKey_*.p8 文件' });
        return;
      }
      const secretsDir = dataSecretsDir();
      fs.mkdirSync(secretsDir, { recursive: true });
      keyPath = path.join(secretsDir, originalName);
      fs.renameSync(req.file.path, keyPath);
      fs.chmodSync(keyPath, 0o600);
    }

    if (!keyPath) {
      res.status(400).json({ success: false, error: '请填写 Key 文件路径或上传 AuthKey_*.p8 文件' });
      return;
    }

    const resolvedKeyPath = path.isAbsolute(keyPath) ? keyPath : path.resolve(process.cwd(), keyPath);
    if (!fs.existsSync(resolvedKeyPath)) {
      res.status(400).json({ success: false, error: 'Key 文件路径不存在' });
      return;
    }
    const envPath = updateEnvValues({
      APP_STORE_CONNECT_API_KEY_ID: keyId,
      APP_STORE_CONNECT_API_ISSUER_ID: issuerId,
      APP_STORE_CONNECT_API_KEY_PATH: resolvedKeyPath,
    });
    res.json({
      success: true,
      data: {
        ...appleConfigStatus(),
        envFile: path.basename(envPath),
        message: 'Apple Developer API 配置已更新',
      },
    });
  } catch (error: any) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    logger.error('更新 Apple Developer API 配置失败', { error: error?.message });
    res.status(500).json({ success: false, error: error?.message || '更新 Apple Developer API 配置失败' });
  }
});

router.get('/devices', adminMiddleware, async (req, res) => {
  const platform = String(req.query.platform || 'IOS').trim().toUpperCase();
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 200);
  const devices: any[] = [];
  let url = `${ASC_API_BASE}/devices?limit=${limit}`;
  if (platform) {
    url += `&filter[platform]=${encodeURIComponent(platform)}`;
  }

  try {
    for (let page = 0; url && page < 10; page += 1) {
      const response = await requestApple<any>('GET', url);
      devices.push(...(Array.isArray(response?.data) ? response.data : []));
      url = response?.links?.next || '';
    }
    const normalizedDevices = devices
      .map(normalizeAppleDevice)
      .sort((a, b) => String(b.addedDate || '').localeCompare(String(a.addedDate || '')));
    saveAppleDevices(normalizedDevices);
    res.json({
      success: true,
      data: {
        devices: normalizedDevices,
        total: normalizedDevices.length,
        platform,
        source: 'apple',
      },
    });
  } catch (error: any) {
    const { appleError, message } = appleDeviceApiErrorMessage(error, '获取 Apple 设备列表失败');
    const cachedDevices = listCachedAppleDevices(platform);
    if (cachedDevices.length > 0) {
      res.json({
        success: true,
        data: {
          devices: cachedDevices,
          total: cachedDevices.length,
          platform,
          source: 'cache',
          warning: message,
        },
      });
      return;
    }
    logger.error('获取 Apple 设备列表失败', { error: error?.message, appleError });
    res.status(502).json({
      success: false,
      error: message,
      appleError,
    });
  }
});

router.get('/lookup', async (req, res) => {
  const udid = normalizeUdid(req.query.udid).replace(/-/g, '');
  if (!isValidUdid(udid)) {
    res.status(400).json({ success: false, error: '请输入有效的 iOS 设备 Identifier/UDID' });
    return;
  }

  const cachedDevice = findCachedAppleDeviceByUdid(udid);
  if (cachedDevice) {
    res.json({ success: true, data: { registered: true, device: cachedDevice, source: 'cache' } });
    return;
  }

  if (!appleConfigStatus().configured) {
    res.json({ success: true, data: { registered: false, source: 'cache' } });
    return;
  }

  try {
    const existing = await requestApple<any>('GET', `${ASC_API_BASE}/devices?filter[udid]=${encodeURIComponent(udid)}&limit=1`);
    const existedDevice = Array.isArray(existing?.data) ? existing.data[0] : null;
    if (!existedDevice?.id) {
      res.json({ success: true, data: { registered: false, source: 'apple' } });
      return;
    }
    const normalizedDevice = normalizeAppleDevice(existedDevice);
    saveAppleDevices([normalizedDevice]);
    res.json({ success: true, data: { registered: true, device: normalizedDevice, source: 'apple' } });
  } catch (error: any) {
    const { message } = appleDeviceApiErrorMessage(error, '查询 Apple 设备注册状态失败');
    logger.warn('查询 Apple 设备注册状态失败，返回本地未命中结果', { error: error?.message, udid });
    res.json({ success: true, data: { registered: false, source: 'cache', warning: message } });
  }
});

router.post('/enrollments', (req, res) => {
  cleanupSessions();
  const id = crypto.randomUUID();
  const session: EnrollmentSession = {
    id,
    createdAt: Date.now(),
    status: 'pending',
  };
  sessions.set(id, session);
  const baseUrl = publicBaseUrl(req);
  res.json({
    success: true,
    data: {
      sessionId: id,
      status: session.status,
      enrollUrl: `${baseUrl}/api/apple-devices/enroll/${encodeURIComponent(id)}`,
      expiresAt: new Date(session.createdAt + SESSION_TTL_MS).toISOString(),
    },
  });
});

router.get('/enrollments/:id', (req, res) => {
  cleanupSessions();
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ success: false, error: '设备采集会话不存在或已过期' });
    return;
  }
  enrichEnrollmentDeviceFromLocal(session);
  sessions.set(session.id, session);
  res.json({ success: true, data: session });
});

router.get('/enroll/:id', (req, res) => {
  cleanupSessions();
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).send('设备采集会话不存在或已过期，请回到 CI/CD 页面重新生成二维码。');
    return;
  }
  const baseUrl = publicBaseUrl(req);
  const mobileConfigUrl = `${baseUrl}/api/apple-devices/enroll/${encodeURIComponent(req.params.id)}/profile.mobileconfig`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NN iOS 设备注册</title>
  <style>
    body { margin: 0; padding: 28px 18px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f8fb; color: #1f2937; }
    main { max-width: 520px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 22px; box-shadow: 0 8px 30px rgba(15, 23, 42, .08); }
    h1 { font-size: 22px; margin: 0 0 12px; }
    p { line-height: 1.6; color: #4b5563; }
    a { display: inline-block; margin-top: 12px; padding: 12px 16px; color: #fff; background: #1677ff; border-radius: 8px; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <h1>采集 iOS 设备 Identifier</h1>
    <p>点击下方按钮安装临时描述文件。iOS 会打开设置完成安装，并把 UDID 回传给平台。</p>
    <p>采集完成后回到电脑 CI/CD 页面继续注册到 Apple Developer。</p>
    <a href="${escapeXml(mobileConfigUrl)}">安装采集描述文件</a>
  </main>
</body>
</html>`);
});

router.get('/enroll/:id/profile.mobileconfig', (req, res) => {
  cleanupSessions();
  if (!sessions.has(req.params.id)) {
    res.status(404).send('设备采集会话不存在或已过期');
    return;
  }
  res.setHeader('Content-Type', 'application/x-apple-aspen-config; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="nn-ios-device-enroll.mobileconfig"');
  res.send(createMobileConfig(publicBaseUrl(req), req.params.id));
});

router.post('/enroll/:id/callback', expressRawProfileCallback(), (req, res) => {
  cleanupSessions();
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).send('设备采集会话不存在或已过期');
    return;
  }
  const bodyText = parseProfileServiceCallbackBody(req.body);
  const udid = normalizeUdid(parsePlistValue(bodyText, 'UDID'));
  if (!isValidUdid(udid)) {
    const bodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf-8');
    const debugDir = path.join(process.env.UPLOAD_DIR || path.resolve(process.cwd(), '../uploads'), 'apple-device-callback-debug');
    const debugFile = path.join(debugDir, `${session.id}-${Date.now()}.bin`);
    try {
      fs.mkdirSync(debugDir, { recursive: true });
      fs.writeFileSync(debugFile, bodyBuffer);
    } catch (error: any) {
      logger.warn('保存 iOS 设备采集回调调试文件失败', { error: error?.message });
    }
    logger.warn('未能从 iOS 设备采集回调中读取有效 UDID', {
      sessionId: session.id,
      contentType: req.get('content-type'),
      bodyType: Buffer.isBuffer(req.body) ? 'buffer' : typeof req.body,
      bodyLength: bodyBuffer.length,
      plistKeys: parsePlistKeys(bodyText).slice(0, 20),
      bodyPreview: bodyText.replace(/[^\x20-\x7E\u4e00-\u9fa5]/g, '.').slice(0, 300),
      debugFile,
    });
    res.status(400).send('未能从设备回调中读取有效 UDID');
    return;
  }
  session.status = 'completed';
  session.device = {
    udid,
    name: parsePlistValue(bodyText, 'DEVICE_NAME') || createFallbackDeviceName(udid),
    product: parsePlistValue(bodyText, 'PRODUCT'),
    version: parsePlistValue(bodyText, 'VERSION'),
    serial: parsePlistValue(bodyText, 'SERIAL'),
  };
  enrichEnrollmentDeviceFromLocal(session);
  sessions.set(session.id, session);
  logger.info('iOS 设备 Identifier 已采集', { udid, name: session.device.name, product: session.device.product });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(createEnrollmentCompletedHtml(req, session));
});

function expressRawProfileCallback() {
  return express.raw({
    type: ['application/xml', 'text/xml', 'application/x-apple-aspen-config', 'application/pkcs7-signature', '*/*'],
    limit: '1mb',
  });
}

router.get('/registration-requests', adminMiddleware, (_req, res) => {
  res.json({ success: true, data: { requests: listRegistrationRequests() } });
});

router.post('/registration-requests', express.json({ limit: '1mb' }), async (req, res) => {
  const udid = normalizeUdid(req.body?.udid);
  const name = String(req.body?.name || '').trim() || createFallbackDeviceName(udid);
  const platform = String(req.body?.platform || 'IOS').trim().toUpperCase();
  if (!isValidUdid(udid)) {
    res.status(400).json({ success: false, error: '请输入有效的 iOS 设备 Identifier/UDID' });
    return;
  }
  if (!['IOS', 'MAC_OS'].includes(platform)) {
    res.status(400).json({ success: false, error: '设备平台仅支持 IOS 或 MAC_OS' });
    return;
  }

  const existingRequest = findPendingRegistrationRequest(udid);
  if (existingRequest) {
    res.json({
      success: true,
      data: {
        ...existingRequest,
        alreadyPending: true,
        message: '该设备已有待审批注册申请',
      },
    });
    return;
  }

  try {
    const existing = await requestApple<any>('GET', `${ASC_API_BASE}/devices?filter[udid]=${encodeURIComponent(udid)}&limit=1`);
    const existedDevice = Array.isArray(existing?.data) ? existing.data[0] : null;
    if (existedDevice?.id) {
      res.json({
        success: true,
        data: {
          id: existedDevice.id,
          udid,
          name: existedDevice.attributes?.name || name,
          platform: existedDevice.attributes?.platform || platform,
          status: existedDevice.attributes?.status,
          alreadyExists: true,
          message: '该设备已存在于 Apple Developer 账号',
        },
      });
      return;
    }

    const request: RegistrationRequest = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'pending',
      udid,
      name,
      platform,
      source: {
        product: String(req.body?.product || '').trim(),
        version: String(req.body?.version || '').trim(),
        serial: String(req.body?.serial || '').trim(),
      },
      message: '已提交 Apple 设备注册申请，等待管理员审批',
    };
    saveRegistrationRequest(request);
    await notifyAppleDeviceApproval(req, request);
    res.json({
      success: true,
      data: {
        ...request,
        alreadyExists: false,
        message: request.message,
      },
    });
  } catch (error: any) {
    const { appleError, message } = appleDeviceApiErrorMessage(error, '提交 Apple 设备注册申请失败');
    logger.error('提交 Apple 设备注册申请失败', { error: error?.message, appleError, udid });
    res.status(502).json({
      success: false,
      error: message,
      appleError,
    });
  }
});

router.post('/registration-requests/:id/approve', express.json({ limit: '1mb' }), adminMiddleware, async (req, res) => {
  const request = getRegistrationRequest(req.params.id);
  if (!request) {
    res.status(404).json({ success: false, error: '设备注册申请不存在' });
    return;
  }
  if (request.status !== 'pending') {
    res.json({ success: true, data: request });
    return;
  }

  try {
    const result = await registerAppleDeviceToDeveloper(request.udid, request.name, request.platform);
    request.status = 'registered';
    request.updatedAt = Date.now();
    request.appleDeviceId = result.id;
    request.appleStatus = result.status;
    request.message = result.message;
    saveRegistrationRequest(request);
    res.json({ success: true, data: { ...request, result } });
  } catch (error: any) {
    const { appleError, message } = appleDeviceApiErrorMessage(error, '审批注册 Apple 设备失败');
    logger.error('审批注册 Apple 设备失败', { error: error?.message, appleError, udid: request.udid });
    res.status(502).json({
      success: false,
      error: message,
      appleError,
    });
  }
});

router.post('/register', express.json({ limit: '1mb' }), adminMiddleware, async (req, res) => {
  const udid = normalizeUdid(req.body?.udid);
  const name = String(req.body?.name || '').trim() || `iPhone ${udid.slice(-6)}`;
  const platform = String(req.body?.platform || 'IOS').trim().toUpperCase();
  if (!isValidUdid(udid)) {
    res.status(400).json({ success: false, error: '请输入有效的 iOS 设备 Identifier/UDID' });
    return;
  }
  if (!['IOS', 'MAC_OS'].includes(platform)) {
    res.status(400).json({ success: false, error: '设备平台仅支持 IOS 或 MAC_OS' });
    return;
  }

  try {
    const result = await registerAppleDeviceToDeveloper(udid, name, platform);
    res.json({ success: true, data: result });
  } catch (error: any) {
    const { appleError, message } = appleDeviceApiErrorMessage(error, '注册 Apple 设备失败');
    logger.error('注册 Apple 设备失败', { error: error?.message, appleError, udid });
    res.status(502).json({
      success: false,
      error: message,
      appleError,
    });
  }
});

export default router;
