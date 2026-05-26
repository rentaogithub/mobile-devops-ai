# 需求文档

## 简介

iOS 崩溃日志符号化系统是一个 Web 应用，用于将 iOS 应用的崩溃日志中的内存地址转换为可读的函数名、文件名和行号。该系统支持上传 dSYM 文件，解析多种格式的崩溃日志，并提供 dSYM 文件管理功能。

## 术语表

- **System**: iOS 崩溃日志符号化系统
- **dSYM**: Debug Symbol 文件，包含应用的调试符号信息
- **UUID**: 唯一标识符，用于匹配 dSYM 文件和崩溃日志
- **Crash Log**: 崩溃日志，包含应用崩溃时的堆栈信息
- **Symbolication**: 符号化过程，将内存地址转换为可读的符号信息
- **User**: 使用该系统的开发者或测试人员

## 需求

### 需求 1

**用户故事:** 作为开发者，我希望能够上传 dSYM 文件，以便系统可以使用它来符号化崩溃日志

#### 验收标准

1. THE System SHALL 接受 .dSYM 目录格式的文件上传
2. THE System SHALL 接受 .xcarchive 格式的文件上传
3. THE System SHALL 接受 .zip 压缩包格式的文件上传
4. WHEN User 上传 dSYM 文件时，THE System SHALL 提取并存储文件的 UUID 信息
5. WHEN User 上传 dSYM 文件时，THE System SHALL 验证文件格式的有效性

### 需求 2

**用户故事:** 作为开发者，我希望能够提交崩溃日志，以便系统可以解析并符号化堆栈信息

#### 验收标准

1. THE System SHALL 接受通过文本粘贴方式提交的崩溃日志
2. THE System SHALL 接受通过文件上传方式提交的崩溃日志
3. THE System SHALL 支持 Apple Crash Report 格式的崩溃日志
4. THE System SHALL 支持 .ips 文件格式的崩溃日志
5. WHEN User 提交崩溃日志时，THE System SHALL 从日志中提取 UUID 信息

### 需求 3

**用户故事:** 作为开发者，我希望系统能够自动匹配 dSYM 文件和崩溃日志，以便快速完成符号化

#### 验收标准

1. WHEN System 接收到崩溃日志时，THE System SHALL 根据 UUID 查找匹配的 dSYM 文件
2. IF 找到匹配的 dSYM 文件，THEN THE System SHALL 自动执行符号化过程
3. IF 未找到匹配的 dSYM 文件，THEN THE System SHALL 向 User 显示错误消息
4. THE System SHALL 在 5 秒内完成 UUID 匹配过程

### 需求 4

**用户故事:** 作为开发者，我希望看到符号化后的崩溃日志，以便快速定位问题

#### 验收标准

1. WHEN 符号化完成时，THE System SHALL 显示包含函数名的堆栈信息
2. WHEN 符号化完成时，THE System SHALL 显示包含文件名的堆栈信息
3. WHEN 符号化完成时，THE System SHALL 显示包含行号的堆栈信息
4. THE System SHALL 保留原始崩溃日志的格式结构
5. THE System SHALL 高亮显示已符号化的堆栈行

### 需求 5

**用户故事:** 作为开发者，我希望能够管理已上传的 dSYM 文件，以便维护和查询符号文件

#### 验收标准

1. THE System SHALL 显示所有已上传 dSYM 文件的列表
2. THE System SHALL 在列表中显示每个 dSYM 文件的 UUID 信息
3. THE System SHALL 在列表中显示每个 dSYM 文件的上传时间
4. THE System SHALL 在列表中显示每个 dSYM 文件的应用名称和版本
5. THE System SHALL 允许 User 删除已上传的 dSYM 文件

### 需求 6

**用户故事:** 作为开发者，我希望系统能够处理符号化错误，以便了解失败原因

#### 验收标准

1. IF 符号化工具执行失败，THEN THE System SHALL 向 User 显示错误消息
2. IF dSYM 文件损坏，THEN THE System SHALL 向 User 显示文件无效的提示
3. IF 崩溃日志格式无法识别，THEN THE System SHALL 向 User 显示格式不支持的提示
4. WHEN 发生错误时，THE System SHALL 记录错误详情到日志文件

### 需求 7

**用户故事:** 作为开发者，我希望能够下载符号化后的崩溃日志，以便分享或存档

#### 验收标准

1. WHEN 符号化完成时，THE System SHALL 提供下载按钮
2. WHEN User 点击下载按钮时，THE System SHALL 生成文本格式的符号化日志文件
3. THE System SHALL 在下载文件名中包含时间戳信息

### 需求 8

**用户故事:** 作为开发者，我希望系统能够使用通义千问 AI 智能分析符号化后的崩溃日志，以便快速理解崩溃原因和获取修复建议

#### 验收标准

1. THE System SHALL 集成通义千问 API 服务进行崩溃日志分析
2. WHEN User 在符号化页面输入 API Key 时，THE System SHALL 验证 API Key 的有效性
3. WHEN 符号化完成且 User 提供了有效的 API Key 时，THE System SHALL 自动调用通义千问 API 分析符号化后的日志
4. THE System SHALL 在分析结果中显示崩溃类型识别
5. THE System SHALL 在分析结果中显示可能的崩溃原因列表
6. THE System SHALL 在分析结果中显示修复建议列表
7. THE System SHALL 在分析结果中显示严重程度评估
8. THE System SHALL 在分析结果中显示受影响的组件识别
9. THE System SHALL 在分析结果中显示 AI 生成的总结说明
10. THE System SHALL 仅在当前会话中保存 API Key，不进行持久化存储
11. THE System SHALL 仅显示当前符号化日志的分析结果，不保存历史分析记录
12. IF AI 分析失败，THEN THE System SHALL 显示错误提示但不影响符号化结果的展示
13. THE System SHALL 在 30 秒内完成 AI 分析或超时提示
