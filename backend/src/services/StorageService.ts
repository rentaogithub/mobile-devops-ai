import { getDatabase } from '../database';
import { DSYMInfo } from '../types';
import fs from 'fs';
import path from 'path';

export class StorageService {
  private db = getDatabase();

  /**
   * 保存 dSYM 信息到数据库
   */
  async saveDSYMInfo(info: Omit<DSYMInfo, 'id' | 'uploadTime'>): Promise<DSYMInfo> {
    const stmt = this.db.prepare(`
      INSERT INTO dsym_info (uuid, app_name, version, build_number, architecture, file_path, file_size, notes, related_app_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      info.uuid,
      info.appName,
      info.version,
      info.buildNumber || null,
      info.architecture,
      info.filePath,
      info.fileSize,
      info.notes || null,
      info.relatedAppVersions ? JSON.stringify(info.relatedAppVersions) : null
    );

    // 获取插入的记录
    const inserted = this.db
      .prepare('SELECT * FROM dsym_info WHERE id = ?')
      .get(result.lastInsertRowid) as {
      id: number;
      uuid: string;
      app_name: string;
      version: string;
      build_number: string | null;
      architecture: string;
      file_path: string;
      file_size: number;
      notes: string | null;
      related_app_version: string | null;
      upload_time: string;
    };

    return this.mapToDTO(inserted);
  }

  /**
   * 更新 dSYM 信息
   */
  async updateDSYMInfo(
    uuid: string,
    updates: { version?: string; notes?: string; relatedAppVersions?: string[] }
  ): Promise<DSYMInfo> {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.version !== undefined) {
      fields.push('version = ?');
      values.push(updates.version);
    }

    if (updates.notes !== undefined) {
      fields.push('notes = ?');
      values.push(updates.notes);
    }

    if (updates.relatedAppVersions !== undefined) {
      fields.push('related_app_version = ?');
      values.push(JSON.stringify(updates.relatedAppVersions));
    }

    if (fields.length === 0) {
      throw new Error('没有要更新的字段');
    }

    values.push(uuid);

    const stmt = this.db.prepare(`
      UPDATE dsym_info 
      SET ${fields.join(', ')}
      WHERE uuid = ?
    `);

    stmt.run(...values);

    const updated = await this.findByUUID(uuid);
    if (!updated) {
      throw new Error('更新后未找到记录');
    }

    return updated;
  }

  /**
   * 根据 UUID 查找 dSYM
   */
  async findByUUID(uuid: string): Promise<DSYMInfo | null> {
    const stmt = this.db.prepare('SELECT * FROM dsym_info WHERE uuid = ?');
    const result = stmt.get(uuid) as {
      id: number;
      uuid: string;
      app_name: string;
      version: string;
      build_number: string | null;
      architecture: string;
      file_path: string;
      file_size: number;
      notes: string | null;
      related_app_version: string | null;
      upload_time: string;
    } | undefined;

    return result ? this.mapToDTO(result) : null;
  }

  /**
   * 获取所有 dSYM
   */
  async getAllDSYMs(): Promise<DSYMInfo[]> {
    const stmt = this.db.prepare('SELECT * FROM dsym_info ORDER BY upload_time DESC');
    const results = stmt.all() as {
      id: number;
      uuid: string;
      app_name: string;
      version: string;
      build_number: string | null;
      architecture: string;
      file_path: string;
      file_size: number;
      notes: string | null;
      related_app_version: string | null;
      upload_time: string;
    }[];

    return results.map((row) => this.mapToDTO(row));
  }

  /**
   * 删除 dSYM
   */
  async deleteDSYM(uuid: string): Promise<void> {
    // 先获取文件路径
    const dsym = await this.findByUUID(uuid);
    if (!dsym) {
      throw new Error(`dSYM with UUID ${uuid} not found`);
    }

    // 删除数据库记录
    const stmt = this.db.prepare('DELETE FROM dsym_info WHERE uuid = ?');
    stmt.run(uuid);

    // 删除文件系统中的文件
    const dsymDir = path.dirname(dsym.filePath);
    if (fs.existsSync(dsymDir)) {
      fs.rmSync(dsymDir, { recursive: true, force: true });
    }
  }

  /**
   * 检查 UUID 是否已存在
   */
  async exists(uuid: string): Promise<boolean> {
    const result = await this.findByUUID(uuid);
    return result !== null;
  }

  /**
   * 将数据库行映射为 DTO
   */
  private mapToDTO(row: {
    id: number;
    uuid: string;
    app_name: string;
    version: string;
    build_number: string | null;
    architecture: string;
    file_path: string;
    file_size: number;
    upload_time: string;
    notes?: string | null;
    related_app_version?: string | null;
  }): DSYMInfo {
    let relatedAppVersions: string[] | undefined = undefined;
    if (row.related_app_version) {
      try {
        relatedAppVersions = JSON.parse(row.related_app_version);
      } catch (e) {
        // 兼容旧数据：如果不是 JSON，当作单个版本处理
        relatedAppVersions = [row.related_app_version];
      }
    }

    return {
      id: row.id,
      uuid: row.uuid,
      appName: row.app_name,
      version: row.version,
      buildNumber: row.build_number || undefined,
      architecture: row.architecture,
      filePath: row.file_path,
      fileSize: row.file_size,
      uploadTime: row.upload_time,
      notes: row.notes || undefined,
      relatedAppVersions,
    };
  }
}
