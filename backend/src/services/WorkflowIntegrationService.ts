import { createHash } from 'crypto';
import logger from '../utils/logger';
import { workflowService } from './WorkflowService';
import { currentProductLineId, currentProjectId, getProductLineContext } from './ProductLineContext';

type JsonObject = Record<string, any>;

function text(value: unknown) {
  return String(value ?? '').trim();
}

function token(value: unknown) {
  return text(value).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 140) || 'unknown';
}

function sha1(value: string) {
  return createHash('sha1').update(value).digest('hex');
}

function compact(value: unknown, maxLength = 1000) {
  return text(value).replace(/\s+/g, ' ').slice(0, maxLength);
}

function workflowScope() {
  return currentProductLineId() === 'nn' ? 'nn' : token(currentProjectId());
}

function productLabel() {
  return getProductLineContext()?.name || currentProductLineId();
}

function scopedArtifactId(kind: string, ...parts: unknown[]) {
  const suffix = parts.map(token).join('_');
  return currentProductLineId() === 'nn'
    ? `artifact_${kind}_${suffix}`
    : `artifact_${kind}_${workflowScope()}_${suffix}`;
}

function buildStatus(build: JsonObject) {
  if (build.building) return 'running';
  const status = text(build.result).toUpperCase();
  if (status === 'SUCCESS') return 'passed';
  if (status === 'FAILURE') return 'failed';
  if (status === 'ABORTED') return 'canceled';
  if (status === 'UNSTABLE') return 'unstable';
  return status ? status.toLowerCase() : 'created';
}

function sentrySeverity(issue: JsonObject) {
  const level = text(issue.level || issue.severity).toLowerCase();
  if (level === 'fatal') return 'critical';
  if (level === 'error') return 'high';
  if (level === 'warning') return 'medium';
  return 'low';
}

function analysisSummary(analysis: JsonObject | undefined) {
  if (!analysis) return '';
  return compact(
    analysis.summary
      || analysis.rootCause
      || analysis.failureReason
      || analysis.crashReason
      || analysis.analysis
      || analysis.conclusion,
    3500,
  );
}

function latestBuildArtifactForVersion(appVersion: string) {
  return workflowService.listArtifacts({ artifactType: 'jenkins_build', limit: 500 })
    .filter((artifact: any) => artifact.version === appVersion)
    .sort((left: any, right: any) => Number(right.buildNumber || 0) - Number(left.buildNumber || 0))[0] || null;
}

export class WorkflowIntegrationService {
  private bestEffort<T>(name: string, operation: () => T): T | null {
    try {
      return operation();
    } catch (error: any) {
      logger.warn(`Workflow 自动同步失败: ${name}`, { error: error?.message || String(error) });
      return null;
    }
  }

