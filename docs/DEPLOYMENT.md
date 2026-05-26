# iOS 崩溃日志符号化系统 - 部署文档

## 系统要求

### 必需环境
- **操作系统**: macOS（因为需要使用 `atos` 和 `dwarfdump` 命令）
- **Node.js**: 18.x 或更高版本
- **npm**: 9.x 或更高版本
- **磁盘空间**: 建议至少 10GB 可用空间（用于存储 dSYM 文件）

### 可选环境
- **Xcode**: 如果需要符号化系统库，需要安装 Xcode 并下载对应版本的 iOS DeviceSupport

---

## 快速部署指南

### 1. 获取项目代码

```bash
# 克隆或复制项目到目标机器
# 假设项目目录为 ~/ios-crash-symbolizer
cd ~/ios-crash-symbolizer
```

### 2. 安装依赖

#### 后端依赖
```bash
cd backend
npm install
```

#### 前端依赖
```bash
cd ../frontend
npm install
```

### 3. 配置环境变量

在 `backend` 目录下创建 `.env` 文件：

```bash
cd ../backend
cat > .env << 'EOF'
# 服务器端口
PORT=3000

# 文件上传目录
UPLOAD_DIR=./storage/uploads

# dSYM 存储目录
DSYM_DIR=./storage/dsyms

# 数据库路径
DB_PATH=./storage/database.sqlite

# 最大文件上传大小（字节）500MB
MAX_FILE_SIZE=524288000

# 日志级别
LOG_LEVEL=info

# 系统符号化（可选，启用后可以符号化系统库）
ENABLE_SYSTEM_SYMBOLS=true
XCODE_SYMBOLS_PATH=/Users/$(whoami)/Library/Developer/Xcode/iOS DeviceSupport
EOF
```

### 4. 创建存储目录

```bash
# 在 backend 目录下
mkdir -p storage/uploads
mkdir -p storage/dsyms
```

### 5. 启动服务

#### 开发模式（推荐用于测试）

**终端 1 - 启动后端：**
```bash
cd backend
npm run dev
```

**终端 2 - 启动前端：**
```bash
cd frontend
npm run dev
```

访问 http://localhost:5173 即可使用系统。

#### 生产模式

**构建前端：**
```bash
cd frontend
npm run build
```

**启动后端（会自动服务前端静态文件）：**
```bash
cd ../backend
npm run build
npm start
```

访问 http://localhost:3000 即可使用系统。

---

## 生产环境部署

### 使用 PM2 管理进程

#### 1. 安装 PM2
```bash
npm install -g pm2
```

#### 2. 创建 PM2 配置文件

在项目根目录创建 `ecosystem.config.js`：

```javascript
module.exports = {
  apps: [
    {
      name: 'ios-crash-symbolizer',
      cwd: './backend',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
```

#### 3. 构建并启动

```bash
# 构建前端
cd frontend
npm run build

# 构建后端
cd ../backend
npm run build

# 使用 PM2 启动
cd ..
pm2 start ecosystem.config.js

# 设置开机自启动
pm2 startup
pm2 save
```

#### 4. PM2 常用命令

```bash
# 查看状态
pm2 status

# 查看日志
pm2 logs ios-crash-symbolizer

# 重启服务
pm2 restart ios-crash-symbolizer

# 停止服务
pm2 stop ios-crash-symbolizer

# 删除服务
pm2 delete ios-crash-symbolizer
```

---

## 使用说明

系统部署完成后，通过浏览器访问即可使用。系统包含三个主要功能模块：

### 1. 上传 dSYM

#### 功能说明
上传并管理 iOS 应用的 dSYM 符号文件，用于后续的崩溃日志符号化。

#### 操作步骤

1. **点击"上传 dSYM"标签页**

2. **选择 dSYM 文件**
   - 支持的格式：
     - `.dSYM` 目录（直接拖拽到上传区域）
     - `.xcarchive` 文件（Xcode Archive）
     - `.zip` 压缩包（包含 dSYM 的压缩文件）
     - `.tgz` / `.tar.gz` 压缩包

