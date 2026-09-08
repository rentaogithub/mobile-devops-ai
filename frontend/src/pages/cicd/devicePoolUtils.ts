import { QualityDevicePool } from '../../services/api';

export function devicePoolDevicesText(pool: QualityDevicePool) {
  const devices = pool.devices?.length
    ? pool.devices
    : (pool.deviceId ? [{ udid: pool.deviceId }] : []);
  return devices.map((device) => device.label ? `${device.udid} ${device.label}` : device.udid).join('\n');
}

export function parseDevicePoolDevices(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [udid, ...labelParts] = line.split(/\s+/);
      return {
        udid,
        label: labelParts.join(' ') || undefined,
      };
    })
    .filter((device) => device.udid);
}

export function cleanDevicePoolsForSave(pools: QualityDevicePool[]) {
  return pools.map((pool) => ({
    label: pool.label.trim(),
    value: pool.value.trim(),
    deviceId: pool.deviceId?.trim() || undefined,
    devices: (pool.devices || []).map((device) => ({
      label: device.label?.trim() || undefined,
      udid: device.udid.trim(),
      description: device.description?.trim() || undefined,
    })).filter((device) => device.udid),
    description: pool.description.trim(),
  }));
}

export function cloneDevicePoolsForDraft(pools: QualityDevicePool[]) {
  return pools.map((pool) => ({
    ...pool,
    devices: pool.devices?.map((device) => ({ ...device })),
  }));
}

export function updateDevicePoolDraftAt(pools: QualityDevicePool[], index: number, patch: Partial<QualityDevicePool>) {
  return pools.map((pool, poolIndex) => (
    poolIndex === index ? { ...pool, ...patch } : pool
  ));
}

export function appendDevicePoolDraft(pools: QualityDevicePool[]) {
  return [
    ...pools,
    {
      label: '新设备池',
      value: `ios-pool-${pools.length + 1}`,
      deviceId: '',
      description: '用于打包机本机 iOS 真机质检调度。',
    },
  ];
}

export function removeDevicePoolDraftAt(pools: QualityDevicePool[], index: number) {
  return pools.filter((_, poolIndex) => poolIndex !== index);
}

export function defaultQualityDeviceUdids(pools: QualityDevicePool[], poolValue: string) {
  const pool = pools.find((item) => item.value === poolValue);
  return (pool?.devices || [])
    .filter((device) => device.status === 'idle' && device.udid)
    .slice(0, 1)
    .map((device) => device.udid);
}

export function availableQualityDevicePools(pools: QualityDevicePool[]) {
  return pools.filter((pool) => (pool.stats?.idle ?? 0) > 0);
}

export function findQualityDevicePool(pools: QualityDevicePool[], poolValue: string) {
  return pools.find((pool) => pool.value === poolValue);
}

export function availableQualityDevices(pool?: QualityDevicePool) {
  return (pool?.devices || []).filter((device) => device.status === 'idle' && device.udid);
}

export function reconcileSelectedQualityDeviceUdids(current: string[], availableUdids: string[]) {
  const next = current.filter((udid) => availableUdids.includes(udid));
  if (next.length > 0) return next;
  return availableUdids.slice(0, 1);
}
