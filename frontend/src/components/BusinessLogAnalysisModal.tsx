import { useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Input, message, Modal, Space, Table, Tabs, Tag, Tooltip, Tree, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';

const { Text } = Typography;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface ParsedBusinessLog {
  time: string;
  category: string;
  event: string;
  level: 'info' | 'warning' | 'error';
  fields: Record<string, string>;
  line: string;
}

interface ApiTimelineRow {
  key: string;
  requestTime: string;
  responseTime: string;
  api: string;
  costMs: number | null;
  retCode: string;
  retMsg: string;
  nntid: string;
  trackId: string;
  parameters: string;
  responseBody: string;
  requestLine: string;
  responseLine: string;
  fullApi: string;
  matchedRequest: boolean;
  status: 'success' | 'failed' | 'pending';
  relatedEvents?: ParsedBusinessLog[];
}

interface SemanticLogItem {
  key: string;
  time: string;
  title: string;
  detail: string;
  level: 'info' | 'warning' | 'error';
  tags: string[];
  sourceEvent?: string;
  meaningful?: boolean;
  categoryL1?: SemanticCategory;
  semanticLevel?: SemanticLevel;
  apiName?: string;
  apiPath?: string;
  apiDocUrl?: string;
}

type SemanticCategory = '生命周期' | '网络请求' | '用户交互' | '业务状态变更' | '异常与错误' | '崩溃/卡死' | '第三方SDK' | '性能';
type SemanticLevel = 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export interface BusinessLogAnalysis {
  source: string;
  total: number;
  timeRange: string;
  warnings: number;
  apiRequests: number;
  apiResponses: number;
  failedResponses: ParsedBusinessLog[];
  slowResponses: ParsedBusinessLog[];
  eventCounts: Array<{ event: string; count: number }>;
  apiStats: Array<{ api: string; requestCount: number; responseCount: number; failedCount: number; maxCostMs: number; avgCostMs: number }>;
  apiTimeline: ApiTimelineRow[];
  retCodeCounts: Array<{ retCode: string; count: number }>;
  versions: string[];
  userIds: string[];
  nntidIssueCount: number;
  suggestions: string[];
  functionGroups: Array<{ key: string; label: string; logs: ParsedBusinessLog[]; warnings: number; eventCounts: Array<{ event: string; count: number }> }>;
}

function highlightText(text: string, keyword: string): ReactNode {
  if (!keyword) {
    return text;
  }

  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const nodes: ReactNode[] = [];
  let searchStart = 0;
  let matchIndex = lowerText.indexOf(lowerKeyword, searchStart);

  while (matchIndex >= 0) {
    if (matchIndex > searchStart) {
      nodes.push(text.slice(searchStart, matchIndex));
    }
    const matchEnd = matchIndex + keyword.length;
    nodes.push(
      <mark
        key={`${matchIndex}-${matchEnd}-${nodes.length}`}
        style={{ color: '#1e1e1e', background: '#ffd666', borderRadius: 2, padding: '0 2px' }}
      >
        {text.slice(matchIndex, matchEnd)}
      </mark>
    );
    searchStart = matchEnd;
    matchIndex = lowerText.indexOf(lowerKeyword, searchStart);
  }

  if (searchStart < text.length) {
    nodes.push(text.slice(searchStart));
  }

  return nodes;
}

function decodeQuotedFieldValue(value: string): string {
  return value.replace(/\\"/g, '"');
}

function extractFieldValue(source: string, fieldName: string): string {
  if (!source) return '';
  const startToken = `${fieldName}=`;
  const startIndex = source.indexOf(startToken);
  if (startIndex < 0) return '';

  const valueStart = startIndex + startToken.length;
  if (source[valueStart] !== '"') {
    const endMatch = source.slice(valueStart).match(/(?=,\s*[A-Za-z_][\w]*=|\})/);
    const endIndex = endMatch?.index !== undefined ? valueStart + endMatch.index : source.length;
    return source.slice(valueStart, endIndex).trim();
  }

  const quotedStart = valueStart + 1;
  let searchIndex = quotedStart;
  while (searchIndex < source.length) {
    const quoteIndex = source.indexOf('"', searchIndex);
    if (quoteIndex < 0) break;
    const tail = source.slice(quoteIndex + 1);
    if (/^\s*(?:,\s*[A-Za-z_][\w]*=|\}\s*$)/.test(tail)) {
      return decodeQuotedFieldValue(source.slice(quotedStart, quoteIndex));
    }
    searchIndex = quoteIndex + 1;
  }
  return '';
}

function parseFields(fieldsText: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w]*)=("(?:\\.|[^"])*"|[^,}]+)/g;
  let match = pattern.exec(fieldsText);
  while (match) {
    const rawValue = match[2].trim();
    fields[match[1]] = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1).replace(/\\"/g, '"')
      : rawValue;
    match = pattern.exec(fieldsText);
  }
  const response = extractFieldValue(fieldsText, 'response');
  if (response) {
    fields.response = response;
  }
  return fields;
}

function normalizeApiKey(api?: string): string {
  if (!api) return '-';
  try {
    const parsed = new URL(api.replace(/^"|"$/g, ''));
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return api.split('?')[0] || api;
  }
}

function normalizeApiPath(api?: string): string {
  if (!api) return '-';
  try {
    const parsed = new URL(api.replace(/^"|"$/g, ''));
    return `${parsed.pathname}${parsed.search || ''}`;
  } catch {
    const value = api.replace(/^"|"$/g, '');
    return value.replace(/^https?:\/\/[^/]+/i, '') || value;
  }
}

function normalizeApiDocsSearchPath(api?: string): string {
  const path = normalizeApiPath(api);
  if (!path || path === '-') return '';
  return path.split('?')[0];
}

function buildApiDocsSearchUrl(api?: string): string {
  const path = normalizeApiDocsSearchPath(api);
  if (!path) return '';
  return `/api-docs?q=${encodeURIComponent(path)}`;
}

function humanizeEventName(event: string): string {
  const known: Record<string, string> = {
    api_request: '发起接口请求',
    api_response: '收到接口响应',
    api_failure: '接口请求失败',
    api_decode_failure: '接口响应解析失败',
    raw_log: 'SDK 原始日志',
    ws_channel_outside_subscribe_deferred: '频道订阅延后',
    im_get_conversation_failed: '获取 IM 会话失败',
    im_join_group_failed: '加入 IM 群失败',
    rtc_stream_event_failed: 'RTC 流事件异常',
    rtc_sig_info_fetch_result: '获取 RTC 签名结果',
    rtc_join_room_start: '开始调用 RTC SDK 加入房间',
    rtc_audio_route_snapshot: '记录 RTC 音频路由状态',
    rtc_stream_mode_set: '设置 RTC 流模式',
    rtc_leave_room_cleanup_start: '开始清理离房状态',
    rtc_leave_room_cleanup_complete: '离房清理完成',
    rtc_leave_room: '离开 RTC 房间',
    audio_effect_preload_finished: '音效预加载完成',
    voice_room_join_rtc_result: '语音房加入 RTC 结果',
    voice_room_rtc_join_start: '开始加入语音房 RTC',
    voice_room_screen_share_state_change: '语音房屏幕共享状态变化',
    community_hall_group_join_result: '社区大厅入群结果',
  };
  if (known[event]) return known[event];
  if (!event || event === 'raw_log') return '普通日志';
  return humanizeUnknownEventName(event);
}

function splitIdentifierWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./-]+/g, ' ')
    .split(/\s+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function humanizeUnknownEventName(event: string): string {
  const words = splitIdentifierWords(event);
  if (!words.length) return event;
  const dictionary: Record<string, string> = {
    api: 'API',
    im: 'IM',
    rtc: 'RTC',
    sdk: 'SDK',
    websocket: 'WebSocket',
    ws: 'WebSocket',
    login: '登录',
    logout: '退出登录',
    auth: '鉴权',
    sig: '签名',
    signature: '签名',
    token: 'token',
    session: '会话',
    user: '用户',
    compare: '比对',
    consume: '耗时',
    cost: '耗时',
    start: '开始',
    end: '结束',
    result: '结果',
    status: '状态',
    success: '成功',
    succeed: '成功',
    failed: '失败',
    fail: '失败',
    failure: '失败',
    error: '错误',
    warning: '警告',
    fetch: '获取',
    get: '获取',
    query: '查询',
    load: '加载',
    update: '更新',
    change: '变化',
    send: '发送',
    receive: '接收',
    dispatch: '分发',
    callback: '回调',
    reconcile: '对账',
    skip: '跳过',
    subscribe: '订阅',
    deferred: '延后',
    outside: '外部',
    join: '加入',
    leave: '离开',
    enter: '进入',
    room: '房间',
    channel: '频道',
    server: '服务器',
    group: '群组',
    conversation: '会话',
    message: '消息',
    msg: '消息',
    community: '社区',
    hall: '大厅',
    home: '首页',
    voice: '语音',
    audio: '音频',
    effect: '音效',
    preload: '预加载',
    finished: '完成',
    finish: '完成',
    screen: '屏幕',
    share: '共享',
    stream: '流',
    mode: '模式',
    set: '设置',
    cleanup: '清理',
    route: '路由',
    snapshot: '快照',
    reconnect: '重连',
    connect: '连接',
    disconnect: '断开',
    heartbeat: '心跳',
  };
  const translated = words.map((word) => dictionary[word] || word).join('');
  return translated || event;
}

function chineseObjectFromWords(words: string[]): string {
  const text = words.join(' ');
  const objects: Array<[RegExp, string]> = [
    [/tmlnfo|tm info|tm/, 'TM 信息'],
    [/personal topic server|topic server/, '个人话题服务器'],
    [/query not empty/, '非空频道数据'],
    [/walkind|walk in|team list/, '组队列表'],
    [/page query|page/, '分页列表'],
    [/enter server balance|server balance/, '入服负载配置'],
    [/role user ids|role users?/, '角色用户'],
    [/user channel and member|channel member/, '用户频道和成员信息'],
    [/task center|points monthly|points/, '任务中心积分'],
    [/label cache/, '标签缓存'],
    [/plugin user number/, '插件用户数量'],
    [/conversation/, 'IM 会话'],
    [/session/, 'IM Session'],
    [/login status/, '登录状态'],
    [/sig|signature/, '签名信息'],
    [/audio session/, '音频会话'],
    [/screen share/, '屏幕共享'],
    [/websocket/, 'WebSocket 连接'],
    [/subscribe/, '订阅结果'],
    [/join/, '加入结果'],
  ];
  return objects.find(([pattern]) => pattern.test(text))?.[1] || '';
}

function chineseActionFromWords(words: string[]): string {
  const text = words.join(' ');
  if (/enter|join/.test(text)) return '进入/加入';
  if (/query|page|list/.test(text)) return '查询';
  if (/get|fetch/.test(text)) return '获取';
  if (/auth|config/.test(text)) return '读取配置';
  if (/update|change/.test(text)) return '更新';
  if (/send/.test(text)) return '发送';
  if (/activate/.test(text)) return '激活';
  if (/deactivate/.test(text)) return '停用';
  return '处理';
}

function humanizeApiOperationName(path: string): string {
  const normalized = path.split('?')[0].replace(/\/+$/, '');
  const lastMeaningfulSegment = normalized
    .split('/')
    .filter((segment) => segment && !/^\d+$/.test(segment) && !/^v\d+$/i.test(segment))
    .pop() || '';
  const words = splitIdentifierWords(lastMeaningfulSegment);
  if (!words.length) return '';

  const dictionary: Record<string, string> = {
    get: '获取',
    query: '查询',
    find: '查询',
    list: '列表',
    page: '分页',
    check: '校验',
    validate: '校验',
    enter: '进入',
    leave: '离开',
    new: '新',
    user: '用户',
    info: '信息',
    by: '通过',
    token: 'Token',
    guild: '公会',
    channel: '频道',
    member: '成员',
    msg: '消息',
    message: '消息',
    client: '客户端',
    banner: 'Banner',
    rank: '排名',
    black: '黑名单',
    ban: '封禁',
    room: '房间',
    after: '后',
    notice: '公告',
    system: '系统',
    inform: '通知',
    simple: '简要',
    ids: 'ID列表',
    id: 'ID',
  };

  if (words.includes('by')) {
    const byIndex = words.indexOf('by');
    const before = words.slice(0, byIndex).map((word) => dictionary[word] || word).join('');
    const after = words.slice(byIndex + 1).map((word) => dictionary[word] || word).join('');
    return after && before ? `通过${after}${before}` : before || after;
  }

  const translated = words.map((word) => dictionary[word] || word).join('');
  return /[a-z]{3,}/i.test(translated) ? '' : translated;
}

function humanizeApiPath(path: string): string {
  const normalized = path.split('?')[0];
  const known: Array<[RegExp, string]> = [
    [/\/nchannel\/channel\/business\/enterPersonalTopicServerByIdV2/i, '进入个人话题服务器，通常用于社区首页或话题频道初始化'],
    [/\/nchannel\/server\/channel\/queryNotEmpty/i, '查询当前可展示的非空频道'],
    [/\/nchannel\/channel\/business\/\d+\/newAllKindTeamListByServerId/i, '拉取指定社区服务器下的组队列表'],
    [/\/nchannel\/server\/channel\/pageQuery/i, '分页查询社区频道列表'],
    [/\/nchannel\/server\/room\/page\/config\/v1\/enterServerBalanceV1/i, '读取进入服务器时的负载均衡配置'],
    [/\/nchannel\/channel\/auth\/config\/server\/role\/userIds/i, '查询服务器角色对应的用户列表'],
    [/\/nchannel\/channel\/business\/getUserChannelAndMemberByUserIds/i, '查询用户所在频道和成员信息'],
    [/\/u-mobile\/api\/v1\/taskCenter\/points\/monthly/i, '查询用户本月任务中心积分'],
    [/\/nchannel\/channel\/business\/\d+\/getLabelCacheByServerId/i, '读取社区服务器标签缓存'],
    [/\/nchannel\/channel\/business\/getPluginUserNumber/i, '查询插件关联用户数量'],
    [/\/ncoperation\/api\/v2\/TmInfo\/getTmInfo/i, '获取运营侧 TM 配置信息'],
    [/\/user-query\/user\/info\/batchQuery/i, '批量查询用户资料'],
  ];
  const matched = known.find(([pattern]) => pattern.test(normalized));
  if (matched) return matched[1];
  const operationName = humanizeApiOperationName(normalized);
  if (operationName) return operationName;
  const words = splitIdentifierWords(normalized);
  const object = chineseObjectFromWords(words);
  const action = chineseActionFromWords(words);
  return object ? `${action}${object}` : '';
}

function humanizeSdkFunction(fn: string): string {
  const words = splitIdentifierWords(fn);
  const text = words.join(' ');
  const known: Array<[RegExp, string]> = [
    [/lim get login status/, '检查 IM 登录态'],
    [/get main login status|login status/, '检查 SDK 登录态'],
    [/lim conv get conv info|get conv info/, '读取 IM 会话信息'],
    [/get session info/, '读取会话 Session 信息'],
    [/async write/, '向 SDK 网络连接写入数据'],
    [/send success/, '消息或数据发送成功'],
    [/initialize with auth|initialize/, '初始化 SDK 鉴权环境'],
    [/auth manager.*fetch config|fetch config/, '获取 RTC 节点配置'],
    [/join room with auth/, '发起 RTC 鉴权进房'],
    [/async join room/, '启动 RTC 异步进房流程'],
    [/request room controller/, '请求 RTC 房间控制器'],
    [/send community subscribe request/, '发送 RTC 社区订阅请求'],
    [/send channel outside subscribe request/, '发送 RTC 外部频道订阅请求'],
    [/calculate audio stutter data/, '统计 RTC 音频卡顿数据'],
    [/beast http connection|http connection/, 'RTC 信令连接状态变化'],
    [/dns resolve|resolve dns/, '解析 RTC 信令域名'],
    [/rtc sig info|sig info/, '获取 RTC 进房签名信息'],
    [/join rtc|join/, '加入 RTC 房间'],
    [/stream event/, '处理 RTC 音视频流事件'],
    [/audio session/, '处理系统音频会话'],
    [/websocket|socket/, '处理 SDK WebSocket 连接'],
  ];
  const matched = known.find(([pattern]) => pattern.test(text));
  if (matched) return matched[1];
  const object = chineseObjectFromWords(words);
  const action = chineseActionFromWords(words);
  return object ? `${action}${object}` : '';
}

function extractSdkCandidatePhrase(plain: string, fn: string): string {
  const afterTag = plain.match(/\]\s*:?\s*([^{}]+)/)?.[1] || plain;
  const withoutLocation = afterTag
    .replace(/^\[[^\]]+\]\s*/g, '')
    .replace(/\([^)]*\.(?:cc|cpp|h|hpp):\d+\)/g, '')
    .replace(/\{[\s\S]*$/, '')
    .replace(/\b[A-Za-z_][\w]*[:=]\s*[^,，\s]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (withoutLocation && /[A-Za-z]/.test(withoutLocation)) return withoutLocation;
  return fn;
}

function translateTechnicalPhrase(phrase: string): string {
  const words = splitIdentifierWords(phrase);
  const text = words.join(' ');
  const patterns: Array<[RegExp, string]> = [
    [/send.*community.*subscribe.*request/, '发送 RTC 社区订阅请求'],
    [/send.*channel.*outside.*subscribe.*request/, '发送 RTC 外部频道订阅请求'],
    [/calculate.*audio.*stutter.*data/, '统计 RTC 音频卡顿数据'],
    [/play.*effect.*internal|play.*effect/, '播放音效'],
    [/stop.*effect.*internal|stop.*effect|end.*buffer.*stop/, '停止播放音效'],
    [/transport/, 'RTC 传输统计'],
    [/connect.*state/, '连接状态变化'],
    [/fetch.*config/, '获取配置'],
    [/join.*room/, '加入房间'],
    [/request.*room.*controller/, '请求房间控制器'],
    [/callback|on response|response/, '处理回调结果'],
    [/login.*status/, '检查登录态'],
    [/audio.*stutter/, '音频卡顿统计'],
    [/mute.*audio.*producer/, '设置音频流静音'],
  ];
  const matched = patterns.find(([pattern]) => pattern.test(text));
  if (matched) return matched[1];
  const object = chineseObjectFromWords(words);
  const action = chineseActionFromWords(words);
  if (object) return `${action}${object}`;
  const translated = humanizeUnknownEventName(phrase);
  return /[a-z]{3,}/i.test(translated) ? '' : translated;
}

function autoTranslateSdkLog(plain: string, fn: string, category: string, factText: string): { title: string; detail: string } {
  const phrase = extractSdkCandidatePhrase(plain, fn);
  const title = translateTechnicalPhrase(phrase) || translateTechnicalPhrase(fn);
  if (!title) {
    return {
      title: `${category} 普通日志`,
      detail: factText || '未识别出明确业务动作，仅保留为普通日志。',
    };
  }
  return {
    title,
    detail: factText || `${title}。`,
  };
}

function extractSdkUsefulFacts(plain: string): string[] {
  const facts: string[] = [];
  const result = plain.match(/\bresult[:=]\s*(-?\d+)/i)?.[1];
  const errorMessage = plain.match(/\berror_message[:=]\s*([^,\]\s]+)/i)?.[1];
  const bytes = plain.match(/\bbytes[:=]\s*(\d+)/i)?.[1];
  const callId = plain.match(/\bcall_id[:=]\s*(-?\d+)/i)?.[1];
  const roomId = plain.match(/\broom_id[:=]\s*([A-Za-z0-9_-]+)/i)?.[1];
  const peerId = plain.match(/\bpeer_id[:=]\s*([A-Za-z0-9_-]+)/i)?.[1];
  const producerId = plain.match(/\bproducer_id[:=]\s*([A-Za-z0-9_-]+)/i)?.[1];
  const mute = plain.match(/\bmute[:=]\s*(-?\d+)/i)?.[1];
  const joinCost = plain.match(/\bjoin_succeed_since_start_ms[:=]\s*(\d+)/i)?.[1];
  const streamEvent = plain.match(/\bstream event\s*:\s*(-?\d+)/i)?.[1];
  const size = plain.match(/\bsize[:=]\s*(\d+)/i)?.[1];
  const mode = plain.match(/\bmode[:=]\s*(-?\d+)/i)?.[1];
  const bytesSent = plain.match(/\bbytes_sent[:=]\s*(\d+)/i)?.[1];
  const packetsSent = plain.match(/\bpackets_sent[:=]\s*(\d+)/i)?.[1];
  const bytesReceived = plain.match(/\bbytes_received[:=]\s*(\d+)/i)?.[1];
  const packetsReceived = plain.match(/\bpackets_received[:=]\s*(\d+)/i)?.[1];
  const rtt = plain.match(/\bice_rtt[:=]\s*([0-9.]+)/i)?.[1];
  const effectId = plain.match(/\beffect_id[:=]\s*(\d+)/i)?.[1];
  const failed = /\bfail(?:ed)?\b|success\s*[:=]\s*false/i.test(plain);
  if (failed) facts.push('执行失败');
  if (result !== undefined) facts.push(`结果码 ${result}`);
  if (errorMessage && errorMessage !== ':') facts.push(`错误信息 ${errorMessage}`);
  if (bytes) facts.push(`发送 ${bytes} 字节`);
  if (callId) facts.push(`调用 ID ${callId}`);
  if (roomId) facts.push(`房间 ${roomId}`);
  if (peerId) facts.push(`用户 ${peerId}`);
  if (producerId) facts.push(`音频流 ${producerId}`);
  if (mute !== undefined) facts.push(`静音=${mute === '1' ? '是' : '否'}`);
  if (joinCost) facts.push(`入房耗时 ${joinCost}ms`);
  if (streamEvent !== undefined) facts.push(`流事件 ${streamEvent}`);
  if (size) facts.push(`数量 ${size}`);
  if (mode !== undefined) facts.push(`模式 ${mode}`);
  if (bytesSent) facts.push(`发送 ${bytesSent} 字节`);
  if (packetsSent) facts.push(`发送包 ${packetsSent}`);
  if (bytesReceived) facts.push(`接收 ${bytesReceived} 字节`);
  if (packetsReceived) facts.push(`接收包 ${packetsReceived}`);
  if (rtt) facts.push(`RTT ${rtt}s`);
  if (effectId) facts.push(`音效 ${effectId}`);
  return facts;
}

