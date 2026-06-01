#!/bin/bash

# 确保后端服务在启动前端前已运行
# 解决前端代理连接失败问题

set -e

BACKEND_URL="http://127.0.0.1:3000"
MAX_RETRIES=30
RETRY_INTERVAL=2

echo "🔍 检查后端服务是否已启动..."

# 检查端口是否被监听
if lsof -ti:3000 > /dev/null 2>&1; then
    echo "✅ 端口 3000 已被监听"
else
    echo "❌ 端口 3000 未被监听，请先启动后端服务"
    echo "   在 backend/ 目录运行: npm run dev"
    exit 1
fi

# 检查后端 API 是否响应
for i in $(seq 1 $MAX_RETRIES); do
    if curl -s -f "$BACKEND_URL/api/health" > /dev/null 2>&1; then
        echo "✅ 后端服务已就绪 (尝试 $i 次)"
        exit 0
    fi
    
    if [ $i -lt $MAX_RETRIES ]; then
        echo "⏳ 等待后端服务启动... ($i/$MAX_RETRIES)"
        sleep $RETRY_INTERVAL
    fi
done

echo "❌ 后端服务启动超时，请检查后端日志"
echo "   前端代理将无法连接到后端 API"
exit 1
