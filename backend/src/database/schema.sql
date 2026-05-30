-- dSYM 信息表
CREATE TABLE IF NOT EXISTS dsym_info (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  app_name TEXT NOT NULL,
  version TEXT NOT NULL,
  build_number TEXT,
  architecture TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  notes TEXT,
  related_app_version TEXT,  -- 关联的主应用版本（用于组件库）
  upload_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 为 UUID 创建索引以加快查询
CREATE INDEX IF NOT EXISTS idx_uuid ON dsym_info(uuid);

-- 为上传时间创建索引
CREATE INDEX IF NOT EXISTS idx_upload_time ON dsym_info(upload_time DESC);

-- 符号化历史记录表
CREATE TABLE IF NOT EXISTS symbolication_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_version TEXT NOT NULL,  -- 主应用版本
  version_detected INTEGER DEFAULT 1,  -- 版本号是否自动检测到（1: 检测到, 0: 未检测到/使用最高版本）
  crash_type TEXT,  -- 崩溃类型
  crash_reason TEXT,  -- 崩溃原因
  last_stack_call TEXT,  -- 最后堆栈调用名
  crash_module TEXT,  -- 崩溃模块
  crash_location TEXT,  -- 崩溃位置
  original_log TEXT NOT NULL,  -- 原始崩溃日志
  symbolicated_log TEXT NOT NULL,  -- 符号化后的日志
  used_uuids TEXT NOT NULL,  -- 使用的 UUID 列表（JSON 数组）
  ai_analysis TEXT,  -- AI 分析结果（JSON）
  is_fixed INTEGER DEFAULT 0,  -- 是否已修复（0: 未修复, 1: 已修复）
  fixed_version TEXT,  -- 修复版本号
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 为主应用版本创建索引
CREATE INDEX IF NOT EXISTS idx_app_version ON symbolication_history(app_version);

-- 为创建时间创建索引
CREATE INDEX IF NOT EXISTS idx_created_at ON symbolication_history(created_at DESC);

-- 实时日志配对会话表
CREATE TABLE IF NOT EXISTS realtime_log_pairing_sessions (
  pairing_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  status TEXT NOT NULL,
  device_info TEXT,
  created_at INTEGER NOT NULL,
  paired_at INTEGER,
  last_active_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_realtime_log_pairing_status ON realtime_log_pairing_sessions(status);
CREATE INDEX IF NOT EXISTS idx_realtime_log_pairing_last_active_at ON realtime_log_pairing_sessions(last_active_at DESC);
