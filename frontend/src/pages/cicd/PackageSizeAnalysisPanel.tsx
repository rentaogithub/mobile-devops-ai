import { Alert, Button, Card, Col, Empty, Progress, Row, Space, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { JenkinsPackageSizeAnalysis } from '../../services/api';

const { Text } = Typography;

function packageSizeTypeLabel(type?: string) {
  const labels: Record<string, string> = {
    executable: '主程序',
    framework: 'Framework',
    dylib: '动态库',
    plugin: '插件',
    asset: '资源包',
    bundle: 'Bundle',
    resource: '资源',
    swiftSupport: 'Swift',
    symbol: '符号',
    other: '其他',
  };
  return labels[String(type || '')] || '其他';
}

function packageSizeTypeColor(type?: string) {
  const colors: Record<string, string> = {
    executable: 'volcano',
    framework: 'blue',
    dylib: 'geekblue',
    plugin: 'purple',
    asset: 'green',
    bundle: 'cyan',
    resource: 'default',
    swiftSupport: 'orange',
    symbol: 'gold',
    other: 'default',
  };
  return colors[String(type || '')] || 'default';
}

function packageSizeDeltaColor(value?: number | null) {
  if (!value) return 'default';
  return value > 0 ? 'red' : 'green';
}

function packageSizeDeltaText(deltaText?: string, deltaPercent?: number | null) {
  if (!deltaText) return '-';
  return deltaPercent === null || deltaPercent === undefined ? deltaText : `${deltaText} (${deltaPercent > 0 ? '+' : ''}${deltaPercent}%)`;
}

interface PackageSizeAnalysisPanelProps {
  analysis: JenkinsPackageSizeAnalysis | null;
  loading?: boolean;
  error?: string;
  onRefresh: () => void;
}

export function PackageSizeAnalysisPanel({ analysis, loading, error, onRefresh }: PackageSizeAnalysisPanelProps) {
  const largestEntry = analysis?.entries?.[0];
  const comparison = analysis?.comparison || null;
  const comparisonEntryMap = new Map((comparison?.entries || []).map((item) => [item.key, item]));

  if (loading) {
    return (
      <Card size="small">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Text type="secondary">正在分析包体积...</Text>
          <Progress percent={60} status="active" showInfo={false} />
        </Space>
      </Card>
    );
  }
  if (error) {
    return <Alert type="error" showIcon message={error} />;
  }
  if (!analysis) {
    return <Empty description="暂无包体积分析" />;
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {analysis.warnings?.map((item) => (
        <Alert key={item} type="warning" showIcon message={item} />
      ))}
      <Space wrap>
        {analysis.updatedAt && <Tag color="blue">存档 {new Date(analysis.updatedAt).toLocaleString('zh-CN')}</Tag>}
        {analysis.cached && <Tag>已存档</Tag>}
        {comparison?.baseline && (
          <Tag color="purple">
            对比前一 release #{comparison.baseline.buildNumber} / {comparison.baseline.appVersion || '-'}
          </Tag>
        )}
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={onRefresh}
        >
          重新分析
        </Button>
      </Space>
      <Row gutter={12}>
        <Col xs={24} md={8}>
          <Card size="small">
            <Text type="secondary">IPA 大小</Text>
            <div style={{ marginTop: 6, fontSize: 22, fontWeight: 600 }}>{analysis.totalText || '-'}</div>
            {comparison && (
              <Tag color={packageSizeDeltaColor(comparison.deltaBytes)}>
                {packageSizeDeltaText(comparison.deltaText, comparison.deltaPercent)}
              </Tag>
            )}
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card size="small">
            <Text type="secondary">解压后大小</Text>
            <div style={{ marginTop: 6, fontSize: 22, fontWeight: 600 }}>{analysis.uncompressedText || '-'}</div>
            {comparison && (
              <Tag color={packageSizeDeltaColor(comparison.deltaUncompressedBytes)}>
                {packageSizeDeltaText(comparison.deltaUncompressedText, comparison.deltaUncompressedPercent)}
              </Tag>
            )}
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card size="small">
            <Text type="secondary">最大占用</Text>
            <div style={{ marginTop: 6, fontSize: 18, fontWeight: 600 }}>
              {largestEntry ? `${largestEntry.name} ${largestEntry.text}` : '-'}
            </div>
          </Card>
        </Col>
      </Row>
      <Space wrap>
        {analysis.publishChannel && <Tag>{analysis.publishChannel}</Tag>}
        {analysis.appVersion && <Tag color="purple">APP {analysis.appVersion}</Tag>}
        {analysis.channelBuildNumber && <Tag color="green">渠道构建号 {analysis.channelBuildNumber}</Tag>}
      </Space>
      {analysis.entries.length ? (
        <Table
          size="small"
          rowKey={(record) => record.key}
          pagination={false}
          scroll={{ y: 410 }}
          dataSource={analysis.entries}
          columns={[
            {
              title: '类型',
              dataIndex: 'type',
              key: 'type',
              width: 110,
              render: (value: string) => <Tag color={packageSizeTypeColor(value)}>{packageSizeTypeLabel(value)}</Tag>,
            },
            {
              title: '模块',
              dataIndex: 'name',
              key: 'name',
              width: 240,
              render: (value: string, record) => (
                <Space direction="vertical" size={2}>
                  <Text strong>{value}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{record.path}</Text>
                </Space>
              ),
            },
            {
              title: '大小',
              dataIndex: 'text',
              key: 'text',
              width: 120,
            },
            {
              title: '较前版',
              key: 'delta',
              width: 150,
              render: (_, record) => {
                const diff = comparisonEntryMap.get(record.key);
                if (!diff) return '-';
                return (
                  <Tag color={packageSizeDeltaColor(diff.deltaBytes)}>
                    {packageSizeDeltaText(diff.deltaText, diff.deltaPercent)}
                  </Tag>
                );
              },
            },
            {
              title: '占比',
              dataIndex: 'percent',
              key: 'percent',
              width: 180,
              render: (value: number) => <Progress percent={value} size="small" style={{ width: 130 }} />,
            },
            {
              title: '文件数',
              dataIndex: 'fileCount',
              key: 'fileCount',
              width: 90,
            },
          ]}
        />
      ) : (
        <Empty description="未获取到 IPA 内部结构" />
      )}
    </Space>
  );
}