function summarizeSdkPlainText(plain: string, fn: string, category: string): { title: string; detail: string } {
  const meaning = humanizeSdkFunction(fn);
  const facts = extractSdkUsefulFacts(plain);
  const factText = facts.length ? `关键字段：${facts.join('，')}。` : '';
  const roomId = plain.match(/\broom_id[:=]\s*([A-Za-z0-9_-]+)/i)?.[1];
  const result = plain.match(/\bresult[:=]\s*(-?\d+)/i)?.[1];
  const resultDetail = result !== undefined ? `返回结果码 ${result}。${factText}` : factText;
  const connectState = plain.match(/Connect state from \[([^\]]+)\] to \[([^\]]+)\]/i);

  if (/login status|getMainLoginStatus|LIMGetLoginStatus/i.test(`${fn} ${plain}`)) {
    return {
      title: category === 'IM SDK' ? '检查 IM 登录态' : '检查 SDK 登录态',
      detail: resultDetail || 'SDK 返回当前登录状态。',
    };
  }
  if (connectState) {
    const [, fromState, toState] = connectState;
    const isConnected = /connected/i.test(toState);
    const isConnecting = /connecting|dns resolving|dns resolved/i.test(toState);
    return {
      title: isConnected ? 'RTC 信令连接已建立' : isConnecting ? 'RTC 信令连接进行中' : 'RTC 信令连接状态变化',
      detail: `信令连接从 ${fromState} 变为 ${toState}。${isConnected ? '连接建立后可继续鉴权和加入房间。' : ''}`,
    };
  }
  if (/AuthManager.*FetchConfig succeeded|FetchConfig succeeded/i.test(plain)) {
    return {
      title: '获取 RTC 节点配置成功',
      detail: factText || 'RTC SDK 已拿到边缘节点或信令配置，可以继续进房流程。',
    };
  }
  if (/JoinRoomWithAuth/i.test(plain)) {
    return {
      title: roomId ? `发起加入 RTC 房间 ${roomId}` : '发起加入 RTC 房间',
      detail: factText || 'RTC SDK 开始带鉴权信息加入房间。',
    };
  }
  if (/AsyncJoinRoom|RequestRoomController/i.test(plain)) {
    return {
      title: '启动 RTC 进房流程',
      detail: roomId ? `开始异步加入房间 ${roomId}。` : factText || 'RTC SDK 已启动异步进房流程。',
    };
  }
  if (/\[Transport\]|Transport/i.test(fn) || /\[Transport\]/i.test(plain)) {
    const direction = plain.match(/\bdirection[:=]\s*([A-Za-z]+)/i)?.[1];
    return {
      title: direction === 'recv' ? 'RTC 下行传输统计' : direction === 'send' ? 'RTC 上行传输统计' : 'RTC 传输统计',
      detail: factText || 'RTC SDK 上报音视频传输统计。',
    };
  }
  if (/EffectPlayerImp|PlayEffectInternal|StopEffectInternal|effect_id/i.test(`${fn} ${plain}`)) {
    const effectId = plain.match(/\beffect_id[:=]\s*(\d+)/i)?.[1];
    if (/StopEffectInternal|end of buffer|stop/i.test(plain)) {
      return {
        title: effectId ? `停止播放音效 ${effectId}` : '停止播放音效',
        detail: effectId ? `音效 ${effectId} 已播放到结尾或被停止。` : factText || 'RTC SDK 停止播放音效。',
      };
    }
    if (/PlayEffectInternal|\bPlay\b/i.test(plain)) {
      return {
        title: effectId ? `播放音效 ${effectId}` : '播放音效',
        detail: factText || 'RTC SDK 开始播放音效。',
      };
    }
    return {
      title: '音效播放状态变化',
      detail: factText || 'RTC SDK 上报音效播放状态。',
    };
  }
  if (/Succeed to \[JOIN\]/i.test(plain)) {
    return {
      title: '已加入 RTC 房间',
      detail: factText || 'RTC SDK 返回进房成功。',
    };
  }
  if (/join_succeed_since_start_ms/i.test(plain)) {
    return {
      title: 'RTC 入房成功耗时',
      detail: factText || 'RTC SDK 上报入房成功耗时。',
    };
  }
  if (/stream event/i.test(plain)) {
    return {
      title: /succeed\s*:\s*1|success\s*[:=]\s*true/i.test(plain) ? 'RTC 流事件处理成功' : 'RTC 流事件状态变化',
      detail: factText || 'RTC SDK 上报音视频流事件。',
    };
  }
  if (/producer_id/i.test(plain) || /\bMuteAudioProducer\b/i.test(plain)) {
    return {
      title: '上行音频流状态变化',
      detail: factText || 'RTC SDK 记录本端音频流或静音状态。',
    };
  }
  if (/Succeed to send bytes/i.test(plain)) {
    return {
      title: 'WebSocket 数据发送成功',
      detail: factText || 'SDK 网络层已把数据发送出去。',
    };
  }
  if (roomId && /^(room_id|done|sdk 日志)$/i.test(fn)) {
    return {
      title: 'RTC 房间上下文',
      detail: `当前 RTC SDK 操作关联房间 ${roomId}。`,
    };
  }
  if (/^done$/i.test(fn) || /^\s*done\.?\s*$/i.test(plain)) {
    return {
      title: 'SDK 操作完成',
      detail: '无明确业务含义。SDK 完成态普通流水，默认不作为问题线索。',
    };
  }
  if (/CircularBuffer|gain_|operator=/i.test(plain)) {
    return {
      title: '音频缓冲内部状态',
      detail: '无明确业务含义。SDK 音频缓冲内部调试日志，默认不作为问题线索。',
    };
  }
  if (meaning) {
    return {
      title: meaning,
      detail: factText || `${meaning}。`,
    };
  }
  if (/doCallback/i.test(fn) || /doCallback/i.test(plain)) {
    return {
      title: 'SDK 回调处理完成',
      detail: resultDetail || 'SDK 完成一次内部回调处理。',
    };
  }
  if (/OnResponse/i.test(fn) || /\bOnResponse\b/i.test(plain)) {
    return {
      title: 'SDK 请求返回结果',
      detail: resultDetail || 'SDK 返回了一次请求结果。',
    };
  }
  if (/tcp client not connected|tcp.*already closed|not connected|already closed/i.test(plain)) {
    return {
      title: 'IM 长连接已断开或已关闭',
      detail: 'IM SDK 发现 TCP 连接不可用。可能导致消息发送失败、收不到新消息，通常需要等待重连或重新登录 IM。',
    };
  }
  if (/tcp/i.test(plain) && /fail|error|closed|disconnect/i.test(plain)) {
    return {
      title: 'IM TCP 连接异常',
      detail: factText || 'IM SDK 的 TCP 长连接出现异常，可能影响实时消息收发。',
    };
  }
  if (/websocket|socket|connection/i.test(plain)) {
    if (/reconnect|retry|restore/i.test(plain)) {
      return {
        title: '长连接正在重连',
        detail: factText || 'SDK 正在恢复实时连接，期间消息可能延迟到达。',
      };
    }
    if (/disconnect|closed|close|lost|broken/i.test(plain)) {
      return {
        title: '长连接已断开',
        detail: factText || 'SDK 实时连接断开，可能影响消息、订阅和在线状态同步。',
      };
    }
    if (/connected|connect success|connect succeeded|open/i.test(plain)) {
      return {
        title: '长连接已建立',
        detail: factText || 'SDK 实时连接已建立，可以接收实时消息和订阅推送。',
      };
    }
    if (/subscribe|subscription|channel/i.test(plain)) {
      return {
        title: '实时频道订阅变化',
        detail: factText || 'SDK 正在处理实时频道订阅，订阅成功后才能收到对应推送。',
      };
    }
    if (/heartbeat|ping|pong/i.test(plain)) {
      return {
        title: '长连接心跳',
        detail: factText || 'SDK 正在维持实时连接心跳，用来确认连接仍然可用。',
      };
    }
    if (/send|write/i.test(plain) && /fail|error|timeout/i.test(plain)) {
      return {
        title: '长连接发送失败',
        detail: factText || 'SDK 通过长连接发送数据失败，可能影响消息或订阅请求。',
      };
    }
    if (/receive|read/i.test(plain) && /fail|error|timeout/i.test(plain)) {
      return {
        title: '长连接接收失败',
        detail: factText || 'SDK 从长连接读取数据失败，可能影响实时消息到达。',
      };
    }
    return {
      title: '长连接普通流水',
      detail: '无明确业务含义。SDK 网络连接普通流水，默认不作为问题线索。',
    };
  }
  return autoTranslateSdkLog(plain, fn, category, factText);
}

