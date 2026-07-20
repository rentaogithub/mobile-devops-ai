import axios, { AxiosError } from 'axios';
import logger from '../utils/logger';

export interface CrashAnalysis {
  summary: string;
  crashType: string;
  possibleCauses: string[];
  suggestions: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedComponents: string[];
  appVersion?: string; // 主应用版本号
  crashThread?: string; // 崩溃线程
  crashModule?: string; // 崩溃模块
  crashStack?: string; // 崩溃堆栈快照
  crashLocation?: string; // 崩溃位置（类名、方法名）
  crashFile?: string; // 崩溃文件名
  crashLine?: number; // 崩溃行号
}

export interface AggregateCrashIssueInput {
  id: string;
  shortId?: string;
  title: string;
  count?: string;
  userCount?: number;
  level?: string;
  appVersionRange?: string;
  eventId?: string;
  analysisLog: string;
}

export interface AggregateCrashPattern {
  title: string;
  issueIds: string[];
  sharedSymptoms: string[];
  commonStackSignals: string[];
  possibleRootCause: string;
  confidence: 'low' | 'medium' | 'high';
  evidence: string[];
}

export interface AggregateCrashAnalysis {
  summary: string;
  conclusion: string;
  confidence: 'low' | 'medium' | 'high';
  patterns: AggregateCrashPattern[];
  suspectedRootCauses: string[];
  verificationSteps: string[];
  fixSuggestions: string[];
  needsMoreData: string[];
}

export interface BuildFailureAnalysis {
  summary: string;
  stage: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  rootCause: string;
  evidence: string[];
  suggestions: string[];
  ownerHint?: string;
  needsManualAction?: boolean;
}

/**
 * OpenAI AI 崩溃分析服务
 */
export class AIAnalysisService {
  private readonly openAIEndpoint: string;
  private readonly openAIModel: string;
  private readonly openAIAPIStyle: 'responses' | 'chat_completions';
  private readonly timeout: number;
  private readonly maxOutputTokens: number;

  constructor() {
    this.openAIEndpoint = (
      process.env.OPENAI_API_ENDPOINT ||
      process.env.OPENAI_BASE_URL ||
      'https://api.openai.com/v1'
    ).replace(/\/+$/, '');
    this.openAIModel = process.env.OPENAI_MODEL || 'gpt-5.1';
    this.openAIAPIStyle = this.normalizeOpenAIAPIStyle(process.env.OPENAI_API_STYLE);
    this.timeout = parseInt(process.env.AI_ANALYSIS_TIMEOUT || '90000', 10);
    this.maxOutputTokens = parseInt(process.env.AI_ANALYSIS_MAX_OUTPUT_TOKENS || '900', 10);
  }

  /**
   * 分析符号化后的崩溃日志
   * @param symbolicatedLog 符号化后的崩溃日志
   * @param apiKey API Key
   * @param fallbackAppVersion 备用的应用版本号（从 dSYM 获取）
   */
  async analyzeCrashLog(
    symbolicatedLog: string, 
    apiKey: string,
    fallbackAppVersion?: string
  ): Promise<CrashAnalysis> {
    try {
      // 优先使用环境变量中的 Key；如果鉴权失败，再回退到本次请求传入的 Key。
      const candidateApiKeys = this.getCandidateAPIKeys(apiKey);
      
      logger.info('开始 AI 分析崩溃日志', { fallbackAppVersion });

      if (candidateApiKeys.length === 0) {
        throw new Error('API Key 不能为空');
      }

      // 提取基本信息
      const basicInfo = this.extractBasicInfo(symbolicatedLog);
      
      logger.info('提取的基本信息', { 
        extractedVersion: basicInfo.appVersion,
        fallbackVersion: fallbackAppVersion,
        crashModule: basicInfo.crashModule,
        crashLocation: basicInfo.crashLocation
      });

      // 优先使用 dSYM 中的版本号（更准确），如果没有才使用崩溃日志中的版本
      if (fallbackAppVersion) {
        basicInfo.appVersion = fallbackAppVersion;
        logger.info('使用 dSYM 中的版本号', { version: fallbackAppVersion });
      } else if (!basicInfo.appVersion) {
        logger.warn('未找到应用版本号');
      }

      // 构建分析提示词（包含崩溃位置信息）
      const prompt = this.buildAnalysisPrompt(symbolicatedLog, {
        crashLocation: basicInfo.crashLocation,
        crashModule: basicInfo.crashModule,
        crashStack: basicInfo.crashStack
      });

      // 调用 AI API
      const response = await this.callAIAPIWithFallback(prompt, candidateApiKeys);

      // 解析 AI 响应
      const analysis = this.parseAIResponse(response);

      // 合并基本信息
      analysis.appVersion = basicInfo.appVersion;
      analysis.crashThread = basicInfo.crashThread;
      analysis.crashModule = basicInfo.crashModule;
      analysis.crashStack = basicInfo.crashStack;
      analysis.crashLocation = basicInfo.crashLocation;

      logger.info('AI 分析完成', { 
        crashType: analysis.crashType, 
        severity: analysis.severity,
        appVersion: analysis.appVersion,
        crashThread: analysis.crashThread,
        crashModule: analysis.crashModule,
        crashLocation: analysis.crashLocation
      });
      return analysis;
    } catch (error: any) {
      logger.error('AI 分析失败', { error: error.message });
      throw error;
    }
  }

