import { Space, Typography } from 'antd';
import { ReactNode } from 'react';

const { Text } = Typography;

interface QualityLogSectionProps {
  children: ReactNode;
}

export function QualityLogSection({ children }: QualityLogSectionProps) {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%', marginTop: 16 }}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Text strong>质检日志</Text>
        {children}
      </Space>
    </Space>
  );
}
