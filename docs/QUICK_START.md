# 快速开始指南

## 系统已启动 ✅

- **前端**: http://localhost:5173
- **后端**: http://localhost:3000

## 处理第三方平台崩溃日志（无 UUID）

### 快速步骤

1. **上传 dSYM**
   - 访问 http://localhost:5173/upload
   - 上传你的 dSYM 文件
   - 记录应用名称和版本

2. **符号化崩溃日志**
   - 访问 http://localhost:5173/symbolicate
   - 粘贴崩溃日志
   - **在"手动选择 dSYM"下拉框中选择对应的 dSYM**
   - 点击"开始符号化"

3. **查看结果**
   - 查看符号化后的日志
   - 下载结果

## 功能特性

### ✅ 已实现

- [x] 上传 dSYM（.dSYM、.xcarchive、.zip）
- [x] 自动提取 UUID
- [x] **手动选择 dSYM（支持第三方平台崩溃日志）**
- [x] 符号化崩溃日志
- [x] 对比查看原始/符号化日志
- [x] 下载符号化结果
- [x] dSYM 文件管理
- [x] 搜索和过滤
- [x] 删除 dSYM

### 🎯 核心优势

1. **支持第三方平台**
   - Bugly、Firebase、Sentry 等平台的崩溃日志
   - 手动选择 dSYM 进行符号化

2. **智能匹配**
   - 自动提取 UUID（如果有）
   - 手动选择（如果没有 UUID）

3. **易于使用**
   - 拖拽上传
   - 实时反馈
   - 清晰的错误提示

## 常见场景

### 场景 1: Apple 原生崩溃日志（有 UUID）

```
直接粘贴 → 自动提取 UUID → 自动匹配 dSYM → 符号化
```

### 场景 2: 第三方平台崩溃日志（无 UUID）

```
粘贴日志 → 手动选择 dSYM → 符号化
```

### 场景 3: 不确定版本

```
1. 查看崩溃日志中的版本信息
2. 在下拉框中搜索对应版本
3. 选择并符号化
```

## 测试数据

如果你没有真实的崩溃日志，可以：

1. **使用示例日志**（需要对应的 dSYM）
2. **创建测试项目**
   - 创建简单的 iOS 项目
   - Archive 并导出 dSYM
   - 制造崩溃并获取日志

## 文档

- `README.md` - 项目概述和安装说明
- `TESTING_GUIDE.md` - 详细测试指南
- `THIRD_PARTY_CRASH_LOGS.md` - 第三方平台崩溃日志处理指南

## API 端点

### dSYM 管理
- `POST /api/dsym/upload` - 上传 dSYM
- `GET /api/dsym/list` - 获取列表
- `DELETE /api/dsym/:uuid` - 删除 dSYM

### 符号化
- `POST /api/symbolicate` - 符号化崩溃日志
  ```json
  {
    "crashLog": "崩溃日志内容",
    "uuid": "可选的 UUID"
  }
  ```

## 日志和调试

### 查看后端日志
```bash
# 实时日志
tail -f backend/logs/combined.log

# 错误日志
tail -f backend/logs/error.log
```

### 查看数据库
```bash
cd backend
sqlite3 storage/database.sqlite "SELECT app_name, version, uuid FROM dsym_info;"
```

## 停止服务

如果需要停止服务：

```bash
# 停止后端（在运行后端的终端按 Ctrl+C）
# 停止前端（在运行前端的终端按 Ctrl+C）
```

## 下一步

- [ ] 编写自动化测试
- [ ] 准备生产部署
- [ ] 添加用户认证
- [ ] 支持批量处理
- [ ] 添加历史记录
