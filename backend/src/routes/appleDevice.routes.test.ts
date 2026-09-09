import express from 'express';
import request from 'supertest';
import axios from 'axios';
import crypto from 'crypto';
import { getDatabase } from '../database';
import { productLineConfigService } from '../services/ProductLineConfigService';
import router from './appleDevice.routes';

jest.mock('../config/env', () => ({}));
jest.mock('axios');
jest.mock('../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('child_process', () => ({ execFileSync: jest.fn(() => { throw new Error('No local devices in tests'); }) }));
jest.mock('../database', () => {
  const db = new (require('better-sqlite3'))(':memory:');
  return { getDatabase: () => db };
});
jest.mock('../middleware/auth', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { adminMiddleware: pass, productLineContextMiddleware: pass, requireApplicationPlatform: () => pass, requireApplicationServices: () => pass };
});
jest.mock('../services/ProductLineConfigService', () => {
  const { privateKey } = require('crypto').generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { productLineConfigService: {
    get: jest.fn((key: string) => key.endsWith('PRIVATE_KEY')
      ? privateKey.export({ type: 'pkcs8', format: 'pem' }) : key === 'APPLE_DEVICE_TEAM_ID' ? 'LX4548D2Q6' : 'test-account'),
    setMany: jest.fn(),
  } };
});

const app = express().use((req, _res, next) => {
  (req as any).authUser = { username: 'test-reviewer' };
  next();
}).use(router);
const appleRequest = axios.request as jest.Mock;
const udid = '00008020-001D31642E81002E';
const compact = udid.replace(/-/g, '');
const device = { id: 'apple-device', type: 'devices', attributes: { udid, name: 'Test iPhone', platform: 'IOS', status: 'ENABLED' } };
const configGet = productLineConfigService.get as jest.Mock;
const defaultConfigGet = configGet.getMockImplementation()!;

beforeEach(async () => {
  configGet.mockImplementation(defaultConfigGet);
  (productLineConfigService.setMany as jest.Mock).mockClear();
  appleRequest.mockReset();
  appleRequest.mockResolvedValue({ data: { data: [] } });
  await request(app).get('/devices');
  getDatabase().exec('DELETE FROM apple_developer_devices; DELETE FROM apple_device_registration_requests;');
  appleRequest.mockClear();
});

it('does not fall back to App Store credentials when the development account is unconfigured', async () => {
  configGet.mockImplementation((key: string) => key.startsWith('APPLE_DEVICE_') ? '' : defaultConfigGet(key));
  const status = await request(app).get('/status');
  expect(status.body.data.configured).toBe(false);
  const response = await request(app).get('/lookup').query({ udid });
  expect(response.status).toBe(502);
  expect(appleRequest).not.toHaveBeenCalled();
});

it('rejects switching the scan entry to Leishen before contacting Apple or saving configuration', async () => {
  const response = await request(app).post('/config').field('teamId', 'M4HNX7MUD2').field('issuerId', 'store-issuer');
  expect(response.status).toBe(400);
  expect(response.body.error).toContain('仅支持武汉团队 LX4548D2Q6');
  expect(appleRequest).not.toHaveBeenCalled();
  expect(productLineConfigService.setMany).not.toHaveBeenCalled();
});

it('blocks Leishen queries, registrations and cached lists if stored configuration is changed outside the scan entry', async () => {
  const pending = await request(app).post('/registration-requests').send({ udid });
  appleRequest.mockResolvedValueOnce({ data: { data: [device] } });
  await request(app).get('/devices');
  configGet.mockImplementation((key: string) => key === 'APPLE_DEVICE_TEAM_ID' ? 'M4HNX7MUD2' : defaultConfigGet(key));
  const status = await request(app).get('/status');
  expect(status.body.data).toMatchObject({ configured: false, requiredTeamId: 'LX4548D2Q6' });
  // Even cache rows matching the unsupported account must not become visible.
  const forbiddenScope = crypto.createHash('sha256').update(JSON.stringify(['M4HNX7MUD2', 'test-account', 'test-account'])).digest('hex');
  getDatabase().prepare('UPDATE apple_developer_devices SET account_scope = ?').run(forbiddenScope);
  getDatabase().prepare('UPDATE apple_device_registration_requests SET account_scope = ?').run(forbiddenScope);
  appleRequest.mockClear();
  expect((await request(app).get('/devices')).status).toBe(502);
  expect((await request(app).get('/lookup').query({ udid })).status).toBe(502);
  expect((await request(app).post('/register').send({ udid })).status).toBe(409);
  expect((await request(app).post('/registration-requests').send({ udid })).status).toBe(502);
  expect((await request(app).post(`/registration-requests/${pending.body.data.id}/approve`)).status).toBe(502);
  expect((await request(app).get('/registration-requests')).body.data.requests).toEqual([]);
  expect(appleRequest).not.toHaveBeenCalled();
});

