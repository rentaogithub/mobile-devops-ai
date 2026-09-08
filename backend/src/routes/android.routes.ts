import { Router } from 'express';
import { requireApplicationPlatform, sessionAuthMiddleware, requireRole } from '../middleware/auth';
import { androidDeliveryService as service } from '../services/AndroidDeliveryService';
const router = Router();
router.use(sessionAuthMiddleware, requireApplicationPlatform('android'));
const handle = (operation: (req: any, res: any) => any) => async (req: any, res: any) => {
  try { const data = await operation(req, res); if (!res.headersSent) res.json({ success: true, data }); }
  catch (error: any) { if (!res.headersSent) res.status(409).json({ success: false, error: error.message }); }
};
router.get('/readiness', handle(() => service.readiness()));
router.get('/issues', handle(() => service.issues()));
router.post('/issues/:id/resolve', requireRole('tester'), handle((req) => service.resolveIssue(req.params.id, req.body?.smokeRunId)));
router.get('/runs', handle(() => service.list()));
router.get('/runs/:id/gate', handle((req) => service.gate(req.params.id)));
router.post('/runs', requireRole('tester'), handle((req) => service.trigger(req.body || {})));
router.post('/runs/:id/sync', requireRole('tester'), handle((req) => service.refresh(req.params.id)));
router.post('/runs/:id/cancel', requireRole('tester'), handle((req) => service.cancel(req.params.id)));
router.get('/runs/:id/download', requireRole('tester'), handle(async (req, res) => {
  const bytes = await service.download(req.params.id);
  res.set({ 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': `attachment; filename="android-${req.params.id}.apk"`, 'Cache-Control': 'no-store' }).send(bytes);
}));
export default router;
