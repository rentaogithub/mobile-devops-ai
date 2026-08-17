import { Space, Tag } from 'antd';
import { JenkinsBuild, JenkinsQualityBuild } from '../../services/api';
import { appStoreReleaseTag } from './AppStoreReleaseCard';
import { releaseOrderStatusTag } from './ReleaseTimelineCard';
import { testFlightDistributionTag } from './TestFlightDistributionCard';

function formatDuration(duration: number, building: boolean) {
  if (!duration && building) return '运行中';
  if (!duration) return '-';
  const seconds = Math.round(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}分${restSeconds}秒` : `${restSeconds}秒`;
}

function formatSeconds(value?: number | null) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '-';
  const seconds = Math.max(0, Math.floor(Number(value)));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}时${minutes}分`;
  if (minutes > 0) return `${minutes}分${rest}秒`;
  return `${rest}秒`;
}

export function progressElapsedSeconds(build: JenkinsQualityBuild) {
  const progress = build.qualitySummary?.progress;
  const progressElapsed = Number(progress?.elapsedSeconds || 0);
  const requestedDuration = Number(progress?.requestedDurationSeconds || 0);
  const progressPercentValue = Number(progress?.progressPercent || 0);
  const progressStatusValue = String(progress?.status || build.qualitySummary?.status || '').toLowerCase();
  const isTerminal = progressPercentValue >= 100 ||
    ['passed', 'success', 'failed', 'unstable', 'canceled', 'cancelled', 'aborted'].includes(progressStatusValue);
  if (requestedDuration > 0 && isTerminal) {
    return requestedDuration;
  }
  if (build.building && progress?.updatedAt && progressElapsed >= 0) {
    const sinceUpdate = Math.max(0, Math.floor((Date.now() - Number(progress.updatedAt)) / 1000));
    const liveElapsed = progressElapsed + sinceUpdate;
    return requestedDuration > 0 ? Math.min(requestedDuration, liveElapsed) : liveElapsed;
  }
  if (progressElapsed > 0) {
    return requestedDuration > 0 ? Math.min(requestedDuration, progressElapsed) : progressElapsed;
  }
  const monkeyDurationMs = Number(build.qualitySummary?.performanceAnalysis?.monkeyDurationMs || 0);
  if (Number.isFinite(monkeyDurationMs) && monkeyDurationMs > 0) {
    const monkeySeconds = Math.round(monkeyDurationMs / 1000);
    return requestedDuration > 0 ? Math.min(requestedDuration, monkeySeconds) : monkeySeconds;
  }
  if (build.duration > 0) return Math.round(build.duration / 1000);
  return progressElapsed;
}

export function formatQualityDuration(build: JenkinsQualityBuild) {
  const seconds = progressElapsedSeconds(build);
  if (seconds > 0) return formatSeconds(seconds);
  return formatDuration(build.duration, build.building);
}

export function formatMonkeyExecutionSummary(build: JenkinsQualityBuild) {
  const summary = build.qualitySummary;
  const executedEvents = Number(summary?.monkeyExecutedEvents || 0);
  const requestedDurationSeconds = Number(summary?.progress?.requestedDurationSeconds || 0);
  const monkeyDurationMs = Number(summary?.performanceAnalysis?.monkeyDurationMs || 0);
  const durationSeconds = requestedDurationSeconds > 0
    ? requestedDurationSeconds
    : (Number.isFinite(monkeyDurationMs) && monkeyDurationMs > 0 ? Math.round(monkeyDurationMs / 1000) : 0);
  if (durationSeconds > 0) return `${executedEvents} 次 / ${formatSeconds(durationSeconds)}`;
  const requestedEvents = Number(summary?.monkeyEventCount || 0);
  return requestedEvents > 0 ? `${executedEvents}/${requestedEvents} 次` : `${executedEvents} 次`;
}

export function progressRemainingSeconds(build: JenkinsQualityBuild) {
  const progress = build.qualitySummary?.progress;
  const requestedDuration = Number(progress?.requestedDurationSeconds || 0);
  if (requestedDuration <= 0) return progress?.remainingSeconds;
  return Math.max(0, requestedDuration - progressElapsedSeconds(build));
}

export function progressPercent(build: JenkinsQualityBuild) {
  const progress = build.qualitySummary?.progress;
  const requestedDuration = Number(progress?.requestedDurationSeconds || 0);
  if (requestedDuration > 0) {
    return Math.min(100, Math.max(0, Math.round((progressElapsedSeconds(build) / requestedDuration) * 100)));
  }
  return Math.min(100, Math.max(0, Math.round(progress?.progressPercent || 0)));
}

export function isQualityBuildEffectivelyRunning(build: JenkinsQualityBuild) {
  const progress = build.qualitySummary?.progress;
  const status = String(progress?.status || '').toLowerCase();
  if (['passed', 'success', 'failed', 'unstable', 'canceled', 'cancelled', 'aborted'].includes(status)) return false;
  if (progressPercent(build) >= 100) return false;
  return build.building;
}

export function progressStatus(build: JenkinsQualityBuild) {
  const status = String(build.qualitySummary?.status || build.qualitySummary?.progress?.status || '').toLowerCase();
  if (['passed', 'success'].includes(status)) return 'success';
  if (build.result === 'FAILURE' || ['failed', 'failure'].includes(status)) return 'exception';
  if (isQualityBuildEffectivelyRunning(build)) return 'active';
  return 'success';
}

