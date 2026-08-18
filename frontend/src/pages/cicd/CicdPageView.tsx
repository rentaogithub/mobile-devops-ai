import { CicdPageHeaderContainer } from './CicdPageHeaderContainer';
import { CicdHealthPanelContainer } from './CicdHealthPanelContainer';
import { CicdModals } from './CicdModals';
import { CicdActiveSection } from './CicdActiveSection';
import type { CicdPageController } from './useCicdPageController';

interface CicdPageViewProps {
  controller: CicdPageController;
  appleDeviceGuideImage: string;
}

export function CicdPageView({
  controller,
  appleDeviceGuideImage,
}: CicdPageViewProps) {
  return (
    <div>
      <CicdPageHeaderContainer controller={controller} />
      <CicdHealthPanelContainer controller={controller} />
      <CicdActiveSection controller={controller} appleDeviceGuideImage={appleDeviceGuideImage} />
      <CicdModals controller={controller} />
    </div>
  );
}
