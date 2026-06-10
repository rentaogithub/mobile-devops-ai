import { Alert, Button, Card, Collapse, List, Space, Spin, Tag, Typography, message } from 'antd';
import { ArrowLeftOutlined, BarChartOutlined, ExportOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import AIAnalysisPanel from '../components/AIAnalysisPanel';
import { sentryAnalysisApi } from '../services/api';
import { SentryIssueAnalysisResult, SentryIssueSummary } from '../types';

const { Title, Text, Paragraph } = Typography;

const SENTRY_PROXY_BASE_URL = (import.meta.env.VITE_SENTRY_PROXY_BASE_URL || 'http://10.1.3.177:3000').replace(/\/+$/, '');
const SENTRY_IOS_PROJECT_PATH = '/sentry/organizations/sentry/projects/nn-ios/?project=6';
const SENTRY_IOS_PROJECT_URL = SENTRY_IOS_PROJECT_PATH;

type CurrentSentryIssue = Pick<SentryIssueSummary, 'id' | 'title' | 'permalink'>;

function parseSentryIssueFromURL(rawURL: string, fallbackTitle = ''): CurrentSentryIssue | null {
  const url = new URL(rawURL, window.location.origin);
  const issueMatch = url.pathname.match(/\/issues\/([^/?#]+)/);
  if (!issueMatch) {
    return null;
  }

  const id = decodeURIComponent(issueMatch[1]);
  return {
    id,
    title: fallbackTitle.trim() || id,
    permalink: `${SENTRY_PROXY_BASE_URL}${url.pathname}${url.search}${url.hash}`,
  };
}

export default function SentryServicePage() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [apiKey] = useState(() => {
    return localStorage.getItem('qwen_api_key') || 'sk-af14207873244405ae33e5129fdd9700';
  });
  const [analyzing, setAnalyzing] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [frameAccessError, setFrameAccessError] = useState('');
  const [currentIssue, setCurrentIssue] = useState<CurrentSentryIssue | null>(null);
  const [results, setResults] = useState<SentryIssueAnalysisResult[]>([]);
  const iframeSrc = useMemo(() => `${SENTRY_IOS_PROJECT_URL}&_=${frameKey}`, [frameKey]);

  useEffect(() => {
    const onSentryIssueMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin && !event.origin.startsWith(SENTRY_PROXY_BASE_URL)) {
        return;
      }

      const issue = event.data?.type === 'nn-sentry-issue-selected'
        ? event.data.issue
        : null;
      if (event.data?.type !== 'nn-sentry-issue-selected') {
        return;
      }

      if (!issue?.id) {
        setCurrentIssue(null);
        setFetchError('');
        setFrameAccessError('');
        return;
      }

      setCurrentIssue({
        id: String(issue.id),
        title: String(issue.title || issue.id),
        permalink: issue.permalink
          ? (() => {
            const url = new URL(String(issue.permalink), window.location.origin);
            return `${SENTRY_PROXY_BASE_URL}${url.pathname}${url.search}${url.hash}`;
          })()
          : undefined,
      });
      setFetchError('');
      setFrameAccessError('');
    };

    window.addEventListener('message', onSentryIssueMessage);
    return () => window.removeEventListener('message', onSentryIssueMessage);
  }, []);

  const updateCurrentIssue = (issue: CurrentSentryIssue | null) => {
    setCurrentIssue(issue?.id ? issue : null);
    setFetchError('');
  };

  const handleFrameBack = () => {
    try {
      iframeRef.current?.contentWindow?.history.back();
      window.setTimeout(detectIssueFromFrameLocation, 600);
    } catch (_error) {
      if (iframeRef.current) {
        iframeRef.current.src = `${SENTRY_IOS_PROJECT_URL}&_=${Date.now()}`;
      }
    }
  };

  const detectIssueFromFrameLocation = () => {
    try {
      const frameWindow = iframeRef.current?.contentWindow;
      const title = frameWindow?.document?.title || '';
      const href = frameWindow?.location?.href || '';
      const issue = href ? parseSentryIssueFromURL(href, title) : null;
      updateCurrentIssue(issue);
      setFrameAccessError('');
    } catch (_error) {
      // Cross-origin iframes report the current issue through postMessage injected by the proxy.
    }
  };

  const handleFrameLoad = () => {
    const iframe = iframeRef.current;
    try {
      const doc = iframe?.contentDocument;
      if (!doc) {
        return;
      }

      const onIssueClick = (event: MouseEvent) => {
        const target = event.target as Element | null;
        const anchor = target?.closest?.('a[href*="/issues/"]') as HTMLAnchorElement | null;
        if (anchor?.href) {
          updateCurrentIssue(parseSentryIssueFromURL(anchor.href, anchor.textContent || ''));
          window.setTimeout(detectIssueFromFrameLocation, 600);
        }
      };

      doc.removeEventListener('click', onIssueClick, true);
      doc.addEventListener('click', onIssueClick, true);
      detectIssueFromFrameLocation();
      setFrameAccessError('');
    } catch (_error) {
      // Cross-origin iframes report clicks through the injected postMessage bridge.
    }
  };

  const handleAnalyzeCurrentIssue = async () => {
    if (!currentIssue?.id) {
      message.warning('请先在下方 Sentry 页面点击要分析的问题');
      return;
    }

    setAnalyzing(true);
    setFetchError('');
    setResults([]);
    try {
      const response = await sentryAnalysisApi.analyzeSelected({
        issueIds: [currentIssue.id],
        issues: [currentIssue],
        apiKey,
      });

      if (!response.success || !response.data) {
        throw new Error(response.error || '分析当前 Sentry 问题失败');
      }

      setResults(response.data.results);
      message.success(`已分析当前 Sentry 问题：${currentIssue.title || currentIssue.id}`);
    } catch (error: any) {
      const errorMessage = error.error || error.message || '分析当前 Sentry 问题失败';
      setFetchError(errorMessage);
      message.error(errorMessage);
    } finally {
      setAnalyzing(false);
    }
  };

  const getSeverityColor = (severity?: string) => {
    switch (severity) {
      case 'critical':
        return 'red';
      case 'high':
        return 'volcano';
      case 'medium':
        return 'orange';
      case 'low':
        return 'green';
      default:
        return 'default';
    }
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
          <Button icon={<ArrowLeftOutlined />} onClick={handleFrameBack}>
            上一页
          </Button>
          <Button
            type="primary"
            icon={<SearchOutlined />}
            loading={analyzing}
            disabled={!currentIssue?.id}
            onClick={handleAnalyzeCurrentIssue}
          >
            分析当前 Sentry 问题
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => setFrameKey((value) => value + 1)}>
            刷新
          </Button>
          <Button
            type="primary"
            icon={<ExportOutlined />}
            href={SENTRY_IOS_PROJECT_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            新窗口打开
          </Button>
        </Space>
      </Space>

      {frameAccessError && (
        <Alert
          type="warning"
          message="无法识别 Sentry 当前问题"
          description={frameAccessError}
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {(fetchError || results.length > 0 || analyzing) && (
        <Card
          title={
            <Space>
              <span>Sentry 当前问题分析</span>
              {currentIssue?.id && <Tag>{currentIssue.id}</Tag>}
            </Space>
          }
          style={{ marginBottom: 16 }}
        >
          <Spin spinning={analyzing} tip="正在分析当前 Sentry 问题...">
            {fetchError ? (
              <Alert type="error" message="Sentry 操作失败" description={fetchError} showIcon />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size="large">
                {results.length > 0 && (
                  <List
                    dataSource={results}
                    renderItem={(item) => (
                      <List.Item>
                        <Card style={{ width: '100%' }}>
                          <Space direction="vertical" style={{ width: '100%' }} size="middle">
                            <Space wrap align="start" style={{ width: '100%', justifyContent: 'space-between' }}>
                              <div>
                                <Space wrap>
                                  <Text strong>{item.issue.shortId || item.issue.id}</Text>
                                  {item.analysis?.severity && (
                                    <Tag color={getSeverityColor(item.analysis.severity)}>
                                      {item.analysis.severity}
                                    </Tag>
                                  )}
                                  {item.issue.status && <Tag>{item.issue.status}</Tag>}
                                </Space>
                                <Paragraph style={{ margin: '6px 0 0' }}>{item.issue.title}</Paragraph>
                                {item.issue.culprit && <Text type="secondary">{item.issue.culprit}</Text>}
                              </div>
                              <Space>
                                <Text type="secondary">事件 {item.issue.count || '-'}</Text>
                                <Text type="secondary">用户 {item.issue.userCount ?? '-'}</Text>
                                {item.issue.permalink && (
                                  <Button size="small" href={item.issue.permalink} target="_blank" rel="noopener noreferrer">
                                    打开
                                  </Button>
                                )}
                              </Space>
                            </Space>

                            {item.error ? (
                              <Alert type="warning" message="分析失败" description={item.error} />
                            ) : (
                              <AIAnalysisPanel analysis={item.analysis || null} loading={false} />
                            )}

                            {item.analysisLog && (
                              <Collapse
                                size="small"
                                items={[
                                  {
                                    key: 'log',
                                    label: '查看抓取上下文',
                                    children: (
                                      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>
                                        {item.analysisLog}
                                      </pre>
                                    ),
                                  },
                                ]}
                              />
                            )}
                          </Space>
                        </Card>
                      </List.Item>
                    )}
                  />
                )}
              </Space>
            )}
          </Spin>
        </Card>
      )}

      <Card styles={{ body: { padding: 0, height: 'calc(100vh - 220px)', minHeight: 560 } }}>
        <iframe
          ref={iframeRef}
          key={frameKey}
          src={iframeSrc}
          onLoad={handleFrameLoad}
          title="Sentry NN iOS"
          style={{
            width: '100%',
            height: '100%',
            border: 0,
            display: 'block',
            borderRadius: 8,
          }}
        />
      </Card>
    </div>
  );
}
