import axios from 'axios';
import {
  DSYMInfo,
  SymbolicationResult,
  ApiResponse,
  CrashAnalysis,
  SentryFetchAnalyzeResult,
  SentryIssueListResult,
  SentryAnalyzeSelectedResult,
  SentryAggregateAnalyzeResult,
  SentrySymbolicateLogResult,
  SentryOriginalCrashResult,
  SentrySymbolicateAnalyzeResult,
  SentryIssueSummary,
  HistoryRecord,
} from '../types';
import { authUtils } from '../utils/auth';

const api = axios.create({
  baseURL: '/api',
  timeout: 60000, // 60 秒超时
  headers: {
    'Content-Type': 'application/json',
  },
});

const EXCLUDED_SENTRY_APP_VERSIONS = new Set(['10.0.0']);

// 请求拦截器
api.interceptors.request.use(
  (config) => {
    // 添加认证令牌
    const token = authUtils.getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// 响应拦截器
api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    if (error.response) {
      // 处理 401 未授权错误
      if (error.response.status === 401) {
        authUtils.clearToken();
        window.location.reload(); // 重新加载页面，触发登录
      }
      // 服务器返回错误
      return Promise.reject(error.response.data);
    } else if (error.request) {
      // 请求发送但没有收到响应
      return Promise.reject({ error: '网络错误，请检查连接' });
    } else {
      // 其他错误
      return Promise.reject({ error: error.message });
    }
  }
);

export const dsymApi = {
  /**
   * 上传 dSYM 文件
   */
  upload: async (file: File): Promise<ApiResponse<DSYMInfo>> => {
    const formData = new FormData();
    formData.append('file', file, file.name);

    const response = await api.post<ApiResponse<DSYMInfo>>('/dsym/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      timeout: 600000, // 10 分钟超时，用于大文件上传
    });

    return response.data;
  },

  /**
   * 从服务器本机 xcarchive 自动上传主工程 dSYM
   */
  uploadFromXcarchive: async (xcarchivePath: string): Promise<ApiResponse<DSYMInfo>> => {
    const response = await api.post<ApiResponse<DSYMInfo>>('/dsym/upload-from-xcarchive', { xcarchivePath }, {
      timeout: 600000,
    });
    return response.data;
  },

  /**
   * 获取 dSYM 列表
   */
  list: async (): Promise<ApiResponse<DSYMInfo[]>> => {
    const response = await api.get<ApiResponse<DSYMInfo[]>>('/dsym/list');
    return response.data;
  },

  /**
   * 更新 dSYM 信息
   */
  update: async (uuid: string, data: { version?: string; notes?: string; relatedAppVersions?: string[] }): Promise<ApiResponse> => {
    const response = await api.put<ApiResponse>(`/dsym/${uuid}`, data);
    return response.data;
  },

  /**
   * 删除 dSYM
   */
  delete: async (uuid: string): Promise<ApiResponse> => {
    const response = await api.delete<ApiResponse>(`/dsym/${uuid}`);
    return response.data;
  },

  /**
   * 下载 dSYM 文件
   */
  download: (uuid: string, appName: string, version: string): void => {
    const token = authUtils.getToken();
    const url = `/api/dsym/${uuid}/download`;
    
    // 创建一个隐藏的 a 标签来触发下载
    const link = document.createElement('a');
    link.href = url;
    link.download = `${appName}_${version}_${uuid.substring(0, 8)}.dSYM.zip`;
    
    // 如果有认证令牌，需要通过 fetch 下载
    if (token) {
      fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
        .then(response => response.blob())
        .then(blob => {
          const blobUrl = window.URL.createObjectURL(blob);
          link.href = blobUrl;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          window.URL.revokeObjectURL(blobUrl);
        })
        .catch(error => {
          console.error('下载失败', error);
        });
    } else {
      // 没有认证令牌，直接下载
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  },
};

export interface WatermarkCandidate {
  anchor: string;
  env: string;
  uid: string;
  score: number;
  repaired: boolean;
  scale: number;
  safeTop: number;
  start: {
    x: number;
    y: number;
  };
  enhancement: string;
  payloadHex: string;
}

export interface WatermarkImageTimeInfo {
  time?: string;
  timestamp?: number;
  source: 'exif' | 'pngText' | 'none';
  field?: string;
  reliable: boolean;
}

export interface WatermarkDecodeResult {
  success: boolean;
  deep: boolean;
  candidates: WatermarkCandidate[];
  bestCandidate?: WatermarkCandidate;
  imageTime: WatermarkImageTimeInfo;
  rawOutput: string;
}

export const watermarkApi = {
  /**
   * 上传截图并解析点阵水印
   */
  decode: async (file: File, deep = true): Promise<ApiResponse<WatermarkDecodeResult>> => {
    const formData = new FormData();
    formData.append('file', file, file.name);
    formData.append('deep', String(deep));

    const response = await api.post<ApiResponse<WatermarkDecodeResult>>('/watermark/decode', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      timeout: 120000,
    });

    return response.data;
  },
};

export interface OpUserInfo {
  id?: string;
  userId?: string | number;
  nickName?: string;
  telNum?: string;
  email?: string;
  nnNumber?: string;
  userType_dictText?: string;
  status_dictText?: string;
  registerCanal?: string;
  updateBy?: string;
  updaeTime?: string;
  createTime?: string;
}

export interface OpUserListResult {
  records: OpUserInfo[];
  total: number;
  pageNo: number;
  pageSize: number;
}

export interface UserQueryRecord extends OpUserInfo {
  recordKey: string;
  remark?: string;
  searchKey?: string;
  lastQueryAt: string;
}

export interface OpFeedbackLogInfo {
  id?: string;
  userId?: string | number;
  type?: string | number;
  reqChannel_dictText?: string;
  showVersion?: string;
  version?: string;
  crashLogUrl?: string;
  crashTime?: string;
  createTime?: string;
}

export interface FeedbackLogPreviewFile {
  name: string;
  path: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
  createdAtMs: number;
  modifiedAtMs: number;
}

export interface FeedbackLogPreviewResult {
  tempDir: string;
  files: FeedbackLogPreviewFile[];
}

export interface FeedbackLogLine {
  id: string;
  time: string;
  content: string;
}

export interface FeedbackLogFileContent {
  path: string;
  rows: FeedbackLogLine[];
}

const parseStoredOpToken = (raw: string | null): string => {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed?.value === 'string') {
      if (parsed.expire && Number(parsed.expire) <= Date.now()) return '';
      return parsed.value;
    }
    if (typeof parsed?.content === 'string') return parsed.content;
    if (typeof parsed?.token === 'string') return parsed.token;
  } catch {
    return raw;
  }
  return '';
};

const getCurrentOpAccessToken = (): string => {
  const tokenKeys = [
    'Access-Token',
    'access-token',
    'x-access-token',
    'X-Access-Token',
    'OP_TOKEN',
    'pro__Access-Token',
    'pro__access-token',
    'pro__x-access-token',
  ];

  for (const key of tokenKeys) {
    const token = parseStoredOpToken(localStorage.getItem(key) || sessionStorage.getItem(key));
    if (token && token.length >= 16) return token;
  }

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !/(^|__)access[-_]?token$/i.test(key)) continue;
    const token = parseStoredOpToken(localStorage.getItem(key));
    if (token && token.length >= 16) return token;
  }

  return '';
};

const syncCurrentOpAccessToken = async (): Promise<string> => {
  const token = getCurrentOpAccessToken();
  if (!token) return '';
  await axios.post('/api/op-auth/sync', { token }, { timeout: 10000 }).catch(() => {});
  return token;
};

const toOpErrorMessage = (error: any, fallback: string): string => {
  const payload = error?.response?.data || error;
  if (typeof payload === 'string') {
    return payload || fallback;
  }
  return payload?.message || payload?.error || error?.message || fallback;
};

