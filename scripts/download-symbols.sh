#!/bin/bash

# iOS 系统符号下载脚本
# 用于下载指定 iOS 版本的系统符号

set -e

SYMBOLS_DIR="$HOME/Library/Developer/Xcode/iOS DeviceSupport"
TEMP_DIR="/tmp/ios-symbols-download"

echo "=========================================="
echo "iOS 系统符号下载工具"
echo "=========================================="
echo ""

# 创建目标目录
mkdir -p "$SYMBOLS_DIR"

echo "目标目录: $SYMBOLS_DIR"
echo ""

# 检查是否已有符号
if [ -d "$SYMBOLS_DIR" ] && [ "$(ls -A $SYMBOLS_DIR)" ]; then
    echo "已存在的系统符号版本:"
    ls -1 "$SYMBOLS_DIR"
    echo ""
fi

echo "请选择下载方式:"
echo "1. 从 GitHub 下载（推荐）"
echo "2. 手动指定下载链接"
echo "3. 从本地文件导入"
echo "4. 连接真机设备（需要 Xcode）"
echo ""
read -p "请输入选项 (1-4): " choice

case $choice in
    1)
        echo ""
        echo "从 GitHub 下载系统符号..."
        echo "常用的 GitHub 仓库:"
        echo "  - https://github.com/Zuikyo/iOS-System-Symbols"
        echo "  - https://github.com/QiuChenly/iOS-DeviceSupport"
        echo ""
        echo "请访问上述仓库，下载需要的 iOS 版本符号文件"
        echo "下载后运行此脚本选择选项 3 导入"
        ;;
    2)
        echo ""
        read -p "请输入下载链接: " download_url
        echo "开始下载..."
        mkdir -p "$TEMP_DIR"
        cd "$TEMP_DIR"
        
        if curl -L -o symbols.zip "$download_url"; then
            echo "下载完成，开始解压..."
            unzip -q symbols.zip
            
            # 查找解压后的目录
            for dir in */; do
                if [[ $dir == *"DeviceSupport"* ]] || [[ $dir =~ [0-9]+\.[0-9]+ ]]; then
                    echo "找到符号目录: $dir"
                    cp -r "$dir"* "$SYMBOLS_DIR/"
                fi
            done
            
            echo "导入完成！"
            rm -rf "$TEMP_DIR"
        else
            echo "下载失败！"
            exit 1
        fi
        ;;
    3)
        echo ""
        read -p "请输入符号文件路径 (支持 .zip 或目录): " symbols_path
        
        if [ ! -e "$symbols_path" ]; then
            echo "错误: 文件或目录不存在"
            exit 1
        fi
        
        if [ -f "$symbols_path" ]; then
            # 是文件，尝试解压
            echo "解压文件..."
            mkdir -p "$TEMP_DIR"
            
            if [[ $symbols_path == *.zip ]]; then
                unzip -q "$symbols_path" -d "$TEMP_DIR"
            elif [[ $symbols_path == *.tar.gz ]] || [[ $symbols_path == *.tgz ]]; then
                tar -xzf "$symbols_path" -C "$TEMP_DIR"
            else
                echo "不支持的文件格式"
                exit 1
            fi
            
            # 复制到目标目录
            for dir in "$TEMP_DIR"/*; do
                if [ -d "$dir" ]; then
                    cp -r "$dir" "$SYMBOLS_DIR/"
                fi
            done
            
            rm -rf "$TEMP_DIR"
        else
            # 是目录，直接复制
            echo "复制目录..."
            cp -r "$symbols_path"/* "$SYMBOLS_DIR/"
        fi
        
        echo "导入完成！"
        ;;
    4)
        echo ""
        echo "请按照以下步骤操作:"
        echo "1. 使用 USB 连接 iOS 设备到 Mac"
        echo "2. 打开 Xcode"
        echo "3. 选择 Window > Devices and Simulators"
        echo "4. 选择你的设备"
        echo "5. 等待 Xcode 显示 'Preparing device for development...'"
        echo "6. 等待完成后，符号会自动下载到:"
        echo "   $SYMBOLS_DIR"
        echo ""
        echo "按任意键继续..."
        read -n 1
        ;;
    *)
        echo "无效的选项"
        exit 1
        ;;
esac

echo ""
echo "=========================================="
echo "当前已安装的系统符号:"
echo "=========================================="
if [ -d "$SYMBOLS_DIR" ] && [ "$(ls -A $SYMBOLS_DIR)" ]; then
    ls -lh "$SYMBOLS_DIR"
    echo ""
    echo "总大小:"
    du -sh "$SYMBOLS_DIR"
else
    echo "暂无系统符号"
fi

echo ""
echo "=========================================="
echo "配置完成！"
echo "=========================================="
echo ""
echo "下一步:"
echo "1. 重启后端服务: npm run dev"
echo "2. 查看日志确认系统符号化已启用"
echo "3. 尝试符号化包含系统库的崩溃日志"
echo ""
