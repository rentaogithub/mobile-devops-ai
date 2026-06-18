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
} from '@ant-design/icons';
import { JenkinsBuild, JenkinsBuildListResult, JenkinsQualityArtifactPreview, JenkinsQualityBuild, JenkinsQualityListResult, JenkinsQualityPerformanceSamples, JenkinsQualitySuite, SonicDevicePool, SonicDevicePoolStatusResult, dsymApi, jenkinsApi, symbolicateApi } from '../services/api';
import type { DSYMInfo, SymbolicationResult } from '../types';

const { Title, Paragraph, Text } = Typography;
type DeployTarget = 'Pgyer' | 'TestFlight' | 'AppStore';
type QualitySummaryView = 'log' | 'monkey' | 'performance' | 'crash' | 'summary';

const DEPLOY_TARGET_OPTIONS: { label: string; value: DeployTarget }[] = [
  { label: '蒲公英', value: 'Pgyer' },
  { label: 'TestFlight', value: 'TestFlight' },
  { label: '苹果商店', value: 'AppStore' },
];

const QUALITY_SUITE_OPTIONS: { label: string; value: JenkinsQualitySuite }[] = [
  { label: 'Monkey 测试', value: 'monkey' },
  { label: '冒烟测试', value: 'smoke' },
  { label: '登录测试', value: 'login' },
  { label: 'IM 基础链路', value: 'im' },
  { label: 'RTC 基础链路', value: 'rtc' },
  { label: '全量回归', value: 'full' },
];

const MONKEY_DURATION_OPTIONS = [
  { label: '5 分钟', value: 300 },
  { label: '0.5 小时', value: 1800 },
  { label: '1 小时', value: 3600 },
  { label: '4 小时', value: 14400 },
  { label: '8 小时', value: 28800 },
];

const QUALITY_JOB_MISSING_MESSAGE = '未找到 Jenkins 自动质检 Job：nn-auto-quality，请先在 Jenkins 中创建该 Job，或通过 JENKINS_NN_QA_JOB 配置正确 Job 名称。';

function normalizeQualityError(err: any) {
  const message = String(err?.error || err?.message || '');
  if (err?.status === 404 || /Not Found|page does not exist|Oops! Not Found/i.test(message)) {
    return QUALITY_JOB_MISSING_MESSAGE;
  }
  return message || '加载自动质检任务列表失败';
}

function isReleaseBranch(branch: string) {
  return /^(?:origin\/)?release\/\d+(?:\.\d+){2,}$/.test(branch.trim());
}

