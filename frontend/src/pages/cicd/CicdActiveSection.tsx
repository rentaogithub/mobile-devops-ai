import { ReleaseSectionContainer } from './ReleaseSectionContainer';
import { QualitySectionContainer } from './QualitySectionContainer';
import { AppleDeviceSectionContainer } from './AppleDeviceSectionContainer';
import type { CicdPageController } from './useCicdPageController';

interface CicdActiveSectionProps {
  controller: CicdPageController;
  appleDeviceGuideImage: string;
}

export function CicdActiveSection({
  controller,
  appleDeviceGuideImage,
}: CicdActiveSectionProps) {
  if (controller.activeSection === 'release') {
    return <ReleaseSectionContainer controller={controller} />;
  }

  if (controller.activeSection === 'quality') {
    return <QualitySectionContainer controller={controller} />;
  }

  return (
    <AppleDeviceSectionContainer
      guideImage={appleDeviceGuideImage}
      controller={controller}
    />
  );
}
