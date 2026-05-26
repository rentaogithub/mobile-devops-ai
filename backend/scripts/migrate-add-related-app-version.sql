-- 添加 related_app_version 字段用于组件库关联主应用版本
-- 运行方式: sqlite3 data/database.sqlite < backend/scripts/migrate-add-related-app-version.sql

-- 检查字段是否已存在，如果不存在则添加
-- SQLite 不支持 IF NOT EXISTS for ALTER TABLE，所以需要手动检查

ALTER TABLE dsym_info ADD COLUMN related_app_version TEXT;
