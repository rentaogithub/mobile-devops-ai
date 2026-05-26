#!/bin/bash

# 测试 symbolicatecrash 工具
# 用法: ./scripts/test-symbolicatecrash.sh <crash.ips> <YourApp.app.dSYM>

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "======================================"
echo "symbolicatecrash 测试脚本"
echo "======================================"
echo ""

# 检查参数
if [ $# -lt 2 ]; then
    echo -e "${RED}错误: 缺少参数${NC}"
    echo ""
    echo "用法:"
    echo "  $0 <crash.ips> <YourApp.app.dSYM>"
    echo ""
    echo "示例:"
    echo "  $0 crash.ips MyApp.app.dSYM"
    echo "  $0 /path/to/crash.ips /path/to/MyApp.app.dSYM"
    echo ""
    exit 1
fi

CRASH_FILE="$1"
DSYM_FILE="$2"

# 检查文件是否存在
if [ ! -f "$CRASH_FILE" ]; then
    echo -e "${RED}错误: 崩溃日志文件不存在: $CRASH_FILE${NC}"
    exit 1
fi

if [ ! -d "$DSYM_FILE" ]; then
    echo -e "${RED}错误: dSYM 文件不存在: $DSYM_FILE${NC}"
    exit 1
fi

echo -e "${GREEN}✅ 输入文件验证通过${NC}"
echo "  崩溃日志: $CRASH_FILE"
echo "  dSYM: $DSYM_FILE"
echo ""

# 查找 symbolicatecrash 工具
echo "查找 symbolicatecrash 工具..."
TOOL_PATH=""

# 方法1: xcrun
TOOL_PATH=$(xcrun -find symbolicatecrash 2>/dev/null || echo "")
if [ -z "$TOOL_PATH" ] || [ ! -f "$TOOL_PATH" ]; then
    # 方法2: 常见位置
    COMMON_PATHS=(
        "/Applications/Xcode.app/Contents/SharedFrameworks/DVTFoundation.framework/Versions/A/Resources/symbolicatecrash"
        "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/Library/PrivateFrameworks/DVTFoundation.framework/Resources/symbolicatecrash"
    )
    
    for path in "${COMMON_PATHS[@]}"; do
        if [ -f "$path" ]; then
            TOOL_PATH="$path"
            break
        fi
    done
fi

if [ -z "$TOOL_PATH" ] || [ ! -f "$TOOL_PATH" ]; then
    echo -e "${RED}❌ 未找到 symbolicatecrash 工具${NC}"
    echo ""
    echo "请运行检查脚本获取更多信息:"
    echo "  ./scripts/check-symbolicatecrash.sh"
    exit 1
fi

echo -e "${GREEN}✅ 找到工具: $TOOL_PATH${NC}"
echo ""

# 设置环境变量
export DEVELOPER_DIR=$(xcode-select -p 2>/dev/null || echo "/Applications/Xcode.app/Contents/Developer")
echo "设置环境变量:"
echo "  DEVELOPER_DIR=$DEVELOPER_DIR"
echo ""

# 创建输出文件名
OUTPUT_FILE="${CRASH_FILE%.ips}_symbolicated.crash"
if [ "$CRASH_FILE" = "$OUTPUT_FILE" ]; then
    OUTPUT_FILE="${CRASH_FILE}_symbolicated.crash"
fi

echo "输出文件: $OUTPUT_FILE"
echo ""

# 执行符号化
echo "======================================"
echo "开始符号化..."
echo "======================================"
echo ""

START_TIME=$(date +%s)

# 执行命令
if "$TOOL_PATH" "$CRASH_FILE" "$DSYM_FILE" > "$OUTPUT_FILE" 2>&1; then
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    
    echo ""
    echo "======================================"
    echo -e "${GREEN}✅ 符号化成功${NC}"
    echo "======================================"
    echo ""
    echo "处理时间: ${DURATION} 秒"
    echo "输出文件: $OUTPUT_FILE"
    echo "文件大小: $(du -h "$OUTPUT_FILE" | cut -f1)"
    echo ""
    
    # 检查符号化质量
    echo "符号化质量检查:"
    
    # 检查是否包含源文件位置
    if grep -q "\.swift:" "$OUTPUT_FILE" || grep -q "\.m:" "$OUTPUT_FILE"; then
        echo -e "  ${GREEN}✅ 包含源文件位置信息${NC}"
        
        # 显示一些示例
        echo ""
        echo "符号化示例（前5行）:"
        echo "---"
        grep -E "\.(swift|m|mm|c|cpp):" "$OUTPUT_FILE" | head -5
        echo "---"
    else
        echo -e "  ${YELLOW}⚠️  未检测到源文件位置信息${NC}"
        echo "     可能原因: UUID 不匹配或 dSYM 不正确"
    fi
    
    # 检查是否包含函数名
    if grep -q "(in " "$OUTPUT_FILE"; then
        echo -e "  ${GREEN}✅ 包含函数符号信息${NC}"
    fi
    
    echo ""
    echo "查看完整结果:"
    echo "  cat $OUTPUT_FILE"
    echo "  less $OUTPUT_FILE"
    echo ""
    
else
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    
    echo ""
    echo "======================================"
    echo -e "${RED}❌ 符号化失败${NC}"
    echo "======================================"
    echo ""
    echo "处理时间: ${DURATION} 秒"
    echo ""
    
    if [ -f "$OUTPUT_FILE" ]; then
        echo "错误输出（前20行）:"
        echo "---"
        head -20 "$OUTPUT_FILE"
        echo "---"
        echo ""
        echo "完整错误信息: $OUTPUT_FILE"
    fi
    
    echo ""
    echo "可能的原因:"
    echo "  1. dSYM 文件与崩溃日志不匹配"
    echo "  2. .ips 文件格式不正确"
    echo "  3. DEVELOPER_DIR 未正确设置"
    echo ""
    echo "调试建议:"
    echo "  1. 验证 UUID 是否匹配"
    echo "  2. 检查 .ips 文件是否完整"
    echo "  3. 尝试使用其他版本的 dSYM"
    echo ""
    
    exit 1
fi
