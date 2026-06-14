#!/bin/bash

# 停止开发环境脚本

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SONIC_AGENT_PID_FILE="${SONIC_AGENT_PID_FILE:-$PROJECT_ROOT/nn-ios-platform-data/sonic-agent.pid}"

echo "🛑 停止开发服务..."

# 停止后端 (端口 3001)
if lsof -ti:3001 > /dev/null 2>&1; then
    echo "停止后端服务 (端口 3001)..."
    lsof -ti:3001 | xargs kill -9 2>/dev/null || true
    echo "✅ 后端服务已停止"
else
    echo "ℹ️  后端服务未运行"
fi

# 停止前端 (端口 5173)
if lsof -ti:5173 > /dev/null 2>&1; then
    echo "停止前端服务 (端口 5173)..."
    lsof -ti:5173 | xargs kill -9 2>/dev/null || true
    echo "✅ 前端服务已停止"
else
    echo "ℹ️  前端服务未运行"
fi

if [ -f "$SONIC_AGENT_PID_FILE" ]; then
    SONIC_AGENT_PID="$(cat "$SONIC_AGENT_PID_FILE" 2>/dev/null || true)"
    if [ -n "$SONIC_AGENT_PID" ] && kill -0 "$SONIC_AGENT_PID" >/dev/null 2>&1; then
        echo "停止 Sonic Agent (PID $SONIC_AGENT_PID)..."
        kill "$SONIC_AGENT_PID" 2>/dev/null || true
        echo "✅ Sonic Agent 已停止"
    else
        echo "ℹ️  Sonic Agent 未运行"
    fi
    rm -f "$SONIC_AGENT_PID_FILE"
fi

echo "🎉 所有服务已停止"
