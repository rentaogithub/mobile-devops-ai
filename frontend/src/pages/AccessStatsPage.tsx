import { useEffect, useMemo, useState } from 'react';
import { Card, Col, Empty, Row, Spin, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { BarChartOutlined, TeamOutlined, UserOutlined } from '@ant-design/icons';
import { accessStatsApi, ServiceAccessPathStat, ServiceAccessSummary, ServiceAccessVisitor } from '../services/api';
import { authUtils } from '../utils/auth';

const { Title, Text } = Typography;

const formatTime = (value: string) => {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
};

const isLoopbackIp = (value: string) => {
  const normalized = value.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
};

const roleLabels: Record<string, string> = {
  guest: '游客',
  tester: '测试',
  developer: '研发',
  product: '产品运营',
  admin: '管理员',
  user: '用户',
};

const roleColors: Record<string, string> = {
  guest: 'default',
  tester: 'blue',
  developer: 'purple',
  product: 'magenta',
  admin: 'gold',
  user: 'default',
};

const visitorIdentity = (visitor: ServiceAccessVisitor) => {
  if (visitor.identity) return visitor.identity;
  const role = visitor.platformRole || visitor.role || 'user';
  const name = visitor.displayName || visitor.username || '';
  return name ? `${roleLabels[role] || role}・${name}` : (roleLabels[role] || role || '用户');
};

export default function AccessStatsPage() {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<ServiceAccessSummary | null>(null);
  const isAdmin = authUtils.isAdmin();

  useEffect(() => {
    if (!isAdmin) return;
    setLoading(true);
    accessStatsApi.summary()
      .then(setSummary)
      .catch((error) => {
        message.error(error?.error || error?.message || '获取访问统计失败');
      })
      .finally(() => setLoading(false));
  }, [isAdmin]);

  const displayIpFallback = useMemo(() => {
    const knownIp = summary?.recentVisitors.find((visitor) => visitor.ip && !isLoopbackIp(visitor.ip))?.ip;
    if (knownIp) return knownIp;
    return isLoopbackIp(window.location.hostname) ? '' : window.location.hostname;
  }, [summary?.recentVisitors]);

  const visitorColumns = useMemo<ColumnsType<ServiceAccessVisitor>>(() => [
    {
      title: '身份',
      dataIndex: 'role',
      width: 180,
      ellipsis: true,
      render: (_role, record) => {
        const role = record.platformRole || record.role || 'user';
        return <Tag color={roleColors[role] || 'default'}>{visitorIdentity(record)}</Tag>;
      },
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      width: 150,
      ellipsis: true,
      render: (ip: string) => isLoopbackIp(ip || '') && displayIpFallback ? displayIpFallback : ip,
    },
    {
      title: '访问次数',
      dataIndex: 'visitCount',
      width: 100,
      sorter: (a, b) => a.visitCount - b.visitCount,
    },
    {
      title: '首次访问',
      dataIndex: 'firstSeen',
      width: 180,
      render: formatTime,
    },
    {
      title: '最后访问',
      dataIndex: 'lastSeen',
      width: 180,
      render: formatTime,
    },
  ], [displayIpFallback]);

  const pathColumns = useMemo<ColumnsType<ServiceAccessPathStat>>(() => [
    {
      title: '页面',
      dataIndex: 'path',
      ellipsis: true,
    },
    {
      title: '访问用户',
      dataIndex: 'visitors',
      width: 120,
    },
    {
      title: '访问次数',
      dataIndex: 'visits',
      width: 120,
    },
  ], []);

  if (!isAdmin) {
    return <Empty description="仅管理员可查看服务访问统计" />;
  }

  return (
    <Spin spinning={loading}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <Title level={3} style={{ marginBottom: 4 }}>服务访问统计</Title>
          <Text type="secondary">统计访问平台服务的用户、访问次数和最近访问页面</Text>
        </div>
      </div>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Text type="secondary">访问用户</Text>
            <div style={{ marginTop: 8, fontSize: 28, fontWeight: 600 }}>
              <TeamOutlined style={{ color: '#1677ff', marginRight: 8 }} />
              {summary?.totals.totalVisitors || 0}
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Text type="secondary">总访问次数</Text>
            <div style={{ marginTop: 8, fontSize: 28, fontWeight: 600 }}>
              <BarChartOutlined style={{ color: '#52c41a', marginRight: 8 }} />
              {summary?.totals.totalVisits || 0}
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Text type="secondary">今日访问用户</Text>
            <div style={{ marginTop: 8, fontSize: 28, fontWeight: 600 }}>
              <UserOutlined style={{ color: '#faad14', marginRight: 8 }} />
              {summary?.totals.todayVisitors || 0}
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Text type="secondary">管理员用户</Text>
            <div style={{ marginTop: 8, fontSize: 28, fontWeight: 600 }}>
              {summary?.totals.adminVisitors || 0}
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={9}>
          <Card title="热门页面" style={{ height: '100%' }}>
            <Table<ServiceAccessPathStat>
              rowKey="path"
              size="small"
              columns={pathColumns}
              dataSource={summary?.topPaths || []}
              pagination={false}
            />
          </Card>
        </Col>
        <Col xs={24} lg={15}>
          <Card title="最近访问用户">
            <Table<ServiceAccessVisitor>
              rowKey="visitorId"
              columns={visitorColumns}
              dataSource={summary?.recentVisitors || []}
              scroll={{ x: 640 }}
              pagination={{ pageSize: 10 }}
            />
          </Card>
        </Col>
      </Row>
    </Spin>
  );
}
