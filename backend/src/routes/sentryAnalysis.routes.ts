import { Router, Request, Response } from 'express';
import sentryIssueService from '../services/SentryIssueService';
import aiAnalysisService from '../services/AIAnalysisService';
import { StorageService, SymbolizerService } from '../services';
import historyService from '../services/HistoryService';
import { AppError, DSYMInfo, ErrorCode } from '../types';
import { extractCrashInfo } from '../utils/crashLogParser';
import { extractVersionFromCrashLog } from '../utils/versionExtractor';
import { getDatabase } from '../database';
import logger from '../utils/logger';
import { workflowIntegrationService } from '../services/WorkflowIntegrationService';
import fs from 'fs';
import path from 'path';

const router = Router();
const storage = new StorageService();
const symbolizer = new SymbolizerService();
const excludedSentryAppVersions = new Set(
  (process.env.SENTRY_EXCLUDED_APP_VERSIONS || '10.0.0')
    .split(',')
    .map((version) => version.trim())
    .filter(Boolean)
);
const defaultSentryIssueQuery = `is:unresolved ${Array.from(excludedSentryAppVersions)
  .map((version) => `!release:"${version.replace(/"/g, '\\"')}"`)
  .join(' ')}`.trim();

interface SymbolicationAttemptDetail {
  appVersion: string;
  error: string;
}

function ensureSentryIssueHistoryTable() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sentry_issue_symbolication_history (
      issue_id TEXT PRIMARY KEY,
      short_id TEXT,
      history_id INTEGER NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sentry_issue_history_short_id
      ON sentry_issue_symbolication_history(short_id);
  `);
}

