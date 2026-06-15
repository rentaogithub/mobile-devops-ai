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
XCARCHIVE_PATH="${XCARCHIVE_PATH:-}"
ARCHIVE_URL="${ARCHIVE_URL:-}"
TEST_SUITE="${TEST_SUITE:-smoke}"
DEVICE_POOL="${DEVICE_POOL:-ios-default}"
DEVICE_POOL_LABEL="${DEVICE_POOL_LABEL:-${DEVICE_POOL}}"
DEVICE_UDID="${DEVICE_UDID:-${DEVICE_SELECTOR:-}}"
DEVICE_CLOUD="${DEVICE_CLOUD:-LocalMac}"
APP_BUNDLE_ID="${APP_BUNDLE_ID:-com.nndev.im}"
DETECTED_BUNDLE_ID=""

export PATH="$HOME/.local/bin:$HOME/Library/Python/3.9/bin:$HOME/Library/Python/3.10/bin:$HOME/Library/Python/3.11/bin:$HOME/Library/Python/3.12/bin:$HOME/Library/Python/3.13/bin:$HOME/Library/Python/3.14/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

WORKSPACE_DIR="${WORKSPACE:-$(pwd)}"
RESULT_DIR="${WORKSPACE_DIR}/quality-results/${SOURCE_BUILD_NUMBER:-unknown}-${TEST_SUITE}"
REPORT_FILE="${RESULT_DIR}/junit.xml"
META_FILE="${RESULT_DIR}/metadata.json"
SUMMARY_FILE="${RESULT_DIR}/summary.json"
LOG_FILE="${RESULT_DIR}/quality.log"
IPA_FILE="${RESULT_DIR}/app.ipa"
SCREENSHOT_FILE="${RESULT_DIR}/screenshot.png"
DEVICE_LOG_FILE="${RESULT_DIR}/device.log"
PROCESS_FILE="${RESULT_DIR}/processes.json"
LAUNCH_METHOD=""

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
  write_summary "failed" "${message}" || true
  write_report 1 "${message}"
  exit 1
}