3. **上传方式**
   - **拖拽上传**：将文件拖拽到上传区域
   - **点击上传**：点击上传区域，选择文件

4. **查看上传结果**
   - 上传成功后会显示：
     - 应用名称
     - 版本号
     - UUID
     - 上传时间

#### 注意事项
- 单个文件最大 500MB
- 相同 UUID 的 dSYM 不能重复上传
- 上传的 dSYM 文件会永久保存，直到手动删除

---

### 2. 符号化崩溃日志

#### 功能说明
将崩溃日志中的内存地址转换为可读的函数名、文件名和行号。

#### 操作步骤

1. **点击"符号化"标签页**

2. **输入崩溃日志**
   - **方式一：粘贴文本**
     - 复制崩溃日志内容
     - 粘贴到文本框中
   
   - **方式二：上传文件**
     - 点击"上传文件"按钮
     - 选择 `.crash` 或 `.ips` 文件
     - 系统会自动读取文件内容

3. **选择 dSYM 文件**
   - 从下拉列表中选择对应的 dSYM
   - **支持多选**：可以同时选择多个 dSYM（例如主应用 + 框架）
   - 第一个选择的 dSYM 会作为主应用

4. **开始符号化**
   - 点击"开始符号化"按钮
   - 等待处理完成（通常几秒钟）

5. **查看结果**
   - **符号化后**标签页：显示符号化后的日志
   - **原始日志**标签页：显示原始崩溃日志
   - 点击"下载结果"可以保存符号化后的日志

#### 支持的崩溃日志格式

- **Apple Crash Report** (`.crash` 文件)
  ```
  Incident Identifier: xxx
  CrashReporter Key: xxx
  Hardware Model: iPhone
  Process: MyApp [12345]
  ...
  Thread 0 Crashed:
  0   MyApp    0x100001234 0x100000000 + 4660
  ```

- **.ips 文件** (JSON 格式)
  - 从控制台导出的崩溃日志
  - 建议：在控制台中打开 .ips 文件，复制格式化后的文本

- **第三方平台崩溃日志**
  - Bugly、Firebase 等平台导出的日志
  - 需要手动选择对应的 dSYM

#### UUID 匹配说明

- **自动匹配**：系统会尝试从崩溃日志中提取 UUID 并自动匹配 dSYM
- **手动选择**：如果自动匹配失败，需要手动选择 dSYM
- **UUID 不匹配警告**：
  - 如果 dSYM 的 UUID 与崩溃日志不匹配，系统会显示警告
  - 系统仍会尝试使用文件名匹配进行符号化
  - 建议上传正确版本的 dSYM 以获得准确结果

#### 多 dSYM 符号化

如果崩溃日志包含多个二进制文件（主应用 + 框架），可以：

1. 选择多个 dSYM 文件（按住 Cmd/Ctrl 多选）
2. 系统会依次使用每个 dSYM 进行符号化
3. 例如：
   - 选择 `NNIM 5.12.0` 和 `NNRtc 2.5.4`
   - 系统会符号化 NNIM 和 NNRtc 的堆栈

#### 手动符号化（使用 atos 命令）

如果需要手动符号化单个地址，可以直接使用 `atos` 命令：

**方式一：使用地址符号化**

```bash
atos -arch <架构> -o <二进制文件或dSYM路径> -l <加载基址> <目标地址>
```

**示例：**
```bash
# 符号化单个地址
atos -o ./NNIM.app.dSYM/Contents/Resources/DWARF/NNIM -l 0x107ac0000 0x107b8b004

# 符号化多个地址
atos -o ./NNIM.app.dSYM/Contents/Resources/DWARF/NNIM -l 0x107ac0000 0x107b8b004 0x107b8b100 0x107b8b200
```

**参数说明：**
- `-arch <架构>`：指定架构（arm64、armv7 等），通常可以省略，系统会自动检测
- `-o <路径>`：dSYM 文件中的 DWARF 文件路径
- `-l <加载基址>`：二进制的加载基址（从崩溃日志的 Binary Images 部分获取）
- `<目标地址>`：要符号化的内存地址

