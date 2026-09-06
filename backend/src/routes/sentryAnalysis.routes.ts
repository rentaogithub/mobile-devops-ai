import { Router, Request, Response } from 'express';
import sentryIssueService from '../services/SentryIssueService';
import aiAnalysisService from '../services/AIAnalysisService';
import { SymbolizerService } from '../services';
import historyService from '../services/HistoryService';
import { AppError, DSYMInfo, ErrorCode } from '../types';
import { extractCrashInfo } from '../utils/crashLogParser';
import { extractVersionFromCrashLog } from '../utils/versionExtractor';
import { getDatabase } from '../database';
import logger from '../utils/logger';
import { workflowIntegrationService } from '../services/WorkflowIntegrationService';
import { crashGovernanceService, CrashGovernanceStatus } from '../services/CrashGovernanceService';
import { dsymMatcherService, isMainAppDSYM } from '../services/DSYMMatcherService';
import fs from 'fs';
import path from 'path';
import { currentProductLineId } from '../services/ProductLineContext';
import { productLineConfigService } from '../services/ProductLineConfigService';

const router = Router();
const symbolizer = new SymbolizerService();

const GOVERNANCE_SYNC_LIMIT = Number(process.env.CRASH_GOVERNANCE_SYNC_LIMIT || 20);

function getExcludedSentryAppVersions() {
  return new Set(crashGovernanceService.getExcludedVersions());
}

function getDefaultSentryIssueQuery() {
  return crashGovernanceService.getDefaultIssueQuery();
}

function governanceConfigResponse() {
  const legacy = currentProductLineId() === 'nn';
  const sentryOrganization = productLineConfigService.get('SENTRY_ORG') || (legacy ? process.env.SENTRY_ORG || 'sentry' : '');
  const sentryProject = productLineConfigService.get('SENTRY_PROJECT') || (legacy ? process.env.SENTRY_PROJECT || 'nn-ios' : '');
  return {
    ...crashGovernanceService.getConfig(),
    sentryOrganization,
    sentryProject,
    sentryProxyPath: sentryOrganization && sentryProject
      ? `/organizations/${encodeURIComponent(sentryOrganization)}/projects/${encodeURIComponent(sentryProject)}/`
      : '/',
  };
}

function getRequestOperator(req: Request): string | undefined {
  const user = (req as any).authUser;
  return user?.displayName || user?.username || undefined;
}

interface SymbolicationAttemptDetail {
  appVersion: string;
  error: string;
}

