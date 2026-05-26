# 企业微信分享功能集成指南

## 功能概述

本系统集成了企业微信分享功能，允许用户将崩溃报告详情分享到企业微信。采用**复制到剪贴板**的简单可靠方案，用户可以将包含详情链接的分享内容粘贴到企业微信中发送。

## 核心特性

### 分享内容

分享的是**崩溃报告详情页面链接**，接收者点击链接后可以查看：

1. **完整的符号化堆栈**
2. **AI 智能分析结果**（如果有）
3. **崩溃详细信息**（类型、模块、位置等）
4. **原始崩溃日志**

### 自动保存历史记录

- 符号化时自动保存到历史记录数据库
- 后端返回 `historyId`，用于生成分享链接
- 支持从缓存和历史记录中获取 `historyId`

## 实现方案

### 方案选择

经过评估，我们选择了**复制到剪贴板**方案，原因如下：

1. **简单可靠**：不需要复杂的企业微信配置
2. **跨平台**：支持 macOS、Windows、移动端
3. **用户体验好**：一键复制，粘贴即可分享
4. **无需权限**：不需要企业微信管理员权限
5. **完整信息**：分享链接可查看完整详情

## 技术实现

### 1. 后端改动

#### 符号化 API 返回 historyId

位置：`backend/src/routes/symbolicate.routes.ts`

所有符号化响应都包含 `historyId` 字段：

- 从历史记录返回：包含 `historyId`
- 从缓存返回：先保存历史记录，再返回 `historyId`
- 新符号化：保存历史记录后返回 `historyId`

### 2. 前端改动

#### 类型定义

位置：`frontend/src/types/index.ts`

```typescript
export interface SymbolicationResult {
  // ... 其他字段
  historyId?: number; // 历史记录ID，用于生成分享链接
}
```

#### 符号化页面分享

位置：`frontend/src/pages/SymbolicatePage.tsx`

```typescript
const handleShare = async () => {
  // 从符号化结果中获取 historyId
  const historyId = result.historyId;
  
  // 构建详情链接
  const detailUrl = `${baseUrl}/history?id=${historyId}`;
  
  // 复制到剪贴板
  await shareToWeChatWork(shareContent);
};
```

## 分享内容格式

### 符号化页面分享

```
📱 应用版本：1.0.0
💥 崩溃类型：SIGSEGV
🔧 崩溃模块：NNIM
📍 崩溃位置：-[ViewController handleCrash:] (ViewController.m:123)
⏰ 时间：2024-01-01 12:00:00

查看详情：http://localhost:5173/history?id=1
```

## 用户操作流程

### 从符号化页面分享

1. 上传崩溃日志并完成符号化
2. （可选）进行 AI 分析
3. 点击"分享"按钮
4. 系统自动复制分享内容到剪贴板
5. 显示提示："分享链接已复制到剪贴板，请在企业微信中粘贴发送"
6. 用户打开企业微信
7. 在聊天窗口中粘贴（Cmd+V 或 Ctrl+V）
8. 发送消息
9. 接收者点击链接，自动打开历史记录详情模态框，查看完整的崩溃详情

## 详情页面功能

当用户通过分享链接打开详情时（`/history?id=123`），系统会：

1. 自动加载历史记录列表
2. 查找对应 ID 的记录
3. 自动打开详情模态框
4. 显示完整的符号化堆栈和 AI 分析结果
5. 用户可以下载报告或继续分享
6. 关闭模态框后，URL 参数会被清除，回到历史记录列表

## 数据流程

```
用户上传崩溃日志
    ↓
后端符号化处理
    ↓
自动保存到历史记录数据库
    ↓
返回符号化结果 + historyId
    ↓
前端保存 historyId
    ↓
用户点击分享
    ↓
使用 historyId 生成详情链接
    ↓
复制到剪贴板
    ↓
用户粘贴到企业微信
    ↓
接收者点击链接
    ↓
打开历史记录详情页面
    ↓
查看完整符号化结果和AI分析
```

## 优势

1. **完整信息**：分享链接可查看完整的符号化详情和AI分析
2. **无需配置**：不需要企业微信 API 配置
3. **简单易用**：一键复制，粘贴即可
4. **跨平台**：支持所有平台
5. **可靠性高**：不依赖第三方服务
6. **自动保存**：符号化时自动保存历史记录
7. **持久化**：分享链接永久有效

## 相关文件

### 后端
- `backend/src/routes/symbolicate.routes.ts` - 符号化路由，返回 historyId
- `backend/src/services/HistoryService.ts` - 历史记录服务

### 前端
- `frontend/src/utils/wechatShare.ts` - 分享工具函数
- `frontend/src/pages/HistoryPage.tsx` - 历史记录页面分享
- `frontend/src/pages/SymbolicatePage.tsx` - 符号化页面分享
- `frontend/src/types/index.ts` - 类型定义

## 测试

### 测试步骤

1. 上传崩溃日志并符号化
2. 点击"分享"按钮
3. 检查是否显示成功提示
4. 打开文本编辑器，粘贴内容
5. 验证分享内容格式是否正确
6. 复制链接到浏览器打开
7. 验证是否能正确显示崩溃详情

### 测试用例

- ✅ 符号化后自动保存历史记录
- ✅ 返回正确的 historyId
- ✅ 复制到剪贴板成功
- ✅ 分享内容格式正确
- ✅ 链接可以正确跳转到详情页
- ✅ 详情页显示完整的符号化结果
- ✅ 详情页显示 AI 分析结果（如果有）
- ✅ 支持不同浏览器
- ✅ 移动端也能正常使用
