import { useState } from 'react';
import { Typography, Card, Row, Col, Input, Button, Space, DatePicker, Select, Table, Tag, Empty, Upload, Alert, Descriptions, Switch, message } from 'antd';
import {
  FileSearchOutlined,
  SearchOutlined,
  ReloadOutlined,
  DownloadOutlined,
  QrcodeOutlined,
  UserOutlined,
  UploadOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { watermarkApi, WatermarkDecodeResult } from '../services/api';

const { Title, Paragraph } = Typography;
const { RangePicker } = DatePicker;

const logColumns = [
  { title: '时间', dataIndex: 'timestamp', key: 'timestamp', width: 180 },
  {
    title: '级别',
    dataIndex: 'level',
    key: 'level',
    width: 100,
    render: (level: string) => {
      const colorMap: Record<string, string> = {
        ERROR: 'red', WARN: 'orange', INFO: 'blue', DEBUG: 'default',
      };
      return <Tag color={colorMap[level] || 'default'}>{level}</Tag>;
    },
  },
  { title: '模块', dataIndex: 'module', key: 'module', width: 150 },
  { title: '内容', dataIndex: 'message', key: 'message', ellipsis: true },
];

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
  const navigate = useNavigate();
  const [watermarkDeep, setWatermarkDeep] = useState(true);
  const [watermarkLoading, setWatermarkLoading] = useState(false);
  const [watermarkResult, setWatermarkResult] = useState<WatermarkDecodeResult | null>(null);

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
            收集和分析应用运行日志，支持日志检索、统计分析和异常告警
          </Paragraph>
        </div>
        <Button
          type="primary"
          icon={<QrcodeOutlined />}
          onClick={() => navigate('/logs/pair')}
        >
          扫码连接设备
        </Button>
      </div>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {[
          { label: '今日日志', value: 0, color: '#1677ff' },
          { label: 'ERROR', value: 0, color: '#ff4d4f' },
          { label: 'WARN', value: 0, color: '#faad14' },
          { label: 'INFO', value: 0, color: '#52c41a' },
        ].map((stat) => (
          <Col xs={12} sm={6} key={stat.label}>
            <Card size="small" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 'bold', color: stat.color }}>{stat.value}</div>
              <div style={{ color: '#999', fontSize: 13 }}>{stat.label}</div>
            </Card>
          </Col>
        ))}
      </Row>

      <Card
        title={(
          <Space>
            <UserOutlined style={{ color: '#1677ff' }} />
            查询用户
          </Space>
        )}
        extra={(
          <Space>
            <span style={{ color: '#666' }}>深度识别</span>
            <Switch size="small" checked={watermarkDeep} onChange={setWatermarkDeep} />
          </Space>
        )}
        style={{ marginBottom: 24 }}
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} md={10}>
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
          </Col>
          <Col xs={24} md={14}>
            {watermarkResult?.bestCandidate ? (
              <Descriptions size="small" bordered column={2}>
                <Descriptions.Item label="UID">{watermarkResult.bestCandidate.uid}</Descriptions.Item>
                <Descriptions.Item label="环境">{watermarkResult.bestCandidate.env}</Descriptions.Item>
                <Descriptions.Item label="锚点">{watermarkResult.bestCandidate.anchor}</Descriptions.Item>
                <Descriptions.Item label="置信度">{watermarkResult.bestCandidate.score.toFixed(2)}</Descriptions.Item>
                <Descriptions.Item label="修复">{watermarkResult.bestCandidate.repaired ? '是' : '否'}</Descriptions.Item>
                <Descriptions.Item label="候选数">{watermarkResult.candidates.length}</Descriptions.Item>
                <Descriptions.Item label="增强方式">{watermarkResult.bestCandidate.enhancement}</Descriptions.Item>
                <Descriptions.Item label="图片时间">{formatWatermarkImageTime(watermarkResult.imageTime?.time)}</Descriptions.Item>
                <Descriptions.Item label="时间来源">
                  {formatWatermarkTimeSource(
                    watermarkResult.imageTime?.source,
                    watermarkResult.imageTime?.field,
                    watermarkResult.imageTime?.reliable
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="payload">{watermarkResult.bestCandidate.payloadHex}</Descriptions.Item>
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
          </Col>
        </Row>
      </Card>

      <Card>
        <Space wrap style={{ marginBottom: 16, width: '100%' }}>
          <Input placeholder="搜索日志内容..." prefix={<SearchOutlined />} style={{ width: 300 }} />
          <Select placeholder="日志级别" style={{ width: 120 }} allowClear
            options={[
              { value: 'ERROR', label: 'ERROR' },
              { value: 'WARN', label: 'WARN' },
              { value: 'INFO', label: 'INFO' },
              { value: 'DEBUG', label: 'DEBUG' },
            ]}
          />
          <RangePicker showTime />
          <Button icon={<ReloadOutlined />}>刷新</Button>
          <Button icon={<DownloadOutlined />}>导出</Button>
        </Space>
        <Empty description="暂无日志数据，请先配置日志采集源">
          <Button type="primary">配置日志源</Button>
        </Empty>
        <Table columns={logColumns} dataSource={[]} style={{ display: 'none' }} />
      </Card>
    </div>
  );
}
