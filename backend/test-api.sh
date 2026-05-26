#!/bin/bash

echo "=== iOS 崩溃日志符号化系统 API 测试 ==="
echo ""

# 测试健康检查
echo "1. 测试健康检查接口"
curl -s http://localhost:3000/health | jq .
echo ""

# 测试获取 dSYM 列表
echo "2. 测试获取 dSYM 列表"
curl -s http://localhost:3000/api/dsym/list | jq .
echo ""

# 测试符号化接口（无崩溃日志）
echo "3. 测试符号化接口（应该返回错误）"
curl -s -X POST http://localhost:3000/api/symbolicate \
  -H "Content-Type: application/json" \
  -d '{"crashLog":""}' | jq .
echo ""

# 测试 404
echo "4. 测试 404 处理"
curl -s http://localhost:3000/api/notfound | jq .
echo ""

echo "=== 测试完成 ==="
