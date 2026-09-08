import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Descriptions, Empty, Form, Input, Row, Space, Table, Tag, Typography } from 'antd';
import { DeliveryReadiness, workflowApi } from '../services/api';

const labels = { passed: '证据通过', blocked: '存在阻断', warning: '待核实', unknown: '证据不足' };
const colors = { passed: 'green', blocked: 'red', warning: 'gold', unknown: 'default' };

export default function DeliveryReadinessPanel({ onNavigate }: { onNavigate: (target: DeliveryReadiness['actions'][number]['target'], buildNumber: string) => void }) {
  const [form] = Form.useForm();
  const [result, setResult] = useState<DeliveryReadiness>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  useEffect(() => () => { requestId.current += 1; }, []);
  const diagnose = async ({ buildNumber }: { buildNumber: string }) => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError('');
    setResult(undefined);
    try {
      const response = await workflowApi.deliveryReadiness(buildNumber.trim());
      if (currentRequest === requestId.current) setResult(response.data);
    } catch (failure: any) {
      if (currentRequest === requestId.current) setError(failure?.error || failure?.message || '交付诊断加载失败，请重试');
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  };
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="研发交付诊断">
        <Typography.Paragraph type="secondary">从源构建出发，查看变更、产物、质检、问题处理和发布观察，找到下一步最需要处理的事项。</Typography.Paragraph>
        <Form form={form} layout="inline" onFinish={diagnose} initialValues={{ buildNumber: new URLSearchParams(window.location.search).get('buildNumber') || '' }}>
          <Form.Item name="buildNumber" label="Jenkins 源构建号" rules={[{ required: true, message: '请输入源构建号' }, { pattern: /^[1-9]\d{0,11}$/, message: '请输入 1 至 12 位正整数' }]}>
            <Input placeholder="例如 12345" aria-label="Jenkins 源构建号" style={{ width: 220 }} />
          </Form.Item>
          <Form.Item><Button type="primary" htmlType="submit" loading={loading}>诊断交付链路</Button></Form.Item>
        </Form>
      </Card>
      {error && <Alert type="error" showIcon message={error} />}
      {!result && !loading && !error && <Empty description="输入源构建号，查看当前产品线的交付证据" />}
      {result && <>
        <Alert showIcon type={result.status === 'blocked' ? 'error' : result.status === 'passed' ? 'success' : 'warning'} message={`构建 #${result.buildNumber} · ${result.summary}`} description={result.limitations.join(' ')} />
        <Descriptions size="small" bordered column={{ xs: 1, sm: 2, md: 3 }} items={[
          { key: 'branch', label: '分支', children: result.context.branch || '缺失' },
          { key: 'commit', label: 'Commit', children: result.context.commitHash || '缺失' },
          { key: 'version', label: '版本', children: result.context.releaseVersion || '缺失' },
          { key: 'updated', label: '构建同步时间', children: result.context.updatedAt ? new Date(result.context.updatedAt).toLocaleString('zh-CN') : '尚未同步' },
          { key: 'evaluated', label: '诊断时间', children: new Date(result.evaluatedAt).toLocaleString('zh-CN') },
          { key: 'gate', label: '门禁快照', children: result.gate.result.summary },
        ]} />
        <Row gutter={[12, 12]}>{result.stages.map((stage) => <Col xs={24} md={12} xl={8} key={stage.key}>
          <Card size="small" title={stage.title} extra={<Tag color={colors[stage.status]}>{labels[stage.status]}</Tag>}>
            <Typography.Paragraph style={{ margin: 0 }}>{stage.summary}</Typography.Paragraph>
          </Card>
        </Col>)}</Row>
        <Card title={`下一步行动（${result.actions.length}）`}>
          <Table size="small" rowKey="code" dataSource={result.actions} pagination={{ pageSize: 8 }} scroll={{ x: 760 }} columns={[
            { title: '优先级', dataIndex: 'priority', width: 85, render: (value) => <Tag color={value === 'P0' ? 'red' : value === 'P1' ? 'gold' : 'blue'}>{value}</Tag> },
            { title: '事项', dataIndex: 'title', width: 260 },
            { title: '处理依据', dataIndex: 'reason' },
            { title: '入口', width: 100, render: (_, action) => <Button type="link" onClick={() => onNavigate(action.target, result.buildNumber)}>前往处理</Button> },
          ]} />
        </Card>
        <Card title="关联证据">
          <Table size="small" rowKey="id" dataSource={result.evidence.tasks} pagination={{ pageSize: 5 }} scroll={{ x: 700 }} columns={[
            { title: '任务 ID', dataIndex: 'id', ellipsis: true },
            { title: '套件', dataIndex: 'suite' },
            { title: '状态', dataIndex: 'status' },
            { title: 'Commit', dataIndex: 'commitHash', ellipsis: true },
          ]} />
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>关联 {result.counts.artifacts} 个产物、{result.counts.issues} 个问题、{result.counts.candidates} 个回归候选。正式发布前仍需实时复核。</Typography.Paragraph>
        </Card>
      </>}
    </Space>
  );
}
