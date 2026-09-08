import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, initializeDatabase } from '../database';
import { DeviceRecording } from './DeviceRecordingService';
import { ReplayFlowAssetError, ReplayFlowAssetService, recordingSourceFingerprint } from './ReplayFlowAssetService';

function recording(): DeviceRecording {
  return {
    id: 'recording-1',
    projectId: 'nn-ios',
    title: '社区搜索',
    owner: 'admin',
    status: 'stopped',
    createdAt: '2026-09-03T00:00:00.000Z',
    stoppedAt: '2026-09-03T00:01:00.000Z',
    device: { udid: 'device-1', name: 'iPhone', osVersion: '18.0', connected: true },
    selectedCount: 1,
    candidateSelectedCount: 0,
    observations: [],
    steps: [{
      id: 'step-1',
      index: 1,
      origin: 'platform',
      status: 'ready',
      included: true,
      noiseLikely: false,
      summary: '点击搜索',
      createdAt: '2026-09-03T00:00:01.000Z',
      action: {
        type: 'tap',
        params: { x: 100, y: 200 },
        normalizedPoint: { x: 0.5, y: 0.25 },
        target: {
          type: 'XCUIElementTypeButton',
          name: '搜索',
          rect: { x: 80, y: 180, width: 40, height: 40 },
          relativePoint: { x: 0.5, y: 0.5 },
          depth: 4,
          locators: [],
        },
      },
    }],
  };
}

function namedRecording(id: string, title: string): DeviceRecording {
  const value = recording();
  value.id = id;
  value.title = title;
  value.steps[0].id = `${id}-step`;
  return value;
}

