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
  relatedAppVersions?: string[];  // 关联的主应用版本列表（用于组件库）
  uploadTime: string;
}

export interface CrashLog {
  content: string;
  uuid?: string;
  format: 'apple' | 'ips' | 'unknown';
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
}

export interface SymbolicationResult {
  originalLog: string;
  symbolicatedLog: string;
  matchedUUID: string;
  success: boolean;
  analysis?: CrashAnalysis;
}

export enum ErrorCode {
  INVALID_FILE_FORMAT = 'INVALID_FILE_FORMAT',
  UUID_NOT_FOUND = 'UUID_NOT_FOUND',
  DSYM_NOT_FOUND = 'DSYM_NOT_FOUND',
  SYMBOLICATION_FAILED = 'SYMBOLICATION_FAILED',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  INVALID_CRASH_LOG = 'INVALID_CRASH_LOG',
  AI_ANALYSIS_FAILED = 'AI_ANALYSIS_FAILED',
  INVALID_API_KEY = 'INVALID_API_KEY',
  AI_API_TIMEOUT = 'AI_API_TIMEOUT',
}

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    public message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'AppError';
  }
}
