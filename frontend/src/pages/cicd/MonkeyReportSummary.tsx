import { Alert, Collapse, Descriptions, Empty, Space, Tag, Typography } from 'antd';
import { JenkinsQualityArtifactPreview } from '../../services/api';

const { Text } = Typography;

function parseJsonPreview<T>(preview?: JenkinsQualityArtifactPreview | null): T | null {
  if (!preview?.content) return null;
  try {
    return JSON.parse(preview.content) as T;
  } catch {
    return null;
  }
}

function eventTypeLabel(type?: string) {
  const labels: Record<string, string> = {
    tap: '点击',
    swipe: '滑动',
    edgeBack: '边缘返回',
    tapBack: '点击返回',
    businessNav: '业务入口切换',
    businessExplore: '业务探索',
    businessGuardBack: '业务保护返回',
    businessGuardSwipe: '业务保护滑动',
  };
  return labels[type || ''] || type || '未知';
}

interface MonkeyReportSummaryProps {
  preview: (JenkinsQualityArtifactPreview & { title: string }) | null;
  loading: boolean;
  formatSeconds: (value?: number | null) => string;
}

export function MonkeyReportSummary({ preview, loading, formatSeconds }: MonkeyReportSummaryProps) {
  type MonkeyEvent = {
    index?: number;
    type?: string;
    reason?: string;
    businessDomain?: string;
    businessPath?: string;
    pageName?: string;
    riskLevel?: string;
    businessGuard?: string;
    x?: number;
    y?: number;
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    usedFallbackPoint?: boolean;
  };
  type MonkeyReport = {
    status?: string;
    message?: string;
    wdaUrl?: string;
    requestedEvents?: number;
    requestedDurationSeconds?: number;
    executedEvents?: number;
    durationMs?: number;
    rules?: {
      backIntervalEvents?: number;
      stuckEvents?: number;
      stuckCheckIntervalEvents?: number;
      backActionProbability?: number;
      backTapProbability?: number;
      avoidTopBar?: boolean;
      heartbeatIntervalSeconds?: number;
      forbiddenTexts?: string[];
      businessAware?: boolean;
      businessDomains?: string[];
      guardedActionPolicy?: string;
    };
    businessAware?: boolean;
    businessCoverage?: {
      enabled?: boolean;
      targetDomains?: string[];
      guardedActionPolicy?: string;
      domainCounts?: Record<string, number>;
      riskCounts?: Record<string, number>;
      topPaths?: Array<{ businessPath?: string; eventCount?: number }>;
      matchedClasses?: Record<string, number>;
      mapLoadError?: string;
    };
    dominantBusinessDomain?: string;
    lastBusinessPath?: string;
    events?: MonkeyEvent[];
  };

  if (loading) {
    return <Alert showIcon type="info" message="正在加载 Monkey 报告..." />;
  }

  const report = parseJsonPreview<MonkeyReport>(preview);
  if (!report) {
    return preview?.content ? (
      <Alert showIcon type="warning" message="Monkey 报告不是可解析的 JSON" />
    ) : (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次任务没有 Monkey 报告" />
    );
  }

  const events = report.events || [];
  const eventCounts = events.reduce<Record<string, number>>((acc, event) => {
    const type = event.type || 'unknown';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const backEvents = events.filter((event) => event.type === 'edgeBack' || event.type === 'tapBack');
  const stuckEvents = events.filter((event) => /stuck/i.test(event.reason || ''));
  const fallbackEvents = events.filter((event) => event.usedFallbackPoint);
  const recentEvents = events.slice(-8).reverse();
  const executedEvents = report.executedEvents ?? events.length;
  const durationSeconds = report.durationMs ? Math.round(report.durationMs / 1000) : report.requestedDurationSeconds;
  const isPassed = report.status === 'passed';
  const businessCoverage = report.businessCoverage;
  const businessAware = !!(report.businessAware || businessCoverage?.enabled || report.rules?.businessAware);
  const domainEntries = Object.entries(businessCoverage?.domainCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  const riskEntries = Object.entries(businessCoverage?.riskCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  const guardedEventCount = events.filter((event) => event.businessGuard).length;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        showIcon
        type={isPassed ? 'success' : 'warning'}
        message={isPassed ? 'Monkey 执行完成' : 'Monkey 执行异常'}
        description={report.message || '未提供执行说明'}
      />
      <Space wrap>
        <Tag color={isPassed ? 'green' : 'red'}>{report.status || 'unknown'}</Tag>
        {businessAware && <Tag color="blue">业务感知探索</Tag>}
        <Tag>执行 {executedEvents} 次</Tag>
        {report.requestedEvents !== undefined && <Tag>目标 {report.requestedEvents} 次</Tag>}
        {durationSeconds !== undefined && <Tag>耗时 {formatSeconds(durationSeconds)}</Tag>}
        {report.requestedDurationSeconds !== undefined && <Tag>计划 {formatSeconds(report.requestedDurationSeconds)}</Tag>}
        {report.wdaUrl && <Tag>WDA {report.wdaUrl.replace(/^https?:\/\//, '')}</Tag>}
      </Space>
      {businessAware && (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Text strong>业务探索覆盖</Text>
          {businessCoverage?.mapLoadError ? (
            <Alert showIcon type="warning" message={`业务映射加载失败：${businessCoverage.mapLoadError}`} />
          ) : null}
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="主要业务域">{report.dominantBusinessDomain || '-'}</Descriptions.Item>
            <Descriptions.Item label="最后路径">{report.lastBusinessPath || '-'}</Descriptions.Item>
            <Descriptions.Item label="保护动作">{guardedEventCount}</Descriptions.Item>
            <Descriptions.Item label="目标业务">
              {(businessCoverage?.targetDomains || report.rules?.businessDomains || []).join('、') || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="保护策略">{businessCoverage?.guardedActionPolicy || report.rules?.guardedActionPolicy || '-'}</Descriptions.Item>
            <Descriptions.Item label="风险分布">
              {riskEntries.length ? riskEntries.map(([risk, count]) => `${risk} ${count}`).join(' / ') : '-'}
            </Descriptions.Item>
          </Descriptions>
          {domainEntries.length > 0 && (
            <Space wrap>
              {domainEntries.map(([domain, count]) => (
                <Tag key={domain} color={domain === report.dominantBusinessDomain ? 'blue' : 'default'}>
                  {domain} {count}
                </Tag>
              ))}
            </Space>
          )}
          {businessCoverage?.topPaths?.length ? (
            <Space wrap>
              {businessCoverage.topPaths.slice(0, 8).map((item) => (
                <Tag key={item.businessPath || 'unknown'}>
                  {item.businessPath || 'unknown'} {item.eventCount || 0}
                </Tag>
              ))}
            </Space>
          ) : null}
        </Space>
      )}
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
        <Descriptions.Item label="点击">{eventCounts.tap || 0}</Descriptions.Item>
        <Descriptions.Item label="滑动">{eventCounts.swipe || 0}</Descriptions.Item>
        <Descriptions.Item label="返回">{backEvents.length}</Descriptions.Item>
        <Descriptions.Item label="卡住处理">{stuckEvents.length}</Descriptions.Item>
        <Descriptions.Item label="兜底点击">{fallbackEvents.length}</Descriptions.Item>
        <Descriptions.Item label="禁点文案">{report.rules?.forbiddenTexts?.length || 0}</Descriptions.Item>
      </Descriptions>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Text strong>执行规则</Text>
        <Space wrap>
          {report.rules?.backIntervalEvents !== undefined && <Tag>每 {report.rules.backIntervalEvents} 次尝试返回</Tag>}
          {report.rules?.stuckEvents !== undefined && <Tag>连续 {report.rules.stuckEvents} 次判定卡住</Tag>}
          {report.rules?.stuckCheckIntervalEvents !== undefined && <Tag>每 {report.rules.stuckCheckIntervalEvents} 次检测卡住</Tag>}
          {report.rules?.backActionProbability !== undefined && <Tag>返回概率 {Math.round(report.rules.backActionProbability * 100)}%</Tag>}
          {report.rules?.backTapProbability !== undefined && <Tag>点击返回概率 {Math.round(report.rules.backTapProbability * 100)}%</Tag>}
          {report.rules?.avoidTopBar !== undefined && <Tag>{report.rules.avoidTopBar ? '避开顶部区域' : '允许顶部区域'}</Tag>}
          {report.rules?.heartbeatIntervalSeconds !== undefined && <Tag>心跳 {report.rules.heartbeatIntervalSeconds}s</Tag>}
        </Space>
      </Space>
      {recentEvents.length > 0 && (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Text strong>最近动作</Text>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {recentEvents.map((event) => (
              <Text key={event.index} type="secondary" style={{ fontSize: 12 }}>
                #{event.index} {eventTypeLabel(event.type)}
                {event.reason ? ` / ${event.reason}` : ''}
                {event.businessPath ? ` / ${event.businessPath}` : ''}
                {event.pageName ? ` / ${event.pageName}` : ''}
                {event.x !== undefined && event.y !== undefined ? ` / (${event.x}, ${event.y})` : ''}
                {event.startX !== undefined && event.endX !== undefined ? ` / (${event.startX}, ${event.startY}) -> (${event.endX}, ${event.endY})` : ''}
              </Text>
            ))}
          </Space>
        </Space>
      )}
      <Collapse
        size="small"
        items={[
          {
            key: 'raw',
            label: '查看原始 Monkey 数据',
            children: (
              <pre
                style={{
                  margin: 0,
                  maxHeight: 360,
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
                {preview?.content || '文件内容为空'}
              </pre>
            ),
          },
        ]}
      />
    </Space>
  );
}
