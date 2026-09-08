import { message } from 'antd';

import { JenkinsBuild, JenkinsQualityListResult, JenkinsQualitySuite, QualityDevicePool, jenkinsApi } from '../../services/api';
import { PRODUCTION_BUNDLE_ID } from './qualityOptions';

type QualityDevice = NonNullable<QualityDevicePool['devices']>[number];

interface QualityTriggerForm {
  build: JenkinsBuild | null;
  suite: JenkinsQualitySuite;
  devicePool: string;
  deviceUdids: string[];
  durationSeconds: number;
  stutterScenario: string;
  businessFlowFeatures: string[];
  skipInstall: boolean;
}

interface UseQualityTriggerParams {
  canUseQuality: boolean;
  form: QualityTriggerForm;
  selectedPool?: QualityDevicePool;
  availableDevices: QualityDevice[];
  qualityData?: JenkinsQualityListResult | null;
  onSubmittingChange: (submitting: boolean) => void;
  onSubmitMessageChange: (message: string) => void;
  onSubmitted: () => void;
  refreshSection: () => Promise<unknown>;
  refreshUntilUpdated: (previousLatest?: number | string) => Promise<void>;
}

export function useQualityTrigger({
  canUseQuality,
  form,
  selectedPool,
  availableDevices,
  qualityData,
  onSubmittingChange,
  onSubmitMessageChange,
  onSubmitted,
  refreshSection,
  refreshUntilUpdated,
}: UseQualityTriggerParams) {
  const triggerQuality = async () => {
    if (!canUseQuality) {
      message.warning('开始质检需要测试、研发或管理员权限');
      return;
    }
    if (!form.build) {
      message.warning('请选择需要质检的构建');
      return;
    }
    if (!selectedPool || availableDevices.length === 0) {
      message.warning('请选择有空闲设备的设备池');
      return;
    }
    if (form.deviceUdids.length === 0) {
      message.warning('请至少选择一台空闲设备');
      return;
    }
    if (form.suite === 'business_flow' && form.businessFlowFeatures.length === 0) {
      message.warning('请至少选择一个业务功能');
      return;
    }
    onSubmittingChange(true);
    onSubmitMessageChange('正在提交 Jenkins 质检任务...');
    const previousLatestQualityBuild = qualityData?.builds?.[0]?.number;
    try {
      await jenkinsApi.triggerQuality({
        buildNumber: form.build.number,
        branch: form.build.branchName,
        commitHash: form.build.commitHash,
        appVersion: form.build.appVersion,
        packageUrl: form.build.installPackageUrl || form.build.packageUrl,
        xcarchivePath: form.build.xcarchivePath,
        archiveUrl: form.build.archiveUrl,
        publishChannel: form.build.publishChannel,
        testSuite: form.suite,
        devicePool: form.devicePool,
        deviceUdid: form.deviceUdids[0],
        monkeyDurationSeconds: form.suite === 'monkey' || form.suite === 'stutter' || form.suite === 'business_flow'
          ? form.durationSeconds
          : undefined,
        stutterScenario: form.suite === 'stutter' ? form.stutterScenario : undefined,
        businessFlowPlan: form.suite === 'business_flow'
          ? {
              name: '自定义业务编排',
              featureIds: form.businessFlowFeatures,
              maxDurationSeconds: form.durationSeconds,
              riskPolicy: 'read_only',
              stopOnFailure: true,
            }
          : undefined,
        skipInstall: form.skipInstall,
        appBundleId: form.skipInstall ? PRODUCTION_BUNDLE_ID : undefined,
      });
      onSubmitMessageChange('已提交，正在等待 Jenkins 创建任务并刷新列表...');
      message.success(`已触发自动质检任务：#${form.build.number}`);
      onSubmitted();
      void refreshSection();
      void refreshUntilUpdated(previousLatestQualityBuild);
    } catch (err: any) {
      message.error(err?.error || err?.message || '触发自动质检失败');
      onSubmitMessageChange('');
    } finally {
      onSubmittingChange(false);
    }
  };

  return { triggerQuality };
}