function compactFieldValue(value?: string, maxLength = 80): string {
  const text = String(value || '').trim();
  if (!text || text === '-') return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function semanticFields(fields: Record<string, string>): string[] {
  const labels: Array<[string, string]> = [
    ['success', '结果'],
    ['retCode', 'retCode'],
    ['code', 'code'],
    ['retMsg', '消息'],
    ['errorMsg', '消息'],
    ['reason', '原因'],
    ['method', '方法'],
    ['roomId', '房间'],
    ['channelId', '频道'],
    ['conversationId', '会话'],
    ['sessionId', 'Session'],
    ['messageId', '消息ID'],
    ['nntid', 'nntid'],
    ['trackId', 'trackId'],
  ];
  return labels
    .map(([key, label]) => {
      const value = compactFieldValue(fields[key]);
      if (!value) return '';
      if (key === 'success') return `${label}=${value === 'true' ? '成功' : value === 'false' ? '失败' : value}`;
      return `${label}=${value}`;
    })
    .filter(Boolean);
}

function semanticStatusText(level: ParsedBusinessLog['level'], fields: Record<string, string>): string {
  if (String(fields.success || '').toLowerCase() === 'false') return '失败';
  const retCode = fields.retCode || fields.code;
  if (retCode && !['0', '100', '200', '61000'].includes(retCode)) return '异常';
  return level === 'info' ? '正常' : '需关注';
}

function boolText(value?: string): string {
  const text = String(value || '').toLowerCase();
  if (text === 'true') return '是';
  if (text === 'false') return '否';
  return value || '-';
}

function rtcFieldSummary(fields: Record<string, string>, keys: Array<[string, string]>): string {
  return keys
    .map(([key, label]) => {
      const value = compactFieldValue(fields[key], 60);
      return value ? `${label}=${value}` : '';
    })
    .filter(Boolean)
    .join('，');
}

const commonSemanticFieldLabels: Array<[string, string]> = [
  ['success', '结果'],
  ['retCode', 'retCode'],
  ['code', 'code'],
  ['retMsg', '消息'],
  ['errorMsg', '错误信息'],
  ['reason', '原因'],
  ['costMs', '耗时'],
  ['userId', '用户'],
  ['uid', 'UID'],
  ['nnNumber', 'NN 号'],
  ['roomId', '房间'],
  ['channelId', '频道'],
  ['serverId', '服务器'],
  ['groupId', '群组'],
  ['conversationId', '会话'],
  ['sessionId', 'Session'],
  ['messageId', '消息'],
  ['msgId', '消息'],
  ['method', '方法'],
  ['url', '地址'],
  ['path', '路径'],
  ['status', '状态'],
  ['state', '状态'],
  ['token', 'token'],
  ['version', '版本'],
  ['nntid', 'nntid'],
  ['trackId', 'trackId'],
];

function readableFieldValue(key: string, value?: string): string {
  const text = compactFieldValue(value, key === 'token' ? 24 : 80);
  if (!text) return '';
  if (key === 'success' && text === 'true') return '';
  if ((key === 'retCode' || key === 'code') && ['0', '100', '200', '61000'].includes(text)) return '';
  if ((key === 'retMsg' || key === 'errorMsg') && /^(操作成功|成功|success|ok)$/i.test(text)) return '';
  if (key === 'success') return text === 'true' ? '成功' : text === 'false' ? '失败' : text;
  if (key === 'costMs') return `${text}ms`;
  return text;
}

function fieldSummary(fields: Record<string, string>, keys: Array<[string, string]> = commonSemanticFieldLabels, maxItems = 8): string {
  return keys
    .map(([key, label]) => {
      const value = readableFieldValue(key, fields[key]);
      return value ? `${label} ${value}` : '';
    })
    .filter(Boolean)
    .slice(0, maxItems)
    .join('，');
}

function stripSemanticTitlePrefix(title: string): string {
  return title.replace(/^[A-Za-z0-9_+\-\s\u4e00-\u9fa5]+：\s*/, '').trim();
}

function getSemanticLevel(log: ParsedBusinessLog): SemanticLevel {
  if (/fatal|crash|anr|卡死|崩溃/i.test(log.event) || /\b(?:fatal|crash|anr)\b/i.test(log.line)) return 'FATAL';
  if (log.level === 'error' || /error|exception|failed|failure|请求失败|解析失败/i.test(log.event)) return 'ERROR';
  if (log.level === 'warning') return 'WARN';
  return 'INFO';
}

function getSemanticCategory(log: ParsedBusinessLog): SemanticCategory {
  const text = `${log.category} ${log.event} ${log.line}`;
  if (/crash|anr|fatal|崩溃|卡死/i.test(text)) return '崩溃/卡死';
  if (/fail|error|exception|warning|auth failed|not connected|already closed|请求失败|解析失败/i.test(text)) return '异常与错误';
  if (/api_|http|urlsession|request|response|websocket|socket|tcp|network|connect|heartbeat|ping|pong/i.test(text)) return '网络请求';
  if (/click|tap|gesture|input|button|用户点击/i.test(text)) return '用户交互';
  if (/launch|foreground|background|lifecycle|viewdid|页面|启动/i.test(text)) return '生命周期';
  if (/cost|耗时|fps|memory|性能/i.test(text)) return '性能';
  if (/sdk|nnrtc|nnimsdk|push|third/i.test(text)) return '第三方SDK';
  return '业务状态变更';
}

function truncateSummary(title: string): string {
  const text = stripSemanticTitlePrefix(title).replace(/[，。；;,.]\s*$/, '').trim();
  return text.length > 30 ? `${text.slice(0, 30)}...` : text;
}

function isSkippableRawLog(log: ParsedBusinessLog, detail: string): boolean {
  const text = `${log.event} ${log.line} ${detail}`;
  if (log.level !== 'info') return false;
  return /AudioProcessing::(?:Config|ApplyConfig)|CircularBuffer|operator=|gain_|do_read\s*:|async_write\s*:|recv im server len\s*:\s*1|send success\s*:\s*1/i.test(text);
}

function makeSemanticLogItem(log: ParsedBusinessLog, title: string, detail: string, tags: string[], meaningful = true): SemanticLogItem {
  const normalizedDetail = detail.replace(/。?$/, '。');
  return {
    key: `${log.time}-${log.event}-${log.line}`,
    time: log.time || '-',
    title: truncateSummary(title),
    detail: normalizedDetail,
    level: log.level,
    tags,
    sourceEvent: log.event,
    meaningful: meaningful && !isSkippableRawLog(log, normalizedDetail),
    categoryL1: getSemanticCategory(log),
    semanticLevel: getSemanticLevel(log),
  };
}

function semanticEventLabel(event: string): string {
  const label = humanizeEventName(event);
  return compactFieldValue(label === '普通日志' ? event : label, 42);
}

function moduleEventTitle(_moduleName: string, _event: string, meaning: string): string {
  return meaning;
}

function fallbackModuleExplanation(log: ParsedBusinessLog, moduleName: string, status: string, hint: string): SemanticLogItem {
  const summary = fieldSummary(log.fields);
  return makeSemanticLogItem(
    log,
    semanticEventLabel(log.event),
    summary ? `${status}。${hint}关键字段：${summary}。` : `${status}。${hint || '无关键字段。'}`,
    [moduleName, status],
    Boolean(summary) || status !== '正常'
  );
}

function removeLowValueSemanticPhrases(detail: string): string {
  return detail
    .replace(/^正常。/, '')
    .replace(/^(信息|调试)日志。/, '')
    .replace(/这条日志和/g, '')
    .replace(/这条日志用于/g, '用于')
    .replace(/用于判断/g, '判断')
    .replace(/关键字段：/g, '涉及 ')
    .replace(/涉及\s*。/g, '')
    .trim();
}

function filterSemanticItems(items: SemanticLogItem[]): SemanticLogItem[] {
  return items
    .map((item) => ({ ...item, detail: removeLowValueSemanticPhrases(item.detail) || item.detail }));
}

function getSemanticDisplayTag(item: SemanticLogItem): string {
  const moduleTag = item.tags[0];
  if (moduleTag === 'IM SDK' || moduleTag === 'RTC SDK') return moduleTag;
  return item.categoryL1 || moduleTag || '';
}


function extractSdkPlainText(line: string): string {
  return line
    .replace(/^\[(?:IMSDK|RTCSDK)\]\s*/i, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/^\[(?:info|debug|warning|error)\]\s*/i, '')
    .replace(/^\[thread\s+\d+\]\s*/i, '')
    .trim();
}

function extractSdkFunction(line: string): string {
  const plain = extractSdkPlainText(line);
  const invalidNames = new Set(['size', 'mode', 'result', 'done', 'room_id', 'peer_id', 'producer_id', 'call_id', 'success', 'error_message', 'transport', 'effectplayerimp']);
  const bracketNames = [...plain.matchAll(/\[([A-Za-z_][\w:<>~.-]+)\]/g)]
    .map((item) => item[1])
    .filter((name) => !invalidNames.has(name.toLowerCase()))
    .filter((name) => /[A-Z_]/.test(name) && !/^nnrtc-[iwe]$/i.test(name));
  if (bracketNames.length) return bracketNames[bracketNames.length - 1];

  const functionCall = [...plain.matchAll(/\b([A-Za-z_][\w:<>~.-]+)\s*\(/g)]
    .map((item) => item[1])
    .filter((name) => !invalidNames.has(name.toLowerCase()));
  if (functionCall.length) return functionCall[functionCall.length - 1];

  const afterBracket = [...plain.matchAll(/\]\s*([A-Za-z_][\w:<>~.-]+)\b/g)]
    .map((item) => item[1])
    .filter((name) => !invalidNames.has(name.toLowerCase()));
  return afterBracket[afterBracket.length - 1] || 'SDK 日志';
}

function makeSdkSemanticItem(log: ParsedBusinessLog, title: string, detail: string, tags: string[], meaningful: boolean): SemanticLogItem {
  const normalizedDetail = detail.replace(/。?$/, '。');
  const categoryL1: SemanticCategory = /not connected|closed|fail|error|异常|失败/i.test(`${title} ${detail}`) ? '异常与错误' : /websocket|socket|tcp|连接|心跳|发送|接收/i.test(`${title} ${detail}`) ? '网络请求' : '第三方SDK';
  return {
    key: `${log.time}-${log.line}`,
    time: log.time || '-',
    title: truncateSummary(title),
    detail: normalizedDetail,
    level: log.level,
    tags,
    sourceEvent: log.event,
    meaningful: meaningful && !isSkippableRawLog(log, normalizedDetail),
    categoryL1,
    semanticLevel: getSemanticLevel(log),
  };
}

function explainSdkLog(log: ParsedBusinessLog): SemanticLogItem {
  const isRtc = log.category === 'RTC SDK';
  const plain = extractSdkPlainText(log.line);
  const fn = extractSdkFunction(log.line);
  const levelMatch = log.line.match(/\[(info|debug|warning|error)\]/i)?.[1]?.toLowerCase();
  const levelText = levelMatch === 'debug' ? '调试' : levelMatch === 'warning' ? '警告' : levelMatch === 'error' ? '错误' : '信息';
  const category = isRtc ? 'RTC SDK' : 'IM SDK';
  const summary = summarizeSdkPlainText(plain, fn, category);
  return makeSdkSemanticItem(
    log,
    summary.title,
    `${levelText}日志。${summary.detail}`,
    [category, levelText],
    log.level !== 'info' || !/无明确业务含义|普通流水/.test(summary.detail)
  );
}

function explainRtcBusinessLog(log: ParsedBusinessLog): SemanticLogItem {
  const fields = log.fields;
  const status = semanticStatusText(log.level, fields);
  let title = humanizeEventName(log.event);
  let detail = '';

  switch (log.event) {
    case 'audio_effect_preload_finished':
      title = '音效资源预加载结束';
      detail = `音效预加载完成。成功 ${fields.successCount || '0'} 个，缺失 ${fields.missingCount || '0'} 个${fields.missingNames ? `，缺失资源：${fields.missingNames}` : ''}。`;
      break;
    case 'rtc_sig_info_fetch_result':
      title = fields.success === 'true' ? 'RTC 进房签名获取成功' : 'RTC 进房签名获取失败';
      detail = `${status}。进入 RTC 房间前需要签名，这里记录签名获取结果。${rtcFieldSummary(fields, [['roomId', '房间'], ['channelId', '频道'], ['reason', '原因']])}`;
      break;
    case 'voice_room_rtc_join_start':
      title = '准备加入语音房 RTC';
      detail = `业务层开始进入 RTC。${rtcFieldSummary(fields, [['channelId', '频道'], ['roomType', '房间类型'], ['roomId', '房间']])}`;
      break;
    case 'rtc_join_room_start':
      title = '调用 RTC SDK 加入房间';
      detail = `开始让 RTC SDK 进房。${rtcFieldSummary(fields, [['roomId', '房间'], ['peerId', '用户'], ['channelType', '频道类型']])}${fields.autoConsumer ? `，自动消费流=${boolText(fields.autoConsumer)}` : ''}。`;
      break;
    case 'voice_room_join_rtc_result':
      title = fields.success === 'true' ? '语音房 RTC 加入成功' : '语音房 RTC 加入失败';
      detail = `${status}。${rtcFieldSummary(fields, [['roomId', '房间'], ['channelId', '频道'], ['reason', '原因']])}`;
      break;
    case 'rtc_audio_route_snapshot':
      title = '记录当前音频路由状态';
      detail = [
        fields.currentInputs ? `输入=${fields.currentInputs}` : '',
        fields.currentOutputs ? `输出=${fields.currentOutputs}` : '',
        fields.category ? `音频类别=${fields.category}` : '',
        fields.mode ? `模式=${fields.mode}` : '',
        fields.sampleRate ? `采样率=${fields.sampleRate}` : '',
        fields.isJoinedRoom ? `已进房=${boolText(fields.isJoinedRoom)}` : '',
        fields.isRTCMute ? `RTC 静音=${boolText(fields.isRTCMute)}` : '',
        fields.trigger ? `触发点=${fields.trigger}` : '',
      ].filter(Boolean).join('，') || '采集了一次系统音频路由快照。';
      break;
    case 'rtc_stream_mode_set':
      title = '设置 RTC 流模式';
      detail = `设置当前用户或房间的 RTC 流模式。${rtcFieldSummary(fields, [['reason', '原因'], ['serverRoomLiveType', '房间直播类型'], ['userMode', '用户模式']])}`;
      break;
    case 'rtc_leave_room_cleanup_start':
      title = '开始清理离房状态';
      detail = `用户准备离开 RTC 房间，开始清理本地状态。${rtcFieldSummary(fields, [['roomId', '房间'], ['channelId', '频道']])}`;
      break;
    case 'rtc_leave_room':
      title = '离开 RTC 房间';
      detail = `业务层发起离房。${rtcFieldSummary(fields, [['roomId', '房间'], ['channelId', '频道'], ['reason', '原因']])}`;
      break;
    case 'rtc_leave_room_cleanup_complete':
      title = '离房状态清理完成';
      detail = `本地 RTC 离房清理已结束。${rtcFieldSummary(fields, [['roomId', '房间'], ['channelId', '频道']])}`;
      break;
    case 'voice_room_screen_share_state_change':
      title = '屏幕共享状态变化';
      detail = `语音房屏幕共享状态发生变化。${rtcFieldSummary(fields, [['channelId', '频道'], ['state', '状态'], ['roomType', '房间类型']])}`;
      break;
    default: {
      const fieldsText = semanticFields(fields);
      detail = fieldsText.length ? `${status}。关键字段：${fieldsText.join('，')}。` : `${status}。这是一条 RTC 业务日志，可结合原文继续判断。`;
      break;
    }
  }

  return makeSemanticLogItem(log, title, detail, ['RTC', status]);
}

function explainLoginBusinessLog(log: ParsedBusinessLog): SemanticLogItem {
  const fields = log.fields;
  const status = semanticStatusText(log.level, fields);
  const event = log.event.toLowerCase();
  const summary = fieldSummary(fields, [
    ['success', '结果'],
    ['retCode', 'retCode'],
    ['code', 'code'],
    ['retMsg', '消息'],
    ['errorMsg', '错误信息'],
    ['userId', '用户'],
    ['costMs', '耗时'],
    ['token', 'token'],
  ]);

  if (/im_sig|sig/.test(event)) {
    const title = status === '失败' || status === '异常' ? '登录后获取 IM 签名失败' : '登录后获取 IM 签名成功';
    const detail = status === '失败' || status === '异常'
      ? `IM 登录缺少可用签名，会影响会话、消息和群组能力。${summary ? `关键字段：${summary}。` : ''}`
      : `IM 签名已返回，可以继续登录 IM。${summary ? `关键字段：${summary}。` : ''}`;
    return makeSemanticLogItem(log, moduleEventTitle('Login', log.event, title), detail, ['Login', status]);
  }
  if (/token|session/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Login', log.event, '登录态或会话信息更新'), `${summary ? `关键字段：${summary}。` : '登录态有更新。'}`, ['Login', status]);
  }
  if (/login|auth/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Login', log.event, status === '失败' || status === '异常' ? '登录鉴权失败' : '登录鉴权通过'), `${summary ? `关键字段：${summary}。` : '账号登录链路已走到鉴权阶段。'}`, ['Login', status]);
  }
  return fallbackModuleExplanation(log, 'Login', status, '用于判断用户登录态、鉴权或签名链路。');
}

function explainImBusinessLog(log: ParsedBusinessLog): SemanticLogItem {
  const fields = log.fields;
  const status = semanticStatusText(log.level, fields);
  const event = log.event.toLowerCase();
  const summary = fieldSummary(fields, [
    ['success', '结果'],
    ['retCode', 'retCode'],
    ['code', 'code'],
    ['retMsg', '消息'],
    ['errorMsg', '错误信息'],
    ['conversationId', '会话'],
    ['sessionId', 'Session'],
    ['groupId', '群组'],
    ['messageId', '消息'],
    ['msgId', '消息'],
    ['userId', '用户'],
  ]);

  if (/conversation|conv/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('IM', log.event, status === '失败' || status === '异常' ? '会话读取失败' : '会话读取/更新'), `${status}。影响会话列表、未读数或进入聊天页前的会话状态。${summary ? `关键字段：${summary}。` : ''}`, ['IM', status]);
  }
  if (/join.*group|group.*join|group/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('IM', log.event, status === '失败' || status === '异常' ? '加入群组失败' : '群组关系更新'), `${status}。社区、语音房或频道聊天通常依赖 IM 群组，失败时会影响收发消息。${summary ? `关键字段：${summary}。` : ''}`, ['IM', status]);
  }
  if (/send|receive|message|msg/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('IM', log.event, status === '失败' || status === '异常' ? '消息链路异常' : '消息链路记录'), `${status}。确认消息发送、接收、回执或消息体处理是否正常。${summary ? `关键字段：${summary}。` : ''}`, ['IM', status]);
  }
  if (/login|connect|status/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('IM', log.event, 'IM 连接或登录状态变化'), `${status}。判断 IM SDK 是否已登录、是否断线或重连。${summary ? `关键字段：${summary}。` : ''}`, ['IM', status]);
  }
  return fallbackModuleExplanation(log, 'IM', status, '用于判断 IM 会话、群组、消息或连接状态。');
}

function explainCommunityBusinessLog(log: ParsedBusinessLog): SemanticLogItem {
  const fields = log.fields;
  const status = semanticStatusText(log.level, fields);
  const event = log.event.toLowerCase();
  const summary = fieldSummary(fields, [
    ['success', '结果'],
    ['retCode', 'retCode'],
    ['code', 'code'],
    ['retMsg', '消息'],
    ['errorMsg', '错误信息'],
    ['serverId', '服务器'],
    ['channelId', '频道'],
    ['roomId', '房间'],
    ['groupId', '群组'],
    ['userId', '用户'],
    ['costMs', '耗时'],
  ]);

  if (/reconcile.*skip|skip.*reconcile/.test(event)) {
    return makeSemanticLogItem(log, '跳过社区群组对账', `${summary ? `关键字段：${summary}。` : '本次没有执行社区群组对账。'}`, ['Community', status], Boolean(summary) || status !== '正常');
  }
  if (/hall|home|homepage|recommend/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Community', log.event, '社区首页/大厅数据'), `${status}。关联首页可见内容、推荐频道或大厅数据。${summary ? `关键字段：${summary}。` : ''}`, ['Community', status]);
  }
  if (/enter|join/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Community', log.event, status === '失败' || status === '异常' ? '进入社区/频道失败' : '进入社区/频道'), `${status}。判断用户是否成功进入服务器、频道或话题场景。${summary ? `关键字段：${summary}。` : ''}`, ['Community', status]);
  }
  if (/channel|server|room|topic/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Community', log.event, '社区频道/服务器数据'), `${status}。记录频道、服务器、房间或话题相关数据的拉取和更新。${summary ? `关键字段：${summary}。` : ''}`, ['Community', status]);
  }
  if (/list|query|load|fetch|get/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Community', log.event, '社区业务数据查询'), `${status}。判断社区页面列表或基础配置是否取到。${summary ? `关键字段：${summary}。` : ''}`, ['Community', status]);
  }
  return fallbackModuleExplanation(log, 'Community', status, '用于判断社区首页、频道、服务器或话题链路。');
}

