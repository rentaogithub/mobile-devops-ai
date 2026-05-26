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
# QWEN_API_KEY=your_api_key
# QWEN_API_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

# 企业微信配置（可选）
# WECHAT_WORK_WEBHOOK=your_webhook_url
```

### 开发模式启动

```bash
# 同时启动前端和后端开发服务器
npm run dev

# 或分别启动
npm run dev:backend   # 后端服务：http://localhost:3001
npm run dev:frontend  # 前端服务：http://localhost:5173
```

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
./download-ios18-symbols.sh
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
- **AI**：通义千问 API

## 🤝 贡献

欢迎提交 Issue 和 Pull Request

## 📄 许可证

MIT License