  syncJenkinsBuild(build: JsonObject) {
    return this.bestEffort('Jenkins build', () => {
      const jenkinsNumber = text(build.number || build.jenkinsBuildNumber);
      if (!jenkinsNumber) return null;
      const sourceBuildNumber = jenkinsNumber;
      const scope = workflowScope();
      const label = productLabel();
      const artifactId = `artifact_jenkins_${scope}_${token(jenkinsNumber)}`;
      const taskId = `jenkins:${scope}:${jenkinsNumber}`;
      const status = buildStatus(build);
      const artifact = workflowService.createArtifact({
        id: artifactId,
        artifactType: 'jenkins_build',
        name: `${label} Jenkins #${jenkinsNumber}`,
        version: build.appVersion,
        buildNumber: sourceBuildNumber,
        commitHash: build.commitHash,
        branch: build.branchName || build.branch,
        uri: build.packageUrl || build.installPackageUrl || build.archiveUrl || build.xcarchivePath || build.url,
        metadata: {
          jenkinsBuildNumber: Number(jenkinsNumber) || jenkinsNumber,
          channelBuildNumber: build.buildNumber,
          result: build.result,
          building: Boolean(build.building),
          timestamp: build.timestamp,
          duration: build.duration,
          publishChannel: build.publishChannel,
          packageUrl: build.packageUrl,
          installPackageUrl: build.installPackageUrl,
          channelQrUrl: build.channelQrUrl,
          xcarchivePath: build.xcarchivePath,
          archiveUrl: build.archiveUrl,
          dsymSync: build.dsymSync,
          jenkinsUrl: build.url,
        },
      });
      const task = workflowService.upsertTask({
        id: taskId,
        taskType: 'ios_build',
        suite: 'build',
        status,
        source: 'jenkins',
        externalId: jenkinsNumber,
        externalUrl: build.url,
        buildNumber: sourceBuildNumber,
        commitHash: build.commitHash,
        branch: build.branchName || build.branch,
        artifactId,
        progress: build.building ? 50 : 100,
        startedAt: build.timestamp ? new Date(Number(build.timestamp)).toISOString() : undefined,
        finishedAt: !build.building && build.timestamp
          ? new Date(Number(build.timestamp) + Number(build.duration || 0)).toISOString()
          : undefined,
        config: { publishChannel: build.publishChannel },
        result: { result: build.result, passed: status === 'passed', durationMs: build.duration },
      });
      if (status === 'failed' || status === 'unstable') {
        workflowService.upsertIssue({
          fingerprint: `jenkins:${scope}:${jenkinsNumber}:build_failure`,
          source: 'jenkins',
          sourceRef: build.url || `${label}#${jenkinsNumber}`,
          category: 'build_failure',
          severity: status === 'failed' ? 'high' : 'medium',
          title: `${label} Jenkins #${jenkinsNumber} ${status === 'failed' ? '构建失败' : '构建不稳定'}`,
          summary: `分支 ${text(build.branchName || build.branch) || '-'}，发布渠道 ${text(build.publishChannel) || '-'}`,
          taskId,
          artifactId,
          buildNumber: sourceBuildNumber,
          commitHash: build.commitHash,
          evidence: [{ type: 'jenkins_build', url: build.url, result: build.result }],
          metadata: { jenkinsBuildNumber: jenkinsNumber, publishChannel: build.publishChannel },
          lastSeen: build.timestamp ? new Date(Number(build.timestamp)).toISOString() : undefined,
        });
      }
      return { artifact, task };
    });
  }

  syncJenkinsBuilds(builds: JsonObject[]) {
    return builds.map((build) => this.syncJenkinsBuild(build)).filter(Boolean);
  }

  recordBuildFailure(build: JsonObject, analysis?: JsonObject) {
    return this.bestEffort('Jenkins failure analysis', () => {
      this.syncJenkinsBuild({ ...build, result: build.result || 'FAILURE', building: false });
      const jenkinsNumber = text(build.number || build.jenkinsBuildNumber || build.buildNumber);
      const sourceBuildNumber = jenkinsNumber;
      const scope = workflowScope();
      const label = productLabel();
      return workflowService.upsertIssue({
        fingerprint: `jenkins:${scope}:${jenkinsNumber}:build_failure`,
        source: 'jenkins',
        sourceRef: build.url || `${label}#${jenkinsNumber}`,
        category: 'build_failure',
        severity: text(analysis?.severity).toLowerCase() || 'high',
        title: compact(analysis?.title || analysis?.failureStage || `${label} Jenkins #${jenkinsNumber} 构建失败`, 500),
        summary: analysisSummary(analysis) || '已采集 Jenkins 失败日志，等待进一步定位。',
        taskId: `jenkins:${scope}:${jenkinsNumber}`,
        artifactId: `artifact_jenkins_${scope}_${token(jenkinsNumber)}`,
        buildNumber: sourceBuildNumber,
        commitHash: build.commitHash,
        module: analysis?.module || analysis?.suspectedModule,
        evidence: [{ type: 'jenkins_failure_analysis', analysis, url: build.url }],
        metadata: { ...build, analysis },
      });
    });
  }

