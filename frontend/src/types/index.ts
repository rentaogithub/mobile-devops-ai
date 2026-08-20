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
  eventId?: string;
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
  appVersionRange?: string;
  minAppVersion?: string;
  maxAppVersion?: string;
  appVersions?: string[];
  excludedAppVersionOnly?: boolean;
  appVersionLoading?: boolean;
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

export interface SentryAggregateCrashPattern {
  title: string;
  issueIds: string[];
  sharedSymptoms: string[];
  commonStackSignals: string[];
  possibleRootCause: string;
  confidence: 'low' | 'medium' | 'high';
  evidence: string[];
}

export interface SentryAggregateCrashAnalysis {
  summary: string;
  conclusion: string;
  confidence: 'low' | 'medium' | 'high';
  patterns: SentryAggregateCrashPattern[];
  suspectedRootCauses: string[];
  verificationSteps: string[];
  fixSuggestions: string[];
  needsMoreData: string[];
}

export interface SentryAggregateAnalyzeResult {
  total: number;
  issues: Array<{
    id: string;
    shortId?: string;
    title: string;
    count?: string;
    userCount?: number;
    level?: string;
    appVersionRange?: string;
    eventId?: string;
  }>;
  analysis: SentryAggregateCrashAnalysis;
}

export interface SentrySymbolicateLogResult {
  issue: SentryIssueSummary;
  eventId?: string;
  crashLog: string;
}

export interface SentryOriginalCrashResult {
  issue: SentryIssueSummary;
  eventId?: string;
  incidentIdentifier?: string;
  crashLog: string;
  previewLog: string;
}

export interface SentrySymbolicateAnalyzeResult {
  issue: SentryIssueSummary;
  eventId?: string;
  incidentIdentifier?: string;
  appVersion: string;
  originalLog: string;
  symbolicatedLog: string;
  matchedUUIDs: string[];
  warning?: string;
  aiAnalysis?: CrashAnalysis;
  aiError?: string;
  historyId?: number;
}

export type CrashGovernanceStatus = 'new' | 'analyzing' | 'pending_fix' | 'fixed' | 'regression' | 'ignored';
export type CrashSymbolicationStatus = 'pending' | 'success' | 'failed' | 'incomplete';
export type CrashAIAnalysisStatus = 'pending' | 'success' | 'failed' | 'skipped';
export type CrashSymbolicationFailureCategory =
  | 'missing_dsym'
  | 'uuid_mismatch'
  | 'incomplete_log'
  | 'missing_system_symbols'
  | 'tool_failed'
  | 'unknown';

export interface CrashDSYMCoverageSummary {
  appVersion: string;
  mainAppReady: boolean;
  relatedReady: boolean;
  total: number;
  valid: number;
  missingDwarf: number;
  modules: Array<{
    appName: string;
    uuid: string;
    version: string;
    buildNumber?: string;
    valid: boolean;
    reason?: string;
  }>;
}

