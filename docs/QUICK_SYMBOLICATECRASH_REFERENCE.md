# symbolicatecrash 快速参考

## 一分钟快速开始

### 检查工具是否可用
```bash
./scripts/check-symbolicatecrash.sh
```

### 在系统中使用（推荐）
1. 上传 .ips 文件
2. 选择 dSYM
3. 点击符号化
4. ✅ 系统自动使用 symbolicatecrash

### 命令行手动使用
```bash
# 测试符号化
./scripts/test-symbolicatecrash.sh crash.ips MyApp.app.dSYM

# 直接使用工具
symbolicatecrash crash.ips MyApp.app.dSYM > symbolicated.crash
```

## 核心特性

| 特性 | 说明 |
|------|------|
| 🎯 自动检测 | 检测到 .ips 格式自动使用 |
| 🔄 智能回退 | 失败时自动使用 atos 方法 |
| 📝 完整输出 | 包含所有线程和系统库 |
| ⚡ 快速处理 | 2-30 秒（取决于文件大小） |
| 🛡️ 错误处理 | 完整的异常处理和日志 |

## 命令格式

```bash
symbolicatecrash <crash.ips> <YourApp.app.dSYM> > <output.crash>
```

## 工作流程

```
.ips 文件 → 检测格式 → 使用 symbolicatecrash → 验证输出 → 返回结果
                              ↓ 失败
                         回退到 atos → 返回结果
```

## 系统要求

✅ macOS  
✅ Xcode  
✅ xcode-select 配置

## 验证安装

```bash
# 检查 Xcode
xcodebuild -version

# 检查工具
./scripts/check-symbolicatecrash.sh

# 测试符号化
./scripts/test-symbolicatecrash.sh your.ips your.dSYM
```

## 常见问题速查

| 问题 | 解决方案 |
|------|---------|
| 找不到工具 | `xcode-select --install` |
| 符号化失败 | 检查 UUID 是否匹配 |
| 输出为空 | 验证 dSYM 文件正确性 |
| 自动回退 | 正常行为，不影响使用 |

## 日志关键词

```
✅ 成功: "symbolicatecrash 符号化成功"
⚠️  回退: "回退到 atos 方法"
❌ 失败: "symbolicatecrash 执行失败"
```

## 文件位置

```
文档:
  - SYMBOLICATECRASH_INTEGRATION.md (详细文档)
  - SYMBOLICATECRASH_USAGE_GUIDE.md (使用指南)
  - SYMBOLICATECRASH_SUMMARY.md (总结)

脚本:
  - scripts/check-symbolicatecrash.sh (检查工具)
  - scripts/test-symbolicatecrash.sh (测试符号化)

代码:
  - backend/src/services/SymbolizerService.ts (实现)
```

## 性能参考

| 文件大小 | 处理时间 |
|---------|---------|
| < 100KB | 2-5 秒 |
| 100KB-1MB | 5-15 秒 |
| > 1MB | 15-30 秒 |

## 快速调试

```bash
# 1. 检查环境
./scripts/check-symbolicatecrash.sh

# 2. 验证文件
ls -lh crash.ips MyApp.app.dSYM

# 3. 测试符号化
./scripts/test-symbolicatecrash.sh crash.ips MyApp.app.dSYM

# 4. 查看结果
cat crash_symbolicated.crash
```

## 最佳实践

✅ 使用最新版 Xcode  
✅ 确保 UUID 匹配  
✅ 验证 dSYM 完整性  
✅ 查看符号化日志  
✅ 利用缓存机制

## 支持

遇到问题？查看详细文档：
- [集成文档](./SYMBOLICATECRASH_INTEGRATION.md)
- [使用指南](./SYMBOLICATECRASH_USAGE_GUIDE.md)
- [总结文档](./SYMBOLICATECRASH_SUMMARY.md)
