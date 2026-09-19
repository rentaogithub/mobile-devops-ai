# v0.1.0 安全与合规自查

自查日期：2026-09-19

本记录覆盖 `v0.1.0` 发布候选版本的开源合规、依赖风险、历史密钥和基础质量门禁。所有结论均基于仓库提交内容，不包含部署环境中的第三方凭据、网络边界或真机资产。

## 结论

| 检查项 | 结果 | 证据或处置 |
| --- | --- | --- |
| 开源许可证 | 通过 | 仓库根目录提供 SPDX 可识别的 MIT `LICENSE` |
| Node.js 生产依赖 | 通过 | `npm audit --omit=dev --audit-level=high`：0 个漏洞 |
| Node.js 全部依赖 | 通过 | `npm audit --audit-level=high`：0 个漏洞 |
| Git 历史密钥 | 通过 | Gitleaks 8.30.1 扫描 243 个提交及当前工作树，未发现未处置泄露 |
| Rust 依赖 | CI 门禁 | `rustsec/audit-check` 对水印解码器的 `Cargo.lock` 执行审计 |
| 静态安全分析 | CI 门禁 | CodeQL 分析 JavaScript/TypeScript，PR 同时执行依赖变更审查 |
| 类型检查与测试 | 通过 | Node.js 22；前端 19 项、后端 267 项测试全部通过 |
| 前端生产构建 | 通过 | Vite 8 生产构建成功；保留大分块优化警告作为后续性能改进项 |

## 本次处置

- 提交根级 `package-lock.json`，CI 和本地统一使用 `npm ci`。
- 升级 `adm-zip`、`tar`、`react-router-dom` 和 `vitest` 至修复版本，并移除前端与后端未使用的归档、Vite 测试依赖。
- 将测试中的生产形态 App Store Connect 标识替换为明确的测试夹具。历史扫描命中的旧测试标识不包含私钥，私钥由测试运行时即时生成；其精确历史指纹记录在 `.gitleaksignore`，不使用宽泛路径或规则豁免。
- 增加每次推送、PR 和每周定时执行的 npm audit、RustSec、Gitleaks、CodeQL 与依赖审查。
- 建立私密漏洞报告入口、Issue/PR 模板、CODEOWNERS 和贡献审查规范。

## 发布门禁

发布标签只能在 GitHub 的 `CI` 与 `Security` 工作流成功后创建。任何真实凭据泄露都必须先吊销或轮换，再删除当前树中的内容；是否重写公开历史需单独评估对现有克隆和分支的影响。

## 已知边界

- iOS 真机、证书、Jenkins、Android Runner 和外部监控平台需要对应环境才能做端到端验证，本次自查不声明这些外部系统已通过验收。
- 本地环境未安装 Rust 工具链，Rust 依赖审计由 GitHub Actions 的独立 RustSec 门禁执行。
- 审计结果是发布时点快照；依赖和代码仍需持续扫描。
