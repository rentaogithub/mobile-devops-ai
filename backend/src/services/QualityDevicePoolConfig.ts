import fs from 'fs';
import path from 'path';

/** Shared local-device configuration. Legacy names are read-only upgrade fallbacks. */
export function readQualityDevicePools(dataDir: string, scopedPath: string): any[] {
  const configPath = [
    path.join(dataDir, 'quality-device-pools.json'),
    scopedPath,
    path.join(dataDir, 'sonic-device-pools.json'),
  ].find((candidate) => fs.existsSync(candidate));

  const normalize = (value: unknown): any[] => Array.isArray(value)
    ? value.filter((pool) => pool && typeof pool === 'object' && pool.label && pool.value)
      .map(({ groupId: _unusedGroupId, ...pool }) => pool)
    : [];

  if (configPath) {
    try {
      const pools = normalize(JSON.parse(fs.readFileSync(configPath, 'utf8'))?.devicePools);
      if (pools.length > 0) return pools;
    } catch {
      // A malformed file may fall back to configured local devices, never to remote groups.
    }
  }

  const raw = process.env.QUALITY_DEVICE_POOLS_JSON ?? process.env.SONIC_DEVICE_POOLS_JSON;
  try {
    return normalize(JSON.parse(raw || '[]'));
  } catch {
    return [];
  }
}
