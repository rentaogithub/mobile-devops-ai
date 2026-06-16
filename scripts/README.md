# Scripts

## 自动质检

日常自动质检默认走打包机本机 USB 真机，不依赖 Sonic Server/Web。Jenkins `nn-auto-quality` 调用：

```bash
sh scripts/sonic/ios-quality.sh
```

脚本会按顺序执行：

1. 读取平台传入的构建号、分支、Commit、APP 版本和 IPA 地址。
2. 使用 `tidevice` 识别打包机 USB 连接的 iPhone。
3. 获取安装包：优先使用 Jenkins 本地 IPA，其次从 `XCARCHIVE_PATH/Products/Applications/*.app` 生成临时 IPA，最后才尝试外部 URL。
4. 从 IPA 或 `.xcarchive` 自动识别真实 Bundle ID，启动 App，生成 `quality-results/**` 日志和 JUnit 报告。

Jenkins `nn-auto-quality` 的 `Execute shell` 不写死平台目录。平台触发质检时会自动传入 `NN_IOS_PLATFORM_DIR`；手动点 `Build with Parameters` 时才需要填写该参数：

```bash
set -e
PLATFORM_DIR="${NN_IOS_PLATFORM_DIR:-}"
if [ -z "$PLATFORM_DIR" ] && [ -n "${WORKSPACE:-}" ] && [ -f "$WORKSPACE/scripts/sonic/ios-quality.sh" ]; then
  PLATFORM_DIR="$WORKSPACE"
fi
if [ -z "$PLATFORM_DIR" ] || [ ! -f "$PLATFORM_DIR/scripts/sonic/ios-quality.sh" ]; then
  echo "ERROR: NN_IOS_PLATFORM_DIR is not configured or invalid."
  echo "Expected file: $NN_IOS_PLATFORM_DIR/scripts/sonic/ios-quality.sh"
  echo "When triggered by nn-ios-platform, this parameter is passed automatically."
  echo "For manual Jenkins builds, fill NN_IOS_PLATFORM_DIR with the platform project directory."
  exit 2
fi
cd "$PLATFORM_DIR"
bash scripts/sonic/ios-quality.sh
```

如果平台部署目录变化，不需要改 Jenkins Job；重启/重新启动平台服务后，平台会按当前服务实际目录重新传参。

常用 Jenkins 参数：

| 参数 | 说明 |
| --- | --- |
| `SOURCE_BUILD_NUMBER` | 来源发布构建号 |
| `PACKAGE_URL` | 可下载的 IPA 地址 |
| `XCARCHIVE_PATH` | 打包机本地 `.xcarchive` 路径，可从 `Products/Applications/*.app` 生成临时 IPA |
| `DEVICE_POOL` | 平台设备池 value |
| `DEVICE_UDID` | 指定真机 UDID，留空自动选择第一台 |
| `APP_BUNDLE_ID` | 启动校验的 Bundle ID，蒲公英渠道默认 `com.nndev.im` |
| `TEST_SUITE` | 测试套件：`smoke`、`login`、`im`、`rtc`、`monkey`、`full` |
| `REQUESTED_TEST_SUITE` | 平台原始选择的质检套件，空值时使用 `TEST_SUITE` |
| `RUN_MONKEY` | 设为 `1` 时执行 Monkey 随机测试 |
| `WDA_URL` | Monkey 测试使用的 WebDriverAgent 地址，默认 `http://10.1.3.177:8100` |
| `WDA_AUTO_START` | Monkey 测试前自动启动 WebDriverAgent，默认 `1` |
| `WDA_AUTO_INSTALL` | 找不到 WebDriverAgent.xcodeproj 时自动安装/检测 Appium XCUITest Driver，默认 `1` |
| `WDA_PROJECT_PATH` | 可选：WebDriverAgent.xcodeproj 路径，留空时自动查找 Sonic Agent / Appium 常见目录 |
| `MONKEY_EVENT_COUNT` | Monkey 随机事件次数，默认 `30` |
| `MONKEY_INTERVAL_SECONDS` | Monkey 事件间隔，默认 `0.35` |

当前自动质检只启动蒲公英渠道包，默认 Bundle ID 为 `com.nndev.im`。如果日志中出现 `Installing 'com.xxx'` 但后续启动的是另一个 Bundle ID，说明 Jenkins 参数或平台环境变量 `QA_APP_BUNDLE_ID` 覆盖了默认值。iOS 17+ 设备上如果 `tidevice launch` 报 `DeveloperImage not found`，脚本会自动尝试 `xcrun devicectl device process launch`；仍失败时，需要确认打包机 Xcode 版本支持该 iOS 系统版本。

如果 `devicectl` 报 `The device must be paired before it can be connected`，说明 Jenkins 运行用户还没有完成 Xcode/CoreDevice 配对。脚本会自动执行一次：

```bash
xcrun devicectl manage pair --device <UDID>
```

此时需要保持 iPhone 解锁，并在设备上确认信任/配对。若 Jenkins 环境仍失败，可登录打包机同一个 macOS 用户后手动执行上面的命令，再重新触发质检。

也可以直接使用仓库脚本完成配对和启动：

```bash
sh scripts/sonic/sonic.sh ios-pair
```

指定设备或 Bundle ID：

```bash
sh scripts/sonic/sonic.sh ios-pair 00008101-0015192E0178001E
sh scripts/sonic/sonic.sh ios-pair 00008101-0015192E0178001E com.nndev.im
```

### 同步 Jenkins Job

仓库里的 `scripts/jenkins/nn-auto-quality-config.xml` 是 `nn-auto-quality` 的标准配置。修改模板后，需要同步到 Jenkins 实例：

```bash
bash scripts/jenkins/sync-nn-auto-quality-job.sh
```

脚本默认读取 `backend/.env` 中的 `JENKINS_BASE_URL` 和 `JENKINS_NN_QA_JOB`。如果 Jenkins 不允许匿名更新配置，需要在 `backend/.env` 或命令行环境中配置：

```bash
JENKINS_USER=admin
JENKINS_TOKEN=your-api-token
```

如果同步时报 Jenkins 500，但原页面可访问，通常是 Jenkins 拒绝无认证的 `config.xml` 更新；使用管理员 API Token 后再执行同步。

## Sonic 可选诊断

Sonic 现在是可选扩展能力，不随平台默认启动。需要排查 Sonic 时再使用统一入口：

```bash
sh scripts/sonic/sonic.sh start
sh scripts/sonic/sonic.sh check
sh scripts/sonic/sonic.sh stop
```

`scripts/sonic/sonic.sh` 会调度下面这些内部子脚本：

| 脚本 | 用途 |
| --- | --- |
| `scripts/sonic/bootstrap.sh` | 一键启动 Sonic Server/Web + Agent，并输出诊断 |
| `scripts/sonic/init-stack-env.sh` | 初始化 `deploy/sonic/.env` |
| `scripts/sonic/start-stack.sh` | 启动 Sonic Server/Web Docker 服务 |
| `scripts/sonic/prepare-agent.sh` | 下载/解压 Sonic Agent，生成 `start.sh` |
| `scripts/sonic/start-agent.sh` | 启动 Sonic Agent |
| `scripts/sonic/check.sh` | 诊断 Sonic Server/Web、平台代理和 Agent 线索 |
| `scripts/sonic/ios-quality.sh` | Jenkins 本机真机自动质检执行脚本 |

除非要单独排查某一层，平时不要直接调用内部子脚本。
