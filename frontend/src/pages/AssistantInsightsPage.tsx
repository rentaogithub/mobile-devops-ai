import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Empty, Progress, Row, Space, Spin, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { BarChartOutlined, BulbOutlined, DatabaseOutlined, ReloadOutlined, RobotOutlined, SearchOutlined, ToolOutlined } from '@ant-design/icons';
import {
  AssistantCapabilityDatasetStatus,
  assistantInsightsApi,
  AssistantSemanticResolution,
  AssistantSemanticSearchMiss,
  AssistantSemanticStats,
} from '../services/api';
import { authUtils } from '../utils/auth';

const { Title, Text } = Typography;

const formatTime = (value: string) => {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
};

const modeMeta: Record<string, { label: string; color: string }> = {
  deterministic: { label: '语义命中', color: 'green' },
  model_fallback: { label: '模型兜底', color: 'blue' },
};

export default function AssistantInsightsPage() {
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [stats, setStats] = useState<AssistantSemanticStats | null>(null);
  const [datasetStatus, setDatasetStatus] = useState<AssistantCapabilityDatasetStatus | null>(null);
  const isAdmin = authUtils.isAdmin();

  const load = () => {
    if (!isAdmin) return;
    setLoading(true);
    Promise.all([
      assistantInsightsApi.semanticStats(80),
      assistantInsightsApi.capabilityDatasetStatus(),
    ])
      .then(([semanticStats, capabilityStatus]) => {
        setStats(semanticStats);
        setDatasetStatus(capabilityStatus);
      })
      .catch((error) => {
        message.error(error?.error || error?.message || '获取 AI 提效统计失败');
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [isAdmin]);

  const hitRate = useMemo(() => {
    const total = stats?.totals.resolutions || 0;
    return total ? Math.round(((stats?.totals.deterministic || 0) / total) * 100) : 0;
  }, [stats]);

  const resolutionColumns = useMemo<ColumnsType<AssistantSemanticResolution>>(() => [
    {
      title: '识别方式',
      dataIndex: 'mode',
      width: 110,
      render: (mode: string) => <Tag color={modeMeta[mode]?.color || 'default'}>{modeMeta[mode]?.label || mode}</Tag>,
    },
    {
      title: '命中服务',
      dataIndex: 'toolName',
      width: 210,
      ellipsis: true,
      render: (value?: string) => value ? <Tag>{value}</Tag> : <Text type="secondary">模型选择</Text>,
    },
    {
      title: '用户输入',
      dataIndex: 'rawInput',
      ellipsis: true,
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 180,
      render: formatTime,
    },
  ], []);

  const missColumns = useMemo<ColumnsType<AssistantSemanticSearchMiss>>(() => [
    {
      title: '服务',
      dataIndex: 'toolName',
      width: 180,
      ellipsis: true,
      render: (value: string) => <Tag>{value}</Tag>,
    },
    {
      title: '原始查询',
      dataIndex: 'rawQuery',
      ellipsis: true,
    },
    {
      title: '清洗后',
      dataIndex: 'cleanedQuery',
      width: 180,
      ellipsis: true,
      render: (value: string) => value || '-',
    },
    {
      title: '扩展词',
      dataIndex: 'tokens',
      width: 260,
      render: (tokens: string[]) => (
        <Space size={[4, 4]} wrap>
          {(tokens || []).slice(0, 5).map((token) => <Tag key={token}>{token}</Tag>)}
        </Space>
      ),
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 180,
      render: formatTime,
    },
  ], []);

  const syncCapabilities = async () => {
    setSyncing(true);
    try {
      const result = await assistantInsightsApi.syncCapabilityEntrances();
      message.success(`已同步 ${result.totalSynced} 条路由/跨端能力`);
      load();
    } catch (error: any) {
      message.error(error?.error || error?.message || '同步能力入口失败');
    } finally {
      setSyncing(false);
    }
  };

  if (!isAdmin) {
    return <Empty description="仅管理员可查看 AI 提效看板" />;
  }

  return (
    <Spin spinning={loading}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <Title level={3} style={{ marginBottom: 4 }}>AI 提效看板</Title>
          <Text type="secondary">观察语义命中、模型兜底和零结果查询，持续反哺业务词库与服务路由。</Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          <Button type="primary" icon={<DatabaseOutlined />} loading={syncing} onClick={syncCapabilities}>
            同步能力入口
          </Button>
        </Space>
      </div>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Text type="secondary">语义命中率</Text>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
              <Progress type="circle" percent={hitRate} size={64} />
              <div>
                <div style={{ fontSize: 24, fontWeight: 650 }}>{stats?.totals.deterministic || 0}</div>
                <Text type="secondary">规则精准命中</Text>
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Text type="secondary">AI 会话识别</Text>
            <div style={{ marginTop: 8, fontSize: 28, fontWeight: 650 }}>
              <RobotOutlined style={{ color: '#1677ff', marginRight: 8 }} />
              {stats?.totals.resolutions || 0}
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Text type="secondary">模型兜底</Text>
            <div style={{ marginTop: 8, fontSize: 28, fontWeight: 650 }}>
              <BulbOutlined style={{ color: '#722ed1', marginRight: 8 }} />
              {stats?.totals.modelFallback || 0}
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Text type="secondary">能力目录</Text>
            <div style={{ marginTop: 8, fontSize: 28, fontWeight: 650 }}>
              <DatabaseOutlined style={{ color: '#13c2c2', marginRight: 8 }} />
              {datasetStatus?.total || 0}
            </div>
            <Text type="secondary">{datasetStatus?.files || 0} 个数据集文件</Text>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24}>
          <Card title={<><DatabaseOutlined /> 能力数据集健康度</>}>
            <Row gutter={[16, 16]}>
              <Col xs={24} lg={12}>
                <Text type="secondary">按服务域分布</Text>
                <div style={{ marginTop: 12 }}>
                  <Space size={[6, 8]} wrap>
                    {Object.entries(datasetStatus?.byDomain || {}).map(([domain, count]) => (
                      <Tag key={domain} color="blue">{domain} {count}</Tag>
                    ))}
                  </Space>
                </div>
              </Col>
              <Col xs={24} lg={12}>
                <Text type="secondary">按来源分布</Text>
                <div style={{ marginTop: 12 }}>
                  <Space size={[6, 8]} wrap>
                    {Object.entries(datasetStatus?.sources || {}).map(([source, count]) => (
                      <Tag key={source}>{source} {count}</Tag>
                    ))}
                  </Space>
                </div>
              </Col>
            </Row>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title={<><ToolOutlined /> Top 服务能力</>} style={{ height: '100%' }}>
            <Table
              rowKey="toolName"
              size="small"
              pagination={false}
              dataSource={stats?.topTools || []}
              columns={[
                { title: '服务', dataIndex: 'toolName', ellipsis: true },
                { title: '次数', dataIndex: 'count', width: 80, sorter: (a, b) => a.count - b.count },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={16}>
          <Card title={<><BarChartOutlined /> 最近语义识别</>}>
            <Table<AssistantSemanticResolution>
              rowKey={(record, index) => `${record.createdAt}-${record.mode}-${index}`}
              columns={resolutionColumns}
              dataSource={stats?.recentResolutions || []}
              scroll={{ x: 760 }}
              pagination={{ pageSize: 10 }}
            />
          </Card>
        </Col>
        <Col xs={24}>
          <Card title={<><SearchOutlined /> 待反哺词库的零结果查询</>}>
            <Table<AssistantSemanticSearchMiss>
              rowKey={(record, index) => `${record.createdAt}-${record.toolName}-${index}`}
              columns={missColumns}
              dataSource={stats?.recentSearchMisses || []}
              scroll={{ x: 980 }}
              pagination={{ pageSize: 10 }}
            />
          </Card>
        </Col>
      </Row>
    </Spin>
  );
}
