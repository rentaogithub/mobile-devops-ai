// 认证工具函数

const AUTH_USER_KEY = 'auth_user';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: 'guest' | 'tester' | 'developer' | 'product' | 'admin';
  active: boolean;
}

function normalizeUser(user: AuthUser): AuthUser {
  const legacyRole = String(user.role || '');
  const role = legacyRole === 'viewer'
    ? 'guest'
    : (legacyRole === 'operator' ? 'tester' : legacyRole);
  return {
    ...user,
    role: (['guest', 'tester', 'developer', 'product', 'admin'].includes(role) ? role : 'guest') as AuthUser['role'],
  };
}

function emitAuthStateChanged() {
  window.dispatchEvent(new Event('auth-state-changed'));
}

export const authUtils = {
  setUser: (user: AuthUser) => {
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(normalizeUser(user)));
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
    emitAuthStateChanged();
  },

  isAuthenticated: (): boolean => {
    return !!authUtils.getUser();
  },

  isAdmin: (): boolean => {
    return authUtils.getUser()?.role === 'admin';
  },

  hasRole: (role: AuthUser['role']): boolean => {
    const currentRole = authUtils.getUser()?.role;
    if (!currentRole) return false;
    if (currentRole === 'admin') return true;
    if (role === 'guest') return ['guest', 'tester', 'developer', 'product'].includes(currentRole);
    if (role === 'tester') return ['tester', 'developer'].includes(currentRole);
    if (role === 'developer') return currentRole === 'developer';
    if (role === 'product') return currentRole === 'product';
    return false;
  },

  hasAnyRole: (roles: AuthUser['role'][]): boolean => {
    const currentRole = authUtils.getUser()?.role;
    return Boolean(currentRole && roles.includes(currentRole));
  },

  refreshUser: async (): Promise<AuthUser | null> => {
    try {
      const response = await fetch('/api/auth/me', { credentials: 'include' });
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
