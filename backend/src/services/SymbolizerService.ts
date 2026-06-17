import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { CrashLogParser, StackFrame } from './CrashLogParser';
import { SystemSymbolsService } from './SystemSymbolsService';
import { AppError, ErrorCode } from '../types';
import logger from '../utils/logger';

const execAsync = promisify(exec);

export class SymbolizerService {
  private parser: CrashLogParser;
  private systemSymbols: SystemSymbolsService;
  private timeout: number;

  constructor() {
    this.parser = new CrashLogParser();
    this.systemSymbols = new SystemSymbolsService();
    this.timeout = 30000; // 30 秒超时
  }

  /**
   * 使用多个 dSYM 文件符号化崩溃日志
   */
  async symbolicateWithMultipleDSYMs(
    crashLog: string,
    dsymPaths: string[]
  ): Promise<{ symbolicatedLog: string; warning?: string }> {
    logger.info('使用多个 dSYM 文件符号化', { dsymCount: dsymPaths.length });

    let result = crashLog;
    const warnings: string[] = [];
    const symbolizedBinaries: string[] = [];

    // 依次使用每个 dSYM 文件符号化
    for (const dsymPath of dsymPaths) {
      try {
        const dsymResult = await this.symbolicate(result, dsymPath);
        result = dsymResult.symbolicatedLog;
        
        if (dsymResult.warning) {
          warnings.push(dsymResult.warning);
        }
        
        const dsymName = this.extractAppNameFromDSYM(dsymPath);
        symbolizedBinaries.push(dsymName);
        
        logger.info('使用 dSYM 符号化成功', { dsymName });
      } catch (error: any) {
        const dsymName = this.extractAppNameFromDSYM(dsymPath);
        logger.warn('使用 dSYM 符号化失败', { dsymName, error: error.message });
        warnings.push(`${dsymName}: ${error.message}`);
      }
    }

    logger.info('多 dSYM 符号化完成', { 
      symbolizedBinaries,
      warningCount: warnings.length 
    });

    return {
      symbolicatedLog: result,
      warning: warnings.length > 0 ? warnings.join('\n\n') : undefined,
    };
  }

  /**
   * 符号化崩溃日志（单个 dSYM）
   */
  async symbolicate(
    crashLog: string,
    dsymPath: string
  ): Promise<{ symbolicatedLog: string; warning?: string }> {
    try {
      logger.info('开始符号化崩溃日志', { dsymPath });
      const warnings: string[] = [];
      let wasResourceIPS = false;

      // 先检测是否是 .ips JSON 格式（不进行完整解析）
      let trimmed = crashLog.trim();
      if (trimmed.startsWith('{')) {
        const resourceReport = this.convertResourceIPSToCrashLog(crashLog);
        if (resourceReport) {
          wasResourceIPS = true;
          crashLog = resourceReport;
          trimmed = crashLog.trim();
          logger.info('检测到 resource/wakeups .ips，已转换为简化堆栈格式', {
            convertedLength: crashLog.length,
          });
        }
      }
      // 检查是否是文本格式的崩溃日志（包含特定的文本格式标记）
      const isTextFormat = crashLog.includes('Thread 0 Crashed:') || 
                          crashLog.includes('Binary Images:') ||
                          /^\d+\s+\S+\s+0x[0-9a-f]+/.test(crashLog); // 匹配堆栈行格式
      const isIPSFormat = trimmed.startsWith('{') && !isTextFormat;
      
      // 如果是 .ips 格式，转换为文本格式后使用 atos
      // 注意：不使用 symbolicatecrash，因为它无法处理多行 JSON 格式
      if (isIPSFormat) {
        logger.info('检测到 .ips JSON 格式，转换为文本格式后使用 atos');
        try {
          // 使用 ipsConverter 转换
          const { convertIPSToCrash } = require('../utils/ipsConverter');
          crashLog = convertIPSToCrash(crashLog);
          logger.info('.ips 转换成功，继续使用 atos 方法', {
            convertedLength: crashLog.length,
            hasThreadCrashed: crashLog.includes('Thread') && crashLog.includes('Crashed'),
            hasBinaryImages: crashLog.includes('Binary Images:')
          });
        } catch (convertError: any) {
          logger.error('.ips 转换失败', { error: convertError.message });
          throw new AppError(
            ErrorCode.SYMBOLICATION_FAILED,
            `无法处理 .ips 文件：${convertError.message}`,
            400
          );
        }
      }

      // 解析崩溃日志（文本格式）
      const parsed = this.parser.parseCrashLog(crashLog);
      logger.info('崩溃日志解析成功', {
        format: parsed.format,
        uuid: parsed.uuid,
        binaryName: parsed.binaryName,
        stackFrameCount: parsed.stackFrames.length,
      });

      // 从 dSYM 路径中提取应用名称
      const dsymName = this.extractAppNameFromDSYM(dsymPath);
      logger.info('dSYM 应用名称', { dsymName });

      // 提取 dSYM 的 UUID
      const dsymUUID = await this.extractDSYMUUID(dsymPath);
      logger.info('dSYM UUID', { dsymUUID });

      // 从 Binary Images 中找到匹配 UUID 的二进制名称
      let matchedBinaryName = this.findBinaryNameByUUID(crashLog, dsymUUID);
      
      if (!matchedBinaryName) {
        // UUID 不匹配，尝试使用 dSYM 文件名匹配
        logger.warn('UUID 不匹配，尝试使用文件名匹配', { dsymName, dsymUUID });
        
        // 检查崩溃日志中是否有同名的二进制
        const availableBinaries = [...new Set(parsed.stackFrames.map((f) => f.binaryName))];
        if (availableBinaries.includes(dsymName)) {
          matchedBinaryName = dsymName;
          logger.warn('使用文件名匹配到二进制（UUID 不匹配，符号化结果可能不准确）', { 
            matchedBinaryName,
            dsymUUID,
          });
        } else {
          // 提取崩溃日志中所有二进制的 UUID
          const binaryUUIDs = this.extractAllBinaryUUIDs(crashLog);
          
          logger.warn('未找到匹配的二进制', {
            dsymUUID,
            dsymName,
            availableBinaries,
            binaryUUIDs,
          });
          
          // 构建友好的错误消息
          let errorMsg = `崩溃日志中未找到与 dSYM 匹配的二进制文件。\n\n`;
          errorMsg += `dSYM 信息：\n`;
          errorMsg += `  - 名称: ${dsymName}\n`;
          errorMsg += `  - UUID: ${dsymUUID}\n\n`;
          errorMsg += `崩溃日志中包含以下二进制文件：\n`;
          binaryUUIDs.forEach(({ name, uuid }) => {
            errorMsg += `  - ${name}: ${uuid}\n`;
          });
          errorMsg += `\n请上传与崩溃日志匹配的 dSYM 文件，或确保二进制名称一致。`;
          
          throw new AppError(
            ErrorCode.SYMBOLICATION_FAILED,
            errorMsg,
            400
          );
        }
      } else {
        logger.info('找到匹配的二进制名称（UUID 匹配）', { matchedBinaryName, dsymUUID });
      }

      // 只符号化匹配的应用的堆栈帧
      const appFrames = parsed.stackFrames.filter((frame) => frame.binaryName === matchedBinaryName);

      if (appFrames.length === 0) {
        logger.warn('未找到匹配应用的堆栈帧', {
          matchedBinaryName,
          availableBinaries: [...new Set(parsed.stackFrames.map((f) => f.binaryName))],
        });
        throw new AppError(
          ErrorCode.SYMBOLICATION_FAILED,
          `崩溃日志中未找到应用 "${matchedBinaryName}" 的堆栈信息。`,
          400
        );
      }

      // 提取该应用的加载地址
      let loadAddress = this.extractLoadAddressForBinary(crashLog, matchedBinaryName);
      let inferredLoadAddresses: string[] = [];
      const hasBinaryImages = /Binary Images:/i.test(crashLog);
      if (!hasBinaryImages) {
        inferredLoadAddresses = this.inferLoadAddressesFromSimplifiedStack(appFrames, matchedBinaryName);

        if (loadAddress && !inferredLoadAddresses.includes(loadAddress)) {
          inferredLoadAddresses.unshift(loadAddress);
        }

        if (!loadAddress) {
          loadAddress = inferredLoadAddresses[0];
        }

        if (inferredLoadAddresses.length > 0) {
          warnings.push(
            `⚠️ 当前崩溃日志缺少 Binary Images，已根据 "${matchedBinaryName}" 栈地址尝试推断加载基址。` +
            `符号化结果可能存在偏差，建议上传完整 .ips 或包含 Binary Images 的 crash 日志。`
          );
          logger.warn('缺少 Binary Images，使用栈地址推断加载地址候选', {
            matchedBinaryName,
            extractedLoadAddress: loadAddress,
            inferredLoadAddresses,
          });
        }
      }
      if (!loadAddress) {
        logger.error('无法提取加载地址', { matchedBinaryName });
        throw new AppError(
          ErrorCode.SYMBOLICATION_FAILED,
          `无法从崩溃日志中提取应用 "${matchedBinaryName}" 的加载地址`,
          400
        );
      }

      logger.info('提取到加载地址', { matchedBinaryName, loadAddress });

      // 提取需要符号化的地址
      const addresses = this.parser.extractAddresses(appFrames);
      logger.info(`提取到 ${addresses.length} 个地址需要符号化`);

      // 使用 atos 批量符号化
      let symbolMap = inferredLoadAddresses.length > 1
        ? await this.symbolicateWithCandidateLoadAddresses(addresses, dsymPath, inferredLoadAddresses)
        : await this.symbolicateWithAtos(addresses, dsymPath, loadAddress);
      symbolMap = await this.fillAddressOnlySymbols(addresses, symbolMap, dsymPath, loadAddress);
      logger.info(`成功符号化 ${symbolMap.size} 个地址`);

      // 替换原始日志中的地址为符号信息
      let symbolicatedLog = this.replaceSymbols(crashLog, appFrames, symbolMap);

      // 如果启用了系统符号化，尝试符号化系统库
      if (this.systemSymbols.isEnabled()) {
        logger.info('开始符号化系统库');
        symbolicatedLog = await this.symbolicateSystemLibraries(
          symbolicatedLog,
          parsed.stackFrames,
          matchedBinaryName
        );
      }

      logger.info('符号化完成');
      
      // 检查是否有 UUID 不匹配的警告
      const finalDsymUUID = await this.extractDSYMUUID(dsymPath);
      const matchedByUUID = this.findBinaryNameByUUID(crashLog, finalDsymUUID);
      
      if (!matchedByUUID && !wasResourceIPS) {
        const warning = `⚠️ 警告：dSYM 文件的 UUID 与崩溃日志不匹配。符号化结果可能不准确。建议上传正确版本的 dSYM 文件以获得准确的符号化结果。`;
        warnings.push(warning);
      }
      
      return {
        symbolicatedLog,
        warning: warnings.length > 0 ? warnings.join('\n\n') : undefined,
      };
    } catch (error) {
      logger.error('符号化失败', { error });
      throw error;
    }
  }

