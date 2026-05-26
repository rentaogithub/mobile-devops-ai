# 系统符号配置指南

## 概述

系统现在支持符号化 iOS 系统库（如 Foundation、UIKit、CoreFoundation 等），这需要 Xcode 的系统符号文件。

## 配置步骤

### 1. 确认 Xcode 已安装

```bash
xcode-select -p
# 应该输出: /Applications/Xcode.app/Contents/Developer
```

### 2. 配置环境变量

编辑 `backend/.env` 文件：

```bash
# 启用系统符号化
ENABLE_SYSTEM_SYMBOLICATION=true

# Xcode 系统符号路径（默认值，通常不需要修改）
XCODE_SYMBOLS_PATH=/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/DeviceSupport
```

### 3. 确认系统符号存在

检查 Xcode 是否有对应 iOS 版本的符号：

```bash
ls /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/DeviceSupport/
```

你应该看到类似这样的目录：
```
15.0/
15.0 (19A346)/
15.1 (19B74)/
16.0/
16.0 (20A362)/
...
```

### 4. 下载缺失的系统符号

如果没有对应 iOS 版本的符号，需要：

**方法 1: 连接真机设备**
1. 将运行对应 iOS 版本的设备连接到 Mac
2. 打开 Xcode
3. Window → Devices and Simulators
4. Xcode 会自动下载该设备的系统符号

**方法 2: 手动下载**
1. 从其他 Mac 复制对应版本的符号目录
2. 放到 DeviceSupport 目录下

### 5. 重启后端服务

```bash
# 停止当前服务（Ctrl+C）
# 重新启动
cd backend
npm run dev
```

## 工作原理

### 符号化流程

1. **应用代码符号化**
   - 使用用户上传的 dSYM 文件
   - 符号化应用自己的堆栈帧

2. **系统库符号化**（如果启用）
   - 从崩溃日志中提取 iOS 版本
   - 在 Xcode 符号目录中查找对应版本的系统库
   - 使用 atos 命令符号化系统库堆栈帧

### 支持的系统库

系统会自动识别并符号化以下系统库：

- Foundation
- UIKit / UIKitCore
- CoreFoundation
- libobjc.A.dylib
- libsystem_kernel.dylib
- libsystem_pthread.dylib
- libdispatch.dylib
- CoreGraphics
- QuartzCore
- CoreAnimation
- AVFoundation
- CoreMedia
- CoreVideo
- Metal
- MetalKit

## 使用示例

### 符号化前

```
Thread 0 Crashed:
0  CoreFoundation  0x32ce2df20  0x32cdaa000 + 1228576
1  Foundation      0x32b1e07f8  0x32ab02000 + 6945784
2  UIKitCore       0x331aa1f60  0x3312b0000 + 9568096
7  NNIM            0x2057c67d0  0x204ec0000 + 3675172
8  NNIM            0x2057c681c  0x204ec0000 + 3675248
```

### 符号化后

```
Thread 0 Crashed:
0  CoreFoundation  0x32ce2df20  __exceptionPreprocess + 164
1  Foundation      0x32b1e07f8  -[NSObject(NSKeyValueCoding) setValue:forKey:] + 284
2  UIKitCore       0x331aa1f60  -[UIView setFrame:] + 96
7  NNIM            0x2057c67d0  -[ViewController viewDidLoad] (ViewController.m:42)
8  NNIM            0x2057c681c  -[ViewController loadView] (ViewController.m:58)
```

## 性能影响

启用系统符号化会：
- 增加符号化时间（约 2-5 秒）
- 需要更多磁盘空间（Xcode 符号文件较大）
- 提供更完整的调用栈信息

## 故障排查

### 问题 1: 系统符号化未生效

**检查：**
```bash
# 查看后端日志
tail -f backend/logs/combined.log | grep "系统符号"
```

**可能原因：**
- `ENABLE_SYSTEM_SYMBOLICATION` 未设置为 `true`
- Xcode 符号路径不正确
- 没有对应 iOS 版本的符号

**解决：**
1. 确认 `.env` 配置正确
2. 检查路径是否存在
3. 连接真机下载符号

### 问题 2: 找不到系统符号

**日志显示：**
```
未找到系统库符号 {"binaryName":"Foundation","iosVersion":"15.0"}
```

**解决：**
1. 连接运行 iOS 15.0 的设备到 Mac
2. 打开 Xcode，等待符号下载完成
3. 重启后端服务

### 问题 3: 符号化速度慢

**原因：**
系统库符号化需要多次调用 atos 命令

**优化：**
- 只在需要时启用系统符号化
- 系统会缓存已找到的符号路径

## 禁用系统符号化

如果不需要系统符号，可以禁用以提高性能：

```bash
# 编辑 backend/.env
ENABLE_SYSTEM_SYMBOLICATION=false
```

或者直接删除该配置项（默认为禁用）。

## 高级配置

### 自定义符号路径

如果你的 Xcode 安装在其他位置：

```bash
XCODE_SYMBOLS_PATH=/path/to/your/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/DeviceSupport
```

### 使用外部符号库

你也可以从其他来源获取系统符号，只需确保目录结构符合 Xcode 的格式：

```
DeviceSupport/
├── 15.0/
│   └── Symbols/
│       └── System/
│           └── Library/
│               └── Frameworks/
│                   └── Foundation.framework/
│                       └── Foundation
├── 16.0/
│   └── Symbols/
...
```

## 注意事项

1. **版本匹配**：系统符号必须与崩溃日志的 iOS 版本匹配
2. **磁盘空间**：每个 iOS 版本的符号约 2-5GB
3. **性能**：首次符号化会较慢，后续会使用缓存
4. **隐私**：系统符号文件包含在 Xcode 中，不涉及隐私问题

## 推荐配置

### 开发环境
```bash
ENABLE_SYSTEM_SYMBOLICATION=true
```
完整的符号化信息，便于调试

### 生产环境
```bash
ENABLE_SYSTEM_SYMBOLICATION=false
```
只符号化应用代码，性能更好

## 验证配置

启动后端服务后，查看日志：

```bash
tail -f backend/logs/combined.log
```

如果看到：
```
系统符号化已启用 {"xcodeSymbolsPath":"/Applications/Xcode.app/..."}
```

说明配置成功！
