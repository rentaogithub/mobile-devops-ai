#!/bin/bash
# 将 WechatOpenSDK 官方版本发布到内部 Nexus 和 NNSpec 仓库
# 用法: ./scripts/publish-wechat-sdk.sh [版本号]
# 示例: ./scripts/publish-wechat-sdk.sh 2.0.5

set -e

VERSION="${1:-2.0.5}"
COMPONENT_NAME="WechatOpenSDK"
BACKEND_URL="http://localhost:3000"
ADMIN_PASSWORD="huyu1234"

OFFICIAL_URL="https://dldir1.qq.com/WechatWebDev/opensdk/cocoapods/OpenSDK${VERSION}.zip"
TEMP_DIR=$(mktemp -d)
ZIP_FILE="${TEMP_DIR}/OpenSDK${VERSION}.zip"

echo "=== 发布 ${COMPONENT_NAME}@${VERSION} 到内部仓库 ==="
echo ""

# 1. 下载官方 zip
echo "[1/3] 下载官方 SDK: ${OFFICIAL_URL}"
curl -L -o "${ZIP_FILE}" "${OFFICIAL_URL}"
if [ ! -f "${ZIP_FILE}" ]; then
  echo "错误: 下载失败"
  rm -rf "${TEMP_DIR}"
  exit 1
fi
FILE_SIZE=$(ls -lh "${ZIP_FILE}" | awk '{print $5}')
echo "  下载完成: ${FILE_SIZE}"

# 2. 通过 API 发布到内部仓库
echo "[2/3] 发布到内部 Nexus 和 NNSpec..."
RESPONSE=$(curl -s -X POST "${BACKEND_URL}/api/pods/publish" \
  -H "Authorization: Bearer ${ADMIN_PASSWORD}" \
  -F "file=@${ZIP_FILE}" \
  -F "name=${COMPONENT_NAME}" \
  -F "version=${VERSION}" \
  -F "lib_type=static_library" \
  -F "lib_name=libWechatOpenSDK.a" \
  -F "sys_frameworks=Security,UIKit,CoreGraphics,WebKit" \
  -F "sys_libraries=z,sqlite3.0,c++")

echo "  API 响应: ${RESPONSE}"

# 3. 检查结果
SUCCESS=$(echo "${RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success', False))" 2>/dev/null || echo "false")
if [ "${SUCCESS}" = "True" ] || [ "${SUCCESS}" = "true" ]; then
  echo "[3/3] 发布成功!"
  STATUS=$(echo "${RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('status','unknown'))" 2>/dev/null || echo "unknown")
  echo "  状态: ${STATUS}"
  echo "  Nexus: http://172.31.4.4:9091/repository/nn_ios/${COMPONENT_NAME}/${VERSION}.zip"
else
  echo "[3/3] 发布失败"
  ERROR=$(echo "${RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','未知错误'))" 2>/dev/null || echo "未知错误")
  echo "  错误: ${ERROR}"
fi

# 清理
rm -rf "${TEMP_DIR}"
echo ""
echo "=== 完成 ==="
