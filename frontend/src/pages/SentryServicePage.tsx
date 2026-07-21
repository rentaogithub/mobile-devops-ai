import { Alert, Button, Card, Input, List, Modal, Segmented, Space, Spin, Tabs, Tag, Tooltip, Typography, message } from 'antd';
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
  TrophyOutlined,
} from '@ant-design/icons';
import { useCallback, useRef, useState } from 'react';
import { historyApi, sentryAnalysisApi } from '../services/api';
import { SentryIssueSummary, SentrySymbolicateAnalyzeResult } from '../types';
import { downloadTextFile } from '../utils/helpers';
import { shareToWeChatWork } from '../utils/wechatShare';
import AIAnalysisPanel from '../components/AIAnalysisPanel';

const { Title, Text, Paragraph } = Typography;
const { TextArea, Search } = Input;

const SENTRY_SERVICE_URL = '/sentry-service';
const SENTRY_OVERVIEW_PATH = '/organizations/sentry/projects/nn-ios/';
const DEFAULT_ISSUE_QUERY = 'is:unresolved !release:"10.0.0"';
const TOP_PERIOD = '7d';
const RECENT_PERIOD = '24h';
const RECENT_NEW_WINDOW_MS = 24 * 60 * 60 * 1000;
const EXCLUDED_SENTRY_APP_VERSIONS = new Set(['10.0.0']);
const SENTRY_SYMBOLICATION_HISTORY_CACHE_KEY = 'nn-sentry-symbolication-history-v1';

type CurrentSentryIssue = Pick<SentryIssueSummary, 'id' | 'title' | 'permalink'>;
type SentryView = 'overview' | 'top' | 'recent' | 'lookup';
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
type SentrySymbolicationHistoryCache = Record<string, {
  historyId: number;
  updatedAt: number;
}>;

