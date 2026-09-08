## ADDED Requirements

### Requirement APP-001: 应用隔离
平台 SHALL 按产品线和应用双重隔离任务、产物和执行能力；iOS 存量 Workflow 标识 MUST 保持不变。

#### Scenario: 跨端访问
GIVEN 同一产品线已有 iOS、Android 应用
WHEN Android 请求 iOS 专属 API 或 AI 工具
THEN 服务端拒绝执行；切换应用后历史与审批不混用。

### Requirement AND-001: 可追溯任务
Android 构建 SHALL 接收完整 Commit，并持久化唯一请求标识和执行配置快照。提交结果不明 MUST NOT 自动重试。

#### Scenario: Jenkins 超时
GIVEN Jenkins 接收请求但响应丢失
WHEN 用户用同一请求键重试
THEN 返回原任务，通过 Jenkins 参数中的唯一请求标识恢复，不能按分支或时间猜测。

### Requirement AND-002: APK 门禁
下载 SHALL 绑定构建成功证据、APK SHA256 和最近一次同源 Smoke，实际安装包名和版本必须匹配。证据缺失、失败或未知 MUST 阻止下载。

#### Scenario: 证据错配
GIVEN Smoke 的源构建、Commit、校验值或安装版本与 APK 不一致
WHEN 同步或下载
THEN 门禁拒绝，保留诊断原因。

### Requirement AND-003: 外部验收
平台 MUST 将已实现的适配能力与实际接入验收区分。

#### Scenario: 未配置设备
GIVEN 未提供 Android 设备
WHEN 查询接入状态
THEN 展示缺项并阻止 Smoke，不宣称实际链路已通过。
