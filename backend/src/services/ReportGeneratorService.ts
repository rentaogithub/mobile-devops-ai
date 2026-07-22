import archiver from 'archiver';
import logger from '../utils/logger';

interface CrashAnalysis {
  summary: string;
  crashType: string;
  possibleCauses: string[];
  suggestions: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedComponents: string[];
  appVersion?: string;
  crashThread?: string;
  crashModule?: string;
  crashStack?: string;
}

interface ReportZipOptions {
  symbolicatedLog: string;
  originalLog?: string;
  analysis?: CrashAnalysis;
  appVersion?: string;
}

/**
 * 报告生成服务
 * 用于生成符号化报告的PDF和ZIP文件
 */
export class ReportGeneratorService {
  /**
   * 生成AI分析报告HTML
   */
  generateAIAnalysisHTML(analysis: CrashAnalysis): string {
    const severityColor = this.getSeverityColor(analysis.severity);
    const severityText = this.getSeverityText(analysis.severity);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>崩溃分析报告</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      line-height: 1.6;
      color: #333;
      background: #f5f5f5;
      padding: 20px;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    h1 {
      text-align: center;
      color: #1890ff;
      margin-bottom: 30px;
      font-size: 28px;
      border-bottom: 3px solid #1890ff;
      padding-bottom: 15px;
    }
    h2 {
      color: #1890ff;
      margin-top: 30px;
      margin-bottom: 15px;
      font-size: 20px;
      border-left: 4px solid #1890ff;
      padding-left: 10px;
    }
    .info-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 15px;
      margin-bottom: 20px;
      background: #fafafa;
      padding: 20px;
      border-radius: 4px;
    }
    .info-item {
      display: flex;
      align-items: center;
    }
    .info-label {
      font-weight: bold;
      color: #666;
      min-width: 100px;
    }
    .info-value {
      color: #333;
    }
    .severity {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 4px;
      font-weight: bold;
      color: white;
      background: ${severityColor};
    }
    .summary {
      background: #e6f7ff;
      border-left: 4px solid #1890ff;
      padding: 15px;
      margin: 15px 0;
      border-radius: 4px;
    }
    ul {
      margin: 15px 0;
      padding-left: 25px;
    }
    li {
      margin: 10px 0;
      line-height: 1.8;
    }
    .components {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 15px 0;
    }
    .component-tag {
      background: #f0f0f0;
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 14px;
    }
    .stack-snapshot {
      background: #f5f5f5;
      border: 1px solid #d9d9d9;
      border-radius: 4px;
      padding: 15px;
      margin: 15px 0;
      overflow-x: auto;
    }
    .stack-snapshot pre {
      font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .footer {
      text-align: center;
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e8e8e8;
      color: #999;
      font-size: 14px;
    }
    @media print {
      body {
        background: white;
        padding: 0;
      }
      .container {
        box-shadow: none;
        padding: 20px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>崩溃分析报告</h1>
    
    <h2>基本信息</h2>
    <div class="info-grid">
      ${analysis.appVersion ? `
      <div class="info-item">
        <span class="info-label">应用版本：</span>
        <span class="info-value">${analysis.appVersion}</span>
      </div>` : ''}
      ${analysis.crashThread ? `
      <div class="info-item">
        <span class="info-label">崩溃线程：</span>
        <span class="info-value">${analysis.crashThread}</span>
      </div>` : ''}
      ${analysis.crashModule ? `
      <div class="info-item">
        <span class="info-label">崩溃模块：</span>
        <span class="info-value">${analysis.crashModule}</span>
      </div>` : ''}
      <div class="info-item">
        <span class="info-label">崩溃类型：</span>
        <span class="info-value">${analysis.crashType}</span>
      </div>
      <div class="info-item">
        <span class="info-label">严重程度：</span>
        <span class="severity">${severityText}</span>
      </div>
    </div>

    <h2>崩溃摘要</h2>
    <div class="summary">
      ${analysis.summary}
    </div>

    <h2>可能原因</h2>
    <ul>
      ${analysis.possibleCauses.map(cause => `<li>${cause}</li>`).join('')}
    </ul>

    <h2>修复建议</h2>
    <ul>
      ${analysis.suggestions.map(suggestion => `<li>${suggestion}</li>`).join('')}
    </ul>

    <h2>受影响组件</h2>
    <div class="components">
      ${analysis.affectedComponents.map(comp => `<span class="component-tag">${comp}</span>`).join('')}
    </div>

    ${analysis.crashStack ? `
    <h2>崩溃堆栈快照</h2>
    <div class="stack-snapshot">
      <pre>${analysis.crashStack}</pre>
    </div>` : ''}

    <div class="footer">
      生成时间：${new Date().toLocaleString('zh-CN')}
    </div>
  </div>
</body>
</html>`;
  }

  generateEmptyAIAnalysisHTML(appVersion?: string): string {
    return this.generateAIAnalysisHTML({
      summary: '暂无 AI 分析结果。请在详情页切换到 AI 智能分析后生成分析，或稍后重新下载。',
      crashType: '未分析',
      possibleCauses: ['暂无 AI 分析数据'],
      suggestions: ['先完成 AI 智能分析，再下载可获得完整分析结论。'],
      severity: 'low',
      affectedComponents: [],
      appVersion,
    });
  }

  /**
   * 生成ZIP文件（包含符号化日志和AI分析报告）
   */
  async generateReportZip(
    symbolicatedLogOrOptions: string | ReportZipOptions,
    analysis?: CrashAnalysis,
    appVersion?: string,
    originalLog?: string
  ): Promise<Buffer> {
    const options: ReportZipOptions = typeof symbolicatedLogOrOptions === 'string'
      ? {
          symbolicatedLog: symbolicatedLogOrOptions,
          analysis,
          appVersion,
          originalLog,
        }
      : symbolicatedLogOrOptions;

    return new Promise(async (resolve, reject) => {
      try {
        const archive = archiver('zip', {
          zlib: { level: 9 }, // 最高压缩级别
        });

        const buffers: Buffer[] = [];
        archive.on('data', (chunk) => buffers.push(chunk));
        archive.on('end', () => {
          const zipBuffer = Buffer.concat(buffers);
          logger.info('ZIP文件生成成功', { size: zipBuffer.length });
          resolve(zipBuffer);
        });
        archive.on('error', reject);

        const timestamp = Date.now();
        const version = options.appVersion || 'unknown';

        // 添加原始崩溃日志文件
        const originalLogFileName = `original_crash_${version}_${timestamp}.crash`;
        archive.append(options.originalLog || '暂无原始崩溃日志', { name: originalLogFileName });
        logger.info('添加原始崩溃日志到ZIP', { fileName: originalLogFileName });

        // 添加符号化日志文件
        const logFileName = `symbolicated_crash_${version}_${timestamp}.txt`;
        archive.append(options.symbolicatedLog, { name: logFileName });
        logger.info('添加符号化日志到ZIP', { fileName: logFileName });

        // 添加AI分析HTML报告。即使暂未分析，也保留固定文件，方便下载包结构稳定。
        try {
          const htmlContent = options.analysis
            ? this.generateAIAnalysisHTML(options.analysis)
            : this.generateEmptyAIAnalysisHTML(version);
          const htmlFileName = `ai_analysis_report_${version}_${timestamp}.html`;
          archive.append(htmlContent, { name: htmlFileName });
          logger.info('添加AI分析报告到ZIP', { fileName: htmlFileName, hasAIAnalysis: !!options.analysis });
        } catch (error: any) {
          logger.error('生成AI分析HTML失败', { error: error.message });
          const htmlFileName = `ai_analysis_report_${version}_${timestamp}.html`;
          archive.append('<!DOCTYPE html><html><body><h1>AI分析报告生成失败</h1></body></html>', { name: htmlFileName });
        }

        // 完成打包
        archive.finalize();
      } catch (error: any) {
        logger.error('生成ZIP文件失败', { error: error.message });
        reject(error);
      }
    });
  }

  /**
   * 获取严重程度的中文文本
   */
  private getSeverityText(severity: string): string {
    const severityMap: Record<string, string> = {
      low: '低',
      medium: '中',
      high: '高',
      critical: '严重',
    };
    return severityMap[severity] || severity;
  }

  /**
   * 获取严重程度的颜色
   */
  private getSeverityColor(severity: string): string {
    const colorMap: Record<string, string> = {
      low: '#52c41a',
      medium: '#faad14',
      high: '#ff7a45',
      critical: '#f5222d',
    };
    return colorMap[severity] || '#999';
  }
}

export default new ReportGeneratorService();
