import { Card } from 'antd';
import { ReactNode } from 'react';

interface QualityReportSectionCardProps {
  title: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}

export function QualityReportSectionCard({ title, extra, children }: QualityReportSectionCardProps) {
  return (
    <Card size="small" title={title} extra={extra} style={{ marginTop: 16 }}>
      {children}
    </Card>
  );
}
