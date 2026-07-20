# Sonic 单 Mac 自动质检部署说明

本文档用于“一台 Mac 同时承载打包 + 平台 + Sonic + 真机 Agent”的落地方式。

## 目标架构

```text
一台 Mac: 10.1.3.177
  Jenkins
  nn-ios-platform
  Sonic Server
  Sonic Web
  Sonic Agent
  iPhone 真机
```

对外统一入口：

```text
平台:        http://10.1.3.177:5173
Sonic 后台:  http://10.1.3.177:5173/sonic-admin
Sonic API:   http://10.1.3.177:5173/sonic-api
Jenkins:     http://10.1.3.177:8080/job/nn/
```

本机内部服务：

```text
Sonic Web:    http://127.0.0.1:3002
Sonic API:    http://127.0.0.1:8094
Sonic Agent:  直连 http://127.0.0.1:3002（WebSocket /server 代理）
```

## 角色分工

| 模块 | 职责 |
| --- | --- |
| Jenkins | 构建 IPA，触发自动质检 Job |
| nn-ios-platform | 展示发布管理、自动质检、设备池配置和 Sonic 入口 |
| Sonic Server/API | 管理设备、测试计划、执行任务和报告 |
| Sonic Web | Sonic 后台页面 |
| Sonic Agent | 运行在这台 Mac 上，控制 USB 连接的 iPhone |
| iPhone 真机 | 执行安装、启动和自动化用例 |

## 前置条件

### 系统环境

- macOS
- Xcode 已安装并打开过一次
- Xcode Command Line Tools 已安装
- 当前 Mac 能访问 Jenkins、Git、内部包地址和平台服务
- iPhone 使用 USB 连接到这台 Mac

安装 Command Line Tools：

```bash
xcode-select --install
```

确认 Xcode 路径：

```bash
xcode-select -p
```

## 真机依赖安装

### Homebrew

如果未安装 Homebrew，先安装：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### libimobiledevice / ideviceinstaller

```bash
brew install libimobiledevice ideviceinstaller
```

### tidevice

```bash
brew install pipx
pipx ensurepath
pipx install tidevice
```

如果当前终端还找不到 `tidevice`，重新打开终端，或执行：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 连接 iPhone

1. USB 连接 iPhone 到 Mac。
2. 解锁 iPhone。
3. 在手机上点击“信任此电脑”。
4. 保持手机处于可用状态。

验证设备：

```bash
idevice_id -l
tidevice list
```

能看到 UDID 后，说明 Mac 已经可以识别真机。

## WebDriverAgent 配置

Sonic Agent 控制 iOS 真机时通常需要 WebDriverAgent。

需要确认：

1. Xcode 登录了可用于真机调试的开发者账号。
2. WebDriverAgent 能使用当前 Team 签名。
3. iPhone 已信任开发者证书。
4. WDA 能在真机上启动。

建议先用 Sonic Agent 自带的 WDA 配置方式处理；如果 Sonic 后台提示 WDA 启动失败，再到 Xcode 中单独打开 WebDriverAgent 工程修签名。

常见问题：

- 签名失败：检查 Team、Bundle Identifier、证书和描述文件。
- 设备不可用：重新插拔 USB，确认 iPhone 解锁并信任电脑。
- WDA 启动超时：检查 iOS 版本、Xcode 版本和设备开发者模式。

## 部署 Sonic Server / Web

平台已经提供 Sonic 子服务部署模板：

```bash
sh scripts/sonic/sonic.sh stack
```

脚本会自动生成 `deploy/sonic/.env`：

```bash
SONIC_HOST=10.1.3.177
SONIC_WEB_PORT=3002
SONIC_API_PORT=8094
SONIC_MYSQL_PORT=3307
SONIC_REDIS_PORT=6380

SONIC_WEB_IMAGE=sonicorg/sonic-client-web:v2.7.2
SONIC_EUREKA_IMAGE=sonicorg/sonic-server-eureka:v2.7.2
SONIC_GATEWAY_IMAGE=sonicorg/sonic-server-gateway:v2.7.2
SONIC_CONTROLLER_IMAGE=sonicorg/sonic-server-controller:v2.7.2
SONIC_FOLDER_IMAGE=sonicorg/sonic-server-folder:v2.7.2

SONIC_MYSQL_PASSWORD=自动生成
SONIC_MYSQL_ROOT_PASSWORD=自动生成
```

