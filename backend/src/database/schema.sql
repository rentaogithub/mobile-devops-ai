-- dSYM 信息表
CREATE TABLE IF NOT EXISTS dsym_info (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL,
  app_name TEXT NOT NULL,
  version TEXT NOT NULL,
  build_number TEXT,
  architecture TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  notes TEXT,
  related_app_version TEXT,  -- 关联的主应用版本（用于组件库）
  product_line_id TEXT NOT NULL DEFAULT 'nn',
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
  uid TEXT,  -- Sentry 用户 UID
  device_id TEXT,  -- Sentry 设备 ID
  original_log TEXT NOT NULL,  -- 原始崩溃日志
  symbolicated_log TEXT NOT NULL,  -- 符号化后的日志
  used_uuids TEXT NOT NULL,  -- 使用的 UUID 列表（JSON 数组）
  ai_analysis TEXT,  -- AI 分析结果（JSON）
  is_fixed INTEGER DEFAULT 0,  -- 是否已修复（0: 未修复, 1: 已修复）
  fixed_version TEXT,  -- 修复版本号
  fixed_remark TEXT,  -- 修复备注
  product_line_id TEXT NOT NULL DEFAULT 'nn',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 为主应用版本创建索引
CREATE INDEX IF NOT EXISTS idx_app_version ON symbolication_history(app_version);

-- 为创建时间创建索引
CREATE INDEX IF NOT EXISTS idx_created_at ON symbolication_history(created_at DESC);

-- Sentry Issue 与符号化历史的关联（按产品线隔离）
CREATE TABLE IF NOT EXISTS sentry_issue_symbolication_history (
  product_line_id TEXT NOT NULL DEFAULT 'nn',
  issue_id TEXT NOT NULL,
  short_id TEXT,
  permalink TEXT,
  history_id INTEGER NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (product_line_id, issue_id)
);

-- 实时日志配对会话表
CREATE TABLE IF NOT EXISTS realtime_log_pairing_sessions (
  pairing_id TEXT PRIMARY KEY,
  product_line_id TEXT NOT NULL DEFAULT 'nn',
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
CREATE INDEX IF NOT EXISTS idx_realtime_log_pairing_product ON realtime_log_pairing_sessions(product_line_id, status, last_active_at DESC);

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

-- iOS 黑盒自动化：回放流程资产
CREATE TABLE IF NOT EXISTS replay_flow_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
  name TEXT NOT NULL,
  description TEXT,
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  source_recording_id TEXT,
  source_fingerprint TEXT NOT NULL,
  current_draft_id TEXT,
  latest_version_id TEXT,
  pre_flow_asset_id TEXT,
  post_flow_asset_id TEXT,
  pre_flow_version_id TEXT,
  post_flow_version_id TEXT,
  creation_completed INTEGER NOT NULL DEFAULT 1,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_replay_flow_assets_status ON replay_flow_assets(project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_replay_flow_assets_owner ON replay_flow_assets(project_id, owner, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_replay_flow_assets_recording ON replay_flow_assets(source_recording_id, created_at DESC);

-- 回放流程草稿：一个资产当前维护一份可持续编辑的草稿
CREATE TABLE IF NOT EXISTS replay_flow_drafts (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL DEFAULT 1,
  dsl_json TEXT NOT NULL,
  validation_json TEXT NOT NULL DEFAULT '{}',
  source_recording_id TEXT,
  source_fingerprint TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES replay_flow_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_replay_flow_drafts_updated ON replay_flow_drafts(updated_at DESC);

-- 发布版本表先建立数据边界；正式发布能力在后续节点启用
CREATE TABLE IF NOT EXISTS replay_flow_versions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  dsl_json TEXT NOT NULL,
  compiled_json TEXT NOT NULL,
  source_recording_id TEXT,
  source_fingerprint TEXT NOT NULL,
  release_notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(asset_id, version_number),
  FOREIGN KEY (asset_id) REFERENCES replay_flow_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_replay_flow_versions_asset ON replay_flow_versions(asset_id, version_number DESC);

CREATE TABLE IF NOT EXISTS replay_flow_audit_events (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES replay_flow_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_replay_flow_audit_asset ON replay_flow_audit_events(asset_id, created_at DESC);

-- 本地实名账号与服务端会话
CREATE TABLE IF NOT EXISTS platform_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'guest',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- iOS 产品线。key 用于稳定标识，project_id 对应 Workflow 数据隔离键。
CREATE TABLE IF NOT EXISTS platform_product_lines (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  project_id TEXT NOT NULL UNIQUE,
  bundle_id TEXT,
  jenkins_base_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS component_libraries (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK(platform IN ('ios', 'android')),
  config_product_line_id TEXT NOT NULL REFERENCES platform_product_lines(id),
  UNIQUE(platform, config_product_line_id)
);

CREATE TABLE IF NOT EXISTS platform_applications (
  id TEXT PRIMARY KEY,
  product_line_id TEXT NOT NULL REFERENCES platform_product_lines(id),
  platform TEXT NOT NULL CHECK(platform IN ('ios', 'android')),
  name TEXT NOT NULL,
  package_id TEXT NOT NULL DEFAULT '',
  workflow_project_id TEXT NOT NULL UNIQUE,
  services_json TEXT,
  service_options_json TEXT NOT NULL DEFAULT '{}',
  component_library_id TEXT REFERENCES component_libraries(id),
  config_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(product_line_id, platform)
);

CREATE TABLE IF NOT EXISTS android_delivery_runs (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES platform_applications(id),
  request_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('build', 'smoke')),
  status TEXT NOT NULL,
  job_name TEXT NOT NULL,
  queue_url TEXT,
  build_number INTEGER,
  config_json TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(application_id, request_key)
);

-- 同一用户可在不同产品线拥有不同角色；平台管理员仍由 platform_users.role = admin 表示。
CREATE TABLE IF NOT EXISTS platform_product_line_memberships (
  product_line_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'guest',
  app_store_release INTEGER NOT NULL DEFAULT 0 CHECK(app_store_release IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_line_id, user_id),
  FOREIGN KEY (product_line_id) REFERENCES platform_product_lines(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES platform_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_product_line_memberships_user
  ON platform_product_line_memberships(user_id, product_line_id);

CREATE TABLE IF NOT EXISTS platform_product_line_configs (
  product_line_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  encrypted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (product_line_id, key),
  FOREIGN KEY (product_line_id) REFERENCES platform_product_lines(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES platform_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_sessions_user ON platform_sessions(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_sessions_token ON platform_sessions(token_hash);

CREATE TABLE IF NOT EXISTS platform_user_registration_requests (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  requested_role TEXT NOT NULL,
  product_line_id TEXT NOT NULL DEFAULT 'nn',
  status TEXT NOT NULL DEFAULT 'pending',
  reviewer_user_id TEXT,
  reviewer_username TEXT,
  review_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_platform_user_registration_requests_status ON platform_user_registration_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_user_registration_requests_username ON platform_user_registration_requests(username, status);

-- 平台管理员统一敏感配置（值仅由管理员接口读取，不返回明文）
CREATE TABLE IF NOT EXISTS platform_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- AI 会话只持久化实际工具调用与审批，不保存普通聊天正文
CREATE TABLE IF NOT EXISTS assistant_action_audits (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
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

CREATE INDEX IF NOT EXISTS idx_assistant_audits_user ON assistant_action_audits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_audits_status ON assistant_action_audits(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_audits_idempotency ON assistant_action_audits(idempotency_key, status);
