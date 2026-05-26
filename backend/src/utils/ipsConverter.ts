/**
 * 将 .ips JSON 格式转换为 .crash 文本格式
 */

interface IPSData {
  incident_id?: string;
  incidentID?: string;
  crashReporterKey?: string;
  modelCode?: string;
  hardwareModel?: string;
  procName?: string;
  app_name?: string;
  pid?: number;
  procPath?: string;
  bundlePath?: string;
  bundleID?: string;
  app_version?: string;
  bundleVersion?: string;
  build_version?: string;
  bundleShortVersion?: string;
  cpuType?: string;
  parentProc?: string;
  parentPid?: number;
  timestamp?: string;
  captureTime?: string;
  procLaunch?: string;
  osVersion?: {
    train?: string;
    build?: string;
    releaseType?: string;
  };
  os_version?: string;
  basebandVersion?: string;
  exception?: {
    type?: string;
    signal?: string;
    codes?: string;
    rawCodes?: number[];
    subtype?: string;
  };
  termination?: {
    namespace?: string;
    code?: number;
    flags?: number;
    reasons?: string[];
  };
  faultingThread?: number;
  threads?: Array<{
    triggered?: boolean;
    frames?: Array<{
      imageIndex?: number;
      imageOffset?: number;
      symbol?: string;
    }>;
  }>;
  binaryImages?: Array<{
    name?: string;
    base?: number;
    loadAddress?: number;
    size?: number;
    arch?: string;
    uuid?: string;
    path?: string;
  }>;
  usedImages?: Array<{
    name?: string;
    base?: number;
    loadAddress?: number;
    size?: number;
    arch?: string;
    uuid?: string;
    path?: string;
  }>;
  appSpecificInfo?: string | string[];
  applicationSpecificInformation?: string | string[];
  reportNotes?: string[];
  thermalLevel?: number;
}