  /**
   * wakeups/resource .ips 没有 threads/binaryImages，但通常包含
   * "Heaviest stack for the target process"。转换成现有解析器支持的简化栈格式。
   */
  private convertResourceIPSToCrashLog(content: string): string | null {
    if (!/Heaviest stack for the target process:/i.test(content)) {
      return null;
    }

    const metadata = this.extractResourceIPSMetadata(content);
    const lines = content.split(/\r?\n/);
    const stackLines: string[] = [];
    let inHeaviestStack = false;
    let frameIndex = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^Heaviest stack for the target process:/i.test(trimmed)) {
        inHeaviestStack = true;
        continue;
      }

      if (!inHeaviestStack) {
        continue;
      }

      if (!trimmed) {
        if (stackLines.length > 0) break;
        continue;
      }

      const match = trimmed.match(/^\d+\s+\S+\s+\(([^+()]+)\s+\+\s+(\d+)\)\s+\[(0x[0-9a-f]+)\]/i);
      if (!match) {
        if (stackLines.length > 0 && !/^\d+\s+/.test(trimmed)) break;
        continue;
      }

      const binaryName = match[1].trim();
      const offset = Number(match[2]);
      const address = Number.parseInt(match[3], 16);
      if (!binaryName || !Number.isFinite(offset) || !Number.isFinite(address) || address <= offset) {
        continue;
      }