it('isolates cached devices and registration requests when the account changes', async () => {
  const pending = await request(app).post('/registration-requests').send({ udid });
  appleRequest.mockResolvedValueOnce({ data: { data: [device] } });
  await request(app).get('/devices');
  configGet.mockImplementation((key: string) => key.endsWith('ISSUER_ID') ? 'another-issuer' : defaultConfigGet(key));
  appleRequest.mockRejectedValue(new Error('offline'));
  expect((await request(app).get('/devices')).status).toBe(502);
  expect((await request(app).get('/registration-requests')).body.data.requests).toEqual([]);
  expect((await request(app).post(`/registration-requests/${pending.body.data.id}/approve`)).status).toBe(404);
});

it.each(['M4HNX7MUD2', 'LX4548D2Q6'])('verifies the actual team %s before saving isolated device credentials', async (actualTeam) => {
  const certificateParser = jest.spyOn(crypto, 'X509Certificate').mockImplementation(() => ({
    toLegacyObject: () => ({ subject: { OU: actualTeam } }),
  }) as any);
  try {
    appleRequest.mockResolvedValueOnce({ data: { data: [{ attributes: { certificateContent: 'dGVzdA==' } }] } });
    const response = await request(app).post('/config')
      .field('teamId', 'LX4548D2Q6').field('issuerId', 'development-issuer')
      .attach('keyFile', Buffer.from(defaultConfigGet('APPLE_DEVICE_API_PRIVATE_KEY')), 'AuthKey_DEVKEY.p8');
    if (actualTeam !== 'LX4548D2Q6') {
      expect(response.status).toBe(400);
      expect(productLineConfigService.setMany).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(200);
      expect(productLineConfigService.setMany).toHaveBeenCalledWith('nn', {
        APPLE_DEVICE_TEAM_ID: 'LX4548D2Q6', APPLE_DEVICE_API_KEY_ID: 'DEVKEY',
        APPLE_DEVICE_API_ISSUER_ID: 'development-issuer',
        APPLE_DEVICE_API_PRIVATE_KEY: expect.stringContaining('BEGIN PRIVATE KEY'),
      }, 'test-reviewer');
    }
  } finally {
    certificateParser.mockRestore();
  }
});
afterAll(() => getDatabase().close());

it('shows the real Apple list and cache even when legacy local hiding records exist', async () => {
  getDatabase().exec('CREATE TABLE apple_device_list_removals (product_line_id TEXT, team_id TEXT, udid TEXT, removed_at INTEGER)');
  try {
    getDatabase().prepare('INSERT INTO apple_device_list_removals VALUES (?, ?, ?, ?)').run('nn', 'LX4548D2Q6', udid, Date.now());
    appleRequest.mockResolvedValueOnce({ data: { data: [device] } });
    const live = await request(app).get('/devices');
    expect(live.body.data).toMatchObject({ total: 1, source: 'apple', devices: [{ udid }] });
    appleRequest.mockRejectedValueOnce(new Error('offline'));
    const cached = await request(app).get('/devices');
    expect(cached.body.data).toMatchObject({ total: 1, source: 'cache', devices: [{ udid }] });
  } finally {
    getDatabase().exec('DROP TABLE apple_device_list_removals');
  }
});