如果内部网络无法拉取 Docker Hub，可把这些 `SONIC_*_IMAGE` 覆盖成内部镜像仓库地址。Apple Silicon 会自动从官方 JAR 构建本地 arm64 兼容镜像。

启动：

```bash
docker compose --env-file .env up -d
```

查看状态：

```bash
docker compose --env-file .env ps
```

查看日志：

```bash
docker compose --env-file .env logs -f sonic-server-controller sonic-server-gateway
docker compose --env-file .env logs -f sonic-web
```

## 配置 nn-ios-platform

编辑 `backend/.env`：

```bash
SONIC_API_BASE=http://10.1.3.177:5173/sonic-api
SONIC_WEB_URL=http://10.1.3.177:5173/sonic-admin
SONIC_API_PROXY_TARGET=http://127.0.0.1:8094
SONIC_WEB_PROXY_TARGET=http://127.0.0.1:3002
SONIC_TOKEN=your_sonic_token
SONIC_PROJECT_ID=nn-ios
SONIC_TEST_PLAN_ID=smoke
```

说明：

- `SONIC_API_BASE` 给 Jenkins 调用，统一走平台入口。
- `SONIC_WEB_URL` 给页面“打开 Sonic”按钮使用。
- `SONIC_API_PROXY_TARGET` 是平台后端代理到本机 Sonic API 的地址。
- `SONIC_WEB_PROXY_TARGET` 是平台后端代理到本机 Sonic Web 的地址。
- `SONIC_TOKEN` 如果不想通过平台透传，可只配置在 Jenkins Credential 或 Job 环境变量里。

重启平台后端和前端。

验证：

```bash
curl -I http://10.1.3.177:5173/sonic-admin
curl -I http://10.1.3.177:5173/sonic-api
```

## 启动 Sonic Agent

Sonic Agent 运行在同一台 Mac 上，通过 Sonic Web 的 `/server` WebSocket 代理连接：

```text
http://127.0.0.1:3002
```

不要把 Agent 指向 Gateway 的 `8094`：该端口供平台 API 调用；Agent 2.7.2 需要连接 Web 暴露的 `3002`，由 `/server` 转发到 Controller WebSocket。

Agent 需要配置：

- Sonic Server/API 地址
- Agent 名称
- 设备机 IP 或标识
- iOS 设备能力
- WebDriverAgent 签名配置

启动 Agent 后，到 Sonic 后台确认 iPhone 在线：

```text
http://10.1.3.177:5173/sonic-admin
```

### 随 nn-ios-platform 自动启动 Agent

建议把 Sonic Agent 放在 `nn-ios-platform` 同级的独立目录，代码、平台运行数据和 Agent 程序分开维护：

```text
/Users/a1/工作/
  nn-ios-platform/
  nn-ios-platform-data/
  sonic-agent/
```

## Sonic 脚本使用

日常只需要记住一个入口：

```bash
cd /Users/a1/工作/nn-ios-platform
sh scripts/sonic/sonic.sh start
```

常用命令：

```bash
sh scripts/sonic/sonic.sh start   # 一键启动 Sonic Server/Web + Agent，并输出诊断
sh scripts/sonic/sonic.sh check   # 检查 Sonic Server/Web、平台代理、Agent 线索
sh scripts/sonic/sonic.sh stop    # 停止 Sonic Agent 和 Sonic Server/Web 容器
```

辅助命令：

```bash
sh scripts/sonic/sonic.sh prepare # 准备/下载/解压 Sonic Agent，生成 start.sh
sh scripts/sonic/sonic.sh stack   # 仅启动 Sonic Server/Web
sh scripts/sonic/sonic.sh agent   # 仅启动 Sonic Agent
```

`npm run dev` / `npm start` 会自动调用 `npm run start:sonic`，等价于：

```bash
sh scripts/sonic/sonic.sh start
```

`scripts/sonic/bootstrap.sh`、`scripts/sonic/prepare-agent.sh`、`scripts/sonic/start-stack.sh`、`scripts/sonic/start-agent.sh`、`scripts/sonic/check.sh` 是内部子脚本。除非需要单独排查某一层，平时不用直接执行它们。

默认情况下，`sonic.sh start` 会访问 Sonic Agent 官方 GitHub Release，自动选择当前 Mac 架构对应的包：

```text
https://github.com/SonicCloudOrg/sonic-agent/releases
```

Apple Silicon 会选择 `macosx_arm64` 包，Intel Mac 会选择 `macosx_x86_64` 包。

