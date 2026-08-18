import { AppleDeviceSection } from './AppleDeviceSection';
import type { CicdPageController } from './useCicdPageController';

interface AppleDeviceSectionContainerProps {
  guideImage: string;
  controller: CicdPageController;
}

export function AppleDeviceSectionContainer({
  guideImage,
  controller,
}: AppleDeviceSectionContainerProps) {
  const registration = controller.appleDeviceRegistration;

  return (
    <AppleDeviceSection
      isAdmin={controller.permissions.isAdmin}
      enrollment={registration.enrollment}
      enrollmentState={registration.enrollmentState}
      enrollmentLoading={registration.enrollmentLoading}
      deviceUdid={registration.deviceUdid}
      guideImage={guideImage}
      registrationResult={registration.registrationInlineResult}
      lookupLoading={registration.deviceLookupLoading}
      registering={registration.registering}
      registeredDevice={registration.registeredDevice}
      registrationRequests={registration.registrationRequests}
      registrationRequestsLoading={registration.registrationRequestsLoading}
      approvingRequestId={registration.approvingRegistrationRequest}
      developerDevices={registration.developerDevices}
      filteredDeveloperDevices={registration.filteredDeveloperDevices}
      developerDevicesLoading={registration.developerDevicesLoading}
      developerDevicesError={registration.developerDevicesError}
      developerDeviceKeyword={registration.developerDeviceKeyword}
      configStatus={registration.configStatus}
      configStatusLoading={registration.configStatusLoading}
      configSaving={registration.configSaving}
      configKeyId={registration.configKeyId}
      configIssuerId={registration.configIssuerId}
      configKeyPath={registration.configKeyPath}
      configKeyFile={registration.configKeyFile}
      onCreateEnrollment={registration.createEnrollment}
      onTabChange={(key) => {
        if (key === 'requests') void registration.loadRegistrationRequests();
        if (key === 'devices') void registration.loadDeveloperDevices();
        if (key === 'config') void registration.loadConfigStatus();
      }}
      onLoadRegistrationRequests={registration.loadRegistrationRequests}
      onApproveRegistrationRequest={registration.approveRegistrationRequest}
      onLoadDeveloperDevices={registration.loadDeveloperDevices}
      onDeveloperDeviceKeywordChange={registration.setDeveloperDeviceKeyword}
      onLoadConfigStatus={registration.loadConfigStatus}
      onSaveConfig={registration.saveConfig}
      onConfigKeyIdChange={registration.setConfigKeyId}
      onConfigIssuerIdChange={registration.setConfigIssuerId}
      onConfigKeyPathChange={registration.setConfigKeyPath}
      onConfigKeyFileChange={registration.setConfigKeyFile}
    />
  );
}
