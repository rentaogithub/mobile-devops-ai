import { useEffect, useState } from 'react';

import { JenkinsCicdHealthResult, jenkinsApi } from '../../services/api';
import { usePollingEffect } from './usePollingEffect';

export function useCicdHealth(enabled: boolean) {
  const [health, setHealth] = useState<JenkinsCicdHealthResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const loadHealth = async (options?: { silent?: boolean }) => {
    if (!enabled) return null;
    if (!options?.silent) {
      setLoading(true);
    }
    try {
      const response = await jenkinsApi.getCicdHealth();
      setHealth(response.data || null);
      return response.data || null;
    } catch (err: any) {
      setHealth({
        healthy: false,
        blockers: [{
          key: 'health_api',
          label: '健康检查',
          status: 'blocked',
          message: err?.error || err?.message || '加载 CI/CD 健康状态失败',
        }],
        warnings: [],
        checks: [],
        checkedAt: new Date().toISOString(),
        elapsedMs: 0,
      });
      return null;
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!enabled) return;
    void loadHealth({ silent: true });
  }, [enabled]);

  usePollingEffect(
    enabled,
    120000,
    () => { void loadHealth({ silent: true }); },
    [enabled],
  );

  const toggleHealth = () => {
    setOpen((current) => !current);
    void loadHealth();
  };

  return {
    health,
    loading,
    open,
    toggleHealth,
  };
}
