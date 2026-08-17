import { useState } from 'react';
import { message } from 'antd';

import { SonicDevicePool, SonicDevicePoolStatusResult, jenkinsApi } from '../../services/api';
import {
  appendDevicePoolDraft,
  cleanDevicePoolsForSave,
  cloneDevicePoolsForDraft,
  removeDevicePoolDraftAt,
  updateDevicePoolDraftAt,
} from './devicePoolUtils';

interface UseQualityDevicePoolsParams {
  canAdmin?: boolean;
  selectedPoolValue: string;
  onSelectedPoolChange: (value: string) => void;
}

export function useQualityDevicePools({
  canAdmin,
  selectedPoolValue,
  onSelectedPoolChange,
}: UseQualityDevicePoolsParams) {
  const [pools, setPools] = useState<SonicDevicePool[]>([]);
  const [status, setStatus] = useState<SonicDevicePoolStatusResult | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [unassignedTargetPool, setUnassignedTargetPool] = useState('ios-default');
  const [drafts, setDrafts] = useState<SonicDevicePool[]>([]);

  const syncSelectedPools = (nextPools: SonicDevicePool[]) => {
    if (nextPools.length > 0 && !nextPools.some((pool) => pool.value === selectedPoolValue)) {
      onSelectedPoolChange(nextPools[0].value);
    }
    if (nextPools.length > 0 && !nextPools.some((pool) => pool.value === unassignedTargetPool)) {
      setUnassignedTargetPool(nextPools[0].value);
    }
  };

  const loadPools = async () => {
    try {
      const response = await jenkinsApi.getSonicDevicePoolStatus();
      const nextStatus = response.data || null;
      const nextPools = nextStatus?.pools || [];
      setStatus(nextStatus);
      setPools(nextPools);
      syncSelectedPools(nextPools);
    } catch (err: any) {
      try {
        const response = await jenkinsApi.listSonicDevicePools();
        const nextPools = response.data || [];
        setStatus(null);
        setPools(nextPools);
        syncSelectedPools(nextPools);
      } catch {
        message.warning(err?.error || err?.message || '加载质检设备池失败');
      }
    }
  };

  const openModal = () => {
    if (!canAdmin) {
      message.warning('设备池配置仅管理员可操作');
      return;
    }
    setDrafts(cloneDevicePoolsForDraft(pools));
    setModalOpen(true);
  };

  const updateDraft = (index: number, patch: Partial<SonicDevicePool>) => {
    setDrafts((items) => updateDevicePoolDraftAt(items, index, patch));
  };

  const addDraft = () => {
    setDrafts(appendDevicePoolDraft);
  };

  const removeDraft = (index: number) => {
    setDrafts((items) => removeDevicePoolDraftAt(items, index));
  };

  const savePools = async () => {
    if (!canAdmin) {
      message.warning('设备池配置仅管理员可操作');
      return;
    }
    const normalized = cleanDevicePoolsForSave(drafts);

    if (normalized.some((pool) => !pool.label || !pool.value)) {
      message.warning('设备池名称和 value 不能为空');
      return;
    }

    setSaving(true);
    try {
      const response = await jenkinsApi.updateSonicDevicePools(normalized);
      const nextPools = response.data || [];
      setPools(nextPools);
      syncSelectedPools(nextPools);
      setModalOpen(false);
      message.success('设备池配置已保存');
    } catch (err: any) {
      message.error(err?.error || err?.message || '保存质检设备池失败');
    } finally {
      setSaving(false);
    }
  };

  const addUnassignedDevicesToPool = async () => {
    if (!canAdmin) {
      message.warning('设备池配置仅管理员可操作');
      return;
    }
    const devices = status?.unassignedDevices || [];
    if (devices.length === 0) {
      message.info('没有可加入的在线设备');
      return;
    }

    const targetValue = unassignedTargetPool || pools[0]?.value;
    if (!targetValue) {
      message.warning('请先创建一个设备池');
      return;
    }

    const nextPools = pools.map((pool) => {
      if (pool.value !== targetValue) return pool;
      const existingDevices = pool.devices?.length
        ? pool.devices
        : (pool.deviceId || pool.groupId ? [{ udid: pool.deviceId || pool.groupId || '' }] : []);
      const existingUdids = new Set(existingDevices.map((device) => device.udid).filter(Boolean));
      const nextDevices = [
        ...existingDevices,
        ...devices
          .filter((device) => !existingUdids.has(device.udid))
          .map((device) => ({
            udid: device.udid,
            label: device.marketName || device.name || undefined,
            description: [device.productVersion, device.connType].filter(Boolean).join(' / ') || undefined,
          })),
      ];
      return {
        ...pool,
        deviceId: nextDevices[0]?.udid || pool.deviceId,
        groupId: undefined,
        devices: nextDevices,
      };
    });

    setAdding(true);
    try {
      await jenkinsApi.updateSonicDevicePools(cleanDevicePoolsForSave(nextPools));
      message.success(`已加入 ${devices.length} 台设备`);
      await loadPools();
    } catch (err: any) {
      message.error(err?.error || err?.message || '加入设备池失败');
    } finally {
      setAdding(false);
    }
  };

  return {
    pools,
    status,
    modalOpen,
    saving,
    adding,
    unassignedTargetPool,
    drafts,
    setUnassignedTargetPool,
    setModalOpen,
    loadPools,
    openModal,
    updateDraft,
    addDraft,
    removeDraft,
    savePools,
    addUnassignedDevicesToPool,
  };
}
