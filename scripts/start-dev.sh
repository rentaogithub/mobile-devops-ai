#!/bin/bash

# 一键启动开发环境脚本
# 解决启动顺序问题：先启动后端，再启动前端

set -e

# Node 26 的实际路径
NODE_BIN="/opt/homebrew/Cellar/node/26.0.0/bin/node"
NPM_BIN="/opt/homebrew/Cellar/node/26.0.0/bin/npm"

# 确保使用正确的 Node 版本
export PATH="/opt/homebrew/opt/node/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"

echo "🚀 启动 iOS 崩溃日志符号化系统开发环境"
echo "========================================"

# 1. 检查依赖
echo "🔍 检查依赖..."
if [ ! -d "$BACKEND_DIR/node_modules" ] || [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo "📦 安装依赖..."
    cd "$PROJECT_ROOT"
    "$NPM_BIN" install
fi

# 2. 启动后端
echo "🔄 启动后端服务..."
cd "$BACKEND_DIR"
if lsof -ti:3000 > /dev/null 2>&1; then
    echo "✅ 后端服务已在运行 (端口 3000)"
else
    # 在后台启动后端
    "$NPM_BIN" run dev > "$PROJECT_ROOT/backend-dev.log" 2>&1 &
    BACKEND_PID=$!
    echo "📝 后端进程 PID: $BACKEND_PID"
    
    # 等待后端启动
    echo "⏳ 等待后端服务启动..."
    for i in {1..30}; do
        if lsof -ti:3000 > /dev/null 2>&1; then
            echo "✅ 后端服务启动成功"
            break
        fi
        if [ $i -eq 30 ]; then
            echo "❌ 后端服务启动超时"
            echo "查看日志: tail -f $PROJECT_ROOT/backend-dev.log"
            kill $BACKEND_PID 2>/dev/null || true
            exit 1
        fi
        sleep 1
    done
fi

# 3. 启动前端
echo "🔄 启动前端服务..."
cd "$FRONTEND_DIR"

# 检查端口 5173 是否被占用
if lsof -ti:5173 > /dev/null 2>&1; then
    echo "⚠️  端口 5173 已被占用，尝试释放..."
    lsof -ti:5173 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# 启动前端
"$NPM_BIN" run dev -- --port 5173 > "$PROJECT_ROOT/frontend-dev.log" 2>&1 &
FRONTEND_PID=$!
echo "📝 前端进程 PID: $FRONTEND_PID"

# 等待前端启动
echo "⏳ 等待前端服务启动..."
for i in {1..15}; do
    if lsof -ti:5173 > /dev/null 2>&1; then
        echo "✅ 前端服务启动成功"
        break
    fi
    if [ $i -eq 15 ]; then
        echo "❌ 前端服务启动失败"
        echo "查看日志: tail -f $PROJECT_ROOT/frontend-dev.log"
        kill $FRONTEND_PID 2>/dev/null || true
        exit 1
    fi
    sleep 1
done

echo ""
echo "========================================"
echo "🎉 开发环境启动完成！"
echo ""
echo "🔗 访问地址:"
echo "   前端: http://localhost:5173"
echo "   后端: http://localhost:3000"
echo ""
echo "📋 进程信息:"
echo "   后端 PID: $BACKEND_PID"
echo "   前端 PID: $FRONTEND_PID"
echo ""
echo "📝 日志文件:"
echo "   后端: $PROJECT_ROOT/backend-dev.log"
echo "   前端: $PROJECT_ROOT/frontend-dev.log"
echo ""
echo "🛑 停止服务:"
echo "   kill $BACKEND_PID $FRONTEND_PID"
echo "========================================"

# 等待用户中断
trap "echo '🛑 停止服务...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true; exit 0" INT TERM
wait
