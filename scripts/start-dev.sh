#!/bin/bash

# 一键启动开发环境脚本
# 解决启动顺序问题：先启动后端，再启动前端

set -e

# Node 26 的实际路径
NODE_BIN="/opt/homebrew/Cellar/node/26.0.0/bin/node"
NPM_CLI="/opt/homebrew/Cellar/node/26.0.0/libexec/lib/node_modules/npm/bin/npm-cli.js"

# npm 命令封装
function run_npm() {
    "$NODE_BIN" "$NPM_CLI" "$@"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
ENV_BACKEND_PORT=""
if [ -f "$BACKEND_DIR/.env" ]; then
    ENV_BACKEND_PORT="$(awk -F= '/^PORT=/{print $2; exit}' "$BACKEND_DIR/.env" | tr -d '[:space:]')"
fi
BACKEND_PORT="${BACKEND_PORT:-${ENV_BACKEND_PORT:-3000}}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
BACKEND_PID=""
FRONTEND_PID=""

echo "🚀 启动 iOS 崩溃日志符号化系统开发环境"
echo "========================================"

# 1. 检查依赖
echo "🔍 检查依赖..."
if [ ! -d "$BACKEND_DIR/node_modules" ] || [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo "📦 安装依赖..."
    cd "$PROJECT_ROOT"
    run_npm install
fi

# 2. 启动 Sonic Server/Web + Agent
echo "🔄 启动 Sonic 相关服务..."
cd "$PROJECT_ROOT"
run_npm run start:sonic | tee "$PROJECT_ROOT/sonic-dev.log" || true

echo "🔍 Sonic 服务状态:"
if command -v docker >/dev/null 2>&1; then
    if docker ps >/dev/null 2>&1; then
        docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' | sed 's/^/   /'
    else
        echo "   Docker 当前不可用或未启动"
    fi
else
    echo "   Docker 未安装"
fi

if lsof -ti:3002 > /dev/null 2>&1; then
    echo "   ✅ Sonic Web: http://127.0.0.1:3002"
else
    echo "   ⚠️  Sonic Web 未监听 3002"
fi

if lsof -ti:8094 > /dev/null 2>&1; then
    echo "   ✅ Sonic API: http://127.0.0.1:8094"
else
    echo "   ⚠️  Sonic API 未监听 8094"
fi

if [ -f "$PROJECT_ROOT/nn-ios-platform-data/sonic-agent.pid" ]; then
    SONIC_AGENT_PID="$(cat "$PROJECT_ROOT/nn-ios-platform-data/sonic-agent.pid" 2>/dev/null || true)"
    if [ -n "$SONIC_AGENT_PID" ] && kill -0 "$SONIC_AGENT_PID" >/dev/null 2>&1; then
        echo "   ✅ Sonic Agent PID: $SONIC_AGENT_PID"
    else
        echo "   ⚠️  Sonic Agent PID 文件存在，但进程未运行"
    fi
else
    echo "   ⚠️  Sonic Agent 未配置或未启动"
fi
echo "   详细诊断: sh scripts/check-sonic-stack.sh"

# 3. 启动后端
echo "🔄 启动后端服务..."
cd "$BACKEND_DIR"
if lsof -ti:$BACKEND_PORT > /dev/null 2>&1; then
    echo "✅ 后端服务已在运行 (端口 $BACKEND_PORT)"
else
    # 在后台启动后端
    run_npm run dev > "$PROJECT_ROOT/backend-dev.log" 2>&1 &
    BACKEND_PID=$!
    echo "📝 后端进程 PID: $BACKEND_PID"
    
    # 等待后端启动
    echo "⏳ 等待后端服务启动..."
    for i in {1..30}; do
        if lsof -ti:$BACKEND_PORT > /dev/null 2>&1; then
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

# 4. 启动前端
echo "🔄 启动前端服务..."
cd "$FRONTEND_DIR"

# 检查端口是否被占用
if lsof -ti:$FRONTEND_PORT > /dev/null 2>&1; then
    echo "⚠️  端口 $FRONTEND_PORT 已被占用，尝试释放..."
    lsof -ti:$FRONTEND_PORT | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# 启动前端
run_npm run dev -- --port "$FRONTEND_PORT" > "$PROJECT_ROOT/frontend-dev.log" 2>&1 &
FRONTEND_PID=$!
echo "📝 前端进程 PID: $FRONTEND_PID"

# 等待前端启动
echo "⏳ 等待前端服务启动..."
for i in {1..15}; do
    if lsof -ti:$FRONTEND_PORT > /dev/null 2>&1; then
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
echo "   前端: http://localhost:$FRONTEND_PORT"
echo "   后端: http://localhost:$BACKEND_PORT"
echo "   Sonic: http://localhost:$FRONTEND_PORT/sonic-admin"
echo ""
echo "📋 进程信息:"
echo "   后端 PID: $BACKEND_PID"
echo "   前端 PID: $FRONTEND_PID"
echo ""
echo "📝 日志文件:"
echo "   后端: $PROJECT_ROOT/backend-dev.log"
echo "   前端: $PROJECT_ROOT/frontend-dev.log"
echo "   Sonic: $PROJECT_ROOT/sonic-dev.log"
echo ""
echo "🛑 停止服务:"
echo "   kill $BACKEND_PID $FRONTEND_PID"
echo "========================================"

# 等待用户中断
trap "echo '🛑 停止服务...'; [ -n \"$BACKEND_PID\" ] && kill $BACKEND_PID 2>/dev/null || true; [ -n \"$FRONTEND_PID\" ] && kill $FRONTEND_PID 2>/dev/null || true; exit 0" INT TERM
wait
