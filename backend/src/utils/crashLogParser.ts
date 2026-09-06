/**
 * 从符号化后的崩溃日志中提取关键信息
 */

export interface CrashInfo {
  lastStackCall?: string;
  crashModule?: string;
  crashLocation?: string;
  crashType?: string;
  crashReason?: string;
  crashModuleUuid?: string;
  blockerThreadId?: string;
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
  const hangInfo = extractRunloopHangInfo(symbolicatedLog);
  if (hangInfo?.crashModule) {
    return hangInfo.crashModule;
  }

  const crashedThreadFrame = findFirstNonSystemFrame(extractCrashedThreadLines(symbolicatedLog));
  if (crashedThreadFrame) {
    return formatCrashModule(crashedThreadFrame.moduleName, crashedThreadFrame.symbolInfo);
  }
  
  // 如果没有找到 Thread Crashed，尝试查找第一个非系统库的堆栈
  const stackLines = symbolicatedLog.split('\n');
  const fallbackFrame = findFirstNonSystemFrame(stackLines);
  if (fallbackFrame) {
    return formatCrashModule(fallbackFrame.moduleName, fallbackFrame.symbolInfo);
  }
  
  return undefined;
}

function extractRunloopHangInfo(symbolicatedLog: string): Pick<CrashInfo, 'crashModule' | 'crashLocation' | 'crashModuleUuid' | 'blockerThreadId'> | undefined {
  if (!isTimedOutRunloopHang(symbolicatedLog)) {
    return undefined;
  }

  const blockerThreadId = symbolicatedLog.match(/blocked by turnstile waiting for[^\n]*\bthread\s+(0x[0-9a-f]+)/i)?.[1];
  if (!blockerThreadId) {
    return undefined;
  }

  const blockerThreadLines = extractThreadLinesById(symbolicatedLog, blockerThreadId);
  if (blockerThreadLines.length === 0) {
    return {
      crashLocation: `blocked by thread ${blockerThreadId}`,
      blockerThreadId,
    };
  }

  const blockerFrame = findFirstHangBlockerFrame(blockerThreadLines);
  if (!blockerFrame) {
    return {
      crashLocation: extractThreadName(blockerThreadLines) || `blocked by thread ${blockerThreadId}`,
      blockerThreadId,
    };
  }

  const threadName = extractThreadName(blockerThreadLines);
  const location = threadName || `blocked by thread ${blockerThreadId}`;
  const crashModule = blockerFrame.moduleName
    ? formatCrashModule(blockerFrame.moduleName, blockerFrame.symbolInfo || location)
    : `UUID:${blockerFrame.uuid}`;

  return {
    crashModule,
    crashLocation: extractClassAndMethod(blockerFrame.symbolInfo || '') || location,
    crashModuleUuid: blockerFrame.uuid,
    blockerThreadId,
  };
}

function isTimedOutRunloopHang(log: string): boolean {
  return /"bug_type"\s*:\s*"228"/i.test(log) ||
    /Event:\s*Timed Out Runloop Hang/i.test(log) ||
    /Reason:\s*UIKit-runloop-[^\n]*timeout/i.test(log);
}

function extractThreadLinesById(log: string, threadId: string): string[] {
  const escapedThreadId = threadId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = log.match(new RegExp(`(?:^|\\n)(\\s*Thread\\s+${escapedThreadId}[^\\n]*\\n[\\s\\S]*?)(?=\\n\\s*Thread\\s+0x[0-9a-f]+|\\n\\s*Binary Images:|\\s*$)`, 'i'));
  return match?.[1]?.split('\n') || [];
}

function extractThreadName(threadLines: string[]): string | undefined {
  return threadLines.join('\n').match(/Thread name "([^"]+)"/i)?.[1]?.trim();
}

function findFirstHangBlockerFrame(lines: string[]): { moduleName?: string; symbolInfo?: string; uuid?: string } | undefined {
  let firstNonSystemFrame: { moduleName?: string; symbolInfo?: string; uuid?: string } | undefined;

  for (const line of lines) {
    const uuidFrameMatch = line.match(/^\s*(?:\*?\d+)\s+.*?\(<([0-9A-F-]{36})>\s+\+\s+\d+\)/i);
    if (uuidFrameMatch) {
      return { uuid: uuidFrameMatch[1].toUpperCase() };
    }

    const namedFrameMatch = line.match(/^\s*(?:\*?\d+)\s+([^\s]+)\s+(?:0x[0-9a-f]+\s+)?([^\n]+)/i);
    if (!namedFrameMatch) {
      continue;
    }

    const moduleName = normalizeFrameModule(namedFrameMatch[1], namedFrameMatch[2]);
    if (moduleName && !isSystemModule(moduleName)) {
      const frame = {
        moduleName,
        symbolInfo: namedFrameMatch[2],
      };
      if (!firstNonSystemFrame) {
        firstNonSystemFrame = frame;
      }
      if (!isGenericThreadEntrySymbol(namedFrameMatch[2])) {
        return frame;
      }
    }
  }

  return firstNonSystemFrame;
}

