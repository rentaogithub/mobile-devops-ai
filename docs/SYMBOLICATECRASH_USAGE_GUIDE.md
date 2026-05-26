# symbolicatecrash 使用指南

## 快速开始

### 1. 验证工具可用性

运行检查脚本：
```bash
./scripts/check-symbolicatecrash.sh
```

预期输出：
```
✅ symbolicatecrash 工具可用
找到工具: /Applications/Xcode.app/Contents/SharedFrameworks/DVTFoundation.framework/Versions/A/Resources/symbolicatecrash
```

### 2. 在系统中使用

系统已经自动集成了 symbolicatecrash 工具，无需手动配置。

#### 自动符号化流程

1. **上传 .ips 文件**
   - 在符号化页面点击"上传崩溃日志"
   - 选择 .ips 格式的文件

2. **选择 dSYM**
   - 系统会自动检测可用的 dSYM 文件
   - 选择与崩溃日志匹配的版本

3. **开始符号化**
   - 点击"开始符号化"按钮
   - 系统会自动：
     - 检测文件格式为 .ips
     - 尝试使用 symbolicatecrash 工具
     - 如果成功，返回完整符号化结果
     - 如果失败，自动回退到 atos 方法

### 3. 手动命令行使用

如果需要在命令行手动符号化：

```bash
# 基本用法
symbolicatecrash your_crash.ips YourApp.app.dSYM > symbolicated.crash

# 完整示例
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
/Applications/Xcode.app/Contents/SharedFrameworks/DVTFoundation.framework/Versions/A/Resources/symbolicatecrash \
  crash.ips \
  MyApp.app.dSYM \
  > symbolicated.crash
```

## 工作原理

### 系统集成流程

```
用户上传 .ips 文件
    ↓
系统检测文件格式
    ↓
format === 'ips' ?
    ↓ 是
尝试使用 symbolicatecrash
    ↓
查找工具路径
    ↓
创建临时文件
    ↓
执行命令: symbolicatecrash crash.ips YourApp.app.dSYM
    ↓
验证输出是否包含符号
    ↓
成功? → 返回符号化结果
    ↓ 失败
回退到 atos 方法
    ↓
返回符号化结果
```

### 代码实现

在 `SymbolizerService.ts` 中：

```typescript
// 检测 .ips 格式
if (parsed.format === 'ips') {
  logger.info('检测到 .ips 格式，尝试使用 symbolicatecrash 工具');
  
  try {
    const result = await this.symbolicateWithSymbolicatecrash(crashLog, dsymPath);
    if (result) {
      logger.info('使用 symbolicatecrash 符号化成功');
      return { symbolicatedLog: result };
    }
  } catch (error: any) {
    logger.warn('symbolicatecrash 符号化失败，回退到 atos 方法', { 
      error: error.message 
    });
    // 继续使用 atos 方法
  }
}
```

## 符号化结果对比

### 使用 symbolicatecrash（推荐用于 .ips）

**输入**: crash.ips
```json
{
  "threads": [{
    "frames": [{
      "imageOffset": 823300,
      "imageIndex": 0
    }]
  }]
}
```

**输出**: 完整符号化的崩溃日志
```
Thread 0 Crashed:
0   MyApp    0x0000000100c8b004 -[ViewController viewDidLoad] + 52 (ViewController.swift:42)
1   MyApp    0x0000000100c8b100 -[AppDelegate application:didFinishLaunchingWithOptions:] + 256 (AppDelegate.swift:15)
2   UIKitCore 0x00000001a2345678 -[UIApplication _run] + 1234
...
```

### 使用 atos（传统方法）

**输入**: 需要手动提取地址
```
0x0000000100c8b004
0x0000000100c8b100
```

**输出**: 仅符号信息
```
-[ViewController viewDidLoad] (in MyApp) (ViewController.swift:42)
-[AppDelegate application:didFinishLaunchingWithOptions:] (in MyApp) (AppDelegate.swift:15)
```

## 优势

### 1. 完整性
- ✅ 符号化所有线程
- ✅ 保留崩溃上下文
- ✅ 包含系统库信息
- ✅ 保持原始格式

### 2. 准确性
- ✅ Apple 官方工具
- ✅ 专为 .ips 设计
- ✅ 处理复杂场景
- ✅ 支持最新格式

### 3. 易用性
- ✅ 一条命令完成
- ✅ 自动处理细节
- ✅ 无需手动解析
- ✅ 系统自动集成

## 常见场景

### 场景1: 标准 .ips 文件符号化

**步骤**:
1. 从 Xcode Organizer 导出 .ips 文件
2. 上传到符号化页面
3. 选择对应的 dSYM
4. 点击符号化

**结果**: 
- 使用 symbolicatecrash
- 完整的符号化输出
- 包含源文件和行号

### 场景2: UUID 不匹配

**情况**: dSYM 的 UUID 与崩溃日志不匹配

**系统行为**:
1. symbolicatecrash 可能失败
2. 自动回退到 atos 方法
3. 显示警告信息
4. 仍然尝试符号化