write_summary() {
  local status="$1"
  local message="${2:-}"
  python3 - "$SUMMARY_FILE" \
    "$status" "$message" "${SOURCE_BUILD_NUMBER:-}" "${BRANCH:-}" "${COMMIT_HASH:-}" "${APP_VERSION:-}" \
    "${TEST_SUITE:-}" "${DEVICE_POOL:-}" "${DEVICE_POOL_LABEL:-}" "${SELECTED_DEVICE:-}" "${LAUNCH_BUNDLE_ID:-}" \
    "${DETECTED_BUNDLE_ID:-}" "${LAUNCH_METHOD:-}" "${RESULT_DIR:-}" "${SCREENSHOT_FILE:-}" "${DEVICE_LOG_FILE:-}" "${PROCESS_FILE:-}" <<'PY'
import json
import os
import sys

summary_path = sys.argv[1]
(
    status,
    message,
    source_build_number,
    branch,
    commit_hash,
    app_version,
    test_suite,
    device_pool,
    device_pool_label,
    device_udid,
    launch_bundle_id,
    detected_bundle_id,
    launch_method,
    result_dir,
    screenshot_file,
    device_log_file,
    process_file,
) = sys.argv[2:19]

def rel(path):
    if not path:
        return ""
    try:
        return os.path.relpath(path, result_dir)
    except Exception:
        return path

data = {
    "status": status,
    "message": message,
    "sourceBuildNumber": source_build_number,
    "branch": branch,
    "commitHash": commit_hash,
    "appVersion": app_version,
    "testSuite": test_suite,
    "devicePool": device_pool,
    "devicePoolLabel": device_pool_label,
    "deviceUdid": device_udid,
    "bundleId": launch_bundle_id,
    "detectedBundleId": detected_bundle_id,
    "launchMethod": launch_method,
    "artifacts": {
        "screenshot": rel(screenshot_file) if os.path.exists(screenshot_file) else "",
        "deviceLog": rel(device_log_file) if os.path.exists(device_log_file) else "",
        "processes": rel(process_file) if os.path.exists(process_file) else "",
        "junit": "junit.xml",
        "qualityLog": "quality.log",
    },
}
with open(summary_path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
PY
}

find_tidevice() {
  if command -v tidevice >/dev/null 2>&1; then
    command -v tidevice
    return
  fi
  local candidate
  for candidate in \
    "$HOME/.local/bin/tidevice" \
    "$HOME/Library/Python/3.9/bin/tidevice" \
    "$HOME/Library/Python/3.10/bin/tidevice" \
    "$HOME/Library/Python/3.11/bin/tidevice" \
    "$HOME/Library/Python/3.12/bin/tidevice" \
    "$HOME/Library/Python/3.13/bin/tidevice" \
    "$HOME/Library/Python/3.14/bin/tidevice"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
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

  # tidevice list can print a table header. Pick the first real iOS UDID.
  ${tidevice_cmd} list 2>/dev/null | awk '
    NR == 1 && ($1 == "UDID" || $1 == "SerialNumber") { next }
    $1 ~ /^[0-9A-Fa-f-]{25,}$/ { print $1; exit }
  '
}

download_ipa() {
  local source_url="$1"
  if [ -z "${source_url}" ]; then
    return 1
  fi
  case "${source_url}" in
    http://*|https://*)
      curl -L --fail --connect-timeout 15 --max-time 600 -o "${IPA_FILE}" "${source_url}"
      ;;
    file://*)
      cp "${source_url#file://}" "${IPA_FILE}"
      ;;
    /*)
      cp "${source_url}" "${IPA_FILE}"
      ;;
    *)
      return 1
      ;;
  esac
  [ -s "${IPA_FILE}" ] || return 1
  if command -v unzip >/dev/null 2>&1; then
    unzip -l "${IPA_FILE}" 'Payload/*.app/*' >/dev/null 2>&1 || return 2
  fi
  return 0
}

read_bundle_id_from_plist() {
  local plist_path="$1"
  if [ -z "${plist_path}" ] || [ ! -f "${plist_path}" ]; then
    return 1
  fi
  if [ -x /usr/libexec/PlistBuddy ]; then
    /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${plist_path}" 2>/dev/null && return
  fi
  python3 -c 'import plistlib, sys; print(plistlib.load(open(sys.argv[1], "rb")).get("CFBundleIdentifier", ""))' "${plist_path}" 2>/dev/null
}

read_bundle_id_from_app() {
  local app_path="$1"
  read_bundle_id_from_plist "${app_path}/Info.plist"
}

detect_bundle_id_from_ipa() {
  if [ ! -s "${IPA_FILE}" ] || ! command -v unzip >/dev/null 2>&1; then
    return 1
  fi
  local tmp_dir plist_path bundle_id
  tmp_dir="$(mktemp -d "${RESULT_DIR}/ipa-info.XXXXXX")"
  unzip -q "${IPA_FILE}" 'Payload/*.app/Info.plist' -d "${tmp_dir}" >/dev/null 2>&1 || {
    rm -rf "${tmp_dir}"
    return 1
  }
  plist_path="$(find "${tmp_dir}/Payload" -path '*.app/Info.plist' -type f 2>/dev/null | head -n 1)"
  bundle_id="$(read_bundle_id_from_plist "${plist_path}" 2>/dev/null || true)"
  rm -rf "${tmp_dir}"
  if [ -n "${bundle_id}" ]; then
    DETECTED_BUNDLE_ID="${bundle_id}"
    return 0
  fi
  return 1
}

package_ipa_from_xcarchive() {
  local archive_path="$1"
  if [ -z "${archive_path}" ] || [ ! -d "${archive_path}" ]; then
    return 1
  fi

  local app_path
  app_path="$(find "${archive_path}/Products/Applications" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -n 1)"
  if [ -z "${app_path}" ] || [ ! -d "${app_path}" ]; then
    return 1
  fi
  DETECTED_BUNDLE_ID="$(read_bundle_id_from_app "${app_path}" 2>/dev/null || true)"

  local payload_dir="${RESULT_DIR}/Payload"
  rm -rf "${payload_dir}" "${IPA_FILE}"
  mkdir -p "${payload_dir}"
  cp -R "${app_path}" "${payload_dir}/"
  (
    cd "${RESULT_DIR}"
    zip -qry "${IPA_FILE}" Payload
  )
  [ -s "${IPA_FILE}" ]
}

launch_app() {
  local bundle_id="$1"
  local launch_output="${RESULT_DIR}/launch-${bundle_id}.log"

  log "启动 App: ${bundle_id}"
  if ${TIDEVICE_CMD} --udid "${SELECTED_DEVICE}" launch "${bundle_id}" 2>&1 | tee "${launch_output}" | tee -a "${LOG_FILE}"; then
    LAUNCH_METHOD="tidevice"
    return 0
  fi

  if grep -q 'DeveloperImage not found\|InvalidService' "${launch_output}" 2>/dev/null; then
    log "tidevice 启动失败，尝试使用 Xcode devicectl 启动 iOS 17+ 设备。"
    if command -v xcrun >/dev/null 2>&1 && xcrun devicectl --help >/dev/null 2>&1; then
      local devicectl_output="${RESULT_DIR}/devicectl-launch-${bundle_id}.log"
      if xcrun devicectl device process launch --device "${SELECTED_DEVICE}" "${bundle_id}" 2>&1 | tee "${devicectl_output}" | tee -a "${LOG_FILE}"; then
        LAUNCH_METHOD="devicectl"
        return 0
      fi
      if grep -q 'must be paired\|RemotePairingError' "${devicectl_output}" 2>/dev/null; then
        log "devicectl 提示设备未配对，尝试执行 CoreDevice 配对。请保持 iPhone 解锁，并在设备上确认信任。"
        xcrun devicectl manage pair --device "${SELECTED_DEVICE}" 2>&1 | tee -a "${LOG_FILE}" || true
        log "重新尝试使用 devicectl 启动 App。"
        if xcrun devicectl device process launch --device "${SELECTED_DEVICE}" "${bundle_id}" 2>&1 | tee -a "${LOG_FILE}"; then
          LAUNCH_METHOD="devicectl"
          return 0
        fi
        log "devicectl 仍无法连接设备。请在打包机 Jenkins 用户环境执行：xcrun devicectl manage pair --device ${SELECTED_DEVICE}"
      fi
    else
      log "未找到 xcrun devicectl，无法自动绕过 tidevice DeveloperImage 限制。"
    fi
  fi

  return 1
}

capture_screenshot() {
  log "采集启动截图..."
  if ${TIDEVICE_CMD} --udid "${SELECTED_DEVICE}" screenshot "${SCREENSHOT_FILE}" >/dev/null 2>&1; then
    log "截图: ${SCREENSHOT_FILE}"
    return 0
  fi
  log "截图采集失败，跳过。"
  return 1
}

capture_device_log() {
  log "采集设备日志..."
  : > "${DEVICE_LOG_FILE}"
  if ! ${TIDEVICE_CMD} --udid "${SELECTED_DEVICE}" syslog > "${DEVICE_LOG_FILE}" 2>&1 &
  then
    log "设备日志采集启动失败，跳过。"
    return 1
  fi
  local syslog_pid=$!
  sleep 8
  kill "${syslog_pid}" >/dev/null 2>&1 || true
  wait "${syslog_pid}" >/dev/null 2>&1 || true
  if [ -s "${DEVICE_LOG_FILE}" ]; then
    log "设备日志: ${DEVICE_LOG_FILE}"
    return 0
  fi
  log "设备日志为空，跳过。"
  return 1
}

check_process_alive() {
  local bundle_id="$1"
  if ! command -v xcrun >/dev/null 2>&1 || ! xcrun devicectl --help >/dev/null 2>&1; then
    log "未找到 devicectl，跳过进程存活检查。"
    return 2
  fi

  log "检查 App 进程存活..."
  rm -f "${PROCESS_FILE}"
  if ! xcrun devicectl device info processes --device "${SELECTED_DEVICE}" --json-output "${PROCESS_FILE}" >/dev/null 2>&1; then
    log "进程列表采集失败，跳过进程存活检查。"
    return 2
  fi
  if grep -q "${bundle_id}" "${PROCESS_FILE}" 2>/dev/null; then
    log "进程存活: ${bundle_id}"
    return 0
  fi
  if grep -q '"name"[[:space:]]*:[[:space:]]*"im"\|"executableName"[[:space:]]*:[[:space:]]*"im"' "${PROCESS_FILE}" 2>/dev/null; then
    log "进程存活: im"
    return 0
  fi
  return 1
}

url_decode() {
  local value="$1"
  python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.argv[1]))' "$value" 2>/dev/null || printf '%s\n' "$value"
}

resolve_xcarchive_path() {
  if [ -n "${XCARCHIVE_PATH}" ] && [ -d "${XCARCHIVE_PATH}" ]; then
    printf '%s\n' "${XCARCHIVE_PATH}"
    return
  fi

  case "${ARCHIVE_URL}" in
    smb://*/Archives/*.xcarchive*)
      local relative decoded candidate
      relative="${ARCHIVE_URL#smb://*/Archives/}"
      decoded="$(url_decode "${relative}")"
      candidate="${HOME}/Library/Developer/Xcode/Archives/${decoded}"
      if [ -d "${candidate}" ]; then
        printf '%s\n' "${candidate}"
        return
      fi
      ;;
  esac
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
  "xcarchivePath": "${XCARCHIVE_PATH}",
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
log "xcarchive: ${XCARCHIVE_PATH:-N/A}"
RESOLVED_XCARCHIVE_PATH="$(resolve_xcarchive_path)"
if [ -n "${RESOLVED_XCARCHIVE_PATH}" ] && [ "${RESOLVED_XCARCHIVE_PATH}" != "${XCARCHIVE_PATH}" ]; then
  log "解析到本地 xcarchive: ${RESOLVED_XCARCHIVE_PATH}"
fi

TIDEVICE_CMD="$(find_tidevice)"
if [ -z "${TIDEVICE_CMD}" ]; then
  fail "未找到 tidevice。请在打包机 Jenkins 用户下安装：python3 -m pipx install tidevice，或 python3 -m pip install --user tidevice。若已安装，请确认 Jenkins 用户 PATH 包含 \$HOME/.local/bin。当前 PATH=${PATH}"
fi

log "tidevice: ${TIDEVICE_CMD}"
log "当前连接设备:"
${TIDEVICE_CMD} list | tee -a "${LOG_FILE}" || true

SELECTED_DEVICE="$(select_device "${TIDEVICE_CMD}")"
if [ -z "${SELECTED_DEVICE}" ]; then
  fail "未发现 USB 连接的 iPhone。请确认真机已连接打包机并完成信任。"
fi
log "使用设备: ${SELECTED_DEVICE}"

download_status=0
download_ipa "${PACKAGE_URL}" || download_status=$?
if [ "${download_status}" != "0" ] && [ -n "${RESOLVED_XCARCHIVE_PATH}" ]; then
  log "PACKAGE_URL 不可用，尝试从 xcarchive Products 生成临时 IPA: ${RESOLVED_XCARCHIVE_PATH}"
  download_status=0
  package_ipa_from_xcarchive "${RESOLVED_XCARCHIVE_PATH}" || download_status=$?
fi
if [ "${download_status}" != "0" ] && [ -n "${ARCHIVE_URL}" ] && [ "${ARCHIVE_URL}" != "${PACKAGE_URL}" ]; then
  log "PACKAGE_URL 不可用，尝试 ARCHIVE_URL: ${ARCHIVE_URL}"
  download_status=0
  download_ipa "${ARCHIVE_URL}" || download_status=$?
fi
if [ "${download_status}" = "2" ]; then
  file_desc="$(file "${IPA_FILE}" 2>/dev/null || true)"
  fail "下载到的文件不是有效 IPA，可能 PACKAGE_URL 是蒲公英页面短链而不是直接下载地址。PACKAGE_URL=${PACKAGE_URL:-N/A} ARCHIVE_URL=${ARCHIVE_URL:-N/A} 文件信息=${file_desc:-N/A}"
elif [ "${download_status}" != "0" ]; then
  fail "无法获取 IPA。请确保 Jenkins 传入 PACKAGE_URL，且该地址可被打包机下载。ARCHIVE_URL=${ARCHIVE_URL:-N/A}"
fi
detect_bundle_id_from_ipa || true
log "IPA: ${IPA_FILE}"
if [ -n "${DETECTED_BUNDLE_ID}" ]; then
  log "检测到安装包 Bundle ID: ${DETECTED_BUNDLE_ID}"
fi

log "安装 IPA..."
${TIDEVICE_CMD} --udid "${SELECTED_DEVICE}" install "${IPA_FILE}" 2>&1 | tee -a "${LOG_FILE}"

LAUNCH_BUNDLE_ID="${APP_BUNDLE_ID:-${DETECTED_BUNDLE_ID}}"
if [ -n "${APP_BUNDLE_ID}" ] && [ -n "${DETECTED_BUNDLE_ID}" ] && [ "${APP_BUNDLE_ID}" != "${DETECTED_BUNDLE_ID}" ]; then
  log "配置的 APP_BUNDLE_ID=${APP_BUNDLE_ID} 与安装包 Bundle ID=${DETECTED_BUNDLE_ID} 不一致，按配置启动。"
fi

if [ -n "${LAUNCH_BUNDLE_ID}" ]; then
  if ! launch_app "${LAUNCH_BUNDLE_ID}"; then
    fail "安装成功但启动失败：${LAUNCH_BUNDLE_ID}。如果日志包含 DeveloperImage not found，请在打包机安装匹配当前 iOS 版本的 Xcode，或确认 xcrun devicectl 可用。"
  fi
fi

log "等待基础启动稳定..."
sleep 5

process_status=0
check_process_alive "${LAUNCH_BUNDLE_ID}" || process_status=$?
capture_screenshot || true
capture_device_log || true
if [ "${process_status}" = "1" ]; then
  fail "启动后未检测到 App 进程：${LAUNCH_BUNDLE_ID}"
fi

write_summary "passed" "安装、启动、进程检查、截图和日志采集完成"
write_report 0
log "质检结果目录: ${RESULT_DIR}"
log "JUnit报告: ${REPORT_FILE}"
log "质检摘要: ${SUMMARY_FILE}"
