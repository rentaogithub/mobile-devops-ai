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
    const timestamp = new Date().toISOString();
    const membershipColumns = db.prepare('PRAGMA table_info(platform_product_line_memberships)').all() as any[];
    if (!membershipColumns.some((column) => column.name === 'app_store_release')) db.exec('ALTER TABLE platform_product_line_memberships ADD COLUMN app_store_release INTEGER NOT NULL DEFAULT 0 CHECK(app_store_release IN (0, 1))');
    db.prepare(`
      INSERT OR IGNORE INTO platform_product_lines (
        id, key, name, project_id, bundle_id, active, created_at, updated_at
      ) VALUES ('nn', 'nn', 'NN', 'nn-ios', NULL, 1, ?, ?)
    `).run(timestamp, timestamp);
    const applicationColumns = db.prepare('PRAGMA table_info(platform_applications)').all() as any[];
    if (!applicationColumns.some((column) => column.name === 'services_json')) db.exec('ALTER TABLE platform_applications ADD COLUMN services_json TEXT');
    if (!applicationColumns.some((column) => column.name === 'service_options_json')) db.exec("ALTER TABLE platform_applications ADD COLUMN service_options_json TEXT NOT NULL DEFAULT '{}'");
    if (!applicationColumns.some((column) => column.name === 'component_library_id')) db.exec('ALTER TABLE platform_applications ADD COLUMN component_library_id TEXT REFERENCES component_libraries(id)');
    db.exec("INSERT OR IGNORE INTO component_libraries (id, platform, config_product_line_id) SELECT 'ios:' || id, 'ios', id FROM platform_product_lines");
    // Preserve the existing iOS Workflow namespace; adding Android never relabels old data.
    db.prepare(`
      INSERT OR IGNORE INTO platform_applications
        (id, product_line_id, platform, name, package_id, workflow_project_id, created_at, updated_at)
      SELECT id || ':ios', id, 'ios', name || ' iOS', COALESCE(bundle_id, ''), project_id, ?, ?
      FROM platform_product_lines p
      WHERE NOT EXISTS (SELECT 1 FROM platform_applications a WHERE a.product_line_id = p.id)
    `).run(timestamp, timestamp);
    const productLineColumns = db.prepare('PRAGMA table_info(platform_product_lines)').all() as any[];
    if (!productLineColumns.some((col: any) => col.name === 'jenkins_base_url')) {
      console.log('Adding jenkins_base_url column to platform_product_lines...');
      db.exec('ALTER TABLE platform_product_lines ADD COLUMN jenkins_base_url TEXT');
    }
    const legacyJenkinsBaseUrl = String(process.env.JENKINS_BASE_URL || '').trim().replace(/\/+$/, '');
    if (legacyJenkinsBaseUrl) {
      db.prepare(`
        UPDATE platform_product_lines
        SET jenkins_base_url = COALESCE(NULLIF(jenkins_base_url, ''), ?), updated_at = ?
        WHERE id = 'nn'
      `).run(legacyJenkinsBaseUrl, timestamp);
    }

    // 检查 related_app_version 列是否存在
    const tableInfo = db.prepare("PRAGMA table_info(dsym_info)").all() as any[];
    const hasRelatedAppVersion = tableInfo.some((col: any) => col.name === 'related_app_version');

    if (!hasRelatedAppVersion) {
      console.log('Adding related_app_version column...');
      db.exec('ALTER TABLE dsym_info ADD COLUMN related_app_version TEXT');
      console.log('Migration completed: added related_app_version column');
    }

    if (!tableInfo.some((col: any) => col.name === 'product_line_id')) {
      console.log('Adding product_line_id column to dsym_info...');
      db.exec("ALTER TABLE dsym_info ADD COLUMN product_line_id TEXT NOT NULL DEFAULT 'nn'");
    }
    const legacyDsymIndexes = db.prepare('PRAGMA index_list(dsym_info)').all() as any[];
    if (legacyDsymIndexes.some((index: any) => index.origin === 'u' && index.unique === 1)) {
      console.log('Migrating dSYM UUID uniqueness to product-line scope...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE dsym_info_product_scoped (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uuid TEXT NOT NULL,
            app_name TEXT NOT NULL,
            version TEXT NOT NULL,
            build_number TEXT,
            architecture TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            notes TEXT,
            related_app_version TEXT,
            product_line_id TEXT NOT NULL DEFAULT 'nn',
            upload_time DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO dsym_info_product_scoped (
            id, uuid, app_name, version, build_number, architecture, file_path, file_size,
            notes, related_app_version, product_line_id, upload_time
          )
          SELECT id, uuid, app_name, version, build_number, architecture, file_path, file_size,
            notes, related_app_version, product_line_id, upload_time
          FROM dsym_info;
          DROP TABLE dsym_info;
          ALTER TABLE dsym_info_product_scoped RENAME TO dsym_info;
        `);
      })();
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_uuid ON dsym_info(uuid)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_upload_time ON dsym_info(upload_time DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_dsym_product_line ON dsym_info(product_line_id, upload_time DESC)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_dsym_product_uuid ON dsym_info(product_line_id, uuid)');

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
    const hasHistoryProductLineId = historyTableInfo.some((col: any) => col.name === 'product_line_id');

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


    if (!hasHistoryProductLineId) {
      console.log('Adding product_line_id column to symbolication_history...');
      db.exec("ALTER TABLE symbolication_history ADD COLUMN product_line_id TEXT NOT NULL DEFAULT 'nn'");
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_history_product_line ON symbolication_history(product_line_id, created_at DESC)');

    const sentryHistoryColumns = db.prepare('PRAGMA table_info(sentry_issue_symbolication_history)').all() as any[];
    if (!sentryHistoryColumns.some((col: any) => col.name === 'permalink')) {
      db.exec('ALTER TABLE sentry_issue_symbolication_history ADD COLUMN permalink TEXT');
    }
    const currentSentryHistoryColumns = db.prepare('PRAGMA table_info(sentry_issue_symbolication_history)').all() as any[];
    const sentryIssueIdColumn = currentSentryHistoryColumns.find((col: any) => col.name === 'issue_id');
    const sentryHistoryNeedsProductScope =
      !currentSentryHistoryColumns.some((col: any) => col.name === 'product_line_id')
      || sentryIssueIdColumn?.pk === 1;
    if (sentryHistoryNeedsProductScope) {
      console.log('Migrating Sentry issue history to product-line scope...');
      db.exec(`
        ALTER TABLE sentry_issue_symbolication_history RENAME TO sentry_issue_symbolication_history_legacy;
        CREATE TABLE sentry_issue_symbolication_history (
          product_line_id TEXT NOT NULL DEFAULT 'nn',
          issue_id TEXT NOT NULL,
          short_id TEXT,
          permalink TEXT,
          history_id INTEGER NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (product_line_id, issue_id)
        );
        INSERT INTO sentry_issue_symbolication_history (
          product_line_id, issue_id, short_id, permalink, history_id, updated_at
        )
        SELECT 'nn', issue_id, short_id, permalink, history_id, updated_at
        FROM sentry_issue_symbolication_history_legacy;
        DROP TABLE sentry_issue_symbolication_history_legacy;
      `);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sentry_issue_history_product_short_id
      ON sentry_issue_symbolication_history(product_line_id, short_id)
    `);

    const registrationColumns = db.prepare('PRAGMA table_info(platform_user_registration_requests)').all() as any[];
    if (!registrationColumns.some((col: any) => col.name === 'product_line_id')) {
      console.log('Adding product_line_id column to platform_user_registration_requests...');
      db.exec("ALTER TABLE platform_user_registration_requests ADD COLUMN product_line_id TEXT NOT NULL DEFAULT 'nn'");
    }

    db.prepare(`
      INSERT OR IGNORE INTO platform_product_line_memberships (
        product_line_id, user_id, role, created_at, updated_at
      )
      SELECT 'nn', id,
        CASE WHEN role IN ('guest', 'tester', 'developer', 'product') THEN role ELSE 'guest' END,
        ?, ?
      FROM platform_users
      WHERE role <> 'admin'
    `).run(timestamp, timestamp);

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

    const assistantAuditColumns = db.prepare('PRAGMA table_info(assistant_action_audits)').all() as any[];
    if (!assistantAuditColumns.some((column) => column.name === 'project_id')) {
      db.exec("ALTER TABLE assistant_action_audits ADD COLUMN project_id TEXT NOT NULL DEFAULT 'nn-ios'");
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_audits_project ON assistant_action_audits(project_id, created_at DESC)');

    const pairingColumns = db.prepare('PRAGMA table_info(realtime_log_pairing_sessions)').all() as any[];
    if (!pairingColumns.some((column) => column.name === 'product_line_id')) {
      db.exec("ALTER TABLE realtime_log_pairing_sessions ADD COLUMN product_line_id TEXT NOT NULL DEFAULT 'nn'");
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_realtime_log_pairing_product ON realtime_log_pairing_sessions(product_line_id, status, last_active_at DESC)');

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
