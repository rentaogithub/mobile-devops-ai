/**
 * 企业微信分享工具
 * 复制分享内容到剪贴板，用户可以粘贴到企业微信
 */

export interface ShareContent {
  title: string;
  description: string;
  url: string;
}

/**
 * 分享到企业微信（复制到剪贴板）
 * @param content 分享内容
 * @returns Promise<boolean> 是否成功
 */
export async function shareToWeChatWork(content: ShareContent): Promise<boolean> {
  // 构建分享文本
  const parts = [];
  if (content.title) {
    parts.push(content.title);
  }
  parts.push(content.description);
  parts.push(`查看详情：${content.url}`);
  
  const shareText = parts.join('\n\n');
  
  try {
    await copyToClipboard(shareText);
    return true;
  } catch (error) {
    console.error('复制失败', error);
    return false;
  }
}

/**
 * 复制文本到剪贴板
 */
async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      // 降级方案
      fallbackCopyToClipboard(text);
    }
  } else {
    fallbackCopyToClipboard(text);
  }
}

/**
 * 降级的复制方案
 */
function fallbackCopyToClipboard(text: string): void {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  document.body.appendChild(textArea);
  textArea.select();
  
  try {
    document.execCommand('copy');
  } catch (err) {
    console.error('复制失败', err);
  }
  
  document.body.removeChild(textArea);
}

/**
 * 生成崩溃报告分享内容
 */
export function generateCrashReportShareContent(record: {
  id: number;
  appVersion: string;
  crashType?: string;
  crashModule?: string;
  crashLocation?: string;
  createdAt: string;
}): ShareContent {
  const baseUrl = window.location.origin;
  const detailUrl = `${baseUrl}/history?id=${record.id}`;
  
  const lines = [
    `📱 应用版本：${record.appVersion}`,
  ];
  
  if (record.crashType) {
    lines.push(`💥 崩溃类型：${record.crashType}`);
  }
  
  if (record.crashModule) {
    lines.push(`🔧 崩溃模块：${record.crashModule}`);
  }
  
  if (record.crashLocation) {
    lines.push(`📍 崩溃位置：${record.crashLocation}`);
  }
  
  lines.push(`⏰ 时间：${record.createdAt}`);
  
  return {
    title: '',
    description: lines.join('\n'),
    url: detailUrl,
  };
}

/**
 * 检测是否在企业微信环境中
 */
export function isWeChatWork(): boolean {
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes('wxwork');
}

/**
 * 检测是否支持企业微信分享
 */
export function canShareToWeChatWork(): boolean {
  // 在 macOS 或 Windows 上都可以尝试调起
  return true;
}

/**
 * 检测是否可以使用原生分享
 */
export function canUseNativeShare(): boolean {
  // Web Share API 需要在安全上下文（HTTPS 或 localhost）中使用
  // 并且需要用户交互触发
  return (
    'share' in navigator &&
    (window.location.protocol === 'https:' || window.location.hostname === 'localhost')
  );
}