export function hasQualityReportArtifact(build?: JenkinsQualityBuild | null) {
  const artifacts = build?.qualitySummary?.artifacts;
  if (!artifacts) return false;
  return Boolean(
    artifacts.qualityLogUrl ||
    artifacts.summaryUrl ||
    artifacts.monkeyReportUrl ||
    artifacts.performanceSamplesUrl ||
    artifacts.performanceTraceUrl ||
    artifacts.crashReportsUrl ||
    artifacts.junitUrl ||
    artifacts.screenshotUrl
  );
}

export function resultTag(build: Pick<JenkinsBuild, 'building' | 'result'>) {
  if (build.building) {
    return <Tag color="processing">运行中</Tag>;
  }
  switch (build.result) {
    case 'SUCCESS':
      return <Tag color="green">成功</Tag>;
    case 'FAILURE':
      return <Tag color="red">失败</Tag>;
    case 'ABORTED':
      return <Tag color="default">已取消</Tag>;
    case 'UNSTABLE':
      return <Tag color="orange">不稳定</Tag>;
    default:
      return <Tag>未知</Tag>;
  }
}

export function buildStatusTags(build: JenkinsBuild) {
  return (
    <Space size={4} wrap>
      {resultTag(build)}
      {build.releaseOrder && (
        <span title={build.releaseOrder.failureReason || build.releaseOrder.phase || undefined}>
          {releaseOrderStatusTag(build.releaseOrder.status)}
        </span>
      )}
      {build.publishChannel === 'TestFlight' && testFlightDistributionTag(build)}
      {build.publishChannel === 'AppStore' && appStoreReleaseTag(build)}
    </Space>
  );
}

export function qualityResultTag(build: JenkinsQualityBuild) {
  if (isQualityBuildEffectivelyRunning(build)) {
    return <Tag color="processing">运行中</Tag>;
  }
  if (build.building && progressPercent(build) >= 100) {
    return <Tag color="blue">收尾中</Tag>;
  }
  const status = String(build.qualitySummary?.status || build.qualitySummary?.progress?.status || '').toLowerCase();
  if (['passed', 'success'].includes(status)) {
    return <Tag color="green">通过</Tag>;
  }
  if (['failed', 'failure'].includes(status)) {
    return <Tag color="red">失败</Tag>;
  }
  if (['unstable', 'warning'].includes(status)) {
    return <Tag color="orange">需关注</Tag>;
  }
  if (['canceled', 'cancelled', 'aborted'].includes(status)) {
    return <Tag color="default">已取消</Tag>;
  }
  return resultTag(build);
}

export function qualitySummaryStatusMeta(build: JenkinsQualityBuild) {
  const status = String(build.qualitySummary?.status || build.qualitySummary?.progress?.status || '').toLowerCase();
  if (['passed', 'success'].includes(status)) return { type: 'success' as const, message: '质检完成' };
  if (['failed', 'failure'].includes(status)) return { type: 'error' as const, message: '质检失败' };
  if (['unstable', 'warning'].includes(status)) return { type: 'warning' as const, message: '质检完成，需关注' };
  if (['canceled', 'cancelled', 'aborted'].includes(status)) return { type: 'info' as const, message: '质检已取消' };
  if (isQualityBuildEffectivelyRunning(build)) return { type: 'info' as const, message: '质检运行中' };
  if (build.result === 'SUCCESS') return { type: 'success' as const, message: '质检完成' };
  if (build.result === 'FAILURE') return { type: 'error' as const, message: '质检失败' };
  return { type: 'info' as const, message: '质检结果' };
}

const QUALITY_PHASE_LABELS: Record<string, string> = {
  preparing: '准备阶段',
  package: '包获取阶段',
  install: '安装阶段',
  wda: 'WDA 阶段',
  launch: 'App 启动阶段',
  coldstart: '冷启动阶段',
  cold_start: '冷启动阶段',
  performance: '性能采样阶段',
  monkey: 'Monkey 执行阶段',
  report: '报告生成阶段',
  cleanup: '清理阶段',
  failed: '失败收尾',
};

function inferQualityPhase(build: JenkinsQualityBuild) {
  const summary = build.qualitySummary;
  const rawPhase = String(summary?.progress?.phase || '').trim().toLowerCase();
  if (rawPhase && rawPhase !== 'failed') return rawPhase;

  const failed = build.result === 'FAILURE' || ['failed', 'failure'].includes(String(summary?.status || summary?.progress?.status || '').toLowerCase());
  if (!failed && rawPhase) return rawPhase;

  const text = [
    summary?.message,
    summary?.monkeyMessage,
    summary?.progress?.message,
  ].filter(Boolean).join('\n');

  if (/安装|install|provisioning|0xe8008015|0xe800801f/i.test(text)) return 'install';
  if (/wda|webdriveragent|iproxy|8100|8156/i.test(text)) return 'wda';
  if (/启动|launch|bundle identifier|bundle id/i.test(text)) return 'launch';
  if (/xctrace|性能|performance|trace/i.test(text)) return 'performance';
  if (/monkey|connection reset|broken pipe/i.test(text)) return 'monkey';
  if (/包|ipa|package|artifact|download/i.test(text)) return 'package';
  return rawPhase || (failed ? 'failed' : '');
}

export function qualityPhaseLabel(build: JenkinsQualityBuild) {
  const phase = inferQualityPhase(build);
  return phase ? (QUALITY_PHASE_LABELS[phase] || phase) : '';
}
