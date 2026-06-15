#!/bin/bash

# Start Sonic Server/Web together with nn-ios-platform when configured.
# The script is intentionally non-blocking: platform startup should keep going
# when Sonic images are not configured on a fresh machine.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKEND_ENV_FILE="${SONIC_PLATFORM_ENV_FILE:-$PROJECT_ROOT/backend/.env}"
SONIC_DIR="${SONIC_STACK_DIR:-$PROJECT_ROOT/deploy/sonic}"
SONIC_ENV_FILE="${SONIC_STACK_ENV_FILE:-$SONIC_DIR/.env}"
SONIC_ENV_EXAMPLE="$SONIC_DIR/.env.example"
SONIC_ENV_INIT_SCRIPT="$PROJECT_ROOT/scripts/sonic/init-stack-env.sh"

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

has_placeholder_passwords() {
  local mysql_password mysql_root_password
  mysql_password="$(read_env_value SONIC_MYSQL_PASSWORD "$SONIC_ENV_FILE")"
  mysql_root_password="$(read_env_value SONIC_MYSQL_ROOT_PASSWORD "$SONIC_ENV_FILE")"
  [ -z "$mysql_password" ] && return 0
  [ -z "$mysql_root_password" ] && return 0
  [ "$mysql_password" = "sonic_password_here" ] && return 0
  [ "$mysql_root_password" = "sonic_root_password_here" ] && return 0
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

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
    return
  fi
  echo ""
}

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

sync_mysql_credentials() {
  if ! command -v docker >/dev/null 2>&1; then
    return
  fi
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^nn-sonic-mysql$'; then
    return
  fi

  local database user password root_password
  database="$(read_env_value SONIC_MYSQL_DATABASE "$SONIC_ENV_FILE")"
  user="$(read_env_value SONIC_MYSQL_USER "$SONIC_ENV_FILE")"
  password="$(read_env_value SONIC_MYSQL_PASSWORD "$SONIC_ENV_FILE")"
  root_password="$(read_env_value SONIC_MYSQL_ROOT_PASSWORD "$SONIC_ENV_FILE")"

  database="${database:-sonic}"
  user="${user:-sonic}"

  if [ -z "$password" ] || [ -z "$root_password" ]; then
    echo "Skip Sonic MySQL credential sync: missing password in $SONIC_ENV_FILE."
    return
  fi

  echo "Syncing Sonic MySQL user credentials..."
  docker exec \
    -e SONIC_MYSQL_DATABASE="$database" \
    -e SONIC_MYSQL_USER="$user" \
    -e SONIC_MYSQL_PASSWORD="$password" \
    nn-sonic-mysql \
    sh -lc 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS \`$SONIC_MYSQL_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS "$SONIC_MYSQL_USER"@"%" IDENTIFIED BY "$SONIC_MYSQL_PASSWORD";
ALTER USER "$SONIC_MYSQL_USER"@"%" IDENTIFIED BY "$SONIC_MYSQL_PASSWORD";
GRANT ALL PRIVILEGES ON \`$SONIC_MYSQL_DATABASE\`.* TO "$SONIC_MYSQL_USER"@"%";
FLUSH PRIVILEGES;
SQL' >/dev/null 2>&1 || echo "WARN: failed to sync Sonic MySQL user credentials."
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

if [ ! -f "$SONIC_ENV_FILE" ] || has_placeholder_images || has_placeholder_passwords; then
  if [ -x "$SONIC_ENV_INIT_SCRIPT" ] || [ -f "$SONIC_ENV_INIT_SCRIPT" ]; then
    sh "$SONIC_ENV_INIT_SCRIPT"
  elif [ -f "$SONIC_ENV_EXAMPLE" ]; then
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

COMPOSE_CMD="$(compose_cmd)"
if [ -z "$COMPOSE_CMD" ]; then
  echo "Sonic Server/Web not started: docker compose or docker-compose command not found."
  exit 0
fi

echo "Starting Sonic Server/Web by docker compose..."
$COMPOSE_CMD -f "$SONIC_DIR/docker-compose.yml" --env-file "$SONIC_ENV_FILE" up -d
sync_mysql_credentials

if ! wait_http "http://127.0.0.1:${SONIC_API_PORT:-8094}" 12; then
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^nn-sonic-server$'; then
    if docker logs --tail 120 nn-sonic-server 2>&1 | grep -q 'HikariPool-1 - Starting'; then
      echo "Sonic Server appears stuck while opening datasource. Recreating sonic-server and sonic-web..."
      $COMPOSE_CMD -f "$SONIC_DIR/docker-compose.yml" --env-file "$SONIC_ENV_FILE" up -d --force-recreate sonic-server sonic-web
    fi
  fi
fi

if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^nn-sonic-web$'; then
  if docker logs --tail 80 nn-sonic-web 2>&1 | grep -q 'sonic-server-gateway'; then
    echo "Sonic Web upstream DNS is stale. Recreating Sonic Server/Web containers..."
    $COMPOSE_CMD -f "$SONIC_DIR/docker-compose.yml" --env-file "$SONIC_ENV_FILE" up -d --force-recreate sonic-server sonic-web
  fi
fi

$COMPOSE_CMD -f "$SONIC_DIR/docker-compose.yml" --env-file "$SONIC_ENV_FILE" ps
