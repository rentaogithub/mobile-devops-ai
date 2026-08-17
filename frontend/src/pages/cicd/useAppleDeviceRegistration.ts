import { useEffect, useMemo, useRef, useState } from 'react';
import { message } from 'antd';

import {
  AppleDeveloperDeviceListResult,
  AppleDeveloperDeviceLookupResult,
  AppleDeviceConfigStatus,
  AppleDeviceEnrollment,
  AppleDeviceEnrollmentCreateResult,
  AppleDeviceRegistrationRequestListResult,
  appleDeviceApi,
} from '../../services/api';
import {
  AppleRegistrationInlineResult,
  filterAppleDeveloperDevices,
  findPendingAppleRegistrationRequest,
  findRegisteredAppleDevice,
  getAppleRegistrationAutoAction,
  isValidAppleUdid,
  normalizeAppleUdid,
} from './appleDeviceUtils';
import { usePollingEffect } from './usePollingEffect';

interface UseAppleDeviceRegistrationParams {
  active: boolean;
  canAdmin?: boolean;
}

export function useAppleDeviceRegistration({ active, canAdmin }: UseAppleDeviceRegistrationParams) {
  const [configStatus, setConfigStatus] = useState<AppleDeviceConfigStatus | null>(null);
  const [configStatusLoading, setConfigStatusLoading] = useState(false);
  const [enrollment, setEnrollment] = useState<AppleDeviceEnrollmentCreateResult | null>(null);
  const [enrollmentState, setEnrollmentState] = useState<AppleDeviceEnrollment | null>(null);
  const [enrollmentLoading, setEnrollmentLoading] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [deviceUdid, setDeviceUdid] = useState('');
  const [developerDevices, setDeveloperDevices] = useState<AppleDeveloperDeviceListResult | null>(null);
  const [developerDevicesLoading, setDeveloperDevicesLoading] = useState(false);
  const [developerDevicesError, setDeveloperDevicesError] = useState('');
  const [developerDeviceKeyword, setDeveloperDeviceKeyword] = useState('');
  const [deviceLookup, setDeviceLookup] = useState<AppleDeveloperDeviceLookupResult | null>(null);
  const [deviceLookupLoading, setDeviceLookupLoading] = useState(false);
  const [registrationInlineResult, setRegistrationInlineResult] = useState<AppleRegistrationInlineResult | null>(null);
  const [registrationRequests, setRegistrationRequests] = useState<AppleDeviceRegistrationRequestListResult | null>(null);
  const [registrationRequestsLoading, setRegistrationRequestsLoading] = useState(false);
  const [approvingRegistrationRequest, setApprovingRegistrationRequest] = useState('');
  const [configSaving, setConfigSaving] = useState(false);
  const [configKeyId, setConfigKeyId] = useState('');
  const [configIssuerId, setConfigIssuerId] = useState('');
  const [configKeyPath, setConfigKeyPath] = useState('');
  const [configKeyFile, setConfigKeyFile] = useState<File | null>(null);
  const enrollmentAutoCreatedRef = useRef(false);
  const deviceLookupSeqRef = useRef(0);
  const autoRegistrationUdidRef = useRef('');
  const registrationNoticeRef = useRef('');

  const registeredDevice = useMemo(() => {
    return findRegisteredAppleDevice({
      udid: deviceUdid,
      enrollment: enrollmentState,
      developerDevices,
      lookup: deviceLookup,
    });
  }, [developerDevices?.devices, deviceLookup, deviceUdid, enrollmentState?.device?.udid]);

  const pendingRegistrationRequest = useMemo(() => {
    return findPendingAppleRegistrationRequest({
      udid: deviceUdid,
      enrollment: enrollmentState,
      requests: registrationRequests,
    });
  }, [registrationRequests?.requests, deviceUdid, enrollmentState?.device?.udid]);

  const filteredDeveloperDevices = useMemo(() => {
    return filterAppleDeveloperDevices(developerDevices?.devices || [], developerDeviceKeyword);
  }, [developerDevices?.devices, developerDeviceKeyword]);

  const loadConfigStatus = async () => {
    setConfigStatusLoading(true);
    try {
      const response = await appleDeviceApi.status();
      const status = response.data || null;
      setConfigStatus(status);
      if (status) {
        setConfigKeyId(status.keyId || '');
        setConfigIssuerId(status.issuerId || '');
        setConfigKeyPath(status.keyPath || '');
      }
    } catch (err: any) {
      message.warning(err?.error || err?.message || '加载 Apple Developer 配置状态失败');
    } finally {
      setConfigStatusLoading(false);
    }
  };

  const saveConfig = async () => {
    setConfigSaving(true);
    try {
      const response = await appleDeviceApi.updateConfig({
        keyId: configKeyId.trim(),
        issuerId: configIssuerId.trim(),
        keyPath: configKeyPath.trim(),
        keyFile: configKeyFile,
      });
      const status = response.data || null;
      setConfigStatus(status);
      setConfigKeyFile(null);
      if (status) {
        setConfigKeyId(status.keyId || configKeyId.trim());
        setConfigIssuerId(status.issuerId || configIssuerId.trim());
        setConfigKeyPath(status.keyPath || configKeyPath.trim());
      }
      message.success(status?.message || 'Apple Developer API 配置已更新');
    } catch (err: any) {
      message.error(err?.error || err?.message || '更新 Apple Developer API 配置失败');
    } finally {
      setConfigSaving(false);
    }
  };

  const loadDeveloperDevices = async () => {
    if (!canAdmin) {
      setDeveloperDevices(null);
      setDeveloperDevicesError('');
      return;
    }
    setDeveloperDevicesLoading(true);
    setDeveloperDevicesError('');
    try {
      const response = await appleDeviceApi.listDevices({ platform: 'IOS', limit: 200 });
      setDeveloperDevices(response.data || null);
    } catch (err: any) {
      setDeveloperDevicesError(err?.error || err?.message || '获取 Apple Developer 设备列表失败');
    } finally {
      setDeveloperDevicesLoading(false);
    }
  };

  const loadRegistrationRequests = async () => {
    if (!canAdmin) {
      setRegistrationRequests(null);
      return;
    }
    setRegistrationRequestsLoading(true);
    try {
      const response = await appleDeviceApi.listRegistrationRequests();
      setRegistrationRequests(response.data || null);
    } catch (err: any) {
      message.warning(err?.error || err?.message || '加载 Apple 设备注册申请失败');
    } finally {
      setRegistrationRequestsLoading(false);
    }
  };

  const refreshSection = async () => {
    await Promise.all([
      loadConfigStatus(),
      loadDeveloperDevices(),
      loadRegistrationRequests(),
    ]);
  };

  const resetEnrollmentForm = () => {
    setEnrollment(null);
    setEnrollmentState(null);
    setDeviceName('');
    setDeviceUdid('');
    setDeviceLookup(null);
    setDeviceLookupLoading(false);
    setRegistrationInlineResult(null);
    autoRegistrationUdidRef.current = '';
    registrationNoticeRef.current = '';
    enrollmentAutoCreatedRef.current = false;
  };

  const createEnrollment = async () => {
    setEnrollmentLoading(true);
    setEnrollmentState(null);
    setDeviceName('');
    setDeviceUdid('');
    setDeviceLookup(null);
    setDeviceLookupLoading(false);
    setRegistrationInlineResult(null);
    autoRegistrationUdidRef.current = '';
    registrationNoticeRef.current = '';
    try {
      const response = await appleDeviceApi.createEnrollment();
      const nextEnrollment = response.data || null;
      setEnrollment(nextEnrollment);
      if (nextEnrollment?.sessionId) {
        message.success('设备采集二维码已生成');
      }
    } catch (err: any) {
      message.error(err?.error || err?.message || '生成设备采集二维码失败');
    } finally {
      setEnrollmentLoading(false);
    }
  };

  const lookupDeviceRegistration = async (udid: string) => {
    const normalized = normalizeAppleUdid(udid);
    const lookupSeq = deviceLookupSeqRef.current + 1;
    deviceLookupSeqRef.current = lookupSeq;
    if (!normalized) {
      setDeviceLookup(null);
      return;
    }
    setDeviceLookupLoading(true);
    try {
      const response = await appleDeviceApi.lookupDevice(normalized);
      if (deviceLookupSeqRef.current !== lookupSeq) return;
      setDeviceLookup(response.data || null);
    } catch (err: any) {
      if (deviceLookupSeqRef.current !== lookupSeq) return;
      setDeviceLookup(null);
      setRegistrationInlineResult({
        type: 'error',
        message: '设备注册状态查询失败',
        description: err?.error || err?.message || '请重新生成二维码后再扫码采集。',
      });
      message.warning(err?.error || err?.message || '查询 Apple 设备注册状态失败');
    } finally {
      if (deviceLookupSeqRef.current !== lookupSeq) return;
      setDeviceLookupLoading(false);
    }
  };

  const refreshEnrollment = async (silent = false) => {
    if (!enrollment?.sessionId) return null;
    try {
      const response = await appleDeviceApi.getEnrollment(enrollment.sessionId);
      const nextEnrollmentState = response.data || null;
      setEnrollmentState(nextEnrollmentState);
      if (nextEnrollmentState?.device?.udid) {
        setDeviceUdid(nextEnrollmentState.device.udid);
        setDeviceName((current) => current || nextEnrollmentState.device?.name || '');
      }
      return nextEnrollmentState;
    } catch (err: any) {
      if (!silent) {
        message.error(err?.error || err?.message || '读取设备采集结果失败');
      }
      return null;
    }
  };

  const showRegistrationNotice = (udid: string, type: AppleRegistrationInlineResult['type'], content: string) => {
    const noticeKey = `${normalizeAppleUdid(udid)}:${type}:${content}`;
    if (registrationNoticeRef.current === noticeKey) return;
    registrationNoticeRef.current = noticeKey;
    message.open({
      type,
      content,
      duration: 3,
      style: {
        marginTop: '32vh',
        textAlign: 'center',
      },
    });
  };

  const submitRegistrationRequest = async (options?: { silent?: boolean; resetAfterSubmit?: boolean }) => {
    const udid = normalizeAppleUdid(deviceUdid || enrollmentState?.device?.udid);
    if (!udid) {
      if (!options?.silent) message.warning('请先扫码采集设备 Identifier');
      setRegistrationInlineResult({ type: 'warning', message: '请先扫码采集设备 Identifier' });
      return;
    }
    if (!isValidAppleUdid(udid)) {
      if (!options?.silent) message.warning('设备 Identifier 不合法，请重新扫码采集');
      setRegistrationInlineResult({ type: 'error', message: '设备 Identifier 不合法', description: '请重新生成二维码后再扫码采集。' });
      return;
    }
    if (registeredDevice) {
      if (!options?.silent) message.info('该设备已在 Apple Developer 设备列表中，无需重复提交注册申请');
      setRegistrationInlineResult({
        type: 'info',
        message: '该设备已在 Apple Developer 设备列表中',
        description: '无需重复提交注册申请。',
      });
      return;
    }
    setRegistering(true);
    setRegistrationInlineResult({ type: 'info', message: '正在自动提交注册申请...' });
    try {
      const response = await appleDeviceApi.createRegistrationRequest({
        udid,
        name: deviceName.trim() || enrollmentState?.device?.name || undefined,
        platform: 'IOS',
        product: enrollmentState?.device?.product,
        version: enrollmentState?.device?.version,
        serial: enrollmentState?.device?.serial,
      });
      const result = response.data;
      const successMessage = result?.message || (result?.alreadyExists ? '设备已存在' : '已提交注册申请，等待管理员审批');
      setRegistrationInlineResult({
        type: result?.alreadyExists ? 'info' : 'success',
        message: successMessage,
      });
      if (options?.silent) {
        showRegistrationNotice(udid, result?.alreadyExists ? 'info' : 'success', successMessage);
      } else {
        message.success(successMessage);
      }
      if (options?.resetAfterSubmit) {
        resetEnrollmentForm();
      }
      void refreshSection();
    } catch (err: any) {
      const errorMessage = err?.error || err?.message || '提交 Apple 设备注册申请失败';
      setRegistrationInlineResult({ type: 'error', message: errorMessage });
      if (!options?.silent) message.error(errorMessage);
    } finally {
      setRegistering(false);
    }
  };

  const approveRegistrationRequest = async (id: string) => {
    setApprovingRegistrationRequest(id);
    try {
      const response = await appleDeviceApi.approveRegistrationRequest(id);
      message.success(response.data?.message || response.data?.result?.message || '设备已注册到 Apple Developer');
      void refreshSection();
    } catch (err: any) {
      message.error(err?.error || err?.message || '审批注册 Apple 设备失败');
    } finally {
      setApprovingRegistrationRequest('');
    }
  };

  useEffect(() => {
    if (!active) return;
    if (enrollment || enrollmentLoading || enrollmentAutoCreatedRef.current) return;
    enrollmentAutoCreatedRef.current = true;
    void createEnrollment();
  }, [active, enrollment, enrollmentLoading]);

  usePollingEffect(
    active && Boolean(enrollment?.sessionId) && enrollmentState?.status !== 'completed',
    2000,
    () => { void refreshEnrollment(true); },
    [active, enrollment?.sessionId, enrollmentState?.status],
  );

  useEffect(() => {
    if (!active) return undefined;
    const targetUdid = normalizeAppleUdid(deviceUdid || enrollmentState?.device?.udid);
    if (!targetUdid || targetUdid.length < 24) {
      setDeviceLookup(null);
      setDeviceLookupLoading(false);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void lookupDeviceRegistration(targetUdid);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [active, deviceUdid, enrollmentState?.device?.udid]);

  useEffect(() => {
    if (!active) return;
    const rawUdid = deviceUdid || enrollmentState?.device?.udid;
    const action = getAppleRegistrationAutoAction({
      udid: rawUdid,
      registeredDevice,
      pendingRequest: pendingRegistrationRequest,
      lookup: deviceLookup,
      lookupLoading: deviceLookupLoading,
      registering,
      autoSubmitted: autoRegistrationUdidRef.current === normalizeAppleUdid(rawUdid),
    });
    if (!action.targetUdid) return;
    if (action.result) {
      setRegistrationInlineResult(action.result);
    }
    if (action.notice) {
      showRegistrationNotice(action.targetUdid, action.notice.type, action.notice.content);
    }
    if (!action.shouldSubmit) return;
    autoRegistrationUdidRef.current = action.targetUdid;
    void submitRegistrationRequest({ silent: true });
  }, [
    active,
    deviceLookup,
    deviceLookupLoading,
    registering,
    deviceUdid,
    enrollmentState?.device?.udid,
    pendingRegistrationRequest,
    registeredDevice,
  ]);

  return {
    configStatus,
    configStatusLoading,
    enrollment,
    enrollmentState,
    enrollmentLoading,
    registering,
    deviceUdid,
    developerDevices,
    developerDevicesLoading,
    developerDevicesError,
    developerDeviceKeyword,
    deviceLookupLoading,
    registrationInlineResult,
    registrationRequests,
    registrationRequestsLoading,
    approvingRegistrationRequest,
    configSaving,
    configKeyId,
    configIssuerId,
    configKeyPath,
    configKeyFile,
    registeredDevice,
    filteredDeveloperDevices,
    setDeveloperDeviceKeyword,
    setConfigKeyId,
    setConfigIssuerId,
    setConfigKeyPath,
    setConfigKeyFile,
    loadConfigStatus,
    saveConfig,
    loadDeveloperDevices,
    loadRegistrationRequests,
    refreshSection,
    createEnrollment,
    approveRegistrationRequest,
    resetEnrollmentForm,
  };
}
