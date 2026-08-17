import { useState } from 'react';
import { message } from 'antd';

import {
  JenkinsQualityArtifactPreview,
  JenkinsQualityBuild,
  JenkinsQualityListResult,
  JenkinsQualityPerformanceSamples,
  jenkinsApi,
} from '../../services/api';
import {
  getBusinessFlowReportUrl,
  getPerformanceSamplesUrl,
  hasPerformanceReport,
  isBusinessFlowQualityBuild,
} from './qualityReportUtils';
import { QualitySummaryView } from './qualityReportTypes';

interface UseQualityReportModalParams {
  loadQualityBuilds: (options?: { silent?: boolean }) => Promise<JenkinsQualityListResult | null>;
}

export function useQualityReportModal({ loadQualityBuilds }: UseQualityReportModalParams) {
  const [build, setBuild] = useState<JenkinsQualityBuild | null>(null);
  const [activeView, setActiveView] = useState<QualitySummaryView>('performance');
  const [artifactPreview, setArtifactPreview] = useState<(JenkinsQualityArtifactPreview & { title: string }) | null>(null);
  const [artifactPreviewLoading, setArtifactPreviewLoading] = useState(false);
  const [logDigest, setLogDigest] = useState<JenkinsQualityArtifactPreview | null>(null);
  const [logDigestLoading, setLogDigestLoading] = useState(false);
  const [performanceSamples, setPerformanceSamples] = useState<JenkinsQualityPerformanceSamples | null>(null);
  const [performanceLoading, setPerformanceLoading] = useState(false);

  const previewArtifact = async (title: string, url?: string) => {
    if (!url) return;
    setArtifactPreviewLoading(true);
    try {
      const response = await jenkinsApi.previewQualityArtifact(url);
      setPerformanceSamples(null);
      setArtifactPreview({
        ...(response.data || { url, content: '' }),
        title,
      });
    } catch (err: any) {
      message.error(err?.error || err?.message || '读取结果文件失败');
    } finally {
      setArtifactPreviewLoading(false);
    }
  };

  const loadLogDigest = async (url?: string) => {
    if (!url) {
      setLogDigest(null);
      return;
    }
    setLogDigestLoading(true);
    try {
      const response = await jenkinsApi.previewQualityArtifact(url);
      setLogDigest(response.data || null);
    } catch {
      setLogDigest(null);
    } finally {
      setLogDigestLoading(false);
    }
  };

  const openPerformance = async (url?: string) => {
    setActiveView('performance');
    setArtifactPreview(null);
    setPerformanceSamples(null);
    if (!url) {
      setPerformanceLoading(false);
      return;
    }
    setPerformanceLoading(true);
    try {
      const response = await jenkinsApi.getQualityPerformanceSamples(url);
      setPerformanceSamples(response.data || null);
    } catch (err: any) {
      message.error(err?.error || err?.message || '读取性能采样失败');
    } finally {
      setPerformanceLoading(false);
    }
  };

  const open = async (record: JenkinsQualityBuild) => {
    setBuild(record);
    setArtifactPreview(null);
    setLogDigest(null);
    setPerformanceSamples(null);
    if (isBusinessFlowQualityBuild(record)) {
      setActiveView('business_flow');
      const businessFlowReportUrl = getBusinessFlowReportUrl(record);
      if (businessFlowReportUrl) {
        previewArtifact('业务编排报告', businessFlowReportUrl);
      }
    }
    if (hasPerformanceReport(record)) {
      setActiveView('performance');
      setPerformanceLoading(Boolean(getPerformanceSamplesUrl(record)));
    }

    const nextData = await loadQualityBuilds({ silent: true });
    const latestBuild = nextData?.builds?.find((item) => item.number === record.number);
    const displayBuild = latestBuild || record;
    setBuild(displayBuild);
    if (isBusinessFlowQualityBuild(displayBuild)) {
      setActiveView('business_flow');
      const businessFlowReportUrl = getBusinessFlowReportUrl(displayBuild);
      if (businessFlowReportUrl) {
        await previewArtifact('业务编排报告', businessFlowReportUrl);
      }
      return;
    }
    if (hasPerformanceReport(displayBuild)) {
      await openPerformance(getPerformanceSamplesUrl(displayBuild));
    } else {
      setActiveView('log');
    }
  };

  const close = () => {
    setBuild(null);
    setActiveView('performance');
    setArtifactPreview(null);
    setLogDigest(null);
    setPerformanceSamples(null);
  };

  return {
    build,
    activeView,
    artifactPreview,
    artifactPreviewLoading,
    logDigest,
    logDigestLoading,
    performanceSamples,
    performanceLoading,
    setBuild,
    setActiveView,
    setArtifactPreview,
    setPerformanceSamples,
    open,
    close,
    previewArtifact,
    loadLogDigest,
    openPerformance,
  };
}
