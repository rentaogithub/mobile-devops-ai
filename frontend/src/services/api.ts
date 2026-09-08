import axios from 'axios';
import { assertQualityDevicePoolResponse } from './qualityDevicePoolResponse';
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
  CrashGovernanceDashboard,
  CrashGovernanceConfig,
  CrashGovernanceEvent,
  CrashGovernanceFingerprintGroup,
  CrashGovernanceRecord,
  CrashGovernanceStatus,
  HistoryRecord,
} from '../types';
import { authUtils, type MobileApplication } from '../utils/auth';

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 60000, // 60 秒超时
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config) => {
  const productLine = authUtils.getActiveProductLine();
  if (productLine) config.headers.set('X-Product-Line-Id', productLine.id);
  const application = authUtils.getActiveApplication();
  if (application) config.headers.set('X-Application-Id', application.id);
  return config;
});

const FALLBACK_EXCLUDED_SENTRY_APP_VERSIONS = ['10.0.0'];
const fallbackExcludedSentryAppVersions = () => authUtils.getActiveProductLine()?.id === 'nn'
  ? FALLBACK_EXCLUDED_SENTRY_APP_VERSIONS
  : [];
const fallbackSentryIssueQuery = () => {
  const versions = fallbackExcludedSentryAppVersions();
  return versions.length > 0 ? `is:unresolved !release:"${versions[0]}"` : 'is:unresolved';
};
let sentryGovernanceConfigCache: (CrashGovernanceConfig & { productLineId: string; loadedAt: number }) | null = null;
export const BACKEND_UNAVAILABLE_CODE = 'BACKEND_UNAVAILABLE';
export const BACKEND_UNAVAILABLE_MESSAGE = '平台后端服务不可达，请确认 3000 端口服务已启动';
export const BACKEND_UNAVAILABLE_HINT = '可在 nn-ios-platform 目录执行 ./start-platform.sh，或查看 backend-dev.log。';

export type PlatformRole = 'guest' | 'tester' | 'developer' | 'product' | 'admin';

export interface PlatformProductLine {
  applications?: MobileApplication[];
  id: string;
  key: string;
  name: string;
  projectId: string;
  bundleId?: string;
  jenkinsBaseUrl?: string;
  active: boolean;
}

export interface ProductLineMembership extends PlatformProductLine {
  appStoreRelease?: boolean;
  role: PlatformRole;
}

export interface PlatformUser {
  id: string;
  username: string;
  displayName: string;
  role: PlatformRole;
  active: boolean;
  productLines: ProductLineMembership[];
}

export type PlatformRegistrationStatus = 'pending' | 'approved' | 'rejected';

export interface PlatformRegistrationRequest {
  id: string;
  username: string;
  displayName: string;
  requestedRole: PlatformRole;
  productLineId: string;
  productLineName?: string;
  status: PlatformRegistrationStatus;
  reviewerUserId?: string;
  reviewerUsername?: string;
  reviewMessage?: string;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
}

export interface PlatformConfigStatus {
  aiApiKeyConfigured: boolean;
  releaseVerificationPasswordConfigured: boolean;
  aiApiKey?: string;
  releaseVerificationPassword?: string;
  adminPassword?: string;
}

export interface ProductLineServiceConfig {
  JENKINS_USER: string;
  JENKINS_TOKEN: string;
  JENKINS_TOKENConfigured: boolean;
  JENKINS_NN_JOB: string;
  JENKINS_NN_QA_JOB: string;
  JENKINS_NN_REPO_URL: string;
  PODX_TARGET_NAME: string;
  PODX_PRIVATE_SOURCE: string;
  PODX_GIT_BASE_URL: string;
  PODX_PUBLISH_REPOS: string;
  PODX_PUBLISH_MAIN_REPO: string;
  PODX_PUBLISH_WORK_DIR: string;
  PODX_PUBLISH_BASE_BRANCH: string;
  PODS_NEXUS_BASE_URL: string;
  PODS_NEXUS_USER: string;
  PODS_NEXUS_PASSWORDConfigured: boolean;
  GIT_USERNAME: string;
  GIT_PASSWORDConfigured: boolean;
  NNRTC_JENKINS_BASE_URL: string;
  NNRTC_JENKINS_JOB: string;
  NNRTC_JENKINS_USER: string;
  NNRTC_JENKINS_TOKENConfigured: boolean;
  SENTRY_PROXY_TARGET: string;
  SENTRY_ORG: string;
  SENTRY_PROJECT: string;
  SENTRY_AUTO_LOGIN: string;
  SENTRY_LOGIN_USERNAME: string;
  SENTRY_LOGIN_PASSWORDConfigured: boolean;
  PGYER_API_KEY: string;
  PGYER_API_KEYConfigured: boolean;
  PGYER_APP_KEYConfigured: boolean;
  PGYER_SHORTCUT_URL: string;
  APP_STORE_CONNECT_API_KEY_ID: string;
  APP_STORE_CONNECT_API_ISSUER_ID: string;
  APP_STORE_CONNECT_API_PRIVATE_KEYConfigured: boolean;
  APP_STORE_CONNECT_API_PRIVATE_KEY_SOURCE?: string;
  APP_STORE_CONNECT_API_PRIVATE_KEY_STORAGE?: string;
  APP_STORE_CONNECT_APP_ID: string;
  APP_STORE_CONNECT_TESTFLIGHT_GROUPS: string;
  WECHAT_WEBHOOK_URLConfigured: boolean;
  WECHAT_WEBHOOK_URL?: string;
  WECHAT_WEBHOOK_URL_SOURCE?: string;
  WECHAT_WORK_CORP_ID: string;
  WECHAT_WORK_AGENT_ID: string;
  WECHAT_WORK_SECRETConfigured: boolean;
}

export interface ProductLinePodxConfigSyncResult {
  productLineId: string;
  projectDirectory: string;
  configPath: string;
  repoUrl: string;
  cloned: boolean;
}

export interface ProductLineComponentRepository {
  name: string;
  url: string;
}

export interface ProductLineTestFlightGroup {
  id: string;
  name: string;
  isInternal: boolean;
}

export type ProductLineServiceUpdate = Partial<Record<
  | 'JENKINS_USER' | 'JENKINS_TOKEN' | 'JENKINS_NN_JOB' | 'JENKINS_NN_QA_JOB' | 'JENKINS_NN_REPO_URL'
  | 'PODX_TARGET_NAME' | 'PODX_PRIVATE_SOURCE' | 'PODX_GIT_BASE_URL'
  | 'PODX_PUBLISH_REPOS' | 'PODX_PUBLISH_MAIN_REPO' | 'PODX_PUBLISH_WORK_DIR' | 'PODX_PUBLISH_BASE_BRANCH'
  | 'PODS_NEXUS_BASE_URL' | 'PODS_NEXUS_USER' | 'PODS_NEXUS_PASSWORD'
  | 'GIT_USERNAME' | 'GIT_PASSWORD'
  | 'NNRTC_JENKINS_BASE_URL' | 'NNRTC_JENKINS_JOB' | 'NNRTC_JENKINS_USER' | 'NNRTC_JENKINS_TOKEN'
  | 'SENTRY_PROXY_TARGET' | 'SENTRY_ORG' | 'SENTRY_PROJECT' | 'SENTRY_AUTO_LOGIN' | 'SENTRY_LOGIN_USERNAME' | 'SENTRY_LOGIN_PASSWORD'
  | 'PGYER_API_KEY' | 'PGYER_APP_KEY' | 'PGYER_SHORTCUT_URL'
  | 'APP_STORE_CONNECT_API_KEY_ID' | 'APP_STORE_CONNECT_API_ISSUER_ID' | 'APP_STORE_CONNECT_API_PRIVATE_KEY' | 'APP_STORE_CONNECT_APP_ID' | 'APP_STORE_CONNECT_TESTFLIGHT_GROUPS'
  | 'WECHAT_WEBHOOK_URL' | 'WECHAT_WORK_CORP_ID' | 'WECHAT_WORK_AGENT_ID' | 'WECHAT_WORK_SECRET',
  string
>>;

// 响应拦截器
api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    if (error.response) {
      // 处理 401 未授权错误
      if (error.response.status === 401) {
        authUtils.clearUser();
      }
      // 服务器返回错误
      return Promise.reject(error.response.data);
    } else if (error.request) {
      // 请求发送但没有收到响应
      const isTimeout = error.code === 'ECONNABORTED';
      return Promise.reject({
        error: isTimeout ? '平台服务请求超时，请稍后重试' : BACKEND_UNAVAILABLE_MESSAGE,
        code: isTimeout ? 'REQUEST_TIMEOUT' : BACKEND_UNAVAILABLE_CODE,
        hint: isTimeout ? '如果持续超时，请查看 backend-dev.log 确认后端是否卡住。' : BACKEND_UNAVAILABLE_HINT,
      });
    } else {
      // 其他错误
      return Promise.reject({ error: error.message });
    }
  }
);

