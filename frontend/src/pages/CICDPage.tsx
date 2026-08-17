import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { message } from 'antd';
import { JenkinsBuild } from '../services/api';
import appleDeviceEnrollGuide from '../assets/apple-device-enroll-guide.svg';
import { CicdHealthPanel } from './cicd/CicdHealthPanel';
import { CICDSection, CicdPageHeader, getCicdPageMeta, getCicdSectionFromPath } from './cicd/CicdPageHeader';
import { ReleaseBranchModal } from './cicd/ReleaseBranchModal';
import { BuildLogModal } from './cicd/BuildLogModal';
import { InstallQrModal } from './cicd/InstallQrModal';
import { ReleaseSection } from './cicd/ReleaseSection';
import { QualitySection } from './cicd/QualitySection';
import { AppleDeviceSection } from './cicd/AppleDeviceSection';
import { QualityStartModal } from './cicd/QualityStartModal';
import { DevicePoolModal } from './cicd/DevicePoolModal';
import { ReleasePublishModal } from './cicd/ReleasePublishModal';
import { QualityReportModal } from './cicd/QualityReportModal';
import {
  formatBuildTime,
  formatDuration,
  formatMilliseconds,
  formatSeconds,
  getChannelBuildNumber,
  getHighestReleaseBranch,
  releaseNotesLength,
} from './cicd/cicdFormatters';
import { normalizeOpenUrl, openExternalUrl, openPerformanceTrace } from './cicd/cicdUrlUtils';
import { getReleaseValidationState } from './cicd/releaseValidationState';
import { getQualityReportDisplayMeta } from './cicd/qualityReportUtils';
import { getCicdPermissions } from './cicd/cicdPermissions';
import { useBuildLogModal } from './cicd/useBuildLogModal';
import { useCicdDerivedOptions } from './cicd/useCicdDerivedOptions';
import { useCicdHealth } from './cicd/useCicdHealth';
import { useCicdPageRouting } from './cicd/useCicdPageRouting';
import { useReleaseValidation } from './cicd/useReleaseValidation';
import { useReleaseBranchModal } from './cicd/useReleaseBranchModal';
import { useAppleDeviceRegistration } from './cicd/useAppleDeviceRegistration';
import { useQualityBuilds } from './cicd/useQualityBuilds';
import { useQualityBuildPolling } from './cicd/useQualityBuildPolling';
import { useQualityDeviceSelection } from './cicd/useQualityDeviceSelection';
import { useQualityDevicePools } from './cicd/useQualityDevicePools';
import { useQualityReportModal } from './cicd/useQualityReportModal';
import { useQualityReportSync } from './cicd/useQualityReportSync';
import { useQualityStartModal } from './cicd/useQualityStartModal';
import { useQualityTrigger } from './cicd/useQualityTrigger';
import { useReleaseBranches } from './cicd/useReleaseBranches';
import { useReleaseBuildPolling } from './cicd/useReleaseBuildPolling';
import { useReleaseBuilds } from './cicd/useReleaseBuilds';
import { useReleasePublishModal } from './cicd/useReleasePublishModal';
import { useReleasePublishSync } from './cicd/useReleasePublishSync';
import { useReleasePublisher } from './cicd/useReleasePublisher';
import {
  BUSINESS_FLOW_FEATURE_GROUPS,
  DEPLOY_TARGET_OPTIONS,
  MONKEY_DURATION_OPTIONS,
  QUALITY_SUITE_GROUPS,
  STUTTER_SCENARIO_OPTIONS,
  DeployTarget,
  filterDeployTargetOptions,
  publishChannelLabel,
  qualitySuiteLabel,
  qualitySuiteName,
  shouldUseInstalledProductionApp,
  stutterScenarioLabel,
} from './cicd/qualityOptions';
import {
  devicePoolDevicesText,
  parseDevicePoolDevices,
} from './cicd/devicePoolUtils';
import {
  buildStatusTags,
  formatMonkeyExecutionSummary,
  formatQualityDuration,
  hasQualityReportArtifact,
  isQualityBuildEffectivelyRunning,
  progressElapsedSeconds,
  progressPercent,
  progressRemainingSeconds,
  progressStatus,
  qualityPhaseLabel,
  qualityResultTag,
  qualitySummaryStatusMeta,
} from './cicd/qualityStatus';

