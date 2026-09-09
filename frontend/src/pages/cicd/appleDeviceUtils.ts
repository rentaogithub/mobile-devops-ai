import {
  AppleDeveloperDevice,
  AppleDeveloperDeviceListResult,
  AppleDeviceEnrollment,
  AppleDeviceRegistrationRequestListResult,
  AppleDeveloperDeviceLookupResult,
} from '../../services/api';

export type AppleRegistrationInlineResult = {
  type: 'success' | 'info' | 'warning' | 'error';
  message: string;
  description?: string;
};

export function normalizeAppleUdid(value?: string) {
  return String(value || '').trim().toUpperCase().replace(/-/g, '');
}

export function isValidAppleUdid(value?: string) {
  return /^[A-F0-9]{24,40}$/.test(normalizeAppleUdid(value));
}

export function findRegisteredAppleDevice({
  udid,
  enrollment,
  developerDevices,
  lookup,
}: {
  udid?: string;
  enrollment?: AppleDeviceEnrollment | null;
  developerDevices?: AppleDeveloperDeviceListResult | null;
  lookup?: AppleDeveloperDeviceLookupResult | null;
}): AppleDeveloperDevice | null {
  const targetUdid = normalizeAppleUdid(udid || enrollment?.device?.udid);
  if (!targetUdid) return null;
  const listedDevice = (developerDevices?.source === 'apple' ? developerDevices.devices : []).find((device) => normalizeAppleUdid(device.udid) === targetUdid);
  if (listedDevice) return listedDevice;
  if (lookup?.source === 'apple' && lookup.registered && normalizeAppleUdid(lookup.device?.udid) === targetUdid) {
    return lookup.device || null;
  }
  return null;
}

export function findPendingAppleRegistrationRequest({
  udid,
  enrollment,
  requests,
}: {
  udid?: string;
  enrollment?: AppleDeviceEnrollment | null;
  requests?: AppleDeviceRegistrationRequestListResult | null;
}) {
  const targetUdid = normalizeAppleUdid(udid || enrollment?.device?.udid);
  if (!targetUdid) return null;
  return (requests?.requests || []).find((request) => (
    request.status === 'pending' && normalizeAppleUdid(request.udid) === targetUdid
  )) || null;
}

export function filterAppleDeveloperDevices(devices: AppleDeveloperDevice[], keyword: string) {
  const trimmed = keyword.trim();
  if (!trimmed) return devices;
  const normalizedKeyword = normalizeAppleUdid(trimmed);
  const lowerKeyword = trimmed.toLowerCase();
  return devices.filter((device) => (
    normalizeAppleUdid(device.udid).includes(normalizedKeyword)
    || String(device.name || '').toLowerCase().includes(lowerKeyword)
    || String(device.model || '').toLowerCase().includes(lowerKeyword)
    || String(device.deviceClass || '').toLowerCase().includes(lowerKeyword)
  ));
}

export function getAppleRegistrationAutoAction({
  udid,
  registeredDevice,
  pendingRequest,
  lookup,
  lookupLoading,
  registering,
  autoSubmitted,
}: {
  udid?: string;
  registeredDevice?: AppleDeveloperDevice | null;
  pendingRequest?: unknown;
  lookup?: AppleDeveloperDeviceLookupResult | null;
  lookupLoading?: boolean;
  registering?: boolean;
  autoSubmitted?: boolean;
}): {
  targetUdid: string;
  result?: AppleRegistrationInlineResult;
  notice?: { type: AppleRegistrationInlineResult['type']; content: string };
  shouldSubmit?: boolean;
} {
  const targetUdid = normalizeAppleUdid(udid);
  if (!targetUdid) return { targetUdid };
  if (!isValidAppleUdid(targetUdid)) {
    return {
      targetUdid,
      result: {
        type: 'error',
        message: '设备 Identifier 不合法',
        description: '请重新生成二维码后再扫码采集。',
      },
      notice: { type: 'error', content: '设备 Identifier 不合法，请重新扫码采集' },
    };
  }
  if (registeredDevice) {
    return {
      targetUdid,
      result: {
        type: 'info',
        message: '该设备已在 Apple Developer 设备列表中',
        description: '无需重复提交注册申请。',
      },
      notice: { type: 'info', content: '该设备已在 Apple Developer 设备列表中，无需重复申请' },
    };
  }
  if (pendingRequest) {
    return {
      targetUdid,
      result: {
        type: 'info',
        message: '该设备已提交注册申请',
        description: '等待管理员审批。',
      },
      notice: { type: 'info', content: '该设备已提交注册申请，等待管理员审批' },
    };
  }
  if (lookupLoading || lookup?.source !== 'apple' || registering || lookup.registered || autoSubmitted) {
    return { targetUdid };
  }
  return { targetUdid, shouldSubmit: true };
}