function getReleaseVersion(branch: string) {
  const match = branch.trim().replace(/^origin\//, '').match(/^release\/(\d+(?:\.\d+){2,})$/);
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

function getHighestReleaseBranch(list: string[]) {
  return list.filter(isReleaseBranch).sort(compareReleaseBranches).at(-1) || '';
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

function performanceGradeColor(grade?: string) {
  if (grade === 'good') return 'green';
  if (grade === 'warning') return 'orange';
  if (grade === 'slow') return 'red';
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
  if (build.building && progress?.updatedAt && progressElapsed >= 0) {
    const sinceUpdate = Math.max(0, Math.floor((Date.now() - Number(progress.updatedAt)) / 1000));
    return progressElapsed + sinceUpdate;
  }
  if (progressElapsed > 0) return progressElapsed;
  if (build.duration > 0) return Math.round(build.duration / 1000);
  return progressElapsed;
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
  if (build.result === 'FAILURE') return 'exception';
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
  const status = String(build.qualitySummary?.status || build.qualitySummary?.progress?.status || '').toLowerCase();
  if (['passed', 'success'].includes(status)) {
    return <Tag color="green">通过</Tag>;
  }
  if (['failed', 'failure'].includes(status)) {
    return <Tag color="red">失败</Tag>;
  }
  if (['canceled', 'cancelled', 'aborted'].includes(status)) {
    return <Tag color="default">已取消</Tag>;
  }
  return resultTag(build);
}

function getChannelBuildNumber(build: JenkinsBuild) {
  const channelBuildNumber = String(build.buildNumber || '').trim();
  if (!channelBuildNumber) return '';
  if (channelBuildNumber === String(build.number)) return '';
  return channelBuildNumber;
}

function openPerformanceTrace(url?: string) {
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function PerformanceAnalysisSummary({
  analysis,
}: {
  analysis?: NonNullable<NonNullable<JenkinsQualityBuild['qualitySummary']>['performanceAnalysis']>;
}) {
  const issues = analysis?.conclusion?.issues || [];
  if (!analysis) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次任务没有性能报告" />;
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap>
        {analysis?.coldStartGrade && (
          <Tag color={performanceGradeColor(analysis.coldStartGrade)}>
            冷启动 {analysis.coldStartGrade}
          </Tag>
        )}
        {analysis?.launchDurationMs !== undefined && <Tag>启动命令 {formatMilliseconds(analysis.launchDurationMs)}</Tag>}
        {analysis?.coldStartReadyMs !== undefined && <Tag>首屏 {formatMilliseconds(analysis.coldStartReadyMs)}</Tag>}
        {analysis?.monkeyExecutedEvents !== undefined && <Tag>Monkey {analysis.monkeyExecutedEvents} 次</Tag>}
        {analysis?.monkeyEventsPerMinute !== undefined && <Tag>速率 {analysis.monkeyEventsPerMinute} 次/分钟</Tag>}
        {analysis?.monkeyDurationMs !== undefined && <Tag>Monkey 耗时 {formatMilliseconds(analysis.monkeyDurationMs)}</Tag>}
        {analysis?.samples?.sampleCount !== undefined && <Tag>采样 {analysis.samples.sampleCount} 条</Tag>}
        {analysis?.samples?.cpu?.avg !== undefined && analysis.samples.cpu.avg !== null && (
          <Tag>CPU 平均 {analysis.samples.cpu.avg}% / 峰值 {analysis.samples.cpu.max ?? '-'}%</Tag>
        )}
        {analysis?.samples?.memoryMB?.avg !== undefined && analysis.samples.memoryMB.avg !== null && (
          <Tag>内存平均 {analysis.samples.memoryMB.avg}MB / 峰值 {analysis.samples.memoryMB.max ?? '-'}MB</Tag>
        )}
        {analysis?.samples?.fps?.avg !== undefined && analysis.samples.fps.avg !== null && (
          <Tag>FPS 平均 {analysis.samples.fps.avg} / 最低 {analysis.samples.fps.min ?? '-'}</Tag>
        )}
        {analysis?.conclusion?.severity && (
          <Tag color={analysisSeverityColor(analysis.conclusion.severity)}>
            结论 {analysis.conclusion.severity}
          </Tag>
        )}
      </Space>
      {issues.length > 0 ? (
        <Alert
          showIcon
          type="warning"
          message="性能风险"
          description={(
            <Space direction="vertical" size={4}>
              {issues.map((issue, index) => (
                <Text key={`${issue.metric || 'metric'}-${index}`} type="secondary">
                  {issue.message || issue.metric}
                </Text>
              ))}
            </Space>
          )}
        />
      ) : (
        analysis?.conclusion?.severity && <Alert showIcon type="success" message="未发现性能风险" />
      )}
    </Space>
  );
}

type QualityMonkeyEvent = {
  index?: number;
  type?: string;
  reason?: string;
  startedAtMs?: number;
  elapsedSeconds?: number;
  x?: number;
  y?: number;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  usedFallbackPoint?: boolean;
  page?: {
    fingerprint?: string;
    summary?: {
      text?: string[];
      nodeTypes?: string[];
    };
  };
};

type QualityMonkeyReport = {
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
  };
  events?: QualityMonkeyEvent[];
};

function nearestMonkeyEvents(
  sampleIndex: number | undefined,
  sampleCount: number,
  report?: QualityMonkeyReport | null,
  sampleTimeSeconds?: number,
  radius = 5
) {
  const events = report?.events || [];
  if (!sampleIndex || !sampleCount || events.length === 0) return [];
  const timedEvents = events.filter((event) => typeof event.elapsedSeconds === 'number');
  if (typeof sampleTimeSeconds === 'number' && timedEvents.length > 0) {
    return timedEvents
      .map((event) => ({
        event,
        distance: Math.abs(Number(event.elapsedSeconds) - sampleTimeSeconds),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, Math.max(6, radius))
      .map((item) => item.event)
      .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  }
  const estimatedEventIndex = Math.max(1, Math.round((sampleIndex / sampleCount) * events.length));
  return events.filter((event) => {
    const index = Number(event.index || 0);
    return index >= estimatedEventIndex - radius && index <= estimatedEventIndex + radius;
  });
}

function formatMonkeyEvent(event: QualityMonkeyEvent) {
  return `#${event.index} ${eventTypeLabel(event.type)}${event.reason ? `/${event.reason}` : ''}`;
}

function formatMonkeyPageHint(events: QualityMonkeyEvent[]) {
  const text = events
    .flatMap((event) => event.page?.summary?.text || [])
    .filter(Boolean);
  const unique = Array.from(new Set(text)).slice(0, 8);
  return unique.length > 0 ? unique.join('、') : '';
}

function PerformanceDiagnostics({
  samples,
  monkeyPreview,
  monkeyLoading,
}: {
  samples: JenkinsQualityPerformanceSamples | null;
  monkeyPreview: JenkinsQualityArtifactPreview | null;
  monkeyLoading: boolean;
}) {
  if (!samples?.samples?.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无性能采样，无法生成诊断" />;
  }

  const monkeyReport = parseJsonPreview<QualityMonkeyReport>(monkeyPreview);
  const validCpuSamples = samples.samples.filter((sample) => sample.cpu !== null);
  const validMemorySamples = samples.samples.filter((sample) => sample.memoryMB !== null);
  const validFpsSamples = samples.samples.filter((sample) => sample.fps !== null);
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
  const cpuPeakEvents = nearestMonkeyEvents(
    maxCpuSample?.index,
    samples.returnedSampleCount || samples.sampleCount,
    monkeyReport,
    maxCpuSample?.timeSeconds
  );
  const memoryJumpEvents = nearestMonkeyEvents(
    biggestMemoryJump?.index,
    samples.returnedSampleCount || samples.sampleCount,
    monkeyReport,
    biggestMemoryJump?.timeSeconds
  );
  const cpuPeakPageHint = formatMonkeyPageHint(cpuPeakEvents);
  const memoryJumpPageHint = formatMonkeyPageHint(memoryJumpEvents);
  const hasTimedMonkeyEvents = !!monkeyReport?.events?.some((event) => typeof event.elapsedSeconds === 'number');
  const memoryAttention = memoryDelta !== null && memoryDelta >= 15;
  const jumpAttention = !!biggestMemoryJump && biggestMemoryJump.delta >= 8;
  const cpuAttention = !!maxCpuSample && Number(maxCpuSample.cpu) >= 80;
  const fpsAttention = !!minFpsSample && Number(minFpsSample.fps) > 0 && Number(minFpsSample.fps) < 45;
  const attentionItems = [
    memoryAttention ? `内存从 ${firstMemory}MB 增长到 ${lastMemory}MB，净增长 ${memoryDelta}MB，建议确认是否进入高资源页面后未回收。` : '',
    jumpAttention && biggestMemoryJump ? `#${biggestMemoryJump.index} 附近内存单次上升 ${biggestMemoryJump.delta}MB，是最明显的资源切换点。` : '',
    cpuAttention && maxCpuSample ? `CPU 在 #${maxCpuSample.index} 达到 ${maxCpuSample.cpu}%，可结合附近动作判断是否触发重渲染、页面初始化或密集计算。` : '',
    highCpuSamples.length >= 3 ? `CPU >= 70% 的采样有 ${highCpuSamples.length} 条，建议关注是否存在连续高负载。` : '',
    fpsAttention && minFpsSample ? `FPS 最低 ${minFpsSample.fps}，可检查该采样附近是否有卡顿动作。` : '',
  ].filter(Boolean);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
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
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
        <Descriptions.Item label="CPU 峰值">
          {maxCpuSample ? `${maxCpuSample.cpu}% / #${maxCpuSample.index} / ${Math.round(maxCpuSample.timeSeconds)}s` : '-'}
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
          {highCpuSamples.length} 条
        </Descriptions.Item>
        <Descriptions.Item label="FPS 低点">
          {minFpsSample?.fps !== null && minFpsSample?.fps !== undefined ? `${minFpsSample.fps} / #${minFpsSample.index}` : '-'}
        </Descriptions.Item>
      </Descriptions>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Text strong>动作关联</Text>
        {monkeyLoading ? (
          <Alert showIcon type="info" message="正在加载 Monkey 动作数据..." />
        ) : monkeyReport?.events?.length ? (
          <Space direction="vertical" size={4}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              匹配方式：{hasTimedMonkeyEvents ? '按事件时间戳精确匹配' : '按事件序号近似匹配'}
            </Text>
            {maxCpuSample && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                CPU 峰值附近：{cpuPeakEvents.length > 0 ? cpuPeakEvents.map(formatMonkeyEvent).join('、') : '未匹配到动作'}
              </Text>
            )}
            {cpuPeakPageHint && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                CPU 峰值页面线索：{cpuPeakPageHint}
              </Text>
            )}
            {biggestMemoryJump && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                内存阶跃附近：{memoryJumpEvents.length > 0 ? memoryJumpEvents.map(formatMonkeyEvent).join('、') : '未匹配到动作'}
              </Text>
            )}
            {memoryJumpPageHint && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                内存阶跃页面线索：{memoryJumpPageHint}
              </Text>
            )}
          </Space>
        ) : (
          <Alert showIcon type="info" message="未加载到 Monkey 动作数据，暂不能关联动作区间" />
        )}
      </Space>
    </Space>
  );
}

