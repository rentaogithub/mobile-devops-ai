// 认证工具函数

const AUTH_TOKEN_KEY = 'auth_token';

export const authUtils = {
  // 保存认证令牌
  setToken: (token: string) => {
    sessionStorage.setItem(AUTH_TOKEN_KEY, token);
  },

  // 获取认证令牌
  getToken: (): string | null => {
    return sessionStorage.getItem(AUTH_TOKEN_KEY);
  },

  // 清除认证令牌
  clearToken: () => {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
  },

  // 检查是否已认证
  isAuthenticated: (): boolean => {
    return !!sessionStorage.getItem(AUTH_TOKEN_KEY);
  },

  // 检查是否是管理员
  isAdmin: (): boolean => {
    return sessionStorage.getItem('is_admin') === 'true';
  },

  // 设置管理员状态
  setAdmin: (isAdmin: boolean) => {
    sessionStorage.setItem('is_admin', isAdmin.toString());
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