function explainVoiceRoomBusinessLog(log: ParsedBusinessLog): SemanticLogItem {
  const fields = log.fields;
  const status = semanticStatusText(log.level, fields);
  const event = log.event.toLowerCase();
  const summary = fieldSummary(fields, [
    ['success', '结果'],
    ['retCode', 'retCode'],
    ['code', 'code'],
    ['retMsg', '消息'],
    ['errorMsg', '错误信息'],
    ['roomId', '房间'],
    ['channelId', '频道'],
    ['serverId', '服务器'],
    ['userId', '用户'],
    ['state', '状态'],
    ['costMs', '耗时'],
  ]);

  if (/im.*group.*result|join.*im.*group|im.*group/.test(event)) {
    return makeSemanticLogItem(log, status === '失败' || status === '异常' ? '加入语音房 IM 群组失败' : '加入语音房 IM 群组成功', `${summary ? `关键字段：${summary}。` : '语音房关联的 IM 群组已处理。'}`, ['VoiceRoom', status], Boolean(summary) || status !== '正常');
  }
  if (/rtc|audio|mic|mute|speaker/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('VoiceRoom', log.event, '语音链路状态变化'), `${status}。影响语音房听说能力、麦克风、静音或音频路由。${summary ? `关键字段：${summary}。` : ''}`, ['VoiceRoom', status]);
  }
  if (/enter|join/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('VoiceRoom', log.event, status === '失败' || status === '异常' ? '进入语音房失败' : '进入语音房'), `${status}。判断房间业务态是否建立成功。${summary ? `关键字段：${summary}。` : ''}`, ['VoiceRoom', status]);
  }
  if (/leave|exit|cleanup/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('VoiceRoom', log.event, '离开语音房并清理状态'), `${status}。确认离房后本地房间、音频和连接状态是否被清理。${summary ? `关键字段：${summary}。` : ''}`, ['VoiceRoom', status]);
  }
  if (/screen.*share|share/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('VoiceRoom', log.event, '屏幕共享状态变化'), `${status}。判断屏幕共享开启、关闭或异常中断。${summary ? `关键字段：${summary}。` : ''}`, ['VoiceRoom', status]);
  }
  return fallbackModuleExplanation(log, 'VoiceRoom', status, '用于判断语音房进出房、音频和房间状态。');
}

function explainWebSocketBusinessLog(log: ParsedBusinessLog): SemanticLogItem {
  const fields = log.fields;
  const status = semanticStatusText(log.level, fields);
  const event = log.event.toLowerCase();
  const summary = fieldSummary(fields, [
    ['success', '结果'],
    ['code', 'code'],
    ['retCode', 'retCode'],
    ['errorMsg', '错误信息'],
    ['reason', '原因'],
    ['method', '方法'],
    ['messageId', '消息'],
    ['channelId', '频道'],
    ['channelCount', '频道数'],
    ['timeoutMs', '超时'],
    ['port', '端口'],
  ]);

  if (/connect|connected|disconnect|reconnect/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('WebSocket', log.event, status === '失败' || status === '异常' ? '连接异常' : '连接状态变化'), `${status}。影响实时消息、频道订阅和在线状态同步。${summary ? `关键字段：${summary}。` : ''}`, ['WebSocket', status]);
  }
  if (/subscribe|channel/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('WebSocket', log.event, '频道订阅状态'), `${status}。订阅成功后客户端才能收到对应频道的实时推送。${summary ? `关键字段：${summary}。` : ''}`, ['WebSocket', status]);
  }
  if (/request|response|send/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('WebSocket', log.event, '实时请求收发'), `${status}。确认 WebSocket 上行请求或服务端响应是否正常。${summary ? `关键字段：${summary}。` : ''}`, ['WebSocket', status]);
  }
  return fallbackModuleExplanation(log, 'WebSocket', status, '用于判断实时连接、频道订阅或消息收发状态。');
}

function explainMessageBusinessLog(log: ParsedBusinessLog): SemanticLogItem {
  const fields = log.fields;
  const status = semanticStatusText(log.level, fields);
  const event = log.event.toLowerCase();
  const summary = fieldSummary(fields, [
    ['success', '结果'],
    ['retCode', 'retCode'],
    ['code', 'code'],
    ['retMsg', '消息'],
    ['errorMsg', '错误信息'],
    ['messageId', '消息'],
    ['msgId', '消息'],
    ['conversationId', '会话'],
    ['sessionId', 'Session'],
    ['userId', '用户'],
  ]);

  if (/send/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Message', log.event, status === '失败' || status === '异常' ? '消息发送失败' : '消息发送记录'), `${status}。判断客户端消息是否成功发出或拿到发送结果。${summary ? `关键字段：${summary}。` : ''}`, ['Message', status]);
  }
  if (/receive|push|notify/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Message', log.event, '收到消息或通知'), `${status}。判断服务端消息是否到达客户端并进入处理流程。${summary ? `关键字段：${summary}。` : ''}`, ['Message', status]);
  }
  if (/read|ack|receipt/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Message', log.event, '消息已读或回执状态'), `${status}。确认消息状态同步是否正常。${summary ? `关键字段：${summary}。` : ''}`, ['Message', status]);
  }
  return fallbackModuleExplanation(log, 'Message', status, '用于判断消息收发、回执或通知处理。');
}

function explainPushBusinessLog(log: ParsedBusinessLog): SemanticLogItem {
  const fields = log.fields;
  const status = semanticStatusText(log.level, fields);
  const event = log.event.toLowerCase();
  const summary = fieldSummary(fields, [
    ['success', '结果'],
    ['code', 'code'],
    ['retCode', 'retCode'],
    ['errorMsg', '错误信息'],
    ['reason', '原因'],
    ['token', 'token'],
    ['userId', '用户'],
    ['state', '状态'],
  ]);

  if (/permission|auth/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Push', log.event, '推送权限状态'), `${status}。判断系统通知权限是否可用，权限关闭会导致离线推送不可达。${summary ? `关键字段：${summary}。` : ''}`, ['Push', status]);
  }
  if (/token|register|bind/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Push', log.event, status === '失败' || status === '异常' ? '推送 token 注册失败' : '推送 token 注册/绑定'), `${status}。确认设备 token 是否成功上报并绑定到用户。${summary ? `关键字段：${summary}。` : ''}`, ['Push', status]);
  }
  if (/receive|click|open/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Push', log.event, '推送到达或点击'), `${status}。判断推送是否到达客户端，以及用户是否从推送进入 App。${summary ? `关键字段：${summary}。` : ''}`, ['Push', status]);
  }
  return fallbackModuleExplanation(log, 'Push', status, '用于判断通知权限、token 绑定或推送到达。');
}

function explainWebBusinessLog(log: ParsedBusinessLog): SemanticLogItem {
  const fields = log.fields;
  const status = semanticStatusText(log.level, fields);
  const event = log.event.toLowerCase();
  const summary = fieldSummary(fields, [
    ['success', '结果'],
    ['code', 'code'],
    ['retCode', 'retCode'],
    ['errorMsg', '错误信息'],
    ['reason', '原因'],
    ['url', '地址'],
    ['path', '路径'],
    ['costMs', '耗时'],
  ]);

  if (/load|render|finish|start/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Web', log.event, 'H5 页面加载/渲染'), `${status}。判断 WebView 页面是否开始加载、完成渲染或出现白屏风险。${summary ? `关键字段：${summary}。` : ''}`, ['Web', status]);
  }
  if (/bridge|jsbridge/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Web', log.event, 'Native 与 H5 通信'), `${status}。判断 JSBridge 调用是否正常，异常会影响 H5 调用客户端能力。${summary ? `关键字段：${summary}。` : ''}`, ['Web', status]);
  }
  if (/error|fail|exception/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('Web', log.event, 'H5 异常'), `${status}。记录 WebView 加载、脚本或网络异常。${summary ? `关键字段：${summary}。` : ''}`, ['Web', status]);
  }
  return fallbackModuleExplanation(log, 'Web', status, '用于判断 H5 加载、渲染或 Native 通信状态。');
}

function explainRealtimeBusinessLog(log: ParsedBusinessLog): SemanticLogItem {
  const fields = log.fields;
  const status = semanticStatusText(log.level, fields);
  const event = log.event.toLowerCase();
  const summary = fieldSummary(fields, [
    ['success', '结果'],
    ['code', 'code'],
    ['retCode', 'retCode'],
    ['errorMsg', '错误信息'],
    ['reason', '原因'],
    ['method', '方法'],
    ['channelId', '频道'],
    ['messageId', '消息'],
    ['costMs', '耗时'],
  ]);

  if (/heartbeat|ping|pong/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('NNRealtimeLog', log.event, '实时心跳'), `${status}。判断长连接心跳是否稳定，心跳异常通常会带来断线或延迟。${summary ? `关键字段：${summary}。` : ''}`, ['NNRealtimeLog', status]);
  }
  if (/connect|reconnect|restore/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('NNRealtimeLog', log.event, '实时连接恢复/重连'), `${status}。判断实时通道是否重新建立，以及订阅是否需要恢复。${summary ? `关键字段：${summary}。` : ''}`, ['NNRealtimeLog', status]);
  }
  if (/dispatch|receive|message|subscribe/.test(event)) {
    return makeSemanticLogItem(log, moduleEventTitle('NNRealtimeLog', log.event, '实时消息分发'), `${status}。确认实时消息是否收到、分发到业务模块或订阅频道。${summary ? `关键字段：${summary}。` : ''}`, ['NNRealtimeLog', status]);
  }
  return fallbackModuleExplanation(log, 'NNRealtimeLog', status, '用于判断实时通道、心跳、订阅和消息分发状态。');
}

function explainApiBusinessLog(log: ParsedBusinessLog): SemanticLogItem {
  const fields = log.fields;
  const status = semanticStatusText(log.level, fields);
  const apiPath = normalizeApiPath(fields.api || fields.url || fields.path || '');
  const summary = fieldSummary(fields, [
    ['api', '接口'],
    ['url', '地址'],
    ['path', '路径'],
    ['retCode', 'retCode'],
    ['code', 'code'],
    ['retMsg', '消息'],
    ['errorMsg', '错误信息'],
    ['reason', '原因'],
    ['nntid', 'nntid'],
    ['trackId', 'trackId'],
    ['costMs', '耗时'],
  ]);

  if (log.event === 'api_failure') {
    return makeSemanticLogItem(
      log,
      '接口请求失败',
      `请求没有正常完成，通常是网络断开、超时、DNS/TLS 或服务端连接失败。${apiPath && apiPath !== '-' ? `接口 ${apiPath}。` : ''}${summary ? `涉及 ${summary}。` : ''}`,
      ['API', status]
    );
  }
  if (log.event === 'api_decode_failure') {
    return makeSemanticLogItem(
      log,
      '接口响应解析失败',
      `请求已返回，但客户端没能把响应解析成预期数据，常见原因是字段缺失、类型不匹配、空数据或服务端结构变化。${apiPath && apiPath !== '-' ? `接口 ${apiPath}。` : ''}${summary ? `涉及 ${summary}。` : ''}`,
      ['API', status]
    );
  }
  return fallbackModuleExplanation(log, 'API', status, '用于判断接口请求、响应或解析链路。');
}

