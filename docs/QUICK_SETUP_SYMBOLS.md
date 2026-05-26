# 快速配置系统符号

## 当前状态
✅ 目录已创建：`~/Library/Developer/Xcode/iOS DeviceSupport/`
❌ 目录为空，需要添加符号文件

## 最简单的方法：连接真机

1. **用 USB 连接 iOS 设备到 Mac**
2. **打开 Xcode**
3. **菜单：Window > Devices and Simulators**
4. **等待提示 "Preparing device for development..."**
5. **完成后符号会自动下载**

## 从网络下载

### 推荐仓库
1. **QiuChenly/iOS-DeviceSupport**
   - 地址：https://github.com/QiuChenly/iOS-DeviceSupport
   - 包含 iOS 10.0 - 17.x 的符号
   - 下载对应版本的 zip 文件

2. **Zuikyo/iOS-System-Symbols**
   - 地址：https://github.com/Zuikyo/iOS-System-Symbols
   - 包含多个 iOS 版本

### 下载步骤
```bash
# 1. 访问 GitHub 仓库
open https://github.com/QiuChenly/iOS-DeviceSupport

# 2. 进入 DeviceSupport 目录，下载需要的版本
# 例如：15.0.zip, 16.0.zip, 17.0.zip

# 3. 解压到目标目录
cd ~/Downloads
unzip "15.0.zip" -d ~/Library/Developer/Xcode/"iOS DeviceSupport"/

# 4. 验证
ls ~/Library/Developer/Xcode/"iOS DeviceSupport"/
```

## 常见 iOS 版本对应

根据你的崩溃日志选择对应版本：
- iOS 15.x → 下载 15.0.zip
- iOS 16.x → 下载 16.0.zip  
- iOS 17.x → 下载 17.0.zip
- iOS 18.x → 下载 18.0.zip

## 验证配置

```bash
# 1. 检查目录
ls -lh ~/Library/Developer/Xcode/"iOS DeviceSupport"/

# 应该看到类似：
# 15.0 (19A346)/
# 16.0 (20A362)/

# 2. 检查符号文件
ls ~/Library/Developer/Xcode/"iOS DeviceSupport"/15.0*/Symbols/System/Library/Frameworks/

# 应该看到：
# Foundation.framework
# UIKit.framework
# CoreFoundation.framework
# ...
```

## 重启服务

配置完成后重启后端服务：
```bash
# 停止当前服务（Ctrl+C）
# 重新启动
npm run dev
```

查看日志确认：
```
info: 系统符号化已启用 {"xcodeSymbolsPath":"..."}
```

## 测试符号化

1. 上传包含系统库堆栈的崩溃日志
2. 查看符号化结果
3. 系统库（如 UIKit、Foundation）应该显示函数名而不是地址

## 需要帮助？

如果遇到问题，检查：
1. 目录路径是否正确
2. 符号文件是否完整
3. iOS 版本是否匹配
4. 后端日志是否有错误

参考完整文档：`SYSTEM_SYMBOLS_SETUP.md`
