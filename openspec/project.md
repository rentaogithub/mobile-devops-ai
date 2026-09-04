# nn-ios-platform OpenSpec Project

## Project Purpose

`nn-ios-platform` 是本地部署的 iOS 移动研发与质量平台，覆盖真机控制、黑盒自动化录制与回放、Crash 符号化、质量任务、Jenkins 集成及相关运维能力。

本 OpenSpec 目录用于管理具有跨前后端接口、持久化模型或执行语义影响的产品变更。

## Technical Context

- Frontend: React、TypeScript、Ant Design、Vite、Axios。
- Backend: Node.js、Express、TypeScript、SQLite。
- Device automation: WebDriverAgent、Xcode、USB iOS 真机。
- Evidence: PNG screenshot、WDA XML Source、JSON run record。
- CI: Jenkins、项目内质量任务接口。

## Specification Conventions

- 规范性需求使用 `SHALL`、`MUST NOT`。
- 验收场景使用 `GIVEN / WHEN / THEN / AND`。
- Capability spec 描述当前已成立的系统行为。
- Change delta 使用 `ADDED / MODIFIED / REMOVED Requirements`。
- 每个规范性需求必须至少包含一个验收场景。
- 变更任务必须引用对应需求 ID。
- 设计文档不得把规划能力描述成已完成功能。

## Architecture Constraints

- 被测 App 作为黑盒，不依赖业务探针。
- DSL 是顺序编辑器、可视化画布和低代码编辑器的唯一事实来源。
- WDA 负责确定性操作、页面状态读取和证据采集。
- 语义定位优先，归一化坐标作为兜底。
- 正式质量执行必须可追溯到不可变流程版本。
- 敏感输入值不得持久化到流程和运行记录。
- 禁止任意脚本、无限循环和无上限重试。

## Quality Gates

- 前后端 TypeScript typecheck 必须通过。
- 受影响单元测试和集成测试必须通过。
- DSL、执行语义或定位逻辑变更必须包含真机验收场景。
- 新增节点必须同时覆盖 Schema、校验、编译、执行、画布/低代码投影、证据和文档。

## Related Design

- `docs/DEVICE_REPLAY_ORCHESTRATION_REQUIREMENTS.md`
- `docs/superpowers/specs/2026-09-01-ios-black-box-recording-orchestration-design.md`
