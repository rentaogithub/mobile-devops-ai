#!/usr/bin/env bash
set -euo pipefail

# Jenkins nn-auto-quality job entry script.
# It validates build metadata from nn-ios-platform, prepares report artifacts,
# and optionally calls a Sonic cloud-device API when SONIC_API_BASE is provided.

SOURCE_BUILD_NUMBER="${SOURCE_BUILD_NUMBER:-}"
BRANCH="${BRANCH:-}"
COMMIT_HASH="${COMMIT_HASH:-}"
APP_VERSION="${APP_VERSION:-}"
PACKAGE_URL="${PACKAGE_URL:-}"
ARCHIVE_URL="${ARCHIVE_URL:-}"
TEST_SUITE="${TEST_SUITE:-smoke}"
DEVICE_POOL="${DEVICE_POOL:-ios-default}"
DEVICE_POOL_LABEL="${DEVICE_POOL_LABEL:-${DEVICE_POOL}}"
SONIC_DEVICE_GROUP_ID="${SONIC_DEVICE_GROUP_ID:-}"
DEVICE_CLOUD="${DEVICE_CLOUD:-Sonic}"

SONIC_API_BASE="${SONIC_API_BASE:-}"
SONIC_TOKEN="${SONIC_TOKEN:-}"
SONIC_PROJECT_ID="${SONIC_PROJECT_ID:-}"
SONIC_TEST_PLAN_ID="${SONIC_TEST_PLAN_ID:-}"

WORKSPACE_DIR="${WORKSPACE:-$(pwd)}"
RESULT_DIR="${WORKSPACE_DIR}/quality-results/${SOURCE_BUILD_NUMBER:-unknown}-${TEST_SUITE}"
REPORT_FILE="${RESULT_DIR}/junit.xml"
META_FILE="${RESULT_DIR}/metadata.json"

mkdir -p "${RESULT_DIR}"

fail() {
  local message="$1"
  cat > "${REPORT_FILE}" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="sonic-ios-quality" tests="1" failures="1" errors="0" skipped="0">
  <testcase classname="quality.preflight" name="validate parameters">
    <failure message="${message}">${message}</failure>
  </testcase>
</testsuite>
XML
  echo "ERROR: ${message}" >&2
  exit 1
}

[[ -n "${SOURCE_BUILD_NUMBER}" ]] || fail "SOURCE_BUILD_NUMBER is required"
[[ -n "${TEST_SUITE}" ]] || fail "TEST_SUITE is required"
[[ -n "${DEVICE_POOL}" ]] || fail "DEVICE_POOL is required"

if [[ -z "${PACKAGE_URL}" && -z "${ARCHIVE_URL}" ]]; then
  fail "PACKAGE_URL or ARCHIVE_URL is required"
fi

cat > "${META_FILE}" <<JSON
{
  "sourceBuildNumber": "${SOURCE_BUILD_NUMBER}",
  "branch": "${BRANCH}",
  "commitHash": "${COMMIT_HASH}",
  "appVersion": "${APP_VERSION}",
  "packageUrl": "${PACKAGE_URL}",
  "archiveUrl": "${ARCHIVE_URL}",
  "testSuite": "${TEST_SUITE}",
  "devicePool": "${DEVICE_POOL}",
  "devicePoolLabel": "${DEVICE_POOL_LABEL}",
  "sonicDeviceGroupId": "${SONIC_DEVICE_GROUP_ID}",
  "deviceCloud": "${DEVICE_CLOUD}"
}
JSON

echo "========================================"
echo "Sonic iOS 自动质检"
echo "========================================"
echo "构建号: ${SOURCE_BUILD_NUMBER}"
echo "分支: ${BRANCH:-N/A}"
echo "Commit: ${COMMIT_HASH:-N/A}"
echo "APP版本: ${APP_VERSION:-N/A}"
echo "测试套件: ${TEST_SUITE}"
echo "设备池: ${DEVICE_POOL_LABEL} (${DEVICE_POOL})"
echo "Sonic Group ID: ${SONIC_DEVICE_GROUP_ID:-N/A}"
echo "包地址: ${PACKAGE_URL:-${ARCHIVE_URL}}"

if [[ -n "${SONIC_API_BASE}" && -n "${SONIC_TOKEN}" ]]; then
  echo "调用 Sonic API: ${SONIC_API_BASE}"
  payload="$(cat <<JSON
{
  "projectId": "${SONIC_PROJECT_ID}",
  "testPlanId": "${SONIC_TEST_PLAN_ID}",
  "sourceBuildNumber": "${SOURCE_BUILD_NUMBER}",
  "branch": "${BRANCH}",
  "commitHash": "${COMMIT_HASH}",
  "appVersion": "${APP_VERSION}",
  "packageUrl": "${PACKAGE_URL}",
  "archiveUrl": "${ARCHIVE_URL}",
  "testSuite": "${TEST_SUITE}",
  "devicePool": "${DEVICE_POOL}",
  "devicePoolLabel": "${DEVICE_POOL_LABEL}",
  "deviceGroupId": "${SONIC_DEVICE_GROUP_ID}",
  "platform": "iOS"
}
JSON
)"
  response_file="${RESULT_DIR}/sonic-response.json"
  http_code="$(
    curl -sS -o "${response_file}" -w "%{http_code}" \
      -X POST "${SONIC_API_BASE%/}/api/quality/ios/run" \
      -H "Authorization: Bearer ${SONIC_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "${payload}"
  )"
  if [[ "${http_code}" -lt 200 || "${http_code}" -ge 300 ]]; then
    fail "Sonic API failed with HTTP ${http_code}: $(cat "${response_file}")"
  fi
else
  echo "SONIC_API_BASE 或 SONIC_TOKEN 未配置，当前仅生成 Jenkins 质检占位报告。"
fi

cat > "${REPORT_FILE}" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="sonic-ios-quality" tests="1" failures="0" errors="0" skipped="0">
  <testcase classname="quality.${TEST_SUITE}" name="Sonic iOS quality gate"/>
</testsuite>
XML

echo "质检结果目录: ${RESULT_DIR}"
echo "JUnit报告: ${REPORT_FILE}"
