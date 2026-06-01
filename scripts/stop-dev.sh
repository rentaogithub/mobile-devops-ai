#!/bin/bash

# 停止开发环境脚本

echo "🛑 停止开发服务..."

# 停止后端 (端口 3000)
if lsof -ti:3000 > /dev/null 2>&1; then
    echo "停止后端服务 (端口 3000)..."
    lsof -ti:3000 | xargs kill -9 2>/dev/null || true
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

echo "🎉 所有服务已停止"
