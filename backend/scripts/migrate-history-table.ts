import { getDatabase } from '../src/database/connection';

// 创建历史记录表
function migrateHistoryTable() {
  const db = getDatabase();

  try {
    console.log('检查 symbolication_history 表是否存在...');
    
    const historyTableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbolication_history'")
      .get();

    if (historyTableExists) {
      console.log('✅ symbolication_history 表已存在');
      return;
    }

    console.log('创建 symbolication_history 表...');
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS symbolication_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_version TEXT NOT NULL,
        crash_type TEXT,
        crash_reason TEXT,
        original_log TEXT NOT NULL,
        symbolicated_log TEXT NOT NULL,
        used_uuids TEXT NOT NULL,
        ai_analysis TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('创建索引...');
    
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_app_version ON symbolication_history(app_version);
      CREATE INDEX IF NOT EXISTS idx_created_at ON symbolication_history(created_at DESC);
    `);

    console.log('✅ symbolication_history 表创建成功！');
    
    // 验证表是否创建成功
    const verify = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbolication_history'")
      .get();
    
    if (verify) {
      console.log('✅ 验证成功：表已创建');
    } else {
      console.error('❌ 验证失败：表未创建');
    }
  } catch (error: any) {
    console.error('❌ 迁移失败:', error.message);
    throw error;
  }
}

// 执行迁移
console.log('开始数据库迁移...');
migrateHistoryTable();
console.log('迁移完成！');
process.exit(0);
