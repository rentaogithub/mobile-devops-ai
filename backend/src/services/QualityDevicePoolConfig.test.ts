import fs from 'fs';
import os from 'os';
import path from 'path';
import { readQualityDevicePools } from './QualityDevicePoolConfig';

describe('local iOS device-pool configuration upgrades', () => {
  let dir: string;
  const originalEnv = { ...process.env };
  const pool = { label: 'USB iPhone', value: 'ios-default', devices: [{ udid: 'device-1' }] };
  const scoped = () => path.join(dir, 'product-lines', 'nn', 'quality-device-pools.json');
  const save = (file: string, deviceId: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ devicePools: [{ ...pool, deviceId }] }));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-pools-'));
    delete process.env.QUALITY_DEVICE_POOLS_JSON;
    delete process.env.SONIC_DEVICE_POOLS_JSON;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('preserves devices from old files without exposing remote group identifiers', () => {
    const legacy = path.join(dir, 'sonic-device-pools.json');
    fs.writeFileSync(legacy, JSON.stringify({ devicePools: [{ ...pool, groupId: '123' }] }));
    expect(readQualityDevicePools(dir, scoped())).toEqual([pool]);
    expect(JSON.parse(fs.readFileSync(legacy, 'utf8')).devicePools[0].groupId).toBe('123');
  });

  it('prefers saved local configuration over scoped or legacy configuration', () => {
    save(path.join(dir, 'sonic-device-pools.json'), 'legacy');
    save(scoped(), 'scoped');
    expect(readQualityDevicePools(dir, scoped())[0].deviceId).toBe('scoped');
    save(path.join(dir, 'quality-device-pools.json'), 'local');
    expect(readQualityDevicePools(dir, scoped())[0].deviceId).toBe('local');
  });

  it('reads old environment settings but lets the new setting override them', () => {
    process.env.SONIC_DEVICE_POOLS_JSON = JSON.stringify([pool]);
    expect(readQualityDevicePools(dir, scoped())).toEqual([pool]);
    process.env.QUALITY_DEVICE_POOLS_JSON = '[]';
    expect(readQualityDevicePools(dir, scoped())).toEqual([]);
  });

  it('falls back to the environment on malformed files and rejects malformed entries', () => {
    fs.writeFileSync(path.join(dir, 'quality-device-pools.json'), '{');
    process.env.QUALITY_DEVICE_POOLS_JSON = JSON.stringify([null, 1, {}, pool]);
    expect(readQualityDevicePools(dir, scoped())).toEqual([pool]);
    process.env.QUALITY_DEVICE_POOLS_JSON = '{';
    expect(readQualityDevicePools(dir, scoped())).toEqual([]);
  });
});
