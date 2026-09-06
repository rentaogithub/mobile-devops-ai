// 认证工具函数

const AUTH_USER_KEY = 'auth_user';
const ACTIVE_PRODUCT_LINE_KEY = 'active_product_line_id';

export interface AuthProductLine {
  id: string;
  key: string;
  name: string;
  projectId: string;
  bundleId?: string;
  jenkinsBaseUrl?: string;
  active: boolean;
  role: AuthUser['role'];
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: 'guest' | 'tester' | 'developer' | 'product' | 'admin';
  active: boolean;
  productLines: AuthProductLine[];
}

function normalizeUser(user: AuthUser): AuthUser {
  const legacyRole = String(user.role || '');
  const role = legacyRole === 'viewer'
    ? 'guest'
    : (legacyRole === 'operator' ? 'tester' : legacyRole);
  return {
    ...user,
    role: (['guest', 'tester', 'developer', 'product', 'admin'].includes(role) ? role : 'guest') as AuthUser['role'],
    productLines: Array.isArray(user.productLines) ? user.productLines : [],
  };
}

function emitAuthStateChanged() {
  window.dispatchEvent(new Event('auth-state-changed'));
}

function persistActiveProductLineCookie(productLineId?: string) {
  document.cookie = productLineId
    ? `active_product_line_id=${encodeURIComponent(productLineId)}; Path=/; SameSite=Lax`
    : 'active_product_line_id=; Path=/; Max-Age=0; SameSite=Lax';
}

export const authUtils = {
  setUser: (user: AuthUser) => {
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(normalizeUser(user)));
    const selectedId = localStorage.getItem(ACTIVE_PRODUCT_LINE_KEY);
    const active = user.productLines.find((item) => item.id === selectedId)
      || user.productLines.find((item) => item.id === 'nn')
      || user.productLines[0];
    if (active) persistActiveProductLineCookie(active.id);
    emitAuthStateChanged();
  },

  getUser: (): AuthUser | null => {
    try {
      const value = localStorage.getItem(AUTH_USER_KEY);
      return value ? normalizeUser(JSON.parse(value) as AuthUser) : null;
    } catch {
      return null;
    }
  },

  clearUser: () => {
    localStorage.removeItem(AUTH_USER_KEY);
    localStorage.removeItem(ACTIVE_PRODUCT_LINE_KEY);
    persistActiveProductLineCookie();
    emitAuthStateChanged();
  },

  isAuthenticated: (): boolean => {
    return !!authUtils.getUser();
  },

  isAdmin: (): boolean => {
    return authUtils.getUser()?.role === 'admin';
  },

  getActiveProductLine: (): AuthProductLine | null => {
    const user = authUtils.getUser();
    if (!user?.productLines.length) return null;
    const selectedId = localStorage.getItem(ACTIVE_PRODUCT_LINE_KEY);
    return user.productLines.find((item) => item.id === selectedId)
      || user.productLines.find((item) => item.id === 'nn')
      || user.productLines[0];
  },

  setActiveProductLine: (productLineId: string) => {
    const user = authUtils.getUser();
    if (!user?.productLines.some((item) => item.id === productLineId)) return false;
    localStorage.setItem(ACTIVE_PRODUCT_LINE_KEY, productLineId);
    persistActiveProductLineCookie(productLineId);
    emitAuthStateChanged();
    window.dispatchEvent(new Event('product-line-changed'));
    return true;
  },

  getActiveRole: (): AuthUser['role'] | null => {
    const user = authUtils.getUser();
    if (!user) return null;
    if (user.role === 'admin') return 'admin';
    return authUtils.getActiveProductLine()?.role || null;
  },

  hasRole: (role: AuthUser['role']): boolean => {
    const currentRole = authUtils.getActiveRole();
    if (!currentRole) return false;
    if (currentRole === 'admin') return true;
    if (role === 'guest') return ['guest', 'tester', 'developer', 'product'].includes(currentRole);
    if (role === 'tester') return ['tester', 'developer'].includes(currentRole);
    if (role === 'developer') return currentRole === 'developer';
    if (role === 'product') return currentRole === 'product';
    return false;
  },

  hasAnyRole: (roles: AuthUser['role'][]): boolean => {
    const currentRole = authUtils.getActiveRole();
    return Boolean(currentRole && roles.includes(currentRole));
  },

  refreshUser: async (): Promise<AuthUser | null> => {
    try {
      const activeProductLineId = localStorage.getItem(ACTIVE_PRODUCT_LINE_KEY);
      const response = await fetch('/api/auth/me', {
        credentials: 'include',
        headers: activeProductLineId ? { 'X-Product-Line-Id': activeProductLineId } : undefined,
      });
      if (!response.ok) throw new Error('not authenticated');
      const data = await response.json();
      const user = data.data?.user as AuthUser;
      authUtils.setUser(user);
      return user;
    } catch {
      authUtils.clearUser();
      return null;
    }
  },
};