function upsertSentryIssueHistory(issue: any, historyId?: number) {
  const issueId = String(issue?.id || '').trim();
  if (!issueId || !historyId) {
    return;
  }

  ensureSentryIssueHistoryTable();
  getDatabase().prepare(`
    INSERT INTO sentry_issue_symbolication_history (issue_id, short_id, history_id, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(issue_id) DO UPDATE SET
      short_id = excluded.short_id,
      history_id = excluded.history_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(issueId, issue?.shortId || null, historyId);
}

function getSentryIssueHistoryMap(issues: any[]) {
  ensureSentryIssueHistoryTable();
  const db = getDatabase();
  const lookup = db.prepare(`
    SELECT
      h.history_id,
      sh.app_version
    FROM sentry_issue_symbolication_history h
    INNER JOIN symbolication_history sh ON sh.id = h.history_id
    WHERE h.issue_id = ? OR h.short_id = ?
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
    const row = lookup.get(issueId, shortId) as { history_id?: number; app_version?: string } | undefined;
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
  const rawVersions = [
    requestedAppVersion,
    extractedVersion,
    issue?.maxAppVersion,
    issue?.minAppVersion,
    ...(Array.isArray(issue?.appVersions) ? issue.appVersions : []),
    ...(typeof issue?.appVersionRange === 'string' ? issue.appVersionRange.split(' - ') : []),
  ];

  return Array.from(new Set(rawVersions
    .map(normalizeAppVersion)
    .filter((version) => version && !excludedSentryAppVersions.has(version))))
    .sort((a, b) => compareVersions(b, a));
}

async function findDSYMsForAppVersion(appVersion: string): Promise<DSYMInfo[]> {
  const allDSYMs = await storage.getAllDSYMs();
  const exactMainApps = allDSYMs.filter((dsym) =>
    dsym.appName.toUpperCase() === 'NNIM' && dsym.version === appVersion
  );
  const relatedComponents = allDSYMs.filter((dsym) =>
    dsym.appName.toUpperCase() !== 'NNIM' &&
    Array.isArray(dsym.relatedAppVersions) &&
    dsym.relatedAppVersions.includes(appVersion)
  );

  const candidates = exactMainApps.length > 0 || relatedComponents.length > 0
    ? [...exactMainApps, ...relatedComponents]
    : allDSYMs.filter((dsym) => dsym.version === appVersion);

  const unique = new Map<string, DSYMInfo>();
  candidates.forEach((dsym) => unique.set(dsym.uuid, dsym));
  return Array.from(unique.values());
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
  if (hasDWARFFile(dsym.filePath)) {
    return dsym.filePath;
  }

  const dsymDir = process.env.DSYM_DIR || path.resolve(process.cwd(), '..', 'nn-ios-platform-data', 'dsyms');
  const dsymName = path.basename(dsym.filePath || `${dsym.appName}.dSYM`);
  const candidates = [
    path.join(dsymDir, dsym.uuid, dsymName),
    path.join(dsymDir, dsym.uuid, `${dsym.appName}.dSYM`),
    path.join(dsymDir, dsym.uuid, `${dsym.appName}.app.dSYM`),
  ];
  const resolved = candidates.find((candidate) => hasDWARFFile(candidate));
  if (resolved) {
    logger.warn('修正 dSYM 旧路径', {
      appName: dsym.appName,
      uuid: dsym.uuid,
      oldPath: dsym.filePath,
      resolvedPath: resolved,
    });
    return resolved;
  }

  return dsym.filePath;
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
  const normalizedCrashLog = normalizeUUID(crashLog);
  const filtered = dsymInfos.filter((dsym) => {
    const resolvedFilePath = resolveDSYMFilePath(dsym);
    const appName = dsym.appName;
    const isMainApp = appName.toUpperCase() === 'NNIM';
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

    if (isMainApp || uuidMatches || nameMatches) {
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

async function symbolicateAndSaveSentryIssue(issue: any, requestedAppVersion = '') {
  if (!issue?.id) {
    throw new AppError(ErrorCode.INVALID_CRASH_LOG, '请选择要解析的 Sentry 问题', 400);
  }

  const normalizedIssue = sentryIssueService.normalizeIssueSummary(issue);
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
      let existingHistory =
        historyService.findDuplicateHistory(crashLog, targetUUIDs) ||
        historyService.findDuplicateByOriginalLog(crashLog, appVersion) ||
        historyService.findDuplicateByOriginalLog(crashLog);

      if (existingHistory) {
        if (isHistoryMissingTargetUUIDs(existingHistory.usedUuids, targetUUIDs)) {
          logger.info('Sentry 自动符号化命中旧历史，刷新缺失 dSYM 的符号化结果', {
            issueId: normalizedIssue.id,
            historyId: existingHistory.id,
            existingUUIDs: existingHistory.usedUuids,
            targetUUIDs,
          });

          const symbolicated = await symbolizer.symbolicateWithMultipleDSYMs(crashLog, dsymPaths);
          const crashInfo = extractCrashInfo(crashLog, symbolicated.symbolicatedLog);
          const versionDetected = extractedVersion === appVersion || normalizedIssue.appVersions?.includes(appVersion);

          existingHistory = await historyService.updateSymbolicationResult(existingHistory.id, {
            appVersion,
            versionDetected,
            crashType: crashInfo.crashType,
            crashReason: crashInfo.crashReason,
            lastStackCall: crashInfo.lastStackCall,
            crashModule: crashInfo.crashModule,
            crashLocation: crashInfo.crashLocation,
            originalLog: crashLog,
            symbolicatedLog: symbolicated.symbolicatedLog,
            usedUuids: targetUUIDs,
            aiAnalysis: undefined,
          });
        }

        upsertSentryIssueHistory(normalizedIssue, existingHistory.id);
        return {
          issue: normalizedIssue,
          eventId: event?.id,
          incidentIdentifier: originalCrashFile.incidentIdentifier,
          appVersion: existingHistory.appVersion || appVersion,
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
      const versionDetected = extractedVersion === appVersion || normalizedIssue.appVersions?.includes(appVersion);
      const savedRecord = await historyService.saveHistory({
        appVersion,
        versionDetected,
        crashType: crashInfo.crashType,
        crashReason: crashInfo.crashReason,
        lastStackCall: crashInfo.lastStackCall,
        crashModule: crashInfo.crashModule,
        crashLocation: crashInfo.crashLocation,
        originalLog: crashLog,
        symbolicatedLog: symbolicated.symbolicatedLog,
        usedUuids: targetUUIDs,
      });

      upsertSentryIssueHistory(normalizedIssue, savedRecord.id);
      return {
        issue: normalizedIssue,
        eventId: event?.id,
        incidentIdentifier: originalCrashFile.incidentIdentifier,
        appVersion,
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

router.post('/issues', async (req: Request, res: Response) => {
  try {
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
    const appVersion = normalizeAppVersion(requestedAppVersion) || getHighestIssueVersion(normalizedIssue);
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

    const event = await sentryIssueService.getLatestEvent(normalizedIssue.id);
    const originalCrashFile = sentryIssueService.buildOriginalCrashFile(normalizedIssue, event);
    const crashLog = originalCrashFile.crashLog;
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
    let existingHistory =
      historyService.findDuplicateHistory(crashLog, targetUUIDs) ||
      historyService.findDuplicateByOriginalLog(crashLog, appVersion);

    if (existingHistory) {
      if (isHistoryMissingTargetUUIDs(existingHistory.usedUuids, targetUUIDs)) {
        logger.info('Sentry 历史记录缺少当前可用 dSYM，刷新符号化结果', {
          issueId: normalizedIssue.id,
          historyId: existingHistory.id,
          existingUUIDs: existingHistory.usedUuids,
          targetUUIDs,
        });

        const symbolicated = await symbolizer.symbolicateWithMultipleDSYMs(crashLog, dsymPaths);
        const crashInfo = extractCrashInfo(crashLog, symbolicated.symbolicatedLog);
        const extractedVersion = extractVersionFromCrashLog(crashLog);
        const versionDetected = extractedVersion === appVersion || normalizedIssue.appVersions?.includes(appVersion);

        existingHistory = await historyService.updateSymbolicationResult(existingHistory.id, {
          appVersion,
          versionDetected,
          crashType: crashInfo.crashType,
          crashReason: crashInfo.crashReason,
          lastStackCall: crashInfo.lastStackCall,
          crashModule: crashInfo.crashModule,
          crashLocation: crashInfo.crashLocation,
          originalLog: crashLog,
          symbolicatedLog: symbolicated.symbolicatedLog,
          usedUuids: targetUUIDs,
          aiAnalysis: undefined,
        });
      }

      logger.info('Sentry 问题已解析过，直接返回历史记录', {
        issueId: normalizedIssue.id,
        appVersion,
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
              existingHistory.appVersion || appVersion
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
        { ...normalizedIssue, eventId: event?.id, appVersion: existingHistory.appVersion || appVersion },
        aiAnalysis,
      );

      res.json({
        success: true,
        data: {
          issue: normalizedIssue,
          eventId: event?.id,
          incidentIdentifier: originalCrashFile.incidentIdentifier,
          appVersion: existingHistory.appVersion || appVersion,
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
    const extractedVersion = extractVersionFromCrashLog(crashLog);
    const versionDetected = extractedVersion === appVersion || normalizedIssue.appVersions?.includes(appVersion);

    let aiAnalysis: any = undefined;
    let aiError: string | undefined = undefined;
    if (aiAnalysisService.hasConfiguredAPIKey(apiKey)) {
      try {
        aiAnalysis = await aiAnalysisService.analyzeCrashLog(
          symbolicated.symbolicatedLog,
          apiKey,
          appVersion
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
      appVersion,
      versionDetected,
      crashType: crashInfo.crashType,
      crashReason: crashInfo.crashReason,
      lastStackCall: crashInfo.lastStackCall,
      crashModule: crashInfo.crashModule,
      crashLocation: crashInfo.crashLocation,
      originalLog: crashLog,
      symbolicatedLog: symbolicated.symbolicatedLog,
      usedUuids: targetUUIDs,
      aiAnalysis,
    });

    logger.info('Sentry 问题解析完成', {
      issueId: normalizedIssue.id,
      appVersion,
      historyId: savedRecord.id,
      hasAIAnalysis: !!aiAnalysis,
    });
    workflowIntegrationService.syncSentryIssue(
      { ...normalizedIssue, eventId: event?.id, appVersion },
      aiAnalysis,
    );

    res.json({
      success: true,
      data: {
        issue: normalizedIssue,
        eventId: event?.id,
        incidentIdentifier: originalCrashFile.incidentIdentifier,
        appVersion,
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

export default router;
