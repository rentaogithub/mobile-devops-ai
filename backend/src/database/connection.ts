import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (db) {
    return db;
  }

  // 使用绝对路径，相对于项目根目录
  const projectRoot = path.resolve(__dirname, '../../../');
  const dbPath = process.env.DB_PATH || path.join(projectRoot, 'nn-ios-platform-data', 'database.sqlite');
  const dbDir = path.dirname(dbPath);

  // 确保数据库目录存在
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // 创建数据库连接
  db = new Database(dbPath, {
    verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
  });

  // 启用外键约束
  db.pragma('foreign_keys = ON');

  // 设置 WAL 模式以提高并发性能
  db.pragma('journal_mode = WAL');

  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function reconnectDatabase(): void {
  closeDatabase();
  getDatabase();
}

// 优雅关闭
process.on('SIGINT', () => {
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDatabase();
  process.exit(0);
});
