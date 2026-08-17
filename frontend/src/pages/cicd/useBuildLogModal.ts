import { useState } from 'react';
import { message } from 'antd';

import { JenkinsAppStoreRelease, JenkinsBuild, JenkinsBuildFailureAnalysis, JenkinsPackageSizeAnalysis, jenkinsApi } from '../../services/api';
import { canAnalyzeBuildFailure, downloadTextFile } from './cicdBuildUtils';
import { SelectedBuildLog } from './BuildLogModal';

export function useBuildLogModal() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [buildFailureAnalysisLoading, setBuildFailureAnalysisLoading] = useState(false);
  const [buildFailureAnalysis, setBuildFailureAnalysis] = useState<JenkinsBuildFailureAnalysis | null>(null);
  const [packageSizeAnalysis, setPackageSizeAnalysis] = useState<JenkinsPackageSizeAnalysis | null>(null);
  const [packageSizeLoading, setPackageSizeLoading] = useState(false);
  const [packageSizeError, setPackageSizeError] = useState('');
  const [selectedBuildLog, setSelectedBuildLog] = useState<SelectedBuildLog | null>(null);

  const showBuildLog = async (build: JenkinsBuild) => {
    setOpen(true);
    setBuildFailureAnalysis(null);
    setPackageSizeAnalysis(null);
    setPackageSizeError('');
    setSelectedBuildLog({ build, log: '', thirdSdkBranch: build.branchName || 'develop', thirdSdkDependencies: [] });
    setLoading(true);
    try {
      const response = await jenkinsApi.getBuildLog(build.number);
      setSelectedBuildLog({
        build: {
          ...build,
          dsymSync: response.data?.dsymSync || build.dsymSync,
          testFlightWhatsNew: response.data?.testFlightWhatsNew || build.testFlightWhatsNew,
          testFlightDistribution: response.data?.testFlightDistribution || build.testFlightDistribution,
          appStoreRelease: response.data?.appStoreRelease || build.appStoreRelease,
          releaseOrder: response.data?.releaseOrder || build.releaseOrder,
        },
        log: response.data?.log || '',
        thirdSdkBranch: response.data?.thirdSdkBranch || build.branchName || 'develop',
        thirdSdkRevision: response.data?.thirdSdkRevision,
        thirdSdkDependencies: response.data?.thirdSdkDependencies || [],
        thirdSdkMissingFiles: response.data?.thirdSdkMissingFiles || [],
        thirdSdkError: response.data?.thirdSdkError,
      });
      setBuildFailureAnalysis(response.data?.failureAnalysis || null);
    } catch (err: any) {
      message.error(err?.error || err?.message || '加载打包日志失败');
      setSelectedBuildLog({
        build,
        log: '加载打包日志失败',
        thirdSdkBranch: build.branchName || 'develop',
        thirdSdkDependencies: [],
        thirdSdkError: err?.error || err?.message || '加载打包日志失败',
      });
    } finally {
      setLoading(false);
    }
  };

  const analyzeSelectedBuildFailure = async (force = false) => {
    if (!selectedBuildLog) return;
    setBuildFailureAnalysisLoading(true);
    try {
      const response = await jenkinsApi.analyzeBuildFailure(selectedBuildLog.build.number, force);
      setBuildFailureAnalysis(response.data?.analysis || null);
      message.success(response.data?.cached ? '已加载保存的失败分析' : '失败分析完成');
    } catch (err: any) {
      message.error(err?.error || err?.message || '失败分析失败');
    } finally {
      setBuildFailureAnalysisLoading(false);
    }
  };

  const ensureBuildFailureAnalysis = () => {
    if (!selectedBuildLog || buildFailureAnalysis || buildFailureAnalysisLoading) return;
    if (!canAnalyzeBuildFailure(selectedBuildLog.build, selectedBuildLog.log)) return;
    void analyzeSelectedBuildFailure(false);
  };

  const ensurePackageSizeAnalysis = async (force = false) => {
    if (!selectedBuildLog || (!force && packageSizeAnalysis) || packageSizeLoading) return;
    setPackageSizeLoading(true);
    setPackageSizeError('');
    try {
      const response = await jenkinsApi.getBuildPackageSize(selectedBuildLog.build.number, force);
      setPackageSizeAnalysis(response.data || null);
    } catch (err: any) {
      setPackageSizeError(err?.error || err?.message || '包体积分析失败');
    } finally {
      setPackageSizeLoading(false);
    }
  };

  const downloadBuildLog = () => {
    if (!selectedBuildLog) return;
    downloadTextFile(`nn-${selectedBuildLog.build.number}.log`, selectedBuildLog.log || '');
  };

  const updateSelectedBuildAppStoreRelease = (buildNumber: number, appStoreRelease: JenkinsAppStoreRelease) => {
    setSelectedBuildLog((current) => current && current.build.number === buildNumber ? {
      ...current,
      build: {
        ...current.build,
        appStoreRelease,
      },
    } : current);
  };

  return {
    open,
    loading,
    selectedBuildLog,
    buildFailureAnalysis,
    buildFailureAnalysisLoading,
    packageSizeAnalysis,
    packageSizeLoading,
    packageSizeError,
    showBuildLog,
    closeBuildLog: () => setOpen(false),
    downloadBuildLog,
    ensureBuildFailureAnalysis,
    analyzeSelectedBuildFailure,
    ensurePackageSizeAnalysis,
    updateSelectedBuildAppStoreRelease,
  };
}
