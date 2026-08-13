import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Typography, Card, Space, Tag, Button, message, Popconfirm, Empty, Spin, Modal, Tabs, Input, Select } from 'antd';
import { ClockCircleOutlined, DeleteOutlined, EyeOutlined, ThunderboltOutlined, DownloadOutlined, ShareAltOutlined, CheckCircleOutlined, CloseCircleOutlined, SearchOutlined, UpOutlined, DownOutlined } from '@ant-design/icons';
import { authUtils } from '../utils/auth';
import { formatDateTime } from '../utils/helpers';
import AIAnalysisPanel from '../components/AIAnalysisPanel';
import { historyApi } from '../services/api';
import { shareToWeChatWork, generateCrashReportShareContent } from '../utils/wechatShare';

const { Title, Paragraph, Text } = Typography;

interface HistoryRecord {
  id: number;
  appVersion: string;
  versionDetected: boolean;
  crashType?: string;
  crashReason?: string;
  lastStackCall?: string;
  crashModule?: string;
  crashLocation?: string;
  originalLog: string;
  symbolicatedLog: string;
  usedUuids: string[];
  aiAnalysis?: any;
  isFixed: boolean;
  fixedVersion?: string;
  fixedRemark?: string;
  createdAt: string;
}

type ModuleFilter = 'rtc' | 'im' | 'other';
type CrashCategoryFilter =
  | 'unrecognized_selector'
  | 'wild_pointer'
  | 'memory_leak'
  | 'non_ui_thread'
  | 'watchdog'
  | 'app_hanging'
  | 'memory'
  | 'signal'
  | 'other';

const CRASH_CATEGORY_OPTIONS: Array<{ value: CrashCategoryFilter; label: string }> = [
  { value: 'unrecognized_selector', label: 'Unrecognized Selector' },
  { value: 'wild_pointer', label: '野指针' },
  { value: 'memory_leak', label: '内存泄露' },
  { value: 'non_ui_thread', label: '非UI线程操作' },
  { value: 'watchdog', label: 'Watchdog 超时' },
  { value: 'app_hanging', label: 'App hanging' },
  { value: 'memory', label: '内存过高/Jetsam' },
  { value: 'signal', label: 'Signal/EXC' },
  { value: 'other', label: '其他' },
];

