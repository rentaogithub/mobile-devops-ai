import type { JenkinsBuild, JenkinsQualitySuite } from '../../services/api';
import { ReleasePublishModal } from './ReleasePublishModal';
import { getHighestReleaseBranch, releaseNotesLength } from './cicdFormatters';
import { qualitySuiteName } from './qualityOptions';
import type { DeployTarget } from './qualityOptions';
import type { useReleasePublishModal } from './useReleasePublishModal';
import type { useReleaseValidation } from './useReleaseValidation';

interface ReleasePublishModalContainerProps {
  modal: ReturnType<typeof useReleasePublishModal>;
  validation: ReturnType<typeof useReleaseValidation>;
  releasePreflightBlocked?: boolean;
  appStoreGatePending?: boolean;
  appStoreGateBlocked?: boolean;
  appStoreGateWarningNeedsReason?: boolean;
  canOperateCicd?: boolean;
  canPublishPgyerOrTestFlight?: boolean;
  canPublishAppStore?: boolean;
  deployTargetOptions: Array<{ label: string; value: DeployTarget }>;
  publishBranchOptions: Array<{ value: string; label: string }>;
  branchLoading?: boolean;
  branches: string[];
  gateBuildOptions: Array<{ value: number; label: string }>;
  sourceBuilds: JenkinsBuild[];
  onPublish: () => void;
  onRefreshBranches: () => void;
  onOpenUrl: (url?: string) => void;
  onRunMissingSuite: (build?: JenkinsBuild, suite?: JenkinsQualitySuite) => void;
}

export function ReleasePublishModalContainer({
  modal,
  validation,
  releasePreflightBlocked,
  appStoreGatePending,
  appStoreGateBlocked,
  appStoreGateWarningNeedsReason,
  canOperateCicd,
  canPublishPgyerOrTestFlight,
  canPublishAppStore,
  deployTargetOptions,
  publishBranchOptions,
  branchLoading,
  branches,
  gateBuildOptions,
  sourceBuilds,
  onPublish,
  onRefreshBranches,
  onOpenUrl,
  onRunMissingSuite,
}: ReleasePublishModalContainerProps) {
  return (
    <ReleasePublishModal
      open={modal.open}
      publishing={modal.publishing}
      canOperateCicd={canOperateCicd}
      canPublishPgyerOrTestFlight={canPublishPgyerOrTestFlight}
      canPublishAppStore={canPublishAppStore}
      deployTarget={modal.deployTarget}
      deployTargetOptions={deployTargetOptions}
      publishBranch={modal.publishBranch}
      publishBranchOptions={publishBranchOptions}
      branchLoading={branchLoading}
      branches={branches}
      resolvedPublishAppVersion={modal.resolvedPublishAppVersion}
      appStoreReleaseGuard={validation.appStoreReleaseGuard}
      appStoreReleaseGuardLoading={validation.appStoreReleaseGuardLoading}
      appStoreReleaseGuardError={validation.appStoreReleaseGuardError}
      releasePreflight={validation.preflight}
      releasePreflightLoading={validation.preflightLoading}
      releasePreflightError={validation.preflightError}
      releasePreflightBlocked={releasePreflightBlocked}
      appStoreGatePending={appStoreGatePending}
      appStoreGateBlocked={appStoreGateBlocked}
      appStoreGateWarningNeedsReason={appStoreGateWarningNeedsReason}
      verificationPassword={modal.verificationPassword}
      releaseNotes={modal.releaseNotes}
      gateBuildNumber={modal.gateBuildNumber}
      gateBuildOptions={gateBuildOptions}
      gatePreview={validation.gatePreview}
      gatePreviewLoading={validation.gatePreviewLoading}
      gateMissingSuites={validation.gateMissingSuites}
      gateOverrideReason={modal.gateOverrideReason}
      sourceBuilds={sourceBuilds}
      releaseNotesLength={releaseNotesLength}
      getHighestReleaseBranch={getHighestReleaseBranch}
      qualitySuiteName={qualitySuiteName}
      onPublish={onPublish}
      onClose={() => modal.setOpen(false)}
      onDeployTargetChange={modal.setDeployTarget}
      onPublishBranchChange={modal.setPublishBranch}
      onGateBuildNumberChange={modal.setGateBuildNumber}
      onVerificationPasswordChange={modal.setVerificationPassword}
      onReleaseNotesChange={modal.setReleaseNotes}
      onRefreshBranches={onRefreshBranches}
      onOpenUrl={onOpenUrl}
      onGateOverrideReasonChange={modal.setGateOverrideReason}
      onRunMissingSuite={onRunMissingSuite}
    />
  );
}
