import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  ApartmentOutlined,
  BugOutlined,
  ExperimentOutlined,
  FundProjectionScreenOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import {
  workflowApi,
  qualityApi,
  WorkflowImpactResult,
  WorkflowIssue,
  WorkflowKnowledgeEntry,
  WorkflowOverview,
  WorkflowRegressionCandidate,
  WorkflowReleaseGate,
  WorkflowReleaseObservation,
} from '../services/api';

const { Title, Paragraph, Text } = Typography;

const severityColor: Record<string, string> = {
  blocker: 'red',
  critical: 'red',
  high: 'volcano',
  medium: 'gold',
  low: 'blue',
  info: 'default',
};

const statusColor: Record<string, string> = {
  passed: 'green',
  success: 'green',
  completed: 'green',
  resolved: 'green',
  blocked: 'red',
  failed: 'red',
  critical: 'red',
  warning: 'gold',
  running: 'processing',
  queued: 'processing',
  open: 'blue',
  proposed: 'purple',
  generated: 'cyan',
  exported: 'blue',
  compiled: 'geekblue',
  verified: 'green',
};

function dateText(value?: string) {
  return value ? new Date(value).toLocaleString('zh-CN') : '-';
}

export default function WorkflowPage() {
  const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState<WorkflowOverview>();
  const [issues, setIssues] = useState<WorkflowIssue[]>([]);
  const [gates, setGates] = useState<WorkflowReleaseGate[]>([]);
  const [candidates, setCandidates] = useState<WorkflowRegressionCandidate[]>([]);
  const [knowledge, setKnowledge] = useState<WorkflowKnowledgeEntry[]>([]);
  const [observations, setObservations] = useState<WorkflowReleaseObservation[]>([]);
  const [evaluations, setEvaluations] = useState<any[]>([]);
  const [impact, setImpact] = useState<WorkflowImpactResult>();
  const [gateResult, setGateResult] = useState<WorkflowReleaseGate>();
  const [releaseHealth, setReleaseHealth] = useState<Record<string, any>>();
  const [detailTitle, setDetailTitle] = useState('');
  const [detailContent, setDetailContent] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [impactForm] = Form.useForm();
  const [gateForm] = Form.useForm();
  const [observationForm] = Form.useForm();
  const [knowledgeForm] = Form.useForm();

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      // 读取标准质量任务时，后端会把 Jenkins/local artifacts 同步进 Workflow 数据模型。
      await qualityApi.listTasks().catch(() => undefined);
      const [overviewResponse, issueResponse, gateResponse, candidateResponse, knowledgeResponse, observationResponse, evaluationResponse] = await Promise.all([
        workflowApi.overview(),
        workflowApi.listIssues(),
        workflowApi.listGates(),
        workflowApi.listRegressionCandidates(),
        workflowApi.listKnowledge(),
        workflowApi.listReleaseObservations(),
        workflowApi.listAIEvaluations(),
      ]);
      setOverview(overviewResponse.data);
      setIssues(issueResponse.data || []);
      setGates(gateResponse.data || []);
      setCandidates(candidateResponse.data || []);
      setKnowledge(knowledgeResponse.data || []);
      setObservations(observationResponse.data || []);
      setEvaluations(evaluationResponse.data || []);
    } catch (error: any) {
      message.error(error?.error || error?.message || '加载 Workflow 数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const openJson = (title: string, value: unknown) => {
    setDetailTitle(title);
    setDetailContent(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    setDetailOpen(true);
  };

  const updateIssue = async (issue: WorkflowIssue, status: string) => {
    try {
      await workflowApi.updateIssue(issue.id, { status });
      message.success(`Issue 已更新为 ${status}`);
      await loadAll();
    } catch (error: any) {
      message.error(error?.error || '更新 Issue 失败');
    }
  };

  const proposeRegression = async (issue: WorkflowIssue) => {
    try {
      const response = await workflowApi.proposeRegression(issue.id);
      message.success('已生成确定性回归候选');
      openJson('回归候选', response.data);
      await loadAll();
    } catch (error: any) {
      message.error(error?.error || '生成回归候选失败');
    }
  };

  const suggestFix = async (issue: WorkflowIssue) => {
    const key = `fix-${issue.id}`;
    message.loading({ content: '正在生成候选修复建议...', key, duration: 0 });
    try {
      const response = await workflowApi.suggestFix(issue.id, {
        businessDomain: issue.businessDomain,
        businessPath: issue.businessPath,
        module: issue.module,
      });
      message.success({ content: '候选修复建议已生成', key });
      openJson('候选修复建议（不会创建 Commit/PR）', response.data);
    } catch (error: any) {
      message.error({ content: error?.error || '生成修复建议失败', key });
    }
  };

  const analyzeImpact = async () => {
    const values = await impactForm.validateFields();
    setLoading(true);
    try {
      const response = await workflowApi.analyzeImpact(values);
      setImpact(response.data);
      message.success('变更影响分析完成');
    } catch (error: any) {
      message.error(error?.error || '变更影响分析失败');
    } finally {
      setLoading(false);
    }
  };

  const evaluateGate = async () => {
    const values = await gateForm.validateFields();
    try {
      const response = await workflowApi.evaluateGate({
        ...values,
        policy: { requiredSuites: values.requiredSuites },
      });
      setGateResult(response.data);
      message.success('质量门禁评估完成');
      await loadAll();
    } catch (error: any) {
      message.error(error?.error || '质量门禁评估失败');
    }
  };

  const generateXCUITest = async (candidate: WorkflowRegressionCandidate) => {
    const key = `xcuitest-${candidate.id}`;
    message.loading({ content: '正在生成 XCUITest...', key, duration: 0 });
    try {
      const response = await workflowApi.generateXCUITest(candidate.id);
      const code = response.data?.candidate?.generatedCode || response.data?.generation?.code || '';
      message.success({ content: 'XCUITest 已生成', key });
      openJson('生成的 XCUITest', code);
      await loadAll();
    } catch (error: any) {
      message.error({ content: error?.error || '生成 XCUITest 失败', key });
    }
  };

  const exportXCUITest = async (candidate: WorkflowRegressionCandidate) => {
    try {
      const response = await workflowApi.exportXCUITest(candidate.id);
      message.success('XCUITest 已导出到平台数据目录，未修改 nnios');
      openJson('导出结果', response.data);
      await loadAll();
    } catch (error: any) {
      message.error(error?.error || '导出 XCUITest 失败');
    }
  };

  const verifyXCUITest = async (candidate: WorkflowRegressionCandidate) => {
    const key = `compile-${candidate.id}`;
    message.loading({ content: '正在独立校验 Swift/XCTest 代码...', key, duration: 0 });
    try {
      const response = await workflowApi.verifyXCUITest(candidate.id);
      if (response.data?.passed) message.success({ content: 'XCUITest 独立类型检查通过', key });
      else message.error({ content: 'XCUITest 类型检查失败，可查看日志', key });
      openJson('编译结果', response.data);
      await loadAll();
    } catch (error: any) {
      message.error({ content: error?.error || '编译 XCUITest 失败', key });
    }
  };

  const runXCUITest = async (candidate: WorkflowRegressionCandidate) => {
    const key = `run-${candidate.id}`;
    message.loading({ content: '正在提交外部 CI/XCUITest Runner...', key, duration: 0 });
    try {
      const response = await workflowApi.runXCUITest(candidate.id);
      if (response.data?.passed) message.success({ content: 'XCUITest 执行通过', key });
      else message.error({ content: 'XCUITest 执行失败', key });
      openJson('执行结果', response.data);
      await loadAll();
    } catch (error: any) {
      message.error({ content: error?.error || '请先配置 WORKFLOW_XCUITEST_RUNNER_URL', key });
    }
  };

  const addObservation = async () => {
    const values = await observationForm.validateFields();
    try {
      await workflowApi.addReleaseObservation(values);
      const response = await workflowApi.releaseHealth(values.releaseVersion);
      setReleaseHealth(response.data);
      message.success('发布观察指标已记录');
      observationForm.setFieldsValue({ metric: '', value: undefined, baselineValue: undefined });
      await loadAll();
    } catch (error: any) {
      message.error(error?.error || '记录发布观察失败');
    }
  };

  const synthesizeKnowledge = async () => {
    const values = await knowledgeForm.validateFields();
    const payload = {
      ...values,
      tags: String(values.tags || '').split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      reusableChecks: String(values.reusableChecks || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    };
    try {
      const response = await workflowApi.synthesizeKnowledge(payload);
      message.success('知识条目已沉淀');
      openJson('知识条目', response.data);
      knowledgeForm.resetFields();
      await loadAll();
    } catch (error: any) {
      message.error(error?.error || '知识提炼失败');
    }
  };

  const evaluateAIOutput = async (evaluationId: string, accepted: boolean) => {
    try {
      await workflowApi.updateAIEvaluation(evaluationId, { accepted, score: accepted ? 1 : 0 });
      message.success(accepted ? '已标记为采纳' : '已标记为未采纳');
      await loadAll();
    } catch (error: any) {
      message.error(error?.error || '更新 AI 评测失败');
    }
  };

  const overviewTab = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        {[
          { title: 'Artifacts', value: overview?.artifacts || 0, icon: <ApartmentOutlined />, color: '#1677ff' },
          { title: '统一任务', value: overview?.tasks || 0, icon: <ExperimentOutlined />, color: '#722ed1' },
          { title: '运行中', value: overview?.activeTasks || 0, icon: <FundProjectionScreenOutlined />, color: '#13c2c2' },
          { title: '开放 Issue', value: overview?.openIssues || 0, icon: <BugOutlined />, color: '#f5222d' },
          { title: '回归候选', value: overview?.regressionCandidates || 0, icon: <SafetyCertificateOutlined />, color: '#fa8c16' },
          { title: '知识条目', value: overview?.knowledgeEntries || 0, icon: <RobotOutlined />, color: '#52c41a' },
        ].map((item) => (
          <Col xs={12} md={8} xl={4} key={item.title}>
            <Card><Statistic title={item.title} value={item.value} prefix={<span style={{ color: item.color }}>{item.icon}</span>} /></Card>
          </Col>
        ))}
      </Row>
      {overview?.latestGate && (
        <Alert
          showIcon
          type={overview.latestGate.status === 'passed' ? 'success' : overview.latestGate.status === 'blocked' ? 'error' : 'warning'}
          message={`最新发布门禁：${overview.latestGate.result?.summary || overview.latestGate.status}`}
          description={`Build #${overview.latestGate.buildNumber} · 评分 ${overview.latestGate.score}`}
        />
      )}
      <Row gutter={16}>
        <Col xs={24} xl={12}>
          <Card title="最近任务">
            <Table size="small" rowKey="id" pagination={false} dataSource={overview?.latestTasks || []} columns={[
              { title: '套件', dataIndex: 'suite', render: (value) => <Tag>{value || '-'}</Tag> },
              { title: '构建', dataIndex: 'buildNumber' },
              { title: '状态', dataIndex: 'status', render: (value) => <Tag color={statusColor[value]}>{value}</Tag> },
              { title: '进度', dataIndex: 'progress', render: (value) => <Progress percent={Number(value) || 0} size="small" /> },
            ]} />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="最近 Issue">
            <Table size="small" rowKey="id" pagination={false} dataSource={overview?.latestIssues || []} columns={[
              { title: '级别', dataIndex: 'severity', width: 90, render: (value) => <Tag color={severityColor[value]}>{value}</Tag> },
              { title: '问题', dataIndex: 'title', ellipsis: true },
              { title: '业务域', dataIndex: 'businessDomain', width: 100 },
              { title: '状态', dataIndex: 'status', width: 90, render: (value) => <Tag color={statusColor[value]}>{value}</Tag> },
            ]} />
          </Card>
        </Col>
      </Row>
    </Space>
  );

  const issueTab = (
    <Table
      rowKey="id"
      loading={loading}
      dataSource={issues}
      tableLayout="fixed"
      scroll={{ x: 1490 }}
      columns={[
        { title: '级别', dataIndex: 'severity', width: 90, render: (value) => <Tag color={severityColor[value]}>{value}</Tag> },
        {
          title: '问题',
          dataIndex: 'title',
          width: 320,
          ellipsis: true,
          render: (value, row) => (
            <Button
              type="link"
              title={value}
              onClick={() => openJson(row.title, row)}
              style={{
                display: 'block',
                width: '100%',
                maxWidth: '100%',
                paddingInline: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textAlign: 'left',
              }}
            >
              {value}
            </Button>
          ),
        },
        { title: '分类', dataIndex: 'category', width: 140 },
        {
          title: '业务路径',
          dataIndex: 'businessPath',
          width: 180,
          ellipsis: true,
          render: (value) => value
            ? <Text code ellipsis={{ tooltip: value }} style={{ display: 'block', maxWidth: '100%' }}>{value}</Text>
            : '-',
        },
        { title: '构建', dataIndex: 'buildNumber', width: 90 },
        { title: '次数', dataIndex: 'occurrenceCount', width: 70 },
        { title: '状态', dataIndex: 'status', width: 90, render: (value) => <Tag color={statusColor[value]}>{value}</Tag> },
        { title: '最近发生', dataIndex: 'lastSeen', width: 180, render: dateText },
        {
          title: '操作', key: 'actions', width: 330, fixed: 'right', render: (_, row) => (
            <Space size={4} wrap>
              <Button size="small" onClick={() => proposeRegression(row)}>回归候选</Button>
              <Button size="small" icon={<RobotOutlined />} onClick={() => suggestFix(row)}>修复建议</Button>
              {row.status === 'resolved'
                ? <Button size="small" onClick={() => updateIssue(row, 'open')}>重开</Button>
                : <Button size="small" onClick={() => updateIssue(row, 'resolved')}>解决</Button>}
              <Button size="small" onClick={() => updateIssue(row, 'ignored')}>忽略</Button>
            </Space>
          ),
        },
      ]}
    />
  );

  const impactTab = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="PR / Commit 变更影响分析">
        <Form form={impactForm} layout="vertical" initialValues={{ repoPath: '/Users/a1/工作/nnios', headRef: 'HEAD' }}>
          <Row gutter={16}>
            <Col xs={24} lg={10}><Form.Item label="iOS 仓库路径" name="repoPath" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col xs={12} lg={5}><Form.Item label="Base Ref" name="baseRef"><Input placeholder="origin/main；留空分析工作区" /></Form.Item></Col>
            <Col xs={12} lg={5}><Form.Item label="Head Ref" name="headRef"><Input /></Form.Item></Col>
            <Col xs={24} lg={4} style={{ display: 'flex', alignItems: 'end' }}><Form.Item><Button type="primary" onClick={analyzeImpact}>开始分析</Button></Form.Item></Col>
          </Row>
        </Form>
      </Card>
      {impact && <Card title="影响结论">
        <Descriptions column={{ xs: 1, md: 3 }}>
          <Descriptions.Item label="风险"><Progress type="circle" size={72} percent={impact.riskScore} status={impact.riskLevel === 'high' ? 'exception' : 'normal'} /></Descriptions.Item>
          <Descriptions.Item label="变更规模">{impact.totalFiles} 文件 / {impact.changedLines} 行</Descriptions.Item>
          <Descriptions.Item label="模块">{impact.modules.map((item) => <Tag key={item}>{item}</Tag>)}</Descriptions.Item>
          <Descriptions.Item label="业务域">{impact.domains.map((item) => <Tag color="blue" key={item}>{item}</Tag>)}</Descriptions.Item>
          <Descriptions.Item label="推荐套件" span={2}>{impact.recommendedSuites.map((item) => <Tag color="purple" key={item}>{item}</Tag>)}</Descriptions.Item>
          <Descriptions.Item label="专项检查" span={3}>{impact.recommendedChecks.length ? impact.recommendedChecks.join('；') : '基础 Smoke 与单元测试'}</Descriptions.Item>
        </Descriptions>
        <Table size="small" rowKey="path" pagination={{ pageSize: 20 }} dataSource={impact.files} columns={[
          { title: '文件', dataIndex: 'path', ellipsis: true },
          { title: '类型', dataIndex: 'kind', width: 130 },
          { title: '模块', dataIndex: 'module', width: 140 },
          { title: '+/-', width: 100, render: (_, row) => <Text><Text type="success">+{row.added}</Text> / <Text type="danger">-{row.deleted}</Text></Text> },
          { title: '风险', dataIndex: 'risks', width: 280, render: (values: string[]) => values.map((item) => <Tag key={item}>{item}</Tag>) },
        ]} />
      </Card>}
    </Space>
  );

  const gateTab = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="发布质量门禁">
        <Form form={gateForm} layout="vertical" initialValues={{ buildStatus: 'success', requiredSuites: ['smoke'] }}>
          <Row gutter={16}>
            <Col xs={12} md={5}><Form.Item label="构建号" name="buildNumber" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col xs={12} md={5}><Form.Item label="分支" name="branch"><Input /></Form.Item></Col>
            <Col xs={12} md={5}><Form.Item label="构建状态" name="buildStatus"><Select options={['success', 'failure', 'unstable'].map((value) => ({ value, label: value }))} /></Form.Item></Col>
            <Col xs={24} md={9}><Form.Item label="必需套件" name="requiredSuites"><Checkbox.Group options={['smoke', 'monkey', 'stutter', 'im', 'rtc', 'full']} /></Form.Item></Col>
          </Row>
          <Button type="primary" onClick={evaluateGate}>执行门禁评估</Button>
        </Form>
      </Card>
      {gateResult && <Alert showIcon type={gateResult.status === 'passed' ? 'success' : gateResult.status === 'blocked' ? 'error' : 'warning'} message={gateResult.result.summary || gateResult.status} description={`评分 ${gateResult.score}；构建 #${gateResult.buildNumber}`} />}
      <Table rowKey="id" dataSource={gates} columns={[
        { title: '构建', dataIndex: 'buildNumber' },
        { title: '分支', dataIndex: 'branch' },
        { title: '状态', dataIndex: 'status', render: (value) => <Tag color={statusColor[value]}>{value}</Tag> },
        { title: '评分', dataIndex: 'score', render: (value) => <Progress percent={value} size="small" /> },
        { title: '时间', dataIndex: 'createdAt', render: dateText },
        { title: '详情', render: (_, row) => <Button type="link" onClick={() => openJson('门禁详情', row)}>查看</Button> },
      ]} />
    </Space>
  );

  const regressionTab = (
    <Table rowKey="id" dataSource={candidates} columns={[
      { title: '候选', dataIndex: 'title', render: (value, row) => <Button type="link" onClick={() => openJson(value, row)}>{value}</Button> },
      { title: '业务路径', dataIndex: 'businessPath', render: (value) => value ? <Text code>{value}</Text> : '-' },
      { title: '置信度', dataIndex: 'confidence', width: 130, render: (value) => <Progress percent={Math.round(Number(value) * 100)} size="small" /> },
      { title: '状态', dataIndex: 'status', width: 100, render: (value) => <Tag color={statusColor[value]}>{value}</Tag> },
      { title: '更新时间', dataIndex: 'updatedAt', width: 180, render: dateText },
      { title: '操作', width: 390, render: (_, row) => <Space size={4} wrap>
        <Button size="small" icon={<RobotOutlined />} onClick={() => generateXCUITest(row)}>生成</Button>
        <Button size="small" disabled={!row.generatedCode} onClick={() => exportXCUITest(row)}>导出</Button>
        <Button size="small" disabled={!row.generatedCode} onClick={() => verifyXCUITest(row)}>编译</Button>
        <Button size="small" type="primary" ghost disabled={!row.generatedCode} onClick={() => runXCUITest(row)}>外部 Runner 执行</Button>
      </Space> },
    ]} />
  );

  const evolutionTab = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={16}>
        <Col xs={24} xl={12}>
          <Card title="移动研发知识沉淀">
            <Form form={knowledgeForm} layout="vertical">
              <Form.Item label="标题" name="title" rules={[{ required: true }]}><Input /></Form.Item>
              <Form.Item label="摘要" name="summary" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
              <Form.Item label="标签" name="tags"><Input placeholder="Crash, IM, 生命周期" /></Form.Item>
              <Form.Item label="可复用检查" name="reusableChecks"><Input.TextArea rows={3} placeholder="每行一条" /></Form.Item>
              <Button type="primary" icon={<RobotOutlined />} onClick={synthesizeKnowledge}>AI 提炼并保存</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="灰度 / 发布观察">
            <Form form={observationForm} layout="vertical" initialValues={{ status: 'normal', channel: 'TestFlight' }}>
              <Row gutter={12}>
                <Col span={12}><Form.Item label="版本" name="releaseVersion" rules={[{ required: true }]}><Input /></Form.Item></Col>
                <Col span={12}><Form.Item label="渠道" name="channel"><Select options={['Pgyer', 'TestFlight', 'AppStore'].map((value) => ({ value, label: value }))} /></Form.Item></Col>
                <Col span={12}><Form.Item label="指标" name="metric" rules={[{ required: true }]}><Input placeholder="crash_free_rate" /></Form.Item></Col>
                <Col span={6}><Form.Item label="当前值" name="value" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} /></Form.Item></Col>
                <Col span={6}><Form.Item label="基线" name="baselineValue"><InputNumber style={{ width: '100%' }} /></Form.Item></Col>
                <Col span={12}><Form.Item label="状态" name="status"><Select options={['normal', 'warning', 'critical', 'regressed'].map((value) => ({ value, label: value }))} /></Form.Item></Col>
              </Row>
              <Button type="primary" onClick={addObservation}>记录并评估发布健康度</Button>
            </Form>
            {releaseHealth && <Alert style={{ marginTop: 16 }} showIcon type={releaseHealth.status === 'healthy' ? 'success' : releaseHealth.status === 'critical' ? 'error' : 'warning'} message={`发布健康度：${releaseHealth.status}`} description={(releaseHealth.recommendations || []).join('；')} />}
          </Card>
        </Col>
      </Row>
      <Card title="知识库">
        <Table rowKey="id" size="small" dataSource={knowledge} columns={[
          { title: '类型', dataIndex: 'kind', width: 160 },
          { title: '标题', dataIndex: 'title' },
          { title: '摘要', dataIndex: 'summary', ellipsis: true },
          { title: '置信度', dataIndex: 'confidence', width: 100, render: (value) => `${Math.round(Number(value) * 100)}%` },
          { title: '详情', width: 80, render: (_, row) => <Button type="link" onClick={() => openJson(row.title, row)}>查看</Button> },
        ]} />
      </Card>
      <Card title="发布观察记录">
        <Table rowKey="id" size="small" dataSource={observations} columns={[
          { title: '版本', dataIndex: 'releaseVersion' },
          { title: '渠道', dataIndex: 'channel' },
          { title: '指标', dataIndex: 'metric' },
          { title: '当前值', dataIndex: 'value' },
          { title: '基线', dataIndex: 'baselineValue' },
          { title: '状态', dataIndex: 'status', render: (value) => <Tag color={statusColor[value]}>{value}</Tag> },
          { title: '时间', dataIndex: 'observedAt', render: dateText },
        ]} />
      </Card>
      <Card title="AI 输出评测">
        <Table rowKey="id" size="small" dataSource={evaluations} columns={[
          { title: '能力', dataIndex: 'capability' },
          { title: '模型', dataIndex: 'model' },
          { title: 'Prompt', dataIndex: 'promptVersion' },
          { title: '耗时', dataIndex: 'latencyMs', render: (value) => value === null || value === undefined ? '-' : `${value}ms` },
          { title: '采纳', dataIndex: 'accepted', render: (value) => value === null ? <Tag>待评价</Tag> : <Tag color={value ? 'green' : 'red'}>{value ? '是' : '否'}</Tag> },
          { title: '输出', render: (_, row) => <Button type="link" onClick={() => openJson('AI 输出', row.output)}>查看</Button> },
          { title: '反馈', render: (_, row) => <Space><Button size="small" onClick={() => evaluateAIOutput(row.id, true)}>采纳</Button><Button size="small" danger onClick={() => evaluateAIOutput(row.id, false)}>不采纳</Button></Space> },
        ]} />
      </Card>
    </Space>
  );

  const tabItems = useMemo(() => [
    { key: 'overview', label: '平台概览', children: overviewTab },
    { key: 'issues', label: `Issue 中心（${issues.length}）`, children: issueTab },
    { key: 'impact', label: '变更影响', children: impactTab },
    { key: 'gate', label: '发布门禁', children: gateTab },
    { key: 'regression', label: `回归候选（${candidates.length}）`, children: regressionTab },
    { key: 'evolution', label: '知识与发布观察', children: evolutionTab },
  ], [overview, issues, gates, candidates, knowledge, observations, evaluations, impact, gateResult, releaseHealth, loading]);

  return (
    <div>
      <Space align="start" style={{ width: '100%', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <Title level={4} style={{ marginBottom: 6 }}><ApartmentOutlined style={{ color: '#1677ff', marginRight: 8 }} />移动研发质量中心</Title>
          <Paragraph type="secondary" style={{ margin: 0 }}>统一汇聚 Artifact、质量任务和 Issue，为变更分析、发布决策、确定性回归及质量知识沉淀提供依据。</Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={loadAll}>刷新</Button>
      </Space>
      <Alert
        showIcon
        type="info"
        style={{ marginBottom: 16 }}
        message="当前实施范围"
        description="已跳过安全底座；候选修复只生成建议，不创建 Commit/PR，也不自动执行修复验证闭环。"
      />
      <Tabs items={tabItems} />
      <Modal title={detailTitle} open={detailOpen} onCancel={() => setDetailOpen(false)} footer={null} width={1000}>
        <pre style={{ margin: 0, padding: 16, maxHeight: '70vh', overflow: 'auto', background: '#f6f8fa', borderRadius: 8, whiteSpace: 'pre-wrap' }}>{detailContent}</pre>
      </Modal>
    </div>
  );
}
