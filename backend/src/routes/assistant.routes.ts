import { createHash, randomBytes } from 'crypto';
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { requireRole } from '../middleware/auth';
import { assistantAttachmentService } from '../services/AssistantAttachmentService';
import { assistantAuditService } from '../services/AssistantAuditService';
import { AssistantEvent, assistantService } from '../services/AssistantService';
import { assistantCapabilityDatasetService } from '../services/AssistantCapabilityDatasetService';
import { authService, PlatformUser } from '../services/AuthService';
import { businessSemanticService } from '../services/BusinessSemanticService';
import { jenkinsAssistantService } from '../services/JenkinsAssistantService';
import logger from '../utils/logger';

const router = Router();
const upload = multer({ dest: assistantAttachmentService.uploadDir, limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const ASSISTANT_CLIENT_COOKIE = 'nn_assistant_client';
const ASSISTANT_CLIENT_TTL_SECONDS = 365 * 24 * 60 * 60;

function cookieValue(req: Request, name: string) {
  const prefix = `${name}=`;
  return String(req.headers.cookie || '')
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length) || '';
}

function anonymousAssistantUser(req: Request, res: Response): PlatformUser {
  let clientId = cookieValue(req, ASSISTANT_CLIENT_COOKIE);
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(clientId)) {
    clientId = randomBytes(24).toString('base64url');
    res.append('Set-Cookie', [
      `${ASSISTANT_CLIENT_COOKIE}=${clientId}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${ASSISTANT_CLIENT_TTL_SECONDS}`,
      process.env.NODE_ENV === 'production' ? 'Secure' : '',
    ].filter(Boolean).join('; '));
  }
  const clientHash = createHash('sha256').update(clientId).digest('hex').slice(0, 32);
  return {
    id: `assistant-anonymous:${clientHash}`,
    username: 'anonymous',
    displayName: '匿名访客',
    role: 'guest',
    active: true,
    productLines: [],
  };
}

router.use((req, _res, next) => {
  const sessionUser = authService.getSessionUser(req);
  const effectiveRole = (req as any).effectiveRole;
  const assistantUser = sessionUser
    ? { ...sessionUser, role: sessionUser.role === 'admin' ? 'admin' : (effectiveRole || sessionUser.role) }
    : anonymousAssistantUser(req, _res);
  (req as any).authUser = assistantUser;
  (req as any).isAdmin = assistantUser.role === 'admin';
  next();
});

function user(req: Request) {
  return (req as any).authUser as PlatformUser;
}