describe('ReplayFlowAssetService', () => {
  let directory = '';
  let service: ReplayFlowAssetService;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-flow-assets-'));
    closeDatabase();
    process.env.DB_PATH = path.join(directory, 'database.sqlite');
    initializeDatabase();
    service = new ReplayFlowAssetService();
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('creates a persistent draft from a stopped recording', () => {
    const created = service.createFromRecording(recording(), 'admin', { name: '社区搜索回放' });
    expect(created.name).toBe('社区搜索回放');
    expect(created.status).toBe('draft');
    expect(created.sourceRecordingId).toBe('recording-1');
    expect(created.draft.revision).toBe(1);
    expect(created.draft.flow.nodes.length).toBeGreaterThan(2);
    expect(service.list()).toHaveLength(1);

    closeDatabase();
    initializeDatabase();
    expect(new ReplayFlowAssetService().get(created.id).name).toBe('社区搜索回放');
  });

  test('fingerprint changes when the selected action changes', () => {
    const first = recording();
    const second = recording();
    second.steps[0].action.params = { x: 101, y: 200 };
    expect(recordingSourceFingerprint(first)).not.toBe(recordingSourceFingerprint(second));
  });

  test('返回确认来源预览和已选步骤', () => {
    const source = recording();
    const created = service.createFromRecording(source, 'admin');
    const preview = service.sourcePreview(source, created.id);

    expect(preview.sourceChanged).toBe(false);
    expect(preview.recording).toMatchObject({ id: source.id, selectedCount: 1 });
    expect(preview.selectedSteps).toEqual([expect.objectContaining({
      id: 'step-1', actionType: 'tap', summary: '点击搜索', targetSummary: '搜索',
    })]);
    expect(preview.validation.valid).toBe(true);
  });

  test('录制没有已选步骤时拒绝生成来源预览', () => {
    const source = recording();
    source.selectedCount = 0;
    source.steps[0].included = false;

    expect(() => service.sourcePreview(source))
      .toThrow(expect.objectContaining({ code: 'RECORDING_HAS_NO_SELECTED_STEPS' }));
  });

  test('uses revision locking when saving a draft', () => {
    const created = service.createFromRecording(recording(), 'admin');
    const saved = service.saveDraft(created.id, 'developer', {
      expectedRevision: 1,
      name: '新名称',
    });
    expect(saved.draft.revision).toBe(2);
    expect(saved.name).toBe('新名称');
    expect(() => service.saveDraft(created.id, 'developer', { expectedRevision: 1 }))
      .toThrow(ReplayFlowAssetError);
  });

  test('从原录制重置为新 revision，并更新来源指纹', () => {
    const source = recording();
    const created = service.createFromRecording(source, 'admin');
    const edited = service.saveDraft(created.id, 'admin', {
      expectedRevision: 1,
      name: '保留的流程名称',
      flow: { ...created.draft.flow, nodes: created.draft.flow.nodes.slice(0, -1) },
    });
    source.steps[0].action.params = { x: 110, y: 205 };
    source.steps[0].summary = '重新标注点击';
    expect(service.sourcePreview(source, created.id).sourceChanged).toBe(true);

    const reset = service.resetFromRecording(created.id, source, 'admin', edited.draft.revision);

    expect(reset.draft.revision).toBe(3);
    expect(reset.name).toBe('保留的流程名称');
    expect(reset.sourceFingerprint).toBe(recordingSourceFingerprint(source));
    expect(reset.draft.validation.valid).toBe(true);
    expect(service.sourcePreview(source, created.id).sourceChanged).toBe(false);
  });

  test('从原录制重置时拒绝过期 revision', () => {
    const source = recording();
    const created = service.createFromRecording(source, 'admin');
    const edited = service.saveDraft(created.id, 'admin', {
      expectedRevision: created.draft.revision,
      name: '已经更新的草稿',
    });

    expect(edited.draft.revision).toBe(2);
    expect(() => service.resetFromRecording(created.id, source, 'admin', created.draft.revision))
      .toThrow(expect.objectContaining({ code: 'FLOW_DRAFT_CONFLICT' }));
  });

  test('keeps a new-flow session incomplete until the user finishes creation', () => {
    const created = service.createFromRecording(recording(), 'admin', { creationMode: true });
    expect(created.creationCompleted).toBe(false);
    expect(created.completedAt).toBeUndefined();

    const completed = service.completeCreation(created.id, 'admin');
    expect(completed.creationCompleted).toBe(true);
    expect(completed.completedAt).toBeTruthy();
    expect(service.completeCreation(created.id, 'admin').completedAt).toBe(completed.completedAt);
  });

  test('copies and archives a flow without deleting it', () => {
    const created = service.createFromRecording(recording(), 'admin');
    const copied = service.copy(created.id, 'developer');
    expect(copied.id).not.toBe(created.id);
    expect(copied.name).toContain('副本');
    service.setArchived(created.id, 'admin', true);
    expect(service.list()).toHaveLength(1);
    expect(service.list({ status: 'archived' })[0].id).toBe(created.id);
  });

  test('发布不可变版本并配置前置和后置版本引用', () => {
    const pre = service.createFromRecording(namedRecording('recording-pre', '登录准备'), 'admin');
    const main = service.createFromRecording(namedRecording('recording-main', '搜索社区'), 'admin');
    const post = service.createFromRecording(namedRecording('recording-post', '退出清理'), 'admin');
    const preVersion = service.publish(pre.id, 'admin', { expectedRevision: pre.draft.revision, releaseNotes: '登录基线' }).version;
    const postVersion = service.publish(post.id, 'admin', { expectedRevision: post.draft.revision }).version;

    const updated = service.updateExecutionChain(main.id, 'admin', {
      preFlowVersionId: preVersion.id,
      postFlowVersionId: postVersion.id,
    });

    expect(updated).toMatchObject({
      preFlowVersionId: preVersion.id,
      preFlowAssetId: pre.id,
      preFlowAssetName: pre.name,
      preFlowVersionNumber: 1,
      postFlowVersionId: postVersion.id,
      postFlowAssetId: post.id,
      postFlowAssetName: post.name,
      postFlowVersionNumber: 1,
    });
    expect(service.list().find((asset) => asset.id === main.id)).toMatchObject({
      preFlowVersionId: preVersion.id,
      postFlowVersionId: postVersion.id,
    });
    expect(service.getVersion(preVersion.id)).toMatchObject({ assetId: pre.id, versionNumber: 1, releaseNotes: '登录基线' });
  });

  test('拒绝草稿、自引用、循环引用和不可用流程', () => {
    const first = service.createFromRecording(namedRecording('recording-first', '流程 A'), 'admin');
    const second = service.createFromRecording(namedRecording('recording-second', '流程 B'), 'admin');
    const creating = service.createFromRecording(namedRecording('recording-creating', '创建中'), 'admin', { creationMode: true });
    const firstVersion = service.publish(first.id, 'admin', { expectedRevision: first.draft.revision }).version;
    const secondVersion = service.publish(second.id, 'admin', { expectedRevision: second.draft.revision }).version;

    expect(() => service.updateExecutionChain(first.id, 'admin', { preFlowVersionId: firstVersion.id }))
      .toThrow(expect.objectContaining({ code: 'FLOW_CHAIN_SELF_REFERENCE' }));
    expect(() => service.updateExecutionChain(first.id, 'admin', { preFlowVersionId: creating.id }))
      .toThrow(expect.objectContaining({ code: 'FLOW_VERSION_NOT_FOUND' }));

    service.updateExecutionChain(first.id, 'admin', { preFlowVersionId: secondVersion.id });
    expect(() => service.updateExecutionChain(second.id, 'admin', { postFlowVersionId: firstVersion.id }))
      .toThrow(expect.objectContaining({ code: 'FLOW_CHAIN_CYCLE' }));
    expect(() => service.setArchived(second.id, 'admin', true))
      .toThrow(expect.objectContaining({ code: 'FLOW_CHAIN_REFERENCE_IN_USE' }));
  });

  test('发布版本不会被后续草稿修改', () => {
    const created = service.createFromRecording(namedRecording('recording-versioned', '稳定登录'), 'admin');
    const publishedName = created.draft.flow.name;
    const published = service.publish(created.id, 'admin', { expectedRevision: created.draft.revision }).version;
    const edited = service.saveDraft(created.id, 'admin', { expectedRevision: created.draft.revision, name: '稳定登录-草稿修改' });
    const second = service.publish(created.id, 'admin', { expectedRevision: edited.draft.revision }).version;

    expect(service.getVersion(published.id).flow.name).toBe(publishedName);
    expect(service.get(created.id).draft.flow.name).toBe('稳定登录-草稿修改');
    expect(second.versionNumber).toBe(2);
    expect(service.listPublishedVersions().map((version) => version.versionNumber)).toEqual([2, 1]);
    expect(() => service.publish(created.id, 'admin', { expectedRevision: created.draft.revision }))
      .toThrow(expect.objectContaining({ code: 'FLOW_DRAFT_CONFLICT' }));
  });

  test('从不可变历史版本复制为新的回放任务', () => {
    const created = service.createFromRecording(namedRecording('recording-copy-version', '登录基线'), 'admin');
    const version = service.publish(created.id, 'admin', { expectedRevision: created.draft.revision }).version;
    service.saveDraft(created.id, 'admin', { expectedRevision: created.draft.revision, name: '登录基线-未发布修改' });

    const copied = service.copyVersion(version.id, 'tester', '登录基线 v1 复制任务');

    expect(copied).toMatchObject({ name: '登录基线 v1 复制任务', status: 'draft', creationCompleted: true });
    expect(copied.id).not.toBe(created.id);
    expect(copied.draft.flow.nodes).toEqual(version.flow.nodes);
    expect(copied.draft.flow.name).toBe('登录基线 v1 复制任务');
    expect(copied.auditEvents[0]).toMatchObject({
      eventType: 'flow.version_copied',
      actor: 'tester',
      payload: { sourceAssetId: created.id, sourceVersionId: version.id, sourceVersionNumber: 1 },
    });
  });

  test('回滚历史版本只生成新草稿且不修改已发布版本', () => {
    const created = service.createFromRecording(namedRecording('recording-rollback', '社区搜索 v1'), 'admin');
    const first = service.publish(created.id, 'admin', { expectedRevision: created.draft.revision }).version;
    const edited = service.saveDraft(created.id, 'developer', {
      expectedRevision: created.draft.revision,
      name: '社区搜索 v2 草稿',
    });
    const second = service.publish(created.id, 'developer', { expectedRevision: edited.draft.revision }).version;

    const rolledBack = service.rollbackToVersion(first.id, 'developer', edited.draft.revision);

    expect(rolledBack.draft.revision).toBe(edited.draft.revision + 1);
    expect(rolledBack.name).toBe(first.flow.name);
    expect(rolledBack.draft.flow).toEqual(first.flow);
    expect(rolledBack.latestVersionId).toBe(second.id);
    expect(service.getVersion(first.id).flow).toEqual(first.flow);
    expect(service.getVersion(second.id).flow).toEqual(second.flow);
    expect(rolledBack.auditEvents[0]).toMatchObject({
      eventType: 'flow.version_rolled_back_to_draft',
      actor: 'developer',
      payload: { sourceVersionId: first.id, sourceVersionNumber: 1, revision: edited.draft.revision + 1 },
    });
    expect(() => service.rollbackToVersion(first.id, 'developer', edited.draft.revision))
      .toThrow(expect.objectContaining({ code: 'FLOW_DRAFT_CONFLICT' }));
  });
});
