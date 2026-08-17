import { useState } from 'react';
import { message } from 'antd';

import { JenkinsAppStoreRelease, JenkinsBuildListResult, jenkinsApi } from '../../services/api';
import { DeployTarget } from './qualityOptions';
import { BUILD_REFRESH_DELAYS_MS, delay } from './pollingDelays';

interface UseReleaseBuildsParams {
  canUseQuality: boolean;
  filterDeployTarget: DeployTarget | '';
  filterBranchName: string;
  onAppStoreReleaseUpdate: (buildNumber: number, release: JenkinsAppStoreRelease) => void;
}

export function useReleaseBuilds({
  canUseQuality,
  filterDeployTarget,
  filterBranchName,
  onAppStoreReleaseUpdate,
}: UseReleaseBuildsParams) {
  const [data, setData] = useState<JenkinsBuildListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stoppingBuild, setStoppingBuild] = useState<number | null>(null);
  const [cancelingAppStoreReview, setCancelingAppStoreReview] = useState<number | null>(null);

  const loadBuilds = async (
    target = filterDeployTarget,
    options?: { silent?: boolean },
    branch = filterBranchName,
  ) => {
    if (!options?.silent) {
      setLoading(true);
    }
    setError('');
    try {
      const response = await jenkinsApi.listNNBuilds({ deployTarget: target, branch });
      setData(response.data || null);
      return response.data || null;
    } catch (err: any) {
      setError(err?.error || err?.message || '加载 Jenkins 构建列表失败');
      return null;
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  };

  const refreshBuildsUntilUpdated = async (
    target: DeployTarget | '',
    previousLatest?: number | string,
    branch = filterBranchName,
  ) => {
    setLoading(true);
    try {
      for (const delayMs of BUILD_REFRESH_DELAYS_MS) {
        if (delayMs > 0) {
          await delay(delayMs);
        }
        const nextData = await loadBuilds(target, { silent: true }, branch);
        const latest = nextData?.builds?.[0]?.number;
        if (latest && previousLatest && Number(latest) > Number(previousLatest)) {
          return;
        }
        if (nextData?.builds?.some((build) => build.building)) {
          return;
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const stopBuild = async (buildNumber: number) => {
    if (!canUseQuality) {
      message.warning('取消构建需要测试、研发或管理员权限');
      return;
    }
    setStoppingBuild(buildNumber);
    try {
      await jenkinsApi.stopBuild(buildNumber);
      message.success(`已取消构建 #${buildNumber}`);
      loadBuilds();
    } catch (err: any) {
      message.error(err?.error || err?.message || '取消构建失败');
    } finally {
      setStoppingBuild(null);
    }
  };

  const cancelAppStoreReview = async (buildNumber: number) => {
    setCancelingAppStoreReview(buildNumber);
    try {
      const response = await jenkinsApi.cancelAppStoreReview(buildNumber);
      message.success(response.data?.message || '已停止 App Store 审核');
      if (response.data) {
        onAppStoreReleaseUpdate(buildNumber, response.data);
      }
      await loadBuilds(filterDeployTarget, { silent: true }, filterBranchName);
    } catch (err: any) {
      message.error(err?.error || err?.message || '停止 App Store 审核失败');
    } finally {
      setCancelingAppStoreReview(null);
    }
  };

  return {
    data,
    loading,
    error,
    stoppingBuild,
    cancelingAppStoreReview,
    loadBuilds,
    refreshBuildsUntilUpdated,
    stopBuild,
    cancelAppStoreReview,
  };
}
