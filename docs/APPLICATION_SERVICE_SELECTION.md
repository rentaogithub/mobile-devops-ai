# 按产品线与应用选配服务

配置层级为：产品线 → 平台应用 → 已选服务 → 对应资源配置。平台支持范围和实际启用范围分开判断；同一产品线的 iOS、Android 可以选择不同的崩溃提供商和研发工具。

例如 NN iOS 可选择 Sentry、Podx、Jenkins，NN Android 可选择腾讯 Bugly、Jenkins、adb 真机质检。Bugly 并非 Android 专属：iOS 也可选择 Bugly。Podx 目前只支持 iOS，Android 不可启用。

## 操作入口

管理员从顶部“应用接入”进入当前产品线，点击目标 iOS 或 Android 应用的“选配服务”。

- 按应用勾选服务；每个应用当前可以选择一个主崩溃提供商：Sentry、Bugly，或都不启用。
- 自动质检依赖 Jenkins 和真机服务。选择质检会补选依赖；取消任一依赖会同时取消质检。API 同样校验依赖，不能绕过页面提交无效组合。
- Android 只选择 Jenkins 时，仅检查 APK 构建配置，不要求 Smoke Job 和测试设备；关闭质检后保留历史证据，停用 Smoke 同步与门禁下载操作。
- Bugly 可填写真实 App ID 和应用控制台 URL；Sentry 也可填写控制台入口。URL 不得包含账号密码、Token 或 API Key。
- “应用服务”显示当前应用已选模块、控制台入口和适配边界。资源配置齐全不等于数据集成或真实链路验收通过。
- “组件库（Podx）”可绑定同系统的已有库，多个产品线共用版本、Nexus 与 Specs 资源；主工程配置保持独立，详见[共用组件库](SHARED_COMPONENT_LIBRARIES.md)。

新产品线创建的初始 iOS 应用不自动启用可选服务。Android 接入表单提供可修改的首期建议项；NN Android 建议项包含 Bugly。存量应用尚未保存过选配时沿用既有 iOS/Android 能力，以避免升级关闭已有入口；显式空数组则表示关闭全部可选服务，重新启动不会恢复默认值。

## 服务与资源的边界

| 服务 | 当前平台适配 | 配置与运行范围 |
| --- | --- | --- |
| Sentry | iOS 原生接入；Android 仅控制台入口 | iOS 数据地址、Organization、Project 与凭据沿用当前产品线已有 Sentry 配置；控制台 URL 不替换数据 API 地址 |
| 腾讯 Bugly | iOS / Android 控制台入口 | App ID 和控制台 URL 按应用保存；问题同步、符号还原、指标和 AI 数据诊断仍待接口适配 |
| Podx / Pods | iOS | 产品线的 Podx/mgit 资源配置只有在对应 iOS 应用启用 Podx 时才同步到工程 |
| Jenkins | iOS / Android | 启用开关按应用；当前 Jenkins 服务器和 API 凭据仍是产品线共享资源，Android 使用独立 Job 配置 |
| 自动质检、真机服务 | iOS / Android | 使用各自执行器；Android 当前仅支持已实现的指定设备 APK 安装启动 Smoke |
| dSYM、反馈日志、API/路由查询、质量中心、企业微信、水印、DevOps、Apple 设备登记 | 已有 iOS 适配 | 独立选配，不因产品线是 iOS 就强制展示；Android 对应适配未完成前不可启用 |

所有模块的支持范围由服务目录统一声明。新增平台/提供商适配需要实现执行器和证据契约后再修改目录，不能仅放开复选框来声明支持。

## 生效范围

页面导航和直接路由访问都检查服务选择；服务端 API 独立校验，隐藏菜单不能替代执行拦截。Sentry/OP/Sonic 代理入口也应用对应服务限制。公开 Apple 描述文件回调保留已有已签发登记会话处理，不依赖浏览器当前选择。

AI 工具同时满足角色、系统和服务条件才会开放；复合诊断要求依赖的全部服务已选。待确认动作在执行时重新读取服务状态，停用后不能用旧审批继续调用。能力检索与首页建议不会继续推荐已关闭的工具。

后台同步跳过未启用的 Sentry、Podx、Jenkins、质检、dSYM 源。保存产品线不再无条件同步 Podx；Jenkins 的 dSYM 自动同步也检查开关。停用保留资源配置和历史记录，不会删除历史产物或自动终止已经运行的外部任务，也不会修改 Jenkins Job 内部脚本。

如果质量门禁要求线上 Crash 治理证据，切到未接入数据 API 的提供商或关闭 Sentry 后，会返回当前提供商证据不足；不会用旧 Sentry 的空风险结果宣称已验证。若需要不同平台连接同类服务的不同服务器和凭据，还需进一步扩展应用级连接实例；当前共享资源边界见上表。

## 验证

新增后端用例覆盖应用/产品线隔离、服务兼容性与依赖、空配置迁移、控制台参数安全、直接 API 拦截、AI 撤销、后台同步跳过及旧提供商证据拦截。

浏览器用例 `scripts/test-application-services-ui.mjs` 使用隔离 API fixtures 验证：两端不同提供商、服务取消联动、隐藏和阻止未启用页面、Android 禁用 Podx，以及明确关闭全部服务。测试不会访问真实 Bugly/Sentry，也不会触发构建或安装。

```sh
npm run check
npm run build
node scripts/test-application-services-ui.mjs
node scripts/test-android-onboarding-ui.mjs
node scripts/test-delivery-readiness-ui.mjs
```
