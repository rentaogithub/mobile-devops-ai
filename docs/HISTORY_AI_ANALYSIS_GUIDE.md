# 历史记录 AI 分析功能说明

## 功能概述

符号化历史记录现在支持保存和查看 AI 智能分析结果。当用户对崩溃日志进行 AI 分析后，分析结果会自动关联到对应的历史记录中。

## 核心功能

### 1. 自动关联 AI 分析
- 符号化后进行 AI 分析
- 分析结果自动保存到对应的历史记录
- 通过版本号和 UUID 匹配记录

### 2. 详情查看
- 历史记录详情对话框包含两个标签页
- **符号化日志**：查看完整的符号化后的日志
- **AI 智能分析**：查看 AI 分析结果（如果有）

### 3. 完整分析信息
AI 分析结果包含：
- 崩溃类型和严重程度
- 问题描述
- 可能原因
- 建议解决方案
- 相关代码位置

## 使用流程

### 步骤 1：符号化崩溃日志

1. 进入"符号化"页面
2. 上传或粘贴崩溃日志
3. 点击"开始符号化"
4. 符号化成功后，系统自动保存历史记录

### 步骤 2：进行 AI 分析

1. 在符号化结果页面
2. 切换到"AI 智能分析"标签页
3. 输入通义千问 API Key
4. 点击"开始分析"
5. AI 分析完成后，结果自动保存到历史记录

### 步骤 3：查看历史记录

1. 进入"历史记录"页面
2. 找到对应的记录
3. 点击"查看详情"
4. 如果有 AI 分析，会显示"AI 智能分析"标签页

## 界面展示

### 历史记录列表

```
┌─────────────────────────────────────────────┐
│ 符号化历史记录                               │
│ 共 5 条记录                                  │
├─────────────────────────────────────────────┤
│ 🕐 2025-01-15 14:30 [v5.12.0] [SIGSEGV]    │
│ 最后调用：-[ViewController viewDidLoad]     │
│ [查看详情] [删除]                            │
└─────────────────────────────────────────────┘
```

### 详情对话框（有 AI 分析）

```
┌─────────────────────────────────────────────┐
│ 历史记录详情                        [关闭]  │
├─────────────────────────────────────────────┤
│ 版本：5.12.0    时间：2025-01-15 14:30      │
│ [SIGSEGV] [NNIM] [-[ViewController ...]]   │
│                                              │
│ [符号化日志] [AI 智能分析] ⭐                │
├─────────────────────────────────────────────┤
│ 📊 崩溃分析                                  │
│                                              │
│ 崩溃类型：空指针访问                         │
│ 严重程度：🔴 高                              │
│                                              │
│ 问题描述：                                   │
│ 在 ViewController 的 viewDidLoad 方法中...  │
│                                              │
│ 可能原因：                                   │
│ 1. 对象未初始化就被访问                      │
│ 2. ...                                       │
│                                              │
│ 建议解决方案：                               │
│ 1. 检查对象初始化逻辑                        │
│ 2. ...                                       │
└─────────────────────────────────────────────┘
```

### 详情对话框（无 AI 分析）

```
┌─────────────────────────────────────────────┐
│ 历史记录详情                        [关闭]  │
├─────────────────────────────────────────────┤
│ 版本：5.12.0    时间：2025-01-15 14:30      │
│ [SIGSEGV] [NNIM] [-[ViewController ...]]   │
│                                              │
│ [符号化日志]                                 │
├─────────────────────────────────────────────┤
│ Thread 0 Crashed:                            │
│ 0  NNIM  0x0001234  -[ViewController ...]   │
│ ...                                          │
└─────────────────────────────────────────────┘
```

## 技术实现

### 后端实现

#### 1. 更新历史记录的 AI 分析

```typescript
// HistoryService.ts
async updateAIAnalysis(id: number, aiAnalysis: any): Promise<void> {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE symbolication_history 
    SET ai_analysis = ?
    WHERE id = ?
  `);
  
  stmt.run(JSON.stringify(aiAnalysis), id);
}
```

#### 2. AI 分析完成后自动更新

```typescript
// symbolicate.routes.ts
// 执行 AI 分析
const analysis = await qwenAIService.analyzeCrashLog(...);