function explainBusinessLog(log: ParsedBusinessLog): SemanticLogItem {
  if (log.category === 'IM SDK' || log.category === 'RTC SDK') return explainSdkLog(log);
  if (log.category === 'API') return explainApiBusinessLog(log);
  if (log.category === 'RTC') return explainRtcBusinessLog(log);
  if (log.category === 'Login') return explainLoginBusinessLog(log);
  if (log.category === 'IM') return explainImBusinessLog(log);
  if (log.category === 'Community') return explainCommunityBusinessLog(log);
  if (log.category === 'VoiceRoom') return explainVoiceRoomBusinessLog(log);
  if (log.category === 'WebSocket') return explainWebSocketBusinessLog(log);
  if (log.category === 'Message') return explainMessageBusinessLog(log);
  if (log.category === 'Push') return explainPushBusinessLog(log);
  if (log.category === 'Web') return explainWebBusinessLog(log);
  if (log.category === 'NNRealtimeLog') return explainRealtimeBusinessLog(log);
  const fields = semanticFields(log.fields);
  const status = semanticStatusText(log.level, log.fields);
  return makeSemanticLogItem(
    log,
    humanizeEventName(log.event),
    fields.length
      ? `${status}。关键字段：${fields.join('，')}。`
      : `${status}。${log.event === 'raw_log' ? '无明确业务含义。' : '未携带关键 fields。'}`,
    [log.category, log.event],
    fields.length > 0 || status !== '正常'
  );
}

function explainApiRow(row: ApiTimelineRow): SemanticLogItem {
  const path = normalizeApiPath(row.fullApi);
  const apiDocsPath = normalizeApiDocsSearchPath(row.fullApi);
  const meaning = humanizeApiPath(path);
  const costText = row.costMs === null ? '' : `${row.costMs}ms`;
  const relatedText = (row.relatedEvents || []).map((event) => {
    if (event.event === 'api_failure') return '请求阶段失败';
    if (event.event === 'api_decode_failure') return '响应解析失败';
    return humanizeEventName(event.event);
  }).filter(Boolean).join('，');
  const resultText = row.status === 'pending'
    ? '没有匹配到响应，可能是请求还没结束、响应日志缺失或 nntid 未对上'
    : row.status === 'failed'
      ? `接口存在异常${row.retCode !== '-' ? `，retCode=${row.retCode}` : ''}${row.retMsg !== '-' ? `，消息=${row.retMsg}` : ''}${relatedText ? `，关联事件=${relatedText}` : ''}`
      : '返回成功';
  const level: ParsedBusinessLog['level'] = row.status === 'failed' || row.status === 'pending' || (row.costMs !== null && row.costMs > 350) ? 'warning' : 'info';
  const title = row.status === 'pending'
    ? `接口未匹配到响应${costText ? `，${costText}` : ''}`
    : row.status === 'failed'
      ? `接口存在异常${costText ? `，${costText}` : ''}`
      : `接口返回成功${costText ? `，${costText}` : ''}`;
  const nntidText = row.nntid !== '-' ? `nntid=${row.nntid}。` : '';
  const detail = row.status === 'success' ? nntidText : `${resultText}。${nntidText}`;
  return {
    key: row.key,
    time: row.requestTime || row.responseTime || '-',
    title: truncateSummary(title),
    detail,
    level,
    tags: ['API', row.status === 'success' ? '成功' : row.status === 'pending' ? '无响应' : '异常'],
    sourceEvent: 'api_timeline',
    meaningful: true,
    categoryL1: '网络请求',
    semanticLevel: level === 'info' ? 'INFO' : row.status === 'failed' ? 'ERROR' : 'WARN',
    apiName: meaning || undefined,
    apiPath: apiDocsPath,
    apiDocUrl: buildApiDocsSearchUrl(row.fullApi),
  };
}

function parseLogTimeValue(time: string): number {
  const normalized = time.replace(/^\[|\]$/g, '');
  const fullMatch = normalized.match(/^(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?/);
  if (fullMatch) {
    const [, year, month, day, hour, minute, second, millisecond = '0'] = fullMatch;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millisecond.padEnd(3, '0'))).getTime();
  }

  const shortMatch = normalized.match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?/);
  if (!shortMatch) return 0;
  const [, month, day, hour, minute, second, millisecond = '0'] = shortMatch;
  return new Date(2000, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millisecond.padEnd(3, '0'))).getTime();
}

function parseJsonValue(value?: string): JsonValue | null {
  if (!value || value === '-') return null;
  const candidates = [value, value.replace(/\\\\(?=")/g, '\\')];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as JsonValue;
    } catch {
      // 尝试下一种转义层级。
    }
  }
  return null;
}

function formatJsonText(value?: string): string {
  const parsed = parseJsonValue(value);
  if (parsed === null) return '';
  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return '';
  }
}

function formatJsonPrimitive(value: JsonValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  return String(value);
}

function getJsonNodeSummary(value: JsonValue): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value && typeof value === 'object') return `Object(${Object.keys(value).length})`;
  return formatJsonPrimitive(value);
}

function buildJsonTreeData(value: JsonValue, keyword: string, key = 'root', label = 'root'): any[] {
  const lowerKeyword = keyword.trim().toLowerCase();
  const renderLabel = (nodeLabel: string, nodeValue: JsonValue) => {
    const valueText = getJsonNodeSummary(nodeValue);
    const text = `${nodeLabel}: ${valueText}`;
    return <span>{highlightText(text, lowerKeyword)}</span>;
  };

  const makeNode = (nodeValue: JsonValue, nodeKey: string, nodeLabel: string): any => {
    if (Array.isArray(nodeValue)) {
      return {
        key: nodeKey,
        title: renderLabel(nodeLabel, nodeValue),
        children: nodeValue.map((item, index) => makeNode(item, `${nodeKey}.${index}`, `[${index}]`)),
      };
    }
    if (nodeValue && typeof nodeValue === 'object') {
      return {
        key: nodeKey,
        title: renderLabel(nodeLabel, nodeValue),
        children: Object.entries(nodeValue).map(([childKey, childValue]) => makeNode(childValue, `${nodeKey}.${childKey}`, childKey)),
      };
    }
    return { key: nodeKey, title: renderLabel(nodeLabel, nodeValue) };
  };

  return [makeNode(value, key, label)];
}

function getDefaultExpandedJsonKeys(value: JsonValue, maxDepth = 2, key = 'root', depth = 0): string[] {
  if (depth >= maxDepth || value === null || typeof value !== 'object') {
    return [];
  }
  const keys = [key];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [`${index}`, item] as const)
    : Object.entries(value);
  entries.forEach(([childKey, childValue]) => {
    keys.push(...getDefaultExpandedJsonKeys(childValue, maxDepth, `${key}.${childKey}`, depth + 1));
  });
  return keys;
}

function getMatchedJsonKeys(value: JsonValue, keyword: string, key = 'root', label = 'root'): string[] {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return [];
  const keys = new Set<string>();
  const walk = (nodeValue: JsonValue, nodeKey: string, nodeLabel: string, ancestors: string[]) => {
    const text = `${nodeLabel}: ${getJsonNodeSummary(nodeValue)}`.toLowerCase();
    if (text.includes(normalizedKeyword)) {
      [...ancestors, nodeKey].forEach((item) => keys.add(item));
    }
    if (Array.isArray(nodeValue)) {
      nodeValue.forEach((item, index) => walk(item, `${nodeKey}.${index}`, `[${index}]`, [...ancestors, nodeKey]));
    } else if (nodeValue && typeof nodeValue === 'object') {
      Object.entries(nodeValue).forEach(([childKey, childValue]) => walk(childValue, `${nodeKey}.${childKey}`, childKey, [...ancestors, nodeKey]));
    }
  };
  walk(value, key, label, []);
  return Array.from(keys);
}

function removeResponseFieldFromLogLine(line: string): string {
  if (!line || line === '-') return line;
  return line
    .replace(/,\s*response="(?:\\.|[^"\\])*"(?=,\s*[A-Za-z_][\w]*=|\})/g, '')
    .replace(/\sresponse="(?:\\.|[^"\\])*",\s*/g, ' ')
    .replace(/\sresponse="(?:\\.|[^"\\])*"(?=\})/g, '');
}

function extractResponseFieldFromLogLine(line: string): string {
  if (!line || line === '-') return '';
  return extractFieldValue(line, 'response');
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 回退到 textarea 复制。
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', 'true');
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '0';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  textArea.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    document.body.removeChild(textArea);
  }
  return copied;
}

function extractBusinessLogTime(line: string): string {
  const bracketTimes = [...line.matchAll(/\[([^\]]+)\]/g)]
    .map((item) => item[1])
    .filter((value) =>
      /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ||
      /^\d{4}[/-]\d{2}[/-]\d{2}\s+\d{2}:\d{2}:\d{2}(?:[.:]\d+)?$/.test(value)
    );
  return bracketTimes[0]
    || line.match(/^(\d{4}[/-]\d{2}[/-]\d{2}\s+\d{2}:\d{2}:\d{2}(?:[.:]\d+)?)/)?.[1]
    || '';
}

function normalizeLogCategory(line: string, categoryMatches: string[], time: string): string {
  if (/\[IMSDK\]|\[nnimsdk-[^\]]+\]/i.test(line)) return 'IM SDK';
  if (/\[RTCSDK\]|\[nnrtc-[^\]]+\]/i.test(line)) return 'RTC SDK';

  const candidates = categoryMatches.filter((item) => item !== time && !item.includes(':'));
  if (candidates.includes('RTC_API') || candidates.includes('RTC')) return 'RTC';
  const priority = ['API', 'IM', 'Community', 'VoiceRoom', 'WebSocket', 'Login', 'Message', 'Push', 'Web'];
  const matchedPriority = priority.find((item) => candidates.includes(item));
  if (matchedPriority) return matchedPriority;

  return candidates.find((item) => !['Warning', 'Error', 'Debug', 'Info'].includes(item)) || candidates[0] || '未分类';
}

function parseBusinessLogLine(line: string): ParsedBusinessLog {
  const time = extractBusinessLogTime(line);
  const categoryMatches = [...line.matchAll(/\[([A-Za-z][A-Za-z0-9_+\-.]*)\]/g)].map((item) => item[1]);
  const category = normalizeLogCategory(line, categoryMatches, time);
  const event = line.match(/\bevent=([A-Za-z0-9_:.+-]+)/)?.[1] || 'raw_log';
  const fieldsText = line.match(/\bfields=\{([\s\S]*)\}\s*$/)?.[1] || '';
  const fields = fieldsText ? parseFields(fieldsText) : {};
  const retCode = fields.retCode;
  const code = fields.code;
  const success = String(fields.success || '').toLowerCase();
  const hasExplicitWarning = /⚠️|\[Warning\]|\[Error\]/i.test(line);
  const hasFailedEvent = /(?:^|[_:.+-])(?:fail|failed|failure|exception)(?:$|[_:.+-])/i.test(event);
  const hasFailedResult = success === 'false' ||
    Boolean(retCode && !['0', '100', '200'].includes(retCode)) ||
    Boolean(code && !['0', '100', '200', '61000'].includes(code));
  const level = hasExplicitWarning || hasFailedEvent || hasFailedResult ? 'warning' : 'info';
  return { time, category, event, level, fields, line };
}

function splitConcatenatedBusinessLogLine(line: string): string[] {
  const physicalLines = line
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  return physicalLines.flatMap((physicalLine) => {
    const recordStartPattern = /\d{4}[/-]\d{2}[/-]\d{2}\s+\d{2}:\d{2}:\d{2}[.:]\d{1,6}(?=\s+\[)/g;
    const starts = [...physicalLine.matchAll(recordStartPattern)]
      .map((match) => match.index ?? 0)
      .filter((index) => index === 0 || /\s/.test(physicalLine[index - 1] || ''));
    if (starts.length <= 1) return [physicalLine];

    return starts
      .map((start, index) => physicalLine.slice(start, starts[index + 1] ?? physicalLine.length).trim())
      .filter(Boolean);
  });
}

function topCounts(values: string[], limit = 12) {
  const counts = new Map<string, number>();
  values.filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([event, count]) => ({ event, count }));
}

function getLogModuleGroup(log: ParsedBusinessLog): { key: string; label: string } {
  const label = log.category || '未分类';
  const key = label.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_') || 'unknown';
  return { key, label };
}

