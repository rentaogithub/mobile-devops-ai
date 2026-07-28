import { getDatabase } from '../database';
import logger from '../utils/logger';

export interface SymbolicationHistoryRecord {
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
  aiAnalysis?: any;
  isFixed: boolean;
  fixedVersion?: string;
  createdAt: string;
}

export interface SaveHistoryParams {
  appVersion: string;
  versionDetected?: boolean;
  crashType?: string;
  crashReason?: string;
  originalLog: string;
  symbolicatedLog: string;
  usedUuids: string[];
  aiAnalysis?: any;
  lastStackCall?: string;
  crashModule?: string;
  crashLocation?: string;
  crashModuleUuid?: string;
  blockerThreadId?: string;
}

export class HistoryService {
  /**
   * 检查是否存在相同的历史记录（基于原始日志的哈希值）
   */
  private calculateLogHash(originalLog: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(originalLog).digest('hex');
  }

  /**
   * 查找相同的历史记录
   */
  findDuplicateHistory(originalLog: string, usedUuids: string[]): SymbolicationHistoryRecord | null {
    const db = getDatabase();

    try {
      // 查找最近24小时内的记录，避免全表扫描
      const stmt = db.prepare(`
        SELECT * FROM symbolication_history 
        WHERE datetime(created_at) > datetime('now', '-24 hours')
        ORDER BY created_at DESC
        LIMIT 100
      `);

      const rows = stmt.all() as any[];
      
      // 在内存中比较原始日志和UUID
      for (const row of rows) {
        if (row.original_log === originalLog) {
          const recordUuids = JSON.parse(row.used_uuids);
          // 检查UUID是否完全匹配（顺序无关）
          const uuidsMatch = 
            recordUuids.length === usedUuids.length &&
            recordUuids.every((uuid: string) => usedUuids.includes(uuid));
          
          if (uuidsMatch) {
            logger.info('找到重复的历史记录', { 
              id: row.id,
              appVersion: row.app_version 
            });
            return this.mapRowToRecord(row);
          }
        }
      }

      return null;
    } catch (error: any) {
      logger.error('查找重复历史记录失败', { error: error.message });
      return null;
    }
  }

  /**
   * 仅按原始日志查找历史记录。用于 Sentry 事件这类稳定来源：
   * dSYM 选择策略调整后 UUID 集合可能变化，但同一份原始崩溃不应重复解析。
   */
  findDuplicateByOriginalLog(originalLog: string, appVersion?: string): SymbolicationHistoryRecord | null {
    const db = getDatabase();

    try {
      const rows = appVersion
        ? db.prepare(`
            SELECT * FROM symbolication_history
            WHERE app_version = ?
            ORDER BY created_at DESC
            LIMIT 500
          `).all(appVersion) as any[]
        : db.prepare(`
            SELECT * FROM symbolication_history
            ORDER BY created_at DESC
            LIMIT 1000
          `).all() as any[];

      const row = rows.find((record) => record.original_log === originalLog);
      if (!row) {
        return null;
      }

      logger.info('按原始日志找到重复历史记录', {
        id: row.id,
        appVersion: row.app_version,
      });
      return this.mapRowToRecord(row);
    } catch (error: any) {
      logger.error('按原始日志查找重复历史记录失败', { error: error.message });
      return null;
    }
  }

