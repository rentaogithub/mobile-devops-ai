import axios from 'axios';
import logger from '../utils/logger';
import { productLineConfigService } from './ProductLineConfigService';
import { currentProductLineId } from './ProductLineContext';

interface WeChatWorkConfig {
  corpId: string;
  agentId: string;
  secret: string;
}

interface CrashReportMessage {
  appVersion: string;
  crashType: string;
  crashLocation?: string;
  crashModule?: string;
  severity: string;
  assignee?: string;
  detailUrl: string;
  createdAt: string;
}

export class WeChatWorkService {
  private tokenCache = new Map<string, { accessToken: string; expireTime: number }>();

  private getConfig(): WeChatWorkConfig {
    return {
      corpId: productLineConfigService.get('WECHAT_WORK_CORP_ID'),
      agentId: productLineConfigService.get('WECHAT_WORK_AGENT_ID'),
      secret: productLineConfigService.get('WECHAT_WORK_SECRET'),
    };
  }

  /**
   * 获取企业微信 Access Token
   */
  private async getAccessToken(): Promise<string> {
    const productLineId = currentProductLineId();
    const cached = this.tokenCache.get(productLineId);
    // 如果 token 还有效，直接返回
    if (cached?.accessToken && Date.now() < cached.expireTime) {
      return cached.accessToken;
    }

    try {
      const config = this.getConfig();
      if (!config.corpId || !config.secret) throw new Error('当前产品线企业微信 Corp ID 或 Secret 未配置');
      const response = await axios.get(
        `https://qyapi.weixin.qq.com/cgi-bin/gettoken`,
        {
          params: {
            corpid: config.corpId,
            corpsecret: config.secret,
          },
        }
      );

      if (response.data.errcode === 0) {
        const accessToken = String(response.data.access_token || '');
        this.tokenCache.set(productLineId, {
          accessToken,
          // 提前 5 分钟过期
          expireTime: Date.now() + (response.data.expires_in - 300) * 1000,
        });
        logger.info('企业微信 Access Token 获取成功', { productLineId });
        return accessToken;
      } else {
        throw new Error(`获取 Access Token 失败: ${response.data.errmsg}`);
      }
    } catch (error: any) {
      logger.error('获取企业微信 Access Token 失败', { error: error.message });
      throw error;
    }
  }

  /**
   * 发送文本消息到企业微信
   */
  async sendTextMessage(
    content: string,
    toUser?: string,
    toParty?: string,
    toTag?: string
  ): Promise<void> {
    try {
      const token = await this.getAccessToken();
      const config = this.getConfig();

      const message = {
        touser: toUser || '@all',
        toparty: toParty,
        totag: toTag,
        msgtype: 'text',
        agentid: config.agentId,
        text: {
          content,
        },
        safe: 0,
      };

      const response = await axios.post(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
        message
      );

      if (response.data.errcode === 0) {
        logger.info('企业微信消息发送成功', {
          toUser,
          toParty,
          invalidUser: response.data.invaliduser,
        });
      } else {
        throw new Error(`发送消息失败: ${response.data.errmsg}`);
      }
    } catch (error: any) {
      logger.error('发送企业微信消息失败', { error: error.message });
      throw error;
    }
  }

  /**
   * 发送崩溃报告卡片消息
   */
  async sendCrashReportCard(
    report: CrashReportMessage,
    toUser?: string,
    toParty?: string
  ): Promise<void> {
    try {
      const token = await this.getAccessToken();
      const config = this.getConfig();

      // 构建文本卡片消息
      const message = {
        touser: toUser || '@all',
        toparty: toParty,
        msgtype: 'textcard',
        agentid: config.agentId,
        textcard: {
          title: `🔴 崩溃报告 - ${this.getSeverityText(report.severity)}`,
          description: this.buildCardDescription(report),
          url: report.detailUrl,
          btntxt: '查看详情',
        },
      };

      const response = await axios.post(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
        message
      );

      if (response.data.errcode === 0) {
        logger.info('崩溃报告卡片发送成功', {
          appVersion: report.appVersion,
          toUser,
          toParty,
        });
      } else {
        throw new Error(`发送卡片失败: ${response.data.errmsg}`);
      }
    } catch (error: any) {
      logger.error('发送崩溃报告卡片失败', { error: error.message });
      throw error;
    }
  }