it('never writes to Apple during scan or application submission; only approval registers a new device', async () => {
  const enrollment = await request(app).post('/enrollments');
  const sessionId = enrollment.body.data.sessionId;
  const callback = await request(app).post(`/enroll/${sessionId}/callback`).set('Content-Type', 'application/xml')
    .send(`<?xml version="1.0"?><plist><dict><key>UDID</key><string>${udid}</string><key>PRODUCT</key><string>iPhone11,6</string></dict></plist>`);
  expect(callback.status).toBe(200);
  const collected = await request(app).get(`/enrollments/${sessionId}`);
  expect(collected.body.data).toMatchObject({ status: 'completed', device: { udid } });
  expect(appleRequest).not.toHaveBeenCalled();
  const submitted = await request(app).post('/registration-requests').send({ udid });
  expect(submitted.body.data.status).toBe('pending');
  expect((await request(app).get('/registration-requests')).body.data.requests).toEqual([
    expect.objectContaining({ id: submitted.body.data.id, status: 'pending' }),
  ]);
  expect(appleRequest.mock.calls.every(([call]) => call.method === 'GET')).toBe(true);
  appleRequest.mockClear();
  appleRequest.mockResolvedValueOnce({ data: { data: [] } }).mockResolvedValueOnce({ data: { data: device } });
  const approved = await request(app).post(`/registration-requests/${submitted.body.data.id}/approve`);
  expect(approved.body.data).toMatchObject({ status: 'registered', approvedBy: 'test-reviewer', approvedAt: expect.any(Number) });
  expect(appleRequest.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
  const saved = (await request(app).get('/registration-requests')).body.data.requests[0];
  expect(saved).toMatchObject({ approvedBy: 'test-reviewer', approvedAt: approved.body.data.approvedAt });
  appleRequest.mockClear();
  await request(app).post(`/registration-requests/${submitted.body.data.id}/approve`);
  expect(appleRequest).not.toHaveBeenCalled();
});

it('rejects the old direct-registration route and approval without an existing request', async () => {
  const response = await request(app).post('/register').send({ udid });
  expect(response.status).toBe(409);
  expect(response.body.code).toBe('APPROVAL_REQUIRED');
  expect((await request(app).post('/registration-requests/not-found/approve')).status).toBe(404);
  expect(appleRequest).not.toHaveBeenCalled();
});

it('keeps the request pending without a success audit when Apple registration fails', async () => {
  const submitted = await request(app).post('/registration-requests').send({ udid });
  appleRequest.mockRejectedValueOnce(new Error('Apple unavailable'));
  expect((await request(app).post(`/registration-requests/${submitted.body.data.id}/approve`)).status).toBe(502);
  const saved = (await request(app).get('/registration-requests')).body.data.requests[0];
  expect(saved.status).toBe('pending');
  expect(saved.approvedAt).toBeUndefined();
  expect(saved.approvedBy).toBeUndefined();
});

it('does not register again or fabricate an approval for a device already in Apple', async () => {
  appleRequest.mockResolvedValueOnce({ data: { data: [device] } });
  const submitted = await request(app).post('/registration-requests').send({ udid });
  expect(submitted.body.data.alreadyExists).toBe(true);
  expect((await request(app).get('/registration-requests')).body.data.requests).toEqual([]);
  expect(appleRequest.mock.calls.every(([call]) => call.method === 'GET')).toBe(true);
});

it('queries Apple with the canonical UDID even when the client removes the separator', async () => {
  appleRequest.mockResolvedValue({ data: { data: [device] } });
  const response = await request(app).get('/lookup').query({ udid: compact.toLowerCase() });
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({ registered: true, source: 'apple', device: { udid } });
  expect(appleRequest.mock.calls[0][0].url).toContain(`filter[udid]=${udid}`);
});

it('does not treat a historical cache hit as a current Apple registration', async () => {
  appleRequest.mockResolvedValueOnce({ data: { data: [device] } });
  await request(app).get('/devices');
  appleRequest.mockResolvedValueOnce({ data: { data: [] } });
  const response = await request(app).get('/lookup').query({ udid });
  expect(response.body.data).toEqual({ registered: false, source: 'apple' });
});

it('reports lookup failures instead of returning a false registration result', async () => {
  appleRequest.mockResolvedValueOnce({ data: { data: [device] } });
  await request(app).get('/devices');
  appleRequest.mockRejectedValue(new Error('Apple unavailable'));
  const response = await request(app).get('/lookup').query({ udid });
  expect(response.status).toBe(502);
  expect(response.body).toMatchObject({ success: false, error: 'Apple unavailable' });
  expect(response.body.data).toBeUndefined();
  const list = await request(app).get('/devices');
  expect(list.body.data).toMatchObject({ source: 'cache', warning: 'Apple unavailable', total: 1 });
});

it('deduplicates legacy pending requests without separators', async () => {
  const created = await request(app).post('/registration-requests').send({ udid });
  getDatabase().prepare('UPDATE apple_device_registration_requests SET udid = ?').run(compact);
  appleRequest.mockClear();
  const duplicate = await request(app).post('/registration-requests').send({ udid });
  expect(duplicate.body.data).toMatchObject({ id: created.body.data.id, alreadyPending: true });
  expect(appleRequest).not.toHaveBeenCalled();
});

it('restores the separator when approving a legacy request', async () => {
  const created = await request(app).post('/registration-requests').send({ udid });
  getDatabase().prepare('UPDATE apple_device_registration_requests SET udid = ?').run(compact);
  appleRequest.mockClear();
  appleRequest.mockResolvedValueOnce({ data: { data: [] } }).mockResolvedValueOnce({ data: { data: device } });
  const approved = await request(app).post(`/registration-requests/${created.body.data.id}/approve`).send({});
  expect(approved.body.data.status).toBe('registered');
  expect(appleRequest.mock.calls[0][0].url).toContain(`filter[udid]=${udid}`);
  expect(appleRequest.mock.calls[1][0]).toMatchObject({ method: 'POST', data: { data: { attributes: { udid } } } });
});