export const authApi = {
  register: async (payload: {
    username: string;
    displayName?: string;
    password: string;
    requestedRole: PlatformRole;
    productLineId?: string;
  }): Promise<ApiResponse<PlatformRegistrationRequest>> => {
    const response = await api.post<ApiResponse<PlatformRegistrationRequest>>('/auth/register', payload);
    return response.data;
  },

  listUsers: async (): Promise<ApiResponse<PlatformUser[]>> => {
    const response = await api.get<ApiResponse<PlatformUser[]>>('/auth/users');
    return response.data;
  },

  listPublicProductLines: async (): Promise<ApiResponse<PlatformProductLine[]>> => {
    const response = await api.get<ApiResponse<PlatformProductLine[]>>('/auth/product-lines/public');
    return response.data;
  },

  listProductLines: async (): Promise<ApiResponse<PlatformProductLine[]>> => {
    const response = await api.get<ApiResponse<PlatformProductLine[]>>('/auth/product-lines');
    return response.data;
  },

  createProductLine: async (payload: {
    key?: string;
    name: string;
    projectId?: string;
    bundleId?: string;
    jenkinsBaseUrl?: string;
  }): Promise<ApiResponse<PlatformProductLine>> => {
    const response = await api.post<ApiResponse<PlatformProductLine>>('/auth/product-lines', payload);
    return response.data;
  },

  updateProductLine: async (id: string, payload: {
    name?: string;
    projectId?: string;
    bundleId?: string;
    jenkinsBaseUrl?: string;
    active?: boolean;
  }): Promise<ApiResponse<PlatformProductLine>> => {
    const response = await api.patch<ApiResponse<PlatformProductLine>>(`/auth/product-lines/${encodeURIComponent(id)}`, payload);
    return response.data;
  },

  getProductLineServices: async (id: string): Promise<ApiResponse<ProductLineServiceConfig>> => {
    const response = await api.get<ApiResponse<ProductLineServiceConfig>>(`/auth/product-lines/${encodeURIComponent(id)}/services`);
    return response.data;
  },

  getProductLineComponentRepositories: async (id: string): Promise<ApiResponse<ProductLineComponentRepository[]>> => {
    const response = await api.get<ApiResponse<ProductLineComponentRepository[]>>(`/auth/product-lines/${encodeURIComponent(id)}/component-repositories`);
    return response.data;
  },

  getProductLineTestFlightGroups: async (id: string): Promise<ApiResponse<ProductLineTestFlightGroup[]>> => {
    const response = await api.get<ApiResponse<ProductLineTestFlightGroup[]>>(`/auth/product-lines/${encodeURIComponent(id)}/app-store/testflight-groups`);
    return response.data;
  },

  updateProductLineServices: async (id: string, payload: ProductLineServiceUpdate): Promise<ApiResponse<ProductLineServiceConfig>> => {
    const response = await api.put<ApiResponse<ProductLineServiceConfig>>(`/auth/product-lines/${encodeURIComponent(id)}/services`, payload);
    return response.data;
  },

  syncProductLinePodxConfig: async (id: string): Promise<ApiResponse<ProductLinePodxConfigSyncResult>> => {
    const response = await api.post<ApiResponse<ProductLinePodxConfigSyncResult>>(`/auth/product-lines/${encodeURIComponent(id)}/sync-podx-config`);
    return response.data;
  },

  getPlatformConfig: async (): Promise<ApiResponse<PlatformConfigStatus>> => {
    const response = await api.get<ApiResponse<PlatformConfigStatus>>('/auth/platform-config');
    return response.data;
  },

  getRuntimeConfigStatus: async (): Promise<ApiResponse<PlatformConfigStatus>> => {
    const response = await api.get<ApiResponse<PlatformConfigStatus>>('/auth/runtime-config-status');
    return response.data;
  },

  updatePlatformConfig: async (payload: {
    currentPassword?: string;
    newAdminPassword?: string;
    releaseVerificationPassword?: string;
    aiApiKey?: string;
  }): Promise<ApiResponse<PlatformConfigStatus>> => {
    const response = await api.put<ApiResponse<PlatformConfigStatus>>('/auth/platform-config', payload);
    return response.data;
  },

  listRegistrationRequests: async (): Promise<ApiResponse<PlatformRegistrationRequest[]>> => {
    const response = await api.get<ApiResponse<PlatformRegistrationRequest[]>>('/auth/registration-requests');
    return response.data;
  },

  approveRegistrationRequest: async (id: string): Promise<ApiResponse<{
    request: PlatformRegistrationRequest;
    user: PlatformUser;
  }>> => {
    const response = await api.post<ApiResponse<{
      request: PlatformRegistrationRequest;
      user: PlatformUser;
    }>>(`/auth/registration-requests/${encodeURIComponent(id)}/approve`);
    return response.data;
  },

  rejectRegistrationRequest: async (id: string, message?: string): Promise<ApiResponse<PlatformRegistrationRequest>> => {
    const response = await api.post<ApiResponse<PlatformRegistrationRequest>>(
      `/auth/registration-requests/${encodeURIComponent(id)}/reject`,
      { message },
    );
    return response.data;
  },

  createUser: async (payload: {
    username: string;
    displayName?: string;
    password: string;
    role: PlatformRole;
    productLines?: Array<{ productLineId: string; role: PlatformRole; appStoreRelease?: boolean }>;
  }): Promise<ApiResponse<PlatformUser>> => {
    const response = await api.post<ApiResponse<PlatformUser>>('/auth/users', payload);
    return response.data;
  },

  updateUser: async (id: string, payload: {
    displayName?: string;
    password?: string;
    role?: PlatformRole;
    active?: boolean;
    productLines?: Array<{ productLineId: string; role: PlatformRole; appStoreRelease?: boolean }>;
  }): Promise<ApiResponse<PlatformUser>> => {
    const response = await api.patch<ApiResponse<PlatformUser>>(`/auth/users/${id}`, payload);
    return response.data;
  },

  deleteUser: async (id: string): Promise<ApiResponse> => {
    const response = await api.delete<ApiResponse>(`/auth/users/${encodeURIComponent(id)}`);
    return response.data;
  },
};

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
    const url = `/api/dsym/${uuid}/download`;
    
    // 创建一个隐藏的 a 标签来触发下载
    const link = document.createElement('a');
    link.href = url;
    link.download = `${appName}_${version}_${uuid.substring(0, 8)}.dSYM.zip`;
    
    // 登录态使用 HttpOnly Cookie，通过 fetch 下载。
    if (authUtils.isAuthenticated()) {
      fetch(url, {
        credentials: 'include',
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

export interface ServiceAccessVisitor {
  visitorId: string;
  role: 'admin' | 'user' | string;
  username?: string;
  displayName?: string;
  platformRole?: PlatformRole | string;
  identity?: string;
  ip: string;
  accessHost?: string;
  userAgent: string;
  firstPath: string;
  lastPath: string;
  firstSeen: string;
  lastSeen: string;
  visitCount: number;
}

export interface ServiceAccessPathStat {
  path: string;
  visitors: number;
  visits: number;
}

export interface ServiceAccessSummary {
  totals: {
    totalVisitors: number;
    totalVisits: number;
    adminVisitors: number;
    todayVisitors: number;
    todayVisits: number;
  };
  recentVisitors: ServiceAccessVisitor[];
  topPaths: ServiceAccessPathStat[];
}

export interface AssistantSemanticResolution {
  rawInput: string;
  mode: 'deterministic' | 'model_fallback';
  toolName?: string;
  availableToolCount?: number;
  productLineId?: string;
  createdAt: string;
}

export interface AssistantSemanticSearchMiss {
  toolName: string;
  rawQuery: string;
  cleanedQuery: string;
  tokens: string[];
  productLineId?: string;
  createdAt: string;
}

export interface AssistantSemanticStats {
  totals: {
    resolutions: number;
    deterministic: number;
    modelFallback: number;
    searchMisses: number;
  };
  topTools: Array<{ toolName: string; count: number }>;
  recentResolutions: AssistantSemanticResolution[];
  recentSearchMisses: AssistantSemanticSearchMiss[];
}

export interface AssistantCapabilityDatasetStatus {
  datasetDir: string;
  files: number;
  total: number;
  byDomain: Record<string, number>;
  sources: Record<string, number>;
}

export interface AssistantCapabilitySyncResult {
  syncedAt: string;
  totalSynced: number;
  results: Array<{
    source: string;
    syncedAt: string;
    received: number;
    synced: number;
    total: number;
    datasetPath: string;
  }>;
}

export interface OpFeedbackLogInfo {
  id?: string;
  userId?: string | number;
  type?: string | number;
  type_dictText?: string;
  logType_dictText?: string;
  reqChannel_dictText?: string;
  showVersion?: string;
  version?: string;
  crashLogUrl?: string;
  crashTime?: string;
  createTime?: string;
}

export interface RtcLogRetrieveTaskInfo {
  id?: string;
  userId?: string | number;
  beginTime?: string;
  endTime?: string;
  taskTime?: string;
  status?: string | number;
  status_dictText?: string;
  reqChannelStatus?: string;
}

export interface RtcLogRetrieveTaskListResult {
  records: RtcLogRetrieveTaskInfo[];
  total: number;
  pageNo: number;
  pageSize: number;
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

export interface FeedbackLogArchiveAnalysisFile {
  name: string;
  path: string;
  lineCount: number;
  size: number;
}

export interface FeedbackLogArchiveAnalysisResult {
  files: FeedbackLogArchiveAnalysisFile[];
  lines: string[];
  lineCount: number;
  apiRequestSampleCount?: number;
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

export const syncCurrentOpAccessToken = async (): Promise<string> => {
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

const formatOpDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
          query: uid,
          reqChannel: 1,
          column: 'createTime',
          order: 'desc',
          field: 'id,,action,userId,type,type_dictText,logType_dictText,reqChannel_dictText,version,crashLogUrl,crashTime,createTime',
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
  createRtcLogRetrieveTask: async (uid: string | number): Promise<void> => {
    await syncCurrentOpAccessToken();
    const beginDate = new Date();
    const endDate = new Date(beginDate);
    endDate.setDate(beginDate.getDate() + 4);

    let response;
    try {
      response = await axios.post('/jeecg-boot/bms/rtc/log/task/add', {
        userId: String(uid),
        beginTime: formatOpDate(beginDate),
        endTime: formatOpDate(endDate),
        reqChannel: [1],
      }, {
        timeout: 60000,
      });
    } catch (error: any) {
      throw new Error(toOpErrorMessage(error, '创建日志回捞任务失败'));
    }

    const payload = response.data;
    if (
      payload &&
      (
        payload.success === false ||
        (payload.code !== undefined && ![0, 200].includes(Number(payload.code))) ||
        (payload.retCode !== undefined && !['0', '100', '200'].includes(String(payload.retCode)))
      )
    ) {
      throw new Error(payload.message || payload.error || '创建日志回捞任务失败');
    }
  },
  rtcLogRetrieveTasks: async (uid: string | number, pageNo = 1, pageSize = 10): Promise<RtcLogRetrieveTaskListResult> => {
    await syncCurrentOpAccessToken();
    let response;
    try {
      response = await axios.post('/jeecg-boot/bms/rtc/log/task/list', {
        userId: String(uid),
        status: 1,
        column: 'createTime',
        order: 'desc',
        field: 'id,,userId,beginTime,status,reqChannelStatus,action',
        pageNo,
        pageSize,
      }, {
        timeout: 60000,
      });
    } catch (error: any) {
      throw new Error(toOpErrorMessage(error, '查询日志回捞任务失败'));
    }

    const payload = response.data;
    if (
      payload &&
      (
        payload.success === false ||
        (payload.code !== undefined && ![0, 200].includes(Number(payload.code))) ||
        (payload.retCode !== undefined && !['0', '100', '200'].includes(String(payload.retCode)))
      )
    ) {
      throw new Error(payload.message || payload.error || '查询日志回捞任务失败');
    }

    const result = payload?.result || payload?.data || payload?.retData || payload;
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
  analyzeArchive: async (archive: Blob): Promise<FeedbackLogArchiveAnalysisResult> => {
    const response = await api.post<ApiResponse<FeedbackLogArchiveAnalysisResult>>('/feedback-log/analyze-archive', archive, {
      headers: { 'Content-Type': 'application/zip' },
      timeout: 120000,
    });
    if (!response.data.data) {
      throw new Error(response.data.error || '分析 NN 日志失败');
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

const getServiceVisitorId = (): string => {
  const key = 'service_access_visitor_id';
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const nextId = `visitor_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(key, nextId);
  return nextId;
};

export const accessStatsApi = {
  track: async (path: string): Promise<void> => {
    const currentUser = authUtils.getUser();
    await api.post('/access-stats/track', {
      visitorId: getServiceVisitorId(),
      path,
      isAdmin: authUtils.isAdmin(),
      username: currentUser?.username,
      displayName: currentUser?.displayName,
      role: authUtils.getActiveRole() || currentUser?.role,
      accessHost: window.location.hostname,
    }).catch(() => {});
  },
  summary: async (): Promise<ServiceAccessSummary> => {
    const response = await api.get<ApiResponse<ServiceAccessSummary>>('/access-stats/summary');
    return response.data.data || {
      totals: {
        totalVisitors: 0,
        totalVisits: 0,
        adminVisitors: 0,
        todayVisitors: 0,
        todayVisits: 0,
      },
      recentVisitors: [],
      topPaths: [],
    };
  },
};

export const assistantInsightsApi = {
  semanticStats: async (limit = 50): Promise<AssistantSemanticStats> => {
    const response = await api.get<ApiResponse<AssistantSemanticStats>>('/assistant/semantic/stats', { params: { limit } });
    return response.data.data || {
      totals: { resolutions: 0, deterministic: 0, modelFallback: 0, searchMisses: 0 },
      topTools: [],
      recentResolutions: [],
      recentSearchMisses: [],
    };
  },
  capabilityDatasetStatus: async (): Promise<AssistantCapabilityDatasetStatus> => {
    const response = await api.get<ApiResponse<AssistantCapabilityDatasetStatus>>('/assistant/datasets/capabilities/status');
    return response.data.data || { datasetDir: '', files: 0, total: 0, byDomain: {}, sources: {} };
  },
  syncCapabilityEntrances: async (): Promise<AssistantCapabilitySyncResult> => {
    const response = await api.post<ApiResponse<AssistantCapabilitySyncResult>>('/assistant/datasets/capabilities/sync-from-entrances');
    return response.data.data || { syncedAt: '', totalSynced: 0, results: [] };
  },
};

export const symbolicateApi = {
  /**
   * 符号化崩溃日志
   */
  symbolicate: async (
    crashLog: string,
    uuids?: string[],
    options?: {
      saveHistory?: boolean;
      mainAppBranch?: string;
    }
  ): Promise<ApiResponse<SymbolicationResult>> => {
    const response = await api.post<ApiResponse<SymbolicationResult>>('/symbolicate', {
      crashLog,
      uuids,
      saveHistory: options?.saveHistory,
      mainAppBranch: options?.mainAppBranch,
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
    appVersion: string,
    originalLog?: string
  ): Promise<void> => {
    try {
      const response = await fetch('/api/symbolicate/download', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          symbolicatedLog,
          originalLog,
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

async function getSentryGovernanceConfigForClient() {
  const productLineId = authUtils.getActiveProductLine()?.id || 'nn';
  if (sentryGovernanceConfigCache
    && sentryGovernanceConfigCache.productLineId === productLineId
    && Date.now() - sentryGovernanceConfigCache.loadedAt < 5 * 60 * 1000) {
    return sentryGovernanceConfigCache;
  }
  try {
    const response = await api.get<ApiResponse<CrashGovernanceConfig>>('/sentry-analysis/governance/config');
    const config = response.data.data;
    if (response.data.success && config) {
      sentryGovernanceConfigCache = {
        excludedVersions: config.excludedVersions || fallbackExcludedSentryAppVersions(),
        defaultIssueQuery: config.defaultIssueQuery || fallbackSentryIssueQuery(),
        sentryOrganization: config.sentryOrganization,
        sentryProject: config.sentryProject,
        sentryProxyPath: config.sentryProxyPath,
        productLineId,
        loadedAt: Date.now(),
      };
      return sentryGovernanceConfigCache;
    }
  } catch {
    // 配置读取失败时使用兜底版本，避免影响 Sentry 列表展示。
  }
  return {
    excludedVersions: fallbackExcludedSentryAppVersions(),
    defaultIssueQuery: fallbackSentryIssueQuery(),
    sentryOrganization: productLineId === 'nn' ? 'sentry' : '',
    sentryProject: productLineId === 'nn' ? 'nn-ios' : '',
    sentryProxyPath: productLineId === 'nn' ? '/organizations/sentry/projects/nn-ios/' : '/',
    productLineId,
    loadedAt: Date.now(),
  };
}

function buildAppVersionRange(values: string[], excludedVersions: string[] = fallbackExcludedSentryAppVersions()) {
  const excludedAppVersions = new Set(excludedVersions);
  const versions = Array.from(new Set(values.filter((version) =>
    Boolean(version) && !excludedAppVersions.has(version)
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

function normalizeSentryIssue(issue: any, excludedVersions: string[] = fallbackExcludedSentryAppVersions()): SentryIssueSummary {
  const range = buildAppVersionRange(collectAppVersions(issue), excludedVersions);
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
  const productLine = authUtils.getActiveProductLine();
  const response = await fetch(`/sentry${path}`, {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(productLine ? { 'X-Product-Line-Id': productLine.id } : {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Sentry API failed: ${response.status} ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

async function enrichSentryIssueVersionRange(issue: SentryIssueSummary): Promise<SentryIssueSummary> {
  const config = await getSentryGovernanceConfigForClient();
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
      query: `${issue.shortId || issue.id} ${config.excludedVersions.map((version) => `!release:"${version.replace(/"/g, '\\"')}"`).join(' ')}`.trim(),
      field: 'release',
      per_page: '20',
    });
    try {
      const tagValues = await Promise.race([
        sentryProxyGet<any[]>(`/api/0/projects/${encodeURIComponent(config.sentryOrganization || '')}/${encodeURIComponent(config.sentryProject || '')}/tags/release/values/?${releaseQuery.toString()}`),
        timeout<any[]>('Sentry release tag values timeout'),
      ]);
      versions.push(...(Array.isArray(tagValues) ? tagValues.map((item) => item.value || item.name || item.key) : []));
    } catch {
      // tag values 兜底失败也不阻塞列表。
    }
  }

  const range = buildAppVersionRange(versions, config.excludedVersions);
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
  const config = await getSentryGovernanceConfigForClient();
  const period = params.period || '24h';
  const limit = Math.min(Math.max(params.limit || 5, 1), 20);
  const query = params.query || config.defaultIssueQuery || 'is:unresolved';
  const search = new URLSearchParams({
    query,
    sort: 'date',
    limit: String(limit),
  });

  search.set('statsPeriod', period === '7d' ? '14d' : period);

  if (!config.sentryOrganization || !config.sentryProject) {
    throw new Error('当前产品线未配置 Sentry Organization 或 Project');
  }

  const data = await sentryProxyGet<any[] | { results?: any[] }>(
    `/api/0/projects/${encodeURIComponent(config.sentryOrganization)}/${encodeURIComponent(config.sentryProject)}/issues/?${search.toString()}`
  );
  const rawIssues = Array.isArray(data) ? data : data?.results || [];
  const issues = rawIssues
    .map((issue) => normalizeSentryIssue(issue, config.excludedVersions))
    .filter((issue) => {
      if (period !== '7d') {
        return true;
      }
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
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
  governanceDashboard: async (): Promise<ApiResponse<CrashGovernanceDashboard>> => {
    const response = await api.get<ApiResponse<CrashGovernanceDashboard>>(
      '/sentry-analysis/governance/dashboard',
      { timeout: 60000 }
    );
    return response.data;
  },

  governanceConfig: async (): Promise<ApiResponse<CrashGovernanceConfig>> => {
    const response = await api.get<ApiResponse<CrashGovernanceConfig>>(
      '/sentry-analysis/governance/config'
    );
    return response.data;
  },

  updateGovernanceConfig: async (
    payload: { excludedVersions: string[] }
  ): Promise<ApiResponse<CrashGovernanceConfig>> => {
    const response = await api.patch<ApiResponse<CrashGovernanceConfig>>(
      '/sentry-analysis/governance/config',
      payload
    );
    if (response.data.success && response.data.data) {
      sentryGovernanceConfigCache = {
        excludedVersions: response.data.data.excludedVersions || fallbackExcludedSentryAppVersions(),
        defaultIssueQuery: response.data.data.defaultIssueQuery || fallbackSentryIssueQuery(),
        sentryOrganization: response.data.data.sentryOrganization || sentryGovernanceConfigCache?.sentryOrganization,
        sentryProject: response.data.data.sentryProject || sentryGovernanceConfigCache?.sentryProject,
        sentryProxyPath: response.data.data.sentryProxyPath || sentryGovernanceConfigCache?.sentryProxyPath,
        productLineId: authUtils.getActiveProductLine()?.id || 'nn',
        loadedAt: Date.now(),
      };
    }
    return response.data;
  },

  syncGovernance: async (params: {
    period?: string;
    limit?: number;
    query?: string;
  } = {}): Promise<ApiResponse<{
    period: string;
    query: string;
    total: number;
    records: CrashGovernanceRecord[];
  }>> => {
    const response = await api.post<ApiResponse<{
      period: string;
      query: string;
      total: number;
      records: CrashGovernanceRecord[];
    }>>(
      '/sentry-analysis/governance/sync',
      params,
      { timeout: 180000 }
    );
    return response.data;
  },

  updateGovernanceStatus: async (
    id: number,
    payload: {
      governanceStatus: CrashGovernanceStatus;
      owner?: string;
      fixedVersion?: string;
      fixedRemark?: string;
      ignoreReason?: string;
    }
  ): Promise<ApiResponse<CrashGovernanceRecord>> => {
    const response = await api.patch<ApiResponse<CrashGovernanceRecord>>(
      `/sentry-analysis/governance/issues/${id}/status`,
      payload
    );
    return response.data;
  },

  updateGovernanceFingerprintStatus: async (
    id: number,
    payload: {
      governanceStatus: CrashGovernanceStatus;
      owner?: string;
      fixedVersion?: string;
      fixedRemark?: string;
      ignoreReason?: string;
    }
  ): Promise<ApiResponse<CrashGovernanceFingerprintGroup>> => {
    const response = await api.patch<ApiResponse<CrashGovernanceFingerprintGroup>>(
      `/sentry-analysis/governance/issues/${id}/fingerprint/status`,
      payload
    );
    return response.data;
  },

  governanceIssueDetail: async (
    id: number
  ): Promise<ApiResponse<{ record: CrashGovernanceRecord; history?: HistoryRecord; fingerprintGroup?: CrashGovernanceFingerprintGroup; events?: CrashGovernanceEvent[] }>> => {
    const response = await api.get<ApiResponse<{ record: CrashGovernanceRecord; history?: HistoryRecord; fingerprintGroup?: CrashGovernanceFingerprintGroup; events?: CrashGovernanceEvent[] }>>(
      `/sentry-analysis/governance/issues/${id}`
    );
    return response.data;
  },

  refreshGovernanceCoverage: async (
    id: number
  ): Promise<ApiResponse<CrashGovernanceRecord>> => {
    const response = await api.post<ApiResponse<CrashGovernanceRecord>>(
      `/sentry-analysis/governance/issues/${id}/refresh-coverage`,
      {},
      { timeout: 60000 }
    );
    return response.data;
  },

  refreshGovernanceCoverageByVersion: async (
    appVersion: string
  ): Promise<ApiResponse<{
    appVersion: string;
    total: number;
    refreshed: number;
    skipped: number;
    records: CrashGovernanceRecord[];
  }>> => {
    const response = await api.post<ApiResponse<{
      appVersion: string;
      total: number;
      refreshed: number;
      skipped: number;
      records: CrashGovernanceRecord[];
    }>>(
      `/sentry-analysis/governance/versions/${encodeURIComponent(appVersion)}/refresh-coverage`,
      {},
      { timeout: 120000 }
    );
    return response.data;
  },

  governanceIssues: async (params: {
    status?: CrashGovernanceStatus | 'open' | 'all';
    source?: 'sentry' | 'quality' | 'manual' | 'all';
    appVersion?: string;
    dsymCoverageStatus?: string;
    symbolicationStatus?: string;
    symbolicationFailureCategory?: string;
    analysisStatus?: string;
    owner?: string;
    keyword?: string;
    limit?: number;
  } = {}): Promise<ApiResponse<{ issues: CrashGovernanceRecord[] }>> => {
    const query = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== '' && value !== 'all')
    );
    const response = await api.get<ApiResponse<{ issues: CrashGovernanceRecord[] }>>(
      '/sentry-analysis/governance/issues',
      { params: query }
    );
    return response.data;
  },

  governanceEvents: async (params: {
    scope?: string;
    toStatus?: string;
    operator?: string;
    keyword?: string;
    limit?: number;
  } = {}): Promise<ApiResponse<{ events: CrashGovernanceEvent[] }>> => {
    const query = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== '' && value !== 'all')
    );
    const response = await api.get<ApiResponse<{ events: CrashGovernanceEvent[] }>>(
      '/sentry-analysis/governance/events',
      { params: query }
    );
    return response.data;
  },

  exportGovernanceEvents: async (params: {
    scope?: string;
    toStatus?: string;
    operator?: string;
    keyword?: string;
    limit?: number;
  } = {}): Promise<void> => {
    const query = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== '' && value !== 'all')
    );
    const response = await api.get<Blob>('/sentry-analysis/governance/events/export', {
      params: query,
      responseType: 'blob',
    });
    const blobUrl = window.URL.createObjectURL(response.data);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `crash-governance-events-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(blobUrl);
  },

  analyzeGovernanceIssue: async (
    id: number,
    apiKey?: string
  ): Promise<ApiResponse<{ record: CrashGovernanceRecord; message: string }>> => {
    const response = await api.post<ApiResponse<{ record: CrashGovernanceRecord; message: string }>>(
      `/sentry-analysis/governance/issues/${id}/analyze`,
      { apiKey },
      { timeout: 30000 }
    );
    return response.data;
  },

  listIssues: async (params: {
    period: string;
    limit: number;
    query?: string;
  }): Promise<ApiResponse<SentryIssueListResult>> => {
    try {
      const proxyResponse = await listSentryIssuesFromProxy(params);
      const issues = proxyResponse.data?.issues || [];
      if (issues.length === 0) {
        return proxyResponse;
      }

      api.post<ApiResponse<{
        total: number;
        synced: number;
        issues: SentryIssueSummary[];
      }>>('/sentry-analysis/sync-issues', { issues }, { timeout: 60000 }).catch(() => {
        // Workflow 同步失败不影响 Sentry 列表本身可用。
      });

      return proxyResponse;
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
    const url = `/api/history/${id}/download`;
    
    // 创建一个隐藏的 a 标签来触发下载
    const link = document.createElement('a');
    link.href = url;
    link.download = `crash_report_${appVersion}_${Date.now()}.zip`;
    
    if (authUtils.isAuthenticated()) {
      fetch(url, {
        credentials: 'include',
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
  updateFixedStatus: async (id: number, isFixed: boolean, fixedVersion?: string, fixedRemark?: string): Promise<ApiResponse> => {
    const response = await api.patch<ApiResponse>(`/history/${id}/fixed`, {
      isFixed,
      fixedVersion,
      fixedRemark,
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
    file: File | undefined,
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
    if (file) {
      formData.append('file', file, file.name);
    }
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
    target_branch?: string;
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
    target_branch?: string;
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
    target_branch?: string;
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
  productLineId?: string;
  podx?: {
    productLineId: string;
    targetName: string;
    privateSource: string;
    gitBaseUrl: string;
    overlayFile: string;
    publishRepos: string[];
    publishRepoUrls: string[];
    publishMainRepo: string;
    publishWorkDir: string;
    publishBaseBranch: string;
    jenkinsBaseUrl: string;
    jenkinsJob: string;
    jenkinsQualityJob: string;
    jenkinsRepoUrl: string;
  };
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
   * 并用发布主仓库同名分支 Podfile 反查版本
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
    const response = await fetch('/api/git/branch-jobs/stream', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
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
  dsymSync?: JenkinsBuildDsymSync;
  testFlightWhatsNew?: string;
  testFlightDistribution?: JenkinsTestFlightDistribution;
  appStoreRelease?: JenkinsAppStoreRelease;
  releaseOrder?: JenkinsReleaseOrder;
}

export interface JenkinsReleaseOrderEvent {
  id: string;
  type: string;
  title: string;
  status: 'success' | 'processing' | 'warning' | 'error' | 'default' | string;
  detail?: string;
  at: string;
  payload?: Record<string, unknown>;
}

export interface JenkinsReleaseOrder {
  id: string;
  branch: string;
  deployTarget: 'Pgyer' | 'TestFlight' | 'AppStore' | string;
  appVersion?: string;
  releaseNotes?: string;
  gateBuildNumber?: number;
  releaseGateOverrideReason?: string;
  jenkinsQueueUrl?: string;
  jenkinsBuildNumber?: number;
  jenkinsBuildUrl?: string;
  channelBuildNumber?: string;
  status?: string;
  phase?: string;
  failureReason?: string;
  createdAt?: string;
  updatedAt?: string;
  events?: JenkinsReleaseOrderEvent[];
}

export interface JenkinsTestFlightDistribution {
  status?: 'waiting_processing' | 'distributed' | 'failed' | 'skipped' | 'unconfirmed' | 'uploaded' | 'ready_for_submission' | 'in_beta_review';
  appVersion?: string;
  buildNumber?: string;
  appStoreBuildId?: string;
  betaAppReviewSubmissionId?: string;
  processingState?: string;
  internalBuildState?: string;
  externalBuildState?: string;
  groups?: Array<{ id: string; name: string }>;
  whatsNew?: string;
  message?: string;
  updatedAt?: string;
}

export interface JenkinsAppStoreRelease {
  status?: 'waiting_processing' | 'ready_for_review' | 'waiting_for_review' | 'in_review' | 'pending_release' | 'ready_for_distribution' | 'ready_for_sale' | 'rejected' | 'developer_rejected' | 'developer_action_needed' | 'pending_agreement' | 'failed' | 'skipped' | 'unconfirmed' | 'uploaded';
  appVersion?: string;
  buildNumber?: string;
  appStoreBuildId?: string;
  appStoreVersionId?: string;
  reviewSubmissionId?: string;
  processingState?: string;
  appStoreState?: string;
  releaseNotes?: string;
  releaseType?: string;
  failureReason?: string;
  message?: string;
  updatedAt?: string;
}

export interface JenkinsAppStoreReleaseGuard {
  blocked: boolean;
  branch: string;
  appVersion: string;
  appStoreVersionId?: string;
  appStoreState?: string;
  status?: JenkinsAppStoreRelease['status'];
  latestAppStoreVersion?: string;
  message?: string;
}

export interface JenkinsReleasePreflightCheck {
  key: string;
  label: string;
  status: 'passed' | 'warning' | 'blocked';
  message: string;
  details?: Record<string, unknown>;
}

export interface JenkinsReleasePreflightResult {
  passed: boolean;
  branch: string;
  deployTarget: 'Pgyer' | 'TestFlight' | 'AppStore' | string;
  appVersion?: string;
  blockers: JenkinsReleasePreflightCheck[];
  warnings: JenkinsReleasePreflightCheck[];
  checks: JenkinsReleasePreflightCheck[];
}

export interface JenkinsCicdHealthResult {
  healthy: boolean;
  blockers: JenkinsReleasePreflightCheck[];
  warnings: JenkinsReleasePreflightCheck[];
  checks: JenkinsReleasePreflightCheck[];
  checkedAt: string;
  elapsedMs: number;
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
  failureAnalysis?: JenkinsBuildFailureAnalysis;
  failureAnalysisUpdatedAt?: string;
  dsymSync?: JenkinsBuildDsymSync;
  testFlightWhatsNew?: string;
  testFlightDistribution?: JenkinsTestFlightDistribution;
  appStoreRelease?: JenkinsAppStoreRelease;
  releaseOrder?: JenkinsReleaseOrder;
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

export interface JenkinsPackageSizeAnalysis {
  jobName: string;
  buildNumber: number;
  appVersion?: string;
  publishChannel?: string;
  channelBuildNumber?: string;
  ipaPath?: string;
  ipaUrl?: string;
  totalBytes: number;
  totalText: string;
  uncompressedBytes: number;
  uncompressedText: string;
  warnings?: string[];
  cached?: boolean;
  updatedAt?: string;
  comparison?: {
    baseline: {
      buildNumber: number;
      appVersion?: string;
      publishChannel?: string;
      channelBuildNumber?: string;
      branchName?: string;
      totalBytes?: number;
      totalText?: string;
      uncompressedBytes?: number;
      uncompressedText?: string;
      updatedAt?: string;
    };
    deltaBytes: number;
    deltaText: string;
    deltaPercent: number | null;
    deltaUncompressedBytes: number;
    deltaUncompressedText: string;
    deltaUncompressedPercent: number | null;
    entries: Array<{
      key: string;
      type: string;
      name: string;
      path: string;
      bytes: number;
      text: string;
      baselineBytes: number;
      baselineText: string;
      deltaBytes: number;
      deltaText: string;
      deltaPercent: number | null;
    }>;
  } | null;
  entries: Array<{
    key: string;
    type: string;
    name: string;
    path: string;
    bytes: number;
    text: string;
    percent: number;
    fileCount: number;
  }>;
}

export interface JenkinsBuildDsymSync {
  buildNumber: number;
  status: 'running' | 'success' | 'partial' | 'failed';
  message?: string;
  appVersion?: string;
  publishChannel?: string;
  xcarchivePath?: string;
  updatedAt?: string;
  main?: DSYMInfo & {
    skipped?: boolean;
    message?: string;
  };
  components?: Array<{
    name: string;
    version: string;
    status: 'linked' | 'missing';
    uuids?: string[];
    message?: string;
  }>;
  thirdSdkBranch?: string;
  thirdSdkRevision?: string;
  thirdSdkError?: string;
}

export interface JenkinsBuildFailureAnalysis {
  summary: string;
  stage: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  rootCause: string;
  evidence: string[];
  suggestions: string[];
  ownerHint?: string;
  needsManualAction?: boolean;
}

export type JenkinsQualitySuite = 'smoke' | 'im' | 'rtc' | 'monkey' | 'stutter' | 'business_flow' | 'replay_flow' | 'full';

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
    businessFlow?: {
      name?: string;
      status?: string;
      message?: string;
      totalSteps?: number;
      passedSteps?: number;
      failedSteps?: number;
      skippedSteps?: number;
      durationMs?: number;
      riskPolicy?: string;
      stopOnFailure?: boolean;
      steps?: Array<{
        id?: string;
        type?: string;
        label?: string;
        domain?: string;
        path?: string;
        status?: string;
        durationMs?: number;
        message?: string;
        riskLevel?: string;
        guarded?: boolean;
        lastAction?: string;
      }>;
      issues?: Array<{ severity?: string; message?: string; stepId?: string; path?: string }>;
    };
    replayFlow?: {
      name?: string;
      status?: string;
      iterationCount?: number;
      durationSeconds?: number;
      stopOnFailure?: boolean;
      manifestId?: string;
      phases?: Array<{
        phase?: 'pre' | 'main' | 'post';
        assetId?: string;
        assetName?: string;
        versionId?: string;
        versionNumber?: number;
      }>;
    };
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
      businessFlowReportUrl?: string;
      replayFlowReportUrl?: string;
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

export type QualityTaskType = 'ios_monkey' | 'ios_stutter' | 'ios_business_flow' | 'ios_smoke' | 'ios_login' | 'ios_im' | 'ios_rtc' | 'ios_full';
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

export interface QualityDevicePool {
  label: string;
  value: string;
  description: string;
  deviceId?: string;
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

export interface QualityDevicePoolStatusResult {
  pools: QualityDevicePool[];
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
    branch?: string;
  }): Promise<ApiResponse<JenkinsBuildListResult>> => {
    const response = await api.get<ApiResponse<JenkinsBuildListResult>>('/jenkins/nn/builds', { params });
    return response.data;
  },

  publishNN: async (payload: {
    deployTarget: 'Pgyer' | 'TestFlight' | 'AppStore';
    verificationPassword?: string;
    branch?: string;
    appVersion?: string;
    gateBuildNumber?: number;
    releaseGateOverrideReason?: string;
    testFlightWhatsNew?: string;
  }): Promise<ApiResponse<{ jobName: string; url: string; deployTarget: string; branch: string; jenkinsBranch?: string; sourceBuildNumber?: number; releaseGate?: WorkflowReleaseGate; releaseOrder?: JenkinsReleaseOrder }>> => {
    const response = await api.post<ApiResponse<{ jobName: string; url: string; deployTarget: string; branch: string; jenkinsBranch?: string; sourceBuildNumber?: number; releaseGate?: WorkflowReleaseGate; releaseOrder?: JenkinsReleaseOrder }>>('/jenkins/nn/build', payload);
    return response.data;
  },

  preflightRelease: async (payload: {
    deployTarget: 'Pgyer' | 'TestFlight' | 'AppStore';
    branch?: string;
    appVersion?: string;
    gateBuildNumber?: number;
    testFlightWhatsNew?: string;
  }): Promise<ApiResponse<JenkinsReleasePreflightResult>> => {
    const response = await api.post<ApiResponse<JenkinsReleasePreflightResult>>('/jenkins/nn/release/preflight', payload);
    return response.data;
  },

  getCicdHealth: async (): Promise<ApiResponse<JenkinsCicdHealthResult>> => {
    const response = await api.get<ApiResponse<JenkinsCicdHealthResult>>('/jenkins/nn/cicd/health');
    return response.data;
  },

  previewReleaseGate: async (payload: {
    gateBuildNumber: number;
    branch?: string;
  }): Promise<ApiResponse<{
    build: JenkinsBuild;
    releaseGate: WorkflowReleaseGate;
    missingSuites: JenkinsQualitySuite[];
  }>> => {
    const response = await api.post<ApiResponse<{
      build: JenkinsBuild;
      releaseGate: WorkflowReleaseGate;
      missingSuites: JenkinsQualitySuite[];
    }>>('/jenkins/nn/release-gate/preview', payload);
    return response.data;
  },

  checkAppStoreReleaseGuard: async (payload: {
    branch: string;
  }): Promise<ApiResponse<JenkinsAppStoreReleaseGuard>> => {
    const response = await api.post<ApiResponse<JenkinsAppStoreReleaseGuard>>('/jenkins/nn/app-store/release-guard', payload);
    return response.data;
  },

  submitAppStoreReview: async (buildNumber: number): Promise<ApiResponse<JenkinsAppStoreRelease>> => {
    const response = await api.post<ApiResponse<JenkinsAppStoreRelease>>(`/jenkins/nn/builds/${buildNumber}/submit-app-store-review`);
    return response.data;
  },

  cancelAppStoreReview: async (buildNumber: number): Promise<ApiResponse<JenkinsAppStoreRelease>> => {
    const response = await api.post<ApiResponse<JenkinsAppStoreRelease>>(`/jenkins/nn/builds/${buildNumber}/cancel-app-store-review`);
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

  getBuildPackageSize: async (buildNumber: number, force = false): Promise<ApiResponse<JenkinsPackageSizeAnalysis>> => {
    const response = await api.get<ApiResponse<JenkinsPackageSizeAnalysis>>(`/jenkins/nn/builds/${buildNumber}/package-size`, {
      timeout: 120000,
      params: force ? { force: 1 } : undefined,
    });
    return response.data;
  },

  analyzeBuildFailure: async (buildNumber: number, force = false): Promise<ApiResponse<{ jobName: string; buildNumber: number; analysis: JenkinsBuildFailureAnalysis; updatedAt?: string; cached?: boolean }>> => {
    const response = await api.post<ApiResponse<{ jobName: string; buildNumber: number; analysis: JenkinsBuildFailureAnalysis; updatedAt?: string; cached?: boolean }>>(
      `/jenkins/nn/builds/${buildNumber}/analyze-failure`,
      { force },
      { timeout: 120000 },
    );
    return response.data;
  },

  syncBuildDsyms: async (buildNumber: number, force = false): Promise<ApiResponse<JenkinsBuildDsymSync>> => {
    const response = await api.post<ApiResponse<JenkinsBuildDsymSync>>(
      `/jenkins/nn/builds/${buildNumber}/sync-dsyms`,
      { force },
      { timeout: 600000 },
    );
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

  listQualityDevicePools: async (): Promise<ApiResponse<QualityDevicePool[]>> => {
    const response = await api.get<ApiResponse<QualityDevicePool[]>>('/jenkins/nn/quality/device-pools');
    assertQualityDevicePoolResponse(response.data, 'list');
    return response.data;
  },

  getQualityDevicePoolStatus: async (): Promise<ApiResponse<QualityDevicePoolStatusResult>> => {
    const response = await api.get<ApiResponse<QualityDevicePoolStatusResult>>('/jenkins/nn/quality/device-pools/status');
    assertQualityDevicePoolResponse(response.data, 'status');
    return response.data;
  },

  updateQualityDevicePools: async (devicePools: QualityDevicePool[]): Promise<ApiResponse<QualityDevicePool[]>> => {
    const response = await api.put<ApiResponse<QualityDevicePool[]>>('/jenkins/nn/quality/device-pools', { devicePools });
    assertQualityDevicePoolResponse(response.data, 'list');
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
    businessFlowPlan?: {
      name?: string;
      featureIds?: string[];
      maxDurationSeconds?: number;
      riskPolicy?: string;
      stopOnFailure?: boolean;
      steps?: Array<Record<string, unknown>>;
    };
    replayFlow?: {
      assetId: string;
      versionId: string;
      inputs?: Record<string, string>;
      durationSeconds: number;
      stopOnFailure: true;
    };
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

export interface AppleDeviceConfigStatus {
  configured: boolean;
  missing: string[];
  warnings?: string[];
  keyId?: string;
  issuerId?: string;
  keyPath?: string;
  keyPathConfigured?: boolean;
  keyFileName?: string;
  keyFileExists?: boolean;
  keyLooksLikeSubscriptionKey?: boolean;
  keyLooksLikeAppStoreConnectKey?: boolean;
}

export interface AppleDeviceEnrollment {
  id: string;
  createdAt: number;
  status: 'pending' | 'completed';
  device?: {
    udid: string;
    name?: string;
    product?: string;
    version?: string;
    serial?: string;
  };
}

export interface AppleDeviceEnrollmentCreateResult {
  sessionId: string;
  status: AppleDeviceEnrollment['status'];
  enrollUrl: string;
  expiresAt: string;
}

export interface AppleDeviceRegisterResult {
  id?: string;
  udid: string;
  name: string;
  platform: string;
  status?: string;
  alreadyExists: boolean;
  message: string;
}

export interface AppleDeviceRegistrationRequest {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: 'pending' | 'registered' | 'rejected';
  udid: string;
  name: string;
  platform: string;
  source?: {
    product?: string;
    version?: string;
    serial?: string;
  };
  appleDeviceId?: string;
  appleStatus?: string;
  alreadyExists?: boolean;
  alreadyPending?: boolean;
  message?: string;
}

export interface AppleDeviceRegistrationRequestListResult {
  requests: AppleDeviceRegistrationRequest[];
}

export interface AppleDeveloperDevice {
  id: string;
  name: string;
  udid: string;
  platform: string;
  status: string;
  deviceClass?: string;
  model?: string;
  addedDate?: string;
}

export interface AppleDeveloperDeviceListResult {
  devices: AppleDeveloperDevice[];
  total: number;
  platform: string;
  source?: 'apple' | 'cache';
  warning?: string;
}

export interface AppleDeveloperDeviceLookupResult {
  registered: boolean;
  device?: AppleDeveloperDevice;
  source?: 'apple' | 'cache';
  warning?: string;
}

export const appleDeviceApi = {
  status: async (): Promise<ApiResponse<AppleDeviceConfigStatus>> => {
    const response = await api.get<ApiResponse<AppleDeviceConfigStatus>>('/apple-devices/status');
    return response.data;
  },

  updateConfig: async (payload: {
    issuerId: string;
    keyFile?: File | null;
  }): Promise<ApiResponse<AppleDeviceConfigStatus & { message?: string }>> => {
    const formData = new FormData();
    formData.append('issuerId', payload.issuerId);
    if (payload.keyFile) formData.append('keyFile', payload.keyFile, payload.keyFile.name);
    const response = await api.post<ApiResponse<AppleDeviceConfigStatus & { message?: string }>>('/apple-devices/config', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    });
    return response.data;
  },

  listDevices: async (params?: { platform?: 'IOS' | 'MAC_OS'; limit?: number }): Promise<ApiResponse<AppleDeveloperDeviceListResult>> => {
    const response = await api.get<ApiResponse<AppleDeveloperDeviceListResult>>('/apple-devices/devices', { params });
    return response.data;
  },

  lookupDevice: async (udid: string): Promise<ApiResponse<AppleDeveloperDeviceLookupResult>> => {
    const response = await api.get<ApiResponse<AppleDeveloperDeviceLookupResult>>('/apple-devices/lookup', { params: { udid } });
    return response.data;
  },

  createEnrollment: async (): Promise<ApiResponse<AppleDeviceEnrollmentCreateResult>> => {
    const response = await api.post<ApiResponse<AppleDeviceEnrollmentCreateResult>>('/apple-devices/enrollments');
    return response.data;
  },

  getEnrollment: async (sessionId: string): Promise<ApiResponse<AppleDeviceEnrollment>> => {
    const response = await api.get<ApiResponse<AppleDeviceEnrollment>>(`/apple-devices/enrollments/${encodeURIComponent(sessionId)}`);
    return response.data;
  },

  listRegistrationRequests: async (): Promise<ApiResponse<AppleDeviceRegistrationRequestListResult>> => {
    const response = await api.get<ApiResponse<AppleDeviceRegistrationRequestListResult>>('/apple-devices/registration-requests');
    return response.data;
  },

  createRegistrationRequest: async (payload: { udid: string; name?: string; platform?: 'IOS' | 'MAC_OS'; product?: string; version?: string; serial?: string }): Promise<ApiResponse<AppleDeviceRegistrationRequest>> => {
    const response = await api.post<ApiResponse<AppleDeviceRegistrationRequest>>('/apple-devices/registration-requests', payload, {
      timeout: 60000,
    });
    return response.data;
  },

  approveRegistrationRequest: async (id: string): Promise<ApiResponse<AppleDeviceRegistrationRequest & { result?: AppleDeviceRegisterResult }>> => {
    const response = await api.post<ApiResponse<AppleDeviceRegistrationRequest & { result?: AppleDeviceRegisterResult }>>(`/apple-devices/registration-requests/${encodeURIComponent(id)}/approve`, {}, {
      timeout: 60000,
    });
    return response.data;
  },

  register: async (payload: { udid: string; name?: string; platform?: 'IOS' | 'MAC_OS' }): Promise<ApiResponse<AppleDeviceRegisterResult>> => {
    const response = await api.post<ApiResponse<AppleDeviceRegisterResult>>('/apple-devices/register', payload, {
      timeout: 60000,
    });
    return response.data;
  },
};

export interface DeviceControlDevice {
  udid: string;
  name: string;
  productType?: string;
  osVersion?: string;
  connectionType?: string;
  connected: boolean;
}

export interface DeviceControlStatus {
  phase: 'idle' | 'starting' | 'connected' | 'error';
  device?: DeviceControlDevice;
  owner?: string;
  sessionId?: string;
  wdaUrl?: string;
  windowSize?: {
    width: number;
    height: number;
  };
  streamAvailable?: boolean;
  startedAt?: string;
  lastError?: string;
}

export interface DeviceRecordingSnapshot {
  id: string;
  createdAt: string;
  screenshotUrl: string;
  sourceUrl: string;
  screenshotBytes: number;
  sourceBytes: number;
  screenshotHash: string;
  sourceHash: string;
}

export interface DeviceRecordingLocatorCandidate {
  strategy: 'accessibilityId' | 'predicate' | 'classChain' | 'hierarchy' | 'coordinate';
  value: string;
  score: number;
}

export interface DeviceRecordingActionTarget {
  type: string;
  name?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  contextLabels?: string[];
  rect: { x: number; y: number; width: number; height: number };
  relativePoint: { x: number; y: number };
  depth: number;
  locators: DeviceRecordingLocatorCandidate[];
}

export interface DeviceRecordingAction {
  type: string;
  params: Record<string, unknown>;
  screenSize?: { width: number; height: number };
  normalizedPoint?: { x: number; y: number };
  normalizedStart?: { x: number; y: number };
  normalizedEnd?: { x: number; y: number };
  target?: DeviceRecordingActionTarget;
  startTarget?: DeviceRecordingActionTarget;
  endTarget?: DeviceRecordingActionTarget;
}

export interface DeviceRecordingStep {
  id: string;
  index: number;
  origin: 'platform' | 'annotated';
  status: 'pending' | 'ready' | 'failed';
  included: boolean;
  noiseLikely: boolean;
  summary: string;
  createdAt: string;
  action: DeviceRecordingAction;
  beforeSnapshot?: DeviceRecordingSnapshot;
  afterSnapshot?: DeviceRecordingSnapshot;
  sourceDiff?: {
    addedCount: number;
    removedCount: number;
    addedLabels: string[];
    removedLabels: string[];
  };
  error?: string;
}

export interface DeviceRecordingObservation {
  id: string;
  index: number;
  kind: 'external_change';
  status: 'pending' | 'ready' | 'failed';
  included: boolean;
  promotedStepId?: string;
  noiseLikely: boolean;
  summary: string;
  createdAt: string;
  beforeSnapshot?: DeviceRecordingSnapshot;
  afterSnapshot?: DeviceRecordingSnapshot;
  sourceDiff?: DeviceRecordingStep['sourceDiff'];
  suggestedAction?: 'tap' | 'input' | 'ignore';
  suggestionReason?: string;
  logicalGroupId?: string;
  collapsedIntoObservationId?: string;
  collapsedObservationCount?: number;
  error?: string;
}

export interface DeviceRecording {
  id: string;
  title: string;
  owner: string;
  status: 'recording' | 'stopped';
  createdAt: string;
  stoppedAt?: string;
  device?: DeviceControlDevice;
  initialSnapshot?: DeviceRecordingSnapshot;
  steps: DeviceRecordingStep[];
  observations: DeviceRecordingObservation[];
  selectedCount: number;
  candidateSelectedCount: number;
}

export type DeviceReplayFlowNodeType = 'start' | 'tap' | 'swipe' | 'input' | 'keyboard' | 'wait' | 'condition' | 'assertion' | 'end';

export interface DeviceReplayFlowTarget {
  accessibilityId?: string;
  name?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  type?: string;
  contextLabels?: string[];
  coordinate?: { x: number; y: number };
  relativePoint?: { x: number; y: number };
}

export type DeviceReplayFlowCondition =
  | { all: DeviceReplayFlowCondition[] }
  | { any: DeviceReplayFlowCondition[] }
  | { not: DeviceReplayFlowCondition }
  | { kind: 'element'; operator: 'exists' | 'not_exists' | 'visible' | 'not_visible' | 'enabled' | 'disabled'; target: DeviceReplayFlowTarget }
  | { kind: 'text'; operator: 'equals' | 'contains' | 'not_contains'; target: DeviceReplayFlowTarget; value: string }
  | { kind: 'keyboard'; operator: 'visible' | 'hidden' }
  | { kind: 'app'; operator: 'foreground' | 'background' }
  | { kind: 'delay'; durationMs: number }
  | { kind: 'page_stable'; durationMs?: number }
  | { kind: 'snapshot_similarity'; snapshotId: string; threshold?: number };

export interface DeviceReplayFlowNode {
  id: string;
  type: DeviceReplayFlowNodeType;
  name?: string;
  description?: string;
  timeoutMs?: number;
  retry?: { maxAttempts: number; intervalMs?: number; backoff?: 'fixed' | 'linear' };
  evidence?: { beforeSnapshotId?: string; afterSnapshotId?: string; recordingStepId?: string };
  precondition?: DeviceReplayFlowCondition;
  postcondition?: DeviceReplayFlowCondition;
  next?: string;
  onFailure?: string;
  target?: DeviceReplayFlowTarget;
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  durationMs?: number;
  startTarget?: DeviceReplayFlowTarget;
  endTarget?: DeviceReplayFlowTarget;
  value?: string;
  key?: 'Search' | 'Return' | 'Done' | 'Dismiss';
  condition?: DeviceReplayFlowCondition;
  onSuccess?: string;
  onTimeout?: string;
  onError?: string;
  onTrue?: string;
  onFalse?: string;
  onPassed?: string;
  onFailed?: string;
  result?: 'success' | 'failure';
  message?: string;
}

export interface DeviceReplayFlowDsl {
  schemaVersion: '1.0';
  id: string;
  name: string;
  description?: string;
  source?: { type: 'recording'; recordingId: string };
  inputs?: Record<string, { type: 'string'; required?: boolean; default?: string; description?: string }>;
  nodes: DeviceReplayFlowNode[];
}

export interface DeviceReplayFlowDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
  nodeId?: string;
}

export interface DeviceReplayFlowValidation {
  valid: boolean;
  errors: DeviceReplayFlowDiagnostic[];
  warnings: DeviceReplayFlowDiagnostic[];
}

export interface DeviceReplayFlowRunEvidence {
  id: string;
  phase: 'before' | 'after';
  createdAt: string;
  sourceUrl?: string;
  screenshotUrl?: string;
  captureError?: string;
}

export interface DeviceReplayFlowNodeRun {
  sequence: number;
  nodeId: string;
  nodeType: DeviceReplayFlowNodeType;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempts: number;
  outcome?: string;
  nextNodeId?: string;
  errorCode?: string;
  error?: string;
  locator?: {
    strategy: 'semantic' | 'coordinate' | 'coordinate-fallback';
    resolvedPoint: { x: number; y: number };
    matchedName?: string;
    matchedLabel?: string;
    semanticScore?: number;
  };
  condition?: { matched: boolean; kind: string; actual?: string | number | boolean; expected?: string | number | boolean; elapsedMs: number };
  evidence: DeviceReplayFlowRunEvidence[];
}

export interface DeviceReplayFlowRun {
  id: string;
  flowId: string;
  flowName: string;
  owner: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  inputNames: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  currentNodeId?: string;
  result?: 'success' | 'failure';
  errorCode?: string;
  error?: string;
  device?: { udid: string; name: string; osVersion?: string };
  nodes: DeviceReplayFlowNodeRun[];
}

export type ReplayFlowAssetStatus = 'draft' | 'published' | 'archived';

export interface ReplayFlowAssetSummary {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  owner: string;
  status: ReplayFlowAssetStatus;
  sourceRecordingId?: string;
  sourceFingerprint: string;
  currentDraftId?: string;
  latestVersionId?: string;
  latestVersionNumber?: number;
  preFlowVersionId?: string;
  preFlowAssetId?: string;
  preFlowAssetName?: string;
  preFlowVersionNumber?: number;
  postFlowVersionId?: string;
  postFlowAssetId?: string;
  postFlowAssetName?: string;
  postFlowVersionNumber?: number;
  creationCompleted: boolean;
  completedAt?: string;
  revision: number;
  nodeCount: number;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ReplayFlowDraft {
  id: string;
  assetId: string;
  revision: number;
  flow: DeviceReplayFlowDsl;
  validation: DeviceReplayFlowValidation;
  sourceRecordingId?: string;
  sourceFingerprint: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReplayFlowAsset extends ReplayFlowAssetSummary {
  draft: ReplayFlowDraft;
  versions: ReplayFlowVersionSummary[];
  auditEvents: ReplayFlowAuditEvent[];
}

export interface ReplayFlowAuditEvent {
  id: string;
  assetId: string;
  eventType: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ReplayFlowVersionSummary {
  id: string;
  assetId: string;
  assetName: string;
  versionNumber: number;
  createdBy: string;
  createdAt: string;
  releaseNotes?: string;
}

export interface ReplayFlowVersion extends ReplayFlowVersionSummary {
  projectId: string;
  flow: DeviceReplayFlowDsl;
  compiled: unknown;
  sourceRecordingId?: string;
  sourceFingerprint: string;
}

export interface ReplayFlowSourcePreview {
  recording: {
    id: string;
    title: string;
    status: DeviceRecording['status'];
    owner: string;
    createdAt: string;
    stoppedAt?: string;
    device?: DeviceControlDevice;
    selectedCount: number;
  };
  selectedSteps: Array<{
    id: string;
    index: number;
    origin: string;
    actionType: string;
    summary: string;
    targetSummary?: string;
  }>;
  sourceFingerprint: string;
  storedSourceFingerprint?: string;
  sourceChanged: boolean;
  flow: DeviceReplayFlowDsl;
  validation: DeviceReplayFlowValidation;
}

export type ReplayFlowChainPhase = 'pre' | 'main' | 'post';
export type ReplayFlowChainPhaseStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
export type ReplayFlowChainRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ReplayFlowChainPhaseRun {
  phase: ReplayFlowChainPhase;
  assetId: string;
  assetName: string;
  versionId?: string;
  versionNumber?: number;
  status: ReplayFlowChainPhaseStatus;
  replayRunId?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  errorCode?: string;
  error?: string;
}

export interface ReplayFlowChainRun {
  id: string;
  mainAssetId: string;
  mainAssetName: string;
  owner: string;
  status: ReplayFlowChainRunStatus;
  inputNames: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  stopRequestedAt?: string;
  currentPhase?: ReplayFlowChainPhase;
  result?: 'success' | 'failure';
  errorCode?: string;
  error?: string;
  device?: { udid: string; name: string; osVersion?: string };
  phases: ReplayFlowChainPhaseRun[];
}

export const deviceControlApi = {
  listDevices: async (): Promise<ApiResponse<{ devices: DeviceControlDevice[] }>> => {
    const response = await api.get<ApiResponse<{ devices: DeviceControlDevice[] }>>('/device-control/devices');
    return response.data;
  },

  status: async (): Promise<ApiResponse<DeviceControlStatus>> => {
    const response = await api.get<ApiResponse<DeviceControlStatus>>('/device-control/status');
    return response.data;
  },

  connect: async (udid: string): Promise<ApiResponse<DeviceControlStatus>> => {
    const response = await api.post<ApiResponse<DeviceControlStatus>>('/device-control/connect', { udid }, {
      timeout: 360000,
    });
    return response.data;
  },

  disconnect: async (): Promise<ApiResponse<DeviceControlStatus>> => {
    const response = await api.post<ApiResponse<DeviceControlStatus>>('/device-control/disconnect');
    return response.data;
  },

  source: async (): Promise<ApiResponse<{ source: string }>> => {
    const response = await api.get<ApiResponse<{ source: string }>>('/device-control/source', { timeout: 30000 });
    return response.data;
  },

  tap: async (x: number, y: number): Promise<ApiResponse<{ point: { x: number; y: number } }>> => {
    const response = await api.post<ApiResponse<{ point: { x: number; y: number } }>>('/device-control/tap', { x, y });
    return response.data;
  },

  swipe: async (payload: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    durationMs: number;
  }): Promise<ApiResponse<{
    start: { x: number; y: number };
    end: { x: number; y: number };
    durationMs: number;
  }>> => {
    const response = await api.post('/device-control/swipe', payload);
    return response.data;
  },

  input: async (text: string): Promise<ApiResponse<{ length: number }>> => {
    const response = await api.post<ApiResponse<{ length: number }>>('/device-control/input', { text });
    return response.data;
  },

  startRecording: async (title?: string): Promise<ApiResponse<DeviceRecording>> => {
    const response = await api.post<ApiResponse<DeviceRecording>>('/device-control/recordings', { title }, { timeout: 60000 });
    return response.data;
  },

  currentRecording: async (): Promise<ApiResponse<{ recording: DeviceRecording | null }>> => {
    const response = await api.get<ApiResponse<{ recording: DeviceRecording | null }>>('/device-control/recordings/current');
    return response.data;
  },

  latestRecording: async (): Promise<ApiResponse<{ recording: DeviceRecording | null }>> => {
    const response = await api.get<ApiResponse<{ recording: DeviceRecording | null }>>('/device-control/recordings/latest');
    return response.data;
  },

  observeRecordingChange: async (): Promise<ApiResponse<DeviceRecording>> => {
    const response = await api.post<ApiResponse<DeviceRecording>>('/device-control/recordings/current/observe');
    return response.data;
  },

  stopRecording: async (): Promise<ApiResponse<DeviceRecording>> => {
    const response = await api.post<ApiResponse<DeviceRecording>>('/device-control/recordings/current/stop', {}, { timeout: 60000 });
    return response.data;
  },

  getRecording: async (recordingId: string): Promise<ApiResponse<DeviceRecording>> => {
    const response = await api.get<ApiResponse<DeviceRecording>>(`/device-control/recordings/${encodeURIComponent(recordingId)}`);
    return response.data;
  },

  updateRecordingStep: async (recordingId: string, stepId: string, included: boolean): Promise<ApiResponse<DeviceRecording>> => {
    const response = await api.patch<ApiResponse<DeviceRecording>>(
      `/device-control/recordings/${encodeURIComponent(recordingId)}/steps/${encodeURIComponent(stepId)}`,
      { included },
    );
    return response.data;
  },

  updateRecordingObservation: async (recordingId: string, observationId: string, included: boolean): Promise<ApiResponse<DeviceRecording>> => {
    const response = await api.patch<ApiResponse<DeviceRecording>>(
      `/device-control/recordings/${encodeURIComponent(recordingId)}/observations/${encodeURIComponent(observationId)}`,
      { included },
    );
    return response.data;
  },

  promoteRecordingObservation: async (
    recordingId: string,
    observationId: string,
    annotation: {
      type: 'tap' | 'swipe' | 'input';
      point?: { x: number; y: number };
      start?: { x: number; y: number };
      end?: { x: number; y: number };
      durationMs?: number;
    },
  ): Promise<ApiResponse<DeviceRecording>> => {
    const response = await api.post<ApiResponse<DeviceRecording>>(
      `/device-control/recordings/${encodeURIComponent(recordingId)}/observations/${encodeURIComponent(observationId)}/promote`,
      annotation,
    );
    return response.data;
  },

  replayRecording: async (recordingId: string, inputValue?: string): Promise<ApiResponse<{
    recordingId: string;
    selectedCount: number;
    executedCount: number;
    skippedCount: number;
    skipped: Array<{ stepId: string; index: number; type: string; summary: string; reason: string }>;
    results: Array<{ stepId: string; index: number; type: string; summary: string }>;
  }>> => {
    const response = await api.post(
      `/device-control/recordings/${encodeURIComponent(recordingId)}/replay`,
      { inputValue: inputValue || '' },
      { timeout: 300000 },
    );
    return response.data;
  },

  replayFlowTemplate: async (recordingId: string, includeUnselected = false): Promise<ApiResponse<{
    flow: DeviceReplayFlowDsl;
    validation: DeviceReplayFlowValidation;
    compiled: unknown;
  }>> => {
    const response = await api.get(
      `/device-control/recordings/${encodeURIComponent(recordingId)}/replay-flow-template`,
      { params: { includeUnselected } },
    );
    return response.data;
  },

  recordingOrchestrationPreview: async (recordingId: string): Promise<ApiResponse<{
    preview: ReplayFlowSourcePreview;
  }>> => {
    const response = await api.get<ApiResponse<{ preview: ReplayFlowSourcePreview }>>(
      `/device-control/recordings/${encodeURIComponent(recordingId)}/orchestration-preview`,
    );
    return response.data;
  },

  listReplayFlowAssets: async (params: {
    search?: string;
    status?: ReplayFlowAssetStatus | 'all';
    limit?: number;
  } = {}): Promise<ApiResponse<{ assets: ReplayFlowAssetSummary[] }>> => {
    const response = await api.get<ApiResponse<{ assets: ReplayFlowAssetSummary[] }>>('/device-control/replay-flow-assets', { params });
    return response.data;
  },

  getReplayFlowAsset: async (assetId: string): Promise<ApiResponse<{ asset: ReplayFlowAsset }>> => {
    const response = await api.get<ApiResponse<{ asset: ReplayFlowAsset }>>(
      `/device-control/replay-flow-assets/${encodeURIComponent(assetId)}`,
    );
    return response.data;
  },

  getReplayFlowVersion: async (versionId: string): Promise<ApiResponse<{ version: ReplayFlowVersion }>> => {
    const response = await api.get<ApiResponse<{ version: ReplayFlowVersion }>>(
      `/device-control/replay-flow-versions/${encodeURIComponent(versionId)}`,
    );
    return response.data;
  },

  listPublishedReplayFlowVersions: async (): Promise<ApiResponse<{ versions: ReplayFlowVersionSummary[] }>> => {
    const response = await api.get<ApiResponse<{ versions: ReplayFlowVersionSummary[] }>>(
      '/device-control/replay-flow-versions',
    );
    return response.data;
  },

  copyReplayFlowVersion: async (
    versionId: string,
    name?: string,
  ): Promise<ApiResponse<{ asset: ReplayFlowAsset }>> => {
    const response = await api.post<ApiResponse<{ asset: ReplayFlowAsset }>>(
      `/device-control/replay-flow-versions/${encodeURIComponent(versionId)}/copy`,
      { name },
    );
    return response.data;
  },

  rollbackReplayFlowVersion: async (
    versionId: string,
    expectedRevision: number,
  ): Promise<ApiResponse<{ asset: ReplayFlowAsset }>> => {
    const response = await api.post<ApiResponse<{ asset: ReplayFlowAsset }>>(
      `/device-control/replay-flow-versions/${encodeURIComponent(versionId)}/rollback`,
      { expectedRevision },
    );
    return response.data;
  },

  getReplayFlowSourcePreview: async (assetId: string): Promise<ApiResponse<{
    preview: ReplayFlowSourcePreview;
  }>> => {
    const response = await api.get<ApiResponse<{ preview: ReplayFlowSourcePreview }>>(
      `/device-control/replay-flow-assets/${encodeURIComponent(assetId)}/source-preview`,
    );
    return response.data;
  },

  resetReplayFlowFromRecording: async (
    assetId: string,
    expectedRevision: number,
  ): Promise<ApiResponse<{ asset: ReplayFlowAsset; preview: ReplayFlowSourcePreview }>> => {
    const response = await api.post<ApiResponse<{ asset: ReplayFlowAsset; preview: ReplayFlowSourcePreview }>>(
      `/device-control/replay-flow-assets/${encodeURIComponent(assetId)}/reset-from-recording`,
      { expectedRevision },
    );
    return response.data;
  },

  createReplayFlowAsset: async (
    recordingId: string,
    payload: { name: string; description?: string; creationMode?: boolean },
  ): Promise<ApiResponse<{ asset: ReplayFlowAsset }>> => {
    const response = await api.post<ApiResponse<{ asset: ReplayFlowAsset }>>(
      `/device-control/recordings/${encodeURIComponent(recordingId)}/replay-flow-assets`,
      payload,
    );
    return response.data;
  },

  completeReplayFlowCreation: async (assetId: string): Promise<ApiResponse<{ asset: ReplayFlowAsset }>> => {
    const response = await api.post<ApiResponse<{ asset: ReplayFlowAsset }>>(
      `/device-control/replay-flow-assets/${encodeURIComponent(assetId)}/complete-creation`,
    );
    return response.data;
  },

  saveReplayFlowDraft: async (
    assetId: string,
    payload: { expectedRevision: number; flow?: DeviceReplayFlowDsl; name?: string; description?: string },
  ): Promise<ApiResponse<{ asset: ReplayFlowAsset }>> => {
    const response = await api.put<ApiResponse<{ asset: ReplayFlowAsset }>>(
      `/device-control/replay-flow-assets/${encodeURIComponent(assetId)}/draft`,
      payload,
    );
    return response.data;
  },

  copyReplayFlowAsset: async (assetId: string, name?: string): Promise<ApiResponse<{ asset: ReplayFlowAsset }>> => {
    const response = await api.post<ApiResponse<{ asset: ReplayFlowAsset }>>(
      `/device-control/replay-flow-assets/${encodeURIComponent(assetId)}/copy`,
      { name },
    );
    return response.data;
  },

  setReplayFlowAssetArchived: async (assetId: string, archived: boolean): Promise<ApiResponse<{ asset: ReplayFlowAsset }>> => {
    const response = await api.post<ApiResponse<{ asset: ReplayFlowAsset }>>(
      `/device-control/replay-flow-assets/${encodeURIComponent(assetId)}/${archived ? 'archive' : 'restore'}`,
    );
    return response.data;
  },

  updateReplayFlowExecutionChain: async (
    assetId: string,
    payload: { preFlowVersionId?: string | null; postFlowVersionId?: string | null },
  ): Promise<ApiResponse<{ asset: ReplayFlowAsset }>> => {
    const response = await api.put<ApiResponse<{ asset: ReplayFlowAsset }>>(
      `/device-control/replay-flow-assets/${encodeURIComponent(assetId)}/execution-chain`,
      payload,
    );
    return response.data;
  },

  publishReplayFlowAsset: async (
    assetId: string,
    payload: { expectedRevision: number; releaseNotes?: string },
  ): Promise<ApiResponse<{ asset: ReplayFlowAsset; version: ReplayFlowVersion }>> => {
    const response = await api.post<ApiResponse<{ asset: ReplayFlowAsset; version: ReplayFlowVersion }>>(
      `/device-control/replay-flow-assets/${encodeURIComponent(assetId)}/publish`,
      payload,
    );
    return response.data;
  },

  startReplayFlowAssetRun: async (
    assetId: string,
    inputs: Record<string, string>,
  ): Promise<ApiResponse<{ run: ReplayFlowChainRun }>> => {
    const response = await api.post<ApiResponse<{ run: ReplayFlowChainRun }>>(
      `/device-control/replay-flow-assets/${encodeURIComponent(assetId)}/runs`,
      { inputs },
    );
    return response.data;
  },

  listReplayFlowChainRuns: async (params: {
    status?: ReplayFlowChainRunStatus | 'all';
    limit?: number;
  } = {}): Promise<ApiResponse<{ runs: ReplayFlowChainRun[] }>> => {
    const response = await api.get<ApiResponse<{ runs: ReplayFlowChainRun[] }>>(
      '/device-control/replay-flow-chain-runs',
      { params },
    );
    return response.data;
  },

  getReplayFlowChainRun: async (runId: string): Promise<ApiResponse<{ run: ReplayFlowChainRun }>> => {
    const response = await api.get<ApiResponse<{ run: ReplayFlowChainRun }>>(
      `/device-control/replay-flow-chain-runs/${encodeURIComponent(runId)}`,
    );
    return response.data;
  },

  stopReplayFlowChainRun: async (runId: string): Promise<ApiResponse<{ run: ReplayFlowChainRun }>> => {
    const response = await api.post<ApiResponse<{ run: ReplayFlowChainRun }>>(
      `/device-control/replay-flow-chain-runs/${encodeURIComponent(runId)}/stop`,
    );
    return response.data;
  },

  validateReplayFlow: async (flow: DeviceReplayFlowDsl): Promise<ApiResponse<{
    validation: DeviceReplayFlowValidation;
    compiled: unknown;
  }>> => {
    const response = await api.post('/device-control/replay-flows/validate', { flow });
    return response.data;
  },

  startReplayFlow: async (flow: DeviceReplayFlowDsl, inputs: Record<string, string>): Promise<ApiResponse<{
    run: DeviceReplayFlowRun;
  }>> => {
    const response = await api.post('/device-control/replay-flows/runs', { flow, inputs });
    return response.data;
  },

  getReplayFlowRun: async (runId: string): Promise<ApiResponse<{ run: DeviceReplayFlowRun }>> => {
    const response = await api.get(`/device-control/replay-flows/runs/${encodeURIComponent(runId)}`);
    return response.data;
  },

  stopReplayFlowRun: async (runId: string): Promise<ApiResponse<{ run: DeviceReplayFlowRun }>> => {
    const response = await api.post(`/device-control/replay-flows/runs/${encodeURIComponent(runId)}/stop`);
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

export interface WorkflowOverview {
  projectId: string;
  artifacts: number;
  tasks: number;
  activeTasks: number;
  openIssues: number;
  regressionCandidates: number;
  knowledgeEntries: number;
  tasksByStatus: Record<string, number>;
  issuesBySeverity: Record<string, number>;
  latestGate?: WorkflowReleaseGate | null;
  latestTasks: WorkflowTask[];
  latestIssues: WorkflowIssue[];
}

export interface WorkflowTask {
  id: string;
  taskType: string;
  suite?: string;
  status: string;
  source: string;
  buildNumber?: string;
  branch?: string;
  commitHash?: string;
  deviceUdid?: string;
  progress: number;
  config: Record<string, unknown>;
  result: Record<string, any>;
  updatedAt: string;
}

export interface WorkflowIssue {
  id: string;
  fingerprint: string;
  source: string;
  category: string;
  severity: string;
  status: string;
  title: string;
  summary?: string;
  module?: string;
  ownerHint?: string;
  businessDomain?: string;
  businessPath?: string;
  taskId?: string;
  buildNumber?: string;
  occurrenceCount: number;
  lastSeen: string;
  evidence: unknown[];
  metadata: Record<string, any>;
}

export interface WorkflowImpactResult {
  repoPath: string;
  baseRef?: string;
  headRef: string;
  totalFiles: number;
  changedLines: number;
  riskScore: number;
  riskLevel: string;
  modules: string[];
  domains: string[];
  risks: string[];
  recommendedSuites: string[];
  recommendedChecks: string[];
  files: Array<{ path: string; kind: string; module: string; domains: string[]; risks: string[]; added: number; deleted: number }>;
}

export interface WorkflowReleaseGate {
  id: string;
  buildNumber: string;
  branch?: string;
  status: string;
  score: number;
  result: {
    summary?: string;
    blockers?: Array<{ code: string; message: string }>;
    warnings?: Array<{ code: string; message: string }>;
    passed?: Array<{ code: string; message: string }>;
  };
  createdAt: string;
}

export interface WorkflowRegressionCandidate {
  id: string;
  issueId?: string;
  title: string;
  suite: string;
  businessDomain?: string;
  businessPath?: string;
  preconditions: string[];
  steps: string[];
  assertions: string[];
  confidence: number;
  status: string;
  generatedCode?: string;
  metadata: Record<string, any>;
  updatedAt: string;
}

export interface WorkflowKnowledgeEntry {
  id: string;
  kind: string;
  title: string;
  summary: string;
  tags: string[];
  confidence: number;
  updatedAt: string;
  content: Record<string, any>;
}

export interface WorkflowReleaseObservation {
  id: string;
  releaseVersion: string;
  buildNumber?: string;
  channel?: string;
  metric: string;
  value: number;
  baselineValue?: number;
  status: string;
  observedAt: string;
}

export interface DeliveryReadiness {
  projectId: string;
  buildNumber: string;
  status: 'passed' | 'blocked' | 'warning' | 'unknown';
  summary: string;
  evaluatedAt: string;
  limitations: string[];
  context: { commitHash: string | null; branch: string | null; releaseVersion: string | null; updatedAt: string | null };
  counts: { artifacts: number; tasks: number; issues: number; openIssues: number; candidates: number };
  stages: Array<{ key: string; title: string; status: DeliveryReadiness['status']; summary: string; evidenceIds: string[] }>;
  actions: Array<{ code: string; priority: 'P0' | 'P1' | 'P2'; title: string; reason: string; target: 'cicd' | 'issues' | 'regression' | 'evolution' | 'gate'; evidenceIds: string[] }>;
  gate: WorkflowReleaseGate;
  evidence: {
    artifacts: Array<{ id: string; artifactType: string; name: string; updatedAt: string }>;
    tasks: Array<{ id: string; suite: string; status: string; commitHash: string | null; branch: string | null; updatedAt: string }>;
    issues: Array<{ id: string; title: string; severity: string; status: string; ownerHint: string | null }>;
    candidates: Array<{ id: string; issueId: string; title: string; status: string; updatedAt: string }>;
  };
}

export const workflowApi = {
  deliveryReadiness: async (buildNumber: string): Promise<ApiResponse<DeliveryReadiness>> => (await api.get(`/workflow/delivery/${encodeURIComponent(buildNumber)}`)).data,
  overview: async (): Promise<ApiResponse<WorkflowOverview>> => (await api.get('/workflow/overview')).data,
  listTasks: async (): Promise<ApiResponse<WorkflowTask[]>> => (await api.get('/workflow/tasks')).data,
  listIssues: async (params?: Record<string, unknown>): Promise<ApiResponse<WorkflowIssue[]>> => (await api.get('/workflow/issues', { params })).data,
  updateIssue: async (issueId: string, payload: Record<string, unknown>): Promise<ApiResponse<WorkflowIssue>> => (await api.patch(`/workflow/issues/${issueId}`, payload)).data,
  analyzeImpact: async (payload: { repoPath?: string; baseRef?: string; headRef?: string; files?: string[] }): Promise<ApiResponse<WorkflowImpactResult>> => (await api.post('/workflow/impact/analyze', payload, { timeout: 120000 })).data,
  evaluateGate: async (payload: Record<string, unknown>): Promise<ApiResponse<WorkflowReleaseGate>> => (await api.post('/workflow/release-gates/evaluate', payload)).data,
  listGates: async (): Promise<ApiResponse<WorkflowReleaseGate[]>> => (await api.get('/workflow/release-gates')).data,
  proposeRegression: async (issueId: string): Promise<ApiResponse<WorkflowRegressionCandidate>> => (await api.post(`/workflow/issues/${issueId}/regression-candidates`)).data,
  listRegressionCandidates: async (): Promise<ApiResponse<WorkflowRegressionCandidate[]>> => (await api.get('/workflow/regression-candidates')).data,
  generateXCUITest: async (candidateId: string, apiKey?: string): Promise<ApiResponse<{ candidate: WorkflowRegressionCandidate; generation: Record<string, any> }>> => (await api.post(`/workflow/regression-candidates/${candidateId}/generate-xcuitest`, { apiKey }, { timeout: 120000 })).data,
  exportXCUITest: async (candidateId: string): Promise<ApiResponse<{ candidate: WorkflowRegressionCandidate; filePath: string; className: string; testNames: string[] }>> => (await api.post(`/workflow/regression-candidates/${candidateId}/export-xcuitest`)).data,
  verifyXCUITest: async (candidateId: string): Promise<ApiResponse<{ candidate: WorkflowRegressionCandidate; passed: boolean; logPath: string; mode: string }>> => (await api.post(`/workflow/regression-candidates/${candidateId}/verify-xcuitest`, {}, { timeout: 5 * 60 * 1000 })).data,
  runXCUITest: async (candidateId: string, destination?: string): Promise<ApiResponse<{ candidate: WorkflowRegressionCandidate; executed: boolean; passed: boolean; [key: string]: any }>> => (await api.post(`/workflow/regression-candidates/${candidateId}/run-xcuitest`, { allowRun: true, destination }, { timeout: 45 * 60 * 1000 })).data,
  suggestFix: async (issueId: string, context: Record<string, unknown> = {}, apiKey?: string): Promise<ApiResponse<Record<string, any>>> => (await api.post(`/workflow/issues/${issueId}/fix-suggestion`, { context, apiKey }, { timeout: 120000 })).data,
  listKnowledge: async (): Promise<ApiResponse<WorkflowKnowledgeEntry[]>> => (await api.get('/workflow/knowledge')).data,
  synthesizeKnowledge: async (payload: Record<string, unknown>): Promise<ApiResponse<WorkflowKnowledgeEntry>> => (await api.post('/workflow/knowledge/synthesize', payload, { timeout: 120000 })).data,
  listAIEvaluations: async (): Promise<ApiResponse<any[]>> => (await api.get('/workflow/ai-evaluations')).data,
  recordAIEvaluation: async (payload: Record<string, unknown>): Promise<ApiResponse<{ id: string }>> => (await api.post('/workflow/ai-evaluations', payload)).data,
  updateAIEvaluation: async (evaluationId: string, payload: Record<string, unknown>): Promise<ApiResponse<any>> => (await api.patch(`/workflow/ai-evaluations/${evaluationId}`, payload)).data,
  addReleaseObservation: async (payload: Record<string, unknown>): Promise<ApiResponse<{ id: string }>> => (await api.post('/workflow/release-observations', payload)).data,
  listReleaseObservations: async (releaseVersion?: string): Promise<ApiResponse<WorkflowReleaseObservation[]>> => (await api.get('/workflow/release-observations', { params: releaseVersion ? { releaseVersion } : undefined })).data,
  releaseHealth: async (releaseVersion: string): Promise<ApiResponse<Record<string, any>>> => (await api.get(`/workflow/release-health/${encodeURIComponent(releaseVersion)}`)).data,
};

export default api;

export interface ComponentLibrary { id: string; name: string; platform: 'ios' | 'android'; configProductLineId: string; }
export interface ComponentLibraryStatus extends ComponentLibrary { shared: boolean; applications: { id: string; name: string; productLineId: string }[]; }
export const componentLibraryApi = {
  list: () => api.get('/auth/component-libraries').then((r) => r.data.data as ComponentLibrary[]),
  current: () => api.get('/pods/library').then((r) => r.data.data as ComponentLibraryStatus),
};
export const mobileApplicationApi = {
  list: (product: string) => api.get(`/auth/product-lines/${encodeURIComponent(product)}/applications`).then((r) => r.data.data as MobileApplication[]),
  save: (product: string, data: unknown, id?: string) => (id ? api.patch(`/auth/product-lines/${encodeURIComponent(product)}/applications/${encodeURIComponent(id)}`, data) : api.post(`/auth/product-lines/${encodeURIComponent(product)}/applications`, data)).then((r) => r.data.data),
};
export interface AndroidRun {
  id: string; kind: 'build' | 'smoke'; status: string; jobName: string; buildNumber?: number; createdAt: string;
  config: { commit: string; sourceRunId?: string; deviceSerial?: string }; result: { message?: string; manifest?: Record<string, unknown> };
}
export const androidApi = {
  issues: () => api.get('/android/issues').then((r) => r.data.data as { id: string; title: string; status: string; buildNumber: string; evidence: unknown[] }[]),
  resolveIssue: (id: string, smokeRunId: string) => api.post(`/android/issues/${encodeURIComponent(id)}/resolve`, { smokeRunId }),
  readiness: () => api.get('/android/readiness').then((r) => r.data.data as { configured: boolean; missing: string[]; acceptance: string; configurationRevision: string }),
  list: () => api.get('/android/runs').then((r) => r.data.data as AndroidRun[]),
  trigger: (data: { kind: 'build' | 'smoke'; requestKey: string; commit?: string; sourceRunId?: string; configurationRevision?: string }) => api.post('/android/runs', data).then((r) => r.data.data as AndroidRun),
  sync: (id: string) => api.post(`/android/runs/${encodeURIComponent(id)}/sync`).then((r) => r.data.data),
  cancel: (id: string) => api.post(`/android/runs/${encodeURIComponent(id)}/cancel`).then((r) => r.data.data),
  gate: (id: string) => api.get(`/android/runs/${encodeURIComponent(id)}/gate`).then((r) => r.data.data as { passed: boolean; reason: string }),
  download: (id: string) => api.get(`/android/runs/${encodeURIComponent(id)}/download`, { responseType: 'blob', timeout: 180_000 }).then((r) => r.data as Blob).catch(async (error) => {
    if (error instanceof Blob) {
      let reason = '安装包下载失败';
      try { reason = JSON.parse(await error.text()).error || reason; } catch { /* Non-JSON proxy response. */ }
      throw new Error(reason);
    }
    throw error;
  }),
};