      const loadAddress = `0x${(address - offset).toString(16)}`;
      stackLines.push(`${frameIndex} ${binaryName} ${match[3]} ${loadAddress} + ${offset}`);
      frameIndex += 1;
    }

    if (stackLines.length === 0) {
      return null;
    }

    return [
      `Incident Identifier: ${metadata.incidentId || 'N/A'}`,
      `Process:             ${metadata.processName || 'Unknown'} [${metadata.pid || 0}]`,
      `Identifier:          ${metadata.bundleId || 'N/A'}`,
      `Version:             ${metadata.version || 'N/A'}${metadata.buildVersion ? ` (${metadata.buildVersion})` : ''}`,
      `Date/Time:           ${metadata.timestamp || ''}`,
      `OS Version:          ${metadata.osVersion || 'iOS'}`,
      'Report Version:      104',
      '',
      `Exception Type:      ${metadata.event ? `RESOURCE_${metadata.event.toUpperCase()}` : 'RESOURCE'}`,
      metadata.wakeups ? `Exception Reason:    ${metadata.wakeups}` : '',
      '',
      'Thread 0 Crashed:',
      ...stackLines,
    ].filter((line) => line !== '').join('\n');
  }

  private extractResourceIPSMetadata(content: string): {
    incidentId?: string;
    processName?: string;
    pid?: string;
    bundleId?: string;
    version?: string;
    buildVersion?: string;
    timestamp?: string;
    osVersion?: string;
    event?: string;
    wakeups?: string;
  } {
    let jsonHeader: any = {};
    const firstLine = content.split(/\r?\n/).find((line) => line.trim().startsWith('{'))?.trim();
    if (firstLine) {
      try {
        jsonHeader = JSON.parse(firstLine);
      } catch {
        jsonHeader = {};
      }
    }

    const readField = (label: string) => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return content.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'im'))?.[1]?.trim();
    };

    const versionLine = readField('Version');
    const versionMatch = versionLine?.match(/^([^\s(]+)(?:\s+\(([^)]+)\))?/);

    return {
      incidentId: jsonHeader.incident_id || jsonHeader.incidentID || readField('Incident Identifier'),
      processName: jsonHeader.app_name || jsonHeader.procName || readField('Command'),
      pid: readField('PID'),
      bundleId: jsonHeader.bundleID || readField('Identifier'),
      version: jsonHeader.app_version || versionMatch?.[1],
      buildVersion: jsonHeader.build_version || versionMatch?.[2],
      timestamp: jsonHeader.timestamp || readField('Date/Time'),
      osVersion: jsonHeader.os_version || readField('OS Version'),
      event: readField('Event'),
      wakeups: readField('Wakeups'),
    };
  }

  /**
   * 使用 atos 符号化地址
   */
  async symbolicateWithAtos(
    addresses: string[],
    dsymPath: string,
    loadAddress: string,
    options: { includeAddressOnly?: boolean } = {}
  ): Promise<Map<string, string>> {
    const symbolMap = new Map<string, string>();

    if (addresses.length === 0) {
      return symbolMap;
    }

    try {
      // 找到 DWARF 文件
      const dwarfPath = this.findDWARFFile(dsymPath);
      if (!dwarfPath) {
        logger.error('未找到 DWARF 文件', { dsymPath });
        throw new AppError(ErrorCode.SYMBOLICATION_FAILED, '未找到 DWARF 文件', 400);
      }

      // 构建 atos 命令
      // atos -o <dSYM> -l <loadAddress> <address1> <address2> ...
      const addressList = addresses.join(' ');
      const command = `atos -o "${dwarfPath}" -l ${loadAddress} ${addressList}`;

      logger.info('执行 atos 命令', { command: command.substring(0, 200) });

      // 执行命令
      const { stdout, stderr } = await execAsync(command, {
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      if (stderr) {
        logger.warn('atos 命令产生警告', { stderr });
      }

      // 解析输出
      const symbols = stdout.trim().split('\n');

      // 将地址和符号对应起来
      addresses.forEach((address, index) => {
        if (index < symbols.length) {
          const symbol = symbols[index].trim();
          // 只有当符号化成功时才添加（atos 失败时会返回原地址）
          if (this.isUsableAtosSymbol(symbol, address, options.includeAddressOnly)) {
            symbolMap.set(address, symbol);
          }
        }
      });

      return symbolMap;
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }

      // 处理超时错误
      if (error.killed || error.signal === 'SIGTERM') {
        logger.error('atos 命令超时', { timeout: this.timeout });
        throw new AppError(
          ErrorCode.SYMBOLICATION_FAILED,
          `符号化超时（${this.timeout / 1000}秒）`,
          500
        );
      }

      // 处理命令不存在错误
      if (error.code === 'ENOENT') {
        logger.error('atos 命令不存在，请确保在 macOS 系统上运行');
        throw new AppError(
          ErrorCode.SYMBOLICATION_FAILED,
          'atos 命令不可用，请确保在 macOS 系统上运行',
          500
        );
      }

      logger.error('atos 命令执行失败', { error: error.message, stack: error.stack });
      throw new AppError(ErrorCode.SYMBOLICATION_FAILED, 'atos 命令执行失败', 500);
    }
  }

  private isUsableAtosSymbol(
    symbol: string,
    address: string,
    includeAddressOnly = false
  ): boolean {
    if (!symbol || symbol === address) {
      return false;
    }

    if (!symbol.startsWith('0x')) {
      return true;
    }

    // 某些地址在 dSYM 里没有函数/DWARF 条目，atos 只能返回
    // "0x00003650 (in NNRtc)"。最终结果里保留这个信息，比继续显示
    // "<unknown> + ..." 更清楚，但它不能参与候选基址评分。
    return includeAddressOnly && /^0x[0-9a-f]+\s+\(in [^)]+\)(?:\s+\+\s+\d+)?$/i.test(symbol);
  }

  /**
   * 替换原始日志中的符号
   */
  private replaceSymbols(
    originalLog: string,
    stackFrames: StackFrame[],
    symbolMap: Map<string, string>
  ): string {
    let result = originalLog;

    // 按行处理，替换符号化的行
    stackFrames.forEach((frame) => {
      const symbol = symbolMap.get(frame.address);
      if (symbol) {
        // 构建新的行
        // 原始: 0  MyApp  0x0000000100001234 0x100000000 + 4660
        // 新的: 0  MyApp  0x0000000100001234 main (ViewController.swift:42)
        const newLine = `${frame.index}  ${frame.binaryName}  ${frame.address} ${symbol}`;

        // 替换原始行
        result = result.replace(frame.line, newLine);
      }
    });

    return result;
  }

  /**
   * 查找 DWARF 文件
   */
  private findDWARFFile(dsymPath: string): string | null {
    const fs = require('fs');
    const dwarfDir = path.join(dsymPath, 'Contents', 'Resources', 'DWARF');

    if (!fs.existsSync(dwarfDir)) {
      return null;
    }

    const files = fs.readdirSync(dwarfDir);
    if (files.length === 0) {
      return null;
    }

    // 过滤掉 macOS 资源分叉文件（以 ._ 开头）和隐藏文件（以 . 开头）
    const validFiles = files.filter((file: string) => !file.startsWith('.'));

    if (validFiles.length === 0) {
      logger.warn('DWARF 目录中只有隐藏文件', { dwarfDir, files });
      return null;
    }

    // 返回第一个有效文件
    return path.join(dwarfDir, validFiles[0]);
  }

  /**
   * 从 dSYM 路径中提取应用名称
   */
  private extractAppNameFromDSYM(dsymPath: string): string {
    // dsymPath 格式: storage/dsyms/uuid/MyApp.app.dSYM
    const dsymName = path.basename(dsymPath);
    // 移除 .app.dSYM 或 .dSYM 后缀
    return dsymName.replace('.app.dSYM', '').replace('.dSYM', '');
  }

  /**
   * 提取 dSYM 的 UUID
   */
  private async extractDSYMUUID(dsymPath: string): Promise<string> {
    const fs = require('fs');
    const dwarfPath = this.findDWARFFile(dsymPath);
    if (!dwarfPath) {
      throw new AppError(ErrorCode.SYMBOLICATION_FAILED, '未找到 DWARF 文件', 400);
    }

    const { stdout } = await execAsync(`dwarfdump --uuid "${dwarfPath}"`);
    const uuidMatch = stdout.match(/UUID:\s+([A-F0-9-]+)/i);
    if (!uuidMatch) {
      throw new AppError(ErrorCode.SYMBOLICATION_FAILED, '无法提取 dSYM UUID', 400);
    }

    return uuidMatch[1];
  }

  /**
   * 提取崩溃日志中所有二进制的 UUID
   */
  private extractAllBinaryUUIDs(crashLog: string): Array<{ name: string; uuid: string }> {
    const result: Array<{ name: string; uuid: string }> = [];
    const lines = crashLog.split('\n');
    let foundBinaryImages = false;

    for (const line of lines) {
      if (line.includes('Binary Images:')) {
        foundBinaryImages = true;
        continue;
      }

      if (!foundBinaryImages) {
        continue;
      }

      const match = line.match(/0x[0-9a-f]+\s+-\s+0x[0-9a-f]+\s+(\S+)\s+\S+\s+<([A-F0-9-]+)>/i);
      if (match) {
        result.push({
          name: match[1],
          uuid: match[2],
        });
      }
    }

    return result;
  }

  /**
   * 从 Binary Images 中根据 UUID 找到二进制名称
   */
  private findBinaryNameByUUID(crashLog: string, uuid: string): string | null {
    // 规范化 UUID（移除连字符，转换为小写）
    const normalizedUUID = uuid.replace(/-/g, '').toLowerCase();
    logger.info('查找匹配 UUID 的二进制', { normalizedUUID });

    // Binary Images 格式:
    // 0x100000000 - 0x100ffffff MyApp arm64  <4C4C44A8-5555-3144-A119-54B84805F5A2> /path/to/MyApp
    // 或者没有连字符: <4c4c44a855553144a11954b84805f5a2>
    const lines = crashLog.split('\n');
    
    let foundBinaryImages = false;
    const matchedLines: string[] = [];
    
    for (const line of lines) {
      // 检测 Binary Images 部分
      if (line.includes('Binary Images:')) {
        foundBinaryImages = true;
        continue;
      }
      
      if (!foundBinaryImages) {
        continue;
      }
      
      // 匹配 Binary Images 行
      const match = line.match(/0x[0-9a-f]+\s+-\s+0x[0-9a-f]+\s+(\S+)\s+\S+\s+<([A-F0-9-]+)>/i);
      if (match) {
        const binaryName = match[1];
        const lineUUID = match[2].replace(/-/g, '').toLowerCase();
        matchedLines.push(`${binaryName}: ${lineUUID}`);
        
        if (lineUUID === normalizedUUID) {
          logger.info('找到匹配的二进制', { binaryName, lineUUID });
          return binaryName;
        }
      }
    }

    logger.warn('未找到匹配的二进制', { 
      normalizedUUID, 
      foundBinaryImages,
      matchedCount: matchedLines.length,
      sample: matchedLines.slice(0, 5)
    });

    return null;
  }

  /**
   * 为特定二进制提取加载地址
   */
  private extractLoadAddressForBinary(crashLog: string, binaryName: string): string | null {
    const escapedName = binaryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    logger.info('extractLoadAddressForBinary', { binaryName, escapedName });
    
    // 从 Binary Images 部分提取
    // 格式: 0x100000000 - 0x100ffffff MyApp arm64  <uuid> /path/to/MyApp
    const pattern = new RegExp(
      `(0x[0-9a-f]+)\\s+-\\s+0x[0-9a-f]+\\s+${escapedName}`,
      'i'
    );
    const match = crashLog.match(pattern);
    if (match) {
      return match[1];
    }

    // 尝试从堆栈中提取（格式: address loadAddress + offset）
    const stackPattern = new RegExp(
      `\\d+\\s+${escapedName}\\s+0x[0-9a-f]+\\s+(0x[0-9a-f]+)\\s+\\+`,
      'i'
    );
    const stackMatch = crashLog.match(stackPattern);
    if (stackMatch) {
      return stackMatch[1];
    }

    // 尝试从 <unknown> + offset 格式中计算加载地址
    // 格式: 6   NNIM   0x204ce7fd0   <unknown> + 4375609296
    const unknownPattern = new RegExp(
      `\\d+\\s+${escapedName}\\s+(0x[0-9a-f]+)\\s+<unknown>\\s+\\+\\s+(\\d+)`,
      'i'
    );
    logger.info('尝试 unknown 模式匹配', { pattern: unknownPattern.source, hasBinaryInLog: crashLog.includes(binaryName) });
    const unknownMatch = crashLog.match(unknownPattern);
    if (unknownMatch) {
      const loadAddr = this.inferLoadAddressFromUnknownValue(unknownMatch[1], unknownMatch[2]);
      if (loadAddr) {
        return loadAddr;
      }

      logger.warn('unknown 模式中的 + 值不是有效偏移，跳过加载地址计算', {
        binaryName,
        address: unknownMatch[1],
        value: unknownMatch[2],
      });
    }

    return null;
  }

  /**
   * 兼容 MetricKit/精简 crash 文本：只有栈地址，没有 Binary Images/load address。
   * 这类日志无法严格还原 slide，只能按应用栈最小地址做页对齐推断。
   */
  private inferLoadAddressesFromSimplifiedStack(
    frames: StackFrame[],
    binaryName: string
  ): string[] {
    const addresses = frames
      .filter((frame) => frame.binaryName === binaryName)
      .map((frame) => parseInt(frame.address, 16))
      .filter((address) => Number.isFinite(address) && address > 0);

    if (addresses.length === 0) {
      return [];
    }

    const candidates: string[] = [];

    const addCandidate = (base: number) => {
      if (!Number.isFinite(base) || base <= 0) {
        return;
      }

      const candidate = `0x${base.toString(16)}`;
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    };

    // 精简日志里的 "<unknown> + N" 有三种常见来源：
    // 1. N 是 image offset，可以用 address - N 得到加载基址；
    // 2. N 是未 slide 的 Mach-O 虚拟地址，可用 address - N + 0x100000000 推出加载基址；
    // 3. N 是实际绝对地址，这时 address - N 无效，只能继续走页对齐候选。
    for (const frame of frames) {
      if (frame.binaryName !== binaryName || !frame.offset) {
        continue;
      }

      const loadAddress = this.inferLoadAddressFromUnknownValue(frame.address, frame.offset);
      if (loadAddress) {
        addCandidate(parseInt(loadAddress, 16));
      }
    }

    const minAddress = Math.min(...addresses);
    // iOS 设备常见 16KB 页对齐；没有 Binary Images 时，多候选试探比固定猜一个基址可靠。
    const alignments = [16 * 1024, 4 * 1024, 1024 * 1024];
    for (const alignment of alignments) {
      const base = Math.floor(minAddress / alignment) * alignment;
      const offset = minAddress - base;
      if (base > 0 && offset > 0 && offset < 512 * 1024 * 1024) {
        addCandidate(base);
      }
    }

    return candidates;
  }

  private inferLoadAddressFromUnknownValue(addressHex: string, valueText: string): string | null {
    const address = parseInt(addressHex, 16);
    const value = parseInt(valueText, 10);
    if (!Number.isFinite(address) || !Number.isFinite(value) || value <= 0) {
      return null;
    }

    const delta = address - value;
    if (delta <= 0 || delta >= address) {
      return null;
    }

    const maxReasonableImageOffset = 512 * 1024 * 1024;
    const commonPreferredBase = 0x100000000;
    if (value < maxReasonableImageOffset) {
      return `0x${delta.toString(16)}`;
    }

    if (value >= commonPreferredBase) {
      return `0x${(delta + commonPreferredBase).toString(16)}`;
    }

    return null;
  }

  private async symbolicateWithCandidateLoadAddresses(
    addresses: string[],
    dsymPath: string,
    loadAddresses: string[]
  ): Promise<Map<string, string>> {
    let bestMap = new Map<string, string>();
    let bestLoadAddress = loadAddresses[0];
    let bestScore = -1;

    for (const loadAddress of loadAddresses) {
      const symbolMap = await this.symbolicateWithAtos(addresses, dsymPath, loadAddress);
      const score = this.scoreSymbolicationMap(addresses, symbolMap);
      logger.info('候选加载地址符号化结果', {
        loadAddress,
        symbolCount: symbolMap.size,
        score,
      });

      if (score > bestScore) {
        bestMap = symbolMap;
        bestLoadAddress = loadAddress;
        bestScore = score;
      }
    }

    const unresolvedAddresses = addresses.filter((address) => !bestMap.has(address));
    if (unresolvedAddresses.length > 0 && bestLoadAddress) {
      const fallbackMap = await this.symbolicateWithAtos(
        unresolvedAddresses,
        dsymPath,
        bestLoadAddress,
        { includeAddressOnly: true }
      );
      fallbackMap.forEach((symbol, address) => bestMap.set(address, symbol));
    }

    logger.info('选择候选加载地址', {
      loadAddress: bestLoadAddress,
      symbolCount: bestMap.size,
    });

    return bestMap;
  }

  private async fillAddressOnlySymbols(
    addresses: string[],
    symbolMap: Map<string, string>,
    dsymPath: string,
    loadAddress: string
  ): Promise<Map<string, string>> {
    const unresolvedAddresses = addresses.filter((address) => !symbolMap.has(address));
    if (unresolvedAddresses.length === 0) {
      return symbolMap;
    }

    const fallbackMap = await this.symbolicateWithAtos(
      unresolvedAddresses,
      dsymPath,
      loadAddress,
      { includeAddressOnly: true }
    );
    fallbackMap.forEach((symbol, address) => symbolMap.set(address, symbol));
    return symbolMap;
  }

  private scoreSymbolicationMap(addresses: string[], symbolMap: Map<string, string>): number {
    return addresses.reduce((score, address, index) => {
      if (!symbolMap.has(address)) {
        return score;
      }

      // 主权重仍然是符号化数量；低位加入栈深度，平局时选覆盖更深帧的候选。
      return score + 1000 + index;
    }, 0);
  }

  /**
   * 符号化系统库
   */
  private async symbolicateSystemLibraries(
    crashLog: string,
    allFrames: StackFrame[],
    appName: string
  ): Promise<string> {
    let result = crashLog;
    const iosVersion = this.systemSymbols.extractIOSVersion(crashLog);

    // 按二进制分组
    const framesByBinary = new Map<string, StackFrame[]>();
    for (const frame of allFrames) {
      if (frame.binaryName === appName) {
        continue; // 跳过应用自己的帧（已经符号化过了）
      }

      if (!this.systemSymbols.isSystemLibrary(frame.binaryName)) {
        continue; // 跳过非系统库
      }

      if (!framesByBinary.has(frame.binaryName)) {
        framesByBinary.set(frame.binaryName, []);
      }
      framesByBinary.get(frame.binaryName)!.push(frame);
    }

    logger.info(`找到 ${framesByBinary.size} 个系统库需要符号化`);

    // 逐个符号化系统库
    for (const [binaryName, frames] of framesByBinary) {
      try {
        // 查找系统符号
        const systemDSYM = await this.systemSymbols.findSystemDSYM(binaryName, iosVersion);
        if (!systemDSYM) {
          logger.warn(`未找到系统库符号`, { binaryName, iosVersion });
          continue;
        }

        // 提取加载地址。精简日志里的系统库 <unknown> + N 通常不是 image offset，
        // 优先用页对齐候选，避免被 unknown 分支推成错误基址。
        const hasBinaryImages = crashLog.includes('Binary Images:');
        let loadAddress = hasBinaryImages ? this.extractLoadAddressForBinary(crashLog, binaryName) : null;
        let inferredLoadAddresses: string[] = [];
        if (!loadAddress) {
          inferredLoadAddresses = this.inferLoadAddressesFromSimplifiedStack(frames, binaryName);
          loadAddress = inferredLoadAddresses[0];
        }

        if (!loadAddress) {
          logger.warn(`无法提取系统库加载地址`, { binaryName });
          continue;
        }

        // 符号化
        const addresses = frames.map((f) => f.address);
        const symbolMap = inferredLoadAddresses.length > 1
          ? await this.symbolicateSystemLibWithCandidateLoadAddresses(
            addresses,
            systemDSYM,
            inferredLoadAddresses,
            binaryName
          )
          : await this.symbolicateWithAtosForSystemLib(
            addresses,
            systemDSYM,
            loadAddress
          );

        if (symbolMap.size > 0) {
          result = this.replaceSymbols(result, frames, symbolMap);
          logger.info(`成功符号化系统库`, {
            binaryName,
            symbolizedCount: symbolMap.size,
          });
        }
      } catch (error) {
        logger.error(`符号化系统库失败`, { binaryName, error });
      }
    }

    return result;
  }

  private async symbolicateSystemLibWithCandidateLoadAddresses(
    addresses: string[],
    binaryPath: string,
    loadAddresses: string[],
    binaryName: string
  ): Promise<Map<string, string>> {
    let bestMap = new Map<string, string>();
    let bestLoadAddress = loadAddresses[0];

    for (const loadAddress of loadAddresses) {
      const symbolMap = await this.symbolicateWithAtosForSystemLib(
        addresses,
        binaryPath,
        loadAddress
      );
      logger.info('系统库候选加载地址符号化结果', {
        binaryName,
        loadAddress,
        symbolCount: symbolMap.size,
      });

      const score = this.scoreSymbolicationMap(addresses, symbolMap);
      if (score > this.scoreSymbolicationMap(addresses, bestMap)) {
        bestMap = symbolMap;
        bestLoadAddress = loadAddress;
      }
    }

    logger.info('选择系统库候选加载地址', {
      binaryName,
      loadAddress: bestLoadAddress,
      symbolCount: bestMap.size,
    });

    return bestMap;
  }

  /**
   * 使用 atos 符号化系统库（不使用 dSYM 格式）
   */
  private async symbolicateWithAtosForSystemLib(
    addresses: string[],
    binaryPath: string,
    loadAddress: string
  ): Promise<Map<string, string>> {
    const symbolMap = new Map<string, string>();

    if (addresses.length === 0) {
      return symbolMap;
    }

    try {
      const addressList = addresses.join(' ');
      const command = `atos -o "${binaryPath}" -l ${loadAddress} ${addressList}`;

      logger.info('执行系统库 atos 命令', { command: command.substring(0, 200) });

      const { stdout, stderr } = await execAsync(command, {
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024,
      });

      if (stderr) {
        logger.warn('atos 命令产生警告', { stderr });
      }

      const symbols = stdout.trim().split('\n');

      addresses.forEach((address, index) => {
        if (index < symbols.length) {
          const symbol = symbols[index].trim();
          if (this.isUsableAtosSymbol(symbol, address)) {
            symbolMap.set(address, symbol);
          }
        }
      });

      return symbolMap;
    } catch (error: any) {
      logger.error('系统库 atos 命令执行失败', { error: error.message });
      return symbolMap;
    }
  }

  /**
   * 将 .ips JSON 格式转换为文本格式（公开方法，在符号化前调用）
   */
  convertIPSToTextFormat(originalJSON: string): string {
    try {
      // 先检查是否是多行 JSON（每行一个 JSON 对象）
      const lines = originalJSON.trim().split('\n');
      let jsonData: any;
      
      if (lines.length > 1) {
        // 多行 JSON，需要找到包含 threads 的那一行
        logger.info('检测到多行 JSON，共 ' + lines.length + ' 行');
        
        // 尝试解析每一行，找到包含 threads 的
        for (let i = 0; i < lines.length; i++) {
          try {
            const parsed = JSON.parse(lines[i]);
            if (parsed.threads || parsed.binaryImages || parsed.usedImages) {
              logger.info('找到包含崩溃数据的行：第 ' + (i + 1) + ' 行');
              jsonData = parsed;
              break;
            }
          } catch (e) {
            // 跳过无法解析的行
            continue;
          }
        }
        
        // 如果没找到，使用第一行
        if (!jsonData) {
          logger.warn('未找到包含 threads 的行，使用第一行');
          jsonData = JSON.parse(lines[0]);
        }
      } else {
        jsonData = JSON.parse(originalJSON);
      }
      
      const allKeys = Object.keys(jsonData);
      logger.info('JSON 结构分析', {
        totalKeys: allKeys.length,
        allKeys: allKeys,
        sampleData: {
          app_name: jsonData.app_name,
          name: jsonData.name,
          hasThreads: !!jsonData.threads,
          hasUsedImages: !!jsonData.usedImages,
          hasBinaryImages: !!jsonData.binaryImages,
        }
      });
      
      const threads = jsonData.threads || [];
      const binaryImages = jsonData.binaryImages || jsonData.usedImages || [];
      
      logger.info('开始转换 .ips JSON 为文本格式', {
        hasThreads: threads.length > 0,
        threadCount: threads.length,
        hasBinaryImages: binaryImages.length > 0,
        binaryImageCount: binaryImages.length,
      });
      
      // 如果没有 threads 或 binaryImages，说明这不是完整的 .ips 文件
      if (threads.length === 0 || binaryImages.length === 0) {
        logger.error('.ips 文件不完整，缺少 threads 或 binaryImages', {
          hasThreads: threads.length > 0,
          hasBinaryImages: binaryImages.length > 0,
          jsonLength: originalJSON.length,
          availableKeys: allKeys,
        });
        throw new Error('.ips 文件不完整，缺少崩溃线程或二进制镜像信息。请确保上传完整的 .ips 文件。');
      }
      
      const textLines: string[] = [];

      // 提取 OS 版本
      const osVersion = jsonData.osVersion || {};
      const osVersionStr = osVersion.train || 'iOS';
      const osBuild = osVersion.build || '';
      textLines.push(`OS Version: ${osVersionStr}${osBuild ? ' (' + osBuild + ')' : ''}`);
      textLines.push('Report Version: 104');
      textLines.push('');

      // 添加异常信息
      const exception = jsonData.exception || {};
      const exceptionType = exception.type || 'EXC_CRASH';
      const exceptionSignal = exception.signal || '';
      textLines.push(`Exception Type: ${exceptionType}${exceptionSignal ? ' (' + exceptionSignal + ')' : ''}`);
      
      // 找到崩溃的线程索引
      const crashedThreadIndex = threads.findIndex((t: any) => t.triggered);
      textLines.push(`Crashed Thread: ${crashedThreadIndex >= 0 ? crashedThreadIndex : 0}`);
      textLines.push('');

      // 添加 Application Specific Information
      const appSpecificInfo = jsonData.appSpecificInfo || jsonData.applicationSpecificInformation;
      if (appSpecificInfo) {
        textLines.push('Application Specific Information:');
        if (typeof appSpecificInfo === 'string') {
          textLines.push(appSpecificInfo);
        } else if (Array.isArray(appSpecificInfo)) {
          appSpecificInfo.forEach((info: string) => textLines.push(info));
        }
        textLines.push('');
      }

      // 添加崩溃线程信息
      const crashedThread = threads.find((t: any) => t.triggered) || threads[0];
      
      if (crashedThread && crashedThread.frames && crashedThread.frames.length > 0) {
        const threadIndex = threads.indexOf(crashedThread);
        textLines.push(`Thread ${threadIndex} Crashed:`);
        
        // 添加堆栈帧
        crashedThread.frames.forEach((frame: any, index: number) => {
          const imageInfo = binaryImages[frame.imageIndex];
          if (imageInfo) {
            let binaryName = imageInfo.name || 'Unknown';
            if (binaryName.includes('/')) {
              binaryName = binaryName.split('/').pop() || binaryName;
            }
            const loadAddress = typeof imageInfo.base === 'number' 
              ? imageInfo.base 
              : (typeof imageInfo.loadAddress === 'number' ? imageInfo.loadAddress : 0);
            const imageOffset = frame.imageOffset || 0;
            const actualAddress = loadAddress + imageOffset;
            const address = `0x${actualAddress.toString(16).padStart(16, '0')}`;
            const loadAddrHex = `0x${loadAddress.toString(16)}`;
            
            // 格式：index  binaryName  address  loadAddress + offset
            const symbol = frame.symbol || `${loadAddrHex} + ${imageOffset}`;
            textLines.push(`${index}  ${binaryName}  ${address} ${symbol}`);
          }
        });
        textLines.push('');
      } else {
        logger.warn('未找到有效的崩溃线程或堆栈帧', {
          hasCrashedThread: !!crashedThread,
          hasFrames: crashedThread?.frames?.length > 0,
          frameCount: crashedThread?.frames?.length || 0,
        });
      }

      // 添加其他线程
      threads.forEach((thread: any, threadIndex: number) => {
        if (thread === crashedThread) return;
        
        textLines.push(`Thread ${threadIndex}:`);
        if (thread.frames && thread.frames.length > 0) {
          thread.frames.slice(0, 10).forEach((frame: any, index: number) => {
            const imageInfo = binaryImages[frame.imageIndex];
            if (imageInfo) {
              let binaryName = imageInfo.name || 'Unknown';
              if (binaryName.includes('/')) {
                binaryName = binaryName.split('/').pop() || binaryName;
              }
              const loadAddress = typeof imageInfo.base === 'number' 
                ? imageInfo.base 
                : (typeof imageInfo.loadAddress === 'number' ? imageInfo.loadAddress : 0);
              const imageOffset = frame.imageOffset || 0;
              const actualAddress = loadAddress + imageOffset;
              const address = `0x${actualAddress.toString(16).padStart(16, '0')}`;
              const loadAddrHex = `0x${loadAddress.toString(16)}`;
              const symbol = frame.symbol || `${loadAddrHex} + ${imageOffset}`;
              textLines.push(`${index}  ${binaryName}  ${address} ${symbol}`);
            }
          });
        }
        textLines.push('');
      });

      // 添加 Binary Images
      textLines.push('Binary Images:');
      binaryImages.forEach((img: any) => {
        const base = typeof img.base === 'number' 
          ? img.base 
          : (typeof img.loadAddress === 'number' ? img.loadAddress : 0);
        const size = img.size || 0;
        const end = base + size;
        let name = img.name || 'Unknown';
        if (name.includes('/')) {
          name = name.split('/').pop() || name;
        }
        const arch = img.arch || 'arm64';
        const uuid = img.uuid || 'N/A';
        const path = img.path || img.name || '';
        
        // 格式：0xSTART - 0xEND  name  arch  <UUID>  path
        textLines.push(`0x${base.toString(16).padStart(9, '0')} - 0x${end.toString(16).padStart(9, '0')} ${name} ${arch}  <${uuid}> ${path}`);
      });

      const result = textLines.join('\n');
      logger.info('转换完成', { 
        lineCount: textLines.length,
        resultLength: result.length,
        hasThreadCrashed: result.includes('Thread') && result.includes('Crashed'),
        hasBinaryImages: result.includes('Binary Images:'),
      });
      return result;
    } catch (error: any) {
      logger.error('转换 .ips 为文本格式失败', { error: error.message, stack: error.stack });
      // 如果转换失败，返回原始 JSON
      return originalJSON;
    }
  }

  /**
   * 将 .ips JSON 格式转换为文本格式（带符号映射，已废弃）
   */
  private convertIPSToText(
    originalJSON: string,
    stackFrames: StackFrame[],
    symbolMap: Map<string, string>
  ): string {
    try {
      const jsonData = JSON.parse(originalJSON);
      const lines: string[] = [];

      // 添加基本信息
      lines.push('Incident Identifier: ' + (jsonData.incident_id || jsonData.incidentID || 'N/A'));
      lines.push('CrashReporter Key:   ' + (jsonData.crashReporterKey || 'N/A'));
      lines.push('Hardware Model:      ' + (jsonData.modelCode || jsonData.hardwareModel || 'N/A'));
      lines.push('Process:             ' + (jsonData.procName || jsonData.app_name || 'Unknown') + ' [' + (jsonData.pid || '0') + ']');
      lines.push('Path:                ' + (jsonData.procPath || jsonData.bundlePath || 'N/A'));
      lines.push('Identifier:          ' + (jsonData.bundleID || 'N/A'));
      lines.push('Version:             ' + (jsonData.app_version || jsonData.bundleVersion || 'N/A') + ' (' + (jsonData.build_version || jsonData.bundleShortVersion || 'N/A') + ')');
      lines.push('Code Type:           ' + (jsonData.cpuType || 'ARM-64'));
      lines.push('Parent Process:      ' + (jsonData.parentProc || 'launchd') + ' [' + (jsonData.parentPid || '1') + ']');
      lines.push('');
      
      // 添加日期和时间
      lines.push('Date/Time:           ' + (jsonData.timestamp || jsonData.captureTime || new Date().toISOString()));
      lines.push('OS Version:          ' + (jsonData.os_version || jsonData.osVersion || 'iOS'));
      lines.push('Report Version:      12');
      lines.push('');

      // 添加异常信息
      if (jsonData.exception) {
        lines.push('Exception Type:      ' + (jsonData.exception.type || 'N/A'));
        lines.push('Exception Codes:     ' + (jsonData.exception.codes || 'N/A'));
        lines.push('Exception Subtype:   ' + (jsonData.exception.subtype || 'N/A'));
        if (jsonData.exception.signal) {
          lines.push('Exception Signal:    ' + jsonData.exception.signal);
        }
        lines.push('');
      }

      // 添加崩溃线程信息
      const threads = jsonData.threads || [];
      const crashedThread = threads.find((t: any) => t.triggered) || threads[0];
      
      if (crashedThread) {
        const threadIndex = threads.indexOf(crashedThread);
        lines.push(`Thread ${threadIndex} Crashed:`);
        
        // 添加堆栈帧
        if (crashedThread.frames) {
          crashedThread.frames.forEach((frame: any, index: number) => {
            const stackFrame = stackFrames.find(f => f.index === index);
            if (stackFrame) {
              const symbol = symbolMap.get(stackFrame.address);
              if (symbol) {
                lines.push(`${index}  ${stackFrame.binaryName}  ${stackFrame.address} ${symbol}`);
              } else {
                lines.push(stackFrame.line);
              }
            }
          });
        }
        lines.push('');
      }

      // 添加其他线程
      threads.forEach((thread: any, threadIndex: number) => {
        if (thread === crashedThread) return;
        
        lines.push(`Thread ${threadIndex}:`);
        if (thread.frames && thread.frames.length > 0) {
          thread.frames.slice(0, 10).forEach((frame: any, index: number) => {
            const binaryImages = jsonData.binaryImages || [];
            const imageInfo = binaryImages[frame.imageIndex];
            if (imageInfo) {
              let binaryName = imageInfo.name || 'Unknown';
              if (binaryName.includes('/')) {
                binaryName = binaryName.split('/').pop();
              }
              const loadAddress = imageInfo.base || imageInfo.loadAddress || 0;
              const imageOffset = frame.imageOffset || 0;
              const address = `0x${(loadAddress + imageOffset).toString(16)}`;
              const symbol = frame.symbol || `${loadAddress} + ${imageOffset}`;
              lines.push(`${index}  ${binaryName}  ${address} ${symbol}`);
            }
          });
        }
        lines.push('');
      });

      // 添加 Binary Images
      lines.push('Binary Images:');
      const binaryImages = jsonData.binaryImages || [];
      binaryImages.forEach((img: any) => {
        const base = img.base || img.loadAddress || 0;
        const size = img.size || 0;
        const end = base + size;
        let name = img.name || 'Unknown';
        if (name.includes('/')) {
          name = name.split('/').pop();
        }
        const arch = img.arch || 'arm64';
        const uuid = img.uuid || 'N/A';
        const path = img.path || img.name || '';
        
        lines.push(`0x${base.toString(16)} - 0x${end.toString(16)} ${name} ${arch}  <${uuid}> ${path}`);
      });

      return lines.join('\n');
    } catch (error: any) {
      logger.error('转换 .ips 为文本格式失败', { error: error.message });
      // 如果转换失败，返回原始 JSON
      return originalJSON;
    }
  }

  /**
   * 解析崩溃日志（公开方法）
   */
  parseCrashLog(content: string) {
    return this.parser.parseCrashLog(content);
  }

  /**
   * 提取堆栈地址（公开方法）
   */
  extractStackAddresses(crashLog: string): StackFrame[] {
    const parsed = this.parser.parseCrashLog(crashLog);
    return parsed.stackFrames;
  }

  /**
   * 使用 symbolicatecrash 工具符号化（适用于 .ips 文件）
   * 命令格式: symbolicatecrash your_crash.ips YourApp.app.dSYM > symbolicated.crash
   */
  private async symbolicateWithSymbolicatecrash(
    crashLog: string,
    dsymPath: string
  ): Promise<string | null> {
    const fs = require('fs');
    const os = require('os');

    try {
      // 查找 symbolicatecrash 工具
      const symbolicatecrashPath = await this.findSymbolicatecrash();
      if (!symbolicatecrashPath) {
        logger.warn('未找到 symbolicatecrash 工具');
        return null;
      }

      logger.info('找到 symbolicatecrash 工具', { path: symbolicatecrashPath });

      // 创建临时文件保存崩溃日志
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbolicate-'));
      const crashLogPath = path.join(tempDir, 'crash.ips');
      fs.writeFileSync(crashLogPath, crashLog, 'utf-8');

      // 设置环境变量
      const env = {
        ...process.env,
        DEVELOPER_DIR: await this.findDeveloperDir(),
      };

      // 构建命令：symbolicatecrash <crash.ips> <YourApp.app.dSYM>
      const command = `"${symbolicatecrashPath}" "${crashLogPath}" "${dsymPath}"`;

      logger.info('执行 symbolicatecrash 命令', { 
        command,
        dsymPath,
        crashLogSize: crashLog.length,
      });

      // 执行命令
      const { stdout, stderr } = await execAsync(command, {
        env,
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      // 清理临时文件
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn('清理临时文件失败', { tempDir, error });
      }

      // symbolicatecrash 的警告信息通常输出到 stderr，但不影响结果
      if (stderr) {
        logger.info('symbolicatecrash stderr 输出', { 
          stderr: stderr.substring(0, 500),
          hasWarning: stderr.includes('## Warning ##'),
        });
      }

      // 检查输出是否有效
      if (!stdout || stdout.trim().length === 0) {
        logger.warn('symbolicatecrash 输出为空');
        return null;
      }

      // 检查是否符号化成功（查找符号化的标志）
      // 符号化成功的标志：包含源文件位置信息
      const hasSymbols = stdout.includes('(in ') || 
                        stdout.includes('.swift:') || 
                        stdout.includes('.m:') ||
                        stdout.includes('.mm:') ||
                        stdout.includes('.c:') ||
                        stdout.includes('.cpp:');

      if (hasSymbols) {
        logger.info('symbolicatecrash 符号化成功', {
          outputLength: stdout.length,
          hasSwift: stdout.includes('.swift:'),
          hasObjC: stdout.includes('.m:'),
        });
        return stdout;
      }

      logger.warn('symbolicatecrash 输出不包含符号化信息', {
        outputPreview: stdout.substring(0, 500),
      });
      return null;
    } catch (error: any) {
      logger.error('symbolicatecrash 执行失败', { 
        error: error.message,
        stderr: error.stderr?.substring(0, 500),
        code: error.code,
      });
      return null;
    }
  }

  /**
   * 查找 symbolicatecrash 工具路径
   */
  private async findSymbolicatecrash(): Promise<string | null> {
    try {
      // symbolicatecrash 通常位于 Xcode 中
      // /Applications/Xcode.app/Contents/SharedFrameworks/DVTFoundation.framework/Versions/A/Resources/symbolicatecrash
      
      // 方法1: 使用 xcrun 查找
      try {
        const { stdout } = await execAsync('xcrun -find symbolicatecrash', {
          timeout: 5000,
        });
        const toolPath = stdout.trim();
        if (toolPath && require('fs').existsSync(toolPath)) {
          return toolPath;
        }
      } catch (error) {
        logger.warn('xcrun 查找 symbolicatecrash 失败', { error });
      }

      // 方法2: 在常见位置查找
      const possiblePaths = [
        '/Applications/Xcode.app/Contents/SharedFrameworks/DVTFoundation.framework/Versions/A/Resources/symbolicatecrash',
        '/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/Library/PrivateFrameworks/DVTFoundation.framework/Resources/symbolicatecrash',
      ];

      for (const possiblePath of possiblePaths) {
        if (require('fs').existsSync(possiblePath)) {
          return possiblePath;
        }
      }

      // 方法3: 使用 find 命令搜索
      try {
        const { stdout } = await execAsync(
          'find /Applications/Xcode.app -name symbolicatecrash 2>/dev/null | head -1',
          { timeout: 10000 }
        );
        const toolPath = stdout.trim();
        if (toolPath && require('fs').existsSync(toolPath)) {
          return toolPath;
        }
      } catch (error) {
        logger.warn('find 命令查找 symbolicatecrash 失败', { error });
      }

      return null;
    } catch (error: any) {
      logger.error('查找 symbolicatecrash 失败', { error: error.message });
      return null;
    }
  }

  /**
   * 查找 DEVELOPER_DIR（Xcode 开发者目录）
   */
  private async findDeveloperDir(): Promise<string> {
    try {
      const { stdout } = await execAsync('xcode-select -p', { timeout: 5000 });
      return stdout.trim();
    } catch (error) {
      // 默认路径
      return '/Applications/Xcode.app/Contents/Developer';
    }
  }
}