export const opUserApi = {
  list: async (searchkey: string, pageNo = 1, pageSize = 10): Promise<OpUserListResult> => {
    await syncCurrentOpAccessToken();
    const response = await axios.get('/jeecg-boot/user/tUser/list', {
      params: {
        _t: Math.floor(Date.now() / 1000),
        searchkey,
        column: 'createTime',
        order: 'desc',
        field: 'id,,action,userId,nickName,telNum,email,nnNumber,userType_dictText,status_dictText,registerCanal,updateBy,updaeTime,createTime',
        pageNo,
        pageSize,
      },
      timeout: 60000,
    });

    const payload = response.data;
    if (
      payload &&
      (payload.success === false || (payload.code !== undefined && ![0, 200].includes(Number(payload.code))))
    ) {
      throw new Error(payload.message || payload.error || '查询用户信息失败');
    }

    const result = payload?.result || payload?.data || payload;
    const records = Array.isArray(result?.records)
      ? result.records
      : Array.isArray(result)
        ? result
        : [];

    return {
      records,
      total: Number(result?.total ?? records.length),
      pageNo: Number(result?.current ?? result?.pageNo ?? pageNo),
      pageSize: Number(result?.size ?? result?.pageSize ?? pageSize),
    };
  },
  feedbackLogs: async (uid: string | number, pageNo = 1, pageSize = 10): Promise<OpUserListResult & { records: OpFeedbackLogInfo[] }> => {
    await syncCurrentOpAccessToken();
    let response;
    try {
      response = await axios.get('/jeecg-boot/crash_log/list', {
        params: {
          _t: Math.floor(Date.now() / 1000),
          type: 36,
          query: uid,
          reqChannel: 1,
          column: 'createTime',
          order: 'desc',
          field: 'id,,action,userId,type,reqChannel_dictText,version,crashLogUrl,crashTime,createTime',
          pageNo,
          pageSize,
          queryParam: '',
          page: pageNo - 1,
        },
        timeout: 60000,
      });
    } catch (error: any) {
      throw new Error(toOpErrorMessage(error, '查询反馈日志失败'));
    }

    const payload = response.data;
    if (
      payload &&
      (payload.success === false || (payload.code !== undefined && ![0, 200].includes(Number(payload.code))))
    ) {
      throw new Error(payload.message || payload.error || '查询反馈日志失败');
    }

    const result = payload?.result || payload?.data || payload;
    const records = Array.isArray(result?.records)
      ? result.records
      : Array.isArray(result)
        ? result
        : [];

    return {
      records,
      total: Number(result?.total ?? records.length),
      pageNo: Number(result?.current ?? result?.pageNo ?? pageNo),
      pageSize: Number(result?.size ?? result?.pageSize ?? pageSize),
    };
  },
  downloadFeedbackLog: async (record: OpFeedbackLogInfo): Promise<void> => {
    let fileURL = record.crashLogUrl || '';
    if (!fileURL) {
      throw new Error('当前记录缺少日志下载地址');
    }

    if (fileURL.includes(',')) {
      fileURL = fileURL.substring(0, fileURL.indexOf(','));
    }
    if (fileURL.startsWith('/')) {
      fileURL = fileURL.startsWith('/op/') ? fileURL : `/op${fileURL}`;
    }

    const link = document.createElement('a');
    link.href = fileURL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.download = `feedback-log-${record.userId || record.id || Date.now()}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  },
};

export const feedbackLogApi = {
  preview: async (record: OpFeedbackLogInfo): Promise<FeedbackLogPreviewResult> => {
    if (!record.crashLogUrl) {
      throw new Error('当前记录缺少日志下载地址');
    }

    const response = await api.post<ApiResponse<FeedbackLogPreviewResult>>('/feedback-log/preview', {
      url: record.crashLogUrl,
    }, {
      timeout: 120000,
    });
    if (!response.data.data) {
      throw new Error(response.data.error || '预览日志失败');
    }
    return response.data.data;
  },
  readFile: async (path: string): Promise<FeedbackLogFileContent> => {
    const response = await api.post<ApiResponse<FeedbackLogFileContent>>('/feedback-log/read', {
      path,
    }, {
      timeout: 120000,
    });
    if (!response.data.data) {
      throw new Error(response.data.error || '读取日志文件失败');
    }
    return response.data.data;
  },
};

export const userQueryRecordApi = {
  list: async (): Promise<UserQueryRecord[]> => {
    const response = await api.get<ApiResponse<UserQueryRecord[]>>('/user-query-records');
    return response.data.data || [];
  },
  upsertBatch: async (records: OpUserInfo[], searchKey: string): Promise<UserQueryRecord[]> => {
    const response = await api.post<ApiResponse<UserQueryRecord[]>>('/user-query-records/batch', {
      records,
      searchKey,
    });
    return response.data.data || [];
  },
  updateRemark: async (recordKey: string, remark: string): Promise<UserQueryRecord[]> => {
    const response = await api.put<ApiResponse<UserQueryRecord[]>>(
      `/user-query-records/${encodeURIComponent(recordKey)}/remark`,
      { remark }
    );
    return response.data.data || [];
  },
  remove: async (recordKey: string): Promise<UserQueryRecord[]> => {
    const response = await api.delete<ApiResponse<UserQueryRecord[]>>(
      `/user-query-records/${encodeURIComponent(recordKey)}`
    );
    return response.data.data || [];
  },
  clear: async (): Promise<UserQueryRecord[]> => {
    const response = await api.delete<ApiResponse<UserQueryRecord[]>>('/user-query-records');
    return response.data.data || [];
  },
};

export const symbolicateApi = {
  /**
   * 符号化崩溃日志
   */
  symbolicate: async (
    crashLog: string,
    uuids?: string[]
  ): Promise<ApiResponse<SymbolicationResult>> => {
    const response = await api.post<ApiResponse<SymbolicationResult>>('/symbolicate', {
      crashLog,
      uuids,
    });
    return response.data;
  },

  /**
   * AI 分析符号化后的崩溃日志
   */
  analyze: async (
    symbolicatedLog: string,
    uuids: string[],
    apiKey?: string
  ): Promise<ApiResponse<CrashAnalysis>> => {
    const response = await api.post<ApiResponse<CrashAnalysis>>('/symbolicate/analyze', {
      symbolicatedLog,
      uuids,
      apiKey,
    });
    return response.data;
  },

  /**
   * 下载符号化报告
   */
  downloadReport: async (
    symbolicatedLog: string,
    analysis: CrashAnalysis | undefined,
    appVersion: string
  ): Promise<void> => {
    const token = authUtils.getToken();
    
    try {
      const response = await fetch('/api/symbolicate/download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          symbolicatedLog,
          analysis,
          appVersion,
        }),
      });

      if (!response.ok) {
        throw new Error('下载失败');
      }

      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `crash_report_${appVersion}_${Date.now()}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error('下载失败', error);
      throw error;
    }
  },

  /**
   * 清除符号化缓存
   */
  clearCache: async (): Promise<ApiResponse> => {
    const response = await api.post<ApiResponse>('/symbolicate/clear-cache');
    return response.data;
  },
};

function compareAppVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number(part) || 0);
  const right = b.split('.').map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return a.localeCompare(b);
}

function extractAppVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  const match =
    trimmed.match(/@([0-9]+(?:\.[0-9]+){1,3})(?:[+._-]|$)/) ||
    trimmed.match(/\b([0-9]+(?:\.[0-9]+){1,3})(?:[+._-]\d+)?\b/);
  return match?.[1];
}

function getContextValues(contexts: unknown): any[] {
  if (Array.isArray(contexts)) {
    return contexts;
  }
  if (contexts && typeof contexts === 'object') {
    return Object.values(contexts);
  }
  return [];
}

function collectAppVersions(source: any): string[] {
  const candidates = [
    source?.maxAppVersion,
    source?.minAppVersion,
    source?.appVersionRange,
    source?.release,
    source?.release?.version,
    source?.release?.shortVersion,
    source?.release?.versionInfo?.version?.raw,
    source?.dist,
    source?.metadata?.release,
    source?.metadata?.dist,
    ...(Array.isArray(source?.tags) ? source.tags.flatMap((tag: any) => {
      const key = String(tag?.key || '').toLowerCase();
      return ['release', 'dist', 'version', 'app.version', 'app_version'].includes(key)
        ? [tag?.value]
        : [];
    }) : []),
    ...getContextValues(source?.contexts).flatMap((context: any) => [
      context?.release,
      context?.dist,
      context?.app_version,
    ]),
  ];

  return candidates
    .map(extractAppVersion)
    .filter((version): version is string => Boolean(version));
}

function buildAppVersionRange(values: string[]) {
  const versions = Array.from(new Set(values.filter((version) =>
    Boolean(version) && !EXCLUDED_SENTRY_APP_VERSIONS.has(version)
  ))).sort(compareAppVersions);
  const min = versions[0];
  const max = versions[versions.length - 1];
  return {
    versions,
    min,
    max,
    range: min && max ? (min === max ? max : `${min} - ${max}`) : undefined,
  };
}

