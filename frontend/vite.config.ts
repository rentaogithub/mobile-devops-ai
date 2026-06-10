import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backendTarget = process.env.VITE_BACKEND_TARGET || 'http://127.0.0.1:3000';
const backendWsTarget = backendTarget.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // 监听所有网络接口
    port: 5173,
    strictPort: true, // 强制使用 5173 端口，如果被占用则报错
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
        secure: false,
        ws: true,
        timeout: 600000, // 10分钟超时
      },
      '/sentry': {
        target: backendTarget,
        changeOrigin: false,
        secure: false,
        timeout: 600000,
      },
      '/ws': {
        target: backendWsTarget,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
