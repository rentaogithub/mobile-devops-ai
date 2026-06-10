import { Router, Request, Response } from 'express';
import { SymbolizerService, StorageService } from '../services';
import historyService from '../services/HistoryService';
import qwenAIService from '../services/QwenAIService';
import symbolicationCache from '../services/SymbolicationCacheService';
import { AppError, ErrorCode } from '../types';
import logger from '../utils/logger';
import { extractCrashInfo } from '../utils/crashLogParser';
import { convertIPSToCrash } from '../utils/ipsConverter';

const router = Router();

const symbolizer = new SymbolizerService();
const storage = new StorageService();

const unknownNNIMFrameRegex = /^\d+\s+NNIM\s+0x[0-9a-f]+\s+<unknown>\s+\+\s+\d+$/gim;
const unknownSystemFrameRegex = /^\d+\s+(?:libsystem_kernel\.dylib|libsystem_pthread\.dylib|libdispatch\.dylib|CoreFoundation|Foundation|UIKitCore|GraphicsServices|dyld)\s+0x[0-9a-f]+\s+<unknown>\s+\+\s+\d+$/gim;

function countMatches(log: string, regex: RegExp): number {
  return (log.match(regex) || []).length;
}

function hasValidSymbolicationResult(originalLog: string, symbolicatedLog: string): boolean {
  if (!symbolicatedLog || symbolicatedLog === originalLog) {
    return false;
  }

  // MetricKit/精简 crash 常见没有 Binary Images，旧结果会保留 NNIM <unknown> 栈。
  const originalUnknownNNIMCount = countMatches(originalLog, unknownNNIMFrameRegex);
  if (originalUnknownNNIMCount > 0) {
    const unresolvedNNIMCount = countMatches(symbolicatedLog, unknownNNIMFrameRegex);
    if (unresolvedNNIMCount >= originalUnknownNNIMCount) {
      return false;
    }
  }

  // 系统库符号文件补齐后，之前仅解析到 App/组件的历史结果也需要失效。
  const shouldValidateSystemFrames = process.env.ENABLE_SYSTEM_SYMBOLICATION === 'true';
  const originalUnknownSystemCount = shouldValidateSystemFrames
    ? countMatches(originalLog, unknownSystemFrameRegex)
    : 0;
  if (originalUnknownSystemCount > 0) {
    const unresolvedSystemCount = countMatches(symbolicatedLog, unknownSystemFrameRegex);
    if (unresolvedSystemCount >= originalUnknownSystemCount) {
      return false;
    }
  }

  return symbolicatedLog.includes('(in ') || /^\d+\s+\S+\s+0x[0-9a-f]+\s+(?!<unknown>)/gim.test(symbolicatedLog);
}

