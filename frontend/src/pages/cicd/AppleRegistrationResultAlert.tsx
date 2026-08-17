import { Alert, Space, Typography } from 'antd';

import { AppleDeveloperDevice, AppleDeviceEnrollment } from '../../services/api';
import { AppleRegistrationInlineResult } from './appleDeviceUtils';

const { Text } = Typography;

interface AppleRegistrationResultAlertProps {
  udid?: string;
  result?: AppleRegistrationInlineResult | null;
  lookupLoading?: boolean;
  registering?: boolean;
  registeredDevice?: AppleDeveloperDevice | null;
  enrollment?: AppleDeviceEnrollment | null;
}

export function AppleRegistrationResultAlert({
  udid,
  result,
  lookupLoading,
  registering,
  registeredDevice,
  enrollment,
}: AppleRegistrationResultAlertProps) {
  const alertResult = result
    || (lookupLoading ? { type: 'info' as const, message: '正在校验设备注册状态...' } : null)
    || (registering ? { type: 'info' as const, message: '正在自动提交注册申请...' } : null);

  if (!udid || !alertResult) return null;

  const deviceInfo = [
    registeredDevice?.name || enrollment?.device?.name,
    registeredDevice?.model || enrollment?.device?.product,
    registeredDevice?.status || enrollment?.device?.version,
  ].filter(Boolean).join(' / ');

  return (
    <Alert
      type={alertResult.type}
      showIcon
      message={alertResult.message}
      description={(
        <Space direction="vertical" size={4}>
          <Text code copyable>{udid}</Text>
          {alertResult.description && <Text type="secondary">{alertResult.description}</Text>}
          {deviceInfo && <Text type="secondary">{deviceInfo}</Text>}
        </Space>
      )}
      style={{ width: '100%', textAlign: 'left' }}
    />
  );
}
