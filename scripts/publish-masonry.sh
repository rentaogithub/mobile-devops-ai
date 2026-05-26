#!/bin/bash
# 将 Masonry 源码编译为二进制 framework 并发布到内部 Nexus 和 NNSpec 仓库
# 使用 pod lib create 生成合法 Xcode 工程，避免手写 pbxproj 的转义问题
#
# 用法: ./scripts/publish-masonry.sh [版本号] [输出类型]
# 示例:
#   ./scripts/publish-masonry.sh 1.1.0              # 编译为 framework（默认）
#   ./scripts/publish-masonry.sh 1.1.0 static_library  # 编译为 .a 静态库

set -e

VERSION="${1:-1.1.0}"
OUTPUT_TYPE="${2:-static_library}"
COMPONENT_NAME="Masonry"
BACKEND_URL="http://localhost:3000"
ADMIN_PASSWORD="huyu1234"

echo "=== 发布 ${COMPONENT_NAME}@${VERSION} (${OUTPUT_TYPE}) 到内部仓库 ==="
echo ""
echo "方案: 通过后端 API 触发源码编译 (pod lib create + xcodebuild)"
echo ""

# 调用后端 API 进行源码编译 + 发布
echo "[1/1] 调用后端 API: 源码编译并发布..."
echo "  组件: ${COMPONENT_NAME}"
echo "  版本: ${VERSION}"
echo "  输出: ${OUTPUT_TYPE}"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BACKEND_URL}/api/pods/official/import" \
  -H "Authorization: Bearer ${ADMIN_PASSWORD}" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"${COMPONENT_NAME}\",
    \"version\": \"${VERSION}\",
    \"buildBinary\": true,
    \"outputType\": \"${OUTPUT_TYPE}\"
  }")

# 分离 HTTP body 和 status code
HTTP_BODY=$(echo "${RESPONSE}" | head -n -1)
HTTP_CODE=$(echo "${RESPONSE}" | tail -1)

echo "  HTTP 状态码: ${HTTP_CODE}"

if [ "${HTTP_CODE}" -ge 200 ] && [ "${HTTP_CODE}" -lt 300 ]; then
  SUCCESS=$(echo "${HTTP_BODY}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success', False))" 2>/dev/null || echo "false")

  if [ "${SUCCESS}" = "True" ] || [ "${SUCCESS}" = "true" ]; then
    echo ""
    echo "✅ 发布成功!"
    STATUS=$(echo "${HTTP_BODY}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('status','unknown'))" 2>/dev/null || echo "unknown")
    NEXUS_URL=$(echo "${HTTP_BODY}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('source_zip_url',''))" 2>/dev/null || echo "")
    echo "  状态: ${STATUS}"
    echo "  Nexus: ${NEXUS_URL:-http://172.31.4.4:9091/repository/nn_ios/${COMPONENT_NAME}/${VERSION}.zip}"
    echo ""
    echo "使用方式 (Podfile):"
    echo "  pod '${COMPONENT_NAME}', '${VERSION}'"
  else
    echo ""
    echo "❌ 发布失败"
    ERROR=$(echo "${HTTP_BODY}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','未知错误'))" 2>/dev/null || echo "未知错误")
    echo "  错误: ${ERROR}"
    exit 1
  fi
else
  echo ""
  echo "❌ 请求失败 (HTTP ${HTTP_CODE})"
  echo "  响应: ${HTTP_BODY}"
  echo ""
  echo "请确认:"
  echo "  1. 后端服务已启动: ${BACKEND_URL}"
  echo "  2. 管理员密码正确"
  echo "  3. 服务器已安装 CocoaPods (pod --version)"
  exit 1
fi

echo ""
echo "=== 完成 ==="
