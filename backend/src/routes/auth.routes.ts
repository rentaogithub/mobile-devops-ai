import { Router } from 'express';
import { verifyPassword } from '../middleware/auth';

const router = Router();

/**
 * POST /api/auth/verify
 * 验证密码
 */
router.post('/verify', verifyPassword);

/**
 * GET /api/auth/status
 * 检查认证状态
 */
router.get('/status', (req, res) => {
  const authEnabled = process.env.AUTH_ENABLED === 'true';
  res.json({
    success: true,
    data: {
      authEnabled,
    },
  });
});

export default router;
