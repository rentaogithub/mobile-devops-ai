#!/bin/bash

# 检查 symbolicatecrash 工具是否可用
# 用于验证环境配置

echo "======================================"
echo "检查 symbolicatecrash 工具"
echo "======================================"
echo ""

# 检查是否在 macOS 上
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "❌ 错误: symbolicatecrash 只能在 macOS 上使用"
    exit 1
fi

echo "✅ 运行环境: macOS"
echo ""

# 检查 Xcode 是否安装
if ! command -v xcodebuild &> /dev/null; then
    echo "❌ 错误: 未安装 Xcode"
    echo "   请从 App Store 安装 Xcode"
    exit 1
fi

echo "✅ Xcode 已安装"
xcodebuild -version
echo ""

# 检查 xcode-select
DEVELOPER_DIR=$(xcode-select -p 2>/dev/null)
if [ $? -ne 0 ]; then
    echo "❌ 错误: xcode-select 未配置"
    echo "   运行: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
    exit 1
fi

echo "✅ DEVELOPER_DIR: $DEVELOPER_DIR"
echo ""

# 方法1: 使用 xcrun 查找
echo "方法1: 使用 xcrun 查找..."
TOOL_PATH=$(xcrun -find symbolicatecrash 2>/dev/null)
if [ -n "$TOOL_PATH" ] && [ -f "$TOOL_PATH" ]; then
    echo "✅ 找到工具: $TOOL_PATH"
    echo ""
    echo "工具信息:"
    ls -lh "$TOOL_PATH"
    echo ""
    echo "测试执行:"
    "$TOOL_PATH" 2>&1 | head -5
    echo ""
    echo "======================================"
    echo "✅ symbolicatecrash 工具可用"
    echo "======================================"
    exit 0
fi

echo "⚠️  xcrun 未找到工具"
echo ""

# 方法2: 在常见位置查找
echo "方法2: 在常见位置查找..."
COMMON_PATHS=(
    "/Applications/Xcode.app/Contents/SharedFrameworks/DVTFoundation.framework/Versions/A/Resources/symbolicatecrash"
    "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/Library/PrivateFrameworks/DVTFoundation.framework/Resources/symbolicatecrash"
)

for path in "${COMMON_PATHS[@]}"; do
    if [ -f "$path" ]; then
        echo "✅ 找到工具: $path"
        echo ""
        echo "工具信息:"
        ls -lh "$path"
        echo ""
        echo "======================================"
        echo "✅ symbolicatecrash 工具可用"
        echo "======================================"
        exit 0
    fi
done

echo "⚠️  常见位置未找到工具"
echo ""

# 方法3: 使用 find 命令搜索
echo "方法3: 使用 find 命令搜索（可能需要几秒钟）..."
TOOL_PATH=$(find /Applications/Xcode.app -name symbolicatecrash 2>/dev/null | head -1)
if [ -n "$TOOL_PATH" ] && [ -f "$TOOL_PATH" ]; then
    echo "✅ 找到工具: $TOOL_PATH"
    echo ""
    echo "工具信息:"
    ls -lh "$TOOL_PATH"
    echo ""
    echo "======================================"
    echo "✅ symbolicatecrash 工具可用"
    echo "======================================"
    exit 0
fi

echo ""
echo "======================================"
echo "❌ 未找到 symbolicatecrash 工具"
echo "======================================"
echo ""
echo "可能的原因:"
echo "1. Xcode 版本过旧"
echo "2. Xcode 安装不完整"
echo "3. 工具路径已更改"
echo ""
echo "建议:"
echo "1. 更新到最新版本的 Xcode"
echo "2. 重新安装 Xcode 命令行工具: xcode-select --install"
echo "3. 手动搜索工具: find /Applications/Xcode.app -name symbolicatecrash"
echo ""

exit 1
