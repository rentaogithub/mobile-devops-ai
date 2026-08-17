import { Button, Card, Space, Tag, Typography } from 'antd';
import { JenkinsQualityArtifactPreview } from '../../services/api';

const { Text } = Typography;

interface QualityArtifactPreviewCardProps {
  preview: (JenkinsQualityArtifactPreview & { title: string }) | null;
  onOpenUrl: (url?: string) => void;
  onClose: () => void;
}

export function QualityArtifactPreviewCard({ preview, onOpenUrl, onClose }: QualityArtifactPreviewCardProps) {
  if (!preview) return null;

  return (
    <Card
      size="small"
      title={(
        <Space>
          <Text>{preview.title}</Text>
          {preview.format && <Tag>{preview.format}</Tag>}
          {preview.truncated && <Tag color="orange">已截断</Tag>}
        </Space>
      )}
      extra={(
        <Space>
          <Button size="small" type="link" onClick={() => onOpenUrl(preview.url)}>
            打开原文件
          </Button>
          <Button size="small" type="text" onClick={onClose}>
            收起
          </Button>
        </Space>
      )}
      style={{ marginTop: 16 }}
    >
      <pre
        style={{
          margin: 0,
          maxHeight: 420,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontSize: 12,
          lineHeight: 1.5,
          background: '#fafafa',
          padding: 12,
          border: '1px solid #f0f0f0',
          borderRadius: 4,
        }}
      >
        {preview.content || '文件内容为空'}
      </pre>
    </Card>
  );
}