// 查找最近的匹配记录
const recentRecords = historyService.getHistoryByVersion(mainAppVersion);
if (recentRecords.length > 0) {
  const latestRecord = recentRecords[0];
  // 检查 UUID 是否匹配
  const isMatch = uuids.every(uuid => recordUuids.includes(uuid));
  
  if (isMatch) {
    // 更新历史记录
    await historyService.updateAIAnalysis(latestRecord.id, analysis);
  }
}
```

### 前端实现

#### 1. 使用 Tabs 组件

```typescript
<Tabs
  defaultActiveKey="log"
  items={[
    {
      key: 'log',
      label: '符号化日志',
      children: <pre>{selectedRecord.symbolicatedLog}</pre>,
    },
    ...(selectedRecord.aiAnalysis ? [{
      key: 'analysis',
      label: 'AI 智能分析',
      children: <AIAnalysisPanel analysis={selectedRecord.aiAnalysis} />,
    }] : []),
  ]}
/>
```

#### 2. 复用 AIAnalysisPanel 组件

```typescript
import AIAnalysisPanel from '../components/AIAnalysisPanel';

// 在详情对话框中使用
<AIAnalysisPanel 
  analysis={selectedRecord.aiAnalysis} 
  loading={false} 
/>
```

## 数据库结构

```sql
CREATE TABLE symbolication_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_version TEXT NOT NULL,
  crash_type TEXT,
  crash_reason TEXT,
  last_stack_call TEXT,
  crash_module TEXT,
  original_log TEXT NOT NULL,
  symbolicated_log TEXT NOT NULL,
  used_uuids TEXT NOT NULL,
  ai_analysis TEXT,  -- ⭐ AI 分析结果（JSON）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 使用场景

### 场景 1：回顾历史分析

**问题**：之前分析过的崩溃，想再看一次 AI 分析结果。

**解决**：
1. 进入"历史记录"页面
2. 找到对应的记录
3. 点击"查看详情"
4. 切换到"AI 智能分析"标签页
5. 查看完整的分析结果

### 场景 2：对比不同版本的分析

**问题**：想对比 5.12.0 和 5.11.0 的崩溃分析。

**解决**：
1. 查看 5.12.0 版本的历史记录
2. 打开详情，查看 AI 分析
3. 查看 5.11.0 版本的历史记录
4. 打开详情，查看 AI 分析
5. 对比两个版本的分析结果

### 场景 3：分享分析结果

**问题**：想把 AI 分析结果分享给团队。

**解决**：
1. 打开历史记录详情
2. 切换到"AI 智能分析"标签页
3. 截图或复制分析内容
4. 分享给团队成员

### 场景 4：追踪问题修复

**问题**：修复了一个崩溃，想确认是否还有类似问题。

**解决**：
1. 查看历史记录中的 AI 分析
2. 找到相同或类似的崩溃类型
3. 检查是否已修复
4. 追踪问题修复进度

## 匹配逻辑

AI 分析结果通过以下条件匹配历史记录：

1. **版本号匹配**：主应用版本相同
2. **UUID 匹配**：使用的 dSYM UUID 完全相同
3. **时间最近**：选择最近的一条记录

**示例**：
```
符号化：版本 5.12.0，UUID [ABC, DEF]
AI 分析：版本 5.12.0，UUID [ABC, DEF]
→ 匹配成功，更新历史记录
```

## 注意事项

### 1. API Key 安全

- API Key 不会保存到历史记录
- 每次分析需要重新输入
- 建议使用环境变量管理

### 2. 分析结果更新

- 只更新最近的匹配记录
- 如果有多条相同的记录，只更新最新的一条
- 已有分析结果会被覆盖

### 3. 数据大小

- AI 分析结果以 JSON 格式存储
- 建议定期清理旧记录
- 避免数据库过大

## 优势

### 1. 完整记录
- 保存符号化日志和 AI 分析
- 方便回顾和对比
- 追踪问题修复进度

### 2. 提高效率
- 无需重复分析
- 快速查看历史分析
- 节省 API 调用次数

### 3. 团队协作
- 分享分析结果
- 统一问题理解
- 提高沟通效率

## 总结

历史记录 AI 分析功能提供了：

✅ **自动关联**：AI 分析结果自动保存到历史记录
✅ **完整展示**：详情对话框包含符号化日志和 AI 分析
✅ **便捷查看**：标签页切换，清晰直观
✅ **智能匹配**：通过版本号和 UUID 精确匹配
✅ **复用组件**：使用 AIAnalysisPanel 组件，保持一致性

现在你可以更方便地管理和查看崩溃分析历史了！🎉