  syncSentryIssue(issue: JsonObject, analysis?: JsonObject) {
    return this.bestEffort('Sentry issue', () => {
      const issueId = text(issue.id || issue.shortId);
      if (!issueId) return null;
      const appVersion = text(issue.maxAppVersion || issue.appVersion || issue.appVersions?.[0]);
      const releaseArtifactId = appVersion ? scopedArtifactId('sentry_release', appVersion) : undefined;
      const linkedBuild = appVersion ? latestBuildArtifactForVersion(appVersion) : null;
      const artifactId = linkedBuild?.id || releaseArtifactId;
      if (releaseArtifactId) {
        workflowService.createArtifact({
          id: releaseArtifactId,
          artifactType: 'app_release',
          name: `${productLabel()} ${appVersion}`,
          version: appVersion,
          metadata: { source: 'sentry', appVersionRange: issue.appVersionRange, appVersions: issue.appVersions },
        });
        if (linkedBuild?.id) {
          workflowService.addRelation({ fromType: 'artifact', fromId: linkedBuild.id, relation: 'represents_release', toType: 'artifact', toId: releaseArtifactId });
        }
      }
      return workflowService.upsertIssue({
        fingerprint: `sentry:${issueId}`,
        source: 'sentry',
        sourceRef: issue.permalink || issueId,
        category: 'crash',
        severity: sentrySeverity(issue),
        status: text(issue.status).toLowerCase() === 'resolved' ? 'resolved' : 'open',
        title: compact(issue.title || issue.culprit || issue.shortId || `Sentry ${issueId}`, 500),
        summary: analysisSummary(analysis) || compact(issue.metadata?.value || issue.culprit || issue.type, 3500),
        module: analysis?.module || analysis?.crashModule || issue.culprit,
        artifactId,
        buildNumber: linkedBuild?.buildNumber,
        commitHash: linkedBuild?.commitHash,
        evidence: [{
          type: 'sentry_issue',
          issueId,
          eventId: issue.eventId,
          permalink: issue.permalink,
          count: issue.count,
          userCount: issue.userCount,
          analysis,
        }],
        metadata: {
          shortId: issue.shortId,
          level: issue.level,
          count: issue.count,
          userCount: issue.userCount,
          firstSeen: issue.firstSeen,
          lastSeen: issue.lastSeen,
          appVersionRange: issue.appVersionRange,
          appVersions: issue.appVersions,
          eventId: issue.eventId,
          analysis,
        },
        firstSeen: issue.firstSeen,
        lastSeen: issue.lastSeen,
      });
    });
  }

  syncSentryIssues(issues: JsonObject[]) {
    return issues.map((issue) => this.syncSentryIssue(issue)).filter(Boolean);
  }

  syncFeedbackLog(rows: JsonObject[], context: JsonObject = {}) {
    return this.bestEffort('feedback log', () => {
      const sourcePath = text(context.path || context.filePath);
      const artifactId = scopedArtifactId('feedback_log', sha1(sourcePath || JSON.stringify(rows.slice(0, 5))).slice(0, 16));
      workflowService.createArtifact({
        id: artifactId,
        artifactType: 'feedback_log',
        name: sourcePath ? `用户反馈日志 ${sourcePath.split('/').pop()}` : '用户反馈日志',
        buildNumber: context.buildNumber,
        version: context.appVersion,
        uri: sourcePath,
        metadata: { ...context, rowCount: rows.length },
      });

      const groups = new Map<string, { category: string; severity: string; title: string; rows: JsonObject[] }>();
      for (const row of rows) {
        const content = compact(row.content, 4000);
        if (!content) continue;
        let category = '';
        let severity = 'medium';
        let title = '';
        if (/\b(crash|exception|fatal|assert(?:ion)? failed)\b|崩溃|异常/i.test(content)) {
          category = 'log_exception';
          severity = /fatal|crash|崩溃/i.test(content) ? 'high' : 'medium';
          title = '反馈日志检测到异常/崩溃信号';
        } else if (/\bretCode\s*[=:]\s*(?!0\b|200\b)[-\d]+|\b(error|failed|failure)\b|失败|错误/i.test(content)) {
          category = 'log_error';
          severity = 'medium';
          title = '反馈日志检测到错误返回';
        } else {
          const duration = content.match(/(?:duration|cost|elapsed|latency)(?:Ms)?\s*[=:]\s*(\d+)/i);
          if (duration && Number(duration[1]) >= Number(process.env.WORKFLOW_LOG_SLOW_MS || 3000)) {
            category = 'slow_request';
            severity = 'medium';
            title = '反馈日志检测到慢请求';
          }
        }
        if (!category) continue;
        const normalized = content
          .replace(/https?:\/\/\S+/g, '<url>')
          .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<uuid>')
          .replace(/\b\d{4,}\b/g, '<n>')
          .slice(0, 500);
        const key = `${category}:${sha1(normalized)}`;
        const group = groups.get(key) || { category, severity, title, rows: [] };
        group.rows.push({ id: row.id, time: row.time, content });
        groups.set(key, group);
      }

      const issues = Array.from(groups.entries()).slice(0, 50).map(([key, group]) => workflowService.upsertIssue({
        fingerprint: `feedback:${key}`,
        source: 'feedback_log',
        sourceRef: sourcePath,
        category: group.category,
        severity: group.severity,
        title: `${group.title}（${group.rows.length} 条）`,
        summary: compact(group.rows[0]?.content, 3500),
        artifactId,
        buildNumber: context.buildNumber,
        evidence: group.rows.slice(0, 10).map((item) => ({ type: 'log_line', ...item })),
        metadata: { ...context, matchedCount: group.rows.length },
        lastSeen: context.lastSeen,
      }));
      return { artifactId, issueCount: issues.length, issues };
    });
  }

