import { useMemo, useState } from 'react';
import { message } from 'antd';

import { JenkinsQualityListResult, jenkinsApi } from '../../services/api';
import { QUALITY_REFRESH_DELAYS_MS, delay } from './pollingDelays';
import { normalizeQualityError } from './qualityOptions';
import { isQualityBuildEffectivelyRunning } from './qualityStatus';

interface UseQualityBuildsParams {
  canAdmin: boolean;
  canUseQuality: boolean;
  refreshSourceBuilds: () => Promise<unknown>;
  refreshDevicePools: () => Promise<unknown>;
}

export function useQualityBuilds({
  canAdmin,
  canUseQuality,
  refreshSourceBuilds,
  refreshDevicePools,
}: UseQualityBuildsParams) {
  const [data, setData] = useState<JenkinsQualityListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [jobSyncing, setJobSyncing] = useState(false);
  const [stoppingBuild, setStoppingBuild] = useState<number | null>(null);
  const [cleaningWda, setCleaningWda] = useState<string | null>(null);

  const hasRunningBuild = useMemo(
    () => (data?.builds || []).some((build) => isQualityBuildEffectivelyRunning(build)),
    [data],
  );

  const loadBuilds = async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    setError('');
    try {
      const response = await jenkinsApi.listQualityBuilds();
      setData(response.data || null);
      return response.data || null;
    } catch (err: any) {
      setError(normalizeQualityError(err));
      return null;
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  };

  async function refreshSection(options?: { silent?: boolean }) {
    const [, qualityResult] = await Promise.all([
      refreshSourceBuilds(),
      loadBuilds(options),
      refreshDevicePools(),
    ]);
    return qualityResult;
  }

  const refreshUntilUpdated = async (previousLatest?: number | string) => {
    const previousNumber = previousLatest ? Number(previousLatest) : 0;
    for (const delayMs of QUALITY_REFRESH_DELAYS_MS) {
      if (delayMs > 0) {
        await delay(delayMs);
      }
      const nextData = await refreshSection({ silent: true });
      const latestBuild = nextData?.builds?.[0];
      const latestNumber = latestBuild ? Number(latestBuild.number) : 0;

      if (latestNumber && (!previousNumber || latestNumber > previousNumber)) {
        return;
      }
    }
    await refreshSection({ silent: true });
  };

  const syncJobConfig = async () => {
    if (!canAdmin) {
      message.warning('同步 Jenkins 配置仅管理员可操作');
      return;
    }
    setJobSyncing(true);
    try {
      const response = await jenkinsApi.syncQualityJobConfig();
      const result = response.data;
      message.success(result?.concurrentBuild ? 'Jenkins 质检 Job 已同步，并发已开启' : 'Jenkins 质检 Job 已同步');
      await refreshSection({ silent: true });
    } catch (err: any) {
      message.error(err?.error || err?.message || '同步 Jenkins 质检 Job 配置失败');
    } finally {
      setJobSyncing(false);
    }
  };

  const stopBuild = async (buildNumber: number, deviceUdid?: string) => {
    if (!canUseQuality) {
      message.warning('停止质检任务需要测试、研发或管理员权限');
      return;
    }
    setStoppingBuild(buildNumber);
    try {
      await jenkinsApi.stopQualityBuild(buildNumber, deviceUdid ? { deviceUdid } : undefined);
      message.success(`已停止质检任务 #${buildNumber}`);
      await refreshSection({ silent: true });
    } catch (err: any) {
      message.error(err?.error || err?.message || '停止质检任务失败');
    } finally {
      setStoppingBuild(null);
    }
  };

  const cleanupWda = async (deviceUdid?: string) => {
    if (!canUseQuality) {
      message.warning('清理 WDA 需要测试、研发或管理员权限');
      return;
    }
    if (!deviceUdid && hasRunningBuild) {
      message.warning('当前有质检任务运行中，请先停止或等待任务结束后再清理 WDA');
      return;
    }
    const cleanupKey = deviceUdid || '__all__';
    setCleaningWda(cleanupKey);
    try {
      const response = await jenkinsApi.cleanupQualityWda(deviceUdid ? { deviceUdid } : undefined);
      const terminated = response.data?.terminatedDeviceProcesses || 0;
      message.success(deviceUdid
        ? `已清理设备 WDA：${deviceUdid.slice(0, 12)}...${terminated ? `，终止设备进程 ${terminated} 个` : ''}`
        : `已清理本机 WDA/iproxy/xctrace${terminated ? `，终止设备进程 ${terminated} 个` : ''}`);
      await refreshSection({ silent: true });
    } catch (err: any) {
      message.error(err?.error || err?.message || '清理 WDA 失败');
    } finally {
      setCleaningWda(null);
    }
  };

  return {
    data,
    loading,
    error,
    jobSyncing,
    stoppingBuild,
    cleaningWda,
    hasRunningBuild,
    loadBuilds,
    refreshSection,
    refreshUntilUpdated,
    syncJobConfig,
    stopBuild,
    cleanupWda,
    clearError: () => setError(''),
  };
}
