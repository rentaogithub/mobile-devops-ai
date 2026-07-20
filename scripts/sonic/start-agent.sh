#!/bin/bash

# Start Sonic Agent together with nn-ios-platform when configured.
# The script is intentionally non-blocking: platform startup should not fail
# just because the local real-device agent is not installed yet.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${SONIC_AGENT_ENV_FILE:-$PROJECT_ROOT/backend/.env}"
STACK_ENV_FILE="${SONIC_STACK_ENV_FILE:-$PROJECT_ROOT/deploy/sonic/.env}"
DATA_DIR="${SONIC_AGENT_DATA_DIR:-$PROJECT_ROOT/nn-ios-platform-data}"
LOG_FILE="${SONIC_AGENT_LOG_FILE:-$PROJECT_ROOT/sonic-agent.log}"
PID_FILE="${SONIC_AGENT_PID_FILE:-$DATA_DIR/sonic-agent.pid}"

load_agent_env() {
  if [ ! -f "$ENV_FILE" ]; then
    return
  fi

  while IFS='=' read -r key value; do
    case "$key" in
      SONIC_AGENT_*|SONIC_API_PROXY_TARGET|SONIC_API_BASE|SONIC_HOST|CURRENT_DEVICE_IP)
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
  done < <(grep -E '^(SONIC_AGENT_|SONIC_API_PROXY_TARGET=|SONIC_API_BASE=|SONIC_HOST=|CURRENT_DEVICE_IP=)' "$ENV_FILE" || true)

  if [ -f "$STACK_ENV_FILE" ]; then
    while IFS='=' read -r key value; do
      case "$key" in
        SONIC_HOST|SONIC_AGENT_SERVER_PORT)
          if [ -z "${!key:-}" ]; then
            value="${value%%#*}"
            value="${value%$'\r'}"
            export "$key=$value"
          fi
          ;;
      esac
    done < <(grep -E '^(SONIC_HOST=|SONIC_AGENT_SERVER_PORT=)' "$STACK_ENV_FILE" || true)
  fi
}

is_process_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
}

detect_local_ipv4() {
  local interface address
  interface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
  if [ -n "$interface" ] && command -v ipconfig >/dev/null 2>&1; then
    address="$(ipconfig getifaddr "$interface" 2>/dev/null || true)"
  fi
  if [ -z "$address" ] && command -v ipconfig >/dev/null 2>&1; then
    address="$(ipconfig getifaddr en0 2>/dev/null || true)"
  fi
  printf '%s' "$address"
}

is_local_ipv4() {
  local address="$1"
  [ -n "$address" ] && ifconfig 2>/dev/null | grep -Eq "inet[[:space:]]+$address([[:space:]]|$)"
}

resolve_agent_host() {
  local configured detected
  configured="${SONIC_AGENT_HOST:-${CURRENT_DEVICE_IP:-${SONIC_HOST:-}}}"
  detected="$(detect_local_ipv4)"
  if is_local_ipv4 "$configured"; then
    printf '%s' "$configured"
  elif [ -n "$detected" ]; then
    printf '%s' "$detected"
  else
    printf '%s' "${configured:-127.0.0.1}"
  fi
}

resolve_server_port() {
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^nn-sonic-gateway$'; then
    printf '%s' "${SONIC_WEB_PORT:-3002}"
  else
    printf '%s' "${SONIC_AGENT_SERVER_PORT:-8095}"
  fi
}

resolve_server_host() {
  local server_port="$1"
  if [ -n "${SONIC_AGENT_SERVER_HOST:-}" ]; then
    printf '%s' "$SONIC_AGENT_SERVER_HOST"
  elif nc -z 127.0.0.1 "$server_port" >/dev/null 2>&1; then
    printf '%s' '127.0.0.1'
  else
    printf '%s' "${SONIC_HOST:-127.0.0.1}"
  fi
}

resolve_agent_key() {
  if [ -n "${SONIC_AGENT_KEY:-}" ]; then
    printf '%s' "$SONIC_AGENT_KEY"
    return
  fi
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^nn-sonic-mysql$'; then
    docker exec \
      -e SONIC_AGENT_NAME="${SONIC_AGENT_NAME:-nn-ios-platform-mac}" \
      nn-sonic-mysql \
      sh -lc 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SELECT secret_key FROM sonic.agents WHERE name = \"$SONIC_AGENT_NAME\" ORDER BY id DESC LIMIT 1"' \
      2>/dev/null || true
  fi
}

load_agent_env

if [ "${SONIC_AGENT_AUTO_START:-true}" = "false" ]; then
  echo "Sonic Agent auto start disabled."
  exit 0
fi

mkdir -p "$DATA_DIR"

if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_process_alive "$EXISTING_PID"; then
    echo "Sonic Agent already running: $EXISTING_PID"
    exit 0
  fi
fi

