# dSYM 符号化工具

iOS 崩溃日志符号化系统，支持自动符号化、AI 分析、历史记录、企业微信集成等功能。

## 🚀 快速开始

### 远程访问

- **Web 访问**：http://10.1.106.95:5173
- **VNC 远程桌面**：vnc://10.1.103.96

### 环境要求

- Node.js >= 18.x
- npm >= 9.x
- macOS 系统（用于 symbolicatecrash 工具）
- Xcode Command Line Tools

### 安装依赖

```bash
# 安装项目依赖
npm install
```

### 配置环境变量

在 `backend` 目录下创建 `.env` 文件：

```bash
# 服务端口
PORT=3001

# 数据库路径（可选，默认使用 nn-ios-platform-data/database.sqlite）
# DB_PATH=./nn-ios-platform-data/database.sqlite

# 文件上传配置（可选）
# UPLOAD_DIR=./nn-ios-platform-data/uploads
# DSYM_DIR=./nn-ios-platform-data/dsyms
# MAX_FILE_SIZE=524288000

# AI 配置（可选）
# OPENAI_API_KEY=your_openai_api_key_or_relay_token
# OPENAI_API_ENDPOINT=https://api.openai.com/v1
# OPENAI_BASE_URL=https://relay.example.com/v1
# OPENAI_MODEL=gpt-5.1
# OPENAI_API_STYLE=responses
# OPENAI_API_STYLE=chat_completions

# 实名账号与 AI 执行中心
# 首次启动会使用以下账号创建本地管理员；已有用户时不会重复创建
# ADMIN_USERNAME=admin
# ADMIN_DISPLAY_NAME=平台管理员
# ADMIN_PASSWORD=change_me
# AUTH_SESSION_TTL_HOURS=12
# AUTH_COOKIE_SECURE=true
# ASSISTANT_AI_TIMEOUT=120000
# ASSISTANT_MAX_OUTPUT_TOKENS=1600
# 仅在前后端确实分离部署时配置，多个来源用逗号分隔
# ASSISTANT_ALLOWED_ORIGINS=https://platform.example.com

# 企业微信配置（可选）
# WECHAT_WORK_WEBHOOK=your_webhook_url
```

### 开发模式启动

#### 方式一：使用启动脚本（推荐）

```bash
# 一键启动开发环境（自动处理启动顺序和端口冲突）
./start-platform.sh restart

# 停止开发环境
./start-platform.sh stop
```

启动脚本会：
- 自动检查并安装依赖
- 按正确顺序启动后端和前端
- 自动处理端口占用问题
- 等待后端就绪后再启动前端（避免代理连接失败）
- 输出日志到 `backend-dev.log` 和 `frontend-dev.log`

#### 方式二：手动启动

```bash
# 同时启动前端和后端开发服务器
npm run dev

# 或分别启动（注意：必须先启动后端，再启动前端）
npm run dev:backend   # 后端服务：http://localhost:3000
npm run dev:frontend  # 前端服务：http://localhost:5173
```

**注意**：如果前端出现 `ECONNREFUSED 127.0.0.1:3000` 错误，说明后端还未启动完成，请等待后端启动后再启动前端。

### 生产环境部署

#### 1. 构建项目

```bash
# 构建前端和后端
npm run build

# 或分别构建
npm run build:backend
npm run build:frontend
```

#### 2. 启动后端服务

```bash
cd backend
npm start
```

后端服务默认运行在 `http://localhost:3001`

#### 3. 部署前端

前端构建产物在 `frontend/dist` 目录，可以使用 Nginx 或其他 Web 服务器部署：

**Nginx 配置示例：**

```nginx
server {
    listen 80;
    server_name your-domain.com;

    root /path/to/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # 代理后端 API
    location /api {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

#### 4. 使用 PM2 管理后端进程（推荐）

```bash
# 安装 PM2
npm install -g pm2

# 启动后端服务
cd backend
pm2 start dist/index.js --name dsym-backend

# 查看服务状态
pm2 status

# 查看日志
pm2 logs dsym-backend

# 设置开机自启
pm2 startup
pm2 save
```

## 📖 功能文档

详细使用文档请查看 [docs/INDEX.md](docs/INDEX.md)

### 核心功能

- **符号化处理** - 支持 .crash 和 .ips 文件的自动符号化
- **AI 崩溃分析** - 自动分析崩溃原因并提供解决建议
- **AI 会话执行中心** - 在首页通过受控工具查询 Crash、CI/CD、自动质检与质量中心；写操作支持分级确认和实名审计
- **版本自动检测** - 自动识别崩溃日志中的版本信息
- **历史记录** - 保存符号化历史，支持查询和重新分析
- **企业微信集成** - 支持分享符号化结果到企业微信
- **组件库管理** - 支持多模块 dSYM 管理

### 快速指南

- [快速开始](docs/QUICK_START.md) - 系统快速上手
- [如何上传 dSYM](docs/HOW_TO_UPLOAD_DSYM.md) - dSYM 文件上传指南
- [符号化使用](docs/SYMBOLICATECRASH_USAGE_GUIDE.md) - 崩溃日志符号化
- [AI 自动分析](docs/AUTO_AI_ANALYSIS_GUIDE.md) - AI 分析功能
- [企业微信设置](docs/WECHAT_SETUP_GUIDE.md) - 企业微信集成

## 🔧 系统配置

### 系统符号配置

iOS 系统符号可以提高符号化准确性，配置方法：

```bash
# 下载 iOS 系统符号（需要 Xcode）
./scripts/download-symbols.sh
```

详见：[系统符号设置指南](docs/SYSTEM_SYMBOLS_SETUP.md)

### dSYM 文件获取

- **主应用**：从构建服务器或 Xcode Archive 中获取
- **组件库**：联系相关开发人员获取
- **IM SDK**：从指定共享目录获取

详见：[如何上传 dSYM](docs/HOW_TO_UPLOAD_DSYM.md)

## 📊 技术栈

- **前端**：React + TypeScript + Vite + Ant Design
- **后端**：Node.js + Express + TypeScript
- **数据库**：SQLite (better-sqlite3)
- **符号化**：Apple symbolicatecrash
- **AI**：OpenAI Responses API

### AI 会话执行中心安全边界

- 普通聊天仅保存在当前浏览器页面，刷新后清空。
- 查询工具直接执行；普通写操作需确认；CI/CD 写操作按游客、测试、研发、产品运营、管理员分角色控制。
- AI 发布必须指定质量门禁源构建；源构建状态、分支、必需测试套件和阻塞级 Issue 校验与原 CI/CD 发布接口共用同一套服务。
- TestFlight / App Store 验证密码仅在最终审批时直传执行服务，不发送给模型，也不写入操作审计。
- 所有工具参数均经过 allowlist Schema 校验，模型不能访问任意 URL、Shell 或 SQL。
- 实际工具调用、审批和结果会写入 `assistant_action_audits`，敏感字段自动脱敏。
- 仅支持上传 `.crash`、`.ips`、`.txt`，附件 15 分钟后自动清理。
- 管理员可在 dSYM 管理页的“平台用户”页签创建 `guest`、`tester`、`developer`、`product`、`admin` 账号；也可通过 `POST /api/auth/users` 创建。
- 角色边界：`guest` 游客可访问常用只读服务和 iOS 设备注册申请；`tester` 测试可发布蒲公英/TestFlight 并执行自动质检；`developer` 研发在测试权限基础上可增加/删除 Pods 组件；`product` 产品运营可发布苹果商店包；`admin` 管理员支持所有功能和角色权限管理。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request

## 📄 许可证

MIT License



