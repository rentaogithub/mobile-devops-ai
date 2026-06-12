import { useState } from 'react';
import { Typography, Card, Input, Button, Space, Upload, Alert, Descriptions, Switch, Tabs, message } from 'antd';
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
import { watermarkApi, WatermarkDecodeResult } from '../services/api';
import LogsPairPage from './LogsPairPage';

const { Title, Paragraph } = Typography;
const FEEDBACK_LOG_URL = 'https://op.nn.com/#/speed/logs';

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

  const openFeedbackLogs = () => {
    window.open(FEEDBACK_LOG_URL, '_blank', 'noopener,noreferrer');
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
                  识别水印用户
                </Space>
              ),
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
                      <Descriptions.Item label="UID">{watermarkResult.bestCandidate.uid}</Descriptions.Item>
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
                  <iframe
                    title="OP 反馈日志"
                    src={FEEDBACK_LOG_URL}
                    style={{
                      width: '100%',
                      height: 680,
                      border: '1px solid #f0f0f0',
                      borderRadius: 6,
                      background: '#fff',
                    }}
                  />
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
    </div>
  );
}
