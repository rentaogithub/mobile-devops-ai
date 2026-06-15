#!/bin/bash

# Diagnose Sonic Server/Web deployment on the fixed build Mac.

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SONIC_DIR="${SONIC_STACK_DIR:-$PROJECT_ROOT/deploy/sonic}"
SONIC_ENV_FILE="${SONIC_STACK_ENV_FILE:-$SONIC_DIR/.env}"
PLATFORM_HOST="${PLATFORM_HOST:-10.1.3.177}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

section() {
  echo
  echo "==== $* ===="
}

check_command() {
  local command_name="$1"
  if command -v "$command_name" >/dev/null 2>&1; then
    echo "OK: $command_name -> $(command -v "$command_name")"
  else
    echo "MISS: $command_name"
  fi
}

check_http() {
  local url="$1"
  local name="$2"
  local code
  code="$(curl -s -o /tmp/nn-ios-platform-sonic-check.out -w "%{http_code}" --connect-timeout 2 "$url")"
  if [ "$code" = "000" ]; then
    echo "FAIL: $name $url -> connect failed"
  elif [ "$code" -ge 200 ] && [ "$code" -lt 400 ]; then
    echo "OK: $name $url -> HTTP $code"
  else
    echo "WARN: $name $url -> HTTP $code"
  fi
}

print_container_logs() {
  local container_name="$1"
  local title="$2"
  if ! command -v docker >/dev/null 2>&1; then
    return
  fi
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${container_name}$"; then
    echo "skip $title logs: $container_name is not running"
    return
  fi

  section "$title Logs"
  docker logs --tail 100 "$container_name" 2>&1 | sed 's/^/  /'
}

check_sonic_server_inside_container() {
  if ! command -v docker >/dev/null 2>&1; then
    return
  fi
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^nn-sonic-server$'; then
    return
  fi

  section "Sonic Server Container HTTP"
  docker exec nn-sonic-server sh -lc '
    if command -v curl >/dev/null 2>&1; then
      curl -s -o /dev/null -w "container localhost:8094 -> HTTP %{http_code}\n" --connect-timeout 2 http://127.0.0.1:8094 || true
    elif command -v wget >/dev/null 2>&1; then
      wget -q -S -O /dev/null http://127.0.0.1:8094 2>&1 | head -n 8 || true
    else
      echo "curl/wget not found in nn-sonic-server"
    fi
  ' 2>&1 || true
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

section "Commands"
check_command docker
check_command docker-compose
check_command colima
check_command curl

section "Colima"
if command -v colima >/dev/null 2>&1; then
  colima status
else
  echo "colima not installed"
fi

section "Docker"
if command -v docker >/dev/null 2>&1; then
  docker version
  if docker compose version >/dev/null 2>&1; then
    docker compose version
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose version
  else
    echo "MISS: docker compose / docker-compose"
  fi
  echo
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
else
  echo "docker not installed"
fi

section "Sonic Env"
if [ -f "$SONIC_ENV_FILE" ]; then
  sed -n '1,120p' "$SONIC_ENV_FILE" | sed -E 's/^(.*PASSWORD=).*/\1******/'
else
  echo "missing $SONIC_ENV_FILE"
fi

section "Sonic Compose"
COMPOSE_CMD="$(compose_cmd)"
if [ -f "$SONIC_ENV_FILE" ] && [ -n "$COMPOSE_CMD" ]; then
  $COMPOSE_CMD -f "$SONIC_DIR/docker-compose.yml" --env-file "$SONIC_ENV_FILE" ps
else
  echo "skip compose check"
fi

section "Ports"
lsof -nP -iTCP:3002 -sTCP:LISTEN
lsof -nP -iTCP:8094 -sTCP:LISTEN

section "HTTP"
check_http "http://127.0.0.1:3002" "Sonic Web"
check_http "http://127.0.0.1:8094" "Sonic API"
check_http "http://127.0.0.1:5173/sonic-admin" "Platform Sonic Admin Proxy"
check_http "http://127.0.0.1:5173/sonic-api" "Platform Sonic API Proxy"
check_http "http://${PLATFORM_HOST}:${FRONTEND_PORT}/sonic-admin" "External Platform Sonic Admin Proxy"
check_http "http://${PLATFORM_HOST}:${FRONTEND_PORT}/sonic-api" "External Platform Sonic API Proxy"

check_sonic_server_inside_container
print_container_logs "nn-sonic-server" "Sonic Server"

section "Hint"
echo "如果 3002 不通：Sonic Web 容器未启动或启动失败。"
echo "如果 8094 不通：Sonic Server/API 容器未启动或启动失败。"
echo "如果 .env 缺失或仍是占位配置，执行 sh scripts/sonic/sonic.sh stack 自动初始化。"
