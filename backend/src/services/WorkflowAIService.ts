import { AIAnalysisService } from './AIAnalysisService';
import { workflowService } from './WorkflowService';

const aiAnalysisService = new AIAnalysisService();

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function extractActions(issue: any) {
  const evidence = Array.isArray(issue?.evidence) ? issue.evidence : [];
  const actions = evidence.flatMap((item: any) => {
    if (Array.isArray(item?.actions)) return item.actions;
    if (item?.action || item?.target) return [item];
    return [];
  });
  return actions.slice(-12).map((action: any, index: number) => ({
    index: index + 1,
    action: String(action.action || action.type || 'tap'),
    target: String(action.target || action.screen || action.pageName || '可见控件'),
    businessDomain: action.businessDomain || issue.businessDomain || undefined,
    businessPath: action.businessPath || issue.businessPath || undefined,
  }));
}

function swiftIdentifier(value: string) {
  const normalized = value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const name = normalized || 'GeneratedRegression';
  return /^\d/.test(name) ? `Test_${name}` : name;
}

function escapeSwift(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export class WorkflowAIService {
  proposeRegressionCandidate(issueId: string) {
    const issue: any = workflowService.getIssue(issueId);
    if (!issue) throw new Error('Issue 不存在');
    const actions = extractActions(issue);
    const businessPath = issue.businessPath || issue.metadata?.lastBusinessPath || 'unknown';
    const steps = actions.length
      ? actions.map((action: any) => `${action.action}：${action.target}`)
      : [
          `启动 App 并进入 ${businessPath}`,
          '按失败前业务路径执行安全、可重复的操作',
          '等待页面稳定并采集当前页面状态',
        ];
    const confidence = actions.length >= 5 ? 0.85 : actions.length >= 2 ? 0.7 : 0.45;
    return workflowService.createRegressionCandidate({
      issueId: issue.id,
      sourceTaskId: issue.taskId,
      title: `${issue.businessDomain || '业务'}：${issue.title}`,
      suite: 'xcuitest',
      businessDomain: issue.businessDomain,
      businessPath,
      preconditions: ['使用专用测试账号', 'App 已安装并处于可控登录态', '禁止支付、删除、退出登录等不可逆操作'],
      steps,
      assertions: [
        'App 保持前台且进程未崩溃',
        `能够到达或安全退出 ${businessPath}`,
        issue.category === 'white_screen' ? '页面存在至少一个可访问业务元素' : '关键业务控件可见且可交互',
      ],
      confidence,
      metadata: {
        source: 'monkey_failure',
        category: issue.category,
        sourceRef: issue.sourceRef,
        originalActions: actions,
      },
    });
  }

  async generateXCUITest(candidateId: string, apiKey?: string) {
    const candidate = workflowService.getRegressionCandidate(candidateId);
    if (!candidate) throw new Error('回归候选不存在');
    const testName = swiftIdentifier(candidate.title);
    const fallbackCode = `import XCTest

private enum ${testName}RegressionError: Error {
    case appDidNotEnterForeground
}

final class ${testName}Tests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func test_${testName}() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-ui-testing"]
        app.launch()
${candidate.steps.map((step: string) => `        // ${escapeSwift(step)}`).join('\n')}
        guard app.wait(for: .runningForeground, timeout: 10) else {
            throw ${testName}RegressionError.appDidNotEnterForeground
        }
${candidate.assertions.map((assertion: string) => `        // Assertion: ${escapeSwift(assertion)}`).join('\n')}
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "${testName}"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
`;
    const startedAt = Date.now();
    const result = await aiAnalysisService.runStructuredAnalysis({
      apiKey,
      systemPrompt: `你是资深 iOS 自动化测试工程师。根据确定性回归候选生成可维护的 XCUITest。输出严格 JSON：
{
  "testName": "Swift 合法测试名",
  "code": "完整 Swift 代码",
  "requiredAccessibilityIdentifiers": ["需要研发补充的 identifier"],
  "notes": ["实现说明"]
}
要求：代码必须自包含，不得依赖 nnios 新增辅助类或修改业务代码；优先使用 App 现有 accessibilityIdentifier 和稳定文案；禁止坐标点击；禁止支付、删除、退出登录；使用 guard/throw 表达失败，避免依赖无法独立 typecheck 的 XCTest 断言宏；输出必须是可单独类型检查的完整 Swift 测试文件；不得声称已经执行。`,
      userPrompt: JSON.stringify(candidate, null, 2),
      fallback: {
        testName,
        code: fallbackCode,
        requiredAccessibilityIdentifiers: [],
        notes: ['当前未配置 AI Key，已生成安全的 XCUITest 骨架。'],
      },
    });
    const code = String(result.code || fallbackCode);
    workflowService.recordAIEvaluation({
      capability: 'xcuitest_generation',
      model: process.env.OPENAI_MODEL || 'rule-fallback',
      promptVersion: 'xcuitest-v1',
      inputRef: candidateId,
      output: result,
      latencyMs: Date.now() - startedAt,
    });
    const updated = workflowService.createRegressionCandidate({
      issueId: candidate.issueId,
      sourceTaskId: candidate.sourceTaskId,
      title: `${candidate.title}（AI 生成）`,
      suite: candidate.suite,
      businessDomain: candidate.businessDomain,
      businessPath: candidate.businessPath,
      preconditions: candidate.preconditions,
      steps: candidate.steps,
      assertions: candidate.assertions,
      confidence: candidate.confidence,
      status: 'generated',
      generatedCode: code,
      metadata: {
        parentCandidateId: candidateId,
        requiredAccessibilityIdentifiers: result.requiredAccessibilityIdentifiers || [],
        notes: result.notes || [],
      },
    });
    return { candidate: updated, generation: result };
  }

  async suggestFix(issueId: string, context: Record<string, any>, apiKey?: string) {
    const issue: any = workflowService.getIssue(issueId);
    if (!issue) throw new Error('Issue 不存在');
    const fallback = {
      summary: `针对“${issue.title}”的候选修复建议`,
      rootCauseHypotheses: [issue.summary || '需要结合代码和现场证据继续定位'],
      filesToInspect: asStringArray(context.files).slice(0, 20),
      patchPlan: [
        '在责任模块增加可观测性和前置状态校验',
        '补齐稳定 accessibilityIdentifier，便于确定性回归',
        '修复后运行受影响业务套件与对应回归候选',
      ],
      codeChanges: [],
      risks: ['该结果仅为候选建议，未修改代码，也未创建 Commit 或 PR。'],
    };
    const startedAt = Date.now();
    const result = await aiAnalysisService.runStructuredAnalysis({
      apiKey,
      systemPrompt: `你是资深 iOS 故障修复助手。基于 Issue、Swift/Objective-C 代码上下文和变更影响给出候选修复方案。输出严格 JSON：
{
  "summary": "修复摘要",
  "rootCauseHypotheses": ["根因假设"],
  "filesToInspect": ["文件"],
  "patchPlan": ["步骤"],
  "codeChanges": [{"file":"路径","description":"修改说明","example":"短代码示例"}],
  "risks": ["风险"]
}
不要创建 Commit、PR 或声称已验证；不确定时明确需要的证据。`,
      userPrompt: JSON.stringify({ issue, context }, null, 2).slice(0, 30000),
      fallback,
    });
    workflowService.recordAIEvaluation({
      capability: 'fix_suggestion',
      model: process.env.OPENAI_MODEL || 'rule-fallback',
      promptVersion: 'fix-suggestion-v1',
      inputRef: issueId,
      output: result,
      latencyMs: Date.now() - startedAt,
    });
    return result;
  }

  async synthesizeKnowledge(input: Record<string, any>, apiKey?: string) {
    const fallback = {
      title: String(input.title || '移动研发经验沉淀'),
      summary: String(input.summary || '由 Workflow 事件和问题证据生成的工程知识条目。'),
      tags: asStringArray(input.tags),
      diagnosis: asStringArray(input.diagnosis),
      reusableChecks: asStringArray(input.reusableChecks),
      regressionGuidance: asStringArray(input.regressionGuidance),
    };
    const startedAt = Date.now();
    const result = await aiAnalysisService.runStructuredAnalysis({
      apiKey,
      systemPrompt: `你是移动研发知识工程师。将输入的故障、质量和处理信息提炼为可复用知识。输出严格 JSON：
{
  "title":"标题",
  "summary":"摘要",
  "tags":["标签"],
  "diagnosis":["诊断步骤"],
  "reusableChecks":["可自动化检查"],
  "regressionGuidance":["回归建议"]
}
去除敏感信息和偶发噪声，保留可验证证据。`,
      userPrompt: JSON.stringify(input, null, 2).slice(0, 30000),
      fallback,
    });
    const entry = workflowService.saveKnowledge({
      kind: input.kind || 'incident_playbook',
      fingerprint: input.fingerprint,
      title: result.title || fallback.title,
      summary: result.summary || fallback.summary,
      tags: result.tags || fallback.tags,
      sourceRefs: input.sourceRefs || [],
      content: result,
      confidence: input.confidence || 0.7,
    });
    workflowService.recordAIEvaluation({
      capability: 'knowledge_synthesis',
      model: process.env.OPENAI_MODEL || 'rule-fallback',
      promptVersion: 'knowledge-v1',
      inputRef: entry?.id,
      output: result,
      latencyMs: Date.now() - startedAt,
    });
    return entry;
  }
}

export const workflowAIService = new WorkflowAIService();
