import { describe, expect, it } from 'vitest';
import { isQualityBuildEffectivelyRunning, progressElapsedSeconds, progressPercent } from './qualityStatus';

describe('qualityStatus replay flow progress', () => {
  it('回放任务刚开始时不会直接显示 100% 或收尾中', () => {
    const build = {
      building: true,
      duration: 0,
      qualitySummary: {
        progress: {
          status: 'running',
          phase: 'replayFlow',
          updatedAt: Date.now(),
          elapsedSeconds: 0,
          requestedDurationSeconds: 14400,
          progressPercent: 0,
        },
      },
    } as any;

    expect(progressPercent(build)).toBeLessThan(1);
    expect(isQualityBuildEffectivelyRunning(build)).toBe(true);
  });

  it('提前失败时展示 Jenkins 实际耗时，不冒充计划时长', () => {
    const build = {
      building: false,
      result: 'FAILURE',
      duration: 1_077_508,
      qualitySummary: {
        status: 'failed',
        progress: {
          status: 'failed',
          elapsedSeconds: 14400,
          requestedDurationSeconds: 14400,
          progressPercent: 25,
        },
      },
    } as any;

    expect(progressElapsedSeconds(build)).toBe(1078);
    expect(progressPercent(build)).toBe(7);
    expect(isQualityBuildEffectivelyRunning(build)).toBe(false);
  });
});
