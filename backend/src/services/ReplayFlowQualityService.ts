import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDatabasePath } from '../database';
import {
  ReplayFlowAssetService,
  ReplayFlowVersion,
  replayFlowAssetService,
} from './ReplayFlowAssetService';

export type ReplayFlowQualityPhase = 'pre' | 'main' | 'post';

export interface ReplayFlowQualityManifestPhase {
  phase: ReplayFlowQualityPhase;
  assetId: string;
  assetName: string;
  versionId: string;
  versionNumber: number;
}

export interface ReplayFlowQualityExecutionManifest {
  id: string;
  schemaVersion: '1.0';
  createdAt: string;
  mainAssetId: string;
  mainAssetName: string;
  durationSeconds: number;
  stopOnFailure: boolean;
  inputNames: string[];
  phases: ReplayFlowQualityManifestPhase[];
}

export interface ReplayFlowQualityConfiguration {
  manifest: ReplayFlowQualityExecutionManifest;
  inputs: Record<string, string>;
}

export class ReplayFlowQualityError extends Error {
  constructor(message: string, public statusCode = 400, public code = 'REPLAY_FLOW_QUALITY_ERROR') {
    super(message);
  }
}

function phaseFromVersion(phase: ReplayFlowQualityPhase, version: ReplayFlowVersion): ReplayFlowQualityManifestPhase {
  return {
    phase,
    assetId: version.assetId,
    assetName: version.assetName,
    versionId: version.id,
    versionNumber: version.versionNumber,
  };
}

export class ReplayFlowQualityService {
  constructor(private assets: ReplayFlowAssetService = replayFlowAssetService) {}

  createConfiguration(input: {
    assetId?: unknown;
    versionId?: unknown;
    inputs?: unknown;
    durationSeconds?: unknown;
    stopOnFailure?: unknown;
  }): ReplayFlowQualityConfiguration {
    const assetId = String(input.assetId || '').trim();
    const versionId = String(input.versionId || '').trim();
    if (!assetId || !versionId) throw new ReplayFlowQualityError('请选择已发布的回放任务和执行版本');

    const mainAsset = this.assets.get(assetId);
    if (mainAsset.status !== 'published') throw new ReplayFlowQualityError('回放任务必须处于已发布状态', 409);
    const mainVersion = this.assets.getVersion(versionId);
    if (mainVersion.assetId !== mainAsset.id) throw new ReplayFlowQualityError('所选版本不属于当前回放任务');

    const versions: Array<{ phase: ReplayFlowQualityPhase; version: ReplayFlowVersion }> = [];
    if (mainAsset.preFlowVersionId) versions.push({ phase: 'pre', version: this.publishedVersion(mainAsset.preFlowVersionId, '前置流程') });
    versions.push({ phase: 'main', version: mainVersion });
    if (mainAsset.postFlowVersionId) versions.push({ phase: 'post', version: this.publishedVersion(mainAsset.postFlowVersionId, '后置流程') });

    const supplied = input.inputs && typeof input.inputs === 'object' && !Array.isArray(input.inputs)
      ? input.inputs as Record<string, unknown>
      : {};
    const definitions = new Map<string, { required: boolean; defaultValue?: string }>();
    versions.forEach(({ version }) => {
      Object.entries(version.flow.inputs || {}).forEach(([name, definition]) => {
        const current = definitions.get(name);
        definitions.set(name, {
          required: Boolean(current?.required || definition.required),
          defaultValue: current?.defaultValue ?? definition.default,
        });
      });
    });
    const values: Record<string, string> = {};
    definitions.forEach((definition, name) => {
      const raw = supplied[name];
      const resolved = raw === undefined || raw === null ? definition.defaultValue : String(raw);
      if ((resolved === undefined || resolved === '') && definition.required) {
        throw new ReplayFlowQualityError(`回放参数 ${name} 必填`);
      }
      if (resolved !== undefined) {
        const value = String(resolved);
        if (value.length > 2000) throw new ReplayFlowQualityError(`回放参数 ${name} 不能超过 2000 个字符`);
        values[name] = value;
      }
    });

    const durationSeconds = Number(input.durationSeconds);
    if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) throw new ReplayFlowQualityError('业务编排时长无效');
    const manifest: ReplayFlowQualityExecutionManifest = {
      id: `replay_quality_${crypto.randomUUID()}`,
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      mainAssetId: mainAsset.id,
      mainAssetName: mainAsset.name,
      durationSeconds,
      stopOnFailure: input.stopOnFailure !== false,
      inputNames: [...definitions.keys()].sort(),
      phases: versions.map(({ phase, version }) => phaseFromVersion(phase, version)),
    };
    return { manifest, inputs: values };
  }

  persistRuntimeInputs(manifestId: string, inputs: Record<string, string>) {
    const directory = this.runtimeInputDirectory();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = this.runtimeInputPath(manifestId);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(inputs), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  }

  readRuntimeInputs(manifestId: string) {
    const target = this.runtimeInputPath(manifestId);
    if (!fs.existsSync(target)) throw new ReplayFlowQualityError('回放质检运行参数映射不存在', 500, 'REPLAY_FLOW_INPUTS_NOT_FOUND');
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  }

  removeRuntimeInputs(manifestId: string) {
    const target = this.runtimeInputPath(manifestId);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }

  private publishedVersion(versionId: string, label: string) {
    const version = this.assets.getVersion(versionId);
    const asset = this.assets.get(version.assetId);
    if (asset.status !== 'published') throw new ReplayFlowQualityError(`${label}所属任务已不是发布状态`, 409);
    return version;
  }

  private runtimeInputDirectory() {
    return path.join(path.dirname(getDatabasePath()), 'replay-flow-quality-inputs');
  }

  private runtimeInputPath(manifestId: string) {
    const safeId = String(manifestId || '').replace(/[^A-Za-z0-9._-]+/g, '_');
    if (!safeId) throw new ReplayFlowQualityError('回放执行清单 ID 无效');
    return path.join(this.runtimeInputDirectory(), `${safeId}.json`);
  }
}

export const replayFlowQualityService = new ReplayFlowQualityService();
