#!/bin/bash

# 检查 NNRtc dSYM 文件结构的脚本

echo "=== 检查 NNRtc dSYM 文件结构 ==="
echo ""

# 查找 NNRtc dSYM 文件
echo "1. 查找 NNRtc dSYM 文件..."
NNRTC_DSYM=$(find . -name "NNRtc*.dSYM" -type d 2>/dev/null | head -1)

if [ -z "$NNRTC_DSYM" ]; then
    echo "❌ 未找到 NNRtc dSYM 文件"
    echo ""
    echo "请提供 NNRtc dSYM 文件的路径："
    echo "  ./check-nnrtc-dsym.sh /path/to/NNRtc.dSYM"
    exit 1
fi

if [ ! -z "$1" ]; then
    NNRTC_DSYM="$1"
fi

echo "✓ 找到: $NNRTC_DSYM"
echo ""

# 检查目录结构
echo "2. 检查目录结构..."
if [ -d "$NNRTC_DSYM/Contents" ]; then
    echo "✓ Contents/ 目录存在"
else
    echo "❌ Contents/ 目录不存在"
fi

if [ -d "$NNRTC_DSYM/Contents/Resources" ]; then
    echo "✓ Contents/Resources/ 目录存在"
else
    echo "❌ Contents/Resources/ 目录不存在"
fi

if [ -d "$NNRTC_DSYM/Contents/Resources/DWARF" ]; then
    echo "✓ Contents/Resources/DWARF/ 目录存在"
else
    echo "❌ Contents/Resources/DWARF/ 目录不存在"
    exit 1
fi

echo ""

# 列出 DWARF 目录内容
echo "3. DWARF 目录内容..."
ls -la "$NNRTC_DSYM/Contents/Resources/DWARF/"
echo ""

# 检查 DWARF 文件
DWARF_FILES=$(ls "$NNRTC_DSYM/Contents/Resources/DWARF/" 2>/dev/null | grep -v "^\.")
if [ -z "$DWARF_FILES" ]; then
    echo "❌ DWARF 目录为空或只包含隐藏文件"
    exit 1
fi

echo "✓ 找到 DWARF 文件: $DWARF_FILES"
echo ""

# 提取 UUID
echo "4. 提取 UUID..."
DWARF_FILE="$NNRTC_DSYM/Contents/Resources/DWARF/$DWARF_FILES"
dwarfdump --uuid "$DWARF_FILE"
echo ""

# 检查文件大小
echo "5. 文件大小..."
du -sh "$NNRTC_DSYM"
echo ""

echo "=== 检查完成 ==="
