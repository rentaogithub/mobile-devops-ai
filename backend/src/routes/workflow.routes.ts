import { Router, Request, Response } from 'express';
import { workflowService } from '../services/WorkflowService';
import { changeImpactService } from '../services/ChangeImpactService';
import { qualityGateService } from '../services/QualityGateService';
import { workflowAIService } from '../services/WorkflowAIService';
import { xcuiTestWorkflowService } from '../services/XCUITestWorkflowService';
import { platformOperationsService } from '../services/PlatformOperationsService';
import { adminMiddleware } from '../middleware/auth';
import logger from '../utils/logger';
import { currentProjectId } from '../services/ProductLineContext';

const router = Router();

router.use((req, _res, next) => {
  const projectId = currentProjectId();
  req.query.projectId = projectId;
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    req.body.projectId = projectId;
  }
  next();
});

function belongsToCurrentProduct(entity: any): boolean {
  return !entity || !entity.projectId || entity.projectId === currentProjectId();
}

function ok(res: Response, data: unknown) {
  res.json({ success: true, data });
}

function fail(res: Response, error: any, fallback: string, status = 500) {
  logger.error(`${fallback}: ${error?.message || error}`);
  res.status(status).json({ success: false, error: error?.message || fallback });
}

router.get('/overview', (req, res) => {
  try {
    ok(res, workflowService.overview(String(req.query.projectId || 'nn-ios')));
  } catch (error) {
    fail(res, error, '加载 Workflow 概览失败');
  }
});

router.get('/operations/sync', (_req, res) => {
  ok(res, platformOperationsService.getSyncStatus());
});

router.post('/operations/sync/:source', adminMiddleware, async (req, res) => {
  try {
    const source = String(req.params.source || '');
    ok(res, source === 'all'
      ? await platformOperationsService.runAllSyncs()
      : await platformOperationsService.runSync(source as any));
  } catch (error) {
    fail(res, error, '执行 Workflow 同步失败', 400);
  }
});

router.get('/operations/storage', (_req, res) => {
  try {
    ok(res, platformOperationsService.storageReport());
  } catch (error) {
    fail(res, error, '读取平台存储状态失败');
  }
});

router.post('/operations/backup', adminMiddleware, async (_req, res) => {
  try {
    ok(res, await platformOperationsService.backupDatabase());
  } catch (error) {
    fail(res, error, '数据库备份失败');
  }
});

router.post('/operations/retention', adminMiddleware, async (req, res) => {
  try {
    if (req.body?.execute === true) {
      ok(res, await platformOperationsService.applyRetention(String(req.body?.confirm || '')));
      return;
    }
    ok(res, platformOperationsService.retentionCandidates());
  } catch (error) {
    fail(res, error, '执行保留策略失败', 400);
  }
});

router.post('/operations/compact', adminMiddleware, (_req, res) => {
  try {
    ok(res, platformOperationsService.compactWorkflowPayloads());
  } catch (error) {
    fail(res, error, 'Workflow Payload 瘦身失败');
  }
});

router.get('/artifacts', (req, res) => {
  try {
    ok(res, workflowService.listArtifacts(req.query));
  } catch (error) {
    fail(res, error, '加载 Artifact 失败');
  }
});

router.post('/artifacts', (req, res) => {
  try {
    ok(res, workflowService.createArtifact(req.body || {}));
  } catch (error) {
    fail(res, error, '保存 Artifact 失败', 400);
  }
});

router.get('/tasks', (req, res) => {
  try {
    ok(res, workflowService.listTasks(req.query));
  } catch (error) {
    fail(res, error, '加载 Workflow 任务失败');
  }
});

router.post('/tasks', (req, res) => {
  try {
    ok(res, workflowService.upsertTask(req.body || {}));
  } catch (error) {
    fail(res, error, '保存 Workflow 任务失败', 400);
  }
});

router.get('/tasks/:taskId', (req, res) => {
  try {
    const task = workflowService.getTask(req.params.taskId);
    if (!task || !belongsToCurrentProduct(task)) return res.status(404).json({ success: false, error: '任务不存在' });
    ok(res, { task, relations: workflowService.listRelations('task', task.id), events: workflowService.listEvents({ entityType: 'task', entityId: task.id }) });
  } catch (error) {
    fail(res, error, '加载任务详情失败');
  }
});