如果固定电脑不能访问 GitHub，或者希望使用内部缓存包，可以在 `backend/.env` 中设置：

```bash
SONIC_AGENT_PACKAGE_URL=http://your-internal-host/sonic-agent.zip
```

如果关闭自动下载，且真实 Agent 包还没放到 `/Users/a1/工作/sonic-agent`，脚本会明确以“缺少 Sonic Agent runtime package”结束；这时不是 `.env` 配置问题，而是还缺实际 Agent 程序。

Agent 默认目录为：

```text
/Users/a1/工作/sonic-agent
```

如果目录中存在 `sonic-agent*.zip`、`sonic-agent*.tar.gz`、`sonic-agent*.tgz` 或 `sonic-agent*.jar`，脚本会自动解压或识别。如果解压后存在 `sonic-agent*.jar`，且目录中还没有 `start.sh`，脚本会自动生成可执行的 `start.sh`：

```bash
java -jar sonic-agent*.jar --server.host=http://127.0.0.1:8094
```

最终目录下需要有以下任意一种启动入口：

```text
/Users/a1/工作/sonic-agent/start.sh
/Users/a1/工作/sonic-agent/sonic-agent*.jar
```

`prepare` 会同时生成：

```text
/Users/a1/工作/sonic-agent/INSTALL_PACKAGE_HERE.txt
/Users/a1/工作/sonic-agent/start.sh.template
```

它们只是提示和模板，不代表 Agent 已经安装完成。不要直接把 `start.sh.template` 当作可用 Agent 启动脚本。

也可以显式指定本地包路径：

```bash
sh scripts/sonic/sonic.sh prepare /Users/a1/工作/sonic-agent/sonic-agent.zip
```

平台启动脚本已经支持自动拉起 Sonic Agent。先在 `backend/.env` 中配置其中一种方式：

```bash
SONIC_AGENT_AUTO_START=true
SONIC_AGENT_DIR=/Users/a1/工作/sonic-agent
SONIC_AGENT_AUTO_DOWNLOAD=true
SONIC_AGENT_API_BASE=http://127.0.0.1:8094
```

如果 Agent 不是标准目录结构，也可以直接指定启动命令：

```bash
SONIC_AGENT_AUTO_START=true
SONIC_AGENT_CMD='cd /Users/a1/工作/sonic-agent && sh start.sh'
```

之后启动平台即可：

```bash
npm run dev
# 或
npm start
```

启动行为：

- 如果 Sonic Agent 已经运行，会跳过。
- 如果没有配置 `SONIC_AGENT_DIR` 或 `SONIC_AGENT_CMD`，只打印提示，不阻断平台启动。
- Agent 日志默认写入 `sonic-agent.log`。
- Agent PID 默认写入 `nn-ios-platform-data/sonic-agent.pid`。

停止开发环境时：

```bash
sh scripts/stop-dev.sh
```

如果 Agent 是由平台启动的，会一起停止。

## Sonic 后台配置

在 Sonic 后台完成：

1. 确认 iPhone 在线。
2. 创建项目，例如 `nn-ios`。
3. 创建测试计划，例如 `smoke`。
4. 创建设备分组：
   - `iOS 默认设备池`
   - `iPhone 新系统池`
   - `iPhone 兼容性池`
5. 将真机加入对应设备分组。
6. 记录设备分组 ID。

## 平台设备池配置

打开：

```text
CI/CD -> 自动质检 -> Sonic 配置状态 -> 设备池管理
```

配置示例：

| 名称 | value | Group ID | 说明 |
| --- | --- | --- | --- |
| iOS 默认设备池 | ios-default | 1 | 日常冒烟质检 |
| iPhone 新系统池 | ios-latest | 2 | 新系统兼容性 |
| iPhone 兼容性池 | ios-compat | 3 | 旧机型或旧系统回归 |

`Group ID` 必须与 Sonic 后台设备分组 ID 一致。

## Jenkins 配置

### 发布 Job

现有 `nn` Job 负责打包和发布，平台会读取构建列表并触发发布。

### 自动质检 Job

创建或确认 Jenkins Job：

```text
nn-auto-quality
```

Job 需要支持参数化构建：

