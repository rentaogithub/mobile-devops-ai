import { CrashLog, AppError, ErrorCode } from '../types';

export interface StackFrame {
  index: number;
  binaryName: string;
  address: string;
  symbol?: string;
  offset?: string;
  line: string;
}

export interface ParsedCrashLog {
  uuid?: string;
  binaryName?: string;
  loadAddress?: string;
  stackFrames: StackFrame[];
  format: 'apple' | 'ips' | 'unknown';
}

export class CrashLogParser {
  /**
   * 解析崩溃日志
   */
  parseCrashLog(content: string): ParsedCrashLog {
    // 检测日志格式
    const format = this.detectFormat(content);

    // 如果是 .ips 格式，使用 JSON 解析
    if (format === 'ips') {
      return this.parseIPSFormat(content);
    }

    // 否则使用文本格式解析
    return this.parseTextFormat(content);
  }

  /**
   * 解析 .ips JSON 格式
   */
  private parseIPSFormat(content: string): ParsedCrashLog {
    try {
      // 清理内容，移除可能的 BOM 和多余空白
      let cleanContent = content.trim();
      
      // 移除 UTF-8 BOM
      if (cleanContent.charCodeAt(0) === 0xFEFF) {
        cleanContent = cleanContent.substring(1);
      }
      
      // 尝试直接解析整个内容
      let jsonData: any = null;
      let headerData: any = null;
      
      try {
        jsonData = JSON.parse(cleanContent);
        console.log('IPS: 成功解析为单个 JSON 对象');
      } catch (parseError) {
        // 如果直接解析失败，尝试多行 JSON 格式
        console.log('IPS: 单个 JSON 解析失败，尝试多行 JSON 格式');
        const lines = cleanContent.split('\n');
        
        // 策略1: 尝试解析每一行作为独立的 JSON
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine || !trimmedLine.startsWith('{')) continue;
          
          try {
            const data = JSON.parse(trimmedLine);
            if (data.threads && (data.binaryImages || data.usedImages)) {
              console.log('IPS: 找到堆栈数据（单行 JSON）');
              jsonData = data;
              break;
            } else if (data.app_name || data.timestamp || data.incident_id) {
              console.log('IPS: 找到头部信息');
              headerData = data;
            }
          } catch {
            continue;
          }
        }
        
        // 策略2: 如果没找到堆栈数据，尝试从第一行之后的所有内容解析为一个 JSON
        if (!jsonData) {
          console.log('IPS: 尝试解析第一行之后的内容为格式化 JSON');
          
          const firstLineEnd = cleanContent.indexOf('\n');
          if (firstLineEnd > 0) {
            const remainingContent = cleanContent.substring(firstLineEnd + 1).trim();
            
            try {
              const data = JSON.parse(remainingContent);
              if (data.threads && (data.binaryImages || data.usedImages)) {
                console.log('IPS: 找到堆栈数据（格式化 JSON）');
                // 兼容 usedImages
                if (!data.binaryImages && data.usedImages) {
                  data.binaryImages = data.usedImages;
                }
                jsonData = data;
              }
            } catch (e) {
              console.log('IPS: 格式化 JSON 解析失败');
            }
          }
        }
        
        // 合并头部信息和主数据
        if (jsonData && headerData) {
          console.log('IPS: 合并头部信息和堆栈数据');
          jsonData = {
            ...headerData,
            ...jsonData,
            threads: jsonData.threads,
            binaryImages: jsonData.binaryImages,
          };
        }
        
        if (!jsonData) {
          throw new Error('未找到包含 threads 和 binaryImages 的 JSON 数据');
        }
      }

      // 记录 JSON 结构以便调试
      console.log('IPS JSON keys:', Object.keys(jsonData));
      console.log('Has threads:', !!jsonData.threads);
      console.log('Has binaryImages:', !!jsonData.binaryImages);
      
      // 提取二进制镜像信息
      const binaryImages = jsonData.binaryImages || [];
      const binaryImageMap = new Map<number, any>();
      binaryImages.forEach((img: any, index: number) => {
        binaryImageMap.set(index, img);
      });

      console.log('Binary images count:', binaryImages.length);

      // 提取堆栈帧
      const stackFrames: StackFrame[] = [];
      const threads = jsonData.threads || [];

      console.log('Threads count:', threads.length);
      if (threads.length > 0) {
        console.log('First thread keys:', Object.keys(threads[0]));
        console.log('First thread triggered:', threads[0].triggered);
      }

      // 找到崩溃的线程
      const crashedThread = threads.find((t: any) => t.triggered) || threads[0];
      if (!crashedThread || !crashedThread.frames) {
        console.log('Crashed thread:', crashedThread);
        throw new AppError(ErrorCode.INVALID_CRASH_LOG, '未找到崩溃线程的堆栈信息', 400);
      }