/**
 * POST /api/symbolicate
 * 符号化崩溃日志
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    let { crashLog, uuid, uuids, apiKey } = req.body;

    if (!crashLog) {
      throw new AppError(ErrorCode.INVALID_CRASH_LOG, '未提供崩溃日志', 400);
    }

    // 检测文件格式
    const trimmed = crashLog.trim();
    
    // 检查是否已经是文本格式（包含 Thread Crashed 或 Binary Images）
    const isAlreadyTextFormat = 
      crashLog.includes('Thread') && (crashLog.includes('Crashed') || crashLog.includes('Binary Images'));
    
    // 检测是否是 .ips JSON 格式
    const isIPSFormat = trimmed.startsWith('{') && !isAlreadyTextFormat;
    
    if (isIPSFormat) {
      logger.info('检测到 .ips JSON 格式，将使用 symbolicatecrash 工具处理');
      // 不在这里转换，让 SymbolizerService 使用 symbolicatecrash 处理
      // symbolicatecrash 可以直接处理 .ips JSON 格式
    } else if (isAlreadyTextFormat) {
      logger.info('检测到文本格式的崩溃日志');
    } else {
      logger.warn('未知的崩溃日志格式');
    }

    // 支持单个 UUID 或多个 UUIDs
    let targetUUIDs: string[] = [];
    if (uuids && Array.isArray(uuids) && uuids.length > 0) {
      targetUUIDs = uuids;
      logger.info('收到符号化请求（多个 dSYM）', { providedUUIDs: targetUUIDs });
    } else if (uuid) {
      targetUUIDs = [uuid];
      logger.info('收到符号化请求（单个 dSYM）', { providedUUID: uuid });
    } else {
      // 尝试从崩溃日志中提取 UUID
      try {
        const parsed = symbolizer.parseCrashLog(crashLog);
        if (parsed.uuid) {
          targetUUIDs = [parsed.uuid];
          logger.info('从崩溃日志中提取到 UUID', { uuid: parsed.uuid });
        } else {
          logger.warn('无法从崩溃日志中提取 UUID');
          throw new AppError(
            ErrorCode.UUID_NOT_FOUND,
            '无法从崩溃日志中提取 UUID。这可能是第三方平台的崩溃日志，请在前端手动选择对应的 dSYM 文件。',
            400
          );
        }
      } catch (error) {
        logger.warn('解析崩溃日志失败，无法提取 UUID');
        throw new AppError(
          ErrorCode.UUID_NOT_FOUND,
          '无法从崩溃日志中提取 UUID。请在前端手动选择对应的 dSYM 文件。',
          400
        );
      }
    }

    // 先检查历史记录（持久化存储）
    logger.info('检查历史记录', { 
      crashLogLength: crashLog.length,
      targetUUIDs
    });
    
    const historyRecord = historyService.findDuplicateHistory(crashLog, targetUUIDs);
    // 检查历史记录是否有效，避免修复后仍返回旧的 NNIM <unknown> 结果。
    const isHistoryValid = historyRecord &&
      hasValidSymbolicationResult(crashLog, historyRecord.symbolicatedLog);
    
    if (historyRecord && isHistoryValid) {
      logger.info('✓ 从历史记录中找到相同的崩溃日志', { 
        historyId: historyRecord.id,
        appVersion: historyRecord.appVersion,
        hasAIAnalysis: !!historyRecord.aiAnalysis,
        fromHistory: true
      });

      // 直接返回历史记录中的结果
      res.json({
        success: true,
        data: {
          originalLog: crashLog,
          symbolicatedLog: historyRecord.symbolicatedLog,
          matchedUUIDs: targetUUIDs,
          fromHistory: true,
          aiAnalysis: historyRecord.aiAnalysis,
          historyId: historyRecord.id, // 返回历史记录ID
        },
      });
      return;
    }

    // 检查缓存（内存存储）
    logger.info('检查符号化缓存', { 
      crashLogLength: crashLog.length,
      targetUUIDs,
      cacheStats: symbolicationCache.getStats()
    });
    
    const cached = symbolicationCache.get(crashLog, targetUUIDs);
    if (cached && hasValidSymbolicationResult(crashLog, cached.symbolicatedLog)) {
      logger.info('✓ 使用缓存的符号化结果（快速返回）', { 
        uuids: cached.matchedUUIDs,
        fromCache: true,
        hasAIAnalysis: !!cached.aiAnalysis
      });

      // 先尝试查找是否已有历史记录
      const existingHistory = historyService.findDuplicateHistory(crashLog, targetUUIDs);
      
      if (existingHistory) {
        // 如果已有历史记录，直接返回带 historyId 的结果
        res.json({
          success: true,
          data: {
            originalLog: crashLog,
            symbolicatedLog: cached.symbolicatedLog,
            matchedUUIDs: cached.matchedUUIDs,
            warning: cached.warning,
            fromCache: true,
            aiAnalysis: cached.aiAnalysis,
            historyId: existingHistory.id, // 返回历史记录ID
          },
        });
      } else {
        // 如果没有历史记录，先保存再返回
        try {
          // 使用缓存中的版本号，如果没有则查找
          let appVersion = cached.appVersion || 'Unknown';
          
          if (!cached.appVersion) {
            const dsymInfo = await storage.findByUUID(targetUUIDs[0]);
            if (dsymInfo) {
              appVersion = dsymInfo.version;
            }
          }

          // 检查版本是否被检测到
          const { extractVersionFromCrashLog } = await import('../utils/versionExtractor');
          const extractedVersion = extractVersionFromCrashLog(crashLog);
          const versionDetected = extractedVersion === appVersion;

          // 提取崩溃信息
          const crashInfo = extractCrashInfo(crashLog, cached.symbolicatedLog);

          // 保存历史记录
          const savedRecord = await historyService.saveHistory({
            appVersion,
            versionDetected,
            crashType: crashInfo.crashType,
            crashReason: crashInfo.crashReason,
            lastStackCall: crashInfo.lastStackCall,
            crashModule: crashInfo.crashModule,
            crashLocation: crashInfo.crashLocation,
            originalLog: crashLog,
            symbolicatedLog: cached.symbolicatedLog,
            usedUuids: targetUUIDs,
            aiAnalysis: cached.aiAnalysis,
          });
          
          logger.info('符号化历史记录已保存（来自缓存）', { 
            historyId: savedRecord.id,
            appVersion, 
            uuids: targetUUIDs
          });

          // 返回带 historyId 的结果
          res.json({
            success: true,
            data: {
              originalLog: crashLog,
              symbolicatedLog: cached.symbolicatedLog,
              matchedUUIDs: cached.matchedUUIDs,
              warning: cached.warning,
              fromCache: true,
              aiAnalysis: cached.aiAnalysis,
              historyId: savedRecord.id, // 返回历史记录ID
            },
          });
        } catch (error: any) {
          logger.error('保存符号化历史记录失败', { error: error.message });
          // 即使保存失败，也返回缓存结果（不包含 historyId）
          res.json({
            success: true,
            data: {
              originalLog: crashLog,
              symbolicatedLog: cached.symbolicatedLog,
              matchedUUIDs: cached.matchedUUIDs,
              warning: cached.warning,
              fromCache: true,
              aiAnalysis: cached.aiAnalysis,
            },
          });
        }
      }

      return;
    } else if (cached) {
      logger.warn('忽略无效符号化缓存，重新执行符号化', {
        targetUUIDs,
        crashLogLength: crashLog.length,
      });
    }
    
    logger.info('✗ 缓存未命中，执行符号化', { targetUUIDs });

    // 查找所有匹配的 dSYM
    const dsymInfos = [];
    for (const targetUUID of targetUUIDs) {
      const dsymInfo = await storage.findByUUID(targetUUID);
      if (!dsymInfo) {
        logger.warn('未找到匹配的 dSYM', { uuid: targetUUID });
        throw new AppError(
          ErrorCode.DSYM_NOT_FOUND,
          `未找到 UUID 为 ${targetUUID} 的 dSYM 文件，请先上传对应的 dSYM`,
          404
        );
      }
      dsymInfos.push(dsymInfo);
      logger.info('找到匹配的 dSYM', {
        uuid: targetUUID,
        appName: dsymInfo.appName,
        version: dsymInfo.version,
      });
    }

    // 执行符号化（支持多个 dSYM）
    const dsymPaths = dsymInfos.map((info) => info.filePath);
    const result = await symbolizer.symbolicateWithMultipleDSYMs(crashLog, dsymPaths);

    // 获取主应用版本
    let appVersion = 'Unknown';
    const mainApp = dsymInfos.find((info) => info.appName.toUpperCase() === 'NNIM');
    if (mainApp) {
      appVersion = mainApp.version;
    } else if (dsymInfos.length > 0) {
      appVersion = dsymInfos[0].version;
    }

    // 检查版本是否被检测到
    const { extractVersionFromCrashLog } = await import('../utils/versionExtractor');
    const extractedVersion = extractVersionFromCrashLog(crashLog);
    const versionDetected = extractedVersion === appVersion;

    // 提取崩溃信息
    const crashInfo = extractCrashInfo(crashLog, result.symbolicatedLog);

    // 保存符号化历史记录
    let aiAnalysis = undefined;
    let historyId: number | undefined = undefined;
    try {
      const savedRecord = await historyService.saveHistory({
        appVersion,
        versionDetected,
        crashType: crashInfo.crashType,
        crashReason: crashInfo.crashReason,
        lastStackCall: crashInfo.lastStackCall,
        crashModule: crashInfo.crashModule,
        crashLocation: crashInfo.crashLocation,
        originalLog: crashLog,
        symbolicatedLog: result.symbolicatedLog,
        usedUuids: targetUUIDs,
      });
      
      // 如果是重复记录且有AI分析结果，保存下来
      aiAnalysis = savedRecord.aiAnalysis;
      historyId = savedRecord.id; // 保存历史记录ID
      
      logger.info('符号化历史记录已保存', { 
        historyId,
        appVersion, 
        uuids: targetUUIDs,
        crashType: crashInfo.crashType,
        lastStackCall: crashInfo.lastStackCall,
        crashModule: crashInfo.crashModule,
        hasAIAnalysis: !!aiAnalysis
      });
    } catch (error: any) {
      logger.error('保存符号化历史记录失败', { error: error.message });
      // 不影响符号化结果的返回
    }

    // 保存到缓存（包含版本号和AI分析）
    logger.info('保存符号化结果到缓存', { 
      crashLogLength: crashLog.length,
      targetUUIDs,
      appVersion,
      hasAIAnalysis: !!aiAnalysis
    });
    symbolicationCache.set(
      crashLog,
      targetUUIDs,
      result.symbolicatedLog,
      result.warning,
      appVersion,
      aiAnalysis
    );

    res.json({
      success: true,
      data: {
        originalLog: crashLog,
        symbolicatedLog: result.symbolicatedLog,
        matchedUUIDs: targetUUIDs,
        warning: result.warning,
        aiAnalysis, // 包含AI分析结果（如果有的话）
        historyId, // 返回历史记录ID
      },
    });
  } catch (error: any) {
    logger.error('符号化失败', { error: error.message });

    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: '符号化失败',
      });
    }
  }
});

/**
 * POST /api/symbolicate/download
 * 下载符号化报告（ZIP格式，包含符号化日志和AI分析PDF）
 */
