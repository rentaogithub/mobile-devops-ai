import { Alert, Button, Card, Input, List, Modal, Space, Spin, Tabs, Tag, Typography, message } from 'antd';
import {
  ArrowLeftOutlined,
  BarChartOutlined,
  DashboardOutlined,
  DownloadOutlined,
  FileSearchOutlined,
  OrderedListOutlined,
  ReloadOutlined,
  RobotOutlined,
  ShareAltOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { useCallback, useState } from 'react';
import { sentryAnalysisApi } from '../services/api';
import { SentryIssueSummary, SentrySymbolicateAnalyzeResult } from '../types';
import { downloadTextFile } from '../utils/helpers';
import AIAnalysisPanel from '../components/AIAnalysisPanel';
import { shareToWeChatWork } from '../utils/wechatShare';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

const SENTRY_SERVICE_URL = '/sentry-service';
const SENTRY_OVERVIEW_PATH = '/organizations/sentry/projects/nn-ios/';
const DEFAULT_ISSUE_QUERY = 'is:unresolved';
const TOP_PERIOD = '7d';
const RECENT_PERIOD = '24h';

type CurrentSentryIssue = Pick<SentryIssueSummary, 'id' | 'title' | 'permalink'>;
type SentryView = 'overview' | 'top' | 'recent';

function getInitialIssueId() {
  return new URLSearchParams(window.location.search).get('issue') || '';
}

function toLocalIssueURL(issue?: Pick<SentryIssueSummary, 'id' | 'shortId'>) {
  const issueId = issue?.id || issue?.shortId;
  return issueId ? `${SENTRY_SERVICE_URL}?issue=${encodeURIComponent(issueId)}` : SENTRY_SERVICE_URL;
}

function toSentryIssueURL(issue: Pick<SentryIssueSummary, 'id'>) {
  return `http://10.1.3.177:3000/organizations/sentry/issues/${encodeURIComponent(issue.id)}/?project=6&query=&referrer=project-issue-stream`;
}

function getIssueTime(issue: SentryIssueSummary) {
  return Date.parse(issue.lastSeen || issue.firstSeen || '') || 0;
}

function formatIssueTime(value?: string) {
  if (!value) {
    return '-';
  }
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function compareVersions(a: string, b: string) {
  const left = a.split('.').map((part) => Number(part) || 0);
  const right = b.split('.').map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function getHighestAppVersion(issues: SentryIssueSummary[]) {
  return issues
    .flatMap((issue) => [issue.maxAppVersion, ...(issue.appVersions || [])])
    .filter((version): version is string => Boolean(version))
    .sort(compareVersions)
    .pop();
}

function getIssueAppVersionLabel(issue: SentryIssueSummary) {
  if (issue.appVersionRange) {
    return issue.appVersionRange;
  }
  if (issue.minAppVersion && issue.maxAppVersion) {
    return issue.minAppVersion === issue.maxAppVersion
      ? issue.maxAppVersion
      : `${issue.minAppVersion} - ${issue.maxAppVersion}`;
  }
  return issue.maxAppVersion || issue.minAppVersion || issue.appVersions?.join(' - ') || '-';
}

function buildOverviewURL(version: number) {
  const params = new URLSearchParams({
    project: '6',
    statsPeriod: '7d',
    _: String(version),
  });
  return `${SENTRY_OVERVIEW_PATH}?${params.toString()}`;
}

function sanitizeFilename(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'sentry_issue';
}

function extractIncidentIdentifier(crashLog: string) {
  return crashLog.match(/^Incident Identifier:\s*(.+)$/m)?.[1]?.trim();
}

function buildOriginalCrashFileName(crashLog: string, incidentIdentifier?: string) {
  const incidentId = incidentIdentifier || extractIncidentIdentifier(crashLog) || 'sentry_incident';
  return `${sanitizeFilename(incidentId)}.crash`;
}

export default function SentryServicePage() {
  const [activeView, setActiveView] = useState<SentryView>('overview');
  const [overviewFrameKey, setOverviewFrameKey] = useState(0);
  const [issueLoading, setIssueLoading] = useState(false);
  const [symbolicatingIssueId, setSymbolicatingIssueId] = useState('');
  const [downloadingIssueId, setDownloadingIssueId] = useState('');
  const [fetchError, setFetchError] = useState('');
  const [topIssues, setTopIssues] = useState<SentryIssueSummary[]>([]);
  const [recentIssues, setRecentIssues] = useState<SentryIssueSummary[]>([]);
  const [currentIssue, setCurrentIssue] = useState<CurrentSentryIssue | null>(null);
  const [analysisModalOpen, setAnalysisModalOpen] = useState(false);
  const [analysisTargetIssue, setAnalysisTargetIssue] = useState<SentryIssueSummary | null>(null);
  const [analysisResult, setAnalysisResult] = useState<SentrySymbolicateAnalyzeResult | null>(null);
  const [analysisError, setAnalysisError] = useState('');

  const loadIssues = useCallback(async (period: string) => {
    setIssueLoading(true);
    setFetchError('');
    try {
      const response = await sentryAnalysisApi.listIssues({
        period,
        limit: 20,
        query: DEFAULT_ISSUE_QUERY,
      });

      if (!response.success || !response.data) {
        throw new Error(response.error || '抓取 Sentry 问题列表失败');
      }

      const nextIssues = [...response.data.issues].sort((a, b) => getIssueTime(b) - getIssueTime(a));
      if (period === TOP_PERIOD) {
        setTopIssues(nextIssues);
      } else {
        setRecentIssues(nextIssues);
      }
      setCurrentIssue((selected) => {
        const initialIssueId = getInitialIssueId();
        const initialIssue = initialIssueId
          ? nextIssues.find((issue) => issue.id === initialIssueId || issue.shortId === initialIssueId)
          : null;
        if (initialIssue) {
          return {
            id: initialIssue.id,
            title: initialIssue.title || initialIssue.shortId || initialIssue.id,
            permalink: toLocalIssueURL(initialIssue),
          };
        }
        if (selected && nextIssues.some((issue) => issue.id === selected.id)) {
          return selected;
        }
        return null;
      });
    } catch (error: any) {
      const errorMessage = error.error || error.message || '抓取 Sentry 问题列表失败';
      setFetchError(errorMessage);
      message.error(errorMessage);
    } finally {
      setIssueLoading(false);
    }
  }, []);

  const updateCurrentIssue = (issue: CurrentSentryIssue | null) => {
    setCurrentIssue(issue?.id ? issue : null);
    setFetchError('');
  };

  const handleOpenIssue = (issue: SentryIssueSummary) => {
    updateCurrentIssue({
      id: issue.id,
      title: issue.title || issue.shortId || issue.id,
      permalink: toLocalIssueURL(issue),
    });
    window.open(toSentryIssueURL(issue), '_blank', 'noopener,noreferrer');
  };

  const handleBack = () => {
    window.history.back();
  };

  const handleShowOverview = () => {
    setActiveView('overview');
    setFetchError('');
  };

  const handleShowTop = () => {
    setActiveView('top');
    if (topIssues.length === 0) {
      loadIssues(TOP_PERIOD);
    }
  };

  const handleShowRecent = () => {
    setActiveView('recent');
    if (recentIssues.length === 0) {
      loadIssues(RECENT_PERIOD);
    }
  };

  const handleRefresh = () => {
    if (activeView === 'overview') {
      setOverviewFrameKey((value) => value + 1);
      return;
    }
    loadIssues(activeView === 'top' ? TOP_PERIOD : RECENT_PERIOD);
  };

  const handleSymbolicateIssue = async (issue: SentryIssueSummary) => {
    setSymbolicatingIssueId(issue.id);
    setAnalysisTargetIssue(issue);
    setAnalysisResult(null);
    setAnalysisError('');
    setAnalysisModalOpen(true);
    try {
      const targetAppVersion = highestAppVersion || issue.maxAppVersion;
      const response = await sentryAnalysisApi.symbolicateAndAnalyze({
        issue: {
          ...issue,
          maxAppVersion: targetAppVersion,
        },
        appVersion: targetAppVersion,
      });
      if (!response.success || !response.data?.symbolicatedLog) {
        throw new Error(response.error || '解析 Sentry 问题失败');
      }

      setAnalysisResult(response.data);
      message.success('Sentry 问题已解析并生成历史记录');
    } catch (error: any) {
      const errorMessage = error.error || error.message || '解析 Sentry 问题失败';
      setAnalysisError(errorMessage);
      message.error(errorMessage);
    } finally {
      setSymbolicatingIssueId('');
    }
  };

  const handleDownloadOriginalCrash = async (issue: SentryIssueSummary) => {
    setDownloadingIssueId(issue.id);
    try {
      const targetIssue = {
        ...issue,
        maxAppVersion: highestAppVersion || issue.maxAppVersion,
      };
      const response = await sentryAnalysisApi.buildOriginalCrash({ issue: targetIssue });
      if (!response.success || !response.data?.crashLog) {
        throw new Error(response.error || '生成原始崩溃文件失败');
      }

      downloadTextFile(
        response.data.crashLog,
        buildOriginalCrashFileName(response.data.crashLog, response.data.incidentIdentifier)
      );
      message.success('原始崩溃文件下载已开始');
    } catch (error: any) {
      const errorMessage = error.error || error.message || '下载原始崩溃文件失败';
      message.error(errorMessage);
    } finally {
      setDownloadingIssueId('');
    }
  };

  const getSeverityColor = (severity?: string) => {
    switch (severity) {
      case 'fatal':
      case 'critical':
        return 'red';
      case 'error':
      case 'high':
        return 'volcano';
      case 'warning':
      case 'medium':
        return 'orange';
      case 'low':
        return 'green';
      default:
        return 'default';
    }
  };

  const totalEvents = topIssues.reduce((sum, issue) => sum + Number(issue.count || 0), 0);
  const totalUsers = topIssues.reduce((sum, issue) => sum + Number(issue.userCount || 0), 0);
  const fatalIssues = topIssues.filter((issue) => issue.level === 'fatal' || issue.level === 'critical');
  const latestIssue = topIssues.reduce<SentryIssueSummary | null>((latest, issue) => {
    if (!latest || getIssueTime(issue) > getIssueTime(latest)) {
      return issue;
    }
    return latest;
  }, null);
  const topByEvents = [...topIssues]
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
    .slice(0, 10);
  const topByUsers = [...topIssues]
    .sort((a, b) => Number(b.userCount || 0) - Number(a.userCount || 0))
    .slice(0, 10);
  const activeIssues = activeView === 'top' ? topIssues : recentIssues;
  const highestAppVersion = getHighestAppVersion(activeIssues);
  const analysisTitle = analysisResult?.issue.shortId ||
    analysisTargetIssue?.shortId ||
    analysisTargetIssue?.id ||
    'Sentry 问题';

  const handleDownloadSymbolicatedLog = () => {
    if (!analysisResult) {
      return;
    }
    downloadTextFile(
      analysisResult.symbolicatedLog,
      `${sanitizeFilename(analysisTitle)}_${sanitizeFilename(analysisResult.appVersion)}_symbolicated.crash`
    );
  };

  const handleDownloadModalOriginalCrash = () => {
    if (!analysisResult) {
      return;
    }
    downloadTextFile(
      analysisResult.originalLog,
      buildOriginalCrashFileName(analysisResult.originalLog, analysisResult.incidentIdentifier)
    );
  };

  const handleShareAnalysisResult = async () => {
    if (!analysisResult?.historyId) {
      message.error('无法生成分享链接，历史记录ID不存在');
      return;
    }

    const detailUrl = `${window.location.origin}/history?id=${analysisResult.historyId}`;
    const analysis = analysisResult.aiAnalysis;
    const success = await shareToWeChatWork({
      title: '',
      description: [
        `Sentry 问题：${analysisResult.issue.shortId || analysisResult.issue.id}`,
        `应用版本：${analysisResult.appVersion}`,
        analysisResult.issue.title && `标题：${analysisResult.issue.title}`,
        analysis?.crashType && `崩溃类型：${analysis.crashType}`,
        analysis?.crashModule && `崩溃模块：${analysis.crashModule}`,
        analysis?.crashLocation && `崩溃位置：${analysis.crashLocation}`,
        `时间：${new Date().toLocaleString('zh-CN')}`,
      ].filter(Boolean).join('\n'),
      url: detailUrl,
    });

    if (success) {
      message.success('分享链接已复制到剪贴板，请在企业微信中粘贴发送', 3);
    } else {
      message.error('复制失败');
    }
  };

  const renderIssueCard = (issue: SentryIssueSummary) => {
    const selected = currentIssue?.id === issue.id;
    return (
      <List.Item>
        <Card
          size="small"
          hoverable
          onClick={() => handleOpenIssue(issue)}
          style={{
            width: '100%',
            borderColor: selected ? '#1677ff' : undefined,
            background: selected ? '#f0f7ff' : undefined,
            cursor: 'pointer',
          }}
        >
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            <Space wrap style={{ width: '100%', justifyContent: 'space-between' }} align="start">
              <Space wrap>
                <Text strong>{issue.shortId || issue.id}</Text>
                {issue.level && <Tag color={getSeverityColor(issue.level)}>{issue.level}</Tag>}
                {issue.status && <Tag>{issue.status}</Tag>}
              </Space>
              <Space>
                <Text type="secondary">事件 {issue.count || '-'}</Text>
                <Text type="secondary">用户 {issue.userCount ?? '-'}</Text>
                <Text type="secondary">APP版本范围</Text>
                <Tag color="blue" style={{ marginInlineEnd: 0 }}>{getIssueAppVersionLabel(issue)}</Tag>
                <Text type="secondary">最近 {formatIssueTime(issue.lastSeen)}</Text>
                <Button
                  size="small"
                  icon={<FileSearchOutlined />}
                  loading={symbolicatingIssueId === issue.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleSymbolicateIssue({
                      ...issue,
                      maxAppVersion: highestAppVersion || issue.maxAppVersion,
                    });
                  }}
                >
                  解析
                </Button>
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  loading={downloadingIssueId === issue.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleDownloadOriginalCrash({
                      ...issue,
                      maxAppVersion: highestAppVersion || issue.maxAppVersion,
                    });
                  }}
                >
                  下载
                </Button>
              </Space>
            </Space>
            <Paragraph style={{ margin: 0 }}>{issue.title}</Paragraph>
            {issue.culprit && <Text type="secondary">{issue.culprit}</Text>}
          </Space>
        </Card>
      </List.Item>
    );
  };

  return (
    <div>
      <Space align="center" style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
        <Space align="center">
          <BarChartOutlined style={{ color: '#1677ff', fontSize: 22 }} />
          <div>
            <Title level={2} style={{ margin: 0 }}>Sentry 服务</Title>
            <Text type="secondary">查看 NN iOS 项目的线上崩溃与事件。</Text>
          </div>
        </Space>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={handleBack}>
            上一页
          </Button>
          <Button
            type={activeView === 'overview' ? 'primary' : 'default'}
            icon={<DashboardOutlined />}
            onClick={handleShowOverview}
          >
            总览
          </Button>
          <Button
            type={activeView === 'top' ? 'primary' : 'default'}
            icon={<TrophyOutlined />}
            onClick={handleShowTop}
          >
            Top汇总
          </Button>
          <Button
            type={activeView === 'recent' ? 'primary' : 'default'}
            icon={<OrderedListOutlined />}
            onClick={handleShowRecent}
          >
            最近问题
          </Button>
          <Button icon={<ReloadOutlined />} loading={issueLoading} onClick={handleRefresh}>
            刷新
          </Button>
        </Space>
      </Space>

      {fetchError && (
        <Alert
          type="error"
          message="Sentry 操作失败"
          description={fetchError}
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {activeView === 'overview' ? (
        <Card styles={{ body: { padding: 0, height: 'calc(100vh - 220px)', minHeight: 560 } }}>
          <iframe
            key={overviewFrameKey}
            src={buildOverviewURL(overviewFrameKey)}
            title="Sentry NNIOS 总览"
            style={{
              width: '100%',
              height: '100%',
              border: 0,
              display: 'block',
              borderRadius: 8,
            }}
          />
        </Card>
      ) : activeView === 'top' ? (
        <Card
          title={
            <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
              <Space>
                <span>Top汇总</span>
                <Tag>最近 7 天</Tag>
              </Space>
              <Button type="link" onClick={handleShowRecent}>
                查看最近问题
              </Button>
            </Space>
          }
        >
          <Spin spinning={issueLoading} tip="正在生成 Top 汇总...">
            <Space direction="vertical" style={{ width: '100%' }} size="large">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: 16,
                }}
              >
                <Card size="small">
                  <Text type="secondary">未解决问题</Text>
                  <Title level={3} style={{ margin: '8px 0 0' }}>{topIssues.length}</Title>
                </Card>
                <Card size="small">
                  <Text type="secondary">事件总数</Text>
                  <Title level={3} style={{ margin: '8px 0 0' }}>{totalEvents || '-'}</Title>
                </Card>
                <Card size="small">
                  <Text type="secondary">影响用户</Text>
                  <Title level={3} style={{ margin: '8px 0 0' }}>{totalUsers || '-'}</Title>
                </Card>
                <Card size="small">
                  <Text type="secondary">高危问题</Text>
                  <Title level={3} style={{ margin: '8px 0 0' }}>{fatalIssues.length || '-'}</Title>
                </Card>
                <Card size="small">
                  <Text type="secondary">最近崩溃</Text>
                  <Title level={3} style={{ margin: '8px 0 0' }}>
                    {latestIssue ? formatIssueTime(latestIssue.lastSeen) : '-'}
                  </Title>
                </Card>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
                  gap: 16,
                }}
              >
                <Card size="small" title="Top 事件数" extra={<Text type="secondary">按事件数排序</Text>}>
                  {topByEvents.length === 0 && !issueLoading ? (
                    <Alert type="info" message="暂无 Sentry 问题" showIcon />
                  ) : (
                    <List dataSource={topByEvents} renderItem={renderIssueCard} />
                  )}
                </Card>
                <Card size="small" title="Top 影响用户" extra={<Text type="secondary">按用户数排序</Text>}>
                  {topByUsers.length === 0 && !issueLoading ? (
                    <Alert type="info" message="暂无 Sentry 问题" showIcon />
                  ) : (
                    <List dataSource={topByUsers} renderItem={renderIssueCard} />
                  )}
                </Card>
              </div>
            </Space>
          </Spin>
        </Card>
      ) : (
        <Card
          title={
            <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
              <Space>
                <span>最近问题</span>
                <Tag>最近 24h</Tag>
              </Space>
            </Space>
          }
        >
          <Spin spinning={issueLoading} tip="正在抓取 Sentry 问题...">
            {activeIssues.length === 0 && !issueLoading ? (
              <Alert type="info" message="暂无 Sentry 问题" showIcon />
            ) : (
              <List
                dataSource={activeIssues}
                renderItem={renderIssueCard}
              />
            )}
          </Spin>
        </Card>
      )}

      <Modal
        title={`解析结果 - ${analysisTitle}`}
        open={analysisModalOpen}
        onCancel={() => setAnalysisModalOpen(false)}
        width={1080}
        footer={[
          <Button
            key="share"
            icon={<ShareAltOutlined />}
            disabled={!analysisResult?.historyId}
            onClick={handleShareAnalysisResult}
          >
            分享
          </Button>,
          <Button key="original" disabled={!analysisResult} onClick={handleDownloadModalOriginalCrash}>
            下载原始崩溃
          </Button>,
          <Button key="symbolicated" disabled={!analysisResult} onClick={handleDownloadSymbolicatedLog}>
            下载符号化日志
          </Button>,
          <Button key="close" type="primary" onClick={() => setAnalysisModalOpen(false)}>
            关闭
          </Button>,
        ]}
      >
        <Spin spinning={Boolean(symbolicatingIssueId) && !analysisResult && !analysisError} tip="正在符号化并进行 AI 分析...">
          {analysisError ? (
            <Alert type="error" message="解析失败" description={analysisError} showIcon />
          ) : analysisResult ? (
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <Alert
                type={analysisResult.aiError ? 'warning' : 'success'}
                showIcon
                message={
                  <Space wrap>
                    <span>已按 APP 版本 {analysisResult.appVersion} 解析</span>
                    <Text type="secondary">历史记录 #{analysisResult.historyId || '-'}</Text>
                    <Text type="secondary">UUID {analysisResult.matchedUUIDs.length} 个</Text>
                  </Space>
                }
                description={analysisResult.aiError || analysisResult.warning}
              />
              <Tabs
                defaultActiveKey={analysisResult.aiAnalysis ? 'analysis' : 'symbolicated'}
                items={[
                  {
                    key: 'analysis',
                    label: (
                      <Space>
                        <RobotOutlined />
                        AI 分析
                      </Space>
                    ),
                    children: (
                      analysisResult.aiAnalysis ? (
                        <AIAnalysisPanel analysis={analysisResult.aiAnalysis} loading={false} />
                      ) : (
                        <Alert type="warning" message={analysisResult.aiError || '暂无 AI 分析结果'} showIcon />
                      )
                    ),
                  },
                  {
                    key: 'symbolicated',
                    label: '符号化日志',
                    children: (
                      <TextArea
                        value={analysisResult.symbolicatedLog}
                        readOnly
                        rows={20}
                        style={{ fontFamily: 'monospace', fontSize: 12 }}
                      />
                    ),
                  },
                  {
                    key: 'original',
                    label: '原始崩溃',
                    children: (
                      <TextArea
                        value={analysisResult.originalLog}
                        readOnly
                        rows={20}
                        style={{ fontFamily: 'monospace', fontSize: 12 }}
                      />
                    ),
                  },
                ]}
              />
            </Space>
          ) : (
            <Alert
              type="info"
              showIcon
              message="正在解析 Sentry 问题"
              description="会自动使用当前列表中的最高 APP 版本匹配主应用和组件库 dSYM，并生成历史记录。"
            />
          )}
        </Spin>
      </Modal>
    </div>
  );
}
