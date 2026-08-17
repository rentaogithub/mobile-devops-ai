import { Button, Modal, QRCode, Space, Tag } from 'antd';

interface InstallQrPreview {
  url: string;
  channel?: string;
  branchName?: string;
  buildNumber?: string;
}

interface InstallQrModalProps {
  preview: InstallQrPreview | null;
  normalizeUrl: (url?: string) => string;
  onOpenUrl: (url?: string) => void;
  onClose: () => void;
}

export function InstallQrModal({ preview, normalizeUrl, onOpenUrl, onClose }: InstallQrModalProps) {
  return (
    <Modal
      title="扫码安装"
      open={!!preview}
      footer={preview ? (
        <Space>
          <Button type="primary" onClick={() => onOpenUrl(preview.url)}>
            打开地址
          </Button>
        </Space>
      ) : null}
      onCancel={onClose}
    >
      <Space direction="vertical" align="center" size={16} style={{ width: '100%', padding: '12px 0 16px' }}>
        <Space>
          {preview?.channel && <Tag color="blue">{preview.channel}</Tag>}
          {preview?.branchName && <Tag color="default">分支 {preview.branchName}</Tag>}
          {preview?.buildNumber && <Tag color="green">渠道构建号 {preview.buildNumber}</Tag>}
        </Space>
        {preview?.url && <QRCode value={normalizeUrl(preview.url)} size={260} />}
      </Space>
    </Modal>
  );
}
