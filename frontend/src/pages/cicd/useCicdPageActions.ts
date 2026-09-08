import { message } from 'antd';

import type { JenkinsBuild, JenkinsQualitySuite, QualityDevicePool } from '../../services/api';
import type { DeployTarget } from './qualityOptions';

interface UseCicdPageActionsParams {
  canOperateCicd: boolean;
  canUseQuality: boolean;
  deployTarget: DeployTarget;
  firstAvailableDeployTarget?: DeployTarget;
  availableDeployTargetOptions: Array<{ label: string; value: DeployTarget }>;
  branches: string[];
  releasePublishModal: {
    openForPgyerBuild: (build: JenkinsBuild) => void;
    openWithDefaults: (params: {
      deployTarget: DeployTarget;
      firstAvailableDeployTarget?: DeployTarget;
      availableDeployTargets: Array<{ label: string; value: DeployTarget }>;
      branches: string[];
      canOperateCicd: boolean;
    }) => void;
  };
  qualityStartModal: {
    openWithDefaults: (params: {
      selectedBuild?: JenkinsBuild;
      builds?: JenkinsBuild[];
      pools: QualityDevicePool[];
    }) => void;
    setSuite: (suite: JenkinsQualitySuite) => void;
  };
  releaseBuilds?: JenkinsBuild[];
  qualityDevicePools: QualityDevicePool[];
  closePublishModal: () => void;
}

export function useCicdPageActions({
  canOperateCicd,
  canUseQuality,
  deployTarget,
  firstAvailableDeployTarget,
  availableDeployTargetOptions,
  branches,
  releasePublishModal,
  qualityStartModal,
  releaseBuilds,
  qualityDevicePools,
  closePublishModal,
}: UseCicdPageActionsParams) {
  const openPgyerPublish = (build: JenkinsBuild) => {
    releasePublishModal.openForPgyerBuild(build);
  };

  const openPublishModal = () => {
    releasePublishModal.openWithDefaults({
      deployTarget,
      firstAvailableDeployTarget,
      availableDeployTargets: availableDeployTargetOptions,
      branches,
      canOperateCicd,
    });
  };

  const openQualityModal = (build?: JenkinsBuild) => {
    if (!canUseQuality) {
      message.warning('开始质检需要测试、研发或管理员权限');
      return;
    }
    qualityStartModal.openWithDefaults({
      selectedBuild: build,
      builds: releaseBuilds,
      pools: qualityDevicePools,
    });
  };

  const runMissingQualitySuite = (build?: JenkinsBuild, suite?: JenkinsQualitySuite) => {
    closePublishModal();
    openQualityModal(build);
    if (suite) qualityStartModal.setSuite(suite);
  };

  return {
    openPgyerPublish,
    openPublishModal,
    openQualityModal,
    runMissingQualitySuite,
  };
}