**方式二：使用偏移量符号化**

```bash
atos -arch <架构> -o <二进制文件或dSYM路径> <偏移量>
```

**示例：**
```bash
# 使用偏移量符号化
atos -arch arm64 -o NNRtc.dSYM/Contents/Resources/DWARF/NNRtc 895660

# 符号化多个偏移量
atos -arch arm64 -o NNRtc.dSYM/Contents/Resources/DWARF/NNRtc 895660 895700 895800
```

**参数说明：**
- `-arch <架构>`：必须指定架构
- `-o <路径>`：dSYM 文件中的 DWARF 文件路径
- `<偏移量>`：相对于二进制起始位置的偏移量（十进制或十六进制）

**如何获取参数：**

从崩溃日志中提取信息：

```
Thread 0 Crashed:
0   NNIM    0x107b8b004    0x107ac0000 + 831492
                          ↑ 目标地址    ↑ 加载基址  ↑ 偏移量

Binary Images:
0x107ac0000 - 0x107ffffff NNIM arm64  <e08bdb14efd731409629ff39911fd971>
↑ 加载基址                           ↑ 架构      ↑ UUID
```

**使用场景：**
- 快速符号化单个地址
- 验证 dSYM 文件是否正确
- 调试符号化问题
- 批量符号化特定地址

**输出示例：**
```bash
$ atos -o ./NNIM.app.dSYM/Contents/Resources/DWARF/NNIM -l 0x107ac0000 0x107b8b004
-[ViewController handleCrash:] (in NNIM) (ViewController.m:123)
```

---

### 3. 管理 dSYM

#### 功能说明
查看、搜索、编辑和删除已上传的 dSYM 文件。

#### 操作步骤

1. **点击"管理"标签页**

2. **查看 dSYM 列表**
   - 显示所有已上传的 dSYM 文件
   - 包含信息：
     - 应用名称
     - 版本号（和 Build Number）
     - UUID
     - 架构（arm64、armv7 等）
     - 文件大小
     - 上传时间
     - 备注

3. **搜索 dSYM**
   - 在搜索框中输入关键词
   - 可搜索：应用名称、版本号、UUID
   - 实时过滤结果

4. **编辑 dSYM 信息**
   - 点击"编辑"按钮
   - 可以修改：
     - **版本号**：修正自动提取的版本号
     - **备注**：添加说明（如：测试版本、发布日期等）
   - 点击"保存"

5. **删除 dSYM**
   - 点击"删除"按钮
   - 确认删除
   - **注意**：删除后无法恢复

6. **刷新列表**
   - 点击"刷新"按钮更新列表

---

### 使用技巧

#### 1. 如何获取 dSYM 文件

**从 Xcode Archive 获取：**
```bash
# 打开 Xcode Organizer
# Window → Organizer → Archives
# 右键点击 Archive → Show in Finder
# 进入 .xcarchive/dSYMs/ 目录
```

**从构建输出获取：**
```bash
# 在项目的 DerivedData 目录中
~/Library/Developer/Xcode/DerivedData/YourProject-xxx/Build/Products/
```

**从 App Store Connect 下载：**
- 登录 App Store Connect
- 进入应用 → TestFlight 或 App Store
- 选择对应版本 → 下载 dSYM

#### 2. 如何获取崩溃日志

**从 Xcode 获取：**
- Window → Devices and Simulators
- 选择设备 → View Device Logs
- 导出崩溃日志

**从控制台获取：**
- 打开"控制台"应用
- 连接设备或选择崩溃报告
- 导出为 .ips 或复制文本

**从第三方平台获取：**
- Bugly、Firebase、Sentry 等
- 导出崩溃日志文本

#### 3. 符号化最佳实践

1. **及时上传 dSYM**
   - 每次发布新版本后立即上传 dSYM
   - 为 dSYM 添加备注（版本、日期、渠道等）

