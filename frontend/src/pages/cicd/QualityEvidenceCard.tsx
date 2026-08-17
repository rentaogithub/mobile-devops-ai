import { Card, Empty, Image, Space } from 'antd';

interface QualityEvidenceCardProps {
  screenshotUrl?: string;
}

export function QualityEvidenceCard({ screenshotUrl }: QualityEvidenceCardProps) {
  return (
    <Card size="small" title="现场证据" style={{ marginTop: 16 }}>
      {screenshotUrl ? (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Image
            src={screenshotUrl}
            alt="质检截图"
            style={{ maxHeight: 520, objectFit: 'contain' }}
          />
        </Space>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次任务未归档截图" />
      )}
    </Card>
  );
}
