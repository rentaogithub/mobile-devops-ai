import './config/env';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import http from 'http';

import { initializeDatabase } from './database';
import { errorHandler, notFoundHandler } from './middleware';
import dsymRoutes from './routes/dsym.routes';
import symbolicateRoutes from './routes/symbolicate.routes';
import androidRoutes from './routes/android.routes';
import authRoutes from './routes/auth.routes';
import cleanupRoutes from './routes/cleanup.routes';
import historyRoutes from './routes/history.routes';
import moduleRoutes from './routes/module.routes';
import wechatRoutes from './routes/wechat.routes';
import podsRoutes from './routes/pods.routes';
import gitRoutes from './routes/git.routes';
import jenkinsRoutes from './routes/jenkins.routes';
import qualityRoutes from './routes/quality.routes';
import pairingRoutes from './routes/pairing.routes';
import sentryProxyRoutes from './routes/sentryProxy.routes';
import sentryAnalysisRoutes from './routes/sentryAnalysis.routes';
import watermarkRoutes from './routes/watermark.routes';
import sonicProxyRoutes from './routes/sonicProxy.routes';
import opProxyRoutes from './routes/opProxy.routes';
import userQueryRecordsRoutes from './routes/userQueryRecords.routes';
import feedbackLogRoutes from './routes/feedbackLog.routes';
import accessStatsRoutes from './routes/accessStats.routes';
import apiDocsRoutes from './routes/apiDocs.routes';
import workflowRoutes from './routes/workflow.routes';
import appleDeviceRoutes from './routes/appleDevice.routes';
import assistantRoutes from './routes/assistant.routes';
import deviceControlRoutes from './routes/deviceControl.routes';
import { authMiddleware, productLineContextMiddleware, requireApplicationPlatform, selectedServiceMiddleware, requireApplicationServices } from './middleware/auth';
import cleanupService from './services/CleanupService';
import podService from './services/PodService';
import { browserLogWebSocketService } from './services/BrowserLogWebSocketService';
import { platformOperationsService } from './services/PlatformOperationsService';
import { clearOpAccessToken, getOpAccessToken, isOpAccessTokenUsable, updateOpAccessToken } from './services/OpCookieJar';
import logger from './utils/logger';
import { authService } from './services/AuthService';
import { assistantToolRegistry } from './services/AssistantToolRegistry';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.set('trust proxy', true);

// 初始化数据库
initializeDatabase();
authService.initializeBootstrapUser();
podService.initTable();
assistantToolRegistry.syncCapabilityDataset();