router.post('/download', async (req: Request, res: Response) => {
  try {
    const { symbolicatedLog, analysis, appVersion } = req.body;

    if (!symbolicatedLog) {
      throw new AppError(ErrorCode.INVALID_CRASH_LOG, '未提供符号化日志', 400);
    }

    logger.info('生成符号化报告下载', { 
      appVersion: appVersion || 'unknown',
      hasAIAnalysis: !!analysis
    });

    // 动态导入 ReportGeneratorService
    const { default: reportGenerator } = await import('../services/ReportGeneratorService');

    // 生成ZIP文件
    const zipBuffer = await reportGenerator.generateReportZip(
      symbolicatedLog,
      analysis,
      appVersion || 'unknown'
    );

    // 设置响应头
    const fileName = `crash_report_${appVersion || 'unknown'}_${Date.now()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', zipBuffer.length);

    // 发送文件
    res.send(zipBuffer);

    logger.info('符号化报告下载成功', { 
      fileName,
      size: zipBuffer.length
    });
  } catch (error: any) {
    logger.error('生成符号化报告失败', { error: error.message });

    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: '生成报告失败',
      });
    }
  }
});

/**
 * POST /api/symbolicate/analyze
 * AI 分析符号化后的崩溃日志
 */
router.post('/analyze', async (req: Request, res: Response) => {
  try {
    const { symbolicatedLog, uuids, apiKey } = req.body;

    if (!symbolicatedLog) {
      throw new AppError(ErrorCode.INVALID_CRASH_LOG, '未提供符号化后的崩溃日志', 400);
    }

    if (!apiKey || apiKey.trim().length === 0) {
      throw new AppError(ErrorCode.INVALID_CRASH_LOG, '未提供 API Key', 400);
    }

    logger.info('收到 AI 分析请求');

    // 查找主应用的 dSYM 以获取版本号
    let mainAppVersion: string | undefined;
    if (uuids && Array.isArray(uuids) && uuids.length > 0) {
      logger.info('查找主应用版本号', { uuids });
      
      for (const uuid of uuids) {
        const dsymInfo = await storage.findByUUID(uuid);
        logger.info('找到 dSYM', { 
          uuid, 
          appName: dsymInfo?.appName, 
          version: dsymInfo?.version 
        });
        
        if (dsymInfo && dsymInfo.appName.toUpperCase() === 'NNIM') {
          mainAppVersion = dsymInfo.version;
          logger.info('找到主应用 NNIM 的版本', { version: mainAppVersion });
          break;
        }
      }
      
      // 如果没有找到 NNIM，使用第一个
      if (!mainAppVersion && uuids.length > 0) {
        const dsymInfo = await storage.findByUUID(uuids[0]);
        if (dsymInfo) {
          mainAppVersion = dsymInfo.version;
          logger.info('使用第一个 dSYM 的版本', { 
            appName: dsymInfo.appName, 
            version: mainAppVersion 
          });
        }
      }
    }
    
    logger.info('最终使用的应用版本', { mainAppVersion });

    // 执行 AI 分析
    const analysis = await qwenAIService.analyzeCrashLog(
      symbolicatedLog,
      apiKey,
      mainAppVersion
    );

    logger.info('AI 分析完成', {
      crashType: analysis.crashType,
      severity: analysis.severity,
      appVersion: analysis.appVersion,
    });

    // 尝试更新最近的历史记录，添加 AI 分析结果
    if (mainAppVersion && uuids && uuids.length > 0) {
      try {
        // 查找最近的匹配记录
        const recentRecords = historyService.getHistoryByVersion(mainAppVersion);
        if (recentRecords.length > 0) {
          // 找到最近的一条记录
          const latestRecord = recentRecords[0];
          // 检查 UUID 是否匹配
          const recordUuids = latestRecord.usedUuids;
          const isMatch = uuids.every((uuid: string) => recordUuids.includes(uuid));
          
          if (isMatch) {
            // 更新这条记录，添加 AI 分析结果
            await historyService.updateAIAnalysis(latestRecord.id, analysis);
            logger.info('已更新历史记录的 AI 分析结果', { 
              recordId: latestRecord.id,
              appVersion: mainAppVersion 
            });
          }
        }
      } catch (error: any) {
        logger.error('更新历史记录的 AI 分析失败', { error: error.message });
        // 不影响 AI 分析结果的返回
      }
    }

    res.json({
      success: true,
      data: analysis,
    });
  } catch (error: any) {
    logger.error('AI 分析失败', { error: error.message });

    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message || 'AI 分析失败',
      });
    }
  }
});

export default router;

/**
 * POST /api/symbolicate/clear-cache
 * 清除符号化缓存
 */
router.post('/clear-cache', async (req: Request, res: Response) => {
  try {
    symbolicationCache.clear();
    logger.info('符号化缓存已清除');
    
    res.json({
      success: true,
      message: '缓存已清除',
    });
  } catch (error: any) {
    logger.error('清除缓存失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: '清除缓存失败',
    });
  }
});
