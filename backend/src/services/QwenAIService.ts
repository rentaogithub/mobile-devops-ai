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

/**
 * 通义千问 AI 崩溃分析服务
 */
export class QwenAIService {
  private readonly apiEndpoint: string;
  private readonly model: string;
  private readonly provider: string;
  private readonly openAIEndpoint: string;
  private readonly openAIModel: string;
  private readonly timeout: number;

  constructor() {
    this.apiEndpoint = process.env.QWEN_API_ENDPOINT || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    this.model = process.env.QWEN_MODEL || 'qwen-plus';
    this.provider = (process.env.AI_PROVIDER || '').toLowerCase();
    this.openAIEndpoint = (process.env.OPENAI_API_ENDPOINT || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.openAIModel = process.env.CODEX_MODEL || process.env.OPENAI_MODEL || 'gpt-5.1-codex';
    this.timeout = parseInt(process.env.AI_ANALYSIS_TIMEOUT || '30000', 10);
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
      // 优先使用环境变量中的 Key，其次使用前端传入的 Key
      const effectiveApiKey = this.getEffectiveAPIKey(apiKey);
      
      logger.info('开始 AI 分析崩溃日志', { fallbackAppVersion });

      if (!effectiveApiKey || effectiveApiKey.trim().length === 0) {
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
        crashModule: basicInfo.crashModule
      });

      // 调用 AI API
      const response = await this.callAIAPI(prompt, effectiveApiKey);

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
  }): string {
    const systemPrompt = `你是一个专业的 iOS 崩溃日志分析专家。你的任务是分析符号化后的崩溃日志，并提供详细的分析结果。

请按照以下 JSON 格式返回分析结果：
{
  "summary": "简短的崩溃总结（1-2句话）",
  "crashType": "崩溃类型（如：内存访问错误、程序异常终止等）",
  "possibleCauses": ["可能原因1", "可能原因2", "可能原因3"],
  "suggestions": ["修复建议1", "修复建议2", "修复建议3"],
  "severity": "严重程度（low/medium/high/critical）",
  "affectedComponents": ["受影响的组件1", "受影响的组件2"]
}

分析要点：
1. 识别崩溃类型（EXC_BAD_ACCESS、SIGABRT、SIGSEGV 等）
2. 分析堆栈信息，找出崩溃发生的位置
3. 根据异常类型和堆栈推断可能的原因
4. 提供具体的修复建议
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

    const userPrompt = `请分析以下符号化后的 iOS 崩溃日志：
${crashLocationInfo}
\`\`\`
${symbolicatedLog.substring(0, 8000)}
\`\`\`

请返回 JSON 格式的分析结果。`;

    return JSON.stringify({
      systemPrompt,
      userPrompt,
    });
  }

  private getEffectiveAPIKey(apiKey?: string): string {
    if (this.shouldUseOpenAI()) {
      return process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || apiKey || '';
    }
    return process.env.QWEN_API_KEY || apiKey || '';
  }

  hasConfiguredAPIKey(apiKey?: string): boolean {
    return this.getEffectiveAPIKey(apiKey).trim().length > 0;
  }

  private shouldUseOpenAI(): boolean {
    return this.provider === 'codex' || this.provider === 'openai' ||
      !!process.env.OPENAI_API_KEY || !!process.env.CODEX_API_KEY;
  }

  private async callAIAPI(prompt: string, apiKey: string): Promise<string> {
    if (this.shouldUseOpenAI()) {
      return this.callOpenAIResponsesAPI(prompt, apiKey);
    }
    return this.callQwenAPI(prompt, apiKey);
  }

  /**
   * 调用通义千问兼容 API
   */
  private async callQwenAPI(prompt: string, apiKey: string): Promise<string> {
    try {
      const { systemPrompt, userPrompt } = JSON.parse(prompt);

      logger.info('调用 AI API', { provider: 'qwen', model: this.model, hasApiKey: !!apiKey });

      const response = await axios.post(
        `${this.apiEndpoint}/chat/completions`,
        {
          model: this.model,
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
          temperature: 0.7,
          max_tokens: 2000,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          timeout: this.timeout,
        }
      );

      if (!response.data || !response.data.choices || response.data.choices.length === 0) {
        throw new Error('AI API 返回数据格式错误');
      }

      const content = response.data.choices[0].message?.content;
      if (!content) {
        throw new Error('AI API 返回内容为空');
      }

      return content;
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response?.status === 401) {
          throw new Error('API Key 无效，请检查您的 AI API Key');
        }
        if (axiosError.code === 'ECONNABORTED') {
          throw new Error('AI 分析超时，请稍后重试');
        }
        if (axiosError.response) {
          throw new Error(`AI API 调用失败: ${axiosError.response.status} ${axiosError.response.statusText}`);
        }
        throw new Error('网络连接失败，请检查网络设置');
      }
      throw error;
    }
  }

  /**
   * 调用 OpenAI Responses API（Codex/OpenAI）
   */
  private async callOpenAIResponsesAPI(prompt: string, apiKey: string): Promise<string> {
    try {
      const { systemPrompt, userPrompt } = JSON.parse(prompt);

      logger.info('调用 AI API', { provider: 'openai', model: this.openAIModel, hasApiKey: !!apiKey });

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
          max_output_tokens: 2000,
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

export default new QwenAIService();
