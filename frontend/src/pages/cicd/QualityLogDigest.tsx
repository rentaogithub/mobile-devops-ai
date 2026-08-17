import { Alert, Empty, Space } from 'antd';
import { JenkinsQualityArtifactPreview } from '../../services/api';

function tailLines(content: string, maxLines = 80) {
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

interface QualityLogDigestProps {
  preview: JenkinsQualityArtifactPreview | null;
  loading: boolean;
}

export function QualityLogDigest({ preview, loading }: QualityLogDigestProps) {
  const content = tailLines(preview?.content || '');
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {loading ? (
        <Alert showIcon type="info" message="正在加载质检日志..." />
      ) : preview?.content ? (
        <pre
          style={{
            margin: 0,
            maxHeight: 260,
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
          {content || '日志内容为空'}
        </pre>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次任务没有可展示的质检日志" />
      )}
    </Space>
  );
}
