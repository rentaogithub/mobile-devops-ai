import { getDatabase } from '../database';
import { CrashAnalysis } from '../types';
import type { SentryIssueSummary } from './SentryIssueService';
import { currentProductLineId } from './ProductLineContext';
import historyService from './HistoryService';
import { dsymMatcherService, DSYMCoverageSummary } from './DSYMMatcherService';

const OWNER_TODO_OVERDUE_DAYS = Math.max(Number(process.env.CRASH_GOVERNANCE_OWNER_TODO_OVERDUE_DAYS || 3), 1);

export type CrashGovernanceStatus = 'new' | 'analyzing' | 'pending_fix' | 'fixed' | 'regression' | 'ignored';
export type CrashSymbolicationStatus = 'pending' | 'success' | 'failed' | 'incomplete';
export type CrashAnalysisStatus = 'pending' | 'success' | 'failed' | 'skipped';
export type CrashSymbolicationFailureCategory =
  | 'missing_dsym'
  | 'uuid_mismatch'
  | 'incomplete_log'
  | 'missing_system_symbols'
  | 'tool_failed'
  | 'unknown';

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
  analysisStatus: CrashAnalysisStatus;
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
  dsymCoverage?: DSYMCoverageSummary;
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

export interface CrashReleaseHealth {
  status: 'healthy' | 'warning' | 'critical';
  appVersion: string;
  openCrashCount: number;
  highRiskCount: number;
  regressionCount: number;
  dsymMissingCount: number;
  symbolicationFailedCount: number;
  highRisks: CrashGovernanceRecord[];
  regressions: CrashGovernanceRecord[];
  dsymMissing: CrashGovernanceRecord[];
  symbolicationFailures: CrashGovernanceRecord[];
  supportingEvidence: {
    qualityCrashCount: number;
    manualCrashCount: number;
    qualityEvidence: CrashGovernanceRecord[];
    manualEvidence: CrashGovernanceRecord[];
  };
  recommendations: string[];
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeCount(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeVersion(value?: string): string {
  return String(value || '').trim();
}

function normalizeFingerprintPart(value?: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/0x[0-9a-f]+/gi, '0x')
    .replace(/<unknown>/g, '')
    .replace(/\bline\s+\d+\b/g, 'line')
    .replace(/:\d+\b/g, ':line')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

function buildFingerprint(input: {
  sourceIssueId?: string;
  title?: string;
  culprit?: string;
  crashType?: string;
  crashReason?: string;
  crashModule?: string;
  crashLocation?: string;
  appVersion?: string;
}): string {
  const structuredParts = [
    input.crashType,
    input.crashReason,
    input.crashModule,
    input.crashLocation,
    input.culprit,
  ]
    .map(normalizeFingerprintPart)
    .filter(Boolean)
    .join('|');
  if (structuredParts) {
    return structuredParts;
  }
  const titlePart = normalizeFingerprintPart(input.title);
  if (titlePart) {
    return titlePart;
  }
  return [
    input.sourceIssueId,
    input.appVersion,
  ]
    .map(normalizeFingerprintPart)
    .filter(Boolean)
    .join('|');
}

function isOpenCrash(record: CrashGovernanceRecord): boolean {
  return !['fixed', 'ignored'].includes(record.governanceStatus);
}

function isHighRiskCrash(record: CrashGovernanceRecord): boolean {
  return ['fatal', 'critical', 'error'].includes(String(record.level || '').toLowerCase()) ||
    record.eventCount >= 20 ||
    record.userCount >= 5;
}

function compareVersionDesc(a: string, b: string): number {
  const left = a.split('.').map((part) => Number(part) || 0);
  const right = b.split('.').map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (right[index] || 0) - (left[index] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return b.localeCompare(a);
}

function buildSyncHealth(records: CrashGovernanceRecord[], lastSyncedAt?: string): CrashGovernanceDashboard['syncHealth'] {
  const staleThresholdHours = Math.max(Number(process.env.CRASH_GOVERNANCE_STALE_HOURS || 6), 1);
  const failedCount = records.filter((record) => Boolean(record.lastSyncError)).length;
  const retryCount = records.reduce((sum, record) => sum + normalizeCount(record.retryCount), 0);
  const neverSyncedCount = records.filter((record) => !record.lastSyncedAt).length;
  if (!lastSyncedAt) {
    return {
      status: 'never_synced',
      staleThresholdHours,
      failedCount,
      retryCount,
      neverSyncedCount,
      message: '尚未完成 Sentry 同步，请先执行同步 Crash 状态。',
    };
  }

  const syncedAt = Date.parse(lastSyncedAt);
  const staleHours = Number.isFinite(syncedAt) ? (Date.now() - syncedAt) / (60 * 60 * 1000) : undefined;
  if (failedCount > 0) {
    return {
      status: 'failed',
      lastSyncedAt,
      staleThresholdHours,
      staleHours: staleHours === undefined ? undefined : Number(staleHours.toFixed(1)),
      failedCount,
      retryCount,
      neverSyncedCount,
      message: `最近同步存在 ${failedCount} 条失败记录，请查看治理列表中的同步失败原因。`,
    };
  }
  if (staleHours !== undefined && staleHours > staleThresholdHours) {
    return {
      status: 'warning',
      lastSyncedAt,
      staleThresholdHours,
      staleHours: Number(staleHours.toFixed(1)),
      failedCount,
      retryCount,
      neverSyncedCount,
      message: `距离上次同步已 ${staleHours.toFixed(1)} 小时，建议刷新线上 Crash 状态。`,
    };
  }

  return {
    status: 'healthy',
    lastSyncedAt,
    staleThresholdHours,
    staleHours: staleHours === undefined ? undefined : Number(staleHours.toFixed(1)),
    failedCount,
    retryCount,
    neverSyncedCount,
    message: 'Sentry 同步状态正常。',
  };
}

function classifySymbolicationFailure(error?: string, status?: CrashSymbolicationStatus): CrashSymbolicationFailureCategory | undefined {
  if (status === 'success' || status === 'pending') {
    return undefined;
  }
  const message = String(error || '').toLowerCase();
  if (status === 'incomplete' ||
    message.includes('信息不全') ||
    message.includes('缺少可符号化信息') ||
    message.includes('无线程') ||
    message.includes('threads') ||
    message.includes('binaryimages') ||
    message.includes('binary images') ||
    message.includes('debug images') ||
    message.includes('日志结构')) {
    return 'incomplete_log';
  }
  if (message.includes('uuid 不匹配') ||
    message.includes('uuid mismatch') ||
    message.includes('uuid与') ||
    message.includes('uuid 与') ||
    message.includes('不匹配')) {
    return 'uuid_mismatch';
  }
  if (message.includes('未找到') && (message.includes('dsym') || message.includes('dwarf')) ||
    message.includes('缺少') && (message.includes('dsym') || message.includes('dwarf')) ||
    message.includes('dsym not found') ||
    message.includes('no dsym')) {
    return 'missing_dsym';
  }
  if (message.includes('系统符号') ||
    message.includes('device support') ||
    message.includes('ios devicesupport')) {
    return 'missing_system_symbols';
  }
  if (message.includes('atos') ||
    message.includes('dwarfdump') ||
    message.includes('xcrun') ||
    message.includes('command failed') ||
    message.includes('执行失败') ||
    message.includes('超时') ||
    message.includes('timeout')) {
    return 'tool_failed';
  }
  return error || status === 'failed' || status === 'incomplete' ? 'unknown' : undefined;
}

function ensureColumn(db: any, tableName: string, columnName: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  if (!columns.some((column) => column.name === columnName)) {
    db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
  }
}

function groupTopCrashRecords(records: CrashGovernanceRecord[]): CrashGovernanceRecord[] {
  const groups = new Map<string, CrashGovernanceRecord[]>();
  records.forEach((record) => {
    const key = record.fingerprint || `record:${record.id}`;
    const group = groups.get(key) || [];
    group.push(record);
    groups.set(key, group);
  });

  return Array.from(groups.values())
    .map((group) => {
      const representative = [...group].sort((a, b) => {
        const eventDiff = normalizeCount(b.eventCount) - normalizeCount(a.eventCount);
        if (eventDiff !== 0) {
          return eventDiff;
        }
        return (Date.parse(b.lastSeen || b.updatedAt) || 0) - (Date.parse(a.lastSeen || a.updatedAt) || 0);
      })[0];
      const lastSeen = group
        .map((record) => record.lastSeen)
        .filter((value): value is string => Boolean(value))
        .sort()
        .pop() || representative.lastSeen;
      return {
        ...representative,
        eventCount: group.reduce((sum, record) => sum + normalizeCount(record.eventCount), 0),
        userCount: group.reduce((sum, record) => sum + normalizeCount(record.userCount), 0),
        lastSeen,
        groupedIssueCount: group.length,
        groupedIssueIds: group.map((record) => record.sourceIssueId),
      };
    })
    .sort((a, b) => normalizeCount(b.eventCount) - normalizeCount(a.eventCount))
    .slice(0, 10);
}

function buildSymbolicationFailureBreakdown(records: CrashGovernanceRecord[]): CrashGovernanceDashboard['symbolicationFailureBreakdown'] {
  const groups = new Map<CrashSymbolicationFailureCategory, {
    category: CrashSymbolicationFailureCategory;
    count: number;
    eventCount: number;
    userCount: number;
    latestSeen?: string;
  }>();

  records
    .filter((record) => record.symbolicationStatus === 'failed' || record.symbolicationStatus === 'incomplete')
    .forEach((record) => {
      const category = record.symbolicationFailureCategory || 'unknown';
      const current = groups.get(category) || {
        category,
        count: 0,
        eventCount: 0,
        userCount: 0,
        latestSeen: undefined,
      };
      current.count += 1;
      current.eventCount += normalizeCount(record.eventCount);
      current.userCount += normalizeCount(record.userCount);
      const recordSeen = record.lastSeen || record.updatedAt;
      if (recordSeen && (!current.latestSeen || recordSeen > current.latestSeen)) {
        current.latestSeen = recordSeen;
      }
      groups.set(category, current);
    });

  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count || b.eventCount - a.eventCount);
}

function buildGovernanceStatusDistribution(records: CrashGovernanceRecord[]): CrashGovernanceDashboard['governanceStatusDistribution'] {
  const statusOrder: CrashGovernanceStatus[] = ['new', 'analyzing', 'pending_fix', 'regression', 'fixed', 'ignored'];
  const groups = new Map<CrashGovernanceStatus, {
    status: CrashGovernanceStatus;
    count: number;
    eventCount: number;
    userCount: number;
  }>();
  statusOrder.forEach((status) => {
    groups.set(status, {
      status,
      count: 0,
      eventCount: 0,
      userCount: 0,
    });
  });

  records.forEach((record) => {
    const current = groups.get(record.governanceStatus) || {
      status: record.governanceStatus,
      count: 0,
      eventCount: 0,
      userCount: 0,
    };
    current.count += 1;
    current.eventCount += normalizeCount(record.eventCount);
    current.userCount += normalizeCount(record.userCount);
    groups.set(record.governanceStatus, current);
  });

  return statusOrder
    .map((status) => groups.get(status)!)
    .filter((item) => item.count > 0);
}

function buildOwnerTodoDistribution(records: CrashGovernanceRecord[]): CrashGovernanceDashboard['ownerTodoDistribution'] {
  const groups = new Map<string, {
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
  }>();

  records.filter(isOpenCrash).forEach((record) => {
    const owner = String(record.owner || '').trim() || '未分配';
    const current = groups.get(owner) || {
      owner,
      count: 0,
      highRiskCount: 0,
      regressionCount: 0,
      overdueCount: 0,
      oldestOpenAgeDays: 0,
      overdueThresholdDays: OWNER_TODO_OVERDUE_DAYS,
      eventCount: 0,
      userCount: 0,
      latestSeen: undefined,
    };
    const openedAt = Date.parse(record.firstSeen || record.createdAt || '');
    const openAgeDays = openedAt ? Math.max(Math.floor((Date.now() - openedAt) / (24 * 60 * 60 * 1000)), 0) : 0;
    current.count += 1;
    current.highRiskCount += isHighRiskCrash(record) ? 1 : 0;
    current.regressionCount += record.governanceStatus === 'regression' ? 1 : 0;
    current.overdueCount += openAgeDays >= OWNER_TODO_OVERDUE_DAYS ? 1 : 0;
    current.oldestOpenAgeDays = Math.max(current.oldestOpenAgeDays, openAgeDays);
    current.eventCount += normalizeCount(record.eventCount);
    current.userCount += normalizeCount(record.userCount);
    const recordSeen = record.lastSeen || record.updatedAt;
    if (recordSeen && (!current.latestSeen || recordSeen > current.latestSeen)) {
      current.latestSeen = recordSeen;
    }
    groups.set(owner, current);
  });

  return Array.from(groups.values())
    .sort((a, b) => b.overdueCount - a.overdueCount
      || b.regressionCount - a.regressionCount
      || b.highRiskCount - a.highRiskCount
      || b.oldestOpenAgeDays - a.oldestOpenAgeDays
      || b.count - a.count
      || b.eventCount - a.eventCount
      || a.owner.localeCompare(b.owner))
    .slice(0, 12);
}

function normalizeInsightName(value?: string, fallback = '未识别'): string {
  return String(value || '').trim() || fallback;
}

function trimCrashModuleName(value?: string): string {
  const text = normalizeInsightName(value);
  if (text === '未识别') {
    return text;
  }
  return text.split(' - ')[0]?.trim() || text;
}

function buildCrashInsightSummary(records: CrashGovernanceRecord[]): CrashGovernanceDashboard['crashInsightSummary'] {
  const buildTop = (selector: (record: CrashGovernanceRecord) => string) => {
    const groups = new Map<string, {
      name: string;
      count: number;
      eventCount: number;
      userCount: number;
    }>();
    records.forEach((record) => {
      const name = selector(record);
      const current = groups.get(name) || {
        name,
        count: 0,
        eventCount: 0,
        userCount: 0,
      };
      current.count += 1;
      current.eventCount += normalizeCount(record.eventCount);
      current.userCount += normalizeCount(record.userCount);
      groups.set(name, current);
    });
    return Array.from(groups.values())
      .sort((a, b) => b.count - a.count || b.eventCount - a.eventCount || b.userCount - a.userCount || a.name.localeCompare(b.name))
      .slice(0, 8);
  };
  const identifiedCount = records.filter((record) => Boolean(record.crashType || record.crashModule || record.crashLocation)).length;
  const unidentifiedCount = Math.max(records.length - identifiedCount, 0);
  return {
    identifiedCount,
    unidentifiedCount,
    identificationRate: records.length > 0 ? Math.round((identifiedCount / records.length) * 100) : 0,
    topTypes: buildTop((record) => normalizeInsightName(record.crashType || record.level, '未知类型')),
    topModules: buildTop((record) => trimCrashModuleName(record.crashModule || record.culprit)),
    topReasons: buildTop((record) => normalizeInsightName(record.crashReason || record.title, '未知原因')),
  };
}

function toCsvCell(value: unknown): string {
  const text = Array.isArray(value) ? value.join(';') : String(value ?? '');
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

function buildActionRecommendations(input: {
  highRiskCount: number;
  regressionCount: number;
  dsymMissingCount: number;
  syncHealth: CrashGovernanceDashboard['syncHealth'];
  failureBreakdown: CrashGovernanceDashboard['symbolicationFailureBreakdown'];
  ownerTodos: CrashGovernanceDashboard['ownerTodoDistribution'];
  crashInsightSummary: CrashGovernanceDashboard['crashInsightSummary'];
}): CrashGovernanceDashboard['actionRecommendations'] {
  const recommendations: CrashGovernanceDashboard['actionRecommendations'] = [];
  if (input.crashInsightSummary.unidentifiedCount > 0 && input.crashInsightSummary.identificationRate < 80) {
    recommendations.push({
      type: 'identification',
      priority: 'high',
      title: '提升崩溃识别完整度',
      description: `当前线上 Crash 识别完整度 ${input.crashInsightSummary.identificationRate}%，仍有 ${input.crashInsightSummary.unidentifiedCount} 条缺少类型、模块或位置。`,
      action: '优先完成符号化和 AI 分析，确保 Crash 能归类到具体类型、模块和调用位置。',
      targetFilters: {
        source: 'sentry',
        status: 'open',
      },
      count: input.crashInsightSummary.unidentifiedCount,
    });
  }
  const unassigned = input.ownerTodos.find((item) => item.owner === '未分配');
  if (unassigned?.count) {
    recommendations.push({
      type: 'owner',
      priority: unassigned.highRiskCount > 0 || unassigned.overdueCount > 0 ? 'high' : 'medium',
      title: '先分派未分配 Crash',
      description: `当前有 ${unassigned.count} 条未解决线上 Crash 还没有负责人，其中逾期 ${unassigned.overdueCount} 条、高风险 ${unassigned.highRiskCount} 条。`,
      action: '打开未分配列表，优先给高风险、疑似回归和逾期记录补充负责人。',
      targetFilters: {
        source: 'sentry',
        status: 'open',
        owner: '未分配',
      },
      count: unassigned.count,
    });
  }
  const overdueOwner = input.ownerTodos.find((item) => item.owner !== '未分配' && item.overdueCount > 0);
  if (overdueOwner) {
    recommendations.push({
      type: 'owner',
      priority: overdueOwner.highRiskCount > 0 || overdueOwner.regressionCount > 0 ? 'high' : 'medium',
      title: '跟进逾期待办负责人',
      description: `${overdueOwner.owner} 名下有 ${overdueOwner.overdueCount} 条 Crash 超过 ${overdueOwner.overdueThresholdDays} 天未关闭，最久 ${overdueOwner.oldestOpenAgeDays} 天。`,
      action: '打开该负责人未解决列表，确认是否需要补充修复版本、关联构建或调整负责人。',
      targetFilters: {
        source: 'sentry',
        status: 'open',
        owner: overdueOwner.owner,
      },
      count: overdueOwner.overdueCount,
    });
  }
  if (input.regressionCount > 0) {
    recommendations.push({
      type: 'crash_risk',
      priority: 'high',
      title: '优先确认疑似回归 Crash',
      description: `当前存在 ${input.regressionCount} 条疑似回归记录，可能是已修复问题在新版本重新出现。`,
      action: '打开治理列表筛选“疑似回归”，确认修复版本、负责人和关联构建。',
      count: input.regressionCount,
    });
  }
  if (input.highRiskCount > 0) {
    recommendations.push({
      type: 'crash_risk',
      priority: 'high',
      title: '处理未解决高风险 Crash',
      description: `当前存在 ${input.highRiskCount} 条高风险线上 Crash，可能影响发布健康。`,
      action: '优先完成符号化和 AI 分析，补充负责人、修复版本和处理备注。',
      count: input.highRiskCount,
    });
  }
  if (input.dsymMissingCount > 0) {
    recommendations.push({
      type: 'dsym',
      priority: 'medium',
      title: '补齐缺失 dSYM',
      description: `当前有 ${input.dsymMissingCount} 条记录的 dSYM 覆盖缺失。`,
      action: '检查对应版本主包和组件 dSYM 是否已同步到 dSYM 文件管理，补齐后重查 dSYM。',
      count: input.dsymMissingCount,
    });
  }

  input.failureBreakdown.forEach((item) => {
    if (item.category === 'missing_dsym') {
      recommendations.push({
        type: 'symbolication',
        priority: 'high',
        title: '符号化失败集中在缺 dSYM',
        description: `${item.count} 条未解决 Crash 因缺 dSYM 无法准确归因，影响 ${item.eventCount} 次事件。`,
        action: '按 App 版本筛选记录，补齐主包、leigod_im_cross_sdk、NNRtc 等相关 dSYM 后重新符号化。',
        relatedCategory: item.category,
        count: item.count,
      });
    } else if (item.category === 'uuid_mismatch') {
      recommendations.push({
        type: 'symbolication',
        priority: 'high',
        title: '存在 UUID 不匹配',
        description: `${item.count} 条记录疑似使用了错误构建产物或错误版本 dSYM。`,
        action: '核对 Sentry Event 的 debug images UUID、Jenkins 构建号、xcarchive 和 dSYM UUID 是否一致。',
        relatedCategory: item.category,
        count: item.count,
      });
    } else if (item.category === 'incomplete_log') {
      recommendations.push({
        type: 'symbolication',
        priority: 'medium',
        title: '部分日志结构不完整',
        description: `${item.count} 条记录缺少线程、Binary Images 或 debug images 信息。`,
        action: '优先拉取完整 Sentry Event 或设备原始 ips/crash 文件，再重新解析。',
        relatedCategory: item.category,
        count: item.count,
      });
    } else if (item.category === 'missing_system_symbols') {
      recommendations.push({
        type: 'symbolication',
        priority: 'medium',
        title: '系统符号缺失',
        description: `${item.count} 条记录需要对应 iOS DeviceSupport 或系统符号。`,
        action: '检查 Jenkins 节点 Xcode DeviceSupport 是否包含对应 iOS 版本。',
        relatedCategory: item.category,
        count: item.count,
      });
    } else if (item.category === 'tool_failed') {
      recommendations.push({
        type: 'symbolication',
        priority: 'medium',
        title: '符号化工具执行失败',
        description: `${item.count} 条记录在 atos、dwarfdump 或 xcrun 链路失败。`,
        action: '检查 Xcode 命令行工具、dSYM 文件完整性和符号化命令超时日志。',
        relatedCategory: item.category,
        count: item.count,
      });
    }
  });

  if (input.syncHealth.status === 'failed' || input.syncHealth.status === 'never_synced') {
    recommendations.push({
      type: 'sync',
      priority: input.syncHealth.status === 'failed' ? 'high' : 'medium',
      title: input.syncHealth.status === 'failed' ? '修复 Sentry 同步失败' : '先同步线上 Crash',
      description: input.syncHealth.message,
      action: '检查 Sentry Token、项目配置和网络连通性后重新同步 Crash 状态。',
      count: input.syncHealth.failedCount || input.syncHealth.neverSyncedCount,
    });
  }

  return recommendations.slice(0, 8);
}

function normalizeExcludedVersions(versions: unknown): string[] {
  const raw = Array.isArray(versions)
    ? versions
    : String(versions || (currentProductLineId() === 'nn' ? process.env.SENTRY_EXCLUDED_APP_VERSIONS || '10.0.0' : '')).split(',');
  return Array.from(new Set(
    raw
      .map((version) => String(version || '').trim())
      .filter(Boolean)
  ));
}

function buildDefaultIssueQuery(excludedVersions: string[]): string {
  return `is:unresolved ${excludedVersions
    .map((version) => `!release:"${version.replace(/"/g, '\\"')}"`)
    .join(' ')}`.trim();
}

export class CrashGovernanceService {
  private get db() {
    return getDatabase();
  }

  ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS crash_governance_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL DEFAULT 'sentry',
        source_issue_id TEXT NOT NULL,
        short_id TEXT,
        event_id TEXT,
        permalink TEXT,
        title TEXT NOT NULL,
        culprit TEXT,
        level TEXT,
        sentry_status TEXT,
        app_version TEXT,
        app_version_range TEXT,
        first_seen TEXT,
        last_seen TEXT,
        event_count INTEGER DEFAULT 0,
        user_count INTEGER DEFAULT 0,
        crash_type TEXT,
        crash_reason TEXT,
        crash_module TEXT,
        crash_location TEXT,
        fingerprint TEXT,
        symbolication_status TEXT NOT NULL DEFAULT 'pending',
        symbolication_error TEXT,
        symbolication_failure_category TEXT,
        analysis_status TEXT NOT NULL DEFAULT 'pending',
        analysis_error TEXT,
        governance_status TEXT NOT NULL DEFAULT 'new',
        owner TEXT,
        fixed_version TEXT,
        fixed_remark TEXT,
        ignore_reason TEXT,
        history_id INTEGER,
        quality_task_id TEXT,
        release_record_id TEXT,
        dsym_coverage_status TEXT NOT NULL DEFAULT 'unknown',
        dsym_coverage_json TEXT,
        retry_count INTEGER DEFAULT 0,
        last_synced_at TEXT,
        last_sync_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        product_line_id TEXT NOT NULL DEFAULT 'nn',
        UNIQUE(product_line_id, source, source_issue_id)
      );
      CREATE INDEX IF NOT EXISTS idx_crash_governance_updated
        ON crash_governance_records(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_crash_governance_status
        ON crash_governance_records(governance_status, last_seen DESC);
      CREATE INDEX IF NOT EXISTS idx_crash_governance_app_version
        ON crash_governance_records(app_version);
      CREATE TABLE IF NOT EXISTS crash_governance_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id INTEGER NOT NULL,
        notification_type TEXT NOT NULL,
        sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        product_line_id TEXT NOT NULL DEFAULT 'nn',
        UNIQUE(product_line_id, record_id, notification_type)
      );
      CREATE INDEX IF NOT EXISTS idx_crash_governance_notifications_record
        ON crash_governance_notifications(record_id);
      CREATE TABLE IF NOT EXISTS crash_governance_config (
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        product_line_id TEXT NOT NULL DEFAULT 'nn',
        PRIMARY KEY (product_line_id, key)
      );
      CREATE TABLE IF NOT EXISTS crash_governance_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'single',
        from_status TEXT,
        to_status TEXT,
        operator TEXT,
        note TEXT,
        related_record_ids_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        product_line_id TEXT NOT NULL DEFAULT 'nn'
      );
      CREATE INDEX IF NOT EXISTS idx_crash_governance_events_record
        ON crash_governance_events(record_id, created_at DESC);
    `);
    const ensureProductColumn = (table: string) => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'product_line_id')) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN product_line_id TEXT NOT NULL DEFAULT 'nn'`);
      }
    };
    ensureProductColumn('crash_governance_records');
    ensureProductColumn('crash_governance_notifications');
    ensureProductColumn('crash_governance_events');
    ensureColumn(this.db, 'crash_governance_records', 'symbolication_failure_category', 'TEXT');
    const hasLegacyUniqueIndex = (table: string, expectedColumns: string[]) => {
      const indexes = this.db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>;
      return indexes.some((index) => {
        if (!index.unique) {
          return false;
        }
        const columns = this.db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>;
        return columns.map((column) => column.name).join(',') === expectedColumns.join(',');
      });
    };
    if (hasLegacyUniqueIndex('crash_governance_records', ['source', 'source_issue_id'])) {
      this.db.exec(`
        ALTER TABLE crash_governance_records RENAME TO crash_governance_records_legacy;
        CREATE TABLE crash_governance_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL DEFAULT 'sentry',
          source_issue_id TEXT NOT NULL,
          short_id TEXT,
          event_id TEXT,
          permalink TEXT,
          title TEXT NOT NULL,
          culprit TEXT,
          level TEXT,
          sentry_status TEXT,
          app_version TEXT,
          app_version_range TEXT,
          first_seen TEXT,
          last_seen TEXT,
          event_count INTEGER DEFAULT 0,
          user_count INTEGER DEFAULT 0,
          crash_type TEXT,
          crash_reason TEXT,
          crash_module TEXT,
          crash_location TEXT,
          fingerprint TEXT,
          symbolication_status TEXT NOT NULL DEFAULT 'pending',
          symbolication_error TEXT,
          symbolication_failure_category TEXT,
          analysis_status TEXT NOT NULL DEFAULT 'pending',
          analysis_error TEXT,
          governance_status TEXT NOT NULL DEFAULT 'new',
          owner TEXT,
          fixed_version TEXT,
          fixed_remark TEXT,
          ignore_reason TEXT,
          history_id INTEGER,
          quality_task_id TEXT,
          release_record_id TEXT,
          dsym_coverage_status TEXT NOT NULL DEFAULT 'unknown',
          dsym_coverage_json TEXT,
          retry_count INTEGER DEFAULT 0,
          last_synced_at TEXT,
          last_sync_error TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          product_line_id TEXT NOT NULL DEFAULT 'nn',
          UNIQUE(product_line_id, source, source_issue_id)
        );
        INSERT INTO crash_governance_records (
          id, source, source_issue_id, short_id, event_id, permalink, title, culprit, level, sentry_status,
          app_version, app_version_range, first_seen, last_seen, event_count, user_count,
          crash_type, crash_reason, crash_module, crash_location, fingerprint,
          symbolication_status, symbolication_error, symbolication_failure_category,
          analysis_status, analysis_error, governance_status, owner, fixed_version, fixed_remark, ignore_reason,
          history_id, quality_task_id, release_record_id, dsym_coverage_status, dsym_coverage_json,
          retry_count, last_synced_at, last_sync_error, created_at, updated_at, product_line_id
        )
        SELECT
          id, source, source_issue_id, short_id, event_id, permalink, title, culprit, level, sentry_status,
          app_version, app_version_range, first_seen, last_seen, event_count, user_count,
          crash_type, crash_reason, crash_module, crash_location, fingerprint,
          symbolication_status, symbolication_error, symbolication_failure_category,
          analysis_status, analysis_error, governance_status, owner, fixed_version, fixed_remark, ignore_reason,
          history_id, quality_task_id, release_record_id, dsym_coverage_status, dsym_coverage_json,
          retry_count, last_synced_at, last_sync_error, created_at, updated_at,
          COALESCE(NULLIF(product_line_id, ''), 'nn')
        FROM crash_governance_records_legacy;
        DROP TABLE crash_governance_records_legacy;
      `);
    }
    if (hasLegacyUniqueIndex('crash_governance_notifications', ['record_id', 'notification_type'])) {
      this.db.exec(`
        ALTER TABLE crash_governance_notifications RENAME TO crash_governance_notifications_legacy;
        CREATE TABLE crash_governance_notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_id INTEGER NOT NULL,
          notification_type TEXT NOT NULL,
          sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          product_line_id TEXT NOT NULL DEFAULT 'nn',
          UNIQUE(product_line_id, record_id, notification_type)
        );
        INSERT INTO crash_governance_notifications (
          id, record_id, notification_type, sent_at, product_line_id
        )
        SELECT id, record_id, notification_type, sent_at, COALESCE(NULLIF(product_line_id, ''), 'nn')
        FROM crash_governance_notifications_legacy;
        DROP TABLE crash_governance_notifications_legacy;
      `);
    }
    const configColumns = this.db.prepare('PRAGMA table_info(crash_governance_config)').all() as Array<{ name: string; pk: number }>;
    if (!configColumns.some((column) => column.name === 'product_line_id')) {
      this.db.exec(`
        ALTER TABLE crash_governance_config RENAME TO crash_governance_config_legacy;
        CREATE TABLE crash_governance_config (
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          product_line_id TEXT NOT NULL DEFAULT 'nn',
          PRIMARY KEY (product_line_id, key)
        );
        INSERT INTO crash_governance_config (key, value, updated_at, product_line_id)
        SELECT key, value, updated_at, 'nn' FROM crash_governance_config_legacy;
        DROP TABLE crash_governance_config_legacy;
      `);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_crash_governance_updated
        ON crash_governance_records(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_crash_governance_status
        ON crash_governance_records(governance_status, last_seen DESC);
      CREATE INDEX IF NOT EXISTS idx_crash_governance_app_version
        ON crash_governance_records(app_version);
      CREATE INDEX IF NOT EXISTS idx_crash_governance_notifications_record
        ON crash_governance_notifications(record_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_crash_governance_source_product
        ON crash_governance_records(product_line_id, source, source_issue_id);
      CREATE INDEX IF NOT EXISTS idx_crash_governance_product_updated
        ON crash_governance_records(product_line_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_crash_governance_notification_product
        ON crash_governance_notifications(product_line_id, record_id, notification_type);
      CREATE INDEX IF NOT EXISTS idx_crash_governance_events_product
        ON crash_governance_events(product_line_id, created_at DESC);
    `);
  }

  getConfig(): CrashGovernanceConfig {
    this.ensureTable();
    const row = this.db.prepare(`
      SELECT value, updated_at FROM crash_governance_config
      WHERE product_line_id = ? AND key = 'excluded_versions'
      LIMIT 1
    `).get(currentProductLineId()) as any;
    const excludedVersions = normalizeExcludedVersions(row?.value ? safeJsonParse<string[]>(row.value, []) : undefined);
    return {
      excludedVersions,
      defaultIssueQuery: buildDefaultIssueQuery(excludedVersions),
      updatedAt: row?.updated_at || undefined,
    };
  }

  updateConfig(payload: { excludedVersions?: unknown }): CrashGovernanceConfig {
    this.ensureTable();
    const excludedVersions = normalizeExcludedVersions(payload.excludedVersions);
    this.db.prepare(`
      INSERT INTO crash_governance_config (key, value, updated_at, product_line_id)
      VALUES ('excluded_versions', ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(product_line_id, key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).run(JSON.stringify(excludedVersions), currentProductLineId());
    return this.getConfig();
  }

  getExcludedVersions(): string[] {
    return this.getConfig().excludedVersions;
  }

  getDefaultIssueQuery(): string {
    return this.getConfig().defaultIssueQuery;
  }

  upsertSentryIssue(issue: SentryIssueSummary, options: {
    eventId?: string;
    historyId?: number;
    analysis?: CrashAnalysis;
    symbolicationStatus?: CrashSymbolicationStatus;
    symbolicationError?: string;
    analysisStatus?: CrashAnalysisStatus;
    analysisError?: string;
    syncError?: string;
  } = {}): CrashGovernanceRecord {
    this.ensureTable();
    const sourceIssueId = String(issue.id || issue.shortId || '').trim();
    if (!sourceIssueId) {
      throw new Error('Sentry Issue 缺少 ID，无法入库');
    }

    const appVersion = normalizeVersion(issue.maxAppVersion || issue.minAppVersion || issue.appVersionRange?.split(' - ').pop());
    const existing = this.getBySourceIssueId(sourceIssueId);
    const previousStatus = existing?.governanceStatus;
    const governanceStatus = this.nextGovernanceStatus(existing, issue);
    const analysis = options.analysis;
    const crashType = analysis?.crashType || existing?.crashType;
    const crashModule = analysis?.crashModule || existing?.crashModule;
    const crashLocation = analysis?.crashLocation || existing?.crashLocation;
    const fingerprint = buildFingerprint({
      sourceIssueId,
      title: issue.title,
      culprit: issue.culprit,
      crashType,
      crashReason: existing?.crashReason,
      crashModule,
      crashLocation,
      appVersion,
    });
    const now = new Date().toISOString();
    const symbolicationStatus = options.symbolicationStatus || existing?.symbolicationStatus || 'pending';
    const symbolicationFailureCategory = classifySymbolicationFailure(
      options.symbolicationError || existing?.symbolicationError,
      symbolicationStatus,
    );
    const analysisStatus = options.analysisStatus || (analysis ? 'success' : existing?.analysisStatus || 'pending');
    const historyId = options.historyId || existing?.historyId;
    const coverage = existing?.dsymCoverage;
    const coverageStatus = existing?.dsymCoverageStatus || 'unknown';

    this.db.prepare(`
      INSERT INTO crash_governance_records (
        product_line_id, source, source_issue_id, short_id, event_id, permalink, title, culprit, level, sentry_status,
        app_version, app_version_range, first_seen, last_seen, event_count, user_count,
        crash_type, crash_reason, crash_module, crash_location, fingerprint,
        symbolication_status, symbolication_error, symbolication_failure_category, analysis_status, analysis_error,
        governance_status, history_id, dsym_coverage_status, dsym_coverage_json,
        retry_count, last_synced_at, last_sync_error, updated_at
      )
      VALUES (
        @productLineId, 'sentry', @sourceIssueId, @shortId, @eventId, @permalink, @title, @culprit, @level, @sentryStatus,
        @appVersion, @appVersionRange, @firstSeen, @lastSeen, @eventCount, @userCount,
        @crashType, @crashReason, @crashModule, @crashLocation, @fingerprint,
        @symbolicationStatus, @symbolicationError, @symbolicationFailureCategory, @analysisStatus, @analysisError,
        @governanceStatus, @historyId, @coverageStatus, @coverageJson,
        @retryCount, @lastSyncedAt, @lastSyncError, @updatedAt
      )
      ON CONFLICT(product_line_id, source, source_issue_id) DO UPDATE SET
        short_id = excluded.short_id,
        event_id = COALESCE(excluded.event_id, crash_governance_records.event_id),
        permalink = COALESCE(excluded.permalink, crash_governance_records.permalink),
        title = excluded.title,
        culprit = excluded.culprit,
        level = excluded.level,
        sentry_status = excluded.sentry_status,
        app_version = COALESCE(excluded.app_version, crash_governance_records.app_version),
        app_version_range = COALESCE(excluded.app_version_range, crash_governance_records.app_version_range),
        first_seen = COALESCE(excluded.first_seen, crash_governance_records.first_seen),
        last_seen = COALESCE(excluded.last_seen, crash_governance_records.last_seen),
        event_count = excluded.event_count,
        user_count = excluded.user_count,
        crash_type = COALESCE(excluded.crash_type, crash_governance_records.crash_type),
        crash_module = COALESCE(excluded.crash_module, crash_governance_records.crash_module),
        crash_location = COALESCE(excluded.crash_location, crash_governance_records.crash_location),
        fingerprint = excluded.fingerprint,
        symbolication_status = excluded.symbolication_status,
        symbolication_error = excluded.symbolication_error,
        symbolication_failure_category = excluded.symbolication_failure_category,
        analysis_status = excluded.analysis_status,
        analysis_error = excluded.analysis_error,
        governance_status = CASE
          WHEN crash_governance_records.governance_status = 'ignored' THEN 'ignored'
          ELSE excluded.governance_status
        END,
        history_id = COALESCE(excluded.history_id, crash_governance_records.history_id),
        dsym_coverage_status = excluded.dsym_coverage_status,
        dsym_coverage_json = COALESCE(excluded.dsym_coverage_json, crash_governance_records.dsym_coverage_json),
        retry_count = excluded.retry_count,
        last_synced_at = excluded.last_synced_at,
        last_sync_error = excluded.last_sync_error,
        updated_at = excluded.updated_at
    `).run({
      productLineId: currentProductLineId(),
      sourceIssueId,
      shortId: issue.shortId || null,
      eventId: options.eventId || existing?.eventId || null,
      permalink: issue.permalink || existing?.permalink || null,
      title: issue.title || '未知崩溃',
      culprit: issue.culprit || null,
      level: issue.level || null,
      sentryStatus: issue.status || null,
      appVersion: appVersion || null,
      appVersionRange: issue.appVersionRange || null,
      firstSeen: issue.firstSeen || null,
      lastSeen: issue.lastSeen || null,
      eventCount: normalizeCount(issue.count),
      userCount: normalizeCount(issue.userCount),
      crashType: crashType || null,
      crashReason: existing?.crashReason || null,
      crashModule: crashModule || null,
      crashLocation: crashLocation || null,
      fingerprint,
      symbolicationStatus,
      symbolicationError: options.symbolicationError || null,
      symbolicationFailureCategory: symbolicationFailureCategory || null,
      analysisStatus,
      analysisError: options.analysisError || null,
      governanceStatus,
      historyId: historyId || null,
      coverageStatus,
      coverageJson: coverage ? JSON.stringify(coverage) : null,
      retryCount: options.syncError ? (existing?.retryCount || 0) + 1 : 0,
      lastSyncedAt: now,
      lastSyncError: options.syncError || null,
      updatedAt: now,
    });

    const record = this.getBySourceIssueId(sourceIssueId);
    if (record && previousStatus === 'fixed' && record.governanceStatus === 'regression') {
      return record;
    }
    return record!;
  }

  upsertQualityCrash(input: {
    sourceRef: string;
    title: string;
    appVersion?: string;
    buildNumber?: string;
    qualityTaskId?: string;
    level?: string;
    crashType?: string;
    crashReason?: string;
    crashModule?: string;
    crashLocation?: string;
    artifactRefs?: unknown;
    lastSeen?: string;
  }): CrashGovernanceRecord {
    this.ensureTable();
    const sourceIssueId = String(input.sourceRef || '').trim();
    if (!sourceIssueId) {
      throw new Error('质检 Crash 缺少来源标识，无法入库');
    }

    const now = new Date().toISOString();
    const appVersion = normalizeVersion(input.appVersion);
    const fingerprint = buildFingerprint({
      sourceIssueId,
      title: input.title,
      crashType: input.crashType,
      crashReason: input.crashReason,
      crashModule: input.crashModule,
      crashLocation: input.crashLocation,
      appVersion,
    });
    const existing = this.getBySource('quality', sourceIssueId);

    this.db.prepare(`
      INSERT INTO crash_governance_records (
        product_line_id, source, source_issue_id, title, level, app_version, event_count, user_count,
        crash_type, crash_reason, crash_module, crash_location, fingerprint,
        symbolication_status, analysis_status, governance_status,
        quality_task_id, dsym_coverage_status, last_seen, last_synced_at,
        updated_at, last_sync_error
      )
      VALUES (
        @productLineId, 'quality', @sourceIssueId, @title, @level, @appVersion, 1, 0,
        @crashType, @crashReason, @crashModule, @crashLocation, @fingerprint,
        @symbolicationStatus, 'skipped', @governanceStatus,
        @qualityTaskId, @coverageStatus, @lastSeen, @lastSyncedAt,
        @updatedAt, @lastSyncError
      )
      ON CONFLICT(product_line_id, source, source_issue_id) DO UPDATE SET
        title = excluded.title,
        level = excluded.level,
        app_version = COALESCE(excluded.app_version, crash_governance_records.app_version),
        event_count = crash_governance_records.event_count + 1,
        crash_type = COALESCE(excluded.crash_type, crash_governance_records.crash_type),
        crash_reason = COALESCE(excluded.crash_reason, crash_governance_records.crash_reason),
        crash_module = COALESCE(excluded.crash_module, crash_governance_records.crash_module),
        crash_location = COALESCE(excluded.crash_location, crash_governance_records.crash_location),
        fingerprint = excluded.fingerprint,
        quality_task_id = COALESCE(excluded.quality_task_id, crash_governance_records.quality_task_id),
        last_seen = COALESCE(excluded.last_seen, crash_governance_records.last_seen),
        last_synced_at = excluded.last_synced_at,
        updated_at = excluded.updated_at
    `).run({
      productLineId: currentProductLineId(),
      sourceIssueId,
      title: input.title || '质检 Crash',
      level: input.level || 'error',
      appVersion: appVersion || null,
      crashType: input.crashType || null,
      crashReason: input.crashReason || null,
      crashModule: input.crashModule || null,
      crashLocation: input.crashLocation || null,
      fingerprint,
      symbolicationStatus: existing?.symbolicationStatus || 'pending',
      governanceStatus: existing?.governanceStatus || 'new',
      qualityTaskId: input.qualityTaskId || null,
      coverageStatus: existing?.dsymCoverageStatus || 'unknown',
      lastSeen: input.lastSeen || now,
      lastSyncedAt: now,
      updatedAt: now,
      lastSyncError: null,
    });

    const record = this.getBySource('quality', sourceIssueId);
    if (record?.appVersion) {
      void this.refreshCoverageForQualityRecord(record);
    }
    return record!;
  }

  upsertManualCrash(input: {
    historyId?: number;
    title: string;
    appVersion?: string;
    crashType?: string;
    crashReason?: string;
    crashModule?: string;
    crashLocation?: string;
    level?: string;
    usedUuids?: string[];
  }): CrashGovernanceRecord {
    this.ensureTable();
    const sourceIssueId = input.historyId
      ? `history:${input.historyId}`
      : buildFingerprint({
        title: input.title,
        appVersion: input.appVersion,
        crashType: input.crashType,
        crashReason: input.crashReason,
        crashModule: input.crashModule,
        crashLocation: input.crashLocation,
      });
    const now = new Date().toISOString();
    const appVersion = normalizeVersion(input.appVersion);
    const fingerprint = buildFingerprint({
      sourceIssueId,
      title: input.title,
      crashType: input.crashType,
      crashReason: input.crashReason,
      crashModule: input.crashModule,
      crashLocation: input.crashLocation,
      appVersion,
    });

    this.db.prepare(`
      INSERT INTO crash_governance_records (
        product_line_id, source, source_issue_id, title, level, app_version, event_count, user_count,
        crash_type, crash_reason, crash_module, crash_location, fingerprint,
        symbolication_status, analysis_status, governance_status,
        history_id, dsym_coverage_status, last_seen, last_synced_at, updated_at
      )
      VALUES (
        @productLineId, 'manual', @sourceIssueId, @title, @level, @appVersion, 1, 0,
        @crashType, @crashReason, @crashModule, @crashLocation, @fingerprint,
        'success', 'pending', 'new',
        @historyId, @coverageStatus, @lastSeen, @lastSyncedAt, @updatedAt
      )
      ON CONFLICT(product_line_id, source, source_issue_id) DO UPDATE SET
        title = excluded.title,
        level = excluded.level,
        app_version = COALESCE(excluded.app_version, crash_governance_records.app_version),
        crash_type = COALESCE(excluded.crash_type, crash_governance_records.crash_type),
        crash_reason = COALESCE(excluded.crash_reason, crash_governance_records.crash_reason),
        crash_module = COALESCE(excluded.crash_module, crash_governance_records.crash_module),
        crash_location = COALESCE(excluded.crash_location, crash_governance_records.crash_location),
        fingerprint = excluded.fingerprint,
        symbolication_status = 'success',
        history_id = COALESCE(excluded.history_id, crash_governance_records.history_id),
        last_seen = excluded.last_seen,
        last_synced_at = excluded.last_synced_at,
        updated_at = excluded.updated_at
    `).run({
      productLineId: currentProductLineId(),
      sourceIssueId,
      title: input.title || '手动解析 Crash',
      level: input.level || 'medium',
      appVersion: appVersion || null,
      crashType: input.crashType || null,
      crashReason: input.crashReason || null,
      crashModule: input.crashModule || null,
      crashLocation: input.crashLocation || null,
      fingerprint,
      historyId: input.historyId || null,
      coverageStatus: 'unknown',
      lastSeen: now,
      lastSyncedAt: now,
      updatedAt: now,
    });

    const record = this.getBySource('manual', sourceIssueId);
    if (record?.appVersion) {
      void this.refreshCoverageForQualityRecord(record);
    }
    return record!;
  }

  markSymbolication(issueId: string, payload: {
    status: CrashSymbolicationStatus;
    historyId?: number;
    error?: string;
    eventId?: string;
  }): void {
    this.ensureTable();
    const now = new Date().toISOString();
    const failureCategory = classifySymbolicationFailure(payload.error, payload.status);
    this.db.prepare(`
      UPDATE crash_governance_records
      SET symbolication_status = ?,
          symbolication_error = ?,
          symbolication_failure_category = ?,
          history_id = COALESCE(?, history_id),
          event_id = COALESCE(?, event_id),
          governance_status = CASE
            WHEN governance_status IN ('ignored', 'fixed') THEN governance_status
            WHEN ? = 'success' THEN 'pending_fix'
            ELSE governance_status
          END,
          updated_at = ?
      WHERE product_line_id = ? AND source = 'sentry' AND source_issue_id = ?
    `).run(payload.status, payload.error || null, failureCategory || null, payload.historyId || null, payload.eventId || null, payload.status, now, currentProductLineId(), issueId);
  }

  markAnalysis(issueId: string, payload: {
    status: CrashAnalysisStatus;
    error?: string;
    analysis?: CrashAnalysis;
  }): void {
    this.ensureTable();
    const now = new Date().toISOString();
    const crashType = payload.analysis?.crashType || null;
    const crashModule = payload.analysis?.crashModule || null;
    const crashLocation = payload.analysis?.crashLocation || null;
    this.db.prepare(`
      UPDATE crash_governance_records
      SET analysis_status = ?,
          analysis_error = ?,
          crash_type = COALESCE(?, crash_type),
          crash_module = COALESCE(?, crash_module),
          crash_location = COALESCE(?, crash_location),
          updated_at = ?
      WHERE product_line_id = ? AND source = 'sentry' AND source_issue_id = ?
    `).run(payload.status, payload.error || null, crashType, crashModule, crashLocation, now, currentProductLineId(), issueId);
  }

  markAnalysisByRecordId(id: number, payload: {
    status: CrashAnalysisStatus;
    error?: string;
    analysis?: CrashAnalysis;
  }): CrashGovernanceRecord | undefined {
    this.ensureTable();
    const now = new Date().toISOString();
    const crashType = payload.analysis?.crashType || null;
    const crashModule = payload.analysis?.crashModule || null;
    const crashLocation = payload.analysis?.crashLocation || null;
    this.db.prepare(`
      UPDATE crash_governance_records
      SET analysis_status = ?,
          analysis_error = ?,
          crash_type = COALESCE(?, crash_type),
          crash_module = COALESCE(?, crash_module),
          crash_location = COALESCE(?, crash_location),
          governance_status = CASE
            WHEN ? = 'pending' AND governance_status NOT IN ('fixed', 'ignored') THEN 'analyzing'
            WHEN ? = 'success' AND governance_status = 'analyzing' THEN 'pending_fix'
            ELSE governance_status
          END,
          updated_at = ?
      WHERE id = ? AND product_line_id = ?
    `).run(payload.status, payload.error || null, crashType, crashModule, crashLocation, payload.status, payload.status, now, id, currentProductLineId());
    return this.getById(id);
  }

  async refreshCoverageForRecord(issueId: string, crashLog?: string): Promise<CrashGovernanceRecord | undefined> {
    const record = this.getBySourceIssueId(issueId);
    return this.refreshCoverage(record, crashLog);
  }

  async refreshCoverageById(id: number, crashLog?: string): Promise<CrashGovernanceRecord | undefined> {
    const record = this.getById(id);
    return this.refreshCoverage(record, crashLog);
  }

  async refreshCoverageByVersion(appVersion: string): Promise<{
    appVersion: string;
    total: number;
    refreshed: number;
    skipped: number;
    records: CrashGovernanceRecord[];
  }> {
    this.ensureTable();
    const normalizedVersion = normalizeVersion(appVersion);
    if (!normalizedVersion) {
      return {
        appVersion: '',
        total: 0,
        refreshed: 0,
        skipped: 0,
        records: [],
      };
    }
    const rows = this.db.prepare(`
      SELECT * FROM crash_governance_records
      WHERE product_line_id = ? AND app_version = ?
      ORDER BY datetime(last_seen) DESC, datetime(updated_at) DESC
      LIMIT 200
    `).all(currentProductLineId(), normalizedVersion) as any[];
    const records = rows.map((row) => this.mapRow(row));
    const refreshedRecords: CrashGovernanceRecord[] = [];
    let skipped = 0;
    for (const record of records) {
      const refreshed = await this.refreshCoverage(record);
      if (refreshed) {
        refreshedRecords.push(refreshed);
      } else {
        skipped += 1;
      }
    }
    return {
      appVersion: normalizedVersion,
      total: records.length,
      refreshed: refreshedRecords.length,
      skipped,
      records: refreshedRecords,
    };
  }

  list(options: {
    limit?: number;
    status?: CrashGovernanceStatus | 'open';
    source?: string;
    appVersion?: string;
    dsymCoverageStatus?: string;
    symbolicationStatus?: string;
    symbolicationFailureCategory?: string;
    analysisStatus?: string;
    owner?: string;
    keyword?: string;
  } = {}): CrashGovernanceRecord[] {
    this.ensureTable();
    const limit = Math.min(Math.max(Number(options.limit || 30), 1), 200);
    const clauses: string[] = ['product_line_id = ?'];
    const params: any[] = [currentProductLineId()];
    if (options.status === 'open') {
      clauses.push("governance_status NOT IN ('fixed', 'ignored')");
    } else if (options.status) {
      clauses.push('governance_status = ?');
      params.push(options.status);
    }
    if (options.source) {
      clauses.push('source = ?');
      params.push(options.source);
    }
    if (options.appVersion) {
      clauses.push('app_version = ?');
      params.push(normalizeVersion(options.appVersion));
    }
    if (options.dsymCoverageStatus) {
      clauses.push('dsym_coverage_status = ?');
      params.push(options.dsymCoverageStatus);
    }
    if (options.symbolicationStatus) {
      clauses.push('symbolication_status = ?');
      params.push(options.symbolicationStatus);
    }
    if (options.symbolicationFailureCategory) {
      clauses.push('symbolication_failure_category = ?');
      params.push(options.symbolicationFailureCategory);
    }
    if (options.analysisStatus) {
      clauses.push('analysis_status = ?');
      params.push(options.analysisStatus);
    }
    if (options.owner) {
      const owner = String(options.owner).trim();
      if (owner === '未分配') {
        clauses.push("(owner IS NULL OR TRIM(owner) = '')");
      } else if (owner) {
        clauses.push('owner = ?');
        params.push(owner);
      }
    }
    const keyword = String(options.keyword || '').trim();
    if (keyword) {
      clauses.push(`(
        source_issue_id LIKE ?
        OR short_id LIKE ?
        OR title LIKE ?
        OR culprit LIKE ?
        OR crash_module LIKE ?
        OR crash_location LIKE ?
        OR owner LIKE ?
      )`);
      const keywordParam = `%${keyword}%`;
      params.push(keywordParam, keywordParam, keywordParam, keywordParam, keywordParam, keywordParam, keywordParam);
    }
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT * FROM crash_governance_records
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY datetime(last_seen) DESC, datetime(updated_at) DESC
      LIMIT ?
    `).all(...params) as any[];
    return rows.map((row) => this.mapRow(row));
  }

  listOpenRisksByVersion(appVersion: string, limit = 50): CrashGovernanceRecord[] {
    this.ensureTable();
    const normalizedVersion = normalizeVersion(appVersion);
    if (!normalizedVersion) {
      return [];
    }
    const rows = this.db.prepare(`
      SELECT * FROM crash_governance_records
      WHERE product_line_id = ? AND app_version = ?
        AND source = 'sentry'
        AND governance_status NOT IN ('fixed', 'ignored')
      ORDER BY
        CASE
          WHEN governance_status = 'regression' THEN 0
          WHEN level IN ('fatal', 'critical') THEN 1
          WHEN level = 'error' THEN 2
          ELSE 3
        END,
        event_count DESC,
        datetime(last_seen) DESC
      LIMIT ?
    `).all(currentProductLineId(), normalizedVersion, Math.min(Math.max(Number(limit || 50), 1), 100)) as any[];
    return rows.map((row) => this.mapRow(row));
  }

  evaluateReleaseHealth(appVersion: string): CrashReleaseHealth {
    this.ensureTable();
    const normalizedVersion = normalizeVersion(appVersion);
    const emptyResult: CrashReleaseHealth = {
      status: 'healthy',
      appVersion: normalizedVersion,
      openCrashCount: 0,
      highRiskCount: 0,
      regressionCount: 0,
      dsymMissingCount: 0,
      symbolicationFailedCount: 0,
      highRisks: [],
      regressions: [],
      dsymMissing: [],
      symbolicationFailures: [],
      supportingEvidence: {
        qualityCrashCount: 0,
        manualCrashCount: 0,
        qualityEvidence: [],
        manualEvidence: [],
      },
      recommendations: ['当前版本未发现线上 Crash 治理风险，可继续观察发布健康状态。'],
    };
    if (!normalizedVersion) {
      return emptyResult;
    }

    const rows = this.db.prepare(`
      SELECT * FROM crash_governance_records
      WHERE product_line_id = ? AND app_version = ?
      ORDER BY
        CASE
          WHEN governance_status = 'regression' THEN 0
          WHEN source = 'sentry' AND level IN ('fatal', 'critical') THEN 1
          WHEN source = 'sentry' AND level = 'error' THEN 2
          ELSE 3
        END,
        event_count DESC,
        datetime(last_seen) DESC,
        datetime(updated_at) DESC
    `).all(currentProductLineId(), normalizedVersion) as any[];
    const records = rows.map((row) => this.mapRow(row));
    const onlineOpen = records.filter((record) => record.source === 'sentry' && isOpenCrash(record));
    const highRisks = onlineOpen.filter(isHighRiskCrash).slice(0, 20);
    const regressions = onlineOpen.filter((record) => record.governanceStatus === 'regression').slice(0, 20);
    const dsymMissing = onlineOpen.filter((record) => record.dsymCoverageStatus === 'missing').slice(0, 20);
    const symbolicationFailures = onlineOpen.filter((record) => record.symbolicationStatus === 'failed').slice(0, 20);
    const qualityEvidence = records.filter((record) => record.source === 'quality').slice(0, 10);
    const manualEvidence = records.filter((record) => record.source === 'manual').slice(0, 10);
    const recommendations: string[] = [];

    if (regressions.length > 0) {
      recommendations.push('发现疑似回归 Crash，建议暂停继续放量并优先确认修复版本是否生效。');
    }
    if (highRisks.length > 0) {
      recommendations.push('存在未解决高风险线上 Crash，建议关联 Commit、负责人和修复版本后再扩大发布。');
    }
    if (dsymMissing.length > 0) {
      recommendations.push('存在 dSYM 缺失，需补齐符号文件后重新符号化，避免误判崩溃归因。');
    }
    if (symbolicationFailures.length > 0) {
      recommendations.push('存在符号化失败记录，需检查 UUID 匹配、日志结构或符号化工具执行结果。');
    }
    if (qualityEvidence.length > 0 || manualEvidence.length > 0) {
      recommendations.push('质检/手动解析 Crash 已作为辅助证据保留，不计入线上发布健康风险。');
    }
    if (recommendations.length === 0) {
      recommendations.push('当前版本未发现线上 Crash 治理风险，可继续观察发布健康状态。');
    }

    return {
      status: regressions.length > 0 || highRisks.length > 0 ? 'critical' : dsymMissing.length > 0 || symbolicationFailures.length > 0 ? 'warning' : 'healthy',
      appVersion: normalizedVersion,
      openCrashCount: onlineOpen.length,
      highRiskCount: highRisks.length,
      regressionCount: regressions.length,
      dsymMissingCount: dsymMissing.length,
      symbolicationFailedCount: symbolicationFailures.length,
      highRisks,
      regressions,
      dsymMissing,
      symbolicationFailures,
      supportingEvidence: {
        qualityCrashCount: qualityEvidence.length,
        manualCrashCount: manualEvidence.length,
        qualityEvidence,
        manualEvidence,
      },
      recommendations,
    };
  }

  dashboard(): CrashGovernanceDashboard {
    this.ensureTable();
    const records = this.listForDashboard();
    const onlineRecords = records.filter((record) => record.source === 'sentry');
    const qualityRecords = records.filter((record) => record.source === 'quality');
    const manualRecords = records.filter((record) => record.source === 'manual');
    const openRecords = onlineRecords.filter(isOpenCrash);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const highRisk = openRecords.filter(isHighRiskCrash);
    const lastSyncedAt = onlineRecords
      .map((record) => record.lastSyncedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .pop();
    const syncHealth = buildSyncHealth(onlineRecords, lastSyncedAt);
    const failureBreakdown = buildSymbolicationFailureBreakdown(openRecords);
    const governanceActivity = this.getGovernanceActivity();
    const ownerTodoDistribution = buildOwnerTodoDistribution(onlineRecords);
    const crashInsightSummary = buildCrashInsightSummary(openRecords);
    const coverageVersions = new Map<string, CrashGovernanceRecord>();
    onlineRecords.forEach((record) => {
      if (record.appVersion && !coverageVersions.has(record.appVersion)) {
        coverageVersions.set(record.appVersion, record);
      }
    });
    const versionRecords = new Map<string, CrashGovernanceRecord[]>();
    onlineRecords.forEach((record) => {
      if (!record.appVersion) {
        return;
      }
      const recordsForVersion = versionRecords.get(record.appVersion) || [];
      recordsForVersion.push(record);
      versionRecords.set(record.appVersion, recordsForVersion);
    });

    return {
      summary: {
        totalOpen: openRecords.length,
        newToday: onlineRecords.filter((record) => (Date.parse(record.firstSeen || record.createdAt) || 0) >= todayStart.getTime()).length,
        highRisk: highRisk.length,
        regressions: onlineRecords.filter((record) => record.governanceStatus === 'regression').length,
        symbolicated: onlineRecords.filter((record) => record.symbolicationStatus === 'success').length,
        symbolicationFailed: onlineRecords.filter((record) => record.symbolicationStatus === 'failed').length,
        analysisReady: onlineRecords.filter((record) => record.analysisStatus === 'success').length,
        analysisFailed: onlineRecords.filter((record) => record.analysisStatus === 'failed').length,
        dsymReady: onlineRecords.filter((record) => record.dsymCoverageStatus === 'ready').length,
        dsymMissing: onlineRecords.filter((record) => record.dsymCoverageStatus === 'missing').length,
        lastSyncedAt,
        excludedVersions: this.getExcludedVersions(),
      },
      topIssues: groupTopCrashRecords(openRecords),
      recentIssues: onlineRecords.slice(0, 10),
      regressions: onlineRecords.filter((record) => record.governanceStatus === 'regression').slice(0, 10),
      qualityEvidence: qualityRecords.slice(0, 10),
      manualEvidence: manualRecords.slice(0, 10),
      symbolicationFailureBreakdown: failureBreakdown,
      actionRecommendations: buildActionRecommendations({
        highRiskCount: highRisk.length,
        regressionCount: onlineRecords.filter((record) => record.governanceStatus === 'regression').length,
        dsymMissingCount: onlineRecords.filter((record) => record.dsymCoverageStatus === 'missing').length,
        syncHealth,
        failureBreakdown,
        ownerTodos: ownerTodoDistribution,
        crashInsightSummary,
      }),
      crashInsightSummary,
      governanceStatusDistribution: buildGovernanceStatusDistribution(onlineRecords),
      ownerTodoDistribution,
      dsymCoverage: Array.from(coverageVersions.values()).map((record) => ({
        appVersion: record.appVersion || '-',
        status: record.dsymCoverageStatus,
        total: record.dsymCoverage?.total || 0,
        valid: record.dsymCoverage?.valid || 0,
        mainAppReady: Boolean(record.dsymCoverage?.mainAppReady),
        relatedReady: Boolean(record.dsymCoverage?.relatedReady),
      })),
      versionHealth: Array.from(versionRecords.entries())
        .map(([appVersion, recordsForVersion]) => {
          const openForVersion = recordsForVersion.filter(isOpenCrash);
          const highRiskCount = openForVersion.filter(isHighRiskCrash).length;
          const regressionCount = openForVersion.filter((record) => record.governanceStatus === 'regression').length;
          const dsymMissingCount = openForVersion.filter((record) => record.dsymCoverageStatus === 'missing').length;
          const symbolicationFailedCount = openForVersion.filter((record) => record.symbolicationStatus === 'failed').length;
          const status: 'healthy' | 'warning' | 'critical' = regressionCount > 0 || highRiskCount > 0
            ? 'critical'
            : dsymMissingCount > 0 || symbolicationFailedCount > 0
              ? 'warning'
              : 'healthy';
          return {
            appVersion,
            status,
            openCrashCount: openForVersion.length,
            highRiskCount,
            regressionCount,
            dsymMissingCount,
            symbolicationFailedCount,
            lastSeen: recordsForVersion
              .map((record) => record.lastSeen)
              .filter((value): value is string => Boolean(value))
              .sort()
              .pop(),
          };
        })
        .sort((a, b) => compareVersionDesc(a.appVersion, b.appVersion))
        .slice(0, 12),
      syncHealth,
      governanceActivity,
    };
  }

  private getGovernanceActivity(): CrashGovernanceDashboard['governanceActivity'] {
    this.ensureTable();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    const summary = this.db.prepare(`
      SELECT
        COUNT(*) AS recent_7d_count,
        SUM(CASE WHEN scope = 'single' THEN 1 ELSE 0 END) AS single_count,
        SUM(CASE WHEN scope = 'fingerprint' THEN 1 ELSE 0 END) AS fingerprint_count
      FROM crash_governance_events
      WHERE product_line_id = ? AND datetime(created_at) >= datetime(?)
    `).get(currentProductLineId(), since) as any;
    const topOperatorRows = this.db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(operator), ''), '系统') AS operator, COUNT(*) AS count
      FROM crash_governance_events
      WHERE product_line_id = ? AND datetime(created_at) >= datetime(?)
      GROUP BY COALESCE(NULLIF(TRIM(operator), ''), '系统')
      ORDER BY count DESC, operator ASC
      LIMIT 5
    `).all(currentProductLineId(), since) as any[];
    const lastEventRow = this.db.prepare(`
      SELECT * FROM crash_governance_events
      WHERE product_line_id = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT 1
    `).get(currentProductLineId()) as any | undefined;

    return {
      recent7dCount: Number(summary?.recent_7d_count || 0),
      singleCount: Number(summary?.single_count || 0),
      fingerprintCount: Number(summary?.fingerprint_count || 0),
      lastEvent: lastEventRow ? this.mapEventRow(lastEventRow) : undefined,
      topOperators: topOperatorRows.map((row) => ({
        operator: row.operator || '系统',
        count: Number(row.count || 0),
      })),
    };
  }

  private listForDashboard(): CrashGovernanceRecord[] {
    const limit = Math.min(Math.max(Number(process.env.CRASH_GOVERNANCE_DASHBOARD_LIMIT || 5000), 100), 20000);
    const rows = this.db.prepare(`
      SELECT * FROM crash_governance_records
      WHERE product_line_id = ?
      ORDER BY datetime(last_seen) DESC, datetime(updated_at) DESC
      LIMIT ?
    `).all(currentProductLineId(), limit) as any[];
    return rows.map((row) => this.mapRow(row));
  }

  updateGovernanceStatus(id: number, payload: {
    governanceStatus: CrashGovernanceStatus;
    owner?: string;
    fixedVersion?: string;
    fixedRemark?: string;
    ignoreReason?: string;
    operator?: string;
  }): CrashGovernanceRecord {
    this.ensureTable();
    const before = this.getById(id);
    if (!before) {
      throw new Error('Crash 记录不存在');
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE crash_governance_records
      SET governance_status = ?,
          owner = COALESCE(?, owner),
          fixed_version = ?,
          fixed_remark = ?,
          ignore_reason = ?,
          updated_at = ?
      WHERE id = ? AND product_line_id = ?
    `).run(
      payload.governanceStatus,
      payload.owner || null,
      payload.fixedVersion || null,
      payload.fixedRemark || null,
      payload.ignoreReason || null,
      now,
      id,
      currentProductLineId(),
    );
    const record = this.getById(id);
    if (!record) {
      throw new Error('Crash 记录不存在');
    }
    if (record.historyId && payload.governanceStatus === 'fixed') {
      historyService.updateFixedStatus(record.historyId, true, payload.fixedVersion || record.appVersion || '', payload.fixedRemark);
    }
    this.recordGovernanceEvent({
      recordId: record.id,
      scope: 'single',
      fromStatus: before.governanceStatus,
      toStatus: payload.governanceStatus,
      operator: payload.operator,
      note: payload.fixedRemark || payload.ignoreReason || payload.owner,
      relatedRecordIds: [record.id],
    });
    return record;
  }

  updateFingerprintGroupStatus(id: number, payload: {
    governanceStatus: CrashGovernanceStatus;
    owner?: string;
    fixedVersion?: string;
    fixedRemark?: string;
    ignoreReason?: string;
    operator?: string;
  }): CrashGovernanceFingerprintGroup {
    this.ensureTable();
    const group = this.getFingerprintGroupByRecordId(id, 200);
    if (!group || group.records.length === 0) {
      throw new Error('Crash 记录不存在');
    }
    if (!group.fingerprint) {
      const record = this.updateGovernanceStatus(id, payload);
      return {
        fingerprint: record.fingerprint,
        issueCount: 1,
        eventCount: record.eventCount,
        userCount: record.userCount,
        versions: record.appVersion ? [record.appVersion] : [],
        lastSeen: record.lastSeen,
        records: [record],
      };
    }

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE crash_governance_records
      SET governance_status = ?,
          owner = COALESCE(?, owner),
          fixed_version = ?,
          fixed_remark = ?,
          ignore_reason = ?,
          updated_at = ?
      WHERE product_line_id = ? AND source = 'sentry' AND fingerprint = ?
    `).run(
      payload.governanceStatus,
      payload.owner || null,
      payload.fixedVersion || null,
      payload.fixedRemark || null,
      payload.ignoreReason || null,
      now,
      currentProductLineId(),
      group.fingerprint,
    );

    if (payload.governanceStatus === 'fixed') {
      group.records.forEach((record) => {
        if (record.historyId) {
          historyService.updateFixedStatus(record.historyId, true, payload.fixedVersion || record.appVersion || '', payload.fixedRemark);
        }
      });
    }

    const updated = this.getFingerprintGroupByRecordId(id, 200);
    if (!updated) {
      throw new Error('Crash 记录不存在');
    }
    const relatedRecordIds = group.records.map((record) => record.id);
    group.records.forEach((record) => {
      this.recordGovernanceEvent({
        recordId: record.id,
        scope: 'fingerprint',
        fromStatus: record.governanceStatus,
        toStatus: payload.governanceStatus,
        operator: payload.operator,
        note: payload.fixedRemark || payload.ignoreReason || payload.owner,
        relatedRecordIds,
      });
    });
    return updated;
  }

  listGovernanceEvents(recordId: number, limit = 50): CrashGovernanceEvent[] {
    this.ensureTable();
    const rows = this.db.prepare(`
      SELECT * FROM crash_governance_events
      WHERE product_line_id = ? AND record_id = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `).all(currentProductLineId(), recordId, Math.min(Math.max(Number(limit || 50), 1), 200)) as any[];
    return rows.map((row) => this.mapEventRow(row));
  }

  listRecentGovernanceEvents(options: {
    limit?: number;
    scope?: string;
    toStatus?: string;
    operator?: string;
    keyword?: string;
  } = {}): CrashGovernanceEvent[] {
    this.ensureTable();
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 200);
    const clauses: string[] = ['e.product_line_id = ?'];
    const params: any[] = [currentProductLineId()];
    if (options.scope) {
      clauses.push('e.scope = ?');
      params.push(options.scope);
    }
    if (options.toStatus) {
      clauses.push('e.to_status = ?');
      params.push(options.toStatus);
    }
    if (options.operator) {
      clauses.push('e.operator LIKE ?');
      params.push(`%${String(options.operator).trim()}%`);
    }
    const keyword = String(options.keyword || '').trim();
    if (keyword) {
      clauses.push(`(
        r.source_issue_id LIKE ?
        OR r.short_id LIKE ?
        OR r.title LIKE ?
        OR r.app_version LIKE ?
        OR e.note LIKE ?
        OR e.operator LIKE ?
      )`);
      const keywordParam = `%${keyword}%`;
      params.push(keywordParam, keywordParam, keywordParam, keywordParam, keywordParam, keywordParam);
    }
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT
        e.*,
        r.id AS record_id_alias,
        r.source,
        r.source_issue_id,
        r.short_id,
        r.event_id,
        r.permalink,
        r.title,
        r.culprit,
        r.level,
        r.sentry_status,
        r.app_version,
        r.app_version_range,
        r.first_seen,
        r.last_seen,
        r.event_count,
        r.user_count,
        r.crash_type,
        r.crash_reason,
        r.crash_module,
        r.crash_location,
        r.fingerprint,
        r.symbolication_status,
        r.symbolication_error,
        r.symbolication_failure_category,
        r.analysis_status,
        r.analysis_error,
        r.governance_status,
        r.owner,
        r.fixed_version,
        r.fixed_remark,
        r.ignore_reason,
        r.history_id,
        r.quality_task_id,
        r.release_record_id,
        r.dsym_coverage_status,
        r.dsym_coverage_json,
        r.retry_count,
        r.last_synced_at,
        r.last_sync_error,
        r.created_at AS record_created_at,
        r.updated_at AS record_updated_at
      FROM crash_governance_events e
      LEFT JOIN crash_governance_records r ON r.id = e.record_id AND r.product_line_id = e.product_line_id
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY datetime(e.created_at) DESC, e.id DESC
      LIMIT ?
    `).all(...params) as any[];
    return rows.map((row) => ({
      ...this.mapEventRow(row),
      record: row.record_id_alias ? this.mapRow({
        ...row,
        id: row.record_id_alias,
        created_at: row.record_created_at,
        updated_at: row.record_updated_at,
      }) : undefined,
    }));
  }

  exportGovernanceEventsCsv(options: {
    limit?: number;
    scope?: string;
    toStatus?: string;
    operator?: string;
    keyword?: string;
  } = {}): string {
    const events = this.listRecentGovernanceEvents({
      ...options,
      limit: options.limit || 200,
    });
    const headers = [
      '时间',
      '操作范围',
      '原状态',
      '目标状态',
      '操作人',
      '关联记录',
      'Issue',
      'App版本',
      'Crash标题',
      '备注',
    ];
    const rows = events.map((event) => [
      event.createdAt,
      event.scope === 'fingerprint' ? '同指纹批量' : '单条操作',
      event.fromStatus || '',
      event.toStatus || '',
      event.operator || '系统',
      event.relatedRecordIds,
      event.record?.shortId || event.record?.sourceIssueId || event.recordId || '',
      event.record?.appVersion || '',
      event.record?.title || '',
      event.note || '',
    ]);
    return [headers, ...rows].map((row) => row.map(toCsvCell).join(',')).join('\n');
  }

  private recordGovernanceEvent(input: {
    recordId: number;
    scope: 'single' | 'fingerprint';
    fromStatus?: CrashGovernanceStatus;
    toStatus?: CrashGovernanceStatus;
    operator?: string;
    note?: string;
    relatedRecordIds?: number[];
  }): void {
    this.db.prepare(`
      INSERT INTO crash_governance_events (
        record_id, action, scope, from_status, to_status, operator, note, related_record_ids_json, created_at, product_line_id
      )
      VALUES (?, 'status_update', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.recordId,
      input.scope,
      input.fromStatus || null,
      input.toStatus || null,
      input.operator || null,
      input.note || null,
      JSON.stringify(input.relatedRecordIds || [input.recordId]),
      new Date().toISOString(),
      currentProductLineId(),
    );
  }

  wasNotificationSent(recordId: number, notificationType: string): boolean {
    this.ensureTable();
    const row = this.db.prepare(`
      SELECT id FROM crash_governance_notifications
      WHERE product_line_id = ? AND record_id = ? AND notification_type = ?
      LIMIT 1
    `).get(currentProductLineId(), recordId, notificationType);
    return Boolean(row);
  }

  markNotificationSent(recordId: number, notificationType: string): void {
    this.ensureTable();
    this.db.prepare(`
      INSERT OR IGNORE INTO crash_governance_notifications (record_id, notification_type, product_line_id)
      VALUES (?, ?, ?)
    `).run(recordId, notificationType, currentProductLineId());
  }

  getById(id: number): CrashGovernanceRecord | undefined {
    this.ensureTable();
    const row = this.db.prepare('SELECT * FROM crash_governance_records WHERE id = ? AND product_line_id = ?').get(id, currentProductLineId()) as any;
    return row ? this.mapRow(row) : undefined;
  }

  getBySourceIssueId(issueId: string): CrashGovernanceRecord | undefined {
    return this.getBySource('sentry', issueId);
  }

  getBySource(source: 'sentry' | 'quality' | 'manual', issueId: string): CrashGovernanceRecord | undefined {
    this.ensureTable();
    const row = this.db.prepare(`
      SELECT * FROM crash_governance_records
      WHERE product_line_id = ? AND source = ? AND source_issue_id = ?
    `).get(currentProductLineId(), source, issueId) as any;
    return row ? this.mapRow(row) : undefined;
  }

  getFingerprintGroupByRecordId(id: number, limit = 50): CrashGovernanceFingerprintGroup | undefined {
    this.ensureTable();
    const record = this.getById(id);
    if (!record) {
      return undefined;
    }

    const normalizedLimit = Math.min(Math.max(Number(limit || 50), 1), 200);
    const rows = record.fingerprint
      ? this.db.prepare(`
        SELECT * FROM crash_governance_records
        WHERE product_line_id = ? AND source = 'sentry' AND fingerprint = ?
        ORDER BY event_count DESC, datetime(last_seen) DESC, datetime(updated_at) DESC
        LIMIT ?
      `).all(currentProductLineId(), record.fingerprint, normalizedLimit) as any[]
      : this.db.prepare(`
        SELECT * FROM crash_governance_records
        WHERE id = ? AND product_line_id = ?
        LIMIT 1
      `).all(record.id, currentProductLineId()) as any[];
    const records = rows.map((row) => this.mapRow(row));
    const versions = Array.from(new Set(records
      .map((item) => item.appVersion)
      .filter((version): version is string => Boolean(version))))
      .sort(compareVersionDesc);
    const lastSeen = records
      .map((item) => item.lastSeen)
      .filter((value): value is string => Boolean(value))
      .sort()
      .pop();

    return {
      fingerprint: record.fingerprint,
      issueCount: records.length,
      eventCount: records.reduce((sum, item) => sum + normalizeCount(item.eventCount), 0),
      userCount: records.reduce((sum, item) => sum + normalizeCount(item.userCount), 0),
      versions,
      lastSeen,
      records,
    };
  }

  private async refreshCoverageForQualityRecord(record: CrashGovernanceRecord): Promise<void> {
    if (!record.appVersion) {
      return;
    }
    const coverage = await dsymMatcherService.getCoverage(record.appVersion);
    const status = this.toCoverageStatus(coverage);
    this.db.prepare(`
      UPDATE crash_governance_records
      SET dsym_coverage_status = ?,
          dsym_coverage_json = ?,
          updated_at = ?
      WHERE id = ? AND product_line_id = ?
    `).run(status, JSON.stringify(coverage), new Date().toISOString(), record.id, currentProductLineId());
  }

  private async refreshCoverage(record: CrashGovernanceRecord | undefined, crashLog?: string): Promise<CrashGovernanceRecord | undefined> {
    if (!record?.appVersion) {
      return record;
    }

    const coverage = crashLog
      ? (await dsymMatcherService.matchForCrash(record.appVersion, crashLog)).coverage
      : await dsymMatcherService.getCoverage(record.appVersion);
    const status = this.toCoverageStatus(coverage);
    this.db.prepare(`
      UPDATE crash_governance_records
      SET dsym_coverage_status = ?,
          dsym_coverage_json = ?,
          updated_at = ?
      WHERE id = ? AND product_line_id = ?
    `).run(status, JSON.stringify(coverage), new Date().toISOString(), record.id, currentProductLineId());
    return this.getById(record.id);
  }

  private nextGovernanceStatus(existing: CrashGovernanceRecord | undefined, issue: SentryIssueSummary): CrashGovernanceStatus {
    if (existing?.governanceStatus === 'ignored') {
      return 'ignored';
    }
    if (existing?.governanceStatus === 'fixed') {
      const fixedVersion = normalizeVersion(existing.fixedVersion);
      const issueVersion = normalizeVersion(issue.maxAppVersion || issue.minAppVersion || issue.appVersionRange?.split(' - ').pop());
      if (!fixedVersion || !issueVersion || fixedVersion !== issueVersion) {
        return 'regression';
      }
      return 'fixed';
    }
    if (existing?.governanceStatus && existing.governanceStatus !== 'new') {
      return existing.governanceStatus;
    }
    return 'new';
  }

  private toCoverageStatus(coverage: DSYMCoverageSummary): 'ready' | 'missing' | 'partial' {
    if (coverage.valid === 0 || !coverage.mainAppReady) {
      return 'missing';
    }
    if (coverage.missingDwarf > 0 || !coverage.relatedReady) {
      return 'partial';
    }
    return 'ready';
  }

  private mapRow(row: any): CrashGovernanceRecord {
    return {
      id: Number(row.id),
      source: row.source,
      sourceIssueId: row.source_issue_id,
      shortId: row.short_id || undefined,
      eventId: row.event_id || undefined,
      permalink: row.permalink || undefined,
      title: row.title,
      culprit: row.culprit || undefined,
      level: row.level || undefined,
      sentryStatus: row.sentry_status || undefined,
      appVersion: row.app_version || undefined,
      appVersionRange: row.app_version_range || undefined,
      firstSeen: row.first_seen || undefined,
      lastSeen: row.last_seen || undefined,
      eventCount: Number(row.event_count || 0),
      userCount: Number(row.user_count || 0),
      crashType: row.crash_type || undefined,
      crashReason: row.crash_reason || undefined,
      crashModule: row.crash_module || undefined,
      crashLocation: row.crash_location || undefined,
      fingerprint: row.fingerprint || undefined,
      symbolicationStatus: row.symbolication_status,
      symbolicationError: row.symbolication_error || undefined,
      symbolicationFailureCategory: row.symbolication_failure_category || undefined,
      analysisStatus: row.analysis_status,
      analysisError: row.analysis_error || undefined,
      governanceStatus: row.governance_status,
      owner: row.owner || undefined,
      fixedVersion: row.fixed_version || undefined,
      fixedRemark: row.fixed_remark || undefined,
      ignoreReason: row.ignore_reason || undefined,
      historyId: row.history_id ? Number(row.history_id) : undefined,
      qualityTaskId: row.quality_task_id || undefined,
      releaseRecordId: row.release_record_id || undefined,
      dsymCoverageStatus: row.dsym_coverage_status,
      dsymCoverage: safeJsonParse<DSYMCoverageSummary | undefined>(row.dsym_coverage_json, undefined),
      retryCount: Number(row.retry_count || 0),
      lastSyncedAt: row.last_synced_at || undefined,
      lastSyncError: row.last_sync_error || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapEventRow(row: any): CrashGovernanceEvent {
    return {
      id: Number(row.id),
      recordId: Number(row.record_id),
      action: row.action || 'status_update',
      scope: row.scope || 'single',
      fromStatus: row.from_status || undefined,
      toStatus: row.to_status || undefined,
      operator: row.operator || undefined,
      note: row.note || undefined,
      relatedRecordIds: safeJsonParse<number[]>(row.related_record_ids_json, []),
      createdAt: row.created_at,
    };
  }
}

export const crashGovernanceService = new CrashGovernanceService();
