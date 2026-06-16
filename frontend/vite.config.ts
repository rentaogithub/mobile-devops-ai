import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { networkInterfaces } from 'os';

function getLocalAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
}

function getBackendCandidates() {
  const explicit = process.env.VITE_BACKEND_TARGET || process.env.BACKEND_TARGET;
  const addresses = getLocalAddresses();
  const candidates = [
    explicit,
    'http://127.0.0.1:3001',
    ...addresses.map((address) => `http://${address}:3001`),
    'http://127.0.0.1:3000',
    ...addresses.map((address) => `http://${address}:3000`),
  ].filter((target): target is string => Boolean(target));

  return Array.from(new Set(candidates));
}

async function isPlatformBackend(target: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);

  try {
    const response = await fetch(`${target}/health`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const contentType = response.headers.get('content-type') || '';
    return response.ok && contentType.includes('application/json');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveBackendTarget() {
  const candidates = getBackendCandidates();
  for (const candidate of candidates) {
    if (await isPlatformBackend(candidate)) {
      return candidate;
    }
  }

  return candidates[0] || 'http://127.0.0.1:3000';
}

export default defineConfig(async () => {
  const backendTarget = await resolveBackendTarget();
  const backendWsTarget = backendTarget.replace(/^http/, 'ws');

  return {
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
        '^/sonic-(admin|api)(?=/|$)': {
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
  };
});
