import { Alert } from 'antd';
import { ReactNode } from 'react';

import { JenkinsQualityBuild, JenkinsQualityListResult, QualityDevicePool, QualityDevicePoolStatusResult } from '../../services/api';
import { StatsCards } from './StatsCards';
import { QualityDevicePoolOverview } from './QualityDevicePoolOverview';
import { QualityBuildTable } from './QualityBuildTable';
import { buildQualityStatsCards } from './cicdStats';

interface QualitySectionProps {
  error?: string;
  data?: JenkinsQualityListResult | null;
  devicePoolStatus?: QualityDevicePoolStatusResult | null;
  devicePools: QualityDevicePool[];
  devicePoolError?: string;
  canAdmin?: boolean;
  unassignedTargetPool: string;
  addingDevicePool?: boolean;
  jobLoading?: boolean;
  sourceLoading?: boolean;
  isAdmin?: boolean;
  canUseQuality?: boolean;
  canOpenQualityModal?: boolean;
  stoppingQualityBuild?: number | null;
  publishChannelLabel: (channel?: string) => string;
  qualitySuiteLabel: (summary?: JenkinsQualityBuild['qualitySummary']) => string;
  qualityPhaseLabel: (build: JenkinsQualityBuild) => string;
  qualityResultTag: (build: JenkinsQualityBuild) => ReactNode;
  isQualityBuildEffectivelyRunning: (build: JenkinsQualityBuild) => boolean;
  progressPercent: (build: JenkinsQualityBuild) => number;
  progressStatus: (build: JenkinsQualityBuild) => 'success' | 'exception' | 'normal' | 'active';
  progressElapsedSeconds: (build: JenkinsQualityBuild) => number;
  progressRemainingSeconds: (build: JenkinsQualityBuild) => number | null | undefined;
  formatSeconds: (value?: number | null) => string;
  formatBuildTime: (timestamp: number) => ReactNode;
  onUnassignedTargetPoolChange: (pool: string) => void;
  onAddUnassignedDevices: () => void;
  onOpenUrl: (url?: string) => void;
  onOpenQualityModal: (build?: JenkinsQualityBuild) => void;
  onOpenQualityReport: (build: JenkinsQualityBuild) => void;
  onStopQualityBuild: (buildNumber: number, deviceUdid?: string) => void;
}

export function QualitySection({
  error,
  data,
  devicePoolStatus,
  devicePools,
  devicePoolError,
  canAdmin,
  unassignedTargetPool,
  addingDevicePool,
  jobLoading,
  sourceLoading,
  isAdmin,
  canUseQuality,
  canOpenQualityModal,
  stoppingQualityBuild,
  publishChannelLabel,
  qualitySuiteLabel,
  qualityPhaseLabel,
  qualityResultTag,
  isQualityBuildEffectivelyRunning,
  progressPercent,
  progressStatus,
  progressElapsedSeconds,
  progressRemainingSeconds,
  formatSeconds,
  formatBuildTime,
  onUnassignedTargetPoolChange,
  onAddUnassignedDevices,
  onOpenUrl,
  onOpenQualityModal,
  onOpenQualityReport,
  onStopQualityBuild,
}: QualitySectionProps) {
  return (
    <>
      {error && (
        <Alert
          type="error"
          showIcon
          message="自动质检操作失败"
          description={error}
          style={{ marginBottom: 16 }}
        />
      )}
      <StatsCards stats={buildQualityStatsCards(data)} />
      <QualityDevicePoolOverview
        error={devicePoolError}
        status={devicePoolStatus}
        pools={devicePools}
        canAdmin={canAdmin}
        unassignedTargetPool={unassignedTargetPool}
        adding={addingDevicePool}
        onUnassignedTargetPoolChange={onUnassignedTargetPoolChange}
        onAddUnassignedDevices={onAddUnassignedDevices}
      />
      <QualityBuildTable
        jobFullName={data?.job.fullName}
        jobBuildable={data?.job.buildable}
        loading={jobLoading}
        sourceLoading={sourceLoading}
        builds={data?.builds || []}
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
        onOpenUrl={onOpenUrl}
        onOpenQualityModal={onOpenQualityModal}
        onOpenQualityReport={onOpenQualityReport}
        onStopQualityBuild={onStopQualityBuild}
      />
    </>
  );
}