function extractCrashedThreadLines(symbolicatedLog: string): string[] {
  const crashedThreadNumber = symbolicatedLog.match(/Crashed Thread:\s*(\d+)/i)?.[1];
  const nextSectionPattern = '(?=\\n\\s*\\n[ \\t]*Thread\\s+\\d+|\\n[ \\t]*Binary Images:|\\s*$)';
  const patterns = crashedThreadNumber
    ? [
        new RegExp(`(?:^|\\n)Thread\\s+${crashedThreadNumber}\\s+Crashed:?[^\\n]*\\n([\\s\\S]*?)${nextSectionPattern}`, 'i'),
        new RegExp(`(?:^|\\n)Thread\\s+${crashedThreadNumber}:?[^\\n]*\\n([\\s\\S]*?)${nextSectionPattern}`, 'i'),
      ]
    : [
        new RegExp(`(?:^|\\n)Thread\\s+\\d+\\s+Crashed:?[^\\n]*\\n([\\s\\S]*?)${nextSectionPattern}`, 'i'),
      ];

  for (const pattern of patterns) {
    const match = symbolicatedLog.match(pattern);
    if (match?.[1]) {
      return match[1].split('\n');
    }
  }

  return [];
}

function findFirstNonSystemFrame(lines: string[]): { moduleName: string; symbolInfo: string } | undefined {
  let firstDiagnosticSystemFrame: { moduleName: string; symbolInfo: string } | undefined;
  let firstPreferredFrame: { moduleName: string; symbolInfo: string } | undefined;
  let firstNonSystemFrame: { moduleName: string; symbolInfo: string } | undefined;
  let firstNonSystemFrameWithSymbol: { moduleName: string; symbolInfo: string } | undefined;

  for (const line of lines) {
    const stackMatch = line.match(/^\s*\d+\s+([^\s]+)\s+[^\s]+\s+([^\n]+)/);
    if (!stackMatch) {
      continue;
    }

    const rawModuleName = stackMatch[1];
    const symbolInfo = stackMatch[2];
    const moduleName = normalizeFrameModule(rawModuleName, symbolInfo);

    if (moduleName && isDiagnosticSystemModule(moduleName) && extractClassAndMethod(symbolInfo)) {
      firstDiagnosticSystemFrame = firstDiagnosticSystemFrame || { moduleName, symbolInfo };
      continue;
    }

    if (moduleName && !isSystemModule(moduleName)) {
      const frame = { moduleName, symbolInfo };
      if (isPreferredAppModule(moduleName)) {
        if (firstDiagnosticSystemFrame) {
          return firstDiagnosticSystemFrame;
        }
        if (extractClassAndMethod(symbolInfo)) {
          return frame;
        }
        if (!firstPreferredFrame) {
          firstPreferredFrame = frame;
        }
      }
      if (!firstNonSystemFrame) {
        firstNonSystemFrame = frame;
      }
      if (!firstNonSystemFrameWithSymbol && extractClassAndMethod(symbolInfo)) {
        firstNonSystemFrameWithSymbol = frame;
      }
    }
  }

  return firstDiagnosticSystemFrame || firstPreferredFrame || firstNonSystemFrameWithSymbol || firstNonSystemFrame;
}

function formatCrashModule(moduleName: string, symbolInfo: string): string {
  const classMethod = extractClassAndMethod(symbolInfo);
  if (classMethod) {
    return `${moduleName} - ${classMethod}`;
  }
  return moduleName;
}

function normalizeFrameModule(moduleName: string, symbolInfo: string): string | undefined {
  if (moduleName && moduleName !== '<unknown>' && moduleName !== '???') {
    return moduleName;
  }

  return symbolInfo.match(/\(in\s+([^)]+)\)/)?.[1]?.trim();
}

/**
 * 从符号信息中提取类名和方法名
 */
