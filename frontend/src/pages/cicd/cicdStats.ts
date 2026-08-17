import { ReactNode } from 'react';

import { JenkinsBuildListResult, JenkinsQualityListResult } from '../../services/api';

export type StatsCardItem = {
  label: string;
  value: ReactNode;
  color: string;
};

const emptyBuildStats = {
  total: 0,
  running: 0,
  latestBuild: '-',
  successRate: '-',
};

export function getBuildStats(data?: JenkinsBuildListResult | null) {
  return data?.stats || emptyBuildStats;
}

export function buildReleaseStatsCards(stats: JenkinsBuildListResult['stats'] | typeof emptyBuildStats): StatsCardItem[] {
  return [
    { label: '最近构建数', value: stats.total, color: '#1677ff' },
    { label: '运行中', value: stats.running, color: '#52c41a' },
    { label: '最新构建', value: stats.latestBuild, color: '#722ed1' },
    { label: '成功率', value: stats.successRate, color: '#faad14' },
  ];
}

export function buildQualityStatsCards(data?: JenkinsQualityListResult | null): StatsCardItem[] {
  return [
    { label: '质检任务数', value: data?.stats.total || 0, color: '#1677ff' },
    { label: '运行中', value: data?.stats.running || 0, color: '#52c41a' },
    { label: '最新质检', value: data?.stats.latestBuild || '-', color: '#722ed1' },
    { label: '通过率', value: data?.stats.successRate || '-', color: '#faad14' },
  ];
}