EXISTING_AGENT_PID="$(pgrep -f "sonic.*agent" 2>/dev/null | grep -v "^$$$" | head -n 1 || true)"
if [ -n "$EXISTING_AGENT_PID" ]; then
  echo "$EXISTING_AGENT_PID" > "$PID_FILE"
  echo "Sonic Agent appears to be running already: $EXISTING_AGENT_PID"
  exit 0
fi

AGENT_DIR="${SONIC_AGENT_DIR:-}"
AGENT_CMD="${SONIC_AGENT_CMD:-}"

prepare_agent_dir() {
  local prepare_script="$PROJECT_ROOT/scripts/sonic/prepare-agent.sh"
  if [ -x "$prepare_script" ]; then
    "$prepare_script" >/dev/null 2>&1 || true
  elif [ -f "$prepare_script" ]; then
    /bin/bash "$prepare_script" >/dev/null 2>&1 || true
  fi
}

detect_agent_dir() {
  local candidates=(
    "/Users/a1/工作/sonic-agent"
    "$PROJECT_ROOT/deploy/sonic-agent"
    "$PROJECT_ROOT/sonic-agent"
    "$HOME/sonic-agent"
    "$HOME/Downloads/sonic-agent"
    "/opt/sonic-agent"
    "/usr/local/sonic-agent"
    "/Users/a1/sonic-agent"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -x "$candidate/start.sh" ] || find "$candidate" -maxdepth 4 -type f -name 'sonic-agent*.jar' | head -n 1 | grep -q .; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

if [ -z "$AGENT_DIR" ] && [ -z "$AGENT_CMD" ]; then
  prepare_agent_dir
  AGENT_DIR="$(detect_agent_dir || true)"
  if [ -n "$AGENT_DIR" ]; then
    echo "Detected Sonic Agent dir: $AGENT_DIR"
  fi
fi

if [ -n "$AGENT_CMD" ]; then
  echo "Starting Sonic Agent by SONIC_AGENT_CMD..."
  nohup /bin/bash -lc "$AGENT_CMD" > "$LOG_FILE" 2>&1 &
elif [ -n "$AGENT_DIR" ] && find "$AGENT_DIR" -maxdepth 4 -type f -name 'sonic-agent*.jar' | head -n 1 | grep -q .; then
  AGENT_JAR="$(find "$AGENT_DIR" -maxdepth 4 -type f -name 'sonic-agent*.jar' | head -n 1)"
  AGENT_HOST="$(resolve_agent_host)"
  SERVER_PORT="$(resolve_server_port)"
  SERVER_HOST="$(resolve_server_host "$SERVER_PORT")"
  AGENT_KEY="$(resolve_agent_key)"
  echo "Starting Sonic Agent jar: $AGENT_JAR"
  echo "Agent host: $AGENT_HOST, Sonic Server: $SERVER_HOST:$SERVER_PORT"
  pushd "$AGENT_DIR" >/dev/null
  AGENT_ARGS=(
    --sonic.agent.host="$AGENT_HOST" \
    --sonic.server.host="$SERVER_HOST" \
    --sonic.server.port="$SERVER_PORT"
  )
  if [ -n "$AGENT_KEY" ]; then
    AGENT_ARGS+=(--sonic.agent.key="$AGENT_KEY")
  fi
  nohup java -jar "$AGENT_JAR" \
    "${AGENT_ARGS[@]}" \
    > "$LOG_FILE" 2>&1 &
  popd >/dev/null
elif [ -n "$AGENT_DIR" ] && [ -x "$AGENT_DIR/start.sh" ]; then
  echo "Starting Sonic Agent from $AGENT_DIR/start.sh..."
  pushd "$AGENT_DIR" >/dev/null
  nohup ./start.sh > "$LOG_FILE" 2>&1 &
  popd >/dev/null
else
  echo "Sonic Agent not configured or not found."
  if [ -n "$AGENT_DIR" ]; then
    echo "Configured SONIC_AGENT_DIR: $AGENT_DIR"
    if [ -d "$AGENT_DIR" ]; then
      echo "Directory exists, but the real Sonic Agent package is not installed."
      echo "No executable start.sh or sonic-agent*.jar was found under this directory."
    else
      echo "Directory does not exist."
    fi
  fi
  echo "If the standard Agent directory has not been created yet, run:"
  echo "  sh scripts/sonic/sonic.sh prepare"
  echo "Set one of the following in backend/.env:"
  echo "  SONIC_AGENT_DIR=/path/to/sonic-agent"
  echo "  SONIC_AGENT_CMD='cd /path/to/sonic-agent && sh start.sh'"
  echo "Sonic Agent log will be written to: $LOG_FILE"
  exit 0
fi

AGENT_PID=$!
echo "$AGENT_PID" > "$PID_FILE"
echo "Sonic Agent started: $AGENT_PID"
echo "Log: $LOG_FILE"