function normalizeSentryIssue(issue: any): SentryIssueSummary {
  const range = buildAppVersionRange(collectAppVersions(issue));
  return {
    id: String(issue.id || ''),
    shortId: issue.shortId || issue.shortID,
    title: issue.title || issue.metadata?.title || issue.type || '未知崩溃',
    culprit: issue.culprit,
    level: issue.level,
    status: issue.status,
    count: String(issue.count ?? issue.numComments ?? ''),
    userCount: typeof issue.userCount === 'number' ? issue.userCount : Number(issue.userCount || 0),
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    permalink: issue.permalink,
    appVersionRange: range.range || issue.appVersionRange,
    minAppVersion: range.min || issue.minAppVersion,
    maxAppVersion: range.max || issue.maxAppVersion,
    appVersions: range.versions.length > 0 ? range.versions : issue.appVersions,
  };
}

async function sentryProxyGet<T>(path: string): Promise<T> {
  const response = await fetch(`/sentry${path}`, {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Sentry API failed: ${response.status} ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

async function enrichSentryIssueVersionRange(issue: SentryIssueSummary): Promise<SentryIssueSummary> {
  const versions = [...(issue.appVersions || [])];
  const eventPath = `/api/0/issues/${encodeURIComponent(issue.id)}/events/?limit=20`;
  const latestPath = `/api/0/issues/${encodeURIComponent(issue.id)}/events/latest/`;
  const timeout = <T>(message: string) =>
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), 8000));

  const [eventsResult, latestResult] = await Promise.allSettled([
    Promise.race([sentryProxyGet<any[]>(eventPath), timeout<any[]>('Sentry events timeout')]),
    Promise.race([sentryProxyGet<any>(latestPath), timeout<any>('Sentry latest event timeout')]),
  ]);

  if (eventsResult.status === 'fulfilled' && Array.isArray(eventsResult.value)) {
    versions.push(...eventsResult.value.flatMap(collectAppVersions));
  }
  if (latestResult.status === 'fulfilled') {
    versions.push(...collectAppVersions(latestResult.value));
  }

  if (versions.length === 0) {
    const releaseQuery = new URLSearchParams({
      query: `${issue.shortId || issue.id} !release:"10.0.0"`,
      field: 'release',
      per_page: '20',
    });
    try {
      const tagValues = await Promise.race([
        sentryProxyGet<any[]>(`/api/0/projects/sentry/nn-ios/tags/release/values/?${releaseQuery.toString()}`),
        timeout<any[]>('Sentry release tag values timeout'),
      ]);
      versions.push(...(Array.isArray(tagValues) ? tagValues.map((item) => item.value || item.name || item.key) : []));
    } catch {
      // tag values 兜底失败也不阻塞列表。
    }
  }

  const range = buildAppVersionRange(versions);
  if (range.versions.length === 0) {
    return issue;
  }

  return {
    ...issue,
    appVersionRange: range.range,
    minAppVersion: range.min,
    maxAppVersion: range.max,
    appVersions: range.versions,
    excludedAppVersionOnly: range.versions.length === 0,
  };
}

async function listSentryIssuesFromProxy(params: {
  period: string;
  limit: number;
  query?: string;
}): Promise<ApiResponse<SentryIssueListResult>> {
  const period = params.period || '24h';
  const limit = Math.min(Math.max(params.limit || 5, 1), 20);
  const query = params.query || 'is:unresolved';
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const search = new URLSearchParams({
    query,
    sort: 'date',
    limit: String(limit),
  });

  if (period === '7d') {
    search.set('start', new Date(sevenDaysAgo).toISOString());
    search.set('end', new Date().toISOString());
  } else {
    search.set('statsPeriod', period);
  }

  const data = await sentryProxyGet<any[] | { results?: any[] }>(
    `/api/0/projects/sentry/nn-ios/issues/?${search.toString()}`
  );
  const rawIssues = Array.isArray(data) ? data : data?.results || [];
  const issues = rawIssues
    .map(normalizeSentryIssue)
    .filter((issue) => {
      if (period !== '7d') {
        return true;
      }
      return (Date.parse(issue.lastSeen || issue.firstSeen || '') || 0) >= sevenDaysAgo;
    });
  return {
    success: true,
    data: {
      period,
      query,
      total: issues.length,
      issues,
    },
  };
}

export const sentryAnalysisApi = {
  listIssues: async (params: {
    period: string;
    limit: number;
    query?: string;
  }): Promise<ApiResponse<SentryIssueListResult>> => {
    try {
      return await listSentryIssuesFromProxy(params);
    } catch (error) {
      const response = await api.post<ApiResponse<SentryIssueListResult>>(
        '/sentry-analysis/issues',
        params,
        { timeout: 60000 }
      );
      return response.data;
    }
  },

  analyzeSelected: async (params: {
    issueIds: string[];
    issues: SentryIssueSummary[];
    apiKey?: string;
  }): Promise<ApiResponse<SentryAnalyzeSelectedResult>> => {
    const response = await api.post<ApiResponse<SentryAnalyzeSelectedResult>>(
      '/sentry-analysis/analyze-selected',
      params,
      { timeout: 180000 }
    );
    return response.data;
  },

  aggregateAnalyze: async (params: {
    issues: SentryIssueSummary[];
    limit?: number;
    apiKey?: string;
  }): Promise<ApiResponse<SentryAggregateAnalyzeResult>> => {
    const response = await api.post<ApiResponse<SentryAggregateAnalyzeResult>>(
      '/sentry-analysis/aggregate-analyze',
      params,
      { timeout: 240000 }
    );
    return response.data;
  },

  buildSymbolicateLog: async (params: {
    issue: SentryIssueSummary;
  }): Promise<ApiResponse<SentrySymbolicateLogResult>> => {
    const response = await api.post<ApiResponse<SentrySymbolicateLogResult>>(
      '/sentry-analysis/symbolicate-log',
      params,
      { timeout: 60000 }
    );
    return response.data;
  },

  buildOriginalCrash: async (params: {
    issue: SentryIssueSummary;
  }): Promise<ApiResponse<SentryOriginalCrashResult>> => {
    const response = await api.post<ApiResponse<SentryOriginalCrashResult>>(
      '/sentry-analysis/original-crash',
      params,
      { timeout: 60000 }
    );
    return response.data;
  },

  symbolicateAndAnalyze: async (params: {
    issue: SentryIssueSummary;
    appVersion?: string;
    apiKey?: string;
  }): Promise<ApiResponse<SentrySymbolicateAnalyzeResult>> => {
    const response = await api.post<ApiResponse<SentrySymbolicateAnalyzeResult>>(
      '/sentry-analysis/symbolicate-and-analyze',
      params,
      { timeout: 240000 }
    );
    return response.data;
  },

  symbolicateAndSave: async (params: {
    issue: SentryIssueSummary;
    appVersion?: string;
  }): Promise<ApiResponse<SentrySymbolicateAnalyzeResult>> => {
    const response = await api.post<ApiResponse<SentrySymbolicateAnalyzeResult>>(
      '/sentry-analysis/symbolicate-and-save',
      params,
      { timeout: 240000 }
    );
    return response.data;
  },

  historyStatus: async (params: {
    issues: SentryIssueSummary[];
  }): Promise<ApiResponse<{ statuses: Record<string, { historyId: number; appVersion?: string }> }>> => {
    const response = await api.post<ApiResponse<{ statuses: Record<string, { historyId: number; appVersion?: string }> }>>(
      '/sentry-analysis/history-status',
      params
    );
    return response.data;
  },

  enrichIssueVersion: enrichSentryIssueVersionRange,

  fetchAndAnalyze: async (params: {
    period: string;
    limit: number;
    query?: string;
    apiKey?: string;
  }): Promise<ApiResponse<SentryFetchAnalyzeResult>> => {
    const response = await api.post<ApiResponse<SentryFetchAnalyzeResult>>(
      '/sentry-analysis/fetch-and-analyze',
      params,
      { timeout: 180000 }
    );
    return response.data;
  },
};

