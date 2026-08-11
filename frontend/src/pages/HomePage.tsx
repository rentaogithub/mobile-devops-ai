import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Avatar,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Progress,
  QRCode,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd';
import {
  BugOutlined,
  CheckOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  DownloadOutlined,
  EyeOutlined,
  LinkOutlined,
  PaperClipOutlined,
  ReloadOutlined,
  RobotOutlined,
  SendOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { sentryAnalysisApi } from '../services/api';
import type { SentryIssueSummary, SentryOriginalCrashResult } from '../types';
import { authUtils } from '../utils/auth';
import type { AuthUser } from '../utils/auth';

const { Text, Paragraph, Title } = Typography;
const { TextArea } = Input;

interface ToolEvent {
  type: string;
  actionId?: string;
  toolName?: string;
  domain?: string;
  riskLevel?: string;
  status?: string;
  preview?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  progress?: number;
  message?: string;
  confirmationStep?: number;
  confirmationsRequired?: number;
  secretInputs?: Array<{ name: string; label: string; description?: string; required: boolean }>;
}

interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  events: ToolEvent[];
}

interface UploadedAttachment {
  id: string;
  name: string;
  size: number;
  sha256: string;
  expiresAt: string;
}

const suggestions: Array<{ text: string; roles?: AuthUser['role'][] }> = [
  { text: '按 UID 跨系统查询最近的 Crash、日志和相关任务' },
  { text: '搜索登录相关 API 和 App 路由' },
  { text: '分析最近一次 Jenkins 失败构建，并给出修复和重建建议', roles: ['tester', 'developer', 'admin'] },
  { text: '生成过去 24 小时移动端质量日报', roles: ['tester', 'developer', 'admin'] },
];

