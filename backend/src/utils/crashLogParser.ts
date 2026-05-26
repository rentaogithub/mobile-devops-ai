/**
 * 从符号化后的崩溃日志中提取关键信息
 */

export interface CrashInfo {
  lastStackCall?: string;
  crashModule?: string;
  crashLocation?: string;
  crashType?: string;
  crashReason?: string;
}

/**
 * 提取最后的堆栈调用名
 * 从 Thread 0 Crashed 的第一行提取函数名
 * 注意：这个字段已被 crashModule 替代，保留是为了向后兼容
 */
export function extractLastStackCall(symbolicatedLog: string): string | undefined {
  // 由于 crashModule 已经包含了详细的类名和方法名信息
  // 这个字段不再需要，返回 undefined
  // 保留函数是为了向后兼容
  return undefined;
}

/**
 * 提取崩溃模块和位置
 * 从 Thread 0 Crashed 的第一行提取模块名、类名和方法名
 * 格式：NNIM - ClassName(methodName)
 */
export function extractCrashModule(symbolicatedLog: string): string | undefined {
  // 查找 "Thread 0 Crashed:" 后的第一行堆栈
  const threadCrashedMatch = symbolicatedLog.match(/Thread \d+ Crashed:?\s*\n\s*\d+\s+([^\s]+)\s+[^\s]+\s+([^\n]+)/i);
  
  if (threadCrashedMatch) {
    const moduleName = threadCrashedMatch[1];
    const symbolInfo = threadCrashedMatch[2];
    
    // 如果不是系统模块，尝试提取类名和方法名
    if (!isSystemModule(moduleName)) {
      const classMethod = extractClassAndMethod(symbolInfo);
      if (classMethod) {
        return `${moduleName} - ${classMethod}`;
      }
      return moduleName;
    }
  }
  
  // 如果没有找到 Thread Crashed，尝试查找第一个非系统库的堆栈
  const stackLines = symbolicatedLog.split('\n');
  for (const line of stackLines) {
    const stackMatch = line.match(/^\s*\d+\s+([^\s]+)\s+[^\s]+\s+([^\n]+)/);
    if (stackMatch) {
      const moduleName = stackMatch[1];
      const symbolInfo = stackMatch[2];
      
      if (!isSystemModule(moduleName)) {
        const classMethod = extractClassAndMethod(symbolInfo);
        if (classMethod) {
          return `${moduleName} - ${classMethod}`;
        }
        return moduleName;
      }
    }
  }
  
  return undefined;
}

/**
 * 从符号信息中提取类名和方法名
 */
