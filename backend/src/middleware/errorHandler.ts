import { Request, Response, NextFunction } from 'express';
import { AppError } from '../types';
import logger from '../utils/logger';

/**
 * 全局错误处理中间件
 */
export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  // 记录错误
  logger.error('请求处理错误', {
    method: req.method,
    url: req.url,
    error: err.message,
    stack: err.stack,
  });

  // 如果是自定义错误
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
    });
  }

  // Multer 文件上传错误
  if (err.name === 'MulterError') {
    if (err.message.includes('File too large')) {
      return res.status(413).json({
        success: false,
        error: '文件大小超过限制',
      });
    }
    return res.status(400).json({
      success: false,
      error: '文件上传失败',
    });
  }

  // 默认 500 错误
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? '服务器内部错误' : err.message,
  });
}

/**
 * 404 处理中间件
 */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    success: false,
    error: '接口不存在',
  });
}