export default function CICDPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const initialSection: CICDSection = getCicdSectionFromPath(location.pathname);
  const [activeSection, setActiveSection] = useState<CICDSection>(initialSection);
  const [qrPreview, setQrPreview] = useState<{ url: string; channel?: string; buildNumber?: string; branchName?: string } | null>(null);
  const [filterDeployTarget, setFilterDeployTarget] = useState<DeployTarget | ''>('');
  const [filterBranchName, setFilterBranchName] = useState('');
  const buildLogModal = useBuildLogModal();
  const {
    isAdmin,
    canPublishPgyerOrTestFlight,
    canUseQuality,
    canPublishAppStore,
    canOperateCicd,
    canAdminCicd,
    canCreateReleaseBranch,
  } = getCicdPermissions();
  const releasePublishModal = useReleasePublishModal();
  const {
    open: publishModalOpen,
    publishing,
    deployTarget,
    publishBranch,
    verificationPassword,
    gateBuildNumber: publishGateBuildNumber,
    gateOverrideReason: releaseGateOverrideReason,
    releaseNotes: testFlightWhatsNew,
    resolvedPublishAppVersion,
    setOpen: setPublishModalOpen,
    setPublishing,
    setDeployTarget,
    setPublishBranch,
    setVerificationPassword,
    setGateBuildNumber: setPublishGateBuildNumber,
    setGateOverrideReason: setReleaseGateOverrideReason,
    setReleaseNotes: setTestFlightWhatsNew,
  } = releasePublishModal;
  const cicdHealth = useCicdHealth(activeSection === 'release' && canOperateCicd);
  const releaseBuilds = useReleaseBuilds({
    canUseQuality,
    filterDeployTarget,
    filterBranchName,
    onAppStoreReleaseUpdate: buildLogModal.updateSelectedBuildAppStoreRelease,
  });
  const {
    data,
    loading,
    error,
    stoppingBuild,
    cancelingAppStoreReview,
    loadBuilds,
    refreshBuildsUntilUpdated,
    stopBuild,
    cancelAppStoreReview,
  } = releaseBuilds;
  const qualityStartModal = useQualityStartModal();
  const appleDeviceRegistration = useAppleDeviceRegistration({
    active: activeSection === 'devices',
    canAdmin: canAdminCicd,
  });
  const qualityDevicePools = useQualityDevicePools({
    canAdmin: canAdminCicd,
    selectedPoolValue: qualityStartModal.devicePool,
    onSelectedPoolChange: qualityStartModal.setDevicePool,
  });
  const availableDeployTargetOptions = useMemo(
    () => filterDeployTargetOptions(DEPLOY_TARGET_OPTIONS, { canPublishAppStore, canPublishPgyerOrTestFlight }),
    [canPublishAppStore, canPublishPgyerOrTestFlight],
  );
  const firstAvailableDeployTarget = availableDeployTargetOptions[0]?.value;
  const releaseBranches = useReleaseBranches({
    deployTarget,
    onPublishBranchChange: setPublishBranch,
  });
  const { branches, loading: branchLoading, loadBranches } = releaseBranches;
  const releaseValidation = useReleaseValidation({
    publishModalOpen,
    deployTarget,
    publishBranch,
    resolvedPublishAppVersion,
    publishGateBuildNumber,
    testFlightWhatsNew,
    canOperateCicd,
    canPublishAppStore,
  });
  const {
    gatePreview: releaseGatePreview,
    gateMissingSuites: releaseGateMissingSuites,
    gatePreviewLoading: releaseGatePreviewLoading,
    preflight: releasePreflight,
    preflightLoading: releasePreflightLoading,
    preflightError: releasePreflightError,
    appStoreReleaseGuard,
    appStoreReleaseGuardLoading,
    appStoreReleaseGuardError,
  } = releaseValidation;

  const qualityBuilds = useQualityBuilds({
    canAdmin: canAdminCicd,
    canUseQuality,
    refreshSourceBuilds: () => loadBuilds('', { silent: true }, ''),
    refreshDevicePools: qualityDevicePools.loadPools,
  });
  const {
    data: qualityData,
    loading: qualityLoading,
    error: qualityError,
    jobSyncing: qualityJobSyncing,
    stoppingBuild: stoppingQualityBuild,
    cleaningWda: cleaningQualityWda,
    hasRunningBuild: hasRunningQualityBuild,
    loadBuilds: loadQualityBuilds,
    refreshSection: refreshQualitySection,
    refreshUntilUpdated: refreshQualityBuildsUntilUpdated,
    syncJobConfig: syncQualityJobConfig,
    stopBuild: stopQualityBuild,
    cleanupWda: cleanupQualityWda,
    clearError: clearQualityError,
  } = qualityBuilds;

  const qualityReportModal = useQualityReportModal({ loadQualityBuilds });

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
      builds: data?.builds,
      pools: qualityDevicePools.pools,
    });
  };

  useCicdPageRouting({
    pathname: location.pathname,
    search: location.search,
    navigate,
    activeSection,
    setActiveSection,
    canUseQuality,
    builds: data,
    branches,
    loadBuilds,
    loadBranches,
    refreshQualitySection,
    refreshDevicesSection: appleDeviceRegistration.refreshSection,
    clearQualityError,
    showBuildLog: buildLogModal.showBuildLog,
  });

  useReleasePublishSync({
    publishModalOpen,
    branches,
    deployTarget,
    availableDeployTargetOptions,
    firstAvailableDeployTarget,
    loadBranches,
    syncReleaseBranchFromBranches: releasePublishModal.syncReleaseBranchFromBranches,
    syncAvailableTargets: releasePublishModal.syncAvailableTargets,
  });

  useQualityReportSync({
    build: qualityReportModal.build,
    qualityData,
    setBuild: qualityReportModal.setBuild,
    loadQualityBuilds,
    loadLogDigest: qualityReportModal.loadLogDigest,
  });

  useReleaseBuildPolling({
    active: activeSection === 'release',
    data,
    filterDeployTarget,
    filterBranchName,
    loadBuilds,
  });
  const {
    appStoreGatePending,
    appStoreGateBlocked,
    appStoreGateWarningNeedsReason,
    releasePreflightBlocked,
  } = getReleaseValidationState({
    deployTarget,
    gateBuildNumber: publishGateBuildNumber,
    gatePreview: releaseGatePreview,
    gatePreviewLoading: releaseGatePreviewLoading,
    gateOverrideReason: releaseGateOverrideReason,
    preflight: releasePreflight,
    preflightError: releasePreflightError,
  });
  const { publish } = useReleasePublisher({
    canPublishPgyerOrTestFlight,
    canPublishAppStore,
    deployTarget,
    publishBranch,
    resolvedPublishAppVersion,
    verificationPassword,
    gateBuildNumber: publishGateBuildNumber,
    gateOverrideReason: releaseGateOverrideReason,
    releaseNotes: testFlightWhatsNew,
    gatePreview: releaseGatePreview,
    gatePreviewLoading: releaseGatePreviewLoading,
    preflight: releasePreflight,
    preflightLoading: releasePreflightLoading,
    preflightError: releasePreflightError,
    preflightBlocked: releasePreflightBlocked,
    data,
    filterDeployTarget,
    onFilterDeployTargetChange: setFilterDeployTarget,
    onPublishingChange: setPublishing,
    onPublished: releasePublishModal.resetAfterPublish,
    refreshBuildsUntilUpdated,
  });
  const {
    stats,
    canOpenQualityModal,
    publishBranchOptions,
    buildBranchFilterOptions,
    publishGateBuildOptions,
    releaseBaseBranchOptions,
  } = useCicdDerivedOptions({
    branches,
    data,
    deployTarget,
    publishBranch,
    canUseQuality,
    loading,
  });
  const qualityDeviceSelection = useQualityDeviceSelection({
    pools: qualityDevicePools.pools,
    selectedPoolValue: qualityStartModal.devicePool,
    modalOpen: qualityStartModal.open,
    setDeviceUdids: qualityStartModal.setDeviceUdids,
  });
  const {
    availablePools: availableQualityDevicePools,
    selectedPool: selectedQualityPool,
    availableDevices: availableQualityDevices,
  } = qualityDeviceSelection;
  const { triggerQuality } = useQualityTrigger({
    canUseQuality,
    form: qualityStartModal,
    selectedPool: selectedQualityPool,
    availableDevices: availableQualityDevices,
    qualityData,
    onSubmittingChange: qualityStartModal.setSubmitting,
    onSubmitMessageChange: qualityStartModal.setSubmitMessage,
    onSubmitted: qualityStartModal.close,
    refreshSection: refreshQualitySection,
    refreshUntilUpdated: refreshQualityBuildsUntilUpdated,
  });

  useQualityBuildPolling({
    activeSection,
    hasRunningQualityBuild,
    refreshQualitySection,
    loadDevicePools: qualityDevicePools.loadPools,
  });

  const releaseBranchModal = useReleaseBranchModal({
    canCreateReleaseBranch,
    baseBranchOptions: releaseBaseBranchOptions,
    loadBranches,
    onCreated: setPublishBranch,
  });
  const pageMeta = getCicdPageMeta(activeSection);
  const qualityReportMeta = getQualityReportDisplayMeta(qualityReportModal.build);
  return (
    <div>
      <CicdPageHeader
        activeSection={activeSection}
        title={pageMeta.title}
        description={pageMeta.description}
        cicdHealth={cicdHealth.health}
        cicdHealthLoading={cicdHealth.loading}
        canCreateReleaseBranch={canCreateReleaseBranch}
        canOperateCicd={canOperateCicd}
        canAdminCicd={canAdminCicd}
        canUseQuality={canUseQuality}
        canOpenQualityModal={canOpenQualityModal}
        loading={loading}
        publishing={publishing}
        qualityLoading={qualityLoading}
        qualityJobSyncing={qualityJobSyncing}
        onToggleHealth={cicdHealth.toggleHealth}
        onOpenReleaseBranchModal={releaseBranchModal.openModal}
        onRefreshBuilds={() => loadBuilds()}
        onOpenPublishModal={openPublishModal}
        onSyncQualityJobConfig={syncQualityJobConfig}
        onOpenDevicePoolModal={qualityDevicePools.openModal}
        onRefreshQuality={() => refreshQualitySection()}
        onOpenQualityModal={() => openQualityModal()}
      />

      {activeSection === 'release' && cicdHealth.open && (
        <CicdHealthPanel health={cicdHealth.health} loading={cicdHealth.loading} />
      )}

      {activeSection === 'release' ? (
        <ReleaseSection
          error={error}
          data={data}
          stats={stats}
          loading={loading}
          builds={data?.builds || []}
          isAdmin={isAdmin}
          canUseQuality={canUseQuality}
          canPublishPgyerOrTestFlight={canPublishPgyerOrTestFlight}
          canPublishAppStore={canPublishAppStore}
          stoppingBuild={stoppingBuild}
          cancelingAppStoreReview={cancelingAppStoreReview}
          filterBranchName={filterBranchName}
          filterDeployTarget={filterDeployTarget}
          branchLoading={branchLoading}
          branchOptions={buildBranchFilterOptions}
          deployTargetOptions={DEPLOY_TARGET_OPTIONS}
          publishChannelLabel={publishChannelLabel}
          getChannelBuildNumber={getChannelBuildNumber}
          formatBuildTime={formatBuildTime}
          formatDuration={formatDuration}
          renderBuildStatus={buildStatusTags}
          onBranchFilterChange={(nextBranch) => {
            setFilterBranchName(nextBranch);
            loadBuilds(filterDeployTarget, undefined, nextBranch);
          }}
          onDeployTargetFilterChange={(value) => {
            setFilterDeployTarget(value);
            loadBuilds(value, undefined, filterBranchName);
          }}
          onOpenUrl={openExternalUrl}
          onShowBuildLog={buildLogModal.showBuildLog}
          onOpenQuality={openQualityModal}
          onOpenPgyerPublish={openPgyerPublish}
          onCancelAppStoreReview={cancelAppStoreReview}
          onStopBuild={stopBuild}
          onQrPreview={setQrPreview}
        />
      ) : activeSection === 'quality' ? (
        <QualitySection
          error={qualityError}
          data={qualityData}
          devicePoolStatus={qualityDevicePools.status}
          devicePools={qualityDevicePools.pools}
          canAdmin={canAdminCicd}
          unassignedTargetPool={qualityDevicePools.unassignedTargetPool}
          addingDevicePool={qualityDevicePools.adding}
          jobLoading={qualityLoading}
          sourceLoading={loading}
          isAdmin={isAdmin}
          canUseQuality={canUseQuality}
          canOpenQualityModal={canOpenQualityModal}
          stoppingQualityBuild={stoppingQualityBuild}
          publishChannelLabel={publishChannelLabel}
          qualitySuiteLabel={qualitySuiteLabel}
          qualityPhaseLabel={qualityPhaseLabel}
          qualityResultTag={qualityResultTag}
          isQualityBuildEffectivelyRunning={isQualityBuildEffectivelyRunning}
          progressPercent={progressPercent}
          progressStatus={progressStatus}
          progressElapsedSeconds={progressElapsedSeconds}
          progressRemainingSeconds={progressRemainingSeconds}
          formatSeconds={formatSeconds}
          formatBuildTime={formatBuildTime}
          onUnassignedTargetPoolChange={qualityDevicePools.setUnassignedTargetPool}
          onAddUnassignedDevices={qualityDevicePools.addUnassignedDevicesToPool}
          onOpenUrl={openExternalUrl}
          onOpenQualityModal={openQualityModal}
          onOpenQualityReport={(record) => {
            void qualityReportModal.open(record);
          }}
          onStopQualityBuild={stopQualityBuild}
        />
      ) : (
        <AppleDeviceSection
          isAdmin={isAdmin}
          enrollment={appleDeviceRegistration.enrollment}
          enrollmentState={appleDeviceRegistration.enrollmentState}
          enrollmentLoading={appleDeviceRegistration.enrollmentLoading}
          deviceUdid={appleDeviceRegistration.deviceUdid}
          guideImage={appleDeviceEnrollGuide}
          registrationResult={appleDeviceRegistration.registrationInlineResult}
          lookupLoading={appleDeviceRegistration.deviceLookupLoading}
          registering={appleDeviceRegistration.registering}
          registeredDevice={appleDeviceRegistration.registeredDevice}
          registrationRequests={appleDeviceRegistration.registrationRequests}
          registrationRequestsLoading={appleDeviceRegistration.registrationRequestsLoading}
          approvingRequestId={appleDeviceRegistration.approvingRegistrationRequest}
          developerDevices={appleDeviceRegistration.developerDevices}
          filteredDeveloperDevices={appleDeviceRegistration.filteredDeveloperDevices}
          developerDevicesLoading={appleDeviceRegistration.developerDevicesLoading}
          developerDevicesError={appleDeviceRegistration.developerDevicesError}
          developerDeviceKeyword={appleDeviceRegistration.developerDeviceKeyword}
          configStatus={appleDeviceRegistration.configStatus}
          configStatusLoading={appleDeviceRegistration.configStatusLoading}
          configSaving={appleDeviceRegistration.configSaving}
          configKeyId={appleDeviceRegistration.configKeyId}
          configIssuerId={appleDeviceRegistration.configIssuerId}
          configKeyPath={appleDeviceRegistration.configKeyPath}
          configKeyFile={appleDeviceRegistration.configKeyFile}
          onCreateEnrollment={appleDeviceRegistration.createEnrollment}
          onTabChange={(key) => {
            if (key === 'requests') void appleDeviceRegistration.loadRegistrationRequests();
            if (key === 'devices') void appleDeviceRegistration.loadDeveloperDevices();
            if (key === 'config') void appleDeviceRegistration.loadConfigStatus();
          }}
          onLoadRegistrationRequests={appleDeviceRegistration.loadRegistrationRequests}
          onApproveRegistrationRequest={appleDeviceRegistration.approveRegistrationRequest}
          onLoadDeveloperDevices={appleDeviceRegistration.loadDeveloperDevices}
          onDeveloperDeviceKeywordChange={appleDeviceRegistration.setDeveloperDeviceKeyword}
          onLoadConfigStatus={appleDeviceRegistration.loadConfigStatus}
          onSaveConfig={appleDeviceRegistration.saveConfig}
          onConfigKeyIdChange={appleDeviceRegistration.setConfigKeyId}
          onConfigIssuerIdChange={appleDeviceRegistration.setConfigIssuerId}
          onConfigKeyPathChange={appleDeviceRegistration.setConfigKeyPath}
          onConfigKeyFileChange={appleDeviceRegistration.setConfigKeyFile}
        />
	      )}

      <ReleaseBranchModal
        open={releaseBranchModal.open}
        creating={releaseBranchModal.creating}
        branchName={releaseBranchModal.branchName}
        baseBranch={releaseBranchModal.baseBranch}
        baseBranchOptions={releaseBaseBranchOptions}
        branchLoading={branchLoading}
        log={releaseBranchModal.log}
        onBranchNameChange={releaseBranchModal.setBranchName}
        onBaseBranchChange={releaseBranchModal.setBaseBranch}
        onRefreshBranches={loadBranches}
        onSubmit={releaseBranchModal.createReleaseBranch}
        onClose={releaseBranchModal.closeModal}
      />

      <ReleasePublishModal
        open={publishModalOpen}
        publishing={publishing}
        canOperateCicd={canOperateCicd}
        canPublishPgyerOrTestFlight={canPublishPgyerOrTestFlight}
        canPublishAppStore={canPublishAppStore}
        deployTarget={deployTarget}
        deployTargetOptions={availableDeployTargetOptions}
        publishBranch={publishBranch}
        publishBranchOptions={publishBranchOptions}
        branchLoading={branchLoading}
        branches={branches}
        resolvedPublishAppVersion={resolvedPublishAppVersion}
        appStoreReleaseGuard={appStoreReleaseGuard}
        appStoreReleaseGuardLoading={appStoreReleaseGuardLoading}
        appStoreReleaseGuardError={appStoreReleaseGuardError}
        releasePreflight={releasePreflight}
        releasePreflightLoading={releasePreflightLoading}
        releasePreflightError={releasePreflightError}
        releasePreflightBlocked={releasePreflightBlocked}
        appStoreGatePending={appStoreGatePending}
        appStoreGateBlocked={appStoreGateBlocked}
        appStoreGateWarningNeedsReason={appStoreGateWarningNeedsReason}
        verificationPassword={verificationPassword}
        releaseNotes={testFlightWhatsNew}
        gateBuildNumber={publishGateBuildNumber}
        gateBuildOptions={publishGateBuildOptions}
        gatePreview={releaseGatePreview}
        gatePreviewLoading={releaseGatePreviewLoading}
        gateMissingSuites={releaseGateMissingSuites}
        gateOverrideReason={releaseGateOverrideReason}
        sourceBuilds={data?.builds || []}
        releaseNotesLength={releaseNotesLength}
        getHighestReleaseBranch={getHighestReleaseBranch}
        qualitySuiteName={qualitySuiteName}
        onPublish={publish}
        onClose={() => setPublishModalOpen(false)}
        onDeployTargetChange={setDeployTarget}
        onPublishBranchChange={setPublishBranch}
        onGateBuildNumberChange={setPublishGateBuildNumber}
        onVerificationPasswordChange={setVerificationPassword}
        onReleaseNotesChange={setTestFlightWhatsNew}
        onRefreshBranches={loadBranches}
        onOpenUrl={openExternalUrl}
        onGateOverrideReasonChange={setReleaseGateOverrideReason}
        onRunMissingSuite={(build, suite) => {
          setPublishModalOpen(false);
          openQualityModal(build);
          if (suite) qualityStartModal.setSuite(suite);
        }}
      />

      <QualityStartModal
        open={qualityStartModal.open}
        submitting={qualityStartModal.submitting}
        submitMessage={qualityStartModal.submitMessage}
        builds={data?.builds || []}
        selectedBuild={qualityStartModal.build}
        qualitySuite={qualityStartModal.suite}
        qualitySuiteGroups={QUALITY_SUITE_GROUPS}
        durationOptions={MONKEY_DURATION_OPTIONS}
        durationSeconds={qualityStartModal.durationSeconds}
        stutterScenarioOptions={STUTTER_SCENARIO_OPTIONS}
        stutterScenario={qualityStartModal.stutterScenario}
        businessFlowFeatureGroups={BUSINESS_FLOW_FEATURE_GROUPS}
        businessFlowFeatures={qualityStartModal.businessFlowFeatures}
        skipInstall={qualityStartModal.skipInstall}
        availableDevicePools={availableQualityDevicePools}
        availableDevices={availableQualityDevices}
        selectedDeviceUdids={qualityStartModal.deviceUdids}
        publishChannelLabel={publishChannelLabel}
        shouldUseInstalledProductionApp={shouldUseInstalledProductionApp}
        onBuildChange={qualityStartModal.setBuild}
        onQualitySuiteChange={qualityStartModal.setSuite}
        onDurationChange={qualityStartModal.setDurationSeconds}
        onStutterScenarioChange={qualityStartModal.setStutterScenario}
        onBusinessFlowFeaturesChange={qualityStartModal.setBusinessFlowFeatures}
        onSkipInstallChange={qualityStartModal.setSkipInstall}
        onDeviceUdidsChange={qualityStartModal.setDeviceUdids}
        onSubmit={triggerQuality}
        onClose={qualityStartModal.close}
      />

      <QualityReportModal
        build={qualityReportModal.build}
        title={qualityReportMeta.title}
        activeView={qualityReportModal.activeView}
        isMonkeyReport={qualityReportMeta.isMonkeyReport}
        isStutterReport={qualityReportMeta.isStutterReport}
        isBusinessFlowReport={qualityReportMeta.isBusinessFlowReport}
        reportKind={qualityReportMeta.kind}
        performanceButtonLabel={qualityReportMeta.performanceButtonLabel}
        performanceLoading={qualityReportModal.performanceLoading}
        artifactPreview={qualityReportModal.artifactPreview}
        artifactPreviewLoading={qualityReportModal.artifactPreviewLoading}
        logDigest={qualityReportModal.logDigest}
        logDigestLoading={qualityReportModal.logDigestLoading}
        performanceSamples={qualityReportModal.performanceSamples}
        statusMeta={qualityReportModal.build ? qualitySummaryStatusMeta(qualityReportModal.build) : null}
        stutterScenarioLabel={stutterScenarioLabel}
        formatQualityDuration={formatQualityDuration}
        formatMonkeyExecutionSummary={formatMonkeyExecutionSummary}
        formatMilliseconds={formatMilliseconds}
        formatSeconds={formatSeconds}
        isRunning={isQualityBuildEffectivelyRunning}
        hasArtifact={hasQualityReportArtifact}
        onOpenUrl={openExternalUrl}
        onOpenTrace={openPerformanceTrace}
        onClose={qualityReportModal.close}
        onSetActiveView={qualityReportModal.setActiveView}
        onSetArtifactPreview={qualityReportModal.setArtifactPreview}
        onSetPerformanceSamples={qualityReportModal.setPerformanceSamples}
        onPreviewArtifact={qualityReportModal.previewArtifact}
        onOpenPerformance={qualityReportModal.openPerformance}
      />

      <DevicePoolModal
        open={qualityDevicePools.modalOpen}
        saving={qualityDevicePools.saving}
        drafts={qualityDevicePools.drafts}
        hasRunningQualityBuild={hasRunningQualityBuild}
        cleaningQualityWda={cleaningQualityWda}
        devicePoolDevicesText={devicePoolDevicesText}
        parseDevicePoolDevices={parseDevicePoolDevices}
        onUpdateDraft={qualityDevicePools.updateDraft}
        onAddDraft={qualityDevicePools.addDraft}
        onRemoveDraft={qualityDevicePools.removeDraft}
        onCleanupWda={() => cleanupQualityWda()}
        onSave={qualityDevicePools.savePools}
        onClose={() => qualityDevicePools.setModalOpen(false)}
      />

      <BuildLogModal
        open={buildLogModal.open}
        selectedBuildLog={buildLogModal.selectedBuildLog}
        logLoading={buildLogModal.loading}
        canPublishAppStore={canPublishAppStore}
        cancelingAppStoreReview={cancelingAppStoreReview}
        buildFailureAnalysis={buildLogModal.buildFailureAnalysis}
        buildFailureAnalysisLoading={buildLogModal.buildFailureAnalysisLoading}
        packageSizeAnalysis={buildLogModal.packageSizeAnalysis}
        packageSizeLoading={buildLogModal.packageSizeLoading}
        packageSizeError={buildLogModal.packageSizeError}
        getChannelBuildNumber={getChannelBuildNumber}
        shouldUseInstalledProductionApp={shouldUseInstalledProductionApp}
        onClose={buildLogModal.closeBuildLog}
        onDownloadLog={buildLogModal.downloadBuildLog}
        onCancelAppStoreReview={cancelAppStoreReview}
        onEnsureBuildFailureAnalysis={buildLogModal.ensureBuildFailureAnalysis}
        onAnalyzeBuildFailure={buildLogModal.analyzeSelectedBuildFailure}
        onEnsurePackageSizeAnalysis={buildLogModal.ensurePackageSizeAnalysis}
      />

      <InstallQrModal
        preview={qrPreview}
        normalizeUrl={normalizeOpenUrl}
        onOpenUrl={openExternalUrl}
        onClose={() => setQrPreview(null)}
      />

    </div>
  );
}
