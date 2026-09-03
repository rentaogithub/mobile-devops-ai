import { Router } from 'express';
import { requireRole, sessionAuthMiddleware, verifyPassword } from '../middleware/auth';
import { authService } from '../services/AuthService';
import { platformConfigService } from '../services/PlatformConfigService';

const router = Router();

/**
 * POST /api/auth/verify
 * 验证密码
 */
router.post('/verify', verifyPassword);

router.post('/login', (req, res) => {
  const username = String(req.body?.username || process.env.ADMIN_USERNAME || 'admin').trim();
  const password = String(req.body?.password || '');
  const user = authService.authenticate(username, password);
  if (!user) {
    res.status(401).json({ success: false, error: '用户名或密码错误' });
    return;
  }
  authService.createSession(user, req, res);
  res.json({ success: true, data: { user } });
});

router.post('/register', (req, res) => {
  try {
    const request = authService.createRegistrationRequest(req.body || {});
    res.json({
      success: true,
      data: request,
      message: '注册申请已提交，等待管理员审核',
    });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || '提交注册申请失败' });
  }
});

router.post('/logout', (req, res) => {
  authService.clearSession(req, res);
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  const user = authService.refreshSession(req, res);
  if (!user) {
    res.status(401).json({ success: false, error: '未登录' });
    return;
  }
  res.json({ success: true, data: { user } });
});

router.get('/users', sessionAuthMiddleware, requireRole('admin'), (_req, res) => {
  res.json({ success: true, data: authService.listUsers() });
});

router.get('/platform-config', sessionAuthMiddleware, requireRole('admin'), (_req, res) => {
  const actor = (_req as any).authUser;
  res.json({ success: true, data: { ...platformConfigService.adminView(), adminPassword: authService.getPasswordForDisplay(actor.id) || undefined } });
});

router.get('/runtime-config-status', sessionAuthMiddleware, (_req, res) => {
  res.json({ success: true, data: platformConfigService.status() });
});

router.put('/platform-config', sessionAuthMiddleware, requireRole('admin'), (req, res) => {
  try {
    const actor = (req as any).authUser;
    const currentPassword = String(req.body?.currentPassword || '');
    const newAdminPassword = String(req.body?.newAdminPassword || '');
    if (newAdminPassword) {
      authService.changePassword(actor.id, currentPassword, newAdminPassword);
    }
    if (req.body?.releaseVerificationPassword !== undefined) {
      platformConfigService.set('RELEASE_VERIFY_PASSWORD', String(req.body.releaseVerificationPassword || ''), actor.id);
    }
    if (req.body?.aiApiKey !== undefined) {
      platformConfigService.set('OPENAI_API_KEY', String(req.body.aiApiKey || ''), actor.id);
    }
    res.json({ success: true, data: platformConfigService.status(), message: '平台配置已保存' });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || '平台配置保存失败' });
  }
});

router.get('/registration-requests', sessionAuthMiddleware, requireRole('admin'), (_req, res) => {
  res.json({ success: true, data: authService.listRegistrationRequests() });
});

router.post('/registration-requests/:id/approve', sessionAuthMiddleware, requireRole('admin'), (req, res) => {
  try {
    const result = authService.approveRegistrationRequest(req.params.id, (req as any).authUser);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || '通过注册申请失败' });
  }
});

router.post('/registration-requests/:id/reject', sessionAuthMiddleware, requireRole('admin'), (req, res) => {
  try {
    const request = authService.rejectRegistrationRequest(req.params.id, (req as any).authUser, req.body?.message);
    res.json({ success: true, data: request });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || '拒绝注册申请失败' });
  }
});

router.post('/users', sessionAuthMiddleware, requireRole('admin'), (req, res) => {
  try {
    res.json({ success: true, data: authService.createUser(req.body || {}) });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || '创建用户失败' });
  }
});

router.patch('/users/:id', sessionAuthMiddleware, requireRole('admin'), (req, res) => {
  try {
    const updated = authService.updateUser(req.params.id, req.body || {});
    if (!updated) {
      res.status(404).json({ success: false, error: '用户不存在' });
      return;
    }
    res.json({ success: true, data: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || '更新用户失败' });
  }
});

router.delete('/users/:id', sessionAuthMiddleware, requireRole('admin'), (req, res) => {
  try {
    authService.deleteUser(req.params.id, (req as any).authUser?.id);
    res.json({ success: true });
  } catch (error: any) {
    const message = error?.message || '删除用户失败';
    const status = message === '用户不存在' ? 404 : 400;
    res.status(status).json({ success: false, error: message });
  }
});

/**
 * GET /api/auth/status
 * 检查认证状态
 */
router.get('/status', (req, res) => {
  const authEnabled = process.env.AUTH_ENABLED === 'true';
  const user = authService.refreshSession(req, res);
  res.json({
    success: true,
    data: {
      authEnabled,
      localAccountsEnabled: true,
      user,
    },
  });
});

export default router;
