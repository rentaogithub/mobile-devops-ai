import { Alert } from 'antd';
import { ReactNode } from 'react';

import { JenkinsBuild, JenkinsBuildListResult } from '../../services/api';
import { DeployTarget } from './qualityOptions';
import { StatsCards } from './StatsCards';
import { ReleaseBuildTable } from './ReleaseBuildTable';
import { buildReleaseStatsCards } from './cicdStats';

interface ReleaseSectionProps {
  error?: string;
  data?: JenkinsBuildListResult | null;
  stats: JenkinsBuildListResult['stats'];
  loading?: boolean;
  builds: JenkinsBuild[];
  isAdmin?: boolean;
  canUseQuality?: boolean;
  canPublishPgyerOrTestFlight?: boolean;
  canPublishAppStore?: boolean;
  stoppingBuild?: number | null;
  cancelingAppStoreReview?: number | null;
  filterBranchName: string;
  filterDeployTarget: DeployTarget | '';
  branchLoading?: boolean;
  branchOptions: Array<{ value: string; label: string }>;
  deployTargetOptions: Array<{ label: string; value: DeployTarget }>;
  publishChannelLabel: (channel?: string) => string;
  getChannelBuildNumber: (build: JenkinsBuild) => string;
  formatBuildTime: (timestamp: number) => ReactNode;
  formatDuration: (duration: number, building: boolean) => ReactNode;
  renderBuildStatus: (build: JenkinsBuild) => ReactNode;
  onBranchFilterChange: (branchName: string) => void;
  onDeployTargetFilterChange: (target: DeployTarget | '') => void;
  onOpenUrl: (url?: string) => void;
  onShowBuildLog: (build: JenkinsBuild) => void;
  onOpenQuality: (build: JenkinsBuild) => void;
  onOpenPgyerPublish: (build: JenkinsBuild) => void;
  onCancelAppStoreReview: (buildNumber: number) => void;
  onStopBuild: (buildNumber: number) => void;
  onQrPreview: (preview: { url: string; channel?: string; buildNumber?: string; branchName?: string }) => void;
}

export function ReleaseSection({
  error,
  data,
  stats,
  loading,
  builds,
  isAdmin,
  canUseQuality,
  canPublishPgyerOrTestFlight,
  canPublishAppStore,
  stoppingBuild,
  cancelingAppStoreReview,
  filterBranchName,
  filterDeployTarget,
  branchLoading,
  branchOptions,
  deployTargetOptions,
  publishChannelLabel,
  getChannelBuildNumber,
  formatBuildTime,
  formatDuration,
  renderBuildStatus,
  onBranchFilterChange,
  onDeployTargetFilterChange,
  onOpenUrl,
  onShowBuildLog,
  onOpenQuality,
  onOpenPgyerPublish,
  onCancelAppStoreReview,
  onStopBuild,
  onQrPreview,
}: ReleaseSectionProps) {
  return (
    <>
      {error && (
        <Alert
          type="error"
          showIcon
          message="Jenkins 操作失败"
          description={error}
          style={{ marginBottom: 16 }}
        />
      )}

      <StatsCards stats={buildReleaseStatsCards(stats)} />

      <ReleaseBuildTable
        jobFullName={data?.job.fullName}
        jobBuildable={data?.job.buildable}
        loading={loading}
        builds={builds}
        isAdmin={isAdmin}
        canUseQuality={canUseQuality}
        canPublishPgyerOrTestFlight={canPublishPgyerOrTestFlight}
        canPublishAppStore={canPublishAppStore}
        stoppingBuild={stoppingBuild}
        cancelingAppStoreReview={cancelingAppStoreReview}
        filterBranchName={filterBranchName}
        filterDeployTarget={filterDeployTarget}
        branchLoading={branchLoading}
        branchOptions={branchOptions}
        deployTargetOptions={deployTargetOptions}
        publishChannelLabel={publishChannelLabel}
        getChannelBuildNumber={getChannelBuildNumber}
        formatBuildTime={formatBuildTime}
        formatDuration={formatDuration}
        renderBuildStatus={renderBuildStatus}
        onBranchFilterChange={onBranchFilterChange}
        onDeployTargetFilterChange={onDeployTargetFilterChange}
        onOpenUrl={onOpenUrl}
        onShowBuildLog={onShowBuildLog}
        onOpenQuality={onOpenQuality}
        onOpenPgyerPublish={onOpenPgyerPublish}
        onCancelAppStoreReview={onCancelAppStoreReview}
        onStopBuild={onStopBuild}
        onQrPreview={onQrPreview}
      />
    </>
  );
}
