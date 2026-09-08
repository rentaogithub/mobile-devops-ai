# 移动管理平台：Android 接入

2026-09-08：Android 首期通用适配已实现并通过离线验证。当前没有真实 Android 应用仓库、Job 和测试设备资料，不能标记为实际接入验收通过。平台继续保留原有 iOS 能力。

服务选择已支持按应用配置，详见 [应用服务选配](APPLICATION_SERVICE_SELECTION.md)。NN Android 可选 Bugly，iOS 可选 Sentry/Podx；未启用服务不会继续开放对应入口和工具。

## 已实现范围

| 环节 | 本次实现 | 验收边界 |
| --- | --- | --- |
| 应用与产品线 | 同一产品线增加 iOS、Android 应用；顶部切换；独立 Workflow 空间；应用接入管理页 | 目前每条产品线每个平台各一个应用；存量 iOS 空间原样保留 |
| 平台能力 | 服务端拦截 iOS 专属接口的 Android 请求；AI 工具在展示、授权和执行时校验平台；切换后清空当前页面与会话状态 | Android 不调用 Apple、WDA、XCUITest、Pods 和旧 iOS Jenkins 执行器 |
| 构建 | 完整 40 位 Commit；显式 Android Job；执行配置快照；APK 实际包名/版本、签名验证和 SHA256 清单 | 需要已配置 Gradle Wrapper、JDK、SDK 与签名的 Android 工程 |
| 任务追踪 | 请求键幂等；提交前持久化；按唯一请求参数恢复队列/构建；取消请求与取消终态区分 | 状态由页面“同步状态”或 AI 同步工具刷新；超时不等于已终止；不自动重复提交 |
| 设备与 Smoke | 指定 adb 测试设备；安装版本核验；拉取已安装 APK 核对 SHA256；启动观察 10 秒；日志、PNG 截图、安装信息及证据校验值 | 单 APK 安装启动 Smoke，不能替代登录/业务回归、完整 Crash/ANR 检测或性能评估 |
| Crash / ANR | 失败 Smoke 中可核验的 Java Crash/ANR 线索进入应用级 Issue，归档原始日志并保存最多 100000 字符摘录；后续同 APK 通过 Smoke 后可人工复核关闭 | 未接入 R8/ProGuard 还原、NDK 符号化、线上采样或确定性业务回归 |
| 内部分发 | 构建证据 + 最近一次同源 Smoke + 无未解决的 Smoke Crash/ANR；服务端重新计算 APK SHA256 后下载 | 仅内部测试下载；未对接蒲公英、Google Play 等商店，不代表审核或发布成功 |
| AI | `android_readiness`、`android_list_runs`、`android_sync_run`、`android_gate`、需确认的 `android_trigger_run` | 模型只能使用当前应用、角色可用的工具；确认后的配置若变化会阻止执行，不能把配置齐全描述成实机验收通过 |

安装包下载使用当前页面同源 `/api/android/...` 地址，随当前访问服务器的地址变化。链接要求登录和正确的应用上下文，不提供匿名公开安装链接。服务器地址变化后，应从新地址打开平台；已复制的旧地址不会自行改写。

## 首条真实产品的接入步骤

1. 管理员进入“应用接入”（`/applications`），在目标产品线创建 Android 应用，填写真实 applicationId。Android 应用标识、平台和 Workflow 身份创建后不可修改；执行配置可分批填写。
2. 在产品线服务配置中设置 Jenkins 服务地址、用户和 API Token。Android 应用分别填写构建 Job、Smoke Job、仓库 HTTPS/SSH URL、构建变体、APK 相对路径和测试设备序列号。仓库 URL 不得包含密码或 Token。
3. 在 Jenkins 配置下面的构建/Smoke 模板和代理机依赖。此步骤不会由平台自动安装插件或写入真实 Jenkins Job。
4. 选择 Android 应用，进入“Android 交付”（`/android`），输入完整 Commit 创建 APK 任务。通过“同步状态”读取真实 Jenkins 结果与产物清单。
5. 对通过的 APK 执行安装启动 Smoke，核对设备、实际 APK 和证据。安装会更新测试设备上的同包名应用，应使用专用测试设备。
6. 验证错 Commit、错包、版本不符、失败/缺失 Smoke、APK 或证据篡改均不能下载；验证排队取消、执行取消和平台进程重启后的任务恢复。
7. 通过门禁后使用“校验并下载”。失败 Smoke 产生的问题可在下方查看原始日志；复核关闭必须选择问题发生后同一 APK 的通过 Smoke。

