import { Card, Col, Row } from 'antd';
import { ReactNode } from 'react';

interface StatsCardsProps {
  stats: Array<{
    label: string;
    value: ReactNode;
    color: string;
  }>;
}

export function StatsCards({ stats }: StatsCardsProps) {
  return (
    <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
      {stats.map((stat) => (
        <Col xs={12} sm={6} key={stat.label}>
          <Card size="small" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 'bold', color: stat.color }}>{stat.value}</div>
            <div style={{ color: '#999', fontSize: 13 }}>{stat.label}</div>
          </Card>
        </Col>
      ))}
    </Row>
  );
}
