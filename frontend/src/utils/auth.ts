// 认证工具函数

const AUTH_TOKEN_KEY = 'auth_token';
const ADMIN_KEY = 'is_admin';

function emitAuthStateChanged() {
  window.dispatchEvent(new Event('auth-state-changed'));
}

function readStorageValue(key: string): string | null {
  return localStorage.getItem(key) || sessionStorage.getItem(key);
}

function migrateSessionAuth() {
  const sessionToken = sessionStorage.getItem(AUTH_TOKEN_KEY);
  const sessionAdmin = sessionStorage.getItem(ADMIN_KEY);
  if (sessionToken && !localStorage.getItem(AUTH_TOKEN_KEY)) {
    localStorage.setItem(AUTH_TOKEN_KEY, sessionToken);
  }
  if (sessionAdmin && !localStorage.getItem(ADMIN_KEY)) {
    localStorage.setItem(ADMIN_KEY, sessionAdmin);
  }
}

export const authUtils = {
  // 保存认证令牌
  setToken: (token: string) => {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    emitAuthStateChanged();
  },

  // 获取认证令牌
  getToken: (): string | null => {
    migrateSessionAuth();
    return readStorageValue(AUTH_TOKEN_KEY);
  },

  // 清除认证令牌
  clearToken: () => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(ADMIN_KEY);
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    sessionStorage.removeItem(ADMIN_KEY);
    emitAuthStateChanged();
  },

  // 检查是否已认证
  isAuthenticated: (): boolean => {
    migrateSessionAuth();
    return !!readStorageValue(AUTH_TOKEN_KEY);
  },

  // 检查是否是管理员
  isAdmin: (): boolean => {
    migrateSessionAuth();
    return readStorageValue(ADMIN_KEY) === 'true';
  },

  // 设置管理员状态
  setAdmin: (isAdmin: boolean) => {
    localStorage.setItem(ADMIN_KEY, isAdmin.toString());
    sessionStorage.removeItem(ADMIN_KEY);
    emitAuthStateChanged();
  },

  // 检查认证状态
  checkAuthStatus: async (): Promise<{ authEnabled: boolean }> => {
    try {
      const response = await fetch('/api/auth/status');
      const data = await response.json();
      return {
        authEnabled: data.data?.authEnabled || false,
      };
    } catch (error) {
      return { authEnabled: false };
    }
  },
};
