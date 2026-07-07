import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';
import { adminMiddleware } from '../middleware/auth';
import logger from '../utils/logger';

const router = Router();

interface IncomingUserRecord {
  id?: string;
  userId?: string | number;
  nickName?: string;
  telNum?: string;
  email?: string;
  nnNumber?: string;
  userType_dictText?: string;
  status_dictText?: string;
  registerCanal?: string;
  createTime?: string;
  remark?: string;
}

function ensureTable() {
  getDatabase().prepare(`
    CREATE TABLE IF NOT EXISTS user_query_records (
      record_key TEXT PRIMARY KEY,
      id TEXT,
      user_id TEXT,
      nick_name TEXT,
      tel_num TEXT,
      email TEXT,
      nn_number TEXT,
      user_type_text TEXT,
      status_text TEXT,
      register_canal TEXT,
      create_time TEXT,
      search_key TEXT,
      remark TEXT DEFAULT '',
      last_query_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
}

function getRecordKey(record: IncomingUserRecord): string {
  return String(record.userId || record.id || record.telNum || record.email || '').trim();
}

function normalizeText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

function listRecords() {
  ensureTable();
  return getDatabase().prepare(`
    SELECT
      record_key AS recordKey,
      id,
      user_id AS userId,
      nick_name AS nickName,
      tel_num AS telNum,
      email,
      nn_number AS nnNumber,
      user_type_text AS userType_dictText,
      status_text AS status_dictText,
      register_canal AS registerCanal,
      create_time AS createTime,
      search_key AS searchKey,
      remark,
      last_query_at AS lastQueryAt
    FROM user_query_records
    ORDER BY last_query_at DESC
    LIMIT 100
  `).all();
}

router.get('/', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: listRecords() });
  } catch (error: any) {
    logger.error(`查询用户记录失败: ${error.message}`);
    res.status(500).json({ success: false, error: '查询用户记录失败' });
  }
});

router.post('/batch', (req: Request, res: Response) => {
  try {
    ensureTable();
    const records = Array.isArray(req.body?.records) ? req.body.records as IncomingUserRecord[] : [];
    const searchKey = normalizeText(req.body?.searchKey);
    const now = new Date().toISOString();
    const stmt = getDatabase().prepare(`
      INSERT INTO user_query_records (
        record_key,
        id,
        user_id,
        nick_name,
        tel_num,
        email,
        nn_number,
        user_type_text,
        status_text,
        register_canal,
        create_time,
        search_key,
        remark,
        last_query_at,
        updated_at
      ) VALUES (
        @recordKey,
        @id,
        @userId,
        @nickName,
        @telNum,
        @email,
        @nnNumber,
        @userTypeText,
        @statusText,
        @registerCanal,
        @createTime,
        @searchKey,
        @remark,
        @lastQueryAt,
        @updatedAt
      )
      ON CONFLICT(record_key) DO UPDATE SET
        id = excluded.id,
        user_id = excluded.user_id,
        nick_name = excluded.nick_name,
        tel_num = excluded.tel_num,
        email = excluded.email,
        nn_number = excluded.nn_number,
        user_type_text = excluded.user_type_text,
        status_text = excluded.status_text,
        register_canal = excluded.register_canal,
        create_time = excluded.create_time,
        search_key = excluded.search_key,
        last_query_at = excluded.last_query_at,
        updated_at = excluded.updated_at
    `);

    const upsert = getDatabase().transaction((items: IncomingUserRecord[]) => {
      items.forEach((record) => {
        const recordKey = getRecordKey(record);
        if (!recordKey) {
          return;
        }
        stmt.run({
          recordKey,
          id: normalizeText(record.id),
          userId: normalizeText(record.userId),
          nickName: normalizeText(record.nickName),
          telNum: normalizeText(record.telNum),
          email: normalizeText(record.email),
          nnNumber: normalizeText(record.nnNumber),
          userTypeText: normalizeText(record.userType_dictText),
          statusText: normalizeText(record.status_dictText),
          registerCanal: normalizeText(record.registerCanal),
          createTime: normalizeText(record.createTime),
          searchKey,
          remark: normalizeText(record.remark),
          lastQueryAt: now,
          updatedAt: now,
        });
      });
    });

    upsert(records);
    res.json({ success: true, data: listRecords() });
  } catch (error: any) {
    logger.error(`保存用户查询记录失败: ${error.message}`);
    res.status(500).json({ success: false, error: '保存用户查询记录失败' });
  }
});

router.put('/:recordKey/remark', adminMiddleware, (req: Request, res: Response) => {
  try {
    ensureTable();
    const recordKey = req.params.recordKey;
    const remark = normalizeText(req.body?.remark);
    const now = new Date().toISOString();

    const result = getDatabase().prepare(`
      UPDATE user_query_records
      SET remark = @remark, updated_at = @updatedAt
      WHERE record_key = @recordKey
    `).run({ recordKey, remark, updatedAt: now });

    if (result.changes === 0) {
      res.status(404).json({ success: false, error: '用户记录不存在' });
      return;
    }

    res.json({ success: true, data: listRecords() });
  } catch (error: any) {
    logger.error(`更新用户备注失败: ${error.message}`);
    res.status(500).json({ success: false, error: '更新用户备注失败' });
  }
});

router.delete('/:recordKey', adminMiddleware, (req: Request, res: Response) => {
  try {
    ensureTable();
    getDatabase().prepare('DELETE FROM user_query_records WHERE record_key = ?').run(req.params.recordKey);
    res.json({ success: true, data: listRecords() });
  } catch (error: any) {
    logger.error(`删除用户查询记录失败: ${error.message}`);
    res.status(500).json({ success: false, error: '删除用户查询记录失败' });
  }
});

router.delete('/', adminMiddleware, (_req: Request, res: Response) => {
  try {
    ensureTable();
    getDatabase().prepare('DELETE FROM user_query_records').run();
    res.json({ success: true, data: [] });
  } catch (error: any) {
    logger.error(`清空用户查询记录失败: ${error.message}`);
    res.status(500).json({ success: false, error: '清空用户查询记录失败' });
  }
});

export default router;