export const historyApi = {
  /**
   * 获取历史记录详情
   */
  detail: async (id: number): Promise<ApiResponse<HistoryRecord>> => {
    const response = await api.get<ApiResponse<HistoryRecord>>(`/history/${id}`);
    return response.data;
  },

  /**
   * 对历史记录进行AI分析
   */
  analyzeHistory: async (
    id: number,
    apiKey: string
  ): Promise<ApiResponse<CrashAnalysis>> => {
    const response = await api.post<ApiResponse<CrashAnalysis>>(`/history/${id}/analyze`, {
      apiKey,
    });
    return response.data;
  },

  /**
   * 下载历史记录报告
   */
  downloadReport: (id: number, appVersion: string): void => {
    const token = authUtils.getToken();
    const url = `/api/history/${id}/download`;
    
    // 创建一个隐藏的 a 标签来触发下载
    const link = document.createElement('a');
    link.href = url;
    link.download = `crash_report_${appVersion}_${Date.now()}.zip`;
    
    // 如果有认证令牌，需要通过 fetch 下载
    if (token) {
      fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
        .then(response => response.blob())
        .then(blob => {
          const blobUrl = window.URL.createObjectURL(blob);
          link.href = blobUrl;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          window.URL.revokeObjectURL(blobUrl);
        })
        .catch(error => {
          console.error('下载失败', error);
        });
    } else {
      // 没有认证令牌，直接下载
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  },

  /**
   * 更新历史记录的修复状态
   */
  updateFixedStatus: async (id: number, isFixed: boolean, fixedVersion?: string): Promise<ApiResponse> => {
    const response = await api.patch<ApiResponse>(`/history/${id}/fixed`, {
      isFixed,
      fixedVersion,
    });
    return response.data;
  },
};

export interface ExternalServicesConfig {
  nnrtcJenkins: {
    baseUrl: string;
    jobName: string;
    jobUrl: string;
  };
  dsymSources: {
    nnRtcArchiveSmbUrl: string;
    screenShareUrl: string;
  };
}

export const moduleApi = {
  /**
   * 获取自定义模块列表
   */
  getModules: async (): Promise<string[]> => {
    const response = await api.get('/config/modules');
    return response.data.modules;
  },

  /**
   * 更新自定义模块列表
   */
  updateModules: async (modules: string[]): Promise<void> => {
    await api.post('/config/modules', { modules });
  },

  /**
   * 获取前端展示用外部服务配置
   */
  getExternalServices: async (): Promise<ApiResponse<ExternalServicesConfig>> => {
    const response = await api.get<ApiResponse<ExternalServicesConfig>>('/config/external-services');
    return response.data;
  },
};

export const wechatApi = {
  /**
   * 检查企业微信配置状态
   */
  checkConfig: async (): Promise<{ configured: boolean }> => {
    const response = await api.get('/wechat/config');
    return response.data;
  },

  /**
   * 分享崩溃报告到企业微信
   */
  share: async (params: {
    historyId: number;
    toUser?: string;
    toParty?: string;
    assignee?: string;
    messageType?: 'card' | 'markdown';
  }): Promise<void> => {
    await api.post('/wechat/share', params);
  },

  /**
   * 测试企业微信消息发送
   */
  test: async (toUser?: string): Promise<void> => {
    await api.post('/wechat/test', { toUser });
  },
};

export interface PodComponent {
  id: number;
  name: string;
  version: string;
  summary: string;
  homepage: string;
  source_zip_url: string;
  podspec_content: string;
  upload_time: string;
  status: 'uploaded' | 'published' | 'failed';
  error_message?: string;
  warning_message?: string;
  package_type?: 'release' | 'test';
  build_id?: string;
  nnios_branch?: string;
}

export interface NNRtcJenkinsBuild {
  number: number;
  result: string;
  branchName: string;
  timestamp?: number;
  url?: string;
  artifactPath: string;
}

export interface NNRtcJenkinsConfig {
  baseUrl: string;
  jobName: string;
  jobUrl: string;
}

export interface NNRtcPodTask {
  id: string;
  type: 'publish' | 'replace';
  status: 'pending' | 'running' | 'success' | 'failed';
  progress: number;
  message: string;
  logs: string[];
  data?: PodComponent;
  warning?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LeigodIMSDKVersion {
  version: string;
  path: string;
  packageName?: string;
  hasFramework: boolean;
  hasDSYM: boolean;
  updatedAt?: string;
}

export const podsApi = {
  /** 发布组件 */
  publish: async (
    file: File,
    params: {
      name: string;
      version: string;
      lib_type?: string;
      lib_name?: string;
      summary?: string;
      homepage?: string;
      authors?: string;
      license?: string;
      platform_version?: string;
      dependencies?: string;
      sys_frameworks?: string;
      sys_libraries?: string;
      target_branch?: string;
      package_type?: 'release' | 'test';
      build_id?: string;
    }
  ): Promise<ApiResponse<PodComponent>> => {
    const formData = new FormData();
    formData.append('file', file, file.name);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== '') {
        formData.append(key, value);
      }
    });
    const response = await api.post<ApiResponse<PodComponent>>('/pods/publish', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000,
    });
    return response.data;
  },

  /** 从 NNRtc Jenkins 构建发布组件 */
  publishNNRtcFromJenkins: async (params: {
    build_number: string;
    version: string;
    target_branch: string;
    package_type?: 'release' | 'test';
    sys_frameworks?: string;
    sys_libraries?: string;
  }): Promise<ApiResponse<PodComponent>> => {
    const response = await api.post<ApiResponse<PodComponent>>('/pods/nnrtc/jenkins/publish', params, {
      timeout: 600000,
    });
    return response.data;
  },

  /** 创建 NNRtc Jenkins 发布任务 */
  startNNRtcPublishTask: async (params: {
    build_number: string;
    version: string;
    target_branch: string;
    package_type?: 'release' | 'test';
    sys_frameworks?: string;
    sys_libraries?: string;
  }): Promise<ApiResponse<NNRtcPodTask>> => {
    const response = await api.post<ApiResponse<NNRtcPodTask>>('/pods/nnrtc/jenkins/publish-task', params, {
      timeout: 60000,
    });
    return response.data;
  },

  /** 获取 NNRtc Jenkins 构建列表 */
  listNNRtcJenkinsBuilds: async (): Promise<ApiResponse<NNRtcJenkinsBuild[]>> => {
    const response = await api.get<ApiResponse<NNRtcJenkinsBuild[]>>('/pods/nnrtc/jenkins/builds', {
      params: { limit: 300 },
      timeout: 60000,
    });
    return response.data;
  },

  /** 获取 NNRtc Jenkins 配置 */
  getNNRtcJenkinsConfig: async (): Promise<ApiResponse<NNRtcJenkinsConfig>> => {
    const response = await api.get<ApiResponse<NNRtcJenkinsConfig>>('/pods/nnrtc/jenkins/config');
    return response.data;
  },

  /** 获取 IMSDK 共享目录中的 leigod_im_cross_sdk 版本列表 */
  listLeigodIMSDKVersions: async (): Promise<ApiResponse<LeigodIMSDKVersion[]>> => {
    const response = await api.get<ApiResponse<LeigodIMSDKVersion[]>>('/pods/leigod-im/imsdk/versions', {
      timeout: 60000,
    });
    return response.data;
  },

  /** 从 IMSDK 共享目录发布 leigod_im_cross_sdk */
  publishLeigodIMFromIMSDK: async (params: {
    version: string;
    target_branch: string;
    sys_frameworks?: string;
    sys_libraries?: string;
  }): Promise<ApiResponse<PodComponent>> => {
    const response = await api.post<ApiResponse<PodComponent>>('/pods/leigod-im/imsdk/publish', params, {
      timeout: 600000,
    });
    return response.data;
  },

  /** 获取所有组件 */
  list: async (): Promise<ApiResponse<PodComponent[]>> => {
    const response = await api.get<ApiResponse<PodComponent[]>>('/pods/list');
    return response.data;
  },

  /** 获取组件名称列表 */
  names: async (): Promise<ApiResponse<string[]>> => {
    const response = await api.get<ApiResponse<string[]>>('/pods/names');
    return response.data;
  },

  /** 获取指定组件的所有版本 */
  versions: async (name: string): Promise<ApiResponse<PodComponent[]>> => {
    const response = await api.get<ApiResponse<PodComponent[]>>(`/pods/${name}/versions`);
    return response.data;
  },

  /** 获取组件详情 */
  detail: async (name: string, version: string): Promise<ApiResponse<PodComponent>> => {
    const response = await api.get<ApiResponse<PodComponent>>(`/pods/${name}/${version}`);
    return response.data;
  },

  /** 重试同步 spec 仓库 */
  retry: async (name: string, version: string, target_branch: string): Promise<ApiResponse<PodComponent>> => {
    const response = await api.post<ApiResponse<PodComponent>>(`/pods/${name}/${version}/retry`, { target_branch });
    return response.data;
  },

  /** 同步当前组件版本到 nnios 指定分支 */
  syncBranch: async (name: string, version: string, target_branch: string): Promise<ApiResponse<PodComponent>> => {
    const response = await api.post<ApiResponse<PodComponent>>(`/pods/${name}/${version}/sync-branch`, { target_branch });
    return response.data;
  },

  /** 更新 podspec 并同步到远程仓库 */
  updatePodspec: async (name: string, version: string, podspec_content: string, target_branch: string): Promise<ApiResponse<PodComponent>> => {
    const response = await api.put<ApiResponse<PodComponent>>(`/pods/${name}/${version}/podspec`, { podspec_content, target_branch });
    return response.data;
  },

  /** 重新上传 zip 替换已有版本 */
  replaceZip: async (name: string, version: string, file: File, target_branch: string): Promise<ApiResponse<PodComponent>> => {
    const formData = new FormData();
    formData.append('file', file, file.name);
    formData.append('target_branch', target_branch);
    const response = await api.post<ApiResponse<PodComponent>>(`/pods/${name}/${version}/replace`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000,
    });
    return response.data;
  },

  /** 从 IMSDK 共享目录对应版本替换 leigod_im_cross_sdk */
  replaceLeigodIMFromIMSDK: async (version: string, target_branch: string): Promise<ApiResponse<PodComponent>> => {
    const response = await api.post<ApiResponse<PodComponent>>(`/pods/leigod-im/${version}/imsdk/replace`, {
      target_branch,
    }, {
      timeout: 600000,
    });
    return response.data;
  },

  /** 从 NNRtc Jenkins 构建替换已有版本 */
  replaceNNRtcFromJenkins: async (version: string, build_number: string, target_branch: string): Promise<ApiResponse<PodComponent>> => {
    const response = await api.post<ApiResponse<PodComponent>>(`/pods/nnrtc/${version}/jenkins/replace`, {
      build_number,
      target_branch,
    }, {
      timeout: 600000,
    });
    return response.data;
  },

  /** 创建 NNRtc Jenkins 替换任务 */
  startNNRtcReplaceTask: async (version: string, build_number: string, target_branch: string): Promise<ApiResponse<NNRtcPodTask>> => {
    const response = await api.post<ApiResponse<NNRtcPodTask>>(`/pods/nnrtc/${version}/jenkins/replace-task`, {
      build_number,
      target_branch,
    }, {
      timeout: 60000,
    });
    return response.data;
  },

  /** 查询 NNRtc 发布/替换任务 */
  getNNRtcTask: async (taskId: string): Promise<ApiResponse<NNRtcPodTask>> => {
    const response = await api.get<ApiResponse<NNRtcPodTask>>(`/pods/nnrtc/tasks/${taskId}`);
    return response.data;
  },

  /** 查询最近 NNRtc 发布/替换任务 */
  listNNRtcTasks: async (): Promise<ApiResponse<NNRtcPodTask[]>> => {
    const response = await api.get<ApiResponse<NNRtcPodTask[]>>('/pods/nnrtc/tasks');
    return response.data;
  },

  /** 删除组件版本 */
  delete: async (name: string, version: string, target_branch?: string): Promise<ApiResponse<{ fallbackVersion?: string; warning?: string }>> => {
    const response = await api.delete<ApiResponse<{ fallbackVersion?: string; warning?: string }>>(`/pods/${name}/${version}`, {
      params: target_branch ? { target_branch } : undefined,
    });
    return response.data;
  },

  /** 查询官方 CocoaPods 组件的可用版本列表 */
  officialVersions: async (name: string): Promise<ApiResponse<string[]>> => {
    const response = await api.get<ApiResponse<string[]>>(`/pods/official/${name}/versions`);
    return response.data;
  },

  /** 从官方 CocoaPods 导入组件 */
  importOfficial: async (name: string, version: string, buildBinary?: boolean, outputType?: string, depVersionOverrides?: Record<string, string>, selectedSubspecs?: string[], internalVersion?: string, prepareCommand?: string, targetBranch?: string): Promise<ApiResponse<PodComponent>> => {
    const response = await api.post<ApiResponse<PodComponent>>('/pods/official/import', {
      name, version, buildBinary, outputType, depVersionOverrides, selectedSubspecs, internalVersion, prepareCommand, target_branch: targetBranch,
    }, {
      timeout: 600000,
    });
    return response.data;
  },

  /** 查询官方组件的依赖列表 */
  checkDependencies: async (name: string, version: string): Promise<ApiResponse<{
    dependencies: Array<{
      name: string;
      versionRequirement: string;
      existsInInternal: boolean;
      internalVersions: string[];
      officialVersions: string[];
    }>;
    allSatisfied: boolean;
    subspecs: string[];
    defaultSubspecs: string[];
  }>> => {
    const response = await api.get(`/pods/official/${name}/${version}/dependencies`);
    return response.data;
  },

  /** 删除整个组件（所有版本） */
  deleteComponent: async (name: string): Promise<ApiResponse> => {
    const response = await api.delete<ApiResponse>(`/pods/${name}`);
    return response.data;
  },
};