router.get('/issues', (req, res) => {
  try {
    ok(res, workflowService.listIssues(req.query));
  } catch (error) {
    fail(res, error, '加载 Issue 中心失败');
  }
});

router.post('/issues', (req, res) => {
  try {
    ok(res, workflowService.upsertIssue(req.body || {}));
  } catch (error) {
    fail(res, error, '保存 Issue 失败', 400);
  }
});

router.patch('/issues/:issueId', (req, res) => {
  try {
    const existing = workflowService.getIssue(req.params.issueId);
    if (!existing || !belongsToCurrentProduct(existing)) return res.status(404).json({ success: false, error: 'Issue 不存在' });
    const issue = workflowService.updateIssue(req.params.issueId, req.body || {});
    if (!issue) return res.status(404).json({ success: false, error: 'Issue 不存在' });
    ok(res, issue);
  } catch (error) {
    fail(res, error, '更新 Issue 失败', 400);
  }
});

router.get('/issues/:issueId', (req, res) => {
  try {
    const issue = workflowService.getIssue(req.params.issueId);
    if (!issue || !belongsToCurrentProduct(issue)) return res.status(404).json({ success: false, error: 'Issue 不存在' });
    ok(res, {
      issue,
      relations: workflowService.listRelations('issue', issue.id),
      events: workflowService.listEvents({ entityType: 'issue', entityId: issue.id }),
    });
  } catch (error) {
    fail(res, error, '加载 Issue 详情失败');
  }
});

router.post('/relations', (req, res) => {
  try {
    const required = ['fromType', 'fromId', 'relation', 'toType', 'toId'];
    if (required.some((key) => !String(req.body?.[key] || '').trim())) {
      return res.status(400).json({ success: false, error: '关系字段不完整' });
    }
    ok(res, workflowService.addRelation(req.body));
  } catch (error) {
    fail(res, error, '保存实体关系失败', 400);
  }
});

router.post('/events', (req, res) => {
  try {
    ok(res, workflowService.recordEvent(req.body || {}));
  } catch (error) {
    fail(res, error, '记录 Workflow 事件失败', 400);
  }
});

router.get('/events', (req, res) => {
  try {
    ok(res, workflowService.listEvents(req.query));
  } catch (error) {
    fail(res, error, '加载 Workflow 事件失败');
  }
});

router.post('/impact/analyze', (req, res) => {
  try {
    const result = changeImpactService.analyze(req.body || {});
    workflowService.recordEvent({
      eventType: 'change_impact.analyzed',
      entityType: 'commit',
      entityId: String(req.body?.headRef || 'working-tree'),
      payload: result,
    });
    ok(res, result);
  } catch (error) {
    fail(res, error, '变更影响分析失败', 400);
  }
});

router.get('/baselines', (req, res) => {
  try {
    ok(res, workflowService.listBaselines(String(req.query.projectId || 'nn-ios')));
  } catch (error) {
    fail(res, error, '加载质量基线失败');
  }
});

router.post('/baselines', (req, res) => {
  try {
    ok(res, workflowService.upsertBaseline(req.body || {}));
  } catch (error) {
    fail(res, error, '保存质量基线失败', 400);
  }
});

router.post('/release-gates/evaluate', (req, res) => {
  try {
    ok(res, qualityGateService.evaluate(req.body || {}));
  } catch (error) {
    fail(res, error, '发布质量门禁评估失败', 400);
  }
});

router.post('/release-gates/preview', (req, res) => {
  try {
    ok(res, qualityGateService.preview(req.body || {}));
  } catch (error) {
    fail(res, error, '发布质量门禁预检失败', 400);
  }
});

router.get('/release-gates', (req, res) => {
  try {
    ok(res, workflowService.listReleaseGates(String(req.query.projectId || 'nn-ios'), Number(req.query.limit) || 50));
  } catch (error) {
    fail(res, error, '加载发布门禁记录失败');
  }
});

router.post('/issues/:issueId/regression-candidates', (req, res) => {
  try {
    ok(res, workflowAIService.proposeRegressionCandidate(req.params.issueId));
  } catch (error) {
    fail(res, error, '生成回归候选失败', 400);
  }
});

