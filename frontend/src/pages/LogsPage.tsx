import { useEffect, useMemo, useState } from 'react';
import { Typography, Card, Input, Button, Space, Upload, Alert, Descriptions, Switch, Tabs, Spin, Table, Modal, message } from 'antd';
import {
  ApiOutlined,
  CommentOutlined,
  ExportOutlined,
  FileSearchOutlined,
  SearchOutlined,
  QrcodeOutlined,
  UserOutlined,
  UploadOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import {
  feedbackLogApi,
  FeedbackLogLine,
  FeedbackLogPreviewResult,
  opUserApi,
  OpFeedbackLogInfo,
  OpUserInfo,
  RtcLogRetrieveTaskInfo,
  userQueryRecordApi,
  UserQueryRecord,
  watermarkApi,
  WatermarkDecodeResult,
} from '../services/api';
import { authUtils } from '../utils/auth';
import { analyzeBusinessLogLines, BusinessLogAnalysisModal, type BusinessLogAnalysis } from '../components/BusinessLogAnalysisModal';
import LogsPairPage from './LogsPairPage';

const { Title, Paragraph } = Typography;
const FEEDBACK_LOG_URL = '/op/#/speed/logs';
const EXTERNAL_FEEDBACK_LOG_URL = 'https://op.nn.com/#/speed/logs';

const getUserRecordKey = (record: Partial<UserQueryRecord>) =>
  String(record.recordKey || record.userId || record.id || record.telNum || record.email || '');

const getFeedbackLogTime = (record: OpFeedbackLogInfo) => {
  const timestamp = new Date(record.createTime || record.crashTime || '').getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const formatWatermarkImageTime = (time?: string) => {
  if (!time) {
    return '未提取到';
  }
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) {
    return time;
  }
  return date.toLocaleString();
};

const formatWatermarkTimeSource = (source?: string, field?: string, reliable?: boolean) => {
  const sourceNameMap: Record<string, string> = {
    exif: 'EXIF 元信息',
    pngText: 'PNG 文本元信息',
    none: '图片未包含时间元信息',
  };
  const sourceName = sourceNameMap[source || 'none'] || source || '无';
  const fieldText = field ? ` / ${field}` : '';
  const reliableText = reliable ? '可信' : '兜底';
  return `${sourceName}${fieldText}（${reliableText}）`;
};

const parseDateOnlyTime = (value?: string) => {
  if (!value) {
    return 0;
  }
  const normalized = value.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
  if (!normalized) {
    return 0;
  }
  const timestamp = new Date(`${normalized}T00:00:00`).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const isActiveRtcRetrieveTask = (task: RtcLogRetrieveTaskInfo) => {
  const statusText = String(task.status_dictText || task.status || '');
  if (statusText && !['1', '正常'].includes(statusText)) {
    return false;
  }

  const today = new Date();
  const todayTime = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const rangeText = [
    task.taskTime,
    task.beginTime,
    (task as Record<string, unknown>).taskDate,
    (task as Record<string, unknown>).timeRange,
  ].map((value) => String(value || '')).find((value) => value.includes('~')) || '';
  const rangeDates = rangeText.match(/\d{4}-\d{2}-\d{2}/g) || [];
  const beginTime = parseDateOnlyTime(rangeDates[0] || task.beginTime);
  const endTime = parseDateOnlyTime(rangeDates[1] || task.endTime);
  if (beginTime && endTime) {
    return beginTime <= todayTime && todayTime <= endTime;
  }
  return true;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const highlightText = (value: string, keyword: string) => {
  const text = value || '';
  const trimmedKeyword = keyword.trim();
  if (!trimmedKeyword) {
    return text;
  }

  const parts = text.split(new RegExp(`(${escapeRegExp(trimmedKeyword)})`, 'ig'));
  return parts.map((part, index) => (
    part.toLowerCase() === trimmedKeyword.toLowerCase() ? (
      <mark key={`${part}-${index}`} style={{ padding: 0, background: '#ffe58f' }}>
        {part}
      </mark>
    ) : part
  ));
};

export default function LogsPage() {
  const isAdmin = authUtils.isAdmin();
  const [watermarkDeep, setWatermarkDeep] = useState(true);
  const [watermarkLoading, setWatermarkLoading] = useState(false);
  const [watermarkResult, setWatermarkResult] = useState<WatermarkDecodeResult | null>(null);
  const [userSearchKey, setUserSearchKey] = useState('');
  const [userQueryLoading, setUserQueryLoading] = useState(false);
  const [userList, setUserList] = useState<OpUserInfo[]>([]);
  const [userQueryRecords, setUserQueryRecords] = useState<UserQueryRecord[]>([]);
  const [feedbackLogModalOpen, setFeedbackLogModalOpen] = useState(false);
  const [feedbackLogUid, setFeedbackLogUid] = useState<string | number>('');
  const [feedbackLogSearchUid, setFeedbackLogSearchUid] = useState('');
  const [feedbackLogSearchSubmitted, setFeedbackLogSearchSubmitted] = useState(false);
  const [feedbackLogLoading, setFeedbackLogLoading] = useState(false);
  const [feedbackLogList, setFeedbackLogList] = useState<OpFeedbackLogInfo[]>([]);
  const [downloadingFeedbackLogId, setDownloadingFeedbackLogId] = useState('');
  const [previewingFeedbackLogId, setPreviewingFeedbackLogId] = useState('');
  const [analyzingFeedbackLogId, setAnalyzingFeedbackLogId] = useState('');
  const [creatingRtcRetrieveUid, setCreatingRtcRetrieveUid] = useState('');
  const [checkingRtcRetrieveUid, setCheckingRtcRetrieveUid] = useState('');
  const [activeRtcRetrieveTaskUid, setActiveRtcRetrieveTaskUid] = useState('');
  const [feedbackLogPreviewOpen, setFeedbackLogPreviewOpen] = useState(false);
  const [feedbackLogPreview, setFeedbackLogPreview] = useState<FeedbackLogPreviewResult | null>(null);
  const [feedbackLogActiveFilePath, setFeedbackLogActiveFilePath] = useState('');
  const [feedbackLogFileRows, setFeedbackLogFileRows] = useState<Record<string, FeedbackLogLine[]>>({});
  const [loadingFeedbackLogFilePath, setLoadingFeedbackLogFilePath] = useState('');
  const [feedbackLogSearchInput, setFeedbackLogSearchInput] = useState('');
  const [feedbackLogSearchText, setFeedbackLogSearchText] = useState('');
  const [feedbackAnalysisOpen, setFeedbackAnalysisOpen] = useState(false);
  const [feedbackAnalysisResult, setFeedbackAnalysisResult] = useState<BusinessLogAnalysis | null>(null);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const [feedbackFrameLoading, setFeedbackFrameLoading] = useState(true);

  const openFeedbackLogs = () => {
    window.open(EXTERNAL_FEEDBACK_LOG_URL, '_blank', 'noopener,noreferrer');
  };

  const feedbackLogRows = useMemo(() => {
    const keyword = feedbackLogSearchText.trim().toLowerCase();
    const rows = feedbackLogFileRows[feedbackLogActiveFilePath] || [];
    return keyword
      ? rows.filter((row) => `${row.time}\n${row.content}`.toLowerCase().includes(keyword))
      : rows;
  }, [feedbackLogActiveFilePath, feedbackLogFileRows, feedbackLogSearchText]);

  useEffect(() => {
    userQueryRecordApi.list()
      .then(setUserQueryRecords)
      .catch((error: any) => {
        message.error(error?.message || error?.error || '加载查询用户记录失败');
      });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFeedbackLogSearchText(feedbackLogSearchInput);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [feedbackLogSearchInput]);

  useEffect(() => {
    const updateViewportHeight = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', updateViewportHeight);
    return () => window.removeEventListener('resize', updateViewportHeight);
  }, []);

  const changeUserRemarkLocal = (record: Partial<UserQueryRecord>, remark: string) => {
    const key = getUserRecordKey(record);
    if (!key) {
      return;
    }

    setUserQueryRecords((current) =>
      current.map((item) => (getUserRecordKey(item) === key ? { ...item, remark } : item))
    );
  };

  const updateUserRemark = async (record: Partial<UserQueryRecord>, remark: string) => {
    const key = getUserRecordKey(record);
    if (!key) {
      return;
    }

    try {
      const next = await userQueryRecordApi.updateRemark(key, remark);
      setUserQueryRecords(next);
    } catch (error: any) {
      message.error(error?.message || error?.error || '保存备注失败');
      userQueryRecordApi.list().then(setUserQueryRecords).catch(() => undefined);
    }
  };

  const clearUserQueryRecords = async () => {
    try {
      const next = await userQueryRecordApi.clear();
      setUserQueryRecords(next);
    } catch (error: any) {
      message.error(error?.message || error?.error || '清空查询用户记录失败');
    }
  };

  const removeUserQueryRecord = async (record: UserQueryRecord) => {
    const key = getUserRecordKey(record);
    if (!key) {
      return;
    }

    try {
      const next = await userQueryRecordApi.remove(key);
      setUserQueryRecords(next);
    } catch (error: any) {
      message.error(error?.message || error?.error || '删除查询用户记录失败');
    }
  };

  const createRtcLogRetrieveTask = async (uid?: string | number) => {
    if (!uid) {
      message.warning('当前用户没有 UID');
      return;
    }

    const targetUid = String(uid);
    setCreatingRtcRetrieveUid(targetUid);
    try {
      await opUserApi.createRtcLogRetrieveTask(targetUid);
      setActiveRtcRetrieveTaskUid(targetUid);
      message.success('日志回捞任务已创建');
    } catch (error: any) {
      message.error(error?.message || error?.error || '创建日志回捞任务失败');
    } finally {
      setCreatingRtcRetrieveUid('');
    }
  };

  const checkRtcLogRetrieveTask = async (uid?: string | number) => {
    if (!uid) {
      setActiveRtcRetrieveTaskUid('');
      return;
    }

    const targetUid = String(uid);
    setCheckingRtcRetrieveUid(targetUid);
    try {
      const result = await opUserApi.rtcLogRetrieveTasks(targetUid, 1, 10);
      const hasActiveTask = result.total > 0 || result.records.length > 0 || result.records.some(isActiveRtcRetrieveTask);
      setActiveRtcRetrieveTaskUid(hasActiveTask ? targetUid : '');
    } catch (error: any) {
      setActiveRtcRetrieveTaskUid('');
      message.error(error?.message || error?.error || '查询日志回捞任务失败');
    } finally {
      setCheckingRtcRetrieveUid('');
    }
  };

  const handleWatermarkUpload = async (options: any) => {
    const file = options.file as File;
    setWatermarkLoading(true);

    try {
      const response = await watermarkApi.decode(file, watermarkDeep);
      const result = response.data;
      setWatermarkResult(result || null);

      if (result?.bestCandidate) {
        message.success(`识别成功，uid: ${result.bestCandidate.uid}`);
      } else {
        message.warning('未识别到水印信息');
      }
      options.onSuccess?.(response);
    } catch (error: any) {
      const errorMessage = error?.error || error?.message || '水印识别失败';
      message.error(errorMessage);
      setWatermarkResult(null);
      options.onError?.(error);
    } finally {
      setWatermarkLoading(false);
    }
  };

  const queryUserInfo = async (keyword = userSearchKey) => {
    const searchkey = keyword.trim();
    if (!searchkey) {
      message.warning('请输入用户UID/NN号/手机号/用户昵称/邮箱');
      return;
    }

    setUserQueryLoading(true);
    try {
      const result = await opUserApi.list(searchkey, 1, 10);
      setUserList(result.records);
      if (result.records.length > 0) {
        try {
          const next = await userQueryRecordApi.upsertBatch(result.records, searchkey);
          setUserQueryRecords(next);
        } catch (error: any) {
          message.error(error?.message || error?.error || '保存查询用户记录失败');
        }
      }
      if (result.records.length === 0) {
        message.info('未查询到用户信息');
      }
    } catch (error: any) {
      message.error(error?.message || error?.error || '查询用户信息失败');
      setUserList([]);
    } finally {
      setUserQueryLoading(false);
    }
  };

  const queryFeedbackLogs = async (uid: string | number) => {
    if (!uid) {
      return;
    }

    setFeedbackLogLoading(true);
    try {
      const result = await opUserApi.feedbackLogs(uid, 1, 30);
      const records = [...result.records]
        .sort((left, right) => getFeedbackLogTime(right) - getFeedbackLogTime(left))
        .slice(0, 10);
      setFeedbackLogList(records);
      if (result.records.length === 0) {
        message.info('未查询到反馈日志');
      }
    } catch (error: any) {
      message.error(error?.message || error?.error || '查询反馈日志失败');
      setFeedbackLogList([]);
    } finally {
      setFeedbackLogLoading(false);
    }
  };

  const searchFeedbackLogsByUid = (uid = feedbackLogSearchUid) => {
    const keyword = uid.trim();
    if (!keyword) {
      message.warning('请输入用户 UID');
      return;
    }

    setFeedbackLogUid(keyword);
    setFeedbackLogSearchSubmitted(true);
    queryFeedbackLogs(keyword);
    checkRtcLogRetrieveTask(keyword);
  };

  const openFeedbackLogModal = (uid?: string | number) => {
    if (!uid) {
      message.warning('当前用户没有 UID');
      return;
    }
    setFeedbackLogUid(uid);
    setActiveRtcRetrieveTaskUid('');
    setFeedbackLogModalOpen(true);
    queryFeedbackLogs(uid);
    checkRtcLogRetrieveTask(uid);
  };

  const downloadFeedbackLog = async (record: OpFeedbackLogInfo) => {
    if (!record.crashLogUrl) {
      message.warning('当前记录缺少日志下载地址');
      return;
    }

    setFeedbackLogModalOpen(false);
    setDownloadingFeedbackLogId(record.id || record.crashLogUrl);
    try {
      await opUserApi.downloadFeedbackLog(record);
      message.success('日志下载已开始');
    } catch (error: any) {
      message.error(error?.message || error?.error || '下载日志失败');
    } finally {
      setDownloadingFeedbackLogId('');
    }
  };

  const loadFeedbackLogFile = async (filePath: string, force = false) => {
    if (!filePath || (!force && feedbackLogFileRows[filePath] !== undefined)) {
      return;
    }

    setLoadingFeedbackLogFilePath(filePath);
    try {
      const result = await feedbackLogApi.readFile(filePath);
      setFeedbackLogFileRows((current) => ({
        ...current,
        [filePath]: result.rows,
        [result.path]: result.rows,
      }));
    } catch (error: any) {
      message.error(error?.message || error?.error || '读取日志文件失败');
    } finally {
      setLoadingFeedbackLogFilePath('');
    }
  };

  const previewFeedbackLog = async (record: OpFeedbackLogInfo) => {
    if (!record.crashLogUrl) {
      message.warning('当前记录缺少日志下载地址');
      return;
    }

    setFeedbackLogModalOpen(false);
    setPreviewingFeedbackLogId(record.id || record.crashLogUrl);
    setFeedbackLogPreviewOpen(true);
    setFeedbackLogPreview(null);
    setFeedbackLogActiveFilePath('');
    setFeedbackLogFileRows({});
    setFeedbackLogSearchInput('');
    setFeedbackLogSearchText('');
    try {
      const result = await feedbackLogApi.preview(record);
      const sortedResult = {
        ...result,
        files: [...result.files].sort((left, right) =>
          (right.createdAtMs || right.modifiedAtMs) - (left.createdAtMs || left.modifiedAtMs)
        ),
      };
      setFeedbackLogPreview(sortedResult);
      if (sortedResult.files[0]) {
        setFeedbackLogActiveFilePath(sortedResult.files[0].path);
        loadFeedbackLogFile(sortedResult.files[0].path, true);
      }
      if (sortedResult.files.length === 0) {
        message.info('压缩包中未找到业务日志文件');
      }
    } catch (error: any) {
      message.error(error?.message || error?.error || '查看日志失败');
    } finally {
      setPreviewingFeedbackLogId('');
    }
  };

  const makeFeedbackLogAnalysisLine = (row: FeedbackLogLine) => {
    const content = row.content || '';
    if (row.time && row.time !== '-' && !content.startsWith(`[${row.time}]`)) {
      return `[${row.time}]${content}`;
    }
    return content;
  };

  const analyzeFeedbackLog = async (record: OpFeedbackLogInfo) => {
    if (!record.crashLogUrl) {
      message.warning('当前记录缺少日志下载地址');
      return;
    }

    const recordKey = record.id || record.crashLogUrl;
    setFeedbackLogModalOpen(false);
    setAnalyzingFeedbackLogId(recordKey);
    message.loading({ content: '正在分析反馈日志...', key: 'feedback-log-analysis', duration: 0 });
    try {
      const result = await feedbackLogApi.preview(record);
      const files = [...result.files].sort((left, right) =>
        (right.createdAtMs || right.modifiedAtMs) - (left.createdAtMs || left.modifiedAtMs)
      );
      if (files.length === 0) {
        message.destroy('feedback-log-analysis');
        message.info('压缩包中未找到业务日志文件');
        return;
      }

      const fileContents = await Promise.all(files.map((file) => feedbackLogApi.readFile(file.path)));
      const lines = fileContents.flatMap((file) =>
        file.rows
          .map(makeFeedbackLogAnalysisLine)
          .filter((line) => line.trim())
      );
      if (lines.length === 0) {
        message.destroy('feedback-log-analysis');
        message.info('日志文件内容为空，无法分析');
        return;
      }

      setFeedbackAnalysisResult(analyzeBusinessLogLines(lines, `反馈日志 ${record.userId || ''}`.trim()));
      setFeedbackAnalysisOpen(true);
      message.success({ content: '反馈日志分析完成', key: 'feedback-log-analysis' });
    } catch (error: any) {
      message.destroy('feedback-log-analysis');
      message.error(error?.message || error?.error || '分析日志失败');
    } finally {
      setAnalyzingFeedbackLogId('');
    }
  };

  const renderUserInfoDetail = () => {
    const record = userList[0];
    if (!record) {
      return null;
    }

    const stored = userQueryRecords.find((item) => getUserRecordKey(item) === getUserRecordKey(record));
    return (
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        {userList.length > 1 ? (
          <Alert
            type="info"
            showIcon
            message={`共匹配到 ${userList.length} 个用户，当前展示第一条结果`}
          />
        ) : null}
        <Descriptions size="small" bordered column={3}>
          <Descriptions.Item label="UID">
            {record.userId ? (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openFeedbackLogModal(record.userId)}>
                {record.userId}
              </Button>
            ) : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="NN号">{record.nnNumber || '-'}</Descriptions.Item>
          <Descriptions.Item label="昵称">{record.nickName || '-'}</Descriptions.Item>
          <Descriptions.Item label="手机号">{record.telNum || '-'}</Descriptions.Item>
          <Descriptions.Item label="邮箱">{record.email || '-'}</Descriptions.Item>
          <Descriptions.Item label="用户类型">{record.userType_dictText || '-'}</Descriptions.Item>
          <Descriptions.Item label="状态">{record.status_dictText || '-'}</Descriptions.Item>
          <Descriptions.Item label="注册渠道">{record.registerCanal || '-'}</Descriptions.Item>
          <Descriptions.Item label="创建时间">{record.createTime || '-'}</Descriptions.Item>
          <Descriptions.Item label="备注" span={3}>
            {isAdmin ? (
              <Input
                allowClear
                placeholder="添加备注"
                value={stored?.remark || ''}
                onChange={(event) => changeUserRemarkLocal(record, event.target.value)}
                onBlur={(event) => updateUserRemark(record, event.target.value)}
                style={{ maxWidth: 260 }}
              />
            ) : (stored?.remark || '-')}
          </Descriptions.Item>
        </Descriptions>
      </Space>
    );
  };

  const userQueryRecordColumns = [
    {
      title: 'UID',
      dataIndex: 'userId',
      key: 'userId',
      width: 120,
      render: (value: string | number) => value ? (
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openFeedbackLogModal(value)}>
          {value}
        </Button>
      ) : '-',
    },
    {
      title: 'NN号',
      dataIndex: 'nnNumber',
      key: 'nnNumber',
      width: 140,
      render: (value: string) => value || '-',
    },
    {
      title: '昵称',
      dataIndex: 'nickName',
      key: 'nickName',
      width: 150,
      render: (value: string) => value || '-',
    },
    {
      title: '手机号',
      dataIndex: 'telNum',
      key: 'telNum',
      width: 140,
      render: (value: string) => value || '-',
    },
    {
      title: '备注',
      dataIndex: 'remark',
      key: 'remark',
      width: 170,
      render: (_: string, record: UserQueryRecord) => (
        isAdmin ? (
          <Input
            allowClear
            placeholder="添加备注"
            value={record.remark || ''}
            onChange={(event) => changeUserRemarkLocal(record, event.target.value)}
            onBlur={(event) => updateUserRemark(record, event.target.value)}
            style={{ width: 150 }}
          />
        ) : (record.remark || '-')
      ),
    },
    ...(isAdmin ? [{
      title: '操作',
      key: 'action',
      width: 90,
      render: (_: unknown, record: UserQueryRecord) => (
        <Button type="link" danger size="small" style={{ padding: 0 }} onClick={() => removeUserQueryRecord(record)}>
          删除
        </Button>
      ),
    }] : []),
  ];

  const feedbackLogColumns = [
    {
      title: '日志类型',
      key: 'type',
      width: 150,
      render: (_: unknown, record: OpFeedbackLogInfo) => record.type_dictText || record.logType_dictText || record.type || '-',
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      width: 140,
      render: (value: string) => value || '-',
    },
    {
      title: '上传时间',
      dataIndex: 'createTime',
      key: 'createTime',
      width: 180,
      render: (value: string, record: OpFeedbackLogInfo) => value || record.crashTime || '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 210,
      render: (_: unknown, record: OpFeedbackLogInfo) => (
        <Space size="middle">
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            disabled={!record.crashLogUrl}
            loading={previewingFeedbackLogId === (record.id || record.crashLogUrl)}
            onClick={() => previewFeedbackLog(record)}
          >
            查看
          </Button>
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            disabled={!record.crashLogUrl}
            loading={analyzingFeedbackLogId === (record.id || record.crashLogUrl)}
            onClick={() => analyzeFeedbackLog(record)}
          >
            分析
          </Button>
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            disabled={!record.crashLogUrl}
            loading={downloadingFeedbackLogId === (record.id || record.crashLogUrl)}
            onClick={() => downloadFeedbackLog(record)}
          >
            下载
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <Title level={4}>
            <FileSearchOutlined style={{ marginRight: 8, color: '#faad14' }} />
            日志服务
          </Title>
          <Paragraph type="secondary">
            提供设备实时日志、截图水印识别、反馈日志查询和后端日志查询。
          </Paragraph>
        </div>
      </div>

      <Card>
        <Tabs
          defaultActiveKey="pair"
          items={[
            {
              key: 'pair',
              label: (
                <Space>
                  <QrcodeOutlined />
                  实时日志（蒲公英）
                </Space>
              ),
              children: (
                <LogsPairPage embedded pairingMode="modal" />
              ),
            },
            {
              key: 'watermark',
              label: (
                <Space>
                  <UserOutlined />
                  查询用户
                </Space>
              ),
              children: (
                <Tabs
                  defaultActiveKey="userInfo"
                  items={[
                    {
                      key: 'userInfo',
                      label: '查询用户信息',
                      children: (
                        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                          <Input.Search
                            allowClear
                            enterButton="查询"
                            prefix={<SearchOutlined />}
                            placeholder="用户UID/NN号/手机号/用户昵称/邮箱"
                            value={userSearchKey}
                            loading={userQueryLoading}
                            onChange={(event) => setUserSearchKey(event.target.value)}
                            onSearch={(value) => queryUserInfo(value)}
                            style={{ maxWidth: 520 }}
                          />
                          {userQueryLoading ? <Spin /> : renderUserInfoDetail()}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Typography.Title level={5} style={{ margin: 0 }}>
                              查询用户记录
                            </Typography.Title>
                            {isAdmin ? (
                              <Button size="small" disabled={userQueryRecords.length === 0} onClick={clearUserQueryRecords}>
                                清空记录
                              </Button>
                            ) : null}
                          </div>
                          <Table<UserQueryRecord>
                            bordered
                            size="small"
                            rowKey={(record, index) => String(getUserRecordKey(record) || index)}
                            columns={userQueryRecordColumns}
                            dataSource={userQueryRecords}
                            scroll={{ x: 980 }}
                            pagination={{
                              pageSize: 10,
                              showTotal: (total) => `共 ${total} 条`,
                            }}
                          />
                        </Space>
                      ),
                    },
                    {
                      key: 'watermarkUid',
                      label: '识别水印用户UID',
                      children: (
                        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                            <Space>
                              <span style={{ color: '#666' }}>深度识别</span>
                              <Switch size="small" checked={watermarkDeep} onChange={setWatermarkDeep} />
                            </Space>
                          </div>
                          <Upload.Dragger
                            accept="image/png,image/jpeg"
                            maxCount={1}
                            showUploadList={false}
                            customRequest={handleWatermarkUpload}
                            disabled={watermarkLoading}
                          >
                            <p className="ant-upload-drag-icon">
                              {watermarkLoading ? <LoadingOutlined spin /> : <UploadOutlined />}
                            </p>
                            <p className="ant-upload-text">
                              {watermarkLoading ? '识别中...' : '上传截图识别水印用户'}
                            </p>
                            <p className="ant-upload-hint">
                              {watermarkLoading ? '正在解析顶部/底部点阵水印，请稍候' : '支持 JPG/PNG，默认使用深度识别，适合弱水印和多锚点场景'}
                            </p>
                          </Upload.Dragger>

                          {watermarkResult?.bestCandidate ? (
                            <Descriptions size="small" bordered column={1}>
                              <Descriptions.Item label="UID">
                                <Button
                                  type="link"
                                  size="small"
                                  style={{ padding: 0 }}
                                  onClick={() => openFeedbackLogModal(watermarkResult.bestCandidate?.uid)}
                                >
                                  {watermarkResult.bestCandidate.uid}
                                </Button>
                              </Descriptions.Item>
                              <Descriptions.Item label="环境">{watermarkResult.bestCandidate.env}</Descriptions.Item>
                              <Descriptions.Item label="置信度">{watermarkResult.bestCandidate.score.toFixed(2)}</Descriptions.Item>
                              <Descriptions.Item label="图片时间">{formatWatermarkImageTime(watermarkResult.imageTime?.time)}</Descriptions.Item>
                              <Descriptions.Item label="时间来源">
                                {formatWatermarkTimeSource(
                                  watermarkResult.imageTime?.source,
                                  watermarkResult.imageTime?.field,
                                  watermarkResult.imageTime?.reliable
                                )}
                              </Descriptions.Item>
                            </Descriptions>
                          ) : watermarkResult ? (
                            <Alert
                              type="warning"
                              showIcon
                              message="未识别到水印信息"
                              description="可以尝试开启深度识别、上传原图，或检查截图是否包含顶部/底部点阵水印。"
                            />
                          ) : (
                            <Alert
                              type="info"
                              showIcon
                              message="上传截图后会解析点阵水印"
                              description="用于从用户截图中快速反查 uid 和环境信息。"
                            />
                          )}
                        </Space>
                      ),
                    },
                  ]}
                />
              ),
            },
            {
              key: 'feedback',
              label: (
                <Space>
                  <CommentOutlined />
                  反馈日志查询
                </Space>
              ),
              children: (
                <Tabs
                  defaultActiveKey="uid"
                  items={[
                    {
                      key: 'uid',
                      label: 'UID 查询',
                      children: (
                        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                          <Input.Search
                            allowClear
                            enterButton="查询"
                            prefix={<SearchOutlined />}
                            placeholder="输入用户 UID 查询反馈日志"
                            value={feedbackLogSearchUid}
                            loading={feedbackLogLoading}
                            onChange={(event) => {
                              setFeedbackLogSearchUid(event.target.value);
                              if (!event.target.value.trim()) {
                                setFeedbackLogSearchSubmitted(false);
                              }
                            }}
                            onSearch={(value) => searchFeedbackLogsByUid(value)}
                            style={{ width: 360 }}
                          />
                          <Table<OpFeedbackLogInfo>
                            bordered
                            size="small"
                            rowKey={(record, index) => String(record.id || `${record.userId || feedbackLogUid}-${record.crashTime || index}`)}
                            columns={feedbackLogColumns}
                            dataSource={feedbackLogSearchSubmitted ? feedbackLogList : []}
                            loading={feedbackLogLoading}
                            pagination={false}
                          />
                        </Space>
                      ),
                    },
                    {
                      key: 'op',
                      label: 'OP 日志平台',
                      children: (
                        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                          <Button icon={<ExportOutlined />} onClick={openFeedbackLogs}>
                            新窗口打开 OP 日志平台
                          </Button>
                          <div style={{ position: 'relative', minHeight: 680 }}>
                            {feedbackFrameLoading && (
                              <div
                                style={{
                                  position: 'absolute',
                                  inset: 0,
                                  zIndex: 1,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  background: '#fff',
                                  border: '1px solid #f0f0f0',
                                  borderRadius: 6,
                                }}
                              >
                                <Space direction="vertical" align="center">
                                  <Spin />
                                  <span style={{ color: '#666' }}>正在加载 OP 日志平台...</span>
                                </Space>
                              </div>
                            )}
                            <iframe
                              title="OP 反馈日志"
                              src={FEEDBACK_LOG_URL}
                              onLoad={() => setFeedbackFrameLoading(false)}
                              style={{
                                width: '100%',
                                height: 680,
                                border: '1px solid #f0f0f0',
                                borderRadius: 6,
                                background: '#fff',
                              }}
                            />
                          </div>
                        </Space>
                      ),
                    },
                  ]}
                />
              ),
            },
            {
              key: 'backend',
              label: (
                <Space>
                  <ApiOutlined />
                  后端日志查询
                </Space>
              ),
              children: (
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                  <Input placeholder="服务名 / traceId / requestId / 关键字" prefix={<SearchOutlined />} />
                  <Input placeholder="环境，如 prod、gray、test" />
                  <Button type="primary" icon={<SearchOutlined />}>查询后端日志</Button>
                  <Alert
                    type="info"
                    showIcon
                    message="按服务或链路查询后端日志"
                    description="用于排查接口异常、服务错误和客户端请求对应的后端链路。"
                  />
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <Modal
        title={`反馈日志列表${feedbackLogUid ? ` - ${feedbackLogUid}` : ''}`}
        open={feedbackLogModalOpen}
        onCancel={() => setFeedbackLogModalOpen(false)}
        footer={null}
        width={980}
        destroyOnHidden
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Button
            type="primary"
            disabled={
              !feedbackLogUid ||
              activeRtcRetrieveTaskUid === String(feedbackLogUid || '') ||
              checkingRtcRetrieveUid === String(feedbackLogUid || '')
            }
            loading={
              creatingRtcRetrieveUid === String(feedbackLogUid || '') ||
              checkingRtcRetrieveUid === String(feedbackLogUid || '')
            }
            onClick={() => createRtcLogRetrieveTask(feedbackLogUid)}
          >
            {activeRtcRetrieveTaskUid === String(feedbackLogUid || '') ? '已有回捞任务' : '日志回捞'}
          </Button>
          <Table<OpFeedbackLogInfo>
            bordered
            size="small"
            rowKey={(record, index) => String(record.id || `${record.userId || feedbackLogUid}-${record.crashTime || index}`)}
            columns={feedbackLogColumns}
            dataSource={feedbackLogList}
            loading={feedbackLogLoading}
            pagination={false}
          />
        </Space>
      </Modal>
      <Modal
        title="查看反馈日志"
        open={feedbackLogPreviewOpen}
        onCancel={() => setFeedbackLogPreviewOpen(false)}
        footer={null}
        width="calc(100vw - 24px)"
        style={{ top: 12, paddingBottom: 0 }}
        styles={{
          content: { height: 'calc(100vh - 24px)', display: 'flex', flexDirection: 'column' },
          body: { flex: 1, overflow: 'hidden', paddingTop: 8 },
        }}
        destroyOnHidden
      >
        {previewingFeedbackLogId ? (
          <Spin />
        ) : feedbackLogPreview ? (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
            <Input.Search
              allowClear
              prefix={<SearchOutlined />}
              placeholder="全文检索日志内容/时间"
              value={feedbackLogSearchInput}
              onChange={(event) => setFeedbackLogSearchInput(event.target.value)}
              onSearch={(value) => setFeedbackLogSearchText(value)}
              style={{ maxWidth: 520 }}
            />
            {feedbackLogPreview.files.length > 0 ? (
              <Tabs
                activeKey={feedbackLogActiveFilePath}
                className="feedback-log-preview-tabs"
                style={{ flex: 1, minHeight: 0 }}
                onChange={(filePath) => {
                  setFeedbackLogActiveFilePath(filePath);
                  loadFeedbackLogFile(filePath);
                }}
                items={feedbackLogPreview.files.map((file) => ({
                  key: file.path,
                  label: file.name,
                  children: (() => {
                    const rows = feedbackLogActiveFilePath === file.path ? feedbackLogRows : [];
                    const loading = loadingFeedbackLogFilePath === file.path;
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
                        <Typography.Text type="secondary">
                          共 {rows.length} 行{feedbackLogSearchText.trim() ? '匹配' : ''}
                        </Typography.Text>
                        <Table<FeedbackLogLine>
                          bordered
                          size="small"
                          virtual
                          rowKey="id"
                          dataSource={rows}
                          loading={loading}
                          pagination={false}
                          scroll={{ x: 1200, y: Math.max(520, viewportHeight - 205) }}
                          columns={[
                            {
                              title: '时间',
                              dataIndex: 'time',
                              key: 'time',
                              width: 190,
                              render: (value: string) => highlightText(value || '-', feedbackLogSearchText),
                            },
                            {
                              title: '日志内容',
                              dataIndex: 'content',
                              key: 'content',
                              render: (value: string) => (
                                <pre
                                  style={{
                                    margin: 0,
                                    maxHeight: 110,
                                    overflow: 'auto',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    fontFamily: 'Menlo, Monaco, Consolas, monospace',
                                    fontSize: 12,
                                    lineHeight: 1.55,
                                  }}
                                >
                                  {highlightText(value, feedbackLogSearchText)}
                                </pre>
                              ),
                            },
                          ]}
                        />
                      </div>
                    );
                  })(),
                }))}
              />
            ) : (
              <Alert type="warning" showIcon message="压缩包中未找到业务日志文件" />
            )}
          </div>
        ) : null}
      </Modal>
      <BusinessLogAnalysisModal
        open={feedbackAnalysisOpen}
        analysisResult={feedbackAnalysisResult}
        onCancel={() => setFeedbackAnalysisOpen(false)}
      />
    </div>
  );
}
