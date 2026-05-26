import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

// 简单的密码认证中间件
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || AUTH_PASSWORD; // 管理员密码，默认与普通密码相同
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // 如果未启用认证，直接通过（所有人都是管理员）
  if (!AUTH_ENABLED || !AUTH_PASSWORD) {
    (req as any).isAdmin = true;
    return next();
  }

  // 检查请求头中的认证信息
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    logger.warn('未提供认证信息', { ip: req.ip, path: req.path });
    return res.status(401).json({
      success: false,
      error: '需要认证',
      code: 'UNAUTHORIZED',
    });
  }

  // 验证密码
  const providedPassword = authHeader.replace('Bearer ', '');
  
  if (providedPassword !== AUTH_PASSWORD && providedPassword !== ADMIN_PASSWORD) {
    logger.warn('认证失败', { ip: req.ip, path: req.path });
    return res.status(401).json({
      success: false,
      error: '认证失败',
      code: 'INVALID_CREDENTIALS',
    });
  }

  // 认证成功，设置用户角色
  (req as any).isAdmin = providedPassword === ADMIN_PASSWORD;
  next();
};

// 管理员权限中间件
export const adminMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // 如果未启用认证，直接通过（所有人都是管理员）
  if (!AUTH_ENABLED || !ADMIN_PASSWORD) {
    return next();
  }

  // 检查请求头中的认证信息
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    logger.warn('需要管理员权限但未提供认证信息', { ip: req.ip, path: req.path });
    return res.status(403).json({
      success: false,
      error: '需要管理员权限',
      code: 'FORBIDDEN',
    });
  }

  // 验证是否是管理员密码
  const providedPassword = authHeader.replace('Bearer ', '');
  
  if (providedPassword !== ADMIN_PASSWORD) {
    logger.warn('需要管理员权限', { ip: req.ip, path: req.path });
    return res.status(403).json({
      success: false,
      error: '需要管理员权限',
      code: 'FORBIDDEN',
    });
  }

  // 管理员认证成功
  (req as any).isAdmin = true;
  next();
};

// 验证密码的路由处理器
export const verifyPassword = (req: Request, res: Response) => {
  const { password } = req.body;

  if (!AUTH_ENABLED || !ADMIN_PASSWORD) {
    return res.json({
      success: true,
      message: '认证已禁用',
      data: {
        isAdmin: true,
      },
    });
  }

  // 只验证管理员密码
  const isAdmin = password === ADMIN_PASSWORD;

  if (isAdmin) {
    logger.info('管理员认证成功', { ip: req.ip });
    return res.json({
      success: true,
      message: '管理员认证成功',
      data: {
        isAdmin: true,
      },
    });
  }

  logger.warn('管理员密码验证失败', { ip: req.ip });
  return res.status(401).json({
    success: false,
    error: '管理员密码错误',
  });
};