首条真实产品仍需提供：产品线名称、applicationId、仓库 URL、目标 Commit、两个 Jenkins Job、测试设备序列号及后续分发渠道。真实签名、仓库凭据和商店凭据直接配置到 Jenkins 凭据库，不发送给 AI。

## Jenkins 执行契约

模板：

- `scripts/android/Jenkinsfile.build`
- `scripts/android/Jenkinsfile.smoke`
- `scripts/android/runner.py`

构建代理标签默认 `android-build`，质检代理标签默认 `android-device`，可按实际节点调整。代理机预装 Python 3.9+、工程兼容的 JDK、Android SDK、`apkanalyzer`、`apksigner`，质检节点还需要 `adb`。工程包含可执行的 `gradlew`。构建变体 `debug` 会执行 `assembleDebug`；多 flavor 例如 `demoDebug` 对应 `assembleDemoDebug`。当前不支持自定义任意构建脚本或任意 Gradle 任务输入。

将 `runner.py` 从固定的可信平台版本部署到代理机，配置绝对路径环境变量 `PLATFORM_ANDROID_RUNNER`。不要从被测 App 仓库加载可替换的执行器。构建 Job 设置 `ANDROID_GIT_CREDENTIALS_ID`，签名密钥、口令由 Jenkins Credentials 和应用 Gradle 配置提供。质检 Job 需要 Copy Artifact、Lockable Resources 插件，对源构建 Job 仅授权读取产物；按设备序列号加锁，防止多个应用同时安装同一设备。

Jenkins API 访问要求 API Token（不使用账号密码替代）；API Token 免 CSRF crumb。HTTP 请求不跟随外部重定向。反向代理需配置正确的 Jenkins 根 URL。平台保存任务的 Jenkins 地址快照；Jenkins 地址改变后，历史任务须恢复原入口或先实施经过核验的地址迁移，不会把历史构建号直接指向新服务器。

构建清单 `mobile-delivery.json` 包含：`schemaVersion=1`、`kind=build`、`requestId`、`applicationId`、`packageId`、`commit`、`apkPath`、`sha256`、字符串 `versionCode`/`versionName`。实际 APK 与清单一起归档。

Smoke 清单 `mobile-quality.json` 包含相同身份字段、源 `sourceRunId`/`sourceJob`/`sourceBuild`、APK SHA256、实际安装包名与版本、设备序列号、启动/Crash/ANR 布尔结果，以及 `evidence` 和 `evidenceSha256`（logcat、screenshot、packageDump 三项）。平台读取归档文件并逐个核验，缺项或不匹配不得通过。

恢复仅搜索目标 Job 最近 100 次构建与当前队列的 `PLATFORM_REQUEST_ID`；不会按分支、时间或构建号相近猜测。队列过期且对应构建已被清理、相同请求出现多个构建时，需要人工核验，不能更换请求键盲目重发。同一目标有未结束任务时禁止用新键重复提交。

构建超时 30 分钟、Smoke 超时 15 分钟由 Jenkins 强制执行。平台追踪超过 45 分钟显示超时并保留同步/取消能力。归档保留数量由模板默认的 50 次按实际存储策略调整；产物被清理后下载会失败，不会复用其他构建产物。APK 下载上限 512 MiB，单份 Smoke 证据上限 20 MiB。

## 验证与后续阶段

已完成类型检查、204 项后端测试、6 项前端测试、生产构建、7 项 Python 执行器模拟测试，以及 Android 和存量 iOS 交付页的浏览器 API 隔离验收。浏览器验收覆盖应用创建、平台导航、任务请求身份、APK/Smoke 操作和门禁下载；没有调用真实 Jenkins 或设备。

执行验证：

```sh
npm run check
npm run build
python3 -B -m unittest discover -s scripts/android -p 'test_*.py'
node scripts/test-android-onboarding-ui.mjs
```

后续实施取决于实际产品与渠道：AAB/拆分 APK、设备池自动调度、登录/IM/RTC 等确定性业务回归、R8/NDK 精确符号匹配、启动与帧性能、分发渠道的上传/审核/发布/观察状态。当前界面始终显示真实链路待验收，尚未提供自动“认证上线”的开关。