2. **版本管理**
   - 保留所有历史版本的 dSYM
   - 使用备注区分测试版和正式版

3. **UUID 匹配**
   - 确保 dSYM 和崩溃日志来自同一个构建
   - 如果 UUID 不匹配，符号化结果可能不准确

4. **多模块应用**
   - 上传主应用和所有框架的 dSYM
   - 符号化时选择所有相关的 dSYM

5. **系统库符号化**
   - 如果启用了系统符号化，系统会自动符号化 iOS 系统库
   - 需要在 Xcode 中下载对应版本的 iOS DeviceSupport

#### 4. 常见问题

**Q: 为什么符号化后还是显示地址？**
- A: 可能原因：
  1. UUID 不匹配（检查警告信息）
  2. dSYM 文件不完整
  3. 崩溃日志格式不正确

**Q: 如何处理 .ips 文件？**
- A: 建议方式：
  1. 在控制台中打开 .ips 文件
  2. 复制格式化后的文本
  3. 粘贴到符号化页面

**Q: 可以删除旧版本的 dSYM 吗？**
- A: 可以，但建议：
  1. 确认该版本不再需要符号化
  2. 先备份 dSYM 文件
  3. 然后再删除

**Q: 支持哪些架构？**
- A: 支持所有 iOS 架构：
  - arm64（iPhone 5s 及以后）
  - armv7（旧设备）
  - arm64e（A12 及以后）

---

## 配置说明

### 环境变量详解

| 变量名 | 说明 | 默认值 | 必需 |
|--------|------|--------|------|
| `PORT` | 后端服务端口 | 3000 | 否 |
| `UPLOAD_DIR` | 临时文件上传目录 | ./storage/uploads | 否 |
| `DSYM_DIR` | dSYM 永久存储目录 | ./storage/dsyms | 否 |
| `DB_PATH` | SQLite 数据库路径 | ./storage/database.sqlite | 否 |
| `MAX_FILE_SIZE` | 最大上传文件大小（字节） | 524288000 (500MB) | 否 |
| `LOG_LEVEL` | 日志级别 (error/warn/info/debug) | info | 否 |
| `ENABLE_SYSTEM_SYMBOLS` | 是否启用系统库符号化 | false | 否 |
| `XCODE_SYMBOLS_PATH` | Xcode 符号文件路径 | - | 否* |

*注：如果启用 `ENABLE_SYSTEM_SYMBOLS`，则需要配置 `XCODE_SYMBOLS_PATH`

### 前端配置

前端通过 Vite 的代理配置连接后端，配置文件位于 `frontend/vite.config.ts`：

```typescript
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
```

如果后端部署在不同的服务器或端口，需要修改此配置。

---

## 数据备份

### 备份内容

需要备份以下内容：
1. **数据库文件**: `backend/storage/database.sqlite`
2. **dSYM 文件**: `backend/storage/dsyms/`

### 备份脚本

创建 `backup.sh`：

```bash
#!/bin/bash

BACKUP_DIR="$HOME/ios-crash-symbolizer-backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="$BACKUP_DIR/backup_$TIMESTAMP"

# 创建备份目录
mkdir -p "$BACKUP_PATH"

# 备份数据库
cp backend/storage/database.sqlite "$BACKUP_PATH/"

# 备份 dSYM 文件
cp -r backend/storage/dsyms "$BACKUP_PATH/"

# 压缩备份
cd "$BACKUP_DIR"
tar -czf "backup_$TIMESTAMP.tar.gz" "backup_$TIMESTAMP"
rm -rf "backup_$TIMESTAMP"

echo "备份完成: $BACKUP_DIR/backup_$TIMESTAMP.tar.gz"

# 删除 7 天前的备份
find "$BACKUP_DIR" -name "backup_*.tar.gz" -mtime +7 -delete
```

使用 cron 定时备份：

```bash
# 编辑 crontab
crontab -e

# 添加每天凌晨 2 点备份
0 2 * * * /path/to/backup.sh
```

---