function ensureSentryIssueHistoryTable() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sentry_issue_symbolication_history (
      product_line_id TEXT NOT NULL DEFAULT 'nn',
      issue_id TEXT NOT NULL,
      short_id TEXT,
      permalink TEXT,
      history_id INTEGER NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (product_line_id, issue_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sentry_issue_history_product_short_id
      ON sentry_issue_symbolication_history(product_line_id, short_id);
  `);

  const columns = db.prepare("PRAGMA table_info(sentry_issue_symbolication_history)").all() as any[];
  if (!columns.some((column) => column.name === 'permalink')) {
    db.exec('ALTER TABLE sentry_issue_symbolication_history ADD COLUMN permalink TEXT');
  }
}

function upsertSentryIssueHistory(issue: any, historyId?: number) {
  const issueId = String(issue?.id || '').trim();
  if (!issueId || !historyId) {
    return;
  }

  ensureSentryIssueHistoryTable();
  getDatabase().prepare(`
    INSERT INTO sentry_issue_symbolication_history (product_line_id, issue_id, short_id, permalink, history_id, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(product_line_id, issue_id) DO UPDATE SET
      short_id = excluded.short_id,
      permalink = COALESCE(excluded.permalink, sentry_issue_symbolication_history.permalink),
      history_id = excluded.history_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(currentProductLineId(), issueId, issue?.shortId || null, issue?.permalink || null, historyId);
}

function getSentryIssueHistoryMap(issues: any[]) {
  ensureSentryIssueHistoryTable();
  const db = getDatabase();
  const lookup = db.prepare(`
    SELECT
      h.history_id,
      sh.app_version
    FROM sentry_issue_symbolication_history h
    INNER JOIN symbolication_history sh
      ON sh.id = h.history_id AND sh.product_line_id = h.product_line_id
    WHERE h.product_line_id = ? AND (h.issue_id = ? OR h.short_id = ?)
    ORDER BY h.updated_at DESC
    LIMIT 1
  `);
  const statuses: Record<string, { historyId: number; appVersion?: string }> = {};

  issues.forEach((issue) => {
    const issueId = String(issue?.id || '').trim();
    const shortId = String(issue?.shortId || '').trim();
    if (!issueId && !shortId) {
      return;
    }
    const row = lookup.get(currentProductLineId(), issueId, shortId) as { history_id?: number; app_version?: string } | undefined;
    if (row?.history_id) {
      const status = {
        historyId: row.history_id,
        appVersion: row.app_version,
      };
      if (issueId) {
        statuses[issueId] = status;
      }
      if (shortId) {
        statuses[shortId] = status;
      }
    }
  });

  return statuses;
}

function normalizeAppVersion(version?: string): string {
  return String(version || '').trim();
}

function compareVersions(a: string, b: string): number {
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

function getHighestIssueVersion(issue: any): string {
  const excludedSentryAppVersions = getExcludedSentryAppVersions();
  const versions = [
    issue?.maxAppVersion,
    ...(Array.isArray(issue?.appVersions) ? issue.appVersions : []),
    issue?.appVersionRange?.split(' - ').pop(),
  ]
    .map(normalizeAppVersion)
    .filter((version) => version && !excludedSentryAppVersions.has(version));

  return versions.sort(compareVersions).pop() || '';
}

function getIssueVersionCandidates(issue: any, extractedVersion?: string, requestedAppVersion?: string): string[] {
  const excludedSentryAppVersions = getExcludedSentryAppVersions();
  const issueVersions = [
    issue?.maxAppVersion,
    issue?.minAppVersion,
    ...(Array.isArray(issue?.appVersions) ? issue.appVersions : []),
    ...(typeof issue?.appVersionRange === 'string' ? issue.appVersionRange.split(' - ') : []),
  ]
    .map(normalizeAppVersion)
    .filter((version) => version && !excludedSentryAppVersions.has(version))
    .sort((a, b) => compareVersions(b, a));

  const rawVersions = [
    extractedVersion,
    requestedAppVersion,
    ...issueVersions,
  ];

  return Array.from(new Set(rawVersions
    .map(normalizeAppVersion)
    .filter((version) => version && !excludedSentryAppVersions.has(version))));
}

async function findDSYMsForAppVersion(appVersion: string): Promise<DSYMInfo[]> {
  return dsymMatcherService.findDSYMsForAppVersion(appVersion);
}

function normalizeUUID(uuid?: string): string {
  return String(uuid || '').replace(/-/g, '').toLowerCase();
}

function hasDWARFFile(dsymPath: string): boolean {
  const dwarfDir = path.join(dsymPath, 'Contents', 'Resources', 'DWARF');
  if (!fs.existsSync(dwarfDir)) {
    return false;
  }

  return fs.readdirSync(dwarfDir).some((file) => !file.startsWith('.'));
}

function resolveDSYMFilePath(dsym: DSYMInfo): string {
  return dsymMatcherService.resolveDSYMFilePath(dsym);
}

function extractCrashBinaryNames(crashLog: string): Set<string> {
  const names = new Set<string>();
  crashLog.split('\n').forEach((line) => {
    const frameMatch = line.match(/^\s*\d+\s+(\S+)\s+0x[0-9a-f]+/i);
    if (frameMatch?.[1]) {
      names.add(frameMatch[1]);
    }

    const imageMatch = line.match(/0x[0-9a-f]+\s+-\s+0x[0-9a-f]+\s+(\S+)\s+\S+\s+<[^>]+>/i);
    if (imageMatch?.[1]) {
      names.add(imageMatch[1]);
    }
  });
  return names;
}

function filterDSYMsForCrash(dsymInfos: DSYMInfo[], crashLog: string): DSYMInfo[] {
  const crashBinaryNames = extractCrashBinaryNames(crashLog);
  const crashAppVersion = extractVersionFromCrashLog(crashLog);
  const normalizedCrashLog = normalizeUUID(crashLog);
  const filtered = dsymInfos.filter((dsym) => {
    const resolvedFilePath = resolveDSYMFilePath(dsym);
    const appName = dsym.appName;
    const isMainApp = isMainAppDSYM(dsym, crashAppVersion);
    const uuidMatches = normalizedCrashLog.includes(normalizeUUID(dsym.uuid));
    const nameMatches = crashBinaryNames.has(appName);
    const hasDWARF = hasDWARFFile(resolvedFilePath);

    if (!hasDWARF) {
      logger.warn('跳过缺少 DWARF 的 Sentry dSYM', {
        appName,
        uuid: dsym.uuid,
        filePath: dsym.filePath,
        resolvedFilePath,
      });
      return false;
    }

    if (uuidMatches || (nameMatches && (!isMainApp || !crashAppVersion || dsym.version === crashAppVersion))) {
      return true;
    }

    logger.info('跳过本次崩溃中未出现的组件 dSYM', {
      appName,
      uuid: dsym.uuid,
      crashBinaries: Array.from(crashBinaryNames),
    });
    return false;
  }).map((dsym) => ({
    ...dsym,
    filePath: resolveDSYMFilePath(dsym),
  }));

  return filtered.length > 0
    ? filtered
    : dsymInfos
      .map((dsym) => ({ ...dsym, filePath: resolveDSYMFilePath(dsym) }))
      .filter((dsym) => hasDWARFFile(dsym.filePath));
}

function getHistoryAppVersion(extractedVersion: string | null, fallbackVersion: string): string {
  return normalizeAppVersion(extractedVersion || '') || fallbackVersion;
}

function isVersionDetected(extractedVersion: string | null, appVersion: string): boolean {
  return !!extractedVersion && extractedVersion === appVersion;
}

function isHistoryMissingTargetUUIDs(existingUUIDs: string[] = [], targetUUIDs: string[] = []): boolean {
  const existing = new Set(existingUUIDs.map((uuid) => normalizeUUID(uuid)));
  return targetUUIDs.some((uuid) => !existing.has(normalizeUUID(uuid)));
}

function assertSentryCrashLogSymbolicatable(crashLog: string, issue: any, eventId?: string) {
  const missingStack = crashLog.includes('Sentry event does not contain stacktrace/threads');
  const missingDebugImages = crashLog.includes('Sentry event does not contain debug images');
  if (!missingStack && !missingDebugImages) {
    return;
  }

  throw new AppError(
    ErrorCode.INVALID_CRASH_LOG,
    'Sentry 原始崩溃信息不全，缺少可符号化信息',
    400,
    {
      issueId: issue?.id,
      shortId: issue?.shortId,
      eventId,
      missingStacktraceOrThreads: missingStack,
      missingDebugImages,
      hint: '请先确认后端已登录 Sentry 并能拉取 latest event；如果这是 App Hang/Watchdog 类事件，Sentry 可能没有提供可用于 atos/dSYM 符号化的线程栈和 Binary Images。',
    }
  );
}

async function syncGovernanceIssue(issue: any) {
  const normalizedIssue = sentryIssueService.normalizeIssueSummary(issue);
  const record = crashGovernanceService.upsertSentryIssue(normalizedIssue);
  try {
    const event = await sentryIssueService.getLatestEvent(normalizedIssue.id);
    const originalCrashFile = sentryIssueService.buildOriginalCrashFile(normalizedIssue, event);
    const refreshed = crashGovernanceService.upsertSentryIssue(normalizedIssue, {
      eventId: event?.id,
      symbolicationStatus: originalCrashFile.crashLog.includes('Sentry event does not contain stacktrace/threads') ||
        originalCrashFile.crashLog.includes('Sentry event does not contain debug images')
        ? 'incomplete'
        : record.symbolicationStatus,
      symbolicationError: originalCrashFile.crashLog.includes('Sentry event does not contain stacktrace/threads') ||
        originalCrashFile.crashLog.includes('Sentry event does not contain debug images')
        ? 'Sentry 原始信息不全，缺少线程栈或 Binary Images'
        : undefined,
    });
    await crashGovernanceService.refreshCoverageForRecord(normalizedIssue.id, originalCrashFile.crashLog);
    return crashGovernanceService.getById(refreshed.id) || refreshed;
  } catch (error: any) {
    return crashGovernanceService.upsertSentryIssue(normalizedIssue, {
      syncError: error.message || '同步 Sentry Issue 失败',
    });
  }
}

async function syncGovernanceIssues(options: {
  period?: string;
  limit?: number;
  query?: string;
} = {}) {
  const defaultSentryIssueQuery = getDefaultSentryIssueQuery();
  const issues = await sentryIssueService.listNewIssues({
    period: options.period || '24h',
    limit: Math.min(Math.max(Number(options.limit || GOVERNANCE_SYNC_LIMIT), 1), 50),
    query: options.query || defaultSentryIssueQuery,
    enrichVersions: true,
  });
  workflowIntegrationService.syncSentryIssues(issues);
  const records = [];
  for (const issue of issues) {
    records.push(await syncGovernanceIssue(issue));
  }
  return {
    period: options.period || '24h',
    query: options.query || defaultSentryIssueQuery,
    total: records.length,
    records,
  };
}

async function symbolicateAndSaveSentryIssue(issue: any, requestedAppVersion = '') {
  if (!issue?.id) {
    throw new AppError(ErrorCode.INVALID_CRASH_LOG, '请选择要解析的 Sentry 问题', 400);
  }
  const excludedSentryAppVersions = getExcludedSentryAppVersions();

  const normalizedIssue = sentryIssueService.normalizeIssueSummary(issue);
  crashGovernanceService.upsertSentryIssue(normalizedIssue, { symbolicationStatus: 'pending' });
  const event = await sentryIssueService.getLatestEvent(normalizedIssue.id);
  const originalCrashFile = sentryIssueService.buildOriginalCrashFile(normalizedIssue, event);
  const crashLog = originalCrashFile.crashLog;
  assertSentryCrashLogSymbolicatable(crashLog, normalizedIssue, event?.id);
  const extractedVersion = extractVersionFromCrashLog(crashLog);
  const appVersions = getIssueVersionCandidates(normalizedIssue, extractedVersion || undefined, requestedAppVersion);
  if (appVersions.length === 0) {
    throw new AppError(
      ErrorCode.INVALID_CRASH_LOG,
      '未找到可用于解析的 APP 版本，请先刷新 Sentry 问题列表',
      400
    );
  }

  const attempts: SymbolicationAttemptDetail[] = [];
  for (const appVersion of appVersions) {
    try {
      const dsymInfos = await findDSYMsForAppVersion(appVersion);
      if (dsymInfos.length === 0) {
        attempts.push({ appVersion, error: '未找到对应 dSYM' });
        continue;
      }

      const crashDSYMInfos = filterDSYMsForCrash(dsymInfos, crashLog);
      if (crashDSYMInfos.length === 0) {
        attempts.push({ appVersion, error: 'dSYM 不适用于本次崩溃或缺少 DWARF' });
        continue;
      }

      const targetUUIDs = crashDSYMInfos.map((dsym) => dsym.uuid);
      const dsymPaths = crashDSYMInfos.map((dsym) => dsym.filePath);
      const recordAppVersion = getHistoryAppVersion(extractedVersion, appVersion);
      const userIdentifiers = sentryIssueService.extractEventUserIdentifiers(event);
      let existingHistory =
        historyService.findDuplicateHistory(crashLog, targetUUIDs) ||
        historyService.findDuplicateByOriginalLog(crashLog, recordAppVersion) ||
        historyService.findDuplicateByOriginalLog(crashLog);

      if (existingHistory) {
        if ((!existingHistory.uid && userIdentifiers.uid) || (!existingHistory.deviceId && userIdentifiers.deviceId)) {
          historyService.updateUserIdentifiers(existingHistory.id, userIdentifiers);
          existingHistory = historyService.getHistoryById(existingHistory.id);
        }

        const shouldRefreshVersion = extractedVersion && existingHistory.appVersion !== recordAppVersion;
        if (isHistoryMissingTargetUUIDs(existingHistory.usedUuids, targetUUIDs) || shouldRefreshVersion) {
          logger.info('Sentry 自动符号化命中旧历史，刷新缺失 dSYM 的符号化结果', {
            issueId: normalizedIssue.id,
            historyId: existingHistory.id,
            existingUUIDs: existingHistory.usedUuids,
            targetUUIDs,
            existingAppVersion: existingHistory.appVersion,
            recordAppVersion,
          });

          const symbolicated = await symbolizer.symbolicateWithMultipleDSYMs(crashLog, dsymPaths);
          const crashInfo = extractCrashInfo(crashLog, symbolicated.symbolicatedLog);
          const versionDetected = isVersionDetected(extractedVersion, recordAppVersion);

          existingHistory = await historyService.updateSymbolicationResult(existingHistory.id, {
            appVersion: recordAppVersion,
            versionDetected,
            crashType: crashInfo.crashType,
            crashReason: crashInfo.crashReason,
            lastStackCall: crashInfo.lastStackCall,
            crashModule: crashInfo.crashModule,
            crashLocation: crashInfo.crashLocation,
            uid: userIdentifiers.uid,
            deviceId: userIdentifiers.deviceId,
            originalLog: crashLog,
            symbolicatedLog: symbolicated.symbolicatedLog,
            usedUuids: targetUUIDs,
            aiAnalysis: undefined,
          });
        }

        upsertSentryIssueHistory(normalizedIssue, existingHistory.id);
        crashGovernanceService.upsertSentryIssue(normalizedIssue, {
          eventId: event?.id,
          historyId: existingHistory.id,
          symbolicationStatus: 'success',
          analysisStatus: existingHistory.aiAnalysis ? 'success' : 'pending',
          analysis: existingHistory.aiAnalysis,
        });
        await crashGovernanceService.refreshCoverageForRecord(normalizedIssue.id, crashLog);
        return {
          issue: normalizedIssue,
          eventId: event?.id,
          incidentIdentifier: originalCrashFile.incidentIdentifier,
          appVersion: existingHistory.appVersion || recordAppVersion,
          originalLog: existingHistory.originalLog,
          symbolicatedLog: existingHistory.symbolicatedLog,
          matchedUUIDs: existingHistory.usedUuids,
          historyId: existingHistory.id,
          fromHistory: true,
          hasAIAnalysis: !!existingHistory.aiAnalysis,
        };
      }

      const symbolicated = await symbolizer.symbolicateWithMultipleDSYMs(crashLog, dsymPaths);
      const crashInfo = extractCrashInfo(crashLog, symbolicated.symbolicatedLog);
      const versionDetected = isVersionDetected(extractedVersion, recordAppVersion);
      const savedRecord = await historyService.saveHistory({
        appVersion: recordAppVersion,
        versionDetected,
        crashType: crashInfo.crashType,
        crashReason: crashInfo.crashReason,
        lastStackCall: crashInfo.lastStackCall,
        crashModule: crashInfo.crashModule,
        crashLocation: crashInfo.crashLocation,
        uid: userIdentifiers.uid,
        deviceId: userIdentifiers.deviceId,
        originalLog: crashLog,
        symbolicatedLog: symbolicated.symbolicatedLog,
        usedUuids: targetUUIDs,
      });

      upsertSentryIssueHistory(normalizedIssue, savedRecord.id);
      crashGovernanceService.upsertSentryIssue(normalizedIssue, {
        eventId: event?.id,
        historyId: savedRecord.id,
        symbolicationStatus: 'success',
        analysisStatus: 'pending',
      });
      await crashGovernanceService.refreshCoverageForRecord(normalizedIssue.id, crashLog);
      return {
        issue: normalizedIssue,
        eventId: event?.id,
        incidentIdentifier: originalCrashFile.incidentIdentifier,
        appVersion: recordAppVersion,
        originalLog: crashLog,
        symbolicatedLog: symbolicated.symbolicatedLog,
        matchedUUIDs: targetUUIDs,
        warning: symbolicated.warning,
        historyId: savedRecord.id,
        fromHistory: false,
        hasAIAnalysis: false,
      };
    } catch (error: any) {
      attempts.push({ appVersion, error: error.message || '符号化失败' });
    }
  }

  const attemptMessages = attempts.map((attempt) => `${attempt.appVersion}: ${attempt.error}`);
  crashGovernanceService.markSymbolication(normalizedIssue.id, {
    status: 'failed',
    eventId: event?.id,
    error: attemptMessages.join('；') || '候选版本均符号化失败',
  });
  throw new AppError(
    ErrorCode.DSYM_NOT_FOUND,
    `候选版本均符号化失败：${attemptMessages.join('；')}`,
    404,
    {
      issueId: normalizedIssue.id,
      shortId: normalizedIssue.shortId,
      title: normalizedIssue.title,
      eventId: event?.id,
      extractedVersion,
      candidateVersions: appVersions,
      excludedVersions: Array.from(excludedSentryAppVersions),
      attempts,
      hint: '请检查候选版本是否已上传匹配 UUID 的 dSYM，或该 Sentry event 是否包含 Binary Images / debug images。',
    }
  );
}

router.get('/governance/dashboard', (_req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      data: crashGovernanceService.dashboard(),
    });
  } catch (error: any) {
    logger.error('获取 Crash 治理看板失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '获取 Crash 治理看板失败',
    });
  }
});

