import { Alert, Button, Card, Descriptions, Input, Space, Tag, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { AppleDeviceConfigStatus } from '../../services/api';

const { Text } = Typography;

interface AppleDeveloperApiConfigCardProps {
  status: AppleDeviceConfigStatus | null;
  statusLoading?: boolean;
  saving?: boolean;
  keyId: string;
  issuerId: string;
  keyPath: string;
  keyFile: File | null;
  onKeyIdChange: (value: string) => void;
  onIssuerIdChange: (value: string) => void;
  onKeyPathChange: (value: string) => void;
  onKeyFileChange: (file: File | null) => void;
  onCheck: () => void;
  onSave: () => void;
}

export function AppleDeveloperApiConfigCard({
  status,
  statusLoading,
  saving,
  keyId,
  issuerId,
  keyPath,
  keyFile,
  onKeyIdChange,
  onIssuerIdChange,
  onKeyPathChange,
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
            : `缺少：${status?.missing?.join('、') || 'APP_STORE_CONNECT_API_KEY_ID、APP_STORE_CONNECT_API_ISSUER_ID、APP_STORE_CONNECT_API_KEY_PATH'}`}
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
          <Text strong>Key ID</Text>
          <Input
            value={keyId}
            onChange={(event) => onKeyIdChange(event.target.value.trim())}
            placeholder="例如 L69RVXCYFU"
            style={{ marginTop: 8 }}
          />
        </div>
        <div>
          <Text strong>Issuer ID</Text>
          <Input
            value={issuerId}
            onChange={(event) => onIssuerIdChange(event.target.value.trim())}
            placeholder="App Store Connect API Issuer ID"
            style={{ marginTop: 8 }}
          />
        </div>
        <div>
          <Text strong>Key 文件路径</Text>
          <Input
            value={keyPath}
            onChange={(event) => onKeyPathChange(event.target.value)}
            placeholder="/Users/a1/工作/nn-ios-platform-data/secrets/AuthKey_xxx.p8"
            style={{ marginTop: 8 }}
          />
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
          message="上传后会保存到平台数据目录"
          description="选择新的 .p8 文件并保存配置后，后端会将文件保存到 nn-ios-platform-data/secrets，并更新 backend/.env。"
        />
      </Space>
    </Card>
  );
}
