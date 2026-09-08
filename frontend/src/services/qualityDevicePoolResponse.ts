export function assertQualityDevicePoolResponse(value: unknown, kind: 'list' | 'status'): void {
  if (!value || typeof value !== 'object') {
    throw new Error('设备池接口返回异常，请确认前后端版本一致后刷新');
  }
  const response = value as { success?: boolean; data?: unknown; error?: unknown };
  if (response.success !== true) {
    throw new Error(typeof response.error === 'string' ? response.error : '设备池加载失败');
  }
  const data = response.data;
  const pools = kind === 'list'
    ? data
    : (data && typeof data === 'object' ? (data as { pools?: unknown }).pools : undefined);
  if (!Array.isArray(pools)) {
    throw new Error('设备池接口缺少配置数据，请确认后端版本后重试');
  }
}