// Middleware
app.use(cors());
// Sentry 反向代理需要保留原始请求体，必须放在 body parser 前面。
const sentryProxyPaths = [
  '/sentry',
  '/_static',
  '/_assets',
  '/avatar',
  '/auth',
  '/organizations',
  '/settings',
  '/api/0',
];
sentryProxyPaths.forEach((proxyPath) => app.use(proxyPath, productLineContextMiddleware, requireApplicationPlatform('ios'), requireApplicationServices('sentry'), sentryProxyRoutes));
app.use('/op', productLineContextMiddleware, requireApplicationServices('logs'), opProxyRoutes);
app.use('/jeecg-boot', productLineContextMiddleware, requireApplicationServices('logs'), opProxyRoutes);
app.use('/sys', productLineContextMiddleware, requireApplicationServices('logs'), opProxyRoutes);
app.use('/sonic-admin', productLineContextMiddleware, requireApplicationPlatform('ios'), requireApplicationServices('devices'), sonicProxyRoutes);
app.use('/sonic-api', productLineContextMiddleware, requireApplicationPlatform('ios'), requireApplicationServices('devices'), sonicProxyRoutes);
// iOS Profile Service 回调是签名/原始请求体，必须在全局 body parser 前处理。
app.use('/api/apple-devices', appleDeviceRoutes);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 请求日志
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`);
  next();
});

// Health checks
app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok', pid: process.pid, uptimeSeconds: Math.round(process.uptime()), checkedAt: new Date().toISOString() });
});

app.get('/health/ready', (_req, res) => {
  const readiness = platformOperationsService.readiness();
  res.status(readiness.ready ? 200 : 503).json(readiness);
});

app.get('/health', (_req, res) => {
  const readiness = platformOperationsService.readiness();
  res.status(readiness.ready ? 200 : 503).json({ status: readiness.ready ? 'ok' : 'error', ...readiness });
});

app.get('/api/health/dependencies', productLineContextMiddleware, async (_req, res) => {
  const result = await platformOperationsService.dependencies();
  res.status(result.status === 'healthy' ? 200 : 207).json({ success: true, data: result });
});

app.post('/api/op-auth/sync', productLineContextMiddleware, requireApplicationServices('logs'), (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token || token.length < 16) {
    res.status(400).json({ success: false, error: '缺少有效 OP token' });
    return;
  }
  if (!isOpAccessTokenUsable(token, Date.now())) {
    res.status(401).json({ success: false, error: 'OP token 已过期' });
    return;
  }
  updateOpAccessToken(token);
  res.json({ success: true });
});

app.post('/api/op-auth/clear', productLineContextMiddleware, requireApplicationServices('logs'), (_req, res) => {
  clearOpAccessToken();
  res.json({ success: true });
});

app.get('/api/op-auth/status', productLineContextMiddleware, requireApplicationServices('logs'), (_req, res) => {
  const token = getOpAccessToken();
  res.json({
    success: true,
    hasToken: Boolean(token),
    tokenUpdated: Boolean(token),
  });
});

const backendPublic = path.join(__dirname, '../public');
if (fs.existsSync(backendPublic)) {
  app.use(express.static(backendPublic, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.sh')) {
        res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
}

app.get('/logs/view', (req, res) => {
  const pairingId = typeof req.query.pairingId === 'string' ? req.query.pairingId : '';
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const wsUrl = typeof req.query.wsUrl === 'string' && req.query.wsUrl
    ? req.query.wsUrl
    : `ws://${req.get('host') || `127.0.0.1:${PORT}`}/ws/logs`;

  const browserWsUrl = new URL(wsUrl);
  browserWsUrl.searchParams.set('role', 'browser');
  browserWsUrl.searchParams.set('pairingId', pairingId);
  browserWsUrl.searchParams.set('token', token);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NN Browser Log</title>
  <style>
    body { margin: 0; background: #101114; color: #e6e6e6; font-family: Menlo, Monaco, Consolas, monospace; }
    header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #1b1d22; border-bottom: 1px solid #333842; }
    button { padding: 5px 10px; color: #fff; background: #2d6cdf; border: 0; border-radius: 4px; cursor: pointer; }
    #status { color: #8bd17c; font-size: 12px; }
    #logs { padding: 12px 16px; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.55; }
    .error { color: #ff6b6b; }
    .warning { color: #ffd166; }
    .debug { color: #7bd88f; }
  </style>
</head>
<body>
  <header>
    <strong>NN Browser Log</strong>
    <button onclick="logs.innerHTML=''">Clear</button>
    <span id="status">Connecting...</span>
  </header>
  <main id="logs"></main>
  <script>
    const logs = document.getElementById('logs');
    const status = document.getElementById('status');
    const socket = new WebSocket(${JSON.stringify(browserWsUrl.toString())});
    function append(line) {
      const div = document.createElement('div');
      div.textContent = line;
      if (line.includes('[Error]')) div.className = 'error';
      else if (line.includes('[Warning]')) div.className = 'warning';
      else if (line.includes('[Debug]')) div.className = 'debug';
      logs.appendChild(div);
      window.scrollTo(0, document.body.scrollHeight);
    }
    socket.onopen = () => { status.textContent = 'Connected'; };
    socket.onclose = () => { status.textContent = 'Disconnected'; };
    socket.onerror = () => { status.textContent = 'Error'; };
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'log') append(data.line || data.message || event.data);
        else if (data.type === 'status') status.textContent = data.status;
      } catch {
        append(event.data);
      }
    };
  </script>
</body>
</html>`);
});

// API Routes
const applicationAccess = [productLineContextMiddleware, selectedServiceMiddleware];
app.use('/api/auth', authRoutes);
app.use('/api/android', applicationAccess, androidRoutes);
app.use('/api/dsym', applicationAccess, requireApplicationPlatform('ios'), dsymRoutes);
app.use('/api/symbolicate', applicationAccess, requireApplicationPlatform('ios'), symbolicateRoutes);
app.use('/api/history', applicationAccess, requireApplicationPlatform('ios'), historyRoutes);
app.use('/api/cleanup', applicationAccess, requireApplicationPlatform('ios'), authMiddleware, cleanupRoutes);
app.use('/api/config', applicationAccess, requireApplicationPlatform('ios'), moduleRoutes);
app.use('/api/wechat', applicationAccess, requireApplicationPlatform('ios'), wechatRoutes);
app.use('/api/pods', applicationAccess, requireApplicationPlatform('ios'), podsRoutes);
app.use('/api/git', applicationAccess, requireApplicationPlatform('ios'), gitRoutes);
app.use('/api/jenkins', applicationAccess, requireApplicationPlatform('ios'), jenkinsRoutes);
app.use('/api/quality', applicationAccess, requireApplicationPlatform('ios'), qualityRoutes);
app.use('/api/pairing', applicationAccess, requireApplicationPlatform('ios'), pairingRoutes);
app.use('/api/watermark', applicationAccess, requireApplicationPlatform('ios'), authMiddleware, watermarkRoutes);
app.use('/api/sentry-analysis', applicationAccess, requireApplicationPlatform('ios'), sentryAnalysisRoutes);
app.use('/api/user-query-records', applicationAccess, requireApplicationPlatform('ios'), userQueryRecordsRoutes);
app.use('/api/feedback-log', applicationAccess, requireApplicationPlatform('ios'), feedbackLogRoutes);
app.use('/api/access-stats', applicationAccess, accessStatsRoutes);
app.use('/api/api-docs', applicationAccess, apiDocsRoutes);
app.use('/api/workflow', applicationAccess, requireApplicationPlatform('ios'), workflowRoutes);
app.use('/api/assistant', applicationAccess, assistantRoutes);
app.use('/api/device-control', applicationAccess, requireApplicationPlatform('ios'), deviceControlRoutes);

// 生产环境：serve 前端静态文件
const frontendDist = path.join(__dirname, '../../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist, {
    // JS/CSS 带 hash，可以长缓存；HTML 不缓存确保加载最新版本
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
  logger.info(`静态文件服务已启用: ${frontendDist}`);
} else {
  app.use(notFoundHandler);
}

// 错误处理
app.use(errorHandler);

// 创建 HTTP 服务器
const server = http.createServer(app);
browserLogWebSocketService.attach(server);

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Server is running on http://0.0.0.0:${PORT}`);
  logger.info(`WebSocket relay is running on ws://0.0.0.0:${PORT}/ws/logs`);
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
  cleanupService.start();
  platformOperationsService.start(PORT);
});

export default app;
