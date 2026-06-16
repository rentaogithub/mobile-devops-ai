#!/usr/bin/env bash
set -euo pipefail

echo "========================================"
echo "nn-ios Monkey runtime setup"
echo "========================================"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  nvm use --lts >/dev/null 2>&1 || nvm use default >/dev/null 2>&1 || true
fi

if [ -d "$HOME/.nvm/versions/node" ]; then
  latest_node="$(ls "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "$latest_node" ]; then
    export PATH="$HOME/.nvm/versions/node/$latest_node/bin:$PATH"
  fi
fi

need_brew_package() {
  local package="$1"
  if ! command -v brew >/dev/null 2>&1; then
    echo "WARN: brew 不可用，跳过安装 $package。"
    return 1
  fi
  if brew list "$package" >/dev/null 2>&1; then
    echo "OK: $package 已安装"
    return 0
  fi
  echo "安装 $package..."
  brew install "$package"
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
  echo "Node/npm/npx 不完整，尝试通过 Homebrew 安装 node..."
  need_brew_package node || true
fi

if ! command -v iproxy >/dev/null 2>&1; then
  echo "iproxy 不存在，尝试安装 libimobiledevice..."
  need_brew_package libimobiledevice || true
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
  echo "ERROR: 仍未找到 node/npm/npx。请先在打包机 Jenkins 用户可见的 PATH 中安装 Node.js。"
  echo "当前 PATH=$PATH"
  exit 2
fi

echo "node: $(command -v node)"
echo "npm:  $(command -v npm)"
echo "npx:  $(command -v npx)"
node -v || true
npm -v || true

if command -v appium >/dev/null 2>&1; then
  echo "appium: $(command -v appium)"
else
  echo "appium 未安装，优先使用 npx 临时安装 driver。"
fi

echo "安装/检查 Appium XCUITest Driver..."
if command -v appium >/dev/null 2>&1; then
  appium driver list --installed || true
  if ! appium driver list --installed 2>/dev/null | grep -qi "xcuitest"; then
    appium driver install xcuitest
  fi
else
  npx -y appium driver install xcuitest
fi

find_wda() {
  local candidates=(
    "$HOME/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj"
    "$HOME/.appium/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj"
    "/opt/homebrew/lib/node_modules/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj"
    "/opt/homebrew/lib/node_modules/appium/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj"
    "/usr/local/lib/node_modules/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj"
    "/usr/local/lib/node_modules/appium/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -d "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  find "$HOME/.appium" /opt/homebrew/lib/node_modules /usr/local/lib/node_modules \
    -type d -name WebDriverAgent.xcodeproj -print -quit 2>/dev/null || true
}

wda_project="$(find_wda)"
if [ -z "$wda_project" ]; then
  echo "ERROR: XCUITest Driver 已尝试安装，但仍未找到 WebDriverAgent.xcodeproj。"
  exit 3
fi

echo "OK: WebDriverAgent.xcodeproj=$wda_project"
echo
echo "Jenkins 可选参数："
echo "  WDA_PROJECT_PATH=$wda_project"
echo "  WDA_URL=http://10.1.3.177:8100"
echo
echo "验证 WDA 状态："
echo "  curl http://10.1.3.177:8100/status"