  /**
   * 发送 Markdown 格式消息
   */
  async sendMarkdownMessage(
    report: CrashReportMessage,
    toUser?: string,
    toParty?: string
  ): Promise<void> {
    try {
      const token = await this.getAccessToken();
      const config = this.getConfig();

      const markdown = this.buildMarkdownContent(report);

      const message = {
        touser: toUser || '@all',
        toparty: toParty,
        msgtype: 'markdown',
        agentid: config.agentId,
        markdown: {
          content: markdown,
        },
      };

      const response = await axios.post(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
        message
      );

      if (response.data.errcode === 0) {
        logger.info('Markdown 消息发送成功', {
          appVersion: report.appVersion,
          toUser,
          toParty,
        });
      } else {
        throw new Error(`发送 Markdown 消息失败: ${response.data.errmsg}`);
      }
    } catch (error: any) {
      logger.error('发送 Markdown 消息失败', { error: error.message });
      throw error;
    }
  }

  /**
   * 构建卡片描述
   */
  private buildCardDescription(report: CrashReportMessage): string {
    const lines = [
      `<div class="gray">📱 应用版本：${report.appVersion}</div>`,
      `<div class="normal">💥 崩溃类型：${report.crashType}</div>`,
    ];

    if (report.crashModule) {
      lines.push(`<div class="normal">🔧 崩溃模块：${report.crashModule}</div>`);
    }

    if (report.crashLocation) {
      lines.push(`<div class="normal">📍 崩溃位置：${report.crashLocation}</div>`);
    }

    if (report.assignee) {
      lines.push(`<div class="highlight">👤 负责人：@${report.assignee}</div>`);
    }

    lines.push(`<div class="gray">⏰ ${report.createdAt}</div>`);

    return lines.join('');
  }

  /**
   * 构建 Markdown 内容
   */
  private buildMarkdownContent(report: CrashReportMessage): string {
    const severityEmoji = this.getSeverityEmoji(report.severity);
    const lines = [
      `## ${severityEmoji} 崩溃报告 - ${this.getSeverityText(report.severity)}`,
      '',
      `> 📱 **应用版本**：${report.appVersion}`,
      `> 💥 **崩溃类型**：${report.crashType}`,
    ];

    if (report.crashModule) {
      lines.push(`> 🔧 **崩溃模块**：${report.crashModule}`);
    }

    if (report.crashLocation) {
      lines.push(`> 📍 **崩溃位置**：${report.crashLocation}`);
    }

    if (report.assignee) {
      lines.push(`> 👤 **负责人**：<@${report.assignee}>`);
    }

    lines.push('');
    lines.push(`⏰ ${report.createdAt}`);
    lines.push('');
    lines.push(`[查看详情](${report.detailUrl})`);

    return lines.join('\n');
  }

  /**
   * 获取严重程度文本
   */
  private getSeverityText(severity: string): string {
    const map: Record<string, string> = {
      critical: '严重',
      high: '高',
      medium: '中',
      low: '低',
    };
    return map[severity] || '未知';
  }

  /**
   * 获取严重程度 Emoji
   */
  private getSeverityEmoji(severity: string): string {
    const map: Record<string, string> = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🟢',
    };
    return map[severity] || '⚪';
  }

  /**
   * 检查配置是否完整
   */
  isConfigured(): boolean {
    const config = this.getConfig();
    return !!(config.corpId && config.agentId && config.secret);
  }
}

export default new WeChatWorkService();
