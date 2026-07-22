import { useState, useEffect } from 'react';
import {
  Input,
  Button,
  message,
  Card,
  Typography,
  Space,
  Upload,
  Tabs,
  Spin,
  Alert,
  Select,
  Collapse,
  Modal,
} from 'antd';
import {
  FileTextOutlined,
  UploadOutlined,
  DownloadOutlined,
  QuestionCircleOutlined,
  RobotOutlined,
  WarningOutlined,
  ShareAltOutlined,
} from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { symbolicateApi, dsymApi } from '../services/api';
import { DSYMInfo, CrashAnalysis } from '../types';
import APIKeyInput from '../components/APIKeyInput';
import AIAnalysisPanel from '../components/AIAnalysisPanel';
import { shareToWeChatWork } from '../utils/wechatShare';
import { authUtils } from '../utils/auth';
import { downloadTextFile, generateFilename } from '../utils/helpers';

const { TextArea } = Input;
const { Title, Paragraph, Text } = Typography;
const SENTRY_IOS_PROJECT_URL = '/organizations/sentry/projects/nn-ios/?project=6';

export default function SymbolicatePage() {
  const [crashLog, setCrashLog] = useState('');
  const [symbolicating, setSymbolicating] = useState(false);
  const [selectedUUIDs, setSelectedUUIDs] = useState<string[]>([]);
  const [selectedMainAppVersion, setSelectedMainAppVersion] = useState<string | undefined>(undefined);
  const [dsymList, setDsymList] = useState<DSYMInfo[]>([]);
  const [apiKey, setApiKey] = useState(() => {
    // 从 localStorage 读取保存的 API Key；Sentry 自动分析优先使用后端配置的 OpenAI Key。
    return localStorage.getItem('openai_api_key') || '';
  });
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<{
    original: string;
    symbolicated: string;
    uuid: string;
    warning?: string;
    analysis?: CrashAnalysis;
    historyId?: number;
  } | null>(null);
  const [autoSymbolicate, setAutoSymbolicate] = useState(false);
  const [autoAnalyzeAfterSymbolicate, setAutoAnalyzeAfterSymbolicate] = useState(false);
  const [canAnalyze, setCanAnalyze] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [originalCrashFileName, setOriginalCrashFileName] = useState('');
  const isAdmin = authUtils.isAdmin();

  // 加载 dSYM 列表
  useEffect(() => {
    const loadDsyms = async () => {
      try {
        const response = await dsymApi.list();
        if (response.success && response.data) {
          setDsymList(response.data);
        }
      } catch (error) {
        console.error('加载 dSYM 列表失败', error);
      }
    };
    loadDsyms();
  }, []);

  useEffect(() => {
    const sentryCrashLog = sessionStorage.getItem('sentry_symbolicate_crash_log');
    if (!sentryCrashLog) {
      return;
    }

    const issueTitle = sessionStorage.getItem('sentry_symbolicate_issue_title') || 'Sentry 问题';
    const shouldAutoAnalyze = sessionStorage.getItem('sentry_auto_ai_analysis') === 'true';
    sessionStorage.removeItem('sentry_symbolicate_crash_log');
    sessionStorage.removeItem('sentry_symbolicate_issue_title');
    sessionStorage.removeItem('sentry_auto_ai_analysis');
    setCrashLog(sentryCrashLog);
    setOriginalCrashFileName(`${sanitizeFilename(issueTitle)}.crash`);
    setAutoSymbolicate(true);
    setAutoAnalyzeAfterSymbolicate(shouldAutoAnalyze);
    message.success(`已载入 ${issueTitle} 的 Sentry 日志`);
  }, []);

  // 监听autoSymbolicate标记，自动触发符号化（仅文件上传且版本识别成功时）
  // 等待 selectedUUIDs 更新后再触发（版本自动选择是异步的）
  useEffect(() => {
    if (autoSymbolicate && crashLog) {
      if (selectedUUIDs.length > 0) {
        setAutoSymbolicate(false);
        handleSymbolicate();
      }
      // selectedUUIDs 还没就绪时不做任何事，等下次 selectedUUIDs 变化时再触发
    }
  }, [autoSymbolicate, crashLog, selectedUUIDs]);

  // 监听崩溃日志变化，自动选择版本
  useEffect(() => {
    // 如果已经选择了版本，不自动更改
    if (selectedMainAppVersion) {
      return;
    }

    // 如果没有崩溃日志或日志太短，不处理
    if (!crashLog || crashLog.length < 100) {
      return;
    }

    // 如果没有可用的版本列表，不处理
    if (dsymList.length === 0) {
      return;
    }

    // 尝试从崩溃日志中提取版本号
    const extractedVersion = extractVersionFromCrashLog(crashLog);
    
    // 获取主应用版本列表
    const availableVersions = Array.from(
      new Set(
        dsymList
          .filter(d => d.appName.toUpperCase() === 'NNIM')
          .map(d => d.version)
      )
    ).sort((a, b) => b.localeCompare(a));

    if (availableVersions.length === 0) {
      return;
    }

    let selectedVersion: string;
    let messageText: string;
    let messageType: 'success' | 'warning' | 'info' = 'success';

    if (extractedVersion && availableVersions.includes(extractedVersion)) {
      // 检测到版本号且在可用列表中 → 自动符号化
      selectedVersion = extractedVersion;
      messageText = `已自动检测并选择版本 ${extractedVersion}`;
      messageType = 'success';
    } else {
      // 无法提取版本号或版本号不在列表中 → 只自动选版本，不自动符号化，等用户确认
      selectedVersion = availableVersions[0];
      if (extractedVersion) {
        messageText = `检测到版本 ${extractedVersion} 但未找到对应 dSYM，已自动选择最高版本 ${selectedVersion}`;
        messageType = 'warning';
      } else {
        messageText = `未检测到版本号，已自动选择最高版本 ${selectedVersion}`;
        messageType = 'info';
      }
    }

    // 使用静默模式选择版本（不显示组件库关联提示）
    handleMainAppVersionChange(selectedVersion, true);

    // 获取关联的组件库数量
    const relatedComponents = dsymList.filter(
      d => d.appName.toUpperCase() !== 'NNIM' && 
      d.relatedAppVersions && 
      d.relatedAppVersions.includes(selectedVersion)
    );

    // 合并提示信息
    if (relatedComponents.length > 0) {
      messageText += `，已关联 ${relatedComponents.length} 个组件库`;
    }

    // 显示一条合并的提示
    if (messageType === 'success') {
      message.success(messageText);
      // 版本识别成功且是文件上传触发的，自动符号化
      if (autoSymbolicate) {
        // autoSymbolicate 已经是 true，等 selectedUUIDs 更新后会自动触发
      }
    } else if (messageType === 'warning') {
      message.warning(messageText);
      // 版本识别失败，取消自动符号化，让用户手动确认
      setAutoSymbolicate(false);
    } else {
      message.info(messageText);
      // 未识别到版本，取消自动符号化
      setAutoSymbolicate(false);
    }
  }, [crashLog, dsymList, selectedMainAppVersion]);

  // 当选择主应用版本时，自动关联组件库
  const handleMainAppVersionChange = (version: string | undefined, silentOrOption?: boolean | any) => {
    // 判断第二个参数是否是 silent 标志（boolean）还是 Select 的 option 参数
    const silent = typeof silentOrOption === 'boolean' ? silentOrOption : false;
    setSelectedMainAppVersion(version);
    
    if (!version) {
      // 清空选择
      setSelectedUUIDs([]);
      return;
    }

    // 找到选中的主应用 dSYM
    const mainAppDsym = dsymList.find(
      d => d.appName.toUpperCase() === 'NNIM' && d.version === version
    );

    if (!mainAppDsym) {
      setSelectedUUIDs([]);
      return;
    }

    // 找到所有关联到这个主应用版本的组件库
    const relatedComponents = dsymList.filter(
      d => d.appName.toUpperCase() !== 'NNIM' && 
      d.relatedAppVersions && 
      d.relatedAppVersions.includes(version)
    );

    // 自动选择：主应用 + 所有关联的组件库
    const autoSelectedUUIDs = [
      mainAppDsym.uuid,
      ...relatedComponents.map(c => c.uuid)
    ];

    setSelectedUUIDs(autoSelectedUUIDs);
    
    // 只在非静默模式下显示提示
    if (!silent && relatedComponents.length > 0) {
      message.success(`已自动选择主应用和 ${relatedComponents.length} 个关联组件库`);
    }
  };

  // 获取主应用版本列表（去重，并清理空格）
  const mainAppVersions = Array.from(
    new Set(
      dsymList
        .filter(d => d.appName.toUpperCase() === 'NNIM')
        .map(d => d.version.trim()) // 清理空格
    )
  ).sort((a, b) => b.localeCompare(a));
  
  // 调试：输出版本列表
  console.log('主应用版本列表:', mainAppVersions);

  const handleSymbolicate = async () => {
    if (!crashLog.trim()) {
      message.warning('请输入崩溃日志');
      return;
    }

    // 尝试从崩溃日志中提取版本号
    const extractedVersion = extractVersionFromCrashLog(crashLog);

    // 如果没有选择主应用版本，或者选择的版本与崩溃日志版本不同，尝试自动选择
    let versionToUse = selectedMainAppVersion;
    let uuidsToUse = selectedUUIDs;

    // 如果提取到了版本号，且与当前选择的不同，强制重新选择
    if (extractedVersion && extractedVersion !== selectedMainAppVersion) {
      versionToUse = undefined;
    }

    if (!versionToUse) {
      
      if (extractedVersion && mainAppVersions.includes(extractedVersion)) {
        // 找到完全匹配的版本
        versionToUse = extractedVersion;
        message.success(`已自动检测并选择版本 ${extractedVersion}`);
      } else if (extractedVersion) {
        // 提取到版本号，但没有完全匹配的 dSYM
        // 尝试查找最接近的版本
        const closestVersion = findClosestVersion(extractedVersion, mainAppVersions);
        
        if (closestVersion) {
          versionToUse = closestVersion;
          message.warning(
            `崩溃日志版本为 ${extractedVersion}，但未找到对应 dSYM。` +
            `已自动选择最接近的版本 ${closestVersion}，符号化结果可能不完全准确。`,
            6
          );
        } else {
          // 如果没有找到接近的版本，使用最高版本
          const highestVersion = getHighestVersion();
          if (highestVersion) {
            versionToUse = highestVersion;
            message.warning(
              `崩溃日志版本为 ${extractedVersion}，但未找到对应 dSYM。` +
              `已使用最高版本 ${highestVersion}，符号化结果可能不准确。`,
              6
            );
          } else {
            message.error('未找到可用的 dSYM 版本，请先上传对应版本的 dSYM 文件');
            return;
          }
        }
      } else {
        // 未检测到版本号，使用最高版本
        const highestVersion = getHighestVersion();
        if (highestVersion) {
          versionToUse = highestVersion;
          message.info(`未检测到版本号，使用最高版本 ${highestVersion}`);
        } else {
          message.warning('未找到可用的 dSYM 版本，请先上传 dSYM 文件');
          return;
        }
      }

      // 获取该版本对应的 UUIDs
      const mainAppDsym = dsymList.find(
        d => d.appName.toUpperCase() === 'NNIM' && d.version === versionToUse
      );

      if (!mainAppDsym) {
        message.error('未找到对应的主应用 dSYM');
        return;
      }

      // 找到所有关联到这个主应用版本的组件库
      const relatedComponents = dsymList.filter(
        d => d.appName.toUpperCase() !== 'NNIM' && 
        d.relatedAppVersions && 
        d.relatedAppVersions.includes(versionToUse!)
      );

      uuidsToUse = [mainAppDsym.uuid, ...relatedComponents.map(c => c.uuid)];

      // 更新状态（用于UI显示）
      setSelectedMainAppVersion(versionToUse);
      setSelectedUUIDs(uuidsToUse);
    }

    // 如果没有选择 dSYM
    if (uuidsToUse.length === 0) {
      message.warning('未找到对应的 dSYM 文件');
      return;
    }

    try {
      setSymbolicating(true);
      setResult(null);
      setErrorDetail(null);
      setCanAnalyze(false);

      // 只进行符号化，不传递 API Key
      const response = await symbolicateApi.symbolicate(crashLog, uuidsToUse);

      if (response.success && response.data) {
        // 检查是否有AI分析结果（兼容两种字段名）
        const aiAnalysisData = response.data.aiAnalysis || response.data.analysis;
        const hasAIAnalysis = aiAnalysisData !== undefined && aiAnalysisData !== null;
        const fromHistory = response.data.fromHistory === true;
        const fromCache = response.data.fromCache === true;
        
        if (response.data.warning) {
          message.warning('符号化完成，但存在警告');
        } else if (fromHistory) {
          message.success('已从历史记录中加载结果（无需重新符号化）');
        } else if (fromCache) {
          message.success('已从缓存中加载结果（快速响应）');
        } else if (hasAIAnalysis) {
          message.success('符号化成功！已自动加载之前的AI分析结果');
        } else {
          message.success('符号化成功！');
        }
        
        const nextResult = {
          original: response.data.originalLog,
          symbolicated: response.data.symbolicatedLog,
          uuid: response.data.matchedUUIDs 
            ? response.data.matchedUUIDs.join(', ') 
            : (response.data.matchedUUID || ''),
          warning: response.data.warning,
          analysis: aiAnalysisData, // 保存AI分析结果
          historyId: response.data.historyId, // 保存历史记录ID
        };
        setResult(nextResult);
        
        // 符号化成功后，如果没有AI分析结果，允许进行AI分析
        setCanAnalyze(!hasAIAnalysis);
        if (autoAnalyzeAfterSymbolicate && !hasAIAnalysis) {
          setAutoAnalyzeAfterSymbolicate(false);
          setIsAnalyzing(true);
          try {
            const analysisResponse = await symbolicateApi.analyze(
              response.data.symbolicatedLog,
              uuidsToUse,
              apiKey || undefined
            );
            if (analysisResponse.success && analysisResponse.data) {
              message.success('符号化完成，AI 分析完成！');
              setResult({
                ...nextResult,
                analysis: analysisResponse.data,
              });
              setCanAnalyze(false);
            } else {
              throw new Error(analysisResponse.error || 'AI 分析失败');
            }
          } catch (analysisError: any) {
            const analysisErrorMsg = analysisError.error || analysisError.message || 'AI 分析失败';
            message.error(analysisErrorMsg);
          } finally {
            setIsAnalyzing(false);
          }
        }
      } else {
        throw new Error(response.error || '符号化失败');
      }
    } catch (error: any) {
      const errorMsg = error.error || error.message || '符号化失败';
      
      // 如果错误消息包含 UUID 列表，保存详细信息
      if (errorMsg.includes('崩溃日志中包含以下二进制文件')) {
        setErrorDetail(errorMsg);
        message.error('UUID 不匹配，请查看下方详细信息');
      } else {
        message.error(errorMsg);
      }
    } finally {
      setSymbolicating(false);
    }
  };

  const handleAIAnalysis = async () => {
    if (!result) {
      message.warning('请先进行符号化');
      return;
    }

    if (!apiKey || apiKey.trim().length === 0) {
      message.warning('请输入 OpenAI API Key，或在后端配置默认 Key');
      return;
    }

    try {
      setIsAnalyzing(true);

      // 调用独立的AI分析接口
      const response = await symbolicateApi.analyze(result.symbolicated, selectedUUIDs, apiKey);

      if (response.success && response.data) {
        message.success('AI 分析完成！');
        setResult({
          ...result,
          analysis: response.data,
        });
      } else {
        throw new Error(response.error || 'AI 分析失败');
      }
    } catch (error: any) {
      const errorMsg = error.error || error.message || 'AI 分析失败';
      message.error(errorMsg);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // 处理标签页切换
  const handleTabChange = (activeKey: string) => {
    // 如果切换到 AI 分析标签页，且还没有分析过，自动触发分析
    if (activeKey === 'analysis' && result && !result.analysis && !isAnalyzing && apiKey) {
      handleAIAnalysis();
    }
  };

  const handleShare = async () => {
    if (!result) {
      return;
    }

    try {
      // 获取应用版本号
      let appVersion = 'unknown';
      if (selectedMainAppVersion) {
        appVersion = selectedMainAppVersion;
      } else {
        const extractedVersion = extractVersionFromCrashLog(crashLog);
        if (extractedVersion) {
          appVersion = extractedVersion;
        }
      }

      // 从符号化结果中获取 historyId
      // 符号化时已经自动保存到历史记录并返回了 historyId
      const historyId = (result as any).historyId;

      if (!historyId) {
        message.error('无法生成分享链接，历史记录ID不存在');
        return;
      }

      // 构建详情链接
      const baseUrl = window.location.origin;
      const detailUrl = `${baseUrl}/history?id=${historyId}`;

      // 构建分享内容
      const shareContent = {
        title: '',
        description: [
          `📱 应用版本：${appVersion}`,
          result.analysis?.crashType && `💥 崩溃类型：${result.analysis.crashType}`,
          result.analysis?.crashModule && `🔧 崩溃模块：${result.analysis.crashModule}`,
          result.analysis?.crashLocation && `📍 崩溃位置：${result.analysis.crashLocation}`,
          `⏰ 时间：${new Date().toLocaleString('zh-CN')}`,
        ].filter(Boolean).join('\n'),
        url: detailUrl,
      };

      const success = await shareToWeChatWork(shareContent);
      if (success) {
        message.success('分享链接已复制到剪贴板，请在企业微信中粘贴发送', 3);
      } else {
        message.error('复制失败');
      }
    } catch (error) {
      message.error('分享失败');
      console.error('分享失败', error);
    }
  };

  const handleDownload = async () => {
    if (!result) {
      return;
    }

    try {
      // 获取应用版本号
      let appVersion = 'unknown';
      if (selectedMainAppVersion) {
        appVersion = selectedMainAppVersion;
      } else {
        // 尝试从崩溃日志中提取版本号
        const extractedVersion = extractVersionFromCrashLog(crashLog);
        if (extractedVersion) {
          appVersion = extractedVersion;
        }
      }

      // 下载ZIP报告（包含符号化日志和AI分析PDF）
      await symbolicateApi.downloadReport(
        result.symbolicated,
        result.analysis,
        appVersion,
        crashLog
      );
      message.success('下载成功');
    } catch (error) {
      message.error('下载失败');
    }
  };

  const sanitizeFilename = (value: string) => {
    return value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 80) || 'crash';
  };

  const getOriginalCrashFileName = () => {
    if (originalCrashFileName) {
      return originalCrashFileName;
    }

    const sourceLog = result?.original || crashLog;
    const extension = sourceLog.trim().startsWith('{') ? 'ips' : 'crash';
    const version = selectedMainAppVersion || extractVersionFromCrashLog(sourceLog);
    return version
      ? `original_crash_${sanitizeFilename(version)}.${extension}`
      : generateFilename('original_crash', extension);
  };

  const handleDownloadOriginalCrash = () => {
    const originalLog = result?.original || crashLog;
    if (!originalLog.trim()) {
      message.warning('暂无原始崩溃文件可下载');
      return;
    }

    downloadTextFile(originalLog, getOriginalCrashFileName());
    message.success('原始崩溃文件下载已开始');
  };

  // 从崩溃日志中提取版本号
  const extractVersionFromCrashLog = (crashLog: string): string | null => {
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
    
    // 方法2: 从 Binary Images 部分提取主应用的版本
    const binaryImageMatch = crashLog.match(/Binary Images:[\s\S]*?0x[0-9a-f]+\s+-\s+0x[0-9a-f]+\s+NNIM\s+\S+\s+<[^>]+>\s+[^\n]*\(([^\)]+)\)/i);
    if (binaryImageMatch) {
      return binaryImageMatch[1].trim();
    }
    
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
  };

  // 查找最接近的版本号
  const findClosestVersion = (targetVersion: string, availableVersions: string[]): string | null => {
    if (availableVersions.length === 0) {
      return null;
    }

    // 解析版本号为数字数组 [major, minor, patch]
    const parseVersion = (version: string): number[] => {
      return version.split('.').map(v => parseInt(v, 10) || 0);
    };

    const target = parseVersion(targetVersion);
    
    // 计算版本差异
    const calculateDiff = (v1: number[], v2: number[]): number => {
      // 主版本号差异权重最高
      const majorDiff = Math.abs(v1[0] - v2[0]) * 10000;
      const minorDiff = Math.abs((v1[1] || 0) - (v2[1] || 0)) * 100;
      const patchDiff = Math.abs((v1[2] || 0) - (v2[2] || 0));
      return majorDiff + minorDiff + patchDiff;
    };

    // 找到差异最小的版本
    let closestVersion = availableVersions[0];
    let minDiff = calculateDiff(target, parseVersion(closestVersion));

    for (const version of availableVersions) {
      const diff = calculateDiff(target, parseVersion(version));
      if (diff < minDiff) {
        minDiff = diff;
        closestVersion = version;
      }
    }

    // 如果主版本号不同，返回 null（差异太大）
    if (target[0] !== parseVersion(closestVersion)[0]) {
      return null;
    }

    return closestVersion;
  };

  // 获取最高版本号
  const getHighestVersion = (): string | undefined => {
    if (mainAppVersions.length === 0) {
      return undefined;
    }
    // mainAppVersions 已经按降序排序，第一个就是最高版本
    return mainAppVersions[0];
  };

  // 处理崩溃日志变化（手动粘贴）
  const handleCrashLogChange = (value: string) => {
    setCrashLog(value);
    setResult(null);
    setCanAnalyze(false);
    setErrorDetail(null);
    setSelectedMainAppVersion(undefined);
    setSelectedUUIDs([]);
    setOriginalCrashFileName('');
  };

  const uploadProps: UploadProps = {
    accept: '.crash,.ips,.txt',
    beforeUpload: (file) => {
      // 清空之前的状态
      setResult(null);
      setCanAnalyze(false);
      setErrorDetail(null);
      setSelectedMainAppVersion(undefined);
      setSelectedUUIDs([]);
      setOriginalCrashFileName(file.name);
      
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        setCrashLog(content);
        // 清除之前的版本选择，强制重新自动选择
        console.log('文件上传：清除版本选择');
        setSelectedMainAppVersion(undefined);
        setSelectedUUIDs([]);
        message.success('文件读取成功');
        
        // 设置一个标记，表示需要自动符号化
        setAutoSymbolicate(true);
      };
      reader.readAsText(file);
      return false;
    },
    showUploadList: false,
  };

  return (
    <div>
      <Title level={2}>Crash 符号化</Title>
      <Paragraph type="secondary">
        粘贴或上传 iOS 崩溃日志，系统会自动匹配对应的 dSYM 文件并进行符号化处理。
      </Paragraph>

      <Collapse
        style={{ marginTop: 16 }}
        items={[
          {
            key: 'help',
            label: (
              <Space>
                <QuestionCircleOutlined />
                <Text strong>手动符号化说明（使用 atos 命令）</Text>
              </Space>
            ),
            children: (
              <div>
                <Paragraph>
                  如果需要手动符号化单个地址，可以直接使用 <Text code>atos</Text> 命令：
                </Paragraph>

                <Title level={5}>方式一：使用地址符号化</Title>
                <Paragraph>
                  <pre
                    style={{
                      background: '#f5f5f5',
                      padding: '12px',
                      borderRadius: '4px',
                      overflow: 'auto',
                    }}
                  >
                    {`atos -arch <架构> -o <dSYM路径> -l <加载基址> <目标地址>`}
                  </pre>
                </Paragraph>
                <Paragraph>
                  <Text strong>示例：</Text>
                  <pre
                    style={{
                      background: '#f5f5f5',
                      padding: '12px',
                      borderRadius: '4px',
                      overflow: 'auto',
                    }}
                  >
                    {`# 符号化单个地址
atos -o ./NNIM.app.dSYM/Contents/Resources/DWARF/NNIM -l 0x107ac0000 0x107b8b004

# 符号化多个地址
atos -o ./NNIM.app.dSYM/Contents/Resources/DWARF/NNIM -l 0x107ac0000 0x107b8b004 0x107b8b100`}
                  </pre>
                </Paragraph>

                <Title level={5}>方式二：使用偏移量符号化</Title>
                <Paragraph>
                  <pre
                    style={{
                      background: '#f5f5f5',
                      padding: '12px',
                      borderRadius: '4px',
                      overflow: 'auto',
                    }}
                  >
                    {`atos -arch <架构> -o <dSYM路径> <偏移量>`}
                  </pre>
                </Paragraph>
                <Paragraph>
                  <Text strong>示例：</Text>
                  <pre
                    style={{
                      background: '#f5f5f5',
                      padding: '12px',
                      borderRadius: '4px',
                      overflow: 'auto',
                    }}
                  >
                    {`atos -arch arm64 -o NNRtc.dSYM/Contents/Resources/DWARF/NNRtc 895660`}
                  </pre>
                </Paragraph>

                <Title level={5}>如何获取参数</Title>
                <Paragraph>
                  从崩溃日志中提取信息：
                  <pre
                    style={{
                      background: '#f5f5f5',
                      padding: '12px',
                      borderRadius: '4px',
                      overflow: 'auto',
                      fontSize: '12px',
                    }}
                  >
                    {`Thread 0 Crashed:
0   NNIM    0x107b8b004    0x107ac0000 + 831492
            ↑ 目标地址      ↑ 加载基址    ↑ 偏移量

Binary Images:
0x107ac0000 - 0x107ffffff NNIM arm64  <e08bdb14efd731409629ff39911fd971>
↑ 加载基址                           ↑ 架构      ↑ UUID`}
                  </pre>
                </Paragraph>

                <Paragraph>
                  <Text strong>参数说明：</Text>
                  <ul>
                    <li>
                      <Text code>-arch</Text>：指定架构（arm64、armv7 等），通常可以省略
                    </li>
                    <li>
                      <Text code>-o</Text>：dSYM 文件中的 DWARF 文件路径
                    </li>
                    <li>
                      <Text code>-l</Text>：二进制的加载基址（从 Binary Images 部分获取）
                    </li>
                    <li>最后的参数：要符号化的内存地址或偏移量</li>
                  </ul>
                </Paragraph>

                <Paragraph>
                  <Text strong>输出示例：</Text>
                  <pre
                    style={{
                      background: '#f5f5f5',
                      padding: '12px',
                      borderRadius: '4px',
                      overflow: 'auto',
                    }}
                  >
                    {`$ atos -o ./NNIM.app.dSYM/Contents/Resources/DWARF/NNIM -l 0x107ac0000 0x107b8b004
-[ViewController handleCrash:] (in NNIM) (ViewController.m:123)`}
                  </pre>
                </Paragraph>
              </div>
            ),
          },
        ]}
      />

      <Card style={{ marginTop: 24 }}>
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <div>
            <Space direction="vertical" style={{ width: '100%', marginBottom: 8 }} size={4}>
              <Space>
                <Text strong>崩溃日志：</Text>
                <Upload {...uploadProps}>
                  <Button icon={<UploadOutlined />} size="small">
                    上传文件
                  </Button>
                </Upload>
              </Space>
              <div style={{
                background: '#f0f5ff',
                border: '1px solid #adc6ff',
                borderRadius: 4,
                padding: '6px 10px',
                fontSize: 12
              }}>
                <a 
                  href={SENTRY_IOS_PROJECT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ 
                    color: '#1890ff',
                    textDecoration: 'none'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.textDecoration = 'underline';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.textDecoration = 'none';
                  }}
                >
                  📊 Sentry NN 项目
                </a>
              </div>
            </Space>
            <TextArea
              value={crashLog}
              onChange={(e) => handleCrashLogChange(e.target.value)}
              placeholder="粘贴崩溃日志内容，支持 Apple Crash Report 和 .ips 格式。系统会自动检测版本号，如无法检测则选择最高版本。"
              rows={12}
              style={{ fontFamily: 'monospace', fontSize: '12px' }}
            />
          </div>

          <div>
            <Space style={{ marginBottom: 8 }}>
              <Text strong>
                选择主应用版本 <Text type="danger">*</Text>：
              </Text>
              <Text type="secondary" style={{ fontSize: '12px' }}>
                将自动关联对应的组件库
              </Text>
            </Space>
            <Select
              style={{ width: '100%' }}
              placeholder="选择 NNIM 主应用版本（必选）"
              showSearch
              allowClear
              value={selectedMainAppVersion}
              onChange={handleMainAppVersionChange}
              status={!selectedMainAppVersion && crashLog ? 'error' : undefined}
              filterOption={(input, option) =>
                (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
              }
              options={mainAppVersions.map((version) => ({
                value: version,
                label: `NNIM ${version}`,
              }))}
            />
            {!selectedMainAppVersion && crashLog && (
              <Text type="danger" style={{ fontSize: '12px', marginTop: '4px', display: 'block' }}>
                请选择主应用版本
              </Text>
            )}
            {selectedUUIDs.length > 0 && (
              <Text type="success" style={{ fontSize: '12px', marginTop: '4px', display: 'block' }}>
                ✓ 已自动选择 {selectedUUIDs.length} 个 dSYM
                {selectedUUIDs.length > 1 && '（主应用 + 组件库）'}
              </Text>
            )}
          </div>

          {isAdmin && (
            <div>
              <Space style={{ marginBottom: 8 }}>
                <RobotOutlined />
                <Text strong>AI 智能分析（可选）：</Text>
              </Space>
              <APIKeyInput value={apiKey} onChange={setApiKey} />
              <Text type="secondary" style={{ fontSize: '12px', marginTop: '4px', display: 'block' }}>
                提供 OpenAI API Key 可获得智能崩溃分析。API Key 保存在浏览器本地；Sentry 自动解析可使用后端默认配置。
              </Text>
            </div>
          )}

          <Space direction="horizontal" style={{ width: '100%' }} size="middle">
            <Button
              type="primary"
              icon={<FileTextOutlined />}
              onClick={handleSymbolicate}
              loading={symbolicating}
              disabled={result !== null}
              size="large"
              style={{ flex: 1 }}
            >
              {symbolicating ? '符号化中...' : result !== null ? '已完成符号化' : '开始符号化'}
            </Button>
            {isAdmin && (
              <Button
                type="default"
                icon={<RobotOutlined />}
                onClick={handleAIAnalysis}
                loading={isAnalyzing}
                disabled={!canAnalyze || !apiKey || (result !== null && result.analysis !== undefined)}
                size="large"
                style={{ flex: 1 }}
              >
                {isAnalyzing ? 'AI 分析中...' : result !== null && result.analysis !== undefined ? '已完成分析' : 'AI 智能分析'}
              </Button>
            )}
          </Space>
        </Space>
      </Card>

      {errorDetail && (
        <Card style={{ marginTop: 24 }} title="UUID 不匹配">
          <Alert
            message="dSYM 文件版本不匹配"
            description={
              <div>
                <Paragraph>
                  你上传的 dSYM 文件与崩溃日志不是来自同一个构建版本。请上传正确版本的 dSYM 文件。
                </Paragraph>
                <Paragraph strong>崩溃日志中包含以下二进制文件及其 UUID：</Paragraph>
                <pre style={{ 
                  background: '#f5f5f5', 
                  padding: '12px', 
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  maxHeight: '300px',
                  overflow: 'auto'
                }}>
                  {errorDetail.split('\n').slice(2).join('\n')}
                </pre>
                <Paragraph type="secondary" style={{ marginTop: 16 }}>
                  <strong>如何找到正确的 dSYM：</strong>
                  <ul>
                    <li>检查 Xcode Organizer 中对应版本的 Archive</li>
                    <li>查看项目的 DerivedData 目录</li>
                    <li>如果是 App Store 崩溃，从 App Store Connect 下载对应版本的 dSYM</li>
                  </ul>
                </Paragraph>
              </div>
            }
            type="error"
            showIcon
          />
        </Card>
      )}

      {symbolicating && (
        <Card style={{ marginTop: 24 }}>
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 16 }}>
              <Text type="secondary">正在符号化，请稍候...</Text>
            </div>
          </div>
        </Card>
      )}

      {result && (
        <Card
          style={{ marginTop: 24 }}
          title="符号化结果"
          extra={
            <Space>
              <Button icon={<ShareAltOutlined />} onClick={handleShare}>
                分享
              </Button>
              <Button icon={<DownloadOutlined />} onClick={handleDownload}>
                下载
              </Button>
              <Button icon={<DownloadOutlined />} onClick={handleDownloadOriginalCrash}>
                下载原始
              </Button>
            </Space>
          }
        >
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Alert
              message={
                <Space>
                  <Text>匹配的 UUID：</Text>
                  <Text code>{result.uuid}</Text>
                  {result.warning && (
                    <Button
                      type="link"
                      size="small"
                      icon={<WarningOutlined />}
                      onClick={() => setShowWarningModal(true)}
                      style={{ padding: 0, height: 'auto' }}
                    >
                      查看警告详情
                    </Button>
                  )}
                </Space>
              }
              type={result.warning ? 'warning' : 'success'}
              showIcon
            />

            <Tabs
              defaultActiveKey="symbolicated"
              onChange={handleTabChange}
              items={[
                {
                  key: 'symbolicated',
                  label: '符号化后',
                  children: (
                    <TextArea
                      value={result.symbolicated}
                      readOnly
                      rows={20}
                      style={{ fontFamily: 'monospace', fontSize: '12px' }}
                    />
                  ),
                },
                {
                  key: 'analysis',
                  label: (
                    <Space>
                      <RobotOutlined />
                      AI 智能分析
                      {result.analysis && <Text type="success" style={{ fontSize: '12px' }}>✓</Text>}
                    </Space>
                  ),
                  children: (
                    <AIAnalysisPanel analysis={result.analysis || null} loading={isAnalyzing} />
                  ),
                },
                {
                  key: 'original',
                  label: (
                    <Space>
                      原始日志
                      <Button
                        type="link"
                        size="small"
                        icon={<DownloadOutlined />}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleDownloadOriginalCrash();
                        }}
                        style={{ padding: 0 }}
                      >
                        下载原始
                      </Button>
                    </Space>
                  ),
                  children: (
                    <TextArea
                      value={result.original}
                      readOnly
                      rows={20}
                      style={{ fontFamily: 'monospace', fontSize: '12px' }}
                    />
                  ),
                },
              ]}
            />
          </Space>
        </Card>
      )}

      {/* UUID 不匹配警告弹窗 */}
      <Modal
        title={
          <Space>
            <WarningOutlined style={{ color: '#faad14' }} />
            UUID 不匹配警告
          </Space>
        }
        open={showWarningModal}
        onCancel={() => setShowWarningModal(false)}
        footer={[
          <Button key="close" type="primary" onClick={() => setShowWarningModal(false)}>
            知道了
          </Button>,
        ]}
        width={700}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Alert
            message="dSYM 文件版本不匹配"
            description="你上传的 dSYM 文件与崩溃日志不是来自同一个构建版本。请上传正确版本的 dSYM 文件。"
            type="warning"
            showIcon
          />
          
          {result?.warning && (
            <div>
              <Paragraph strong>崩溃日志中包含以下二进制文件及其 UUID：</Paragraph>
              <pre
                style={{
                  background: '#f5f5f5',
                  padding: '12px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  maxHeight: '300px',
                  overflow: 'auto',
                }}
              >
                {result.warning.split('\n').slice(2).join('\n')}
              </pre>
            </div>
          )}

          <div>
            <Paragraph strong>如何找到正确的 dSYM：</Paragraph>
            <ul>
              <li>检查 Xcode Organizer 中对应版本的 Archive</li>
              <li>查看项目的 DerivedData 目录</li>
              <li>如果是 App Store 崩溃，从 App Store Connect 下载对应版本的 dSYM</li>
            </ul>
          </div>
        </Space>
      </Modal>
    </div>
  );
}
