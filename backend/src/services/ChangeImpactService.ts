import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

export interface ChangeImpactInput {
  repoPath?: string;
  baseRef?: string;
  headRef?: string;
  files?: string[];
}

interface ChangedFile {
  path: string;
  added: number;
  deleted: number;
  kind: string;
  module: string;
  domains: string[];
  risks: string[];
}

const DOMAIN_RULES: Array<{ domain: string; pattern: RegExp }> = [
  { domain: 'login', pattern: /login|auth|account|session|登录|认证/i },
  { domain: 'im', pattern: /message|chat|contact|friend|imsdk|\bim\b|消息|聊天|好友/i },
  { domain: 'community', pattern: /community|warband|feed|post|社区|动态/i },
  { domain: 'voice_room', pattern: /voice|room|channel|rtc|mic|语音|房间|频道/i },
  { domain: 'profile', pattern: /profile|mine|setting|privacy|我的|设置|隐私/i },
  { domain: 'playwith', pattern: /playwith|order|wallet|pay|recharge|refund|订单|支付|充值|退款/i },
  { domain: 'cross_platform', pattern: /bridge|jssdk|webview|hybrid|scheme|router|route|跨端|路由/i },
];

function normalizeFiles(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return Array.from(new Set(files.map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 2000);
}

function inferModule(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const moduleIndex = parts.findIndex((part) => /^(modules?|components?|features?|pods?)$/i.test(part));
  if (moduleIndex >= 0 && parts[moduleIndex + 1]) return parts[moduleIndex + 1];
  const sourceIndex = parts.findIndex((part) => /^(sources?|src)$/i.test(part));
  if (sourceIndex >= 0 && parts[sourceIndex + 1]) return parts[sourceIndex + 1];
  return parts.length > 1 ? parts[0] : 'app';
}

function classifyFile(filePath: string) {
  const lower = filePath.toLowerCase();
  if (/tests?\//.test(lower) || /tests?\.(swift|m|mm)$/.test(lower)) return 'test';
  if (/\.swift$/.test(lower)) return 'swift';
  if (/\.(m|mm|h|hpp|cpp|c)$/.test(lower)) return 'objc';
  if (/podfile|podfile\.lock|\.podspec/.test(lower)) return 'dependency';
  if (/\.xcodeproj|\.xcworkspace|project\.pbxproj|\.xcconfig/.test(lower)) return 'build_config';
  if (/info\.plist|\.entitlements|privacyinfo\.xcprivacy/.test(lower)) return 'compliance';
  if (/\.storyboard|\.xib|assets\.xcassets|\.imageset/.test(lower)) return 'ui_resource';
  if (/swagger|openapi|api[-_.]|request|response|endpoint/.test(lower)) return 'api';
  if (/router|route|scheme|jssdk|bridge|webview/.test(lower)) return 'integration';
  if (/jenkins|fastlane|scripts?\/|\.ya?ml$/.test(lower)) return 'pipeline';
  return 'other';
}

function risksFor(kind: string, filePath: string) {
  const risks = new Set<string>();
  if (['swift', 'objc'].includes(kind)) risks.add('functional_regression');
  if (kind === 'dependency') risks.add('dependency_compatibility');
  if (kind === 'build_config' || kind === 'pipeline') risks.add('build_release');
  if (kind === 'compliance') risks.add('privacy_signing_compliance');
  if (kind === 'ui_resource') risks.add('visual_regression');
  if (kind === 'api') risks.add('api_contract');
  if (kind === 'integration') risks.add('route_bridge_compatibility');
  if (/database|migration|storage|cache/i.test(filePath)) risks.add('data_migration');
  if (/startup|launch|appdelegate|scene(delegate)?/i.test(filePath)) risks.add('startup');
  if (/thread|async|concurr|lock|queue|actor/i.test(filePath)) risks.add('concurrency');
  return Array.from(risks);
}

function parseNumstat(output: string) {
  const stats = new Map<string, { added: number; deleted: number }>();
  output.split(/\r?\n/).forEach((line) => {
    const [added, deleted, ...fileParts] = line.split('\t');
    const file = fileParts.join('\t').trim();
    if (!file) return;
    stats.set(file, {
      added: added === '-' ? 0 : Number(added) || 0,
      deleted: deleted === '-' ? 0 : Number(deleted) || 0,
    });
  });
  return stats;
}

export class ChangeImpactService {
  analyze(input: ChangeImpactInput) {
    const repoPath = path.resolve(input.repoPath || process.env.NNIOS_REPO_PATH || '/Users/a1/工作/nnios');
    let files = normalizeFiles(input.files);
    let stats = new Map<string, { added: number; deleted: number }>();
    const baseRef = String(input.baseRef || '').trim();
    const headRef = String(input.headRef || 'HEAD').trim();

    if (files.length === 0) {
      if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.git'))) {
        throw new Error(`仓库不存在或不是 Git 仓库: ${repoPath}`);
      }
      const range = baseRef ? `${baseRef}...${headRef}` : headRef;
      const nameArgs = baseRef
        ? ['diff', '--name-only', '--diff-filter=ACMR', range]
        : ['diff', '--name-only', '--diff-filter=ACMR', headRef];
      const statArgs = baseRef
        ? ['diff', '--numstat', '--diff-filter=ACMR', range]
        : ['diff', '--numstat', '--diff-filter=ACMR', headRef];
      files = normalizeFiles(execFileSync('git', nameArgs, { cwd: repoPath, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).split(/\r?\n/));
      stats = parseNumstat(execFileSync('git', statArgs, { cwd: repoPath, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
    }

    const changedFiles: ChangedFile[] = files.map((filePath) => {
      const kind = classifyFile(filePath);
      const domains = DOMAIN_RULES.filter((rule) => rule.pattern.test(filePath)).map((rule) => rule.domain);
      const stat = stats.get(filePath) || { added: 0, deleted: 0 };
      return {
        path: filePath,
        added: stat.added,
        deleted: stat.deleted,
        kind,
        module: inferModule(filePath),
        domains,
        risks: risksFor(kind, filePath),
      };
    });

    const domains = Array.from(new Set(changedFiles.flatMap((file) => file.domains)));
    const risks = Array.from(new Set(changedFiles.flatMap((file) => file.risks)));
    const modules = Array.from(new Set(changedFiles.map((file) => file.module)));
    const changedLines = changedFiles.reduce((sum, file) => sum + file.added + file.deleted, 0);
    let riskScore = Math.min(100, changedFiles.length * 2 + Math.ceil(changedLines / 40));
    riskScore += domains.length * 5;
    if (risks.includes('privacy_signing_compliance')) riskScore += 20;
    if (risks.includes('dependency_compatibility')) riskScore += 15;
    if (risks.includes('startup')) riskScore += 15;
    if (risks.includes('concurrency')) riskScore += 12;
    riskScore = Math.min(100, riskScore);

    const suites = new Set<string>(['smoke']);
    domains.forEach((domain) => {
      if (domain === 'im') suites.add('im');
      if (domain === 'voice_room') suites.add('rtc');
      if (['community', 'profile', 'playwith', 'login', 'cross_platform'].includes(domain)) suites.add('monkey');
    });
    if (risks.includes('visual_regression')) suites.add('visual');
    if (risks.includes('startup') || risks.includes('concurrency')) suites.add('performance');
    if (risks.includes('dependency_compatibility') || risks.includes('build_release')) suites.add('build_validation');
    if (riskScore >= 70) suites.add('full');

    const checks = new Set<string>();
    risks.forEach((risk) => {
      if (risk === 'api_contract') checks.add('API 契约测试');
      if (risk === 'privacy_signing_compliance') checks.add('隐私清单、权限、签名和 Entitlements 检查');
      if (risk === 'dependency_compatibility') checks.add('Pod 依赖解析与二进制兼容检查');
      if (risk === 'visual_regression') checks.add('截图视觉回归');
      if (risk === 'route_bridge_compatibility') checks.add('路由与 JSBridge 联调验证');
      if (risk === 'startup') checks.add('冷启动基线对比');
      if (risk === 'concurrency') checks.add('Thread Sanitizer/并发路径专项验证');
    });

    return {
      repoPath,
      baseRef: baseRef || null,
      headRef,
      totalFiles: changedFiles.length,
      changedLines,
      riskScore,
      riskLevel: riskScore >= 70 ? 'high' : riskScore >= 40 ? 'medium' : 'low',
      modules,
      domains,
      risks,
      recommendedSuites: Array.from(suites),
      recommendedChecks: Array.from(checks),
      files: changedFiles,
      generatedAt: new Date().toISOString(),
    };
  }
}

export const changeImpactService = new ChangeImpactService();

