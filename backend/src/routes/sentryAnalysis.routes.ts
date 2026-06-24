import { Router, Request, Response } from 'express';
import sentryIssueService from '../services/SentryIssueService';
import aiAnalysisService from '../services/AIAnalysisService';
import { StorageService, SymbolizerService } from '../services';
import historyService from '../services/HistoryService';
import { AppError, DSYMInfo, ErrorCode } from '../types';
import { extractCrashInfo } from '../utils/crashLogParser';
import { extractVersionFromCrashLog } from '../utils/versionExtractor';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';

const router = Router();
const storage = new StorageService();
const symbolizer = new SymbolizerService();

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
    .filter(Boolean);

  return versions.sort(compareVersions).pop() || '';
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
    const appName = dsym.appName;
    const isMainApp = appName.toUpperCase() === 'NNIM';
    const uuidMatches = normalizedCrashLog.includes(normalizeUUID(dsym.uuid));
    const nameMatches = crashBinaryNames.has(appName);
    const hasDWARF = hasDWARFFile(dsym.filePath);

    if (!hasDWARF) {
      logger.warn('跳过缺少 DWARF 的 Sentry dSYM', {
        appName,
        uuid: dsym.uuid,
        filePath: dsym.filePath,
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
  });

  return filtered.length > 0 ? filtered : dsymInfos.filter((dsym) => hasDWARFFile(dsym.filePath));
}

router.post('/issues', async (req: Request, res: Response) => {
  try {
    const {
      period = '24h',
      limit = 10,
      query = 'is:unresolved',
    } = req.body || {};

    const issues = await sentryIssueService.listNewIssues({
      period: String(period || '24h'),
      limit: Number(limit || 10),
      query: String(query || 'is:unresolved'),
    });

    res.json({
      success: true,
      data: {
        period,
        query,
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
    const existingHistory =
      historyService.findDuplicateHistory(crashLog, targetUUIDs) ||
      historyService.findDuplicateByOriginalLog(crashLog, appVersion);

    if (existingHistory) {
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
      query = 'is:unresolved',
    } = req.body || {};

    const issues = await sentryIssueService.listNewIssues({
      period: String(period || '24h'),
      limit: Number(limit || 5),
      query: String(query || 'is:unresolved'),
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
