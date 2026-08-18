import appleDeviceEnrollGuide from '../assets/apple-device-enroll-guide.svg';
import { CicdPageView } from './cicd/CicdPageView';
import { useCicdPageController } from './cicd/useCicdPageController';

export default function CICDPage() {
  const controller = useCicdPageController();
  return <CicdPageView controller={controller} appleDeviceGuideImage={appleDeviceEnrollGuide} />;
}
