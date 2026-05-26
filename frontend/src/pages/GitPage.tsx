import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Typography,
  Card,
  Tabs,
  Table,
  Tag,
  Button,
  Space,
  Empty,
  Input,
  Form,
  Select,
  Switch,
  Alert,
  Row,
  Col,
  Divider,
  message,
  Modal,
  List,
  Tooltip,
  Spin,
} from 'antd';
import {
  BranchesOutlined,
  SearchOutlined,
  PullRequestOutlined,
  TagOutlined,
  PlayCircleOutlined,
  ClearOutlined,
  StopOutlined,
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  LoadingOutlined,
  MinusCircleTwoTone,
  ReloadOutlined,
  ExclamationCircleTwoTone,
  CopyOutlined,
  LinkOutlined,
  ExperimentOutlined,
  SettingOutlined,
  KeyOutlined,
} from '@ant-design/icons';
import { gitApi, GitPushMode, GitRemoteBranchCheckResult, GitRepoDependencyResult, GitStreamEvent } from '../services/api';

const { Title, Paragraph, Text } = Typography;
const { TextArea } = Input;

const mrColumns = [
  { title: '标题', dataIndex: 'title', key: 'title', render: (t: string) => <a>{t}</a> },
  { title: '源分支', dataIndex: 'source', key: 'source', render: (t: string) => <Tag>{t}</Tag> },
  { title: '目标分支', dataIndex: 'target', key: 'target', render: (t: string) => <Tag color="blue">{t}</Tag> },
  { title: '状态', dataIndex: 'status', key: 'status', render: (s: string) => <Tag color="green">{s}</Tag> },
  { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt' },
];

interface RepoStatus {
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  message?: string;
}

interface LogLine {
  time: string;
  repo?: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

function extractRepoName(url: string): string {
  const cleaned = url.trim().replace(/\/+$/g, '');
  const basename = cleaned.split('/').pop() || cleaned;
  return basename.replace(/\.git$/i, '');
}

function BatchCreateBranchPanel() {
  const [form] = Form.useForm();
  const [running, setRunning] = useState(false);
  const [prechecking, setPrechecking] = useState(false);
  const [baseDir, setBaseDir] = useState<string>('');
  const [defaultRepos, setDefaultRepos] = useState<string[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [repoStatus, setRepoStatus] = useState<Record<string, RepoStatus>>({});
  const [summary, setSummary] = useState<{ success: boolean; failures: string[] } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    gitApi
      .getDefaultRepos()
      .then((res) => {
        if (res.success && res.data) {
          setDefaultRepos(res.data.repos);
          setBaseDir(res.data.baseDir);
          form.setFieldsValue({
            baseBranch: res.data.baseBranch,
            repos: res.data.repos.join('\n'),
          });
        }
      })
      .catch((err) => {
        console.error(err);
      });
  }, [form]);

  useEffect(() => {
    // 新日志追加到底部后自动滚动
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  const parseRepos = (raw: string): string[] =>
    raw
      .split(/[\n,]/g)
      .map((l) => l.trim())
      .filter(Boolean);

  const handleRun = async () => {
    try {
      const values = await form.validateFields();
      const repos = parseRepos(values.repos || '');
      if (repos.length === 0) {
        message.warning('请至少填写一个仓库地址');
        return;
      }

      // 先做远端预检
      setPrechecking(true);
      let precheck: GitRemoteBranchCheckResult;
      try {
        const res = await gitApi.precheckBranch({
          targetBranch: values.targetBranch.trim(),
          baseBranch: (values.baseBranch || 'develop').trim(),
          repos,
          username: values.username || undefined,
          password: values.password || undefined,
        });
        if (!res.success || !res.data) {
          throw new Error(res.error || '预检失败');
        }
        precheck = res.data;
      } catch (err: any) {
        message.error(err?.message || err?.error || '预检失败，无法联通远端');
        return;
      } finally {
        setPrechecking(false);
      }

      const proceed = await confirmPrecheck(precheck);
      if (!proceed) return;

      await runJob(values, repos, proceed === 'force');
    } catch {
      // 表单校验失败
    }
  };

  /**
   * 根据预检结果弹窗确认
   * 返回 false 表示取消，'normal' 正常执行，'force' 强制覆盖
   */
  const confirmPrecheck = (
    precheck: GitRemoteBranchCheckResult
  ): Promise<false | 'normal' | 'force'> => {
    const { existingRepos, missingBaseRepos, unreachableRepos, targetBranch, baseBranch } = precheck;

    const reachableCount = precheck.items.filter((i) => i.reachable).length;
    const validCount = precheck.items.filter(
      (i) => i.reachable && i.baseExists && !i.targetExists
    ).length;

    // 全部都不可达：直接报错，不必弹窗
    if (reachableCount === 0) {
      message.error('全部仓库无法连通远端，请检查凭据/网络');
      return Promise.resolve(false);
    }

    // 没有任何问题，直接执行
    if (
      existingRepos.length === 0 &&
      missingBaseRepos.length === 0 &&
      unreachableRepos.length === 0
    ) {
      return Promise.resolve('normal');
    }

    return new Promise((resolve) => {
      const section = (title: string, items: string[], color?: string) =>
        items.length > 0 ? (
          <div style={{ marginBottom: 8 }}>
            <Text strong>{title}</Text>（{items.length}）
            <div style={{ marginTop: 4 }}>
              {items.map((n) => (
                <Tag key={n} color={color} style={{ marginBottom: 4 }}>
                  {n}
                </Tag>
              ))}
            </div>
          </div>
        ) : null;

      const canForce = existingRepos.length > 0 && validCount + existingRepos.length > 0;
      const hasBlockingOnly = missingBaseRepos.length > 0 || unreachableRepos.length > 0;

      Modal.confirm({
        title: '分支预检结果',
        width: 560,
        icon: null,
        content: (
          <div>
            <Paragraph>
              目标：<Tag color="blue">{targetBranch}</Tag> 基于{' '}
              <Tag>{baseBranch}</Tag>
            </Paragraph>
            {section(`目标分支已存在`, existingRepos, 'orange')}
            {section(`远端缺少 ${baseBranch}`, missingBaseRepos, 'red')}
            {section('无法连通远端', unreachableRepos, 'red')}
            {existingRepos.length > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 8 }}
                message="默认会跳过已有目标分支的仓库。若选择「强制覆盖」，本地会重置到基准分支并 push，可能覆盖远端已有历史。"
              />
            )}
            {validCount > 0 && (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 8 }}
                message={`${validCount} 个仓库可正常创建 ${targetBranch}`}
              />
            )}
          </div>
        ),
        footer: (_, { OkBtn: _Ok, CancelBtn: _Cancel }) => (
          <Space>
            <Button
              onClick={() => {
                Modal.destroyAll();
                resolve(false);
              }}
            >
              取消
            </Button>
            {canForce && (
              <Button
                danger
                onClick={() => {
                  Modal.destroyAll();
                  resolve('force');
                }}
              >
                强制覆盖已存在的分支
              </Button>
            )}
            <Button
              type="primary"
              disabled={validCount === 0 && !hasBlockingOnly && existingRepos.length > 0 && !canForce}
              onClick={() => {
                Modal.destroyAll();
                resolve('normal');
              }}
            >
              {existingRepos.length > 0 ? `仅处理可创建的 ${validCount} 个` : '确定执行'}
            </Button>
          </Space>
        ),
      });
    });
  };

  const runJob = async (
    values: {
      targetBranch: string;
      baseBranch?: string;
      pullEnabled?: boolean;
      pushMode: GitPushMode;
      username?: string;
      password?: string;
      modifyPodfile?: boolean;
    },
    repos: string[],
    force: boolean
  ) => {
    // 重置状态
    setLogs([]);
    setSummary(null);
    const initStatus: Record<string, RepoStatus> = {};
    repos.forEach((url) => {
      const name = extractRepoName(url);
      initStatus[name] = { name, status: 'pending' };
    });
    setRepoStatus(initStatus);
    setRunning(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      await gitApi.streamCreateBranch(
        {
          targetBranch: values.targetBranch.trim(),
          baseBranch: (values.baseBranch || 'develop').trim(),
          pullEnabled: !!values.pullEnabled,
          pushMode: values.pushMode,
          repos,
          username: values.username || undefined,
          password: values.password || undefined,
          modifyPodfile: values.modifyPodfile !== false,
          force,
        },
        (evt: GitStreamEvent) => handleEvent(evt),
        ctrl.signal
      );
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        appendLog({ level: 'warn', message: '任务已中止' });
      } else {
        appendLog({ level: 'error', message: `请求失败: ${err?.message || err}` });
        message.error(err?.message || '任务失败');
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const appendLog = (partial: Omit<LogLine, 'time'>) => {
    const line: LogLine = { time: new Date().toLocaleTimeString(), ...partial };
    setLogs((prev) => [...prev, line]);
  };

  const handleEvent = (evt: GitStreamEvent) => {
    if (evt.type === 'log') {
      appendLog({ repo: evt.repo, level: evt.level, message: evt.message });
      if (evt.repo) {
        setRepoStatus((prev) => {
          const current = prev[evt.repo!];
          if (!current || current.status === 'success' || current.status === 'failed') return prev;
          return { ...prev, [evt.repo!]: { ...current, status: 'running' } };
        });
      }
    } else if (evt.type === 'result') {
      setRepoStatus((prev) => ({
        ...prev,
        [evt.repo]: { name: evt.repo, status: evt.status, message: evt.message },
      }));
    } else if (evt.type === 'done') {
      setSummary({ success: evt.success, failures: evt.failures });
      if (evt.success) {
        message.success('全部仓库已完成');
      } else if (evt.failures.length > 0) {
        message.warning(`任务结束，失败 ${evt.failures.length} 个`);
      }
    }
  };

  const handleStop = () => {
    if (!abortRef.current) return;
    Modal.confirm({
      title: '确定要中止任务？',
      content: '已经执行的推送无法回滚，正在进行的仓库可能残留中间状态。',
      okButtonProps: { danger: true },
      onOk: () => {
        abortRef.current?.abort();
      },
    });
  };

  const handleClear = () => {
    setLogs([]);
    setSummary(null);
    setRepoStatus({});
  };

  const statusList = useMemo(() => Object.values(repoStatus), [repoStatus]);

  const renderStatusIcon = (status: RepoStatus['status']) => {
    switch (status) {
      case 'success':
        return <CheckCircleTwoTone twoToneColor="#52c41a" />;
      case 'failed':
        return <CloseCircleTwoTone twoToneColor="#ff4d4f" />;
      case 'running':
        return <LoadingOutlined style={{ color: '#1677ff' }} />;
      case 'skipped':
        return <MinusCircleTwoTone twoToneColor="#faad14" />;
      default:
        return <MinusCircleTwoTone twoToneColor="#bfbfbf" />;
    }
  };

  const statusColor = (level: LogLine['level']) => {
    switch (level) {
      case 'error':
        return '#ff7875';
      case 'warn':
        return '#faad14';
      case 'debug':
        return '#8c8c8c';
      default:
        return '#d9d9d9';
    }
  };

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="批量为指定仓库基于基准分支创建新分支，nnios 会自动修改 Podfile 的 branch 引用并提交"
        description={
          baseDir ? (
            <span>
              工作目录：<Text code>{baseDir}</Text>
            </span>
          ) : null
        }
      />

      <Row gutter={16}>
        <Col xs={24} lg={10}>
          <Card size="small" title="任务参数">
            <Form
              form={form}
              layout="vertical"
              initialValues={{
                baseBranch: 'develop',
                pushMode: 'normal',
                pullEnabled: false,
                modifyPodfile: true,
                repos: defaultRepos.join('\n'),
              }}
              disabled={running || prechecking}
            >
              <Form.Item
                label="目标分支"
                name="targetBranch"
                rules={[{ required: true, message: '请输入目标分支名' }]}
              >
                <Input placeholder="例如 feature/xxx" />
              </Form.Item>

              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item
                    label="基准分支"
                    name="baseBranch"
                    rules={[{ required: true, message: '请输入基准分支' }]}
                  >
                    <Input placeholder="默认 develop" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="推送模式" name="pushMode">
                    <Select
                      options={[
                        { value: 'normal', label: 'normal（普通 push）' },
                        { value: 'set-upstream', label: 'set-upstream（设置远端跟踪）' },
                        { value: 'skip', label: 'skip（只在本地创建）' },
                      ]}
                    />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="拉取最新 base" name="pullEnabled" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="修改 nnios Podfile" name="modifyPodfile" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
              </Row>

              <Divider style={{ margin: '8px 0 12px' }}>可选凭据</Divider>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="Git 用户名" name="username">
                    <Input placeholder="留空则使用系统凭据" autoComplete="off" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="Git 密码/Token" name="password">
                    <Input.Password placeholder="仅内存使用" autoComplete="new-password" />
                  </Form.Item>
                </Col>
              </Row>

              <Form.Item
                label={
                  <Space>
                    <span>仓库列表</span>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      每行一个，或用逗号分隔
                    </Text>
                  </Space>
                }
                name="repos"
                rules={[{ required: true, message: '请填写至少一个仓库地址' }]}
              >
                <TextArea rows={8} placeholder="http://git.example.com/group/repo.git" />
              </Form.Item>
            </Form>

            <Space>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={running || prechecking}
                onClick={handleRun}
              >
                {prechecking ? '预检中' : running ? '执行中' : '开始执行'}
              </Button>
              <Button danger icon={<StopOutlined />} disabled={!running} onClick={handleStop}>
                中止
              </Button>
              <Button
                icon={<ClearOutlined />}
                disabled={running || prechecking}
                onClick={handleClear}
              >
                清空日志
              </Button>
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={14}>
          <Card
            size="small"
            title={
              <Space>
                <span>仓库进度</span>
                {summary && (
                  <Tag color={summary.success ? 'green' : 'red'}>
                    {summary.success
                      ? '全部成功'
                      : `失败 ${summary.failures.length} 个：${summary.failures.join(', ')}`}
                  </Tag>
                )}
              </Space>
            }
            style={{ marginBottom: 12 }}
          >
            {statusList.length === 0 ? (
              <Empty description="尚未开始" />
            ) : (
              <Table
                size="small"
                rowKey="name"
                pagination={false}
                dataSource={statusList}
                columns={[
                  {
                    title: '',
                    dataIndex: 'status',
                    width: 48,
                    render: (s: RepoStatus['status']) => renderStatusIcon(s),
                  },
                  { title: '仓库', dataIndex: 'name' },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    width: 110,
                    render: (s: RepoStatus['status']) => {
                      const map: Record<RepoStatus['status'], { color: string; text: string }> = {
                        pending: { color: 'default', text: '等待中' },
                        running: { color: 'processing', text: '执行中' },
                        success: { color: 'success', text: '成功' },
                        failed: { color: 'error', text: '失败' },
                        skipped: { color: 'warning', text: '跳过' },
                      };
                      const m = map[s];
                      return <Tag color={m.color}>{m.text}</Tag>;
                    },
                  },
                  {
                    title: '说明',
                    dataIndex: 'message',
                    ellipsis: true,
                    render: (t?: string) => t || '—',
                  },
                ]}
              />
            )}
          </Card>

          <Card size="small" title="执行日志" bodyStyle={{ padding: 0 }}>
            <div
              ref={logBoxRef}
              style={{
                background: '#1f1f1f',
                color: '#e6e6e6',
                padding: 12,
                height: 360,
                overflow: 'auto',
                fontFamily:
                  'Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace',
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              {logs.length === 0 ? (
                <span style={{ color: '#8c8c8c' }}>等待执行...</span>
              ) : (
                logs.map((l, idx) => (
                  <div key={idx} style={{ whiteSpace: 'pre-wrap' }}>
                    <span style={{ color: '#595959' }}>[{l.time}]</span>{' '}
                    {l.repo && (
                      <span style={{ color: '#69c0ff' }}>[{l.repo}]</span>
                    )}{' '}
                    <span style={{ color: statusColor(l.level) }}>{l.message}</span>
                  </div>
                ))
              )}
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}

// ===================== 分支浏览面板 =====================

interface RepoBranchesLite {
  repo: string;
  url: string;
  ok: boolean;
  defaultBranch?: string;
  branches?: Array<{ name: string; sha: string; isDefault: boolean }>;
  error?: string;
}

function RemoteBranchesPanel() {
  const [repos, setRepos] = useState<string[]>([]);
  const [repoInput, setRepoInput] = useState<string>('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<RepoBranchesLite[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');

  // 依赖分析弹窗状态
  const [depsModal, setDepsModal] = useState<{
    open: boolean;
    loading: boolean;
    repoUrl?: string;
    repoName?: string;
    branch?: string;
    result?: GitRepoDependencyResult;
    nniosInfo?: { branch: string; missingFiles: string[]; sourceCount: number };
    error?: string;
  }>({ open: false, loading: false });

  useEffect(() => {
    gitApi.getDefaultRepos().then((res) => {
      if (res.success && res.data) {
        setRepos(res.data.repos);
        setRepoInput(res.data.repos.join('\n'));
      }
    });
  }, []);

  const loadBranches = async (repoUrls?: string[]) => {
    const list = repoUrls ?? repos;
    if (list.length === 0) {
      message.warning('仓库列表为空');
      return;
    }
    setLoading(true);
    try {
      const res = await gitApi.listBranches({
        repos: list,
        username: username || undefined,
        password: password || undefined,
      });
      if (!res.success || !res.data) {
        throw new Error(res.error || '获取失败');
      }
      setData(res.data as RepoBranchesLite[]);
      const firstOk = res.data.find((d) => d.ok);
      setSelectedRepo((prev) => {
        if (prev && res.data!.some((d) => d.repo === prev)) return prev;
        return firstOk?.repo || res.data![0]?.repo || null;
      });
    } catch (err: any) {
      message.error(err?.message || err?.error || '获取远端分支失败');
    } finally {
      setLoading(false);
    }
  };

  const parseRepos = (raw: string): string[] =>
    raw
      .split(/[\n,]/g)
      .map((l) => l.trim())
      .filter(Boolean);

  const handleApplyRepos = () => {
    const parsed = parseRepos(repoInput);
    if (parsed.length === 0) {
      message.warning('仓库列表不能为空');
      return;
    }
    setRepos(parsed);
    loadBranches(parsed);
  };

  const currentItem = useMemo(
    () => data.find((d) => d.repo === selectedRepo) || null,
    [data, selectedRepo]
  );

  const filteredBranches = useMemo(() => {
    if (!currentItem?.branches) return [];
    const kw = keyword.trim().toLowerCase();
    if (!kw) return currentItem.branches;
    return currentItem.branches.filter((b) => b.name.toLowerCase().includes(kw));
  }, [currentItem, keyword]);

  const copyText = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => message.success('已复制'))
      .catch(() => message.error('复制失败'));
  };

  const analyzeDeps = async (repoUrl: string, repoName: string, branch: string) => {
    setDepsModal({ open: true, loading: true, repoUrl, repoName, branch });
    try {
      const res = await gitApi.resolvePodDeps({
        repos: [repoUrl],
        branch,
        username: username || undefined,
        password: password || undefined,
      });
      if (!res.success || !res.data) {
        throw new Error(res.error || '分析失败');
      }
      const result = res.data.results[0];
      setDepsModal({
        open: true,
        loading: false,
        repoUrl,
        repoName,
        branch,
        result,
        nniosInfo: res.data.nnios,
        error: result?.ok === false ? result.error : undefined,
      });
    } catch (err: any) {
      setDepsModal({
        open: true,
        loading: false,
        repoUrl,
        repoName,
        branch,
        error: err?.message || err?.error || '分析失败',
      });
    }
  };

  const totalBranches = data.reduce((sum, d) => sum + (d.branches?.length || 0), 0);
  const failedCount = data.filter((d) => !d.ok).length;

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="通过 git ls-remote 查询远端分支，不会落盘到本地。"
      />

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col xs={24} md={10}>
          <Form layout="vertical" size="small">
            <Form.Item label="仓库列表（每行一个）" style={{ marginBottom: 8 }}>
              <TextArea
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                rows={4}
                placeholder="http://git.example.com/group/repo.git"
              />
            </Form.Item>
          </Form>
        </Col>
        <Col xs={24} md={14}>
          <Row gutter={8}>
            <Col span={12}>
              <Form.Item label="Git 用户名" style={{ marginBottom: 8 }}>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="可留空"
                  autoComplete="off"
                  size="small"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="密码 / Token" style={{ marginBottom: 8 }}>
                <Input.Password
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="可留空"
                  autoComplete="new-password"
                  size="small"
                />
              </Form.Item>
            </Col>
          </Row>
          <Space>
            <Button type="primary" icon={<ReloadOutlined />} loading={loading} onClick={handleApplyRepos}>
              加载分支
            </Button>
            {data.length > 0 && (
              <Text type="secondary">
                共 {data.length} 个仓库，{totalBranches} 个分支
                {failedCount > 0 && (
                  <Tag color="red" style={{ marginLeft: 8 }}>
                    {failedCount} 个失败
                  </Tag>
                )}
              </Text>
            )}
          </Space>
        </Col>
      </Row>

      <Row gutter={12}>
        <Col xs={24} md={8} lg={7}>
          <Card
            size="small"
            title="仓库"
            bodyStyle={{ padding: 0, maxHeight: 520, overflow: 'auto' }}
          >
            {loading && data.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center' }}>
                <Spin />
              </div>
            ) : data.length === 0 ? (
              <Empty description="点击「加载分支」开始" style={{ padding: 24 }} />
            ) : (
              <List
                size="small"
                dataSource={data}
                renderItem={(item) => {
                  const active = item.repo === selectedRepo;
                  return (
                    <List.Item
                      onClick={() => setSelectedRepo(item.repo)}
                      style={{
                        cursor: 'pointer',
                        background: active ? '#e6f4ff' : undefined,
                        padding: '8px 12px',
                      }}
                    >
                      <div style={{ width: '100%' }}>
                        <Space size={6} style={{ width: '100%', justifyContent: 'space-between' }}>
                          <Space size={6}>
                            {item.ok ? (
                              <CheckCircleTwoTone twoToneColor="#52c41a" />
                            ) : (
                              <ExclamationCircleTwoTone twoToneColor="#ff4d4f" />
                            )}
                            <Text strong>{item.repo}</Text>
                          </Space>
                          {item.ok ? (
                            <Tag>{item.branches?.length ?? 0}</Tag>
                          ) : (
                            <Tag color="red">失败</Tag>
                          )}
                        </Space>
                        <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2, wordBreak: 'break-all' }}>
                          {item.url}
                        </div>
                      </div>
                    </List.Item>
                  );
                }}
              />
            )}
          </Card>
        </Col>

        <Col xs={24} md={16} lg={17}>
          <Card
            size="small"
            title={
              currentItem ? (
                <Space>
                  <Text strong>{currentItem.repo}</Text>
                  {currentItem.defaultBranch && (
                    <Tag color="blue">默认：{currentItem.defaultBranch}</Tag>
                  )}
                </Space>
              ) : (
                '分支列表'
              )
            }
            extra={
              currentItem?.ok && (
                <Input
                  prefix={<SearchOutlined />}
                  placeholder="过滤分支"
                  allowClear
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  style={{ width: 220 }}
                  size="small"
                />
              )
            }
          >
            {!currentItem ? (
              <Empty description="请选择仓库" />
            ) : !currentItem.ok ? (
              <Alert
                type="error"
                showIcon
                message="无法获取远端分支"
                description={currentItem.error || '未知错误'}
              />
            ) : (
              <Table<{ name: string; sha: string; isDefault: boolean }>
                size="small"
                rowKey="name"
                dataSource={filteredBranches}
                pagination={{ pageSize: 20, showSizeChanger: true, hideOnSinglePage: true }}
                columns={[
                  {
                    title: '分支名',
                    dataIndex: 'name',
                    render: (name: string, record) => (
                      <Space>
                        <BranchesOutlined style={{ color: '#1677ff' }} />
                        <Text>{name}</Text>
                        {record.isDefault && <Tag color="blue">默认</Tag>}
                      </Space>
                    ),
                    sorter: (a, b) => a.name.localeCompare(b.name),
                  },
                  {
                    title: 'Commit',
                    dataIndex: 'sha',
                    width: 120,
                    render: (sha: string) => (
                      <Tooltip title={sha}>
                        <Text code copyable={{ text: sha, tooltips: ['复制完整 SHA', '已复制'] }}>
                          {sha.slice(0, 8)}
                        </Text>
                      </Tooltip>
                    ),
                  },
                  {
                    title: '操作',
                    width: 180,
                    align: 'right' as const,
                    render: (_: unknown, record) => (
                      <Space size={4}>
                        <Tooltip title="基于此分支分析 podspec 依赖">
                          <Button
                            type="text"
                            size="small"
                            icon={<ExperimentOutlined />}
                            onClick={() =>
                              analyzeDeps(currentItem.url, currentItem.repo, record.name)
                            }
                          />
                        </Tooltip>
                        <Tooltip title="复制分支名">
                          <Button
                            type="text"
                            size="small"
                            icon={<CopyOutlined />}
                            onClick={() => copyText(record.name)}
                          />
                        </Tooltip>
                        {currentItem.url && (
                          <Tooltip title="在远端打开（尝试跳转）">
                            <a
                              href={buildBranchWebUrl(currentItem.url, record.name)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Button type="text" size="small" icon={<LinkOutlined />} />
                            </a>
                          </Tooltip>
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>

      <PodDepsModal
        state={depsModal}
        onClose={() => setDepsModal({ open: false, loading: false })}
      />
    </div>
  );
}

// ========== 依赖分析弹窗 ==========

interface PodDepsModalState {
  open: boolean;
  loading: boolean;
  repoUrl?: string;
  repoName?: string;
  branch?: string;
  result?: GitRepoDependencyResult;
  nniosInfo?: { branch: string; missingFiles: string[]; sourceCount: number };
  error?: string;
}

function PodDepsModal({
  state,
  onClose,
}: {
  state: PodDepsModalState;
  onClose: () => void;
}) {
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    if (!state.open) setKeyword('');
  }, [state.open]);

  const filtered = useMemo(() => {
    const deps = state.result?.dependencies || [];
    const kw = keyword.trim().toLowerCase();
    if (!kw) return deps;
    return deps.filter(
      (d) =>
        d.name.toLowerCase().includes(kw) ||
        d.fromSpec.toLowerCase().includes(kw) ||
        d.match?.version?.toLowerCase().includes(kw) ||
        d.match?.branch?.toLowerCase().includes(kw) ||
        d.match?.tag?.toLowerCase().includes(kw)
    );
  }, [state.result, keyword]);

  const resolvedCount = state.result?.dependencies.filter((d) => d.resolved).length || 0;
  const totalCount = state.result?.dependencies.length || 0;

  return (
    <Modal
      title={
        <Space size={8}>
          <ExperimentOutlined />
          <span>依赖分析</span>
          {state.repoName && <Tag color="blue">{state.repoName}</Tag>}
          {state.branch && <Tag>{state.branch}</Tag>}
        </Space>
      }
      open={state.open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      width={900}
      destroyOnClose
    >
      {state.loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin tip="正在克隆 nnios 与目标仓库并解析依赖..." />
        </div>
      ) : state.error ? (
        <Alert type="error" showIcon message="分析失败" description={state.error} />
      ) : !state.result ? (
        <Empty />
      ) : (
        <div>
          <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }} size={8}>
            <Space wrap>
              <Tag color={resolvedCount === totalCount ? 'success' : 'warning'}>
                已解析 {resolvedCount} / {totalCount}
              </Tag>
              <Text type="secondary">
                版本来源：nnios 仓库 <Tag>{state.nniosInfo?.branch}</Tag> 分支的 Podfile 与
                third_sdk.rb
              </Text>
            </Space>
            {state.nniosInfo?.missingFiles && state.nniosInfo.missingFiles.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`nnios 仓库未找到：${state.nniosInfo.missingFiles.join(', ')}`}
              />
            )}
            {state.result.specFiles.length > 0 && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                扫描的 podspec：{state.result.specFiles.join('  ·  ')}
              </Text>
            )}
            <Input
              prefix={<SearchOutlined />}
              allowClear
              placeholder="过滤依赖 / spec / 版本"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </Space>

          <Table
            size="small"
            rowKey={(r) => `${r.name}__${r.fromSpec}__${r.specRequirement || ''}`}
            dataSource={filtered}
            pagination={{ pageSize: 20, showSizeChanger: true, hideOnSinglePage: true }}
            columns={[
              {
                title: '依赖',
                dataIndex: 'name',
                render: (name: string, record) => (
                  <Space size={6}>
                    <Text strong>{name}</Text>
                    {record.specRequirement && (
                      <Tag color="geekblue">{record.specRequirement}</Tag>
                    )}
                    {!record.resolved && <Tag color="red">未命中</Tag>}
                  </Space>
                ),
              },
              {
                title: '版本 / 引用',
                render: (_: unknown, record) => {
                  if (!record.match) return <Text type="secondary">—</Text>;
                  const m = record.match;
                  return (
                    <Space size={4} wrap>
                      {m.version && <Tag color="green">{m.version}</Tag>}
                      {m.tag && <Tag color="gold">tag: {m.tag}</Tag>}
                      {m.branch && <Tag color="blue">branch: {m.branch}</Tag>}
                      {m.commit && (
                        <Tag color="purple">commit: {m.commit.slice(0, 8)}</Tag>
                      )}
                      {m.pathRef && <Tag>path: {m.pathRef}</Tag>}
                      {!m.version && !m.tag && !m.branch && !m.commit && !m.pathRef && (
                        <Text type="secondary">无明确版本</Text>
                      )}
                    </Space>
                  );
                },
              },
              {
                title: '来源',
                width: 120,
                render: (_: unknown, record) => {
                  if (!record.match) return <Text type="secondary">—</Text>;
                  return <Tag>{record.match.sourceFile}</Tag>;
                },
              },
              {
                title: '.podspec',
                dataIndex: 'fromSpec',
                ellipsis: true,
                render: (t: string) => (
                  <Tooltip title={t}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t}
                    </Text>
                  </Tooltip>
                ),
              },
            ]}
            expandable={{
              rowExpandable: (record) => !!record.match?.raw,
              expandedRowRender: (record) => (
                <div>
                  <Paragraph style={{ marginBottom: 8 }}>
                    <Text strong>nnios 中的原始声明：</Text>
                  </Paragraph>
                  <pre
                    style={{
                      margin: 0,
                      padding: 8,
                      background: '#141414',
                      color: '#e6e6e6',
                      borderRadius: 4,
                      fontSize: 12,
                      overflow: 'auto',
                    }}
                  >
                    {record.allMatches.map((m) => `[${m.sourceFile}]  ${m.raw}`).join('\n')}
                  </pre>
                </div>
              ),
            }}
          />
        </div>
      )}
    </Modal>
  );
}

