import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import * as echarts from 'echarts';
import { Typography, Card, Row, Col, Button, Space, Table, Tag, message, Modal, Alert, Radio, Input, Select, QRCode, AutoComplete, Popconfirm, Tabs, Descriptions, Empty, Image, Progress, Checkbox, Collapse } from 'antd';
import {
  RocketOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  ExportOutlined,
  DownloadOutlined,
  StopOutlined,
  FileTextOutlined,
  SettingOutlined,
  PlusOutlined,
  DeleteOutlined,
  BranchesOutlined,
  UploadOutlined,
  BulbOutlined,
} from '@ant-design/icons';
import { JenkinsBuild, JenkinsBuildFailureAnalysis, JenkinsBuildListResult, JenkinsQualityArtifactPreview, JenkinsQualityBuild, JenkinsQualityListResult, JenkinsQualityPerformanceSamples, JenkinsQualitySuite, SonicDevicePool, SonicDevicePoolStatusResult, dsymApi, jenkinsApi, symbolicateApi } from '../services/api';
import type { DSYMInfo, SymbolicationResult } from '../types';

const { Title, Paragraph, Text } = Typography;
type DeployTarget = 'Pgyer' | 'TestFlight' | 'AppStore';
type QualitySummaryView = 'log' | 'monkey' | 'performance' | 'crash' | 'evidence' | 'summary';
type QualityReportKind = 'monkey' | 'stutter' | 'generic';

const DEPLOY_TARGET_OPTIONS: { label: string; value: DeployTarget }[] = [
  { label: '蒲公英', value: 'Pgyer' },
  { label: 'TestFlight', value: 'TestFlight' },
  { label: '苹果商店', value: 'AppStore' },
];

function publishChannelLabel(channel?: string) {
  const option = DEPLOY_TARGET_OPTIONS.find((item) => item.value === channel);
  return option?.label || channel || '';
}

const QUALITY_SUITE_OPTIONS: { label: string; value: JenkinsQualitySuite }[] = [
  { label: 'Monkey 测试', value: 'monkey' },
  { label: '卡顿检测', value: 'stutter' },
  { label: '冒烟测试', value: 'smoke' },
  { label: 'IM 基础链路', value: 'im' },
  { label: 'RTC 基础链路', value: 'rtc' },
  { label: '全量回归', value: 'full' },
];

const QUALITY_SUITE_GROUPS: { title: string; options: { label: string; value: JenkinsQualitySuite }[] }[] = [
  {
    title: '稳定性&性能压测：',
    options: QUALITY_SUITE_OPTIONS.filter((option) => option.value === 'monkey' || option.value === 'stutter'),
  },
  {
    title: '业务核心链路压测：',
    options: QUALITY_SUITE_OPTIONS.filter((option) => !['monkey', 'stutter'].includes(option.value)),
  },
];

const MONKEY_DURATION_OPTIONS = [
  { label: '5 分钟', value: 300 },
  { label: '0.5 小时', value: 1800 },
  { label: '1 小时', value: 3600 },
  { label: '4 小时', value: 14400 },
  { label: '8 小时', value: 28800 },
];

const STUTTER_SCENARIO_OPTIONS = [
  { label: '社区', value: 'community' },
  { label: 'IM', value: 'im' },
  { label: '语音房', value: 'voice_room' },
];

function stutterScenarioLabel(value?: string) {
  if (['rtc', 'room', 'voice', 'voice-room', 'voiceroom', 'voice_room', '语音房'].includes(String(value || '').toLowerCase())) {
    return '语音房';
  }
  const option = STUTTER_SCENARIO_OPTIONS.find((item) => item.value === value);
  return option?.label || value || '';
}

const PRODUCTION_BUNDLE_ID = 'com.nnhuyu.im';
const QUALITY_JOB_MISSING_MESSAGE = '未找到 Jenkins 自动质检 Job：nn-auto-quality，请先在 Jenkins 中创建该 Job，或通过 JENKINS_NN_QA_JOB 配置正确 Job 名称。';

function normalizeQualityError(err: any) {
  const message = String(err?.error || err?.message || '');
  if (err?.status === 404 || /Not Found|page does not exist|Oops! Not Found/i.test(message)) {
    return QUALITY_JOB_MISSING_MESSAGE;
  }
  return message || '加载自动质检任务列表失败';
}

function shouldUseInstalledProductionApp(build?: JenkinsBuild | null) {
  return build?.publishChannel === 'TestFlight' || build?.publishChannel === 'AppStore';
}

function getQualityReportKind(build?: JenkinsQualityBuild | null): QualityReportKind {
  const suite = String(build?.qualitySummary?.testSuite || '').trim().toLowerCase();
  if (suite === 'stutter') return 'stutter';
  if (suite === 'monkey') return 'monkey';
  return 'generic';
}

function getQualityReportTitle(build?: JenkinsQualityBuild | null) {
  const kind = getQualityReportKind(build);
  if (kind === 'stutter') return '卡顿检测报告';
  if (kind === 'monkey') return 'Monkey 质检报告';
  return '质检汇总';
}

function qualitySuiteLabel(summary?: JenkinsQualityBuild['qualitySummary']) {
  const suite = String(summary?.testSuite || '').toLowerCase();
  if (suite === 'stutter') {
    const scenario = stutterScenarioLabel(summary?.stutterScenario);
    return scenario ? `卡顿检测 / ${scenario}` : '卡顿检测';
  }
  if (suite === 'monkey') return 'Monkey';
  return summary?.testSuite || '-';
}

function isReleaseBranch(branch: string) {
  return /^(?:origin\/)?release\/\d+(?:\.\d+){2,}$/.test(branch.trim());
}

function getReleaseVersion(branch: string) {
  const match = branch.trim().replace(/^origin\//, '').match(/^release\/(\d+(?:\.\d+){2,})$/);
  return match ? match[1].split('.').map((item) => Number(item)) : [];
}

function getBranchVersion(branch: string) {
  const match = branch.trim().replace(/^origin\//, '').match(/^(?:release|feature)\/(\d+(?:\.\d+){2,})(?:[_/-].*)?$/);
  return match ? match[1].split('.').map((item) => Number(item)) : [];
}

function compareReleaseBranches(a: string, b: string) {
  const av = getReleaseVersion(a);
  const bv = getReleaseVersion(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (av[i] || 0) - (bv[i] || 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function compareBranchVersionsDesc(a: string, b: string) {
  const av = getBranchVersion(a);
  const bv = getBranchVersion(b);
  const hasVersionA = av.length > 0;
  const hasVersionB = bv.length > 0;
  if (hasVersionA && hasVersionB) {
    const len = Math.max(av.length, bv.length);
    for (let i = 0; i < len; i += 1) {
      const diff = (bv[i] || 0) - (av[i] || 0);
      if (diff !== 0) return diff;
    }
  } else if (hasVersionA) {
    return -1;
  } else if (hasVersionB) {
    return 1;
  }
  return a.localeCompare(b);
}

function compareBranchOptions(a: string, b: string) {
  const normalizedA = a.trim().replace(/^origin\//, '');
  const normalizedB = b.trim().replace(/^origin\//, '');
  if (normalizedA === 'develop') return -1;
  if (normalizedB === 'develop') return 1;
  const aIsRelease = isReleaseBranch(normalizedA);
  const bIsRelease = isReleaseBranch(normalizedB);
  if (aIsRelease && bIsRelease) return compareReleaseBranches(normalizedB, normalizedA);
  if (aIsRelease) return -1;
  if (bIsRelease) return 1;
  const aIsFeature = normalizedA.startsWith('feature/');
  const bIsFeature = normalizedB.startsWith('feature/');
  if (aIsFeature && bIsFeature) return compareBranchVersionsDesc(normalizedA, normalizedB);
  return normalizedA.localeCompare(normalizedB);
}

function getHighestReleaseBranch(list: string[]) {
  return list.filter(isReleaseBranch).sort(compareReleaseBranches).at(-1) || '';
}

function getLatestReleaseBranches(list: string[], limit = 2) {
  return list
    .map((branch) => branch.trim().replace(/^origin\//, ''))
    .filter(isReleaseBranch)
    .sort(compareReleaseBranches)
    .slice(-limit)
    .reverse();
}

function formatBuildTime(timestamp: number) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString();
}

function formatDuration(duration: number, building: boolean) {
  if (!duration && building) return '运行中';
  if (!duration) return '-';
  const seconds = Math.round(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}分${restSeconds}秒` : `${restSeconds}秒`;
}

function formatMilliseconds(value?: number | string | null) {
  if (value === undefined || value === null || value === '') return '-';
  const ms = Number(value);
  if (!Number.isFinite(ms)) return '-';
  if (ms >= 1000) {
    return `${ms}ms (${(ms / 1000).toFixed(2)}秒)`;
  }
  return `${ms}ms`;
}

function analysisSeverityColor(severity?: string) {
  if (severity === 'failed') return 'red';
  if (severity === 'warning') return 'orange';
  if (severity === 'passed') return 'green';
  return 'default';
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

function progressElapsedSeconds(build: JenkinsQualityBuild) {
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

function formatQualityDuration(build: JenkinsQualityBuild) {
  const seconds = progressElapsedSeconds(build);
  if (seconds > 0) return formatSeconds(seconds);
  return formatDuration(build.duration, build.building);
}

function formatMonkeyExecutionSummary(build: JenkinsQualityBuild) {
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

function progressRemainingSeconds(build: JenkinsQualityBuild) {
  const progress = build.qualitySummary?.progress;
  const requestedDuration = Number(progress?.requestedDurationSeconds || 0);
  if (requestedDuration <= 0) return progress?.remainingSeconds;
  return Math.max(0, requestedDuration - progressElapsedSeconds(build));
}

function progressPercent(build: JenkinsQualityBuild) {
  const progress = build.qualitySummary?.progress;
  const requestedDuration = Number(progress?.requestedDurationSeconds || 0);
  if (requestedDuration > 0) {
    return Math.min(100, Math.max(0, Math.round((progressElapsedSeconds(build) / requestedDuration) * 100)));
  }
  return Math.min(100, Math.max(0, Math.round(progress?.progressPercent || 0)));
}

function isQualityBuildEffectivelyRunning(build: JenkinsQualityBuild) {
  const progress = build.qualitySummary?.progress;
  const status = String(progress?.status || '').toLowerCase();
  if (['passed', 'success', 'failed', 'unstable', 'canceled', 'cancelled', 'aborted'].includes(status)) return false;
  if (progressPercent(build) >= 100) return false;
  return build.building;
}

function progressStatus(build: JenkinsQualityBuild) {
  const status = String(build.qualitySummary?.status || build.qualitySummary?.progress?.status || '').toLowerCase();
  if (['passed', 'success'].includes(status)) return 'success';
  if (build.result === 'FAILURE' || ['failed', 'failure'].includes(status)) return 'exception';
  if (isQualityBuildEffectivelyRunning(build)) return 'active';
  return 'success';
}

function hasQualityReportArtifact(build?: JenkinsQualityBuild | null) {
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

function resultTag(build: Pick<JenkinsBuild, 'building' | 'result'>) {
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

function qualityResultTag(build: JenkinsQualityBuild) {
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

function qualitySummaryStatusMeta(build: JenkinsQualityBuild) {
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

function qualityPhaseLabel(build: JenkinsQualityBuild) {
  const phase = inferQualityPhase(build);
  return phase ? (QUALITY_PHASE_LABELS[phase] || phase) : '';
}

function getChannelBuildNumber(build: JenkinsBuild) {
  const rawBuildNumber = String(build.buildNumber || '').trim();
  const channelBuildNumber = rawBuildNumber.match(/[0-9]+$/)?.[0] || rawBuildNumber;
  if (!channelBuildNumber) return '';
  if (channelBuildNumber === String(build.number)) return '';
  return channelBuildNumber;
}

function canAnalyzeBuildFailure(build?: JenkinsBuild, log?: string) {
  if (!build) return false;
  if (build.result === 'FAILURE') return true;
  if (build.result === 'SUCCESS') return false;
  return /Finished:\s+FAILURE|fastlane finished with errors|构建失败|上传失败/i.test(log || '');
}

function normalizeOpenUrl(url?: string) {
  if (!url) return '';
  try {
    const parsed = new URL(url, window.location.origin);
    if (['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
      parsed.hostname = window.location.hostname;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function openExternalUrl(url?: string) {
  const normalizedUrl = normalizeOpenUrl(url);
  if (!normalizedUrl) return;
  window.open(normalizedUrl, '_blank', 'noopener,noreferrer');
}

function openPerformanceTrace(url?: string) {
  openExternalUrl(url);
}

type QualityPerformanceAnalysis = NonNullable<NonNullable<JenkinsQualityBuild['qualitySummary']>['performanceAnalysis']>;

function performanceSeverityMeta(severity?: string, reportKind: QualityReportKind = 'generic') {
  if (severity === 'failed') return { alertType: 'error' as const, label: '高风险', summary: '检测到阻塞级性能风险，建议发布前确认。' };
  if (severity === 'warning') return {
    alertType: 'warning' as const,
    label: '需关注',
    summary: reportKind === 'monkey' ? '性能数据有可疑变化，建议结合 Monkey 动作和页面进一步确认。' : '性能数据有可疑变化，建议结合采样时间点、Trace 和页面状态进一步确认。',
  };
  if (severity === 'passed') return { alertType: 'success' as const, label: '通过', summary: '本次采样未触发已配置阈值，整体性能表现可接受。' };
  return { alertType: 'info' as const, label: '待判断', summary: '本次报告缺少完整结论，需要结合采样数据人工判断。' };
}

function gradeLabel(grade?: string) {
  if (grade === 'good') return '良好';
  if (grade === 'warning') return '偏慢';
  if (grade === 'slow') return '慢';
  return grade || '未知';
}

function metricText(value?: number | null, suffix = '') {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '-';
  return `${value}${suffix}`;
}

function buildPerformanceHighlights(analysis?: QualityPerformanceAnalysis, reportKind: QualityReportKind = 'generic') {
  if (!analysis) return [];
  const includeStutterMetrics = reportKind !== 'monkey';
  const trace = analysis.trace;
  const samples = analysis.samples;
  const stutter = analysis.stutter;
  const frameStutter = analysis.frameStutter;
  const stackAnalysis = analysis.stackAnalysis;
  return [
    analysis.coldStartReadyMs !== undefined ? `首屏稳定 ${formatMilliseconds(analysis.coldStartReadyMs)}，评级 ${gradeLabel(analysis.coldStartGrade)}` : '',
    analysis.launchDurationMs !== undefined ? `启动命令耗时 ${formatMilliseconds(analysis.launchDurationMs)}` : '',
    Number(samples?.sampleCount || 0) > 0 ? `采样 ${samples?.sampleCount} 条` : '',
    samples?.cpu?.avg !== undefined && samples.cpu.avg !== null ? `CPU 平均 ${samples.cpu.avg}% / 峰值 ${metricText(samples.cpu.max, '%')}` : '',
    samples?.memoryMB?.avg !== undefined && samples.memoryMB.avg !== null ? `内存平均 ${samples.memoryMB.avg}MB / 峰值 ${metricText(samples.memoryMB.max, 'MB')}` : '',
    includeStutterMetrics && samples?.fps?.avg !== undefined && samples.fps.avg !== null ? `FPS 平均 ${samples.fps.avg} / 最低 ${metricText(samples.fps.min)}` : '',
    includeStutterMetrics && frameStutter?.available ? `帧级卡顿 ${frameStutter.hitchCount || 0} 次 / 严重 ${frameStutter.severeHitchCount || 0} 次` : '',
    includeStutterMetrics && stackAnalysis?.enabled ? `调用栈 ${stackAnalysis.available ? '已匹配' : '未匹配'}` : '',
    includeStutterMetrics && stutter?.enabled ? `交互卡顿 ${stutter.slowActionCount || 0} 次 / 严重 ${stutter.severeActionCount || 0} 次` : '',
    includeStutterMetrics && stutter?.targetAppRecoveryCount ? `离开被测 App ${stutter.targetAppRecoveryCount} 次` : '',
    reportKind === 'monkey' && analysis.monkeyDurationMs !== undefined ? `Monkey 执行 ${formatMilliseconds(analysis.monkeyDurationMs)}，${analysis.monkeyExecutedEvents || 0} 次动作` : '',
    trace?.available ? `Trace ${trace.segmentCount && trace.segmentCount > 1 ? `${trace.segmentCount} 段` : '已采集'}${trace.durationSeconds ? `，${formatSeconds(Math.round(trace.durationSeconds))}` : ''}` : '',
  ].filter(Boolean);
}

function buildPerformanceSuggestions(analysis?: QualityPerformanceAnalysis, reportKind: QualityReportKind = 'generic') {
  const isMonkeyReport = reportKind === 'monkey';
  if (!analysis) return [isMonkeyReport ? '缺少性能分析数据，建议重新执行一次包含性能采样的 Monkey 任务。' : '缺少性能分析数据，建议重新执行一次卡顿检测任务。'];
  const suggestions: string[] = [];
  const thresholds = analysis.thresholds || {};
  const cpuAvg = analysis.samples?.cpu?.avg;
  const cpuMax = analysis.samples?.cpu?.max;
  const memoryMax = analysis.samples?.memoryMB?.max;
  const fpsAvg = analysis.samples?.fps?.avg;
  const fpsMin = analysis.samples?.fps?.min;
  const stutter = analysis.stutter;
  const frameStutter = analysis.frameStutter;
  const stackAnalysis = analysis.stackAnalysis;

  if (analysis.coldStartGrade === 'warning' || analysis.coldStartGrade === 'slow') {
    suggestions.push('首屏耗时偏高，优先检查启动链路中的同步初始化、首屏接口等待和图片/资源加载。');
  }
  if (cpuAvg !== null && cpuAvg !== undefined && thresholds.cpuAvgWarn && cpuAvg >= thresholds.cpuAvgWarn) {
    suggestions.push('CPU 平均值超过阈值，建议排查循环计算、频繁刷新、日志输出或动画/音视频处理。');
  } else if (cpuMax !== null && cpuMax !== undefined && cpuMax >= 80) {
    suggestions.push(isMonkeyReport
      ? 'CPU 峰值较高，建议结合峰值附近 Monkey 动作确认是否是页面切换、列表渲染或音视频场景触发。'
      : 'CPU 峰值较高，建议结合峰值时间点、Trace 调用栈和当时页面确认是否由渲染、音视频或密集计算触发。');
  }
  if (memoryMax !== null && memoryMax !== undefined && thresholds.memoryPeakWarnMB && memoryMax >= thresholds.memoryPeakWarnMB) {
    suggestions.push('内存峰值超过阈值，建议检查大图、缓存、房间/聊天页面资源释放和循环引用。');
  }
  if (!isMonkeyReport && (
    (fpsAvg !== null && fpsAvg !== undefined && thresholds.fpsAvgWarn && fpsAvg < thresholds.fpsAvgWarn) ||
    (fpsMin !== null && fpsMin !== undefined && thresholds.fpsMinWarn && fpsMin > 0 && fpsMin < thresholds.fpsMinWarn)
  )) {
    suggestions.push('FPS 表现偏低，建议定位采样低点附近的页面和动作，重点看主线程阻塞、布局重算和批量刷新。');
  }
  if (analysis.trace?.available && !analysis.samples?.sampleCount) {
    suggestions.push('Trace 文件已生成但未导出采样行，可下载 Trace 用 Instruments 查看 Time Profiler / Activity Monitor 明细。');
  }
  if (!isMonkeyReport && analysis.samples?.sampleCount && (fpsAvg === null || fpsAvg === undefined) && (fpsMin === null || fpsMin === undefined)) {
    suggestions.push(frameStutter?.available
      ? '本次已解析 xctrace 帧级卡顿，可优先查看最长帧耗时和样本区间。'
      : (isMonkeyReport
        ? '本次 xctrace 样本未包含 FPS/帧时间数据，帧级卡顿暂未产出；可先参考 Monkey 交互延迟卡顿结果。'
        : '本次 xctrace 样本未包含 FPS/帧时间数据，帧级卡顿暂未产出；建议下载 Trace 在 Instruments 中查看。'));
  }
  if (!isMonkeyReport && frameStutter?.available && Number(frameStutter.hitchCount || 0) > 0) {
    suggestions.push('已检测到帧级卡顿，建议下载 Trace 用 Instruments 打开对应 Animation Hitches/Frame 表继续定位主线程或渲染原因。');
  }
  if (!isMonkeyReport && stutter?.enabled && Number(stutter.slowActionCount || 0) > 0) {
    suggestions.push(isMonkeyReport
      ? '已检测到交互卡顿，建议优先查看最长动作和典型样本附近的 Monkey 页面线索。'
      : '已检测到交互卡顿，建议优先查看最长动作、卡顿样本和对应 Trace 调用栈。');
  }
  if (!isMonkeyReport && stutter?.enabled && Number(stutter.targetAppRecoveryCount || 0) > 0) {
    suggestions.push(isMonkeyReport
      ? '测试过程中被测 App 离开过前台，建议优先结合崩溃/卡顿 IPS、Watchdog、系统弹窗和最后几次 Monkey 动作确认 App 是否被杀或切后台。'
      : '检测过程中被测 App 离开过前台，建议优先结合崩溃/卡顿 IPS、Watchdog、系统弹窗和 Trace 结束原因确认 App 是否被杀或切后台。');
  }
  if (!isMonkeyReport && stutter?.enabled && Number(stutter.severeActionCount || 0) > 0) {
    suggestions.push(stackAnalysis?.available
      ? '已匹配严重卡顿附近的 Time Profiler 调用栈，优先查看“卡顿调用栈”定位主线程热点。'
      : '严重交互卡顿需要 Time Profiler 调用栈辅助定位；若本次未匹配，建议确认 Trace 模板为 Time Profiler 后重跑。');
  }
  if (suggestions.length === 0) {
    suggestions.push(isMonkeyReport ? '当前没有触发阈值类风险，可保留本次报告作为 TestFlight/线上包 Monkey 基线。' : '当前没有触发阈值类风险，可保留本次报告作为卡顿检测性能基线。');
  }
  return suggestions;
}

function PerformanceDataCoverage({ analysis, reportKind = 'generic' }: { analysis: QualityPerformanceAnalysis; reportKind?: QualityReportKind }) {
  const sampleCount = analysis.samples?.sampleCount || 0;
  const includeStutterMetrics = reportKind !== 'monkey';
  const hasCpu = analysis.samples?.cpu?.avg !== null && analysis.samples?.cpu?.avg !== undefined;
  const hasMemory = analysis.samples?.memoryMB?.avg !== null && analysis.samples?.memoryMB?.avg !== undefined;
  const hasFps = analysis.samples?.fps?.avg !== null && analysis.samples?.fps?.avg !== undefined;
  const hasInteractionStutter = !!analysis.stutter?.enabled;
  const hasFrameStutter = !!analysis.frameStutter?.available;
  const hasStackAnalysis = !!analysis.stackAnalysis?.available;
  const missing = [
    includeStutterMetrics && !hasFps ? 'FPS' : '',
    includeStutterMetrics && !hasInteractionStutter ? '交互卡顿' : '',
    includeStutterMetrics && !hasFrameStutter ? '帧级卡顿' : '',
    includeStutterMetrics && analysis.stutter?.severeActionCount && !hasStackAnalysis ? '调用栈' : '',
  ].filter(Boolean);

  return (
    <Alert
      showIcon
      type={missing.length > 0 ? 'info' : 'success'}
      message="数据覆盖"
      description={(
        <Space direction="vertical" size={6}>
          <Space wrap>
            <Tag color={hasCpu ? 'green' : 'default'}>CPU {hasCpu ? '已采集' : '未采集'}</Tag>
            <Tag color={hasMemory ? 'green' : 'default'}>内存 {hasMemory ? '已采集' : '未采集'}</Tag>
            {includeStutterMetrics && <Tag color={hasFps ? 'green' : 'gold'}>FPS {hasFps ? '已采集' : '未采集'}</Tag>}
            {includeStutterMetrics && <Tag color={hasInteractionStutter ? 'green' : 'gold'}>交互卡顿 {hasInteractionStutter ? '已检测' : '未接入'}</Tag>}
            {includeStutterMetrics && <Tag color={hasFrameStutter ? 'green' : 'gold'}>帧级卡顿 {hasFrameStutter ? '已解析' : '未解析'}</Tag>}
            {includeStutterMetrics && <Tag color={hasStackAnalysis ? 'green' : 'gold'}>调用栈 {hasStackAnalysis ? '已匹配' : '未匹配'}</Tag>}
            {sampleCount > 0 && <Tag>样本 {sampleCount} 条</Tag>}
          </Space>
          {missing.length > 0 && (
            <Text type="secondary">
              {reportKind === 'monkey'
                ? 'Monkey 性能报告仅展示启动、CPU 和内存基础数据；卡顿、帧率和调用栈分析请使用卡顿检测任务。'
                : sampleCount > 0
                ? '本次已有进程采样，可分析 CPU/内存趋势；FPS 和精准帧级卡顿依赖 xctrace Animation Hitches/Frame 明细表。'
                : '本次 xctrace Trace 已采集，但未导出 CPU/内存明细；后续任务会同时启动侧路采样补齐 CPU/内存。'}
            </Text>
          )}
        </Space>
      )}
    />
  );
}

function PerformanceStackAnalysis({ analysis }: { analysis: QualityPerformanceAnalysis }) {
  const stackAnalysis = analysis.stackAnalysis;
  if (!stackAnalysis?.enabled && !analysis.stutter?.severeActionCount) return null;
  const samples = stackAnalysis?.samples || [];
  const hasFrames = samples.some((sample) => (sample.matchedFrames || []).length > 0);
  return (
    <Alert
      showIcon
      type={hasFrames ? 'success' : 'info'}
      message={hasFrames ? '卡顿调用栈已匹配' : '卡顿调用栈未匹配'}
      description={(
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Text type="secondary">
            {stackAnalysis?.message || '严重交互卡顿需要 Time Profiler Trace 才能定位调用栈。'}
          </Text>
          {stackAnalysis?.template && <Tag>Trace 模板 {stackAnalysis.template}</Tag>}
          {samples.length > 0 && (
            <Collapse
              size="small"
              items={samples.slice(0, 6).map((sample, index) => ({
                key: `${sample.index || index}-${sample.actionDurationMs || 0}`,
                label: `#${sample.index || '-'} ${eventTypeLabel(sample.type)} ${sample.actionDurationMs || '-'}ms${sample.elapsedSeconds ? ` / ${Math.round(sample.elapsedSeconds)}s` : ''}`,
                children: (
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    {sample.page?.summary?.text?.length ? (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        页面线索：{sample.page.summary.text.slice(0, 6).join(' / ')}
                      </Text>
                    ) : null}
                    {(sample.matchedFrames || []).length > 0 ? (
                      <pre
                        style={{
                          margin: 0,
                          maxHeight: 300,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          fontSize: 12,
                          lineHeight: 1.5,
                          background: '#fafafa',
                          padding: 12,
                          border: '1px solid #f0f0f0',
                          borderRadius: 4,
                        }}
                      >
                        {(sample.matchedFrames || []).slice(0, 12).map((frame, frameIndex) => (
                          `${frameIndex + 1}. [${frame.schema || 'stack'}:${frame.row || '-'}] ${frame.frame || ''}`
                        )).join('\n')}
                      </pre>
                    ) : (
                      <Text type="secondary">{sample.message || '未匹配到该卡顿时间点的调用栈。'}</Text>
                    )}
                  </Space>
                ),
              }))}
            />
          )}
        </Space>
      )}
    />
  );
}