// ============ Git 批量操作 ============

export type GitPushMode = 'normal' | 'skip' | 'set-upstream';

export interface GitDefaultReposResponse {
  repos: string[];
  baseBranch: string;
  baseDir: string;
}

export interface GitBranchJobOptions {
  targetBranch: string;
  baseBranch?: string;
  repos: string[];
  pullEnabled?: boolean;
  pushMode?: GitPushMode;
  username?: string;
  password?: string;
  baseDir?: string;
  modifyPodfile?: boolean;
  /** 目标分支已存在时是否强制覆盖，默认 false */
  force?: boolean;
}

export interface GitRemoteBranchCheckItem {
  repo: string;
  url: string;
  targetExists: boolean;
  baseExists: boolean;
  reachable: boolean;
  error?: string;
}

export interface GitRemoteBranchCheckResult {
  targetBranch: string;
  baseBranch: string;
  items: GitRemoteBranchCheckItem[];
  existingRepos: string[];
  missingBaseRepos: string[];
  unreachableRepos: string[];
}

export type GitStreamEvent =
  | { type: 'log'; repo?: string; level: 'info' | 'warn' | 'error' | 'debug'; message: string }
  | { type: 'result'; repo: string; status: 'success' | 'failed' | 'skipped'; message?: string }
  | { type: 'done'; success: boolean; failures: string[] };

export interface GitRemoteBranch {
  name: string;
  sha: string;
  isDefault: boolean;
}

export interface GitRepoBranches {
  repo: string;
  url: string;
  ok: boolean;
  defaultBranch?: string;
  branches?: GitRemoteBranch[];
  error?: string;
}

export interface GitNniosPodSource {
  sourceFile: 'Podfile' | 'third_sdk.rb';
  podName: string;
  version?: string;
  git?: string;
  branch?: string;
  tag?: string;
  commit?: string;
  pathRef?: string;
  raw: string;
}

export interface GitResolvedDependency {
  name: string;
  specRequirement?: string;
  fromSpec: string;
  resolved: boolean;
  match?: GitNniosPodSource;
  allMatches: GitNniosPodSource[];
}

export interface GitRepoDependencyResult {
  repo: string;
  url: string;
  branch: string;
  ok: boolean;
  error?: string;
  specFiles: string[];
  dependencies: GitResolvedDependency[];
}

export interface GitPodDepsResponse {
  nnios: { branch: string; missingFiles: string[]; sourceCount: number };
  results: GitRepoDependencyResult[];
}