      // 解析堆栈帧
      crashedThread.frames.forEach((frame: any, index: number) => {
        const imageIndex = frame.imageIndex;
        const imageInfo = binaryImageMap.get(imageIndex);

        if (!imageInfo) {
          console.log(`Warning: No image info for frame ${index}, imageIndex: ${imageIndex}`);
          return;
        }

        // 提取二进制名称（从路径中提取文件名）
        let binaryName = imageInfo.name || 'Unknown';
        if (binaryName.includes('/')) {
          binaryName = binaryName.split('/').pop() || binaryName;
        }

        const imageOffset = frame.imageOffset || 0;
        const loadAddress = imageInfo.base || imageInfo.loadAddress || 0;

        // 计算实际地址
        let address: string;
        if (typeof loadAddress === 'string') {
          // 如果是字符串格式的地址
          const loadAddrNum = parseInt(loadAddress.replace('0x', ''), 16);
          address = `0x${(loadAddrNum + imageOffset).toString(16)}`;
        } else {
          // 如果是数字格式
          address = `0x${(loadAddress + imageOffset).toString(16)}`;
        }

        // 构建堆栈行（模拟文本格式）
        const symbol = frame.symbol || '';
        const line = symbol
          ? `${index}  ${binaryName}  ${address} ${symbol}`
          : `${index}  ${binaryName}  ${address} ${loadAddress} + ${imageOffset}`;

        stackFrames.push({
          index,
          binaryName,
          address,
          symbol: frame.symbol,
          offset: imageOffset.toString(),
          line,
        });
      });

      if (stackFrames.length === 0) {
        throw new AppError(ErrorCode.INVALID_CRASH_LOG, '未找到有效的堆栈信息', 400);
      }

      // 提取主应用的 UUID 和名称
      // 主应用通常是第一个二进制镜像，或者通过 procName 字段确定
      let mainImage = binaryImages[0];
      const procName = jsonData.procName || jsonData.app_name;
      
      if (procName) {
        // 尝试找到匹配进程名的二进制镜像
        const matchedImage = binaryImages.find((img: any) => {
          const imgName = img.name || '';
          return imgName.includes(procName) || imgName.endsWith(`/${procName}`);
        });
        if (matchedImage) {
          mainImage = matchedImage;
        }
      }

      const uuid = mainImage?.uuid;
      let binaryName = mainImage?.name || procName || 'Unknown';
      
      // 从路径中提取文件名
      if (binaryName.includes('/')) {
        binaryName = binaryName.split('/').pop() || binaryName;
      }

