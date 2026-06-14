#!/bin/bash

# Start Sonic Server/Web together with nn-ios-platform when configured.
# The script is intentionally non-blocking: platform startup should keep going
# when Sonic images are not configured on a fresh machine.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_ENV_FILE="${SONIC_PLATFORM_ENV_FILE:-$PROJECT_ROOT/backend/.env}"
SONIC_DIR="${SONIC_STACK_DIR:-$PROJECT_ROOT/deploy/sonic}"
SONIC_ENV_FILE="${SONIC_STACK_ENV_FILE:-$SONIC_DIR/.env}"
SONIC_ENV_EXAMPLE="$SONIC_DIR/.env.example"

load_platform_env() {
  if [ ! -f "$BACKEND_ENV_FILE" ]; then
    return
  fi

  while IFS='=' read -r key value; do
    case "$key" in
      SONIC_STACK_*|SONIC_SERVER_*|SONIC_WEB_*|SONIC_MYSQL_*|SONIC_REDIS_*|SONIC_HOST)
        if [ -z "${!key:-}" ]; then
          value="${value%%#*}"
          value="${value%$'\r'}"
          value="${value%\"}"
          value="${value#\"}"
          value="${value%\'}"
          value="${value#\'}"
          export "$key=$value"
        fi
        ;;
    esac
  done < <(grep -E '^(SONIC_STACK_|SONIC_SERVER_|SONIC_WEB_|SONIC_MYSQL_|SONIC_REDIS_|SONIC_HOST=)' "$BACKEND_ENV_FILE" || true)
}

read_env_value() {
  local key="$1"
  local file="$2"
  if [ ! -f "$file" ]; then
    return
  fi
  grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//"
}

has_placeholder_images() {
  local web_image server_image
  web_image="$(read_env_value SONIC_WEB_IMAGE "$SONIC_ENV_FILE")"
  server_image="$(read_env_value SONIC_SERVER_IMAGE "$SONIC_ENV_FILE")"

  if [ -z "$web_image" ] || [ -z "$server_image" ]; then
    return 0
  fi
  [ "$web_image" = "sonic-web-image:latest" ] && return 0
  [ "$server_image" = "sonic-server-image:latest" ] && return 0
  return 1
}

ensure_docker_runtime() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Sonic Server/Web not started: docker command not found."
    return 1
  fi

  if docker info >/dev/null 2>&1; then
    return 0
  fi

  if command -v colima >/dev/null 2>&1; then
    echo "Starting Colima for Sonic Server/Web..."
    if colima start >/dev/null 2>&1; then
      return 0
    fi
  fi

  echo "Sonic Server/Web not started: Docker runtime is not available."
  return 1
}

load_platform_env

if [ "${SONIC_STACK_AUTO_START:-true}" = "false" ]; then
  echo "Sonic Server/Web auto start disabled."
  exit 0
fi

if [ ! -d "$SONIC_DIR" ]; then
  echo "Sonic Server/Web not started: $SONIC_DIR does not exist."
  exit 0
fi

if [ ! -f "$SONIC_ENV_FILE" ]; then
  if [ -f "$SONIC_ENV_EXAMPLE" ]; then
    cp "$SONIC_ENV_EXAMPLE" "$SONIC_ENV_FILE"
    echo "Created Sonic compose env: $SONIC_ENV_FILE"
  else
    echo "Sonic Server/Web not started: missing $SONIC_ENV_FILE."
    exit 0
  fi
fi

if has_placeholder_images; then
  echo "Sonic Server/Web not started: configure real SONIC_WEB_IMAGE and SONIC_SERVER_IMAGE in $SONIC_ENV_FILE."
  exit 0
fi

if ! ensure_docker_runtime; then
  exit 0
fi

echo "Starting Sonic Server/Web by docker compose..."
docker compose -f "$SONIC_DIR/docker-compose.yml" --env-file "$SONIC_ENV_FILE" up -d
docker compose -f "$SONIC_DIR/docker-compose.yml" --env-file "$SONIC_ENV_FILE" ps
