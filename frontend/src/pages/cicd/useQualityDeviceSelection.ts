import { useEffect, useMemo } from 'react';

import { QualityDevicePool } from '../../services/api';
import {
  availableQualityDevicePools as getAvailableQualityDevicePools,
  availableQualityDevices as getAvailableQualityDevices,
  findQualityDevicePool,
  reconcileSelectedQualityDeviceUdids,
} from './devicePoolUtils';

interface UseQualityDeviceSelectionParams {
  pools: QualityDevicePool[];
  selectedPoolValue: string;
  modalOpen: boolean;
  setDeviceUdids: (updater: (current: string[]) => string[]) => void;
}

export function useQualityDeviceSelection({
  pools,
  selectedPoolValue,
  modalOpen,
  setDeviceUdids,
}: UseQualityDeviceSelectionParams) {
  const availablePools = useMemo(
    () => getAvailableQualityDevicePools(pools),
    [pools],
  );
  const selectedPool = useMemo(
    () => findQualityDevicePool(pools, selectedPoolValue),
    [pools, selectedPoolValue],
  );
  const availableDevices = useMemo(
    () => getAvailableQualityDevices(selectedPool),
    [selectedPool],
  );

  useEffect(() => {
    if (!modalOpen) return;
    setDeviceUdids((current) => {
      const availableUdids = availableDevices.map((device) => device.udid);
      return reconcileSelectedQualityDeviceUdids(current, availableUdids);
    });
  }, [modalOpen, availableDevices]);

  return {
    availablePools,
    selectedPool,
    availableDevices,
  };
}
