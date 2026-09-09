import { Col, Row, Space } from 'antd';

import {
  AppleDeveloperDevice,
  AppleDeveloperDeviceListResult,
  AppleDeviceEnrollment,
  AppleDeviceEnrollmentCreateResult,
  AppleDeviceRegistrationRequestListResult,
} from '../../services/api';
import { AppleDeviceAdminTabs } from './AppleDeviceAdminTabs';
import { AppleRegistrationResultAlert } from './AppleRegistrationResultAlert';
import { AppleScanCard } from './AppleScanCard';
import { AppleRegistrationInlineResult } from './appleDeviceUtils';

interface AppleDeviceSectionProps {
  isAdmin?: boolean;
  enrollUrl?: string;
  enrollment?: AppleDeviceEnrollmentCreateResult | null;
  enrollmentState?: AppleDeviceEnrollment | null;
  enrollmentLoading?: boolean;
  deviceUdid?: string;
  guideImage: string;
  registrationResult?: AppleRegistrationInlineResult | null;
  lookupLoading?: boolean;
  registering?: boolean;
  registeredDevice?: AppleDeveloperDevice | null;
  registrationRequests: AppleDeviceRegistrationRequestListResult | null;
  registrationRequestsLoading?: boolean;
  approvingRequestId?: string;
  developerDevices: AppleDeveloperDeviceListResult | null;
  filteredDeveloperDevices: AppleDeveloperDevice[];
  developerDevicesLoading?: boolean;
  developerDevicesError?: string;
  developerDeviceKeyword: string;
  onCreateEnrollment: () => void;
  onTabChange: (key: string) => void;
  onLoadRegistrationRequests: () => void;
  onApproveRegistrationRequest: (id: string) => void;
  onLoadDeveloperDevices: () => void;
  onDeveloperDeviceKeywordChange: (value: string) => void;
}

export function AppleDeviceSection({
  isAdmin,
  enrollUrl,
  enrollment,
  enrollmentState,
  enrollmentLoading,
  deviceUdid,
  guideImage,
  registrationResult,
  lookupLoading,
  registering,
  registeredDevice,
  registrationRequests,
  registrationRequestsLoading,
  approvingRequestId,
  developerDevices,
  filteredDeveloperDevices,
  developerDevicesLoading,
  developerDevicesError,
  developerDeviceKeyword,
  onCreateEnrollment,
  onTabChange,
  onLoadRegistrationRequests,
  onApproveRegistrationRequest,
  onLoadDeveloperDevices,
  onDeveloperDeviceKeywordChange,
}: AppleDeviceSectionProps) {
  const scanCard = (
    <AppleScanCard
      enrollUrl={enrollUrl || enrollment?.enrollUrl}
      loading={enrollmentLoading}
      emptyDescription={isAdmin ? '点击生成扫码，创建一次设备 Identifier 采集会话' : '正在生成设备 Identifier 采集二维码'}
      guideImage={guideImage}
      registrationResult={(
        <AppleRegistrationResultAlert
          udid={enrollmentState?.device?.udid || deviceUdid}
          result={registrationResult}
          lookupLoading={lookupLoading}
          registering={registering}
          registeredDevice={registeredDevice}
          enrollment={enrollmentState}
        />
      )}
      onCreateEnrollment={onCreateEnrollment}
    />
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {isAdmin ? (
        <AppleDeviceAdminTabs
          scanCard={scanCard}
          registrationRequests={registrationRequests}
          registrationRequestsLoading={registrationRequestsLoading}
          approvingRequestId={approvingRequestId}
          developerDevices={developerDevices}
          filteredDeveloperDevices={filteredDeveloperDevices}
          developerDevicesLoading={developerDevicesLoading}
          developerDevicesError={developerDevicesError}
          developerDeviceKeyword={developerDeviceKeyword}
          onTabChange={onTabChange}
          onLoadRegistrationRequests={onLoadRegistrationRequests}
          onApproveRegistrationRequest={onApproveRegistrationRequest}
          onLoadDeveloperDevices={onLoadDeveloperDevices}
          onDeveloperDeviceKeywordChange={onDeveloperDeviceKeywordChange}
        />
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={24}>{scanCard}</Col>
        </Row>
      )}
    </Space>
  );
}
