import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// 必须最先加载，确保后续模块能读到环境变量
dotenv.config({ path: path.join(__dirname, '../.env') });

import { initializeDatabase } from './database';
import { errorHandler, notFoundHandler } from './middleware';
import dsymRoutes from './routes/dsym.routes';
import symbolicateRoutes from './routes/symbolicate.routes';
import authRoutes from './routes/auth.routes';
import cleanupRoutes from './routes/cleanup.routes';
import historyRoutes from './routes/history.routes';
import moduleRoutes from './routes/module.routes';
import wechatRoutes from './routes/wechat.routes';
import podsRoutes from './routes/pods.routes';
import gitRoutes from './routes/git.routes';
import pairingRoutes from './routes/pairing.routes';
import { authMiddleware } from './middleware/auth';
import cleanupService from './services/CleanupService';
import podService from './services/PodService';
import logger from './utils/logger';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// 初始化数据库
initializeDatabase();
podService.initTable();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 请求日志
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', database: 'connected' });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/dsym', dsymRoutes);
app.use('/api/symbolicate', symbolicateRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/cleanup', authMiddleware, cleanupRoutes);
app.use('/api/config', moduleRoutes);
app.use('/api/wechat', wechatRoutes);
app.use('/api/pods', podsRoutes);
app.use('/api/git', gitRoutes);
app.use('/api/pairing', pairingRoutes);

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

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Server is running on http://0.0.0.0:${PORT}`);
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
  cleanupService.start();
});

export default app;
