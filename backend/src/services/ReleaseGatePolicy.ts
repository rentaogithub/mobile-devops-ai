export function normalizeQualitySuite(value: string) {
  const text = String(value || 'smoke').trim();
  if (/monkey|随机|猴子/i.test(text)) return 'monkey';
  if (/卡顿|stutter|hitch|jank/i.test(text)) return 'stutter';
  if (/business[_-]?flow|业务.*编排|自定义.*质检|自定义.*测试/i.test(text)) return 'business_flow';
  if (/冒烟|smoke/i.test(text)) return 'smoke';
  if (/^im$|im\s*基础/i.test(text)) return 'im';
  if (/^rtc$|rtc\s*基础/i.test(text)) return 'rtc';
  if (/全量|full/i.test(text)) return 'full';
  return text.toLowerCase();
}

export function requiredReleaseGateSuites() {
  const suites = String(process.env.RELEASE_GATE_REQUIRED_SUITES || 'smoke')
    .split(',')
    .map((item) => normalizeQualitySuite(item))
    .filter(Boolean);
  return suites.length ? Array.from(new Set(suites)) : ['smoke'];
}
