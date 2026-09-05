# iOS 多产品线与权限隔离

平台以“产品线”作为权限和研发数据的租户边界。升级后会自动创建默认产品线 `nn`，并把已有非管理员账号按原角色迁移到该产品线；已有 dSYM、Crash 历史和 Workflow 数据继续归属 `nn`。

## 权限模型

- 平台管理员：管理产品线、账号和各产品线成员，能够访问所有产品线。
- 普通账号：可以加入一条或多条产品线，并在每条产品线分别拥有游客、测试、研发或产品运营角色。
- 服务端鉴权：前端通过 `X-Product-Line-Id` 请求头发送当前产品线，后端验证成员关系并使用该产品线下的角色执行鉴权。
- 数据隔离：dSYM、Crash 历史使用 `product_line_id` 隔离；Workflow 使用产品线配置的 `project_id` 隔离。

## 管理流程

1. 使用平台管理员登录。
2. 进入“角色权限管理 > 产品线”，填写产品线名称、可选 Bundle ID，以及该产品线使用的外部服务。稳定标识和 Workflow 项目标识由平台自动生成。
3. 在“用户角色”中编辑用户，选择其可访问的产品线，并逐条设置角色。
4. 用户登录后从顶部产品线选择器切换上下文；菜单、操作权限和数据随产品线同步切换。

注册申请也必须选择产品线。管理员审核通过后，账号只会获得申请产品线下的对应角色。

## Jenkins 服务

每条产品线可以配置独立的 Jenkins Base URL，例如 `https://jenkins-a.example.com` 或 `http://10.20.30.40:8080`。Jenkins 不需要和平台部署在同一台机器上，但该地址必须能从平台后端所在机器访问。

产品线显式填写的地址会按原域名/IP 使用，不会被替换成平台本机地址。默认 `nn` 产品线在未单独配置时继续回退到 `JENKINS_BASE_URL` 环境变量。

## 产品线级外部服务

管理员可在产品线配置页中选择左侧产品线，并在右侧按 tab 分别维护：

- Jenkins：服务地址、API 用户和 Token、构建 Job、自动质检 Job、iOS Git 仓库。
- 发布渠道：蒲公英 API Key、App Key、短链，以及 App Store Connect API Key、Issuer ID、`.p8` 私钥、App ID 和 TestFlight 测试组。
- 通知：企业微信机器人 Webhook。

除 `nn` 为兼容旧部署可回退历史环境变量外，新产品线未配置的专属服务会保持“未配置”，不会继承 `nn` 或平台进程里的 Jenkins、蒲公英、App Store Connect、TestFlight 和企业微信凭据。

Token、密码、私钥、API Key 和 Webhook 以 AES-256-GCM 加密保存。管理 API 只返回是否已配置，不返回敏感值明文；编辑时不填写会保留已有值，点击“清除”才会删除。

默认 `nn` 产品线会兼容读取现有 Jenkins 发布脚本中的蒲公英 API Key、短链和企业微信 Webhook，并识别 `APP_STORE_CONNECT_API_KEY_PATH` 指向的 `.p8` 私钥文件。敏感内容仍只显示“已配置”，不会回显明文。蒲公英采用短链查询时 App Key 为可选项。

Sentry 崩溃服务属于平台公共服务，所有产品线共用平台级 Sentry 地址、项目和登录配置，不在产品线配置页中重复维护。Sonic 真机与自动化测试也不作为产品线配置项展示。

## nn-ios-tools 接入

平台是 `podx.config.yml` 的配置中心。管理员在产品线配置页维护 Jenkins、podx 和 mgit 字段后，保存配置时会自动将当前产品线配置同步到对应主工程仓库根目录，不再提供单独下载配置文件的流程。`podx` tab 中的“重新同步到主工程”用于仓库凭据恢复、仓库首次 clone 后或配置修正后的手动重试。

同一个主工程只对应一个产品线，因此同步到主工程的 `podx.config.yml` 使用扁平单产品线结构，不写 `product_lines` 聚合配置。同步时平台会优先使用当前产品线的 iOS Git 仓库地址定位主工程；本地 Git 工作目录中已经存在仓库时直接写入，仓库不存在时会 clone 后写入。

工程侧目录通常是：

```text
ios-project/
  Podfile
  podx.config.yml
  Podfile.overlay
```

本地组件切换统一使用主工程根目录的 `Podfile.overlay`。overlay 文件只写需要切本地源码的组件名：

```ruby
pod 'NNRTCBase'
pod 'NNRTCCore'
```

`podx.config.yml` 只同步非敏感工程配置，例如 `product_line`、`target_name`、`private_source`、`git_base_url`、`overlay_file: Podfile.overlay`、`publish` 和 `jenkins` 的 job/repo 地址。Jenkins Token、蒲公英 API Key、App Store Connect 私钥和企业微信 Webhook 不会写入主工程，继续由平台后端加密保存或在 CI 中通过环境变量注入。

同步完成后，在工程根目录验证：

```bash
podx doctor
podx install --no-repo-update
mgit status
```

## API 约定

除认证和平台管理接口外，业务接口支持以下请求头：

```http
X-Product-Line-Id: <product-line-id>
```

普通用户请求未归属的产品线时返回 `403 PRODUCT_LINE_FORBIDDEN`。未登录用户只能进入默认 `nn` 的公开只读上下文，受保护操作仍要求实名登录。
