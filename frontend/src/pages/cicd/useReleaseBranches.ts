import { useState } from 'react';
import { message } from 'antd';

import { jenkinsApi } from '../../services/api';
import { getHighestReleaseBranch } from './cicdFormatters';
import { DeployTarget } from './qualityOptions';

interface UseReleaseBranchesParams {
  deployTarget: DeployTarget;
  onPublishBranchChange: (branch: string) => void;
}

export function useReleaseBranches({
  deployTarget,
  onPublishBranchChange,
}: UseReleaseBranchesParams) {
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const loadBranches = async (options?: { silent?: boolean }) => {
    setLoading(true);
    try {
      const response = await jenkinsApi.listBranches();
      const nextBranches = response.data || [];
      setBranches(nextBranches);
      if (deployTarget !== 'Pgyer') {
        onPublishBranchChange(getHighestReleaseBranch(nextBranches));
      }
      return nextBranches;
    } catch (err: any) {
      if (options?.silent) {
        console.warn('加载分支列表失败，可直接输入分支名', err);
      } else {
        message.warning(err?.error || err?.message || '加载分支列表失败，可直接输入分支名');
      }
      return [];
    } finally {
      setLoading(false);
    }
  };

  return {
    branches,
    loading,
    loadBranches,
  };
}
