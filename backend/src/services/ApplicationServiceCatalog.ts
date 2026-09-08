// Pure data shared with the web client. Provider selection is independent of OS.
export type ServicePlatform = 'ios' | 'android';
export type ApplicationServiceId = 'sentry' | 'bugly' | 'podx' | 'jenkins' | 'quality' | 'devices' | 'dsym' | 'logs' | 'api-docs' | 'workflow' | 'wechat' | 'watermark' | 'apple-devices' | 'devops';
export interface ServiceDefinition {
  id: ApplicationServiceId; name: string; platforms: ServicePlatform[];
  requires: ApplicationServiceId[]; category: string; description: string;
  nativePlatforms: ServicePlatform[];
}
export const applicationServiceCatalog: ServiceDefinition[] = [
  { id: 'sentry', name: 'Sentry', platforms: ['ios', 'android'], nativePlatforms: ['ios'], requires: [], category: 'crash', description: 'iOS 支持现有数据接入；Android 当前仅支持配置外部控制台入口。' },
  { id: 'bugly', name: '腾讯 Bugly', platforms: ['ios', 'android'], nativePlatforms: [], requires: [], category: 'crash', description: '可配置应用标识及控制台入口；问题同步、符号还原和 AI 数据诊断待适配。' },
  { id: 'podx', name: '组件库（Podx）', platforms: ['ios'], nativePlatforms: ['ios'], requires: [], category: 'engineering', description: '同一系统的产品线可共用组件库；当前由 Podx 提供 iOS 组件、依赖和工程管理。' },
  { id: 'jenkins', name: 'Jenkins CI/CD', platforms: ['ios', 'android'], nativePlatforms: ['ios', 'android'], requires: [], category: 'engineering', description: '按应用平台使用对应的构建执行器。' },
  { id: 'devices', name: '真机服务', platforms: ['ios', 'android'], nativePlatforms: ['ios', 'android'], requires: [], category: 'quality', description: 'iOS 调试/回放；Android 指定 adb 设备执行器。' },
  { id: 'quality', name: '自动质检', platforms: ['ios', 'android'], nativePlatforms: ['ios', 'android'], requires: ['jenkins', 'devices'], category: 'quality', description: '依赖构建与真机服务，提供平台对应的自动化执行。' },
  { id: 'dsym', name: 'dSYM 与本地符号化', platforms: ['ios'], nativePlatforms: ['ios'], requires: [], category: 'quality', description: '独立于线上崩溃提供商的 iOS 符号化服务。' },
  { id: 'logs', name: '反馈日志', platforms: ['ios'], nativePlatforms: ['ios'], requires: [], category: 'diagnosis', description: '现有 iOS 反馈日志与日志配对接入。' },
  { id: 'api-docs', name: 'API / 路由 / 跨端查询', platforms: ['ios'], nativePlatforms: ['ios'], requires: [], category: 'engineering', description: '现有接口目录与客户端路由查询。' },
  { id: 'workflow', name: '质量中心', platforms: ['ios'], nativePlatforms: ['ios'], requires: [], category: 'quality', description: '现有 iOS Workflow 工作台；Android 证据在 Android 交付页查看。' },
  { id: 'wechat', name: '企业微信', platforms: ['ios'], nativePlatforms: ['ios'], requires: [], category: 'integration', description: '现有企业微信服务入口。' },
  { id: 'watermark', name: '水印诊断', platforms: ['ios'], nativePlatforms: ['ios'], requires: [], category: 'diagnosis', description: '现有水印解码服务。' },
  { id: 'apple-devices', name: 'Apple 设备注册', platforms: ['ios'], nativePlatforms: ['ios'], requires: [], category: 'integration', description: 'Apple 设备注册与描述文件登记。' },
  { id: 'devops', name: 'DevOps 技能库', platforms: ['ios'], nativePlatforms: ['ios'], requires: [], category: 'engineering', description: '现有 iOS 研发工具安装与技能说明。' },
];
export interface ServiceApplication {
  platform: ServicePlatform; productLineId: string; services?: ApplicationServiceId[];
  serviceOptions?: Partial<Record<'sentry' | 'bugly', { appId?: string; consoleUrl?: string }>>;
}
// NULL/absent selections retain pre-service-selection behavior; [] explicitly disables all.
export function defaultApplicationServices(platform: ServicePlatform, productLineId: string): ApplicationServiceId[] {
  if (platform === 'ios') return applicationServiceCatalog.filter((item) => item.nativePlatforms.includes('ios')).map((item) => item.id);
  return ['jenkins', 'devices', 'quality', ...(productLineId === 'nn' ? ['bugly' as const] : [])];
}
export function selectedServices(app?: ServiceApplication | null): ApplicationServiceId[] {
  return app?.services ?? defaultApplicationServices(app?.platform || 'ios', app?.productLineId || 'nn');
}
export function hasApplicationServices(app: ServiceApplication | null | undefined, services: ApplicationServiceId[]) {
  const selected = selectedServices(app);
  return services.every((id) => selected.includes(id) && applicationServiceCatalog.find((item) => item.id === id)?.platforms.includes(app?.platform || 'ios'));
}
// Longest/specific paths precede their parents. These requirements never replace role checks.
export const pageServiceRequirements: [string, ApplicationServiceId[]][] = [
  ['/sentry-service', ['sentry']], ['/bugly', ['bugly']], ['/history', ['dsym']], ['/symbolicate', ['dsym']], ['/manage', ['dsym']],
  ['/pods', ['podx']], ['/cicd/devices', ['apple-devices']], ['/cicd/device-control', ['devices']], ['/cicd/replay', ['devices']],
  ['/cicd/quality', ['quality']], ['/cicd', ['jenkins']], ['/android', ['jenkins']], ['/logs', ['logs']],
  ['/devops', ['devops']], ['/api-docs', ['api-docs']], ['/routes', ['api-docs']], ['/cross-platform', ['api-docs']], ['/workflow', ['workflow']],
];
export function requiredServicesForPage(path: string) { return pageServiceRequirements.find(([prefix]) => path === prefix || path.startsWith(prefix + '/'))?.[1] || []; }
export const apiServiceRequirements: [string, ApplicationServiceId[]][] = [
  ['/jenkins/nn/quality', ['jenkins', 'quality']], ['/jenkins', ['jenkins']], ['/quality', ['quality']],
  ['/dsym', ['dsym']], ['/symbolicate', ['dsym']], ['/history', ['dsym']], ['/cleanup', ['dsym']], ['/config', ['dsym']],
  ['/pods', ['podx']], ['/git', ['podx']], ['/sentry-analysis', ['sentry']], ['/device-control', ['devices']], ['/apple-devices', ['apple-devices']],
  ['/pairing', ['logs']], ['/user-query-records', ['logs']], ['/feedback-log', ['logs']], ['/watermark', ['watermark']], ['/wechat', ['wechat']],
  ['/api-docs', ['api-docs']], ['/workflow', ['workflow']], ['/android', ['jenkins']],
];
export function requiredServicesForApi(path: string) { return apiServiceRequirements.find(([prefix]) => path === prefix || path.startsWith(prefix + '/'))?.[1] || []; }
