import { useEffect, useState } from 'react';
import { message } from 'antd';

import { jenkinsApi } from '../../services/api';

interface UseReleaseBranchModalParams {
  canCreateReleaseBranch?: boolean;
  baseBranchOptions: Array<{ value: string; label: string }>;
  loadBranches: (options?: { silent?: boolean }) => Promise<string[] | null>;
  onCreated?: (branch: string) => void;
}

export function useReleaseBranchModal({
  canCreateReleaseBranch,
  baseBranchOptions,
  loadBranches,
  onCreated,
}: UseReleaseBranchModalParams) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('develop');
  const [log, setLog] = useState('');

  const openModal = () => {
    if (!canCreateReleaseBranch) {
      message.warning('拉取新分支仅研发或管理员可操作');
      return;
    }
    setBranchName('');
    setBaseBranch('develop');
    setLog('');
    setOpen(true);
    loadBranches();
  };

  const createReleaseBranch = async () => {
    const targetBranch = branchName.trim().replace(/^origin\//, '');
    const normalizedBaseBranch = baseBranch.trim().replace(/^origin\//, '') || 'develop';
    if (!targetBranch) {
      message.warning('请输入新分支名称');
      return;
    }
    if (targetBranch === normalizedBaseBranch) {
      message.warning('新分支不能与基准分支相同');
      return;
    }
    setCreating(true);
    setLog('');
    try {
      await jenkinsApi.createReleaseBranch({ targetBranch, baseBranch: normalizedBaseBranch });
      await loadBranches();
      onCreated?.(targetBranch);
      setOpen(false);
      message.success('分支拉取成功');
    } catch (err: any) {
      const errorText = err?.error || err?.message || '拉取新分支失败';
      setLog((current) => `${current || ''}\n\n${errorText}`.trim());
      message.error('分支拉取失败');
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    if (!baseBranchOptions.some((option) => option.value === baseBranch)) {
      setBaseBranch(baseBranchOptions[0]?.value || 'develop');
    }
  }, [open, baseBranchOptions, baseBranch]);

  return {
    open,
    creating,
    branchName,
    baseBranch,
    log,
    setBranchName,
    setBaseBranch,
    openModal,
    closeModal: () => setOpen(false),
    createReleaseBranch,
  };
}
