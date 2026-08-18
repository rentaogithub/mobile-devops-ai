import type { JenkinsBuildListResult } from '../../services/api';
import { getReleaseValidationState } from './releaseValidationState';
import type { DeployTarget } from './qualityOptions';
import type { useReleasePublishModal } from './useReleasePublishModal';
import { useReleasePublisher } from './useReleasePublisher';
import { useReleaseValidation } from './useReleaseValidation';

interface UseReleasePublishControllerParams {
  modal: ReturnType<typeof useReleasePublishModal>;
  canOperateCicd: boolean;
  canPublishPgyerOrTestFlight: boolean;
  canPublishAppStore: boolean;
  data?: JenkinsBuildListResult | null;
  filterDeployTarget: DeployTarget | '';
  onFilterDeployTargetChange: (target: DeployTarget | '') => void;
  refreshBuildsUntilUpdated: (target: DeployTarget | '', previousLatest?: number | string) => Promise<void>;
}

export function useReleasePublishController({
  modal,
  canOperateCicd,
  canPublishPgyerOrTestFlight,
  canPublishAppStore,
  data,
  filterDeployTarget,
  onFilterDeployTargetChange,
  refreshBuildsUntilUpdated,
}: UseReleasePublishControllerParams) {
  const validation = useReleaseValidation({
    publishModalOpen: modal.open,
    deployTarget: modal.deployTarget,
    publishBranch: modal.publishBranch,
    resolvedPublishAppVersion: modal.resolvedPublishAppVersion,
    publishGateBuildNumber: modal.gateBuildNumber,
    testFlightWhatsNew: modal.releaseNotes,
    canOperateCicd,
    canPublishAppStore,
  });

  const validationState = getReleaseValidationState({
    deployTarget: modal.deployTarget,
    gateBuildNumber: modal.gateBuildNumber,
    gatePreview: validation.gatePreview,
    gatePreviewLoading: validation.gatePreviewLoading,
    gateOverrideReason: modal.gateOverrideReason,
    preflight: validation.preflight,
    preflightError: validation.preflightError,
  });

  const { publish } = useReleasePublisher({
    canPublishPgyerOrTestFlight,
    canPublishAppStore,
    deployTarget: modal.deployTarget,
    publishBranch: modal.publishBranch,
    resolvedPublishAppVersion: modal.resolvedPublishAppVersion,
    verificationPassword: modal.verificationPassword,
    gateBuildNumber: modal.gateBuildNumber,
    gateOverrideReason: modal.gateOverrideReason,
    releaseNotes: modal.releaseNotes,
    gatePreview: validation.gatePreview,
    gatePreviewLoading: validation.gatePreviewLoading,
    preflight: validation.preflight,
    preflightLoading: validation.preflightLoading,
    preflightError: validation.preflightError,
    preflightBlocked: validationState.releasePreflightBlocked,
    data,
    filterDeployTarget,
    onFilterDeployTargetChange,
    onPublishingChange: modal.setPublishing,
    onPublished: modal.resetAfterPublish,
    refreshBuildsUntilUpdated,
  });

  return {
    validation,
    validationState,
    publish,
  };
}
