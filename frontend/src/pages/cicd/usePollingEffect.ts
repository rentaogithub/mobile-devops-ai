import { DependencyList, useEffect } from 'react';

export function usePollingEffect(enabled: boolean, intervalMs: number, callback: () => void, deps: DependencyList) {
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setInterval(callback, intervalMs);
    return () => window.clearInterval(timer);
  }, deps);
}