function startSSE(res: Response) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  return (event: AssistantEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function isAssistantOriginAllowed(headers: Request['headers']) {
  const origin = String(headers.origin || '').trim();
  if (!origin) return true;

  const fetchSite = String(headers['sec-fetch-site'] || '').trim().toLowerCase();
  // 浏览器是向当前页面同源的 /api 发起请求，开发代理只会在浏览器之后改写 Host。
  // Sec-Fetch-Site 由浏览器生成且页面脚本不能伪造，可避免把 Vite/Nginx 代理误判为跨站。
  if (fetchSite === 'same-origin') return true;
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') return false;

  try {
    const originUrl = new URL(origin);
    const host = String(headers.host || '').trim().toLowerCase();
    const configuredOrigins = String(process.env.ASSISTANT_ALLOWED_ORIGINS || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .flatMap((item) => {
        try { return [new URL(item).origin.toLowerCase()]; } catch { return []; }
      });
    return originUrl.host.toLowerCase() === host || configuredOrigins.includes(originUrl.origin.toLowerCase());
  } catch {
    return false;
  }
}

function sameOrigin(req: Request, res: Response, next: () => void) {
  if (!isAssistantOriginAllowed(req.headers)) {
    res.status(403).json({ success: false, error: '跨站请求已拒绝' });
    return;
  }
  next();
}

router.get('/capabilities', (req, res) => {
  res.json({ success: true, data: assistantService.capabilities(user(req)) });
});

router.post('/turn', sameOrigin, async (req, res) => {
  const emit = startSSE(res);
  try {
    await assistantService.turn(user(req), req.body?.messages, emit);
  } catch (error: any) {
    logger.error('Assistant turn 失败', { error: error?.message || error, username: user(req).username });
    emit({ type: 'tool.failed', error: error?.message || 'AI 会话失败' });
    emit({ type: 'assistant.completed', status: 'failed' });
  } finally {
    res.end();
  }
});

router.post('/actions/:id/decision', sameOrigin, async (req, res) => {
  const emit = startSSE(res);
  try {
    const decision = req.body?.decision === 'reject' ? 'reject' : 'approve';
    const secretInputs = req.body?.secretInputs && typeof req.body.secretInputs === 'object'
      ? req.body.secretInputs
      : {};
    await assistantService.decide(user(req), req.params.id, decision, emit, secretInputs);
  } catch (error: any) {
    emit({ type: 'tool.failed', actionId: req.params.id, error: error?.message || '处理审批失败' });
    emit({ type: 'assistant.completed', status: 'failed' });
  } finally {
    res.end();
  }
});

router.post('/actions/:id/cancel', sameOrigin, (req, res) => {
  try {
    res.json({ success: true, data: assistantService.cancel(user(req), req.params.id) });
  } catch (error: any) {
    res.status(404).json({ success: false, error: error?.message || '取消失败' });
  }
});

router.get('/actions/:id/status', sameOrigin, async (req, res) => {
  try {
    const audit = assistantAuditService.get(req.params.id);
    if (!audit || audit.userId !== user(req).id) {
      res.status(404).json({ success: false, error: '操作记录不存在' });
      return;
    }
    if (!['cicd_trigger_build', 'cicd_trigger_release'].includes(audit.toolName)) {
      res.status(400).json({ success: false, error: '该操作不支持构建状态跟踪' });
      return;
    }
    const submission = audit.result && typeof audit.result === 'object' ? audit.result as Record<string, any> : {};
    const previousTracking = submission.tracking && typeof submission.tracking === 'object' ? submission.tracking : {};
    const tracking = await jenkinsAssistantService.getBuildSubmissionStatus({
      queueUrl: String(submission.queueUrl || ''),
      buildNumber: Number(previousTracking.buildNumber || submission.buildNumber || 0) || undefined,
      branch: String(submission.branch || audit.arguments?.branch || ''),
      deployTarget: String(submission.deployTarget || ''),
      submittedAt: String(submission.submittedAt || audit.completedAt || audit.createdAt || ''),
    });
    assistantAuditService.update(audit.id, {
      result: { ...submission, buildNumber: tracking.buildNumber || submission.buildNumber, tracking },
      ...(tracking.buildNumber ? { relatedEntityType: 'jenkins_build', relatedEntityId: String(tracking.buildNumber) } : {}),
    });
    res.json({ success: true, data: tracking });
  } catch (error: any) {
    res.status(502).json({ success: false, error: error?.message || '同步 Jenkins 状态失败' });
  }
});

router.post('/attachments', sameOrigin, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: '请选择附件' });
      return;
    }
    res.json({ success: true, data: assistantAttachmentService.register(req.file, user(req).id) });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || '附件上传失败' });
  }
});

router.get('/audits', requireRole('admin'), (req, res) => {
  res.json({ success: true, data: assistantAuditService.list(Number(req.query.limit) || 100) });
});

router.get('/semantic/stats', requireRole('admin'), (req, res) => {
  res.json({ success: true, data: businessSemanticService.semanticStats(Number(req.query.limit) || 50) });
});

router.get('/datasets/capabilities/status', requireRole('admin'), (_req, res) => {
  res.json({ success: true, data: assistantCapabilityDatasetService.status() });
});

router.post('/datasets/capabilities/sync', requireRole('admin'), (req, res) => {
  try {
    const result = assistantCapabilityDatasetService.syncCapabilities(req.body);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || '同步能力数据集失败' });
  }
});

router.post('/datasets/capabilities/sync-from-entrances', requireRole('admin'), async (req, res) => {
  try {
    const result = await assistantCapabilityDatasetService.syncFromEntrances({
      routesUrl: typeof req.body?.routesUrl === 'string' ? req.body.routesUrl : undefined,
      crossPlatformUrl: typeof req.body?.crossPlatformUrl === 'string' ? req.body.crossPlatformUrl : undefined,
    });
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(502).json({ success: false, error: error?.message || '从能力入口同步数据集失败' });
  }
});

export default router;