| 参数 | 来源 |
| --- | --- |
| `SOURCE_JOB` | 平台传入 |
| `SOURCE_BUILD_NUMBER` | 平台传入 |
| `BRANCH` | 平台传入 |
| `COMMIT_HASH` | 平台传入 |
| `APP_VERSION` | 平台传入 |
| `PACKAGE_URL` | 平台传入 |
| `ARCHIVE_URL` | 平台传入 |
| `TEST_SUITE` | 平台传入 |
| `DEVICE_POOL` | 平台传入 |
| `DEVICE_POOL_LABEL` | 平台传入 |
| `SONIC_DEVICE_GROUP_ID` | 平台传入 |
| `DEVICE_CLOUD` | 平台传入 |
| `SONIC_API_BASE` | 平台传入 |
| `SONIC_PROJECT_ID` | 平台传入 |
| `SONIC_TEST_PLAN_ID` | 平台传入 |
| `SONIC_TOKEN` | Jenkins Credential 或 Job 环境变量 |

Shell 步骤：

```bash
sh scripts/sonic/ios-quality.sh
```

构建后操作建议：

- 发布 JUnit 报告：`quality-results/**/*.xml`
- 归档产物：`quality-results/**`
- 归档 Sonic 截图、录像、日志

## 自动质检流程

```text
发布管理生成 IPA
  -> 自动质检选择构建
  -> 选择测试套件和设备池
  -> 平台触发 nn-auto-quality
  -> Jenkins 调用 sonic-ios-quality.sh
  -> 脚本调用 Sonic API
  -> Sonic 从 Group ID 对应设备池选择真机
  -> Sonic Agent 控制 iPhone 安装并执行用例
  -> Jenkins 收集 JUnit / 截图 / 日志
  -> 平台展示质检任务和报告入口
```

## 验收清单

### Mac 能识别设备

```bash
idevice_id -l
tidevice list
```

### Sonic 服务可用

```bash
curl -I http://127.0.0.1:3002
curl -I http://127.0.0.1:8094
```

### 平台代理可用

```bash
curl -I http://10.1.3.177:5173/sonic-admin
curl -I http://10.1.3.177:5173/sonic-api
```

### 平台能读取 Sonic 配置

打开：

```text
CI/CD -> 自动质检
```

确认：

- “打开 Sonic”按钮可用。
- “检测 Sonic”可返回状态。
- “设备池管理”能保存 Group ID。

### Jenkins 能收到参数

触发一次自动质检，查看 `nn-auto-quality` 日志，确认出现：

```text
设备池: iOS 默认设备池 (ios-default)
Sonic Group ID: 1
调用 Sonic API: http://10.1.3.177:5173/sonic-api
```

### Sonic 后台能看到任务

在 Sonic 后台查看：

- 任务是否创建。
- 设备是否被占用。
- iPhone 是否开始安装 IPA。
- 是否产出截图、日志、报告。

## 常见问题

### 平台能打开，Sonic 后台打不开

检查：

```bash
docker compose --env-file deploy/sonic/.env ps
curl -I http://127.0.0.1:3002
```

确认 `SONIC_WEB_PROXY_TARGET` 是否正确。

### Jenkins 调用 Sonic 失败

检查：

- `SONIC_API_BASE` 是否为 `http://10.1.3.177:5173/sonic-api`
- `SONIC_TOKEN` 是否在 Jenkins 中配置
- Sonic API 实际路径是否与 `scripts/sonic/ios-quality.sh` 中一致

### Sonic 看不到 iPhone

检查：

```bash
idevice_id -l
tidevice list
```

同时检查：

- iPhone 是否解锁
- 是否信任此电脑
- USB 线是否稳定
- Sonic Agent 是否启动
- WebDriverAgent 是否签名成功

### WebDriverAgent 启动失败

检查：

- Xcode Team
- Bundle Identifier
- 开发者证书
- iPhone 开发者模式
- iOS 与 Xcode 版本兼容性

### 设备池选不到设备

检查：

- 平台设备池 `Group ID` 是否与 Sonic 后台分组 ID 一致
- 真机是否已加入该分组
- 真机是否在线、空闲

## 后续扩展

当一台 Mac 压力变大后，可以拆成：

```text
Mac A: Jenkins + nn-ios-platform + Sonic Server/Web
Mac B: Sonic Agent + iPhone 真机
```

拆分后只需要把 Sonic Agent 的 Server 地址改成：

```text
http://10.1.3.177:8094
```

平台和 Jenkins 仍然可以继续通过：

```text
http://10.1.3.177:5173/sonic-admin
http://10.1.3.177:5173/sonic-api
```
