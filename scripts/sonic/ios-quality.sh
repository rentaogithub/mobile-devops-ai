#!/usr/bin/env bash
set -euo pipefail

# Jenkins nn-auto-quality job entry script.
# The stable default path is local Mac + USB iPhone. Sonic remains optional and
# can be integrated by a downstream script later, but platform startup and QA no
# longer depend on a Sonic Server/Web stack.

SOURCE_BUILD_NUMBER="${SOURCE_BUILD_NUMBER:-}"
BRANCH="${BRANCH:-}"
COMMIT_HASH="${COMMIT_HASH:-}"
APP_VERSION="${APP_VERSION:-}"
PACKAGE_URL="${PACKAGE_URL:-}"
ARCHIVE_URL="${ARCHIVE_URL:-}"
TEST_SUITE="${TEST_SUITE:-smoke}"
DEVICE_POOL="${DEVICE_POOL:-ios-default}"
DEVICE_POOL_LABEL="${DEVICE_POOL_LABEL:-${DEVICE_POOL}}"
DEVICE_UDID="${DEVICE_UDID:-${DEVICE_SELECTOR:-}}"
DEVICE_CLOUD="${DEVICE_CLOUD:-LocalMac}"
APP_BUNDLE_ID="${APP_BUNDLE_ID:-com.nnhuyu.im}"

WORKSPACE_DIR="${WORKSPACE:-$(pwd)}"
RESULT_DIR="${WORKSPACE_DIR}/quality-results/${SOURCE_BUILD_NUMBER:-unknown}-${TEST_SUITE}"
REPORT_FILE="${RESULT_DIR}/junit.xml"
META_FILE="${RESULT_DIR}/metadata.json"
LOG_FILE="${RESULT_DIR}/quality.log"
IPA_FILE="${RESULT_DIR}/app.ipa"

mkdir -p "${RESULT_DIR}"

log() {
  echo "$@" | tee -a "${LOG_FILE}"
}

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

write_report() {
  local failures="$1"
  local message="${2:-}"
  if [ "${failures}" = "0" ]; then
    cat > "${REPORT_FILE}" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="local-ios-quality" tests="1" failures="0" errors="0" skipped="0">
  <testcase classname="quality.${TEST_SUITE}" name="Local iOS quality gate"/>
</testsuite>
XML
    return
  fi

  local escaped
  escaped="$(xml_escape "${message}")"
  cat > "${REPORT_FILE}" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="local-ios-quality" tests="1" failures="1" errors="0" skipped="0">
  <testcase classname="quality.preflight" name="Local iOS quality gate">
    <failure message="${escaped}">${escaped}</failure>
  </testcase>
</testsuite>
XML
}

fail() {
  local message="$1"
  log "ERROR: ${message}"
  write_report 1 "${message}"
  exit 1
}

find_tidevice() {
  if command -v tidevice >/dev/null 2>&1; then
    command -v tidevice
    return
  fi
  if command -v python3 >/dev/null 2>&1 && python3 -m tidevice version >/dev/null 2>&1; then
    echo "python3 -m tidevice"
    return
  fi
  echo ""
}

select_device() {
  local tidevice_cmd="$1"
  if [ -n "${DEVICE_UDID}" ]; then
    echo "${DEVICE_UDID}"
    return
  fi

  # tidevice list output is usually: UDID DeviceName
  ${tidevice_cmd} list 2>/dev/null | awk 'NF >= 1 {print $1; exit}'
}

download_ipa() {
  if [ -z "${PACKAGE_URL}" ]; then
    return 1
  fi
  case "${PACKAGE_URL}" in
    http://*|https://*)
      curl -L --fail --connect-timeout 15 --max-time 600 -o "${IPA_FILE}" "${PACKAGE_URL}"
      ;;
    file://*)
      cp "${PACKAGE_URL#file://}" "${IPA_FILE}"
      ;;
    /*)
      cp "${PACKAGE_URL}" "${IPA_FILE}"
      ;;
    *)
      return 1
      ;;
  esac
  [ -s "${IPA_FILE}" ]
}

[[ -n "${SOURCE_BUILD_NUMBER}" ]] || fail "SOURCE_BUILD_NUMBER is required"
[[ -n "${TEST_SUITE}" ]] || fail "TEST_SUITE is required"
[[ -n "${DEVICE_POOL}" ]] || fail "DEVICE_POOL is required"

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
  "deviceUdid": "${DEVICE_UDID}",
  "deviceCloud": "${DEVICE_CLOUD}",
  "runner": "local-ios-device"
}
JSON

log "========================================"
log "本机 iOS 真机自动质检"
log "========================================"
log "源构建: ${SOURCE_BUILD_NUMBER}"
log "分支: ${BRANCH:-N/A}"
log "Commit: ${COMMIT_HASH:-N/A}"
log "APP版本: ${APP_VERSION:-N/A}"
log "测试套件: ${TEST_SUITE}"
log "设备池: ${DEVICE_POOL_LABEL} (${DEVICE_POOL})"
log "指定设备: ${DEVICE_UDID:-自动选择第一台 USB iPhone}"
log "包地址: ${PACKAGE_URL:-${ARCHIVE_URL:-N/A}}"

TIDEVICE_CMD="$(find_tidevice)"
if [ -z "${TIDEVICE_CMD}" ]; then
  fail "未找到 tidevice。请在打包机安装：python3 -m pipx install tidevice 或 python3 -m pip install --user tidevice"
fi

log "tidevice: ${TIDEVICE_CMD}"
log "当前连接设备:"
${TIDEVICE_CMD} list | tee -a "${LOG_FILE}" || true

SELECTED_DEVICE="$(select_device "${TIDEVICE_CMD}")"
if [ -z "${SELECTED_DEVICE}" ]; then
  fail "未发现 USB 连接的 iPhone。请确认真机已连接打包机并完成信任。"
fi
log "使用设备: ${SELECTED_DEVICE}"

if ! download_ipa; then
  fail "无法获取 IPA。请确保 Jenkins 传入 PACKAGE_URL，且该地址可被打包机下载。ARCHIVE_URL=${ARCHIVE_URL:-N/A}"
fi
log "IPA: ${IPA_FILE}"

log "安装 IPA..."
${TIDEVICE_CMD} --udid "${SELECTED_DEVICE}" install "${IPA_FILE}" 2>&1 | tee -a "${LOG_FILE}"

if [ -n "${APP_BUNDLE_ID}" ]; then
  log "启动 App: ${APP_BUNDLE_ID}"
  ${TIDEVICE_CMD} --udid "${SELECTED_DEVICE}" launch "${APP_BUNDLE_ID}" 2>&1 | tee -a "${LOG_FILE}" || {
    fail "安装成功但启动失败：${APP_BUNDLE_ID}"
  }
fi

log "等待基础启动稳定..."
sleep 5

write_report 0
log "质检结果目录: ${RESULT_DIR}"
log "JUnit报告: ${REPORT_FILE}"
