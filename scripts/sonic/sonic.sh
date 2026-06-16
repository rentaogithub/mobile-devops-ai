#!/bin/bash

# Unified Sonic command entrypoint.
# Daily usage:
#   sh scripts/sonic/sonic.sh start
#   sh scripts/sonic/sonic.sh check
#   sh scripts/sonic/sonic.sh stop

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SONIC_DIR="${SONIC_STACK_DIR:-$PROJECT_ROOT/deploy/sonic}"
SONIC_ENV_FILE="${SONIC_STACK_ENV_FILE:-$SONIC_DIR/.env}"
SONIC_AGENT_PID_FILE="${SONIC_AGENT_PID_FILE:-$PROJECT_ROOT/nn-ios-platform-data/sonic-agent.pid}"

usage() {
  cat <<EOF
Sonic command for nn-ios-platform

Usage:
  sh scripts/sonic/sonic.sh start     一键启动 Sonic Server/Web + Agent，并输出诊断
  sh scripts/sonic/sonic.sh check     检查 Sonic Server/Web、平台代理、Agent 线索
  sh scripts/sonic/sonic.sh stop      停止 Sonic Agent 和 Sonic Server/Web 容器
  sh scripts/sonic/sonic.sh prepare   准备/下载/解压 Sonic Agent，生成 start.sh
  sh scripts/sonic/sonic.sh stack     仅启动 Sonic Server/Web
  sh scripts/sonic/sonic.sh agent     仅启动 Sonic Agent
  sh scripts/sonic/sonic.sh ios-pair  配对 USB iPhone 并启动蒲公英包 com.nndev.im
  sh scripts/sonic/sonic.sh monkey-setup 准备 Monkey 测试所需 Node/Appium/WDA

Recommended:
  日常只用 start / check / stop。
EOF
}

compose_cmd() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
    return
  fi
  echo ""
}

stop_agent() {
  if [ -f "$SONIC_AGENT_PID_FILE" ]; then
    local pid
    pid="$(cat "$SONIC_AGENT_PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      echo "Stopping Sonic Agent: $pid"
      kill "$pid" 2>/dev/null || true
    else
      echo "Sonic Agent is not running."
    fi
    rm -f "$SONIC_AGENT_PID_FILE"
    return
  fi

  if pgrep -f "sonic.*agent" >/dev/null 2>&1; then
    echo "Stopping Sonic Agent processes..."
    pkill -f "sonic.*agent" 2>/dev/null || true
  else
    echo "Sonic Agent is not running."
  fi
}

stop_stack() {
  local cmd
  cmd="$(compose_cmd)"
  if [ -z "$cmd" ]; then
    echo "Docker compose is not available; skip Sonic Server/Web stop."
    return
  fi
  if [ ! -f "$SONIC_DIR/docker-compose.yml" ]; then
    echo "Missing Sonic compose file: $SONIC_DIR/docker-compose.yml"
    return
  fi

  echo "Stopping Sonic Server/Web..."
  if [ -f "$SONIC_ENV_FILE" ]; then
    $cmd -f "$SONIC_DIR/docker-compose.yml" --env-file "$SONIC_ENV_FILE" down
  else
    $cmd -f "$SONIC_DIR/docker-compose.yml" down
  fi
}

command_name="${1:-start}"

case "$command_name" in
  start|bootstrap)
    /bin/bash "$PROJECT_ROOT/scripts/sonic/bootstrap.sh"
    ;;
  check|doctor)
    /bin/bash "$PROJECT_ROOT/scripts/sonic/check.sh"
    ;;
  stop)
    stop_agent
    stop_stack
    ;;
  prepare)
    shift || true
    /bin/bash "$PROJECT_ROOT/scripts/sonic/prepare-agent.sh" "$@"
    ;;
  stack)
    /bin/bash "$PROJECT_ROOT/scripts/sonic/start-stack.sh"
    ;;
  agent)
    /bin/bash "$PROJECT_ROOT/scripts/sonic/start-agent.sh"
    ;;
  ios-pair|pair-ios|pair)
    shift || true
    /bin/bash "$PROJECT_ROOT/scripts/sonic/pair-and-launch-ios.sh" "$@"
    ;;
  monkey-setup|setup-monkey)
    /bin/bash "$PROJECT_ROOT/scripts/sonic/setup-monkey-runtime.sh"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown Sonic command: $command_name" >&2
    echo >&2
    usage >&2
    exit 2
    ;;
esac