/** 尝试根据 .git URL 构造 Web 端分支链接（对 GitLab/GitHub/Gitea 常见风格适配） */
function buildBranchWebUrl(repoUrl: string, branch: string): string {
  try {
    const cleaned = repoUrl.replace(/\.git$/i, '');
    // 去除可能的凭据
    const stripped = cleaned.replace(/\/\/[^/@]+@/, '//');
    // GitLab: /-/tree/<branch>；GitHub: /tree/<branch>。这里用 GitLab 风格，尝试失败时也能打开
    return `${stripped}/-/tree/${encodeURIComponent(branch)}`;
  } catch {
    return repoUrl;
  }
}

export default function GitPage() {
  const [credModalOpen, setCredModalOpen] = useState(false);
  const [credLoading, setCredLoading] = useState(false);
  const [credStatus, setCredStatus] = useState<{ username: string; hasPassword: boolean } | null>(
    null
  );
  const [credForm] = Form.useForm();

  useEffect(() => {
    loadCredStatus();
  }, []);

  const loadCredStatus = async () => {
    try {
      const res = await gitApi.getCredentials();
      if (res.success && res.data) setCredStatus(res.data);
    } catch {
      // ignore
    }
  };

  const handleSaveCreds = async () => {
    try {
      const values = await credForm.validateFields();
      setCredLoading(true);
      const res = await gitApi.setCredentials(values.username.trim(), values.password);
      if (res.success) {
        message.success('凭据已保存');
        setCredModalOpen(false);
        loadCredStatus();
      } else {
        message.error(res.error || '保存失败');
      }
    } catch {
      // form validation
    } finally {
      setCredLoading(false);
    }
  };

  const handleClearCreds = async () => {
    setCredLoading(true);
    try {
      const res = await gitApi.clearCredentials();
      if (res.success) {
        message.success('凭据已清除');
        credForm.resetFields();
        loadCredStatus();
      }
    } catch {
      message.error('清除失败');
    } finally {
      setCredLoading(false);
    }
  };

  const tabItems = [
    {
      key: 'batch-branch',
      label: (
        <span>
          <BranchesOutlined /> 批量建分支
        </span>
      ),
      children: <BatchCreateBranchPanel />,
    },
    {
      key: 'branches',
      label: (
        <span>
          <BranchesOutlined /> 分支
        </span>
      ),
      children: <RemoteBranchesPanel />,
    },
    {
      key: 'merge-requests',
      label: (
        <span>
          <PullRequestOutlined /> 合并请求
        </span>
      ),
      children: (
        <Empty description="暂无合并请求">
          <Table columns={mrColumns} dataSource={[]} style={{ display: 'none' }} />
        </Empty>
      ),
    },
    {
      key: 'tags',
      label: (
        <span>
          <TagOutlined /> 标签
        </span>
      ),
      children: <Empty description="暂无标签" />,
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <Title level={4}>
            <BranchesOutlined style={{ marginRight: 8, color: '#fa541c' }} />
            Git 管理
          </Title>
          <Paragraph type="secondary">
            批量操作多仓库分支，也可查看分支、合并请求和标签
          </Paragraph>
        </div>
        <Space>
          {credStatus && (
            <Tag
              color={credStatus.hasPassword ? 'green' : 'default'}
              icon={<KeyOutlined />}
            >
              {credStatus.hasPassword
                ? `凭据: ${credStatus.username}`
                : '未配置凭据'}
            </Tag>
          )}
          <Button
            icon={<SettingOutlined />}
            onClick={() => {
              if (credStatus?.username) {
                credForm.setFieldsValue({ username: credStatus.username, password: '' });
              }
              setCredModalOpen(true);
            }}
          >
            凭据设置
          </Button>
        </Space>
      </div>

      <Card>
        <Tabs items={tabItems} />
      </Card>

      <Modal
        title={
          <Space>
            <KeyOutlined />
            <span>Git 仓库访问凭据</span>
          </Space>
        }
        open={credModalOpen}
        onCancel={() => setCredModalOpen(false)}
        footer={
          <Space>
            <Button danger onClick={handleClearCreds} loading={credLoading}>
              清除凭据
            </Button>
            <Button onClick={() => setCredModalOpen(false)}>取消</Button>
            <Button type="primary" onClick={handleSaveCreds} loading={credLoading}>
              保存
            </Button>
          </Space>
        }
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="设置后所有 Git 操作（分支浏览、批量建分支、依赖分析）将自动使用此凭据，无需每次手动填写。"
          description="凭据保存在服务端 .env 文件中，仅管理员可修改。各操作中手动填写的凭据优先级更高。"
        />
        <Form form={credForm} layout="vertical">
          <Form.Item
            label="Git 用户名"
            name="username"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input placeholder="例如 rentao" autoComplete="off" />
          </Form.Item>
          <Form.Item
            label="Git 密码 / Token"
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password placeholder="密码或 Personal Access Token" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
