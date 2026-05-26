import crypto from 'crypto';
import logger from '../utils/logger';

interface CachedSymbolication {
  hash: string;
  symbolicatedLog: string;
  matchedUUIDs: string[];
  warning?: string;
  appVersion?: string; // 应用版本
  aiAnalysis?: any; // AI分析结果
  timestamp: number;
}

/**
 * 符号化缓存服务
 * 用于缓存相同崩溃日志的符号化结果，避免重复处理
 */
export class SymbolicationCacheService {
  private cache: Map<string, CachedSymbolication>;
  private readonly maxCacheSize: number;
  private readonly cacheExpireTime: number; // 缓存过期时间（毫秒）

  constructor() {
    this.cache = new Map();
    this.maxCacheSize = 100; // 最多缓存100个结果
    this.cacheExpireTime = 24 * 60 * 60 * 1000; // 24小时过期
  }

  /**
   * 计算崩溃日志的哈希值
   */
  private calculateHash(crashLog: string, uuids: string[]): string {
    const content = crashLog + uuids.sort().join(',');
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * 获取缓存的符号化结果
   */
  get(crashLog: string, uuids: string[]): CachedSymbolication | null {
    const hash = this.calculateHash(crashLog, uuids);
    logger.info('查找缓存', { 
      hash: hash.substring(0, 16),
      uuids,
      cacheSize: this.cache.size,
      hasCache: this.cache.has(hash)
    });
    
    const cached = this.cache.get(hash);

    if (!cached) {
      logger.info('缓存未找到', { hash: hash.substring(0, 16) });
      return null;
    }

    // 检查是否过期
    const now = Date.now();
    const age = now - cached.timestamp;
    if (age > this.cacheExpireTime) {
      logger.info('缓存已过期', { 
        hash: hash.substring(0, 16),
        age: Math.floor(age / 1000) + 's'
      });
      this.cache.delete(hash);
      return null;
    }

    logger.info('✓ 命中符号化缓存', { 
      hash: hash.substring(0, 16),
      uuids: cached.matchedUUIDs,
      age: Math.floor(age / 1000) + 's'
    });
    return cached;
  }

  /**
   * 保存符号化结果到缓存
   */
  set(
    crashLog: string,
    uuids: string[],
    symbolicatedLog: string,
    warning?: string,
    appVersion?: string,
    aiAnalysis?: any
  ): void {
    const hash = this.calculateHash(crashLog, uuids);

    // 如果缓存已满，删除最旧的条目
    if (this.cache.size >= this.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
        logger.info('缓存已满，删除最旧的条目', { 
          deletedHash: oldestKey.substring(0, 8) 
        });
      }
    }

    this.cache.set(hash, {
      hash,
      symbolicatedLog,
      matchedUUIDs: uuids,
      warning,
      appVersion,
      aiAnalysis,
      timestamp: Date.now(),
    });

    logger.info('✓ 符号化结果已缓存', { 
      hash: hash.substring(0, 16),
      uuids,
      cacheSize: this.cache.size,
      logLength: symbolicatedLog.length,
      hasAIAnalysis: !!aiAnalysis
    });
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
    logger.info('符号化缓存已清空');
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): {
    size: number;
    maxSize: number;
    expireTime: number;
  } {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      expireTime: this.cacheExpireTime,
    };
  }
}

export default new SymbolicationCacheService();
