# 研发交付诊断与证据可信度

以构建为上下文，连接现有产物、质量任务、Issue、回归候选、发布门禁与版本观察。页面和 AI 调用同一个只读服务，优先回答缺什么证据、为何受阻、下一步去哪里处理。

本轮不创建修复 Commit/PR，不调度 Jenkins、真机或发布，不把规则汇总称为模型推理。正式发布继续使用现有 Jenkins 实时复核和审批链路。

## ADDED Requirements

### DR-1 构建交付诊断
服务 SHALL 仅使用当前产品线中指定构建的数据，返回证据、阶段状态、门禁预览和下一步动作。读取 SHALL NOT 写入 Workflow 事件、任务或门禁。

GIVEN 同号构建属于不同产品线，WHEN 查询交付诊断，THEN 返回当前产品线的数据，AND 无记录时返回证据不足。

### DR-2 可信决策
缺失构建状态 SHALL 阻断门禁；源构建指定 Commit 而必需测试缺 Commit 时 SHALL 阻断；缺失发布观察且无已知风险时 SHALL 返回 unknown；同步旧测试 SHALL NOT 覆盖后续执行结论；非必需套件的 Crash 和失败用例 SHALL 参与门限判断。

GIVEN Smoke 通过而 Monkey 有 Crash，WHEN 预览门禁，THEN Crash 超限阻断。

GIVEN 无发布观察且无已知线上风险，WHEN 评估发布健康，THEN 状态为 unknown，AND 不建议继续放量。

### DR-3 共用服务与有限证据
页面与 AI 工具 SHALL 使用同一交付诊断；结果 SHALL 显式说明数据来自已同步快照。证据截断、缺少构建血缘 SHALL 阻止给出完整证据通过结论。

GIVEN 诊断已返回，WHEN 用户查看下一步动作，THEN 可导航现有能力入口，AND 不隐式触发写操作。

## 验收任务

- [x] DR-1：产品线隔离、只读服务、API 与集成测试。
- [x] DR-2：门禁与健康度回归测试。
- [x] DR-3：页面、AI 工具注册、类型检查及构建。

验证结果：`npm run check` 通过（后端 25 个套件 / 172 项测试，前端 2 项测试）；前后端构建通过。`node scripts/test-delivery-readiness-ui.mjs` 的浏览器验收通过，覆盖入参、证据、导航、失败刷新和产品线切换，API 全部使用固定测试数据。
