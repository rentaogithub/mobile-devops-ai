#!/usr/bin/env bash
set -euo pipefail

APP_BUNDLE_ID="${APP_BUNDLE_ID:-com.nndev.im}"
DEVICE_UDID="${DEVICE_UDID:-${1:-}}"

export PATH="$HOME/.local/bin:$HOME/Library/Python/3.9/bin:$HOME/Library/Python/3.10/bin:$HOME/Library/Python/3.11/bin:$HOME/Library/Python/3.12/bin:$HOME/Library/Python/3.13/bin:$HOME/Library/Python/3.14/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

usage() {
  cat <<EOF
iOS CoreDevice pair and launch helper

Usage:
  sh scripts/ios/pair-and-launch-ios.sh [device-udid] [bundle-id]

Env:
  DEVICE_UDID     指定设备 UDID；未传时自动选择 tidevice list 第一台 USB iPhone
  APP_BUNDLE_ID   启动的 Bundle ID，默认 com.nndev.im

Examples:
  sh scripts/ios/pair-and-launch-ios.sh
  sh scripts/ios/pair-and-launch-ios.sh 00008101-0015192E0178001E
  sh scripts/ios/pair-and-launch-ios.sh 00008101-0015192E0178001E com.nndev.im
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ -n "${2:-}" ]; then
  APP_BUNDLE_ID="$2"
fi

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
  ${tidevice_cmd} list 2>/dev/null | awk '
    NR == 1 && ($1 == "UDID" || $1 == "SerialNumber") { next }
    $1 ~ /^[0-9A-Fa-f-]{25,}$/ { print $1; exit }
  '
}

if ! command -v xcrun >/dev/null 2>&1; then
  echo "ERROR: 未找到 xcrun，请先在打包机安装并打开 Xcode。" >&2
  exit 2
fi

if ! xcrun devicectl --help >/dev/null 2>&1; then
  echo "ERROR: 当前 Xcode 不支持 devicectl，请升级到支持 iOS 17 真机的 Xcode。" >&2
  exit 2
fi

TIDEVICE_CMD="$(find_tidevice)"
if [ -z "${TIDEVICE_CMD}" ]; then
  echo "ERROR: 未找到 tidevice，无法自动选择 USB iPhone。可通过 DEVICE_UDID 手动指定设备。" >&2
  exit 2
fi

echo "当前 tidevice 设备列表:"
${TIDEVICE_CMD} list || true

SELECTED_DEVICE="$(select_device "${TIDEVICE_CMD}")"
if [ -z "${SELECTED_DEVICE}" ]; then
  echo "ERROR: 未发现 USB 连接的 iPhone。请连接设备、解锁并确认信任。" >&2
  exit 2
fi

echo "设备: ${SELECTED_DEVICE}"
echo "Bundle ID: ${APP_BUNDLE_ID}"
echo "执行 CoreDevice 配对，请保持 iPhone 解锁，并在设备上确认信任/配对。"
xcrun devicectl manage pair --device "${SELECTED_DEVICE}" || true

echo "启动 App: ${APP_BUNDLE_ID}"
xcrun devicectl device process launch --device "${SELECTED_DEVICE}" "${APP_BUNDLE_ID}"

echo "完成。"
