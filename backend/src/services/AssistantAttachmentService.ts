import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { currentProjectId } from './ProductLineContext';

export interface AssistantAttachment {
  id: string;
  userId: string;
  projectId: string;
  originalName: string;
  path: string;
  size: number;
  sha256: string;
  createdAt: number;
  expiresAt: number;
}

const ALLOWED_EXTENSIONS = new Set(['.crash', '.ips', '.txt']);
const TTL_MS = 15 * 60 * 1000;

export class AssistantAttachmentService {
  readonly uploadDir = path.join(os.tmpdir(), 'nn-ios-assistant-uploads');
  private readonly attachments = new Map<string, AssistantAttachment>();

  constructor() {
    fs.mkdirSync(this.uploadDir, { recursive: true });
  }

  register(file: Express.Multer.File, userId: string) {
    this.cleanupExpired();
    const extension = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      fs.unlinkSync(file.path);
      throw new Error('仅支持 .crash、.ips、.txt 崩溃日志');
    }
    const id = `attachment_${randomUUID()}`;
    const projectId = currentProjectId();
    const projectDirectory = path.join(this.uploadDir, projectId.replace(/[^A-Za-z0-9_.-]/g, '_'));
    fs.mkdirSync(projectDirectory, { recursive: true });
    const target = path.join(projectDirectory, `${id}${extension}`);
    fs.renameSync(file.path, target);
    const content = fs.readFileSync(target);
    const attachment: AssistantAttachment = {
      id,
      userId,
      projectId,
      originalName: path.basename(file.originalname).slice(0, 240),
      path: target,
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      createdAt: Date.now(),
      expiresAt: Date.now() + TTL_MS,
    };
    this.attachments.set(id, attachment);
    return this.publicMetadata(attachment);
  }

  get(id: string, userId: string) {
    this.cleanupExpired();
    const attachment = this.attachments.get(id);
    if (!attachment || attachment.userId !== userId || attachment.projectId !== currentProjectId() || !fs.existsSync(attachment.path)) return null;
    return attachment;
  }

  readText(id: string, userId: string, maxLength = 200_000) {
    const attachment = this.get(id, userId);
    if (!attachment) throw new Error('附件不存在或已过期');
    return fs.readFileSync(attachment.path, 'utf8').slice(0, maxLength);
  }

  private publicMetadata(attachment: AssistantAttachment) {
    return {
      id: attachment.id,
      name: attachment.originalName,
      size: attachment.size,
      sha256: attachment.sha256,
      expiresAt: new Date(attachment.expiresAt).toISOString(),
    };
  }

  cleanupExpired() {
    const timestamp = Date.now();
    for (const [id, attachment] of this.attachments.entries()) {
      if (attachment.expiresAt > timestamp) continue;
      try { if (fs.existsSync(attachment.path)) fs.unlinkSync(attachment.path); } catch { /* ignore */ }
      this.attachments.delete(id);
    }
  }
}

export const assistantAttachmentService = new AssistantAttachmentService();