**建议**: 上传正确版本的 dSYM

### 场景3: 工具不可用

**情况**: 在非 macOS 系统或没有 Xcode

**系统行为**:
1. 查找工具失败
2. 记录警告日志
3. 直接使用 atos 方法
4. 正常完成符号化

**影响**: 功能正常，但可能不如 symbolicatecrash 完整

### 场景4: 多个 dSYM 文件

**情况**: 应用包含多个框架

**系统行为**:
1. 依次使用每个 dSYM
2. 对于 .ips 文件，每个都尝试 symbolicatecrash
3. 合并所有符号化结果
4. 返回完整的符号化日志

## 性能考虑

### 处理时间

| 文件大小 | symbolicatecrash | atos |
|---------|------------------|------|
| < 100KB | 2-5 秒 | 1-2 秒 |
| 100KB - 1MB | 5-15 秒 | 2-5 秒 |
| > 1MB | 15-30 秒 | 5-10 秒 |

### 优化建议

1. **使用缓存**
   - 系统会缓存符号化结果
   - 相同的崩溃日志不会重复处理

2. **并行处理**
   - 多个 dSYM 可以并行符号化
   - 提高整体处理速度

3. **超时设置**
   - 默认 30 秒超时
   - 防止长时间阻塞

## 故障排除

### 问题1: 找不到工具

**错误**: "未找到 symbolicatecrash 工具"

**检查**:
```bash
./scripts/check-symbolicatecrash.sh
```

**解决**:
```bash
# 安装 Xcode 命令行工具
xcode-select --install

# 设置 Xcode 路径
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

### 问题2: 符号化失败

**错误**: "symbolicatecrash 执行失败"

**可能原因**:
- dSYM 文件损坏
- .ips 文件格式错误
- 权限问题

**解决**:
1. 验证文件完整性
2. 检查文件权限
3. 查看详细日志

### 问题3: 输出为空

**错误**: "symbolicatecrash 输出为空"

**可能原因**:
- UUID 不匹配
- dSYM 文件不正确
- 环境变量未设置

**解决**:
1. 验证 UUID 匹配
2. 确认 DEVELOPER_DIR 设置
3. 使用正确的 dSYM 文件

### 问题4: 自动回退

**现象**: 日志显示"回退到 atos 方法"

**说明**: 这是正常行为，不是错误

**原因**:
- symbolicatecrash 不可用
- 执行失败或超时
- 输出验证失败

**结果**: 使用 atos 继续符号化

## 最佳实践

### 1. 环境准备
- ✅ 安装最新版 Xcode
- ✅ 配置 xcode-select
- ✅ 运行检查脚本验证

### 2. 文件管理
- ✅ 保持 dSYM 文件完整
- ✅ 使用正确的版本
- ✅ 验证 UUID 匹配

### 3. 监控和日志
- ✅ 查看符号化日志
- ✅ 监控成功率
- ✅ 记录失败原因

### 4. 性能优化
- ✅ 利用缓存机制
- ✅ 合理设置超时
- ✅ 清理临时文件

## 测试验证

### 测试1: 基本功能

```bash
# 1. 准备测试文件
# 获取一个 .ips 文件和对应的 dSYM

# 2. 上传到系统
# 在 Web 界面上传文件

# 3. 检查日志
# 查看是否使用了 symbolicatecrash

# 4. 验证结果
# 检查符号化输出是否包含源文件位置
```

### 测试2: 回退机制

```bash
# 1. 临时重命名 Xcode
sudo mv /Applications/Xcode.app /Applications/Xcode.app.bak

# 2. 尝试符号化
# 应该自动回退到 atos

# 3. 恢复 Xcode
sudo mv /Applications/Xcode.app.bak /Applications/Xcode.app
```

### 测试3: 性能测试

```bash
# 测试不同大小的文件
# 记录处理时间
# 对比 symbolicatecrash 和 atos 的性能
```

## 相关资源

### 文档
- `SYMBOLICATECRASH_INTEGRATION.md` - 集成文档
- `IPS_FILE_PARSING_FIX.md` - .ips 文件处理
- `TESTING_GUIDE.md` - 测试指南

### 脚本
- `scripts/check-symbolicatecrash.sh` - 工具检查脚本

### 代码
- `backend/src/services/SymbolizerService.ts` - 符号化服务
- `backend/src/services/CrashLogParser.ts` - 日志解析

## 总结

symbolicatecrash 工具的集成为 .ips 文件提供了最佳的符号化体验：

- ✅ **自动化**: 无需手动配置，系统自动处理
- ✅ **智能化**: 自动检测格式，选择最佳工具
- ✅ **可靠性**: 失败自动回退，确保功能可用
- ✅ **完整性**: 提供完整的符号化结果
- ✅ **易用性**: 用户无感知，一键完成

现在你可以直接上传 .ips 文件，系统会自动使用 symbolicatecrash 工具进行符号化！