## 故障排查

### 常见问题

#### 1. 端口被占用

**错误信息**: `Error: listen EADDRINUSE: address already in use :::3000`

**解决方案**:
```bash
# 查找占用端口的进程
lsof -i :3000

# 杀死进程
kill -9 <PID>

# 或者修改 .env 中的 PORT
```

#### 2. 权限问题

**错误信息**: `EACCES: permission denied`

**解决方案**:
```bash
# 确保存储目录有写权限
chmod -R 755 backend/storage
```

#### 3. atos 命令不可用

**错误信息**: `atos 命令不可用`

**解决方案**:
- 确保在 macOS 系统上运行
- 安装 Xcode Command Line Tools:
  ```bash
  xcode-select --install
  ```

#### 4. 数据库锁定

**错误信息**: `database is locked`

**解决方案**:
```bash
# 停止所有服务
pm2 stop ios-crash-symbolizer

# 删除数据库锁文件
rm backend/storage/database.sqlite-wal
rm backend/storage/database.sqlite-shm

# 重启服务
pm2 start ios-crash-symbolizer
```

### 查看日志

```bash
# PM2 日志
pm2 logs ios-crash-symbolizer

# 应用日志（如果配置了文件日志）
tail -f backend/logs/combined.log
tail -f backend/logs/error.log
```

---

## 性能优化

### 1. 增加文件上传限制

如果需要上传更大的文件，修改 `.env`:

```bash
MAX_FILE_SIZE=1073741824  # 1GB
```

### 2. 数据库优化

SQLite 已配置 WAL 模式以提高并发性能。如果需要更高性能，可以考虑：

- 定期清理旧的 dSYM 文件
- 使用 SSD 存储
- 增加系统内存

### 3. 系统资源

建议配置：
- **CPU**: 2 核心或更多
- **内存**: 4GB 或更多
- **磁盘**: SSD，至少 50GB 可用空间

---

## 安全建议

### 1. 网络访问控制

如果部署在服务器上，建议：

- 使用防火墙限制访问
- 配置 Nginx 反向代理并启用 HTTPS
- 添加身份认证（需要自行实现）

### 2. 文件上传安全

系统已实现：
- 文件类型验证
- 文件大小限制
- 路径遍历防护

### 3. 定期更新

```bash
# 更新依赖
cd backend && npm update
cd ../frontend && npm update
```

---

## 更新部署

### 更新步骤

```bash
# 1. 备份数据
./backup.sh

# 2. 拉取最新代码
git pull

# 3. 更新依赖
cd backend && npm install
cd ../frontend && npm install

# 4. 重新构建
cd ../frontend && npm run build
cd ../backend && npm run build

# 5. 重启服务
pm2 restart ios-crash-symbolizer
```

---

## 卸载

```bash
# 1. 停止服务
pm2 stop ios-crash-symbolizer
pm2 delete ios-crash-symbolizer

# 2. 删除项目文件
rm -rf ~/ios-crash-symbolizer

# 3. 删除备份（可选）
rm -rf ~/ios-crash-symbolizer-backups
```

---

## 技术支持

如有问题，请检查：
1. 系统日志
2. 浏览器控制台
3. 网络连接
4. 文件权限

---

## 附录

### A. 目录结构

```
ios-crash-symbolizer/
├── backend/
│   ├── src/
│   ├── storage/
│   │   ├── uploads/      # 临时上传文件
│   │   ├── dsyms/        # dSYM 存储
│   │   └── database.sqlite
│   ├── package.json
│   └── .env
├── frontend/
│   ├── src/
│   ├── dist/             # 构建输出
│   └── package.json
├── ecosystem.config.js   # PM2 配置
├── backup.sh            # 备份脚本
└── DEPLOYMENT.md        # 本文档
```

### B. 端口说明

- **3000**: 后端 API 服务（生产模式）
- **5173**: 前端开发服务器（开发模式）

### C. 浏览器兼容性

- Chrome 90+
- Safari 14+
- Firefox 88+
- Edge 90+
