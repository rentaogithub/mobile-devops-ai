# 移动研发 AI Workflow

`nn-ios-platform` 已新增移动研发质量中心，用于把原有 Crash、CI/CD、真机质检、日志和组件能力连接为统一的数据与决策链路。

## 本次实施范围

2026-09-07 更新：新增构建交付诊断，详见 [AI 驱动平台评审与演进方案](AI_DRIVEN_PLATFORM_EVOLUTION.md)。下述三阶段为历史实施记录；平台目前已另行具备实名账号、角色控制和受控 AI 审批，不能据此判断为没有认证能力。

按照三阶段实施，当前裁剪如下：

- 第一阶段不实施安全底座，因此本次没有新增 SSO、RBAC、Secret 管理和审批流。
- 第二阶段不实施 `Issue → 修复 Commit → 回归验证` 自动闭环。平台只生成候选修复建议，不写代码、不创建 Commit、不创建 PR。
- 第三阶段实施 AI 测试生成、知识库、发布观察和 AI 评测记录。

## 阶段一：统一平台底座

新增统一数据模型：

- `workflow_artifacts`：IPA、xcarchive、dSYM、构建产物等 Artifact。
- `workflow_tasks`：构建、Monkey、卡顿、Smoke、IM、RTC、全量回归等任务。
- `workflow_issues`：Crash、性能、测试、日志和构建问题。
- `workflow_relations`：Commit、Build、Artifact、Task、Issue 之间的血缘关系。
- `workflow_events`：任务、问题、门禁、回归候选等事件流。

标准质量任务 API 已从仅支持 `ios_monkey` 扩展为：

```text
ios_monkey
ios_stutter
ios_smoke
ios_login
ios_im
ios_rtc
ios_full
```

Monkey 继续使用业务感知模式和 `config/nnios-business-map.json`，并默认启用 guarded/read-only 保护。卡顿仍由独立 `stutter` 套件负责。

### 外部数据自动入库

下列已有服务在原 API 调用成功后会自动回写 Workflow，不需要用户再手工建档：

- Jenkins `nn` 构建列表、构建状态和 AI 失败分析。
- Jenkins `nn-auto-quality` 质量任务创建、队列状态及后续结果同步。
- Sentry Issue 列表、指定/聚合 AI 分析和符号化结果。
- 用户反馈日志中的异常、错误返回和慢请求聚类。
- dSYM 上传、xcarchive 自动导入和存量列表回填。
- Pods 发布、替换、分支同步、podspec 更新和存量列表回填。

同步失败不会破坏原业务接口，会写入服务日志供排查。

## 阶段二：智能质量决策

### 变更影响分析

支持传入 Git 仓库、Base Ref 和 Head Ref，也支持直接传入文件列表。分析结果包含：

- 受影响模块和业务域。
- 功能、依赖、构建、隐私、视觉、API、路由、启动和并发风险。
- 推荐执行的 Smoke、Monkey、IM、RTC、性能、视觉和全量套件。
- 推荐专项检查。

### 发布质量门禁

门禁综合判断：

- 构建状态。
- 必需测试套件是否完成并通过。
- 开放 Issue 的严重程度。
- Crash 和失败用例数量。
- 启动耗时、包体积、CPU、内存等指标相对基线的回退比例。

输出 `passed`、`warning` 或 `blocked`，同时保存评分、阻断项和风险项。

CI/CD 页面的“发布”操作已强制选择源构建。后端会重新向 Jenkins 读取该构建，且只有在以下检查完成后才会调用 `buildWithParameters`：

- 源构建已经 `SUCCESS` 且与待发布分支一致。
- `RELEASE_GATE_REQUIRED_SUITES` 指定的套件已通过，默认为 `smoke`。
- 无 blocker/critical 开放 Issue，Crash 和失败用例未超门限。
- `blocked` 不可覆盖；TestFlight/App Store 的 `warning` 需要填写人工放行原因。

门禁 ID、状态和源构建号会继续传入 Jenkins，方便发布追溯。

### Monkey 回归候选

Issue 中心可以把 Monkey 失败的业务域、业务路径和最后有效动作转为确定性回归候选。候选包含：

- 测试前置条件。
- 业务步骤。
- 断言。
- 置信度。
- 原始 Monkey 证据。

## 阶段三：持续演进

### AI XCUITest 生成