export interface CrashGovernanceRecord {
  id: number;
  source: 'sentry' | 'quality' | 'manual';
  sourceIssueId: string;
  shortId?: string;
  eventId?: string;
  permalink?: string;
  title: string;
  culprit?: string;
  level?: string;
  sentryStatus?: string;
  appVersion?: string;
  appVersionRange?: string;
  firstSeen?: string;
  lastSeen?: string;
  eventCount: number;
  userCount: number;
  crashType?: string;
  crashReason?: string;
  crashModule?: string;
  crashLocation?: string;
  fingerprint?: string;
  symbolicationStatus: CrashSymbolicationStatus;
  symbolicationError?: string;
  symbolicationFailureCategory?: CrashSymbolicationFailureCategory;
  analysisStatus: CrashAIAnalysisStatus;
  analysisError?: string;
  governanceStatus: CrashGovernanceStatus;
  owner?: string;
  fixedVersion?: string;
  fixedRemark?: string;
  ignoreReason?: string;
  historyId?: number;
  qualityTaskId?: string;
  releaseRecordId?: string;
  dsymCoverageStatus: 'ready' | 'missing' | 'partial' | 'unknown';
  dsymCoverage?: CrashDSYMCoverageSummary;
  retryCount: number;
  lastSyncedAt?: string;
  lastSyncError?: string;
  groupedIssueCount?: number;
  groupedIssueIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CrashGovernanceFingerprintGroup {
  fingerprint?: string;
  issueCount: number;
  eventCount: number;
  userCount: number;
  versions: string[];
  lastSeen?: string;
  records: CrashGovernanceRecord[];
}

export interface CrashGovernanceEvent {
  id: number;
  recordId: number;
  record?: CrashGovernanceRecord;
  action: 'status_update';
  scope: 'single' | 'fingerprint';
  fromStatus?: CrashGovernanceStatus;
  toStatus?: CrashGovernanceStatus;
  operator?: string;
  note?: string;
  relatedRecordIds: number[];
  createdAt: string;
}

export interface CrashGovernanceDashboard {
  summary: {
    totalOpen: number;
    newToday: number;
    highRisk: number;
    regressions: number;
    symbolicated: number;
    symbolicationFailed: number;
    analysisReady: number;
    analysisFailed: number;
    dsymReady: number;
    dsymMissing: number;
    lastSyncedAt?: string;
    excludedVersions: string[];
  };
  topIssues: CrashGovernanceRecord[];
  recentIssues: CrashGovernanceRecord[];
  regressions: CrashGovernanceRecord[];
  qualityEvidence: CrashGovernanceRecord[];
  manualEvidence: CrashGovernanceRecord[];
  symbolicationFailureBreakdown: Array<{
    category: CrashSymbolicationFailureCategory;
    count: number;
    eventCount: number;
    userCount: number;
    latestSeen?: string;
  }>;
  actionRecommendations: Array<{
    type: 'symbolication' | 'crash_risk' | 'sync' | 'dsym' | 'owner' | 'identification';
    priority: 'high' | 'medium' | 'low';
    title: string;
    description: string;
    action: string;
    relatedCategory?: CrashSymbolicationFailureCategory;
    targetFilters?: {
      status?: CrashGovernanceStatus | 'open';
      source?: 'sentry' | 'quality' | 'manual' | 'all';
      owner?: string;
      keyword?: string;
      symbolicationFailureCategory?: CrashSymbolicationFailureCategory;
    };
    count?: number;
  }>;
  crashInsightSummary: {
    identifiedCount: number;
    unidentifiedCount: number;
    identificationRate: number;
    topTypes: Array<{
      name: string;
      count: number;
      eventCount: number;
      userCount: number;
    }>;
    topModules: Array<{
      name: string;
      count: number;
      eventCount: number;
      userCount: number;
    }>;
    topReasons: Array<{
      name: string;
      count: number;
      eventCount: number;
      userCount: number;
    }>;
  };
  dsymCoverage: Array<{
    appVersion: string;
    status: 'ready' | 'missing' | 'partial' | 'unknown';
    total: number;
    valid: number;
    mainAppReady: boolean;
    relatedReady: boolean;
  }>;
  versionHealth: Array<{
    appVersion: string;
    status: 'healthy' | 'warning' | 'critical';
    openCrashCount: number;
    highRiskCount: number;
    regressionCount: number;
    dsymMissingCount: number;
    symbolicationFailedCount: number;
    lastSeen?: string;
  }>;
  syncHealth: {
    status: 'healthy' | 'warning' | 'failed' | 'never_synced';
    lastSyncedAt?: string;
    staleThresholdHours: number;
    staleHours?: number;
    failedCount: number;
    retryCount: number;
    neverSyncedCount: number;
    message: string;
  };
  governanceActivity: {
    recent7dCount: number;
    singleCount: number;
    fingerprintCount: number;
    lastEvent?: CrashGovernanceEvent;
    topOperators: Array<{
      operator: string;
      count: number;
    }>;
  };
  governanceStatusDistribution: Array<{
    status: CrashGovernanceStatus;
    count: number;
    eventCount: number;
    userCount: number;
  }>;
  ownerTodoDistribution: Array<{
    owner: string;
    count: number;
    highRiskCount: number;
    regressionCount: number;
    overdueCount: number;
    oldestOpenAgeDays: number;
    overdueThresholdDays: number;
    eventCount: number;
    userCount: number;
    latestSeen?: string;
  }>;
}

export interface CrashGovernanceConfig {
  excludedVersions: string[];
  defaultIssueQuery: string;
  updatedAt?: string;
}

export interface HistoryRecord {
  id: number;
  appVersion: string;
  versionDetected: boolean;
  crashType?: string;
  crashReason?: string;
  lastStackCall?: string;
  crashModule?: string;
  crashLocation?: string;
  originalLog: string;
  symbolicatedLog: string;
  usedUuids: string[];
  aiAnalysis?: CrashAnalysis;
  isFixed: boolean;
  fixedVersion?: string;
  fixedRemark?: string;
  createdAt: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  code?: string;
  error?: string;
  details?: string | string[] | Record<string, unknown>;
  warning?: string;
}