export const gitApi = {
  /** 获取脚本内置的默认仓库列表 */
  getDefaultRepos: async (): Promise<ApiResponse<GitDefaultReposResponse>> => {
    const response = await api.get<ApiResponse<GitDefaultReposResponse>>('/git/default-repos');
    return response.data;
  },

  /** 获取 Git 凭据配置状态 */
  getCredentials: async (): Promise<ApiResponse<{ username: string; hasPassword: boolean }>> => {
    const response = await api.get<ApiResponse<{ username: string; hasPassword: boolean }>>('/git/credentials');
    return response.data;
  },

  /** 设置 Git 凭据 */
  setCredentials: async (username: string, password: string): Promise<ApiResponse> => {
    const response = await api.put<ApiResponse>('/git/credentials', { username, password });
    return response.data;
  },

  /** 清除 Git 凭据 */
  clearCredentials: async (): Promise<ApiResponse> => {
    const response = await api.delete<ApiResponse>('/git/credentials');
    return response.data;
  },

  /** 批量列出多个仓库的远端分支 */
  listBranches: async (params: {
    repos?: string[];
    username?: string;
    password?: string;
  }): Promise<ApiResponse<GitRepoBranches[]>> => {
    const response = await api.post<ApiResponse<GitRepoBranches[]>>('/git/branches', params, {
      timeout: 120000,
    });
    return response.data;
  },

  /**
   * 解析各业务仓库在指定分支下的 podspec 依赖，
   * 并用 nnios 同名分支 Podfile / third_sdk.rb 反查版本
   */
  resolvePodDeps: async (params: {
    repos?: string[];
    branch: string;
    username?: string;
    password?: string;
  }): Promise<ApiResponse<GitPodDepsResponse>> => {
    const response = await api.post<ApiResponse<GitPodDepsResponse>>('/git/pod-deps', params, {
      timeout: 600000,
    });
    return response.data;
  },

  /** 预检：远端是否已有目标/基准分支 */
  precheckBranch: async (params: {
    targetBranch: string;
    baseBranch?: string;
    repos: string[];
    username?: string;
    password?: string;
  }): Promise<ApiResponse<GitRemoteBranchCheckResult>> => {
    const response = await api.post<ApiResponse<GitRemoteBranchCheckResult>>(
      '/git/branch-jobs/precheck',
      params,
      { timeout: 120000 }
    );
    return response.data;
  },

  /**
   * 启动批量建分支任务，返回 NDJSON 流
   * @param onEvent 每收到一条事件触发
   * @param signal AbortSignal，用于中止
   */
  streamCreateBranch: async (
    options: GitBranchJobOptions,
    onEvent: (evt: GitStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> => {
    const token = authUtils.getToken();
    const response = await fetch('/api/git/branch-jobs/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(options),
      signal,
    });

    if (!response.ok || !response.body) {
      let errMsg = `请求失败 (${response.status})`;
      try {
        const data = await response.json();
        if (data?.error) errMsg = data.error;
      } catch {
        // ignore
      }
      throw new Error(errMsg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 逐行解析 NDJSON
    // 每条事件以 \n 结尾
    // 读取时要处理半行缓冲
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as GitStreamEvent;
          onEvent(evt);
        } catch (err) {
          console.warn('无法解析事件行', line, err);
        }
      }
    }

    // flush 残留
    const rest = (buffer + decoder.decode()).trim();
    if (rest) {
      try {
        onEvent(JSON.parse(rest) as GitStreamEvent);
      } catch (err) {
        console.warn('无法解析残留事件行', rest, err);
      }
    }
  },
};

// ============ 设备配对（实时日志） ============

export interface PairingSessionData {
  pairingId: string;
  token: string;
  wsUrl?: string;
  wsUrls: string[];
}

export interface PairingStatusData {
  status: 'waiting' | 'paired' | 'streaming' | 'expired' | 'disconnected';
  wsUrl?: string;
  wsUrls?: string[];
  deviceLogUrl?: string;
  deviceInfo?: {
    deviceId?: string;
    name?: string;
    model?: string;
    systemVersion?: string;
    ip?: string;
    appDeviceId?: string;
    userId?: number | string;
    nickName?: string;
    nnNumber?: number | string;
  };
}

export interface RealtimeLogDeviceData extends PairingStatusData {
  pairingId: string;
  token: string;
  appConnected: boolean;
  recentLogCount: number;
  createdAt: number;
  pairedAt?: number;
  lastActiveAt?: number;
}

export const pairingApi = {
  /** 创建配对会话 */
  create: async (): Promise<ApiResponse<PairingSessionData>> => {
    const response = await api.post<ApiResponse<PairingSessionData>>('/pairing/create', {
      pageHost: window.location.hostname,
    });
    return response.data;
  },

  /** 查询配对状态 */
  getStatus: async (pairingId: string): Promise<ApiResponse<PairingStatusData>> => {
    const response = await api.get<ApiResponse<PairingStatusData>>(`/pairing/status/${pairingId}`);
    return response.data;
  },

  /** 查询已连接/已配对设备 */
  listDevices: async (): Promise<ApiResponse<RealtimeLogDeviceData[]>> => {
    const response = await api.get<ApiResponse<RealtimeLogDeviceData[]>>('/pairing/devices');
    return response.data;
  },

  /** 删除配对会话 */
  delete: async (pairingId: string): Promise<void> => {
    await api.delete(`/pairing/${pairingId}`);
  },
};

// ============ Jenkins CI/CD ============

export interface JenkinsBuild {
  number: number;
  result?: 'SUCCESS' | 'FAILURE' | 'ABORTED' | 'UNSTABLE' | null;
  timestamp: number;
  duration: number;
  building: boolean;
  url: string;
  description?: string | null;
  branchName?: string;
  commitHash?: string;
  publishChannel?: string;
  buildNumber?: string;
  appVersion?: string;
  packageUrl?: string;
  installPackageUrl?: string;
  channelQrUrl?: string;
  xcarchivePath?: string;
  archiveUrl?: string;
}

export interface JenkinsJobInfo {
  name: string;
  fullName: string;
  url: string;
  buildable: boolean;
  color?: string;
  lastBuild?: JenkinsBuild;
}

export interface JenkinsBuildListResult {
  job: JenkinsJobInfo;
  stats: {
    total: number;
    running: number;
    latestBuild: number | string;
    successRate: string;
  };
  builds: JenkinsBuild[];
}

export interface JenkinsBuildLogResult {
  jobName: string;
  buildNumber: number;
  log: string;
  thirdSdkBranch: string;
  thirdSdkRevision?: string;
  thirdSdkDependencies: Array<{
    name: string;
    version: string;
    source: string;
  }>;
  thirdSdkMissingFiles?: string[];
  thirdSdkError?: string;
}

export type JenkinsQualitySuite = 'smoke' | 'im' | 'rtc' | 'monkey' | 'stutter' | 'full';

