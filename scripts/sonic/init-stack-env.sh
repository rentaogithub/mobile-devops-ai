#!/bin/bash

# Initialize deploy/sonic/.env for the fixed 10.1.3.177 machine.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SONIC_DIR="${SONIC_STACK_DIR:-$PROJECT_ROOT/deploy/sonic}"
SONIC_ENV_FILE="${SONIC_STACK_ENV_FILE:-$SONIC_DIR/.env}"
SONIC_HOST="${SONIC_HOST:-10.1.3.177}"
SONIC_WEB_PORT="${SONIC_WEB_PORT:-3002}"
SONIC_API_PORT="${SONIC_API_PORT:-8094}"
SONIC_MYSQL_PORT="${SONIC_MYSQL_PORT:-3307}"
SONIC_REDIS_PORT="${SONIC_REDIS_PORT:-6380}"
SONIC_MYSQL_DATABASE="${SONIC_MYSQL_DATABASE:-sonic}"
SONIC_MYSQL_USER="${SONIC_MYSQL_USER:-sonic}"
SONIC_WEB_IMAGE="${SONIC_WEB_IMAGE:-sonicorg/sonic-client-web:v2.7.2}"
SONIC_SERVER_IMAGE="${SONIC_SERVER_IMAGE:-sonicorg/sonic-server-simple:v1.3.2-release}"

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
    return
  fi
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr -d '-' | tr '[:upper:]' '[:lower:]'
    return
  fi
  date +%s | shasum | awk '{print $1}'
}

replace_or_append() {
  local key="$1"
  local value="$2"
  local file="$3"
  if grep -qE "^${key}=" "$file"; then
    sed -i.bak "s#^${key}=.*#${key}=${value}#" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

mkdir -p "$SONIC_DIR"

if [ ! -f "$SONIC_ENV_FILE" ]; then
  cat > "$SONIC_ENV_FILE" <<EOF
# Sonic 服务访问地址
SONIC_HOST=${SONIC_HOST}
SONIC_WEB_PORT=${SONIC_WEB_PORT}
SONIC_API_PORT=${SONIC_API_PORT}

# 数据库与缓存
SONIC_MYSQL_PORT=${SONIC_MYSQL_PORT}
SONIC_REDIS_PORT=${SONIC_REDIS_PORT}
SONIC_MYSQL_DATABASE=${SONIC_MYSQL_DATABASE}
SONIC_MYSQL_USER=${SONIC_MYSQL_USER}
SONIC_MYSQL_PASSWORD=$(random_secret)
SONIC_MYSQL_ROOT_PASSWORD=$(random_secret)

# Sonic 官方镜像；如内部有镜像仓库，可在这里覆盖。
SONIC_WEB_IMAGE=${SONIC_WEB_IMAGE}
SONIC_SERVER_IMAGE=${SONIC_SERVER_IMAGE}

# 平台侧可使用：
# SONIC_API_BASE=http://${SONIC_HOST}:5173/sonic-api
# SONIC_WEB_URL=http://${SONIC_HOST}:5173/sonic-admin
# SONIC_API_PROXY_TARGET=http://127.0.0.1:${SONIC_API_PORT}
# SONIC_WEB_PROXY_TARGET=http://127.0.0.1:${SONIC_WEB_PORT}
EOF
  echo "Created Sonic env: $SONIC_ENV_FILE"
else
  replace_or_append SONIC_HOST "$SONIC_HOST" "$SONIC_ENV_FILE"
  replace_or_append SONIC_WEB_PORT "$SONIC_WEB_PORT" "$SONIC_ENV_FILE"
  replace_or_append SONIC_API_PORT "$SONIC_API_PORT" "$SONIC_ENV_FILE"
  replace_or_append SONIC_MYSQL_PORT "$SONIC_MYSQL_PORT" "$SONIC_ENV_FILE"
  replace_or_append SONIC_REDIS_PORT "$SONIC_REDIS_PORT" "$SONIC_ENV_FILE"
  replace_or_append SONIC_MYSQL_DATABASE "$SONIC_MYSQL_DATABASE" "$SONIC_ENV_FILE"
  replace_or_append SONIC_MYSQL_USER "$SONIC_MYSQL_USER" "$SONIC_ENV_FILE"

  if grep -qE '^SONIC_MYSQL_PASSWORD=(sonic_password_here)?$' "$SONIC_ENV_FILE"; then
    replace_or_append SONIC_MYSQL_PASSWORD "$(random_secret)" "$SONIC_ENV_FILE"
  fi
  if grep -qE '^SONIC_MYSQL_ROOT_PASSWORD=(sonic_root_password_here)?$' "$SONIC_ENV_FILE"; then
    replace_or_append SONIC_MYSQL_ROOT_PASSWORD "$(random_secret)" "$SONIC_ENV_FILE"
  fi

  replace_or_append SONIC_WEB_IMAGE "$SONIC_WEB_IMAGE" "$SONIC_ENV_FILE"
  replace_or_append SONIC_SERVER_IMAGE "$SONIC_SERVER_IMAGE" "$SONIC_ENV_FILE"
  echo "Updated Sonic env: $SONIC_ENV_FILE"
fi

rm -f "$SONIC_ENV_FILE.bak"
echo "SONIC_HOST=${SONIC_HOST}"
echo "SONIC_WEB_IMAGE=${SONIC_WEB_IMAGE}"
echo "SONIC_SERVER_IMAGE=${SONIC_SERVER_IMAGE}"
