import { currentProjectId } from './ProductLineContext';
import { latestWorkflowTasks, qualityGateService } from './QualityGateService';
import { workflowService } from './WorkflowService';
import { requiredReleaseGateSuites } from './ReleaseGatePolicy';

type StageStatus = 'passed' | 'blocked' | 'warning' | 'unknown';
interface DeliveryStage {
  key: string;
  title: string;
  status: StageStatus;
  summary: string;
  evidenceIds: string[];
}
interface DeliveryAction {
  code: string;
  priority: 'P0' | 'P1' | 'P2';
  title: string;
  reason: string;
  target: 'cicd' | 'issues' | 'regression' | 'evolution' | 'gate';
  evidenceIds: string[];
}

export class DeliveryReadinessService {
  diagnose(value: unknown) {
    const buildNumber = String(value ?? '').trim();
    if (!/^[1-9]\d{0,11}$/.test(buildNumber)) throw new Error('构建号必须为 1 至 12 位正整数');
    const projectId = currentProjectId();
    const evidence = workflowService.getDeliveryEvidence(buildNumber);
    const { artifacts, tasks, issues, candidates } = evidence;
    const build = latestWorkflowTasks(tasks.filter((task) => task.taskType === 'ios_build' && task.source === 'jenkins'))[0];
    const artifact = artifacts.find((item) => item.id === build?.artifactId);
    const commitHash = build?.commitHash || artifact?.commitHash || null;
    const branch = build?.branch || artifact?.branch || null;
    const releaseVersion = artifact?.version || null;
    const qualityTasks = tasks.filter((task) => task.taskType !== 'ios_build');
    const gate = qualityGateService.preview({
      buildNumber, buildStatus: build?.status || 'unknown', commitHash, branch,
      appVersion: releaseVersion, tasks: qualityTasks, issues,
      policy: { requiredSuites: requiredReleaseGateSuites() },
    });
    const openIssues = issues.filter((issue) => !['resolved', 'ignored'].includes(issue.status.toLowerCase()));
    const unresolvedRegressions = issues.filter((issue) => issue.status !== 'ignored' && !candidates.some((candidate) => candidate.issueId === issue.id && candidate.status === 'verified'));
    const health = releaseVersion ? qualityGateService.evaluateReleaseHealth(projectId, releaseVersion) : null;
    const stages: DeliveryStage[] = [];
    const actions: DeliveryAction[] = [];
    const addAction = (action: DeliveryAction) => actions.push(action);
    const lineageComplete = Boolean(build && artifact && commitHash && branch);

    stages.push({ key: 'lineage', title: '变更与产物', status: lineageComplete ? 'passed' : 'unknown', summary: lineageComplete ? `分支 ${branch} · Commit ${commitHash}` : '缺少源构建、关联产物、分支或 Commit，无法完整追溯本次交付', evidenceIds: [build?.id, artifact?.id].filter(Boolean) });
    if (!lineageComplete) addAction({ code: 'lineage_missing', priority: 'P0', title: '补齐构建血缘', reason: '同步 Jenkins 源构建及其分支、Commit、产物关联后重新诊断。', target: 'cicd', evidenceIds: [] });

    const buildPassed = ['passed', 'success', 'stable'].includes(String(build?.status));
    stages.push({ key: 'build', title: '构建', status: !build ? 'unknown' : buildPassed ? 'passed' : 'blocked', summary: build ? `源构建状态：${build.status}` : '尚无源构建记录', evidenceIds: build ? [build.id] : [] });
    if (build && !buildPassed) addAction({ code: 'build_not_passed', priority: 'P0', title: '确认源构建结果', reason: `构建当前为 ${build.status}，请检查控制台日志与失败阶段。`, target: 'cicd', evidenceIds: [build.id] });

    const qualityBlockers = gate.result.blockers.filter((item: any) => !['build_failed', 'build_status_missing', 'open_issue'].includes(item.code));
    stages.push({ key: 'quality', title: '质量验证', status: qualityBlockers.length ? 'blocked' : 'passed', summary: `必需套件：${gate.policy.requiredSuites.join('、')}；${qualityBlockers.length} 项验证阻断`, evidenceIds: qualityTasks.map((task) => task.id) });
    qualityBlockers.forEach((item: any) => addAction({ code: `${item.code}:${item.suite || item.taskId || ''}`, priority: 'P0', title: item.message, reason: '对照当前源构建执行或复核质检，完成后重新诊断。', target: 'cicd', evidenceIds: item.taskId ? [item.taskId] : [] }));

    const blockingIssues = openIssues.filter((issue) => gate.policy.blockSeverities.includes(issue.severity));
    stages.push({ key: 'issues', title: '问题处理', status: blockingIssues.length ? 'blocked' : openIssues.length ? 'warning' : 'passed', summary: `${openIssues.length} 个开放问题，${blockingIssues.length} 个阻断级问题`, evidenceIds: openIssues.map((issue) => issue.id) });
    if (openIssues.length) addAction({ code: 'open_issues', priority: blockingIssues.length ? 'P0' : 'P1', title: '处理关联问题', reason: '检查问题证据、负责人和修复建议；关闭状态本身不代表回归验证通过。', target: 'issues', evidenceIds: openIssues.map((issue) => issue.id) });

    const regressionIssues = issues.filter((issue) => issue.status !== 'ignored');
    stages.push({ key: 'regression', title: '回归闭环', status: regressionIssues.length ? 'warning' : 'passed', summary: regressionIssues.length ? `${unresolvedRegressions.length} 个问题尚无已验证回归候选；已有验证仍需核对是否覆盖本次构建` : '当前构建暂无关联问题需要回归', evidenceIds: candidates.map((candidate) => candidate.id) });
    if (unresolvedRegressions.length) addAction({ code: 'regression_missing', priority: 'P1', title: '补齐确定性回归', reason: '从 Issue 生成候选并验证；生成代码和独立编译均不等于执行通过。已验证候选也需核对是否覆盖本次构建。', target: 'regression', evidenceIds: unresolvedRegressions.map((issue) => issue.id) });
    else if (regressionIssues.length) addAction({ code: 'regression_build_unverified', priority: 'P1', title: '核对回归执行构建', reason: '候选已验证，但现有记录尚未证明验证覆盖本次构建。', target: 'regression', evidenceIds: candidates.map((candidate) => candidate.id) });

    stages.push({ key: 'observation', title: '发布观察', status: !health || health.status === 'unknown' ? 'unknown' : health.status === 'critical' ? 'blocked' : health.status === 'warning' ? 'warning' : 'passed', summary: health ? `版本 ${releaseVersion} · ${health.observationCount} 条观察 · ${health.status}` : '源构建缺少版本信息，尚无法关联发布观察', evidenceIds: [] });
    if (!health || health.status !== 'healthy') addAction({ code: 'release_observation', priority: health?.status === 'critical' ? 'P0' : 'P2', title: '核实版本发布观察', reason: health?.recommendations[0] || '补齐版本并采集发布后的 Crash、启动及核心链路指标。', target: 'evolution', evidenceIds: [] });
    gate.result.warnings.forEach((item: any, index: number) => addAction({ code: `gate_warning:${index}`, priority: 'P1', title: item.message, reason: '核实门禁风险后再进入正式发布审批。', target: 'gate', evidenceIds: item.issueId ? [item.issueId] : [] }));
    if (evidence.truncated) addAction({ code: 'evidence_truncated', priority: 'P0', title: '证据超过诊断上限', reason: '单类证据超过 500 条，本次结果不完整，需专项复核。', target: 'gate', evidenceIds: [] });

    const status: StageStatus = stages.some((stage) => stage.status === 'blocked') || gate.status === 'blocked'
      ? 'blocked' : evidence.truncated || !lineageComplete ? 'unknown'
        : stages.some((stage) => stage.status !== 'passed') || gate.status === 'warning' ? 'warning' : 'passed';
    return {
      kind: 'delivery_readiness', projectId, buildNumber, status,
      summary: status === 'blocked' ? '交付存在阻断项，请先处理下列证据与问题' : status === 'unknown' ? '交付证据不完整，暂不能确认就绪' : status === 'warning' ? '门禁预览未阻断，仍有闭环或观察项待核实' : '当前同步证据检查通过，正式发布仍需实时复核',
      source: 'workflow_snapshot', evaluatedAt: new Date().toISOString(),
      limitations: ['依据当前产品线已同步快照，不能替代 Jenkins 发布前实时复核。', '发布观察按版本聚合；回归候选的 verified 状态尚未绑定本次构建，需核对执行证据。', ...(evidence.truncated ? ['单类证据最多返回 500 条，结果已截断。'] : [])],
      context: { commitHash, branch, releaseVersion, updatedAt: build?.updatedAt || null },
      stages, actions: actions.sort((a, b) => a.priority.localeCompare(b.priority)),
      counts: { artifacts: artifacts.length, tasks: tasks.length, issues: issues.length, openIssues: openIssues.length, candidates: candidates.length },
      gate, releaseHealth: health,
      evidence: {
        artifacts: artifacts.map(({ id, artifactType, name, updatedAt }) => ({ id, artifactType, name, updatedAt })),
        tasks: tasks.map(({ id, suite, status, commitHash, branch, updatedAt }) => ({ id, suite, status, commitHash, branch, updatedAt })),
        issues: issues.map(({ id, title, severity, status, ownerHint }) => ({ id, title, severity, status, ownerHint })),
        candidates,
      },
    };
  }
}

export const deliveryReadinessService = new DeliveryReadinessService();
