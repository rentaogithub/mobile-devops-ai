import { execFile } from 'child_process';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { workflowService } from './WorkflowService';
import { currentProjectId } from './ProductLineContext';

const execFileAsync = promisify(execFile);

function safeToken(value: unknown) {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'GeneratedRegression';
}

function ensureInside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`目标路径必须位于 ${parent} 内`);
  }
}

function parseTestCode(code: string) {
  const className = code.match(/(?:final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*XCTestCase/)?.[1];
  const testNames = Array.from(code.matchAll(/func\s+(test[A-Za-z0-9_]*)\s*\(/g)).map((match) => match[1]);
  if (!className) throw new Error('生成代码中未找到 XCTestCase 类');
  if (testNames.length === 0) throw new Error('生成代码中未找到 test 方法');
  if (!/import\s+XCTest/.test(code)) throw new Error('生成代码缺少 import XCTest');
  return { className, testNames };
}

async function runCommand(command: string, args: string[], options: { cwd: string; timeout: number }) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { passed: true, stdout: String(result.stdout || ''), stderr: String(result.stderr || ''), exitCode: 0 };
  } catch (error: any) {
    return {
      passed: false,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || error.message || ''),
      exitCode: Number(error.code) || 1,
    };
  }
}

export class XCUITestWorkflowService {
  private outputRoot() {
    const base = path.resolve(
      process.env.WORKFLOW_XCUITEST_OUTPUT_DIR
        || path.join(process.env.DATA_DIR || path.resolve(process.cwd(), '..', 'nn-ios-platform-data'), 'workflow-xcuitest'),
    );
    const projectId = currentProjectId();
    return projectId === 'nn-ios' ? base : path.join(base, safeToken(projectId));
  }

  async exportCandidate(candidateId: string, input: Record<string, any> = {}) {
    const candidate = workflowService.getRegressionCandidate(candidateId);
    if (!candidate) throw new Error('回归候选不存在');
    const code = String(candidate.generatedCode || '').trim();
    if (!code) throw new Error('请先生成 XCUITest 代码');
    const parsed = parseTestCode(code);
    const root = this.outputRoot();
    const defaultDirectory = path.join(root, 'exports');
    const targetDirectory = input.targetDirectory ? path.resolve(String(input.targetDirectory)) : defaultDirectory;
    ensureInside(root, targetDirectory);
    await fsPromises.mkdir(targetDirectory, { recursive: true });
    const fileName = `${safeToken(input.fileName || parsed.className)}.swift`;
    const filePath = path.join(targetDirectory, fileName);
    ensureInside(targetDirectory, filePath);
    await fsPromises.writeFile(filePath, `${code}\n`, 'utf8');
    const updated = workflowService.updateRegressionCandidate(candidateId, {
      status: 'exported',
      metadata: {
        export: {
          filePath,
          className: parsed.className,
          testNames: parsed.testNames,
          exportedAt: new Date().toISOString(),
        },
      },
    });
    return { candidate: updated, filePath, ...parsed };
  }

  async verifyCandidate(candidateId: string, input: Record<string, any> = {}) {
    let candidate = workflowService.getRegressionCandidate(candidateId);
    if (!candidate) throw new Error('回归候选不存在');
    let metadata = candidate.metadata as Record<string, any>;
    if (!metadata?.export?.filePath || !fs.existsSync(metadata.export.filePath)) {
      await this.exportCandidate(candidateId, input);
      candidate = workflowService.getRegressionCandidate(candidateId);
    }
    if (!candidate) throw new Error('回归候选不存在');

    const parsed = parseTestCode(String(candidate.generatedCode || ''));
    const exportPath = String((candidate.metadata as Record<string, any>)?.export?.filePath || '');
    if (!exportPath || !fs.existsSync(exportPath)) throw new Error('导出文件不存在');
    const runId = `${safeToken(candidateId)}-${Date.now()}`;
    const runRoot = path.join(this.outputRoot(), runId);
    await fsPromises.mkdir(runRoot, { recursive: true });
    const [sdkResult, platformResult] = await Promise.all([
      runCommand('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { cwd: runRoot, timeout: 30_000 }),
      runCommand('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-platform-path'], { cwd: runRoot, timeout: 30_000 }),
    ]);
    if (!sdkResult.passed || !platformResult.passed) throw new Error('无法获取 iOS Simulator SDK 和 XCTest Framework');
    const sdkPath = sdkResult.stdout.trim();
    const platformPath = platformResult.stdout.trim();
    const args = [
      '--sdk', 'iphonesimulator',
      'swiftc',
      '-typecheck',
      '-target', 'arm64-apple-ios15.0-simulator',
      '-sdk', sdkPath,
      '-F', path.join(platformPath, 'Developer', 'Library', 'Frameworks'),
      exportPath,
    ];
    const result = await runCommand('xcrun', args, { cwd: runRoot, timeout: Number(input.timeoutMs) || 5 * 60 * 1000 });
    const logPath = path.join(runRoot, 'swift-typecheck.log');
    await fsPromises.writeFile(logPath, [result.stdout, result.stderr].filter(Boolean).join('\n'), 'utf8');
    const status = result.passed ? 'compiled' : 'failed';
    const updated = workflowService.updateRegressionCandidate(candidateId, {
      status,
      metadata: {
        compile: {
          passed: result.passed,
          exitCode: result.exitCode,
          logPath,
          className: parsed.className,
          testNames: parsed.testNames,
          mode: 'isolated_xctest_typecheck',
          command: ['xcrun', ...args],
          verifiedAt: new Date().toISOString(),
        },
      },
    });
    return { candidate: updated, passed: result.passed, exitCode: result.exitCode, logPath, mode: 'isolated_xctest_typecheck' };
  }

  async runCandidate(candidateId: string, input: Record<string, any> = {}) {
    if (input.allowRun !== true) throw new Error('未显式允许执行 XCUITest');
    const candidate = workflowService.getRegressionCandidate(candidateId);
    if (!candidate) throw new Error('回归候选不存在');
    const runnerUrl = String(process.env.WORKFLOW_XCUITEST_RUNNER_URL || '').trim();
    if (!runnerUrl) {
      throw new Error('未配置 WORKFLOW_XCUITEST_RUNNER_URL；为保证不修改产品线主工程，实际执行必须由 CI/临时工作区 Runner 完成');
    }
    const compileResult = await this.verifyCandidate(candidateId, input);
    if (!compileResult.passed) return { ...compileResult, executed: false };
    const response = await fetch(runnerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.WORKFLOW_XCUITEST_RUNNER_TOKEN
          ? { Authorization: `Bearer ${process.env.WORKFLOW_XCUITEST_RUNNER_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        candidateId,
        code: candidate.generatedCode,
        destination: input.destination,
        metadata: candidate.metadata,
      }),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) throw new Error(String(payload.error || `XCUITest Runner 返回 ${response.status}`));
    const passed = payload.passed === true || ['passed', 'success', 'verified'].includes(String(payload.status || '').toLowerCase());
    const updated = workflowService.updateRegressionCandidate(candidateId, {
      status: passed ? 'verified' : 'failed',
      metadata: {
        execution: {
          ...payload,
          passed,
          runnerUrl,
          executedAt: new Date().toISOString(),
        },
      },
    });
    return { candidate: updated, executed: true, passed, ...payload };
  }
}

export const xcuiTestWorkflowService = new XCUITestWorkflowService();
