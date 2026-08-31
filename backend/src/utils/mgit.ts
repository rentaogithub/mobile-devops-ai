export function buildMgitPublishArgs(targetBranch: string, baseBranch: string): string[] {
  return ['publish', targetBranch, '--base-branch', baseBranch];
}