可根据回归候选生成 XCUITest。配置 OpenAI Key 时使用模型增强；未配置时生成安全骨架。

生成约束：

- 优先 `accessibilityIdentifier`。
- 禁止坐标点击。
- 禁止支付、删除、退出登录等不可逆动作。
- 包含明确等待和断言。

生成后还支持：

- 导出到平台数据目录 `workflow-xcuitest/exports`，不写入或修改 `nnios`。
- 通过 iOS Simulator SDK 和 XCTest Framework 对生成文件做独立 Swift 类型检查，并保留日志。
- 实际执行由 `WORKFLOW_XCUITEST_RUNNER_URL` 配置的 CI/临时工作区 Runner 完成，避免污染开发机的 `nnios` 工作区。
- Runner 可使用 `WORKFLOW_XCUITEST_RUNNER_TOKEN` 进行服务间鉴权，执行结果回写 `verified` 或 `failed`。

平台不会向 `nnios` 注入 `accessibilityIdentifier`或测试辅助文件。因此生成策略只使用 App 现有的 identifier 和稳定可见文案；缺失的 identifier 仅作为建议输出，不自动修改业务工程。

### 候选修复建议

Issue 可以生成根因假设、建议检查文件、Patch 计划、代码修改示例和风险。该能力只输出建议，不执行自动修复。

### 移动研发知识库

可将故障、质量问题和处理过程提炼为：

- 诊断步骤。
- 可复用自动检查。
- 回归建议。
- 标签和来源引用。

### 发布观察

支持记录 TestFlight、App Store 和 Pgyer 发布后的 Crash、启动、性能等指标，并评估版本健康度和继续放量建议。

### AI 评测

记录测试生成、修复建议和知识提炼的模型、Prompt 版本、耗时、输出、人工评分与采纳结果，为后续 Prompt 和模型迭代提供数据。

## 页面入口

平台顶部菜单：`质量中心`

页面包含：

- 交付诊断：输入 Jenkins 源构建号，关联六个研发阶段、证据缺口和下一步处理入口。管理员也可在 AI 会话中说“诊断构建 #12345 的交付链路，还缺哪些证据”。
- 平台概览。
- Issue 中心。
- 变更影响分析。
- 发布门禁。
- 回归候选与 XCUITest 生成。
- 知识库与发布观察。

## API

主要 API 前缀：

```text
/api/workflow
```

核心接口：

- `GET /overview`
- `GET /delivery/:buildNumber`：当前产品线构建的只读交付诊断；依据同步快照，不替代实时发布门禁。
- `GET|POST /artifacts`
- `GET|POST /tasks`
- `GET|POST|PATCH /issues`
- `POST /impact/analyze`
- `GET|POST /baselines`
- `POST /release-gates/evaluate`
- `POST /release-gates/preview`
- `POST /issues/:issueId/regression-candidates`
- `POST /regression-candidates/:candidateId/generate-xcuitest`
- `POST /regression-candidates/:candidateId/export-xcuitest`
- `POST /regression-candidates/:candidateId/verify-xcuitest`
- `POST /regression-candidates/:candidateId/run-xcuitest`
- `POST /issues/:issueId/fix-suggestion`
- `GET /knowledge`
- `POST /knowledge/synthesize`
- `GET|POST /ai-evaluations`
- `PATCH /ai-evaluations/:evaluationId`
- `GET|POST /release-observations`
- `GET /release-health/:releaseVersion`
- `GET /operations/sync`
- `POST /operations/sync/:source`
- `GET /operations/storage`
- `POST /operations/backup`
- `POST /operations/retention`
- `POST /operations/compact`

平台启动后会按 `WORKFLOW_SYNC_INTERVAL_MINUTES` 周期增量同步 Jenkins 构建、自动质检、dSYM、Pods 和 Sentry。同步状态可通过 `/operations/sync` 查看。

运行保障接口：

- `GET /health/live`：进程存活。
- `GET /health/ready`：数据库真实可用性。
- `GET /api/health/dependencies`：Jenkins、Sentry、Sonic、设备池、OpenAI 和 XCUITest Runner 状态。

数据库支持定时在线备份和 WAL checkpoint。dSYM、Workflow Event 和门禁历史默认仅生成保留策略预览；只有显式设置 `WORKFLOW_RETENTION_ALLOW_DELETE=true` 并提交确认串时才会执行删除。