function getIssueCacheKeys(issue: Pick<SentryIssueSummary, 'id' | 'shortId'>) {
  return [issue.id, issue.shortId]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function readSentrySymbolicationCache(): SentrySymbolicationHistoryCache {
  try {
    return JSON.parse(window.localStorage.getItem(SENTRY_SYMBOLICATION_HISTORY_CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeSentrySymbolicationCache(cache: SentrySymbolicationHistoryCache) {
  window.localStorage.setItem(SENTRY_SYMBOLICATION_HISTORY_CACHE_KEY, JSON.stringify(cache));
}

function cacheSentryHistoryId(issue: Pick<SentryIssueSummary, 'id' | 'shortId'>, historyId?: number) {
  if (!historyId) {
    return;
  }

  const cache = readSentrySymbolicationCache();
  getIssueCacheKeys(issue).forEach((key) => {
    cache[key] = { historyId, updatedAt: Date.now() };
  });
  writeSentrySymbolicationCache(cache);
}

function removeCachedSentryHistoryId(issue: Pick<SentryIssueSummary, 'id' | 'shortId'>) {
  const cache = readSentrySymbolicationCache();
  getIssueCacheKeys(issue).forEach((key) => {
    delete cache[key];
  });
  writeSentrySymbolicationCache(cache);
}

function getInitialIssueId() {
  return new URLSearchParams(window.location.search).get('issue') || '';
}

function toLocalIssueURL(issue?: Pick<SentryIssueSummary, 'id' | 'shortId'>) {
  const issueId = issue?.id || issue?.shortId;
  return issueId ? `${SENTRY_SERVICE_URL}?issue=${encodeURIComponent(issueId)}` : SENTRY_SERVICE_URL;
}

function toSentryProxyIssueURL(issue: Pick<SentryIssueSummary, 'id' | 'permalink'>) {
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

  return `/organizations/sentry/issues/${encodeURIComponent(issue.id)}/?project=6&query=&referrer=project-issue-stream`;
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

function getIssueHighestAppVersion(issue: SentryIssueSummary) {
  return [issue.maxAppVersion, ...(issue.appVersions || [])]
    .filter((version): version is string =>
      typeof version === 'string' && version.length > 0 && !EXCLUDED_SENTRY_APP_VERSIONS.has(version)
    )
    .sort(compareVersions)
    .pop() || issue.minAppVersion;
}

function hasIssueVersionInfo(issue: SentryIssueSummary) {
  return Boolean(getIssueHighestAppVersion(issue) || issue.appVersionRange);
}

function isExcludedAppVersionOnlyIssue(issue: SentryIssueSummary) {
  if (issue.excludedAppVersionOnly) {
    return true;
  }

  const versions = [issue.minAppVersion, issue.maxAppVersion, ...(issue.appVersions || [])]
    .filter((version): version is string => typeof version === 'string' && version.length > 0);
  return versions.length > 0 && versions.every((version) => EXCLUDED_SENTRY_APP_VERSIONS.has(version));
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

function buildOverviewURL(version: number) {
  const params = new URLSearchParams({
    project: '6',
    statsPeriod: '14d',
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
  const [overviewFrameKey, setOverviewFrameKey] = useState(0);
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

  const symbolicateIssueInBackground = useCallback(async (issue: SentryIssueSummary) => {
    if (!issue.id || backgroundSymbolicatedIssueIds.current.has(issue.id)) {
      return;
    }

    if (!hasIssueVersionInfo(issue)) {
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

      cacheSentryHistoryId(issue, response.data.historyId);
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
  }, []);

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
            .filter((currentIssue) => !isExcludedAppVersionOnlyIssue(currentIssue)));
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
  }, [symbolicateIssueInBackground, updateIssuesForView]);

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
          cacheSentryHistoryId(issue, historyId);
          storedStatusMap[issue.id] = {
            status: 'success',
            historyId,
          };
        }
        if (status?.appVersion && !hasIssueVersionInfo(issue)) {
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
  }, [enrichIssueVersionsInBackground, symbolicateIssuesInBackground, updateIssuesForView]);

  const loadIssues = useCallback(async (
    period: string,
    options: { query?: string; view?: SentryView } = {}
  ) => {
    setIssueLoading(true);
    setFetchError('');
    const query = options.query || DEFAULT_ISSUE_QUERY;
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
        .filter((issue) => !isExcludedAppVersionOnlyIssue(issue))
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
  }, [hydrateIssueMetadataInBackground]);

  const updateCurrentIssue = (issue: CurrentSentryIssue | null) => {
    setCurrentIssue(issue?.id ? issue : null);
    setFetchError('');
  };

  const handleOpenIssue = (issue: SentryIssueSummary) => {
    updateCurrentIssue({
      id: issue.id,
      title: issue.title || issue.shortId || issue.id,
      permalink: toSentryProxyIssueURL(issue),
    });
    setSentryDetailIssue(issue);
    setSentryDetailFrameKey((key) => key + 1);
    setSentryDetailModalOpen(true);
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

  const handleShowLookup = () => {
    setActiveView('lookup');
    setFetchError('');
  };

  const handleRefresh = () => {
    if (activeView === 'overview') {
      setOverviewFrameKey((value) => value + 1);
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
    return `${DEFAULT_ISSUE_QUERY} ${type}:"${escaped}"`;
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
      cacheSentryHistoryId(issue, response.data.historyId);
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
      removeCachedSentryHistoryId(issue);
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
        maxAppVersion: getIssueHighestAppVersion(issue),
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

  const sentryDetailURL = sentryDetailIssue ? toSentryProxyIssueURL(sentryDetailIssue) : '';
  const sentryDetailTitle = sentryDetailIssue
    ? `${sentryDetailIssue.shortId || sentryDetailIssue.id} - ${sentryDetailIssue.title || '原始 Sentry 详情'}`
    : '原始 Sentry 详情';

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
          <Button
            type={activeView === 'lookup' ? 'primary' : 'default'}
            icon={<SearchOutlined />}
            onClick={handleShowLookup}
          >
            用户/设备查询
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
