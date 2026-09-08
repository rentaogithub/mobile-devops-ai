import { hasApplicationServices } from '../../../backend/src/services/ApplicationServiceCatalog';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Input, Modal, Select, Space, Table, Tag, Typography, message } from 'antd';
import { androidApi, type AndroidRun } from '../services/api';
import { authUtils } from '../utils/auth';
const states: Record<string, string> = { queued: '排队中', running: '运行中', passed: '证据通过', failed: '失败', canceled: '已取消', invalid_evidence: '证据不匹配', dispatch_unknown: '提交待确认', timed_out: '追踪超时', cancel_requested: '取消待确认' };
export default function AndroidPage() {
  const [runs, setRuns] = useState<AndroidRun[]>([]);
  const [readiness, setReadiness] = useState<Awaited<ReturnType<typeof androidApi.readiness>>>();
  const [issues, setIssues] = useState<Awaited<ReturnType<typeof androidApi.issues>>>([]);
  const [verification, setVerification] = useState<Record<string, string>>({});
  const [commit, setCommit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const app = authUtils.getActiveApplication();
  const qualityEnabled = hasApplicationServices(app, ['quality', 'devices']);
  const canRun = authUtils.hasRole('tester');
  // Preserve a pending request across page reloads when the HTTP response is lost.
  const requestKeys = useRef<Record<string, string>>(JSON.parse(sessionStorage.getItem(`android-requests:${app?.id}`) || '{}'));
  const reload = async () => { const [status, tasks, findings] = await Promise.all([androidApi.readiness(), androidApi.list(), qualityEnabled ? androidApi.issues() : Promise.resolve([])]); setReadiness(status); setRuns(tasks); setIssues(findings); };
  useEffect(() => { void reload().catch((e) => setError(e.error || e.response?.data?.error || e.message)); }, [app?.id]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); await reload(); } catch (e: any) { setError(e.error || e.response?.data?.error || e.message || '操作失败'); }
    finally { setBusy(false); }
  };
  const trigger = async (kind: 'build' | 'smoke', sourceRunId?: string) => {
    const key = `${kind}:${sourceRunId || commit.toLowerCase()}`;
    const requestKey = requestKeys.current[key] ||= (globalThis.crypto.randomUUID?.() || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
    sessionStorage.setItem(`android-requests:${app?.id}`, JSON.stringify(requestKeys.current));
    const run = await androidApi.trigger({ kind, requestKey, configurationRevision: readiness?.configurationRevision, ...(kind === 'build' ? { commit: commit.toLowerCase() } : { sourceRunId }) });
    delete requestKeys.current[key]; sessionStorage.setItem(`android-requests:${app?.id}`, JSON.stringify(requestKeys.current));
    message.info(`任务已记录：${states[run.status] || run.status}`);
  };
  if (app?.platform !== 'android') return <Alert type="info" message="请在顶部选择 Android 应用，或由管理员从“应用接入”添加应用。" />;
  return <Space direction="vertical" size={18} style={{ width: '100%' }}>
    <div><Typography.Title level={3}>Android 交付 · {app.name}</Typography.Title><Typography.Text type="secondary">{app.packageId} · {qualityEnabled ? 'Commit → APK → 安装核验 → 启动 Smoke → 内部下载' : 'Commit → APK'}</Typography.Text></div>
    <Alert showIcon type={readiness?.configured ? 'info' : 'warning'} message={readiness?.configured ? '执行配置已齐全，真实链路仍需验收' : '接入配置尚未齐全'} description={readiness?.missing.length ? `待补齐：${readiness.missing.join('、')}` : qualityEnabled ? '首期门禁仅覆盖安装启动 Smoke；商店发布、AAB、符号还原及性能测试待接入。' : '当前选配 APK 构建；安装启动 Smoke 和通过门禁后的内部下载尚未启用，可在“应用接入”中选配质量服务。'} />
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    <Card title="固定 Commit 构建 APK" extra={<Button loading={busy} onClick={() => void act(reload)}>刷新列表</Button>}>
      <Space.Compact style={{ width: '100%', maxWidth: 780 }}><Input aria-label="Git Commit" value={commit} onChange={(e) => setCommit(e.target.value.trim())} placeholder="完整的 40 位 Git Commit" /><Button type="primary" loading={busy} disabled={!canRun || !/^[a-fA-F0-9]{40}$/.test(commit)} onClick={() => void act(() => trigger('build'))}>构建 APK</Button></Space.Compact>
    </Card>
    <Table rowKey="id" dataSource={runs} scroll={{ x: 1000 }} columns={[
      { title: '任务', render: (_, run) => <Space direction="vertical" size={0}><Typography.Text>{run.kind === 'build' ? 'APK 构建' : '安装启动 Smoke'}</Typography.Text><Typography.Text copyable type="secondary">{run.id}</Typography.Text></Space> },
      { title: 'Jenkins', render: (_, run) => `${run.jobName}${run.buildNumber ? ` #${run.buildNumber}` : ''}` },
      { title: 'Commit', render: (_, run) => <Typography.Text copyable={{ text: run.config.commit }}>{run.config.commit.slice(0, 12)}</Typography.Text> },
      { title: '状态', render: (_, run) => <Tag color={run.status === 'passed' ? 'green' : ['failed', 'invalid_evidence'].includes(run.status) ? 'red' : 'gold'}>{states[run.status] || run.status}</Tag> },
      { title: '操作', render: (_, run) => <Space wrap>
        <Button disabled={!canRun || busy || (run.kind === 'smoke' && !qualityEnabled)} onClick={() => void act(() => androidApi.sync(run.id))}>同步状态</Button>
        <Button onClick={() => Modal.info({ okText: '知道了', title: '任务证据', width: 760, content: <pre style={{ maxHeight: 480, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(run, null, 2)}</pre> })}>证据</Button>
        {qualityEnabled && run.kind === 'build' && run.status === 'passed' && <>
          <Button disabled={!canRun || busy} onClick={() => Modal.confirm({ okText: '开始安装', cancelText: '取消', title: '在配置的 Android 测试设备安装此 APK 并执行启动 Smoke？', content: `测试设备：${app.config.deviceSerial || '尚未配置'}。将更新设备上的同包名应用。任务固定关联此 APK 的校验值和版本。`, onOk: () => act(() => trigger('smoke', run.id)) })}>安装 Smoke</Button>
          <Button disabled={!canRun || busy} onClick={() => void act(async () => {
            const gate = await androidApi.gate(run.id); if (!gate.passed) throw new Error(gate.reason);
            const blob = await androidApi.download(run.id); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${app.packageId}-${run.id}.apk`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
          })}>校验并下载</Button>
        </>}
        {!['passed', 'failed', 'canceled', 'invalid_evidence'].includes(run.status) && <Button disabled={!canRun || busy} onClick={() => void act(() => androidApi.cancel(run.id))}>请求取消</Button>}
      </Space> },
    ]} />
    {qualityEnabled && <Card title="Crash / ANR 原始证据">
      <Table rowKey="id" dataSource={issues} columns={[
        { title: '问题', dataIndex: 'title' }, { title: '状态', dataIndex: 'status' },
        { title: '证据与复核', render: (_, issue) => <Space wrap>
          <Button onClick={() => Modal.info({ okText: '知道了', title: issue.title, width: 760, content: <pre style={{ maxHeight: 480, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(issue.evidence, null, 2)}</pre> })}>原始日志</Button>
          {issue.status !== 'resolved' && <><Select style={{ width: 240 }} placeholder="选择后续同源通过 Smoke" value={verification[issue.id]}
            options={runs.filter((run) => run.kind === 'smoke' && run.status === 'passed' && run.config.sourceRunId === issue.buildNumber).map((run) => ({ value: run.id, label: `${run.jobName} #${run.buildNumber}` }))}
            onChange={(value) => setVerification((current) => ({ ...current, [issue.id]: value }))} />
            <Button disabled={!canRun || busy || !verification[issue.id]} onClick={() => void act(() => androidApi.resolveIssue(issue.id, verification[issue.id]))}>复核关闭</Button></>}
        </Space> },
      ]} locale={{ emptyText: '尚无已核验的启动 Smoke Crash/ANR 问题；完整符号还原仍待接入。' }} />
    </Card>}
  </Space>;
}
