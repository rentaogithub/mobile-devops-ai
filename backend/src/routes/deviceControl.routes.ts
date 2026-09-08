import { Router } from 'express';
import http from 'http';
import https from 'https';
import { authMiddleware, requireAnyRole } from '../middleware/auth';
import { DeviceControlError, deviceControlService } from '../services/DeviceControlService';
import { deviceRecordingService } from '../services/DeviceRecordingService';
import {
  compileDeviceReplayFlow,
  DEVICE_REPLAY_FLOW_JSON_SCHEMA,
  DeviceReplayFlowDsl,
  replayFlowTemplateFromRecording,
  validateDeviceReplayFlow,
} from '../services/DeviceReplayFlow';
import { deviceReplayFlowExecutionService } from '../services/DeviceReplayFlowExecutionService';
import { replayFlowAssetService, ReplayFlowAssetError } from '../services/ReplayFlowAssetService';
import { replayFlowChainExecutionService } from '../services/ReplayFlowChainExecutionService';
import logger from '../utils/logger';

const router = Router();

router.use(authMiddleware, requireAnyRole(['tester', 'developer', 'admin']));
const requireFlowPublisher = requireAnyRole(['developer', 'admin']);

function actorOf(req: any) {
  return String(req.authUser?.username || 'local');
}

function isAdmin(req: any) {
  return Boolean(req.isAdmin || req.authUser?.role === 'admin');
}

function notePlatformAction(req: any, action: { type: string; params: Record<string, unknown> }, summary: string) {
  try {
    deviceRecordingService.notePlatformAction(actorOf(req), isAdmin(req), action, summary);
  } catch (error: any) {
    logger.warn('记录平台真机指令失败', { error: error?.message, action: action.type });
  }
}

function route(handler: (req: any, res: any) => Promise<void>) {
  return async (req: any, res: any) => {
    try {
      await handler(req, res);
    } catch (error: any) {
      const statusCode = error instanceof DeviceControlError || error instanceof ReplayFlowAssetError
        ? error.statusCode
        : (Number(error?.statusCode) || 500);
      logger.error('真机操作台请求失败', { path: req.path, error: error?.message });
      res.status(statusCode).json({
        success: false,
        error: error?.message || '真机操作失败',
        ...(error?.code ? { code: error.code } : {}),
      });
    }
  };
}

router.get('/devices', route(async (_req, res) => {
  const devices = await deviceControlService.listDevices();
  res.json({ success: true, data: { devices } });
}));

router.get('/status', route(async (_req, res) => {
  res.json({ success: true, data: deviceControlService.getStatus() });
}));

router.post('/connect', route(async (req, res) => {
  const status = await deviceControlService.connect(String(req.body?.udid || ''), actorOf(req));
  res.json({ success: true, data: status });
}));

router.post('/disconnect', route(async (req, res) => {
  const status = await deviceControlService.disconnect(actorOf(req), isAdmin(req));
  res.json({ success: true, data: status });
}));

router.get('/screenshot', route(async (req, res) => {
  const screenshot = await deviceControlService.screenshot(actorOf(req), isAdmin(req));
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(screenshot);
}));

