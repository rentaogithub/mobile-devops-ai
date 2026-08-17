import { message } from 'antd';

import { JenkinsBuildListResult, JenkinsReleasePreflightResult, WorkflowReleaseGate, jenkinsApi } from '../../services/api';
import { isReleaseBranch, releaseNotesLength } from './cicdFormatters';
import { DEPLOY_TARGET_OPTIONS, DeployTarget } from './qualityOptions';

interface UseReleasePublisherParams {
  canPublishPgyerOrTestFlight: boolean;
  canPublishAppStore: boolean;
  deployTarget: DeployTarget;
  publishBranch: string;
  resolvedPublishAppVersion: string;
  verificationPassword: string;
  gateBuildNumber?: number;
  gateOverrideReason: string;
  releaseNotes: string;
  gatePreview?: WorkflowReleaseGate | null;
  gatePreviewLoading?: boolean;
  preflight?: JenkinsReleasePreflightResult | null;
  preflightLoading?: boolean;
  preflightError?: string;
  preflightBlocked?: boolean;
  data?: JenkinsBuildListResult | null;
  filterDeployTarget: DeployTarget | '';
  onFilterDeployTargetChange: (target: DeployTarget | '') => void;
  onPublishingChange: (publishing: boolean) => void;
  onPublished: () => void;
  refreshBuildsUntilUpdated: (target: DeployTarget | '', previousLatest?: number | string) => Promise<void>;
}

export function useReleasePublisher({
  canPublishPgyerOrTestFlight,
  canPublishAppStore,
  deployTarget,
  publishBranch,
  resolvedPublishAppVersion,
  verificationPassword,
  gateBuildNumber,
  gateOverrideReason,
  releaseNotes,
  gatePreview,
  gatePreviewLoading,
  preflight,
  preflightLoading,
  preflightError,
  preflightBlocked,
  data,
  filterDeployTarget,
  onFilterDeployTargetChange,
  onPublishingChange,
  onPublished,
  refreshBuildsUntilUpdated,
}: UseReleasePublisherParams) {
  const publish = async () => {
    if ((deployTarget === 'Pgyer' || deployTarget === 'TestFlight') && !canPublishPgyerOrTestFlight) {
      message.warning('蒲公英 / TestFlight 发布需要测试、研发或管理员权限');
      return;
    }
    if (deployTarget === 'AppStore' && !canPublishAppStore) {
      message.warning('苹果商店包发布需要产品运营或管理员权限');
      return;
    }
    if (!publishBranch.trim()) {
      message.warning('请输入发布分支');
      return;
    }
    if (deployTarget !== 'Pgyer' && !isReleaseBranch(publishBranch)) {
      message.warning('TestFlight / 苹果商店只能选择 release/x.x.x 格式分支');
      return;
    }
    if (deployTarget !== 'Pgyer' && !resolvedPublishAppVersion) {
      message.warning('未识别到发布版本，请选择 release/x.x.x 格式分支');
      return;
    }
    if (deployTarget === 'TestFlight' && !canPublishPgyerOrTestFlight) {
      message.warning('TestFlight 发布需要测试、研发或管理员权限');
      return;
    }
    if (deployTarget === 'AppStore' && !canPublishAppStore) {
      message.warning('苹果商店包发布需要产品运营或管理员权限');
      return;
    }
    if (deployTarget !== 'Pgyer' && !verificationPassword.trim()) {
      message.warning('TestFlight / 苹果商店发布需要填写验证密码');
      return;
    }
    if (deployTarget !== 'Pgyer' && releaseNotesLength(releaseNotes) <= 4) {
      message.warning('TestFlight / 苹果商店发布文案必填，且必须超过 4 个字');
      return;
    }
    if (deployTarget === 'AppStore' && gateBuildNumber && (gatePreviewLoading || !gatePreview)) {
      message.warning('质量门禁预检尚未完成，请稍后再发布');
      return;
    }
    if (deployTarget === 'AppStore' && gateBuildNumber && gatePreview?.status === 'blocked') {
      message.warning('质量门禁存在阻断项，不能发布 App Store 包');
      return;
    }
    if (deployTarget === 'AppStore' && gateBuildNumber && gatePreview?.status === 'warning' && !gateOverrideReason.trim()) {
      message.warning('质量门禁存在风险项，请填写人工放行原因');
      return;
    }
    if (preflightLoading) {
      message.warning('发布前预检尚未完成，请稍后再发布');
      return;
    }
    if (preflightBlocked) {
      message.error(preflight?.blockers?.[0]?.message || preflightError || '发布前预检未通过');
      return;
    }
    onPublishingChange(true);
    const publishTarget = deployTarget;
    const previousLatestBuild = data?.job.lastBuild?.number;
    try {
      const preflightResponse = await jenkinsApi.preflightRelease({
        deployTarget: publishTarget,
        branch: publishBranch.trim(),
        appVersion: resolvedPublishAppVersion || undefined,
        gateBuildNumber,
        testFlightWhatsNew: publishTarget !== 'Pgyer' ? releaseNotes.trim() : undefined,
      });
      if (!preflightResponse.data?.passed) {
        message.error(preflightResponse.data?.blockers?.[0]?.message || '发布前预检未通过');
        return;
      }
      const response = await jenkinsApi.publishNN({
        deployTarget: publishTarget,
        branch: publishBranch.trim(),
        appVersion: resolvedPublishAppVersion || undefined,
        verificationPassword: verificationPassword.trim(),
        gateBuildNumber,
        releaseGateOverrideReason: gateOverrideReason.trim() || undefined,
        testFlightWhatsNew: publishTarget !== 'Pgyer' ? releaseNotes.trim() : undefined,
      });
      const gateMessage = response.data?.releaseGate ? `质量门禁 ${response.data.releaseGate.status}，` : '';
      message.success(`${gateMessage}已触发 ${DEPLOY_TARGET_OPTIONS.find((item) => item.value === publishTarget)?.label} 发布构建`);
      onPublished();
      const nextFilter = filterDeployTarget && filterDeployTarget !== publishTarget ? publishTarget : filterDeployTarget;
      if (nextFilter !== filterDeployTarget) {
        onFilterDeployTargetChange(nextFilter);
      }
      await refreshBuildsUntilUpdated(nextFilter, previousLatestBuild);
    } catch (err: any) {
      message.error(err?.error || err?.message || '触发发布失败');
    } finally {
      onPublishingChange(false);
    }
  };

  return { publish };
}
