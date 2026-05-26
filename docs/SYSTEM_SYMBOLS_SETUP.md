# 系统符号配置指南

## 问题说明

符号化后，系统 API（如 UIKit、Foundation 等）没有被解析出来，显示的仍然是内存地址。

## 原因

系统库的符号化需要 iOS 系统符号文件，这些文件通常存储在：
```
~/Library/Developer/Xcode/iOS DeviceSupport/
```

当前系统中该目录不存在，因此无法符号化系统库。

## 解决方案

### 方案 1：连接真机设备（推荐）

1. 使用 USB 连接 iOS 真机设备到 Mac
2. 打开 Xcode
3. 在 Xcode 中选择 Window > Devices and Simulators
4. 等待 Xcode 自动下载该设备的系统符号
5. 下载完成后，符号文件会保存在 `~/Library/Developer/Xcode/iOS DeviceSupport/`

### 方案 2：从其他 Mac 复制

如果你有其他已经连接过真机的 Mac：

1. 从其他 Mac 复制系统符号目录：
   ```bash
   # 在源 Mac 上打包
   cd ~/Library/Developer/Xcode/
   tar -czf ios-symbols.tar.gz "iOS DeviceSupport"
   
   # 传输到目标 Mac 并解压
   cd ~/Library/Developer/Xcode/
   tar -xzf ios-symbols.tar.gz
   ```

2. 重启符号化服务

### 方案 3：从网络下载

可以从以下来源下载 iOS 系统符号：
- Apple Developer Downloads
- GitHub 上的开源项目（搜索 "iOS DeviceSupport"）

**注意**：确保下载的符号版本与崩溃日志的 iOS 版本匹配。

## 验证配置

1. 检查目录是否存在：
   ```bash
   ls ~/Library/Developer/Xcode/iOS\ DeviceSupport/
   ```

2. 查看已有的 iOS 版本：
   ```bash
   ls ~/Library/Developer/Xcode/iOS\ DeviceSupport/
   ```
   
   应该看到类似这样的目录：
   ```
   15.0 (19A346)
   16.0 (20A362)
   17.0 (21A329)
   ```

3. 重启后端服务，查看日志确认系统符号化已启用

## 当前配置

查看 `backend/.env` 文件：

```env
# 是否启用系统符号化
ENABLE_SYSTEM_SYMBOLICATION=true

# 系统符号路径（默认）
XCODE_SYMBOLS_PATH=~/Library/Developer/Xcode/iOS DeviceSupport
```

## 常见问题

### Q: 为什么需要系统符号？
A: 系统库（如 UIKit、Foundation）的符号不包含在应用的 dSYM 中，需要单独的系统符号文件才能解析。

### Q: 系统符号文件很大吗？
A: 是的，每个 iOS 版本的符号文件大约 2-5 GB。建议只保留需要的版本。

### Q: 可以禁用系统符号化吗？
A: 可以，在 `.env` 中设置 `ENABLE_SYSTEM_SYMBOLICATION=false`，但这样系统库的堆栈将无法解析。

### Q: 符号化时如何匹配 iOS 版本？
A: 系统会自动从崩溃日志中提取 iOS 版本号，然后在对应版本的符号目录中查找。

## 临时解决方案

如果暂时无法获取系统符号，可以：

1. 关注应用自己的代码堆栈（这部分可以正常符号化）
2. 系统库的堆栈虽然显示地址，但可以通过函数偏移量推断调用关系
3. 使用 Xcode 的 Organizer 进行符号化（Xcode 有内置的系统符号）

## 相关文档

- [SYSTEM_SYMBOLS_GUIDE.md](./SYSTEM_SYMBOLS_GUIDE.md) - 系统符号使用指南
- [HOW_TO_UPLOAD_DSYM.md](./HOW_TO_UPLOAD_DSYM.md) - dSYM 上传指南