export interface JenkinsQualityBuild {
  number: number;
  result?: 'SUCCESS' | 'FAILURE' | 'ABORTED' | 'UNSTABLE' | null;
  timestamp: number;
  duration: number;
  building: boolean;
  url: string;
  description?: string | null;
  qualitySummary?: {
    status?: 'passed' | 'failed' | string;
    message?: string;
    sourceBuildNumber?: string;
    branch?: string;
    commitHash?: string;
    publishChannel?: string;
    appVersion?: string;
    testSuite?: string;
    stutterScenario?: string;
    devicePool?: string;
    devicePoolLabel?: string;
    deviceUdid?: string;
    bundleId?: string;
    detectedBundleId?: string;
    launchMethod?: string;
    launchDurationMs?: number;
    coldStartReadyMs?: number;
    coldStartWaitSeconds?: number;
    monkeyStatus?: string;
    monkeyMessage?: string;
    monkeyExecutedEvents?: number;
    monkeyEventCount?: number;
    wdaUrl?: string;
    progress?: {
      status?: string;
      phase?: string;
      message?: string;
      updatedAt?: number;
      elapsedSeconds?: number;
      remainingSeconds?: number | null;
      executedEvents?: number;
      requestedEvents?: number;
      requestedDurationSeconds?: number;
      progressPercent?: number;
      lastAction?: Record<string, unknown> | null;
      recentPerformance?: {
        sampleCount?: number;
        cpu?: number | null;
        memoryMB?: number | null;
        fps?: number | null;
      };
    };
    exceptionAnalysis?: {
      severity?: 'passed' | 'warning' | 'failed' | string;
      crashCount?: number;
      exceptionCount?: number;
      watchdogCount?: number;
      memoryIssueCount?: number;
      errorCount?: number;
      samples?: Array<{
        type?: string;
        message?: string;
      }>;
      crashReports?: {
        count?: number;
        files?: string[];
        samples?: Array<{
          file?: string;
          process?: string;
          exception?: string;
          reason?: string;
          crashedThread?: string;
        }>;
      };
      hangStackAnalysis?: Array<{
        file?: string;
        type?: string;
        bugType?: string;
        code?: string;
        event?: string;
        reason?: string;
        captureTime?: string;
        process?: string;
        bundleId?: string;
        version?: string;
        buildVersion?: string;
        mainThread?: {
          index?: number;
          name?: string;
          queue?: string;
          summary?: string;
          frames?: Array<{
            image?: string;
            symbol?: string;
            offset?: number;
          }>;
        };
        symbolication?: {
          source?: string;
          archivePath?: string;
          dsymPath?: string;
          uuid?: string;
          message?: string;
        };
        suspiciousThreads?: Array<{
          index?: number;
          name?: string;
          queue?: string;
          frames?: Array<{
            image?: string;
            symbol?: string;
            offset?: number;
          }>;
        }>;
        suggestions?: string[];
      }>;
    };
    performanceAnalysis?: {
      launchDurationMs?: number;
      coldStartReadyMs?: number;
      coldStartGrade?: 'good' | 'warning' | 'slow' | 'unknown' | string;
      monkeyDurationMs?: number;
      monkeyExecutedEvents?: number;
      monkeyEventsPerMinute?: number;
      monkeyStatus?: string;
      stutter?: {
        enabled?: boolean;
        method?: string;
        thresholds?: {
          actionWarnMs?: number;
          actionSevereMs?: number;
        };
        slowActionCount?: number;
        severeActionCount?: number;
        stuckPageCount?: number;
        wdaRecoveryCount?: number;
        targetAppRecoveryCount?: number;
        longestAction?: {
          index?: number;
          type?: string;
          reason?: string;
          actionDurationMs?: number;
          elapsedSeconds?: number;
          page?: {
            fingerprint?: string;
            summary?: {
              text?: string[];
              nodeTypes?: string[];
            };
          };
        } | null;
        samples?: Array<{
          index?: number;
          type?: string;
          reason?: string;
          actionDurationMs?: number;
          elapsedSeconds?: number;
          page?: {
            fingerprint?: string;
            summary?: {
              text?: string[];
              nodeTypes?: string[];
            };
          };
        }>;
      };
      frameStutter?: {
        enabled?: boolean;
        method?: string;
        available?: boolean;
        template?: string;
        message?: string;
        thresholds?: {
          frameWarnMs?: number;
          frameSevereMs?: number;
        };
        schemas?: string[];
        hitchCount?: number;
        severeHitchCount?: number;
        longestHitch?: {
          schema?: string;
          row?: number;
          durationMs?: number;
          severity?: string;
          timeSeconds?: number | null;
          raw?: string[];
        } | null;
        samples?: Array<{
          schema?: string;
          row?: number;
          durationMs?: number;
          severity?: string;
          timeSeconds?: number | null;
          raw?: string[];
        }>;
      };
      stackAnalysis?: {
        enabled?: boolean;
        available?: boolean;
        method?: string;
        template?: string;
        message?: string;
        schemas?: string[];
        stutterSampleCount?: number;
        samples?: Array<{
          index?: number;
          type?: string;
          elapsedSeconds?: number;
          actionDurationMs?: number;
          message?: string;
          page?: {
            fingerprint?: string;
            summary?: {
              text?: string[];
              nodeTypes?: string[];
            };
          };
          matchedFrames?: Array<{
            schema?: string;
            row?: number;
            frame?: string;
          }>;
        }>;
      };
      samples?: {
        sampleCount?: number;
        cpu?: { avg?: number | null; max?: number | null; min?: number | null };
        memoryMB?: { avg?: number | null; max?: number | null; min?: number | null };
        fps?: { avg?: number | null; max?: number | null; min?: number | null };
      };
      trace?: {
        available?: boolean;
        sampleRowsExported?: number | null;
        durationSeconds?: number | null;
        startDate?: string;
        endDate?: string;
        endReason?: string;
        templateName?: string;
        timeLimit?: string;
        process?: string;
        pid?: string;
        terminationReason?: string;
        segmentCount?: number;
        segments?: Array<{
          name?: string;
          path?: string;
          current?: boolean;
          reason?: string;
          finishedAt?: string;
        }>;
      };
      thresholds?: Record<string, number>;
      conclusion?: {
        severity?: 'passed' | 'warning' | 'failed' | string;
        issues?: Array<{
          severity?: string;
          metric?: string;
          message?: string;
        }>;
      };
    };
    artifacts?: {
      summaryUrl?: string;
      screenshotUrl?: string;
      deviceLogUrl?: string;
      processesUrl?: string;
      monkeyReportUrl?: string;
      performanceSamplesUrl?: string;
      performanceStuttersUrl?: string;
      performanceStacksUrl?: string;
      performanceTraceUrl?: string;
      crashReportsUrl?: string;
      junitUrl?: string;
      qualityLogUrl?: string;
    };
  };
}

export interface JenkinsQualityListResult {
  job: {
    name: string;
    fullName: string;
    url: string;
    buildable: boolean;
    color?: string;
  };
  stats: {
    total: number;
    running: number;
    latestBuild: number | string;
    successRate: string;
  };
  builds: JenkinsQualityBuild[];
}

export interface JenkinsQualityArtifactPreview {
  url: string;
  content: string;
  contentType?: string;
  format?: 'text' | 'json' | 'xml' | string;
  truncated?: boolean;
}

export interface JenkinsQualityPerformanceSamples {
  url: string;
  contentType?: string;
  sampleCount: number;
  returnedSampleCount: number;
  truncated?: boolean;
  sourceTruncated?: boolean;
  samples: Array<{
    index: number;
    timeSeconds: number;
    cpu: number | null;
    memoryMB: number | null;
    fps: number | null;
  }>;
  summary: {
    cpu: { avg: number | null; max: number | null; min: number | null };
    memoryMB: { avg: number | null; max: number | null; min: number | null };
    fps: { avg: number | null; max: number | null; min: number | null };
  };
}

export type QualityTaskType = 'ios_monkey';
export type QualityTaskStatus = 'created' | 'queued' | 'preparing' | 'installing' | 'running' | 'collecting' | 'analyzing' | 'reporting' | 'notifying' | 'success' | 'failed' | 'unstable' | 'canceled' | string;

export interface QualityIssue {
  id: string;
  task_id?: string;
  project_id?: string;
  type: 'crash' | 'oom' | 'stuck' | 'white_screen' | 'performance' | string;
  severity: 'blocker' | 'warning' | 'info' | string;
  title: string;
  fingerprint: string;
  is_new?: boolean;
  count?: number;
  screen?: string;
  first_seen_at?: string;
  artifact_refs?: Record<string, string>;
}

export interface QualityTask {
  task_id: string;
  task_type: QualityTaskType | string;
  status: QualityTaskStatus;
  progress?: number;
  project_id?: string;
  app_name?: string;
  app_version?: string;
  build?: string;
  created_by?: string;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  config?: {
    duration_minutes?: number;
    seed?: string | number;
    max_actions?: number;
    device_pool?: string;
    device_udid?: string;
    wda_url?: string;
    blacklist_profile?: string;
  };
  result?: {
    passed?: boolean;
    crash_count?: number;
    oom_count?: number;
    stuck_count?: number;
    white_screen_count?: number;
    duration_seconds?: number;
    total_actions?: number;
    report_url?: string;
    artifact_url?: string;
  };
  summary?: JenkinsQualityBuild['qualitySummary'];
  issues?: QualityIssue[];
  links?: Record<string, string>;
}

export interface SonicQualityStatus {
  configured: boolean;
  apiBase: string;
  webUrl?: string;
  apiProxyTarget?: string;
  webProxyTarget?: string;
  tokenConfigured: boolean;
  projectId: string;
  testPlanId: string;
  reachable: boolean;
  message: string;
}

export interface SonicDevicePool {
  label: string;
  value: string;
  description: string;
  deviceId?: string;
  groupId?: string;
  devices?: Array<{
    label?: string;
    udid: string;
    description?: string;
    status?: 'idle' | 'busy' | 'offline' | 'unassigned' | string;
    online?: boolean;
    busy?: boolean;
    activeBuildNumber?: number;
    name?: string;
    marketName?: string;
    productVersion?: string;
    connType?: string;
  }>;
  stats?: {
    total: number;
    online: number;
    idle: number;
    busy: number;
    offline: number;
  };
}

export interface SonicDevicePoolStatusResult {
  pools: SonicDevicePool[];
  detectedDevices: Array<{
    udid: string;
    serial?: string;
    name?: string;
    marketName?: string;
    productVersion?: string;
    connType?: string;
  }>;
  unassignedDevices: Array<{
    udid: string;
    name?: string;
    marketName?: string;
    productVersion?: string;
    connType?: string;
    status?: string;
    busy?: boolean;
    activeBuildNumber?: number;
  }>;
  detector: {
    available: boolean;
    error?: string;
  };
}