function extractClassAndMethod(symbolInfo: string): string | null {
  // Objective-C 格式: -[ClassName methodName:] 或 +[ClassName methodName:]
  const objcMatch = symbolInfo.match(/^[-+]\[([^\s]+)\s+([^\]]+)\]/);
  if (objcMatch) {
    const className = objcMatch[1];
    const methodName = objcMatch[2].split(':')[0]; // 去掉参数
    return `${className}(${methodName})`;
  }
  
  // Swift 格式: ClassName.methodName() 或 functionName
  const swiftMatch = symbolInfo.match(/^([^\s(]+(?:\.[^\s(]+)?)\s*\(/);
  if (swiftMatch) {
    const parts = swiftMatch[1].split('.');
    if (parts.length >= 2) {
      const className = parts[0];
      const methodName = parts.slice(1).join('.');
      
      // 检查是否是扩展方法
      const systemClasses = ['UIImageView', 'UIView', 'UIViewController', 'UITableView', 'UICollectionView'];
      if (systemClasses.some(cls => className.includes(cls))) {
        return `${className}+Extension(${methodName})`;
      }
      
      return `${className}(${methodName})`;
    }
  }
  
  return null;
}

/**
 * 提取崩溃类型
 * 优先提取更有意义的信息，如 Watchdog 超时、内存不足等
 */
export function extractCrashType(crashLog: string): string | undefined {
  // 方法1: 检查是否是 Watchdog 超时
  if (crashLog.includes('watchdog') || crashLog.includes('0x8BADF00D')) {
    return 'Watchdog 超时';
  }
  
  // 方法2: 检查是否是内存不足
  if (crashLog.includes('memory') && crashLog.includes('jetsam')) {
    return '内存不足';
  }
  
  // 方法3: Termination Reason（更详细的信息）
  const terminationMatch = crashLog.match(/Termination Reason:\s+([^\n]+)/i);
  if (terminationMatch) {
    const reason = terminationMatch[1].trim();
    // 简化显示
    if (reason.includes('FRONTBOARD')) {
      return 'FRONTBOARD 终止';
    }
    return reason.length > 50 ? reason.substring(0, 50) + '...' : reason;
  }
  
  // 方法4: Exception Type
  const exceptionTypeMatch = crashLog.match(/Exception Type:\s+([^\s\n(]+)(?:\s+\(([^)]+)\))?/i);
  if (exceptionTypeMatch) {
    const excType = exceptionTypeMatch[1];
    const excSignal = exceptionTypeMatch[2];
    
    // 如果有信号，优先显示信号
    if (excSignal) {
      return excSignal;
    }
    return excType;
  }
  
  // 方法5: Signal
  const signalMatch = crashLog.match(/Signal:\s+([^\s\n(]+)/i);
  if (signalMatch) {
    return signalMatch[1];
  }
  
  return undefined;
}

/**
 * 提取崩溃原因
 */
export function extractCrashReason(crashLog: string): string | undefined {
  // 方法1: Exception Subtype
  const subtypeMatch = crashLog.match(/Exception Subtype:\s+([^\n]+)/i);
  if (subtypeMatch) {
    return subtypeMatch[1].trim();
  }
  
  // 方法2: Exception Message
  const messageMatch = crashLog.match(/Exception Message:\s+([^\n]+)/i);
  if (messageMatch) {
    return messageMatch[1].trim();
  }
  
  // 方法3: Termination Description
  const descMatch = crashLog.match(/Termination Description:\s+([^\n]+)/i);
  if (descMatch) {
    return descMatch[1].trim();
  }
  
  // 方法4: Application Specific Information
  const appInfoMatch = crashLog.match(/Application Specific Information:\s*\n([^\n]+)/i);
  if (appInfoMatch) {
    return appInfoMatch[1].trim();
  }
  
  return undefined;
}

/**
 * 判断是否是系统模块
 */
function isSystemModule(module: string): boolean {
  const systemModules = [
    'libsystem',
    'libobjc',
    'CoreFoundation',
    'Foundation',
    'UIKit',
    'UIKitCore',
    'QuartzCore',
    'libdispatch',
    'libswift',
    'dyld',
  ];
  
  return systemModules.some(sys => module.includes(sys));
}

/**
 * 提取崩溃位置（只提取函数名，不包含模块名）
 */
export function extractCrashLocation(symbolicatedLog: string): string | undefined {
  // 查找 "Thread 0 Crashed:" 后的第一行堆栈
  const threadCrashedMatch = symbolicatedLog.match(/Thread \d+ Crashed:?\s*\n\s*\d+\s+([^\s]+)\s+[^\s]+\s+([^\n]+)/i);
  
  if (threadCrashedMatch) {
    const moduleName = threadCrashedMatch[1];
    const symbolInfo = threadCrashedMatch[2];
    
    if (!isSystemModule(moduleName)) {
      const classMethod = extractClassAndMethod(symbolInfo);
      if (classMethod) {
        return classMethod;
      }
    }
  }
  
  // 如果没有找到，尝试查找第一个非系统库的堆栈
  const stackLines = symbolicatedLog.split('\n');
  for (const line of stackLines) {
    const stackMatch = line.match(/^\s*\d+\s+([^\s]+)\s+[^\s]+\s+([^\n]+)/);
    if (stackMatch) {
      const moduleName = stackMatch[1];
      const symbolInfo = stackMatch[2];
      
      if (!isSystemModule(moduleName)) {
        const classMethod = extractClassAndMethod(symbolInfo);
        if (classMethod) {
          return classMethod;
        }
      }
    }
  }
  
  return undefined;
}

/**
 * 提取所有崩溃信息
 */
export function extractCrashInfo(originalLog: string, symbolicatedLog: string): CrashInfo {
  return {
    lastStackCall: extractLastStackCall(symbolicatedLog),
    crashModule: extractCrashModule(symbolicatedLog),
    crashLocation: extractCrashLocation(symbolicatedLog),
    crashType: extractCrashType(originalLog),
    crashReason: extractCrashReason(originalLog),
  };
}
