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
      onCreateEnrollment={registration.createEnrollment}
      onTabChange={(key) => {
        if (key === 'requests') void registration.loadRegistrationRequests();
        if (key === 'devices') void registration.loadDeveloperDevices();
      }}
      onLoadRegistrationRequests={registration.loadRegistrationRequests}
      onApproveRegistrationRequest={registration.approveRegistrationRequest}
      onLoadDeveloperDevices={registration.loadDeveloperDevices}
      onDeveloperDeviceKeywordChange={registration.setDeveloperDeviceKeyword}
    />
  );
}
