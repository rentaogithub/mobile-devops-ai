# iOS 多产品线与权限隔离

平台以“产品线”作为权限和研发数据的租户边界。升级后会自动创建默认产品线 `nn`，并把已有非管理员账号按原角色迁移到该产品线；已有 dSYM、Crash 历史和 Workflow 数据继续归属 `nn`。

## 权限模型

- 平台管理员：管理产品线、账号和各产品线成员，能够访问所有产品线。
- 普通账号：可以加入一条或多条产品线，并在每条产品线分别拥有游客、测试、研发或产品运营角色。
- 服务端鉴权：前端通过 `X-Product-Line-Id` 请求头发送当前产品线，后端验证成员关系并使用该产品线下的角色执行鉴权。
- 数据隔离：dSYM、Crash 历史使用 `product_line_id` 隔离；Workflow 使用产品线配置的 `project_id` 隔离。

## 新产品线接入步骤

1. 准备接入资料：
   - 基础信息：产品线标识、产品线名称、Workflow 项目标识和可选 Bundle ID。
   - Git 信息：iOS 主仓库、私有 Specs 源、组件仓库列表和发布基准分支。
   - CI 信息：Jenkins 服务地址、API 用户/Token、构建 Job 和自动质检 Job。
   - 组件服务：Git 账号、Nexus、NNRtc Jenkins。
   - 可选服务：蒲公英、App Store Connect、Sentry、企业微信机器人和企业微信自建应用。
2. 使用平台管理员登录，进入“配置管理 > 产品线 > 新增”。
3. 在“基础信息”中填写产品线标识、名称和 Workflow 项目标识；Bundle ID 按需填写。产品线标识创建后不可修改，Workflow 项目标识用于隔离任务、问题和质量门禁数据。
4. 在“Jenkins”中填写服务地址、API 用户与 Token、构建 Job、自动质检 Job和 iOS 主仓库地址。不启用 CI/CD 时可以暂不配置。
5. 在“podx / mgit”中填写私有 Specs 源、发布主仓库和发布基准分支，并添加该产品线的全部组件仓库。Target Name、Git 基础地址和发布工作目录由平台根据仓库地址推导，不需要在页面填写。保存后平台自动把 `podx.config.yml` 同步到主工程根目录。
6. 进入新产品线的主工程根目录，首次执行 `podx --create-overlay-file`，生成与 `Podfile` 同级的 `Podfile.overlay` 模板并加入 Xcode 工程引用。空 overlay 表示全部组件使用远端依赖。
7. 在“组件服务”中配置访问组件仓库所需的 Git 用户名及密码/Access Token、Nexus 地址及账号；使用独立 NNRtc 构建任务时，再填写该产品线的 NNRtc Jenkins 地址、Job、用户和 Token。
8. 按需配置发布渠道：
   - 蒲公英：填写 API Key 和应用短链。
   - App Store：填写 Issuer ID、上传未改名的 Apple 原始 `.p8` 私钥、填写数字 App ID；保存后从 Apple API 获取并勾选 TestFlight 自动分发测试组。
   - 业务感知质检：使用 Monkey 或业务编排前，在 `config/product-lines/<产品线 ID>/business-map.json` 准备该 App 的业务地图；可选在同目录增加 `business-flow-presets.json`。默认 `nn` 产品线继续使用 `config/nnios-business-map.json` 和 `config/nnios-business-flow-presets.json`。
9. 在“Sentry”中填写该产品线的服务地址、Organization、Project；需要平台代登录时再开启自动登录并填写账号密码。
10. 按需在“通知”中填写该产品线的企业微信机器人 Webhook，仅用于 CI/CD 发布通知；需要手动分享崩溃报告时，再填写企业微信自建应用的 Corp ID、Agent ID 和 Secret。
11. 进入“用户角色”，为用户添加新产品线，并设置该产品线下的游客、测试、研发或产品运营角色。
12. 在页面顶部切换到新产品线，确认菜单、权限和业务数据已切换到对应上下文。
13. 进入新产品线主工程根目录执行：

   ```bash
   podx doctor
   podx install --no-repo-update
   mgit status
   ```

   确认 `podx.config.yml` 可读取、私有 Specs 源可访问、主仓库与组件仓库均能识别后，接入完成。

注册申请也必须选择产品线。管理员审核通过后，账号只会获得申请产品线下的对应角色。

## Jenkins 服务

每条产品线可以配置独立的 Jenkins Base URL，例如 `https://jenkins-a.example.com` 或 `http://10.20.30.40:8080`。Jenkins 不需要和平台部署在同一台机器上，但该地址必须能从平台后端所在机器访问。

产品线显式填写的地址会按原域名/IP 使用，不会被替换成平台本机地址。默认 `nn` 产品线在未单独配置时继续回退到 `JENKINS_BASE_URL` 环境变量。

## 产品线级外部服务

管理员可在产品线配置页中选择左侧产品线，并在右侧按 tab 分别维护：

- Jenkins：服务地址、API 用户和 Token、构建 Job、自动质检 Job、iOS Git 仓库。
- podx / mgit：私有 Specs 源、发布主仓库、组件仓库和发布基线分支；两套工具共用同一份 `podx.config.yml`。Target Name、Git 基础地址和发布工作目录仅由系统推导，不在页面展示。
- 组件服务：Git 用户名及密码/Access Token、Nexus 地址及账号、NNRtc Jenkins 地址及账号。
- 蒲公英：API Key 和应用短链。
- App Store：Issuer ID、Apple 原始 `.p8` 私钥和数字 App ID。Key ID 从原始私钥文件名自动识别；TestFlight 测试组通过 Apple API 获取并支持多选。
- Sentry：服务地址、Organization、Project 和可选自动登录账号。
- 通知：仅用于 CI/CD 发布通知的企业微信机器人 Webhook；用于手动分享崩溃报告的企业微信自建应用 Corp ID、Agent ID 和 Secret。

