import { Alert, Collapse, Descriptions, Empty, Space, Tag, Typography } from 'antd';
import { JenkinsQualityBuild, JenkinsQualityPerformanceSamples } from '../../services/api';
import { PerformanceDataCoverage } from './PerformanceDataCoverage';
import { PerformanceStackAnalysis } from './PerformanceStackAnalysis';
import { QualityReportKind } from './qualityOptions';

const { Text } = Typography;

function formatMilliseconds(value?: number | string | null) {
  if (value === undefined || value === null || value === '') return '-';
  const ms = Number(value);
  if (!Number.isFinite(ms)) return '-';
  if (ms >= 1000) {
    return `${ms}ms (${(ms / 1000).toFixed(2)}秒)`;
  }
  return `${ms}ms`;
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

export function PerformanceAnalysisSummary({
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
      <PerformanceStackAnalysis analysis={analysis} eventTypeLabel={eventTypeLabel} />
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
        analysis?.conclusion?.severity ? <Alert showIcon type="success" message="未发现阈值类性能风险" /> : null
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

export function StutterReportSummary({
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
      <PerformanceStackAnalysis analysis={analysis} eventTypeLabel={eventTypeLabel} />
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

export function PerformanceDiagnostics({
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
