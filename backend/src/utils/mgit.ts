export function buildMgitPublishArgs(targetBranch: string, baseBranch: string, productLine?: string): string[] {
  return [
    ...(productLine ? ['--line', productLine] : []),
    'publish',
    targetBranch,
    '--base-branch',
    baseBranch,
  ];
}