export function analyzeBusinessLogLines(lines: string[], source: string): BusinessLogAnalysis {
  const parsedLogs = lines.flatMap(splitConcatenatedBusinessLogLine).map(parseBusinessLogLine);
  const apiRequests = parsedLogs.filter((log) => log.event === 'api_request');
  const apiResponses = parsedLogs.filter((log) => log.event === 'api_response');
  const apiRelatedEvents = parsedLogs.filter((log) => log.category === 'API' && log.event !== 'api_request' && log.event !== 'api_response');
  const failedResponses = apiResponses.filter((log) => {
    const retCode = log.fields.retCode;
    return retCode && !['0', '100', '200'].includes(retCode);
  });
  const slowResponses = apiResponses
    .filter((log) => Number(log.fields.costMs || 0) >= 500)
    .sort((left, right) => Number(right.fields.costMs || 0) - Number(left.fields.costMs || 0))
    .slice(0, 20);

  const apiMap = new Map<string, { requestCount: number; responseCount: number; failedCount: number; totalCostMs: number; costCount: number; maxCostMs: number }>();
  [...apiRequests, ...apiResponses].forEach((log) => {
    const api = normalizeApiKey(log.fields.api);
    const item = apiMap.get(api) || { requestCount: 0, responseCount: 0, failedCount: 0, totalCostMs: 0, costCount: 0, maxCostMs: 0 };
    if (log.event === 'api_request') item.requestCount += 1;
    if (log.event === 'api_response') {
      item.responseCount += 1;
      const costMs = Number(log.fields.costMs || 0);
      if (costMs > 0) {
        item.totalCostMs += costMs;
        item.costCount += 1;
        item.maxCostMs = Math.max(item.maxCostMs, costMs);
      }
      const retCode = log.fields.retCode;
      if (retCode && !['0', '100', '200'].includes(retCode)) item.failedCount += 1;
    }
    apiMap.set(api, item);
  });

  const apiStats = Array.from(apiMap.entries())
    .map(([api, stat]) => ({
      api,
      requestCount: stat.requestCount,
      responseCount: stat.responseCount,
      failedCount: stat.failedCount,
      maxCostMs: stat.maxCostMs,
      avgCostMs: stat.costCount ? Math.round(stat.totalCostMs / stat.costCount) : 0,
    }))
    .sort((left, right) => right.failedCount - left.failedCount || right.maxCostMs - left.maxCostMs || right.requestCount - left.requestCount)
    .slice(0, 30);

  const responsesByNntid = new Map<string, ParsedBusinessLog[]>();
  apiResponses.forEach((response) => {
    const nntid = response.fields.nntid || '';
    if (!nntid) return;
    responsesByNntid.set(nntid, [...(responsesByNntid.get(nntid) || []), response]);
  });
  const usedResponses = new Set<ParsedBusinessLog>();
  const apiTimeline: ApiTimelineRow[] = apiRequests.map((request, index) => {
    const nntid = request.fields.nntid || '';
    const response = nntid ? responsesByNntid.get(nntid)?.shift() : undefined;
    if (response) usedResponses.add(response);
    const retCode = response?.fields.retCode || '';
    const status: 'success' | 'failed' | 'pending' = response
      ? (retCode && !['0', '100', '200'].includes(retCode) ? 'failed' : 'success')
      : 'pending';
    return {
      key: `${nntid || request.time}-${index}`,
      requestTime: request.time,
      responseTime: response?.time || '-',
      api: normalizeApiKey(request.fields.api || response?.fields.api),
      costMs: response?.fields.costMs ? Number(response.fields.costMs) : null,
      retCode: retCode || '-',
      retMsg: response?.fields.retMsg || '-',
      nntid: nntid || '-',
      trackId: response?.fields.trackId || '-',
      parameters: request.fields.parameters || '-',
      responseBody: response?.fields.response || extractResponseFieldFromLogLine(response?.line || '') || '-',
      requestLine: request.line,
      responseLine: response?.line || '-',
      fullApi: request.fields.api || response?.fields.api || '-',
      matchedRequest: true,
      status,
      relatedEvents: [],
    };
  });
  apiResponses.forEach((response, index) => {
    if (usedResponses.has(response)) return;
    const retCode = response.fields.retCode || '';
    const status: 'success' | 'failed' = retCode && !['0', '100', '200'].includes(retCode) ? 'failed' : 'success';
    apiTimeline.push({
      key: `response-only-${response.fields.nntid || response.time}-${index}`,
      requestTime: response.time || '-',
      responseTime: response.time || '-',
      api: normalizeApiKey(response.fields.api),
      costMs: null,
      retCode: retCode || '-',
      retMsg: response.fields.retMsg || '-',
      nntid: response.fields.nntid || '-',
      trackId: response.fields.trackId || '-',
      parameters: '-',
      responseBody: response.fields.response || extractResponseFieldFromLogLine(response.line) || '-',
      requestLine: '-',
      responseLine: response.line,
      fullApi: response.fields.api || '-',
      matchedRequest: false,
      status,
      relatedEvents: [],
    });
  });

  const apiTimelineByNntid = new Map<string, ApiTimelineRow>();
  apiTimeline.forEach((row) => {
    if (row.nntid && row.nntid !== '-') apiTimelineByNntid.set(row.nntid, row);
  });
  apiRelatedEvents.forEach((event, index) => {
    const nntid = event.fields.nntid || '';
    const matchedRow = nntid ? apiTimelineByNntid.get(nntid) : undefined;
    if (matchedRow) {
      matchedRow.relatedEvents = [...(matchedRow.relatedEvents || []), event];
      if (event.level !== 'info' && matchedRow.status === 'success') matchedRow.status = 'failed';
      if (event.fields.retCode && matchedRow.retCode === '-') matchedRow.retCode = event.fields.retCode;
      if ((event.fields.retMsg || event.fields.errorMsg || event.fields.reason) && matchedRow.retMsg === '-') {
        matchedRow.retMsg = event.fields.retMsg || event.fields.errorMsg || event.fields.reason || '-';
      }
      return;
    }
    apiTimeline.push({
      key: `api-related-${event.fields.nntid || event.time}-${index}`,
      requestTime: event.time || '-',
      responseTime: event.time || '-',
      api: normalizeApiKey(event.fields.api || event.fields.url || event.fields.path),
      costMs: event.fields.costMs ? Number(event.fields.costMs) : null,
      retCode: event.fields.retCode || event.fields.code || '-',
      retMsg: event.fields.retMsg || event.fields.errorMsg || event.fields.reason || '-',
      nntid: event.fields.nntid || '-',
      trackId: event.fields.trackId || '-',
      parameters: event.fields.parameters || '-',
      responseBody: event.fields.response || extractResponseFieldFromLogLine(event.line) || '-',
      requestLine: '-',
      responseLine: event.line,
      fullApi: event.fields.api || event.fields.url || event.fields.path || '-',
      matchedRequest: false,
      status: event.level !== 'info' ? 'failed' : 'success',
      relatedEvents: [event],
    });
  });

  const requestNntids = new Set(apiRequests.map((log) => log.fields.nntid).filter(Boolean));
  const responseNntids = new Set(apiResponses.map((log) => log.fields.nntid).filter(Boolean));
  let nntidIssueCount = 0;
  requestNntids.forEach((nntid) => {
    if (!responseNntids.has(nntid)) nntidIssueCount += 1;
  });

  const versions = Array.from(new Set(parsedLogs.map((log) => log.fields.version).filter(Boolean))).slice(0, 8);
  const userIds = Array.from(new Set(parsedLogs.flatMap((log) => {
    const raw = `${log.fields.userId || ''} ${log.fields.parameters || ''}`;
    return [...raw.matchAll(/\buserId"?[:=]?"?(\d{5,})/g)].map((item) => item[1]);
  }))).slice(0, 8);

  const suggestions: string[] = [];
  if (failedResponses.length) suggestions.push(`发现 ${failedResponses.length} 条非成功 retCode，优先查看异常响应列表。`);
  if (slowResponses.length) suggestions.push(`发现 ${slowResponses.length} 条接口耗时 >= 500ms，建议关注慢请求 Top。`);
  if (nntidIssueCount) suggestions.push(`发现 ${nntidIssueCount} 个请求 nntid 未匹配到响应，可能存在超时、丢日志或请求未完成。`);
  if (!suggestions.length) suggestions.push('未发现明显异常 retCode 或慢请求，可结合用户操作路径继续检索关键 event。');

  const groupMap = new Map<string, { key: string; label: string; logs: ParsedBusinessLog[] }>();
  parsedLogs.forEach((log) => {
    const group = getLogModuleGroup(log);
    const item = groupMap.get(group.key) || { ...group, logs: [] };
    item.logs.push(log);
    groupMap.set(group.key, item);
  });
  const moduleGroups = Array.from(groupMap.values())
    .sort((left, right) => {
      const leadingOrder = ['API', 'IM SDK', 'RTC SDK', 'IM', 'RTC', 'Login', 'Community'];
      const trailingOrder = ['未分类', 'Warning', 'Error', 'Debug'];
      const leftLeadingIndex = leadingOrder.indexOf(left.label);
      const rightLeadingIndex = leadingOrder.indexOf(right.label);
      if (leftLeadingIndex !== -1 || rightLeadingIndex !== -1) {
        if (leftLeadingIndex === -1) return 1;
        if (rightLeadingIndex === -1) return -1;
        return leftLeadingIndex - rightLeadingIndex;
      }
      const leftTrailingIndex = trailingOrder.indexOf(left.label);
      const rightTrailingIndex = trailingOrder.indexOf(right.label);
      if (leftTrailingIndex !== -1 || rightTrailingIndex !== -1) {
        if (leftTrailingIndex === -1) return -1;
        if (rightTrailingIndex === -1) return 1;
        return leftTrailingIndex - rightTrailingIndex;
      }
      if (left.label === 'IM' && right.label === 'RTC') return -1;
      if (left.label === 'RTC' && right.label === 'IM') return 1;
      return 0;
    })
    .map((group) => ({
      ...group,
      warnings: group.logs.filter((log) => log.level !== 'info').length,
      eventCounts: topCounts(group.logs.map((log) => log.event), 8),
    }));
  const allLogsGroup = {
    key: 'all_business_logs',
    label: '全部业务日志',
    logs: parsedLogs,
    warnings: parsedLogs.filter((log) => log.level !== 'info').length,
    eventCounts: topCounts(parsedLogs.map((log) => log.event), 8),
  };
  const warningErrorLogs = parsedLogs.filter((log) => log.level !== 'info');
  const warningErrorGroup = {
    key: 'warning_error_logs',
    label: 'Warning/Error',
    logs: warningErrorLogs,
    warnings: warningErrorLogs.length,
    eventCounts: topCounts(warningErrorLogs.map((log) => log.event), 8),
  };
  const functionGroups = [
    ...moduleGroups.filter((group) => group.label === 'API'),
    warningErrorGroup,
    ...moduleGroups.filter((group) => group.label !== 'API'),
    allLogsGroup,
  ];

  return {
    source,
    total: parsedLogs.length,
    timeRange: parsedLogs.length ? `${parsedLogs[0].time || '-'} ~ ${parsedLogs[parsedLogs.length - 1].time || '-'}` : '-',
    warnings: parsedLogs.filter((log) => log.level !== 'info').length,
    apiRequests: apiRequests.length,
    apiResponses: apiResponses.length,
    failedResponses: failedResponses.slice(0, 30),
    slowResponses,
    eventCounts: topCounts(parsedLogs.map((log) => log.event), 16),
    apiStats,
    apiTimeline,
    retCodeCounts: topCounts(apiResponses.map((log) => log.fields.retCode || 'empty'), 12).map((item) => ({ retCode: item.event, count: item.count })),
    versions,
    userIds,
    nntidIssueCount,
    suggestions,
    functionGroups,
  };
}

interface BusinessLogAnalysisModalProps {
  open: boolean;
  analysisResult: BusinessLogAnalysis | null;
  onCancel: () => void;
}