function uid(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function readSSE(response: Response, onEvent: (event: ToolEvent & { delta?: string }) => void) {
  if (!response.ok || !response.body) {
    const body = await response.text();
    let errorMessage = body;
    try {
      const parsed = JSON.parse(body);
      errorMessage = parsed.error || parsed.message || body;
    } catch { /* 非 JSON 响应按原文展示 */ }
    throw new Error(errorMessage || `HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      const payload = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
      if (!payload) continue;
      onEvent(JSON.parse(payload));
    }
    if (done) break;
  }
}

function resultPath(event: ToolEvent) {
  if (event.domain === 'cicd') return '/cicd';
  if (event.domain === 'quality') return '/cicd/quality';
  if (event.domain === 'workflow') return '/workflow';
  if (event.domain === 'crash') return (event.result as any)?.historyId ? '/history' : '/sentry-service';
  if (event.domain === 'logs') return '/logs';
  if (event.domain === 'pods') return '/pods';
  if (event.domain === 'api') return event.toolName === 'routes_search' ? '/routes' : '/api-docs';
  return null;
}

function markdownCells(line: string) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line: string) {
  const cells = markdownCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderAssistantContent(content: string) {
  const lines = content.split('\n');
  const nodes: ReactNode[] = [];
  let textLines: string[] = [];
  let index = 0;

  const flushText = () => {
    if (textLines.length === 0) return;
    const text = textLines.join('\n').trim();
    if (text) nodes.push(<div className="assistant-text-block" key={`text-${nodes.length}`}>{text}</div>);
    textLines = [];
  };

  while (index < lines.length) {
    const headerLine = lines[index];
    const separatorLine = lines[index + 1];
    if (headerLine?.includes('|') && separatorLine && isMarkdownTableSeparator(separatorLine)) {
      flushText();
      const headers = markdownCells(headerLine);
      const rows: Record<string, string>[] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const values = markdownCells(lines[index]);
        rows.push(Object.fromEntries(headers.map((_, cellIndex) => [`column_${cellIndex}`, values[cellIndex] || '-'])));
        index += 1;
      }
      nodes.push(
        <Table
          key={`table-${nodes.length}`}
          className="assistant-result-table"
          size="small"
          pagination={false}
          scroll={{ x: 'max-content' }}
          rowKey={(_, rowIndex) => String(rowIndex)}
          columns={headers.map((header, cellIndex) => ({
            title: header || `列 ${cellIndex + 1}`,
            dataIndex: `column_${cellIndex}`,
            key: `column_${cellIndex}`,
          }))}
          dataSource={rows}
        />,
      );
      continue;
    }
    textLines.push(lines[index]);
    index += 1;
  }
  flushText();
  return nodes;
}

const resultColumnLabels: Record<string, string> = {
  id: 'Issue', number: '构建号', result: '状态', status: '状态', branch: '分支', branchName: '分支',
  suite: '测试套件', title: '标题', severity: '严重等级', source: '来源',
  timestamp: '开始时间', duration: '耗时', description: '备注', displayName: '名称',
  deployTarget: '渠道', sourceBuildNumber: '源构建', appVersion: '版本', commitHash: 'Commit',
  appVersionRange: '影响版本', count: '发生次数', userCount: '影响用户', lastSeen: '最近发生',
  channelQrUrl: '安装二维码', progress: '进度', updatedAt: '更新时间', createdAt: '创建时间',
  service: '服务', serviceTitle: '服务名称', method: '方法', path: '路径', summary: '用途', operationId: 'Operation ID', tag: '分组', parameterCount: '参数数', sampleCount: '调用样本',
  file: '文件', line: '行号', route: '路由', module: '模块/负责人', compatibility: '跨端兼容', snippet: '代码位置',
  archiveId: '日志包', archiveTime: '日志时间', content: '日志内容', matchCount: '命中数', fileCount: '文件数', type: '类型',
  version: '版本', issueCount: 'Issue 数', eventCount: '事件数', affectedUsers: '影响用户', topIssue: '首要问题',
  uuid: 'UUID', appName: '应用/组件', buildNumber: '构建号', architecture: '架构', uploadTime: '上传时间',
  component: '依赖组件', requirement: '版本约束', rank: '优先级', cause: '可能原因', evidence: '证据',
  label: '指标', value: '值', terminal: '已结束',
  logId: '日志 ID', logType: '日志类型',
  download: '下载',
};

function compactTable(
  rows: Record<string, unknown>[],
  keys: string[],
  options: {
    rowKey?: (row: Record<string, unknown>, index?: number) => string;
    render?: (key: string, value: unknown, row: Record<string, unknown>) => ReactNode | undefined;
    scrollX?: number | string;
  } = {},
) {
  if (rows.length === 0) return null;
  return (
    <Table
      className="assistant-result-table"
      size="small"
      pagination={rows.length > 8 ? { pageSize: 8, size: 'small', showSizeChanger: false } : false}
      scroll={{ x: options.scrollX || 'max-content' }}
      rowKey={(row, index) => options.rowKey?.(row, index) || String(row.id || row.uuid || row.number || row.path || index)}
      columns={keys.map((key) => ({
        title: resultColumnLabels[key] || key,
        dataIndex: key,
        key,
        ellipsis: ['title', 'summary', 'content', 'snippet', 'evidence'].includes(key),
        render: (value: unknown, row: Record<string, unknown>) => options.render?.(key, value, row) ?? resultCell(value, key),
      }))}
      dataSource={rows}
    />
  );
}

function resultCell(value: unknown, key: string) {
  if (value === null || value === undefined || value === '') return '-';
  if (key === 'timestamp' && typeof value === 'number') return new Date(value).toLocaleString();
  if (['lastSeen', 'firstSeen', 'updatedAt', 'createdAt'].includes(key)) {
    const timestamp = Date.parse(String(value));
    if (Number.isFinite(timestamp)) return new Date(timestamp).toLocaleString();
  }
  if (key === 'duration' && typeof value === 'number') return `${Math.round(value / 1000)} 秒`;
  if (key === 'commitHash') return String(value).slice(0, 12);
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 160);
  return String(value);
}

function renderClosureResult(
  event: ToolEvent,
  openSentryIssue?: (issue: Record<string, unknown>) => void,
  openBuildDetail?: (buildNumber: number) => void,
) {
  const result = event.result as any;
  if (!result || typeof result !== 'object' || Array.isArray(result) || !result.kind) return null;

  if (result.kind === 'build_failure_diagnosis') {
    const analysis = result.analysis || {};
    return (
      <div className="assistant-closure-card assistant-closure-danger">
        <div className="assistant-closure-title">
          <WarningOutlined />
          <Text strong>构建 #{result.build?.number} · {analysis.stage || '失败定位'}</Text>
          <Tag color="red">{String(analysis.severity || 'high').toUpperCase()}</Tag>
        </div>
        <Text>{analysis.summary || analysis.rootCause || '已定位构建失败'}</Text>
        {analysis.rootCause && <div className="assistant-closure-highlight"><strong>根因：</strong>{analysis.rootCause}</div>}
        {Array.isArray(analysis.evidence) && analysis.evidence.length > 0 && (
          <div><Text type="secondary">关键证据</Text><ul>{analysis.evidence.map((item: string, index: number) => <li key={index}>{item}</li>)}</ul></div>
        )}
        {Array.isArray(analysis.suggestions) && analysis.suggestions.length > 0 && (
          <div><Text type="secondary">处理建议</Text><ul>{analysis.suggestions.map((item: string, index: number) => <li key={index}>{item}</li>)}</ul></div>
        )}
        {analysis.ownerHint && <Tag>建议处理：{analysis.ownerHint}</Tag>}
      </div>
    );
  }

  if (result.kind === 'build_verification') {
    const gateStatus = result.releaseGate?.status;
    const passed = result.passed && gateStatus !== 'blocked';
    return (
      <div className={`assistant-closure-card ${passed ? 'assistant-closure-success' : 'assistant-closure-warning'}`}>
        <div className="assistant-closure-title">
          {passed ? <CheckCircleOutlined /> : <WarningOutlined />}
          <Text strong>{result.quality ? '质检任务' : '构建'} #{result.build?.number} 验证</Text>
          <Tag color={passed ? 'green' : result.status === 'running' ? 'blue' : 'orange'}>{result.status}</Tag>
          {gateStatus && <Tag color={gateStatus === 'passed' ? 'green' : gateStatus === 'blocked' ? 'red' : 'gold'}>门禁 {gateStatus}</Tag>}
        </div>
        <div className="assistant-closure-facts">
          <span>分支<strong>{result.build?.branchName || '-'}</strong></span>
          <span>版本<strong>{result.build?.appVersion || '-'}</strong></span>
          <span>渠道<strong>{result.build?.deployTarget || (result.quality ? '自动质检' : '-')}</strong></span>
        </div>
        {result.releaseGate?.result?.summary && <div className="assistant-closure-highlight">{result.releaseGate.result.summary}</div>}
        {result.releaseGateError && <Alert type="warning" showIcon message={result.releaseGateError} />}
        {Array.isArray(result.nextActions) && <ul>{result.nextActions.map((item: string, index: number) => <li key={index}>{item}</li>)}</ul>}
      </div>
    );
  }

  if (result.kind === 'task_verification') {
    return (
      <div className={`assistant-closure-card ${result.passed ? 'assistant-closure-success' : 'assistant-closure-warning'}`}>
        <div className="assistant-closure-title">
          {result.passed ? <CheckCircleOutlined /> : result.terminal ? <WarningOutlined /> : <ReloadOutlined spin />}
          <Text strong>任务 {result.task?.id}</Text>
          <Tag color={result.passed ? 'green' : result.terminal ? 'red' : 'blue'}>{result.task?.status}</Tag>
        </div>
        <Text>测试套件：{result.task?.suite || '-'} · 关联问题：{result.issues?.length || 0}</Text>
        {Array.isArray(result.nextActions) && <ul>{result.nextActions.map((item: string, index: number) => <li key={index}>{item}</li>)}</ul>}
      </div>
    );
  }

  if (result.kind === 'release_health_verification') {
    const healthy = result.status === 'healthy';
    return (
      <div className={`assistant-closure-card ${healthy ? 'assistant-closure-success' : 'assistant-closure-warning'}`}>
        <div className="assistant-closure-title">
          {healthy ? <CheckCircleOutlined /> : <WarningOutlined />}
          <Text strong>版本 {result.releaseVersion} 发布后验证</Text>
          <Tag color={healthy ? 'green' : result.status === 'critical' ? 'red' : 'gold'}>{result.status}</Tag>
        </div>
        <Text>观察指标 {result.observationCount || 0} 项，异常 {result.anomalyCount || 0} 项</Text>
        {Array.isArray(result.recommendations) && <ul>{result.recommendations.map((item: string, index: number) => <li key={index}>{item}</li>)}</ul>}
      </div>
    );
  }

  if (result.kind === 'build_retry' || result.kind === 'quality_retry') {
    return (
      <div className="assistant-closure-card assistant-closure-success">
        <div className="assistant-closure-title">
          <ReloadOutlined />
          <Text strong>{result.kind === 'build_retry' ? '构建重试已提交' : '质检重跑已提交'}</Text>
          <Tag color="blue">QUEUED</Tag>
        </div>
        <Text>来源任务 #{result.retryOf}，请在新任务开始后执行验证。</Text>
      </div>
    );
  }

  if (result.kind === 'cross_system_diagnosis') {
    const causes = Array.isArray(result.possibleCauses) ? result.possibleCauses : [];
    const crashes = Array.isArray(result.crashes) ? result.crashes : [];
    const logMatches = Array.isArray(result.logMatches) ? result.logMatches : [];
    return (
      <div className={`assistant-closure-card ${causes.length > 0 ? 'assistant-closure-warning' : 'assistant-closure-success'}`}>
        <div className="assistant-closure-title">
          {causes.length > 0 ? <WarningOutlined /> : <CheckCircleOutlined />}
          <Text strong>跨系统诊断结果</Text>
          <Tag color={causes.length > 0 ? 'gold' : 'green'}>{causes.length} 个可能原因</Tag>
        </div>
        <div className="assistant-closure-facts">
          <span>Crash<strong>{result.summary?.crashIssues || 0}</strong></span>
          <span>日志命中<strong>{result.summary?.logMatches || 0}</strong></span>
          <span>关联任务<strong>{result.summary?.workflowTasks || 0}</strong></span>
          <span>质量问题<strong>{result.summary?.workflowIssues || 0}</strong></span>
        </div>
        {compactTable(causes, ['rank', 'cause', 'evidence'])}
        {crashes.length > 0 && (
          <div>
            <Text type="secondary">关联 Crash</Text>
            {compactTable(crashes, ['id', 'title', 'appVersionRange', 'count', 'lastSeen'], {
              render: (key, value, row) => key === 'id' && openSentryIssue ? (
                <Button type="link" size="small" className="assistant-build-link" onClick={() => openSentryIssue(row)}>#{resultCell(value, key)}</Button>
              ) : undefined,
            })}
          </div>
        )}
        {logMatches.length > 0 && (
          <div>
            <Text type="secondary">关键日志</Text>
            {compactTable(logMatches, ['archiveTime', 'version', 'time', 'content'], { scrollX: 900 })}
          </div>
        )}
        {result.sourceErrors && Object.keys(result.sourceErrors).length > 0 && <Alert type="warning" showIcon message="部分数据源暂不可用" description={Object.values(result.sourceErrors).join('；')} />}
      </div>
    );
  }

  if (result.kind === 'log_search') {
    const matches = Array.isArray(result.matches) ? result.matches : [];
    const archives = Array.isArray(result.archives) ? result.archives : [];
    const archiveRows = archives.map((item: any) => ({
      id: item.id,
      uploadTime: item.uploadTime || item.time,
      version: item.version,
      download: item.downloadUrl,
    }));
    const contentSearch = Boolean(result.query?.keyword || result.query?.startTime || result.query?.endTime);
    return (
      <div className={`assistant-closure-card ${matches.length > 0 ? 'assistant-closure-warning' : 'assistant-closure-success'}`}>
        <div className="assistant-closure-title">
          <Text strong>日志查询</Text>
          {contentSearch && <Tag color={matches.length > 0 ? 'gold' : 'green'}>{matches.length} 条命中</Tag>}
        </div>
        {matches.length > 0
          ? compactTable(matches, ['archiveTime', 'version', 'file', 'time', 'content'], { scrollX: 1000 })
          : archives.length > 0
            ? compactTable(archiveRows, ['uploadTime', 'version', 'download'], {
              render: (key, value, row) => key === 'download' ? (
                value ? (
                  <a
                    href={String(value)}
                    target="_blank"
                    rel="noopener noreferrer"
                    download={`feedback-log-${String(row.id || Date.now())}.zip`}
                  >
                    <DownloadOutlined /> 下载
                  </a>
                ) : <Text type="secondary">不可下载</Text>
              ) : undefined,
            })
            : <div className="assistant-result-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未查询到该用户的反馈日志" /></div>}
        {Array.isArray(result.warnings) && result.warnings.length > 0 && <Alert type="warning" showIcon message={result.warnings.join('；')} />}
      </div>
    );
  }

  if (result.kind === 'crash_version_comparison') {
    const versions = Array.isArray(result.versions) ? result.versions : [];
    const newIssues = Array.isArray(result.newIssues) ? result.newIssues : [];
    return (
      <div className={`assistant-closure-card ${newIssues.length > 0 ? 'assistant-closure-warning' : 'assistant-closure-success'}`}>
        <div className="assistant-closure-title">
          <BugOutlined />
          <Text strong>Crash 版本对比 · {result.period}</Text>
          <Tag color={newIssues.length > 0 ? 'red' : 'green'}>新增 {newIssues.length}</Tag>
        </div>
        <div className="assistant-closure-highlight">{result.conclusion}</div>
        {compactTable(versions, ['version', 'issueCount', 'eventCount', 'affectedUsers', 'topIssue'])}
        {newIssues.length > 0 && (
          <div>
            <Text type="secondary">新版本新增问题</Text>
            {compactTable(newIssues, ['id', 'title', 'count', 'userCount', 'lastSeen'], {
              render: (key, value, row) => key === 'id' && openSentryIssue ? (
                <Button type="link" size="small" className="assistant-build-link" onClick={() => openSentryIssue(row)}>#{resultCell(value, key)}</Button>
              ) : undefined,
            })}
          </div>
        )}
      </div>
    );
  }

  if (result.kind === 'dsym_diagnosis') {
    const available = result.status === 'available';
    const matches = Array.isArray(result.matches) ? result.matches : [];
    return (
      <div className={`assistant-closure-card ${available ? 'assistant-closure-success' : 'assistant-closure-danger'}`}>
        <div className="assistant-closure-title">
          {available ? <CheckCircleOutlined /> : <WarningOutlined />}
          <Text strong>dSYM 诊断</Text>
          <Tag color={available ? 'green' : 'red'}>{available ? '已找到' : '缺失'}</Tag>
        </div>
        <div className="assistant-closure-highlight">{result.conclusion}</div>
        {compactTable(matches, ['uuid', 'appName', 'version', 'buildNumber', 'architecture', 'uploadTime'], { scrollX: 900 })}
      </div>
    );
  }

  if (result.kind === 'pods_impact') {
    const dependencies = Array.isArray(result.dependencies) ? result.dependencies : [];
    const dependents = Array.isArray(result.dependents) ? result.dependents : [];
    return (
      <div className="assistant-closure-card assistant-closure-warning">
        <div className="assistant-closure-title">
          <Text strong>{result.component?.name} {result.component?.version} 依赖影响</Text>
          {result.upgradeAvailable && <Tag color="blue">最新 {result.latestVersion}</Tag>}
          <Tag>{dependents.length} 个依赖方</Tag>
        </div>
        {Array.isArray(result.risks) && <ul>{result.risks.map((item: string, index: number) => <li key={index}>{item}</li>)}</ul>}
        {dependencies.length > 0 && <div><Text type="secondary">直接依赖</Text>{compactTable(dependencies, ['name', 'requirement'])}</div>}
        {dependents.length > 0 && <div><Text type="secondary">内部依赖方</Text>{compactTable(dependents, ['component', 'version', 'requirement'])}</div>}
      </div>
    );
  }

  if (result.kind === 'api_search' || result.kind === 'route_search') {
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const isApi = result.kind === 'api_search';
    return (
      <div className="assistant-closure-card">
        <div className="assistant-closure-title">
          <Text strong>{isApi ? 'API 查询' : 'App 路由查询'} · {result.keyword}</Text>
          <Tag color="blue">{result.total || rows.length} 条</Tag>
        </div>
        {rows.length > 0
          ? compactTable(rows, isApi
            ? ['serviceTitle', 'method', 'path', 'summary', 'tag', 'parameterCount', 'sampleCount']
            : ['route', 'module', 'compatibility', 'file', 'line', 'snippet'], { scrollX: isApi ? 1100 : 1200 })
          : <div className="assistant-result-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未找到匹配结果" /></div>}
        {result.note && <Text type="secondary">{result.note}</Text>}
      </div>
    );
  }

  if (result.kind === 'quality_daily_report') {
    const metrics = Object.entries(result.metrics || {}).map(([label, value]) => ({ label, value }));
    const metricLabels: Record<string, string> = {
      builds: '构建数', buildSuccessRate: '构建成功率', qualityTasks: '质检任务', qualityFailures: '质检失败', newCrashIssues: '新增 Crash', crashEvents: 'Crash 事件', openHighRisks: '高风险 Issue',
    };
    const risks = Array.isArray(result.risks) ? result.risks : [];
    return (
      <div className={`assistant-closure-card ${risks.length > 0 ? 'assistant-closure-warning' : 'assistant-closure-success'}`}>
        <div className="assistant-closure-title">
          {risks.length > 0 ? <WarningOutlined /> : <CheckCircleOutlined />}
          <Text strong>移动端质量日报 · 过去 {result.hours} 小时</Text>
          <Tag color={risks.length > 0 ? 'gold' : 'green'}>{risks.length} 项风险</Tag>
        </div>
        <div className="assistant-closure-highlight">{result.conclusion}</div>
        <div className="assistant-closure-facts assistant-quality-metrics">
          {metrics.map((item) => (
            <span key={item.label}>{metricLabels[item.label] || item.label}<strong>{item.label === 'buildSuccessRate' && item.value !== null ? `${item.value}%` : resultCell(item.value, 'value')}</strong></span>
          ))}
        </div>
        {compactTable(risks, ['type', 'id', 'title', 'severity', 'count'])}
      </div>
    );
  }

  if (result.kind === 'quality_task_created') {
    return (
      <div className="assistant-closure-card assistant-closure-success">
        <div className="assistant-closure-title">
          <CheckCircleOutlined />
          <Text strong>质检任务已创建</Text>
          <Tag color="blue">{result.task?.status || 'queued'}</Tag>
        </div>
        <div className="assistant-closure-facts">
          <span>任务 ID<strong>{result.task?.id || '-'}</strong></span>
          <span>测试套件<strong>{result.task?.suite || '-'}</strong></span>
          <span>源构建<strong>{result.task?.buildNumber || '-'}</strong></span>
        </div>
      </div>
    );
  }

  if (result.kind === 'release_submission') {
    const tracking = result.tracking || {};
    const phase = String(tracking.phase || 'queued');
    const successful = phase === 'success';
    const failed = ['failed', 'canceled', 'unstable'].includes(phase);
    const statusLabel = phase === 'running' ? 'BUILDING' : phase === 'success' ? 'SUCCESS' : phase === 'failed' ? 'FAILURE' : phase === 'canceled' ? 'ABORTED' : phase === 'unstable' ? 'UNSTABLE' : 'QUEUED';
    return (
      <div className={`assistant-closure-card ${successful ? 'assistant-closure-success' : failed ? 'assistant-closure-danger' : 'assistant-closure-warning'}`}>
        <div className="assistant-closure-title">
          {successful ? <CheckCircleOutlined /> : failed ? <WarningOutlined /> : <ReloadOutlined spin />}
          <Text strong>{result.deployTarget} {successful ? '发布成功' : failed ? '发布失败' : phase === 'running' ? '正在发布' : '已进入队列'}</Text>
          <Tag color={successful ? 'green' : failed ? 'red' : 'blue'}>{statusLabel}</Tag>
        </div>
        <div className="assistant-closure-facts">
          <span>分支<strong>{result.branch || '-'}</strong></span>
          <span>构建号<strong>{tracking.buildNumber ? <Button type="link" size="small" onClick={() => openBuildDetail?.(Number(tracking.buildNumber))}>#{tracking.buildNumber}</Button> : '待分配'}</strong></span>
          <span>门禁<strong>{result.releaseGate?.status || (result.deployTarget === 'Pgyer' ? '不需要' : '-')}</strong></span>
        </div>
        {tracking.message && <Text type={failed ? 'danger' : 'secondary'}>{tracking.message}</Text>}
        {result.trackingError && <Alert type="warning" showIcon message={`状态同步暂时失败：${result.trackingError}`} />}
      </div>
    );
  }

  if (result.kind === 'build_submission') {
    const tracking = result.tracking || {};
    const phase = String(tracking.phase || 'queued');
    const successful = phase === 'success';
    const failed = ['failed', 'canceled', 'unstable'].includes(phase);
    const statusLabel = phase === 'running' ? 'BUILDING' : phase === 'success' ? 'SUCCESS' : phase === 'failed' ? 'FAILURE' : phase === 'canceled' ? 'ABORTED' : phase === 'unstable' ? 'UNSTABLE' : 'QUEUED';
    return (
      <div className={`assistant-closure-card ${successful ? 'assistant-closure-success' : failed ? 'assistant-closure-danger' : 'assistant-closure-warning'}`}>
        <div className="assistant-closure-title">
          {successful ? <CheckCircleOutlined /> : failed ? <WarningOutlined /> : <ReloadOutlined spin />}
          <Text strong>Pgyer {successful ? '发布成功' : failed ? '发布失败' : phase === 'running' ? '正在构建' : '已进入队列'}</Text>
          <Tag color={successful ? 'green' : failed ? 'red' : 'blue'}>{statusLabel}</Tag>
        </div>
        <div className="assistant-closure-facts">
          <span>分支<strong>{tracking.branch || result.branch || '-'}</strong></span>
          <span>发布渠道<strong>Pgyer</strong></span>
          <span>构建号<strong>{tracking.buildNumber ? <Button type="link" size="small" onClick={() => openBuildDetail?.(Number(tracking.buildNumber))}>#{tracking.buildNumber}</Button> : '待分配'}</strong></span>
        </div>
        {tracking.message && <Text type={failed ? 'danger' : 'secondary'}>{tracking.message}</Text>}
        {result.trackingError && <Alert type="warning" showIcon message={`状态同步暂时失败：${result.trackingError}`} />}
      </div>
    );
  }

  if (result.kind === 'task_tracking') {
    const running = !result.terminal;
    const issues = Array.isArray(result.issues) ? result.issues : [];
    return (
      <div className={`assistant-closure-card ${running ? 'assistant-closure-warning' : /pass|success|complete/i.test(String(result.status)) ? 'assistant-closure-success' : 'assistant-closure-danger'}`}>
        <div className="assistant-closure-title">
          {running ? <ReloadOutlined spin /> : /pass|success|complete/i.test(String(result.status)) ? <CheckCircleOutlined /> : <WarningOutlined />}
          <Text strong>{result.taskType} 任务 {result.id}</Text>
          <Tag color={running ? 'blue' : /pass|success|complete/i.test(String(result.status)) ? 'green' : 'red'}>{result.status}</Tag>
        </div>
        {result.verification?.build && (
          <div className="assistant-closure-facts">
            <span>分支<strong>{result.verification.build.branchName || '-'}</strong></span>
            <span>版本<strong>{result.verification.build.appVersion || '-'}</strong></span>
            <span>门禁<strong>{result.verification.releaseGate?.status || '-'}</strong></span>
          </div>
        )}
        {issues.length > 0 && compactTable(issues, ['id', 'title', 'severity', 'status', 'updatedAt'])}
      </div>
    );
  }

  return null;
}

function renderToolResult(
  event: ToolEvent,
  openBuildDetail: (buildNumber: number) => void,
  openQrPreview: (url: string) => void,
  openSentryIssue: (issue: Record<string, unknown>) => void,
) {
  const isSentryIssueList = event.toolName === 'sentry_list_issues' || event.toolName === 'sentry_find_user_issues';
  const closureResult = renderClosureResult(event, openSentryIssue, openBuildDetail);
  if (closureResult) return closureResult;
  if (!Array.isArray(event.result)) {
    return <pre className="assistant-json">{JSON.stringify(event.result, null, 2).slice(0, 12_000)}</pre>;
  }
  const rows = event.result as Record<string, unknown>[];
  if (rows.length === 0) {
    return (
      <div className="assistant-result-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无符合条件的数据" />
      </div>
    );
  }
  if (isSentryIssueList && rows.length === 1) {
    const issue = rows[0];
    return (
      <div className="assistant-crash-card">
        <div className="assistant-crash-card-main">
          <div className="assistant-crash-icon"><BugOutlined /></div>
          <div className="assistant-crash-summary">
            <div className="assistant-crash-heading">
              <Text strong className="assistant-crash-title">{resultCell(issue.title, 'title')}</Text>
              {Boolean(issue.level) && <Tag color="red">{String(issue.level).toUpperCase()}</Tag>}
            </div>
            <Text type="secondary">
              Issue #{resultCell(issue.id, 'id')}
              {issue.lastSeen ? ` · 最近发生 ${resultCell(issue.lastSeen, 'lastSeen')}` : ''}
            </Text>
          </div>
        </div>
        <div className="assistant-crash-metrics">
          <div><span>影响版本</span><strong>{resultCell(issue.appVersionRange || issue.maxAppVersion, 'appVersionRange')}</strong></div>
          <div><span>发生次数</span><strong>{resultCell(issue.count, 'count')}</strong></div>
          <div><span>影响用户</span><strong>{resultCell(issue.userCount, 'userCount')}</strong></div>
        </div>
        <Button type="primary" ghost icon={<EyeOutlined />} onClick={() => openSentryIssue(issue)}>
          查看崩溃详情
        </Button>
      </div>
    );
  }
  const preferredKeys = event.toolName === 'cicd_list_builds'
    ? ['number', 'result', 'timestamp', 'duration', 'description', 'channelQrUrl']
    : event.toolName === 'quality_list_tasks'
      ? ['number', 'result', 'suite', 'sourceBuildNumber', 'timestamp', 'duration', 'description']
      : isSentryIssueList
        ? ['id', 'title', 'appVersionRange', 'count', 'userCount', 'lastSeen']
        : ['id', 'number', 'title', 'status', 'severity', 'suite', 'source', 'branch', 'updatedAt', 'createdAt'];
  const availableKeys = Array.from(new Set(rows.slice(0, 20).flatMap((row) => (
    Object.keys(row || {}).filter((key) => row[key] !== undefined && row[key] !== null && row[key] !== '')
  ))));
  const keys = event.toolName === 'cicd_list_builds'
    ? preferredKeys
    : isSentryIssueList
      ? preferredKeys.filter((key) => availableKeys.includes(key))
    : [
        ...preferredKeys.filter((key) => availableKeys.includes(key)),
        ...availableKeys.filter((key) => !preferredKeys.includes(key) && !['url', 'parameters', 'actions', 'config', 'result', 'building', 'displayName'].includes(key)),
      ].slice(0, 7);
  return (
    <Table
      className="assistant-result-table"
      size="small"
      pagination={rows.length > 10 ? { pageSize: 10, size: 'small', showSizeChanger: false } : false}
      scroll={{ x: isSentryIssueList ? 860 : 'max-content' }}
      rowKey={(row, rowIndex) => String(row.id || row.number || rowIndex)}
      columns={keys.map((key) => ({
        title: resultColumnLabels[key] || key,
        dataIndex: key,
        key,
        ...(isSentryIssueList ? {
          width: key === 'title' ? 380 : key === 'lastSeen' ? 170 : key === 'appVersionRange' ? 130 : 90,
          ellipsis: key === 'title',
        } : {}),
        render: (value: unknown, row: Record<string, unknown>) => {
          if (key === 'id' && isSentryIssueList && String(value || '').trim()) {
            return (
              <Button
                type="link"
                size="small"
                className="assistant-build-link"
                onClick={() => openSentryIssue(row)}
              >
                #{resultCell(value, key)}
              </Button>
            );
          }
          if (key === 'title' && isSentryIssueList) {
            const title = resultCell(value, key);
            return <Tooltip title={title}><span className="assistant-sentry-title">{title}</span></Tooltip>;
          }
          if (key === 'number' && event.toolName === 'cicd_list_builds' && Number.isFinite(Number(value))) {
            return (
              <Button
                type="link"
                size="small"
                className="assistant-build-link"
                onClick={() => openBuildDetail(Number(value))}
              >
                #{resultCell(value, key)}
              </Button>
            );
          }
          if (key === 'channelQrUrl') {
            const url = String(value || '').trim();
            return url ? (
              <button
                type="button"
                className="assistant-install-qr"
                title="放大二维码"
                onClick={() => openQrPreview(url)}
              >
                <QRCode value={url} size={58} bordered={false} />
              </button>
            ) : '-';
          }
          return key === 'result' || key === 'status'
            ? <Tag color={/success|passed|completed/i.test(String(value)) ? 'green' : /fail|abort|cancel|block/i.test(String(value)) ? 'red' : 'blue'}>{resultCell(value, key)}</Tag>
            : resultCell(value, key);
        },
      }))}
      dataSource={rows}
    />
  );
}

function hasTabularResult(event: ToolEvent) {
  return (Array.isArray(event.result) && event.result.length > 0) || Boolean(event.result && typeof event.result === 'object' && !Array.isArray(event.result) && (event.result as any).kind);
}

function renderToolPreview(event: ToolEvent) {
  if (!event.preview) return null;
  if (event.toolName === 'cicd_trigger_build') {
    return (
      <div className="assistant-closure-card assistant-closure-warning">
        <div className="assistant-closure-title">
          <WarningOutlined />
          <Text strong>确认构建 Pgyer 安装包</Text>
          <Tag color="gold">待确认</Tag>
        </div>
        <div className="assistant-closure-facts">
          <span>分支<strong>{String(event.preview.branch || '-')}</strong></span>
          <span>发布渠道<strong>Pgyer</strong></span>
          <span>确认次数<strong>1 次</strong></span>
        </div>
        <Text type="secondary">{String(event.preview.description || '确认后将触发 Jenkins 主工程构建。')}</Text>
      </div>
    );
  }
  return <pre className="assistant-json">{JSON.stringify(event.preview, null, 2)}</pre>;
}

function renderQuickActions(result: unknown, runPrompt: (prompt: string) => void) {
  const actions = result && typeof result === 'object' && !Array.isArray(result) && Array.isArray((result as any).quickActions)
    ? (result as any).quickActions as Array<{ label?: string; prompt?: string }>
    : [];
  const isAutoTrackedSubmission = result && typeof result === 'object' && !Array.isArray(result)
    && ['build_submission', 'release_submission'].includes(String((result as any).kind || ''));
  const visibleActions = actions.filter((action) => action.prompt && !(isAutoTrackedSubmission && /跟踪/.test(String(action.label || ''))));
  if (visibleActions.length === 0) return null;
  return (
    <Space wrap className="assistant-quick-actions">
      {visibleActions.slice(0, 5).map((action, index) => (
        <Button key={`${action.label || action.prompt}-${index}`} size="small" onClick={() => runPrompt(String(action.prompt))}>
          {action.label || '继续处理'}
        </Button>
      ))}
    </Space>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [attachment, setAttachment] = useState<UploadedAttachment | null>(null);
  const [qrPreviewUrl, setQrPreviewUrl] = useState('');
  const [crashDetailOpen, setCrashDetailOpen] = useState(false);
  const [crashDetailLoading, setCrashDetailLoading] = useState(false);
  const [crashDetailIssue, setCrashDetailIssue] = useState<SentryIssueSummary | null>(null);
  const [crashDetail, setCrashDetail] = useState<SentryOriginalCrashResult | null>(null);
  const [crashDetailError, setCrashDetailError] = useState('');
  const [secretValues, setSecretValues] = useState<Record<string, Record<string, string>>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const buildTrackingTimers = useRef<Map<string, number>>(new Map());
  const currentRole = authUtils.getUser()?.role || 'guest';
  const visibleSuggestions = suggestions.filter((suggestion) => !suggestion.roles || suggestion.roles.includes(currentRole));

  useEffect(() => {
    if (entries.length === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, loading]);

  useEffect(() => () => {
    for (const timer of buildTrackingTimers.current.values()) window.clearTimeout(timer);
    buildTrackingTimers.current.clear();
  }, []);

  const updateAssistant = (id: string, updater: (entry: ChatEntry) => ChatEntry) => {
    setEntries((previous) => previous.map((entry) => entry.id === id ? updater(entry) : entry));
  };

  const startBuildStatusPolling = (assistantId: string, actionId: string) => {
    if (buildTrackingTimers.current.has(actionId)) return;
    const poll = async () => {
      try {
        const response = await fetch(`/api/assistant/actions/${encodeURIComponent(actionId)}/status`, { credentials: 'include' });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || '同步构建状态失败');
        const tracking = body.data || {};
        updateAssistant(assistantId, (entry) => ({
          ...entry,
          events: entry.events.map((event) => event.actionId === actionId
            ? {
                ...event,
                result: event.result && typeof event.result === 'object' && !Array.isArray(event.result)
                  ? { ...(event.result as Record<string, unknown>), tracking, trackingError: undefined }
                  : event.result,
              }
            : event),
        }));
        if (tracking.terminal) {
          buildTrackingTimers.current.delete(actionId);
          return;
        }
        const timer = window.setTimeout(poll, tracking.phase === 'queued' ? 4000 : 6000);
        buildTrackingTimers.current.set(actionId, timer);
      } catch (error: any) {
        updateAssistant(assistantId, (entry) => ({
          ...entry,
          events: entry.events.map((event) => event.actionId === actionId && event.result && typeof event.result === 'object' && !Array.isArray(event.result)
            ? { ...event, result: { ...(event.result as Record<string, unknown>), trackingError: error?.message || '同步失败' } }
            : event),
        }));
        const timer = window.setTimeout(poll, 10_000);
        buildTrackingTimers.current.set(actionId, timer);
      }
    };
    const timer = window.setTimeout(poll, 800);
    buildTrackingTimers.current.set(actionId, timer);
  };

  const applyEvent = (assistantId: string, event: ToolEvent & { delta?: string }) => {
    if (event.type === 'assistant.delta') {
      updateAssistant(assistantId, (entry) => ({ ...entry, content: entry.content + (event.delta || '') }));
      return;
    }
    if (event.type === 'assistant.completed') return;
    if (event.type === 'tool.failed' && !event.actionId) {
      updateAssistant(assistantId, (entry) => ({ ...entry, content: `${entry.content}${entry.content ? '\n\n' : ''}执行失败：${event.error || '未知错误'}` }));
      return;
    }
    updateAssistant(assistantId, (entry) => {
      const key = event.actionId || `${event.toolName || 'unknown'}_${entry.events.length}`;
      const index = entry.events.findIndex((item) => (item.actionId || item.toolName) === (event.actionId || event.toolName));
      if (index < 0) return { ...entry, events: [...entry.events, { ...event, actionId: key }] };
      const events = [...entry.events];
      events[index] = { ...events[index], ...event };
      return { ...entry, events };
    });
    const result = event.result as any;
    if (event.type === 'tool.completed' && event.actionId && ['build_submission', 'release_submission'].includes(String(result?.kind || ''))) {
      startBuildStatusPolling(assistantId, event.actionId);
    }
  };

  const consume = async (url: string, body: unknown, assistantId: string) => {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await readSSE(response, (event) => applyEvent(assistantId, event));
  };

  const send = async (override?: string) => {
    const text = String(override ?? input).trim();
    if (!text && !attachment) return;
    const attachmentContext = attachment
      ? `\n\n[会话附件 attachmentId=${attachment.id}, name=${attachment.name}, sha256=${attachment.sha256}]`
      : '';
    const userEntry: ChatEntry = { id: uid('user'), role: 'user', content: `${text || '请处理附件'}${attachmentContext}`, events: [] };
    const assistantEntry: ChatEntry = { id: uid('assistant'), role: 'assistant', content: '', events: [] };
    const requestEntries = [...entries, userEntry];
    setEntries([...requestEntries, assistantEntry]);
    setInput('');
    setAttachment(null);
    setLoading(true);
    try {
      await consume('/api/assistant/turn', {
        messages: requestEntries.map(({ role, content }) => ({ role, content })),
      }, assistantEntry.id);
    } catch (error: any) {
      applyEvent(assistantEntry.id, { type: 'tool.failed', error: error?.message || '会话请求失败' });
    } finally {
      setLoading(false);
    }
  };

  const decide = async (assistantId: string, actionId: string, decision: 'approve' | 'reject') => {
    setLoading(true);
    try {
      await consume(`/api/assistant/actions/${encodeURIComponent(actionId)}/decision`, {
        decision,
        secretInputs: decision === 'approve' ? (secretValues[actionId] || {}) : {},
      }, assistantId);
      setSecretValues((previous) => {
        const next = { ...previous };
        delete next[actionId];
        return next;
      });
    } catch (error: any) {
      applyEvent(assistantId, { type: 'tool.failed', actionId, error: error?.message || '审批失败' });
    } finally {
      setLoading(false);
    }
  };

  const openCrashDetail = async (issue: Record<string, unknown>) => {
    const target = issue as unknown as SentryIssueSummary;
    setCrashDetailIssue(target);
    setCrashDetail(null);
    setCrashDetailError('');
    setCrashDetailOpen(true);
    setCrashDetailLoading(true);
    try {
      const response = await sentryAnalysisApi.buildOriginalCrash({ issue: target });
      if (!response.success || !response.data) {
        throw new Error(response.error || '读取崩溃详情失败');
      }
      setCrashDetail(response.data);
    } catch (error: any) {
      setCrashDetailError(error?.message || '读取崩溃详情失败');
    } finally {
      setCrashDetailLoading(false);
    }
  };

  const uploadAttachment = async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    try {
      const response = await fetch('/api/assistant/attachments', { method: 'POST', credentials: 'include', body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '上传失败');
      setAttachment(data.data);
      message.success('附件已加入当前会话，15 分钟内有效');
    } catch (error: any) {
      message.error(error?.message || '附件上传失败');
    }
    return false;
  };

  return (
    <div className="assistant-home">
      <div className="assistant-topbar">
        <div>
          <Space align="center">
            <Avatar className="assistant-logo" icon={<RobotOutlined />} />
            <div>
              <Title level={4} style={{ margin: 0 }}>AI 会话执行中心</Title>
              <Text type="secondary">按当前角色权限执行；查询直接执行，任务与发布按确认流程执行</Text>
            </div>
          </Space>
        </div>
      </div>

      <div className="assistant-thread">
        {entries.length === 0 && (
          <div className="assistant-empty">
            <Empty image={<RobotOutlined className="assistant-empty-icon" />} description={false}>
              <Title level={3}>直接告诉我你想完成什么</Title>
              <Paragraph type="secondary">我可以查询 Crash、构建、质检和质量中心，并在你确认后执行受控操作。</Paragraph>
              <Space wrap className="assistant-suggestions">
                {visibleSuggestions.map((suggestion) => (
                  <Button key={suggestion.text} onClick={() => void send(suggestion.text)}>{suggestion.text}</Button>
                ))}
              </Space>
            </Empty>
          </div>
        )}

        {entries.map((entry) => (
          <div className={`assistant-message assistant-message-${entry.role}`} key={entry.id}>
            <Avatar icon={entry.role === 'assistant' ? <RobotOutlined /> : <UserOutlined />} />
            <div className="assistant-message-body">
              {entry.content && !entry.events.some(hasTabularResult) && (
                <div className="assistant-message-text">{renderAssistantContent(entry.content)}</div>
              )}
              {entry.role === 'assistant' && !entry.content && entry.events.length === 0 && loading && <Spin size="small" />}
              {entry.events.map((event) => {
                const path = resultPath(event);
                const awaiting = event.type === 'tool.proposed';
                const failed = event.type === 'tool.failed';
                const completed = event.type === 'tool.completed';
                const compactListResult = completed && Array.isArray(event.result);
                const structuredResult = completed && Boolean(event.result && typeof event.result === 'object' && !Array.isArray(event.result) && (event.result as any).kind);
                const compactResult = compactListResult || structuredResult;
                const isFinalConfirmation = awaiting && event.confirmationStep === event.confirmationsRequired;
                const requiredSecretMissing = isFinalConfirmation && (event.secretInputs || []).some((field) => (
                  field.required && !String(secretValues[event.actionId || '']?.[field.name] || '').trim()
                ));
                return (
                  <Card size="small" className="assistant-tool-card" key={event.actionId || event.toolName}>
                    <Space direction="vertical" style={{ width: '100%' }} size={8}>
                      {!compactResult && (
                        <Space wrap>
                          <Tag color={failed ? 'red' : completed ? 'green' : awaiting ? 'gold' : 'blue'}>{event.toolName || 'Agent'}</Tag>
                          {event.riskLevel && <Tag>{event.riskLevel}</Tag>}
                          {awaiting && <Text strong>等待第 {event.confirmationStep || 1}/{event.confirmationsRequired || 1} 次确认</Text>}
                          {event.type === 'tool.started' && <Text>执行中</Text>}
                          {completed && <Text type="success">{event.status === 'rejected' ? '已拒绝' : '已完成'}</Text>}
                        </Space>
                      )}
                      {renderToolPreview(event)}
                      {!completed && !compactListResult && typeof event.progress === 'number' && <Progress percent={event.progress} size="small" status={failed ? 'exception' : 'active'} />}
                      {!completed && !compactListResult && event.message && <Text type="secondary">{event.message}</Text>}
                      {event.error && <Alert type="error" message={event.error} showIcon />}
                      {event.result !== undefined && renderToolResult(
                        event,
                        (buildNumber) => navigate(`/cicd?build=${buildNumber}`),
                        (url) => setQrPreviewUrl(url),
                        (issue) => void openCrashDetail(issue),
                      )}
                      {completed && renderQuickActions(event.result, (prompt) => void send(prompt))}
                      {isFinalConfirmation && event.actionId && (event.secretInputs || []).map((field) => (
                        <Input.Password
                          key={field.name}
                          value={secretValues[event.actionId!]?.[field.name] || ''}
                          placeholder={field.label}
                          aria-label={field.label}
                          autoComplete="new-password"
                          onChange={(inputEvent) => setSecretValues((previous) => ({
                            ...previous,
                            [event.actionId!]: {
                              ...(previous[event.actionId!] || {}),
                              [field.name]: inputEvent.target.value,
                            },
                          }))}
                        />
                      ))}
                      {isFinalConfirmation && (event.secretInputs || []).some((field) => field.description) && (
                        <Text type="secondary">{event.secretInputs?.map((field) => field.description).filter(Boolean).join(' ')}</Text>
                      )}
                      {awaiting && event.actionId && (
                        <Space>
                          <Button type="primary" danger={event.riskLevel === 'high'} icon={<CheckOutlined />} onClick={() => void decide(entry.id, event.actionId!, 'approve')} disabled={loading || requiredSecretMissing}>
                            {event.riskLevel === 'high' ? '确认高风险操作' : '确认执行'}
                          </Button>
                          <Button icon={<CloseOutlined />} onClick={() => void decide(entry.id, event.actionId!, 'reject')} disabled={loading}>拒绝</Button>
                        </Space>
                      )}
                      {path && completed && event.status !== 'rejected' && !structuredResult && (!compactListResult || (Array.isArray(event.result) && event.result.length === 0)) && (
                        <Button type="link" icon={<LinkOutlined />} onClick={() => navigate(path)}>打开原平台详情</Button>
                      )}
                    </Space>
                  </Card>
                );
              })}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="assistant-composer-wrap">
        {attachment && (
          <Tag closable onClose={() => setAttachment(null)} icon={<PaperClipOutlined />} className="assistant-attachment-tag">
            {attachment.name} · {(attachment.size / 1024).toFixed(1)} KB
          </Tag>
        )}
        <div className="assistant-composer">
          <Tooltip title="上传 .crash、.ips 或 .txt，15 分钟后自动清理">
            <Upload showUploadList={false} beforeUpload={(file) => uploadAttachment(file)} accept=".crash,.ips,.txt">
              <Button type="text" icon={<PaperClipOutlined />} disabled={loading} />
            </Upload>
          </Tooltip>
          <TextArea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onPressEnter={(event) => {
              if (!event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="输入指令，例如：查询构建 #123 的日志并分析失败原因"
            autoSize={{ minRows: 1, maxRows: 6 }}
            variant="borderless"
            disabled={loading}
          />
          <Button type="primary" shape="circle" icon={<SendOutlined />} loading={loading} disabled={!input.trim() && !attachment} onClick={() => void send()} />
        </div>
        <Text type="secondary" className="assistant-disclaimer">AI 可能出错。所有写操作仍受权限、参数校验、确认和审计保护。</Text>
      </div>

      <Modal
        title="崩溃详情"
        open={crashDetailOpen}
        width={960}
        centered
        onCancel={() => setCrashDetailOpen(false)}
        footer={<Button onClick={() => setCrashDetailOpen(false)}>关闭</Button>}
      >
        {crashDetailLoading && <div className="assistant-crash-detail-loading"><Spin tip="正在读取最新崩溃事件…" /></div>}
        {!crashDetailLoading && crashDetailError && <Alert type="error" showIcon message={crashDetailError} />}
        {!crashDetailLoading && crashDetail && (
          <div className="assistant-crash-detail">
            <div className="assistant-crash-detail-header">
              <Text strong>{crashDetail.issue.title || crashDetailIssue?.title}</Text>
              <Space wrap>
                <Tag>Issue #{crashDetail.issue.id || crashDetailIssue?.id}</Tag>
                {(crashDetail.issue.appVersionRange || crashDetailIssue?.appVersionRange) && (
                  <Tag color="blue">版本 {crashDetail.issue.appVersionRange || crashDetailIssue?.appVersionRange}</Tag>
                )}
                {crashDetail.eventId && <Text type="secondary" copyable={{ text: crashDetail.eventId }}>Event {crashDetail.eventId}</Text>}
              </Space>
            </div>
            <pre className="assistant-crash-detail-log">{crashDetail.crashLog || crashDetail.previewLog || '暂无崩溃日志'}</pre>
          </div>
        )}
      </Modal>

      <Modal
        title="安装二维码"
        open={Boolean(qrPreviewUrl)}
        centered
        width={380}
        onCancel={() => setQrPreviewUrl('')}
        footer={[
          <Button key="close" onClick={() => setQrPreviewUrl('')}>关闭</Button>,
          <Button
            key="open"
            type="primary"
            onClick={() => window.open(qrPreviewUrl, '_blank', 'noopener,noreferrer')}
          >
            打开安装页面
          </Button>,
        ]}
      >
        <div className="assistant-qr-preview">
          {qrPreviewUrl && <QRCode value={qrPreviewUrl} size={280} bordered={false} />}
          <Text type="secondary" copyable={{ text: qrPreviewUrl }}>{qrPreviewUrl}</Text>
        </div>
      </Modal>
    </div>
  );
}