export default function HistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [historyData, setHistoryData] = useState<HistoryRecord[]>([]);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<HistoryRecord | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [activeTab, setActiveTab] = useState('log'); // 当前激活的标签
  const [queryText, setQueryText] = useState('');
  const [detailSearchText, setDetailSearchText] = useState('');
  const [activeDetailMatchIndex, setActiveDetailMatchIndex] = useState(0);
  const [fixedFilter, setFixedFilter] = useState<'all' | 'fixed' | 'unfixed'>('all');
  const [versionFilter, setVersionFilter] = useState('all');
  const [moduleFilters, setModuleFilters] = useState<ModuleFilter[]>([]);
  const [crashCategoryFilter, setCrashCategoryFilter] = useState<CrashCategoryFilter | 'all'>('all');
  const openedUrlHistoryIdRef = useRef<number | null>(null);
  const detailMatchRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const autoAnalyzingRecordIds = useRef(new Set<number>());
  const isAdmin = authUtils.isAdmin();
  const canAnalyzeCrash = authUtils.hasAnyRole(['tester', 'developer', 'admin']);

  // 从 localStorage 获取保存的 OpenAI API Key
  const getSavedApiKey = () => {
    return localStorage.getItem('openai_api_key') || '';
  };

  useEffect(() => {
    loadHistory();
  }, []);

  // 监听 URL 参数变化，自动打开详情
  useEffect(() => {
    const idParam = searchParams.get('id');
    if (idParam && historyData.length > 0) {
      const id = parseInt(idParam, 10);
      if (openedUrlHistoryIdRef.current === id) {
        return;
      }
      const record = historyData.find(r => r.id === id);
      if (record) {
        openedUrlHistoryIdRef.current = id;
        handleViewDetail(record);
        // 清除 URL 参数，避免刷新时重复打开
        // setSearchParams({});
      } else {
        message.warning(`未找到 ID 为 ${id} 的历史记录`);
      }
    }
  }, [searchParams, historyData]);

  const loadHistory = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/history/list');
      const data = await response.json();

      if (data.success) {
        // 将分组数据转换为平铺列表
        const allRecords: HistoryRecord[] = [];
        Object.values(data.data).forEach((records: any) => {
          allRecords.push(...records);
        });
        // 按时间降序排序
        allRecords.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        console.log('历史记录数据:', allRecords);
        setHistoryData(allRecords);
      } else {
        throw new Error(data.error || '获取历史记录失败');
      }
    } catch (error: any) {
      message.error(error.message || '获取历史记录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/history/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      const data = await response.json();

      if (data.success) {
        message.success('删除成功');
        loadHistory();
      } else {
        throw new Error(data.error || '删除失败');
      }
    } catch (error: any) {
      message.error(error.message || '删除失败');
    }
  };

  const handleViewDetail = async (record: HistoryRecord) => {
    const isOpeningDifferentRecord = !detailModalVisible || selectedRecord?.id !== record.id;
    setSelectedRecord(record);
    setDetailModalVisible(true);
    if (isOpeningDifferentRecord) {
      setActiveTab(record.aiAnalysis ? 'analysis' : 'log');
      setDetailSearchText('');
      setActiveDetailMatchIndex(0);
    }

    try {
      const response = await historyApi.detail(record.id);
      if (response.success && response.data) {
        setSelectedRecord(response.data);
        setHistoryData((prev) =>
          prev.map((item) => (item.id === response.data!.id ? response.data! : item))
        );
      }
    } catch (error: any) {
      message.warning(error?.message || '刷新历史详情失败，当前显示可能不是最新结果');
    }
  };

  const handleCloseDetail = () => {
    setDetailModalVisible(false);
    setDetailSearchText('');
    setActiveDetailMatchIndex(0);
    detailMatchRefs.current = [];
    openedUrlHistoryIdRef.current = null;
    // 清除 URL 参数
    if (searchParams.get('id')) {
      setSearchParams({});
    }
  };

  const updateRecordFixedState = (recordId: number, isFixed: boolean, fixedVersion?: string, fixedRemark?: string) => {
    const updater = (record: HistoryRecord): HistoryRecord =>
      record.id === recordId
        ? {
          ...record,
          isFixed,
          fixedVersion: isFixed ? fixedVersion : undefined,
          fixedRemark: isFixed ? fixedRemark : undefined,
        }
        : record;
    setHistoryData((prev) => prev.map(updater));
    setSelectedRecord((record) => record ? updater(record) : record);
  };

  const handleToggleFixed = async (record: HistoryRecord) => {
    try {
      const newStatus = !record.isFixed;
      
      if (newStatus) {
        // 标记为已修复，需要输入修复版本
        Modal.confirm({
          title: '标记为已修复',
          width: 520,
          okText: '确定',
          cancelText: '取消',
          content: (
            <div>
              <p style={{ marginBottom: 8 }}>请输入修复版本号：</p>
              <Input
                id="fixed-version-input"
                placeholder="例如：1.0.1"
                defaultValue=""
              />
              <p style={{ marginTop: 16, marginBottom: 8 }}>修复备注（可选）：</p>
              <Input.TextArea
                id="fixed-remark-input"
                placeholder="例如：修复原因、关联 PR 或验证结果"
                autoSize={{ minRows: 3, maxRows: 5 }}
                maxLength={500}
                showCount
              />
            </div>
          ),
          onOk: async () => {
            const input = document.getElementById('fixed-version-input') as HTMLInputElement;
            const remarkInput = document.getElementById('fixed-remark-input') as HTMLTextAreaElement;
            const fixedVersion = input?.value?.trim();
            const fixedRemark = remarkInput?.value?.trim();
            
            if (!fixedVersion) {
              message.error('请输入修复版本号');
              return Promise.reject();
            }
            
            await historyApi.updateFixedStatus(record.id, true, fixedVersion, fixedRemark);
            updateRecordFixedState(record.id, true, fixedVersion, fixedRemark);
            message.success('已标记为已修复');
            loadHistory();
          },
        });
      } else {
        // 标记为未修复，直接更新
        await historyApi.updateFixedStatus(record.id, false);
        updateRecordFixedState(record.id, false);
        message.success('已标记为未修复');
        loadHistory();
      }
    } catch (error: any) {
      message.error('更新修复状态失败');
    }
  };

  const handleShareToWechat = async (record: HistoryRecord) => {
    try {
      const shareContent = generateCrashReportShareContent(record);
      const success = await shareToWeChatWork(shareContent);
      
      if (success) {
        message.success('分享内容已复制到剪贴板，请在企业微信中粘贴发送', 3);
      } else {
        message.error('复制失败，请手动复制分享内容');
      }
    } catch (error: any) {
      message.error('分享失败');
    }
  };

  const handleAnalyze = () => {
    if (!canAnalyzeCrash) {
      message.warning('AI 分析需要测试、研发或管理员权限');
      return;
    }
    const savedApiKey = getSavedApiKey();
    startAnalysis(savedApiKey || '');
  };

  const handleTabChange = (activeKey: string) => {
    setActiveTab(activeKey); // 更新当前激活的标签
    if (activeKey === 'analysis' && canAnalyzeCrash && selectedRecord && !selectedRecord.aiAnalysis && !analyzing) {
      if (!autoAnalyzingRecordIds.current.has(selectedRecord.id)) {
        autoAnalyzingRecordIds.current.add(selectedRecord.id);
        startAnalysis(getSavedApiKey() || '');
      }
    }
  };

  const startAnalysis = async (key: string) => {
    if (!selectedRecord || analyzing) {
      return;
    }

    try {
      setAnalyzing(true);

      const result = await historyApi.analyzeHistory(selectedRecord.id, key);

      if (result.success) {
        message.success('AI 分析完成');
        // 更新当前记录
        setSelectedRecord({
          ...selectedRecord,
          aiAnalysis: result.data,
        });
        // 刷新历史记录列表
        loadHistory();
      } else {
        throw new Error(result.error || 'AI 分析失败');
      }
    } catch (error: any) {
      message.error(error.message || 'AI 分析失败');
    } finally {
      setAnalyzing(false);
    }
  };

  useEffect(() => {
    if (
      !detailModalVisible ||
      activeTab !== 'analysis' ||
      !selectedRecord ||
      selectedRecord.aiAnalysis ||
      analyzing ||
      autoAnalyzingRecordIds.current.has(selectedRecord.id)
    ) {
      return;
    }

    autoAnalyzingRecordIds.current.add(selectedRecord.id);
    startAnalysis(getSavedApiKey() || '');
  }, [detailModalVisible, activeTab, selectedRecord?.id, selectedRecord?.aiAnalysis, analyzing]);

  const detailSearchKeyword = detailSearchText.trim();
  const detailMatchCount = useMemo(() => {
    if (!selectedRecord || !detailSearchKeyword) return 0;

    const lowerLog = selectedRecord.symbolicatedLog.toLowerCase();
    const lowerKeyword = detailSearchKeyword.toLowerCase();
    let count = 0;
    let searchIndex = 0;
    let matchIndex = lowerLog.indexOf(lowerKeyword, searchIndex);

    while (matchIndex !== -1) {
      count += 1;
      searchIndex = matchIndex + lowerKeyword.length;
      matchIndex = lowerLog.indexOf(lowerKeyword, searchIndex);
    }

    return count;
  }, [selectedRecord, detailSearchKeyword]);

  useEffect(() => {
    setActiveDetailMatchIndex(0);
    detailMatchRefs.current = [];
  }, [detailSearchKeyword, selectedRecord?.id]);

  useEffect(() => {
    if (!detailMatchCount) return;
    detailMatchRefs.current[activeDetailMatchIndex]?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
  }, [activeDetailMatchIndex, detailMatchCount]);

  const jumpDetailMatch = (direction: 1 | -1) => {
    if (!detailMatchCount) return;
    setActiveDetailMatchIndex((current) => (current + direction + detailMatchCount) % detailMatchCount);
  };

  const renderHighlightedLog = (log: string) => {
    if (!detailSearchKeyword) return log;

    const lowerLog = log.toLowerCase();
    const lowerKeyword = detailSearchKeyword.toLowerCase();
    const nodes: React.ReactNode[] = [];
    let searchIndex = 0;
    let matchIndex = lowerLog.indexOf(lowerKeyword, searchIndex);
    let matchNumber = 0;

    while (matchIndex !== -1) {
      if (matchIndex > searchIndex) {
        nodes.push(log.slice(searchIndex, matchIndex));
      }

      const matchEnd = matchIndex + detailSearchKeyword.length;
      const isActive = matchNumber === activeDetailMatchIndex;
      const currentMatchNumber = matchNumber;
      nodes.push(
        <mark
          key={`match-${matchIndex}-${matchNumber}`}
          ref={(node) => {
            detailMatchRefs.current[currentMatchNumber] = node;
          }}
          style={{
            background: isActive ? '#ffb020' : '#fff1a8',
            color: '#1f1f1f',
            padding: '0 2px',
            borderRadius: 2,
            outline: isActive ? '1px solid #d48806' : 'none',
          }}
        >
          {log.slice(matchIndex, matchEnd)}
        </mark>
      );

      matchNumber += 1;
      searchIndex = matchEnd;
      matchIndex = lowerLog.indexOf(lowerKeyword, searchIndex);
    }

    if (searchIndex < log.length) {
      nodes.push(log.slice(searchIndex));
    }

    return nodes;
  };

  const normalizeSearchValue = (value: unknown): string => {
    return String(value || '')
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const compactSearchValue = (value: string): string => value.replace(/\s+/g, '');

  const includesSearchQuery = (source: string, query: string): boolean => {
    if (!query) return true;
    return source.includes(query) || compactSearchValue(source).includes(compactSearchValue(query));
  };

  const extractCrashedThreadSearchText = (log: string): string => {
    if (!log) return '';

    const crashedThreadNumber = log.match(/Crashed Thread:\s*(\d+)/i)?.[1];
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
      const match = log.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }

    return log
      .split(/\n\s*Binary Images:/i)[0]
      .split('\n')
      .slice(0, 80)
      .join('\n');
  };

  const getRecordModuleGroups = (record: HistoryRecord): ModuleFilter[] => {
    const searchable = normalizeSearchValue([
      record.crashModule,
      record.aiAnalysis?.crashModule,
    ].filter(Boolean).join('\n'));

    const groups = new Set<ModuleFilter>();
    if (/\bnnrtc\b/i.test(searchable)) {
      groups.add('rtc');
    }
    if (/leigod im cross sdk|im sdk/i.test(searchable)) {
      groups.add('im');
    }
    if (groups.size === 0) {
      groups.add('other');
    }

    return Array.from(groups);
  };

  const handleModuleFilterChange = (values: Array<ModuleFilter | 'all'>) => {
    if (values.includes('all')) {
      setModuleFilters([]);
      return;
    }
    setModuleFilters(values.filter((value): value is ModuleFilter => value === 'rtc' || value === 'im' || value === 'other'));
  };

  const getRecordCrashCategories = (record: HistoryRecord): CrashCategoryFilter[] => {
    const text = normalizeSearchValue([
      record.crashType,
      record.crashReason,
      record.lastStackCall,
      record.crashModule,
      record.crashLocation,
      record.aiAnalysis?.summary,
      record.aiAnalysis?.rootCause,
      record.aiAnalysis?.crashType,
      record.aiAnalysis?.crashReason,
      extractCrashedThreadSearchText(record.symbolicatedLog),
      extractCrashedThreadSearchText(record.originalLog),
    ].filter(Boolean).join('\n'));
    const compact = compactSearchValue(text);
    const groups = new Set<CrashCategoryFilter>();

    if (/unrecognized selector|does not recognize selector|doesnotrecognizeselector|selector sent to instance|-[^\\n]+ unrecognized selector/i.test(text)) {
      groups.add('unrecognized_selector');
    }
    if (/野指针|zombie|use after free|use-after-free|dangling pointer|invalid pointer|bad access|exc bad access|kern invalid address|objc msgsend/i.test(text)) {
      groups.add('wild_pointer');
    }
    if (/内存泄露|memory leak|leaked|malloc.*leak|leaks/i.test(text)) {
      groups.add('memory_leak');
    }
    if (/非ui线程|非 ui 线程|main thread checker|ui api called on a background thread|background thread.*ui|not on main thread|uikit.*background/i.test(text)) {
      groups.add('non_ui_thread');
    }
    if (/watchdog|8badf00d/i.test(text)) {
      groups.add('watchdog');
    }
    if (/app hang|app hanging|hang fully blocked|runloop hang|run loop hang|主线程卡死|卡死/i.test(text)) {
      groups.add('app_hanging');
    }
    if (/jetsam|内存不足|out of memory|oom|memory pressure|highwater|per-process-limit/i.test(text)) {
      groups.add('memory');
    }
    if (/exc_|sig(abrt|segv|bus|trap|ill)|signal|exception type/i.test(text) || compact.includes('exc_bad_access')) {
      groups.add('signal');
    }
    if (groups.size === 0) {
      groups.add('other');
    }
    return Array.from(groups);
  };

  const normalizedQuery = normalizeSearchValue(queryText);
  const versionOptions = useMemo(() => {
    const counts = new Map<string, number>();
    historyData.forEach((record) => {
      const version = String(record.appVersion || '').trim();
      if (!version) return;
      counts.set(version, (counts.get(version) || 0) + 1);
    });

    return Array.from(counts.entries())
      .sort(([left], [right]) => right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' }))
      .map(([version, count]) => ({
        value: version,
        label: `${/^v/i.test(version) ? version : `v${version}`} (${count})`,
      }));
  }, [historyData]);

  const records = historyData.filter((record) => {
    if (fixedFilter === 'fixed' && !record.isFixed) return false;
    if (fixedFilter === 'unfixed' && record.isFixed) return false;
    if (versionFilter !== 'all' && record.appVersion !== versionFilter) return false;
    if (moduleFilters.length > 0) {
      const recordGroups = getRecordModuleGroups(record);
      if (!moduleFilters.some((filter) => recordGroups.includes(filter))) {
        return false;
      }
    }
    if (crashCategoryFilter !== 'all') {
      const recordCategories = getRecordCrashCategories(record);
      if (!recordCategories.includes(crashCategoryFilter)) {
        return false;
      }
    }
    if (!normalizedQuery) return true;

    const idQuery = normalizedQuery.replace(/^#/, '');
    if (/^\d+$/.test(idQuery) && String(record.id).includes(idQuery)) {
      return true;
    }

    const visibleSearchable = normalizeSearchValue([
      record.id,
      record.appVersion,
      record.crashType,
      record.crashReason,
      record.lastStackCall,
      record.crashModule,
      record.crashLocation,
      record.fixedVersion,
      record.fixedRemark,
      record.createdAt,
      formatDateTime(record.createdAt),
      record.aiAnalysis?.summary,
      record.aiAnalysis?.crashModule,
      record.aiAnalysis?.crashLocation,
      ...(record.usedUuids || []),
    ].filter(Boolean).join('\n'));

    if (includesSearchQuery(visibleSearchable, normalizedQuery)) {
      return true;
    }

    const crashThreadSearchable = normalizeSearchValue([
      extractCrashedThreadSearchText(record.symbolicatedLog),
      extractCrashedThreadSearchText(record.originalLog),
    ].filter(Boolean).join('\n'));

    return includesSearchQuery(crashThreadSearchable, normalizedQuery);
  });

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '100px 0' }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div>
      <Title level={2}>符号化历史记录</Title>
      <Paragraph type="secondary">
        查看所有符号化过的崩溃日志记录。{historyData.length > 0 ? `共 ${historyData.length} 条记录。` : '暂无历史记录。'}
      </Paragraph>

      <Card size="small" style={{ marginTop: 16 }}>
        <Space wrap>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索入库编号、版本、模块、类型、原因或堆栈关键词"
            value={queryText}
            onChange={(event) => setQueryText(event.target.value)}
            style={{ width: 420 }}
          />
          <Select
            value={fixedFilter}
            onChange={setFixedFilter}
            style={{ width: 120 }}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'unfixed', label: '未修复' },
              { value: 'fixed', label: '已修复' },
            ]}
          />
          <Select
            value={versionFilter}
            onChange={setVersionFilter}
            style={{ width: 160 }}
            showSearch
            optionFilterProp="label"
            options={[
              { value: 'all', label: '全部版本' },
              ...versionOptions,
            ]}
          />
          <Select
            mode="multiple"
            allowClear
            placeholder="全部模块"
            value={moduleFilters}
            onChange={handleModuleFilterChange}
            style={{ width: 180 }}
            maxTagCount="responsive"
            options={[
              { value: 'all', label: '全部' },
              { value: 'rtc', label: 'RTC' },
              { value: 'im', label: 'IM' },
              { value: 'other', label: '其他' },
            ]}
          />
          <Select
            allowClear
            placeholder="全部崩溃类型"
            value={crashCategoryFilter}
            onChange={(value) => setCrashCategoryFilter(value || 'all')}
            style={{ width: 220 }}
            options={[
              { value: 'all', label: '全部' },
              ...CRASH_CATEGORY_OPTIONS,
            ]}
          />
          <Text type="secondary">
            当前 {records.length} 条
          </Text>
        </Space>
      </Card>

      <Space direction="vertical" style={{ width: '100%', marginTop: 24 }} size="middle">
        {records.length === 0 ? (
          <Empty
            description={historyData.length === 0 ? '暂无历史记录' : '未找到匹配记录'}
            style={{ marginTop: 40 }}
          />
        ) : records.map((record) => (
                  <Card
                    key={record.id}
                    size="small"
                    title={
                      <Space>
                        <ClockCircleOutlined />
                        <Text>{formatDateTime(record.createdAt)}</Text>
                        <Tag color="green">已入库 #{record.id}</Tag>
                        {record.versionDetected ? (
                          <Tag color="green">v{record.appVersion}</Tag>
                        ) : (
                          <Tag color="default">v{record.appVersion} (未识别)</Tag>
                        )}
                        {record.crashType && <Tag color="red">{record.crashType}</Tag>}
                        {record.crashModule && <Tag color="blue">{record.crashModule}</Tag>}
                        {record.crashLocation && <Tag color="purple">{record.crashLocation}</Tag>}
                        {record.isFixed ? (
                          <Tag color="success" icon={<CheckCircleOutlined />}>
                            已修复 {record.fixedVersion && `(v${record.fixedVersion})`}
                          </Tag>
                        ) : (
                          <Tag color="default" icon={<CloseCircleOutlined />}>未修复</Tag>
                        )}
                      </Space>
                    }
                    extra={
                      <Space>
                        <Button
                          type="link"
                          icon={<CheckCircleOutlined />}
                          disabled={record.isFixed}
                          onClick={() => handleToggleFixed(record)}
                        >
                          {record.isFixed ? '已修复' : '未修复'}
                        </Button>
                        <Button
                          type="link"
                          icon={<ShareAltOutlined />}
                          onClick={() => handleShareToWechat(record)}
                        >
                          分享
                        </Button>
                        <Button
                          type="link"
                          icon={<EyeOutlined />}
                          onClick={() => handleViewDetail(record)}
                        >
                          查看详情
                        </Button>
                        {isAdmin && (
                          <Popconfirm
                            title="确认删除"
                            description="确定要删除这条历史记录吗？"
                            onConfirm={() => handleDelete(record.id)}
                            okText="确定"
                            cancelText="取消"
                          >
                            <Button type="link" danger icon={<DeleteOutlined />}>
                              删除
                            </Button>
                          </Popconfirm>
                        )}
                      </Space>
                    }
                  >
                    <Space direction="vertical" style={{ width: '100%' }} size="small">
                      {record.crashModule && (
                        <div>
                          <Text strong>崩溃模块：</Text>
                          <Tag color="geekblue" style={{ marginLeft: 8 }}>
                            {record.crashModule}
                          </Tag>
                        </div>
                      )}
                      {record.lastStackCall && (
                        <div>
                          <Text type="secondary">堆栈快照：</Text>
                          <Text code style={{ fontSize: '12px' }}>{record.lastStackCall}</Text>
                        </div>
                      )}
                      {record.crashReason && (
                        <div>
                          <Text type="secondary">崩溃原因：</Text>
                          <Text>{record.crashReason}</Text>
                        </div>
                      )}
                      {record.fixedRemark && (
                        <div>
                          <Text type="secondary">修复备注：</Text>
                          <Text>{record.fixedRemark}</Text>
                        </div>
                      )}
                    </Space>
                  </Card>
                ))}
      </Space>

      <Modal
        title={
          <Space wrap style={{ width: '100%', justifyContent: 'space-between', paddingRight: 32 }}>
            <Text strong>历史记录详情</Text>
            <Space wrap>
              {selectedRecord && !selectedRecord.isFixed && (
                <Button
                  icon={<CheckCircleOutlined />}
                  onClick={() => handleToggleFixed(selectedRecord)}
                >
                  未修复
                </Button>
              )}
              {selectedRecord && selectedRecord.isFixed && (
                <Button
                  icon={<CheckCircleOutlined />}
                  disabled
                >
                  已修复
                </Button>
              )}
              <Button
                icon={<ShareAltOutlined />}
                onClick={() => selectedRecord && handleShareToWechat(selectedRecord)}
              >
                分享
              </Button>
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                onClick={() => selectedRecord && historyApi.downloadReport(selectedRecord.id, selectedRecord.appVersion)}
              >
                下载
              </Button>
            </Space>
          </Space>
        }
        open={detailModalVisible}
        onCancel={handleCloseDetail}
        footer={null}
        width={1200}
      >
        {selectedRecord && (
          <div>
            <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }} size="middle">
              <div>
                <Text strong>编号：</Text>
                <Tag color="green" style={{ marginRight: 16 }}>已入库 #{selectedRecord.id}</Tag>
                <Text strong>版本：</Text>
                <Text>{selectedRecord.appVersion}</Text>
                <Text type="secondary" style={{ marginLeft: 16 }}>时间：</Text>
                <Text>{formatDateTime(selectedRecord.createdAt)}</Text>
                {selectedRecord.isFixed ? (
                  <Tag color="success" icon={<CheckCircleOutlined />} style={{ marginLeft: 16 }}>
                    已修复 {selectedRecord.fixedVersion && `(v${selectedRecord.fixedVersion})`}
                  </Tag>
                ) : (
                  <Tag color="default" icon={<CloseCircleOutlined />} style={{ marginLeft: 16 }}>
                    未修复
                  </Tag>
                )}
              </div>
              <Space size={[8, 8]} wrap>
                {selectedRecord.crashType && <Tag color="red">{selectedRecord.crashType}</Tag>}
                {selectedRecord.crashLocation && <Tag color="purple">{selectedRecord.crashLocation}</Tag>}
              </Space>
              {selectedRecord.crashModule && (
                <div>
                  <Text strong>崩溃模块：</Text>
                  <Tag color="geekblue" style={{ marginLeft: 8 }}>
                    {selectedRecord.crashModule}
                  </Tag>
                </div>
              )}
              {selectedRecord.fixedRemark && (
                <div>
                  <Text strong>修复备注：</Text>
                  <Text>{selectedRecord.fixedRemark}</Text>
                </div>
              )}
              {selectedRecord.lastStackCall && (
                <div>
                  <Text type="secondary">堆栈快照：</Text>
                  <Text code style={{ fontSize: '12px' }}>{selectedRecord.lastStackCall}</Text>
                </div>
              )}
              {selectedRecord.crashReason && (
                <div>
                  <Text type="secondary">崩溃原因：</Text>
                  <Text>{selectedRecord.crashReason}</Text>
                </div>
              )}
            </Space>

            <Tabs
              activeKey={activeTab}
              onChange={handleTabChange}
              items={[
                {
                  key: 'log',
                  label: '符号化日志',
                  children: (
                    <Card size="small">
                      <Space wrap style={{ width: '100%', marginBottom: 12 }}>
                        <Input
                          allowClear
                          prefix={<SearchOutlined />}
                          placeholder="在当前日志中检索"
                          value={detailSearchText}
                          onChange={(event) => setDetailSearchText(event.target.value)}
                          style={{ width: 320 }}
                        />
                        <Text type={detailSearchKeyword && detailMatchCount === 0 ? 'danger' : 'secondary'}>
                          {detailSearchKeyword
                            ? detailMatchCount > 0
                              ? `${activeDetailMatchIndex + 1} / ${detailMatchCount}`
                              : '未找到匹配项'
                            : '输入关键词后高亮匹配内容'}
                        </Text>
                        <Button
                          icon={<UpOutlined />}
                          disabled={!detailMatchCount}
                          onClick={() => jumpDetailMatch(-1)}
                        >
                          上一个
                        </Button>
                        <Button
                          icon={<DownOutlined />}
                          disabled={!detailMatchCount}
                          onClick={() => jumpDetailMatch(1)}
                        >
                          下一个
                        </Button>
                      </Space>
                      <pre style={{ 
                        maxHeight: 500, 
                        overflow: 'auto', 
                        fontSize: 12,
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all'
                      }}>
                        {renderHighlightedLog(selectedRecord.symbolicatedLog)}
                      </pre>
                    </Card>
                  ),
                },
                {
                  key: 'analysis',
                  label: 'AI 智能分析',
                  children: selectedRecord.aiAnalysis ? (
                    <AIAnalysisPanel analysis={selectedRecord.aiAnalysis} loading={false} />
                  ) : (
                    <Card size="small">
                      {analyzing ? (
                        <div style={{ textAlign: 'center', padding: '60px 0' }}>
                          <Spin size="large" />
                          <div style={{ marginTop: 16 }}>
                            <Text type="secondary">AI 正在分析中，请稍候...</Text>
                          </div>
                        </div>
                      ) : canAnalyzeCrash ? (
                        <Empty
                          description="暂无 AI 分析结果"
                          style={{ padding: '40px 0' }}
                        >
                          <Button
                            type="primary"
                            icon={<ThunderboltOutlined />}
                            onClick={handleAnalyze}
                          >
                            AI 智能分析
                          </Button>
                        </Empty>
                      ) : (
                        <Empty
                          description="暂无 AI 分析结果"
                          style={{ padding: '40px 0' }}
                        />
                      )}
                    </Card>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
