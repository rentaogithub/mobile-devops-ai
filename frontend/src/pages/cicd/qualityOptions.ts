import { JenkinsBuild, JenkinsQualityBuild, JenkinsQualitySuite } from '../../services/api';

export type DeployTarget = 'Pgyer' | 'TestFlight' | 'AppStore';
export type QualityReportKind = 'monkey' | 'stutter' | 'business_flow' | 'generic';

export const PRODUCTION_BUNDLE_ID = 'com.nnhuyu.im';
export const QUALITY_JOB_MISSING_MESSAGE = '未找到 Jenkins 自动质检 Job：nn-auto-quality，请先在 Jenkins 中创建该 Job，或通过 JENKINS_NN_QA_JOB 配置正确 Job 名称。';

export const DEPLOY_TARGET_OPTIONS: { label: string; value: DeployTarget }[] = [
  { label: '蒲公英', value: 'Pgyer' },
  { label: 'TestFlight', value: 'TestFlight' },
  { label: '苹果商店', value: 'AppStore' },
];

export function filterDeployTargetOptions(options: typeof DEPLOY_TARGET_OPTIONS, permissions: {
  canPublishAppStore?: boolean;
  canPublishPgyerOrTestFlight?: boolean;
}) {
  return options.filter((option) => (
    option.value === 'AppStore' ? permissions.canPublishAppStore : permissions.canPublishPgyerOrTestFlight
  ));
}

export function publishChannelLabel(channel?: string) {
  const option = DEPLOY_TARGET_OPTIONS.find((item) => item.value === channel);
  return option?.label || channel || '';
}

export const QUALITY_SUITE_OPTIONS: { label: string; value: JenkinsQualitySuite }[] = [
  { label: 'Monkey 测试', value: 'monkey' },
  { label: '卡顿检测', value: 'stutter' },
  { label: '自定义业务编排', value: 'business_flow' },
  { label: '冒烟测试', value: 'smoke' },
  { label: 'IM 基础链路', value: 'im' },
  { label: 'RTC 基础链路', value: 'rtc' },
  { label: '全量回归', value: 'full' },
];

export const QUALITY_SUITE_GROUPS: { title: string; options: { label: string; value: JenkinsQualitySuite }[] }[] = [
  {
    title: '稳定性&性能压测：',
    options: QUALITY_SUITE_OPTIONS.filter((option) => option.value === 'monkey' || option.value === 'stutter'),
  },
  {
    title: '业务核心链路压测：',
    options: QUALITY_SUITE_OPTIONS.filter((option) => !['monkey', 'stutter', 'business_flow'].includes(option.value)),
  },
  {
    title: '自定义业务编排：',
    options: QUALITY_SUITE_OPTIONS.filter((option) => option.value === 'business_flow'),
  },
];

export const BUSINESS_FLOW_FEATURE_GROUPS: Array<{ title: string; options: Array<{ label: string; value: string }> }> = [
  {
    title: 'IM',
    options: [
      { label: '消息列表', value: 'im/home' },
      { label: '聊天详情', value: 'im/chat_detail' },
      { label: '好友搜索', value: 'im/search_friend' },
      { label: '系统消息', value: 'im/system_message' },
    ],
  },
  {
    title: '社区',
    options: [
      { label: '社区首页', value: 'community/root' },
      { label: '切换社区', value: 'community/home' },
      { label: '社区搜索', value: 'community/search' },
      { label: '成员列表', value: 'community/member_list' },
      { label: '热门社区', value: 'community/hot' },
    ],
  },
  {
    title: '语音房',
    options: [
      { label: '语音房入口', value: 'voice_room/home' },
      { label: '进房退房', value: 'voice_room/chat' },
      { label: '麦位列表', value: 'voice_room/mic_list' },
      { label: '邀请上麦', value: 'voice_room/invite_mic' },
    ],
  },
  {
    title: '我的',
    options: [
      { label: '个人主页', value: 'profile/home' },
      { label: '主题设置', value: 'profile/theme' },
      { label: '通知设置', value: 'profile/notice_settings' },
      { label: '关于页', value: 'profile/about' },
    ],
  },
  {
    title: '订单/钱包只读',
    options: [
      { label: '服务中心只读', value: 'playwith/center' },
      { label: '订单列表只读', value: 'playwith/order_list' },
      { label: '钱包只读', value: 'playwith/wallet' },
    ],
  },
];

export const MONKEY_DURATION_OPTIONS = [
  { label: '5 分钟', value: 300 },
  { label: '0.5 小时', value: 1800 },
  { label: '1 小时', value: 3600 },
  { label: '4 小时', value: 14400 },
  { label: '8 小时', value: 28800 },
];

export const STUTTER_SCENARIO_OPTIONS = [
  { label: '社区', value: 'community' },
  { label: 'IM', value: 'im' },
  { label: '语音房', value: 'voice_room' },
];

export function stutterScenarioLabel(value?: string) {
  if (['rtc', 'room', 'voice', 'voice-room', 'voiceroom', 'voice_room', '语音房'].includes(String(value || '').toLowerCase())) {
    return '语音房';
  }
  const option = STUTTER_SCENARIO_OPTIONS.find((item) => item.value === value);
  return option?.label || value || '';
}

export function shouldUseInstalledProductionApp(build?: JenkinsBuild | null) {
  return build?.publishChannel === 'TestFlight' || build?.publishChannel === 'AppStore';
}

export function getQualityReportKind(build?: JenkinsQualityBuild | null): QualityReportKind {
  const suite = String(build?.qualitySummary?.testSuite || '').trim().toLowerCase();
  if (suite === 'stutter') return 'stutter';
  if (suite === 'monkey') return 'monkey';
  if (suite === 'business_flow') return 'business_flow';
  return 'generic';
}

export function getQualityReportTitle(build?: JenkinsQualityBuild | null) {
  const kind = getQualityReportKind(build);
  if (kind === 'stutter') return '卡顿检测报告';
  if (kind === 'monkey') return 'Monkey 质检报告';
  if (kind === 'business_flow') return '业务编排质检报告';
  return '质检汇总';
}

export function qualitySuiteLabel(summary?: JenkinsQualityBuild['qualitySummary']) {
  const suite = String(summary?.testSuite || '').toLowerCase();
  if (suite === 'stutter') {
    const scenario = stutterScenarioLabel(summary?.stutterScenario);
    return scenario ? `卡顿检测 / ${scenario}` : '卡顿检测';
  }
  if (suite === 'monkey') return 'Monkey';
  if (suite === 'business_flow') return '业务编排';
  return summary?.testSuite || '-';
}

export function qualitySuiteName(suite?: string) {
  return QUALITY_SUITE_OPTIONS.find((option) => option.value === suite)?.label || suite || '质检';
}

export function normalizeQualityError(err: any) {
  const message = String(err?.error || err?.message || '');
  if (err?.status === 404 || /Not Found|page does not exist|Oops! Not Found/i.test(message)) {
    return QUALITY_JOB_MISSING_MESSAGE;
  }
  return message || '加载自动质检任务列表失败';
}
