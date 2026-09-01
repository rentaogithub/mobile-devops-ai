#!/bin/bash

# Start nn-ios-platform as a local background service.
# This script is intended for daily platform usage: backend and frontend are
# both kept in detached screen sessions, with health checks before returning.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
BACKEND_LOG="$PROJECT_ROOT/backend-dev.log"
FRONTEND_LOG="$PROJECT_ROOT/frontend-dev.log"
BACKEND_SESSION="${BACKEND_SESSION:-nn-ios-platform-backend}"
FRONTEND_SESSION="${FRONTEND_SESSION:-nn-ios-platform-frontend}"

ENV_BACKEND_PORT=""
if [ -f "$BACKEND_DIR/.env" ]; then
  ENV_BACKEND_PORT="$(awk -F= '/^PORT=/{print $2; exit}' "$BACKEND_DIR/.env" | tr -d '[:space:]')"
fi

BACKEND_PORT="${BACKEND_PORT:-${ENV_BACKEND_PORT:-3000}}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
BACKEND_HEALTH_URL="http://127.0.0.1:$BACKEND_PORT/health"
FRONTEND_URL="http://127.0.0.1:$FRONTEND_PORT"

detect_host_ip() {
  local ip
  ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [ -z "$ip" ]; then
    ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  if [ -z "$ip" ]; then
    ip="$(ifconfig 2>/dev/null | awk '/inet / && $2 !~ /^127\./ && $2 !~ /^169\.254\./ { print $2; exit }')"
  fi
  echo "${ip:-127.0.0.1}"
}

PLATFORM_HOST="${PLATFORM_HOST:-$(detect_host_ip)}"

screen_exists() {
  screen -ls 2>/dev/null | grep -q "[.]$1[[:space:]]"
}

stop_screen_session() {
  local session="$1"
  if screen_exists "$session"; then
    screen -S "$session" -X quit >/dev/null 2>&1 || true
    sleep 1
  fi
}

port_pid() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

port_command() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null || true
}

ensure_port_available_or_owned() {
  local port="$1"
  local expected="$2"
  local pid
  pid="$(port_pid "$port" | head -n 1)"
  if [ -z "$pid" ]; then
    return 0
  fi

  local command
  command="$(port_command "$pid")"
  if echo "$command" | grep -Eqi "$expected"; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    return 0
  fi

  echo "端口 $port 已被其他进程占用，平台未强制关闭："
  echo "  PID: $pid"
  echo "  CMD: $command"
  echo "请先停止该进程，或通过 BACKEND_PORT/FRONTEND_PORT 指定其他端口。"
  exit 1
}

wait_for_http() {
  local url="$1"
  local name="$2"
  local retries="$3"
  local interval="$4"
  local code

  for i in $(seq 1 "$retries"); do
    code="$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 "$url" 2>/dev/null || true)"
    if [ "$code" != "000" ] && [ -n "$code" ]; then
      echo "$name 已就绪：$url"
      return 0
    fi
    sleep "$interval"
  done

  echo "$name 启动超时：$url"
  return 1
}

start_backend() {
  echo "启动后端服务..."
  stop_screen_session "$BACKEND_SESSION"
  ensure_port_available_or_owned "$BACKEND_PORT" "tsx|node|npm|backend|nn-ios-platform"
  : > "$BACKEND_LOG"
  screen -dmS "$BACKEND_SESSION" zsh -lc "cd '$PROJECT_ROOT' && node scripts/run-with-supported-node.mjs dev:backend >> '$BACKEND_LOG' 2>&1"
  if ! wait_for_http "$BACKEND_HEALTH_URL" "后端" 45 1; then
    echo "后端日志：$BACKEND_LOG"
    tail -n 80 "$BACKEND_LOG" || true
    exit 1
  fi
}

start_frontend() {
  echo "启动前端服务..."
  stop_screen_session "$FRONTEND_SESSION"
  ensure_port_available_or_owned "$FRONTEND_PORT" "vite|node|npm|frontend|nn-ios-platform"
  : > "$FRONTEND_LOG"
  screen -dmS "$FRONTEND_SESSION" zsh -lc "cd '$FRONTEND_DIR' && npm run dev -- --host 0.0.0.0 --port '$FRONTEND_PORT' >> '$FRONTEND_LOG' 2>&1"
  if ! wait_for_http "$FRONTEND_URL" "前端" 30 1; then
    echo "前端日志：$FRONTEND_LOG"
    tail -n 80 "$FRONTEND_LOG" || true
    exit 1
  fi
}

if ! command -v screen >/dev/null 2>&1; then
  echo "未找到 screen，无法后台启动平台服务。"
  echo "可先安装 screen，或继续使用 scripts/start-dev.sh 前台启动。"
  exit 1
fi

if [ ! -d "$BACKEND_DIR/node_modules" ] || [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  echo "检测到依赖缺失，开始安装..."
  (cd "$PROJECT_ROOT" && npm install)
fi

(cd "$PROJECT_ROOT" && npm run ensure:native >/dev/null)

case "${1:-start}" in
  start)
    start_backend
    start_frontend
    ;;
  backend)
    start_backend
    ;;
  frontend)
    start_frontend
    ;;
  stop)
    stop_screen_session "$BACKEND_SESSION"
    stop_screen_session "$FRONTEND_SESSION"
    echo "平台服务已停止。"
    exit 0
    ;;
  restart)
    stop_screen_session "$BACKEND_SESSION"
    stop_screen_session "$FRONTEND_SESSION"
    start_backend
    start_frontend
    ;;
  status)
    echo "后端：$BACKEND_HEALTH_URL"
    curl -s -f "$BACKEND_HEALTH_URL" >/dev/null 2>&1 && echo "  ok" || echo "  unavailable"
    echo "前端：$FRONTEND_URL"
    curl -s -f "$FRONTEND_URL" >/dev/null 2>&1 && echo "  ok" || echo "  unavailable"
    echo "screen sessions:"
    screen -ls 2>/dev/null | grep "nn-ios-platform" || true
    exit 0
    ;;
  *)
    echo "用法：$0 [start|restart|stop|status|backend|frontend]"
    exit 1
    ;;
esac

echo ""
echo "平台服务启动完成"
echo "访问地址："
echo "  本机：http://127.0.0.1:$FRONTEND_PORT"
echo "  局域网：http://$PLATFORM_HOST:$FRONTEND_PORT"
echo "后端健康检查：$BACKEND_HEALTH_URL"
echo "日志："
echo "  后端：$BACKEND_LOG"
echo "  前端：$FRONTEND_LOG"
echo "停止服务：./start-platform.sh stop"