  async analyzeAggregateCrashes(
    issues: AggregateCrashIssueInput[],
    apiKey: string
  ): Promise<AggregateCrashAnalysis> {
    const candidateApiKeys = this.getCandidateAPIKeys(apiKey);
    if (candidateApiKeys.length === 0) {
      throw new Error('API Key 不能为空');
    }
    if (issues.length === 0) {
      throw new Error('请选择要聚合分析的 Sentry 问题');
    }

    logger.info('开始 AI 聚合分析 Sentry 崩溃', { issueCount: issues.length });

    const prompt = this.buildAggregateAnalysisPrompt(issues);
    const response = await this.callAIAPIWithFallback(prompt, candidateApiKeys);
    return this.parseAggregateAIResponse(response);
  }

  async analyzeBuildFailureLog(input: {
    log: string;
    buildNumber?: number;
    branchName?: string;
    publishChannel?: string;
    appVersion?: string;
    commitHash?: string;
  }, apiKey = ''): Promise<BuildFailureAnalysis> {
    const candidateApiKeys = this.getCandidateAPIKeys(apiKey);
    if (candidateApiKeys.length === 0) {
      throw new Error('API Key 不能为空');
    }

    const compactLog = this.buildCompactBuildFailureLog(input.log);
    const systemPrompt = `你是 iOS CI/CD 打包发布故障分析助手。请分析 Jenkins 构建日志，输出严格 JSON，不要 Markdown。

输出字段：
{
  "summary": "一句话说明失败原因",
  "stage": "失败阶段，如 编译/签名/导出IPA/上传TestFlight/上传蒲公英/Jenkins后处理/未知",
  "severity": "low|medium|high|critical",
  "rootCause": "最可能根因，要求具体、可执行",
  "evidence": ["日志证据1", "日志证据2"],
  "suggestions": ["处理建议1", "处理建议2"],
  "ownerHint": "建议处理方，如 iOS/发布管理员/Apple开发者账号管理员/Jenkins维护",
  "needsManualAction": true
}

判断规则：
- 优先定位第一个导致构建失败的关键错误，不要被后续 Jenkins 后处理日志干扰。
- 对 TestFlight/App Store 上传失败，要重点判断 Apple 协议、账号、证书、ASC 构建号、网络/API 错误。
- 对蒲公英失败，要判断上传接口、包路径、二维码/渠道构建号解析问题。
- 对编译失败，要指出可能的模块、文件、脚本或依赖。
- evidence 只引用最关键的 2-5 条短日志。`;

    const userPrompt = `构建信息：
- Jenkins 构建号：${input.buildNumber || ''}
- 分支：${input.branchName || ''}
- 发布渠道：${input.publishChannel || ''}
- APP 版本：${input.appVersion || ''}
- Commit：${input.commitHash || ''}

关键日志：
${compactLog}`;

    logger.info('开始 AI 分析 Jenkins 构建失败日志', {
      buildNumber: input.buildNumber,
      publishChannel: input.publishChannel,
      branchName: input.branchName,
      logLength: input.log.length,
      compactLength: compactLog.length,
    });

    const response = await this.callAIAPIWithFallback(JSON.stringify({ systemPrompt, userPrompt }), candidateApiKeys);
    return this.parseBuildFailureAIResponse(response);
  }

