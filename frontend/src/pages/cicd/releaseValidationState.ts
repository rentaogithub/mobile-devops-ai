import { JenkinsReleasePreflightResult, WorkflowReleaseGate } from '../../services/api';
import { DeployTarget } from './qualityOptions';

export function getReleaseValidationState(params: {
  deployTarget: DeployTarget;
  gateBuildNumber?: number;
  gatePreview?: WorkflowReleaseGate;
  gatePreviewLoading?: boolean;
  gateOverrideReason: string;
  preflight?: JenkinsReleasePreflightResult | null;
  preflightError?: string;
}) {
  const hasGateBuild = Boolean(params.gateBuildNumber);
  return {
    appStoreGatePending: params.deployTarget === 'AppStore' && hasGateBuild && (params.gatePreviewLoading || !params.gatePreview),
    appStoreGateBlocked: params.deployTarget === 'AppStore' && hasGateBuild && params.gatePreview?.status === 'blocked',
    appStoreGateWarningNeedsReason: params.deployTarget === 'AppStore' &&
      hasGateBuild &&
      params.gatePreview?.status === 'warning' &&
      !params.gateOverrideReason.trim(),
    releasePreflightBlocked: Boolean(params.preflight?.blockers?.length) || Boolean(params.preflightError && !params.preflight),
  };
}
