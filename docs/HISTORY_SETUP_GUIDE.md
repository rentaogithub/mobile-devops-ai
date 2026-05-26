# 符号化历史记录功能 - 设置指南

## 问题说明

如果你遇到"获取历史记录失败"的错误，这是因为数据库中缺少 `symbolication_history` 表。

## 解决方法

### 方法 1：运行迁移脚本（推荐）

在后端目录执行以下命令：

```bash
cd backend
npx tsx scripts/migrate-history-table.ts
```

你应该看到以下输出：

```
开始数据库迁移...
检查 symbolication_history 表是否存在...
创建 symbolication_history 表...
创建索引...
✅ symbolication_history 表创建成功！
✅ 验证成功：表已创建
迁移完成！
```

### 方法 2：重启服务器

如果数据库表已经创建，但服务器还在使用旧的连接，重启服务器即可：

```bash
# 停止当前服务
# Ctrl+C 或者在 IDE 中停止进程

# 重新启动
npm run dev
```

### 方法 3：手动创建表

如果上述方法都不行，可以手动创建表：

```bash
cd backend
sqlite3 ../../nn-ios-platform-data/database.sqlite
```

然后执行以下 SQL：

```sql
CREATE TABLE IF NOT EXISTS symbolication_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_version TEXT NOT NULL,
  crash_type TEXT,
  crash_reason TEXT,
  original_log TEXT NOT NULL,
  symbolicated_log TEXT NOT NULL,
  used_uuids TEXT NOT NULL,
  ai_analysis TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_app_version ON symbolication_history(app_version);
CREATE INDEX IF NOT EXISTS idx_created_at ON symbolication_history(created_at DESC);
```

退出 sqlite3：
```
.exit
```

## 验证功能

### 1. 测试历史记录服务

运行测试脚本：

```bash
cd backend
npx tsx scripts/test-history.ts
```

如果看到"✅ 所有测试通过！"，说明功能正常。

### 2. 访问历史记录页面

1. 打开浏览器访问：http://localhost:5173
2. 点击顶部导航栏的"历史记录"
3. 如果显示"暂无历史记录"，说明功能正常（只是还没有记录）

### 3. 创建测试记录

1. 进入"符号化"页面
2. 上传一个崩溃日志并符号化
3. 符号化成功后，系统会自动保存记录
4. 再次访问"历史记录"页面，应该能看到刚才的记录

## 常见问题

### Q1: 为什么会出现"no such table"错误？

**A:** 这是因为数据库已经初始化过了，新添加的表不会自动创建。需要运行迁移脚本手动创建。

### Q2: 运行迁移脚本后还是报错？

**A:** 可能是服务器还在使用旧的数据库连接。重启服务器即可。

### Q3: 如何查看数据库中的表？

**A:** 使用 sqlite3 命令：

```bash
sqlite3 ../../nn-ios-platform-data/database.sqlite
.tables
.schema symbolication_history
.exit
```

### Q4: 如何清空历史记录？

**A:** 管理员可以在前端逐条删除，或者直接清空表：

```bash
sqlite3 ../../nn-ios-platform-data/database.sqlite
DELETE FROM symbolication_history;
.exit
```

### Q5: 历史记录会占用多少空间？

**A:** 每条记录大约占用几 KB 到几十 KB（取决于日志长度）。建议定期清理旧记录。

## 功能说明

### 自动保存

每次符号化成功后，系统会自动保存：
- 主应用版本
- 原始崩溃日志
- 符号化后的日志
- 使用的 dSYM UUID 列表
- 符号化时间

### 按版本分类

历史记录会按照主应用版本（NNIM）自动分组：
- 版本 5.12.0
- 版本 5.11.0
- 版本 5.10.0
- ...

### 查看详情

点击"查看详情"可以看到：
- 完整的符号化日志
- 使用的所有 dSYM UUID
- 崩溃类型和原因（如果有）

### 权限控制

- **所有用户**：可以查看历史记录
- **管理员**：可以删除历史记录

## 数据库结构

```sql
CREATE TABLE symbolication_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_version TEXT NOT NULL,           -- 主应用版本
  crash_type TEXT,                     -- 崩溃类型（如 SIGSEGV）
  crash_reason TEXT,                   -- 崩溃原因
  original_log TEXT NOT NULL,          -- 原始崩溃日志
  symbolicated_log TEXT NOT NULL,      -- 符号化后的日志
  used_uuids TEXT NOT NULL,            -- 使用的 UUID（JSON 数组）
  ai_analysis TEXT,                    -- AI 分析结果（JSON）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 总结

符号化历史记录功能已经完全实现并测试通过。如果遇到问题：

1. ✅ 运行迁移脚本：`npx tsx scripts/migrate-history-table.ts`
2. ✅ 重启服务器
3. ✅ 运行测试脚本验证功能
4. ✅ 访问前端页面查看效果

现在你可以愉快地使用历史记录功能了！🎉