function extractClassAndMethod(symbolInfo: string): string | null {
  const cleanedSymbol = symbolInfo
    .replace(/\s+\(in\s+[^)]+\).*$/i, '')
    .replace(/\s+\([^)]+:\d+\)\s*$/i, '')
    .trim();

  if (!cleanedSymbol || cleanedSymbol === '<unknown>' || cleanedSymbol === '<deduplicated_symbol>') {
    return null;
  }

  // Objective-C 格式: -[ClassName methodName:] 或 +[ClassName methodName:]
  const objcMatch = cleanedSymbol.match(/^[-+]\[([^\s]+)\s+([^\]]+)\]/);
  if (objcMatch) {
    const className = objcMatch[1];
    const methodName = objcMatch[2].split(':')[0]; // 去掉参数
    return `${className}(${methodName})`;
  }

  // C++ 格式: namespace::Class::method(...) 或 namespace::function(...)
  const cppSymbol = cleanedSymbol
    .replace(/\(anonymous namespace\)::/g, '')
    .replace(/^(?:non-virtual thunk to|virtual thunk to)\s+/i, '')
    .trim();
  const cppMatch = cppSymbol.match(/^(.+?)\s*\(/);
  if (cppMatch && cppMatch[1].includes('::')) {
    const qualifiedName = cppMatch[1].trim();
    const parts = qualifiedName.split('::').filter(Boolean);
    if (parts.length >= 2) {
      const methodName = parts.pop();
      return `${parts.join('::')}(${methodName})`;
    }
    return qualifiedName;
  }
  
  // Swift 格式: ClassName.methodName() 或 functionName
  const swiftMatch = cleanedSymbol.match(/^([^\s(]+(?:\.[^\s(]+)?)\s*\(/);
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

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanedSymbol) && !isGenericEntrySymbol(cleanedSymbol)) {
    return cleanedSymbol;
  }
  
  return null;
}

/**
 * 提取崩溃类型
 * 优先提取更有意义的信息，如 Watchdog 超时、内存不足等
 */
export function extractCrashType(crashLog: string): string | undefined {
  if (isTimedOutRunloopHang(crashLog)) {
    return 'Runloop Hang';
  }

  const appHangMatch = crashLog.match(/Exception Type:\s+(App Hang[^\n]*)/i);
  if (appHangMatch) {
    return appHangMatch[1].trim();
  }

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
  if (isTimedOutRunloopHang(crashLog)) {
    const reasonMatch = crashLog.match(/Reason:\s+([^\n]+)/i);
    if (reasonMatch) {
      return reasonMatch[1].trim();
    }
  }

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
    'libxpc',
    'CoreFoundation',
    'Foundation',
    'UIKit',
    'UIKitCore',
    'ImageIO',
    'AudioSession',
    'CFNetwork',
    'Security',
    'CoreGraphics',
    'AVFoundation',
    'CoreMedia',
    'CoreVideo',
    'Metal',
    'QuartzCore',
    'libdispatch',
    'libswift',
    'dyld',
  ];
  
  return systemModules.some(sys => module.includes(sys)) ||
    (module.startsWith('lib') && module.endsWith('.dylib'));
}

function isPreferredAppModule(module: string): boolean {
  const preferredModules = moduleConfigService.getCustomModules();
  return preferredModules.some(preferred => module.toLowerCase().includes(preferred.toLowerCase()));
}

function isDiagnosticSystemModule(module: string): boolean {
  const diagnosticModules = ['ImageIO'];
  return diagnosticModules.some(preferred => module.toLowerCase().includes(preferred.toLowerCase()));
}

function isGenericEntrySymbol(symbol: string): boolean {
  return ['main', 'start', '_main', '_start'].includes(symbol.toLowerCase());
}

function isGenericThreadEntrySymbol(symbol: string): boolean {
  return /__thread_proxy|_pthread_start|pthread_start|std::__\d*::__thread_proxy/i.test(symbol);
}

/**
 * 提取崩溃位置（只提取函数名，不包含模块名）
 */
export function extractCrashLocation(symbolicatedLog: string): string | undefined {
  const hangInfo = extractRunloopHangInfo(symbolicatedLog);
  if (hangInfo?.crashLocation) {
    return hangInfo.crashLocation;
  }

  const crashedThreadFrame = findFirstNonSystemFrame(extractCrashedThreadLines(symbolicatedLog));
  if (crashedThreadFrame) {
    return extractClassAndMethod(crashedThreadFrame.symbolInfo) || undefined;
  }
  
  // 如果没有找到，尝试查找第一个非系统库的堆栈
  const stackLines = symbolicatedLog.split('\n');
  const fallbackFrame = findFirstNonSystemFrame(stackLines);
  if (fallbackFrame) {
    return extractClassAndMethod(fallbackFrame.symbolInfo) || undefined;
  }
  
  return undefined;
}

/**
 * 提取所有崩溃信息
 */
export function extractCrashInfo(originalLog: string, symbolicatedLog: string): CrashInfo {
  const hangInfo = extractRunloopHangInfo(symbolicatedLog) || extractRunloopHangInfo(originalLog);

  return {
    lastStackCall: extractLastStackCall(symbolicatedLog),
    crashModule: hangInfo?.crashModule || extractCrashModule(symbolicatedLog),
    crashLocation: hangInfo?.crashLocation || extractCrashLocation(symbolicatedLog),
    crashType: extractCrashType(originalLog),
    crashReason: extractCrashReason(originalLog),
    crashModuleUuid: hangInfo?.crashModuleUuid,
    blockerThreadId: hangInfo?.blockerThreadId,
  };
}
import { moduleConfigService } from '../services/ModuleConfigService';