router.get('/governance/config', (_req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      data: governanceConfigResponse(),
    });
  } catch (error: any) {
    logger.error('获取 Crash 治理配置失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '获取 Crash 治理配置失败',
    });
  }
});

router.patch('/governance/config', (req: Request, res: Response) => {
  try {
    crashGovernanceService.updateConfig({
      excludedVersions: req.body?.excludedVersions,
    });
    res.json({
      success: true,
      data: governanceConfigResponse(),
    });
  } catch (error: any) {
    logger.error('更新 Crash 治理配置失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '更新 Crash 治理配置失败',
    });
  }
});

router.get('/governance/issues', (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status as CrashGovernanceStatus | 'open' : undefined;
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;
    const appVersion = typeof req.query.appVersion === 'string' ? req.query.appVersion : undefined;
    const dsymCoverageStatus = typeof req.query.dsymCoverageStatus === 'string' ? req.query.dsymCoverageStatus : undefined;
    const symbolicationStatus = typeof req.query.symbolicationStatus === 'string' ? req.query.symbolicationStatus : undefined;
    const symbolicationFailureCategory = typeof req.query.symbolicationFailureCategory === 'string' ? req.query.symbolicationFailureCategory : undefined;
    const analysisStatus = typeof req.query.analysisStatus === 'string' ? req.query.analysisStatus : undefined;
    const owner = typeof req.query.owner === 'string' ? req.query.owner : undefined;
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined;
    const limit = Number(req.query.limit || 50);
    res.json({
      success: true,
      data: {
        issues: crashGovernanceService.list({
          status,
          source,
          appVersion,
          dsymCoverageStatus,
          symbolicationStatus,
          symbolicationFailureCategory,
          analysisStatus,
          owner,
          keyword,
          limit,
        }),
      },
    });
  } catch (error: any) {
    logger.error('获取 Crash 治理列表失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '获取 Crash 治理列表失败',
    });
  }
});