type QualityPerformanceIssue = NonNullable<NonNullable<QualityPerformanceAnalysis['conclusion']>['issues']>[number];

function compactPageHints(text?: string[]) {
  const hints = Array.from(new Set((text || []).filter(Boolean))).slice(0, 6);
  return hints.length > 0 ? hints.join(' / ') : '';
}

function stackAnalysisStatusText(analysis: QualityPerformanceAnalysis) {
  const stackAnalysis = analysis.stackAnalysis;
  const severeCount = Number(analysis.stutter?.severeActionCount || 0);
  if (severeCount <= 0) return '';
  if (stackAnalysis?.available) {
    const matchedCount = (stackAnalysis.samples || []).filter((sample) => (sample.matchedFrames || []).length > 0).length;
    return `调用栈状态：已匹配 ${matchedCount || stackAnalysis.samples?.length || 0} 个严重卡顿样本，可在“卡顿调用栈”中查看热点堆栈。`;
  }
  if (stackAnalysis?.enabled) {
    return `调用栈状态：未匹配。${stackAnalysis.message || 'Trace 中没有找到严重卡顿时间点附近的 Time Profiler 调用栈。'}`;
  }
  return '调用栈状态：本次没有生成 Time Profiler 调用栈数据，需要重新执行开启性能采样的任务后定位。';
}

function renderPerformanceIssueDetail(issue: QualityPerformanceIssue, analysis: QualityPerformanceAnalysis, reportKind: QualityReportKind = 'generic') {
  const stutter = analysis.stutter;
  const isMonkeyReport = reportKind === 'monkey';
  if (issue.metric === 'stutter.severeActionCount') {
    const longestAction = stutter?.longestAction;
    const threshold = stutter?.thresholds?.actionSevereMs || 5000;
    const pageHint = compactPageHints(longestAction?.page?.summary?.text);
    return (
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Text strong>严重交互卡顿：{stutter?.severeActionCount || 0} 次，阈值 {threshold}ms</Text>
        {longestAction ? (
          <Text type="secondary">
            最长动作：#{longestAction.index || '-'} {eventTypeLabel(longestAction.type)}
            {longestAction.reason ? ` / ${longestAction.reason}` : ''}
            ，耗时 {longestAction.actionDurationMs ? formatMilliseconds(longestAction.actionDurationMs) : '-'}
            {longestAction.elapsedSeconds ? `，发生在 ${formatSeconds(Math.round(longestAction.elapsedSeconds))}` : ''}
          </Text>
        ) : (
          <Text type="secondary">{issue.message || '检测到严重交互卡顿，但缺少最长动作明细。'}</Text>
        )}
        {pageHint && <Text type="secondary">页面线索：{pageHint}</Text>}
        <Text type="secondary">{stackAnalysisStatusText(analysis)}</Text>
      </Space>
    );
  }

  if (issue.metric === 'stutter.stuckPageCount') {
    const stuckSamples = (stutter?.samples || []).slice(0, 4);
    return (
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Text strong>页面疑似停留不变：{stutter?.stuckPageCount || 0} 次</Text>
        <Text type="secondary">
          判定依据是{isMonkeyReport ? '连续 Monkey 动作后' : '连续检测样本中'}页面指纹变化很小，常见原因包括页面卡死、返回困难、弹窗遮挡、重复回到同一页面，或 WDA 响应变慢。
        </Text>
        {stuckSamples.length > 0 && (
          <Space direction="vertical" size={2}>
            {stuckSamples.map((sample, index) => {
              const pageHint = compactPageHints(sample.page?.summary?.text);
              return (
                <Text key={`${sample.index || index}-${sample.actionDurationMs || 0}`} type="secondary">
                  样本 {index + 1}：#{sample.index || '-'} {eventTypeLabel(sample.type)}
                  {sample.actionDurationMs ? `，动作 ${formatMilliseconds(sample.actionDurationMs)}` : ''}
                  {sample.elapsedSeconds ? `，${formatSeconds(Math.round(sample.elapsedSeconds))}` : ''}
                  {pageHint ? `，页面：${pageHint}` : ''}
                </Text>
              );
            })}
          </Space>
        )}
      </Space>
    );
  }

  if (issue.metric === 'stutter.targetAppRecoveryCount') {
    const recoveryCount = stutter?.targetAppRecoveryCount || 0;
    return (
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Text strong>被测 App 离开前台：{recoveryCount} 次</Text>
        <Text type="secondary">
          {isMonkeyReport ? 'Monkey 过程中' : '检测过程中'}检测到当前前台不是目标 Bundle，脚本已尝试重新拉起被测 App。出现这种情况时，需要优先确认是否被系统弹窗、返回手势、崩溃、Watchdog 或进程被杀触发。
        </Text>
      </Space>
    );
  }

  return (
    <Text type="secondary">
      {issue.message || issue.metric}
    </Text>
  );
}

function PerformanceAnalysisSummary({
  analysis,
  reportKind = 'generic',
}: {
  analysis?: QualityPerformanceAnalysis;
  reportKind?: QualityReportKind;
}) {
  const issues = (analysis?.conclusion?.issues || []).filter((issue) => {
    if (reportKind !== 'monkey') return true;
    return !/stutter|framestutter|fps|卡顿|帧/i.test(String(issue.metric || issue.message || ''));
  });
  const traceSegments = analysis?.trace?.segments || [];
  const displaySeverity = issues.some((issue) => issue.severity === 'failed') ? 'failed' : (issues.length > 0 ? 'warning' : 'passed');
  const severity = performanceSeverityMeta(displaySeverity, reportKind);
  const highlights = buildPerformanceHighlights(analysis, reportKind);
  const suggestions = buildPerformanceSuggestions(analysis, reportKind);
  if (!analysis) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次任务没有性能报告" />;
  }

  if (reportKind === 'monkey') {
    const hasBasicSamples = Number(analysis.samples?.sampleCount || 0) > 0 ||
      analysis.samples?.cpu?.avg !== undefined && analysis.samples.cpu.avg !== null ||
      analysis.samples?.memoryMB?.avg !== undefined && analysis.samples.memoryMB.avg !== null;
    const summaryText = issues[0]?.message || (
      hasBasicSamples
        ? performanceSeverityMeta(displaySeverity, reportKind).summary
        : (analysis.trace?.available
          ? 'Monkey 执行已通过，Trace 已留存；当前缺少 CPU / 内存采样明细，无法生成基础趋势。'
          : 'Monkey 执行已通过，当前没有可用于基础趋势分析的 CPU / 内存采样。')
    );
    return (
      <Alert
        showIcon
        type={severity.alertType}
        message={`结论：${severity.label}`}
        description={(
          <Space direction="vertical" size={6}>
            <Text type="secondary">{summaryText}</Text>
            {highlights.length > 0 && (
              <Space wrap>
                {highlights.slice(0, 6).map((item) => <Tag key={item}>{item}</Tag>)}
              </Space>
            )}
          </Space>
        )}
      />
    );
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        showIcon
        type={severity.alertType}
        message={`性能结论：${severity.label}`}
        description={(
          <Space direction="vertical" size={6}>
            <Text type="secondary">{issues[0]?.message || performanceSeverityMeta(displaySeverity, reportKind).summary}</Text>
            {highlights.length > 0 && (
              <Space wrap>
                {highlights.map((item) => <Tag key={item}>{item}</Tag>)}
              </Space>
            )}
          </Space>
        )}
      />
      <PerformanceDataCoverage analysis={analysis} reportKind={reportKind} />
      <PerformanceStackAnalysis analysis={analysis} />
      {issues.length > 0 ? (
        <Alert
          showIcon
          type="warning"
          message="已识别风险"
          description={(
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {issues.map((issue, index) => (
                <div key={`${issue.metric || 'metric'}-${index}`}>
                  {renderPerformanceIssueDetail(issue, analysis, reportKind)}
                </div>
              ))}
            </Space>
          )}
        />
      ) : (
        analysis?.conclusion?.severity && <Alert showIcon type="success" message="未发现阈值类性能风险" />
      )}
      <Alert
        showIcon
        type="info"
        message="建议动作"
        description={(
          <Space direction="vertical" size={4}>
            {suggestions.map((item, index) => (
              <Text key={index} type="secondary">{index + 1}. {item}</Text>
            ))}
          </Space>
        )}
      />
      {analysis.trace?.available && !analysis.samples?.sampleCount && (
        <Alert
          showIcon
          type="info"
          message="Trace 已采集，未导出可绘制采样"
          description={(
            <Space direction="vertical" size={4}>
              <Text type="secondary">
                {[
                  analysis.trace.templateName ? `模板 ${analysis.trace.templateName}` : '',
                  analysis.trace.durationSeconds ? `采集 ${formatSeconds(Math.round(analysis.trace.durationSeconds))}` : '',
                  analysis.trace.segmentCount && analysis.trace.segmentCount > 1 ? `分段 ${analysis.trace.segmentCount} 段` : '',
                  analysis.trace.endReason ? `结束原因 ${analysis.trace.endReason}` : '',
                  analysis.trace.terminationReason ? `进程 ${analysis.trace.terminationReason}` : '',
                ].filter(Boolean).join('，') || 'xctrace 只导出了 Trace 文件，未生成 CPU / 内存明细行。'}
              </Text>
            </Space>
          )}
        />
      )}
      {traceSegments.length > 0 && (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Text strong>Trace 分段</Text>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {traceSegments.map((segment, index) => (
              <Space key={`${segment.path || segment.name || index}`} size={8} wrap>
                <Tag color={segment.current ? 'blue' : 'default'}>{segment.current ? '当前' : `分段 ${index + 1}`}</Tag>
                <Text code>{segment.path || segment.name || '-'}</Text>
                {segment.reason && <Text type="secondary">{segment.reason}</Text>}
                {segment.finishedAt && <Text type="secondary">{segment.finishedAt}</Text>}
              </Space>
            ))}
          </Space>
        </Space>
      )}
    </Space>
  );
}

