# Mobile DevOps AI

[English](README_EN.md) · [安装指南](docs/安装指南.md) · [参与贡献](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [安全自查](SECURITY_AUDIT.md) · [更新日志](CHANGELOG.md)

Mobile DevOps AI 是一个专为移动应用打造的全链路 AI 服务平台，旨在打通从研发、测试、发布到线上运维的完整闭环。平台核心能力涵盖 AI 辅助编码与智能代码审查、自动化测试与回归监测、多渠道灰度发布、线上崩溃归因与性能分析，以及依赖安全扫描。目前已落地 iOS 服务及 Android 应用隔离构建，支持无缝对接内部 CI/CD 与监控平台，通过 AI 提升移动端研发全生命周期的交付质量与效率。

核心能力：

- **研发提效**：AI 辅助编码、代码审查、智能补全
- **自动化测试**：智能用例生成、回归测试、性能监测
- **智能发布**：自动化打包、多渠道分发、灰度发布
- **线上追踪**：崩溃归因、性能监控、用户行为分析
- **包管理**：依赖管理、版本控制、安全扫描
- **服务打通**：无缝对接内部 CI/CD、监控、工单等平台

## 移动管理平台

面向多产品线的移动研发交付，连接代码与组件管理、Jenkins 构建、真机质检、Crash 与日志诊断、发布门禁和 AI 会话执行。当前已接入 iOS 服务，Android 首期应用隔离、APK 构建/Smoke 和内部分发适配已落地，真实产品待接入验收。

文档统一为[索引](docs/文档索引.md)、[安装](docs/安装指南.md)、[架构](docs/平台架构.md)、[功能](docs/平台功能.md)、[部署](docs/部署与运行.md)和[设计演进](docs/设计与演进.md)。质量中心的“交付诊断”可按源构建号查看证据缺口与下一步动作。

## 平台架构

平台由 React 工作台、一个 Node.js/Express 后端、SQLite/本地文件及外部执行系统组成。AI 和页面调用已有业务模块，交付证据汇总到 Workflow。

![移动管理平台整体架构](docs/diagrams/platform-overview.png)

[整体架构、部署拓扑与核心业务数据流](docs/平台架构.md) · [功能与操作说明](docs/平台功能.md)

## 快速开始

使用 Node.js 22，在根目录按锁文件安装依赖：

```bash
npm ci
```

按[部署与运行](docs/部署与运行.md)配置 `backend/.env` 中的数据路径和初始管理员，再启动：

```bash
npm run dev
```

默认前端 [localhost:5173](http://localhost:5173)，后端 [localhost:3000](http://localhost:3000)；实际后端端口以 `PORT` 为准。日常后台运行可使用 `./start-platform.sh start|status|restart|stop`。生产构建及反向代理要求统一见部署指南。

## 文档入口

- [文档索引](docs/文档索引.md)：文档与常用主题导航。
- [安装指南](docs/安装指南.md)：从源码安装、开发运行和发布前验证。
- [平台架构](docs/平台架构.md)：架构图、部署拓扑、数据流及实现边界。
- [平台功能](docs/平台功能.md)：应用服务、权限、Crash、组件、构建、质检、Android、Workflow 与 AI。
- [部署与运行](docs/部署与运行.md)：运行配置、启停备份、系统符号、真机和 Android Runner。
- [设计与演进](docs/设计与演进.md)：统一约束、回放交付验收和后续优先级。

## 研发检查

```bash
npm run check
npm run build
```

`check` 执行类型检查与测试；`build` 包含 Rust 水印解码器、后端和前端构建。Node 运行时与原生 SQLite 依赖由根脚本统一处理。

## 开源协作

提交 Issue 前请选择 Bug、Feature 或 Documentation 模板。代码变更通过 Pull Request 审查并通过自动检查后合并，具体要求见[贡献指南](CONTRIBUTING.md)。安全漏洞请按[安全策略](SECURITY.md)私密报告，不要提交公开 Issue。

## 权限与执行边界

应用服务开关、产品线成员关系、角色和动作权限分别校验。实名会话与旧密码认证兼容路径仍并存，详见[架构文档](docs/平台架构.md)和[产品线权限说明](docs/平台功能.md#permissions)。

AI 使用具名工具和参数白名单；普通执行需确认，高风险发布/停止需两级确认。页面聊天刷新后清空，工具审计和部分语义分析信息会持久化。构建提交成功、测试执行通过、发布完成和版本健康是不同阶段，应以对应证据确认。

## 许可证

[MIT License](LICENSE)