export function BusinessLogAnalysisModal({ open, analysisResult, onCancel }: BusinessLogAnalysisModalProps) {
  const [apiResponseJsonSearchText, setApiResponseJsonSearchText] = useState('');
  const [apiSearchText, setApiSearchText] = useState('');
  const [logSearchText, setLogSearchText] = useState('');
  const [activeTabKey, setActiveTabKey] = useState<string>();

  const activeGroup = useMemo(() => {
    if (!analysisResult) return null;
    const defaultKey = analysisResult.functionGroups.find((group) => group.label === 'API')?.key || analysisResult.functionGroups[0]?.key;
    const key = activeTabKey || defaultKey;
    return analysisResult.functionGroups.find((group) => group.key === key) || analysisResult.functionGroups[0] || null;
  }, [activeTabKey, analysisResult]);

  const defaultActiveKey = analysisResult?.functionGroups.find((group) => group.label === 'API')?.key || analysisResult?.functionGroups[0]?.key || 'unknown';
  const currentActiveKey = activeGroup?.key || defaultActiveKey;

  const renderAnalysisSummary = () => {
    if (!analysisResult) return null;
    const group = activeGroup;
    const isSdkGroup = group?.label === 'IM SDK' || group?.label === 'RTC SDK';
    return (
      <div
        style={{
          padding: '10px 12px',
          background: '#fafafa',
          border: '1px solid #f0f0f0',
          borderRadius: 6,
        }}
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space size={[8, 8]} wrap>
            <Tag color="blue">总日志 {analysisResult.total}</Tag>
            <Tag color={analysisResult.warnings ? 'orange' : 'green'}>异常 {analysisResult.warnings}</Tag>
            <Tag>API 请求 {analysisResult.apiRequests}</Tag>
            <Tag>API 响应 {analysisResult.apiResponses}</Tag>
            {group ? <Tag color="geekblue">当前分类 {group.label} / {group.label === 'API' ? analysisResult.apiTimeline.length : group.logs.length}</Tag> : null}
            {group?.warnings ? <Tag color="orange">当前异常 {group.warnings}</Tag> : null}
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>时间范围：{analysisResult.timeRange}</Text>
          {!isSdkGroup && group?.eventCounts?.length ? (
            <Space size={[6, 6]} wrap>
              <Text type="secondary" style={{ fontSize: 12 }}>事件统计：</Text>
              {group.eventCounts.map((item) => (
                <Tag key={item.event}>{item.event} {item.count}</Tag>
              ))}
            </Space>
          ) : null}
          {analysisResult.suggestions.length ? (
            <Alert
              type={analysisResult.warnings ? 'warning' : 'success'}
              showIcon
              message={analysisResult.suggestions.join(' ')}
              style={{ padding: '6px 10px' }}
            />
          ) : null}
        </Space>
      </div>
    );
  };

  const filterLogs = (logs: ParsedBusinessLog[]) => {
    const keyword = logSearchText.trim().toLowerCase();
    if (!keyword) return logs;
    return logs.filter((log) => [
      log.time,
      log.category,
      log.event,
      log.line,
      ...Object.entries(log.fields).flatMap(([key, value]) => [key, value]),
    ].join('\n').toLowerCase().includes(keyword));
  };

  const renderSemanticPanel = (items: SemanticLogItem[]) => {
    const visibleItems = filterSemanticItems(items);
    return (
      <div
        style={{
          width: 360,
          flex: '0 0 360px',
          border: '1px solid #f0f0f0',
          borderRadius: 6,
          background: '#fbfbfb',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '9px 12px', borderBottom: '1px solid #f0f0f0', background: '#fff' }}>
          <Space>
            <Text strong>语义分析</Text>
            <Tag>{visibleItems.length}</Tag>
          </Space>
        </div>
        <div style={{ maxHeight: 'calc(100vh - 430px)', overflowY: 'auto', padding: 10 }}>
          {visibleItems.length ? visibleItems.map((item) => (
          <div
            key={item.key}
            style={{
              padding: '8px 0',
              borderBottom: '1px solid #f0f0f0',
            }}
          >
            <Space size={[4, 4]} wrap style={{ marginBottom: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>{item.time}</Text>
              {getSemanticDisplayTag(item) ? <Tag style={{ marginInlineEnd: 0 }}>{getSemanticDisplayTag(item)}</Tag> : null}
              {item.semanticLevel && item.semanticLevel !== 'INFO' ? (
                <Tag color={item.semanticLevel === 'ERROR' || item.semanticLevel === 'FATAL' ? 'red' : 'orange'} style={{ marginInlineEnd: 0 }}>
                  {item.semanticLevel}
                </Tag>
              ) : null}
            </Space>
            <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>{item.title}</div>
            {item.apiPath && item.apiDocUrl ? (
              <Space direction="vertical" size={2} style={{ display: 'flex', marginTop: 4 }}>
                {item.apiName ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    接口名称：{item.apiName}
                  </Text>
                ) : null}
                <Text type="secondary" style={{ fontSize: 12 }}>
                  接口路径：<a href={item.apiDocUrl} target="_blank" rel="noreferrer"><Text code style={{ fontSize: 12, color: 'inherit' }}>{item.apiPath}</Text></a>
                </Text>
              </Space>
            ) : null}
            <Text type="secondary" style={{ display: 'block', fontSize: 12, lineHeight: 1.6 }}>
              {item.detail}
            </Text>
          </div>
          )) : (
            <Text type="secondary">当前筛选下没有可语义化日志。</Text>
          )}
        </div>
      </div>
    );
  };

  const renderNormalLogTable = (group: BusinessLogAnalysis['functionGroups'][number]) => {
    const filteredLogs = filterLogs(group.logs);
    const keyword = logSearchText.trim();
    const isSdkGroup = group.label === 'IM SDK' || group.label === 'RTC SDK';
    const semanticItems = filteredLogs.map(explainBusinessLog);
    return (
      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
        <Space direction="vertical" size="small" style={{ flex: 1, minWidth: 0 }}>
          {keyword ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              命中 {filteredLogs.length} 条
            </Text>
          ) : null}
          <Table
            size="small"
            bordered
            rowKey={(record: ParsedBusinessLog, index) => `${record.time}-${index}`}
            dataSource={filteredLogs}
            pagination={filteredLogs.length > 30 ? { pageSize: 30, showSizeChanger: false } : false}
            scroll={{ x: 1000, y: 'calc(100vh - 430px)' }}
            columns={[
              { title: '时间', dataIndex: 'time', width: 160, sorter: (a, b) => parseLogTimeValue(a.time) - parseLogTimeValue(b.time) },
              ...(!isSdkGroup ? [{
                title: '事件',
                dataIndex: 'event',
                width: 180,
                ellipsis: true,
                filters: group.eventCounts.map((item) => ({ text: `${item.event} (${item.count})`, value: item.event })),
                onFilter: (value: boolean | React.Key, record: ParsedBusinessLog) => record.event === value,
                render: (value: string, record: ParsedBusinessLog) => (
                  <Tooltip title={value}>
                    <Tag
                      color={record.level === 'info' ? 'default' : 'orange'}
                      style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}
                    >
                      {highlightText(value, keyword)}
                    </Tag>
                  </Tooltip>
                ),
              }] : []),
              {
                title: '日志',
                dataIndex: 'line',
                width: isSdkGroup ? 940 : 760,
                render: (value: string) => (
                  <pre
                    style={{
                      margin: 0,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontFamily: 'Menlo, Monaco, Consolas, monospace',
                      fontSize: 12,
                      lineHeight: 1.6,
                      background: 'transparent',
                    }}
                  >
                    {highlightText(value, keyword)}
                  </pre>
                ),
              },
            ]}
          />
        </Space>
        {renderSemanticPanel(semanticItems)}
      </div>
    );
  };

  const renderApiTimelineTable = (dataSource: ApiTimelineRow[], pageSize = 20) => {
    const normalizedApiSearchText = apiSearchText.trim().toLowerCase();
    const filteredDataSource = normalizedApiSearchText
      ? dataSource.filter((record) => [
        record.fullApi,
        normalizeApiPath(record.fullApi),
        record.api,
        record.parameters,
        record.requestLine,
        record.responseLine,
        ...(record.relatedEvents || []).map((event) => event.line),
        record.responseBody,
        formatJsonText(record.responseBody),
        record.retCode,
        record.retMsg,
        record.nntid,
        record.trackId,
      ].join('\n').toLowerCase().includes(normalizedApiSearchText))
      : dataSource;
    const semanticItems = filteredDataSource.map(explainApiRow);

    return (
      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
        <Space direction="vertical" size="small" style={{ flex: 1, minWidth: 0 }}>
          {normalizedApiSearchText && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              命中 {filteredDataSource.length} 条
            </Text>
          )}
          <Table
          size="small"
          bordered
          rowKey="key"
          dataSource={filteredDataSource}
          pagination={filteredDataSource.length > pageSize ? { pageSize } : false}
          scroll={{ x: 900 }}
          expandable={{
            expandedRowRender: (record) => {
              const responseBody = record.responseBody || extractResponseFieldFromLogLine(record.responseLine);
              const parsedResponse = parseJsonValue(responseBody);
              const formattedResponse = formatJsonText(responseBody);
              const responseJsonSearchKeyword = apiResponseJsonSearchText.trim();
              const expandedJsonKeys = parsedResponse && responseJsonSearchKeyword
                ? getMatchedJsonKeys(parsedResponse, responseJsonSearchKeyword)
                : parsedResponse
                  ? getDefaultExpandedJsonKeys(parsedResponse)
                  : [];
              return (
                <Space direction="vertical" size="small" style={{ width: '100%' }}>
                  <Text code style={{ display: 'block', whiteSpace: 'pre-wrap' }}>
                    请求：{record.matchedRequest ? highlightText(record.requestLine, apiSearchText.trim()) : <Tag color="gold">缺少请求日志</Tag>}
                  </Text>
                  <Text code style={{ display: 'block', whiteSpace: 'pre-wrap' }}>响应：{highlightText(removeResponseFieldFromLogLine(record.responseLine), apiSearchText.trim())}</Text>
                  {record.relatedEvents?.length ? (
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text type="secondary">关联 API 事件：</Text>
                      {record.relatedEvents.map((event, index) => (
                        <Text key={`${event.time}-${event.event}-${index}`} code style={{ display: 'block', whiteSpace: 'pre-wrap' }}>
                          {highlightText(event.line, apiSearchText.trim())}
                        </Text>
                      ))}
                    </Space>
                  ) : null}
                  {formattedResponse ? (
                    <div>
                      <Space style={{ marginBottom: 6 }}>
                        <Text type="secondary">响应 JSON：</Text>
                        <Input.Search
                          allowClear
                          size="small"
                          placeholder="检索响应 JSON"
                          value={apiResponseJsonSearchText}
                          onChange={(event) => setApiResponseJsonSearchText(event.target.value)}
                          style={{ width: 240 }}
                        />
                        <Button
                          size="small"
                          icon={<CopyOutlined />}
                          onClick={async () => {
                            const copied = await copyTextToClipboard(formattedResponse);
                            if (copied) {
                              message.success('已复制响应 JSON');
                            } else {
                              message.error('复制失败，请手动选中复制');
                            }
                          }}
                        >
                          复制
                        </Button>
                      </Space>
                      <div
                        style={{
                          padding: 8,
                          background: '#f6f8fa',
                          border: '1px solid #f0f0f0',
                          borderRadius: 4,
                          maxHeight: 420,
                          overflow: 'auto',
                        }}
                      >
                        {parsedResponse ? (
                          <Tree
                            key={`${record.key}-${responseJsonSearchKeyword}`}
                            blockNode
                            defaultExpandAll={false}
                            defaultExpandedKeys={expandedJsonKeys}
                            treeData={buildJsonTreeData(parsedResponse, responseJsonSearchKeyword)}
                            style={{ background: 'transparent', fontFamily: 'Menlo, Monaco, Consolas, monospace', fontSize: 12 }}
                          />
                        ) : (
                          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {highlightText(formattedResponse, responseJsonSearchKeyword)}
                          </pre>
                        )}
                      </div>
                    </div>
                  ) : null}
                </Space>
              );
            },
          }}
          columns={[
            {
              title: '请求时间',
              dataIndex: 'requestTime',
              width: 150,
              sorter: (a, b) => parseLogTimeValue(a.requestTime) - parseLogTimeValue(b.requestTime),
            },
            {
              title: '耗时',
              dataIndex: 'costMs',
              width: 90,
              sorter: (a, b) => {
                if (a.costMs === null && b.costMs === null) return 0;
                if (a.costMs === null) return 1;
                if (b.costMs === null) return -1;
                return a.costMs - b.costMs;
              },
              render: (value: number | null) => {
                if (value === null) return '-';
                return value > 350 ? <Tag color="orange">{value}ms</Tag> : `${value}ms`;
              },
            },
            {
              title: '结果',
              key: 'result',
              width: 220,
              render: (_, record) => {
                const color = record.status === 'failed' ? 'red' : record.status === 'pending' ? 'gold' : 'green';
                const text = record.status === 'pending'
                  ? '无响应'
                  : `${record.retCode}${record.retMsg && record.retMsg !== '-' ? ` / ${record.retMsg}` : ''}`;
                return <Tag color={color}>{text}</Tag>;
              },
            },
            {
              title: '接口',
              dataIndex: 'fullApi',
              ellipsis: true,
              render: (value: string) => {
                const path = normalizeApiPath(value);
                const url = buildApiDocsSearchUrl(value);
                return url ? <a href={url} target="_blank" rel="noreferrer">{highlightText(path, apiSearchText.trim())}</a> : highlightText(path, apiSearchText.trim());
              },
            },
          ]}
          />
        </Space>
        {renderSemanticPanel(semanticItems)}
      </div>
    );
  };

  return (
    <Modal
      title="业务日志在线分析"
      open={open}
      onCancel={onCancel}
      footer={null}
      width="88vw"
      destroyOnHidden
    >
      {analysisResult ? (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {renderAnalysisSummary()}
          <Space>
            {activeGroup?.label === 'API' ? (
              <Input.Search
                allowClear
                placeholder="检索接口 / 日志内容"
                value={apiSearchText}
                onChange={(event) => setApiSearchText(event.target.value)}
                style={{ width: 360 }}
              />
            ) : (
              <Input.Search
                allowClear
                placeholder="搜索当前分类日志"
                value={logSearchText}
                onChange={(event) => setLogSearchText(event.target.value)}
                style={{ width: 360 }}
              />
            )}
          </Space>
          <Tabs
            activeKey={currentActiveKey}
            onChange={setActiveTabKey}
            items={analysisResult.functionGroups.map((group) => ({
              key: group.key,
              label: `${group.label} (${group.label === 'API' ? analysisResult.apiTimeline.length : group.logs.length})`,
              children: group.label === 'API' ? renderApiTimelineTable(analysisResult.apiTimeline) : renderNormalLogTable(group),
            }))}
          />
        </Space>
      ) : null}
    </Modal>
  );
}
