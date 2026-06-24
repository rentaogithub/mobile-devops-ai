#!/usr/bin/env bash
set -euo pipefail

LABEL="${PYMOBILEDEVICE3_TUNNELD_LABEL:-com.nn-ios-platform.pymobiledevice3-tunneld}"
PLIST_PATH="/Library/LaunchDaemons/${LABEL}.plist"
HOST="${PYMOBILEDEVICE3_TUNNELD_HOST:-127.0.0.1}"
PORT="${PYMOBILEDEVICE3_TUNNELD_PORT:-49151}"
PROTOCOL="${PYMOBILEDEVICE3_TUNNELD_PROTOCOL:-tcp}"
PYMOBILEDEVICE3_CMD="${PYMOBILEDEVICE3_CMD:-$(command -v pymobiledevice3 || true)}"

if [ -z "${PYMOBILEDEVICE3_CMD}" ] || [ ! -x "${PYMOBILEDEVICE3_CMD}" ]; then
  echo "未找到 pymobiledevice3，请先安装并确保当前 shell 可执行。"
  exit 1
fi

TMP_PLIST="$(mktemp "/tmp/${LABEL}.XXXXXX.plist")"
cat > "${TMP_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PYMOBILEDEVICE3_CMD}</string>
    <string>remote</string>
    <string>tunneld</string>
    <string>--host</string>
    <string>${HOST}</string>
    <string>--port</string>
    <string>${PORT}</string>
    <string>--protocol</string>
    <string>${PROTOCOL}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/${LABEL}.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/${LABEL}.err.log</string>
</dict>
</plist>
PLIST

plutil -lint "${TMP_PLIST}" >/dev/null

echo "安装 ${LABEL} 到 ${PLIST_PATH}"
sudo launchctl bootout system "${PLIST_PATH}" >/dev/null 2>&1 || true
sudo cp "${TMP_PLIST}" "${PLIST_PATH}"
sudo chown root:wheel "${PLIST_PATH}"
sudo chmod 644 "${PLIST_PATH}"
sudo launchctl bootstrap system "${PLIST_PATH}"
sudo launchctl enable "system/${LABEL}"
sudo launchctl kickstart -k "system/${LABEL}"
rm -f "${TMP_PLIST}"

echo "已启动 ${LABEL}，监听 ${HOST}:${PORT}"
echo "查看状态: sudo launchctl print system/${LABEL}"
echo "查看日志: tail -f /var/log/${LABEL}.err.log /var/log/${LABEL}.log"