router.post('/governance/sync', async (req: Request, res: Response) => {
  try {
    const defaultSentryIssueQuery = getDefaultSentryIssueQuery();
    const {
      period = '24h',
      limit = GOVERNANCE_SYNC_LIMIT,
      query = defaultSentryIssueQuery,
    } = req.body || {};
    const result = await syncGovernanceIssues({
      period: String(period || '24h'),
      limit: Number(limit || GOVERNANCE_SYNC_LIMIT),
      query: String(query || defaultSentryIssueQuery),
    });
    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    logger.error('同步 Crash 治理状态失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '同步 Crash 治理状态失败',
    });
  }
});

router.get('/governance/events', (req: Request, res: Response) => {
  try {
    const scope = typeof req.query.scope === 'string' ? req.query.scope : undefined;
    const toStatus = typeof req.query.toStatus === 'string' ? req.query.toStatus : undefined;
    const operator = typeof req.query.operator === 'string' ? req.query.operator : undefined;
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined;
    const limit = Number(req.query.limit || 100);
    res.json({
      success: true,
      data: {
        events: crashGovernanceService.listRecentGovernanceEvents({
          scope,
          toStatus,
          operator,
          keyword,
          limit,
        }),
      },
    });
  } catch (error: any) {
    logger.error('获取 Crash 治理记录失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '获取 Crash 治理记录失败',
    });
  }
});