router.get('/regression-candidates', (req, res) => {
  try {
    ok(res, workflowService.listRegressionCandidates(String(req.query.projectId || 'nn-ios')));
  } catch (error) {
    fail(res, error, '加载回归候选失败');
  }
});

router.post('/regression-candidates/:candidateId/generate-xcuitest', async (req: Request, res: Response) => {
  try {
    ok(res, await workflowAIService.generateXCUITest(req.params.candidateId, req.body?.apiKey));
  } catch (error) {
    fail(res, error, '生成 XCUITest 失败', 400);
  }
});

router.post('/regression-candidates/:candidateId/export-xcuitest', async (req: Request, res: Response) => {
  try {
    ok(res, await xcuiTestWorkflowService.exportCandidate(req.params.candidateId, req.body || {}));
  } catch (error) {
    fail(res, error, '导出 XCUITest 失败', 400);
  }
});

router.post('/regression-candidates/:candidateId/verify-xcuitest', async (req: Request, res: Response) => {
  try {
    const result = await xcuiTestWorkflowService.verifyCandidate(req.params.candidateId, req.body || {});
    ok(res, result);
  } catch (error) {
    fail(res, error, '编译 XCUITest 失败', 400);
  }
});

router.post('/regression-candidates/:candidateId/run-xcuitest', async (req: Request, res: Response) => {
  try {
    const result = await xcuiTestWorkflowService.runCandidate(req.params.candidateId, req.body || {});
    ok(res, result);
  } catch (error) {
    fail(res, error, '执行 XCUITest 失败', 409);
  }
});

router.post('/issues/:issueId/fix-suggestion', async (req: Request, res: Response) => {
  try {
    ok(res, await workflowAIService.suggestFix(req.params.issueId, req.body?.context || {}, req.body?.apiKey));
  } catch (error) {
    fail(res, error, '生成候选修复建议失败', 400);
  }
});

router.get('/knowledge', (req, res) => {
  try {
    ok(res, workflowService.listKnowledge(req.query));
  } catch (error) {
    fail(res, error, '加载移动研发知识库失败');
  }
});

router.post('/knowledge/synthesize', async (req: Request, res: Response) => {
  try {
    ok(res, await workflowAIService.synthesizeKnowledge(req.body || {}, req.body?.apiKey));
  } catch (error) {
    fail(res, error, '知识提炼失败', 400);
  }
});

router.get('/ai-evaluations', (req, res) => {
  try {
    ok(res, workflowService.listAIEvaluations(String(req.query.projectId || 'nn-ios')));
  } catch (error) {
    fail(res, error, '加载 AI 评测记录失败');
  }
});

router.post('/ai-evaluations', (req, res) => {
  try {
    ok(res, workflowService.recordAIEvaluation(req.body || {}));
  } catch (error) {
    fail(res, error, '记录 AI 评测失败', 400);
  }
});

router.patch('/ai-evaluations/:evaluationId', (req, res) => {
  try {
    const evaluation = workflowService.updateAIEvaluation(req.params.evaluationId, req.body || {});
    if (!evaluation) return res.status(404).json({ success: false, error: 'AI 评测记录不存在' });
    ok(res, evaluation);
  } catch (error) {
    fail(res, error, '更新 AI 评测失败', 400);
  }
});

router.post('/release-observations', (req, res) => {
  try {
    ok(res, workflowService.addReleaseObservation(req.body || {}));
  } catch (error) {
    fail(res, error, '记录发布观察指标失败', 400);
  }
});

router.get('/release-observations', (req, res) => {
  try {
    ok(res, workflowService.listReleaseObservations(String(req.query.projectId || 'nn-ios'), req.query.releaseVersion ? String(req.query.releaseVersion) : undefined));
  } catch (error) {
    fail(res, error, '加载发布观察指标失败');
  }
});

router.get('/release-health/:releaseVersion', (req, res) => {
  try {
    ok(res, qualityGateService.evaluateReleaseHealth(String(req.query.projectId || 'nn-ios'), req.params.releaseVersion));
  } catch (error) {
    fail(res, error, '评估发布健康度失败');
  }
});

export default router;
