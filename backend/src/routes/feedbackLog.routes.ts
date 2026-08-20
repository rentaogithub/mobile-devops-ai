import express, { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import fsPromises from 'fs/promises';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { URL } from 'url';
import { buildOpCookieHeader } from '../services/OpCookieJar';
import logger from '../utils/logger';
import { workflowIntegrationService } from '../services/WorkflowIntegrationService';
import { apiRequestSampleService } from '../services/ApiRequestSampleService';

const router = Router();
const OP_TARGET = (process.env.OP_PROXY_TARGET || 'https://op.nn.com').replace(/\/+$/, '');
const execFileAsync = promisify(execFile);

interface PreviewLogFile {
  name: string;
  path: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
  createdAtMs: number;
  modifiedAtMs: number;
}

interface FeedbackLogLine {
  id: string;
  time: string;
  content: string;
}

function resolveLogURL(rawURL: string): URL {
  if (!rawURL) {
    throw new Error('缺少日志下载地址');
  }

  const cleanURL = rawURL.includes(',') ? rawURL.substring(0, rawURL.indexOf(',')) : rawURL;
  if (/^https?:\/\//i.test(cleanURL)) {
    return new URL(cleanURL);
  }

  const target = new URL(OP_TARGET);
  let pathname = cleanURL.startsWith('/') ? cleanURL : `/${cleanURL}`;
  pathname = pathname.replace(/^\/op(?=\/|$)/, '') || '/';
  return new URL(pathname, target.origin);
}

function downloadFile(targetURL: URL, redirectCount = 0): Promise<Buffer> {
  if (redirectCount > 5) {
    return Promise.reject(new Error('日志下载重定向次数过多'));
  }

  const client = targetURL.protocol === 'https:' ? https : http;
  const cookieHeader = buildOpCookieHeader();

  return new Promise((resolve, reject) => {
    const req = client.get(
      targetURL,
      {
        headers: {
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
          'accept-encoding': 'identity',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        },
      },
      (res) => {
        const statusCode = res.statusCode || 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          res.resume();
          downloadFile(new URL(location, targetURL), redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          reject(new Error(`日志下载失败，状态码 ${statusCode}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );

    req.setTimeout(60000, () => {
      req.destroy(new Error('日志下载超时'));
    });
    req.on('error', reject);
  });
}

function isLogFile(entryName: string): boolean {
  const filename = path.basename(entryName);
  return /\.log$/i.test(filename) && !filename.startsWith('.');
}

function isBusinessLogFile(entryName: string): boolean {
  const filename = path.basename(entryName);
  return (
    /^logs.*\.log$/i.test(filename) ||
    /^app_nn_\d{8}_\d{6}(?:_\d+)?\.log$/i.test(filename) ||
    /(?:^|[_-])\d{8}[_-]\d{6}(?:[_-]\d+)?\.log$/i.test(filename)
  );
}

function selectPreviewLogEntries(entries: string[]): string[] {
  const logEntries = entries.filter((item) => item && isLogFile(item));
  const businessEntries = logEntries.filter(isBusinessLogFile);
  return businessEntries.length > 0 ? businessEntries : logEntries;
}

function isTargetLogFile(entryName: string): boolean {
  return isLogFile(entryName);
}

function parseFeedbackLogLine(line: string): { time: string; content: string } | null {
  const prefixedFullTimeMatch = line.match(/^(\d{4}[/-]\d{2}[/-]\d{2}\s+\d{2}:\d{2}:\d{2}(?:[.:]\d+)?)\s*(.*)$/);
  if (prefixedFullTimeMatch) {
    return {
      time: prefixedFullTimeMatch[1],
      content: prefixedFullTimeMatch[2] || '',
    };
  }

  const shortTimeMatch = line.match(/^\[(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s*(.*)$/);
  if (shortTimeMatch) {
    return {
      time: shortTimeMatch[1],
      content: shortTimeMatch[2] || '',
    };
  }

  const fullTimeMatch = line.match(/^(.*?)(?:\[)(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:\])(.*)$/);
  if (fullTimeMatch) {
    return {
      time: fullTimeMatch[2],
      content: `${fullTimeMatch[1]}${fullTimeMatch[3]}`.trim(),
    };
  }

  return null;
}

function parseFeedbackLogContent(content: string): FeedbackLogLine[] {
  if (!content) {
    return [];
  }

  const rows: FeedbackLogLine[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const parsed = parseFeedbackLogLine(line);
    if (parsed || rows.length === 0) {
      rows.push({
        id: String(index),
        time: parsed?.time || '-',
        content: parsed?.content ?? line,
      });
      return;
    }

    const last = rows[rows.length - 1];
    last.content = `${last.content}\n${line}`;
  });
  return rows;
}

async function assertSafePreviewPath(filePath: string): Promise<string> {
  if (!filePath) {
    throw new Error('缺少日志文件路径');
  }

  const resolvedPath = await fsPromises.realpath(filePath);
  const tempRoot = await fsPromises.realpath(os.tmpdir());
  const relative = path.relative(tempRoot, resolvedPath);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !relative.split(path.sep).some((part) => part.startsWith('feedback-log-')) ||
    !isTargetLogFile(resolvedPath)
  ) {
    throw new Error('非法日志文件路径');
  }
  return resolvedPath;
}

async function collectPreviewFiles(filePaths: string[]): Promise<PreviewLogFile[]> {
  const files: PreviewLogFile[] = [];
  for (const filePath of filePaths) {
    const stat = await fsPromises.stat(filePath);
    files.push({
      name: path.basename(filePath),
      path: filePath,
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString(),
      createdAtMs: stat.birthtimeMs,
      modifiedAtMs: stat.mtimeMs,
    });
  }
  return files.sort((left, right) => {
    const timeDiff = (right.createdAtMs || right.modifiedAtMs) - (left.createdAtMs || left.modifiedAtMs);
    return timeDiff || left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
  });
}

async function findLogFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findLogFiles(fullPath));
    } else if (entry.isFile() && isTargetLogFile(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

async function extractLogsWithUnzip(archivePath: string, tempDir: string): Promise<PreviewLogFile[]> {
  const { stdout } = await execFileAsync('unzip', ['-Z1', archivePath], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const entries = selectPreviewLogEntries(stdout
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean));

  if (entries.length === 0) {
    return [];
  }

  await execFileAsync('unzip', ['-qq', '-o', '-j', archivePath, ...entries, '-d', tempDir], {
    maxBuffer: 10 * 1024 * 1024,
  });

  const extractedFiles = (await fsPromises.readdir(tempDir))
    .filter(isTargetLogFile)
    .map((filename) => path.join(tempDir, filename));
  return collectPreviewFiles(extractedFiles);
}

async function extractLogsWithBsdtar(archivePath: string, tempDir: string): Promise<PreviewLogFile[]> {
  const { stdout } = await execFileAsync('bsdtar', ['-tf', archivePath], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const entries = selectPreviewLogEntries(stdout
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean));

  if (entries.length === 0) {
    return [];
  }

  const extractDir = path.join(tempDir, 'extracted');
  await fsPromises.mkdir(extractDir, { recursive: true });
  await execFileAsync('bsdtar', ['-xf', archivePath, '-C', extractDir, ...entries], {
    maxBuffer: 10 * 1024 * 1024,
  });

  return collectPreviewFiles(await findLogFiles(extractDir));
}

router.post('/analyze-archive', express.raw({ type: ['application/zip', 'application/octet-stream'], limit: '80mb' }), async (req: Request, res: Response) => {
  try {
    const archive = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!archive.length) {
      throw new Error('缺少日志压缩包');
    }

    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'feedback-log-'));
    const archivePath = path.join(tempDir, 'nn-logs.zip');
    await fsPromises.writeFile(archivePath, archive);

    let files: PreviewLogFile[] = [];
    let unzipErrorMessage = '';
    try {
      files = await extractLogsWithUnzip(archivePath, tempDir);
    } catch (unzipError) {
      unzipErrorMessage = unzipError instanceof Error ? unzipError.message : String(unzipError);
      logger.warn('unzip 解压 NN 日志失败，回退到 bsdtar', { error: unzipErrorMessage });
      files = await extractLogsWithBsdtar(archivePath, tempDir);
    }

    if (files.length === 0) {
      throw new Error(unzipErrorMessage || '压缩包中未找到业务日志文件');
    }

    const lines: string[] = [];
    const analyzedFiles: Array<{ name: string; path: string; lineCount: number; size: number }> = [];
    for (const file of files) {
      const content = await fsPromises.readFile(file.path, 'utf8');
      const fileLines = content.split(/\r?\n/).filter((line) => line.trim());
      lines.push(...fileLines);
      analyzedFiles.push({
        name: file.name,
        path: file.path,
        lineCount: fileLines.length,
        size: file.size,
      });
    }

    const apiRequestSampleCount = apiRequestSampleService.ingestLogLines(lines, {
      source: 'feedback_log',
      sourceRef: analyzedFiles.map((file) => file.name).join(','),
    });

    res.json({
      success: true,
      data: {
        files: analyzedFiles,
        lines,
        lineCount: lines.length,
        apiRequestSampleCount,
      },
    });
  } catch (error: any) {
    logger.error(`分析 NN 日志压缩包失败: ${error.message}`);
    res.status(500).json({ success: false, error: error.message || '分析 NN 日志压缩包失败' });
  }
});

router.post('/preview', async (req: Request, res: Response) => {
  try {
    const rawURL = typeof req.body?.url === 'string' ? req.body.url : '';
    const targetURL = resolveLogURL(rawURL);
    const archive = await downloadFile(targetURL);
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'feedback-log-'));
    const archivePath = path.join(tempDir, 'feedback-log.zip');
    await fsPromises.writeFile(archivePath, archive);

    let files: PreviewLogFile[] = [];
    let unzipErrorMessage = '';
    try {
      files = await extractLogsWithUnzip(archivePath, tempDir);
    } catch (unzipError) {
      unzipErrorMessage = unzipError instanceof Error ? unzipError.message : String(unzipError);
      logger.warn('unzip 解压反馈日志失败，回退到 bsdtar', { error: unzipErrorMessage });
      files = await extractLogsWithBsdtar(archivePath, tempDir);
    }

    if (files.length === 0 && unzipErrorMessage) {
      logger.warn('反馈日志压缩包未提取到业务日志文件', { unzipError: unzipErrorMessage });
    }

    res.json({
      success: true,
      data: {
        tempDir,
        files,
      },
    });
  } catch (error: any) {
    logger.error(`预览反馈日志失败: ${error.message}`);
    res.status(500).json({ success: false, error: error.message || '预览反馈日志失败' });
  }
});

router.post('/read', async (req: Request, res: Response) => {
  try {
    const rawPath = typeof req.body?.path === 'string' ? req.body.path : '';
    const filePath = await assertSafePreviewPath(rawPath);
    const content = await fsPromises.readFile(filePath, 'utf8');
    const rows = parseFeedbackLogContent(content);
    const apiRequestSampleCount = apiRequestSampleService.ingestLogLines(rows.map((row) => row.content), {
      source: 'feedback_log',
      sourceRef: filePath,
    });
    const workflowSync = workflowIntegrationService.syncFeedbackLog(rows, {
      ...(req.body?.context || {}),
      path: filePath,
      uid: req.body?.uid,
      appVersion: req.body?.appVersion,
      buildNumber: req.body?.buildNumber,
    });
    res.json({
      success: true,
      data: {
        path: filePath,
        rows,
        apiRequestSampleCount,
        workflowSync: workflowSync ? { artifactId: workflowSync.artifactId, issueCount: workflowSync.issueCount } : undefined,
      },
    });
  } catch (error: any) {
    logger.error(`读取反馈日志文件失败: ${error.message}`);
    res.status(500).json({ success: false, error: error.message || '读取反馈日志文件失败' });
  }
});

export default router;
