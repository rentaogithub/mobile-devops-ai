import { authUtils } from '../../utils/auth';

export function getCicdPermissions() {
  const isAuthenticated = authUtils.isAuthenticated();
  const isAdmin = isAuthenticated && authUtils.isAdmin();
  const canPublishPgyerOrTestFlight = isAuthenticated && authUtils.hasAnyRole(['tester', 'developer', 'admin']);
  const canPublishAppStore = isAuthenticated && authUtils.hasAnyRole(['product', 'admin']);

  return {
    isAdmin,
    canPublishPgyerOrTestFlight,
    canUseQuality: canPublishPgyerOrTestFlight,
    canPublishAppStore,
    canOperateCicd: canPublishPgyerOrTestFlight || canPublishAppStore,
    canAdminCicd: isAdmin,
    canCreateReleaseBranch: isAuthenticated && authUtils.hasAnyRole(['developer', 'admin']),
  };
}
