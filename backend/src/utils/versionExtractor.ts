/**
 * 从崩溃日志中提取版本号
 */
export function extractVersionFromCrashLog(crashLog: string): string | null {
  // 检查是否是 .ips JSON 格式
  const trimmed = crashLog.trim();
  if (trimmed.startsWith('{')) {
    try {
      // 尝试解析第一行（头部信息）
      const firstLineEnd = crashLog.indexOf('\n');
      if (firstLineEnd > 0) {
        const firstLine = crashLog.substring(0, firstLineEnd);
        try {
          const headerData = JSON.parse(firstLine);
          if (headerData.app_version) {
            return headerData.app_version;
          }
        } catch (e) {
          // 第一行不是有效的 JSON，继续尝试整个内容
        }
      }
      
      // 如果第一行解析失败，尝试解析整个 JSON
      const jsonData = JSON.parse(crashLog);
      if (jsonData.app_version) {
        return jsonData.app_version;
      }
    } catch (e) {
      // JSON 解析失败，继续尝试文本格式方法
    }
  }
  
  // 文本格式的提取方法
  // 方法1: 从 Version 字段提取
  const versionMatch = crashLog.match(/^Version:\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/m);
  if (versionMatch) {
    return versionMatch[1].trim();
  }
  
  // 方法2: 从 Binary Images 部分提取当前进程对应的主应用版本。
  const processName = [
    crashLog.match(/^Process:\s+([^\s\[]+)/im)?.[1],
    crashLog.match(/^Command:\s+([^\s]+)/im)?.[1],
    crashLog.match(/^Path:\s+.*\/([^/]+)\.app\/([^/\s]+)$/im)?.[2],
  ].find(Boolean)?.trim();
  const binaryImages = crashLog.split(/Binary Images:/i)[1] || '';
  const imageLines = binaryImages.split(/\r?\n/).filter((line) => /^\s*0x[0-9a-f]+\s+-\s+0x[0-9a-f]+/i.test(line));
  const matchingLine = processName
    ? imageLines.find((line) => {
      const imageName = line.match(/^\s*0x[0-9a-f]+\s+-\s+0x[0-9a-f]+\s+(\S+)/i)?.[1];
      return imageName === processName || line.includes(`/${processName}.app/${processName}`);
    })
    : imageLines.find((line) => /\/[^/\s]+\.app\/[^/\s]+/i.test(line));
  const binaryImageVersion = matchingLine?.match(/\((\d+(?:\.\d+){1,3}(?:[-+][^\s)]+)?)\)\s*$/)?.[1];
  if (binaryImageVersion) return binaryImageVersion.trim();
  
  // 方法3: 从 CFBundleShortVersionString 提取
  const bundleVersionMatch = crashLog.match(/CFBundleShortVersionString:\s+([^\s\n]+)/);
  if (bundleVersionMatch) {
    return bundleVersionMatch[1].trim();
  }
  
  // 方法4: 从 App Version 字段提取
  const appVersionMatch = crashLog.match(/App Version:\s+([^\s\n]+)/);
  if (appVersionMatch) {
    return appVersionMatch[1].trim();
  }
  
  return null;
}