  /**
   * 保存符号化历史记录（如果不存在重复记录）
   */
  async saveHistory(params: SaveHistoryParams): Promise<SymbolicationHistoryRecord> {
    const db = getDatabase();
    const normalizedParams = this.resolveCrashModuleFromDSYM(params);

    try {
      // 检查是否存在重复记录
      const duplicate = this.findDuplicateHistory(normalizedParams.originalLog, normalizedParams.usedUuids);
      if (duplicate) {
        if (this.shouldRefreshDuplicateHistory(duplicate, normalizedParams)) {
          const updateStmt = db.prepare(`
            UPDATE symbolication_history
            SET app_version = ?,
                version_detected = ?,
                crash_type = ?,
                crash_reason = ?,
                last_stack_call = ?,
                crash_module = ?,
                crash_location = ?,
                symbolicated_log = ?,
                used_uuids = ?,
                ai_analysis = ?
            WHERE id = ?
          `);

          updateStmt.run(
            normalizedParams.appVersion,
            normalizedParams.versionDetected !== false ? 1 : 0,
            normalizedParams.crashType || null,
            normalizedParams.crashReason || null,
            normalizedParams.lastStackCall || null,
            normalizedParams.crashModule || null,
            normalizedParams.crashLocation || null,
            normalizedParams.symbolicatedLog,
            JSON.stringify(normalizedParams.usedUuids),
            normalizedParams.aiAnalysis ? JSON.stringify(normalizedParams.aiAnalysis) : null,
            duplicate.id
          );

          logger.info('刷新重复历史记录的符号化结果', {
            existingId: duplicate.id,
            appVersion: normalizedParams.appVersion,
          });
          return this.getHistoryById(duplicate.id);
        }

        logger.info('跳过保存重复的历史记录', {
          existingId: duplicate.id,
          appVersion: duplicate.appVersion,
        });
        return duplicate;
      }

      const stmt = db.prepare(`
        INSERT INTO symbolication_history (
          app_version, version_detected, crash_type, crash_reason, last_stack_call, crash_module, crash_location,
          original_log, symbolicated_log, used_uuids, ai_analysis
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        normalizedParams.appVersion,
        normalizedParams.versionDetected !== false ? 1 : 0,
        normalizedParams.crashType || null,
        normalizedParams.crashReason || null,
        normalizedParams.lastStackCall || null,
        normalizedParams.crashModule || null,
        normalizedParams.crashLocation || null,
        normalizedParams.originalLog,
        normalizedParams.symbolicatedLog,
        JSON.stringify(normalizedParams.usedUuids),
        normalizedParams.aiAnalysis ? JSON.stringify(normalizedParams.aiAnalysis) : null
      );

      logger.info('符号化历史记录已保存', {
        id: result.lastInsertRowid,
        appVersion: normalizedParams.appVersion,
      });

      // 返回保存的记录
      return this.getHistoryById(result.lastInsertRowid as number);
    } catch (error: any) {
      logger.error('保存符号化历史记录失败', { error: error.message });
      throw error;
    }
  }

  private shouldRefreshDuplicateHistory(
    duplicate: SymbolicationHistoryRecord,
    params: SaveHistoryParams
  ): boolean {
    const duplicateModule = (duplicate.crashModule || '').trim();
    const nextModule = (params.crashModule || '').trim();
    if (nextModule && nextModule !== duplicateModule && this.shouldReplaceCrashModule(duplicateModule)) {
      return true;
    }

    if (!params.symbolicatedLog || params.symbolicatedLog === duplicate.symbolicatedLog) {
      return false;
    }

    if (duplicate.symbolicatedLog === duplicate.originalLog && params.symbolicatedLog !== params.originalLog) {
      return true;
    }

    const oldUnknownNNIMCount = this.countUnknownNNIMFrames(duplicate.symbolicatedLog);
    const newUnknownNNIMCount = this.countUnknownNNIMFrames(params.symbolicatedLog);
    if (oldUnknownNNIMCount > 0 && newUnknownNNIMCount < oldUnknownNNIMCount) {
      return true;
    }

    const oldUnknownSystemCount = this.countUnknownSystemFrames(duplicate.symbolicatedLog);
    const newUnknownSystemCount = this.countUnknownSystemFrames(params.symbolicatedLog);
    return oldUnknownSystemCount > 0 && newUnknownSystemCount < oldUnknownSystemCount;
  }

  private countUnknownNNIMFrames(log: string): number {
    const unknownCount = (log.match(/^\d+\s+NNIM\s+0x[0-9a-f]+\s+<unknown>\s+\+\s+\d+$/gim) || []).length;
    const addressOnlyCount = (log.match(/^\d+\s+NNIM\s+0x[0-9a-f]+\s+0x[0-9a-f]+\s+\(in NNIM\)(?:\s+\+\s+\d+)?$/gim) || []).length;
    return unknownCount + addressOnlyCount;
  }

  private countUnknownSystemFrames(log: string): number {
    return (log.match(/^\d+\s+(?:libsystem_kernel\.dylib|libsystem_pthread\.dylib|libdispatch\.dylib|CoreFoundation|Foundation|UIKitCore|GraphicsServices|dyld)\s+0x[0-9a-f]+\s+<unknown>\s+\+\s+\d+$/gim) || []).length;
  }

  private resolveCrashModuleFromDSYM(params: SaveHistoryParams): SaveHistoryParams {
    const uuid = this.extractModuleUUID(params);
    if (!uuid) {
      return params;
    }

    try {
      const dsym = getDatabase().prepare(`
        SELECT app_name
        FROM dsym_info
        WHERE uuid = ?
        ORDER BY upload_time DESC
        LIMIT 1
      `).get(uuid) as { app_name?: string } | undefined;

      const appName = dsym?.app_name?.trim();
      if (!appName) {
        return params;
      }

      const location = params.crashLocation && !/^blocked by thread /i.test(params.crashLocation)
        ? params.crashLocation
        : undefined;

      return {
        ...params,
        crashModule: location ? `${appName} - ${location}` : appName,
      };
    } catch (error: any) {
      logger.warn('根据 dSYM UUID 修正崩溃模块失败', {
        uuid,
        error: error.message,
      });
      return params;
    }
  }

  private extractModuleUUID(params: SaveHistoryParams): string | undefined {
    const explicitUUID = params.crashModuleUuid?.trim();
    if (explicitUUID) {
      return explicitUUID.toUpperCase();
    }

    const moduleUUID = params.crashModule?.match(/^UUID:([0-9A-F-]{36})$/i)?.[1];
    if (moduleUUID) {
      return moduleUUID.toUpperCase();
    }

    return undefined;
  }

  private shouldReplaceCrashModule(currentModule: string): boolean {
    if (!currentModule || /^UUID:[0-9A-F-]{36}$/i.test(currentModule)) {
      return true;
    }

    return currentModule === '<unknown>' || currentModule.toLowerCase() === 'unknown';
  }

  async updateSymbolicationResult(id: number, params: SaveHistoryParams): Promise<SymbolicationHistoryRecord> {
    const db = getDatabase();
    const normalizedParams = this.resolveCrashModuleFromDSYM(params);

    try {
      const stmt = db.prepare(`
        UPDATE symbolication_history
        SET app_version = ?,
            version_detected = ?,
            crash_type = ?,
            crash_reason = ?,
            last_stack_call = ?,
            crash_module = ?,
            crash_location = ?,
            symbolicated_log = ?,
            used_uuids = ?,
            ai_analysis = ?
        WHERE id = ?
      `);

      stmt.run(
        normalizedParams.appVersion,
        normalizedParams.versionDetected !== false ? 1 : 0,
        normalizedParams.crashType || null,
        normalizedParams.crashReason || null,
        normalizedParams.lastStackCall || null,
        normalizedParams.crashModule || null,
        normalizedParams.crashLocation || null,
        normalizedParams.symbolicatedLog,
        JSON.stringify(normalizedParams.usedUuids),
        normalizedParams.aiAnalysis ? JSON.stringify(normalizedParams.aiAnalysis) : null,
        id
      );

      logger.info('历史记录符号化结果已刷新', {
        id,
        appVersion: normalizedParams.appVersion,
        uuidCount: normalizedParams.usedUuids.length,
      });

      return this.getHistoryById(id);
    } catch (error: any) {
      logger.error('刷新历史记录符号化结果失败', { error: error.message, id });
      throw error;
    }
  }

  /**
   * 根据 ID 获取历史记录
   */
  getHistoryById(id: number): SymbolicationHistoryRecord {
    const db = getDatabase();

    const stmt = db.prepare(`
      SELECT * FROM symbolication_history WHERE id = ?
    `);

    const row = stmt.get(id) as any;

    if (!row) {
      throw new Error(`History record ${id} not found`);
    }

    return this.mapRowToRecord(row);
  }

  /**
   * 获取所有历史记录（按主应用版本分组）
   */
  getAllHistoryGroupedByVersion(): Record<string, SymbolicationHistoryRecord[]> {
    const db = getDatabase();

    const stmt = db.prepare(`
      SELECT * FROM symbolication_history 
      ORDER BY created_at DESC
    `);

    const rows = stmt.all() as any[];
    const records = rows.map((row) => this.mapRowToRecord(row));

    // 按主应用版本分组
    const grouped: Record<string, SymbolicationHistoryRecord[]> = {};
    for (const record of records) {
      if (!grouped[record.appVersion]) {
        grouped[record.appVersion] = [];
      }
      grouped[record.appVersion].push(record);
    }

    return grouped;
  }

  /**
   * 根据主应用版本获取历史记录
   */
  getHistoryByVersion(appVersion: string): SymbolicationHistoryRecord[] {
    const db = getDatabase();

    const stmt = db.prepare(`
      SELECT * FROM symbolication_history 
      WHERE app_version = ?
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(appVersion) as any[];
    return rows.map((row) => this.mapRowToRecord(row));
  }

  /**
   * 更新历史记录的 AI 分析结果
   */
  async updateAIAnalysis(id: number, aiAnalysis: any): Promise<void> {
    const db = getDatabase();

    try {
      const current = db.prepare('SELECT crash_module FROM symbolication_history WHERE id = ?').get(id) as { crash_module?: string } | undefined;
      // 如果 AI 分析中包含崩溃模块，同时更新崩溃模块字段
      let updateQuery = `
        UPDATE symbolication_history 
        SET ai_analysis = ?`;
      
      const params: any[] = [JSON.stringify(aiAnalysis)];
      
      if (aiAnalysis.crashModule && this.shouldUpdateCrashModuleFromAI(current?.crash_module, aiAnalysis.crashModule)) {
        updateQuery += `, crash_module = ?`;
        params.push(aiAnalysis.crashModule);
      }
      
      updateQuery += ` WHERE id = ?`;
      params.push(id);

      const stmt = db.prepare(updateQuery);
      stmt.run(...params);

      logger.info('历史记录的 AI 分析已更新', { 
        id,
        updatedCrashModule: !!aiAnalysis.crashModule && this.shouldUpdateCrashModuleFromAI(current?.crash_module, aiAnalysis.crashModule)
      });
    } catch (error: any) {
      logger.error('更新 AI 分析失败', { error: error.message, id });
      throw error;
    }
  }

  private shouldUpdateCrashModuleFromAI(currentCrashModule: string | undefined, aiCrashModule: string): boolean {
    const current = String(currentCrashModule || '').trim();
    const next = String(aiCrashModule || '').trim();
    if (!next) return false;
    if (!current) return true;
    if (/^<unknown>|^unknown$|^未识别|^未知/i.test(current)) return true;
    return current === next;
  }

  /**
   * 删除历史记录
   */
  deleteHistory(id: number): void {
    const db = getDatabase();

    const stmt = db.prepare(`
      DELETE FROM symbolication_history WHERE id = ?
    `);

    stmt.run(id);

    logger.info('符号化历史记录已删除', { id });
  }

  /**
   * 清空所有历史记录
   */
  clearAllHistory(): void {
    const db = getDatabase();

    db.prepare('DELETE FROM symbolication_history').run();

    logger.info('所有符号化历史记录已清空');
  }

  /**
   * 获取历史记录统计
   */
  getStatistics(): {
    totalRecords: number;
    versionCount: number;
    versions: { version: string; count: number }[];
  } {
    const db = getDatabase();

    // 总记录数
    const totalResult = db.prepare('SELECT COUNT(*) as count FROM symbolication_history').get() as any;
    const totalRecords = totalResult.count;

    // 按版本统计
    const versionStats = db.prepare(`
      SELECT app_version as version, COUNT(*) as count 
      FROM symbolication_history 
      GROUP BY app_version 
      ORDER BY count DESC
    `).all() as any[];

    return {
      totalRecords,
      versionCount: versionStats.length,
      versions: versionStats,
    };
  }

  /**
   * 对历史记录进行AI分析
   */
  async analyzeHistory(id: number, apiKey: string): Promise<any> {
    const record = this.getHistoryById(id);

    // 动态导入 AI 分析服务，避免历史服务初始化时提前加载外部 API 配置。
    const { default: aiAnalysisService } = await import('./AIAnalysisService');

    // 调用AI分析，使用应用版本作为fallback
    const analysis = await aiAnalysisService.analyzeCrashLog(
      record.symbolicatedLog,
      apiKey,
      record.appVersion
    );

    // 更新历史记录
    await this.updateAIAnalysis(id, analysis);

    logger.info('历史记录AI分析完成', { id });

    return analysis;
  }

  /**
   * 更新历史记录的修复状态
   */
  updateFixedStatus(id: number, isFixed: boolean, fixedVersion?: string): void {
    const db = getDatabase();

    try {
      const stmt = db.prepare(`
        UPDATE symbolication_history 
        SET is_fixed = ?, fixed_version = ? 
        WHERE id = ?
      `);

      stmt.run(isFixed ? 1 : 0, fixedVersion || null, id);

      logger.info('历史记录修复状态已更新', { id, isFixed, fixedVersion });
    } catch (error: any) {
      logger.error('更新历史记录修复状态失败', { error: error.message });
      throw error;
    }
  }

  /**
   * 将数据库行映射为记录对象
   */
  private mapRowToRecord(row: any): SymbolicationHistoryRecord {
    return {
      id: row.id,
      appVersion: row.app_version,
      versionDetected: row.version_detected === 1,
      crashType: row.crash_type,
      crashReason: row.crash_reason,
      lastStackCall: row.last_stack_call,
      crashModule: row.crash_module,
      crashLocation: row.crash_location,
      originalLog: row.original_log,
      symbolicatedLog: row.symbolicated_log,
      usedUuids: JSON.parse(row.used_uuids),
      aiAnalysis: row.ai_analysis ? JSON.parse(row.ai_analysis) : undefined,
      isFixed: row.is_fixed === 1,
      fixedVersion: row.fixed_version,
      createdAt: row.created_at,
    };
  }
}

export default new HistoryService();
