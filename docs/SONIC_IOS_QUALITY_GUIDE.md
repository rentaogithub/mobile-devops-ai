# Sonic iOS 自动质检接入说明

CI/CD 模块已经拆成“发布管理”和“自动质检”。“自动质检”负责触发独立 Jenkins Job，由 Jenkins 调度 Sonic 云真机设备池执行 iOS 自动化测试。

## 平台接口

平台后端提供两个接口：

- `POST /api/jenkins/nn/quality`：触发自动质检
- `GET /api/jenkins/nn/quality/builds`：读取自动质检任务列表

默认 Jenkins 质检 Job 名为 `nn-auto-quality`，可通过环境变量覆盖：

```bash
JENKINS_NN_QA_JOB=nn-auto-quality
```

## Jenkins Job 参数

`nn-auto-quality` 需要配置为参数化构建，接收以下参数：

| 参数 | 说明 |
| --- | --- |
| `SOURCE_JOB` | 来源 Job，默认 `nn` |
| `SOURCE_BUILD_NUMBER` | 来源构建号 |
| `BRANCH` | 来源分支 |
| `COMMIT_HASH` | 来源构建 Commit |
| `APP_VERSION` | APP 版本 |
| `PACKAGE_URL` | 蒲公英或其他渠道包地址 |
| `ARCHIVE_URL` | 打包服务器 Archives 地址 |
| `TEST_SUITE` | 测试套件：`smoke`、`login`、`im`、`rtc`、`full` |
| `DEVICE_POOL` | Sonic 设备池：`ios-default`、`ios-latest`、`ios-compat` |
| `DEVICE_POOL_LABEL` | 平台设备池展示名称 |
| `SONIC_DEVICE_GROUP_ID` | Sonic 后台设备分组 ID，用于选择真机设备池 |
| `DEVICE_CLOUD` | 固定传 `Sonic` |
| `SONIC_API_BASE` | Sonic 服务地址，由平台环境变量透传 |
| `SONIC_PROJECT_ID` | Sonic 项目 ID，由平台环境变量透传 |
| `SONIC_TEST_PLAN_ID` | Sonic 测试计划 ID，由平台环境变量透传 |

## Jenkins 执行脚本

在 Jenkins Job 的 Shell 步骤中执行：

```bash
sh scripts/quality/sonic-ios-quality.sh
```

如果 Jenkins workspace 不是本仓库，可先拉取平台仓库，或把 `scripts/quality/sonic-ios-quality.sh` 复制到 Jenkins 共享脚本目录。

## Sonic 配置

脚本支持以下 Sonic 环境变量：

```bash
SONIC_API_BASE=http://sonic.example.com
SONIC_WEB_URL=http://sonic.example.com
SONIC_TOKEN=your_token
SONIC_PROJECT_ID=nn-ios
SONIC_TEST_PLAN_ID=smoke
```

平台会把 `SONIC_API_BASE`、`SONIC_PROJECT_ID`、`SONIC_TEST_PLAN_ID` 传给 Jenkins Job；`SONIC_TOKEN` 建议配置在 Jenkins Credential 或 Job 环境变量中，不建议通过构建参数明文传递。

CI/CD 的“自动质检”页会显示 Sonic 配置状态，并可检测 Sonic 服务连通性。

## Sonic 子服务部署

平台内置 Sonic 部署模板，目录为：

```bash
deploy/sonic
```

初始化：

```bash
cd deploy/sonic
cp .env.example .env
```

编辑 `.env`，确认 Sonic 镜像、端口、数据库密码：

```bash
SONIC_HOST=10.1.3.177
SONIC_WEB_PORT=3002
SONIC_API_PORT=8094
SONIC_WEB_IMAGE=sonic-web-image:latest
SONIC_SERVER_IMAGE=sonic-server-image:latest
```

启动：

```bash
docker compose --env-file .env up -d
```

平台后端配置：

```bash
SONIC_API_BASE=http://10.1.3.177:8094
SONIC_WEB_URL=http://10.1.3.177:3002
```

Sonic 真机 Agent 建议部署在接 iPhone 的 Mac mini 上；Sonic Server 可以部署在平台服务器上。设备池和真机归属仍在 Sonic 后台维护，`nn-ios-platform` 只保存设备池 value 与 Sonic Group ID 的映射。

如果 Sonic 与平台部署在 `10.1.3.177` 这台服务器上，推荐对外只暴露平台入口：

```bash
SONIC_API_BASE=http://10.1.3.177:5173/sonic-api
SONIC_WEB_URL=http://10.1.3.177:5173/sonic-admin
SONIC_API_PROXY_TARGET=http://127.0.0.1:8094
SONIC_WEB_PROXY_TARGET=http://127.0.0.1:3002
```

这样浏览器、Jenkins 都访问 `10.1.3.177:5173`，平台后端再代理到本机 Sonic Web/API 服务。

当前脚本默认调用：

```text
POST ${SONIC_API_BASE}/api/quality/ios/run
```

请求体包含构建号、分支、Commit、APP 版本、包地址、测试套件、设备池和 Sonic 设备分组 ID。若你们 Sonic 服务端 API 路径不同，只需要调整脚本里的 `curl` 地址和 payload 字段。

## Jenkins 报告配置

建议在 Jenkins Job 中增加构建后操作：

- 发布 JUnit 报告：`quality-results/**/*.xml`
- 归档构建产物：`quality-results/**`
- 可选：归档 Sonic 截图、录像、设备日志

这样平台上的“自动质检”列表可以先跳转 Jenkins 报告，后续再扩展为平台内聚合展示。

## 推荐流程

1. 发布管理生成 iOS 包。
2. 在 CI/CD 的“自动质检”页点击“新建质检”。
3. 选择来源构建、测试套件、Sonic 设备池。
4. 平台触发 `nn-auto-quality`。
5. Jenkins 调用 Sonic 设备池安装 IPA 并执行用例。
6. Jenkins 输出 JUnit、截图、录像和日志。
7. 平台展示质检任务和报告入口。