function StutterReportSummary({
  analysis,
}: {
  analysis?: QualityPerformanceAnalysis;
}) {
  if (!analysis) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次任务没有卡顿报告" />;
  }
  const stutter = analysis.stutter;
  const frameStutter = analysis.frameStutter;
  const stackAnalysis = analysis.stackAnalysis;
  const slowActionCount = Number(stutter?.slowActionCount || 0);
  const severeActionCount = Number(stutter?.severeActionCount || 0);
  const stuckPageCount = Number(stutter?.stuckPageCount || 0);
  const frameHitchCount = Number(frameStutter?.hitchCount || 0);
  const severeFrameHitchCount = Number(frameStutter?.severeHitchCount || 0);
  const hasStackFrames = !!stackAnalysis?.samples?.some((sample) => (sample.matchedFrames || []).length > 0);
  const hasAnyStutter = slowActionCount > 0 || frameHitchCount > 0 || stuckPageCount > 0;
  const hasSevereStutter = severeActionCount > 0 || severeFrameHitchCount > 0;
  const alertType = hasSevereStutter ? 'error' : (hasAnyStutter ? 'warning' : 'success');
  const alertTitle = hasSevereStutter ? '发现严重卡顿' : (hasAnyStutter ? '发现卡顿风险' : '未发现卡顿问题');
  const issues = (analysis.conclusion?.issues || []).filter((issue) => /stutter|hitch|卡顿|fps|frame/i.test(String(issue.metric || issue.message || '')));
  const stutterSamples = stutter?.samples || [];
  const frameSamples = frameStutter?.samples || [];
  const traceSegments = analysis.trace?.segments || [];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        showIcon
        type={alertType}
        message={`卡顿结论：${alertTitle}`}
        description={(
          <Space wrap>
            <Tag color={stutter?.enabled ? 'green' : 'gold'}>动作卡顿 {stutter?.enabled ? '已检测' : '未检测'}</Tag>
            <Tag color={frameStutter?.available ? 'green' : 'gold'}>帧级卡顿 {frameStutter?.available ? '已解析' : '未解析'}</Tag>
            <Tag color={hasStackFrames ? 'green' : 'gold'}>调用栈 {hasStackFrames ? '已匹配' : '未匹配'}</Tag>
            {analysis.trace?.available && <Tag color="blue">Trace 已采集</Tag>}
          </Space>
        )}
      />
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
        <Descriptions.Item label="交互卡顿">
          {stutter?.enabled ? `${slowActionCount} 次 / 严重 ${severeActionCount} 次` : '未检测'}
        </Descriptions.Item>
        <Descriptions.Item label="最长交互卡顿">
          {stutter?.longestAction?.actionDurationMs
            ? `${formatMilliseconds(stutter.longestAction.actionDurationMs)} / #${stutter.longestAction.index || '-'} ${eventTypeLabel(stutter.longestAction.type)}`
            : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="页面疑似卡住">
          {stutter?.enabled ? `${stuckPageCount} 次` : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="帧级卡顿">
          {frameStutter?.available ? `${frameHitchCount} 次 / 严重 ${severeFrameHitchCount} 次` : '未解析'}
        </Descriptions.Item>
        <Descriptions.Item label="最长帧级卡顿">
          {frameStutter?.longestHitch?.durationMs
            ? `${formatMilliseconds(frameStutter.longestHitch.durationMs)}${frameStutter.longestHitch.timeSeconds ? ` / ${formatSeconds(Math.round(frameStutter.longestHitch.timeSeconds))}` : ''}`
            : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="调用栈">
          {hasStackFrames ? '已匹配' : (stackAnalysis?.enabled ? '未匹配' : '未生成')}
        </Descriptions.Item>
      </Descriptions>
      {issues.length > 0 ? (
        <Alert
          showIcon
          type="warning"
          message="已识别卡顿问题"
          description={(
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {issues.map((issue, index) => (
                <div key={`${issue.metric || 'metric'}-${index}`}>
                  {renderPerformanceIssueDetail(issue, analysis, 'stutter')}
                </div>
              ))}
            </Space>
          )}
        />
      ) : (
        <Alert showIcon type="success" message="未发现阈值类卡顿问题" />
      )}
      {stutterSamples.length > 0 && (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Text strong>交互卡顿样本</Text>
          <Collapse
            size="small"
            items={stutterSamples.slice(0, 8).map((sample, index) => ({
              key: `${sample.index || index}-${sample.actionDurationMs || 0}`,
              label: `#${sample.index || '-'} ${eventTypeLabel(sample.type)} ${sample.actionDurationMs || '-'}ms${sample.reason ? ` / ${sample.reason}` : ''}`,
              children: (
                <Space direction="vertical" size={4}>
                  {sample.elapsedSeconds !== undefined && <Text type="secondary">发生时间：{formatSeconds(Math.round(sample.elapsedSeconds))}</Text>}
                  {sample.page?.summary?.text?.length ? (
                    <Text type="secondary">页面线索：{sample.page.summary.text.slice(0, 8).join(' / ')}</Text>
                  ) : (
                    <Text type="secondary">暂无页面线索</Text>
                  )}
                </Space>
              ),
            }))}
          />
        </Space>
      )}
      {frameSamples.length > 0 && (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Text strong>帧级卡顿样本</Text>
          <Space wrap>
            {frameSamples.slice(0, 8).map((sample, index) => (
              <Tag key={`${sample.row || index}-${sample.durationMs || 0}`} color={sample.severity === 'severe' ? 'red' : 'orange'}>
                {sample.durationMs || '-'}ms{sample.timeSeconds ? ` / ${formatSeconds(Math.round(sample.timeSeconds))}` : ''}
              </Tag>
            ))}
          </Space>
        </Space>
      )}
      <PerformanceStackAnalysis analysis={analysis} />
      {!frameStutter?.available && (
        <Alert
          showIcon
          type="info"
          message="帧级卡顿未解析"
          description={frameStutter?.message || '本次没有导出可解析的帧级卡顿数据，可下载 Trace 用 Instruments 继续查看。'}
        />
      )}
      {traceSegments.length > 0 && (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Text strong>Trace 证据</Text>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {traceSegments.map((segment, index) => (
              <Space key={`${segment.path || segment.name || index}`} size={8} wrap>
                <Tag color={segment.current ? 'blue' : 'default'}>{segment.current ? '当前' : `分段 ${index + 1}`}</Tag>
                <Text code>{segment.path || segment.name || '-'}</Text>
                {segment.reason && <Text type="secondary">{segment.reason}</Text>}
              </Space>
            ))}
          </Space>
        </Space>
      )}
      <Alert
        showIcon
        type="info"
        message="建议动作"
        description={hasAnyStutter
          ? '优先查看严重卡顿样本、页面线索和调用栈；如果调用栈未匹配，下载 Trace 用 Instruments 定位主线程阻塞或渲染耗时。'
          : '本次未触发卡顿阈值，可作为该场景的卡顿基线；如果现场仍感知卡顿，建议切换到自动场景或延长检测时长重跑。'}
      />
    </Space>
  );
}

function PerformanceDiagnostics({
  samples,
  analysis,
  loading = false,
  reportKind = 'generic',
}: {
  samples: JenkinsQualityPerformanceSamples | null;
  analysis?: QualityPerformanceAnalysis;
  loading?: boolean;
  reportKind?: QualityReportKind;
}) {
  const isMonkeyReport = reportKind === 'monkey';
  if (!samples?.samples?.length) {
    const summarySamples = analysis?.samples;
    const hasSummarySamples = !!summarySamples && (
      Number(summarySamples.sampleCount || 0) > 0 ||
      (summarySamples.cpu?.avg !== undefined && summarySamples.cpu.avg !== null) ||
      (summarySamples.memoryMB?.avg !== undefined && summarySamples.memoryMB.avg !== null)
    );
    if (isMonkeyReport && hasSummarySamples) {
      return (
        <Alert
          showIcon
          type="info"
          message="性能观察"
          description={(
            <Space direction="vertical" size={6}>
              <Text type="secondary">
                已读取性能汇总：{[
                  summarySamples?.sampleCount !== undefined ? `采样 ${summarySamples.sampleCount} 条` : '',
                  summarySamples?.cpu?.avg !== undefined && summarySamples.cpu.avg !== null ? `CPU 平均 ${summarySamples.cpu.avg}% / 峰值 ${metricText(summarySamples.cpu.max, '%')}` : '',
                  summarySamples?.memoryMB?.avg !== undefined && summarySamples.memoryMB.avg !== null ? `内存平均 ${summarySamples.memoryMB.avg}MB / 峰值 ${metricText(summarySamples.memoryMB.max, 'MB')}` : '',
                ].filter(Boolean).join('，') || '已有汇总数据'}
              </Text>
              {loading && <Text type="secondary">采样明细和图表正在加载，加载完成后会自动补充趋势分析。</Text>}
            </Space>
          )}
        />
      );
    }
    if (analysis?.trace?.available) {
      return (
        <Alert
          showIcon
          type="info"
          message={isMonkeyReport ? 'Trace 已采集，CPU / 内存采样缺失' : 'Trace 已采集，采样明细缺失'}
          description={(
            <Space direction="vertical" size={4}>
              <Text type="secondary">
                {[
                  analysis.trace.templateName ? `Trace 模板：${analysis.trace.templateName}` : '',
                  analysis.trace.durationSeconds ? `采集时长：${formatSeconds(Math.round(analysis.trace.durationSeconds))}` : '',
                  analysis.trace.segmentCount && analysis.trace.segmentCount > 1 ? `Trace 分段：${analysis.trace.segmentCount} 段` : '',
                  analysis.trace.endReason ? `结束原因：${analysis.trace.endReason}` : '',
                ].filter(Boolean).join('；') || 'xctrace 文件已生成。'}
              </Text>
              <Text type="secondary">
                {isMonkeyReport
                  ? 'Monkey 测试不需要 FPS/帧级卡顿数据；当前只是缺少 CPU / 内存采样明细，所以无法生成基础趋势图。'
                  : '当前缺少可解析的采样明细，所以无法生成趋势图。'}
              </Text>
            </Space>
          )}
        />
      );
    }
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={isMonkeyReport ? '暂无 CPU / 内存采样，无法生成基础趋势诊断' : '暂无性能采样，无法生成诊断'} />;
  }

  const includeStutterMetrics = !isMonkeyReport;
  const validCpuSamples = samples.samples.filter((sample) => sample.cpu !== null);
  const validMemorySamples = samples.samples.filter((sample) => sample.memoryMB !== null);
  const validFpsSamples = samples.samples.filter((sample) => sample.fps !== null);
  const hasFpsSamples = includeStutterMetrics && validFpsSamples.length > 0;
  const maxCpuSample = validCpuSamples.reduce<typeof validCpuSamples[number] | null>(
    (max, sample) => (!max || Number(sample.cpu) > Number(max.cpu) ? sample : max),
    null
  );
  const maxMemorySample = validMemorySamples.reduce<typeof validMemorySamples[number] | null>(
    (max, sample) => (!max || Number(sample.memoryMB) > Number(max.memoryMB) ? sample : max),
    null
  );
  const minFpsSample = validFpsSamples.reduce<typeof validFpsSamples[number] | null>(
    (min, sample) => (!min || Number(sample.fps) < Number(min.fps) ? sample : min),
    null
  );
  const firstMemory = validMemorySamples[0]?.memoryMB ?? null;
  const lastMemory = validMemorySamples.at(-1)?.memoryMB ?? null;
  const memoryDelta = firstMemory !== null && lastMemory !== null ? Number((lastMemory - firstMemory).toFixed(1)) : null;
  let biggestMemoryJump: { from: number; to: number; delta: number; index: number; timeSeconds: number } | null = null;
  for (let index = 1; index < validMemorySamples.length; index += 1) {
    const previous = validMemorySamples[index - 1];
    const current = validMemorySamples[index];
    if (previous.memoryMB === null || current.memoryMB === null) continue;
    const delta = Number((current.memoryMB - previous.memoryMB).toFixed(1));
    if (!biggestMemoryJump || delta > biggestMemoryJump.delta) {
      biggestMemoryJump = {
        from: previous.memoryMB,
        to: current.memoryMB,
        delta,
        index: current.index,
        timeSeconds: current.timeSeconds,
      };
    }
  }
  const highCpuSamples = validCpuSamples.filter((sample) => Number(sample.cpu) >= 70);
  let longestHighCpuRun = 0;
  let currentHighCpuRun = 0;
  for (const sample of validCpuSamples) {
    if (Number(sample.cpu) >= 70) {
      currentHighCpuRun += 1;
      longestHighCpuRun = Math.max(longestHighCpuRun, currentHighCpuRun);
    } else {
      currentHighCpuRun = 0;
    }
  }
  const cpuAvg = samples.summary.cpu.avg;
  const cpuMax = samples.summary.cpu.max;
  const memoryAvg = samples.summary.memoryMB.avg;
  const memoryMax = samples.summary.memoryMB.max;
  const fpsAvg = samples.summary.fps.avg;
  const fpsMin = samples.summary.fps.min;
  const stutter = analysis?.stutter;
  const frameStutter = analysis?.frameStutter;
  const hasInteractionStutter = !!stutter?.enabled;
  const hasFrameStutter = !!frameStutter?.available;
  const slowActionCount = Number(stutter?.slowActionCount || 0);
  const severeActionCount = Number(stutter?.severeActionCount || 0);
  const stuckPageCount = Number(stutter?.stuckPageCount || 0);
  const wdaRecoveryCount = Number(stutter?.wdaRecoveryCount || 0);
  const longestAction = stutter?.longestAction;
  const frameHitchCount = Number(frameStutter?.hitchCount || 0);
  const severeFrameHitchCount = Number(frameStutter?.severeHitchCount || 0);
  const longestFrameHitch = frameStutter?.longestHitch;
  const memoryAttention = memoryDelta !== null && memoryDelta >= 15;
  const jumpAttention = !!biggestMemoryJump && biggestMemoryJump.delta >= 8;
  const cpuAttention = !!maxCpuSample && Number(maxCpuSample.cpu) >= 80;
  const fpsAttention = includeStutterMetrics && !!minFpsSample && Number(minFpsSample.fps) > 0 && Number(minFpsSample.fps) < 45;
  const sampleDurationSeconds = samples.samples.length > 0
    ? Math.max(...samples.samples.map((sample) => Number(sample.timeSeconds || 0)))
    : 0;
  const attentionItems = [
    memoryAttention ? `内存从 ${firstMemory}MB 增长到 ${lastMemory}MB，净增长 ${memoryDelta}MB，建议确认是否进入高资源页面后未回收。` : '',
    jumpAttention && biggestMemoryJump ? `#${biggestMemoryJump.index} 附近内存单次上升 ${biggestMemoryJump.delta}MB，是最明显的资源切换点。` : '',
    cpuAttention && maxCpuSample ? `CPU 在 #${maxCpuSample.index} 达到 ${maxCpuSample.cpu}%，可结合附近动作判断是否触发重渲染、页面初始化或密集计算。` : '',
    highCpuSamples.length >= 3 ? `CPU >= 70% 的采样有 ${highCpuSamples.length} 条，建议关注是否存在连续高负载。` : '',
    fpsAttention && minFpsSample ? `FPS 最低 ${minFpsSample.fps}，可检查该采样附近是否有卡顿动作。` : '',
    includeStutterMetrics && slowActionCount > 0 ? `检测到 ${slowActionCount} 次交互卡顿，其中严重 ${severeActionCount} 次，最长动作耗时 ${longestAction?.actionDurationMs || '-'}ms。` : '',
    includeStutterMetrics && frameHitchCount > 0 ? `检测到 ${frameHitchCount} 次帧级卡顿，其中严重 ${severeFrameHitchCount} 次，最长帧耗时 ${longestFrameHitch?.durationMs || '-'}ms。` : '',
    includeStutterMetrics && stuckPageCount > 0 ? `检测到 ${stuckPageCount} 次页面疑似停留不变，可能是页面卡住、弹层拦截或回退困难。` : '',
    includeStutterMetrics && wdaRecoveryCount > 0 ? `WDA 恢复 ${wdaRecoveryCount} 次，会影响自动化响应耗时，需和真实 App 卡顿区分。` : '',
  ].filter(Boolean);
  const likelyReasons = [
    cpuAttention ? 'CPU 峰值通常和页面初始化、列表批量渲染、图片解码、日志密集输出或音视频处理有关。' : '',
    memoryAttention ? '内存持续增长更像资源未释放；如果只在页面切换后短暂上涨，可能是缓存或新页面资源加载。' : '',
    jumpAttention ? '内存阶跃更适合结合动作定位：关注跳转、打开房间、进入聊天、加载媒体等资源密集场景。' : '',
    longestHighCpuRun >= 3 ? `CPU 连续高位最长 ${longestHighCpuRun} 个采样点，若采样间隔约 1 秒，则可能存在持续负载而不是瞬时尖峰。` : '',
    fpsAttention ? 'FPS 低点需要结合主线程耗时和页面动作确认，单独看 FPS 不能直接判断根因。' : '',
    includeStutterMetrics && frameHitchCount > 0 ? '帧级卡顿来自 xctrace 的帧/Animation Hitches 明细，比 Monkey 动作耗时更接近真实渲染卡顿。' : '',
    includeStutterMetrics && slowActionCount > 0 ? '交互卡顿基于自动化动作响应耗时，可能来自 App 主线程忙、页面动画过长、网络等待、WDA/USB 抖动或系统弹窗。' : '',
  ].filter(Boolean);
  const diagnosisLevel = attentionItems.length >= 3 ? '高关注' : (attentionItems.length > 0 ? '需观察' : '正常');
  const diagnosisType = attentionItems.length >= 3 ? 'warning' : (attentionItems.length > 0 ? 'info' : 'success');

  if (isMonkeyReport) {
    const hasFocus = attentionItems.length > 0;
    const focusDescription = hasFocus
      ? attentionItems.slice(0, 3).join(' ')
      : '本次 Monkey 只保留 CPU、内存作为基础性能证据；卡顿和帧率请使用卡顿检测任务查看。';
    const reasonText = likelyReasons.slice(0, 2).join(' ');
    return (
      <Alert
        showIcon
        type={hasFocus ? 'warning' : 'success'}
        message="性能观察"
        description={(
          <Space direction="vertical" size={4}>
            <Text type="secondary">{focusDescription}</Text>
            {reasonText && <Text type="secondary">判断依据：{reasonText}</Text>}
          </Space>
        )}
      />
    );
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        showIcon
        type={diagnosisType}
        message={`诊断结论：${diagnosisLevel}`}
        description={attentionItems.length > 0
          ? '本次诊断已提取性能变化点，可优先查看下方峰值、阶跃、卡顿样本和 Trace 线索。'
          : `CPU、内存${includeStutterMetrics && hasFpsSamples ? '、FPS' : ''}${includeStutterMetrics && hasFrameStutter ? '、帧级卡顿' : ''}${includeStutterMetrics && hasInteractionStutter ? '、交互卡顿' : ''}没有明显异常趋势，本次可作为同版本后续对比的基线。`}
      />
      {attentionItems.length > 0 ? (
        <Alert
          showIcon
          type="warning"
          message="发现可关注的性能变化"
          description={(
            <Space direction="vertical" size={4}>
              {attentionItems.map((item, index) => (
                <Text key={index} type="secondary">{item}</Text>
              ))}
            </Space>
          )}
        />
      ) : (
        <Alert showIcon type="success" message="未发现明显的性能异常趋势" />
      )}
      {likelyReasons.length > 0 && (
        <Alert
          showIcon
          type="info"
          message="可能原因"
          description={(
            <Space direction="vertical" size={4}>
              {likelyReasons.map((item, index) => (
                <Text key={index} type="secondary">{item}</Text>
              ))}
            </Space>
          )}
        />
      )}
      {includeStutterMetrics && !hasFpsSamples && (
        <Alert
          showIcon
          type="info"
          message="FPS / 帧级卡顿数据未采集"
          description={hasFrameStutter
            ? '本次没有 FPS 指标，但已从 xctrace 帧级表解析卡顿区间。'
            : (frameStutter?.message || '本次样本没有 FPS 或帧耗时字段，因此不能判断掉帧和帧级卡顿区间。')}
        />
      )}
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
        <Descriptions.Item label="采样覆盖">
          {samples.sampleCount} 条 / {sampleDurationSeconds ? formatSeconds(Math.round(sampleDurationSeconds)) : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="CPU 平均/峰值">
          {metricText(cpuAvg, '%')} / {metricText(cpuMax, '%')}
        </Descriptions.Item>
        <Descriptions.Item label="CPU 峰值">
          {maxCpuSample ? `${maxCpuSample.cpu}% / #${maxCpuSample.index} / ${Math.round(maxCpuSample.timeSeconds)}s` : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="内存平均/峰值">
          {metricText(memoryAvg, 'MB')} / {metricText(memoryMax, 'MB')}
        </Descriptions.Item>
        <Descriptions.Item label="内存峰值">
          {maxMemorySample ? `${maxMemorySample.memoryMB}MB / #${maxMemorySample.index}` : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="内存净增长">
          {memoryDelta !== null ? `${memoryDelta > 0 ? '+' : ''}${memoryDelta}MB` : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="最大内存阶跃">
          {biggestMemoryJump ? `+${biggestMemoryJump.delta}MB / #${biggestMemoryJump.index}` : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="高 CPU 采样">
          {highCpuSamples.length} 条{longestHighCpuRun ? ` / 最长连续 ${longestHighCpuRun} 条` : ''}
        </Descriptions.Item>
        {includeStutterMetrics && (
          <>
            <Descriptions.Item label="FPS 平均/最低">
              {hasFpsSamples ? `${metricText(fpsAvg)} / ${metricText(fpsMin)}` : '未采集'}
            </Descriptions.Item>
            <Descriptions.Item label="FPS 低点">
              {minFpsSample?.fps !== null && minFpsSample?.fps !== undefined ? `${minFpsSample.fps} / #${minFpsSample.index}` : '未采集'}
            </Descriptions.Item>
            <Descriptions.Item label="卡顿判断">
              {hasFrameStutter
                ? `${frameHitchCount} 次帧级卡顿 / 严重 ${severeFrameHitchCount} 次`
                : (hasInteractionStutter ? `${slowActionCount} 次交互卡顿 / 严重 ${severeActionCount} 次` : (hasFpsSamples ? '可按 FPS 低点辅助判断' : '未接入'))}
            </Descriptions.Item>
            <Descriptions.Item label="最长帧级卡顿">
              {longestFrameHitch?.durationMs ? `${longestFrameHitch.durationMs}ms${longestFrameHitch.timeSeconds ? ` / ${Math.round(longestFrameHitch.timeSeconds)}s` : ''}` : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="最长卡顿">
              {longestAction?.actionDurationMs ? `${longestAction.actionDurationMs}ms / #${longestAction.index || '-'} ${eventTypeLabel(longestAction.type)}` : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="页面疑似卡住">
              {hasInteractionStutter ? `${stuckPageCount} 次` : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="WDA 恢复">
              {hasInteractionStutter ? `${wdaRecoveryCount} 次` : '-'}
            </Descriptions.Item>
          </>
        )}
      </Descriptions>
      {includeStutterMetrics && frameStutter?.samples?.length ? (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Text strong>帧级卡顿样本</Text>
          <Space wrap>
            {frameStutter.samples.slice(0, 6).map((item, index) => (
              <Tag key={`${item.row || index}-${item.durationMs || 0}`} color={item.severity === 'severe' ? 'red' : 'orange'}>
                {item.durationMs || '-'}ms{item.timeSeconds ? ` / ${Math.round(item.timeSeconds)}s` : ''}
              </Tag>
            ))}
          </Space>
        </Space>
      ) : null}
      {includeStutterMetrics && stutter?.samples?.length ? (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Text strong>卡顿样本</Text>
          <Space wrap>
            {stutter.samples.slice(0, 6).map((item, index) => (
              <Tag key={`${item.index || index}-${item.actionDurationMs || 0}`} color={Number(item.actionDurationMs || 0) >= Number(stutter.thresholds?.actionSevereMs || 5000) ? 'red' : 'orange'}>
                #{item.index || '-'} {eventTypeLabel(item.type)} {item.actionDurationMs || '-'}ms
              </Tag>
            ))}
          </Space>
        </Space>
      ) : null}
    </Space>
  );
}

function PerformanceSamplesChart({ data, reportKind = 'generic' }: { data: JenkinsQualityPerformanceSamples; reportKind?: QualityReportKind }) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const includeFps = reportKind !== 'monkey';
  const hasMetric = data.samples.some((sample) => sample.cpu !== null || sample.memoryMB !== null || (includeFps && sample.fps !== null));
  const validCpuSamples = data.samples.filter((sample) => sample.cpu !== null);
  const validMemorySamples = data.samples.filter((sample) => sample.memoryMB !== null);
  const validFpsSamples = data.samples.filter((sample) => sample.fps !== null);
  const hasCpuSamples = validCpuSamples.length > 0;
  const hasMemorySamples = validMemorySamples.length > 0;
  const hasFpsSamples = includeFps && validFpsSamples.length > 0;
  const maxCpuSample = validCpuSamples.reduce<typeof validCpuSamples[number] | null>(
    (max, sample) => (!max || Number(sample.cpu) > Number(max.cpu) ? sample : max),
    null
  );
  const maxMemorySample = validMemorySamples.reduce<typeof validMemorySamples[number] | null>(
    (max, sample) => (!max || Number(sample.memoryMB) > Number(max.memoryMB) ? sample : max),
    null
  );
  const minFpsSample = validFpsSamples.reduce<typeof validFpsSamples[number] | null>(
    (min, sample) => (!min || Number(sample.fps) < Number(min.fps) ? sample : min),
    null
  );

  useEffect(() => {
    if (!chartRef.current || !hasMetric) return;
    const chart = echarts.init(chartRef.current);
    const labels = data.samples.map((sample) => `${Math.round(sample.timeSeconds || 0)}s`);
    const sampleLabel = (sample?: JenkinsQualityPerformanceSamples['samples'][number] | null) => {
      if (!sample) return '';
      const position = data.samples.findIndex((item) => item.index === sample.index);
      return labels[position >= 0 ? position : 0] || '';
    };
    const markPointStyle = {
      symbolSize: 48,
      label: { fontSize: 10 },
    };
    const legendItems = [
      hasCpuSamples ? 'CPU %' : '',
      hasMemorySamples ? '内存 MB' : '',
      includeFps && hasFpsSamples ? 'FPS' : '',
    ].filter(Boolean);
    const series: echarts.EChartsOption['series'] = [
      hasCpuSamples ? {
        name: 'CPU %',
        type: 'line',
        showSymbol: false,
        connectNulls: true,
        data: data.samples.map((sample) => sample.cpu),
        markPoint: maxCpuSample ? {
          ...markPointStyle,
          data: [{ name: 'CPU 峰值', coord: [sampleLabel(maxCpuSample), Number(maxCpuSample.cpu)], value: Number(maxCpuSample.cpu) }],
        } : undefined,
      } : null,
      hasMemorySamples ? {
        name: '内存 MB',
        type: 'line',
        showSymbol: false,
        connectNulls: true,
        yAxisIndex: 1,
        data: data.samples.map((sample) => sample.memoryMB),
        markPoint: maxMemorySample ? {
          ...markPointStyle,
          data: [{ name: '内存峰值', coord: [sampleLabel(maxMemorySample), Number(maxMemorySample.memoryMB)], value: Number(maxMemorySample.memoryMB) }],
        } : undefined,
      } : null,
      includeFps && hasFpsSamples ? {
        name: 'FPS',
        type: 'line',
        showSymbol: false,
        connectNulls: true,
        data: data.samples.map((sample) => sample.fps),
        markPoint: minFpsSample ? {
          ...markPointStyle,
          data: [{ name: 'FPS 低点', coord: [sampleLabel(minFpsSample), Number(minFpsSample.fps)], value: Number(minFpsSample.fps) }],
        } : undefined,
      } : null,
    ].filter(Boolean) as echarts.EChartsOption['series'];
    const option: echarts.EChartsOption = {
      color: ['#1677ff', '#52c41a', '#fa8c16'],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params: any) => {
          const list = Array.isArray(params) ? params : [params];
          const first = list[0];
          const sample = data.samples[first?.dataIndex || 0];
          const lines = [
            `时间：${formatSeconds(Math.round(sample?.timeSeconds || 0))} / 样本 #${sample?.index ?? '-'}`,
            ...list.map((item: any) => `${item.marker || ''}${item.seriesName}: ${item.value === null || item.value === undefined ? '-' : item.value}`),
          ];
          return lines.join('<br/>');
        },
      },
      legend: {
        top: 0,
        data: legendItems,
      },
      grid: {
        top: 48,
        left: 48,
        right: 56,
        bottom: 40,
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: labels,
        axisLabel: {
          formatter: (value: string) => value,
        },
      },
      yAxis: [
        {
          type: 'value',
          name: includeFps ? 'CPU/FPS' : 'CPU',
          min: 0,
          axisLabel: { formatter: '{value}' },
        },
        {
          type: 'value',
          name: '内存 MB',
          min: 0,
          position: 'right',
          axisLabel: { formatter: '{value}' },
        },
      ],
      dataZoom: [
        { type: 'inside' },
        { type: 'slider', height: 18, bottom: 8 },
      ],
      series,
    };
    chart.setOption(option);
    const resize = () => chart.resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      chart.dispose();
    };
  }, [data, hasMetric, hasCpuSamples, hasMemorySamples, hasFpsSamples, includeFps, maxCpuSample, maxMemorySample, minFpsSample]);

  if (!data.sampleCount || !hasMetric) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未采集到性能样本" />;
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      {reportKind !== 'monkey' && (
        <>
          <Space wrap>
            <Tag>采样 {data.sampleCount} 条</Tag>
            {data.samples.length > 0 && <Tag>覆盖 {formatSeconds(Math.round(Math.max(...data.samples.map((sample) => sample.timeSeconds || 0))))}</Tag>}
            {data.summary.cpu.avg !== null && <Tag>CPU 平均 {data.summary.cpu.avg}% / 峰值 {data.summary.cpu.max ?? '-'}%</Tag>}
            {data.summary.memoryMB.avg !== null && <Tag>内存平均 {data.summary.memoryMB.avg}MB / 峰值 {data.summary.memoryMB.max ?? '-'}MB</Tag>}
            {includeFps && data.summary.fps.avg !== null && <Tag>FPS 平均 {data.summary.fps.avg} / 最低 {data.summary.fps.min ?? '-'}</Tag>}
            {includeFps && data.summary.fps.avg === null && <Tag color="gold">FPS 未采集</Tag>}
            {includeFps && <Tag color="gold">帧级卡顿未采集</Tag>}
            {(data.truncated || data.sourceTruncated) && <Tag color="orange">已截断</Tag>}
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            横轴为采样时间，图中标记已采集指标的峰值；可拖动底部滑块放大某段执行过程。
          </Text>
        </>
      )}
      <div ref={chartRef} style={{ width: '100%', height: 360 }} />
    </Space>
  );
}

function tailLines(content: string, maxLines = 80) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  return lines.slice(-maxLines).join('\n');
}

function normalizeUUID(uuid?: string) {
  return (uuid || '').trim().toUpperCase();
}

function parseCrashJsonHeader(content: string): Record<string, any> {
  const firstLine = content.split(/\r?\n/).find((line) => line.trim().startsWith('{'))?.trim();
  if (!firstLine) return {};
  try {
    return JSON.parse(firstLine);
  } catch {
    return {};
  }
}

function extractCrashField(content: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim();
}

function extractCrashVersion(content: string) {
  const header = parseCrashJsonHeader(content);
  const version = header.app_version || header.bundleVersion || header.bundleShortVersion;
  if (version) return String(version).trim();
  const versionLine = extractCrashField(content, 'Version');
  return versionLine?.match(/^([^\s(]+)/)?.[1]?.trim() || '';
}

function extractCrashMetadata(content: string) {
  const header = parseCrashJsonHeader(content);
  return {
    appName: String(header.app_name || header.procName || extractCrashField(content, 'Command') || extractCrashField(content, 'Process') || '').trim(),
    version: extractCrashVersion(content),
    buildVersion: String(header.build_version || header.bundleShortVersion || '').trim(),
    bundleId: String(header.bundleID || extractCrashField(content, 'Identifier') || '').trim(),
    incidentId: String(header.incident_id || header.incidentID || extractCrashField(content, 'Incident Identifier') || '').trim(),
    sliceUUID: normalizeUUID(header.slice_uuid || header.uuid || ''),
    exceptionType: extractCrashField(content, 'Exception Type') || '',
    terminationReason: extractCrashField(content, 'Termination Reason') || '',
  };
}

function extractResourceStackBinaries(content: string) {
  if (!/Heaviest stack for the target process:/i.test(content)) return [];
  const binaries = new Set<string>();
  for (const match of content.matchAll(/^\s*\d+\s+\S+\s+\(([^+()]+)\s+\+\s+\d+\)\s+\[0x[0-9a-f]+\]/gim)) {
    const binaryName = match[1]?.trim();
    if (binaryName && !['dyld'].includes(binaryName)) {
      binaries.add(binaryName.toUpperCase());
    }
  }
  return Array.from(binaries);
}

function selectCrashDsymUUIDs(content: string, dsyms: DSYMInfo[]) {
  const metadata = extractCrashMetadata(content);
  const stackBinaries = extractResourceStackBinaries(content);
  const appearsInResourceStack = (dsym: DSYMInfo) => (
    stackBinaries.length === 0 || stackBinaries.includes(dsym.appName.replace(/\.app$/i, '').toUpperCase())
  );
  const exactUUID = metadata.sliceUUID;
  const exactMatch = exactUUID ? dsyms.find((dsym) => normalizeUUID(dsym.uuid) === exactUUID) : undefined;
  if (exactMatch) {
    return { uuids: [exactMatch.uuid], metadata, matchType: 'uuid' as const };
  }

  if (!metadata.version) {
    return { uuids: [] as string[], metadata, matchType: 'none' as const };
  }

  const mainApp = dsyms.find((dsym) => dsym.appName.toUpperCase() === 'NNIM' && dsym.version.trim() === metadata.version && appearsInResourceStack(dsym));
  const relatedComponents = dsyms.filter((dsym) => (
    dsym.appName.toUpperCase() !== 'NNIM' &&
    dsym.relatedAppVersions?.map((version) => version.trim()).includes(metadata.version) &&
    appearsInResourceStack(dsym)
  ));
  const uuids = [
    ...(mainApp ? [mainApp.uuid] : []),
    ...relatedComponents.map((component) => component.uuid),
  ];
  return { uuids, metadata, matchType: uuids.length > 0 ? 'version' as const : 'none' as const };
}

function QualityLogDigest({
  preview,
  loading,
}: {
  preview: JenkinsQualityArtifactPreview | null;
  loading: boolean;
}) {
  const content = tailLines(preview?.content || '');
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {loading ? (
        <Alert showIcon type="info" message="正在加载质检日志..." />
      ) : preview?.content ? (
        <pre
          style={{
            margin: 0,
            maxHeight: 260,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 12,
            lineHeight: 1.5,
            background: '#fafafa',
            padding: 12,
            border: '1px solid #f0f0f0',
            borderRadius: 4,
          }}
        >
          {content || '日志内容为空'}
        </pre>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次任务没有可展示的质检日志" />
      )}
    </Space>
  );
}

function parseJsonPreview<T>(preview?: JenkinsQualityArtifactPreview | null): T | null {
  if (!preview?.content) return null;
  try {
    return JSON.parse(preview.content) as T;
  } catch {
    return null;
  }
}

function eventTypeLabel(type?: string) {
  const labels: Record<string, string> = {
    tap: '点击',
    swipe: '滑动',
    edgeBack: '边缘返回',
    tapBack: '点击返回',
    businessNav: '业务入口切换',
    businessExplore: '业务探索',
    businessGuardBack: '业务保护返回',
    businessGuardSwipe: '业务保护滑动',
  };
  return labels[type || ''] || type || '未知';
}

function MonkeyReportSummary({
  preview,
  loading,
}: {
  preview: (JenkinsQualityArtifactPreview & { title: string }) | null;
  loading: boolean;
}) {
  type MonkeyEvent = {
    index?: number;
    type?: string;
    reason?: string;
    businessDomain?: string;
    businessPath?: string;
    pageName?: string;
    riskLevel?: string;
    businessGuard?: string;
    x?: number;
    y?: number;
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    usedFallbackPoint?: boolean;
  };
  type MonkeyReport = {
    status?: string;
    message?: string;
    wdaUrl?: string;
    requestedEvents?: number;
    requestedDurationSeconds?: number;
    executedEvents?: number;
    durationMs?: number;
    rules?: {
      backIntervalEvents?: number;
      stuckEvents?: number;
      stuckCheckIntervalEvents?: number;
      backActionProbability?: number;
      backTapProbability?: number;
      avoidTopBar?: boolean;
      heartbeatIntervalSeconds?: number;
      forbiddenTexts?: string[];
      businessAware?: boolean;
      businessDomains?: string[];
      guardedActionPolicy?: string;
    };
    businessAware?: boolean;
    businessCoverage?: {
      enabled?: boolean;
      targetDomains?: string[];
      guardedActionPolicy?: string;
      domainCounts?: Record<string, number>;
      riskCounts?: Record<string, number>;
      topPaths?: Array<{ businessPath?: string; eventCount?: number }>;
      matchedClasses?: Record<string, number>;
      mapLoadError?: string;
    };
    dominantBusinessDomain?: string;
    lastBusinessPath?: string;
    events?: MonkeyEvent[];
  };

  if (loading) {
    return <Alert showIcon type="info" message="正在加载 Monkey 报告..." />;
  }

  const report = parseJsonPreview<MonkeyReport>(preview);
  if (!report) {
    return preview?.content ? (
      <Alert showIcon type="warning" message="Monkey 报告不是可解析的 JSON" />
    ) : (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次任务没有 Monkey 报告" />
    );
  }

  const events = report.events || [];
  const eventCounts = events.reduce<Record<string, number>>((acc, event) => {
    const type = event.type || 'unknown';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const backEvents = events.filter((event) => event.type === 'edgeBack' || event.type === 'tapBack');
  const stuckEvents = events.filter((event) => /stuck/i.test(event.reason || ''));
  const fallbackEvents = events.filter((event) => event.usedFallbackPoint);
  const recentEvents = events.slice(-8).reverse();
  const executedEvents = report.executedEvents ?? events.length;
  const durationSeconds = report.durationMs ? Math.round(report.durationMs / 1000) : report.requestedDurationSeconds;
  const isPassed = report.status === 'passed';
  const businessCoverage = report.businessCoverage;
  const businessAware = !!(report.businessAware || businessCoverage?.enabled || report.rules?.businessAware);
  const domainEntries = Object.entries(businessCoverage?.domainCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  const riskEntries = Object.entries(businessCoverage?.riskCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  const guardedEventCount = events.filter((event) => event.businessGuard).length;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        showIcon
        type={isPassed ? 'success' : 'warning'}
        message={isPassed ? 'Monkey 执行完成' : 'Monkey 执行异常'}
        description={report.message || '未提供执行说明'}
      />
      <Space wrap>
        <Tag color={isPassed ? 'green' : 'red'}>{report.status || 'unknown'}</Tag>
        {businessAware && <Tag color="blue">业务感知探索</Tag>}
        <Tag>执行 {executedEvents} 次</Tag>
        {report.requestedEvents !== undefined && <Tag>目标 {report.requestedEvents} 次</Tag>}
        {durationSeconds !== undefined && <Tag>耗时 {formatSeconds(durationSeconds)}</Tag>}
        {report.requestedDurationSeconds !== undefined && <Tag>计划 {formatSeconds(report.requestedDurationSeconds)}</Tag>}
        {report.wdaUrl && <Tag>WDA {report.wdaUrl.replace(/^https?:\/\//, '')}</Tag>}
      </Space>
      {businessAware && (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Text strong>业务探索覆盖</Text>
          {businessCoverage?.mapLoadError ? (
            <Alert showIcon type="warning" message={`业务映射加载失败：${businessCoverage.mapLoadError}`} />
          ) : null}
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="主要业务域">{report.dominantBusinessDomain || '-'}</Descriptions.Item>
            <Descriptions.Item label="最后路径">{report.lastBusinessPath || '-'}</Descriptions.Item>
            <Descriptions.Item label="保护动作">{guardedEventCount}</Descriptions.Item>
            <Descriptions.Item label="目标业务">
              {(businessCoverage?.targetDomains || report.rules?.businessDomains || []).join('、') || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="保护策略">{businessCoverage?.guardedActionPolicy || report.rules?.guardedActionPolicy || '-'}</Descriptions.Item>
            <Descriptions.Item label="风险分布">
              {riskEntries.length ? riskEntries.map(([risk, count]) => `${risk} ${count}`).join(' / ') : '-'}
            </Descriptions.Item>
          </Descriptions>
          {domainEntries.length > 0 && (
            <Space wrap>
              {domainEntries.map(([domain, count]) => (
                <Tag key={domain} color={domain === report.dominantBusinessDomain ? 'blue' : 'default'}>
                  {domain} {count}
                </Tag>
              ))}
            </Space>
          )}
          {businessCoverage?.topPaths?.length ? (
            <Space wrap>
              {businessCoverage.topPaths.slice(0, 8).map((item) => (
                <Tag key={item.businessPath || 'unknown'}>
                  {item.businessPath || 'unknown'} {item.eventCount || 0}
                </Tag>
              ))}
            </Space>
          ) : null}
        </Space>
      )}
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
        <Descriptions.Item label="点击">{eventCounts.tap || 0}</Descriptions.Item>
        <Descriptions.Item label="滑动">{eventCounts.swipe || 0}</Descriptions.Item>
        <Descriptions.Item label="返回">{backEvents.length}</Descriptions.Item>
        <Descriptions.Item label="卡住处理">{stuckEvents.length}</Descriptions.Item>
        <Descriptions.Item label="兜底点击">{fallbackEvents.length}</Descriptions.Item>
        <Descriptions.Item label="禁点文案">{report.rules?.forbiddenTexts?.length || 0}</Descriptions.Item>
      </Descriptions>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Text strong>执行规则</Text>
        <Space wrap>
          {report.rules?.backIntervalEvents !== undefined && <Tag>每 {report.rules.backIntervalEvents} 次尝试返回</Tag>}
          {report.rules?.stuckEvents !== undefined && <Tag>连续 {report.rules.stuckEvents} 次判定卡住</Tag>}
          {report.rules?.stuckCheckIntervalEvents !== undefined && <Tag>每 {report.rules.stuckCheckIntervalEvents} 次检测卡住</Tag>}
          {report.rules?.backActionProbability !== undefined && <Tag>返回概率 {Math.round(report.rules.backActionProbability * 100)}%</Tag>}
          {report.rules?.backTapProbability !== undefined && <Tag>点击返回概率 {Math.round(report.rules.backTapProbability * 100)}%</Tag>}
          {report.rules?.avoidTopBar !== undefined && <Tag>{report.rules.avoidTopBar ? '避开顶部区域' : '允许顶部区域'}</Tag>}
          {report.rules?.heartbeatIntervalSeconds !== undefined && <Tag>心跳 {report.rules.heartbeatIntervalSeconds}s</Tag>}
        </Space>
      </Space>
      {recentEvents.length > 0 && (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Text strong>最近动作</Text>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {recentEvents.map((event) => (
              <Text key={event.index} type="secondary" style={{ fontSize: 12 }}>
                #{event.index} {eventTypeLabel(event.type)}
                {event.reason ? ` / ${event.reason}` : ''}
                {event.businessPath ? ` / ${event.businessPath}` : ''}
                {event.pageName ? ` / ${event.pageName}` : ''}
                {event.x !== undefined && event.y !== undefined ? ` / (${event.x}, ${event.y})` : ''}
                {event.startX !== undefined && event.endX !== undefined ? ` / (${event.startX}, ${event.startY}) -> (${event.endX}, ${event.endY})` : ''}
              </Text>
            ))}
          </Space>
        </Space>
      )}
      <Collapse
        size="small"
        items={[
          {
            key: 'raw',
            label: '查看原始 Monkey 数据',
            children: (
              <pre
                style={{
                  margin: 0,
                  maxHeight: 360,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 12,
                  lineHeight: 1.5,
                  background: '#fafafa',
                  padding: 12,
                  border: '1px solid #f0f0f0',
                  borderRadius: 4,
                }}
              >
                {preview?.content || '文件内容为空'}
              </pre>
            ),
          },
        ]}
      />
    </Space>
  );
}

type CrashSymbolicationState = {
  loading?: boolean;
  error?: string;
  result?: SymbolicationResult;
  usedUUIDs?: string[];
  metadata?: ReturnType<typeof extractCrashMetadata>;
  matchType?: 'uuid' | 'version' | 'none';
};

function SymbolicatedCrashAnalysisDigest({
  analysis,
}: {
  analysis?: SymbolicationResult['analysis'] | SymbolicationResult['aiAnalysis'];
}) {
  if (!analysis) return null;
  return (
    <Alert
      showIcon
      type={analysis.severity === 'critical' || analysis.severity === 'high' ? 'error' : 'info'}
      message={analysis.summary || '崩溃分析结果'}
      description={(
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Space wrap>
            {analysis.crashType && <Tag color="red">{analysis.crashType}</Tag>}
            {analysis.crashModule && <Tag>{analysis.crashModule}</Tag>}
            {analysis.crashLocation && <Tag color="orange">{analysis.crashLocation}</Tag>}
            {analysis.appVersion && <Tag color="purple">版本 {analysis.appVersion}</Tag>}
          </Space>
          {analysis.possibleCauses?.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              可能原因：{analysis.possibleCauses.slice(0, 3).join('；')}
            </Text>
          )}
          {analysis.suggestions?.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              建议：{analysis.suggestions.slice(0, 3).join('；')}
            </Text>
          )}
        </Space>
      )}
    />
  );
}

function CrashAnalysisSummary({
  analysis,
  crashReportsUrl,
}: {
  analysis?: NonNullable<NonNullable<JenkinsQualityBuild['qualitySummary']>['exceptionAnalysis']>;
  crashReportsUrl?: string;
}) {
  const [symbolicationByFile, setSymbolicationByFile] = useState<Record<string, CrashSymbolicationState>>({});
  if (!analysis) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次任务没有异常分析结果" />;
  }
  const logSamples = analysis.samples || [];
  const hangStackAnalysis = analysis.hangStackAnalysis || [];
  const crashFileName = (file?: string) => (file || '').split('/').filter(Boolean).at(-1) || '';
  const autoHangAnalysisByFile = new Map(hangStackAnalysis.map((item) => [crashFileName(item.file), item]));
  const crashFileUrl = (file?: string) => {
    const fileName = crashFileName(file);
    if (!fileName || !crashReportsUrl) return '';
    return `${crashReportsUrl.replace(/\/$/, '')}/${encodeURIComponent(fileName)}`;
  };
  const crashFiles = Array.from(new Set((analysis.crashReports?.files || []).map(crashFileName).filter(Boolean)));
  const downloadCrashIps = async (file: string) => {
    const url = crashFileUrl(file);
    if (!url) {
      message.warning('未找到 ips 文件下载地址');
      return;
    }
    const fileName = file.toLowerCase().endsWith('.ips') ? file : `${file}.ips`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('下载 ips 失败');
      }
      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);
    } catch (error: any) {
      message.error(error?.message || '下载 ips 失败');
    }
  };
  const handleSymbolicateCrash = async (file: string) => {
    const url = crashFileUrl(file);
    if (!url) {
      message.warning('未找到 ips 文件下载地址');
      return;
    }
    setSymbolicationByFile((prev) => ({
      ...prev,
      [file]: { ...(prev[file] || {}), loading: true, error: undefined },
    }));
    try {
      const previewResponse = await jenkinsApi.previewQualityArtifact(url);
      if (!previewResponse.success || !previewResponse.data?.content) {
        throw new Error(previewResponse.error || '读取 ips 文件失败');
      }

      const crashLog = previewResponse.data.content;
      const dsymResponse = await dsymApi.list();
      if (!dsymResponse.success || !dsymResponse.data) {
        throw new Error(dsymResponse.error || '读取 dSYM 列表失败');
      }

      const { uuids, metadata, matchType } = selectCrashDsymUUIDs(crashLog, dsymResponse.data);
      if (uuids.length === 0) {
        const versionText = metadata.version ? `版本 ${metadata.version}` : '当前崩溃文件';
        throw new Error(`未匹配到 ${versionText} 对应的 dSYM，请先上传或关联 dSYM 后再解析`);
      }

      const symbolicationResponse = await symbolicateApi.symbolicate(crashLog, uuids);
      if (!symbolicationResponse.success || !symbolicationResponse.data) {
        throw new Error(symbolicationResponse.error || '符号化解析失败');
      }

      setSymbolicationByFile((prev) => ({
        ...prev,
        [file]: {
          loading: false,
          result: symbolicationResponse.data,
          usedUUIDs: uuids,
          metadata,
          matchType,
        },
      }));
      message.success('符号化解析完成');
    } catch (error: any) {
      setSymbolicationByFile((prev) => ({
        ...prev,
        [file]: {
          ...(prev[file] || {}),
          loading: false,
          error: error?.error || error?.message || '符号化解析失败',
        },
      }));
    }
  };
  const renderHangStackAnalysis = (hang: NonNullable<typeof hangStackAnalysis[number]>) => (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Text>{hang.mainThread?.summary || hang.reason || '检测到 Watchdog 卡顿。'}</Text>
      <Collapse
        size="small"
        items={[
          {
            key: 'main-thread',
            label: `主线程堆栈 ${hang.mainThread?.queue || hang.mainThread?.name || ''}`,
            children: (
              <pre
                style={{
                  margin: 0,
                  maxHeight: 320,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 12,
                  lineHeight: 1.5,
                  background: '#fafafa',
                  padding: 12,
                  border: '1px solid #f0f0f0',
                  borderRadius: 4,
                }}
              >
                {(hang.mainThread?.frames || []).slice(0, 24).map((frame, frameIndex) => (
                  `${frameIndex.toString().padStart(2, ' ')} ${frame.image || ''} ${frame.symbol || ''}`
                )).join('\n')}
              </pre>
            ),
          },
          {
            key: 'suspicious',
            label: `可疑同步等待线程 ${hang.suspiciousThreads?.length || 0}`,
            children: (hang.suspiciousThreads?.length || 0) > 0 ? (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {(hang.suspiciousThreads || []).map((thread) => (
                  <pre
                    key={`${thread.index}-${thread.queue || thread.name || 'thread'}`}
                    style={{
                      margin: 0,
                      maxHeight: 220,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontSize: 12,
                      lineHeight: 1.5,
                      background: '#fafafa',
                      padding: 12,
                      border: '1px solid #f0f0f0',
                      borderRadius: 4,
                    }}
                  >
                    {[
                      `Thread ${thread.index ?? '-'} ${thread.queue || thread.name || ''}`,
                      ...(thread.frames || []).map((frame, frameIndex) => `${frameIndex.toString().padStart(2, ' ')} ${frame.image || ''} ${frame.symbol || ''}`),
                    ].join('\n')}
                  </pre>
                ))}
              </Space>
            ) : (
              <Text type="secondary">未发现明显同步等待线程。</Text>
            ),
          },
          {
            key: 'suggestions',
            label: '排查建议',
            children: (
              <Space direction="vertical" size={4}>
                {(hang.suggestions || []).map((item) => (
                  <Text key={item} type="secondary">{item}</Text>
                ))}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space wrap>
        <Tag color={analysisSeverityColor(analysis.severity)}>{analysis.severity || 'unknown'}</Tag>
        <Tag>崩溃 {analysis.crashCount || 0}</Tag>
        <Tag>异常 {analysis.exceptionCount || 0}</Tag>
        <Tag>卡死/Watchdog {analysis.watchdogCount || 0}</Tag>
        <Tag>内存问题 {analysis.memoryIssueCount || 0}</Tag>
        <Tag>错误日志 {analysis.errorCount || 0}</Tag>
      </Space>
      {(analysis.crashReports?.count || 0) > 0 ? (
        <Alert
          showIcon
          type="error"
          message={`发现 ${crashFiles.length || analysis.crashReports?.count || 0} 个崩溃文件`}
          description={(
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {crashFiles.slice(0, 5).map((file) => (
                (() => {
                  const autoHangAnalysis = autoHangAnalysisByFile.get(file);
                  return (
                    <Space key={file} direction="vertical" size={6} style={{ width: '100%' }}>
                      <Space size={8} wrap>
                        <Text type="secondary" style={{ fontSize: 12 }}>{file}</Text>
                        {crashFileUrl(file) && (
                          <Button size="small" type="link" onClick={() => downloadCrashIps(file)}>
                            下载 ips
                          </Button>
                        )}
                        {autoHangAnalysis ? (
                          <Tag color="green">已自动解析</Tag>
                        ) : (
                          <Button
                            size="small"
                            type="link"
                            disabled={!crashFileUrl(file)}
                            loading={symbolicationByFile[file]?.loading}
                            onClick={() => handleSymbolicateCrash(file)}
                          >
                            符号化解析
                          </Button>
                        )}
                      </Space>
                      {autoHangAnalysis && renderHangStackAnalysis(autoHangAnalysis)}
                      {!autoHangAnalysis && symbolicationByFile[file]?.error && (
                        <Alert showIcon type="warning" message={symbolicationByFile[file]?.error} />
                      )}
                      {!autoHangAnalysis && symbolicationByFile[file]?.result && (
                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                          <Space wrap>
                            {symbolicationByFile[file]?.metadata?.appName && <Tag>{symbolicationByFile[file]?.metadata?.appName}</Tag>}
                            {symbolicationByFile[file]?.metadata?.version && <Tag color="purple">版本 {symbolicationByFile[file]?.metadata?.version}</Tag>}
                            {symbolicationByFile[file]?.metadata?.bundleId && <Tag>{symbolicationByFile[file]?.metadata?.bundleId}</Tag>}
                            <Tag color={symbolicationByFile[file]?.matchType === 'uuid' ? 'green' : 'blue'}>
                              dSYM {symbolicationByFile[file]?.usedUUIDs?.length || 0} 个
                            </Tag>
                            {symbolicationByFile[file]?.result?.fromHistory && <Tag color="cyan">历史结果</Tag>}
                            {symbolicationByFile[file]?.result?.fromCache && <Tag color="cyan">缓存结果</Tag>}
                          </Space>
                          {symbolicationByFile[file]?.result?.warning && (
                            <Alert showIcon type="warning" message={symbolicationByFile[file]?.result?.warning} />
                          )}
                          <SymbolicatedCrashAnalysisDigest
                            analysis={symbolicationByFile[file]?.result?.aiAnalysis || symbolicationByFile[file]?.result?.analysis}
                          />
                          <Collapse
                            size="small"
                            items={[
                              {
                                key: 'symbolicated-log',
                                label: '查看符号化日志',
                                children: (
                                  <pre
                                    style={{
                                      margin: 0,
                                      maxHeight: 360,
                                      overflow: 'auto',
                                      whiteSpace: 'pre-wrap',
                                      wordBreak: 'break-word',
                                      fontSize: 12,
                                      lineHeight: 1.5,
                                      background: '#fafafa',
                                      padding: 12,
                                      border: '1px solid #f0f0f0',
                                      borderRadius: 4,
                                    }}
                                  >
                                    {tailLines(symbolicationByFile[file]?.result?.symbolicatedLog || '', 180)}
                                  </pre>
                                ),
                              },
                            ]}
                          />
                        </Space>
                      )}
                    </Space>
                  );
                })()
              ))}
            </Space>
          )}
        />
      ) : (
        <Alert showIcon type="success" message="未发现崩溃报告" />
      )}
      {logSamples.length > 0 && (
        <Space direction="vertical" size={4}>
          {logSamples.slice(0, 5).map((sample, index) => (
            <Text key={`${sample.type || 'sample'}-${index}`} type="secondary" style={{ fontSize: 12 }}>
              [{sample.type || 'log'}] {sample.message}
            </Text>
          ))}
        </Space>
      )}
    </Space>
  );
}

export default function CICDPage() {
  const location = useLocation();
  const [data, setData] = useState<JenkinsBuildListResult | null>(null);
  const [activeSection, setActiveSection] = useState(location.pathname.startsWith('/cicd/quality') ? 'quality' : 'release');
  const [loading, setLoading] = useState(false);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [stoppingBuild, setStoppingBuild] = useState<number | null>(null);
  const [stoppingQualityBuild, setStoppingQualityBuild] = useState<number | null>(null);
  const [cleaningQualityWda, setCleaningQualityWda] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [qualityError, setQualityError] = useState('');
  const [qualityData, setQualityData] = useState<JenkinsQualityListResult | null>(null);
  const [sonicDevicePools, setSonicDevicePools] = useState<SonicDevicePool[]>([]);
  const [devicePoolStatus, setDevicePoolStatus] = useState<SonicDevicePoolStatusResult | null>(null);
  const [devicePoolModalOpen, setDevicePoolModalOpen] = useState(false);
  const [devicePoolSaving, setDevicePoolSaving] = useState(false);
  const [devicePoolAdding, setDevicePoolAdding] = useState(false);
  const [unassignedTargetPool, setUnassignedTargetPool] = useState('ios-default');
  const [qualityJobSyncing, setQualityJobSyncing] = useState(false);
  const [devicePoolDrafts, setDevicePoolDrafts] = useState<SonicDevicePool[]>([]);
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [releaseBranchModalOpen, setReleaseBranchModalOpen] = useState(false);
  const [releaseBranchCreating, setReleaseBranchCreating] = useState(false);
  const [releaseBranchName, setReleaseBranchName] = useState('');
  const [releaseBranchBase, setReleaseBranchBase] = useState('develop');
  const [releaseBranchLog, setReleaseBranchLog] = useState('');
  const [qrPreview, setQrPreview] = useState<{ url: string; channel?: string; buildNumber?: string } | null>(null);
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [buildFailureAnalysisLoading, setBuildFailureAnalysisLoading] = useState(false);
  const [buildFailureAnalysis, setBuildFailureAnalysis] = useState<JenkinsBuildFailureAnalysis | null>(null);
  const [qualityModalOpen, setQualityModalOpen] = useState(false);
  const [qualitySubmitting, setQualitySubmitting] = useState(false);
  const [qualitySubmitMessage, setQualitySubmitMessage] = useState('');
  const [qualityBuild, setQualityBuild] = useState<JenkinsBuild | null>(null);
  const [qualityReportBuild, setQualityReportBuild] = useState<JenkinsQualityBuild | null>(null);
  const [activeQualitySummaryView, setActiveQualitySummaryView] = useState<QualitySummaryView>('performance');
  const [qualityArtifactPreview, setQualityArtifactPreview] = useState<(JenkinsQualityArtifactPreview & { title: string }) | null>(null);
  const [qualityArtifactPreviewLoading, setQualityArtifactPreviewLoading] = useState(false);
  const [qualityLogDigest, setQualityLogDigest] = useState<JenkinsQualityArtifactPreview | null>(null);
  const [qualityLogDigestLoading, setQualityLogDigestLoading] = useState(false);
  const [qualityPerformanceSamples, setQualityPerformanceSamples] = useState<JenkinsQualityPerformanceSamples | null>(null);
  const [qualityPerformanceLoading, setQualityPerformanceLoading] = useState(false);
  const [qualitySuite, setQualitySuite] = useState<JenkinsQualitySuite>('monkey');
  const [qualityMonkeyDurationSeconds, setQualityMonkeyDurationSeconds] = useState(14400);
  const [qualityStutterScenario, setQualityStutterScenario] = useState('community');
  const [qualityDevicePool, setQualityDevicePool] = useState('ios-default');
  const [qualityDeviceUdids, setQualityDeviceUdids] = useState<string[]>([]);
  const [qualitySkipInstall, setQualitySkipInstall] = useState(false);
  const [selectedBuildLog, setSelectedBuildLog] = useState<{
    build: JenkinsBuild;
    log: string;
    thirdSdkBranch: string;
    thirdSdkRevision?: string;
    thirdSdkDependencies: Array<{ name: string; version: string; source: string }>;
    thirdSdkMissingFiles?: string[];
    thirdSdkError?: string;
  } | null>(null);
  const [buildDsymUploading, setBuildDsymUploading] = useState(false);
  const [buildDsymUploaded, setBuildDsymUploaded] = useState<DSYMInfo | null>(null);
  const [deployTarget, setDeployTarget] = useState<DeployTarget>('Pgyer');
  const [filterDeployTarget, setFilterDeployTarget] = useState<DeployTarget | ''>('');
  const [publishBranch, setPublishBranch] = useState('develop');
  const [branches, setBranches] = useState<string[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [verificationPassword, setVerificationPassword] = useState('');

  const loadBuilds = async (target = filterDeployTarget, options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    setError('');
    try {
      const response = await jenkinsApi.listNNBuilds({ deployTarget: target });
      setData(response.data || null);
      return response.data || null;
    } catch (err: any) {
      setError(err?.error || err?.message || '加载 Jenkins 构建列表失败');
      return null;
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  };

  const refreshBuildsUntilUpdated = async (target: DeployTarget | '', previousLatest?: number | string) => {
    const delays = [0, 1500, 1500, 2000, 3000, 4000, 4000, 4000];
    setLoading(true);
    try {
      for (const delay of delays) {
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        const nextData = await loadBuilds(target, { silent: true });
        const latest = nextData?.builds?.[0]?.number;
        if (latest && previousLatest && Number(latest) > Number(previousLatest)) {
          return;
        }
        if (nextData?.builds?.some((build) => build.building)) {
          return;
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const loadQualityBuilds = async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setQualityLoading(true);
    }
    setQualityError('');
    try {
      const response = await jenkinsApi.listQualityBuilds();
      setQualityData(response.data || null);
      return response.data || null;
    } catch (err: any) {
      setQualityError(normalizeQualityError(err));
      return null;
    } finally {
      if (!options?.silent) {
        setQualityLoading(false);
      }
    }
  };

  async function refreshQualitySection(options?: { silent?: boolean }) {
    const [qualityResult] = await Promise.all([
      loadQualityBuilds(options),
      loadSonicDevicePools(),
    ]);
    return qualityResult;
  }

  const openQualityReport = async (record: JenkinsQualityBuild) => {
    setQualityReportBuild(record);
    setQualityArtifactPreview(null);
    setQualityLogDigest(null);
    setQualityPerformanceSamples(null);
    const initialHasPerformanceReport = Boolean(
      record.qualitySummary?.performanceAnalysis ||
      record.qualitySummary?.artifacts?.performanceSamplesUrl ||
      record.qualitySummary?.artifacts?.performanceTraceUrl
    );
    if (initialHasPerformanceReport) {
      setActiveQualitySummaryView('performance');
      setQualityPerformanceLoading(Boolean(record.qualitySummary?.artifacts?.performanceSamplesUrl));
    }

    const nextData = await loadQualityBuilds({ silent: true });
    const latestBuild = nextData?.builds?.find((build) => build.number === record.number);
    const displayBuild = latestBuild || record;
    setQualityReportBuild(displayBuild);
    const hasPerformanceReport = Boolean(
      displayBuild.qualitySummary?.performanceAnalysis ||
      displayBuild.qualitySummary?.artifacts?.performanceSamplesUrl ||
      displayBuild.qualitySummary?.artifacts?.performanceTraceUrl
    );
    if (hasPerformanceReport) {
      await openQualityPerformanceReport(displayBuild.qualitySummary?.artifacts?.performanceSamplesUrl);
    } else {
      setActiveQualitySummaryView('log');
    }
  };

  const refreshQualityBuildsUntilUpdated = async (previousLatest?: number | string) => {
    const delays = [0, 1000, 1500, 2000, 3000, 4000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000];
    const previousNumber = previousLatest ? Number(previousLatest) : 0;
    for (const delay of delays) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const nextData = await refreshQualitySection({ silent: true });
      const latestBuild = nextData?.builds?.[0];
      const latestNumber = latestBuild ? Number(latestBuild.number) : 0;

      if (latestNumber && (!previousNumber || latestNumber > previousNumber)) {
        return;
      }
    }
    await refreshQualitySection({ silent: true });
  };

  const loadSonicDevicePools = async () => {
    try {
      const response = await jenkinsApi.getSonicDevicePoolStatus();
      const status = response.data || null;
      const pools = status?.pools || [];
      setDevicePoolStatus(status);
      setSonicDevicePools(pools);
      if (pools.length > 0 && !pools.some((pool) => pool.value === qualityDevicePool)) {
        setQualityDevicePool(pools[0].value);
      }
      if (pools.length > 0 && !pools.some((pool) => pool.value === unassignedTargetPool)) {
        setUnassignedTargetPool(pools[0].value);
      }
    } catch (err: any) {
      try {
        const response = await jenkinsApi.listSonicDevicePools();
        const pools = response.data || [];
        setDevicePoolStatus(null);
        setSonicDevicePools(pools);
      } catch {
        message.warning(err?.error || err?.message || '加载质检设备池失败');
      }
    }
  };

  const openDevicePoolModal = () => {
    setDevicePoolDrafts(sonicDevicePools.map((pool) => ({ ...pool })));
    setDevicePoolModalOpen(true);
  };

  const updateDevicePoolDraft = (index: number, patch: Partial<SonicDevicePool>) => {
    setDevicePoolDrafts((items) => items.map((item, itemIndex) => (
      itemIndex === index ? { ...item, ...patch } : item
    )));
  };

  const addDevicePoolDraft = () => {
    setDevicePoolDrafts((items) => [
      ...items,
      {
        label: '新设备池',
        value: `ios-pool-${items.length + 1}`,
        deviceId: '',
        description: '用于打包机本机 iOS 真机质检调度。',
      },
    ]);
  };

  const removeDevicePoolDraft = (index: number) => {
    setDevicePoolDrafts((items) => items.filter((_, itemIndex) => itemIndex !== index));
  };

  const devicePoolDevicesText = (pool: SonicDevicePool) => {
    const devices = pool.devices?.length
      ? pool.devices
      : (pool.deviceId || pool.groupId ? [{ udid: pool.deviceId || pool.groupId || '' }] : []);
    return devices.map((device) => device.label ? `${device.udid} ${device.label}` : device.udid).join('\n');
  };

  const parseDevicePoolDevices = (text: string) => text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [udid, ...labelParts] = line.split(/\s+/);
      return {
        udid,
        label: labelParts.join(' ') || undefined,
      };
    })
    .filter((device) => device.udid);

  const deviceStatusTag = (status?: string) => {
    if (status === 'idle') return <Tag color="green">空闲</Tag>;
    if (status === 'busy') return <Tag color="orange">占用</Tag>;
    if (status === 'offline') return <Tag color="red">离线</Tag>;
    if (status === 'unassigned') return <Tag color="blue">未配置</Tag>;
    return <Tag>未知</Tag>;
  };

  const cleanDevicePoolsForSave = (pools: SonicDevicePool[]) => pools.map((pool) => ({
    label: pool.label.trim(),
    value: pool.value.trim(),
    deviceId: pool.deviceId?.trim() || undefined,
    groupId: pool.groupId?.trim() || undefined,
    devices: (pool.devices || []).map((device) => ({
      label: device.label?.trim() || undefined,
      udid: device.udid.trim(),
      description: device.description?.trim() || undefined,
    })).filter((device) => device.udid),
    description: pool.description.trim(),
  }));

  const saveDevicePools = async () => {
    const normalized = cleanDevicePoolsForSave(devicePoolDrafts);

    if (normalized.some((pool) => !pool.label || !pool.value)) {
      message.warning('设备池名称和 value 不能为空');
      return;
    }

    setDevicePoolSaving(true);
    try {
      const response = await jenkinsApi.updateSonicDevicePools(normalized);
      const pools = response.data || [];
      setSonicDevicePools(pools);
      if (pools.length > 0 && !pools.some((pool) => pool.value === qualityDevicePool)) {
        setQualityDevicePool(pools[0].value);
      }
      setDevicePoolModalOpen(false);
      message.success('设备池配置已保存');
    } catch (err: any) {
      message.error(err?.error || err?.message || '保存质检设备池失败');
    } finally {
      setDevicePoolSaving(false);
    }
  };

  const addUnassignedDevicesToPool = async () => {
    const devices = devicePoolStatus?.unassignedDevices || [];
    if (devices.length === 0) {
      message.info('没有可加入的在线设备');
      return;
    }

    const targetValue = unassignedTargetPool || sonicDevicePools[0]?.value;
    if (!targetValue) {
      message.warning('请先创建一个设备池');
      return;
    }

    const nextPools = sonicDevicePools.map((pool) => {
      if (pool.value !== targetValue) return pool;
      const existingDevices = pool.devices?.length
        ? pool.devices
        : (pool.deviceId || pool.groupId ? [{ udid: pool.deviceId || pool.groupId || '' }] : []);
      const existingUdids = new Set(existingDevices.map((device) => device.udid).filter(Boolean));
      const nextDevices = [
        ...existingDevices,
        ...devices
          .filter((device) => !existingUdids.has(device.udid))
          .map((device) => ({
            udid: device.udid,
            label: device.marketName || device.name || undefined,
            description: [device.productVersion, device.connType].filter(Boolean).join(' / ') || undefined,
          })),
      ];
      return {
        ...pool,
        deviceId: nextDevices[0]?.udid || pool.deviceId,
        groupId: undefined,
        devices: nextDevices,
      };
    });

    setDevicePoolAdding(true);
    try {
      await jenkinsApi.updateSonicDevicePools(cleanDevicePoolsForSave(nextPools));
      message.success(`已加入 ${devices.length} 台设备`);
      await loadSonicDevicePools();
    } catch (err: any) {
      message.error(err?.error || err?.message || '加入设备池失败');
    } finally {
      setDevicePoolAdding(false);
    }
  };

  const syncQualityJobConfig = async () => {
    setQualityJobSyncing(true);
    try {
      const response = await jenkinsApi.syncQualityJobConfig();
      const data = response.data;
      message.success(data?.concurrentBuild ? 'Jenkins 质检 Job 已同步，并发已开启' : 'Jenkins 质检 Job 已同步');
      await refreshQualitySection({ silent: true });
    } catch (err: any) {
      message.error(err?.error || err?.message || '同步 Jenkins 质检 Job 配置失败');
    } finally {
      setQualityJobSyncing(false);
    }
  };

  const publish = async () => {
    if (!publishBranch.trim()) {
      message.warning('请输入发布分支');
      return;
    }
    if (deployTarget !== 'Pgyer' && !isReleaseBranch(publishBranch)) {
      message.warning('TestFlight / 苹果商店只能选择 release/x.x.x 格式分支');
      return;
    }
    if (deployTarget !== 'Pgyer' && !verificationPassword.trim()) {
      message.warning('TestFlight / 苹果商店发布需要填写验证密码');
      return;
    }
    setPublishing(true);
    const publishTarget = deployTarget;
    const previousLatestBuild = data?.job.lastBuild?.number;
    try {
      await jenkinsApi.publishNN({
        deployTarget: publishTarget,
        branch: publishBranch.trim(),
        verificationPassword: verificationPassword.trim(),
      });
      message.success(`已触发 ${DEPLOY_TARGET_OPTIONS.find((item) => item.value === publishTarget)?.label} 发布构建，正在刷新构建列表`);
      setPublishModalOpen(false);
      setVerificationPassword('');
      const nextFilter = filterDeployTarget && filterDeployTarget !== publishTarget ? publishTarget : filterDeployTarget;
      if (nextFilter !== filterDeployTarget) {
        setFilterDeployTarget(nextFilter);
      }
      await refreshBuildsUntilUpdated(nextFilter, previousLatestBuild);
    } catch (err: any) {
      message.error(err?.error || err?.message || '触发发布失败');
    } finally {
      setPublishing(false);
    }
  };

  const openReleaseBranchModal = () => {
    setReleaseBranchBase('develop');
    setReleaseBranchName('');
    setReleaseBranchLog('');
    setReleaseBranchModalOpen(true);
    loadBranches();
  };

  const createReleaseBranch = async () => {
    const targetBranch = releaseBranchName.trim().replace(/^origin\//, '');
    const baseBranch = releaseBranchBase.trim().replace(/^origin\//, '') || 'develop';
    if (!targetBranch) {
      message.warning('请输入新分支名称');
      return;
    }
    if (targetBranch === baseBranch) {
      message.warning('新分支不能与基准分支相同');
      return;
    }
    setReleaseBranchCreating(true);
    setReleaseBranchLog('');
    try {
      await jenkinsApi.createReleaseBranch({ targetBranch, baseBranch });
      message.success(`已拉取新分支 ${targetBranch}`);
      setPublishBranch(targetBranch);
      await loadBranches();
    } catch (err: any) {
      const errorText = err?.error || err?.message || '拉取新分支失败';
      setReleaseBranchLog((current) => `${current || ''}\n\n${errorText}`.trim());
      message.error(errorText);
    } finally {
      setReleaseBranchCreating(false);
    }
  };

  const loadBranches = async () => {
    setBranchLoading(true);
    try {
      const response = await jenkinsApi.listBranches();
      const nextBranches = response.data || [];
      setBranches(nextBranches);
      if (deployTarget !== 'Pgyer') {
        setPublishBranch(getHighestReleaseBranch(nextBranches));
      }
      return nextBranches;
    } catch (err: any) {
      message.warning(err?.error || err?.message || '加载分支列表失败，可直接输入分支名');
      return [];
    } finally {
      setBranchLoading(false);
    }
  };

  const stopBuild = async (buildNumber: number) => {
    setStoppingBuild(buildNumber);
    try {
      await jenkinsApi.stopBuild(buildNumber);
      message.success(`已取消构建 #${buildNumber}`);
      loadBuilds();
    } catch (err: any) {
      message.error(err?.error || err?.message || '取消构建失败');
    } finally {
      setStoppingBuild(null);
    }
  };

  const stopQualityBuild = async (buildNumber: number, deviceUdid?: string) => {
    setStoppingQualityBuild(buildNumber);
    try {
      await jenkinsApi.stopQualityBuild(buildNumber, deviceUdid ? { deviceUdid } : undefined);
      message.success(`已停止质检任务 #${buildNumber}`);
      await refreshQualitySection({ silent: true });
    } catch (err: any) {
      message.error(err?.error || err?.message || '停止质检任务失败');
    } finally {
      setStoppingQualityBuild(null);
    }
  };

  const cleanupQualityWda = async (deviceUdid?: string) => {
    if (!deviceUdid && hasRunningQualityBuild) {
      message.warning('当前有质检任务运行中，请先停止或等待任务结束后再清理 WDA');
      return;
    }
    const cleanupKey = deviceUdid || '__all__';
    setCleaningQualityWda(cleanupKey);
    try {
      const response = await jenkinsApi.cleanupQualityWda(deviceUdid ? { deviceUdid } : undefined);
      const terminated = response.data?.terminatedDeviceProcesses || 0;
      message.success(deviceUdid
        ? `已清理设备 WDA：${deviceUdid.slice(0, 12)}...${terminated ? `，终止设备进程 ${terminated} 个` : ''}`
        : `已清理本机 WDA/iproxy/xctrace${terminated ? `，终止设备进程 ${terminated} 个` : ''}`);
      await refreshQualitySection({ silent: true });
    } catch (err: any) {
      message.error(err?.error || err?.message || '清理 WDA 失败');
    } finally {
      setCleaningQualityWda(null);
    }
  };

  const previewQualityArtifact = async (title: string, url?: string) => {
    if (!url) return;
    setQualityArtifactPreviewLoading(true);
    try {
      const response = await jenkinsApi.previewQualityArtifact(url);
      setQualityPerformanceSamples(null);
      setQualityArtifactPreview({
        ...(response.data || { url, content: '' }),
        title,
      });
    } catch (err: any) {
      message.error(err?.error || err?.message || '读取结果文件失败');
    } finally {
      setQualityArtifactPreviewLoading(false);
    }
  };

  const loadQualityLogDigest = async (url?: string) => {
    if (!url) {
      setQualityLogDigest(null);
      return;
    }
    setQualityLogDigestLoading(true);
    try {
      const response = await jenkinsApi.previewQualityArtifact(url);
      setQualityLogDigest(response.data || null);
    } catch {
      setQualityLogDigest(null);
    } finally {
      setQualityLogDigestLoading(false);
    }
  };

  const openQualityPerformanceReport = async (url?: string) => {
    setActiveQualitySummaryView('performance');
    setQualityArtifactPreview(null);
    setQualityPerformanceSamples(null);
    if (!url) {
      setQualityPerformanceLoading(false);
      return;
    }
    setQualityPerformanceLoading(true);
    try {
      const response = await jenkinsApi.getQualityPerformanceSamples(url);
      setQualityPerformanceSamples(response.data || null);
    } catch (err: any) {
      message.error(err?.error || err?.message || '读取性能采样失败');
    } finally {
      setQualityPerformanceLoading(false);
    }
  };

  const openPgyerPublish = (build: JenkinsBuild) => {
    setDeployTarget('Pgyer');
    setVerificationPassword('');
    setPublishBranch(build.branchName || 'develop');
    setPublishModalOpen(true);
  };

  const openPublishModal = () => {
    if (deployTarget !== 'Pgyer') {
      setPublishBranch(getHighestReleaseBranch(branches));
    }
    setPublishModalOpen(true);
  };

  const openQualityModal = (build?: JenkinsBuild) => {
    const fallbackBuild = build || data?.builds?.find((item) => item.result === 'SUCCESS') || data?.builds?.[0] || null;
    const nextPool = sonicDevicePools.find((pool) => (pool.stats?.idle || 0) > 0)?.value || sonicDevicePools[0]?.value || 'ios-default';
    setQualitySubmitMessage('');
    setQualityBuild(fallbackBuild);
    setQualitySuite('monkey');
    setQualityMonkeyDurationSeconds(14400);
    setQualityStutterScenario('community');
    setQualityDevicePool(nextPool);
    setQualityDeviceUdids(defaultQualityDeviceUdids(nextPool));
    setQualitySkipInstall(shouldUseInstalledProductionApp(fallbackBuild));
    setQualityModalOpen(true);
  };

  const triggerQuality = async () => {
    if (!qualityBuild) {
      message.warning('请选择需要质检的构建');
      return;
    }
    if (!selectedQualityPool || availableQualityDevices.length === 0) {
      message.warning('请选择有空闲设备的设备池');
      return;
    }
    if (qualityDeviceUdids.length === 0) {
      message.warning('请至少选择一台空闲设备');
      return;
    }
    setQualitySubmitting(true);
    setQualitySubmitMessage('正在提交 Jenkins 质检任务...');
    const previousLatestQualityBuild = qualityData?.builds?.[0]?.number;
    try {
      await jenkinsApi.triggerQuality({
        buildNumber: qualityBuild.number,
        branch: qualityBuild.branchName,
        commitHash: qualityBuild.commitHash,
        appVersion: qualityBuild.appVersion,
        packageUrl: qualityBuild.installPackageUrl || qualityBuild.packageUrl,
        xcarchivePath: qualityBuild.xcarchivePath,
        archiveUrl: qualityBuild.archiveUrl,
        publishChannel: qualityBuild.publishChannel,
        testSuite: qualitySuite,
        devicePool: qualityDevicePool,
        deviceUdid: qualityDeviceUdids[0],
        monkeyDurationSeconds: qualitySuite === 'monkey' || qualitySuite === 'stutter' ? qualityMonkeyDurationSeconds : undefined,
        stutterScenario: qualitySuite === 'stutter' ? qualityStutterScenario : undefined,
        skipInstall: qualitySkipInstall,
        appBundleId: qualitySkipInstall ? PRODUCTION_BUNDLE_ID : undefined,
      });
      setQualitySubmitMessage('已提交，正在等待 Jenkins 创建任务并刷新列表...');
      message.success(`已触发自动质检任务：#${qualityBuild.number}`);
      setQualityModalOpen(false);
      setQualitySubmitMessage('');
      void refreshQualitySection();
      void refreshQualityBuildsUntilUpdated(previousLatestQualityBuild);
    } catch (err: any) {
      message.error(err?.error || err?.message || '触发自动质检失败');
      setQualitySubmitMessage('');
    } finally {
      setQualitySubmitting(false);
    }
  };

  const showBuildLog = async (build: JenkinsBuild) => {
    setLogModalOpen(true);
    setBuildDsymUploaded(null);
    setBuildFailureAnalysis(null);
    setSelectedBuildLog({ build, log: '', thirdSdkBranch: build.branchName || 'develop', thirdSdkDependencies: [] });
    setLogLoading(true);
    try {
      const response = await jenkinsApi.getBuildLog(build.number);
      setSelectedBuildLog({
        build,
        log: response.data?.log || '',
        thirdSdkBranch: response.data?.thirdSdkBranch || build.branchName || 'develop',
        thirdSdkRevision: response.data?.thirdSdkRevision,
        thirdSdkDependencies: response.data?.thirdSdkDependencies || [],
        thirdSdkMissingFiles: response.data?.thirdSdkMissingFiles || [],
        thirdSdkError: response.data?.thirdSdkError,
      });
      setBuildFailureAnalysis(response.data?.failureAnalysis || null);
    } catch (err: any) {
      message.error(err?.error || err?.message || '加载打包日志失败');
      setSelectedBuildLog({
        build,
        log: '加载打包日志失败',
        thirdSdkBranch: build.branchName || 'develop',
        thirdSdkDependencies: [],
        thirdSdkError: err?.error || err?.message || '加载打包日志失败',
      });
    } finally {
      setLogLoading(false);
    }
  };

  const analyzeSelectedBuildFailure = async (force = false) => {
    if (!selectedBuildLog) return;
    setBuildFailureAnalysisLoading(true);
    try {
      const response = await jenkinsApi.analyzeBuildFailure(selectedBuildLog.build.number, force);
      setBuildFailureAnalysis(response.data?.analysis || null);
      message.success(response.data?.cached ? '已加载保存的失败分析' : '失败分析完成');
    } catch (err: any) {
      message.error(err?.error || err?.message || '失败分析失败');
    } finally {
      setBuildFailureAnalysisLoading(false);
    }
  };

  const ensureBuildFailureAnalysis = () => {
    if (!selectedBuildLog || buildFailureAnalysis || buildFailureAnalysisLoading) return;
    if (!canAnalyzeBuildFailure(selectedBuildLog.build, selectedBuildLog.log)) return;
    void analyzeSelectedBuildFailure(false);
  };

  const handleBuildDsymUpload = async () => {
    const xcarchivePath = selectedBuildLog?.build.xcarchivePath;
    if (!xcarchivePath) {
      message.error('当前构建未记录 xcarchivePath，无法自动匹配 dSYM');
      return;
    }

    setBuildDsymUploading(true);
    setBuildDsymUploaded(null);
    try {
      const response = await dsymApi.uploadFromXcarchive(xcarchivePath);
      if (!response.success || !response.data) {
        throw new Error(response.error || '上传 dSYM 失败');
      }
      setBuildDsymUploaded(response.data);
      message.success(`主工程 dSYM 上传成功：${response.data.appName}@${response.data.version}`);
    } catch (err: any) {
      message.error(err?.error || err?.message || '上传 dSYM 失败');
    } finally {
      setBuildDsymUploading(false);
    }
  };

  const downloadBuildLog = () => {
    if (!selectedBuildLog) return;
    const blob = new Blob([selectedBuildLog.log || ''], { type: 'text/plain;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `nn-${selectedBuildLog.build.number}.log`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  useEffect(() => {
    loadBuilds();
  }, []);

  useEffect(() => {
    const nextSection = location.pathname.startsWith('/cicd/quality') ? 'quality' : 'release';
    setActiveSection(nextSection);
    if (nextSection === 'quality') {
      refreshQualitySection();
    } else {
      setQualityError('');
    }
  }, [location.pathname]);

  useEffect(() => {
    if (publishModalOpen && branches.length === 0) {
      loadBranches();
    }
  }, [publishModalOpen]);

  useEffect(() => {
    if (deployTarget !== 'Pgyer' && branches.length > 0) {
      setPublishBranch(getHighestReleaseBranch(branches));
    }
  }, [deployTarget, branches]);

  useEffect(() => {
    if (!qualityReportBuild) return;
    const latestBuild = qualityData?.builds?.find((build) => build.number === qualityReportBuild.number);
    if (!latestBuild || latestBuild === qualityReportBuild) return;
    setQualityReportBuild(latestBuild);
  }, [qualityData, qualityReportBuild]);

  useEffect(() => {
    if (!qualityReportBuild || hasQualityReportArtifact(qualityReportBuild)) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      loadQualityBuilds({ silent: true });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [
    qualityReportBuild?.number,
    qualityReportBuild?.building,
    qualityReportBuild?.result,
    qualityReportBuild?.qualitySummary?.artifacts,
  ]);

  useEffect(() => {
    if (!qualityReportBuild) {
      setQualityLogDigest(null);
      return;
    }
    loadQualityLogDigest(qualityReportBuild.qualitySummary?.artifacts?.qualityLogUrl);
  }, [
    qualityReportBuild?.number,
    qualityReportBuild?.qualitySummary?.testSuite,
    qualityReportBuild?.qualitySummary?.artifacts?.qualityLogUrl,
  ]);

  const stats = useMemo(() => data?.stats || {
    total: 0,
    running: 0,
    latestBuild: '-',
    successRate: '-',
  }, [data]);
  const previousHasRunningBuildRef = useRef(false);
  const hasRunningBuild = useMemo(
    () => (data?.builds || []).some((build) => build.building),
    [data],
  );
  const previousHasRunningQualityBuildRef = useRef(false);
  const hasRunningQualityBuild = useMemo(
    () => (qualityData?.builds || []).some((build) => isQualityBuildEffectivelyRunning(build)),
    [qualityData],
  );
  const availableQualityDevicePools = useMemo(
    () => sonicDevicePools.filter((pool) => (pool.stats?.idle ?? 0) > 0),
    [sonicDevicePools],
  );
  const selectedQualityPool = useMemo(
    () => sonicDevicePools.find((pool) => pool.value === qualityDevicePool),
    [sonicDevicePools, qualityDevicePool],
  );
  const availableQualityDevices = useMemo(
    () => (selectedQualityPool?.devices || []).filter((device) => device.status === 'idle' && device.udid),
    [selectedQualityPool],
  );

  const defaultQualityDeviceUdids = (poolValue: string) => {
    const pool = sonicDevicePools.find((item) => item.value === poolValue);
    return (pool?.devices || [])
      .filter((device) => device.status === 'idle' && device.udid)
      .slice(0, 1)
      .map((device) => device.udid);
  };

  useEffect(() => {
    if (activeSection !== 'release' || !hasRunningBuild) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      loadBuilds(filterDeployTarget, { silent: true });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [activeSection, hasRunningBuild, filterDeployTarget]);

  useEffect(() => {
    const previous = previousHasRunningBuildRef.current;
    previousHasRunningBuildRef.current = hasRunningBuild;
    if (activeSection === 'release' && previous && !hasRunningBuild) {
      loadBuilds(filterDeployTarget, { silent: true });
    }
  }, [activeSection, hasRunningBuild, filterDeployTarget]);

  useEffect(() => {
    if (activeSection !== 'quality' || !hasRunningQualityBuild) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      refreshQualitySection({ silent: true });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [activeSection, hasRunningQualityBuild]);

  useEffect(() => {
    if (activeSection !== 'quality') {
      return undefined;
    }
    const timer = window.setInterval(() => {
      loadSonicDevicePools();
    }, hasRunningQualityBuild ? 5000 : 15000);
    return () => window.clearInterval(timer);
  }, [activeSection, hasRunningQualityBuild]);

  useEffect(() => {
    const previous = previousHasRunningQualityBuildRef.current;
    previousHasRunningQualityBuildRef.current = hasRunningQualityBuild;
    if (activeSection === 'quality' && previous && !hasRunningQualityBuild) {
      loadSonicDevicePools();
    }
  }, [activeSection, hasRunningQualityBuild]);

  useEffect(() => {
    if (!qualityModalOpen) return;
    setQualityDeviceUdids((current) => {
      const availableUdids = availableQualityDevices.map((device) => device.udid);
      const next = current.filter((udid) => availableUdids.includes(udid));
      if (next.length > 0) return next;
      return availableUdids.slice(0, 1);
    });
  }, [qualityModalOpen, availableQualityDevices]);

  const publishBranchOptions = useMemo(
    () => [...branches].sort(compareBranchOptions).map((branch) => ({ value: branch, label: branch })),
    [branches],
  );
  const releaseBaseBranchOptions = useMemo(() => {
    const items = ['develop', ...getLatestReleaseBranches(branches, 2)];
    return Array.from(new Set(items)).map((branch) => ({ value: branch, label: branch }));
  }, [branches]);
  useEffect(() => {
    if (!releaseBranchModalOpen) return;
    if (!releaseBaseBranchOptions.some((option) => option.value === releaseBranchBase)) {
      setReleaseBranchBase(releaseBaseBranchOptions[0]?.value || 'develop');
    }
  }, [releaseBranchModalOpen, releaseBaseBranchOptions, releaseBranchBase]);
  const pageTitle = activeSection === 'quality' ? '自动质检' : '发布管理';
  const pageDescription = activeSection === 'quality'
    ? '构建包由 Jenkins 产出，质检任务由独立 Jenkins Job 编排，基于打包机 USB 真机覆盖安装、启动、用例、截图和报告采集。'
    : 'nn-ios Jekins构建与发布蒲公英、TestFlight、苹果商店包。';
  const qualityReportKind = getQualityReportKind(qualityReportBuild);
  const isMonkeyQualityReport = qualityReportKind === 'monkey';
  const isStutterQualityReport = qualityReportKind === 'stutter';
  const qualityReportTitle = getQualityReportTitle(qualityReportBuild);
  const qualityPerformanceButtonLabel = isStutterQualityReport ? '卡顿报告' : '性能报告';
  return (
    <div>
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
        <div>
          <Title level={4}>
            <RocketOutlined style={{ marginRight: 8, color: '#722ed1' }} />
            {pageTitle}
          </Title>
          <Paragraph type="secondary">
            {pageDescription}
          </Paragraph>
        </div>
        {activeSection === 'release' ? (
          <Space>
            <Button icon={<ExportOutlined />} onClick={() => openExternalUrl(data?.job.url || `${window.location.protocol}//${window.location.hostname}:8080/job/nn/`)}>
              打开 Jenkins
            </Button>
            <Button icon={<BranchesOutlined />} onClick={openReleaseBranchModal}>
              拉取新分支
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => loadBuilds()} loading={loading}>
              刷新
            </Button>
            <Button type="primary" icon={<PlayCircleOutlined />} loading={publishing} onClick={openPublishModal}>
              发布
            </Button>
          </Space>
        ) : (
          <Space>
            <Button icon={<SettingOutlined />} loading={qualityJobSyncing} onClick={syncQualityJobConfig}>
              同步 Jenkins 配置
            </Button>
            <Button icon={<SettingOutlined />} onClick={openDevicePoolModal}>
              设备池
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => refreshQualitySection()} loading={qualityLoading}>
              刷新
            </Button>
            <Button type="primary" icon={<RocketOutlined />} onClick={() => openQualityModal()} disabled={!data?.builds?.length}>
              开始质检
            </Button>
          </Space>
        )}
      </div>

      {activeSection === 'release' ? (
        <>
                {error && (
                  <Alert
                    type="error"
                    showIcon
                    message="Jenkins 操作失败"
                    description={error}
                    style={{ marginBottom: 16 }}
                  />
                )}

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {[
          { label: '最近构建数', value: stats.total, color: '#1677ff' },
          { label: '运行中', value: stats.running, color: '#52c41a' },
          { label: '最新构建', value: stats.latestBuild, color: '#722ed1' },
          { label: '成功率', value: stats.successRate, color: '#faad14' },
        ].map((stat) => (
          <Col xs={12} sm={6} key={stat.label}>
            <Card size="small" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 'bold', color: stat.color }}>{stat.value}</div>
              <div style={{ color: '#999', fontSize: 13 }}>{stat.label}</div>
            </Card>
          </Col>
        ))}
      </Row>

      <Card
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
            <Space>
              <span>构建列表</span>
              {data?.job.fullName && <Tag color="blue">{data.job.fullName}</Tag>}
              {data?.job.buildable === false && <Tag color="red">不可构建</Tag>}
            </Space>
            <Space>
              <Text type="secondary">发布渠道</Text>
              <Select
                size="small"
                value={filterDeployTarget}
                style={{ width: 130 }}
                options={[
                  { label: '全部', value: '' },
                  ...DEPLOY_TARGET_OPTIONS,
                ]}
                onChange={(value) => {
                  setFilterDeployTarget(value);
                  loadBuilds(value);
                }}
              />
            </Space>
          </div>
        }
      >
        <Table<JenkinsBuild>
          rowKey="number"
          loading={loading}
          dataSource={data?.builds || []}
          tableLayout="fixed"
          scroll={{ x: 1280 }}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          columns={[
            {
              title: '构建',
              dataIndex: 'number',
              key: 'number',
              width: 90,
              render: (number: number, record) => (
                <Button type="link" onClick={() => openExternalUrl(record.url)}>
                  #{number}
                </Button>
              ),
            },
            {
              title: '发布渠道',
              dataIndex: 'publishChannel',
              key: 'publishChannel',
              width: 120,
              render: (value?: string) => value ? <Tag color="blue">{publishChannelLabel(value)}</Tag> : <Text type="secondary">-</Text>,
            },
            {
              title: '分支名',
              dataIndex: 'branchName',
              key: 'branchName',
              width: 150,
              ellipsis: true,
              render: (value?: string) => value ? <Tag>{value}</Tag> : <Text type="secondary">-</Text>,
            },
            {
              title: 'Commit Hash',
              dataIndex: 'commitHash',
              key: 'commitHash',
              width: 130,
              render: (value?: string) => value ? <Text code title={value}>{value.slice(0, 6)}</Text> : <Text type="secondary">-</Text>,
            },
            {
              title: '渠道构建号',
              key: 'buildNumber',
              width: 120,
              render: (_, record) => getChannelBuildNumber(record) || <Text type="secondary">-</Text>,
            },
            {
              title: 'APP版本',
              dataIndex: 'appVersion',
              key: 'appVersion',
              width: 120,
              render: (value?: string) => value ? <Tag color="purple">{value}</Tag> : <Text type="secondary">-</Text>,
            },
            {
              title: '渠道二维码',
              dataIndex: 'channelQrUrl',
              key: 'channelQrUrl',
              width: 110,
              render: (value: string | undefined, record) => value ? (
                <button
                  type="button"
                  onClick={() => setQrPreview({
                    url: value,
                    channel: record.publishChannel,
                    buildNumber: getChannelBuildNumber(record),
                  })}
                  style={{
                    width: 64,
                    height: 64,
                    padding: 0,
                    border: '1px solid #f0f0f0',
                    borderRadius: 4,
                    background: '#fff',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title="打开二维码地址"
                >
                  <QRCode value={value} size={56} bordered={false} />
                </button>
              ) : <Text type="secondary">-</Text>,
            },
            {
              title: '状态',
              key: 'result',
              width: 100,
              render: (_, record) => resultTag(record),
            },
            {
              title: '开始时间',
              dataIndex: 'timestamp',
              key: 'timestamp',
              width: 170,
              render: formatBuildTime,
            },
            {
              title: '耗时',
              key: 'duration',
              width: 100,
              render: (_, record) => formatDuration(record.duration, record.building),
            },
            {
              title: '操作',
              key: 'action',
              width: 270,
              render: (_, record) => (
                <Space size={8}>
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    disabled={!record.archiveUrl}
                    onClick={() => openExternalUrl(record.archiveUrl)}
                  >
                    下载
                  </Button>
                  <Button size="small" icon={<FileTextOutlined />} onClick={() => showBuildLog(record)}>
                    详情
                  </Button>
                  <Button size="small" icon={<RocketOutlined />} onClick={() => openQualityModal(record)}>
                    质检
                  </Button>
                  {record.publishChannel === 'Pgyer' && (
                    <Button size="small" type="primary" ghost icon={<PlayCircleOutlined />} onClick={() => openPgyerPublish(record)}>
                      发布
                    </Button>
                  )}
                  {record.building && (
                    <Popconfirm
                      title="取消构建？"
                      description={`确定要取消 #${record.number} 吗？`}
                      okText="取消构建"
                      cancelText="关闭"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => stopBuild(record.number)}
                    >
                      <Button
                        size="small"
                        danger
                        icon={<StopOutlined />}
                        loading={stoppingBuild === record.number}
                      >
                        取消
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>
        </>
      ) : (
        <>
                {qualityError && (
                  <Alert
                    type="error"
                    showIcon
                    message="自动质检操作失败"
                    description={qualityError}
                    style={{ marginBottom: 16 }}
                  />
                )}
                <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
                  {[
                    { label: '质检任务数', value: qualityData?.stats.total || 0, color: '#1677ff' },
                    { label: '运行中', value: qualityData?.stats.running || 0, color: '#52c41a' },
                    { label: '最新质检', value: qualityData?.stats.latestBuild || '-', color: '#722ed1' },
                    { label: '通过率', value: qualityData?.stats.successRate || '-', color: '#faad14' },
                  ].map((stat) => (
                    <Col xs={12} sm={6} key={stat.label}>
                      <Card size="small" style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 28, fontWeight: 'bold', color: stat.color }}>{stat.value}</div>
                        <div style={{ color: '#999', fontSize: 13 }}>{stat.label}</div>
                      </Card>
                    </Col>
                  ))}
                </Row>
                <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
                  {devicePoolStatus?.detector && !devicePoolStatus.detector.available && (
                    <Col span={24}>
                      <Alert
                        type="warning"
                        showIcon
                        message="无法检测本机 iOS 设备在线状态"
                        description={devicePoolStatus.detector.error}
                      />
                    </Col>
                  )}
                  {(devicePoolStatus?.unassignedDevices || []).length > 0 && (
                    <Col span={24}>
                      <Alert
                        type="info"
                        showIcon
                        message="检测到未加入设备池的在线设备"
                        description={(devicePoolStatus?.unassignedDevices || []).map((device) => `${device.udid}${device.marketName ? ` ${device.marketName}` : ''}`).join('；')}
                        action={(
                          <Space>
                            <Select
                              size="small"
                              value={unassignedTargetPool}
                              style={{ width: 160 }}
                              options={sonicDevicePools.map((pool) => ({ label: pool.label, value: pool.value }))}
                              onChange={setUnassignedTargetPool}
                            />
                            <Button size="small" type="primary" loading={devicePoolAdding} onClick={addUnassignedDevicesToPool}>
                              加入设备池
                            </Button>
                          </Space>
                        )}
                      />
                    </Col>
                  )}
                  {sonicDevicePools.map((pool) => (
                    <Col xs={24} md={8} key={pool.value}>
                      <Card size="small" title={pool.label}>
                        <Space direction="vertical" size={8}>
                          <Space wrap>
                            <Tag color="blue">{pool.value}</Tag>
                            {(pool.devices?.length || pool.deviceId || pool.groupId) && (
                              <Tag color="purple">设备 {pool.devices?.length || 1} 台</Tag>
                            )}
                            {pool.stats && <Tag color="green">空闲 {pool.stats.idle}</Tag>}
                            {pool.stats && pool.stats.busy > 0 && <Tag color="orange">占用 {pool.stats.busy}</Tag>}
                            {pool.stats && pool.stats.offline > 0 && <Tag color="red">离线 {pool.stats.offline}</Tag>}
                          </Space>
                          {(pool.devices?.length ? pool.devices : (pool.deviceId || pool.groupId ? [{ udid: pool.deviceId || pool.groupId || '' }] : [])).slice(0, 4).map((device) => (
                            <Space key={device.udid} size={4} wrap>
                              {deviceStatusTag(device.status)}
                              <Text code style={{ fontSize: 12 }}>{device.udid}</Text>
                              {(device.marketName || device.productVersion) && (
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {[device.marketName, device.productVersion].filter(Boolean).join(' / ')}
                                </Text>
                              )}
                              {device.activeBuildNumber && <Tag>#{device.activeBuildNumber}</Tag>}
                            </Space>
                          ))}
                          <Text type="secondary">{pool.description}</Text>
                        </Space>
                      </Card>
                    </Col>
                  ))}
                  {sonicDevicePools.length === 0 && (
                    <Col span={24}>
                      <Alert type="warning" showIcon message="暂无质检设备池配置" />
                    </Col>
                  )}
                </Row>
                <Card
                  title={
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
                      <Space>
                        <span>质检任务列表</span>
                        {qualityData?.job.fullName && <Tag color="blue">{qualityData.job.fullName}</Tag>}
                        {qualityData?.job.buildable === false && <Tag color="red">不可构建</Tag>}
                      </Space>
                      <Button type="primary" icon={<RocketOutlined />} onClick={() => openQualityModal()} disabled={!data?.builds?.length}>
                        新建质检
                      </Button>
                    </div>
                  }
                >
                  <Table<JenkinsQualityBuild>
                    rowKey="number"
                    loading={qualityLoading}
                    dataSource={qualityData?.builds || []}
                    tableLayout="fixed"
                    scroll={{ x: 1480 }}
                    pagination={{ pageSize: 10, showSizeChanger: false }}
                    columns={[
                      {
                        title: '质检任务',
                        dataIndex: 'number',
                        key: 'number',
                        width: 120,
                        render: (number: number, record) => (
                          <Button type="link" onClick={() => openExternalUrl(record.url)}>
                            #{number}
                          </Button>
                        ),
                      },
                      {
                        title: '来源构建',
                        key: 'sourceBuildNumber',
                        width: 110,
                        render: (_, record) => record.qualitySummary?.sourceBuildNumber ? (
                          <Tag color="blue">#{record.qualitySummary.sourceBuildNumber}</Tag>
                        ) : <Text type="secondary">-</Text>,
                      },
                      {
                        title: '发布渠道',
                        key: 'publishChannel',
                        width: 110,
                        render: (_, record) => record.qualitySummary?.publishChannel ? (
                          <Tag>{publishChannelLabel(record.qualitySummary.publishChannel)}</Tag>
                        ) : <Text type="secondary">-</Text>,
                      },
                      {
                        title: 'APP版本',
                        key: 'appVersion',
                        width: 110,
                        render: (_, record) => record.qualitySummary?.appVersion ? (
                          <Tag color="purple">{record.qualitySummary.appVersion}</Tag>
                        ) : <Text type="secondary">-</Text>,
                      },
                      {
                        title: '测试套件',
                        key: 'testSuite',
                        width: 140,
                        render: (_, record) => {
                          const label = qualitySuiteLabel(record.qualitySummary);
                          if (label === '-') return <Text type="secondary">-</Text>;
                          return <Tag color={record.qualitySummary?.testSuite === 'stutter' ? 'orange' : 'default'}>{label}</Tag>;
                        },
                      },
                      {
                        title: '设备',
                        key: 'device',
                        width: 180,
                        ellipsis: true,
                        render: (_, record) => (
                          <Space direction="vertical" size={0}>
                            <Text>{record.qualitySummary?.devicePoolLabel || record.qualitySummary?.devicePool || '-'}</Text>
                            {record.qualitySummary?.deviceUdid && (
                              <Text type="secondary" style={{ fontSize: 12 }} title={record.qualitySummary.deviceUdid}>
                                {record.qualitySummary.deviceUdid.slice(0, 12)}...
                              </Text>
                            )}
                          </Space>
                        ),
                      },
                      {
                        title: '状态',
                        key: 'result',
                        width: 140,
                        render: (_, record) => {
                          const phaseLabel = qualityPhaseLabel(record);
                          return (
                            <Space direction="vertical" size={2}>
                              {qualityResultTag(record)}
                              {phaseLabel && (
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {isQualityBuildEffectivelyRunning(record) ? '当前阶段' : '阶段'}：{phaseLabel}
                                </Text>
                              )}
                            </Space>
                          );
                        },
                      },
                      {
                        title: '进度',
                        key: 'progress',
                        width: 230,
                        render: (_, record) => {
                          const progress = record.qualitySummary?.progress;
                          if (!record.building && !progress) {
                            return <Text type="secondary">-</Text>;
                          }
                          const percent = progressPercent(record);
                          const perf = progress?.recentPerformance;
                          const remainingSeconds = progressRemainingSeconds(record);
                          const summaryStatus = String(record.qualitySummary?.status || '').toLowerCase();
                          const isPassed = ['passed', 'success'].includes(summaryStatus);
                          const progressMessage = isPassed ? '质检完成' : progress?.message;
                          return (
                            <Space direction="vertical" size={2} style={{ width: '100%' }}>
                              <Progress percent={percent} size="small" status={progressStatus(record)} />
                              {progressMessage && (
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {!isPassed && qualityPhaseLabel(record) ? `${qualityPhaseLabel(record)}：` : ''}{progressMessage}
                                </Text>
                              )}
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                {progress?.executedEvents || 0} 次 / 已运行 {formatSeconds(progressElapsedSeconds(record))}
                                {remainingSeconds !== null && remainingSeconds !== undefined ? ` / 剩余 ${formatSeconds(remainingSeconds)}` : ''}
                              </Text>
                              {(perf?.cpu !== null && perf?.cpu !== undefined) || (perf?.memoryMB !== null && perf?.memoryMB !== undefined) || (perf?.fps !== null && perf?.fps !== undefined) ? (
                                <Space size={4} wrap>
                                  {perf?.cpu !== null && perf?.cpu !== undefined && <Tag>CPU {perf.cpu}%</Tag>}
                                  {perf?.memoryMB !== null && perf?.memoryMB !== undefined && <Tag>内存 {perf.memoryMB}MB</Tag>}
                                  {perf?.fps !== null && perf?.fps !== undefined && <Tag>FPS {perf.fps}</Tag>}
                                </Space>
                              ) : null}
                            </Space>
                          );
                        },
                      },
                      {
                        title: '开始时间',
                        dataIndex: 'timestamp',
                        key: 'timestamp',
                        width: 180,
                        render: formatBuildTime,
                      },
                      {
                        title: '操作',
                        key: 'action',
                        width: 180,
                        render: (_, record) => (
                          <Space size={8}>
                            <Button
                              size="small"
                              icon={<FileTextOutlined />}
                              onClick={() => {
                                void openQualityReport(record);
                              }}
                            >
                              报告
                            </Button>
                            {isQualityBuildEffectivelyRunning(record) && (
                              <Popconfirm
                                title="停止质检任务？"
                                description={`确定要停止 #${record.number} 吗？`}
                                okText="停止"
                                cancelText="关闭"
                                okButtonProps={{ danger: true }}
                                onConfirm={() => stopQualityBuild(record.number, record.qualitySummary?.deviceUdid)}
                              >
                                <Button
                                  size="small"
                                  danger
                                  icon={<StopOutlined />}
                                  loading={stoppingQualityBuild === record.number}
                                >
                                  停止
                                </Button>
                              </Popconfirm>
                            )}
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Card>
        </>
      )}

      <Modal
        title="拉取新分支"
        open={releaseBranchModalOpen}
        okText="开始拉取"
        cancelText="关闭"
        confirmLoading={releaseBranchCreating}
        onOk={createReleaseBranch}
        onCancel={() => {
          if (releaseBranchCreating) return;
          setReleaseBranchModalOpen(false);
        }}
        cancelButtonProps={{ disabled: releaseBranchCreating }}
        closable={!releaseBranchCreating}
        maskClosable={!releaseBranchCreating}
        width={720}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <Text strong>新分支名称</Text>
            <Input
              value={releaseBranchName}
              disabled={releaseBranchCreating}
              onChange={(event) => setReleaseBranchName(event.target.value)}
              placeholder="例如 release/5.15.0"
              style={{ marginTop: 8 }}
            />
          </div>
          <div>
            <Text strong>基准分支</Text>
            <Select
              value={releaseBranchBase}
              options={releaseBaseBranchOptions}
              disabled={releaseBranchCreating}
              loading={branchLoading}
              onChange={setReleaseBranchBase}
              placeholder="请选择基准分支"
              notFoundContent={branchLoading ? '正在加载分支...' : '未找到 release 分支'}
              style={{ marginTop: 8, width: '100%' }}
            />
            <Button size="small" type="link" onClick={loadBranches} loading={branchLoading} disabled={releaseBranchCreating} style={{ paddingInline: 0, marginTop: 4 }}>
              刷新分支列表
            </Button>
          </div>
          {releaseBranchLog && (
            <pre
              style={{
                margin: 0,
                maxHeight: 280,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 12,
                lineHeight: 1.5,
                background: '#fafafa',
                padding: 12,
                border: '1px solid #f0f0f0',
                borderRadius: 4,
              }}
            >
              {releaseBranchLog}
            </pre>
          )}
        </Space>
      </Modal>

      <Modal
        title="选择发布分支和渠道"
        open={publishModalOpen}
        okText="发布"
        cancelText="取消"
        confirmLoading={publishing}
        onOk={publish}
        onCancel={() => setPublishModalOpen(false)}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <Text strong>发布分支</Text>
            {deployTarget === 'Pgyer' ? (
              <AutoComplete
                value={publishBranch}
                options={publishBranchOptions}
                onChange={setPublishBranch}
                placeholder="请输入分支名，如 develop 或 release/5.14.7"
                style={{ marginTop: 8, width: '100%' }}
                filterOption={(inputValue, option) =>
                  String(option?.value || '').toLowerCase().includes(inputValue.toLowerCase())
                }
              />
            ) : (
              <Input
                value={publishBranch || '未找到 release/x.x.x 分支'}
                readOnly
                status={publishBranch ? undefined : 'warning'}
                style={{ marginTop: 8 }}
              />
            )}
            <Space style={{ marginTop: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {branchLoading
                  ? '正在加载分支列表...'
                  : deployTarget === 'Pgyer'
                    ? '可选择已有分支，也可直接输入分支名'
                    : 'TestFlight / 苹果商店自动使用当前 release/ 下最高版本分支'}
              </Text>
              <Button size="small" type="link" onClick={loadBranches} loading={branchLoading}>
                刷新分支
              </Button>
            </Space>
          </div>
          <div>
            <Text strong>发布渠道</Text>
          </div>
          <Radio.Group
            optionType="button"
            buttonStyle="solid"
            options={DEPLOY_TARGET_OPTIONS}
            value={deployTarget}
            onChange={(event) => {
              const nextTarget = event.target.value as DeployTarget;
              setDeployTarget(nextTarget);
              if (nextTarget !== 'Pgyer') {
                setPublishBranch(getHighestReleaseBranch(branches));
              }
              if (nextTarget === 'Pgyer') {
                setVerificationPassword('');
              }
            }}
          />
          {deployTarget !== 'Pgyer' && (
            <Input.Password
              placeholder="请输入验证密码"
              value={verificationPassword}
              onChange={(event) => setVerificationPassword(event.target.value)}
            />
          )}
          <Alert
            type={deployTarget === 'Pgyer' ? 'info' : 'warning'}
            showIcon
            message={deployTarget === 'Pgyer' ? '蒲公英发布无需验证密码' : 'TestFlight / 苹果商店发布需要验证密码'}
          />
        </Space>
      </Modal>

      <Modal
        title="自动质检"
        open={qualityModalOpen}
        okText="开始质检"
        cancelText="取消"
        confirmLoading={qualitySubmitting}
        onOk={triggerQuality}
        cancelButtonProps={{ disabled: qualitySubmitting }}
        closable={!qualitySubmitting}
        maskClosable={!qualitySubmitting}
        onCancel={() => {
          if (qualitySubmitting) return;
          setQualitySubmitMessage('');
          setQualityModalOpen(false);
        }}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {qualitySubmitting && (
            <Alert
              type="info"
              showIcon
              message={qualitySubmitMessage || '正在提交 Jenkins 质检任务...'}
              description="Jenkins 创建构建需要一点时间，任务出现在列表后弹窗会自动关闭。"
            />
          )}
          <div>
            <Text strong>质检构建</Text>
            <Select
              value={qualityBuild?.number}
              disabled={qualitySubmitting}
              style={{ marginTop: 8, width: '100%' }}
              placeholder="请选择构建"
              options={(data?.builds || []).map((build) => ({
                value: build.number,
                label: [
                  `#${build.number}`,
                  publishChannelLabel(build.publishChannel) || '未知渠道',
                  build.branchName || '-',
                  build.appVersion || '',
                ].filter(Boolean).join(' '),
              }))}
              onChange={(value) => {
                const nextBuild = (data?.builds || []).find((build) => build.number === value) || null;
                setQualityBuild(nextBuild);
                setQualitySkipInstall(shouldUseInstalledProductionApp(nextBuild));
              }}
            />
          </div>
          <div>
            <Text strong>测试套件</Text>
            <Radio.Group
              value={qualitySuite}
              disabled={qualitySubmitting}
              onChange={(event) => setQualitySuite(event.target.value)}
              style={{ display: 'block', marginTop: 8 }}
            >
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {QUALITY_SUITE_GROUPS.map((group) => (
                  <div
                    key={group.title}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '132px 1fr',
                      columnGap: 8,
                      alignItems: 'start',
                    }}
                  >
                    <Text type="secondary">{group.title}</Text>
                    <Space wrap size={[16, 8]} align="center">
                      {group.options.map((option) => (
                        <Radio key={option.value} value={option.value}>
                          {option.label}
                        </Radio>
                      ))}
                    </Space>
                  </div>
                ))}
              </Space>
            </Radio.Group>
          </div>
          {(qualitySuite === 'monkey' || qualitySuite === 'stutter') && (
            <div>
              <Text strong>{qualitySuite === 'stutter' ? '卡顿检测时长' : 'Monkey 执行时长'}</Text>
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                options={MONKEY_DURATION_OPTIONS}
                value={qualityMonkeyDurationSeconds}
                disabled={qualitySubmitting}
                onChange={(event) => setQualityMonkeyDurationSeconds(event.target.value)}
                style={{ display: 'block', marginTop: 8 }}
              />
            </div>
          )}
          {qualitySuite === 'stutter' && (
            <div>
              <Text strong>卡顿检测场景</Text>
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                options={STUTTER_SCENARIO_OPTIONS}
                value={qualityStutterScenario}
                disabled={qualitySubmitting}
                onChange={(event) => setQualityStutterScenario(event.target.value)}
                style={{ display: 'block', marginTop: 8 }}
              />
            </div>
          )}
          <div>
            <Checkbox
              checked={qualitySkipInstall}
              disabled={qualitySubmitting}
              onChange={(event) => setQualitySkipInstall(event.target.checked)}
            >
              使用设备上已安装的 App
            </Checkbox>
          </div>
          <div>
            <Text strong>设备池（空闲）</Text>
            {availableQualityDevicePools.length === 0 && (
              <Alert
                type="warning"
                showIcon
                message="当前没有空闲设备池"
                style={{ marginTop: 8 }}
              />
            )}
          </div>
          {availableQualityDevices.length > 0 && (
            <div>
              <Checkbox.Group
                value={qualityDeviceUdids}
                disabled={qualitySubmitting}
                onChange={(values) => setQualityDeviceUdids(values as string[])}
                style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}
              >
                {availableQualityDevices.map((device) => (
                  <Checkbox key={device.udid} value={device.udid}>
                    <Space size={6} wrap>
                      <Text>{device.marketName || device.name || 'iPhone'}</Text>
                      {device.productVersion && <Tag>{device.productVersion}</Tag>}
                      <Text code style={{ fontSize: 12 }}>{device.udid}</Text>
                    </Space>
                  </Checkbox>
                ))}
              </Checkbox.Group>
            </div>
          )}
        </Space>
      </Modal>

      <Modal
        title={qualityReportBuild ? `质检报告 - #${qualityReportBuild.number}` : '质检报告'}
        open={!!qualityReportBuild}
        width="78vw"
        footer={(
          <Space>
            {qualityReportBuild?.qualitySummary?.artifacts?.qualityLogUrl && (
              <Button
                icon={<DownloadOutlined />}
                onClick={() => openExternalUrl(qualityReportBuild.qualitySummary?.artifacts?.qualityLogUrl)}
              >
                下载日志
              </Button>
            )}
            {qualityReportBuild?.qualitySummary?.artifacts?.junitUrl && (
              <Button
                onClick={() => openExternalUrl(qualityReportBuild.qualitySummary?.artifacts?.junitUrl)}
              >
                下载 JUnit
              </Button>
            )}
            <Button onClick={() => {
              setQualityReportBuild(null);
              setActiveQualitySummaryView('performance');
              setQualityArtifactPreview(null);
              setQualityLogDigest(null);
              setQualityPerformanceSamples(null);
            }}>关闭</Button>
          </Space>
        )}
        onCancel={() => {
          setQualityReportBuild(null);
          setActiveQualitySummaryView('performance');
          setQualityArtifactPreview(null);
          setQualityLogDigest(null);
          setQualityPerformanceSamples(null);
        }}
      >
        {qualityReportBuild && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {(() => {
              const statusMeta = qualitySummaryStatusMeta(qualityReportBuild);
              return (
                <Alert
                  type={statusMeta.type}
                  showIcon
                  message={qualityReportBuild.qualitySummary?.message || statusMeta.message}
                  description={(
                    <Space wrap>
                      {qualityReportBuild.qualitySummary?.sourceBuildNumber && <Tag color="blue">来源构建 #{qualityReportBuild.qualitySummary.sourceBuildNumber}</Tag>}
                      {qualityReportBuild.qualitySummary?.appVersion && <Tag color="purple">APP {qualityReportBuild.qualitySummary.appVersion}</Tag>}
                      {qualityReportBuild.qualitySummary?.testSuite && <Tag>套件 {qualityReportBuild.qualitySummary.testSuite}</Tag>}
                      {qualityReportBuild.qualitySummary?.testSuite === 'stutter' && qualityReportBuild.qualitySummary?.stutterScenario && (
                        <Tag color="magenta">场景 {stutterScenarioLabel(qualityReportBuild.qualitySummary.stutterScenario)}</Tag>
                      )}
                      <Tag>耗时 {formatQualityDuration(qualityReportBuild)}</Tag>
                      {qualityReportBuild.qualitySummary?.monkeyStatus && (
                        <Tag color={qualityReportBuild.qualitySummary.monkeyStatus === 'passed' ? 'green' : 'red'}>
                          Monkey {formatMonkeyExecutionSummary(qualityReportBuild)}
                        </Tag>
                      )}
                      <Button type="link" size="small" onClick={() => openExternalUrl(qualityReportBuild.url)}>
                        Jenkins #{qualityReportBuild.number}
                      </Button>
                    </Space>
                  )}
                />
              );
            })()}

            <Card
              size="small"
              title={qualityReportTitle}
              extra={qualityReportBuild.qualitySummary?.artifacts?.summaryUrl && (
                    <Button
                      size="small"
                      type="link"
                      onClick={() => {
                        setActiveQualitySummaryView('summary');
                        previewQualityArtifact('summary.json', qualityReportBuild.qualitySummary?.artifacts?.summaryUrl);
                      }}
                    >
                      summary.json
                    </Button>
              )}
            >
                  <Space wrap>
                    <Button
                      disabled={!qualityReportBuild.qualitySummary?.performanceAnalysis && !qualityReportBuild.qualitySummary?.artifacts?.performanceSamplesUrl && !qualityReportBuild.qualitySummary?.artifacts?.performanceTraceUrl}
                      loading={qualityPerformanceLoading}
                      type={activeQualitySummaryView === 'performance' ? 'primary' : 'default'}
                      onClick={() => openQualityPerformanceReport(qualityReportBuild.qualitySummary?.artifacts?.performanceSamplesUrl)}
                    >
                      {qualityPerformanceButtonLabel}
                    </Button>
                    {isMonkeyQualityReport && (
                      <Button
                        disabled={!qualityReportBuild.qualitySummary?.artifacts?.monkeyReportUrl}
                        loading={qualityArtifactPreviewLoading && qualityArtifactPreview?.title === 'Monkey 报告'}
                        type={activeQualitySummaryView === 'monkey' ? 'primary' : 'default'}
                        onClick={() => {
                          setActiveQualitySummaryView('monkey');
                          previewQualityArtifact('Monkey 报告', qualityReportBuild.qualitySummary?.artifacts?.monkeyReportUrl);
                        }}
                      >
                        Monkey 报告
                      </Button>
                    )}
                    <Button
                      disabled={!qualityReportBuild.qualitySummary?.exceptionAnalysis}
                      type={activeQualitySummaryView === 'crash' ? 'primary' : 'default'}
                      onClick={() => {
                        setActiveQualitySummaryView('crash');
                        setQualityArtifactPreview(null);
                      }}
                    >
                      崩溃分析
                    </Button>
                    <Button
                      icon={<FileTextOutlined />}
                      disabled={!qualityReportBuild.qualitySummary?.artifacts?.qualityLogUrl}
                      type={activeQualitySummaryView === 'log' ? 'primary' : 'default'}
                      onClick={() => {
                        setActiveQualitySummaryView('log');
                        setQualityArtifactPreview(null);
                      }}
                    >
                      质检日志
                    </Button>
                    {isMonkeyQualityReport && (
                      <Button
                        disabled={!qualityReportBuild.qualitySummary?.artifacts?.screenshotUrl}
                        type={activeQualitySummaryView === 'evidence' ? 'primary' : 'default'}
                        onClick={() => {
                          setActiveQualitySummaryView('evidence');
                          setQualityArtifactPreview(null);
                        }}
                      >
                        现场证据
                      </Button>
                    )}
                  </Space>
                  {activeQualitySummaryView === 'log' && (
                    <Space direction="vertical" size={16} style={{ width: '100%', marginTop: 16 }}>
                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        <Text strong>质检日志</Text>
                        <QualityLogDigest
                          preview={qualityLogDigest}
                          loading={qualityLogDigestLoading}
                        />
                      </Space>
                    </Space>
                  )}
                  {activeQualitySummaryView === 'crash' && (
                    <Card size="small" title="崩溃分析" style={{ marginTop: 16 }}>
                      <CrashAnalysisSummary
                        analysis={qualityReportBuild.qualitySummary?.exceptionAnalysis}
                        crashReportsUrl={qualityReportBuild.qualitySummary?.artifacts?.crashReportsUrl}
                      />
                    </Card>
                  )}
                  {activeQualitySummaryView === 'monkey' && isMonkeyQualityReport && (
                    <Card
                      size="small"
                      title="Monkey 报告"
                      extra={qualityArtifactPreview?.url && (
                        <Button size="small" type="link" onClick={() => openExternalUrl(qualityArtifactPreview.url)}>
                          打开原文件
                        </Button>
                      )}
                      style={{ marginTop: 16 }}
                    >
                      <MonkeyReportSummary
                        preview={qualityArtifactPreview}
                        loading={qualityArtifactPreviewLoading}
                      />
                    </Card>
                  )}
                  {activeQualitySummaryView === 'summary' && qualityArtifactPreview && (
                    <Card
                      size="small"
                      title={(
                        <Space>
                          <Text>{qualityArtifactPreview.title}</Text>
                          {qualityArtifactPreview.format && <Tag>{qualityArtifactPreview.format}</Tag>}
                          {qualityArtifactPreview.truncated && <Tag color="orange">已截断</Tag>}
                        </Space>
                      )}
                      extra={(
                        <Space>
                          <Button size="small" type="link" onClick={() => openExternalUrl(qualityArtifactPreview.url)}>
                            打开原文件
                          </Button>
                          <Button size="small" type="text" onClick={() => setQualityArtifactPreview(null)}>
                            收起
                          </Button>
                        </Space>
                      )}
                      style={{ marginTop: 16 }}
                    >
                      <pre
                        style={{
                          margin: 0,
                          maxHeight: 420,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          fontSize: 12,
                          lineHeight: 1.5,
                          background: '#fafafa',
                          padding: 12,
                          border: '1px solid #f0f0f0',
                          borderRadius: 4,
                        }}
                      >
                        {qualityArtifactPreview.content || '文件内容为空'}
                      </pre>
	                    </Card>
	                  )}
                  {activeQualitySummaryView === 'evidence' && isMonkeyQualityReport && (
                    <Card size="small" title="现场证据" style={{ marginTop: 16 }}>
                      {qualityReportBuild.qualitySummary?.artifacts?.screenshotUrl ? (
                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                          <Image
                            src={qualityReportBuild.qualitySummary.artifacts.screenshotUrl}
                            alt="质检截图"
                            style={{ maxHeight: 520, objectFit: 'contain' }}
                          />
                        </Space>
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次任务未归档截图" />
                      )}
                    </Card>
                  )}
                  {activeQualitySummaryView === 'performance' && (
                    <Card
                      size="small"
                      title={(
                        <Space>
                          <Text>{qualityPerformanceButtonLabel}</Text>
                          {qualityPerformanceSamples && <Tag>jsonl</Tag>}
                        </Space>
                      )}
                      extra={(
                        <Space>
                          {!isStutterQualityReport && qualityPerformanceSamples?.url && (
                            <Button size="small" type="link" onClick={() => openExternalUrl(qualityPerformanceSamples.url)}>
                              采样原文件
                            </Button>
                          )}
                          {qualityReportBuild.qualitySummary?.artifacts?.performanceTraceUrl && (
                            <Button size="small" type="link" onClick={() => openPerformanceTrace(qualityReportBuild.qualitySummary?.artifacts?.performanceTraceUrl)}>
                              下载 Trace
                            </Button>
                          )}
                          <Button size="small" type="text" onClick={() => {
                            setQualityPerformanceSamples(null);
                            setActiveQualitySummaryView('log');
                          }}>
                            收起
                          </Button>
                        </Space>
                      )}
                      style={{ marginTop: 16 }}
                    >
                      {isStutterQualityReport ? (
                        <StutterReportSummary
                          analysis={qualityReportBuild.qualitySummary?.performanceAnalysis}
                        />
                      ) : (
                        <Space direction="vertical" size={16} style={{ width: '100%' }}>
                          <Space direction="vertical" size={8} style={{ width: '100%' }}>
                            <Text strong>{isMonkeyQualityReport ? '结论' : '分析总结'}</Text>
                            <PerformanceAnalysisSummary
                              analysis={qualityReportBuild.qualitySummary?.performanceAnalysis}
                              reportKind={qualityReportKind}
                            />
                          </Space>
                          <Space direction="vertical" size={8} style={{ width: '100%' }}>
                            <Text strong>{isMonkeyQualityReport ? '性能观察' : '性能诊断'}</Text>
                            <PerformanceDiagnostics
                              samples={qualityPerformanceSamples}
                              analysis={qualityReportBuild.qualitySummary?.performanceAnalysis}
                              loading={qualityPerformanceLoading}
                              reportKind={qualityReportKind}
                            />
                          </Space>
                          <Space direction="vertical" size={8} style={{ width: '100%' }}>
                            <Text strong>{isMonkeyQualityReport ? '性能趋势' : '性能分析图'}</Text>
                            {qualityPerformanceLoading ? (
                              <Alert showIcon type="info" message="正在加载性能采样..." />
                            ) : qualityPerformanceSamples?.samples?.length ? (
                              <PerformanceSamplesChart data={qualityPerformanceSamples} reportKind={qualityReportKind} />
                            ) : qualityReportBuild.qualitySummary?.performanceAnalysis?.trace?.available ? (
                              <Alert
                                showIcon
                                type="info"
                                message={isMonkeyQualityReport ? 'Trace 已采集，暂无 CPU / 内存趋势' : 'Trace 已采集，暂无可绘制指标'}
                                description={isMonkeyQualityReport
                                  ? 'Monkey 测试不需要 FPS/帧级卡顿数据；当前缺少 CPU / 内存采样明细，所以无法绘制基础趋势。可下载 Trace 用 Instruments 查看原始录制。'
                                  : (isStutterQualityReport
                                    ? '当前 xctrace 导出结果没有 CPU、内存或 FPS 明细行，可下载 Trace 用 Instruments 打开继续分析。'
                                    : '当前 xctrace 导出结果没有 CPU、内存明细行，可下载 Trace 用 Instruments 打开继续分析。')}
                              />
                            ) : (
                              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未采集到性能样本" />
                            )}
                          </Space>
                        </Space>
                      )}
                    </Card>
                  )}
                  {!hasQualityReportArtifact(qualityReportBuild) && (
                    <Alert
                      type={isQualityBuildEffectivelyRunning(qualityReportBuild) ? 'info' : 'warning'}
                      showIcon
                      style={{ marginTop: 16 }}
                      message={isQualityBuildEffectivelyRunning(qualityReportBuild) ? '质检汇总生成中' : '当前任务暂未发现可展示的质检文件'}
                      description={isQualityBuildEffectivelyRunning(qualityReportBuild)
                        ? '任务仍在执行或收尾，报告文件生成后会自动刷新展示。'
                        : '如果任务刚结束，报告文件可能仍在归档，页面会继续自动刷新；也可以打开 Jenkins 控制台查看原始日志。'}
                    />
                  )}
            </Card>
          </Space>
        )}
      </Modal>

      <Modal
        title="质检设备池管理"
        open={devicePoolModalOpen}
        okText="保存"
        cancelText="取消"
        width={760}
        confirmLoading={devicePoolSaving}
        onOk={saveDevicePools}
        onCancel={() => setDevicePoolModalOpen(false)}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="设备池由平台维护"
            description="一个设备池可配置多台 iPhone；创建任务时平台会在池内选择未被占用的 UDID，并作为 DEVICE_UDID / DEVICE_SELECTOR 传给 Jenkins。"
          />
          <Card size="small" title="设备维护">
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Text type="secondary">
                {hasRunningQualityBuild
                  ? '当前有质检任务运行中，请先停止或等待任务结束后再清理 WDA。'
                  : '用于清理本机 WDA、iproxy、xctrace 残留进程。'}
              </Text>
              <Popconfirm
                title="清理 WDA？"
                description={hasRunningQualityBuild
                  ? '当前有质检任务运行中，不能清理 WDA。'
                  : '会停止本机 WDA、iproxy、xctrace 残留进程。'}
                okText="清理"
                cancelText="取消"
                okButtonProps={{ danger: true, disabled: hasRunningQualityBuild }}
                disabled={hasRunningQualityBuild}
                onConfirm={() => cleanupQualityWda()}
              >
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  loading={cleaningQualityWda === '__all__'}
                  disabled={hasRunningQualityBuild}
                >
                  清理 WDA
                </Button>
              </Popconfirm>
            </Space>
          </Card>
          {devicePoolDrafts.map((pool, index) => (
            <Card size="small" key={`${pool.value}-${index}`}>
              <Row gutter={[8, 8]} align="middle">
                <Col xs={24} sm={6}>
                  <Input
                    value={pool.label}
                    placeholder="名称，如 iOS 默认设备池"
                    onChange={(event) => updateDevicePoolDraft(index, { label: event.target.value })}
                  />
                </Col>
                <Col xs={24} sm={6}>
                  <Input
                    value={pool.value}
                    placeholder="value，如 ios-default"
                    onChange={(event) => updateDevicePoolDraft(index, { value: event.target.value })}
                  />
                </Col>
                <Col xs={24} sm={6}>
                  <Input
                    value={pool.description}
                    placeholder="说明"
                    onChange={(event) => updateDevicePoolDraft(index, { description: event.target.value })}
                  />
                </Col>
                <Col xs={24} sm={2}>
                  <Button
                    danger
                    icon={<DeleteOutlined />}
                    disabled={devicePoolDrafts.length <= 1}
                    onClick={() => removeDevicePoolDraft(index)}
                  />
                </Col>
                <Col span={24}>
                  <Input.TextArea
                    rows={3}
                    value={devicePoolDevicesText(pool)}
                    placeholder="每行一台设备：UDID 可选名称，例如 00008101-0015192E0178001E iPhone 12"
                    onChange={(event) => {
                      const devices = parseDevicePoolDevices(event.target.value);
                      updateDevicePoolDraft(index, {
                        devices,
                        deviceId: devices[0]?.udid || '',
                        groupId: undefined,
                      });
                    }}
                  />
                </Col>
              </Row>
            </Card>
          ))}
          <Button icon={<PlusOutlined />} onClick={addDevicePoolDraft}>
            新增设备池
          </Button>
        </Space>
      </Modal>

      <Modal
        title={selectedBuildLog ? `打包日志 - #${selectedBuildLog.build.number}` : '打包日志'}
        open={logModalOpen}
        width="82vw"
        footer={(
          <Space>
            <Button onClick={() => setLogModalOpen(false)}>关闭</Button>
            <Button
              icon={<DownloadOutlined />}
              disabled={!selectedBuildLog?.log}
              onClick={downloadBuildLog}
            >
              下载日志
            </Button>
          </Space>
        )}
        onCancel={() => setLogModalOpen(false)}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {selectedBuildLog && (
            <Space wrap>
              <Tag color="blue">构建 #{selectedBuildLog.build.number}</Tag>
              {selectedBuildLog.build.publishChannel && <Tag>{selectedBuildLog.build.publishChannel}</Tag>}
              {selectedBuildLog.build.branchName && <Tag>分支 {selectedBuildLog.build.branchName}</Tag>}
              {(selectedBuildLog.thirdSdkRevision || selectedBuildLog.build.commitHash) && (
                <Tag color="gold">commit {(selectedBuildLog.thirdSdkRevision || selectedBuildLog.build.commitHash || '').slice(0, 12)}</Tag>
              )}
              {getChannelBuildNumber(selectedBuildLog.build) && <Tag color="green">渠道构建号 {getChannelBuildNumber(selectedBuildLog.build)}</Tag>}
              {selectedBuildLog.build.appVersion && <Tag color="purple">APP {selectedBuildLog.build.appVersion}</Tag>}
            </Space>
          )}
          {selectedBuildLog?.build.publishChannel === 'AppStore' && (
            <Card size="small">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                <Space direction="vertical" size={4}>
                  <Text strong>上传主工程 dSYM 文件</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    上传后会进入 Crash 符号化的 dSYM 文件管理，可直接用于线上崩溃符号化。
                  </Text>
                  {buildDsymUploaded && (
                    <Space size={6} wrap>
                      <Tag color="green">已上传</Tag>
                      <Text>{buildDsymUploaded.appName}@{buildDsymUploaded.version}</Text>
                      <Text code>{buildDsymUploaded.uuid}</Text>
                    </Space>
                  )}
                </Space>
                <Button
                  icon={<UploadOutlined />}
                  loading={buildDsymUploading}
                  disabled={!selectedBuildLog.build.xcarchivePath}
                  onClick={handleBuildDsymUpload}
                >
                  {buildDsymUploading ? '上传中...' : '上传 dSYM'}
                </Button>
              </div>
            </Card>
          )}
          <Tabs
            key={selectedBuildLog?.build.number || 'build-log'}
            defaultActiveKey="build-log"
            onChange={(key) => {
              if (key === 'ai-analysis') ensureBuildFailureAnalysis();
            }}
            items={[
              {
                key: 'build-log',
                label: '打包日志',
                children: (
                  <Input.TextArea
                    value={logLoading ? '正在加载打包日志...' : selectedBuildLog?.log || '暂无打包日志'}
                    readOnly
                    autoSize={false}
                    style={{
                      height: '58vh',
                      fontFamily: 'Menlo, Monaco, Consolas, monospace',
                      fontSize: 12,
                      whiteSpace: 'pre',
                    }}
                  />
                ),
              },
              {
                key: 'third-sdk',
                label: (
                  <Space>
                    <span>三方库</span>
                    <Tag color="blue">{selectedBuildLog?.thirdSdkDependencies.length || 0}</Tag>
                  </Space>
                ),
                children: (
                  <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    <Space wrap>
                      <Text type="secondary">来源：当前构建主工程 third_sdk.rb</Text>
                      {selectedBuildLog?.thirdSdkBranch && <Tag color="geekblue">分支 {selectedBuildLog.thirdSdkBranch}</Tag>}
                    </Space>
                    {selectedBuildLog?.thirdSdkError && (
                      <Alert type="warning" showIcon message="读取 third_sdk.rb 失败" description={selectedBuildLog.thirdSdkError} />
                    )}
                    {selectedBuildLog?.thirdSdkMissingFiles?.length ? (
                      <Alert type="warning" showIcon message={`未找到：${selectedBuildLog.thirdSdkMissingFiles.join(', ')}`} />
                    ) : null}
                    {selectedBuildLog?.thirdSdkDependencies.length ? (
                      <Table
                        size="small"
                        rowKey={(record) => record.name}
                        pagination={false}
                        scroll={{ y: 430 }}
                        dataSource={selectedBuildLog.thirdSdkDependencies}
                        columns={[
                          {
                            title: '三方库',
                            dataIndex: 'name',
                            key: 'name',
                            width: 240,
                            render: (value: string) => <Text strong>{value}</Text>,
                          },
                          {
                            title: '版本',
                            dataIndex: 'version',
                            key: 'version',
                            width: 180,
                            render: (value: string) => <Tag color="purple">{value}</Tag>,
                          },
                        ]}
                      />
                    ) : (
                      <Text type="secondary">
                        {logLoading ? '正在读取 third_sdk.rb...' : '未从 third_sdk.rb 解析到三方库'}
                      </Text>
                    )}
                  </Space>
                ),
              },
              ...(canAnalyzeBuildFailure(selectedBuildLog?.build, selectedBuildLog?.log) ? [{
                key: 'ai-analysis',
                label: (
                  <Space>
                    <span>失败分析</span>
                    {buildFailureAnalysis && <Tag color={analysisSeverityColor(buildFailureAnalysis.severity)}>{buildFailureAnalysis.severity}</Tag>}
                  </Space>
                ),
                children: (
                  <Card size="small">
                    {buildFailureAnalysis ? (
                      <Space direction="vertical" size={10} style={{ width: '100%' }}>
                        <Alert
                          showIcon
                          type={buildFailureAnalysis.severity === 'critical' || buildFailureAnalysis.severity === 'high' ? 'error' : 'warning'}
                          message={buildFailureAnalysis.summary || '构建失败分析'}
                          description={(
                            <Space direction="vertical" size={6}>
                              <Space wrap>
                                <Tag color={analysisSeverityColor(buildFailureAnalysis.severity)}>{buildFailureAnalysis.severity}</Tag>
                                <Tag color="blue">{buildFailureAnalysis.stage || '未知阶段'}</Tag>
                                {buildFailureAnalysis.ownerHint && <Tag>{buildFailureAnalysis.ownerHint}</Tag>}
                                {buildFailureAnalysis.needsManualAction && <Tag color="orange">需要人工处理</Tag>}
                              </Space>
                              <Text>{buildFailureAnalysis.rootCause}</Text>
                            </Space>
                          )}
                        />
                        {buildFailureAnalysis.evidence?.length > 0 && (
                          <div>
                            <Text strong>关键证据</Text>
                            <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                              {buildFailureAnalysis.evidence.map((item, index) => (
                                <li key={`${index}-${item}`}>
                                  <Text code style={{ whiteSpace: 'pre-wrap' }}>{item}</Text>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {buildFailureAnalysis.suggestions?.length > 0 && (
                          <div>
                            <Text strong>处理建议</Text>
                            <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                              {buildFailureAnalysis.suggestions.map((item, index) => (
                                <li key={`${index}-${item}`}>{item}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <Button icon={<BulbOutlined />} loading={buildFailureAnalysisLoading} onClick={() => analyzeSelectedBuildFailure(true)}>
                          重新失败分析
                        </Button>
                      </Space>
                    ) : (
                      <Alert
                        showIcon
                        type="error"
                        message="构建失败，可发起失败分析"
                        description="会优先定位第一处关键失败日志，并给出根因、证据和处理建议。"
                        action={(
                          <Button size="small" icon={<BulbOutlined />} loading={buildFailureAnalysisLoading} onClick={() => analyzeSelectedBuildFailure(false)}>
                            失败分析
                          </Button>
                        )}
                      />
                    )}
                  </Card>
                ),
              }] : []),
            ]}
          />
        </Space>
      </Modal>

      <Modal
        title="渠道二维码"
        open={!!qrPreview}
        footer={qrPreview ? (
          <Space>
            <Button onClick={() => setQrPreview(null)}>关闭</Button>
            <Button type="primary" onClick={() => openExternalUrl(qrPreview.url)}>
              打开地址
            </Button>
          </Space>
        ) : null}
        onCancel={() => setQrPreview(null)}
      >
        <Space direction="vertical" align="center" size={16} style={{ width: '100%', padding: '12px 0 16px' }}>
          <Space>
            {qrPreview?.channel && <Tag color="blue">{qrPreview.channel}</Tag>}
            {qrPreview?.buildNumber && <Tag color="green">渠道构建号 {qrPreview.buildNumber}</Tag>}
          </Space>
          {qrPreview?.url && <QRCode value={normalizeOpenUrl(qrPreview.url)} size={260} />}
        </Space>
      </Modal>
    </div>
  );
}
