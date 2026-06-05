# 升级到 Node.js 26 指南

## 当前状态

- **Node 版本**: 22.22.3
- **better-sqlite3**: 9.2.2
- **状态**: ✅ 稳定运行

## 为什么要升级到 Node 26？

Node 26 是最新版本，提供了：
- 更好的性能
- 新的 JavaScript 特性
- 更新的 V8 引擎

## 为什么暂时不推荐升级？

1. **Node 26 还不是 LTS 版本**（长期支持版本）
2. **生态系统兼容性问题** - 很多工具和库还没完全适配
3. **Node 22 是当前 LTS**，会持续维护到 2027 年

## 如果确实需要升级到 Node 26

### 步骤 1: 升级依赖

```bash
# 1. 升级 better-sqlite3（必须）
cd /Users/a1/工作/nn-ios-platform
npm install better-sqlite3@^12.10.0 --workspace=backend

# 2. 升级类型定义（可选但推荐）
npm install @types/better-sqlite3@^7.6.12 --workspace=backend --save-dev

# 3. 升级其他可能不兼容的依赖
npm update --workspace=backend
npm update --workspace=frontend
```

### 步骤 2: 升级 Node.js

```bash
# 卸载 node@22
brew unlink node@22

# 安装 node 26（已安装）
brew link node --force

# 更新 shell 配置
sed -i '' 's|/opt/homebrew/opt/node@22/bin|/opt/homebrew/opt/node/bin|g' ~/.zshrc
source ~/.zshrc

# 验证版本
node --version  # 应该输出 v26.0.0
```

### 步骤 3: 重新编译原生模块

```bash
cd /Users/a1/工作/nn-ios-platform
npm rebuild
```

### 步骤 4: 测试

```bash
# 启动后端
cd backend
npm run dev

# 在另一个终端启动前端
cd frontend
npm run dev -- --port 5173

# 测试主要功能：
# - 符号化上传
# - Pod 管理
# - 历史记录查询
# - AI 分析
```

### 步骤 5: 回滚方案（如果出问题）

```bash
# 回到 Node 22
brew unlink node
brew link node@22 --force --overwrite

# 恢复 better-sqlite3 版本
cd /Users/a1/工作/nn-ios-platform
npm install better-sqlite3@^9.2.2 --workspace=backend
npm rebuild

# 更新 shell 配置
sed -i '' 's|/opt/homebrew/opt/node/bin|/opt/homebrew/opt/node@22/bin|g' ~/.zshrc
source ~/.zshrc
```

## better-sqlite3 版本变化（9.x → 12.x）

### 主要变化

查看官方 changelog: https://github.com/WiseLibs/better-sqlite3/releases

可能的破坏性变化：
1. API 签名可能有轻微调整
2. 性能优化和内部实现变化
3. 错误处理方式可能不同

### 测试重点

升级后需要重点测试：
- 数据库连接和初始化
- 所有增删改查操作
- 事务处理
- 并发操作
- 错误处理

## 推荐方案

**保持当前 Node 22.x**，理由：

1. ✅ Node 22 是 LTS，支持到 2027 年 4 月
2. ✅ 生态系统完全兼容
3. ✅ 项目当前稳定运行
4. ✅ 没有紧迫的升级需求

**等待以下条件满足后再升级：**

1. Node 26 发布 LTS 版本
2. 项目依赖的所有库都明确支持 Node 26
3. 社区验证稳定性
4. 有明确的业务需求或性能提升

## 总结

| 项目 | Node 22 | Node 26 |
|------|---------|---------|
| 稳定性 | ✅ LTS | ⚠️ 最新版 |
| 兼容性 | ✅ 完全兼容 | ⚠️ 需升级依赖 |
| 支持周期 | ✅ 到 2027/04 | ❓ 待定 |
| 性能 | ✅ 优秀 | ✅ 更好 |
| 推荐度 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |

**建议：保持 Node 22，等 Node 26 LTS 后再升级。**
