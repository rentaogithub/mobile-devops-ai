// 认证工具函数

const AUTH_USER_KEY = 'auth_user';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: 'viewer' | 'operator' | 'admin';
  active: boolean;
}

function emitAuthStateChanged() {
  window.dispatchEvent(new Event('auth-state-changed'));
}

export const authUtils = {
  setUser: (user: AuthUser) => {
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
    emitAuthStateChanged();
  },

  getUser: (): AuthUser | null => {
    try {
      const value = localStorage.getItem(AUTH_USER_KEY);
      return value ? JSON.parse(value) as AuthUser : null;
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