router.get('/governance/events/export', (req: Request, res: Response) => {
  try {
    const scope = typeof req.query.scope === 'string' ? req.query.scope : undefined;
    const toStatus = typeof req.query.toStatus === 'string' ? req.query.toStatus : undefined;
    const operator = typeof req.query.operator === 'string' ? req.query.operator : undefined;
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined;
    const limit = Number(req.query.limit || 200);
    const csv = `\uFEFF${crashGovernanceService.exportGovernanceEventsCsv({
      scope,
      toStatus,
      operator,
      keyword,
      limit,
    })}`;
    const fileName = `crash-governance-events-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(csv);
  } catch (error: any) {
    logger.error('导出 Crash 治理记录失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '导出 Crash 治理记录失败',
    });
  }
});

router.post('/governance/versions/:appVersion/refresh-coverage', async (req: Request, res: Response) => {
  try {
    const appVersion = String(req.params.appVersion || '').trim();
    if (!appVersion) {
      res.status(400).json({ success: false, error: 'App 版本不能为空' });
      return;
    }
    const result = await crashGovernanceService.refreshCoverageByVersion(appVersion);
    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    logger.error('批量重查版本 dSYM 覆盖失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '批量重查版本 dSYM 覆盖失败',
    });
  }
});

router.get('/governance/issues/:id', (req: Request, res: Response) => {
  try {
    const record = crashGovernanceService.getById(Number(req.params.id));
    if (!record) {
      res.status(404).json({ success: false, error: 'Crash 记录不存在' });
      return;
    }
    const history = record.historyId ? historyService.getHistoryById(record.historyId) : undefined;
    const fingerprintGroup = crashGovernanceService.getFingerprintGroupByRecordId(record.id);
    const events = crashGovernanceService.listGovernanceEvents(record.id);
    res.json({
      success: true,
      data: {
        record,
        history,
        fingerprintGroup,
        events,
      },
    });
  } catch (error: any) {
    logger.error('获取 Crash 治理详情失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '获取 Crash 治理详情失败',
    });
  }
});

router.post('/governance/issues/:id/refresh-coverage', async (req: Request, res: Response) => {
  try {
    const record = crashGovernanceService.getById(Number(req.params.id));
    if (!record) {
      res.status(404).json({ success: false, error: 'Crash 记录不存在' });
      return;
    }
    if (!record.appVersion) {
      res.status(400).json({ success: false, error: '当前 Crash 缺少 App 版本，无法重查 dSYM 覆盖' });
      return;
    }
    const history = record.historyId ? historyService.getHistoryById(record.historyId) : undefined;
    const nextRecord = await crashGovernanceService.refreshCoverageById(
      record.id,
      history?.originalLog || history?.symbolicatedLog,
    );
    res.json({
      success: true,
      data: nextRecord,
    });
  } catch (error: any) {
    logger.error('重查 Crash dSYM 覆盖失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '重查 Crash dSYM 覆盖失败',
    });
  }
});

router.post('/governance/issues/:id/analyze', (req: Request, res: Response) => {
  try {
    const record = crashGovernanceService.getById(Number(req.params.id));
    if (!record) {
      res.status(404).json({ success: false, error: 'Crash 记录不存在' });
      return;
    }
    if (!record.historyId) {
      res.status(400).json({ success: false, error: '当前 Crash 未关联符号化历史，无法执行 AI 分析' });
      return;
    }
    const history = historyService.getHistoryById(record.historyId);
    if (!history?.symbolicatedLog) {
      res.status(400).json({ success: false, error: '符号化历史不存在或缺少符号化日志' });
      return;
    }
    const apiKey = String(req.body?.apiKey || '');
    if (!aiAnalysisService.hasConfiguredAPIKey(apiKey)) {
      res.status(400).json({ success: false, error: '未配置 AI API Key' });
      return;
    }

    const pendingRecord = crashGovernanceService.markAnalysisByRecordId(record.id, { status: 'pending' }) || record;
    setImmediate(async () => {
      try {
        const analysis = await aiAnalysisService.analyzeCrashLog(
          history.symbolicatedLog,
          apiKey,
          history.appVersion || record.appVersion,
        );
        await historyService.updateAIAnalysis(history.id, analysis);
        crashGovernanceService.markAnalysisByRecordId(record.id, {
          status: 'success',
          analysis,
        });
      } catch (error: any) {
        crashGovernanceService.markAnalysisByRecordId(record.id, {
          status: 'failed',
          error: error.message || 'AI 分析失败',
        });
        logger.warn('Crash 治理异步 AI 分析失败', {
          recordId: record.id,
          historyId: history.id,
          error: error.message,
        });
      }
    });

    res.json({
      success: true,
      data: {
        record: pendingRecord,
        message: 'AI 分析已开始',
      },
    });
  } catch (error: any) {
    logger.error('启动 Crash 治理 AI 分析失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '启动 Crash 治理 AI 分析失败',
    });
  }
});

router.patch('/governance/issues/:id/status', (req: Request, res: Response) => {
  try {
    const {
      governanceStatus,
      owner,
      fixedVersion,
      fixedRemark,
      ignoreReason,
    } = req.body || {};
    const allowedStatuses = new Set(['new', 'analyzing', 'pending_fix', 'fixed', 'regression', 'ignored']);
    if (!allowedStatuses.has(String(governanceStatus))) {
      res.status(400).json({ success: false, error: '治理状态无效' });
      return;
    }
    const record = crashGovernanceService.updateGovernanceStatus(Number(req.params.id), {
      governanceStatus,
      owner,
      fixedVersion,
      fixedRemark,
      ignoreReason,
      operator: getRequestOperator(req),
    });
    res.json({
      success: true,
      data: record,
    });
  } catch (error: any) {
    logger.error('更新 Crash 治理状态失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '更新 Crash 治理状态失败',
    });
  }
});

router.patch('/governance/issues/:id/fingerprint/status', (req: Request, res: Response) => {
  try {
    const {
      governanceStatus,
      owner,
      fixedVersion,
      fixedRemark,
      ignoreReason,
    } = req.body || {};
    const allowedStatuses = new Set(['new', 'analyzing', 'pending_fix', 'fixed', 'regression', 'ignored']);
    if (!allowedStatuses.has(String(governanceStatus))) {
      res.status(400).json({ success: false, error: '治理状态无效' });
      return;
    }
    const group = crashGovernanceService.updateFingerprintGroupStatus(Number(req.params.id), {
      governanceStatus,
      owner,
      fixedVersion,
      fixedRemark,
      ignoreReason,
      operator: getRequestOperator(req),
    });
    res.json({
      success: true,
      data: group,
    });
  } catch (error: any) {
    logger.error('批量更新同类 Crash 治理状态失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '批量更新同类 Crash 治理状态失败',
    });
  }
});

router.post('/issues', async (req: Request, res: Response) => {
  try {
    const defaultSentryIssueQuery = getDefaultSentryIssueQuery();
    const {
      period = '24h',
      limit = 10,
      query,
      enrichVersions = false,
    } = req.body || {};

    const issues = await sentryIssueService.listNewIssues({
      period: String(period || '24h'),
      limit: Number(limit || 10),
      query: query ? String(query) : undefined,
      enrichVersions: Boolean(enrichVersions),
    });
    workflowIntegrationService.syncSentryIssues(issues);
    issues.forEach((issue) => crashGovernanceService.upsertSentryIssue(issue));

    res.json({
      success: true,
      data: {
        period,
        query: query || defaultSentryIssueQuery,
        total: issues.length,
        issues,
      },
    });
  } catch (error: any) {
    logger.error('抓取 Sentry 问题列表失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '抓取 Sentry 问题列表失败',
    });
  }
});

router.post('/sync-issues', async (req: Request, res: Response) => {
  try {
    const inputIssues = Array.isArray(req.body?.issues) ? req.body.issues.slice(0, 50) : [];
    if (inputIssues.length === 0) {
      res.status(400).json({ success: false, error: '缺少待同步的 Sentry Issue' });
      return;
    }

    const normalizedIssues = inputIssues.map((issue: any) => sentryIssueService.normalizeIssueSummary(issue));
    const enrichedIssues = (await sentryIssueService.enrichIssueSummaries(normalizedIssues))
      .filter((issue) => !issue.excludedAppVersionOnly);
    const synced = workflowIntegrationService.syncSentryIssues(enrichedIssues);

    res.json({
      success: true,
      data: {
        total: enrichedIssues.length,
        synced: synced.length,
        issues: enrichedIssues,
      },
    });
  } catch (error: any) {
    logger.error('同步 Sentry Issue 到 Workflow 失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '同步 Sentry Issue 到 Workflow 失败',
    });
  }
});

router.post('/analyze-selected', async (req: Request, res: Response) => {
  try {
    const {
      apiKey = '',
      issueIds = [],
      issues = [],
    } = req.body || {};

    if (!Array.isArray(issueIds) || issueIds.length === 0) {
      res.status(400).json({
        success: false,
        error: '请选择要分析的 Sentry 问题',
      });
      return;
    }

    const issueMap = new Map((Array.isArray(issues) ? issues : []).map((issue: any) => [String(issue.id), issue]));
    const selectedIssues = issueIds.map((id: string) => issueMap.get(String(id)) || { id: String(id), title: String(id) });

    const results = await Promise.all(selectedIssues.map(async (issue: any) => {
      try {
        const normalizedIssue = sentryIssueService.normalizeIssueSummary(issue);
        const event = await sentryIssueService.getLatestEvent(normalizedIssue.id);
        const analysisLog = sentryIssueService.buildAnalysisLog(normalizedIssue, event);
        const analysis = await aiAnalysisService.analyzeCrashLog(analysisLog, apiKey);
        return {
          issue: normalizedIssue,
          eventId: event?.id,
          analysisLog,
          analysis,
        };
      } catch (error: any) {
        logger.warn('Sentry 指定 issue AI 分析失败', {
          issueId: issue.id,
          error: error.message,
        });
        return {
          issue,
          error: error.message || 'AI 分析失败',
        };
      }
    }));
    results.forEach((result: any) => workflowIntegrationService.syncSentryIssue(
      { ...(result.issue || {}), eventId: result.eventId },
      result.analysis,
    ));

    res.json({
      success: true,
      data: {
        total: results.length,
        results,
      },
    });
  } catch (error: any) {
    logger.error('分析指定 Sentry 问题失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '分析指定 Sentry 问题失败',
    });
  }
});

router.post('/aggregate-analyze', async (req: Request, res: Response) => {
  try {
    const {
      apiKey = '',
      issues = [],
      limit = 10,
    } = req.body || {};

    if (!Array.isArray(issues) || issues.length === 0) {
      res.status(400).json({
        success: false,
        error: '请选择要聚合分析的 Sentry 问题',
      });
      return;
    }

    const selectedIssues = issues.slice(0, Math.min(Math.max(Number(limit || 10), 1), 12));
    const aggregateInputs = await Promise.all(selectedIssues.map(async (issue: any) => {
      const normalizedIssue = sentryIssueService.normalizeIssueSummary(issue);
      const event = await sentryIssueService.getLatestEvent(normalizedIssue.id);
      return {
        id: normalizedIssue.id,
        shortId: normalizedIssue.shortId,
        title: normalizedIssue.title,
        count: normalizedIssue.count,
        userCount: normalizedIssue.userCount,
        level: normalizedIssue.level,
        appVersionRange: normalizedIssue.appVersionRange,
        eventId: event?.id,
        analysisLog: sentryIssueService.buildAnalysisLog(normalizedIssue, event),
      };
    }));

    const analysis = await aiAnalysisService.analyzeAggregateCrashes(aggregateInputs, apiKey);
    aggregateInputs.forEach((issue: any) => workflowIntegrationService.syncSentryIssue(issue, analysis));

    res.json({
      success: true,
      data: {
        total: aggregateInputs.length,
        issues: aggregateInputs.map(({ analysisLog, ...issue }) => issue),
        analysis,
      },
    });
  } catch (error: any) {
    logger.error('Sentry 聚合分析失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || 'Sentry 聚合分析失败',
    });
  }
});

router.post('/symbolicate-log', async (req: Request, res: Response) => {
  try {
    const { issue } = req.body || {};
    if (!issue?.id) {
      res.status(400).json({
        success: false,
        error: '请选择要解析的 Sentry 问题',
      });
      return;
    }

    const normalizedIssue = sentryIssueService.normalizeIssueSummary(issue);
    const event = await sentryIssueService.getLatestEvent(normalizedIssue.id);
    const crashLog = sentryIssueService.buildAnalysisLog(normalizedIssue, event);

    res.json({
      success: true,
      data: {
        issue: normalizedIssue,
        eventId: event?.id,
        crashLog,
      },
    });
  } catch (error: any) {
    logger.error('生成 Sentry 解析日志失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '生成 Sentry 解析日志失败',
    });
  }
});

router.post('/original-crash', async (req: Request, res: Response) => {
  try {
    const { issue } = req.body || {};
    if (!issue?.id) {
      res.status(400).json({
        success: false,
        error: '请选择要下载的 Sentry 问题',
      });
      return;
    }

    const normalizedIssue = sentryIssueService.normalizeIssueSummary(issue);
    const event = await sentryIssueService.getLatestEvent(normalizedIssue.id);
    const originalCrashFile = sentryIssueService.buildOriginalCrashFile(normalizedIssue, event);

    res.json({
      success: true,
      data: {
        issue: normalizedIssue,
        ...originalCrashFile,
      },
    });
  } catch (error: any) {
    logger.error('下载 Sentry 原始崩溃文件失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '下载 Sentry 原始崩溃文件失败',
    });
  }
});

router.post('/symbolicate-and-save', async (req: Request, res: Response) => {
  try {
    const {
      issue,
      appVersion: requestedAppVersion = '',
    } = req.body || {};

    const result = await symbolicateAndSaveSentryIssue(issue, requestedAppVersion);
    workflowIntegrationService.syncSentryIssue(
      { ...(result.issue || issue || {}), eventId: result.eventId, appVersion: result.appVersion },
      (result as any).aiAnalysis,
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    logger.error('Sentry 问题符号化入库失败', {
      code: error.code,
      error: error.message,
      details: error.details,
    });

    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        code: error.code,
        error: error.message,
        details: error.details,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Sentry 问题符号化入库失败',
    });
  }
});

router.post('/history-status', async (req: Request, res: Response) => {
  try {
    const { issues = [] } = req.body || {};
    if (!Array.isArray(issues)) {
      res.status(400).json({
        success: false,
        error: 'issues 必须是数组',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        statuses: getSentryIssueHistoryMap(issues),
      },
    });
  } catch (error: any) {
    logger.error('查询 Sentry 入库状态失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '查询 Sentry 入库状态失败',
    });
  }
});

router.post('/symbolicate-selected', async (req: Request, res: Response) => {
  try {
    const {
      issues = [],
      limit = 10,
    } = req.body || {};

    if (!Array.isArray(issues) || issues.length === 0) {
      res.status(400).json({
        success: false,
        error: '请选择要符号化入库的 Sentry 问题',
      });
      return;
    }

    const selectedIssues = issues.slice(0, Math.min(Math.max(Number(limit || 10), 1), 20));
    const results = [];
    for (const issue of selectedIssues) {
      try {
        results.push(await symbolicateAndSaveSentryIssue(issue, getHighestIssueVersion(issue)));
      } catch (error: any) {
        logger.warn('Sentry 批量符号化单条失败', {
          issueId: issue?.id,
          error: error.message,
        });
        results.push({
          issue: sentryIssueService.normalizeIssueSummary(issue),
          error: error.message || '符号化入库失败',
        });
      }
    }
    results.forEach((result: any) => workflowIntegrationService.syncSentryIssue(
      { ...(result.issue || {}), eventId: result.eventId, appVersion: result.appVersion },
      result.aiAnalysis,
    ));

    res.json({
      success: true,
      data: {
        total: results.length,
        successCount: results.filter((result: any) => !result.error).length,
        failedCount: results.filter((result: any) => result.error).length,
        results,
      },
    });
  } catch (error: any) {
    logger.error('Sentry 批量符号化入库失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || 'Sentry 批量符号化入库失败',
    });
  }
});

router.post('/symbolicate-and-analyze', async (req: Request, res: Response) => {
  try {
    const {
      issue,
      appVersion: requestedAppVersion = '',
      apiKey = '',
    } = req.body || {};

    if (!issue?.id) {
      res.status(400).json({
        success: false,
        error: '请选择要解析的 Sentry 问题',
      });
      return;
    }

    const normalizedIssue = sentryIssueService.normalizeIssueSummary(issue);
    const event = await sentryIssueService.getLatestEvent(normalizedIssue.id);
    const originalCrashFile = sentryIssueService.buildOriginalCrashFile(normalizedIssue, event);
    const crashLog = originalCrashFile.crashLog;
    const extractedVersion = extractVersionFromCrashLog(crashLog);
    const appVersion = normalizeAppVersion(extractedVersion || '') ||
      normalizeAppVersion(requestedAppVersion) ||
      getHighestIssueVersion(normalizedIssue);
    if (!appVersion) {
      throw new AppError(
        ErrorCode.INVALID_CRASH_LOG,
        '未找到可用于解析的 APP 版本，请先刷新 Sentry 问题列表',
        400
      );
    }

    const dsymInfos = await findDSYMsForAppVersion(appVersion);
    if (dsymInfos.length === 0) {
      throw new AppError(
        ErrorCode.DSYM_NOT_FOUND,
        `未找到 APP 版本 ${appVersion} 对应的 dSYM，请先上传或关联组件库 dSYM`,
        404
      );
    }

    logger.info('开始解析 Sentry 问题', {
      issueId: normalizedIssue.id,
      shortId: normalizedIssue.shortId,
      appVersion,
      dsymCount: dsymInfos.length,
    });

    const crashDSYMInfos = filterDSYMsForCrash(dsymInfos, crashLog);
    if (crashDSYMInfos.length === 0) {
      throw new AppError(
        ErrorCode.DSYM_NOT_FOUND,
        `未找到 APP 版本 ${appVersion} 可用于本次崩溃的 dSYM，请检查 dSYM 文件是否完整`,
        404
      );
    }

    const targetUUIDs = crashDSYMInfos.map((dsym) => dsym.uuid);
    const dsymPaths = crashDSYMInfos.map((dsym) => dsym.filePath);
    const recordAppVersion = getHistoryAppVersion(extractedVersion, appVersion);
    const userIdentifiers = sentryIssueService.extractEventUserIdentifiers(event);
    let existingHistory =
      historyService.findDuplicateHistory(crashLog, targetUUIDs) ||
      historyService.findDuplicateByOriginalLog(crashLog, recordAppVersion) ||
      historyService.findDuplicateByOriginalLog(crashLog);

    if (existingHistory) {
      if ((!existingHistory.uid && userIdentifiers.uid) || (!existingHistory.deviceId && userIdentifiers.deviceId)) {
        historyService.updateUserIdentifiers(existingHistory.id, userIdentifiers);
        existingHistory = historyService.getHistoryById(existingHistory.id);
      }

      const shouldRefreshVersion = extractedVersion && existingHistory.appVersion !== recordAppVersion;
      if (isHistoryMissingTargetUUIDs(existingHistory.usedUuids, targetUUIDs) || shouldRefreshVersion) {
        logger.info('Sentry 历史记录缺少当前可用 dSYM，刷新符号化结果', {
          issueId: normalizedIssue.id,
          historyId: existingHistory.id,
          existingUUIDs: existingHistory.usedUuids,
          targetUUIDs,
          existingAppVersion: existingHistory.appVersion,
          recordAppVersion,
        });

        const symbolicated = await symbolizer.symbolicateWithMultipleDSYMs(crashLog, dsymPaths);
        const crashInfo = extractCrashInfo(crashLog, symbolicated.symbolicatedLog);
        const versionDetected = isVersionDetected(extractedVersion, recordAppVersion);

        existingHistory = await historyService.updateSymbolicationResult(existingHistory.id, {
          appVersion: recordAppVersion,
          versionDetected,
          crashType: crashInfo.crashType,
          crashReason: crashInfo.crashReason,
          lastStackCall: crashInfo.lastStackCall,
          crashModule: crashInfo.crashModule,
          crashLocation: crashInfo.crashLocation,
          uid: userIdentifiers.uid,
          deviceId: userIdentifiers.deviceId,
          originalLog: crashLog,
          symbolicatedLog: symbolicated.symbolicatedLog,
          usedUuids: targetUUIDs,
          aiAnalysis: undefined,
        });
      }

      logger.info('Sentry 问题已解析过，直接返回历史记录', {
        issueId: normalizedIssue.id,
        appVersion: recordAppVersion,
        historyId: existingHistory.id,
        hasAIAnalysis: !!existingHistory.aiAnalysis,
      });

      let aiAnalysis = existingHistory.aiAnalysis;
      let aiError: string | undefined = undefined;

      if (!aiAnalysis) {
        if (aiAnalysisService.hasConfiguredAPIKey(apiKey)) {
          try {
            aiAnalysis = await aiAnalysisService.analyzeCrashLog(
              existingHistory.symbolicatedLog,
              apiKey,
              existingHistory.appVersion || recordAppVersion
            );
            await historyService.updateAIAnalysis(existingHistory.id, aiAnalysis);
            logger.info('Sentry 历史记录已补充 AI 分析', {
              issueId: normalizedIssue.id,
              historyId: existingHistory.id,
            });
          } catch (error: any) {
            aiError = error.message || 'AI 分析失败';
            logger.warn('Sentry 历史记录补充 AI 分析失败，保留符号化结果', {
              issueId: normalizedIssue.id,
              historyId: existingHistory.id,
              error: aiError,
            });
          }
        } else {
          aiError = '未配置 AI API Key';
        }
      }

      workflowIntegrationService.syncSentryIssue(
        { ...normalizedIssue, eventId: event?.id, appVersion: existingHistory.appVersion || recordAppVersion },
        aiAnalysis,
      );
      crashGovernanceService.upsertSentryIssue(normalizedIssue, {
        eventId: event?.id,
        historyId: existingHistory.id,
        symbolicationStatus: 'success',
        analysisStatus: aiAnalysis ? 'success' : (aiError ? 'failed' : 'pending'),
        analysisError: aiError,
        analysis: aiAnalysis,
      });
      await crashGovernanceService.refreshCoverageForRecord(normalizedIssue.id, crashLog);

      res.json({
        success: true,
        data: {
          issue: normalizedIssue,
          eventId: event?.id,
          incidentIdentifier: originalCrashFile.incidentIdentifier,
          appVersion: existingHistory.appVersion || recordAppVersion,
          originalLog: existingHistory.originalLog,
          symbolicatedLog: existingHistory.symbolicatedLog,
          matchedUUIDs: existingHistory.usedUuids,
          aiAnalysis,
          aiError,
          historyId: existingHistory.id,
          fromHistory: true,
        },
      });
      return;
    }

    const symbolicated = await symbolizer.symbolicateWithMultipleDSYMs(crashLog, dsymPaths);

    const crashInfo = extractCrashInfo(crashLog, symbolicated.symbolicatedLog);
    const versionDetected = isVersionDetected(extractedVersion, recordAppVersion);

    let aiAnalysis: any = undefined;
    let aiError: string | undefined = undefined;
    if (aiAnalysisService.hasConfiguredAPIKey(apiKey)) {
      try {
        aiAnalysis = await aiAnalysisService.analyzeCrashLog(
          symbolicated.symbolicatedLog,
          apiKey,
          recordAppVersion
        );
      } catch (error: any) {
        aiError = error.message || 'AI 分析失败';
        logger.warn('Sentry 问题 AI 分析失败，保留符号化结果', {
          issueId: normalizedIssue.id,
          error: aiError,
        });
      }
    } else {
      aiError = '未配置 AI API Key';
    }

    const savedRecord = await historyService.saveHistory({
      appVersion: recordAppVersion,
      versionDetected,
      crashType: crashInfo.crashType,
      crashReason: crashInfo.crashReason,
      lastStackCall: crashInfo.lastStackCall,
      crashModule: crashInfo.crashModule,
      crashLocation: crashInfo.crashLocation,
      uid: userIdentifiers.uid,
      deviceId: userIdentifiers.deviceId,
      originalLog: crashLog,
      symbolicatedLog: symbolicated.symbolicatedLog,
      usedUuids: targetUUIDs,
      aiAnalysis,
    });

    logger.info('Sentry 问题解析完成', {
      issueId: normalizedIssue.id,
      appVersion: recordAppVersion,
      historyId: savedRecord.id,
      hasAIAnalysis: !!aiAnalysis,
    });
    workflowIntegrationService.syncSentryIssue(
      { ...normalizedIssue, eventId: event?.id, appVersion: recordAppVersion },
      aiAnalysis,
    );
    crashGovernanceService.upsertSentryIssue(normalizedIssue, {
      eventId: event?.id,
      historyId: savedRecord.id,
      symbolicationStatus: 'success',
      analysisStatus: aiAnalysis ? 'success' : (aiError ? 'failed' : 'pending'),
      analysisError: aiError,
      analysis: aiAnalysis,
    });
    await crashGovernanceService.refreshCoverageForRecord(normalizedIssue.id, crashLog);

    res.json({
      success: true,
      data: {
        issue: normalizedIssue,
        eventId: event?.id,
        incidentIdentifier: originalCrashFile.incidentIdentifier,
        appVersion: recordAppVersion,
        originalLog: crashLog,
        symbolicatedLog: symbolicated.symbolicatedLog,
        matchedUUIDs: targetUUIDs,
        warning: symbolicated.warning,
        aiAnalysis,
        aiError,
        historyId: savedRecord.id,
      },
    });
  } catch (error: any) {
    logger.error('解析 Sentry 问题失败', { error: error.message });
    if (req.body?.issue?.id) {
      crashGovernanceService.upsertSentryIssue(
        sentryIssueService.normalizeIssueSummary(req.body.issue),
        {
          symbolicationStatus: error instanceof AppError && error.code === ErrorCode.INVALID_CRASH_LOG ? 'incomplete' : 'failed',
          symbolicationError: error.message || '解析 Sentry 问题失败',
        },
      );
    }

    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: error.message || '解析 Sentry 问题失败',
    });
  }
});

router.post('/fetch-and-analyze', async (req: Request, res: Response) => {
  try {
    const defaultSentryIssueQuery = getDefaultSentryIssueQuery();
    const {
      apiKey = '',
      period = '24h',
      limit = 5,
      query = defaultSentryIssueQuery,
    } = req.body || {};

    const issues = await sentryIssueService.listNewIssues({
      period: String(period || '24h'),
      limit: Number(limit || 5),
      query: String(query || defaultSentryIssueQuery),
    });

    const results = await Promise.all(issues.map(async (issue) => {
      try {
        const event = await sentryIssueService.getLatestEvent(issue.id);
        const analysisLog = sentryIssueService.buildAnalysisLog(issue, event);
        const analysis = await aiAnalysisService.analyzeCrashLog(analysisLog, apiKey);
        return {
          issue,
          eventId: event?.id,
          analysisLog,
          analysis,
        };
      } catch (error: any) {
        logger.warn('Sentry issue AI 分析失败', {
          issueId: issue.id,
          error: error.message,
        });
        return {
          issue,
          error: error.message || 'AI 分析失败',
        };
      }
    }));
    results.forEach((result: any) => workflowIntegrationService.syncSentryIssue(
      { ...(result.issue || {}), eventId: result.eventId },
      result.analysis,
    ));

    res.json({
      success: true,
      data: {
        period,
        query,
        total: results.length,
        results,
      },
    });
  } catch (error: any) {
    logger.error('抓取 Sentry 新增崩溃失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '抓取 Sentry 新增崩溃失败',
    });
  }
});

const globalCrashGovernanceSync = globalThis as typeof globalThis & {
  __nnCrashGovernanceSyncStarted?: boolean;
};

if (
  process.env.NODE_ENV !== 'test' &&
  process.env.CRASH_GOVERNANCE_AUTO_SYNC !== 'false' &&
  !globalCrashGovernanceSync.__nnCrashGovernanceSyncStarted
) {
  globalCrashGovernanceSync.__nnCrashGovernanceSyncStarted = true;
  const intervalMs = Math.max(Number(process.env.CRASH_GOVERNANCE_SYNC_INTERVAL_MS || 10 * 60 * 1000), 60 * 1000);
  const runBackgroundSync = async () => {
    try {
      const result = await syncGovernanceIssues({
        period: process.env.CRASH_GOVERNANCE_SYNC_PERIOD || '24h',
        limit: GOVERNANCE_SYNC_LIMIT,
        query: getDefaultSentryIssueQuery(),
      });
      logger.info('Crash 治理后台同步完成', { total: result.total });
    } catch (error: any) {
      logger.warn('Crash 治理后台同步失败', { error: error.message });
    }
  };
  setTimeout(runBackgroundSync, Number(process.env.CRASH_GOVERNANCE_SYNC_DELAY_MS || 30 * 1000));
  setInterval(runBackgroundSync, intervalMs);
}

export default router;