export function convertIPSToCrash(ipsContent: string): string {
  let crashData: IPSData | null = null;
  let headerData: any = null;

  try {
    // 尝试将整个内容作为一个 JSON 对象解析
    crashData = JSON.parse(ipsContent) as IPSData;
    console.log(`[IPS Converter] 成功解析为单个 JSON 对象`);
  } catch (firstError) {
    // 如果失败，尝试多行 JSON 格式
    console.log(`[IPS Converter] 单个 JSON 解析失败，尝试多行 JSON 格式`);
    const lines = ipsContent.trim().split('\n');

    // 策略1: 尝试解析每一行作为独立的 JSON
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || !line.startsWith('{')) continue;
      
      try {
        const data = JSON.parse(line) as IPSData;
        if (data.threads && (data.binaryImages || data.usedImages)) {
          console.log(`[IPS Converter] ✓ 找到堆栈数据在第 ${i + 1} 行（单行 JSON）`);
          crashData = data;
          break;
        } else if (data.app_name || data.timestamp || data.incident_id) {
          console.log(`[IPS Converter] ✓ 找到头部信息在第 ${i + 1} 行`);
          headerData = data;
        }
      } catch {
        // 单行解析失败，可能是多行格式化的 JSON
        continue;
      }
    }

    // 策略2: 如果没找到堆栈数据，尝试从第一行之后的所有内容解析为一个 JSON
    if (!crashData) {
      console.log(`[IPS Converter] 尝试解析第一行之后的内容为格式化 JSON`);
      
      // 找到第一个 { 的位置（跳过第一行）
      const firstLineEnd = ipsContent.indexOf('\n');
      if (firstLineEnd > 0) {
        const remainingContent = ipsContent.substring(firstLineEnd + 1).trim();
        
        try {
          const data = JSON.parse(remainingContent) as IPSData;
          if (data.threads && (data.binaryImages || data.usedImages)) {
            console.log(`[IPS Converter] ✓ 找到堆栈数据（格式化 JSON）`);
            crashData = data;
          }
        } catch (e: any) {
          console.log(`[IPS Converter] 格式化 JSON 解析失败: ${e.message}`);
        }
      }
    }

    // 合并头部信息和堆栈数据
    if (crashData && headerData) {
      console.log(`[IPS Converter] 合并头部信息和堆栈数据`);
      crashData = {
        ...headerData,
        ...crashData,
        // 确保关键字段来自正确的数据源
        threads: crashData.threads,
        binaryImages: crashData.binaryImages,
      };
    }

    if (!crashData) {
      throw new Error('无法解析 .ips 文件：未找到包含 threads 和 binaryImages 的数据');
    }
  }

  // 兼容 binaryImages 和 usedImages 两种字段名
  if (!crashData.binaryImages && crashData.usedImages) {
    console.log(`[IPS Converter] 使用 usedImages 字段`);
    crashData.binaryImages = crashData.usedImages;
  }

  if (!crashData || !crashData.threads || !crashData.binaryImages) {
    throw new Error('未找到包含 threads 和 binaryImages/usedImages 的完整崩溃数据');
  }

  console.log(`[IPS Converter] 开始转换: threads=${crashData.threads.length}, binaryImages=${crashData.binaryImages.length}`);

  const outputLines: string[] = [];

  // 添加基本信息
  const incidentId = crashData.incident_id || crashData.incidentID || 'N/A';
  outputLines.push(`Incident Identifier: ${incidentId}`);
  outputLines.push(`CrashReporter Key:   ${crashData.crashReporterKey || 'N/A'}`);
  outputLines.push(`Hardware Model:      ${crashData.modelCode || crashData.hardwareModel || 'N/A'}`);

  const procName = crashData.procName || crashData.app_name || 'Unknown';
  const pid = crashData.pid || 0;
  outputLines.push(`Process:             ${procName} [${pid}]`);
  outputLines.push(`Path:                ${crashData.procPath || crashData.bundlePath || 'N/A'}`);
  outputLines.push(`Identifier:          ${crashData.bundleID || 'N/A'}`);

  const appVersion = crashData.app_version || crashData.bundleVersion || 'N/A';
  const buildVersion = crashData.build_version || crashData.bundleShortVersion || 'N/A';
  outputLines.push(`Version:             ${appVersion} (${buildVersion})`);
  outputLines.push(`Code Type:           ${crashData.cpuType || 'ARM-64'}`);
  outputLines.push(`Parent Process:      ${crashData.parentProc || 'launchd'} [${crashData.parentPid || 1}]`);
  outputLines.push('');

  // 添加日期和系统信息
  outputLines.push(`Date/Time:           ${crashData.captureTime || crashData.timestamp || ''}`);
  
  if (crashData.procLaunch) {
    outputLines.push(`Launch Time:         ${crashData.procLaunch}`);
  }

  if (crashData.osVersion && typeof crashData.osVersion === 'object') {
    const osStr = crashData.osVersion.train || 'iOS';
    const osBuild = crashData.osVersion.build || '';
    outputLines.push(`OS Version:          ${osStr}${osBuild ? ' (' + osBuild + ')' : ''}`);
    
    if (crashData.osVersion.releaseType) {
      outputLines.push(`Release Type:        ${crashData.osVersion.releaseType}`);
    }
  } else {
    outputLines.push(`OS Version:          ${crashData.os_version || 'iOS'}`);
  }
  
  if (crashData.basebandVersion) {
    outputLines.push(`Baseband Version:    ${crashData.basebandVersion}`);
  }

  outputLines.push('Report Version:      104');
  outputLines.push('');

  // 添加异常信息
  if (crashData.exception) {
    const excType = crashData.exception.type || 'EXC_CRASH';
    const excSignal = crashData.exception.signal || '';
    outputLines.push(`Exception Type:      ${excType}${excSignal ? ' (' + excSignal + ')' : ''}`);

    if (crashData.exception.codes) {
      outputLines.push(`Exception Codes:     ${crashData.exception.codes}`);
    }
    if (crashData.exception.subtype) {
      outputLines.push(`Exception Subtype:   ${crashData.exception.subtype}`);
    }
  }
  
  // 添加终止原因
  if (crashData.termination) {
    const term = crashData.termination;
    let reasonText = 'Termination Reason: ';
    
    if (term.namespace) {
      reasonText += `${term.namespace} `;
    }
    if (term.code !== undefined) {
      reasonText += `${term.code} `;
    }
    
    outputLines.push(reasonText.trim());
    
    // 添加详细的终止原因
    if (term.reasons && Array.isArray(term.reasons)) {
      term.reasons.forEach(reason => {
        outputLines.push(reason);
      });
    }
  }
  
  outputLines.push('');

  // 找到崩溃的线程
  const threads = crashData.threads;
  const crashedThreadIndex = threads.findIndex(t => t.triggered) || 0;
  outputLines.push(`Crashed Thread:      ${crashedThreadIndex}`);
  outputLines.push('');

  // 添加 Application Specific Information
  const appInfo = crashData.appSpecificInfo || crashData.applicationSpecificInformation;
  if (appInfo) {
    outputLines.push('Application Specific Information:');
    if (typeof appInfo === 'string') {
      outputLines.push(appInfo);
    } else if (Array.isArray(appInfo)) {
      outputLines.push(...appInfo);
    }
    outputLines.push('');
  }

  // 添加线程信息
  const binaryImages = crashData.binaryImages;

  threads.forEach((thread, threadIndex) => {
    if (thread.triggered) {
      outputLines.push(`Thread ${threadIndex} Crashed:`);
    } else {
      outputLines.push(`Thread ${threadIndex}:`);
    }

    const frames = thread.frames || [];
    frames.slice(0, 50).forEach((frame, frameIndex) => {
      const imageIndex = frame.imageIndex || 0;
      if (imageIndex < binaryImages.length) {
        const imageInfo = binaryImages[imageIndex];

        // 提取二进制名称
        let binaryName = imageInfo.name || 'Unknown';
        if (binaryName.includes('/')) {
          binaryName = binaryName.split('/').pop() || binaryName;
        }

        // 计算地址
        const loadAddress = imageInfo.base || imageInfo.loadAddress || 0;
        const imageOffset = frame.imageOffset || 0;
        const actualAddress = loadAddress + imageOffset;

        // 格式化地址
        const addressStr = `0x${actualAddress.toString(16).padStart(16, '0')}`;
        const loadAddrStr = `0x${loadAddress.toString(16)}`;

        // 符号信息
        const symbol = frame.symbol || `${loadAddrStr} + ${imageOffset}`;

        outputLines.push(`${frameIndex}  ${binaryName}  ${addressStr} ${symbol}`);
      }
    });

    outputLines.push('');
  });

  // 添加 Binary Images
  outputLines.push('Binary Images:');
  binaryImages.forEach(img => {
    const base = img.base || img.loadAddress || 0;
    const size = img.size || 0;
    const end = base + size;

    let name = img.name || 'Unknown';
    if (name.includes('/')) {
      name = name.split('/').pop() || name;
    }

    const arch = img.arch || 'arm64';
    const uuid = img.uuid || 'N/A';
    const path = img.path || img.name || '';

    outputLines.push(`0x${base.toString(16).padStart(9, '0')} - 0x${end.toString(16).padStart(9, '0')} ${name} ${arch}  <${uuid}> ${path}`);
  });

  return outputLines.join('\n');
}
