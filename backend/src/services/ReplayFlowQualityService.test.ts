import { ReplayFlowQualityService } from './ReplayFlowQualityService';

function version(id: string, assetId: string, assetName: string, versionNumber: number, inputs: Record<string, any> = {}) {
  return {
    id,
    assetId,
    assetName,
    versionNumber,
    projectId: 'nn-ios',
    flow: {
      schemaVersion: '1.0',
      id: assetId,
      name: assetName,
      inputs,
      nodes: [],
    },
    compiled: {},
    sourceFingerprint: 'fingerprint',
    createdBy: 'tester',
    createdAt: '2026-09-04T00:00:00.000Z',
  } as any;
}

describe('ReplayFlowQualityService', () => {
  it('固化选定的前置、主流程和后置发布版本', () => {
    const versions: Record<string, any> = {
      pre_v1: version('pre_v1', 'pre', '登录准备', 1, { account: { type: 'string', required: true } }),
      main_v2: version('main_v2', 'main', '社区搜索', 2, { keyword: { type: 'string', default: '游戏' } }),
      post_v3: version('post_v3', 'post', '退出清理', 3),
    };
    const assets: Record<string, any> = {
      main: { id: 'main', name: '社区搜索', status: 'published', preFlowVersionId: 'pre_v1', postFlowVersionId: 'post_v3' },
      pre: { id: 'pre', name: '登录准备', status: 'published' },
      post: { id: 'post', name: '退出清理', status: 'published' },
    };
    const service = new ReplayFlowQualityService({
      get: (id: string) => assets[id],
      getVersion: (id: string) => versions[id],
    } as any);

    const result = service.createConfiguration({
      assetId: 'main',
      versionId: 'main_v2',
      inputs: { account: 'admin' },
      durationSeconds: 300,
      stopOnFailure: true,
    });

    expect(result.manifest.phases.map((item) => [item.phase, item.versionId])).toEqual([
      ['pre', 'pre_v1'],
      ['main', 'main_v2'],
      ['post', 'post_v3'],
    ]);
    expect(result.manifest.inputNames).toEqual(['account', 'keyword']);
    expect(result.inputs).toEqual({ account: 'admin', keyword: '游戏' });
    expect(JSON.stringify(result.manifest)).not.toContain('admin');
  });

  it('拒绝不属于当前回放任务的主版本', () => {
    const service = new ReplayFlowQualityService({
      get: () => ({ id: 'main', name: '主流程', status: 'published' }),
      getVersion: () => version('other_v1', 'other', '其他流程', 1),
    } as any);

    expect(() => service.createConfiguration({
      assetId: 'main', versionId: 'other_v1', durationSeconds: 300,
    })).toThrow('所选版本不属于当前回放任务');
  });
});
