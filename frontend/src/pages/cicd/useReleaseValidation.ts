import { useEffect, useRef, useState } from 'react';
import { message } from 'antd';

import {
  JenkinsAppStoreReleaseGuard,
  JenkinsQualitySuite,
  JenkinsReleasePreflightResult,
  WorkflowReleaseGate,
  jenkinsApi,
} from '../../services/api';
import { DeployTarget } from './qualityOptions';

interface UseReleaseValidationParams {
  publishModalOpen: boolean;
  deployTarget: DeployTarget;
  publishBranch: string;
  resolvedPublishAppVersion: string;
  publishGateBuildNumber?: number;
  testFlightWhatsNew: string;
  canOperateCicd?: boolean;
  canPublishAppStore?: boolean;
}

export function useReleaseValidation({
  publishModalOpen,
  deployTarget,
  publishBranch,
  resolvedPublishAppVersion,
  publishGateBuildNumber,
  testFlightWhatsNew,
  canOperateCicd,
  canPublishAppStore,
}: UseReleaseValidationParams) {
  const [gatePreview, setGatePreview] = useState<WorkflowReleaseGate>();
  const [gateMissingSuites, setGateMissingSuites] = useState<JenkinsQualitySuite[]>([]);
  const [gatePreviewLoading, setGatePreviewLoading] = useState(false);
  const [preflight, setPreflight] = useState<JenkinsReleasePreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState('');
  const [appStoreReleaseGuard, setAppStoreReleaseGuard] = useState<JenkinsAppStoreReleaseGuard | null>(null);
  const [appStoreReleaseGuardLoading, setAppStoreReleaseGuardLoading] = useState(false);
  const [appStoreReleaseGuardError, setAppStoreReleaseGuardError] = useState('');
  const appStoreReleaseGuardSeqRef = useRef(0);
  const releasePreflightSeqRef = useRef(0);

  useEffect(() => {
    if (!publishModalOpen || !publishGateBuildNumber || !publishBranch) {
      setGatePreview(undefined);
      setGateMissingSuites([]);
      return;
    }
    let canceled = false;
    setGatePreviewLoading(true);
    void jenkinsApi.previewReleaseGate({ gateBuildNumber: publishGateBuildNumber, branch: publishBranch })
      .then((response) => {
        if (canceled) return;
        setGatePreview(response.data?.releaseGate);
        setGateMissingSuites(response.data?.missingSuites || []);
      })
      .catch((error: any) => {
        if (canceled) return;
        setGatePreview(undefined);
        setGateMissingSuites([]);
        message.warning(error?.error || error?.message || '质量门禁预检失败');
      })
      .finally(() => {
        if (!canceled) setGatePreviewLoading(false);
      });
    return () => { canceled = true; };
  }, [publishModalOpen, publishGateBuildNumber, publishBranch]);

  useEffect(() => {
    if (!publishModalOpen || deployTarget !== 'AppStore' || !publishBranch || !canPublishAppStore) {
      setAppStoreReleaseGuard(null);
      setAppStoreReleaseGuardError('');
      setAppStoreReleaseGuardLoading(false);
      return undefined;
    }

    let canceled = false;
    const seq = appStoreReleaseGuardSeqRef.current + 1;
    appStoreReleaseGuardSeqRef.current = seq;
    setAppStoreReleaseGuard(null);
    setAppStoreReleaseGuardError('');
    setAppStoreReleaseGuardLoading(true);

    void jenkinsApi.checkAppStoreReleaseGuard({ branch: publishBranch.trim() })
      .then((response) => {
        if (canceled || appStoreReleaseGuardSeqRef.current !== seq) return;
        setAppStoreReleaseGuard(response.data || null);
      })
      .catch((error: any) => {
        if (canceled || appStoreReleaseGuardSeqRef.current !== seq) return;
        setAppStoreReleaseGuard(null);
        setAppStoreReleaseGuardError(error?.error || error?.message || '检查苹果商店版本状态失败');
      })
      .finally(() => {
        if (!canceled && appStoreReleaseGuardSeqRef.current === seq) {
          setAppStoreReleaseGuardLoading(false);
        }
      });

    return () => { canceled = true; };
  }, [publishModalOpen, deployTarget, publishBranch, canPublishAppStore]);

  useEffect(() => {
    if (!publishModalOpen || !publishBranch.trim() || !canOperateCicd) {
      setPreflight(null);
      setPreflightError('');
      setPreflightLoading(false);
      return undefined;
    }

    let canceled = false;
    const seq = releasePreflightSeqRef.current + 1;
    releasePreflightSeqRef.current = seq;
    setPreflightLoading(true);
    setPreflightError('');

    const timer = window.setTimeout(() => {
      void jenkinsApi.preflightRelease({
        deployTarget,
        branch: publishBranch.trim(),
        appVersion: resolvedPublishAppVersion || undefined,
        gateBuildNumber: publishGateBuildNumber,
        testFlightWhatsNew: deployTarget !== 'Pgyer' ? testFlightWhatsNew.trim() : undefined,
      })
        .then((response) => {
          if (canceled || releasePreflightSeqRef.current !== seq) return;
          setPreflight(response.data || null);
          setPreflightError('');
        })
        .catch((error: any) => {
          if (canceled || releasePreflightSeqRef.current !== seq) return;
          setPreflight(error?.data || null);
          setPreflightError(error?.error || error?.message || '发布前预检失败');
        })
        .finally(() => {
          if (!canceled && releasePreflightSeqRef.current === seq) {
            setPreflightLoading(false);
          }
        });
    }, 400);

    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [
    publishModalOpen,
    deployTarget,
    publishBranch,
    resolvedPublishAppVersion,
    publishGateBuildNumber,
    testFlightWhatsNew,
    canOperateCicd,
  ]);

  return {
    gatePreview,
    gateMissingSuites,
    gatePreviewLoading,
    preflight,
    preflightLoading,
    preflightError,
    appStoreReleaseGuard,
    appStoreReleaseGuardLoading,
    appStoreReleaseGuardError,
  };
}
