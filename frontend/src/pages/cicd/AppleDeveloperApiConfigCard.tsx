import { Alert, Button, Card, Descriptions, Input, Space, Tag, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { AppleDeviceConfigStatus } from '../../services/api';

const { Text } = Typography;

interface AppleDeveloperApiConfigCardProps {
  status: AppleDeviceConfigStatus | null;
  statusLoading?: boolean;
  saving?: boolean;
  issuerId: string;
  keyFile: File | null;
  onIssuerIdChange: (value: string) => void;
  onKeyFileChange: (file: File | null) => void;
  onCheck: () => void;
  onSave: () => void;
}

export function AppleDeveloperApiConfigCard({
  status,
  statusLoading,
  saving,
  issuerId,
  keyFile,
  onIssuerIdChange,
  onKeyFileChange,
  onCheck,
  onSave,
}: AppleDeveloperApiConfigCardProps) {
  return (
    <Card
      title="Apple Developer API 配置"
      extra={(
        <Space>
          <Button onClick={onCheck} loading={statusLoading}>
            检查配置
          </Button>
          <Button type="primary" onClick={onSave} loading={saving}>
            保存配置
          </Button>
        </Space>
      )}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          type={status?.configured && !(status?.warnings?.length) ? 'success' : 'warning'}
          showIcon
          message={status?.configured ? '配置可用' : '配置不完整'}
          description={status?.configured
            ? '当前 App Store Connect API Key 可用于设备注册、TestFlight 和版本管理相关接口。'
            : '请填写 Issuer ID，并上传从 App Store Connect 下载且未改名的 AuthKey_<KeyID>.p8 私钥。Key ID 会从文件名自动识别。'}
        />
        <Descriptions bordered size="small" column={1}>
          <Descriptions.Item label="Key 文件">
            {status?.keyFileName ? <Text code>{status.keyFileName}</Text> : <Text type="secondary">未配置</Text>}
          </Descriptions.Item>
          <Descriptions.Item label="文件状态">
            {status?.keyFileExists ? <Tag color="green">存在</Tag> : <Tag color="red">未找到</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="Key 类型">
            {status?.keyLooksLikeAppStoreConnectKey ? <Tag color="green">AuthKey</Tag> : <Tag color="orange">需确认</Tag>}
          </Descriptions.Item>
        </Descriptions>
        {status?.warnings?.map((warning) => (
          <Alert key={warning} type="warning" showIcon message={warning} />
        ))}
        <div>
          <Text strong>Issuer ID</Text>
          <Input
            value={issuerId}
            onChange={(event) => onIssuerIdChange(event.target.value.trim())}
            placeholder="App Store Connect API Issuer ID"
            style={{ marginTop: 8 }}
          />
          <Text type="secondary">在 App Store Connect → 用户和访问 → 集成 → App Store Connect API 页面获取。</Text>
        </div>
        <Upload
          accept=".p8"
          maxCount={1}
          beforeUpload={(file) => {
            onKeyFileChange(file);
            return false;
          }}
          onRemove={() => {
            onKeyFileChange(null);
          }}
          fileList={keyFile ? [{ uid: '-1', name: keyFile.name, status: 'done' as const }] : []}
        >
          <Button icon={<UploadOutlined />}>选择新的 AuthKey_*.p8</Button>
        </Upload>
        <Alert
          type="info"
          showIcon
          message="私钥按产品线加密保存"
          description="私钥用于调用 Apple 官方 API，支持设备注册、TestFlight 测试组和 App Store 版本管理。文件必须保持 AuthKey_<KeyID>.p8 原名；平台提取 Key ID 后加密存储，不写入 backend/.env。"
        />
      </Space>
    </Card>
  );
}
