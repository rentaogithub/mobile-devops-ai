import { useEffect, useState } from 'react';
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
  opUserApi,
  OpFeedbackLogInfo,
  OpUserInfo,
  userQueryRecordApi,
  UserQueryRecord,
  watermarkApi,
  WatermarkDecodeResult,
} from '../services/api';
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

export default function LogsPage() {
  const [watermarkDeep, setWatermarkDeep] = useState(true);
  const [watermarkLoading, setWatermarkLoading] = useState(false);
  const [watermarkResult, setWatermarkResult] = useState<WatermarkDecodeResult | null>(null);
  const [userSearchKey, setUserSearchKey] = useState('');
  const [userQueryLoading, setUserQueryLoading] = useState(false);
  const [userList, setUserList] = useState<OpUserInfo[]>([]);
  const [userQueryRecords, setUserQueryRecords] = useState<UserQueryRecord[]>([]);
  const [feedbackLogModalOpen, setFeedbackLogModalOpen] = useState(false);
  const [feedbackLogUid, setFeedbackLogUid] = useState<string | number>('');
  const [feedbackLogLoading, setFeedbackLogLoading] = useState(false);
  const [feedbackLogList, setFeedbackLogList] = useState<OpFeedbackLogInfo[]>([]);
  const [downloadingFeedbackLogId, setDownloadingFeedbackLogId] = useState('');
  const [feedbackFrameLoading, setFeedbackFrameLoading] = useState(true);

  const openFeedbackLogs = () => {
    window.open(EXTERNAL_FEEDBACK_LOG_URL, '_blank', 'noopener,noreferrer');
  };

  useEffect(() => {
    userQueryRecordApi.list()
      .then(setUserQueryRecords)
      .catch((error: any) => {
        message.error(error?.message || error?.error || '加载查询用户记录失败');
      });
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
      const result = await opUserApi.feedbackLogs(uid, 1, 10);
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

  const openFeedbackLogModal = (uid?: string | number) => {
    if (!uid) {
      message.warning('当前用户没有 UID');
      return;
    }
    setFeedbackLogUid(uid);
    setFeedbackLogModalOpen(true);
    queryFeedbackLogs(uid);
  };

  const downloadFeedbackLog = async (record: OpFeedbackLogInfo) => {
    if (!record.crashLogUrl) {
      message.warning('当前记录缺少日志下载地址');
      return;
    }

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
            <Input
              allowClear
              placeholder="添加备注"
              value={stored?.remark || ''}
              onChange={(event) => changeUserRemarkLocal(record, event.target.value)}
              onBlur={(event) => updateUserRemark(record, event.target.value)}
              style={{ maxWidth: 260 }}
            />
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
      title: '邮箱',
      dataIndex: 'email',
      key: 'email',
      width: 180,
      render: (value: string) => value || '-',
    },
    {
      title: '备注',
      dataIndex: 'remark',
      key: 'remark',
      width: 170,
      render: (_: string, record: UserQueryRecord) => (
        <Input
          allowClear
          placeholder="添加备注"
          value={record.remark || ''}
          onChange={(event) => changeUserRemarkLocal(record, event.target.value)}
          onBlur={(event) => updateUserRemark(record, event.target.value)}
          style={{ width: 150 }}
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_: unknown, record: UserQueryRecord) => (
        <Button type="link" danger size="small" style={{ padding: 0 }} onClick={() => removeUserQueryRecord(record)}>
          删除
        </Button>
      ),
    },
  ];

  const feedbackLogColumns = [
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
      width: 120,
      render: (_: unknown, record: OpFeedbackLogInfo) => (
        <Button
          type="link"
          size="small"
          style={{ padding: 0 }}
          disabled={!record.crashLogUrl}
          loading={downloadingFeedbackLogId === (record.id || record.crashLogUrl)}
          onClick={() => downloadFeedbackLog(record)}
        >
          下载日志
        </Button>
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
                            <Button size="small" disabled={userQueryRecords.length === 0} onClick={clearUserQueryRecords}>
                              清空记录
                            </Button>
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
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <Space>
                    <Button icon={<ExportOutlined />} onClick={openFeedbackLogs}>
                      新窗口打开 OP 日志平台
                    </Button>
                  </Space>
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
        <Table<OpFeedbackLogInfo>
          bordered
          size="small"
          rowKey={(record, index) => String(record.id || `${record.userId || feedbackLogUid}-${record.crashTime || index}`)}
          columns={feedbackLogColumns}
          dataSource={feedbackLogList}
          loading={feedbackLogLoading}
          pagination={false}
        />
      </Modal>
    </div>
  );
}