  syncDSYM(dsym: JsonObject, context: JsonObject = {}) {
    return this.bestEffort('dSYM', () => {
      const uuid = text(dsym.uuid);
      if (!uuid) return null;
      const artifact = workflowService.createArtifact({
        id: scopedArtifactId('dsym', uuid),
        artifactType: 'dsym',
        name: `${text(dsym.appName) || 'Unknown'}.dSYM`,
        version: dsym.version,
        buildNumber: dsym.buildNumber || context.buildNumber,
        uri: dsym.filePath,
        checksum: uuid,
        metadata: { ...context, ...dsym, uuid },
      });
      const linkedBuild = dsym.version ? latestBuildArtifactForVersion(String(dsym.version)) : null;
      if (artifact?.id && linkedBuild?.id) {
        workflowService.addRelation({ fromType: 'artifact', fromId: linkedBuild.id, relation: 'has_symbols', toType: 'artifact', toId: artifact.id });
      }
      return artifact;
    });
  }

  syncPodComponent(component: JsonObject, action = 'sync') {
    return this.bestEffort('Pod component', () => {
      const name = text(component.name || component.component_name || component.pod_name);
      const version = text(component.version);
      if (!name || !version) return null;
      const componentSummary = {
        id: component.id,
        name,
        version,
        summary: compact(component.summary, 500),
        homepage: component.homepage,
        sourceZipUrl: component.source_zip_url || component.download_url || component.zip_url,
        status: component.status,
        uploadTime: component.upload_time || component.uploadTime,
        packageType: component.package_type || component.packageType,
        buildId: component.build_id || component.buildNumber,
        branch: component.target_branch || component.targetBranch || component.branch,
      };
      const artifactId = scopedArtifactId('pod', name, version);
      const artifact = workflowService.createArtifact({
        id: artifactId,
        artifactType: 'pod_component',
        name,
        version,
        buildNumber: component.build_id || component.buildNumber,
        branch: component.target_branch || component.targetBranch || component.branch,
        uri: component.download_url || component.zip_url || component.repo_url || component.git_url,
        metadata: { action, component: componentSummary },
      });
      const task = workflowService.upsertTask({
        id: currentProductLineId() === 'nn'
          ? `pod:${token(action)}:${token(name)}:${token(version)}`
          : `pod:${workflowScope()}:${token(action)}:${token(name)}:${token(version)}`,
        taskType: 'pod_delivery',
        suite: 'pods',
        status: component.status === 'failed' ? 'failed' : 'passed',
        source: 'pods',
        externalId: component.id,
        buildNumber: component.build_id || component.buildNumber,
        branch: component.target_branch || component.targetBranch || component.branch,
        artifactId,
        progress: 100,
        config: { action },
        result: { component: componentSummary, passed: component.status !== 'failed' },
      });
      return { artifact, task };
    });
  }
}

export const workflowIntegrationService = new WorkflowIntegrationService();
