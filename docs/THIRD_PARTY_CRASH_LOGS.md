# 处理第三方平台崩溃日志指南

## 问题说明

从第三方崩溃收集平台（如 Bugly、Firebase Crashlytics、Sentry 等）下载的崩溃日志通常不包含完整的 UUID 信息，这会导致系统无法自动匹配对应的 dSYM 文件。

## 解决方案

系统现在支持**手动选择 dSYM 文件**进行符号化。

### 使用步骤

#### 1. 上传 dSYM 文件

首先，确保已经上传了对应版本的 dSYM 文件：

1. 进入"上传 dSYM"页面
2. 上传对应应用版本的 dSYM 文件
3. 记录显示的应用名称和版本号

#### 2. 符号化崩溃日志

1. 进入"符号化"页面
2. 粘贴或上传第三方平台的崩溃日志
3. **重要**：在"手动选择 dSYM"下拉框中选择对应的 dSYM 文件
   - 可以通过应用名称、版本号或 UUID 搜索
   - 选择与崩溃日志版本匹配的 dSYM
4. 点击"开始符号化"

#### 3. 查看结果

系统会使用你选择的 dSYM 文件进行符号化，并显示结果。

## 如何确定正确的 dSYM 版本

### 方法 1: 通过应用版本号

1. 查看崩溃日志中的应用版本信息
2. 在下拉框中选择相同版本的 dSYM

### 方法 2: 通过构建号（Build Number）

1. 如果崩溃日志包含构建号，使用构建号匹配
2. 构建号通常比版本号更精确

### 方法 3: 通过时间

1. 查看崩溃发生的时间
2. 选择在该时间之前上传的最新 dSYM

## 常见第三方平台处理方法

### Bugly

Bugly 的崩溃日志格式：
```
Exception Type: SIGSEGV
Exception Codes: SEGV_ACCERR
Crashed Thread: 0

Thread 0 Crashed:
0   MyApp    0x0000000100001234 0x100000000 + 4660
1   MyApp    0x0000000100002345 0x100000000 + 9029
```

**处理方法：**
1. 从 Bugly 下载崩溃日志
2. 查看崩溃日志中的应用版本
3. 在系统中手动选择对应版本的 dSYM
4. 进行符号化

### Firebase Crashlytics

Firebase 的崩溃日志格式：
```
#0  MyApp                          0x100001234 specialized function + 52
#1  MyApp                          0x100002345 function + 123
```

**处理方法：**
1. 从 Firebase Console 导出崩溃日志
2. 确认应用版本和构建号
3. 手动选择匹配的 dSYM
4. 进行符号化

### Sentry

Sentry 通常会自动符号化，但如果需要本地处理：

**处理方法：**
1. 从 Sentry 下载原始崩溃日志
2. 根据 Release 版本选择 dSYM
3. 手动符号化

## 批量处理建议

如果需要处理大量第三方平台的崩溃日志：

### 方案 1: 建立版本映射表

创建一个映射表，记录：
- 应用版本号
- 构建号
- 对应的 UUID
- 发布时间

这样可以快速找到对应的 dSYM。

### 方案 2: 使用脚本

可以编写脚本批量调用 API：

```bash
#!/bin/bash

# 批量符号化脚本示例
UUID="your-dsym-uuid"

for crash_file in crashes/*.txt; do
  echo "Processing $crash_file..."
  
  curl -X POST http://localhost:3000/api/symbolicate \
    -H "Content-Type: application/json" \
    -d "{
      \"crashLog\": \"$(cat $crash_file | sed 's/"/\\"/g')\",
      \"uuid\": \"$UUID\"
    }" > "symbolicated_$(basename $crash_file)"
done
```

## 提取 UUID 的其他方法

如果第三方平台的崩溃日志中确实包含 UUID，但格式不同：

### 方法 1: 从二进制镜像信息中提取

某些平台会在日志末尾包含二进制镜像信息：
```
Binary Images:
0x100000000 - 0x100ffffff MyApp arm64 <126353d88a2235d18bf35143eaf68349>
```

可以手动复制 UUID 并粘贴到选择框中。

### 方法 2: 联系平台支持

某些平台可能提供 API 或工具来获取完整的崩溃信息，包括 UUID。

## 最佳实践

1. **保持 dSYM 文件的完整性**
   - 每次发布新版本时，立即上传对应的 dSYM
   - 使用清晰的命名规则（应用名_版本号_构建号）

2. **建立版本管理流程**
   - 记录每个版本的 UUID
   - 保存版本发布时间
   - 维护版本和 dSYM 的对应关系

3. **定期清理**
   - 删除过期版本的 dSYM（如 6 个月前的版本）
   - 保留重要版本的 dSYM

4. **测试验证**
   - 上传 dSYM 后，立即测试符号化功能
   - 确保符号化结果正确

## 故障排查

### 问题 1: 符号化后仍然是地址

**可能原因：**
- 选择的 dSYM 版本不匹配
- dSYM 文件损坏

**解决方法：**
- 确认应用版本和构建号完全匹配
- 重新导出并上传 dSYM

### 问题 2: 部分符号化成功，部分失败

**可能原因：**
- 崩溃涉及多个二进制文件（主应用 + 框架）
- 只上传了主应用的 dSYM

**解决方法：**
- 上传所有相关的 dSYM 文件
- 包括动态库和框架的 dSYM

### 问题 3: 找不到对应版本的 dSYM

**解决方法：**
- 从 Xcode Archive 中导出
- 从 App Store Connect 下载
- 从版本控制系统中重新构建

## 技术支持

如果遇到问题，可以：
1. 查看后端日志：`backend/logs/error.log`
2. 检查数据库：`sqlite3 backend/storage/database.sqlite`
3. 查看系统文档：`README.md` 和 `TESTING_GUIDE.md`
