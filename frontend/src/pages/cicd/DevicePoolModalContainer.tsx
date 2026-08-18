import { DevicePoolModal } from './DevicePoolModal';
import { devicePoolDevicesText, parseDevicePoolDevices } from './devicePoolUtils';
import type { useQualityDevicePools } from './useQualityDevicePools';

interface DevicePoolModalContainerProps {
  pools: ReturnType<typeof useQualityDevicePools>;
  hasRunningQualityBuild?: boolean;
  cleaningQualityWda?: string | null;
  onCleanupWda: () => void;
}

export function DevicePoolModalContainer({
  pools,
  hasRunningQualityBuild,
  cleaningQualityWda,
  onCleanupWda,
}: DevicePoolModalContainerProps) {
  return (
    <DevicePoolModal
      open={pools.modalOpen}
      saving={pools.saving}
      drafts={pools.drafts}
      hasRunningQualityBuild={hasRunningQualityBuild}
      cleaningQualityWda={cleaningQualityWda}
      devicePoolDevicesText={devicePoolDevicesText}
      parseDevicePoolDevices={parseDevicePoolDevices}
      onUpdateDraft={pools.updateDraft}
      onAddDraft={pools.addDraft}
      onRemoveDraft={pools.removeDraft}
      onCleanupWda={onCleanupWda}
      onSave={pools.savePools}
      onClose={() => pools.setModalOpen(false)}
    />
  );
}
