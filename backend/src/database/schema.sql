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

-- 移动研发 Workflow：构建产物与血缘
CREATE TABLE IF NOT EXISTS workflow_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
  artifact_type TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  build_number TEXT,
  commit_hash TEXT,
  branch TEXT,
  uri TEXT,
  checksum TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_build ON workflow_artifacts(project_id, build_number);
CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_commit ON workflow_artifacts(project_id, commit_hash);

-- 移动研发 Workflow：统一任务
CREATE TABLE IF NOT EXISTS workflow_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
  task_type TEXT NOT NULL,
  suite TEXT,
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'platform',
  external_id TEXT,
  external_url TEXT,
  build_number TEXT,
  commit_hash TEXT,
  branch TEXT,
  artifact_id TEXT,
  device_udid TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES workflow_artifacts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_status ON workflow_tasks(project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_build ON workflow_tasks(project_id, build_number);
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_external ON workflow_tasks(source, external_id);

-- 移动研发 Workflow：统一问题中心
CREATE TABLE IF NOT EXISTS workflow_issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
  fingerprint TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  title TEXT NOT NULL,
  summary TEXT,
  module TEXT,
  owner_hint TEXT,
  business_domain TEXT,
  business_path TEXT,
  task_id TEXT,
  artifact_id TEXT,
  build_number TEXT,
  commit_hash TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, fingerprint),
  FOREIGN KEY (task_id) REFERENCES workflow_tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (artifact_id) REFERENCES workflow_artifacts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_issues_status ON workflow_issues(project_id, status, severity, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_issues_build ON workflow_issues(project_id, build_number);

-- 任意实体之间的血缘关系，例如 commit -> build -> ipa -> dSYM -> quality task -> issue
CREATE TABLE IF NOT EXISTS workflow_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, from_type, from_id, relation, to_type, to_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_relations_from ON workflow_relations(project_id, from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_workflow_relations_to ON workflow_relations(project_id, to_type, to_id);

-- Workflow 事件流，作为后续自动化、审计和 AI 学习的数据源
CREATE TABLE IF NOT EXISTS workflow_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_entity ON workflow_events(project_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_events_type ON workflow_events(project_id, event_type, occurred_at DESC);

-- 质量基线与发布门禁
CREATE TABLE IF NOT EXISTS workflow_quality_baselines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
  metric TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'app',
  branch TEXT NOT NULL DEFAULT '*',
  value REAL NOT NULL,
  unit TEXT,
  sample_size INTEGER NOT NULL DEFAULT 1,
  task_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, metric, scope, branch)
);

CREATE TABLE IF NOT EXISTS workflow_release_gates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
  build_number TEXT NOT NULL,
  commit_hash TEXT,
  branch TEXT,
  status TEXT NOT NULL,
  score INTEGER NOT NULL,
  policy_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_release_gates_build ON workflow_release_gates(project_id, build_number, created_at DESC);

-- Monkey 失败路径转确定性回归候选
CREATE TABLE IF NOT EXISTS workflow_regression_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
  issue_id TEXT,
  source_task_id TEXT,
  title TEXT NOT NULL,
  suite TEXT NOT NULL DEFAULT 'xcuitest',
  business_domain TEXT,
  business_path TEXT,
  preconditions_json TEXT NOT NULL DEFAULT '[]',
  steps_json TEXT NOT NULL DEFAULT '[]',
  assertions_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'proposed',
  generated_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES workflow_issues(id) ON DELETE SET NULL,
  FOREIGN KEY (source_task_id) REFERENCES workflow_tasks(id) ON DELETE SET NULL
);

-- 第三阶段：知识库、AI 评测和发布观察
CREATE TABLE IF NOT EXISTS workflow_knowledge_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
  kind TEXT NOT NULL,
  fingerprint TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  content_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0.5,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_knowledge_kind ON workflow_knowledge_entries(project_id, kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_ai_evaluations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
  capability TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  input_ref TEXT,
  output_json TEXT NOT NULL DEFAULT '{}',
  score REAL,
  accepted INTEGER,
  latency_ms INTEGER,
  token_usage INTEGER,
  cost REAL,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_ai_evaluations_capability ON workflow_ai_evaluations(project_id, capability, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_release_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
  release_version TEXT NOT NULL,
  build_number TEXT,
  channel TEXT,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  baseline_value REAL,
  status TEXT NOT NULL DEFAULT 'normal',
  observed_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_release_observations_release ON workflow_release_observations(project_id, release_version, observed_at DESC);
