import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { networkInterfaces } from 'os';

function getLocalBackendTarget() {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
  const preferred =
    addresses.find((address) => address.startsWith('10.')) ||
    addresses.find((address) => address.startsWith('192.168.')) ||
    addresses.find((address) => /^172\.(1[6-9]|2\d|3[01])\./.test(address)) ||
    addresses[0] ||
    '127.0.0.1';
  return `http://${preferred}:3000`;
}

const backendTarget = process.env.VITE_BACKEND_TARGET || getLocalBackendTarget();
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
      '/install-cocoapods-podx.sh': {
        target: backendTarget,
        changeOrigin: true,
        secure: false,
      },
      '^/sentry(?=/|$)': {
        target: backendTarget,
        changeOrigin: false,
        secure: false,
        timeout: 600000,
      },
      '^/(organizations|settings|auth|_static|_assets|avatar|static)(?=/|$)': {
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
