import { createHash } from 'crypto';
import { workflowService } from './WorkflowService';
import { crashGovernanceService } from './CrashGovernanceService';

interface GatePolicy {
  requireSuccessfulBuild: boolean;
  requiredSuites: string[];
  blockSeverities: string[];
  maxCrashCount: number;
  maxFailedTests: number;
  warnMetricRegressionPercent: number;
  blockMetricRegressionPercent: number;
  maxSuiteAgeHours: number;
  checkCrashGovernance: boolean;
  blockCrashGovernanceRisk: boolean;
}

const DEFAULT_POLICY: GatePolicy = {
  requireSuccessfulBuild: true,
  requiredSuites: ['smoke'],
  blockSeverities: ['blocker', 'critical'],
  maxCrashCount: 0,
  maxFailedTests: 0,
  warnMetricRegressionPercent: 10,
  blockMetricRegressionPercent: 25,
  maxSuiteAgeHours: Number(process.env.RELEASE_GATE_MAX_SUITE_AGE_HOURS || 72),
  checkCrashGovernance: true,
  blockCrashGovernanceRisk: false,
};

function normalizeTaskStatus(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

export class QualityGateService {
  preview(input: Record<string, any>) {
    return this.evaluateInternal(input, false);
  }

  evaluate(input: Record<string, any>) {
    return this.evaluateInternal(input, true);
  }

  private evaluateInternal(input: Record<string, any>, persist: boolean) {
    const policy: GatePolicy = {
      ...DEFAULT_POLICY,
      ...(input.policy || {}),
      requiredSuites: Array.isArray(input.policy?.requiredSuites)
        ? input.policy.requiredSuites.map(String)
        : DEFAULT_POLICY.requiredSuites,
      blockSeverities: Array.isArray(input.policy?.blockSeverities)
        ? input.policy.blockSeverities.map((item: unknown) => String(item).toLowerCase())
        : DEFAULT_POLICY.blockSeverities,
    };
    const buildNumber = String(input.buildNumber || '').trim();
    if (!buildNumber) throw new Error('buildNumber 不能为空');
    const releaseVersion = String(input.appVersion || input.releaseVersion || '').trim();

    const tasks = Array.isArray(input.tasks)
      ? input.tasks
      : workflowService.listTasks({ buildNumber, limit: 200 });
    const issues = Array.isArray(input.issues)
      ? input.issues
      : workflowService.listIssues({ buildNumber, limit: 500 });
    const metrics = Array.isArray(input.metrics) ? input.metrics : [];
    const blockers: any[] = [];
    const warnings: any[] = [];
    const passed: any[] = [];
    const evaluatedTasks: any[] = [];

    const buildStatus = normalizeTaskStatus(input.buildStatus || 'success');
    if (policy.requireSuccessfulBuild && !['success', 'passed', 'stable'].includes(buildStatus)) {
      blockers.push({ code: 'build_failed', message: `构建状态为 ${buildStatus || 'unknown'}` });
    } else {
      passed.push({ code: 'build_success', message: '构建状态通过' });
    }

    policy.requiredSuites.forEach((suite) => {
      const suiteTasks = tasks.filter((task: any) => String(task.suite || task.config?.suite || '').toLowerCase() === suite.toLowerCase());
      if (suiteTasks.length === 0) {
        blockers.push({ code: 'required_suite_missing', suite, message: `缺少必需测试套件 ${suite}` });
        return;
      }
      const latest = [...suiteTasks].sort((a: any, b: any) => String(b.updatedAt || b.updated_at || '').localeCompare(String(a.updatedAt || a.updated_at || '')))[0];
      evaluatedTasks.push(latest);
      const status = normalizeTaskStatus(latest.status);
      const taskUpdatedAt = Date.parse(String(latest.finishedAt || latest.updatedAt || latest.updated_at || ''));
      const taskAgeHours = Number.isFinite(taskUpdatedAt) ? (Date.now() - taskUpdatedAt) / (60 * 60 * 1000) : null;
      if (input.commitHash && latest.commitHash && String(latest.commitHash) !== String(input.commitHash)) {
        blockers.push({ code: 'suite_commit_mismatch', suite, taskId: latest.id, expected: input.commitHash, actual: latest.commitHash, message: `${suite} 套件 Commit 与源构建不一致` });
        return;
      }
      if (input.branch && latest.branch && String(latest.branch).replace(/^origin\//, '') !== String(input.branch).replace(/^origin\//, '')) {
        blockers.push({ code: 'suite_branch_mismatch', suite, taskId: latest.id, expected: input.branch, actual: latest.branch, message: `${suite} 套件分支与源构建不一致` });
        return;
      }
      if (taskAgeHours !== null && policy.maxSuiteAgeHours > 0 && taskAgeHours > policy.maxSuiteAgeHours) {
        blockers.push({ code: 'suite_expired', suite, taskId: latest.id, ageHours: Number(taskAgeHours.toFixed(1)), thresholdHours: policy.maxSuiteAgeHours, message: `${suite} 套件结果已超过 ${policy.maxSuiteAgeHours} 小时` });
        return;
      }
      if ((['passed', 'success'].includes(status) || (status === 'completed' && latest.result?.passed === true)) && latest.result?.passed !== false) {
        passed.push({ code: 'suite_passed', suite, taskId: latest.id, message: `${suite} 套件通过` });
      } else if (['failed', 'failure', 'canceled', 'aborted'].includes(status) || latest.result?.passed === false) {
        blockers.push({ code: 'suite_failed', suite, taskId: latest.id, message: `${suite} 套件未通过` });
      } else {
        blockers.push({ code: 'suite_incomplete', suite, taskId: latest.id, message: `${suite} 套件尚未完成` });
      }
    });

    const openIssues = issues.filter((issue: any) => !['resolved', 'ignored'].includes(String(issue.status || '').toLowerCase()));
    openIssues.forEach((issue: any) => {
      const severity = String(issue.severity || 'medium').toLowerCase();
      const item = { code: 'open_issue', issueId: issue.id, severity, message: issue.title || issue.summary || '未命名问题' };
      if (policy.blockSeverities.includes(severity)) blockers.push(item);
      else if (['high', 'medium'].includes(severity)) warnings.push(item);
    });

    const thresholdTasks = evaluatedTasks.length > 0 ? evaluatedTasks : tasks;
    const crashCount = thresholdTasks.reduce((sum: number, task: any) => sum + Number(task.result?.crash_count || task.result?.crashCount || 0), 0);
    if (crashCount > policy.maxCrashCount) {
      blockers.push({ code: 'crash_threshold', value: crashCount, threshold: policy.maxCrashCount, message: `Crash 数 ${crashCount} 超过门限 ${policy.maxCrashCount}` });
    } else {
      passed.push({ code: 'crash_threshold', value: crashCount, message: 'Crash 门限通过' });
    }

    const failedTests = thresholdTasks.reduce((sum: number, task: any) => sum + Number(task.result?.failed_tests || task.result?.failedTests || 0), 0);
    if (failedTests > policy.maxFailedTests) {
      blockers.push({ code: 'failed_test_threshold', value: failedTests, threshold: policy.maxFailedTests, message: `失败用例数 ${failedTests} 超过门限 ${policy.maxFailedTests}` });
    }

    metrics.forEach((metric: any) => {
      const name = String(metric.metric || metric.name || '').trim();
      const value = Number(metric.value);
      if (!name || !Number.isFinite(value)) return;
      const scope = String(metric.scope || 'app');
      const baseline = workflowService.getBaseline(name, scope, String(input.branch || '*'));
      if (!baseline || !baseline.value) {
        warnings.push({ code: 'baseline_missing', metric: name, message: `${name} 暂无质量基线` });
        return;
      }
      const direction = metric.direction === 'higher_is_better' ? 'higher_is_better' : 'lower_is_better';
      const deltaPercent = direction === 'higher_is_better'
        ? ((baseline.value - value) / Math.abs(baseline.value)) * 100
        : ((value - baseline.value) / Math.abs(baseline.value)) * 100;
      const comparison = { code: 'metric_regression', metric: name, value, baseline: baseline.value, deltaPercent: Number(deltaPercent.toFixed(2)) };
      if (deltaPercent >= policy.blockMetricRegressionPercent) {
        blockers.push({ ...comparison, message: `${name} 相比基线回退 ${deltaPercent.toFixed(1)}%` });
      } else if (deltaPercent >= policy.warnMetricRegressionPercent) {
        warnings.push({ ...comparison, message: `${name} 相比基线回退 ${deltaPercent.toFixed(1)}%` });
      } else {
        passed.push({ ...comparison, message: `${name} 基线对比通过` });
      }
    });

    if (policy.checkCrashGovernance && releaseVersion) {
      const crashRisks = crashGovernanceService.listOpenRisksByVersion(releaseVersion, 50);
      const regressions = crashRisks.filter((record) => record.governanceStatus === 'regression');
      const highRisks = crashRisks.filter((record) =>
        ['fatal', 'critical', 'error'].includes(String(record.level || '').toLowerCase()) ||
        record.eventCount >= 20 ||
        record.userCount >= 5
      );
      const dsymMissing = crashRisks.filter((record) => record.dsymCoverageStatus === 'missing');
      const crashRiskItems = [
        ...regressions.map((record) => ({
          code: 'crash_regression',
          issueId: record.sourceIssueId,
          message: `版本 ${releaseVersion} 存在疑似回归 Crash：${record.shortId || record.sourceIssueId} ${record.title}`,
        })),
        ...highRisks.map((record) => ({
          code: 'open_high_crash',
          issueId: record.sourceIssueId,
          message: `版本 ${releaseVersion} 存在未解决高风险 Crash：${record.shortId || record.sourceIssueId}，事件 ${record.eventCount}，用户 ${record.userCount}`,
        })),
        ...dsymMissing.map((record) => ({
          code: 'crash_dsym_missing',
          issueId: record.sourceIssueId,
          message: `版本 ${releaseVersion} 的 Crash ${record.shortId || record.sourceIssueId} 缺少可用 dSYM`,
        })),
      ];

      if (crashRiskItems.length === 0) {
        passed.push({ code: 'crash_governance_clear', message: `版本 ${releaseVersion} 未发现未解决高风险 Crash` });
      } else if (policy.blockCrashGovernanceRisk) {
        blockers.push(...crashRiskItems);
      } else {
        warnings.push(...crashRiskItems);
      }
    }

    const score = Math.max(0, Math.min(100, 100 - blockers.length * 25 - warnings.length * 6));
    const status = blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'warning' : 'passed';
    const result = {
      status,
      score,
      summary: status === 'blocked'
        ? `发布被阻断：${blockers.length} 项阻断问题`
        : status === 'warning'
          ? `允许人工确认发布：${warnings.length} 项风险`
          : '质量门禁通过',
      blockers,
      warnings,
      passed,
      evaluatedTaskCount: thresholdTasks.length,
      sourceTaskCount: tasks.length,
      evaluatedIssueCount: issues.length,
      evaluatedAt: new Date().toISOString(),
    };

    const gateSignature = createHash('sha1').update(JSON.stringify({
      projectId: input.projectId || 'nn-ios',
      buildNumber,
      commitHash: input.commitHash || '',
      branch: input.branch || '',
      buildStatus,
      policy,
      tasks: thresholdTasks.map((task: any) => ({ id: task.id, status: task.status, updatedAt: task.updatedAt || task.updated_at, passed: task.result?.passed })),
      issues: openIssues.map((issue: any) => ({ id: issue.id, status: issue.status, severity: issue.severity, lastSeen: issue.lastSeen || issue.last_seen })),
    })).digest('hex');

    if (!persist) {
      return {
        id: `gate_preview_${gateSignature}`,
        projectId: input.projectId || 'nn-ios',
        buildNumber,
        commitHash: input.commitHash || null,
        branch: input.branch || null,
        status,
        score,
        policy,
        result,
        preview: true,
        createdAt: result.evaluatedAt,
      };
    }

    return workflowService.saveReleaseGate({
      id: `gate_${gateSignature}`,
      projectId: input.projectId,
      buildNumber,
      commitHash: input.commitHash,
      branch: input.branch,
      status,
      score,
      policy,
      result,
    });
  }

  evaluateReleaseHealth(projectId: string, releaseVersion: string) {
    const observations = workflowService.listReleaseObservations(projectId, releaseVersion);
    const anomalies = observations.filter((item: any) => ['warning', 'critical', 'regressed'].includes(String(item.status).toLowerCase()));
    const critical = anomalies.filter((item: any) => String(item.status).toLowerCase() === 'critical');
    const crashHealth = crashGovernanceService.evaluateReleaseHealth(releaseVersion);
    const recommendations: string[] = [];
    if (critical.length || crashHealth.status === 'critical') recommendations.push('暂停继续放量，并检查 Crash、启动失败和核心链路指标。');
    if (anomalies.some((item: any) => /crash/i.test(item.metric))) recommendations.push('关联 Sentry Crash 聚类和本次发布 Commit，确认是否为新增回归。');
    if (anomalies.some((item: any) => /latency|launch|startup|cpu|memory/i.test(item.metric))) recommendations.push('执行对应场景的性能专项任务并下载 xctrace 证据。');
    recommendations.push(...crashHealth.recommendations);
    const uniqueRecommendations = Array.from(new Set(recommendations));
    const status = critical.length || crashHealth.status === 'critical'
      ? 'critical'
      : anomalies.length || crashHealth.status === 'warning'
        ? 'warning'
        : 'healthy';
    if (!uniqueRecommendations.length) uniqueRecommendations.push('当前观察指标正常，可按既定灰度节奏继续放量。');
    return {
      projectId,
      releaseVersion,
      status,
      observationCount: observations.length,
      anomalyCount: anomalies.length,
      anomalies,
      crashHealth,
      recommendations: uniqueRecommendations,
      evaluatedAt: new Date().toISOString(),
    };
  }
}

export const qualityGateService = new QualityGateService();