      return {
        uuid,
        binaryName,
        loadAddress: mainImage?.base || mainImage?.loadAddress,
        stackFrames,
        format: 'ips',
      };
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        ErrorCode.INVALID_CRASH_LOG,
        `解析 .ips 文件失败: ${error.message}`,
        400
      );
    }
  }

  /**
   * 解析文本格式崩溃日志
   */
  private parseTextFormat(content: string): ParsedCrashLog {
    // 提取 UUID
    const uuid = this.extractUUID(content);

    // 提取二进制名称
    const binaryName = this.extractBinaryName(content);

    // 提取加载地址
    const loadAddress = this.extractLoadAddress(content, binaryName);

    // 提取堆栈帧
    const stackFrames = this.extractStackFrames(content, binaryName);

    if (stackFrames.length === 0) {
      throw new AppError(ErrorCode.INVALID_CRASH_LOG, '未找到有效的堆栈信息', 400);
    }

    return {
      uuid,
      binaryName,
      loadAddress,
      stackFrames,
      format: 'apple',
    };
  }

  /**
   * 检测崩溃日志格式
   */
  private detectFormat(content: string): 'apple' | 'ips' | 'unknown' {
    const trimmed = content.trim();
    
    // .ips 格式通常包含 JSON 结构
    if (trimmed.startsWith('{')) {
      const firstLineEnd = trimmed.indexOf('\n');
      if (firstLineEnd > 0) {
        const remainingContent = trimmed.substring(firstLineEnd + 1);
        if (
          remainingContent.includes('Incident Identifier:') ||
          remainingContent.includes('Thread ') ||
          remainingContent.includes('Binary Images:')
        ) {
          return 'apple';
        }
      }

      // 尝试解析为 JSON
      try {
        // 清理可能的多行 JSON
        let testContent = trimmed;
        if (firstLineEnd > 0) {
          testContent = trimmed.substring(0, firstLineEnd);
        }
        
        const jsonData = JSON.parse(testContent);
        // 检查是否包含 .ips 文件的特征字段
        if (
          jsonData.app_name ||
          jsonData.bundleID ||
          jsonData.threads ||
          jsonData.binaryImages
        ) {
          return 'ips';
        }
      } catch {
        // 不是有效的 JSON，继续检查其他格式
      }
    }

    // Apple Crash Report 格式包含特定的标记
    if (
      content.includes('Incident Identifier:') ||
      content.includes('CrashReporter Key:') ||
      content.includes('Hardware Model:')
    ) {
      return 'apple';
    }

    // 检查是否包含堆栈信息
    if (content.match(/^\d+\s+\S+\s+0x[0-9a-f]+/im)) {
      return 'apple';
    }

    return 'unknown';
  }

  /**
   * 提取 UUID
   */
  private extractUUID(content: string): string | undefined {
    // Apple Crash Report 格式
    // Binary Images:
    // 0x100000000 - 0x100ffffff MyApp arm64  <uuid> /path/to/MyApp
    const binaryImagesMatch = content.match(
      /Binary Images:[\s\S]*?0x[0-9a-f]+\s+-\s+0x[0-9a-f]+\s+\S+\s+\S+\s+<([A-F0-9-]+)>/i
    );
    if (binaryImagesMatch) {
      return binaryImagesMatch[1];
    }

    // 另一种格式
    const uuidMatch = content.match(/uuid:\s*<([A-F0-9-]+)>/i);
    if (uuidMatch) {
      return uuidMatch[1];
    }

    // .ips 格式 (JSON)
    try {
      const jsonData = JSON.parse(content);
      if (jsonData.binaryImages && jsonData.binaryImages.length > 0) {
        return jsonData.binaryImages[0].uuid;
      }
    } catch {
      // 不是 JSON 格式
    }

    return undefined;
  }

  /**
   * 提取二进制名称
   */
  private extractBinaryName(content: string): string | undefined {
    // 从 Process 行提取
    const processMatch = content.match(/Process:\s+(\S+)/i);
    if (processMatch) {
      return processMatch[1];
    }

    // 从堆栈中提取（第一个非系统库）
    const stackMatch = content.match(/^\d+\s+(\S+)\s+0x[0-9a-f]+/im);
    if (stackMatch) {
      return stackMatch[1];
    }

    return undefined;
  }

  /**
   * 提取加载地址
   */
  private extractLoadAddress(content: string, binaryName?: string): string | undefined {
    if (!binaryName) {
      return undefined;
    }

    // 从 Binary Images 部分提取
    // 0x100000000 - 0x100ffffff MyApp arm64  <uuid> /path/to/MyApp
    const pattern = new RegExp(
      `(0x[0-9a-f]+)\\s+-\\s+0x[0-9a-f]+\\s+${binaryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      'i'
    );
    const match = content.match(pattern);
    if (match) {
      return match[1];
    }

    return undefined;
  }

  /**
   * 提取堆栈帧
   */
  extractStackFrames(content: string, binaryName?: string): StackFrame[] {
    const frames: StackFrame[] = [];
    const lines = content.split('\n');

    // 匹配堆栈行的正则表达式
    // 格式: 0  MyApp  0x0000000100001234 0x100000000 + 4660
    // 或: 0  MyApp  0x0000000100001234 main + 52
    const stackRegex = /^(\d+)\s+(\S+)\s+(0x[0-9a-f]+)\s+(.+)$/i;

    for (const line of lines) {
      const trimmedLine = line.trim();
      const uuidOffsetMatch = trimmedLine.match(/^(\*?\d+)\s+\?\?\?\s+\(<([0-9A-F-]{36})>\s+\+\s+(\d+)\)\s+\[(0x[0-9a-f]+)\]/i);
      if (uuidOffsetMatch) {
        const [, index, uuid, offset, address] = uuidOffsetMatch;
        frames.push({
          index: parseInt(index.replace('*', ''), 10),
          binaryName: '???',
          address,
          symbol: `<${uuid}>`,
          offset,
          line: trimmedLine,
        });
        continue;
      }

      const match = trimmedLine.match(stackRegex);
      if (match) {
        const [, index, binary, address, rest] = match;

        // 不再过滤，提取所有堆栈帧
        // 这样可以符号化所有相关的二进制文件

        // 解析符号和偏移量
        let symbol: string | undefined;
        let offset: string | undefined;

        // 格式: 0x100000000 + 4660
        const offsetMatch = rest.match(/(0x[0-9a-f]+)\s+\+\s+(\d+)/i);
        if (offsetMatch) {
          offset = offsetMatch[2];
        } else {
          // 格式: main + 52
          const symbolMatch = rest.match(/(\S+)\s+\+\s+(\d+)/);
          if (symbolMatch) {
            symbol = symbolMatch[1];
            offset = symbolMatch[2];
          }
        }

        frames.push({
          index: parseInt(index),
          binaryName: binary,
          address,
          symbol,
          offset,
          line: trimmedLine,
        });
      }
    }

    return frames;
  }

  /**
   * 提取所有需要符号化的地址
   */
  extractAddresses(stackFrames: StackFrame[]): string[] {
    return stackFrames.map((frame) => frame.address);
  }
}
