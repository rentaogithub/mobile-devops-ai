import { Col, Row, Space, Tabs, Tag } from 'antd';
import { ReactNode } from 'react';
import {
  AppleDeveloperDevice,
  AppleDeveloperDeviceListResult,
  AppleDeviceConfigStatus,
  AppleDeviceRegistrationRequestListResult,
} from '../../services/api';
import { AppleDeveloperApiConfigCard } from './AppleDeveloperApiConfigCard';
import { AppleDeveloperDevicesCard } from './AppleDeveloperDevicesCard';
import { AppleRegistrationRequestsCard } from './AppleRegistrationRequestsCard';

interface AppleDeviceAdminTabsProps {
  scanCard: ReactNode;
  registrationRequests: AppleDeviceRegistrationRequestListResult | null;
  registrationRequestsLoading?: boolean;
  approvingRequestId?: string;
  developerDevices: AppleDeveloperDeviceListResult | null;
  filteredDeveloperDevices: AppleDeveloperDevice[];
  developerDevicesLoading?: boolean;
  developerDevicesError?: string;
  developerDeviceKeyword: string;
  configStatus: AppleDeviceConfigStatus | null;
  configStatusLoading?: boolean;
  configSaving?: boolean;
  configKeyId: string;
  configIssuerId: string;
  configKeyPath: string;
  configKeyFile: File | null;
  onTabChange: (key: string) => void;
  onLoadRegistrationRequests: () => void;
  onApproveRegistrationRequest: (id: string) => void;
  onLoadDeveloperDevices: () => void;
  onDeveloperDeviceKeywordChange: (value: string) => void;
  onLoadConfigStatus: () => void;
  onSaveConfig: () => void;
  onConfigKeyIdChange: (value: string) => void;
  onConfigIssuerIdChange: (value: string) => void;
  onConfigKeyPathChange: (value: string) => void;
  onConfigKeyFileChange: (file: File | null) => void;
}

export function AppleDeviceAdminTabs({
  scanCard,
  registrationRequests,
  registrationRequestsLoading,
  approvingRequestId,
  developerDevices,
  filteredDeveloperDevices,
  developerDevicesLoading,
  developerDevicesError,
  developerDeviceKeyword,
  configStatus,
  configStatusLoading,
  configSaving,
  configKeyId,
  configIssuerId,
  configKeyPath,
  configKeyFile,
  onTabChange,
  onLoadRegistrationRequests,
  onApproveRegistrationRequest,
  onLoadDeveloperDevices,
  onDeveloperDeviceKeywordChange,
  onLoadConfigStatus,
  onSaveConfig,
  onConfigKeyIdChange,
  onConfigIssuerIdChange,
  onConfigKeyPathChange,
  onConfigKeyFileChange,
}: AppleDeviceAdminTabsProps) {
  const requests = registrationRequests?.requests || [];
  const pendingCount = requests.filter((request) => request.status === 'pending').length;

  return (
    <Tabs
      defaultActiveKey="scan"
      onChange={onTabChange}
      items={[
        {
          key: 'scan',
          label: '扫码采集',
          children: (
            <Row gutter={[16, 16]}>
              <Col xs={24}>{scanCard}</Col>
            </Row>
          ),
        },
        {
          key: 'requests',
          label: (
            <Space size={6}>
              <span>设备注册申请</span>
              <Tag>{pendingCount}</Tag>
            </Space>
          ),
          children: (
            <AppleRegistrationRequestsCard
              requests={requests}
              loading={registrationRequestsLoading}
              approvingRequestId={approvingRequestId}
              onRefresh={onLoadRegistrationRequests}
              onApprove={onApproveRegistrationRequest}
            />
          ),
        },
        {
          key: 'devices',
          label: 'Apple Developer 设备列表',
          children: (
            <AppleDeveloperDevicesCard
              total={developerDevices?.total}
              devices={filteredDeveloperDevices}
              loading={developerDevicesLoading}
              error={developerDevicesError}
              keyword={developerDeviceKeyword}
              onKeywordChange={onDeveloperDeviceKeywordChange}
              onRefresh={onLoadDeveloperDevices}
            />
          ),
        },
        {
          key: 'config',
          label: 'API 配置',
          children: (
            <AppleDeveloperApiConfigCard
              status={configStatus}
              statusLoading={configStatusLoading}
              saving={configSaving}
              keyId={configKeyId}
              issuerId={configIssuerId}
              keyPath={configKeyPath}
              keyFile={configKeyFile}
              onKeyIdChange={onConfigKeyIdChange}
              onIssuerIdChange={onConfigIssuerIdChange}
              onKeyPathChange={onConfigKeyPathChange}
              onKeyFileChange={onConfigKeyFileChange}
              onCheck={onLoadConfigStatus}
              onSave={onSaveConfig}
            />
          ),
        },
      ]}
    />
  );
}
