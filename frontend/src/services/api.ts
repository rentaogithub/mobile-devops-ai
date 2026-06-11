import axios from 'axios';
import {
  DSYMInfo,
  SymbolicationResult,
  ApiResponse,
  CrashAnalysis,
  SentryFetchAnalyzeResult,
  SentryIssueListResult,
  SentryAnalyzeSelectedResult,
  SentrySymbolicateLogResult,
  SentryOriginalCrashResult,
  SentrySymbolicateAnalyzeResult,
  SentryIssueSummary,
} from '../types';
import { authUtils } from '../utils/auth';

const api = axios.create({
  baseURL: '/api',
  timeout: 60000, // 60 秒超时
  headers: {
    'Content-Type': 'application/json',
  },
});

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

export const sentryAnalysisApi = {
  listIssues: async (params: {
    period: string;
    limit: number;
    query?: string;
  }): Promise<ApiResponse<SentryIssueListResult>> => {
    const response = await api.post<ApiResponse<SentryIssueListResult>>(
      '/sentry-analysis/issues',
      params,
      { timeout: 60000 }
    );
    return response.data;
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
  retry: async (name: string, version: string): Promise<ApiResponse<PodComponent>> => {
    const response = await api.post<ApiResponse<PodComponent>>(`/pods/${name}/${version}/retry`);
    return response.data;
  },

  /** 更新 podspec 并同步到远程仓库 */
  updatePodspec: async (name: string, version: string, podspec_content: string): Promise<ApiResponse<PodComponent>> => {
    const response = await api.put<ApiResponse<PodComponent>>(`/pods/${name}/${version}/podspec`, { podspec_content });
    return response.data;
  },

  /** 重新上传 zip 替换已有版本 */
  replaceZip: async (name: string, version: string, file: File): Promise<ApiResponse<PodComponent>> => {
    const formData = new FormData();
    formData.append('file', file, file.name);
    const response = await api.post<ApiResponse<PodComponent>>(`/pods/${name}/${version}/replace`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000,
    });
    return response.data;
  },

  /** 删除组件版本 */
  delete: async (name: string, version: string): Promise<ApiResponse> => {
    const response = await api.delete<ApiResponse>(`/pods/${name}/${version}`);
    return response.data;
  },

  /** 查询官方 CocoaPods 组件的可用版本列表 */
  officialVersions: async (name: string): Promise<ApiResponse<string[]>> => {
    const response = await api.get<ApiResponse<string[]>>(`/pods/official/${name}/versions`);
    return response.data;
  },

  /** 从官方 CocoaPods 导入组件 */
  importOfficial: async (name: string, version: string, buildBinary?: boolean, outputType?: string, depVersionOverrides?: Record<string, string>, selectedSubspecs?: string[], internalVersion?: string, prepareCommand?: string): Promise<ApiResponse<PodComponent>> => {
    const response = await api.post<ApiResponse<PodComponent>>('/pods/official/import', {
      name, version, buildBinary, outputType, depVersionOverrides, selectedSubspecs, internalVersion, prepareCommand,
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

export default api;
