import { execFile } from 'child_process';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { buildOpCookieHeader, getOpAccessToken } from './OpCookieJar';

interface FeedbackLogRecord {
  id?: string | number;
  userId?: string | number;
  type?: string;
  type_dictText?: string;
  logType_dictText?: string;
  version?: string;
  crashLogUrl?: string;
  crashTime?: string;
  createTime?: string;
  [key: string]: unknown;
}

interface LogSearchInput {
  uid?: string;
  deviceId?: string;
  keyword?: string;
  startTime?: string;
  endTime?: string;
  crashTime?: string;
  windowMinutes?: number;
  limit?: number;
}

interface ParsedLogLine {
  time: string;
  content: string;
}

const OP_TARGET = (process.env.OP_PROXY_TARGET || 'https://op.nn.com').replace(/\/+$/, '');
const MAX_ARCHIVE_BYTES = Number(process.env.ASSISTANT_LOG_MAX_ARCHIVE_BYTES || 50 * 1024 * 1024);
const execFileAsync = promisify(execFile);

function parseTimestamp(value?: string) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function parseLogTimestamp(value: string, archiveTime?: string) {
  const text = String(value || '').trim();
  const short = text.match(/^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  if (short) {
    const archiveTimestamp = parseTimestamp(archiveTime);
    const year = archiveTimestamp ? new Date(archiveTimestamp).getFullYear() : new Date().getFullYear();
    return parseTimestamp(`${year}-${short[1]}`);
  }
  return parseTimestamp(text);
}

function parseLine(line: string): ParsedLogLine | null {
  const shortTime = line.match(/^\[(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s*(.*)$/);
  if (shortTime) return { time: shortTime[1], content: shortTime[2] || '' };
  const fullTime = line.match(/^(.*?)(?:\[)(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:\])(.*)$/);
  if (fullTime) return { time: fullTime[2], content: `${fullTime[1]}${fullTime[3]}`.trim() };
  const isoTime = line.match(/^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.*)$/);
  if (isoTime) return { time: isoTime[1], content: isoTime[2] || '' };
  return null;
}

function parseContent(content: string): ParsedLogLine[] {
  const rows: ParsedLogLine[] = [];
  content.split(/\r?\n/).forEach((line) => {
    const parsed = parseLine(line);
    if (parsed || rows.length === 0) {
      rows.push(parsed || { time: '-', content: line });
      return;
    }
    const previous = rows[rows.length - 1];
    previous.content = `${previous.content}\n${line}`.slice(0, 8_000);
  });
  return rows;
}

function recordTime(record: FeedbackLogRecord) {
  return parseTimestamp(record.crashTime || record.createTime);
}

function browserDownloadUrl(rawUrl?: string) {
  const cleanUrl = String(rawUrl || '').split(',')[0].trim();
  if (!cleanUrl) return undefined;
  if (/^https?:\/\//i.test(cleanUrl)) return cleanUrl;
  const pathname = cleanUrl.startsWith('/') ? cleanUrl : `/${cleanUrl}`;
  return pathname.startsWith('/op/') ? pathname : `/op${pathname}`;
}

function normalizePayload(payload: any): FeedbackLogRecord[] {
  if (payload && (payload.success === false || (payload.code !== undefined && ![0, 200].includes(Number(payload.code))))) {
    throw new Error(payload.message || payload.error || '查询反馈日志失败');
  }
  const result = payload?.result || payload?.data || payload;
  return Array.isArray(result?.records) ? result.records : Array.isArray(result) ? result : [];
}

function isLogFile(entryName: string) {
  const filename = path.basename(entryName);
  return /\.log$/i.test(filename) && !filename.startsWith('.');
}

function isBusinessLogFile(entryName: string) {
  const filename = path.basename(entryName);
  return (
    /^logs.*\.log$/i.test(filename) ||
    /^app_nn_\d{8}_\d{6}(?:_\d+)?\.log$/i.test(filename) ||
    /(?:^|[_-])\d{8}[_-]\d{6}(?:[_-]\d+)?\.log$/i.test(filename)
  );
}

function selectLogEntries(entries: string[]) {
  const logEntries = entries.filter((item) => item && isLogFile(item));
  const businessEntries = logEntries.filter(isBusinessLogFile);
  return businessEntries.length > 0 ? businessEntries : logEntries;
}

export class OperationalLogService {
  private authHeaders() {
    const token = getOpAccessToken();
    const cookie = buildOpCookieHeader();
    return {
      Accept: 'application/json',
      'User-Agent': 'nn-ios-platform-assistant/1.0',
      ...(token ? { 'x-access-token': token } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    };
  }

  private resolveDownloadUrl(rawUrl: string) {
    const cleanUrl = String(rawUrl || '').split(',')[0].trim();
    if (!cleanUrl) throw new Error('反馈日志缺少下载地址');
    const relativeUrl = (cleanUrl.startsWith('/') ? cleanUrl : `/${cleanUrl}`).replace(/^\/op(?=\/|$)/, '') || '/';
    const url = /^https?:\/\//i.test(cleanUrl) ? new URL(cleanUrl) : new URL(relativeUrl, OP_TARGET);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('反馈日志地址协议不受支持');
    if (/^(localhost|127\.|0\.|169\.254\.)/i.test(url.hostname)) throw new Error('反馈日志地址不在允许范围内');
    return url;
  }

  private async listRecords(identifier: string, limit: number) {
    const url = new URL('/jeecg-boot/crash_log/list', OP_TARGET);
    url.searchParams.set('_t', String(Math.floor(Date.now() / 1000)));
    url.searchParams.set('query', identifier);
    url.searchParams.set('reqChannel', '1');
    url.searchParams.set('column', 'createTime');
    url.searchParams.set('order', 'desc');
    url.searchParams.set('field', 'id,,action,userId,type,type_dictText,logType_dictText,reqChannel_dictText,version,crashLogUrl,crashTime,createTime');
    url.searchParams.set('pageNo', '1');
    url.searchParams.set('pageSize', String(Math.min(Math.max(limit, 1), 30)));
    url.searchParams.set('queryParam', '');
    url.searchParams.set('page', '0');
    const response = await fetch(url, { headers: this.authHeaders(), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`反馈日志查询失败：HTTP ${response.status}`);
    try {
      return normalizePayload(JSON.parse(text));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('反馈日志服务返回了无效数据，可能需要先在日志页面刷新 OP 登录状态');
      throw error;
    }
  }

  private async download(record: FeedbackLogRecord) {
    const url = this.resolveDownloadUrl(String(record.crashLogUrl || ''));
    const response = await fetch(url, { headers: this.authHeaders(), redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`日志下载失败：HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_ARCHIVE_BYTES) throw new Error('日志压缩包超过大小限制');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error('日志压缩包超过大小限制');
    return buffer;
  }

  private async extractFiles(buffer: Buffer) {
    const isZip = buffer.subarray(0, 2).toString('ascii') === 'PK';
    if (!isZip) return [{ name: 'feedback.log', content: buffer.toString('utf8') }];
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'assistant-feedback-log-'));
    const archivePath = path.join(tempDir, 'feedback-log.zip');
    try {
      await fsPromises.writeFile(archivePath, buffer);
      const { stdout } = await execFileAsync('unzip', ['-Z1', archivePath], { maxBuffer: 10 * 1024 * 1024 });
      const entries = selectLogEntries(String(stdout || '')
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean))
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
        .slice(0, 8);
      const files: Array<{ name: string; content: string }> = [];
      for (const entry of entries) {
        const extracted = await execFileAsync('unzip', ['-p', archivePath, entry], { maxBuffer: 12 * 1024 * 1024 });
        files.push({ name: path.basename(entry), content: String(extracted.stdout || '') });
      }
      return files;
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  }

  async search(input: LogSearchInput) {
    const uid = String(input.uid || '').trim();
    const deviceId = String(input.deviceId || '').trim();
    const keyword = String(input.keyword || '').trim();
    const identifier = uid || deviceId;
    if (!identifier) throw new Error('日志查询至少需要 UID 或 DeviceID');
    const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 10);
    const windowMinutes = Math.min(Math.max(Number(input.windowMinutes) || 10, 1), 1440);
    const crashAt = parseTimestamp(input.crashTime);
    const startAt = parseTimestamp(input.startTime) || (crashAt ? crashAt - windowMinutes * 60_000 : 0);
    const endAt = parseTimestamp(input.endTime) || (crashAt ? crashAt + windowMinutes * 60_000 : 0);
    const records = (await this.listRecords(identifier, Math.max(limit, 10)))
      .filter((record) => !startAt || !recordTime(record) || recordTime(record) >= startAt)
      .filter((record) => !endAt || !recordTime(record) || recordTime(record) <= endAt)
      .sort((left, right) => recordTime(right) - recordTime(left))
      .slice(0, limit);

    if (!keyword && !input.crashTime && !input.startTime && !input.endTime) {
      const archives = records.map((record) => ({
        id: record.id,
        uploadTime: record.createTime || record.crashTime,
        version: record.version,
        downloadUrl: browserDownloadUrl(record.crashLogUrl),
      }));
      return {
        kind: 'log_search',
        query: { uid: uid || undefined, deviceId: deviceId || undefined },
        archiveCount: records.length,
        matchCount: 0,
        archives,
        matches: [],
        warnings: [],
        truncated: false,
        quickActions: [],
      };
    }

    const matches: Array<Record<string, unknown>> = [];
    const archives: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    for (const record of records.slice(0, 5)) {
      if (!record.crashLogUrl) {
        archives.push({ id: record.id, time: record.crashTime || record.createTime, version: record.version, status: 'missing_url' });
        continue;
      }
      try {
        const files = await this.extractFiles(await this.download(record));
        let archiveMatches = 0;
        for (const file of files) {
          for (const row of parseContent(file.content)) {
            const searchable = `${row.time}\n${row.content}`.toLowerCase();
            if (keyword && !searchable.includes(keyword.toLowerCase())) continue;
            if (deviceId && !searchable.includes(deviceId.toLowerCase())) continue;
            if (uid && !searchable.includes(uid.toLowerCase()) && keyword === '') {
              // UID 已用于筛选反馈记录；日志正文不一定重复打印 UID，因此不强制排除。
            }
            const lineAt = parseLogTimestamp(row.time, String(record.crashTime || record.createTime || ''));
            if (startAt && lineAt && lineAt < startAt) continue;
            if (endAt && lineAt && lineAt > endAt) continue;
            matches.push({
              archiveId: record.id,
              archiveTime: record.crashTime || record.createTime,
              version: record.version,
              file: file.name,
              time: row.time,
              content: row.content.slice(0, 1_200),
            });
            archiveMatches += 1;
            if (matches.length >= 100) break;
          }
          if (matches.length >= 100) break;
        }
        archives.push({
          id: record.id,
          time: record.crashTime || record.createTime,
          version: record.version,
          type: record.logType_dictText || record.type_dictText || record.type,
          fileCount: files.length,
          matchCount: archiveMatches,
          status: 'searched',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`日志 ${record.id || record.crashTime || ''}：${message}`);
        archives.push({ id: record.id, time: record.crashTime || record.createTime, version: record.version, status: 'failed', error: message });
      }
    }

    return {
      kind: 'log_search',
      query: { uid: uid || undefined, deviceId: deviceId || undefined, keyword: keyword || undefined, startTime: startAt ? new Date(startAt).toISOString() : undefined, endTime: endAt ? new Date(endAt).toISOString() : undefined },
      archiveCount: records.length,
      matchCount: matches.length,
      archives,
      matches,
      warnings,
      truncated: matches.length >= 100,
      quickActions: [
        ...(crashAt ? [{ label: '扩大到前后 30 分钟', prompt: `查询${uid ? `用户 ${uid}` : `设备 ${deviceId}`}在 ${input.crashTime} 前后 30 分钟的日志${keyword ? `，关键词 ${keyword}` : ''}` }] : []),
        ...(matches.length > 0 ? [{ label: '分析异常链路', prompt: '分析刚才日志结果中的错误链路、关键时间点和最可能根因' }] : []),
      ],
    };
  }
}

export const operationalLogService = new OperationalLogService();
