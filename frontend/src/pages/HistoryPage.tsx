import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Typography, Card, Space, Tag, Button, message, Popconfirm, Empty, Spin, Modal, Tabs, Input, Select } from 'antd';
import { ClockCircleOutlined, DeleteOutlined, EyeOutlined, ThunderboltOutlined, DownloadOutlined, ShareAltOutlined, CheckCircleOutlined, CloseCircleOutlined, SearchOutlined, ReloadOutlined } from '@ant-design/icons';
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
  createdAt: string;
}

export default function HistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [historyData, setHistoryData] = useState<HistoryRecord[]>([]);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<HistoryRecord | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [activeTab, setActiveTab] = useState('log'); // 当前激活的标签
  const [queryText, setQueryText] = useState('');
  const [fixedFilter, setFixedFilter] = useState<'all' | 'fixed' | 'unfixed'>('all');
  const isAdmin = authUtils.isAdmin();

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
      const record = historyData.find(r => r.id === id);
      if (record) {
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
      const token = authUtils.getToken();
      const response = await fetch(`/api/history/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
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
    setSelectedRecord(record);
    setDetailModalVisible(true);
    setActiveTab('log'); // 重置为日志标签

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
    // 清除 URL 参数
    if (searchParams.get('id')) {
      setSearchParams({});
    }
  };

  const handleToggleFixed = async (record: HistoryRecord) => {
    try {
      const newStatus = !record.isFixed;
      
      if (newStatus) {
        // 标记为已修复，需要输入修复版本
        Modal.confirm({
          title: '标记为已修复',
          content: (
            <div>
              <p>请输入修复版本号：</p>
              <Input
                id="fixed-version-input"
                placeholder="例如：1.0.1"
                defaultValue=""
              />
            </div>
          ),
          onOk: async () => {
            const input = document.getElementById('fixed-version-input') as HTMLInputElement;
            const fixedVersion = input?.value?.trim();
            
            if (!fixedVersion) {
              message.error('请输入修复版本号');
              return Promise.reject();
            }
            
            await historyApi.updateFixedStatus(record.id, true, fixedVersion);
            message.success('已标记为已修复');
            loadHistory();
          },
        });
      } else {
        // 标记为未修复，直接更新
        await historyApi.updateFixedStatus(record.id, false);
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
    const savedApiKey = getSavedApiKey();
    startAnalysis(savedApiKey || '');
  };

  const handleTabChange = (activeKey: string) => {
    setActiveTab(activeKey); // 更新当前激活的标签
  };

  const startAnalysis = async (key: string) => {
    if (!selectedRecord) {
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

  const normalizedQuery = queryText.trim().toLowerCase();
  const records = historyData.filter((record) => {
    if (fixedFilter === 'fixed' && !record.isFixed) return false;
    if (fixedFilter === 'unfixed' && record.isFixed) return false;
    if (!normalizedQuery) return true;

    const idQuery = normalizedQuery.replace(/^#/, '');
    if (/^\d+$/.test(idQuery) && String(record.id).includes(idQuery)) {
      return true;
    }

    const searchable = [
      record.id,
      record.appVersion,
      record.crashType,
      record.crashReason,
      record.lastStackCall,
      record.crashModule,
      record.crashLocation,
      record.fixedVersion,
      record.symbolicatedLog,
      record.aiAnalysis?.summary,
      record.aiAnalysis?.crashModule,
      record.aiAnalysis?.crashLocation,
      ...(record.usedUuids || []),
    ].filter(Boolean).join('\n').toLowerCase();

    return searchable.includes(normalizedQuery);
  });

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '100px 0' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div>
        <Title level={2}>符号化历史记录</Title>
        <Paragraph type="secondary">查看所有符号化过的崩溃日志记录。</Paragraph>
        <Empty
          description="暂无历史记录"
          style={{ marginTop: 60 }}
        />
      </div>
    );
  }

  return (
    <div>
      <Title level={2}>符号化历史记录</Title>
      <Paragraph type="secondary">
        查看所有符号化过的崩溃日志记录。共 {historyData.length} 条记录。
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
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              setQueryText('');
              setFixedFilter('all');
            }}
          >
            重置
          </Button>
          <Text type="secondary">
            当前 {records.length} 条
          </Text>
        </Space>
      </Card>

      <Space direction="vertical" style={{ width: '100%', marginTop: 24 }} size="middle">
        {records.length === 0 ? (
          <Empty description="未找到匹配记录" style={{ marginTop: 40 }} />
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
                        {/* 未修复状态：显示"标记已修复"按钮，所有人可见 */}
                        {!record.isFixed && (
                          <Button
                            type="link"
                            icon={<CheckCircleOutlined />}
                            onClick={() => handleToggleFixed(record)}
                          >
                            标记已修复
                          </Button>
                        )}
                        {/* 已修复状态：显示"标记未修复"按钮，仅管理员可见 */}
                        {record.isFixed && isAdmin && (
                          <Button
                            type="link"
                            icon={<CloseCircleOutlined />}
                            onClick={() => handleToggleFixed(record)}
                          >
                            标记未修复
                          </Button>
                        )}
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
                    </Space>
                  </Card>
                ))}
      </Space>

      <Modal
        title="历史记录详情"
        open={detailModalVisible}
        onCancel={handleCloseDetail}
        footer={[
          <Button 
            key="share"
            icon={<ShareAltOutlined />}
            onClick={() => selectedRecord && handleShareToWechat(selectedRecord)}
          >
            分享到企业微信
          </Button>,
          <Button 
            key="download" 
            type="primary"
            icon={<DownloadOutlined />}
            onClick={() => selectedRecord && historyApi.downloadReport(selectedRecord.id, selectedRecord.appVersion)}
          >
            下载
          </Button>,
          <Button key="close" onClick={handleCloseDetail}>
            关闭
          </Button>,
        ]}
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
                      <pre style={{ 
                        maxHeight: 500, 
                        overflow: 'auto', 
                        fontSize: 12,
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all'
                      }}>
                        {selectedRecord.symbolicatedLog}
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
                      ) : (
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
