import { getDatabase } from './connection';
import fs from 'fs';
import path from 'path';

export function initializeDatabase(): void {
  const db = getDatabase();

  // 读取 schema.sql 文件
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');

  // 执行 schema 中的所有语句
  db.exec(schema);

  // 执行数据库迁移
  migrateDatabase();

  console.log('Database initialized successfully');
}

// 数据库迁移
function migrateDatabase(): void {
  const db = getDatabase();

  try {
    // 检查 related_app_version 列是否存在
    const tableInfo = db.prepare("PRAGMA table_info(dsym_info)").all() as any[];
    const hasRelatedAppVersion = tableInfo.some((col: any) => col.name === 'related_app_version');

    if (!hasRelatedAppVersion) {
      console.log('Adding related_app_version column...');
      db.exec('ALTER TABLE dsym_info ADD COLUMN related_app_version TEXT');
      console.log('Migration completed: added related_app_version column');
    }

    // 检查 symbolication_history 表是否存在
    const historyTableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbolication_history'")
      .get();

    if (!historyTableExists) {
      console.log('Creating symbolication_history table...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS symbolication_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          app_version TEXT NOT NULL,
          crash_type TEXT,
          crash_reason TEXT,
          last_stack_call TEXT,
          crash_module TEXT,
          original_log TEXT NOT NULL,
          symbolicated_log TEXT NOT NULL,
          used_uuids TEXT NOT NULL,
          ai_analysis TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_app_version ON symbolication_history(app_version);
        CREATE INDEX IF NOT EXISTS idx_created_at ON symbolication_history(created_at DESC);
      `);
      console.log('Migration completed: created symbolication_history table');
    }

    // 检查是否需要添加新字段
    const historyTableInfo = db.prepare("PRAGMA table_info(symbolication_history)").all() as any[];
    const hasLastStackCall = historyTableInfo.some((col: any) => col.name === 'last_stack_call');
    const hasCrashModule = historyTableInfo.some((col: any) => col.name === 'crash_module');
    const hasCrashLocation = historyTableInfo.some((col: any) => col.name === 'crash_location');
    const hasIsFixed = historyTableInfo.some((col: any) => col.name === 'is_fixed');
    const hasFixedVersion = historyTableInfo.some((col: any) => col.name === 'fixed_version');
    const hasFixedRemark = historyTableInfo.some((col: any) => col.name === 'fixed_remark');
    const hasVersionDetected = historyTableInfo.some((col: any) => col.name === 'version_detected');
    const hasUid = historyTableInfo.some((col: any) => col.name === 'uid');
    const hasDeviceId = historyTableInfo.some((col: any) => col.name === 'device_id');

    if (!hasLastStackCall) {
      console.log('Adding last_stack_call column to symbolication_history...');
      db.exec('ALTER TABLE symbolication_history ADD COLUMN last_stack_call TEXT');
      console.log('Migration completed: added last_stack_call column');
    }

    if (!hasCrashModule) {
      console.log('Adding crash_module column to symbolication_history...');
      db.exec('ALTER TABLE symbolication_history ADD COLUMN crash_module TEXT');
      console.log('Migration completed: added crash_module column');
    }

    if (!hasCrashLocation) {
      console.log('Adding crash_location column to symbolication_history...');
      db.exec('ALTER TABLE symbolication_history ADD COLUMN crash_location TEXT');
      console.log('Migration completed: added crash_location column');
    }

    if (!hasIsFixed) {
      console.log('Adding is_fixed column to symbolication_history...');
      db.exec('ALTER TABLE symbolication_history ADD COLUMN is_fixed INTEGER DEFAULT 0');
      console.log('Migration completed: added is_fixed column');
    }

    if (!hasFixedVersion) {
      console.log('Adding fixed_version column to symbolication_history...');
      db.exec('ALTER TABLE symbolication_history ADD COLUMN fixed_version TEXT');
      console.log('Migration completed: added fixed_version column');
    }

    if (!hasFixedRemark) {
      console.log('Adding fixed_remark column to symbolication_history...');
      db.exec('ALTER TABLE symbolication_history ADD COLUMN fixed_remark TEXT');
      console.log('Migration completed: added fixed_remark column');
    }

    if (!hasVersionDetected) {
      console.log('Adding version_detected column to symbolication_history...');
      db.exec('ALTER TABLE symbolication_history ADD COLUMN version_detected INTEGER DEFAULT 1');
      console.log('Migration completed: added version_detected column');
    }

    if (!hasUid) {
      console.log('Adding uid column to symbolication_history...');
      db.exec('ALTER TABLE symbolication_history ADD COLUMN uid TEXT');
      console.log('Migration completed: added uid column');
    }

    if (!hasDeviceId) {
      console.log('Adding device_id column to symbolication_history...');
      db.exec('ALTER TABLE symbolication_history ADD COLUMN device_id TEXT');
      console.log('Migration completed: added device_id column');
    }

    const assistantAuditForeignKeys = db.prepare('PRAGMA foreign_key_list(assistant_action_audits)').all() as any[];
    if (assistantAuditForeignKeys.some((foreignKey) => foreignKey.table === 'platform_users')) {
      console.log('Removing account dependency from assistant action audits...');
      db.exec(`
        DROP INDEX IF EXISTS idx_assistant_audits_user;
        DROP INDEX IF EXISTS idx_assistant_audits_status;
        DROP INDEX IF EXISTS idx_assistant_audits_idempotency;
        ALTER TABLE assistant_action_audits RENAME TO assistant_action_audits_with_user_fk;
        CREATE TABLE assistant_action_audits (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          domain TEXT NOT NULL,
          risk_level TEXT NOT NULL,
          status TEXT NOT NULL,
          arguments_json TEXT NOT NULL DEFAULT '{}',
          preview_json TEXT NOT NULL DEFAULT '{}',
          result_json TEXT,
          error TEXT,
          approval_count INTEGER NOT NULL DEFAULT 0,
          approvals_required INTEGER NOT NULL DEFAULT 0,
          idempotency_key TEXT,
          related_entity_type TEXT,
          related_entity_id TEXT,
          duration_ms INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        INSERT INTO assistant_action_audits SELECT * FROM assistant_action_audits_with_user_fk;
        DROP TABLE assistant_action_audits_with_user_fk;
        CREATE INDEX idx_assistant_audits_user ON assistant_action_audits(user_id, created_at DESC);
        CREATE INDEX idx_assistant_audits_status ON assistant_action_audits(status, created_at DESC);
        CREATE INDEX idx_assistant_audits_idempotency ON assistant_action_audits(idempotency_key, status);
      `);
      console.log('Migration completed: assistant audits now support anonymous clients');
    }

    db.prepare("DELETE FROM platform_users WHERE id = 'assistant-guest' AND username = '__assistant_guest__'").run();

    const replayFlowAssetColumns = db.prepare('PRAGMA table_info(replay_flow_assets)').all() as any[];
    if (replayFlowAssetColumns.length > 0 && !replayFlowAssetColumns.some((column) => column.name === 'creation_completed')) {
      console.log('Adding replay flow creation lifecycle columns...');
      db.exec('ALTER TABLE replay_flow_assets ADD COLUMN creation_completed INTEGER NOT NULL DEFAULT 1');
      console.log('Migration completed: replay flow creation state added');
    }
    if (replayFlowAssetColumns.length > 0 && !replayFlowAssetColumns.some((column) => column.name === 'completed_at')) {
      db.exec('ALTER TABLE replay_flow_assets ADD COLUMN completed_at TEXT');
      console.log('Migration completed: replay flow completion time added');
    }
    if (replayFlowAssetColumns.length > 0 && !replayFlowAssetColumns.some((column) => column.name === 'pre_flow_asset_id')) {
      db.exec('ALTER TABLE replay_flow_assets ADD COLUMN pre_flow_asset_id TEXT');
      console.log('Migration completed: replay flow pre-flow reference added');
    }
    if (replayFlowAssetColumns.length > 0 && !replayFlowAssetColumns.some((column) => column.name === 'post_flow_asset_id')) {
      db.exec('ALTER TABLE replay_flow_assets ADD COLUMN post_flow_asset_id TEXT');
      console.log('Migration completed: replay flow post-flow reference added');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_replay_flow_assets_pre_flow ON replay_flow_assets(pre_flow_asset_id);
      CREATE INDEX IF NOT EXISTS idx_replay_flow_assets_post_flow ON replay_flow_assets(post_flow_asset_id);
    `);
  } catch (error) {
    console.error('Migration error:', error);
  }
}

// 检查数据库是否已初始化
export function isDatabaseInitialized(): boolean {
  const db = getDatabase();

  try {
    const result = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dsym_info'")
      .get();
    return !!result;
  } catch (error) {
    return false;
  }
}

// 重置数据库（仅用于开发/测试）
export function resetDatabase(): void {
  const db = getDatabase();

  db.exec('DROP TABLE IF EXISTS dsym_info');
  initializeDatabase();

  console.log('Database reset successfully');
}