除 `nn` 为兼容旧部署可回退历史环境变量外，新产品线未配置的专属服务会保持“未配置”，不会继承 `nn` 或平台进程里的 Jenkins、蒲公英、App Store Connect、TestFlight 和企业微信凭据。

Token、密码、私钥、API Key 和 Webhook 以 AES-256-GCM 加密保存。App Store Connect 私钥不会通过管理 API 返回正文；其他可编辑凭据仅对管理员配置页返回。直接保存会保留当前私钥，明确执行“清除私钥”才会删除。

默认 `nn` 产品线会兼容读取现有 Jenkins 发布脚本中的蒲公英 API Key、短链和企业微信 Webhook，并识别 `APP_STORE_CONNECT_API_KEY_PATH` 指向的 Apple 原始 `.p8` 私钥文件。新上传的私钥必须保持 `AuthKey_<Key ID>.p8` 原始文件名，平台会自动识别 Key ID 并将正文写入当前产品线的数据库加密配置。

## 隔离范围与平台共享边界

以下业务数据和外部服务按产品线隔离：

- Jenkins 构建、自动质检、发布同步状态、业务地图和构建缓存。
- Git 主仓库、组件仓库、工作目录和访问凭据。
- Pods、私有 Specs、Nexus、NNRtc Jenkins 和 `podx.config.yml`。
- Apple Developer 设备与注册申请、App Store Connect 私钥、TestFlight 测试组和发布账号。
- Sentry 服务、组织、项目、登录 Cookie、Crash 治理、dSYM、符号化历史和缓存。
- API 请求样本、无效 Token、API 文档查看记录和用户查询记录。
- 真机录制、回放、组合回放、Workflow、AI 助手审计、附件和待审批操作。
- 企业微信机器人与自建应用账号。

以下能力属于平台共享基础设施：

- Sonic/WDA 物理设备基础设施和设备池配置。设备本身共享，但质检任务、运行状态和业务结果仍归属发起产品线。
- API 文档定义和 OP 上游登录会话。App 路由索引从当前产品线主仓库构建；文档查看记录、请求样本及无效 Token 仍按产品线隔离。
- 平台访问统计，用于统计整个服务的访问情况，不代表当前所选产品线的数据量。
- SQLite 数据库备份、WAL checkpoint、整个平台存储用量和临时上传文件清理。
- iOS 系统符号、水印解码工具和平台级 AI Key。

共享基础设施的查看、备份、压缩和手动清理入口只允许平台管理员操作。共享操作不得绕过产品线条件读取、修改或删除某条产品线的业务数据；Workflow 保留策略和 Payload 压缩仅处理当前产品线。

## podx / mgit 多产品线接入

平台是 `podx.config.yml` 的配置中心。管理员在产品线配置页维护 Jenkins、podx 和 mgit 字段后，保存配置时会自动将当前产品线配置同步到对应主工程仓库根目录，不再提供单独下载配置文件的流程。“podx / mgit”页中的“重新同步到主工程”用于仓库凭据恢复、仓库首次 clone 后或配置修正后的手动重试。

同一个主工程只对应一个产品线，因此同步到主工程的 `podx.config.yml` 使用扁平单产品线结构，不写 `product_lines` 聚合配置。同步时平台会优先使用当前产品线的 iOS Git 仓库地址定位主工程；本地 Git 工作目录中已经存在仓库时直接写入，仓库不存在时会 clone 后写入。

podx 与 mgit 在所有产品线中使用相同命令，不需要为不同产品线重复安装，也不需要在命令中手动传入产品线。开发者只需进入目标主工程目录，工具会读取该工程根目录的 `podx.config.yml`，并使用其中的产品线标识、Specs 源、主仓库和组件仓库配置。

工程侧目录通常是：

```text
ios-project/
  Podfile
  podx.config.yml
  Podfile.overlay
```

### Podfile.overlay 首次创建

`Podfile.overlay` 是开发者本地的组件依赖切换文件，不由平台同步。新产品线主工程首次接入时，在主工程根目录执行：

```bash
podx --create-overlay-file
```

该命令会创建与 `Podfile` 同级的 `Podfile.overlay` 模板，并尝试自动加入 Xcode 工程引用。空 overlay 是正常状态，表示所有私有组件均使用远端依赖。`Podfile.overlay` 属于本地开发配置，应纳入 `.gitignore`，避免将个人的本地组件状态提交到主仓库。

### Podfile.overlay 日常使用

推荐使用 podx 命令维护 overlay，不需要手工编辑本地路径或分支：

```bash
# 将指定组件切到本地源码
podx NNBussCom

# 查看所有组件的 local / remote 状态
podx list

# 切换后更新工程依赖
podx install

# 打开 overlay 查看当前内容
podx open --overlay
```

overlay 文件只写需要切到本地源码的组件名：

```ruby
pod 'NNRTCBase'
pod 'NNRTCCore'
```

不要在 overlay 中填写 `localWork`、`branch`、`:path` 或其他参数。未出现在 overlay 中的组件默认使用远端依赖。组件必须已在主 `Podfile` 中声明，并已加入当前产品线的“组件仓库”列表，podx 才能正确识别和准备对应本地仓库。

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