router.get('/stream', (req, res) => {
  try {
    const streamUrl = deviceControlService.getMjpegUrl(actorOf(req), isAdmin(req));
    const parsed = new URL(streamUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    const upstream = transport.get(parsed, (upstreamResponse) => {
      if ((upstreamResponse.statusCode || 500) >= 400) {
        res.status(502).json({ success: false, error: 'WDA 实时视频流响应异常' });
        upstreamResponse.resume();
        return;
      }
      res.status(upstreamResponse.statusCode || 200);
      res.setHeader('Content-Type', String(upstreamResponse.headers['content-type'] || 'multipart/x-mixed-replace'));
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      upstreamResponse.pipe(res);
    });
    upstream.setTimeout(15000, () => upstream.destroy(new Error('WDA 实时视频流超时')));
    upstream.on('error', (error) => {
      logger.warn('WDA 实时视频流中断', { error: error.message });
      if (!res.headersSent) {
        res.status(502).json({ success: false, error: 'WDA 实时视频流连接失败' });
      } else {
        res.end();
      }
    });
    res.on('close', () => upstream.destroy());
  } catch (error: any) {
    const statusCode = error instanceof DeviceControlError ? error.statusCode : 500;
    res.status(statusCode).json({ success: false, error: error?.message || 'WDA 实时视频流连接失败' });
  }
});

router.get('/source', route(async (req, res) => {
  const source = await deviceControlService.source(actorOf(req), isAdmin(req));
  res.json({ success: true, data: { source } });
}));

router.get('/replay-flows/schema', route(async (_req, res) => {
  res.json({ success: true, data: { schema: DEVICE_REPLAY_FLOW_JSON_SCHEMA } });
}));

router.get('/replay-flow-assets', route(async (req, res) => {
  const assets = replayFlowAssetService.list({
    search: String(req.query.search || ''),
    status: String(req.query.status || ''),
    limit: Number(req.query.limit),
  });
  res.json({ success: true, data: { assets } });
}));

router.get('/replay-flow-assets/:assetId', route(async (req, res) => {
  const asset = replayFlowAssetService.get(String(req.params.assetId));
  res.json({ success: true, data: { asset } });
}));

router.get('/replay-flow-versions/:versionId', route(async (req, res) => {
  const version = replayFlowAssetService.getVersion(String(req.params.versionId));
  res.json({ success: true, data: { version } });
}));

router.get('/replay-flow-versions', route(async (_req, res) => {
  const versions = replayFlowAssetService.listPublishedVersions();
  res.json({ success: true, data: { versions } });
}));

router.get('/replay-flow-assets/:assetId/source-preview', route(async (req, res) => {
  const asset = replayFlowAssetService.get(String(req.params.assetId));
  if (!asset.sourceRecordingId) throw new ReplayFlowAssetError('当前流程没有可读取的录制来源', 404, 'FLOW_SOURCE_RECORDING_NOT_FOUND');
  const recording = deviceRecordingService.getRecording(asset.sourceRecordingId, actorOf(req), isAdmin(req));
  const preview = replayFlowAssetService.sourcePreview(recording, asset.id);
  res.json({ success: true, data: { preview } });
}));

router.put('/replay-flow-assets/:assetId/draft', route(async (req, res) => {
  const asset = replayFlowAssetService.saveDraft(String(req.params.assetId), actorOf(req), {
    expectedRevision: Number(req.body?.expectedRevision),
    flow: req.body?.flow,
    name: req.body?.name,
    description: req.body?.description,
  });
  res.json({ success: true, data: { asset } });
}));

router.post('/replay-flow-assets/:assetId/reset-from-recording', route(async (req, res) => {
  const current = replayFlowAssetService.get(String(req.params.assetId));
  if (!current.sourceRecordingId) throw new ReplayFlowAssetError('当前流程没有可重置的录制来源', 404, 'FLOW_SOURCE_RECORDING_NOT_FOUND');
  const recording = deviceRecordingService.getRecording(current.sourceRecordingId, actorOf(req), isAdmin(req));
  const asset = replayFlowAssetService.resetFromRecording(
    current.id,
    recording,
    actorOf(req),
    Number(req.body?.expectedRevision),
  );
  const preview = replayFlowAssetService.sourcePreview(recording, asset.id);
  res.json({ success: true, data: { asset, preview } });
}));

router.put('/replay-flow-assets/:assetId/execution-chain', route(async (req, res) => {
  const asset = replayFlowAssetService.updateExecutionChain(String(req.params.assetId), actorOf(req), {
    preFlowVersionId: req.body?.preFlowVersionId,
    postFlowVersionId: req.body?.postFlowVersionId,
  });
  res.json({ success: true, data: { asset } });
}));

router.post('/replay-flow-assets/:assetId/publish', requireFlowPublisher, route(async (req, res) => {
  const result = replayFlowAssetService.publish(String(req.params.assetId), actorOf(req), {
    expectedRevision: Number(req.body?.expectedRevision),
    releaseNotes: req.body?.releaseNotes,
  });
  res.status(201).json({ success: true, data: result });
}));

router.post('/replay-flow-versions/:versionId/copy', route(async (req, res) => {
  const asset = replayFlowAssetService.copyVersion(String(req.params.versionId), actorOf(req), req.body?.name);
  res.status(201).json({ success: true, data: { asset } });
}));

router.post('/replay-flow-versions/:versionId/rollback', requireFlowPublisher, route(async (req, res) => {
  const asset = replayFlowAssetService.rollbackToVersion(
    String(req.params.versionId),
    actorOf(req),
    Number(req.body?.expectedRevision),
  );
  res.json({ success: true, data: { asset } });
}));

router.post('/replay-flow-assets/:assetId/runs', route(async (req, res) => {
  const run = replayFlowChainExecutionService.start(
    String(req.params.assetId),
    req.body?.inputs || {},
    actorOf(req),
    isAdmin(req),
  );
  res.status(202).json({ success: true, data: { run } });
}));

router.post('/replay-flow-assets/:assetId/copy', route(async (req, res) => {
  const asset = replayFlowAssetService.copy(String(req.params.assetId), actorOf(req), req.body?.name);
  res.status(201).json({ success: true, data: { asset } });
}));

router.post('/replay-flow-assets/:assetId/archive', route(async (req, res) => {
  const asset = replayFlowAssetService.setArchived(String(req.params.assetId), actorOf(req), true);
  res.json({ success: true, data: { asset } });
}));

router.post('/replay-flow-assets/:assetId/restore', route(async (req, res) => {
  const asset = replayFlowAssetService.setArchived(String(req.params.assetId), actorOf(req), false);
  res.json({ success: true, data: { asset } });
}));

router.post('/replay-flow-assets/:assetId/complete-creation', route(async (req, res) => {
  const asset = replayFlowAssetService.completeCreation(String(req.params.assetId), actorOf(req));
  res.json({ success: true, data: { asset } });
}));

router.post('/replay-flows/validate', route(async (req, res) => {
  const flow = req.body?.flow ?? req.body;
  const validation = validateDeviceReplayFlow(flow);
  res.json({
    success: true,
    data: {
      validation,
      compiled: validation.valid ? compileDeviceReplayFlow(flow as DeviceReplayFlowDsl) : null,
    },
  });
}));

router.post('/replay-flows/runs', route(async (req, res) => {
  const run = deviceReplayFlowExecutionService.start(
    req.body?.flow,
    req.body?.inputs || {},
    actorOf(req),
    isAdmin(req),
  );
  res.status(202).json({ success: true, data: { run } });
}));

router.get('/replay-flows/runs/:runId/evidence/:evidenceId/:kind', route(async (req, res) => {
  const kind = String(req.params.kind) === 'source' ? 'source' : 'screenshot';
  const file = deviceReplayFlowExecutionService.evidenceFile(
    String(req.params.runId),
    String(req.params.evidenceId),
    kind,
    actorOf(req),
    isAdmin(req),
  );
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type(kind === 'source' ? 'application/xml' : 'image/png');
  res.sendFile(file);
}));

router.get('/replay-flows/runs/:runId', route(async (req, res) => {
  const run = deviceReplayFlowExecutionService.getRun(String(req.params.runId), actorOf(req), isAdmin(req));
  res.json({ success: true, data: { run } });
}));

router.post('/replay-flows/runs/:runId/stop', route(async (req, res) => {
  const run = deviceReplayFlowExecutionService.stop(String(req.params.runId), actorOf(req), isAdmin(req));
  res.json({ success: true, data: { run } });
}));

router.get('/replay-flow-chain-runs', route(async (req, res) => {
  const runs = replayFlowChainExecutionService.list(actorOf(req), isAdmin(req), {
    status: String(req.query.status || ''),
    limit: Number(req.query.limit),
  });
  res.json({ success: true, data: { runs } });
}));

router.get('/replay-flow-chain-runs/:runId', route(async (req, res) => {
  const run = replayFlowChainExecutionService.get(String(req.params.runId), actorOf(req), isAdmin(req));
  res.json({ success: true, data: { run } });
}));

router.post('/replay-flow-chain-runs/:runId/stop', route(async (req, res) => {
  const run = replayFlowChainExecutionService.stop(String(req.params.runId), actorOf(req), isAdmin(req));
  res.json({ success: true, data: { run } });
}));

router.post('/recordings', route(async (req, res) => {
  const recording = await deviceRecordingService.start(String(req.body?.title || ''), actorOf(req), isAdmin(req));
  res.json({ success: true, data: recording });
}));

router.get('/recordings/current', route(async (req, res) => {
  const recording = deviceRecordingService.getCurrent(actorOf(req), isAdmin(req));
  res.json({ success: true, data: { recording } });
}));

router.get('/recordings/latest', route(async (req, res) => {
  const recording = deviceRecordingService.getLatest(actorOf(req), isAdmin(req));
  res.json({ success: true, data: { recording } });
}));

router.post('/recordings/current/observe', route(async (req, res) => {
  const recording = deviceRecordingService.observeDeviceChange(actorOf(req), isAdmin(req));
  res.json({ success: true, data: recording });
}));

router.post('/recordings/current/stop', route(async (req, res) => {
  const recording = await deviceRecordingService.stop(actorOf(req), isAdmin(req));
  res.json({ success: true, data: recording });
}));

router.get('/recordings/:recordingId/replay-flow-template', route(async (req, res) => {
  const recording = deviceRecordingService.getRecording(String(req.params.recordingId), actorOf(req), isAdmin(req));
  const flow = replayFlowTemplateFromRecording(recording, String(req.query.includeUnselected || '') === 'true');
  const validation = validateDeviceReplayFlow(flow);
  res.json({
    success: true,
    data: {
      flow,
      validation,
      compiled: validation.valid ? compileDeviceReplayFlow(flow) : null,
    },
  });
}));

router.get('/recordings/:recordingId/orchestration-preview', route(async (req, res) => {
  const recording = deviceRecordingService.getRecording(String(req.params.recordingId), actorOf(req), isAdmin(req));
  const preview = replayFlowAssetService.sourcePreview(recording);
  res.json({ success: true, data: { preview } });
}));

router.post('/recordings/:recordingId/replay-flow-assets', route(async (req, res) => {
  const recording = deviceRecordingService.getRecording(String(req.params.recordingId), actorOf(req), isAdmin(req));
  const asset = replayFlowAssetService.createFromRecording(recording, actorOf(req), {
    name: req.body?.name,
    description: req.body?.description,
    creationMode: Boolean(req.body?.creationMode),
  });
  res.status(201).json({ success: true, data: { asset } });
}));

router.post('/recordings/:recordingId/replay-flow-runs', route(async (req, res) => {
  const recording = deviceRecordingService.getRecording(String(req.params.recordingId), actorOf(req), isAdmin(req));
  const flow = replayFlowTemplateFromRecording(recording, Boolean(req.body?.includeUnselected));
  const inputs = { ...(req.body?.inputs || {}) };
  if (req.body?.inputValue !== undefined && inputs.INPUT === undefined) inputs.INPUT = String(req.body.inputValue);
  const run = deviceReplayFlowExecutionService.start(flow, inputs, actorOf(req), isAdmin(req));
  res.status(202).json({ success: true, data: { run, flow } });
}));

router.get('/recordings/:recordingId', route(async (req, res) => {
  const recording = deviceRecordingService.getRecording(String(req.params.recordingId), actorOf(req), isAdmin(req));
  res.json({ success: true, data: recording });
}));

router.patch('/recordings/:recordingId/steps/:stepId', route(async (req, res) => {
  const recording = deviceRecordingService.updateStep(
    String(req.params.recordingId),
    String(req.params.stepId),
    Boolean(req.body?.included),
    actorOf(req),
    isAdmin(req),
  );
  res.json({ success: true, data: recording });
}));

router.patch('/recordings/:recordingId/observations/:observationId', route(async (req, res) => {
  const recording = deviceRecordingService.updateObservation(
    String(req.params.recordingId),
    String(req.params.observationId),
    Boolean(req.body?.included),
    actorOf(req),
    isAdmin(req),
  );
  res.json({ success: true, data: recording });
}));

router.post('/recordings/:recordingId/observations/:observationId/promote', route(async (req, res) => {
  const recording = deviceRecordingService.promoteObservation(
    String(req.params.recordingId),
    String(req.params.observationId),
    req.body || {},
    actorOf(req),
    isAdmin(req),
  );
  res.json({ success: true, data: recording });
}));

router.post('/recordings/:recordingId/replay', route(async (req, res) => {
  const result = await deviceRecordingService.replay(
    String(req.params.recordingId),
    String(req.body?.inputValue || ''),
    actorOf(req),
    isAdmin(req),
  );
  res.json({ success: true, data: result });
}));

router.get('/recordings/:recordingId/evidence/:snapshotId/:kind', route(async (req, res) => {
  const kind = String(req.params.kind) === 'source' ? 'source' : 'screenshot';
  const file = deviceRecordingService.evidenceFile(
    String(req.params.recordingId),
    String(req.params.snapshotId),
    kind,
    actorOf(req),
    isAdmin(req),
  );
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type(kind === 'source' ? 'application/xml' : 'image/png');
  res.sendFile(file);
}));

router.post('/tap', route(async (req, res) => {
  const result = await deviceControlService.tap(Number(req.body?.x), Number(req.body?.y), actorOf(req), isAdmin(req));
  res.json({ success: true, data: result });
  notePlatformAction(
    req,
    { type: 'tap', params: result.point },
    `点击 (${result.point.x}, ${result.point.y})`,
  );
}));

router.post('/swipe', route(async (req, res) => {
  const result = await deviceControlService.swipe(
    Number(req.body?.startX),
    Number(req.body?.startY),
    Number(req.body?.endX),
    Number(req.body?.endY),
    Number(req.body?.durationMs),
    actorOf(req),
    isAdmin(req),
  );
  res.json({ success: true, data: result });
  notePlatformAction(
    req,
    { type: 'swipe', params: result },
    `滑动 (${result.start.x}, ${result.start.y}) → (${result.end.x}, ${result.end.y})`,
  );
}));

router.post('/input', route(async (req, res) => {
  const result = await deviceControlService.input(String(req.body?.text || ''), actorOf(req), isAdmin(req));
  res.json({ success: true, data: result });
  notePlatformAction(
    req,
    { type: 'input', params: { value: '${INPUT}', length: result.length } },
    `输入参数化文本（${result.length} 字符）`,
  );
}));

export default router;
