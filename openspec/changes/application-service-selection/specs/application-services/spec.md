## ADDED Requirements

### Requirement SVC-001: 应用选配
系统 SHALL 按产品线和应用独立保存服务选择。系统 MUST 区分未迁移配置与显式关闭全部服务；Android MUST NOT 启用仅支持 iOS 的 Podx。

#### Scenario: 双平台崩溃提供商
GIVEN NN iOS 与 NN Android
WHEN 分别选择 Sentry 和 Bugly
THEN 两端分别展示相应服务，配置、菜单和执行能力互不覆盖。

### Requirement SVC-002: 执行约束
系统 SHALL 对 API、后台同步和 AI 工具应用服务约束。停用后的 AI 待审批操作 MUST 重新验证可用服务；复合工具 SHALL 满足全部服务依赖。

#### Scenario: 关闭服务
GIVEN iOS 应用已关闭 Sentry 和 Podx
WHEN 调用 Sentry API、Podx 同步或相应 AI 工具
THEN 服务端拒绝，后台跳过该同步源，其他已选服务继续可用。

### Requirement SVC-003: 接入状态真实性
选中提供商 MUST NOT 被当作数据集成成功。控制台入口 SHALL 明确与问题同步、符号化和 AI 诊断区分。

#### Scenario: Bugly 待接入
GIVEN 应用已选择 Bugly 并填写控制台 URL
WHEN 打开应用服务页
THEN 可以进入配置的控制台，同时标明数据适配待接入，不展示伪造的已同步问题。

### Requirement SVC-004: 质量证据
切换或关闭崩溃提供商后，门禁 MUST NOT 用旧提供商的空风险结果声称已验证当前线上风险。

#### Scenario: 尚无 Bugly 数据适配
GIVEN 门禁要求线上 Crash 治理证据，当前应用选择 Bugly
WHEN 评估门禁
THEN 返回缺少当前提供商证据的阻断项。
