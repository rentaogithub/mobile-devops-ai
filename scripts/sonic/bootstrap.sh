#!/bin/bash

# One-shot Sonic bootstrap for the fixed 10.1.3.177 Mac.
# It starts Sonic Server/Web, prepares/starts Sonic Agent, then prints a clear
# diagnosis. Missing Agent runtime package is reported as a concrete blocker.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENT_DIR="${SONIC_AGENT_DIR:-/Users/a1/工作/sonic-agent}"
PLATFORM_HOST="${PLATFORM_HOST:-10.1.3.177}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
SONIC_WEB_PORT="${SONIC_WEB_PORT:-3002}"
SONIC_API_PORT="${SONIC_API_PORT:-8094}"

check_http() {
  local url="$1"
  local code
  code="$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 "$url" 2>/dev/null || true)"
  [ "$code" != "000" ] && [ -n "$code" ]
}

wait_http() {
  local url="$1"
  local attempts="${2:-10}"
  local index
  for index in $(seq 1 "$attempts"); do
    if check_http "$url"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

print_sonic_server_diagnostics() {
  if ! command -v docker >/dev/null 2>&1; then
    return
  fi

  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^nn-sonic-gateway$'; then
    echo "nn-sonic-gateway 容器未运行。"
    return
  fi

  echo
  echo "nn-sonic-gateway 最近日志:"
  docker logs --tail 80 nn-sonic-gateway 2>&1 | sed 's/^/  /' || true
  echo
  echo "nn-sonic-controller 最近日志:"
  docker logs --tail 80 nn-sonic-controller 2>&1 | sed 's/^/  /' || true

  echo
  echo "nn-sonic-gateway 容器内探测:"
  docker exec nn-sonic-gateway sh -lc '
    if command -v curl >/dev/null 2>&1; then
      curl -s -o /dev/null -w "  container localhost:3000 -> HTTP %{http_code}\n" --connect-timeout 2 http://127.0.0.1:3000 || true
    elif command -v wget >/dev/null 2>&1; then
      wget -q -S -O /dev/null http://127.0.0.1:3000 2>&1 | head -n 5 | sed "s/^/  /" || true
    else
      echo "  curl/wget 不存在，跳过容器内 HTTP 探测"
    fi
  ' 2>&1 || true
}

echo "🚀 Bootstrap Sonic for nn-ios-platform"
echo "====================================="
echo "Project: $PROJECT_ROOT"
echo "Agent:   $AGENT_DIR"
echo

echo "1. 初始化 Sonic Server/Web 配置..."
/bin/bash "$PROJECT_ROOT/scripts/sonic/init-stack-env.sh"
echo

echo "2. 启动 Sonic Server/Web..."
/bin/bash "$PROJECT_ROOT/scripts/sonic/start-stack.sh"
echo

echo "3. 准备 Sonic Agent 目录和启动入口..."
/bin/bash "$PROJECT_ROOT/scripts/sonic/prepare-agent.sh"
echo

echo "4. 启动 Sonic Agent..."
/bin/bash "$PROJECT_ROOT/scripts/sonic/start-agent.sh"
echo

echo "5. 检查 Sonic 服务摘要..."
if wait_http "http://127.0.0.1:$SONIC_WEB_PORT" 5; then
  echo "✅ Sonic Web 可访问: http://$PLATFORM_HOST:$SONIC_WEB_PORT"
else
  echo "⚠️  Sonic Web HTTP 不通: $SONIC_WEB_PORT"
fi

if wait_http "http://127.0.0.1:$SONIC_API_PORT" 10; then
  echo "✅ Sonic API 可访问: http://$PLATFORM_HOST:$SONIC_API_PORT"
else
  echo "⚠️  Sonic API HTTP 不通: $SONIC_API_PORT"
  print_sonic_server_diagnostics
fi

echo "完整诊断: sh scripts/sonic/sonic.sh check"
echo

echo "6. 检查 Agent 安装结果..."
if [ -x "$AGENT_DIR/start.sh" ]; then
  echo "✅ Sonic Agent start.sh exists: $AGENT_DIR/start.sh"
elif find "$AGENT_DIR" -maxdepth 4 -type f -name 'sonic-agent*.jar' | head -n 1 | grep -q .; then
  echo "✅ Sonic Agent jar exists under: $AGENT_DIR"
else
  echo "❌ Sonic Agent runtime package is missing."
  echo
  echo "请把真实 Sonic Agent 包放到:"
  echo "  $AGENT_DIR"
  echo
  echo "支持文件名:"
  echo "  sonic-agent*.zip"
  echo "  sonic-agent*.tar.gz"
  echo "  sonic-agent*.tgz"
  echo "  sonic-agent*.jar"
  echo
  echo "然后重新执行:"
  echo "  cd $PROJECT_ROOT"
  echo "  sh scripts/sonic/sonic.sh start"
  exit 2
fi

if [ -f "$PROJECT_ROOT/nn-ios-platform-data/sonic-agent.pid" ]; then
  AGENT_PID="$(cat "$PROJECT_ROOT/nn-ios-platform-data/sonic-agent.pid" 2>/dev/null || true)"
  if [ -n "$AGENT_PID" ] && kill -0 "$AGENT_PID" >/dev/null 2>&1; then
    echo "✅ Sonic Agent running: $AGENT_PID"
  else
    echo "⚠️  Sonic Agent PID exists but process is not running."
    echo "Log: $PROJECT_ROOT/sonic-agent.log"
  fi
else
  echo "⚠️  Sonic Agent PID file not found."
  echo "Log: $PROJECT_ROOT/sonic-agent.log"
fi

echo
echo "访问地址:"
echo "  Sonic Web: http://$PLATFORM_HOST:$FRONTEND_PORT/sonic-admin"
echo "  Sonic API: http://$PLATFORM_HOST:$FRONTEND_PORT/sonic-api"
