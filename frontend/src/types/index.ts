export interface DSYMInfo {
  id: number;
  uuid: string;
  appName: string;
  version: string;
  buildNumber?: string;
  architecture: string;
  filePath: string;
  fileSize: number;
  notes?: string;
  relatedAppVersions?: string[]; // 关联的主应用版本列表
  uploadTime: string;
}

export interface CrashAnalysis {
  summary: string;
  crashType: string;
  possibleCauses: string[];
  suggestions: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedComponents: string[];
  appVersion?: string; // 主应用版本号
  crashThread?: string; // 崩溃线程
  crashModule?: string; // 崩溃模块
  crashStack?: string; // 崩溃堆栈快照
  crashLocation?: string; // 崩溃位置（类名、方法名）
  crashFile?: string; // 崩溃文件名
  crashLine?: number; // 崩溃行号
}

export interface SymbolicationResult {
  originalLog: string;
  symbolicatedLog: string;
  matchedUUID?: string; // 单个 UUID（向后兼容）
  matchedUUIDs?: string[]; // 多个 UUIDs
  warning?: string;
  analysis?: CrashAnalysis;
  aiAnalysis?: CrashAnalysis; // 兼容后端返回的字段名
  fromCache?: boolean; // 是否来自缓存
  fromHistory?: boolean; // 是否来自历史记录
  historyId?: number; // 历史记录ID，用于生成分享链接
}

export interface SentryIssueSummary {
  id: string;
  shortId?: string;
  title: string;
  culprit?: string;
  level?: string;
  status?: string;
  count?: string;
  userCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  permalink?: string;
}

export interface SentryIssueAnalysisResult {
  issue: SentryIssueSummary;
  eventId?: string;
  analysisLog?: string;
  analysis?: CrashAnalysis;
  error?: string;
}

export interface SentryFetchAnalyzeResult {
  period: string;
  query: string;
  total: number;
  results: SentryIssueAnalysisResult[];
}

export interface SentryIssueListResult {
  period: string;
  query: string;
  total: number;
  issues: SentryIssueSummary[];
}

export interface SentryAnalyzeSelectedResult {
  total: number;
  results: SentryIssueAnalysisResult[];
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
