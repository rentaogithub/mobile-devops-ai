import { useState } from 'react';
import { Upload, message, Card, Typography, Alert, Space, Button } from 'antd';
import { InboxOutlined, CheckCircleOutlined, LoadingOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { dsymApi } from '../services/api';
import { DSYMInfo } from '../types';

const { Title, Paragraph, Text } = Typography;

export default function UploadPage() {
  const [uploading, setUploading] = useState(false);
  const [uploadedInfo, setUploadedInfo] = useState<DSYMInfo | null>(null);

  const uploadProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: '.dSYM,.xcarchive,.zip,.tgz,.tar.gz',
    beforeUpload: (file) => {
      const isValidType =
        file.name.endsWith('.dSYM') ||
        file.name.endsWith('.xcarchive') ||
        file.name.endsWith('.zip') ||
        file.name.endsWith('.tgz') ||
        file.name.endsWith('.tar.gz');

      if (!isValidType) {
        message.error('只支持 .xcarchive、.zip、.tgz 或 .tar.gz 文件');
        return false;
      }

      const isLt500M = file.size / 1024 / 1024 < 500;
      if (!isLt500M) {
        message.error('文件大小不能超过 500MB');
        return false;
      }

      return true;
    },
    customRequest: async ({ file, onSuccess, onError }) => {
      try {
        setUploading(true);
        setUploadedInfo(null);

        const response = await dsymApi.upload(file as File);

        if (response.success && response.data) {
          message.success('上传成功！');
          setUploadedInfo(response.data);
          onSuccess?.(response.data);
        } else {
          throw new Error(response.error || '上传失败');
        }
      } catch (error: any) {
        const errorMsg = error.error || error.message || '上传失败';
        message.error(errorMsg);
        onError?.(error);
      } finally {
        setUploading(false);
      }
    },
  };

  return (
    <div>
      <Title level={2}>上传 dSYM 文件</Title>
      <Paragraph type="secondary">
        上传 iOS 应用的 dSYM 文件，用于后续的崩溃日志符号化。支持 .dSYM 目录、.xcarchive 或 .zip
        压缩包格式。
      </Paragraph>

      <Card style={{ marginTop: 24 }}>
        <Upload {...uploadProps} disabled={uploading} showUploadList={false}>
          <Button 
            type="primary" 
            icon={uploading ? <LoadingOutlined /> : <InboxOutlined />}
            disabled={uploading}
            size="large"
            block
            style={{ height: 120 }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>
                {uploading ? '正在上传和处理文件...' : '点击选择文件上传'}
              </span>
              <span style={{ fontSize: 12, opacity: 0.8 }}>
                支持 .xcarchive、.zip、.tgz、.tar.gz 压缩包，文件大小不超过 500MB
              </span>
            </div>
          </Button>
        </Upload>
      </Card>

      {uploadedInfo && (
        <Card
          style={{ marginTop: 24 }}
          title={
            <Space>
              <CheckCircleOutlined style={{ color: '#52c41a' }} />
              <span>上传成功</span>
            </Space>
          }
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <Text strong>应用名称：</Text>
              <Text>{uploadedInfo.appName}</Text>
            </div>
            <div>
              <Text strong>版本号：</Text>
              <Text>{uploadedInfo.version}</Text>
            </div>
            <div>
              <Text strong>UUID：</Text>
              <Text code>{uploadedInfo.uuid}</Text>
            </div>
            <div>
              <Text strong>上传时间：</Text>
              <Text>{new Date(uploadedInfo.uploadTime).toLocaleString('zh-CN')}</Text>
            </div>
          </Space>
        </Card>
      )}

      <Alert
        style={{ marginTop: 24 }}
        message="使用说明"
        description={
          <ul style={{ marginBottom: 0, paddingLeft: 20 }}>
            <li>dSYM 文件包含应用的调试符号信息，用于将崩溃日志中的内存地址转换为可读的函数名和行号</li>
            <li>
              <strong>重要：</strong>
              .dSYM 是目录，浏览器无法直接上传目录，请先压缩成 .zip 文件再上传
            </li>
            <li>可以从 Xcode Archive 中导出 dSYM 文件，或从 App Store Connect 下载</li>
            <li>支持上传 .xcarchive 文件（会自动提取其中的 dSYM）</li>
            <li>每个应用版本都有唯一的 UUID，系统会自动匹配对应的 dSYM 文件</li>
            <li>上传成功后，可以在"管理"页面查看和管理已上传的 dSYM 文件</li>
            <li>
              <strong>远程协助：</strong>
              如需帮助，可通过 VNC 远程桌面访问：<Text code>vnc://10.1.103.96</Text>
            </li>
          </ul>
        }
        type="info"
        showIcon
      />
    </div>
  );
}
