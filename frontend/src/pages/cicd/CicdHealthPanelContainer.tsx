import { CicdHealthPanel } from './CicdHealthPanel';
import type { CicdPageController } from './useCicdPageController';

interface CicdHealthPanelContainerProps {
  controller: CicdPageController;
}

export function CicdHealthPanelContainer({
  controller,
}: CicdHealthPanelContainerProps) {
  const { activeSection, cicdHealth } = controller;
  if (activeSection !== 'release' || !cicdHealth.open) return null;

  return <CicdHealthPanel health={cicdHealth.health} loading={cicdHealth.loading} />;
}
