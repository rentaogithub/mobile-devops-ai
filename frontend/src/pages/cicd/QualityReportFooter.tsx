import { Button, Space } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';

interface QualityReportFooterProps {
  qualityLogUrl?: string;
  junitUrl?: string;
  onOpenUrl: (url?: string) => void;
  onClose: () => void;
}

export function QualityReportFooter({ qualityLogUrl, junitUrl, onOpenUrl, onClose }: QualityReportFooterProps) {
  return (
    <Space>
      {qualityLogUrl && (
        <Button
          icon={<DownloadOutlined />}
          onClick={() => onOpenUrl(qualityLogUrl)}
        >
          下载日志
        </Button>
      )}
      {junitUrl && (
        <Button onClick={() => onOpenUrl(junitUrl)}>
          下载 JUnit
        </Button>
      )}
      <Button onClick={onClose}>关闭</Button>
    </Space>
  );
}