  /**
   * Workflow 平台通用结构化 AI 能力。
   * 上层负责定义 JSON Schema 语义，本方法只负责调用模型并返回可解析对象。
   */
  async runStructuredAnalysis<T extends Record<string, any>>(input: {
    systemPrompt: string;
    userPrompt: string;
    apiKey?: string;
    fallback: T;
  }): Promise<T> {
    const candidateApiKeys = this.getCandidateAPIKeys(input.apiKey);
    if (candidateApiKeys.length === 0) {
      return input.fallback;
    }

    const response = await this.callAIAPIWithFallback(JSON.stringify({
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
    }), candidateApiKeys);

    try {
      let jsonStr = response.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) jsonStr = codeBlockMatch[1];
      if (!codeBlockMatch) {
        const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (objectMatch) jsonStr = objectMatch[0];
      }
      const parsed = JSON.parse(jsonStr);
      return parsed && typeof parsed === 'object' ? parsed as T : input.fallback;
    } catch (error: any) {
      logger.warn('Workflow 结构化 AI 响应解析失败，使用规则结果', { error: error.message });
      return input.fallback;
    }
  }

  /**
   * 从崩溃日志中提取基本信息
   */
  private extractBasicInfo(crashLog: string): {
    appVersion?: string;
    crashThread?: string;
    crashModule?: string;
    crashStack?: string;
    crashLocation?: string;
    crashFile?: string;
    crashLine?: number;
  } {
    const info: {
      appVersion?: string;
      crashThread?: string;
      crashModule?: string;
      crashStack?: string;
      crashLocation?: string;
      crashFile?: string;
      crashLine?: number;
    } = {};

    // 提取应用版本号
    // 优先从 Binary Images 部分提取主应用的版本
    // 格式: 0x100000000 - 0x100ffffff NNIM arm64 <uuid> /var/containers/Bundle/Application/.../NNIM.app/NNIM (5.12.0)
    const binaryImageMatch = crashLog.match(/Binary Images:[\s\S]*?0x[0-9a-f]+\s+-\s+0x[0-9a-f]+\s+\S+\s+\S+\s+<[^>]+>\s+[^\n]*\(([^\)]+)\)/i);
    if (binaryImageMatch) {
      info.appVersion = binaryImageMatch[1];
    }
    
    // 如果没找到，尝试从 Version 字段提取（但要排除 OS Version）
    if (!info.appVersion) {
      // 查找 Version: 但不是 OS Version:
      const versionMatch = crashLog.match(/(?<!OS\s)Version:\s+([^\s(]+)/);
      if (versionMatch) {
        info.appVersion = versionMatch[1];
      }
    }
    
    // 最后尝试 CFBundleShortVersionString
    if (!info.appVersion) {
      const bundleVersionMatch = crashLog.match(/CFBundleShortVersionString:\s+([^\s\n]+)/);
      if (bundleVersionMatch) {
        info.appVersion = bundleVersionMatch[1];
      }
    }

    // 提取崩溃线程
    // 格式: Crashed Thread: 0 或 Thread 0 Crashed:
    const threadMatch = crashLog.match(/Crashed Thread:\s+(\d+)|Thread\s+(\d+)\s+Crashed/i);
    if (threadMatch) {
      const threadNum = threadMatch[1] || threadMatch[2];
      info.crashThread = `Thread ${threadNum}`;
    }

    // 提取崩溃模块（优先选择自己管理的模块，格式：模块名 - 类名.方法名）
    // 查找崩溃线程的堆栈
    if (info.crashThread) {
      const threadNum = info.crashThread.replace('Thread ', '');
      const threadPattern = new RegExp(`Thread\\s+${threadNum}[^\\n]*Crashed[^\\n]*\\n([\\s\\S]*?)(?=\\n\\nThread|\\n\\n[A-Z]|$)`, 'i');
      const threadMatch = crashLog.match(threadPattern);
      
      if (threadMatch) {
        const stackLines = threadMatch[1].split('\n');
        let firstNonSystemModule: string | null = null;
        
        // 遍历所有堆栈帧，找到第一个自己的模块
        for (const line of stackLines) {
          const frameMatch = line.match(/^\s*\d+\s+([^\s]+)\s+0x[0-9a-f]+\s+(.+)$/i);
          
          if (frameMatch) {
            const moduleName = frameMatch[1];
            const symbolInfo = frameMatch[2];
            
            if (!this.isSystemLibrary(moduleName)) {
              // 记录第一个非系统库模块（只保存模块名）
              if (!firstNonSystemModule) {
                firstNonSystemModule = moduleName;
              }
              
              // 如果是自己的模块，直接使用它
              if (this.isOurModule(moduleName)) {
                const classMethod = this.extractClassAndMethod(symbolInfo);
                if (classMethod) {
                  info.crashModule = `${moduleName} - ${classMethod}`;
                } else {
                  info.crashModule = moduleName;
                }
                break;
              }
            }
          }
        }
        
        // 如果没有找到自己的模块，使用第一个非系统库模块（只显示模块名）
        if (!info.crashModule && firstNonSystemModule) {
          info.crashModule = firstNonSystemModule;
        }
      }
    }

    // 提取崩溃堆栈快照（显示到自己的模块为止，最多30行）
    if (info.crashThread) {
      const threadNum = info.crashThread.replace('Thread ', '');
      const threadPattern = new RegExp(`Thread\\s+${threadNum}[^\\n]*Crashed[^\\n]*\\n([\\s\\S]*?)(?=\\n\\nThread|\\n\\n[A-Z]|$)`, 'i');
      const threadMatch = crashLog.match(threadPattern);
      
      if (threadMatch) {
        const stackLines = threadMatch[1].split('\n').filter(line => line.trim());
        const snapshotLines: string[] = [];
        let foundOurModule = false;
        
        // 遍历堆栈，直到找到自己的模块后再多显示几行
        for (let i = 0; i < Math.min(stackLines.length, 30); i++) {
          const line = stackLines[i];
          snapshotLines.push(line);
          
          // 检查是否是自己的模块
          const frameMatch = line.match(/^\s*\d+\s+([^\s]+)/);
          if (frameMatch) {
            const moduleName = frameMatch[1];
            if (this.isOurModule(moduleName)) {
              foundOurModule = true;
              // 找到自己的模块后，再多显示2行上下文
              const remainingLines = stackLines.slice(i + 1, i + 3);
              snapshotLines.push(...remainingLines);
              break;
            }
          }
        }
        
        // 如果没有找到自己的模块，则显示前15行
        const snapshot = foundOurModule 
          ? snapshotLines.join('\n')
          : stackLines.slice(0, 15).join('\n');
          
        if (snapshot) {
          info.crashStack = snapshot;
        }

        // 提取崩溃位置（优先选择最后一个来自我们自己模块的堆栈帧）
        let lastOurModuleLocation: {
          location?: string;
        } | null = null;
        
        let firstNonSystemLocation: {
          location?: string;
        } | null = null;
        
        for (const line of stackLines) {
          const frameMatch = line.match(/^\s*\d+\s+([^\s]+)\s+0x[0-9a-f]+\s+(.+)$/i);
          if (frameMatch) {
            const moduleName = frameMatch[1];
            const symbolInfo = frameMatch[2];
            
            // 只处理非系统库的堆栈帧
            if (!this.isSystemLibrary(moduleName)) {
              // 提取符号信息（只提取位置，不提取文件和行号）
              const locationInfo: {
                location?: string;
              } = {};
              
              // 提取类名和方法名
              // Objective-C 格式: -[ClassName methodName:] 或 +[ClassName methodName:]
              const objcMatch = symbolInfo.match(/^[-+]\[([^\s]+)\s+([^\]]+)\]/);
              if (objcMatch) {
                const className = objcMatch[1];
                const methodName = objcMatch[2];
                locationInfo.location = `${className}.${methodName}`;
              } else {
                // Swift 格式: ClassName.methodName() 或 functionName
                const swiftMatch = symbolInfo.match(/^([^\s(]+(?:\.[^\s(]+)?)\s*\(/);
                if (swiftMatch) {
                  locationInfo.location = swiftMatch[1];
                } else {
                  // 如果都不匹配，使用整个符号信息（去掉文件位置部分）
                  const cleanSymbol = symbolInfo.replace(/\s*\([^)]+\)\s*$/, '').trim();
                  if (cleanSymbol) {
                    locationInfo.location = cleanSymbol;
                  }
                }
              }
              
              // 如果是我们自己的模块（NNIM、NNRtc、leigod_im_cross_sdk），记录为最后一个
              // 但排除通用的入口函数（main、start 等）
              if (this.isOurModule(moduleName) && locationInfo.location) {
                const isGenericEntry = ['main', 'start', '_main', '_start'].includes(locationInfo.location.toLowerCase());
                if (!isGenericEntry) {
                  lastOurModuleLocation = locationInfo;
                }
              }
              
              // 记录第一个非系统库的位置（作为备选，但也排除通用入口函数）
              if (!firstNonSystemLocation && locationInfo.location) {
                const isGenericEntry = ['main', 'start', '_main', '_start'].includes(locationInfo.location.toLowerCase());
                if (!isGenericEntry) {
                  firstNonSystemLocation = locationInfo;
                }
              }
            }
          }
        }
        
        // 优先使用我们自己模块的最后一个位置，否则使用第一个非系统库的位置
        const selectedLocation = lastOurModuleLocation || firstNonSystemLocation;
        if (selectedLocation) {
          info.crashLocation = selectedLocation.location;
        }
      }
    }

    return info;
  }

  /**
   * 判断是否是系统库
   */
  private isSystemLibrary(moduleName: string): boolean {
    const systemLibraries = [
      'UIKit',
      'UIKitCore',
      'Foundation',
      'CoreFoundation',
      'libobjc.A.dylib',
      'libsystem_kernel.dylib',
      'libsystem_pthread.dylib',
      'libdispatch.dylib',
      'CoreGraphics',
      'QuartzCore',
      'CoreAnimation',
      'AVFoundation',
      'CoreMedia',
      'CoreVideo',
      'Metal',
      'MetalKit',
      'libswiftCore.dylib',
      'libswiftFoundation.dylib',
      'libswiftUIKit.dylib',
      'CFNetwork',
      'Security',
      'SystemConfiguration',
      'libsystem_c.dylib',
      'libsystem_malloc.dylib',
      'libsystem_blocks.dylib',
      'libsystem_platform.dylib',
      'libc++.1.dylib',
      'libc++abi.dylib',
      'GraphicsServices',
      'FrontBoardServices',
      'SpringBoardServices',
      'BackBoardServices',
      'BaseBoard',
      'RunningBoardServices',
    ];

    // 检查是否完全匹配或以系统库名称开头
    return systemLibraries.some(lib => 
      moduleName === lib || 
      moduleName.startsWith(lib + '.') ||
      moduleName.startsWith('lib') && moduleName.endsWith('.dylib')
    );
  }

  /**
   * 判断是否是我们自己的模块
   */
  private isOurModule(moduleName: string): boolean {
    // 从配置服务中获取自定义模块列表
    const { moduleConfigService } = require('./ModuleConfigService');
    const ourModules = moduleConfigService.getCustomModules();
    
    return ourModules.some((mod: string) => 
      moduleName.toLowerCase().includes(mod.toLowerCase())
    );
  }

  /**
   * 从符号信息中提取类名和方法名
   * 返回格式化的字符串，如 "ClassName(methodName)" 或 "ClassName+Extension(methodName)"
   */
  private extractClassAndMethod(symbolInfo: string): string | null {
    let className = '';
    let methodName = '';
    let isExtension = false;
    
    // Objective-C 格式: -[ClassName methodName:] 或 +[ClassName methodName:]
    const objcMatch = symbolInfo.match(/^[-+]\[([^\s]+)\s+([^\]]+)\]/);
    if (objcMatch) {
      className = objcMatch[1];
      methodName = objcMatch[2];
    } else {
      // Swift 格式: ClassName.methodName() 或 functionName
      const swiftMatch = symbolInfo.match(/^([^\s(]+(?:\.[^\s(]+)?)\s*\(/);
      if (swiftMatch) {
        const parts = swiftMatch[1].split('.');
        if (parts.length >= 2) {
          className = parts[0];
          methodName = parts.slice(1).join('.');
          
          // 检查是否是扩展方法（通常以特定前缀开头，如 nn_、custom_ 等）
          // 或者类名是系统类（UIImageView、UIView 等）
          const systemClasses = ['UIImageView', 'UIView', 'UIViewController', 'UITableView', 'UICollectionView', 'UIButton', 'UILabel', 'UITextField'];
          if (systemClasses.some(cls => className.includes(cls))) {
            isExtension = true;
          }
        } else {
          methodName = swiftMatch[1];
        }
      }
    }
    
    // 检查是否是通用入口函数
    const isGenericEntry = ['main', 'start', '_main', '_start'].includes(methodName.toLowerCase());
    if (isGenericEntry) {
      return null;
    }
    
    // 提取方法名的主要部分（去掉参数）
    const methodMainName = methodName.split('(')[0].split(':')[0];
    
    if (className && methodMainName) {
      if (isExtension) {
        return `${className}+Extension(${methodMainName})`;
      } else {
        return `${className}(${methodMainName})`;
      }
    } else if (methodMainName) {
      return methodMainName;
    }
    
    return null;
  }

  /**
   * 构建分析提示词
   */
  private buildAnalysisPrompt(symbolicatedLog: string, crashInfo?: {
    crashLocation?: string;
    crashModule?: string;
    crashStack?: string;
  }): string {
    const systemPrompt = `你是一个专业的 iOS 崩溃日志分析专家。你的任务是分析符号化后的崩溃日志，并提供详细的分析结果。

请按照以下 JSON 格式返回分析结果：
{
  "summary": "简短的崩溃总结（1-2句话）",
  "crashType": "崩溃类型（如：内存访问错误、程序异常终止等）",
  "possibleCauses": ["可能原因1", "可能原因2"],
  "suggestions": ["修复建议1", "修复建议2"],
  "severity": "严重程度（low/medium/high/critical）",
  "affectedComponents": ["受影响的组件1", "受影响的组件2"]
}

分析要点：
1. 识别崩溃类型（EXC_BAD_ACCESS、SIGABRT、SIGSEGV 等）
2. 分析堆栈信息，找出崩溃发生的位置
3. 根据异常类型和堆栈推断可能的原因
4. 提供具体的修复建议，每类最多 2 条，避免长篇解释
5. 评估崩溃的严重程度
6. 识别受影响的系统组件或模块

请只返回 JSON 格式的结果，不要包含其他文字说明。`;

    let crashLocationInfo = '';
    if (crashInfo) {
      crashLocationInfo = '\n\n**崩溃位置信息**：\n';
      if (crashInfo.crashModule) {
        crashLocationInfo += `- 崩溃模块：${crashInfo.crashModule}\n`;
      }
      if (crashInfo.crashLocation) {
        crashLocationInfo += `- 崩溃位置：${crashInfo.crashLocation}\n`;
      }
    }

    const compactCrashLog = this.buildCompactCrashLogForAI(symbolicatedLog, crashInfo?.crashStack);
    logger.info('AI 分析输入已压缩', {
      originalLength: symbolicatedLog.length,
      compactLength: compactCrashLog.length,
    });

    const userPrompt = `请分析以下符号化后的 iOS 崩溃日志：
${crashLocationInfo}
\`\`\`
${compactCrashLog}
\`\`\`

请返回 JSON 格式的分析结果。`;

    return JSON.stringify({
      systemPrompt,
      userPrompt,
    });
  }

  private buildCompactCrashLogForAI(symbolicatedLog: string, crashStack?: string): string {
    const sections: string[] = [];
    const header = symbolicatedLog
      .split(/\n\s*\n/)
      .slice(0, 2)
      .join('\n\n')
      .trim();
    if (header) {
      sections.push(header.substring(0, 1800));
    }

    const exceptionBlock = this.extractNamedBlock(symbolicatedLog, [
      /^Exception Type:/im,
      /^Exception Codes:/im,
      /^Termination Reason:/im,
      /^Triggered by Thread:/im,
      /^Crashed Thread:/im,
      /^Last Exception Backtrace:/im,
    ]);
    if (exceptionBlock) {
      sections.push(`异常信息：\n${exceptionBlock}`);
    }

    if (crashStack) {
      sections.push(`崩溃线程关键堆栈：\n${crashStack.substring(0, 3500)}`);
    } else {
      const crashedThread = this.extractCrashedThreadBlock(symbolicatedLog);
      if (crashedThread) {
        sections.push(`崩溃线程关键堆栈：\n${crashedThread.substring(0, 3500)}`);
      }
    }

    const binaryImages = symbolicatedLog.match(/Binary Images:\n([\s\S]*)$/i)?.[0];
    if (binaryImages) {
      const appImages = binaryImages
        .split('\n')
        .filter((line) => /NNIM|nnios|Runner|\.app\//i.test(line))
        .slice(0, 12)
        .join('\n');
      if (appImages) {
        sections.push(`相关 Binary Images：\n${appImages.substring(0, 1200)}`);
      }
    }

    return sections.join('\n\n---\n\n').substring(0, 6000);
  }

  private extractNamedBlock(crashLog: string, patterns: RegExp[]): string {
    return crashLog
      .split('\n')
      .filter((line) => patterns.some((pattern) => pattern.test(line)))
      .slice(0, 30)
      .join('\n');
  }

  private extractCrashedThreadBlock(crashLog: string): string {
    const crashedThreadMatch = crashLog.match(/Thread\s+\d+\s+Crashed:[\s\S]*?(?=\n\nThread\s+\d+|\n\nBinary Images:|$)/i);
    if (crashedThreadMatch) {
      return crashedThreadMatch[0];
    }

    const crashedThreadNumber = crashLog.match(/Crashed Thread:\s+(\d+)/i)?.[1];
    if (!crashedThreadNumber) {
      return '';
    }

    return crashLog.match(new RegExp(`Thread\\s+${crashedThreadNumber}[^\\n]*[\\s\\S]*?(?=\\n\\nThread\\s+\\d+|\\n\\nBinary Images:|$)`, 'i'))?.[0] || '';
  }

  private buildAggregateAnalysisPrompt(issues: AggregateCrashIssueInput[]): string {
    const systemPrompt = `你是一个资深 iOS 崩溃根因分析专家。你的任务不是逐个分析 issue，而是把多个 Sentry 崩溃样本放在一起做聚合归因。

请重点寻找：
1. 不同堆栈背后的共同异常类型、共同业务入口、共同线程、共同模块、共同生命周期阶段。
2. 表面堆栈不同但可能由同一根因触发的模式，例如对象生命周期、异步回调、线程竞态、通知/KVO、容器越界、空对象、资源释放、SDK 初始化顺序、主线程/子线程切换等。
3. 哪些结论有证据，哪些只是低置信度假设。

请只返回 JSON，格式如下：
{
  "summary": "整体聚合摘要，1-3 句话",
  "conclusion": "最可能的根因结论，如果证据不足要明确说明",
  "confidence": "low/medium/high",
  "patterns": [
    {
      "title": "相似崩溃模式名称",
      "issueIds": ["issue id 或 short id"],
      "sharedSymptoms": ["共同现象"],
      "commonStackSignals": ["共同堆栈信号"],
      "possibleRootCause": "该模式的可能根因",
      "confidence": "low/medium/high",
      "evidence": ["支持这个判断的证据"]
    }
  ],
  "suspectedRootCauses": ["按可能性排序的根因假设"],
  "verificationSteps": ["建议如何验证，不要泛泛而谈"],
  "fixSuggestions": ["建议修复方向"],
  "needsMoreData": ["还需要哪些日志、字段或样本才能提高置信度"]
}`;

    const issueBlocks = issues.slice(0, 12).map((issue, index) => {
      const header = [
        `样本 ${index + 1}`,
        `Issue: ${issue.shortId || issue.id}`,
        `Title: ${issue.title}`,
        issue.count ? `Events: ${issue.count}` : '',
        typeof issue.userCount === 'number' ? `Users: ${issue.userCount}` : '',
        issue.level ? `Level: ${issue.level}` : '',
        issue.appVersionRange ? `App Version Range: ${issue.appVersionRange}` : '',
        issue.eventId ? `Event: ${issue.eventId}` : '',
      ].filter(Boolean).join('\n');

      return `${header}\n关键日志/堆栈：\n${issue.analysisLog.substring(0, 3500)}`;
    }).join('\n\n---\n\n');

    const userPrompt = `请对以下 ${issues.length} 个 Sentry 崩溃 issue 做聚合根因分析。注意：这些 issue 可能堆栈不同，但请寻找共同根因，不要只给单点结论。\n\n${issueBlocks}`;

    return JSON.stringify({
      systemPrompt,
      userPrompt,
    });
  }

  private getEffectiveAPIKey(apiKey?: string): string {
    return process.env.OPENAI_API_KEY || apiKey || '';
  }

  hasConfiguredAPIKey(apiKey?: string): boolean {
    return this.getCandidateAPIKeys(apiKey).length > 0;
  }

  private getCandidateAPIKeys(apiKey?: string): string[] {
    return [
      process.env.OPENAI_API_KEY,
      apiKey,
    ]
      .map((key) => (key || '').trim())
      .filter((key, index, keys) => key.length > 0 && keys.indexOf(key) === index);
  }

  private async callAIAPIWithFallback(prompt: string, apiKeys: string[]): Promise<string> {
    let lastError: any;

    for (let index = 0; index < apiKeys.length; index += 1) {
      try {
        return await this.callAIAPI(prompt, apiKeys[index]);
      } catch (error: any) {
        lastError = error;
        if (!this.isAPIKeyAuthError(error) || index === apiKeys.length - 1) {
          throw error;
        }
        logger.warn('AI API Key 鉴权失败，尝试使用请求中的备用 Key', {
          attempt: index + 1,
          remainingAttempts: apiKeys.length - index - 1,
        });
      }
    }

    throw lastError || new Error('AI API 调用失败');
  }

  private isAPIKeyAuthError(error: any): boolean {
    const message = String(error?.message || '');
    return message.includes('API Key 无效') || message.includes('401');
  }

  private async callAIAPI(prompt: string, apiKey: string): Promise<string> {
    if (this.openAIAPIStyle === 'chat_completions') {
      return this.callOpenAIChatCompletionsAPI(prompt, apiKey);
    }
    return this.callOpenAIResponsesAPI(prompt, apiKey);
  }

  private normalizeOpenAIAPIStyle(style?: string): 'responses' | 'chat_completions' {
    const normalized = (style || '').trim().toLowerCase().replace(/[-\s]/g, '_');
    return normalized === 'chat' || normalized === 'chat_completions' || normalized === 'chat_completions_api'
      ? 'chat_completions'
      : 'responses';
  }

  /**
   * 调用 OpenAI Responses API
   */
  private async callOpenAIResponsesAPI(prompt: string, apiKey: string): Promise<string> {
    try {
      const { systemPrompt, userPrompt } = JSON.parse(prompt);

      logger.info('调用 AI API', {
        provider: 'openai',
        apiStyle: 'responses',
        endpoint: this.openAIEndpoint,
        model: this.openAIModel,
        hasApiKey: !!apiKey,
      });

      const response = await axios.post(
        `${this.openAIEndpoint}/responses`,
        {
          model: this.openAIModel,
          input: [
            {
              role: 'system',
              content: systemPrompt,
            },
            {
              role: 'user',
              content: userPrompt,
            },
          ],
          max_output_tokens: this.maxOutputTokens,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          timeout: this.timeout,
        }
      );

      const content = this.extractOpenAIResponseText(response.data);
      if (!content) {
        throw new Error('AI API 返回内容为空');
      }
      return content;
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response?.status === 401) {
          throw new Error('API Key 无效，请检查您的 OpenAI API Key');
        }
        if (axiosError.code === 'ECONNABORTED') {
          throw new Error('AI 分析超时，请稍后重试');
        }
        if (axiosError.response) {
          const detail = typeof axiosError.response.data === 'string'
            ? axiosError.response.data
            : JSON.stringify(axiosError.response.data || {});
          throw new Error(`OpenAI API 调用失败: ${axiosError.response.status} ${axiosError.response.statusText} ${detail.slice(0, 200)}`);
        }
        throw new Error('网络连接失败，请检查网络设置');
      }
      throw error;
    }
  }

  /**
   * 调用 OpenAI-compatible Chat Completions API（常见中转站）
   */
  private async callOpenAIChatCompletionsAPI(prompt: string, apiKey: string): Promise<string> {
    try {
      const { systemPrompt, userPrompt } = JSON.parse(prompt);

      logger.info('调用 AI API', {
        provider: 'openai',
        apiStyle: 'chat_completions',
        endpoint: this.openAIEndpoint,
        model: this.openAIModel,
        hasApiKey: !!apiKey,
      });

      const response = await axios.post(
        `${this.openAIEndpoint}/chat/completions`,
        {
          model: this.openAIModel,
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            {
              role: 'user',
              content: userPrompt,
            },
          ],
          temperature: 0.2,
          max_tokens: this.maxOutputTokens,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          timeout: this.timeout,
        }
      );

      const content = response.data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('AI API 返回内容为空');
      }
      return content;
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response?.status === 401) {
          throw new Error('API Key 无效，请检查您的 OpenAI API Key 或中转站 Token');
        }
        if (axiosError.code === 'ECONNABORTED') {
          throw new Error('AI 分析超时，请稍后重试');
        }
        if (axiosError.response) {
          const detail = typeof axiosError.response.data === 'string'
            ? axiosError.response.data
            : JSON.stringify(axiosError.response.data || {});
          throw new Error(`OpenAI 中转站调用失败: ${axiosError.response.status} ${axiosError.response.statusText} ${detail.slice(0, 200)}`);
        }
        throw new Error('网络连接失败，请检查网络或中转站地址');
      }
      throw error;
    }
  }

  private extractOpenAIResponseText(data: any): string {
    if (typeof data?.output_text === 'string') {
      return data.output_text;
    }

    const output = Array.isArray(data?.output) ? data.output : [];
    return output
      .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
      .map((content: any) => content?.text || content?.content || '')
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 解析 AI 响应
   */
  private parseAIResponse(response: string): CrashAnalysis {
    try {
      // 尝试提取 JSON 内容
      let jsonStr = response.trim();

      // 如果响应包含 markdown 代码块，提取其中的 JSON
      const jsonMatch = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }

      // 如果没有代码块，尝试直接查找 JSON 对象
      if (!jsonMatch) {
        const directJsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (directJsonMatch) {
          jsonStr = directJsonMatch[0];
        }
      }

      const parsed = JSON.parse(jsonStr);

      // 验证必需字段并设置默认值
      const analysis: CrashAnalysis = {
        summary: parsed.summary || '无法生成崩溃总结',
        crashType: parsed.crashType || '未知类型崩溃',
        possibleCauses: Array.isArray(parsed.possibleCauses) ? parsed.possibleCauses : ['无法确定具体原因'],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : ['建议查看详细日志进行排查'],
        severity: this.validateSeverity(parsed.severity),
        affectedComponents: Array.isArray(parsed.affectedComponents) ? parsed.affectedComponents : ['核心功能'],
      };

      return analysis;
    } catch (error: any) {
      logger.error('解析 AI 响应失败', { error: error.message, response });

      // 返回默认分析结果
      return {
        summary: '无法解析 AI 分析结果，请手动分析崩溃日志',
        crashType: '未知类型',
        possibleCauses: ['AI 分析结果解析失败'],
        suggestions: ['请手动检查崩溃日志', '查看堆栈信息定位问题'],
        severity: 'medium',
        affectedComponents: ['未知'],
      };
    }
  }

  private buildCompactBuildFailureLog(log: string): string {
    const plain = String(log || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    const lines = plain.split(/\r?\n/);
    const keywordPattern = /error|failed|failure|exception|fatal|exit code|fastlane finished|ipa|testflight|app store|appstore|altool|transporter|asc|agreement|provisioning|codesign|archive|xcodebuild|pod install|BUILD FAILED|Finished:\s+FAILURE|构建失败|上传失败|协议|证书|签名|失败/i;
    const selected: string[] = [];
    const seen = new Set<string>();

    function pushLine(line: string) {
      const normalized = line.trim();
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      selected.push(normalized);
    }

    lines.forEach((line, index) => {
      if (!keywordPattern.test(line)) return;
      for (let offset = -2; offset <= 3; offset += 1) {
        const candidate = lines[index + offset];
        if (candidate !== undefined) pushLine(candidate);
      }
    });

    if (selected.length < 8) {
      lines.slice(Math.max(0, lines.length - 160)).forEach(pushLine);
    }

    const compact = selected.join('\n');
    return compact.length > 18000 ? compact.slice(-18000) : compact;
  }

  private parseBuildFailureAIResponse(response: string): BuildFailureAnalysis {
    try {
      let jsonStr = response.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1];
      } else {
        const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (objectMatch) jsonStr = objectMatch[0];
      }
      const parsed = JSON.parse(jsonStr);
      return {
        summary: String(parsed.summary || '无法确定构建失败原因'),
        stage: String(parsed.stage || '未知'),
        severity: this.validateSeverity(parsed.severity),
        rootCause: String(parsed.rootCause || parsed.summary || '需要结合完整日志继续排查'),
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map((item: any) => String(item)).filter(Boolean).slice(0, 6) : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map((item: any) => String(item)).filter(Boolean).slice(0, 8) : ['查看关键错误日志并重新执行构建验证'],
        ownerHint: parsed.ownerHint ? String(parsed.ownerHint) : undefined,
        needsManualAction: Boolean(parsed.needsManualAction),
      };
    } catch (error: any) {
      logger.error('解析 Jenkins 构建失败 AI 响应失败', { error: error.message, response });
      return {
        summary: 'AI 分析结果解析失败',
        stage: '未知',
        severity: 'medium',
        rootCause: 'AI 返回内容不是可解析的 JSON，需要人工查看日志。',
        evidence: [],
        suggestions: ['查看打包日志中的第一处 ERROR/FAILURE', '确认发布账号、证书、构建脚本和上传渠道状态'],
        needsManualAction: true,
      };
    }
  }

  private parseAggregateAIResponse(response: string): AggregateCrashAnalysis {
    try {
      let jsonStr = response.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      } else {
        const directJsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (directJsonMatch) {
          jsonStr = directJsonMatch[0];
        }
      }

      const parsed = JSON.parse(jsonStr);
      const patterns = Array.isArray(parsed.patterns) ? parsed.patterns.map((pattern: any) => ({
        title: String(pattern.title || '相似崩溃模式'),
        issueIds: Array.isArray(pattern.issueIds) ? pattern.issueIds.map(String) : [],
        sharedSymptoms: Array.isArray(pattern.sharedSymptoms) ? pattern.sharedSymptoms.map(String) : [],
        commonStackSignals: Array.isArray(pattern.commonStackSignals) ? pattern.commonStackSignals.map(String) : [],
        possibleRootCause: String(pattern.possibleRootCause || '证据不足，暂无法判断'),
        confidence: this.validateConfidence(pattern.confidence),
        evidence: Array.isArray(pattern.evidence) ? pattern.evidence.map(String) : [],
      })) : [];

      return {
        summary: String(parsed.summary || '未能生成聚合摘要'),
        conclusion: String(parsed.conclusion || '证据不足，暂无法给出明确根因'),
        confidence: this.validateConfidence(parsed.confidence),
        patterns,
        suspectedRootCauses: Array.isArray(parsed.suspectedRootCauses) ? parsed.suspectedRootCauses.map(String) : [],
        verificationSteps: Array.isArray(parsed.verificationSteps) ? parsed.verificationSteps.map(String) : [],
        fixSuggestions: Array.isArray(parsed.fixSuggestions) ? parsed.fixSuggestions.map(String) : [],
        needsMoreData: Array.isArray(parsed.needsMoreData) ? parsed.needsMoreData.map(String) : [],
      };
    } catch (error: any) {
      logger.error('解析 AI 聚合分析响应失败', { error: error.message, response });
      return {
        summary: 'AI 聚合分析结果解析失败',
        conclusion: '无法解析模型输出，请减少聚合 issue 数量后重试',
        confidence: 'low',
        patterns: [],
        suspectedRootCauses: [],
        verificationSteps: ['检查 Sentry issue 的 latest event 是否包含有效异常栈', '减少 issue 数量后重新发起聚合分析'],
        fixSuggestions: ['先按 Top 事件数最高的 3-5 个 issue 做小范围聚合'],
        needsMoreData: ['模型原始响应', '完整 Sentry event JSON', '符号化后的崩溃栈'],
      };
    }
  }

  private validateConfidence(confidence: any): 'low' | 'medium' | 'high' {
    const valid = ['low', 'medium', 'high'];
    if (typeof confidence === 'string' && valid.includes(confidence.toLowerCase())) {
      return confidence.toLowerCase() as 'low' | 'medium' | 'high';
    }
    return 'medium';
  }

  /**
   * 验证严重程度值
   */
  private validateSeverity(severity: any): 'low' | 'medium' | 'high' | 'critical' {
    const validSeverities = ['low', 'medium', 'high', 'critical'];
    if (typeof severity === 'string' && validSeverities.includes(severity.toLowerCase())) {
      return severity.toLowerCase() as 'low' | 'medium' | 'high' | 'critical';
    }
    return 'medium';
  }

  /**
   * 验证 API Key（简单格式验证）
   */
  async validateAPIKey(apiKey: string): Promise<boolean> {
    if (!apiKey || apiKey.trim().length === 0) {
      return false;
    }

    if (!apiKey.startsWith('sk-')) {
      logger.warn('API Key 格式可能不正确，AI API Key 通常以 sk- 开头');
    }

    return true;
  }
}

export default new AIAnalysisService();
