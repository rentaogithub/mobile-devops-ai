import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { authService, PlatformRole, PlatformUser } from '../services/AuthService';
import { runWithProductLine } from '../services/ProductLineContext';

// 简单的密码认证中间件
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || AUTH_PASSWORD; // 管理员密码，默认与普通密码相同
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';

function resolveProductLine(req: Request, user: PlatformUser | null) {
  const requested = String(req.headers['x-product-line-id'] || '').trim();
  const available = user?.productLines || [];
  if (user?.role === 'admin') {
    const productLine = authService.findProductLine(requested || available[0]?.id || 'nn');
    if (!productLine || !productLine.active) return null;
    return { ...productLine, role: 'admin' as PlatformRole };
  }
  if (!user) {
    const productLine = authService.findProductLine(requested || 'nn');
    if (!productLine || productLine.id !== 'nn' || !productLine.active) return null;
    return { ...productLine, role: 'guest' as PlatformRole };
  }
  return available.find((item) => item.id === requested || item.key === requested || item.projectId === requested)
    || (!requested ? available.find((item) => item.id === 'nn') || available[0] : undefined)
    || null;
}

export const productLineContextMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const user = authService.getSessionUser(req);
  const productLine = resolveProductLine(req, user);
  if (!productLine) {
    res.status(user ? 403 : 401).json({
      success: false,
      error: user ? '无权访问该产品线' : '请登录后访问该产品线',
      code: user ? 'PRODUCT_LINE_FORBIDDEN' : 'SESSION_REQUIRED',
    });
    return;
  }
  if (user) (req as any).authUser = user;
  (req as any).productLine = productLine;
  (req as any).effectiveRole = productLine.role;
  (req as any).isAdmin = user?.role === 'admin';
  runWithProductLine({
    id: productLine.id,
    key: productLine.key,
    name: productLine.name,
    projectId: productLine.projectId,
    role: productLine.role,
  }, next);
};

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const sessionUser = authService.getSessionUser(req);
  if (sessionUser) {
    (req as any).authUser = sessionUser;
    (req as any).isAdmin = sessionUser.role === 'admin';
    return next();
  }

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
  const sessionUser = authService.getSessionUser(req);
  if (sessionUser?.role === 'admin') {
    (req as any).authUser = sessionUser;
    (req as any).isAdmin = true;
    return next();
  }

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

export const sessionAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const user = authService.getSessionUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请使用实名账号登录', code: 'SESSION_REQUIRED' });
    return;
  }
  (req as any).authUser = user;
  (req as any).isAdmin = user.role === 'admin';
  next();
};

function roleLabel(role: PlatformRole) {
  const labels: Record<PlatformRole, string> = {
    guest: '游客',
    tester: '测试',
    developer: '研发',
    product: '产品运营',
    admin: '管理员',
  };
  return labels[role] || role;
}

function canSatisfyRole(userRole: PlatformRole, requiredRole: PlatformRole) {
  if (userRole === 'admin') return true;
  if (requiredRole === 'guest') return ['guest', 'tester', 'developer', 'product'].includes(userRole);
  if (requiredRole === 'tester') return ['tester', 'developer'].includes(userRole);
  if (requiredRole === 'developer') return userRole === 'developer';
  if (requiredRole === 'product') return userRole === 'product';
  return false;
}

export function requireRole(role: PlatformRole) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = ((req as any).authUser || authService.getSessionUser(req)) as PlatformUser | null;
    if (!AUTH_ENABLED) {
      (req as any).isAdmin = true;
      next();
      return;
    }
    const effectiveRole = role === 'admin'
      ? user?.role
      : ((req as any).effectiveRole || resolveProductLine(req, user)?.role || user?.role);
    if (!user || !effectiveRole || !canSatisfyRole(effectiveRole, role)) {
      res.status(403).json({ success: false, error: `需要 ${roleLabel(role)} 权限`, code: 'FORBIDDEN' });
      return;
    }
    (req as any).authUser = user;
    next();
  };
}

export function requireAnyRole(roles: PlatformRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = ((req as any).authUser || authService.getSessionUser(req)) as PlatformUser | null;
    if (!AUTH_ENABLED) {
      (req as any).isAdmin = true;
      next();
      return;
    }
    const effectiveRole = user?.role === 'admin'
      ? 'admin'
      : ((req as any).effectiveRole || resolveProductLine(req, user)?.role || user?.role);
    if (!user || !effectiveRole || !roles.includes(effectiveRole)) {
      res.status(403).json({
        success: false,
        error: `需要 ${roles.map(roleLabel).join('、')} 权限`,
        code: 'FORBIDDEN',
      });
      return;
    }
    (req as any).authUser = user;
    (req as any).isAdmin = user.role === 'admin';
    next();
  };
}

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