function PerformanceSamplesChart({ data }: { data: JenkinsQualityPerformanceSamples }) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const hasMetric = data.samples.some((sample) => sample.cpu !== null || sample.memoryMB !== null || sample.fps !== null);

  useEffect(() => {
    if (!chartRef.current || !hasMetric) return;
    const chart = echarts.init(chartRef.current);
    const labels = data.samples.map((sample) => `#${sample.index}`);
    const option: echarts.EChartsOption = {
      color: ['#1677ff', '#52c41a', '#fa8c16'],
      tooltip: {
        trigger: 'axis',
        valueFormatter: (value) => (value === null || value === undefined ? '-' : String(value)),
      },
      legend: {
        top: 0,
        data: ['CPU %', '内存 MB', 'FPS'],
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
      },
      yAxis: [
        {
          type: 'value',
          name: 'CPU/FPS',
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
      series: [
        {
          name: 'CPU %',
          type: 'line',
          showSymbol: false,
          connectNulls: true,
          data: data.samples.map((sample) => sample.cpu),
        },
        {
          name: '内存 MB',
          type: 'line',
          showSymbol: false,
          connectNulls: true,
          yAxisIndex: 1,
          data: data.samples.map((sample) => sample.memoryMB),
        },
        {
          name: 'FPS',
          type: 'line',
          showSymbol: false,
          connectNulls: true,
          data: data.samples.map((sample) => sample.fps),
        },
      ],
    };
    chart.setOption(option);
    const resize = () => chart.resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      chart.dispose();
    };
  }, [data, hasMetric]);

  if (!data.sampleCount || !hasMetric) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未采集到性能样本" />;
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Space wrap>
        <Tag>采样 {data.sampleCount} 条</Tag>
        {data.summary.cpu.avg !== null && <Tag>CPU 平均 {data.summary.cpu.avg}% / 峰值 {data.summary.cpu.max ?? '-'}%</Tag>}
        {data.summary.memoryMB.avg !== null && <Tag>内存平均 {data.summary.memoryMB.avg}MB / 峰值 {data.summary.memoryMB.max ?? '-'}MB</Tag>}
        {data.summary.fps.avg !== null && <Tag>FPS 平均 {data.summary.fps.avg} / 最低 {data.summary.fps.min ?? '-'}</Tag>}
        {(data.truncated || data.sourceTruncated) && <Tag color="orange">已截断</Tag>}
      </Space>
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
    };
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
        <Tag>执行 {executedEvents} 次</Tag>
        {report.requestedEvents !== undefined && <Tag>目标 {report.requestedEvents} 次</Tag>}
        {durationSeconds !== undefined && <Tag>耗时 {formatSeconds(durationSeconds)}</Tag>}
        {report.requestedDurationSeconds !== undefined && <Tag>计划 {formatSeconds(report.requestedDurationSeconds)}</Tag>}
        {report.wdaUrl && <Tag>WDA {report.wdaUrl.replace(/^https?:\/\//, '')}</Tag>}
      </Space>
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
  const crashFileName = (file?: string) => (file || '').split('/').filter(Boolean).at(-1) || '';
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
                <Space key={file} direction="vertical" size={6} style={{ width: '100%' }}>
                  <Space size={8} wrap>
                    <Text type="secondary" style={{ fontSize: 12 }}>{file}</Text>
                    {crashFileUrl(file) && (
                      <Button size="small" type="link" onClick={() => downloadCrashIps(file)}>
                        下载 ips
                      </Button>
                    )}
                    <Button
                      size="small"
                      type="link"
                      disabled={!crashFileUrl(file)}
                      loading={symbolicationByFile[file]?.loading}
                      onClick={() => handleSymbolicateCrash(file)}
                    >
                      符号化解析
                    </Button>
                  </Space>
                  {symbolicationByFile[file]?.error && (
                    <Alert showIcon type="warning" message={symbolicationByFile[file]?.error} />
                  )}
                  {symbolicationByFile[file]?.result && (
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
  const [qualityModalOpen, setQualityModalOpen] = useState(false);
  const [qualitySubmitting, setQualitySubmitting] = useState(false);
  const [qualitySubmitMessage, setQualitySubmitMessage] = useState('');
  const [qualityBuild, setQualityBuild] = useState<JenkinsBuild | null>(null);
  const [qualityReportBuild, setQualityReportBuild] = useState<JenkinsQualityBuild | null>(null);
  const [activeQualitySummaryView, setActiveQualitySummaryView] = useState<QualitySummaryView>('log');
  const [qualityArtifactPreview, setQualityArtifactPreview] = useState<(JenkinsQualityArtifactPreview & { title: string }) | null>(null);
  const [qualityArtifactPreviewLoading, setQualityArtifactPreviewLoading] = useState(false);
  const [qualityLogDigest, setQualityLogDigest] = useState<JenkinsQualityArtifactPreview | null>(null);
  const [qualityLogDigestLoading, setQualityLogDigestLoading] = useState(false);
  const [qualityPerformanceReportOpen, setQualityPerformanceReportOpen] = useState(false);
  const [qualityPerformanceSamples, setQualityPerformanceSamples] = useState<JenkinsQualityPerformanceSamples | null>(null);
  const [qualityPerformanceLoading, setQualityPerformanceLoading] = useState(false);
  const [qualityMonkeyReportDigest, setQualityMonkeyReportDigest] = useState<JenkinsQualityArtifactPreview | null>(null);
  const [qualityMonkeyReportDigestLoading, setQualityMonkeyReportDigestLoading] = useState(false);
  const [qualitySuites, setQualitySuites] = useState<JenkinsQualitySuite[]>(['monkey']);
  const [qualityMonkeyDurationSeconds, setQualityMonkeyDurationSeconds] = useState(14400);
  const [qualityDevicePool, setQualityDevicePool] = useState('ios-default');
  const [qualityDeviceUdids, setQualityDeviceUdids] = useState<string[]>([]);
  const [selectedBuildLog, setSelectedBuildLog] = useState<{
    build: JenkinsBuild;
    log: string;
    thirdSdkBranch: string;
    thirdSdkRevision?: string;
    thirdSdkDependencies: Array<{ name: string; version: string; source: string }>;
    thirdSdkMissingFiles?: string[];
    thirdSdkError?: string;
  } | null>(null);
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

  const refreshQualityBuildsUntilUpdated = async (previousLatest?: number | string) => {
    const delays = [0, 1000, 1500, 2000, 3000, 4000, 5000, 5000, 5000, 5000, 5000, 5000];
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
      if (nextData?.builds?.some((build) => isQualityBuildEffectivelyRunning(build))) {
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
    const fallbackBase = publishBranch.trim() || getHighestReleaseBranch(branches) || 'develop';
    setReleaseBranchBase(fallbackBase);
    setReleaseBranchName('');
    setReleaseBranchLog('');
    setReleaseBranchModalOpen(true);
    if (branches.length === 0) {
      loadBranches();
    }
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
    setReleaseBranchLog('正在执行 mgit，请稍候...');
    try {
      const response = await jenkinsApi.createReleaseBranch({ targetBranch, baseBranch });
      const logs = (response.data?.commands || [])
        .map((item) => `$ ${item.command}\n${item.output || '(无输出)'}`)
        .join('\n\n');
      setReleaseBranchLog(logs);
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
    } catch (err: any) {
      message.warning(err?.error || err?.message || '加载分支列表失败，可直接输入分支名');
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

  const stopQualityBuild = async (buildNumber: number) => {
    setStoppingQualityBuild(buildNumber);
    try {
      await jenkinsApi.stopQualityBuild(buildNumber);
      message.success(`已停止质检任务 #${buildNumber}`);
      await refreshQualitySection({ silent: true });
    } catch (err: any) {
      message.error(err?.error || err?.message || '停止质检任务失败');
    } finally {
      setStoppingQualityBuild(null);
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

  const loadQualityMonkeyReportDigest = async (url?: string) => {
    if (!url) {
      setQualityMonkeyReportDigest(null);
      return;
    }
    setQualityMonkeyReportDigestLoading(true);
    try {
      const response = await jenkinsApi.previewQualityArtifact(url);
      setQualityMonkeyReportDigest(response.data || null);
    } catch {
      setQualityMonkeyReportDigest(null);
    } finally {
      setQualityMonkeyReportDigestLoading(false);
    }
  };

  const openQualityPerformanceReport = async (url?: string) => {
    setQualityPerformanceReportOpen(true);
    setActiveQualitySummaryView('performance');
    setQualityArtifactPreview(null);
    setQualityPerformanceSamples(null);
    if (!url) return;
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
    const nextSuites: JenkinsQualitySuite[] = ['monkey'];
    const nextPool = sonicDevicePools.find((pool) => (pool.stats?.idle || 0) > 0)?.value || sonicDevicePools[0]?.value || 'ios-default';
    setQualitySubmitMessage('');
    setQualityBuild(fallbackBuild);
    setQualitySuites(nextSuites);
    setQualityMonkeyDurationSeconds(14400);
    setQualityDevicePool(nextPool);
    setQualityDeviceUdids(defaultQualityDeviceUdids(nextPool, nextSuites));
    setQualityModalOpen(true);
  };

  const triggerQuality = async () => {
    if (!qualityBuild) {
      message.warning('请选择需要质检的构建');
      return;
    }
    if (qualitySuites.length === 0) {
      message.warning('请至少选择一个测试套件');
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
    if (qualitySuites.length > qualityDeviceUdids.length) {
      message.warning(`已选择 ${qualitySuites.length} 个测试套件，请至少选择 ${qualitySuites.length} 台空闲设备`);
      return;
    }
    setQualitySubmitting(true);
    setQualitySubmitMessage('正在提交 Jenkins 质检任务...');
    const previousLatestQualityBuild = qualityData?.builds?.[0]?.number;
    try {
      await Promise.all(qualitySuites.map((suite, index) => jenkinsApi.triggerQuality({
          buildNumber: qualityBuild.number,
          branch: qualityBuild.branchName,
          commitHash: qualityBuild.commitHash,
          appVersion: qualityBuild.appVersion,
          packageUrl: qualityBuild.installPackageUrl || qualityBuild.packageUrl,
          xcarchivePath: qualityBuild.xcarchivePath,
          archiveUrl: qualityBuild.archiveUrl,
          testSuite: suite,
          devicePool: qualityDevicePool,
          deviceUdid: qualityDeviceUdids[index],
          monkeyDurationSeconds: suite === 'monkey' ? qualityMonkeyDurationSeconds : undefined,
        })));
      setQualitySubmitMessage('已提交，正在等待 Jenkins 创建任务并刷新列表...');
      message.success(`已触发 ${qualitySuites.length} 个自动质检任务：#${qualityBuild.number}`);
      setQualityModalOpen(false);
      setQualitySubmitMessage('');
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
    if (!qualityReportBuild) {
      setQualityLogDigest(null);
      setQualityMonkeyReportDigest(null);
      return;
    }
    loadQualityLogDigest(qualityReportBuild.qualitySummary?.artifacts?.qualityLogUrl);
    loadQualityMonkeyReportDigest(qualityReportBuild.qualitySummary?.artifacts?.monkeyReportUrl);
  }, [
    qualityReportBuild?.number,
    qualityReportBuild?.qualitySummary?.artifacts?.qualityLogUrl,
    qualityReportBuild?.qualitySummary?.artifacts?.monkeyReportUrl,
  ]);

  const stats = useMemo(() => data?.stats || {
    total: 0,
    running: 0,
    latestBuild: '-',
    successRate: '-',
  }, [data]);
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

  const defaultQualityDeviceUdids = (poolValue: string, suites = qualitySuites) => {
    const pool = sonicDevicePools.find((item) => item.value === poolValue);
    return (pool?.devices || [])
      .filter((device) => device.status === 'idle' && device.udid)
      .slice(0, suites.length)
      .map((device) => device.udid);
  };

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
      if (next.length > 0 || qualitySuites.length === 0) return next;
      return availableUdids.slice(0, qualitySuites.length);
    });
  }, [qualityModalOpen, availableQualityDevices, qualitySuites.length]);

  const publishBranchOptions = useMemo(
    () => branches.map((branch) => ({ value: branch, label: branch })),
    [branches],
  );
  const pageTitle = activeSection === 'quality' ? '自动质检' : '发布管理';
  const pageDescription = activeSection === 'quality'
    ? '基于打包机本机 USB 真机执行 iOS 自动化质检，覆盖安装、启动、用例、截图和报告采集。'
    : 'nn-ios Jekins构建与发布蒲公英、TestFlight、苹果商店包。';
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
            <Button icon={<ExportOutlined />} onClick={() => window.open(data?.job.url || `${window.location.protocol}//${window.location.hostname}:8080/job/nn/`, '_blank', 'noopener,noreferrer')}>
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
                <Button type="link" onClick={() => window.open(record.url, '_blank', 'noopener,noreferrer')}>
                  #{number}
                </Button>
              ),
            },
            {
              title: '发布渠道',
              dataIndex: 'publishChannel',
              key: 'publishChannel',
              width: 120,
              render: (value?: string) => value ? <Tag color="blue">{value}</Tag> : <Text type="secondary">-</Text>,
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
                    onClick={() => record.archiveUrl && window.open(record.archiveUrl, '_blank', 'noopener,noreferrer')}
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
                <Alert
                  type="info"
                  showIcon
                  message="本机真机自动质检"
                  description="构建包由 Jenkins 产出，质检任务由独立 Jenkins Job 编排，底层优先使用打包机 USB 连接的 iPhone 执行安装、启动、用例、截图和报告采集。Sonic 可作为后续扩展入口，不再作为平台启动依赖。"
                  style={{ marginBottom: 16 }}
                />
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
                          <Button type="link" onClick={() => window.open(record.url, '_blank', 'noopener,noreferrer')}>
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
                        title: 'APP版本',
                        key: 'appVersion',
                        width: 110,
                        render: (_, record) => record.qualitySummary?.appVersion ? (
                          <Tag color="purple">{record.qualitySummary.appVersion}</Tag>
                        ) : <Text type="secondary">-</Text>,
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
                        width: 120,
                        render: (_, record) => qualityResultTag(record),
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
                          return (
                            <Space direction="vertical" size={2} style={{ width: '100%' }}>
                              <Progress percent={percent} size="small" status={progressStatus(record)} />
                              {progress?.message && (
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {progress.message}
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
                        title: '耗时',
                        key: 'duration',
                        width: 120,
                        render: (_, record) => formatDuration(record.duration, record.building),
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
                                setQualityReportBuild(record);
                                setActiveQualitySummaryView('log');
                                setQualityArtifactPreview(null);
                                setQualityLogDigest(null);
                                setQualityPerformanceReportOpen(false);
                                setQualityPerformanceSamples(null);
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
                                onConfirm={() => stopQualityBuild(record.number)}
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
          <Alert
            type="info"
            showIcon
            message="使用 mgit 为 nnios 和子组件创建同名分支并推送远端"
            description="会依次执行 mgit checkout 基准分支、mgit pull --ff-only、mgit checkout -b 新分支、mgit push。"
          />
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
            <AutoComplete
              value={releaseBranchBase}
              options={publishBranchOptions}
              disabled={releaseBranchCreating}
              onChange={setReleaseBranchBase}
              placeholder="例如 develop 或 release/5.14.8"
              style={{ marginTop: 8, width: '100%' }}
              filterOption={(inputValue, option) =>
                String(option?.value || '').toLowerCase().includes(inputValue.toLowerCase())
              }
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
          <Alert
            type="info"
            showIcon
            message="基于本机 USB 真机执行 iOS 自动化质检"
            description="平台会把构建信息传给 Jenkins 质检 Job，由 Jenkins 在打包机上选择设备池安装 IPA 并执行自动化测试。"
          />
          <div>
            <Text strong>质检构建</Text>
            <Select
              value={qualityBuild?.number}
              disabled={qualitySubmitting}
              style={{ marginTop: 8, width: '100%' }}
              placeholder="请选择构建"
              options={(data?.builds || []).map((build) => ({
                value: build.number,
                label: `#${build.number} ${build.branchName || '-'} ${build.appVersion || ''}`,
              }))}
              onChange={(value) => {
                setQualityBuild((data?.builds || []).find((build) => build.number === value) || null);
              }}
            />
          </div>
          {qualityBuild && (
            <Space wrap>
              <Tag color="blue">构建 #{qualityBuild.number}</Tag>
              {qualityBuild.publishChannel && <Tag>{qualityBuild.publishChannel}</Tag>}
              {qualityBuild.branchName && <Tag>分支 {qualityBuild.branchName}</Tag>}
              {qualityBuild.commitHash && <Tag color="gold">commit {qualityBuild.commitHash.slice(0, 12)}</Tag>}
              {qualityBuild.appVersion && <Tag color="purple">APP {qualityBuild.appVersion}</Tag>}
            </Space>
          )}
          <div>
            <Text strong>测试套件</Text>
            <Checkbox.Group
              options={QUALITY_SUITE_OPTIONS}
              value={qualitySuites}
              disabled={qualitySubmitting}
              onChange={(values) => {
                const nextSuites = values as JenkinsQualitySuite[];
                setQualitySuites(nextSuites);
                setQualityDeviceUdids((current) => {
                  const stillAvailable = current.filter((udid) => availableQualityDevices.some((device) => device.udid === udid));
                  if (stillAvailable.length >= nextSuites.length) return stillAvailable.slice(0, nextSuites.length);
                  const additions = availableQualityDevices
                    .map((device) => device.udid)
                    .filter((udid) => !stillAvailable.includes(udid))
                    .slice(0, nextSuites.length - stillAvailable.length);
                  return [...stillAvailable, ...additions];
                });
              }}
              style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}
            />
          </div>
          {qualitySuites.includes('monkey') && (
            <div>
              <Text strong>Monkey 执行时长</Text>
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
                onClick={() => window.open(qualityReportBuild.qualitySummary?.artifacts?.qualityLogUrl, '_blank', 'noopener,noreferrer')}
              >
                下载日志
              </Button>
            )}
            {qualityReportBuild?.qualitySummary?.artifacts?.junitUrl && (
              <Button
                onClick={() => window.open(qualityReportBuild.qualitySummary?.artifacts?.junitUrl, '_blank', 'noopener,noreferrer')}
              >
                下载 JUnit
              </Button>
            )}
            <Button onClick={() => {
              setQualityReportBuild(null);
              setActiveQualitySummaryView('log');
              setQualityArtifactPreview(null);
              setQualityLogDigest(null);
              setQualityPerformanceReportOpen(false);
              setQualityPerformanceSamples(null);
            }}>关闭</Button>
          </Space>
        )}
        onCancel={() => {
          setQualityReportBuild(null);
          setActiveQualitySummaryView('log');
          setQualityArtifactPreview(null);
          setQualityLogDigest(null);
          setQualityPerformanceReportOpen(false);
          setQualityPerformanceSamples(null);
        }}
      >
        {qualityReportBuild && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type={qualityReportBuild.result === 'SUCCESS' ? 'success' : (qualityReportBuild.result === 'FAILURE' ? 'error' : 'info')}
              showIcon
              message={qualityReportBuild.qualitySummary?.message || (qualityReportBuild.result === 'SUCCESS' ? '质检通过' : '质检结果')}
              description={(
                <Space wrap>
                  {qualityReportBuild.qualitySummary?.sourceBuildNumber && <Tag color="blue">来源构建 #{qualityReportBuild.qualitySummary.sourceBuildNumber}</Tag>}
                  {qualityReportBuild.qualitySummary?.appVersion && <Tag color="purple">APP {qualityReportBuild.qualitySummary.appVersion}</Tag>}
                  {qualityReportBuild.qualitySummary?.testSuite && <Tag>套件 {qualityReportBuild.qualitySummary.testSuite}</Tag>}
                  {qualityReportBuild.qualitySummary?.launchMethod && <Tag color="cyan">启动 {qualityReportBuild.qualitySummary.launchMethod}</Tag>}
                  {qualityReportBuild.qualitySummary?.coldStartReadyMs !== undefined && (
                    <Tag color="geekblue">冷启动 {formatMilliseconds(qualityReportBuild.qualitySummary.coldStartReadyMs)}</Tag>
                  )}
                  {qualityReportBuild.qualitySummary?.monkeyStatus && (
                    <Tag color={qualityReportBuild.qualitySummary.monkeyStatus === 'passed' ? 'green' : 'red'}>
                      Monkey {qualityReportBuild.qualitySummary.monkeyExecutedEvents || 0}/{qualityReportBuild.qualitySummary.monkeyEventCount || 0}
                    </Tag>
                  )}
                </Space>
              )}
            />
            {qualityReportBuild.qualitySummary?.progress && (
              <Alert
                showIcon
                type={isQualityBuildEffectivelyRunning(qualityReportBuild) ? 'info' : 'success'}
                message="运行进度"
                description={(
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Progress
                      percent={progressPercent(qualityReportBuild)}
                      status={progressStatus(qualityReportBuild)}
                    />
                    <Space wrap>
                      {qualityReportBuild.qualitySummary.progress.message && (
                        <Tag color="blue">{qualityReportBuild.qualitySummary.progress.message}</Tag>
                      )}
                      <Tag>已执行 {qualityReportBuild.qualitySummary.progress.executedEvents || 0} 次</Tag>
                      <Tag>已运行 {formatSeconds(progressElapsedSeconds(qualityReportBuild))}</Tag>
                      {progressRemainingSeconds(qualityReportBuild) !== null && progressRemainingSeconds(qualityReportBuild) !== undefined && (
                        <Tag>剩余 {formatSeconds(progressRemainingSeconds(qualityReportBuild))}</Tag>
                      )}
                      {qualityReportBuild.qualitySummary.progress.recentPerformance?.cpu !== null && qualityReportBuild.qualitySummary.progress.recentPerformance?.cpu !== undefined && (
                        <Tag>CPU {qualityReportBuild.qualitySummary.progress.recentPerformance.cpu}%</Tag>
                      )}
                      {qualityReportBuild.qualitySummary.progress.recentPerformance?.memoryMB !== null && qualityReportBuild.qualitySummary.progress.recentPerformance?.memoryMB !== undefined && (
                        <Tag>内存 {qualityReportBuild.qualitySummary.progress.recentPerformance.memoryMB}MB</Tag>
                      )}
                      {qualityReportBuild.qualitySummary.progress.recentPerformance?.fps !== null && qualityReportBuild.qualitySummary.progress.recentPerformance?.fps !== undefined && (
                        <Tag>FPS {qualityReportBuild.qualitySummary.progress.recentPerformance.fps}</Tag>
                      )}
                    </Space>
                  </Space>
                )}
              />
            )}
            <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
              <Descriptions.Item label="质检任务">#{qualityReportBuild.number}</Descriptions.Item>
              <Descriptions.Item label="状态">{qualityResultTag(qualityReportBuild)}</Descriptions.Item>
              <Descriptions.Item label="耗时">{formatDuration(qualityReportBuild.duration, qualityReportBuild.building)}</Descriptions.Item>
              <Descriptions.Item label="启动命令耗时">{formatMilliseconds(qualityReportBuild.qualitySummary?.launchDurationMs)}</Descriptions.Item>
              <Descriptions.Item label="冷启动稳定耗时">{formatMilliseconds(qualityReportBuild.qualitySummary?.coldStartReadyMs)}</Descriptions.Item>
              <Descriptions.Item label="Monkey 结果">
                {qualityReportBuild.qualitySummary?.monkeyStatus ? (
                  <Space wrap>
                    <Tag color={qualityReportBuild.qualitySummary.monkeyStatus === 'passed' ? 'green' : 'red'}>
                      {qualityReportBuild.qualitySummary.monkeyStatus}
                    </Tag>
                    <Text>{qualityReportBuild.qualitySummary.monkeyExecutedEvents || 0}/{qualityReportBuild.qualitySummary.monkeyEventCount || 0} 次</Text>
                  </Space>
                ) : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="开始时间">{formatBuildTime(qualityReportBuild.timestamp)}</Descriptions.Item>
              <Descriptions.Item label="设备池">{qualityReportBuild.qualitySummary?.devicePoolLabel || qualityReportBuild.qualitySummary?.devicePool || '-'}</Descriptions.Item>
              <Descriptions.Item label="设备 UDID">
                <Text code copyable={!!qualityReportBuild.qualitySummary?.deviceUdid}>
                  {qualityReportBuild.qualitySummary?.deviceUdid || '-'}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="Bundle ID">
                <Text code copyable={!!qualityReportBuild.qualitySummary?.bundleId}>
                  {qualityReportBuild.qualitySummary?.bundleId || '-'}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="检测 Bundle">
                <Text code copyable={!!qualityReportBuild.qualitySummary?.detectedBundleId}>
                  {qualityReportBuild.qualitySummary?.detectedBundleId || '-'}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="WDA 地址">
                <Text code copyable={!!qualityReportBuild.qualitySummary?.wdaUrl}>
                  {qualityReportBuild.qualitySummary?.wdaUrl || '-'}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="Jenkins 任务">
                <Button type="link" size="small" onClick={() => window.open(qualityReportBuild.url, '_blank', 'noopener,noreferrer')}>
                  打开 #{qualityReportBuild.number}
                </Button>
              </Descriptions.Item>
            </Descriptions>

            <Row gutter={[16, 16]}>
              <Col xs={24} lg={10}>
                <Card size="small" title="启动截图">
                  {qualityReportBuild.qualitySummary?.artifacts?.screenshotUrl ? (
                    <Image
                      src={qualityReportBuild.qualitySummary.artifacts.screenshotUrl}
                      alt="质检截图"
                      style={{ maxHeight: 420, objectFit: 'contain' }}
                    />
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次任务未归档截图" />
                  )}
                </Card>
              </Col>
              <Col xs={24} lg={14}>
                <Card
                  size="small"
                  title="质检汇总"
                  extra={qualityReportBuild.qualitySummary?.artifacts?.summaryUrl && (
                    <Button
                      size="small"
                      type="link"
                      onClick={() => {
                        setActiveQualitySummaryView('summary');
                        setQualityPerformanceReportOpen(false);
                        previewQualityArtifact('summary.json', qualityReportBuild.qualitySummary?.artifacts?.summaryUrl);
                      }}
                    >
                      summary.json
                    </Button>
                  )}
                >
                  <Space wrap>
                    <Button
                      icon={<FileTextOutlined />}
                      disabled={!qualityReportBuild.qualitySummary?.artifacts?.qualityLogUrl}
                      type={activeQualitySummaryView === 'log' ? 'primary' : 'default'}
                      onClick={() => {
                        setActiveQualitySummaryView('log');
                        setQualityArtifactPreview(null);
                        setQualityPerformanceReportOpen(false);
                      }}
                    >
                      质检日志
                    </Button>
                    <Button
                      disabled={!qualityReportBuild.qualitySummary?.artifacts?.monkeyReportUrl}
                      loading={qualityArtifactPreviewLoading && qualityArtifactPreview?.title === 'Monkey 报告'}
                      type={activeQualitySummaryView === 'monkey' ? 'primary' : 'default'}
                      onClick={() => {
                        setActiveQualitySummaryView('monkey');
                        setQualityPerformanceReportOpen(false);
                        previewQualityArtifact('Monkey 报告', qualityReportBuild.qualitySummary?.artifacts?.monkeyReportUrl);
                      }}
                    >
                      Monkey 报告
                    </Button>
                    <Button
                      disabled={!qualityReportBuild.qualitySummary?.performanceAnalysis && !qualityReportBuild.qualitySummary?.artifacts?.performanceSamplesUrl && !qualityReportBuild.qualitySummary?.artifacts?.performanceTraceUrl}
                      loading={qualityPerformanceLoading}
                      type={activeQualitySummaryView === 'performance' ? 'primary' : 'default'}
                      onClick={() => openQualityPerformanceReport(qualityReportBuild.qualitySummary?.artifacts?.performanceSamplesUrl)}
                    >
                      性能报告
                    </Button>
                    <Button
                      disabled={!qualityReportBuild.qualitySummary?.exceptionAnalysis}
                      type={activeQualitySummaryView === 'crash' ? 'primary' : 'default'}
                      onClick={() => {
                        setActiveQualitySummaryView('crash');
                        setQualityArtifactPreview(null);
                        setQualityPerformanceReportOpen(false);
                      }}
                    >
                      崩溃分析
                    </Button>
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
                  {activeQualitySummaryView === 'monkey' && (
                    <Card
                      size="small"
                      title="Monkey 报告"
                      extra={qualityArtifactPreview?.url && (
                        <Button size="small" type="link" onClick={() => window.open(qualityArtifactPreview.url, '_blank', 'noopener,noreferrer')}>
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
                          <Button size="small" type="link" onClick={() => window.open(qualityArtifactPreview.url, '_blank', 'noopener,noreferrer')}>
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
                  {activeQualitySummaryView === 'performance' && qualityPerformanceReportOpen && (
                    <Card
                      size="small"
                      title={(
                        <Space>
                          <Text>性能报告</Text>
                          {qualityPerformanceSamples && <Tag>jsonl</Tag>}
                        </Space>
                      )}
                      extra={(
                        <Space>
                          {qualityPerformanceSamples?.url && (
                            <Button size="small" type="link" onClick={() => window.open(qualityPerformanceSamples.url, '_blank', 'noopener,noreferrer')}>
                              采样原文件
                            </Button>
                          )}
                          {qualityReportBuild.qualitySummary?.artifacts?.performanceTraceUrl && (
                            <Button size="small" type="link" onClick={() => openPerformanceTrace(qualityReportBuild.qualitySummary?.artifacts?.performanceTraceUrl)}>
                              下载 Trace
                            </Button>
                          )}
                          <Button size="small" type="text" onClick={() => {
                            setQualityPerformanceReportOpen(false);
                            setQualityPerformanceSamples(null);
                          }}>
                            收起
                          </Button>
                        </Space>
                      )}
                      style={{ marginTop: 16 }}
                    >
                      <Space direction="vertical" size={16} style={{ width: '100%' }}>
                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                          <Text strong>分析总结</Text>
                          <PerformanceAnalysisSummary
                            analysis={qualityReportBuild.qualitySummary?.performanceAnalysis}
                          />
                        </Space>
                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                          <Text strong>性能诊断</Text>
                          <PerformanceDiagnostics
                            samples={qualityPerformanceSamples}
                            monkeyPreview={qualityMonkeyReportDigest}
                            monkeyLoading={qualityMonkeyReportDigestLoading}
                          />
                        </Space>
                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                          <Text strong>性能分析图</Text>
                          {qualityPerformanceLoading ? (
                            <Alert showIcon type="info" message="正在加载性能采样..." />
                          ) : qualityPerformanceSamples ? (
                            <PerformanceSamplesChart data={qualityPerformanceSamples} />
                          ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未采集到性能样本" />
                          )}
                        </Space>
                      </Space>
                    </Card>
                  )}
                  {!hasQualityReportArtifact(qualityReportBuild) && (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginTop: 16 }}
                      message="当前任务暂未发现可展示的质检文件"
                      description="如果任务刚结束，稍等几秒刷新列表；如果 Jenkins 未完成归档，可先打开 Jenkins 控制台查看原始日志。"
                    />
                  )}
                </Card>
              </Col>
            </Row>
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
          <Tabs
            key={selectedBuildLog?.build.number || 'build-log'}
            defaultActiveKey="build-log"
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
            <Button type="primary" onClick={() => window.open(qrPreview.url, '_blank', 'noopener,noreferrer')}>
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
          {qrPreview?.url && <QRCode value={qrPreview.url} size={260} />}
        </Space>
      </Modal>
    </div>
  );
}