export const jenkinsApi = {
  listBranches: async (): Promise<ApiResponse<string[]>> => {
    const response = await api.get<ApiResponse<string[]>>('/jenkins/nn/branches');
    return response.data;
  },

  listNNBuilds: async (params?: {
    deployTarget?: 'Pgyer' | 'TestFlight' | 'AppStore' | '';
  }): Promise<ApiResponse<JenkinsBuildListResult>> => {
    const response = await api.get<ApiResponse<JenkinsBuildListResult>>('/jenkins/nn/builds', { params });
    return response.data;
  },

  publishNN: async (payload: {
    deployTarget: 'Pgyer' | 'TestFlight' | 'AppStore';
    verificationPassword?: string;
    branch?: string;
  }): Promise<ApiResponse<{ jobName: string; url: string; deployTarget: string; branch: string; jenkinsBranch?: string }>> => {
    const response = await api.post<ApiResponse<{ jobName: string; url: string; deployTarget: string; branch: string; jenkinsBranch?: string }>>('/jenkins/nn/build', payload);
    return response.data;
  },

  createReleaseBranch: async (payload: {
    targetBranch: string;
    baseBranch?: string;
  }): Promise<ApiResponse<{
    repoDir: string;
    targetBranch: string;
    baseBranch: string;
    commands: Array<{ command: string; output: string }>;
  }>> => {
    const response = await api.post<ApiResponse<{
      repoDir: string;
      targetBranch: string;
      baseBranch: string;
      commands: Array<{ command: string; output: string }>;
    }>>('/jenkins/nn/release-branch', payload, {
      timeout: 10 * 60 * 1000,
    });
    return response.data;
  },

  stopBuild: async (buildNumber: number): Promise<ApiResponse<{ jobName: string; buildNumber: number }>> => {
    const response = await api.post<ApiResponse<{ jobName: string; buildNumber: number }>>(`/jenkins/nn/builds/${buildNumber}/stop`);
    return response.data;
  },

  getBuildLog: async (buildNumber: number): Promise<ApiResponse<JenkinsBuildLogResult>> => {
    const response = await api.get<ApiResponse<JenkinsBuildLogResult>>(`/jenkins/nn/builds/${buildNumber}/log`, {
      timeout: 120000,
    });
    return response.data;
  },

  listQualityBuilds: async (): Promise<ApiResponse<JenkinsQualityListResult>> => {
    const response = await api.get<ApiResponse<JenkinsQualityListResult>>('/jenkins/nn/quality/builds');
    return response.data;
  },

  stopQualityBuild: async (buildNumber: number, payload?: { deviceUdid?: string }): Promise<ApiResponse<{ jobName: string; buildNumber: number }>> => {
    const response = await api.post<ApiResponse<{ jobName: string; buildNumber: number }>>(`/jenkins/nn/quality/builds/${buildNumber}/stop`, payload || {});
    return response.data;
  },

  cleanupQualityWda: async (payload?: { deviceUdid?: string }): Promise<ApiResponse<{ deviceUdid?: string; terminatedDeviceProcesses: number }>> => {
    const response = await api.post<ApiResponse<{ deviceUdid?: string; terminatedDeviceProcesses: number }>>('/jenkins/nn/quality/wda/cleanup', payload || {});
    return response.data;
  },

  previewQualityArtifact: async (url: string): Promise<ApiResponse<JenkinsQualityArtifactPreview>> => {
    const response = await api.get<ApiResponse<JenkinsQualityArtifactPreview>>('/jenkins/nn/quality/artifact-preview', {
      params: { url },
      timeout: 30000,
    });
    return response.data;
  },

  getQualityPerformanceSamples: async (url: string): Promise<ApiResponse<JenkinsQualityPerformanceSamples>> => {
    const response = await api.get<ApiResponse<JenkinsQualityPerformanceSamples>>('/jenkins/nn/quality/performance-samples', {
      params: { url },
      timeout: 30000,
    });
    return response.data;
  },

  getSonicQualityStatus: async (): Promise<ApiResponse<SonicQualityStatus>> => {
    const response = await api.get<ApiResponse<SonicQualityStatus>>('/jenkins/nn/quality/sonic/status');
    return response.data;
  },

  listSonicDevicePools: async (): Promise<ApiResponse<SonicDevicePool[]>> => {
    const response = await api.get<ApiResponse<SonicDevicePool[]>>('/jenkins/nn/quality/sonic/device-pools');
    return response.data;
  },

  getSonicDevicePoolStatus: async (): Promise<ApiResponse<SonicDevicePoolStatusResult>> => {
    const response = await api.get<ApiResponse<SonicDevicePoolStatusResult>>('/jenkins/nn/quality/sonic/device-pools/status');
    return response.data;
  },

  updateSonicDevicePools: async (devicePools: SonicDevicePool[]): Promise<ApiResponse<SonicDevicePool[]>> => {
    const response = await api.put<ApiResponse<SonicDevicePool[]>>('/jenkins/nn/quality/sonic/device-pools', { devicePools });
    return response.data;
  },

  syncQualityJobConfig: async (): Promise<ApiResponse<{
    jobName: string;
    jobUrl: string;
    configPath: string;
    status: number;
    concurrentBuild: boolean;
    hasWdaDerivedDataPath: boolean;
  }>> => {
    const response = await api.post<ApiResponse<{
      jobName: string;
      jobUrl: string;
      configPath: string;
      status: number;
      concurrentBuild: boolean;
      hasWdaDerivedDataPath: boolean;
    }>>('/jenkins/nn/quality/job/sync');
    return response.data;
  },

  triggerQuality: async (payload: {
    buildNumber: number;
    branch?: string;
    commitHash?: string;
    appVersion?: string;
    packageUrl?: string;
    xcarchivePath?: string;
    archiveUrl?: string;
    publishChannel?: string;
    testSuite: JenkinsQualitySuite;
    devicePool: string;
    deviceUdid?: string;
    monkeyDurationSeconds?: number;
    stutterScenario?: string;
    skipInstall?: boolean;
    appBundleId?: string;
  }): Promise<ApiResponse<{
    jobName: string;
    sourceBuildNumber: string;
    testSuite: JenkinsQualitySuite;
    devicePool: string;
    url: string;
  }>> => {
    const response = await api.post<ApiResponse<{
      jobName: string;
      sourceBuildNumber: string;
      testSuite: JenkinsQualitySuite;
      devicePool: string;
      url: string;
    }>>('/jenkins/nn/quality', payload);
    return response.data;
  },
};

export const qualityApi = {
  createTask: async (payload: {
    task_type: QualityTaskType;
    project_id?: string;
    app: {
      name?: string;
      bundle_id?: string;
      version?: string;
      build: string | number;
      branch?: string;
      commit_hash?: string;
      ipa_url?: string;
      xcarchive_path?: string;
      archive_url?: string;
    };
    monkey: {
      duration_minutes?: number;
      seed?: string | number;
      max_actions?: number;
      device_pool?: string;
      interval_seconds?: number;
      page_blacklist?: string;
      text_blacklist?: string;
    };
    notify?: {
      wecom?: boolean;
      mention_on_failure?: boolean;
      owner_group?: string;
    };
  }): Promise<ApiResponse<{ task_id: string; status: QualityTaskStatus; queue_url?: string; job_url?: string }>> => {
    const response = await api.post<ApiResponse<{ task_id: string; status: QualityTaskStatus; queue_url?: string; job_url?: string }>>('/quality/tasks', payload);
    return response.data;
  },

  listTasks: async (): Promise<ApiResponse<{ tasks: QualityTask[] }>> => {
    const response = await api.get<ApiResponse<{ tasks: QualityTask[] }>>('/quality/tasks');
    return response.data;
  },

  getTask: async (taskId: string): Promise<ApiResponse<QualityTask>> => {
    const response = await api.get<ApiResponse<QualityTask>>(`/quality/tasks/${encodeURIComponent(taskId)}`);
    return response.data;
  },

  listIssues: async (taskId: string): Promise<ApiResponse<{ task_id: string; issues: QualityIssue[] }>> => {
    const response = await api.get<ApiResponse<{ task_id: string; issues: QualityIssue[] }>>(`/quality/tasks/${encodeURIComponent(taskId)}/issues`);
    return response.data;
  },

  rerunTask: async (taskId: string, seedStrategy: 'reuse' | 'new' = 'reuse'): Promise<ApiResponse<{ task_id: string; status: QualityTaskStatus; queue_url?: string; job_url?: string }>> => {
    const response = await api.post<ApiResponse<{ task_id: string; status: QualityTaskStatus; queue_url?: string; job_url?: string }>>(`/quality/tasks/${encodeURIComponent(taskId)}/rerun`, {
      seed_strategy: seedStrategy,
    });
    return response.data;
  },

  cancelTask: async (taskId: string): Promise<ApiResponse<{ task_id: string; status: QualityTaskStatus }>> => {
    const response = await api.post<ApiResponse<{ task_id: string; status: QualityTaskStatus }>>(`/quality/tasks/${encodeURIComponent(taskId)}/cancel`);
    return response.data;
  },
};

export default api;
