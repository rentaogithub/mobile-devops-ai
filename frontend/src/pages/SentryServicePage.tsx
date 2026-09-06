import { Alert, Button, Card, Descriptions, Input, List, Modal, Segmented, Select, Space, Spin, Tabs, Tag, Tooltip, Typography, message } from 'antd';
import {
  BarChartOutlined,
  DashboardOutlined,
  DownloadOutlined,
  FileSearchOutlined,
  OrderedListOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  ShareAltOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { historyApi, sentryAnalysisApi } from '../services/api';
import { CrashGovernanceConfig, CrashGovernanceDashboard, CrashGovernanceEvent, CrashGovernanceFingerprintGroup, CrashGovernanceRecord, HistoryRecord, SentryIssueSummary, SentrySymbolicateAnalyzeResult } from '../types';
import { downloadTextFile } from '../utils/helpers';
import { shareToWeChatWork } from '../utils/wechatShare';
import AIAnalysisPanel from '../components/AIAnalysisPanel';

const { Title, Text, Paragraph } = Typography;
const { TextArea, Search } = Input;

const SENTRY_SERVICE_URL = '/sentry-service';
const DEFAULT_ISSUE_QUERY = 'is:unresolved !release:"10.0.0"';
const TOP_PERIOD = '7d';
const RECENT_PERIOD = '24h';
const RECENT_NEW_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXCLUDED_SENTRY_APP_VERSIONS = ['10.0.0'];

type CurrentSentryIssue = Pick<SentryIssueSummary, 'id' | 'title' | 'permalink'>;
type SentryView = 'overview' | 'governance-list' | 'governance-events' | 'top' | 'recent' | 'lookup' | 'raw-sentry';
type SentryLookupType = 'uid' | 'deviceId';
type IssueSymbolicationStatus = {
  status: 'pending' | 'success' | 'failed' | 'incomplete';
  historyId?: number;
  error?: string;
};
type SymbolicationAttemptDetail = {
  appVersion?: unknown;
  error?: unknown;
};

function getInitialIssueId() {
  return new URLSearchParams(window.location.search).get('issue') || '';
}

function toLocalIssueURL(issue?: Pick<SentryIssueSummary, 'id' | 'shortId'>) {
  const issueId = issue?.id || issue?.shortId;
  return issueId ? `${SENTRY_SERVICE_URL}?issue=${encodeURIComponent(issueId)}` : SENTRY_SERVICE_URL;
}

function toSentryProxyIssueURL(issue: Pick<SentryIssueSummary, 'id' | 'permalink'>, config?: CrashGovernanceConfig | null) {
  if (issue.permalink) {
    try {
      const url = new URL(issue.permalink);
      const publicPath = url.pathname.replace(/^\/sentry(?=\/)/, '');
      return `${publicPath}${url.search}${url.hash}`;
    } catch {
      if (issue.permalink.startsWith('/')) {
        const publicPath = issue.permalink.replace(/^\/sentry(?=\/)/, '');
        return publicPath;
      }
    }
  }

  const organization = config?.sentryOrganization;
  return organization
    ? `/organizations/${encodeURIComponent(organization)}/issues/${encodeURIComponent(issue.id)}/?referrer=project-issue-stream`
    : '/sentry/';
}

function buildOverviewURL(version: number, config?: CrashGovernanceConfig | null) {
  const params = new URLSearchParams({
    statsPeriod: '14d',
    _: String(version),
  });
  const path = config?.sentryProxyPath || '/';
  return `${path}${path.includes('?') ? '&' : '?'}${params.toString()}`;
}

function getIssueTime(issue: SentryIssueSummary) {
  return Date.parse(issue.lastSeen || issue.firstSeen || '') || 0;
}

function isNewRecentIssue(issue: SentryIssueSummary) {
  const firstSeenTime = Date.parse(issue.firstSeen || '');
  return Boolean(firstSeenTime) && Date.now() - firstSeenTime <= RECENT_NEW_WINDOW_MS;
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

function getIssueHighestAppVersion(issue: SentryIssueSummary, excludedVersions = DEFAULT_EXCLUDED_SENTRY_APP_VERSIONS) {
  const excludedAppVersions = new Set(excludedVersions);
  return [issue.maxAppVersion, ...(issue.appVersions || [])]
    .filter((version): version is string =>
      typeof version === 'string' && version.length > 0 && !excludedAppVersions.has(version)
    )
    .sort(compareVersions)
    .pop() || issue.minAppVersion;
}

function hasIssueVersionInfo(issue: SentryIssueSummary, excludedVersions = DEFAULT_EXCLUDED_SENTRY_APP_VERSIONS) {
  return Boolean(getIssueHighestAppVersion(issue, excludedVersions) || issue.appVersionRange);
}

function isExcludedAppVersionOnlyIssue(issue: SentryIssueSummary, excludedVersions = DEFAULT_EXCLUDED_SENTRY_APP_VERSIONS) {
  if (issue.excludedAppVersionOnly) {
    return true;
  }
  const excludedAppVersions = new Set(excludedVersions);

  const versions = [issue.minAppVersion, issue.maxAppVersion, ...(issue.appVersions || [])]
    .filter((version): version is string => typeof version === 'string' && version.length > 0);
  return versions.length > 0 && versions.every((version) => excludedAppVersions.has(version));
}

function getIssueAppVersionLabel(issue: SentryIssueSummary) {
  if (issue.appVersionLoading) {
    return '补全中';
  }
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

function formatApiError(error: any, fallback: string) {
  const baseMessage = error?.error || error?.message || fallback;
  const details = error?.details;
  if (!details) {
    return baseMessage;
  }

  if (typeof details === 'string') {
    return `${baseMessage}\n${details}`;
  }

  if (Array.isArray(details)) {
    return `${baseMessage}\n${details.map((detail) => String(detail)).join('\n')}`;
  }

  const detailLines: string[] = [];
  if (Array.isArray(details.candidateVersions)) {
    detailLines.push(`候选版本：${details.candidateVersions.join(', ') || '-'}`);
  }
  if (Array.isArray(details.excludedVersions) && details.excludedVersions.length > 0) {
    detailLines.push(`已排除版本：${details.excludedVersions.join(', ')}`);
  }
  if (typeof details.extractedVersion === 'string' && details.extractedVersion) {
    detailLines.push(`日志识别版本：${details.extractedVersion}`);
  }
  if (typeof details.eventId === 'string' && details.eventId) {
    detailLines.push(`Sentry Event：${details.eventId}`);
  }
  if (Array.isArray(details.attempts)) {
    details.attempts.forEach((attempt: SymbolicationAttemptDetail) => {
      if (attempt && typeof attempt === 'object') {
        const appVersion = 'appVersion' in attempt ? String(attempt.appVersion || '-') : '-';
        const reason = 'error' in attempt ? String(attempt.error || '符号化失败') : '符号化失败';
        detailLines.push(`${appVersion}：${reason}`);
      }
    });
  }
  if (typeof details.hint === 'string' && details.hint) {
    detailLines.push(`建议：${details.hint}`);
  }

  return detailLines.length > 0
    ? `${baseMessage}\n${detailLines.join('\n')}`
    : `${baseMessage}\n${JSON.stringify(details, null, 2)}`;
}

function isIncompleteSentryEventError(error: any) {
  const text = [
    error?.code,
    error?.error,
    error?.message,
    typeof error?.details === 'string' ? error.details : JSON.stringify(error?.details || {}),
  ].join('\n');

  return text.includes('INVALID_CRASH_LOG') && (
    text.includes('缺少可符号化信息') ||
    text.includes('missingStacktraceOrThreads') ||
    text.includes('missingDebugImages') ||
    text.includes('does not contain stacktrace/threads') ||
    text.includes('does not contain debug images')
  );
}

export default function SentryServicePage() {
  const [activeView, setActiveView] = useState<SentryView>('overview');
  const [governanceDashboard, setGovernanceDashboard] = useState<CrashGovernanceDashboard | null>(null);
  const [governanceConfig, setGovernanceConfig] = useState<CrashGovernanceConfig | null>(null);
  const [governanceLoading, setGovernanceLoading] = useState(false);
  const [governanceSyncing, setGovernanceSyncing] = useState(false);
  const [governanceError, setGovernanceError] = useState('');
  const [governanceUpdatingId, setGovernanceUpdatingId] = useState<number | null>(null);
  const [governanceAnalyzingId, setGovernanceAnalyzingId] = useState<number | null>(null);
  const [governanceDetailOpen, setGovernanceDetailOpen] = useState(false);
  const [governanceDetailLoading, setGovernanceDetailLoading] = useState(false);
  const [governanceDetail, setGovernanceDetail] = useState<{ record: CrashGovernanceRecord; history?: HistoryRecord; fingerprintGroup?: CrashGovernanceFingerprintGroup; events?: CrashGovernanceEvent[] } | null>(null);
  const [governanceListLoading, setGovernanceListLoading] = useState(false);
  const [governanceEventsLoading, setGovernanceEventsLoading] = useState(false);
  const [governanceEventsExporting, setGovernanceEventsExporting] = useState(false);
  const [governanceCoverageRefreshingId, setGovernanceCoverageRefreshingId] = useState<number | null>(null);
  const [governanceList, setGovernanceList] = useState<CrashGovernanceRecord[]>([]);
  const [governanceEvents, setGovernanceEvents] = useState<CrashGovernanceEvent[]>([]);
  const [governanceFilters, setGovernanceFilters] = useState({
    source: 'all',
    status: 'all',
    appVersion: '',
    dsymCoverageStatus: 'all',
    symbolicationStatus: 'all',
    symbolicationFailureCategory: 'all',
    analysisStatus: 'all',
    owner: '',
    keyword: '',
  });
  const [governanceEventFilters, setGovernanceEventFilters] = useState({
    scope: 'all',
    toStatus: 'all',
    operator: '',
    keyword: '',
  });
  const [issueLoading, setIssueLoading] = useState(false);
  const [symbolicatingIssueId, setSymbolicatingIssueId] = useState('');
  const [downloadingIssueId, setDownloadingIssueId] = useState('');
  const [fetchError, setFetchError] = useState('');
  const [topIssues, setTopIssues] = useState<SentryIssueSummary[]>([]);
  const [recentIssues, setRecentIssues] = useState<SentryIssueSummary[]>([]);
  const [lookupIssues, setLookupIssues] = useState<SentryIssueSummary[]>([]);
  const [lookupType, setLookupType] = useState<SentryLookupType>('uid');
  const [lookupValue, setLookupValue] = useState('');
  const [lookupQuery, setLookupQuery] = useState('');
  const [currentIssue, setCurrentIssue] = useState<CurrentSentryIssue | null>(null);
  const [rawSentryFrameKey, setRawSentryFrameKey] = useState(0);
  const [sentryDetailModalOpen, setSentryDetailModalOpen] = useState(false);
  const [sentryDetailIssue, setSentryDetailIssue] = useState<SentryIssueSummary | null>(null);
  const [sentryDetailFrameKey, setSentryDetailFrameKey] = useState(0);
  const [analysisModalOpen, setAnalysisModalOpen] = useState(false);
  const [analysisTargetIssue, setAnalysisTargetIssue] = useState<SentryIssueSummary | null>(null);
  const [analysisResult, setAnalysisResult] = useState<SentrySymbolicateAnalyzeResult | null>(null);
  const [analysisError, setAnalysisError] = useState('');
  const [analysisOriginalLog, setAnalysisOriginalLog] = useState('');
  const [analysisOriginalLoading, setAnalysisOriginalLoading] = useState(false);
  const [analysisAiError, setAnalysisAiError] = useState('');
  const [analysisAnalyzing, setAnalysisAnalyzing] = useState(false);
  const [issueSymbolicationStatus, setIssueSymbolicationStatus] = useState<Record<string, IssueSymbolicationStatus>>({});
  const backgroundSymbolicatedIssueIds = useRef(new Set<string>());
  const autoAnalyzedHistoryIds = useRef(new Set<number>());
  const versionEnrichingIssueIds = useRef(new Set<string>());

  const updateIssuesForView = useCallback((view: SentryView, updater: (issues: SentryIssueSummary[]) => SentryIssueSummary[]) => {
    if (view === 'top') {
      setTopIssues(updater);
      return;
    }
    if (view === 'recent') {
      setRecentIssues(updater);
      return;
    }
    if (view === 'lookup') {
      setLookupIssues(updater);
    }
  }, []);

  const loadGovernanceDashboard = useCallback(async () => {
    setGovernanceLoading(true);
    setGovernanceError('');
    try {
      const response = await sentryAnalysisApi.governanceDashboard();
      if (!response.success || !response.data) {
        throw response;
      }
      setGovernanceDashboard(response.data);
    } catch (error: any) {
      const errorMessage = error.error || error.message || '获取 Crash 治理看板失败';
      setGovernanceError(errorMessage);
    } finally {
      setGovernanceLoading(false);
    }
  }, []);

  const loadGovernanceConfig = useCallback(async () => {
    try {
      const response = await sentryAnalysisApi.governanceConfig();
      if (!response.success || !response.data) {
        throw response;
      }
      setGovernanceConfig(response.data);
    } catch (error: any) {
      message.warning(error.error || error.message || '读取 Crash 治理配置失败');
    }
  }, []);

  const syncGovernanceDashboard = useCallback(async () => {
    setGovernanceSyncing(true);
    setGovernanceError('');
    try {
      const response = await sentryAnalysisApi.syncGovernance({
        period: '24h',
        limit: 20,
        query: governanceConfig?.defaultIssueQuery || DEFAULT_ISSUE_QUERY,
      });
      if (!response.success) {
        throw response;
      }
      message.success(`Crash 治理状态已同步 ${response.data?.total || 0} 条`);
      await loadGovernanceDashboard();
    } catch (error: any) {
      const errorMessage = error.error || error.message || '同步 Crash 治理状态失败';
      setGovernanceError(errorMessage);
      message.error(errorMessage, 8);
    } finally {
      setGovernanceSyncing(false);
    }
  }, [governanceConfig?.defaultIssueQuery, loadGovernanceDashboard]);

  useEffect(() => {
    void loadGovernanceDashboard();
    void loadGovernanceConfig();
  }, [loadGovernanceDashboard, loadGovernanceConfig]);

  const activeExcludedVersions = governanceConfig?.excludedVersions?.length
    ? governanceConfig.excludedVersions
    : DEFAULT_EXCLUDED_SENTRY_APP_VERSIONS;
  const activeExcludedVersionKey = activeExcludedVersions.join(',');

  const symbolicateIssueInBackground = useCallback(async (issue: SentryIssueSummary) => {
    if (!issue.id || backgroundSymbolicatedIssueIds.current.has(issue.id)) {
      return;
    }

    if (!hasIssueVersionInfo(issue, activeExcludedVersions)) {
      return;
    }

    backgroundSymbolicatedIssueIds.current.add(issue.id);
    setIssueSymbolicationStatus((statusMap) => ({
      ...statusMap,
      [issue.id]: { status: 'pending' },
    }));

    try {
      const response = await sentryAnalysisApi.symbolicateAndSave({
        issue,
      });

      if (!response.success || !response.data?.historyId) {
        throw response;
      }

      setIssueSymbolicationStatus((statusMap) => ({
        ...statusMap,
        [issue.id]: {
          status: 'success',
          historyId: response.data?.historyId,
        },
      }));
    } catch (error: any) {
      const errorMessage = formatApiError(error, '符号化入库失败');
      const status = isIncompleteSentryEventError(error) ? 'incomplete' : 'failed';
      setIssueSymbolicationStatus((statusMap) => ({
        ...statusMap,
        [issue.id]: {
          status,
          error: errorMessage,
        },
      }));
    }
  }, [activeExcludedVersionKey]);

  const enrichIssueVersionsInBackground = useCallback(async (issues: SentryIssueSummary[], view: SentryView) => {
    const targets = issues.filter((issue) => {
      if (!issue.id || versionEnrichingIssueIds.current.has(issue.id)) {
        return false;
      }
      if (issue.appVersionRange || issue.maxAppVersion || (issue.appVersions && issue.appVersions.length > 0)) {
        return false;
      }
      return true;
    });

    if (targets.length === 0) {
      return;
    }

    targets.forEach((issue) => versionEnrichingIssueIds.current.add(issue.id));
    updateIssuesForView(view, (currentIssues) => currentIssues.map((issue) =>
      targets.some((target) => target.id === issue.id)
        ? { ...issue, appVersionLoading: true }
        : issue
    ));

    const concurrency = 3;
    for (let index = 0; index < targets.length; index += concurrency) {
      const batch = targets.slice(index, index + concurrency);
      await Promise.all(batch.map(async (issue) => {
        try {
          const enrichedIssue = await sentryAnalysisApi.enrichIssueVersion(issue);
          updateIssuesForView(view, (currentIssues) => currentIssues
            .map((currentIssue) => currentIssue.id === issue.id
              ? { ...currentIssue, ...enrichedIssue, appVersionLoading: false }
              : currentIssue)
            .filter((currentIssue) => !isExcludedAppVersionOnlyIssue(currentIssue, activeExcludedVersions)));
          void symbolicateIssueInBackground(enrichedIssue);
        } catch {
          updateIssuesForView(view, (currentIssues) => currentIssues.map((currentIssue) =>
            currentIssue.id === issue.id
              ? { ...currentIssue, appVersionLoading: false }
              : currentIssue
          ));
        } finally {
          versionEnrichingIssueIds.current.delete(issue.id);
        }
      }));
    }
  }, [activeExcludedVersionKey, symbolicateIssueInBackground, updateIssuesForView]);

  const symbolicateIssuesInBackground = useCallback(async (issues: SentryIssueSummary[]) => {
    for (const issue of issues) {
      await symbolicateIssueInBackground(issue);
    }
  }, [symbolicateIssueInBackground]);

  const hydrateIssueMetadataInBackground = useCallback(async (issues: SentryIssueSummary[], view: SentryView) => {
    void enrichIssueVersionsInBackground(issues, view);

    try {
      const statusResponse = await sentryAnalysisApi.historyStatus({ issues });
      const statuses = statusResponse.data?.statuses || {};
      const storedStatusMap: Record<string, IssueSymbolicationStatus> = {};
      const storedVersionMap: Record<string, string> = {};
      issues.forEach((issue) => {
        const status = statuses[issue.id] || (issue.shortId ? statuses[issue.shortId] : undefined);
        const historyId = status?.historyId || 0;
        if (historyId) {
          storedStatusMap[issue.id] = {
            status: 'success',
            historyId,
          };
        }
        if (status?.appVersion && !hasIssueVersionInfo(issue, activeExcludedVersions)) {
          storedVersionMap[issue.id] = status.appVersion;
        }
      });
      setIssueSymbolicationStatus((statusMap) => {
        const nextStatusMap = { ...statusMap };
        issues.forEach((issue) => {
          if (issue.id) {
            delete nextStatusMap[issue.id];
          }
        });
        return {
          ...nextStatusMap,
          ...storedStatusMap,
        };
      });
      if (Object.keys(storedVersionMap).length > 0) {
        updateIssuesForView(view, (currentIssues) => currentIssues.map((issue) => {
          const appVersion = storedVersionMap[issue.id];
          return appVersion
            ? {
              ...issue,
              appVersionRange: appVersion,
              minAppVersion: appVersion,
              maxAppVersion: appVersion,
              appVersions: [appVersion],
              appVersionLoading: false,
            }
            : issue;
        }));
      }
    } catch (statusError: any) {
      console.warn('查询 Sentry 入库状态失败', statusError);
    }

    void symbolicateIssuesInBackground(issues);
  }, [activeExcludedVersionKey, enrichIssueVersionsInBackground, symbolicateIssuesInBackground, updateIssuesForView]);

  const loadIssues = useCallback(async (
    period: string,
    options: { query?: string; view?: SentryView } = {}
  ) => {
    setIssueLoading(true);
    setFetchError('');
    const query = options.query || governanceConfig?.defaultIssueQuery || DEFAULT_ISSUE_QUERY;
    const targetView = options.view || (period === TOP_PERIOD ? 'top' : 'recent');
    try {
      const response = await sentryAnalysisApi.listIssues({
        period,
        limit: 20,
        query,
      });

      if (!response.success || !response.data) {
        throw new Error(response.error || '抓取 Sentry 问题列表失败');
      }

      const nextIssues = [...response.data.issues]
        .filter((issue) => !isExcludedAppVersionOnlyIssue(issue, activeExcludedVersions))
        .sort((a, b) => getIssueTime(b) - getIssueTime(a));
      if (targetView === 'top') {
        setTopIssues(nextIssues);
      } else if (targetView === 'recent') {
        setRecentIssues(nextIssues);
      } else if (targetView === 'lookup') {
        setLookupIssues(nextIssues);
      }

      setIssueLoading(false);
      void hydrateIssueMetadataInBackground(nextIssues, targetView);

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
  }, [activeExcludedVersionKey, governanceConfig?.defaultIssueQuery, hydrateIssueMetadataInBackground]);

  const updateCurrentIssue = (issue: CurrentSentryIssue | null) => {
    setCurrentIssue(issue?.id ? issue : null);
    setFetchError('');
  };

  const handleOpenIssue = (issue: SentryIssueSummary) => {
    updateCurrentIssue({
      id: issue.id,
      title: issue.title || issue.shortId || issue.id,
      permalink: toSentryProxyIssueURL(issue, governanceConfig),
    });
    setSentryDetailIssue(issue);
    setSentryDetailFrameKey((key) => key + 1);
    setSentryDetailModalOpen(true);
  };

  const handleShowOverview = () => {
    setActiveView('overview');
    setFetchError('');
  };

  const loadGovernanceIssues = async (nextFilters = governanceFilters) => {
    setGovernanceListLoading(true);
    setFetchError('');
    try {
      const response = await sentryAnalysisApi.governanceIssues({
        ...nextFilters,
        limit: 100,
      } as any);
      if (!response.success) {
        throw response;
      }
      setGovernanceList(response.data?.issues || []);
    } catch (error: any) {
      setFetchError(error.error || error.message || '加载 Crash 治理列表失败');
    } finally {
      setGovernanceListLoading(false);
    }
  };

  const handleShowGovernanceList = () => {
    setActiveView('governance-list');
    if (governanceList.length === 0) {
      void loadGovernanceIssues();
    }
  };

  const loadGovernanceEvents = async (nextFilters = governanceEventFilters) => {
    setGovernanceEventsLoading(true);
    setFetchError('');
    try {
      const response = await sentryAnalysisApi.governanceEvents({
        ...nextFilters,
        limit: 100,
      });
      if (!response.success) {
        throw response;
      }
      setGovernanceEvents(response.data?.events || []);
    } catch (error: any) {
      setFetchError(error.error || error.message || '加载 Crash 治理记录失败');
    } finally {
      setGovernanceEventsLoading(false);
    }
  };

  const handleShowGovernanceEvents = () => {
    setActiveView('governance-events');
    if (governanceEvents.length === 0) {
      void loadGovernanceEvents();
    }
  };

  const exportGovernanceEvents = async () => {
    setGovernanceEventsExporting(true);
    setFetchError('');
    try {
      await sentryAnalysisApi.exportGovernanceEvents({
        ...governanceEventFilters,
        limit: 200,
      });
      message.success('Crash 治理记录已导出');
    } catch (error: any) {
      setFetchError(error.error || error.message || '导出 Crash 治理记录失败');
    } finally {
      setGovernanceEventsExporting(false);
    }
  };

  const openGovernanceListWithFilters = (filters: Partial<typeof governanceFilters>) => {
    const nextFilters = {
      ...governanceFilters,
      ...filters,
    };
    setGovernanceFilters(nextFilters);
    setActiveView('governance-list');
    void loadGovernanceIssues(nextFilters);
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

  const handleShowLookup = () => {
    setActiveView('lookup');
    setFetchError('');
  };

  const handleViewChange = (view: SentryView) => {
    if (view === 'overview') {
      handleShowOverview();
      return;
    }
    if (view === 'governance-list') {
      handleShowGovernanceList();
      return;
    }
    if (view === 'governance-events') {
      handleShowGovernanceEvents();
      return;
    }
    if (view === 'top') {
      handleShowTop();
      return;
    }
    if (view === 'recent') {
      handleShowRecent();
      return;
    }
    if (view === 'raw-sentry') {
      setActiveView('raw-sentry');
      setFetchError('');
      return;
    }
    handleShowLookup();
  };

  const handleRefresh = () => {
    if (activeView === 'overview') {
      void loadGovernanceDashboard();
      return;
    }
    if (activeView === 'governance-list') {
      void loadGovernanceIssues();
      return;
    }
    if (activeView === 'governance-events') {
      void loadGovernanceEvents();
      return;
    }
    if (activeView === 'raw-sentry') {
      setRawSentryFrameKey((value) => value + 1);
      return;
    }
    if (activeView === 'lookup') {
      if (lookupQuery) {
        loadIssues(TOP_PERIOD, { query: lookupQuery, view: 'lookup' });
      }
      return;
    }
    loadIssues(activeView === 'top' ? TOP_PERIOD : RECENT_PERIOD);
  };

  const buildLookupQuery = (type: SentryLookupType, value: string) => {
    const trimmed = value.trim();
    const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `${governanceConfig?.defaultIssueQuery || DEFAULT_ISSUE_QUERY} ${type}:"${escaped}"`;
  };

  const handleLookupSearch = (value = lookupValue) => {
    const trimmed = value.trim();
    if (!trimmed) {
      message.warning('请输入 UID 或 DeviceID');
      return;
    }

    const query = buildLookupQuery(lookupType, trimmed);
    setLookupValue(trimmed);
    setLookupQuery(query);
    setActiveView('lookup');
    loadIssues(TOP_PERIOD, { query, view: 'lookup' });
  };

  const handleSymbolicateIssue = async (issue: SentryIssueSummary) => {
    setSymbolicatingIssueId(issue.id);
    setAnalysisTargetIssue(issue);
    setAnalysisResult(null);
    setAnalysisError('');
    setAnalysisOriginalLog('');
    setAnalysisAiError('');
    setAnalysisModalOpen(true);
    try {
      const response = await sentryAnalysisApi.symbolicateAndSave({
        issue,
      });
      if (!response.success || !response.data?.symbolicatedLog) {
        throw response;
      }

      const nextResult = response.data;
      setAnalysisResult(nextResult);
      setIssueSymbolicationStatus((statusMap) => ({
        ...statusMap,
        [issue.id]: {
          status: 'success',
          historyId: response.data?.historyId,
        },
      }));
      message.success('Sentry 问题已符号化并生成历史记录');
      void analyzeHistoryResult(nextResult, { silent: true });
    } catch (error: any) {
      const errorMessage = formatApiError(error, '符号化 Sentry 问题失败');
      const status = isIncompleteSentryEventError(error) ? 'incomplete' : 'failed';
      setAnalysisError(errorMessage);
      void loadAnalysisOriginalCrash(issue);
      setIssueSymbolicationStatus((statusMap) => ({
        ...statusMap,
        [issue.id]: {
          status,
          error: errorMessage,
        },
      }));
      message.error(errorMessage, 8);
    } finally {
      setSymbolicatingIssueId('');
    }
  };

  const handleOpenStoredDetail = async (issue: SentryIssueSummary, historyId: number) => {
    setSymbolicatingIssueId(issue.id);
    setAnalysisTargetIssue(issue);
    setAnalysisResult(null);
    setAnalysisError('');
    setAnalysisOriginalLog('');
    setAnalysisAiError('');
    setAnalysisModalOpen(true);
    try {
      const response = await historyApi.detail(historyId);
      if (!response.success || !response.data) {
        throw response;
      }

      const nextResult = {
        issue,
        appVersion: response.data.appVersion,
        originalLog: response.data.originalLog,
        symbolicatedLog: response.data.symbolicatedLog,
        matchedUUIDs: response.data.usedUuids || [],
        historyId: response.data.id,
        aiAnalysis: response.data.aiAnalysis,
      };
      setAnalysisResult(nextResult);
      void analyzeHistoryResult(nextResult, { silent: true });
    } catch (error: any) {
      const errorMessage = error.error || error.message || '获取历史详情失败';
      setAnalysisError(errorMessage);
      setIssueSymbolicationStatus((statusMap) => ({
        ...statusMap,
        [issue.id]: {
          status: 'failed',
          error: errorMessage,
        },
      }));
      message.error(errorMessage);
    } finally {
      setSymbolicatingIssueId('');
    }
  };

  const analyzeHistoryResult = async (
    targetResult: SentrySymbolicateAnalyzeResult,
    options: { silent?: boolean } = {}
  ) => {
    if (!targetResult.historyId) {
      message.error('历史记录ID不存在，无法进行 AI 分析');
      return;
    }
    if (targetResult.aiAnalysis || autoAnalyzedHistoryIds.current.has(targetResult.historyId)) {
      return;
    }

    autoAnalyzedHistoryIds.current.add(targetResult.historyId);
    const apiKey = window.localStorage.getItem('openai_api_key') || '';
    setAnalysisAiError('');
    setAnalysisAnalyzing(true);
    try {
      const response = await historyApi.analyzeHistory(targetResult.historyId, apiKey);
      if (!response.success || !response.data) {
        throw response;
      }

      setAnalysisResult((current) => {
        if (!current || current.historyId !== targetResult.historyId) {
          return current;
        }
        return {
          ...current,
          aiAnalysis: response.data,
        };
      });
      if (!options.silent) {
        message.success('AI 分析完成');
      }
    } catch (error: any) {
      const errorMessage = error.error || error.message || 'AI 分析失败';
      setAnalysisAiError(errorMessage);
      message.error(errorMessage, 8);
      autoAnalyzedHistoryIds.current.delete(targetResult.historyId);
    } finally {
      setAnalysisAnalyzing(false);
    }
  };

  const loadAnalysisOriginalCrash = async (issue: SentryIssueSummary) => {
    setAnalysisOriginalLoading(true);
    try {
      const response = await sentryAnalysisApi.buildOriginalCrash({ issue });
      if (!response.success || !response.data?.crashLog) {
        throw response;
      }
      setAnalysisOriginalLog(response.data.crashLog);
    } catch (error: any) {
      setAnalysisOriginalLog(formatApiError(error, '原始崩溃获取失败'));
    } finally {
      setAnalysisOriginalLoading(false);
    }
  };

  const handleIssueAction = (issue: SentryIssueSummary, status?: IssueSymbolicationStatus) => {
    if (status?.status === 'success' && status.historyId) {
      handleOpenStoredDetail(issue, status.historyId);
      return;
    }

    if (status?.status === 'failed' || status?.status === 'incomplete') {
      setAnalysisTargetIssue(issue);
      setAnalysisResult(null);
      setAnalysisOriginalLog('');
      setAnalysisError(status.error || (status.status === 'incomplete'
        ? 'Sentry 原始信息不全，无法符号化'
        : '符号化入库失败'));
      setAnalysisModalOpen(true);
      void loadAnalysisOriginalCrash(issue);
      return;
    }

    handleSymbolicateIssue(issue);
  };

  const getIssueActionLabel = (status?: IssueSymbolicationStatus) => {
    if (status?.status === 'success') {
      return '详情';
    }
    if (status?.status === 'failed' || status?.status === 'incomplete') {
      return '查看';
    }
    return '符号化';
  };

  const getIssueActionTooltip = (status?: IssueSymbolicationStatus) => {
    if (status?.status === 'success') {
      return '查看已入库详情';
    }
    if (status?.status === 'incomplete') {
      return '查看原始信息不全原因';
    }
    if (status?.status === 'failed') {
      return '查看符号化失败原因';
    }
    return '拉取 Sentry 记录并符号化入库';
  };

  const handleDownloadOriginalCrash = async (issue: SentryIssueSummary) => {
    setDownloadingIssueId(issue.id);
    try {
      const targetIssue = {
        ...issue,
        maxAppVersion: getIssueHighestAppVersion(issue, activeExcludedVersions),
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
  const activeIssues = activeView === 'top'
    ? topIssues
    : activeView === 'lookup'
      ? lookupIssues
      : recentIssues;
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
    const originalLog = analysisResult?.originalLog || analysisOriginalLog;
    if (!originalLog) {
      return;
    }
    downloadTextFile(
      originalLog,
      buildOriginalCrashFileName(originalLog, analysisResult?.incidentIdentifier)
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

  const getGovernanceStatusMeta = (status?: string) => {
    switch (status) {
      case 'fixed':
        return { color: 'green', label: '已修复' };
      case 'regression':
        return { color: 'blue', label: '新发现' };
      case 'pending_fix':
        return { color: 'volcano', label: '待修复' };
      case 'analyzing':
        return { color: 'processing', label: '分析中' };
      case 'ignored':
        return { color: 'default', label: '已忽略' };
      default:
        return { color: 'blue', label: '新发现' };
    }
  };

  const getSymbolicationMeta = (status?: string) => {
    switch (status) {
      case 'success':
        return { color: 'green', label: '已符号化' };
      case 'failed':
        return { color: 'red', label: '符号化失败' };
      case 'incomplete':
        return { color: 'gold', label: '信息不全' };
      default:
        return { color: 'processing', label: '待符号化' };
    }
  };

  const getSymbolicationFailureCategoryMeta = (category?: string) => {
    switch (category) {
      case 'missing_dsym':
        return { color: 'red', label: '缺 dSYM' };
      case 'uuid_mismatch':
        return { color: 'volcano', label: 'UUID 不匹配' };
      case 'incomplete_log':
        return { color: 'gold', label: '日志不完整' };
      case 'missing_system_symbols':
        return { color: 'orange', label: '系统符号缺失' };
      case 'tool_failed':
        return { color: 'magenta', label: '工具失败' };
      case 'unknown':
        return { color: 'default', label: '原因待确认' };
      default:
        return null;
    }
  };

  const getCoverageMeta = (status?: string) => {
    switch (status) {
      case 'ready':
        return { color: 'green', label: 'dSYM齐全' };
      case 'partial':
        return { color: 'orange', label: 'dSYM部分缺失' };
      case 'missing':
        return { color: 'red', label: 'dSYM缺失' };
      default:
        return { color: 'default', label: '未检查' };
    }
  };

  const getAnalysisMeta = (status?: string) => {
    switch (status) {
      case 'success':
        return { color: 'green', label: 'AI已分析' };
      case 'failed':
        return { color: 'red', label: 'AI失败' };
      case 'skipped':
        return { color: 'default', label: '不分析' };
      default:
        return { color: 'processing', label: 'AI待分析' };
    }
  };

  const getRecommendationPriorityMeta = (priority?: string) => {
    switch (priority) {
      case 'high':
        return { color: 'red', label: '高优先级' };
      case 'medium':
        return { color: 'gold', label: '中优先级' };
      default:
        return { color: 'blue', label: '低优先级' };
    }
  };

  const startGovernanceAnalysis = async (record: CrashGovernanceRecord) => {
    if (!record.historyId) {
      message.warning('当前 Crash 未关联符号化历史，无法执行 AI 分析');
      return;
    }
    setGovernanceAnalyzingId(record.id);
    try {
      const apiKey = window.localStorage.getItem('openai_api_key') || '';
      const response = await sentryAnalysisApi.analyzeGovernanceIssue(record.id, apiKey);
      if (!response.success) {
        throw response;
      }
      message.success('AI 分析已开始，稍后刷新看板查看结果');
      await loadGovernanceDashboard();
      window.setTimeout(() => void loadGovernanceDashboard(), 5000);
    } catch (error: any) {
      message.error(error.error || error.message || '启动 AI 分析失败');
    } finally {
      setGovernanceAnalyzingId(null);
    }
  };

  const openGovernanceDetail = async (record: CrashGovernanceRecord) => {
    setGovernanceDetailOpen(true);
    setGovernanceDetailLoading(true);
    setGovernanceDetail({ record });
    try {
      const response = await sentryAnalysisApi.governanceIssueDetail(record.id);
      if (!response.success || !response.data) {
        throw response;
      }
      setGovernanceDetail(response.data);
    } catch (error: any) {
      message.error(error.error || error.message || '加载 Crash 治理详情失败');
    } finally {
      setGovernanceDetailLoading(false);
    }
  };

  const refreshGovernanceCoverage = async (record: CrashGovernanceRecord) => {
    if (!record.appVersion) {
      message.warning('当前 Crash 缺少 App 版本，无法重查 dSYM 覆盖');
      return;
    }
    setGovernanceCoverageRefreshingId(record.id);
    try {
      const response = await sentryAnalysisApi.refreshGovernanceCoverage(record.id);
      if (!response.success || !response.data) {
        throw response;
      }
      const nextRecord = response.data;
      setGovernanceList((records) => records.map((item) => item.id === nextRecord.id ? nextRecord : item));
      setGovernanceDetail((detail) => detail?.record.id === nextRecord.id
        ? { ...detail, record: nextRecord }
        : detail);
      message.success(`dSYM 覆盖已重查：${getCoverageMeta(nextRecord.dsymCoverageStatus).label}`);
      await loadGovernanceDashboard();
    } catch (error: any) {
      message.error(error.error || error.message || '重查 dSYM 覆盖失败');
    } finally {
      setGovernanceCoverageRefreshingId(null);
    }
  };

  const updateGovernanceStatus = async (
    record: CrashGovernanceRecord,
    payload: Parameters<typeof sentryAnalysisApi.updateGovernanceStatus>[1]
  ) => {
    setGovernanceUpdatingId(record.id);
    try {
      const response = await sentryAnalysisApi.updateGovernanceStatus(record.id, payload);
      if (!response.success) {
        throw response;
      }
      message.success('Crash 处理状态已更新');
      if (governanceDetail?.record.id === record.id) {
        await openGovernanceDetail(response.data || record);
      }
      await loadGovernanceDashboard();
    } catch (error: any) {
      message.error(error.error || error.message || '更新 Crash 处理状态失败');
    } finally {
      setGovernanceUpdatingId(null);
    }
  };

  const updateGovernanceFingerprintStatus = async (
    record: CrashGovernanceRecord,
    payload: Parameters<typeof sentryAnalysisApi.updateGovernanceFingerprintStatus>[1]
  ) => {
    setGovernanceUpdatingId(record.id);
    try {
      const response = await sentryAnalysisApi.updateGovernanceFingerprintStatus(record.id, payload);
      if (!response.success || !response.data) {
        throw response;
      }
      const nextGroup = response.data;
      const nextRecord = nextGroup.records.find((item) => item.id === record.id) || record;
      setGovernanceDetail((detail) => detail?.record.id === record.id
        ? { ...detail, record: nextRecord, fingerprintGroup: nextGroup }
        : detail);
      setGovernanceList((records) => records.map((item) =>
        nextGroup.records.find((groupItem) => groupItem.id === item.id) || item
      ));
      message.success(`同类 Crash 已批量更新 ${nextGroup.issueCount} 条`);
      await openGovernanceDetail(nextRecord);
      await loadGovernanceDashboard();
    } catch (error: any) {
      message.error(error.error || error.message || '批量更新同类 Crash 处理状态失败');
    } finally {
      setGovernanceUpdatingId(null);
    }
  };

  const promptGovernanceStatus = (record: CrashGovernanceRecord, action: 'pending_fix' | 'fixed' | 'ignored') => {
    if (action === 'pending_fix') {
      let ownerValue = record.owner || '';
      Modal.confirm({
        title: '标记为待修复？',
        content: (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Text type="secondary">确认将 {record.shortId || record.sourceIssueId} 标记为待修复，可补充负责人。</Text>
            <Input
              placeholder="负责人，例如 iOS/IM/某同学"
              defaultValue={ownerValue}
              onChange={(event) => {
                ownerValue = event.target.value;
              }}
            />
          </Space>
        ),
        okText: '确认',
        cancelText: '取消',
        onOk: () => updateGovernanceStatus(record, {
          governanceStatus: 'pending_fix',
          owner: ownerValue.trim() || undefined,
        }),
      });
      return;
    }

    let inputValue = '';
    Modal.confirm({
      title: action === 'fixed' ? '标记为已修复' : '忽略该 Crash',
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Text type="secondary">
            {action === 'fixed'
              ? '请输入修复版本或备注，方便后续排查处理记录。'
              : '请输入忽略原因，避免后续排查时丢失上下文。'}
          </Text>
          <Input
            placeholder={action === 'fixed' ? `修复版本，默认 ${record.appVersion || '当前版本'}` : '忽略原因'}
            onChange={(event) => {
              inputValue = event.target.value;
            }}
          />
        </Space>
      ),
      okText: action === 'fixed' ? '标记已修复' : '忽略',
      cancelText: '取消',
      onOk: () => {
        const trimmed = inputValue.trim();
        if (action === 'ignored' && !trimmed) {
          message.warning('请填写忽略原因');
          return Promise.reject();
        }
        return updateGovernanceStatus(record, action === 'fixed'
          ? {
            governanceStatus: 'fixed',
            fixedVersion: trimmed || record.appVersion || '',
            fixedRemark: trimmed && trimmed !== record.appVersion ? trimmed : undefined,
          }
          : {
            governanceStatus: 'ignored',
            ignoreReason: trimmed,
          });
      },
    });
  };

  const promptFingerprintGovernanceStatus = (record: CrashGovernanceRecord, action: 'pending_fix' | 'fixed' | 'ignored') => {
    const groupCount = governanceDetail?.fingerprintGroup?.issueCount || 1;
    if (action === 'pending_fix') {
      let ownerValue = record.owner || '';
      Modal.confirm({
        title: `批量标记 ${groupCount} 条同类 Crash 为待修复？`,
        content: (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Text type="secondary">将同一指纹下的线上 Sentry 记录批量标记为待修复，可补充负责人。</Text>
            <Input
              placeholder="负责人，例如 iOS/IM/某同学"
              defaultValue={ownerValue}
              onChange={(event) => {
                ownerValue = event.target.value;
              }}
            />
          </Space>
        ),
        okText: '批量确认',
        cancelText: '取消',
        onOk: () => updateGovernanceFingerprintStatus(record, {
          governanceStatus: 'pending_fix',
          owner: ownerValue.trim() || undefined,
        }),
      });
      return;
    }

    let inputValue = '';
    Modal.confirm({
      title: action === 'fixed' ? `批量标记 ${groupCount} 条同类 Crash 为已修复？` : `批量忽略 ${groupCount} 条同类 Crash？`,
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Text type="secondary">
            {action === 'fixed'
              ? '请输入修复版本或备注，会同步到同一指纹下的线上 Sentry 记录。'
              : '请输入忽略原因，会同步到同一指纹下的线上 Sentry 记录。'}
          </Text>
          <Input
            placeholder={action === 'fixed' ? `修复版本，默认 ${record.appVersion || '当前版本'}` : '忽略原因'}
            onChange={(event) => {
              inputValue = event.target.value;
            }}
          />
        </Space>
      ),
      okText: action === 'fixed' ? '批量标记已修复' : '批量忽略',
      cancelText: '取消',
      onOk: () => {
        const trimmed = inputValue.trim();
        if (action === 'ignored' && !trimmed) {
          message.warning('请填写忽略原因');
          return Promise.reject();
        }
        return updateGovernanceFingerprintStatus(record, action === 'fixed'
          ? {
            governanceStatus: 'fixed',
            fixedVersion: trimmed || record.appVersion || '',
            fixedRemark: trimmed && trimmed !== record.appVersion ? trimmed : undefined,
          }
          : {
            governanceStatus: 'ignored',
            ignoreReason: trimmed,
          });
      },
    });
  };

  const renderGovernanceRecord = (record: CrashGovernanceRecord) => {
    const statusMeta = getGovernanceStatusMeta(record.governanceStatus);
    const symbolicationMeta = getSymbolicationMeta(record.symbolicationStatus);
    const failureCategoryMeta = getSymbolicationFailureCategoryMeta(record.symbolicationFailureCategory);
    const coverageMeta = getCoverageMeta(record.dsymCoverageStatus);
    const analysisMeta = getAnalysisMeta(record.analysisStatus);
    const shouldShowSource = record.source && record.source !== 'sentry';
    const shouldShowSymbolication = record.symbolicationStatus && record.symbolicationStatus !== 'success';
    const shouldShowAnalysis = record.analysisStatus === 'failed';
    const shouldShowCoverage = record.dsymCoverageStatus && record.dsymCoverageStatus !== 'ready';
    const issueForAction: SentryIssueSummary = {
      id: record.sourceIssueId,
      shortId: record.shortId,
      title: record.title,
      culprit: record.culprit,
      level: record.level,
      status: record.sentryStatus,
      count: String(record.eventCount || ''),
      userCount: record.userCount,
      firstSeen: record.firstSeen,
      lastSeen: record.lastSeen,
      permalink: record.permalink,
      appVersionRange: record.appVersionRange,
      maxAppVersion: record.appVersion,
    };
    return (
      <List.Item>
        <Card size="small" style={{ width: '100%' }}>
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
              <Space wrap style={{ width: '100%', justifyContent: 'space-between' }} align="start">
                <Space wrap>
                  <Text strong>{record.shortId || record.sourceIssueId}</Text>
                {shouldShowSource && (
                  <Tag color={record.source === 'quality' ? 'purple' : 'cyan'}>
                    {record.source === 'quality' ? '质检证据' : record.source === 'manual' ? '手动解析' : '线上'}
                  </Tag>
                )}
                <Tag color={statusMeta.color}>{statusMeta.label}</Tag>
                {shouldShowSymbolication && <Tag color={symbolicationMeta.color}>{symbolicationMeta.label}</Tag>}
                {failureCategoryMeta && <Tag color={failureCategoryMeta.color}>{failureCategoryMeta.label}</Tag>}
                {shouldShowAnalysis && <Tag color={analysisMeta.color}>{analysisMeta.label}</Tag>}
                {shouldShowCoverage && <Tag color={coverageMeta.color}>{coverageMeta.label}</Tag>}
                {record.level && <Tag color={getSeverityColor(record.level)}>{record.level}</Tag>}
                {record.appVersion && <Tag color="blue">版本 {record.appVersion}</Tag>}
                {(record.groupedIssueCount || 0) > 1 && (
                  <Tag color="geekblue">聚合 {record.groupedIssueCount} 个 Issue</Tag>
                )}
              </Space>
              <Space wrap>
                <Text type="secondary">事件 {record.eventCount || '-'}</Text>
                <Text type="secondary">用户 {record.userCount || '-'}</Text>
                <Text type="secondary">最近 {formatIssueTime(record.lastSeen)}</Text>
                <Button
                  size="small"
                  icon={<FileSearchOutlined />}
                  onClick={() => openGovernanceDetail(record)}
                >
                  治理详情
                </Button>
                <Button
                  size="small"
                  loading={governanceCoverageRefreshingId === record.id}
                  disabled={!record.appVersion}
                  onClick={() => refreshGovernanceCoverage(record)}
                >
                  重查dSYM
                </Button>
                {record.historyId ? (
                  <Button
                    size="small"
                    icon={<FileSearchOutlined />}
                    onClick={() => handleOpenStoredDetail(issueForAction, record.historyId!)}
                  >
                    符号详情
                  </Button>
                ) : (
                  <Button
                    size="small"
                    icon={<FileSearchOutlined />}
                    loading={symbolicatingIssueId === record.sourceIssueId}
                    onClick={() => handleSymbolicateIssue(issueForAction)}
                  >
                    符号化
                  </Button>
                )}
                {record.historyId && record.analysisStatus !== 'success' && record.analysisStatus !== 'skipped' && (
                  <Button
                    size="small"
                    loading={governanceAnalyzingId === record.id || record.governanceStatus === 'analyzing'}
                    onClick={() => startGovernanceAnalysis(record)}
                  >
                    AI分析
                  </Button>
                )}
              </Space>
            </Space>
            <Paragraph style={{ margin: 0 }}>{record.title}</Paragraph>
            <Space wrap size={12}>
              {record.crashModule && <Text type="secondary">模块：{record.crashModule}</Text>}
              {record.crashLocation && <Text type="secondary">位置：{record.crashLocation}</Text>}
              {record.owner && <Text type="secondary">负责人：{record.owner}</Text>}
              {record.fixedVersion && <Text type="secondary">修复版本：{record.fixedVersion}</Text>}
              {record.fixedRemark && <Text type="secondary">修复备注：{record.fixedRemark}</Text>}
              {record.ignoreReason && <Text type="secondary">忽略原因：{record.ignoreReason}</Text>}
              {record.qualityTaskId && <Text type="secondary">质检任务：{record.qualityTaskId}</Text>}
              {record.lastSyncError && <Text type="danger">同步失败：{record.lastSyncError}</Text>}
              {record.symbolicationError && <Text type="danger">符号化：{record.symbolicationError}</Text>}
              {record.analysisError && <Text type="danger">AI：{record.analysisError}</Text>}
            </Space>
          </Space>
        </Card>
      </List.Item>
    );
  };

  const renderGovernanceEvents = () => {
    const events = governanceDetail?.events || [];
    if (events.length === 0) {
      return null;
    }

    return (
      <Card size="small" title="治理记录">
        <List
          size="small"
          dataSource={events}
          renderItem={(event) => {
            const fromMeta = getGovernanceStatusMeta(event.fromStatus);
            const toMeta = getGovernanceStatusMeta(event.toStatus);
            return (
              <List.Item>
                <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Space wrap>
                    <Tag color={event.scope === 'fingerprint' ? 'geekblue' : 'blue'}>
                      {event.scope === 'fingerprint' ? '同指纹批量' : '单条'}
                    </Tag>
                    {event.fromStatus && <Tag color={fromMeta.color}>{fromMeta.label}</Tag>}
                    <Text type="secondary">→</Text>
                    {event.toStatus && <Tag color={toMeta.color}>{toMeta.label}</Tag>}
                    <Text type="secondary">操作人：{event.operator || '系统'}</Text>
                    {event.note && <Text type="secondary">备注：{event.note}</Text>}
                    {event.relatedRecordIds.length > 1 && <Text type="secondary">关联 {event.relatedRecordIds.length} 条</Text>}
                  </Space>
                  <Text type="secondary">{new Date(event.createdAt).toLocaleString('zh-CN')}</Text>
                </Space>
              </List.Item>
            );
          }}
        />
      </Card>
    );
  };

  const renderGovernanceLatestEvent = () => {
    const latestEvent = governanceDetail?.events?.[0];
    if (!latestEvent) {
      return null;
    }
    const fromMeta = getGovernanceStatusMeta(latestEvent.fromStatus);
    const toMeta = getGovernanceStatusMeta(latestEvent.toStatus);
    return (
      <Alert
        type="info"
        showIcon
        message="最近治理动作"
        description={
          <Space direction="vertical" size={4}>
            <Space wrap>
              <Text>{latestEvent.operator || '系统'}</Text>
              <Text type="secondary">将状态从</Text>
              {latestEvent.fromStatus ? <Tag color={fromMeta.color}>{fromMeta.label}</Tag> : <Tag>未记录</Tag>}
              <Text type="secondary">调整为</Text>
              {latestEvent.toStatus ? <Tag color={toMeta.color}>{toMeta.label}</Tag> : <Tag>未记录</Tag>}
              <Text type="secondary">{new Date(latestEvent.createdAt).toLocaleString('zh-CN')}</Text>
            </Space>
            <Space wrap>
              <Tag color={latestEvent.scope === 'fingerprint' ? 'geekblue' : 'blue'}>
                {latestEvent.scope === 'fingerprint' ? '同指纹批量' : '单条操作'}
              </Tag>
              {latestEvent.relatedRecordIds.length > 1 && <Text type="secondary">关联 {latestEvent.relatedRecordIds.length} 条记录</Text>}
              {latestEvent.note && <Text type="secondary">备注：{latestEvent.note}</Text>}
            </Space>
          </Space>
        }
      />
    );
  };

  const renderGovernanceDashboard = () => {
    const summary = governanceDashboard?.summary;
    const syncHealth = governanceDashboard?.syncHealth;
    const metricCards = [
      { label: '未解决', value: summary?.totalOpen ?? 0, color: '#1677ff' },
      { label: '高风险', value: summary?.highRisk ?? 0, color: '#ff4d4f' },
      { label: '今日新增', value: summary?.newToday ?? 0, color: '#722ed1' },
    ];
    const recommendations = (governanceDashboard?.actionRecommendations || [])
      .filter((item) => !/回归\s*Crash|Crash\s*回归|regression/i.test(`${item.title || ''}${item.description || ''}${item.action || ''}`))
      .slice(0, 3);
    return (
      <Spin spinning={governanceLoading || governanceSyncing} tip={governanceSyncing ? '正在同步 Sentry 到平台库...' : '正在读取 Crash 治理看板...'}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {governanceError && (
            <Alert
              type="error"
              message="Crash 治理状态异常"
              description={governanceError}
              showIcon
            />
          )}
          {syncHealth && syncHealth.status !== 'healthy' && (
            <Alert
              type={syncHealth.status === 'failed' ? 'error' : 'warning'}
              message={
                syncHealth.status === 'never_synced'
                    ? '尚未同步 Sentry'
                    : syncHealth.status === 'failed'
                      ? 'Sentry 同步存在失败'
                      : 'Sentry 同步可能已过期'
              }
              description={[
                syncHealth.message,
                syncHealth.lastSyncedAt ? `最后同步：${new Date(syncHealth.lastSyncedAt).toLocaleString('zh-CN')}` : '',
                syncHealth.staleHours !== undefined ? `距今 ${syncHealth.staleHours} 小时` : '',
                syncHealth.failedCount ? `失败 ${syncHealth.failedCount} 条` : '',
                syncHealth.retryCount ? `重试 ${syncHealth.retryCount} 次` : '',
              ].filter(Boolean).join('；')}
              showIcon
            />
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            {metricCards.map((item) => (
              <Card key={item.label} size="small">
                <Text type="secondary">{item.label}</Text>
                <Title level={3} style={{ margin: '8px 0 0', color: item.color }}>{item.value}</Title>
              </Card>
            ))}
          </div>

          {recommendations.length > 0 && (
            <Card
              size="small"
              title="优先处理"
              extra={<Button type="link" onClick={() => setActiveView('governance-list')}>进入治理列表</Button>}
            >
              <List
                size="small"
                dataSource={recommendations}
                renderItem={(item) => {
                  const meta = getRecommendationPriorityMeta(item.priority);
                  const targetFilters = item.targetFilters || (item.relatedCategory
                    ? { source: 'sentry' as const, symbolicationFailureCategory: item.relatedCategory }
                    : undefined);
                  return (
                    <List.Item
                      actions={targetFilters ? [
                        <Button
                          key="view"
                          size="small"
                          type="link"
                          onClick={() => openGovernanceListWithFilters(targetFilters)}
                        >
                          查看
                        </Button>,
                      ] : undefined}
                    >
                      <Space direction="vertical" size={4}>
                        <Space wrap>
                          <Text strong>{item.title}</Text>
                          <Tag color={meta.color}>{meta.label}</Tag>
                          {item.count !== undefined && <Tag>{item.count} 条</Tag>}
                        </Space>
                        <Text type="secondary">{item.action || item.description}</Text>
                      </Space>
                    </List.Item>
                  );
                }}
              />
            </Card>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
            <Card size="small" title="Top Crash" extra={<Text type="secondary">按事件数排序</Text>}>
              {governanceDashboard?.topIssues?.length ? (
                <List dataSource={governanceDashboard.topIssues.slice(0, 5)} renderItem={renderGovernanceRecord} />
              ) : (
                <Alert type="info" message="暂无已同步 Crash 数据" showIcon />
              )}
            </Card>
            <Card size="small" title="最近新增" extra={<Text type="secondary">按最近发生排序</Text>}>
              {governanceDashboard?.recentIssues?.length ? (
                <List dataSource={governanceDashboard.recentIssues.slice(0, 5)} renderItem={renderGovernanceRecord} />
              ) : (
                <Alert type="info" message="暂无最近 Crash 数据" showIcon />
              )}
            </Card>
          </div>
        </Space>
      </Spin>
    );
  };

  const updateGovernanceFilter = (key: keyof typeof governanceFilters, value: string) => {
    setGovernanceFilters((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const renderGovernanceList = () => {
    const applyFilters = () => void loadGovernanceIssues(governanceFilters);
    const resetFilters = () => {
      const nextFilters = {
        source: 'all',
        status: 'all',
        appVersion: '',
        dsymCoverageStatus: 'all',
        symbolicationStatus: 'all',
        symbolicationFailureCategory: 'all',
        analysisStatus: 'all',
        owner: '',
        keyword: '',
      };
      setGovernanceFilters(nextFilters);
      void loadGovernanceIssues(nextFilters);
    };

    return (
      <Card
        title={
          <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
            <Space>
              <span>Crash 治理列表</span>
              <Tag>{governanceList.length} 条</Tag>
            </Space>
            <Space>
              <Button onClick={resetFilters}>重置</Button>
              <Button type="primary" icon={<SearchOutlined />} onClick={applyFilters} loading={governanceListLoading}>
                查询
              </Button>
            </Space>
          </Space>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Space wrap>
            <Select
              value={governanceFilters.source}
              style={{ width: 130 }}
              onChange={(value) => updateGovernanceFilter('source', value)}
              options={[
                { value: 'all', label: '全部来源' },
                { value: 'sentry', label: '线上 Sentry' },
                { value: 'quality', label: '质检证据' },
                { value: 'manual', label: '手动解析' },
              ]}
            />
            <Select
              value={governanceFilters.status}
              style={{ width: 130 }}
              onChange={(value) => updateGovernanceFilter('status', value)}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'open', label: '未解决' },
                { value: 'new', label: '新发现' },
                { value: 'analyzing', label: '分析中' },
                { value: 'pending_fix', label: '待修复' },
                { value: 'fixed', label: '已修复' },
                { value: 'ignored', label: '已忽略' },
              ]}
            />
            <Input
              allowClear
              placeholder="App 版本"
              value={governanceFilters.appVersion}
              onChange={(event) => updateGovernanceFilter('appVersion', event.target.value)}
              style={{ width: 140 }}
            />
            <Select
              value={governanceFilters.dsymCoverageStatus}
              style={{ width: 140 }}
              onChange={(value) => updateGovernanceFilter('dsymCoverageStatus', value)}
              options={[
                { value: 'all', label: '全部 dSYM' },
                { value: 'ready', label: 'dSYM齐全' },
                { value: 'partial', label: '部分缺失' },
                { value: 'missing', label: 'dSYM缺失' },
                { value: 'unknown', label: '未检查' },
              ]}
            />
            <Select
              value={governanceFilters.symbolicationStatus}
              style={{ width: 140 }}
              onChange={(value) => updateGovernanceFilter('symbolicationStatus', value)}
              options={[
                { value: 'all', label: '全部符号化' },
                { value: 'pending', label: '待符号化' },
                { value: 'success', label: '已符号化' },
                { value: 'failed', label: '符号化失败' },
                { value: 'incomplete', label: '信息不全' },
              ]}
            />
            <Select
              value={governanceFilters.symbolicationFailureCategory}
              style={{ width: 150 }}
              onChange={(value) => updateGovernanceFilter('symbolicationFailureCategory', value)}
              options={[
                { value: 'all', label: '全部失败原因' },
                { value: 'missing_dsym', label: '缺 dSYM' },
                { value: 'uuid_mismatch', label: 'UUID 不匹配' },
                { value: 'incomplete_log', label: '日志不完整' },
                { value: 'missing_system_symbols', label: '系统符号缺失' },
                { value: 'tool_failed', label: '工具失败' },
                { value: 'unknown', label: '原因待确认' },
              ]}
            />
            <Select
              value={governanceFilters.analysisStatus}
              style={{ width: 140 }}
              onChange={(value) => updateGovernanceFilter('analysisStatus', value)}
              options={[
                { value: 'all', label: '全部 AI' },
                { value: 'pending', label: 'AI待分析' },
                { value: 'success', label: 'AI已分析' },
                { value: 'failed', label: 'AI失败' },
                { value: 'skipped', label: '不分析' },
              ]}
            />
            <Input
              allowClear
              placeholder="负责人"
              value={governanceFilters.owner}
              onChange={(event) => updateGovernanceFilter('owner', event.target.value)}
              style={{ width: 140 }}
            />
            <Search
              allowClear
              placeholder="搜索 Issue、标题、模块"
              value={governanceFilters.keyword}
              onChange={(event) => updateGovernanceFilter('keyword', event.target.value)}
              onSearch={applyFilters}
              style={{ width: 280, maxWidth: '100%' }}
            />
          </Space>
          <Spin spinning={governanceListLoading} tip="正在加载 Crash 治理列表...">
            {governanceList.length ? (
              <List dataSource={governanceList} renderItem={renderGovernanceRecord} />
            ) : (
              <Alert type="info" message="暂无匹配的 Crash 治理记录" showIcon />
            )}
          </Spin>
        </Space>
      </Card>
    );
  };

  const updateGovernanceEventFilter = (key: keyof typeof governanceEventFilters, value: string) => {
    setGovernanceEventFilters((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const renderGovernanceEventList = () => {
    const applyFilters = () => void loadGovernanceEvents(governanceEventFilters);
    const resetFilters = () => {
      const nextFilters = {
        scope: 'all',
        toStatus: 'all',
        operator: '',
        keyword: '',
      };
      setGovernanceEventFilters(nextFilters);
      void loadGovernanceEvents(nextFilters);
    };

    return (
      <Card
        title={
          <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
            <Space>
              <span>Crash 治理记录</span>
              <Tag>{governanceEvents.length} 条</Tag>
            </Space>
            <Space>
              <Button onClick={resetFilters}>重置</Button>
              <Button
                icon={<DownloadOutlined />}
                onClick={exportGovernanceEvents}
                loading={governanceEventsExporting}
              >
                导出 CSV
              </Button>
              <Button type="primary" icon={<SearchOutlined />} onClick={applyFilters} loading={governanceEventsLoading}>
                查询
              </Button>
            </Space>
          </Space>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Space wrap>
            <Select
              value={governanceEventFilters.scope}
              style={{ width: 140 }}
              onChange={(value) => updateGovernanceEventFilter('scope', value)}
              options={[
                { value: 'all', label: '全部范围' },
                { value: 'single', label: '单条操作' },
                { value: 'fingerprint', label: '同指纹批量' },
              ]}
            />
            <Select
              value={governanceEventFilters.toStatus}
              style={{ width: 140 }}
              onChange={(value) => updateGovernanceEventFilter('toStatus', value)}
              options={[
                { value: 'all', label: '全部目标状态' },
                { value: 'new', label: '新发现' },
                { value: 'analyzing', label: '分析中' },
                { value: 'pending_fix', label: '待修复' },
                { value: 'fixed', label: '已修复' },
                { value: 'ignored', label: '已忽略' },
              ]}
            />
            <Input
              allowClear
              placeholder="操作人"
              value={governanceEventFilters.operator}
              onChange={(event) => updateGovernanceEventFilter('operator', event.target.value)}
              style={{ width: 160 }}
            />
            <Search
              allowClear
              placeholder="搜索 Issue、标题、版本、备注"
              value={governanceEventFilters.keyword}
              onChange={(event) => updateGovernanceEventFilter('keyword', event.target.value)}
              onSearch={applyFilters}
              style={{ width: 300, maxWidth: '100%' }}
            />
          </Space>
          <Spin spinning={governanceEventsLoading} tip="正在加载 Crash 治理记录...">
            {governanceEvents.length ? (
              <List
                dataSource={governanceEvents}
                renderItem={(event) => {
                  const fromMeta = getGovernanceStatusMeta(event.fromStatus);
                  const toMeta = getGovernanceStatusMeta(event.toStatus);
                  return (
                    <List.Item>
                      <Card size="small" style={{ width: '100%' }}>
                        <Space direction="vertical" style={{ width: '100%' }} size={6}>
                          <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
                            <Space wrap>
                              <Tag color={event.scope === 'fingerprint' ? 'geekblue' : 'blue'}>
                                {event.scope === 'fingerprint' ? '同指纹批量' : '单条'}
                              </Tag>
                              {event.fromStatus && <Tag color={fromMeta.color}>{fromMeta.label}</Tag>}
                              <Text type="secondary">→</Text>
                              {event.toStatus && <Tag color={toMeta.color}>{toMeta.label}</Tag>}
                              <Text type="secondary">操作人：{event.operator || '系统'}</Text>
                              {event.relatedRecordIds.length > 1 && <Text type="secondary">关联 {event.relatedRecordIds.length} 条</Text>}
                            </Space>
                            <Text type="secondary">{new Date(event.createdAt).toLocaleString('zh-CN')}</Text>
                          </Space>
                          {event.record && (
                            <Space wrap>
                              <Button
                                type="link"
                                size="small"
                                style={{ padding: 0, height: 'auto' }}
                                onClick={() => openGovernanceDetail(event.record!)}
                              >
                                {event.record.shortId || event.record.sourceIssueId}
                              </Button>
                              {event.record.appVersion && <Tag color="blue">版本 {event.record.appVersion}</Tag>}
                              <Text>{event.record.title}</Text>
                            </Space>
                          )}
                          {event.note && <Text type="secondary">备注：{event.note}</Text>}
                        </Space>
                      </Card>
                    </List.Item>
                  );
                }}
              />
            ) : (
              <Alert type="info" message="暂无匹配的 Crash 治理记录" showIcon />
            )}
          </Spin>
        </Space>
      </Card>
    );
  };

  const renderIssueCard = (issue: SentryIssueSummary) => {
    const selected = currentIssue?.id === issue.id;
    const symbolicationStatus = issueSymbolicationStatus[issue.id];
    const isStored = symbolicationStatus?.status === 'success';
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
                {activeView === 'recent' && isNewRecentIssue(issue) && (
                  <Tag color="magenta">新增</Tag>
                )}
                {issue.level && <Tag color={getSeverityColor(issue.level)}>{issue.level}</Tag>}
                {issue.status && !isStored && <Tag>{issue.status}</Tag>}
                {symbolicationStatus?.status === 'pending' && <Tag color="processing">符号化中</Tag>}
                {isStored && (
                  <Tag color="green">已入库 #{symbolicationStatus.historyId || '-'}</Tag>
                )}
                {symbolicationStatus?.status === 'incomplete' && (
                  <Tooltip title={symbolicationStatus.error || 'Sentry 原始信息不全，无法符号化'}>
                    <Tag
                      color="gold"
                      style={{ cursor: 'pointer' }}
                      onClick={(event) => {
                        event.stopPropagation();
                        message.warning(symbolicationStatus.error || 'Sentry 原始信息不全，无法符号化', 8);
                      }}
                    >
                      信息不全
                    </Tag>
                  </Tooltip>
                )}
                {symbolicationStatus?.status === 'failed' && (
                  <Tooltip title={symbolicationStatus.error || '符号化入库失败'}>
                    <Tag
                      color="red"
                      style={{ cursor: 'pointer' }}
                      onClick={(event) => {
                        event.stopPropagation();
                        message.error(symbolicationStatus.error || '符号化入库失败', 6);
                      }}
                    >
                      符号化失败
                    </Tag>
                  </Tooltip>
                )}
              </Space>
              <Space>
                <Text type="secondary">事件 {issue.count || '-'}</Text>
                <Text type="secondary">用户 {issue.userCount ?? '-'}</Text>
                <Text type="secondary">APP版本范围</Text>
                <Tag color={issue.appVersionLoading ? 'processing' : 'blue'} style={{ marginInlineEnd: 0 }}>
                  {getIssueAppVersionLabel(issue)}
                </Tag>
                <Text type="secondary">最近 {formatIssueTime(issue.lastSeen)}</Text>
                <Tooltip title={getIssueActionTooltip(symbolicationStatus)}>
                  <Button
                    size="small"
                    icon={<FileSearchOutlined />}
                    loading={symbolicatingIssueId === issue.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleIssueAction(issue, symbolicationStatus);
                    }}
                  >
                    {getIssueActionLabel(symbolicationStatus)}
                  </Button>
                </Tooltip>
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  loading={downloadingIssueId === issue.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleDownloadOriginalCrash(issue);
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

  const sentryDetailURL = sentryDetailIssue ? toSentryProxyIssueURL(sentryDetailIssue, governanceConfig) : '';
  const sentryDetailTitle = sentryDetailIssue
    ? `${sentryDetailIssue.shortId || sentryDetailIssue.id} - ${sentryDetailIssue.title || '原始 Sentry 详情'}`
    : '原始 Sentry 详情';

  return (
    <div>
      <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }} size="middle">
        <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space align="center">
            <BarChartOutlined style={{ color: '#1677ff', fontSize: 22 }} />
            <div>
              <Title level={2} style={{ margin: 0 }}>Sentry 服务</Title>
              <Text type="secondary">查看 NN iOS 项目的线上崩溃与事件。</Text>
            </div>
          </Space>
          <Space>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              onClick={activeView === 'overview' ? syncGovernanceDashboard : handleRefresh}
              loading={activeView === 'overview' ? governanceSyncing : issueLoading}
            >
              {activeView === 'overview' ? '同步' : '刷新'}
            </Button>
          </Space>
        </Space>
        <Segmented<SentryView>
          value={activeView}
          onChange={handleViewChange}
          options={[
            { label: '总览', value: 'overview', icon: <DashboardOutlined /> },
            { label: '治理列表', value: 'governance-list', icon: <OrderedListOutlined /> },
            { label: '最近问题', value: 'recent', icon: <OrderedListOutlined /> },
            { label: '用户/设备查询', value: 'lookup', icon: <SearchOutlined /> },
            { label: '原始 Sentry', value: 'raw-sentry', icon: <FileSearchOutlined /> },
          ]}
          style={{ maxWidth: '100%' }}
        />
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
        renderGovernanceDashboard()
      ) : activeView === 'governance-list' ? (
        renderGovernanceList()
      ) : activeView === 'governance-events' ? (
        renderGovernanceEventList()
      ) : activeView === 'raw-sentry' ? (
        <Card styles={{ body: { padding: 0, height: 'calc(100vh - 220px)', minHeight: 560 } }}>
          <iframe
            key={rawSentryFrameKey}
            src={buildOverviewURL(rawSentryFrameKey, governanceConfig)}
            title="当前产品线 Sentry 总览"
            sandbox="allow-same-origin allow-scripts allow-forms allow-downloads"
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
      ) : activeView === 'lookup' ? (
        <Card
          title={
            <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
              <Space>
                <span>用户/设备崩溃查询</span>
                <Tag>最近 7 天</Tag>
              </Space>
              {lookupQuery && <Text type="secondary">{lookupQuery}</Text>}
            </Space>
          }
        >
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Space wrap>
              <Segmented
                value={lookupType}
                onChange={(value) => setLookupType(value as SentryLookupType)}
                options={[
                  { label: 'UID', value: 'uid' },
                  { label: 'DeviceID', value: 'deviceId' },
                ]}
              />
              <Search
                allowClear
                enterButton="查询"
                placeholder={lookupType === 'uid' ? '输入 uid，例如 208194080' : '输入 deviceid，例如 58DBC2ED-C9B4-4E89-9F98...'}
                value={lookupValue}
                onChange={(event) => setLookupValue(event.target.value)}
                onSearch={handleLookupSearch}
                loading={issueLoading}
                style={{ width: 460, maxWidth: '100%' }}
              />
            </Space>
            <Spin spinning={issueLoading} tip="正在查询 Sentry 崩溃列表...">
              {lookupIssues.length === 0 && !issueLoading ? (
                <Alert
                  type="info"
                  message={lookupQuery ? '未查询到匹配崩溃' : '请输入 UID 或 DeviceID 查询崩溃列表'}
                  showIcon
                />
              ) : (
                <List
                  dataSource={lookupIssues}
                  renderItem={renderIssueCard}
                />
              )}
            </Spin>
          </Space>
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
        title={`Crash 治理详情 - ${governanceDetail?.record.shortId || governanceDetail?.record.sourceIssueId || ''}`}
        open={governanceDetailOpen}
        onCancel={() => setGovernanceDetailOpen(false)}
        width={980}
        footer={[
          governanceDetail?.record ? (
            <Button
              key="coverage"
              loading={governanceCoverageRefreshingId === governanceDetail.record.id}
              disabled={!governanceDetail.record.appVersion}
              onClick={() => refreshGovernanceCoverage(governanceDetail.record)}
            >
              重查dSYM
            </Button>
          ) : null,
          governanceDetail?.record.historyId ? (
            <Button
              key="history"
              icon={<FileSearchOutlined />}
              onClick={() => {
                const record = governanceDetail.record;
                handleOpenStoredDetail({
                  id: record.sourceIssueId,
                  shortId: record.shortId,
                  title: record.title,
                  permalink: record.permalink,
                }, record.historyId!);
              }}
            >
              打开符号详情
            </Button>
          ) : null,
          governanceDetail?.record && governanceDetail.record.governanceStatus !== 'pending_fix' && governanceDetail.record.governanceStatus !== 'fixed' && governanceDetail.record.governanceStatus !== 'ignored' ? (
            <Button
              key="pending_fix"
              loading={governanceUpdatingId === governanceDetail.record.id}
              onClick={() => promptGovernanceStatus(governanceDetail.record, 'pending_fix')}
            >
              标记待修复
            </Button>
          ) : null,
          governanceDetail?.record && governanceDetail.record.governanceStatus !== 'fixed' && governanceDetail.record.governanceStatus !== 'ignored' ? (
            <Button
              key="fixed"
              loading={governanceUpdatingId === governanceDetail.record.id}
              onClick={() => promptGovernanceStatus(governanceDetail.record, 'fixed')}
            >
              标记已修复
            </Button>
          ) : null,
          governanceDetail?.record && governanceDetail.record.governanceStatus !== 'ignored' ? (
            <Button
              key="ignored"
              loading={governanceUpdatingId === governanceDetail.record.id}
              onClick={() => promptGovernanceStatus(governanceDetail.record, 'ignored')}
            >
              忽略
            </Button>
          ) : null,
          <Button key="close" type="primary" onClick={() => setGovernanceDetailOpen(false)}>
            关闭
          </Button>,
        ].filter(Boolean)}
      >
        <Spin spinning={governanceDetailLoading} tip="正在加载 Crash 治理详情...">
          {governanceDetail?.record ? (
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label="来源">
                  {governanceDetail.record.source === 'sentry' ? '线上 Sentry' : governanceDetail.record.source === 'quality' ? '质检证据' : '手动解析'}
                </Descriptions.Item>
                <Descriptions.Item label="治理状态">
                  <Tag color={getGovernanceStatusMeta(governanceDetail.record.governanceStatus).color}>
                    {getGovernanceStatusMeta(governanceDetail.record.governanceStatus).label}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="版本">{governanceDetail.record.appVersion || '-'}</Descriptions.Item>
                <Descriptions.Item label="等级">{governanceDetail.record.level || '-'}</Descriptions.Item>
                <Descriptions.Item label="事件 / 用户">
                  {governanceDetail.record.eventCount || 0} / {governanceDetail.record.userCount || 0}
                </Descriptions.Item>
                <Descriptions.Item label="最近发生">{formatIssueTime(governanceDetail.record.lastSeen)}</Descriptions.Item>
                <Descriptions.Item label="负责人">{governanceDetail.record.owner || '-'}</Descriptions.Item>
                <Descriptions.Item label="修复版本">{governanceDetail.record.fixedVersion || '-'}</Descriptions.Item>
                <Descriptions.Item label="修复备注" span={2}>{governanceDetail.record.fixedRemark || '-'}</Descriptions.Item>
                <Descriptions.Item label="忽略原因" span={2}>{governanceDetail.record.ignoreReason || '-'}</Descriptions.Item>
              </Descriptions>

              {renderGovernanceLatestEvent()}

              <Card size="small" title="崩溃定位">
                <Space direction="vertical" style={{ width: '100%' }} size={6}>
                  <Paragraph style={{ marginBottom: 0 }}>{governanceDetail.record.title}</Paragraph>
                  <Space wrap size={12}>
                    {governanceDetail.record.culprit && <Text type="secondary">Culprit：{governanceDetail.record.culprit}</Text>}
                    {governanceDetail.record.crashType && <Text type="secondary">类型：{governanceDetail.record.crashType}</Text>}
                    {governanceDetail.record.crashModule && <Text type="secondary">模块：{governanceDetail.record.crashModule}</Text>}
                    {governanceDetail.record.crashLocation && <Text type="secondary">位置：{governanceDetail.record.crashLocation}</Text>}
                  </Space>
                </Space>
              </Card>

              {(governanceDetail.fingerprintGroup?.issueCount || 0) > 1 && (
                <Card
                  size="small"
                  title="同类 Crash"
                  extra={
                    <Space wrap>
                      <Text type="secondary">Issue {governanceDetail.fingerprintGroup!.issueCount}</Text>
                      <Text type="secondary">事件 {governanceDetail.fingerprintGroup!.eventCount}</Text>
                      <Text type="secondary">用户 {governanceDetail.fingerprintGroup!.userCount}</Text>
                      <Button
                        size="small"
                        loading={governanceUpdatingId === governanceDetail.record.id}
                        onClick={() => promptFingerprintGovernanceStatus(governanceDetail.record, 'pending_fix')}
                      >
                        批量待修复
                      </Button>
                      <Button
                        size="small"
                        loading={governanceUpdatingId === governanceDetail.record.id}
                        onClick={() => promptFingerprintGovernanceStatus(governanceDetail.record, 'fixed')}
                      >
                        批量已修复
                      </Button>
                      <Button
                        size="small"
                        loading={governanceUpdatingId === governanceDetail.record.id}
                        onClick={() => promptFingerprintGovernanceStatus(governanceDetail.record, 'ignored')}
                      >
                        批量忽略
                      </Button>
                    </Space>
                  }
                >
                  <Space direction="vertical" style={{ width: '100%' }} size={8}>
                    <Space wrap>
                      <Text type="secondary">覆盖版本：</Text>
                      {governanceDetail.fingerprintGroup!.versions.length ? (
                        governanceDetail.fingerprintGroup!.versions.map((version) => <Tag key={version}>{version}</Tag>)
                      ) : (
                        <Text type="secondary">-</Text>
                      )}
                      <Text type="secondary">最近 {formatIssueTime(governanceDetail.fingerprintGroup!.lastSeen)}</Text>
                    </Space>
                    <List
                      size="small"
                      dataSource={governanceDetail.fingerprintGroup!.records}
                      renderItem={(item) => (
                        <List.Item>
                          <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
                            <Space wrap>
                              <Button
                                type="link"
                                size="small"
                                style={{ padding: 0, height: 'auto' }}
                                onClick={() => openGovernanceDetail(item)}
                              >
                                {item.shortId || item.sourceIssueId}
                              </Button>
                              <Tag color={getGovernanceStatusMeta(item.governanceStatus).color}>
                                {getGovernanceStatusMeta(item.governanceStatus).label}
                              </Tag>
                              {item.appVersion && <Tag color="blue">版本 {item.appVersion}</Tag>}
                              {item.level && <Tag color={getSeverityColor(item.level)}>{item.level}</Tag>}
                              <Text type="secondary">事件 {item.eventCount || 0}</Text>
                              <Text type="secondary">用户 {item.userCount || 0}</Text>
                            </Space>
                            <Text type="secondary">最近 {formatIssueTime(item.lastSeen)}</Text>
                          </Space>
                        </List.Item>
                      )}
                    />
                  </Space>
                </Card>
              )}

              <Card size="small" title="符号化与分析状态">
                <Space direction="vertical" style={{ width: '100%' }} size={8}>
                  <Space wrap>
                    <Tag color={getSymbolicationMeta(governanceDetail.record.symbolicationStatus).color}>
                      {getSymbolicationMeta(governanceDetail.record.symbolicationStatus).label}
                    </Tag>
                    {getSymbolicationFailureCategoryMeta(governanceDetail.record.symbolicationFailureCategory) && (
                      <Tag color={getSymbolicationFailureCategoryMeta(governanceDetail.record.symbolicationFailureCategory)!.color}>
                        {getSymbolicationFailureCategoryMeta(governanceDetail.record.symbolicationFailureCategory)!.label}
                      </Tag>
                    )}
                    <Tag color={getAnalysisMeta(governanceDetail.record.analysisStatus).color}>
                      {getAnalysisMeta(governanceDetail.record.analysisStatus).label}
                    </Tag>
                    <Tag color={getCoverageMeta(governanceDetail.record.dsymCoverageStatus).color}>
                      {getCoverageMeta(governanceDetail.record.dsymCoverageStatus).label}
                    </Tag>
                    {governanceDetail.record.historyId && <Tag>历史 #{governanceDetail.record.historyId}</Tag>}
                  </Space>
                  {governanceDetail.record.symbolicationError && <Alert type="error" showIcon message="符号化失败原因" description={governanceDetail.record.symbolicationError} />}
                  {governanceDetail.record.analysisError && <Alert type="error" showIcon message="AI 分析失败原因" description={governanceDetail.record.analysisError} />}
                  {governanceDetail.record.lastSyncError && <Alert type="warning" showIcon message="同步失败原因" description={governanceDetail.record.lastSyncError} />}
                  {governanceDetail.record.dsymCoverage && (
                    <Text type="secondary">
                      dSYM 覆盖：有效 {governanceDetail.record.dsymCoverage.valid}/{governanceDetail.record.dsymCoverage.total}，
                      主包{governanceDetail.record.dsymCoverage.mainAppReady ? '已就绪' : '缺失'}，
                      组件{governanceDetail.record.dsymCoverage.relatedReady ? '已就绪' : '待补齐'}
                    </Text>
                  )}
                </Space>
              </Card>

              {governanceDetail.history?.aiAnalysis && (
                <Card size="small" title="AI 分析结论">
                  <AIAnalysisPanel analysis={governanceDetail.history.aiAnalysis} loading={false} />
                </Card>
              )}

              {renderGovernanceEvents()}
            </Space>
          ) : (
            <Alert type="info" message="暂无 Crash 治理详情" showIcon />
          )}
        </Spin>
      </Modal>

      <Modal
        title={`原始 Sentry 详情 - ${sentryDetailIssue?.shortId || sentryDetailIssue?.id || ''}`}
        open={sentryDetailModalOpen}
        onCancel={() => setSentryDetailModalOpen(false)}
        width="92vw"
        style={{ top: 24 }}
        styles={{ body: { padding: 0, height: 'calc(100vh - 150px)', minHeight: 560 } }}
        footer={[
          <Button key="close" type="primary" onClick={() => setSentryDetailModalOpen(false)}>
            关闭
          </Button>,
        ]}
      >
        {sentryDetailURL && (
          <iframe
            key={`${sentryDetailFrameKey}-${sentryDetailURL}`}
            src={sentryDetailURL}
            title={sentryDetailTitle}
            sandbox="allow-same-origin allow-scripts allow-forms allow-downloads"
            style={{
              width: '100%',
              height: '100%',
              border: 0,
              display: 'block',
            }}
          />
        )}
      </Modal>

      <Modal
        title={`符号化结果 - ${analysisTitle}`}
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
          <Button key="original" disabled={!analysisResult && !analysisOriginalLog} onClick={handleDownloadModalOriginalCrash}>
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
        <Spin spinning={Boolean(symbolicatingIssueId) && !analysisResult && !analysisError} tip="正在符号化并保存历史记录...">
          {analysisError ? (
            <Tabs
              defaultActiveKey="error"
              items={[
                {
                  key: 'error',
                  label: '错误信息',
                  children: (
                    <Alert
                      type="error"
                      message={analysisError.includes('缺少可符号化信息') ? '原始信息不全' : '符号化失败'}
                      description={
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {analysisError}
                        </pre>
                      }
                      showIcon
                    />
                  ),
                },
                {
                  key: 'original',
                  label: '原始崩溃',
                  children: (
                    <Spin spinning={analysisOriginalLoading} tip="正在获取原始崩溃...">
                      <TextArea
                        value={analysisOriginalLog}
                        placeholder="正在获取原始崩溃..."
                        readOnly
                        rows={20}
                        style={{ fontFamily: 'monospace', fontSize: 12 }}
                      />
                    </Spin>
                  ),
                },
              ]}
            />
          ) : analysisResult ? (
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <Alert
                type={analysisResult.aiError ? 'warning' : 'success'}
                showIcon
                message={
                  <Space wrap>
                    <span>已按 APP 版本 {analysisResult.appVersion} 符号化入库</span>
                    <Text type="secondary">历史记录 #{analysisResult.historyId || '-'}</Text>
                    <Text type="secondary">UUID {analysisResult.matchedUUIDs.length} 个</Text>
                  </Space>
                }
                description={analysisResult.warning || '已自动发起 AI 分析，分析完成后会在 AI 分析页展示。'}
              />
              <Tabs
                defaultActiveKey="symbolicated"
                items={[
                  {
                    key: 'analysis',
                    label: (
                      <Space>
                        <RobotOutlined />
                        AI 分析
                      </Space>
                    ),
                    children: analysisResult.aiAnalysis ? (
                      <AIAnalysisPanel analysis={analysisResult.aiAnalysis} loading={analysisAnalyzing} />
                    ) : (
                      <Card size="small">
                        {analysisAnalyzing ? (
                          <AIAnalysisPanel analysis={null} loading />
                        ) : analysisAiError ? (
                          <Alert
                            type="error"
                            showIcon
                            message="AI 分析失败"
                            description={analysisAiError}
                          />
                        ) : (
                          <Alert
                            type="info"
                            showIcon
                            message="暂无 AI 分析结果"
                            description="系统会在打开详情后自动发起 AI 分析。"
                          />
                        )}
                      </Card>
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
              message="正在符号化 Sentry 问题"
              description="会自动使用当前列表中的最高 APP 版本匹配主应用和组件库 dSYM，只保存符号化历史记录，不自动调用 AI。"
            />
          )}
        </Spin>
      </Modal>
    </div>
  );
}
