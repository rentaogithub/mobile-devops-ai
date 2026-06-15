#!/bin/bash

# Start Sonic Agent together with nn-ios-platform when configured.
# The script is intentionally non-blocking: platform startup should not fail
# just because the local real-device agent is not installed yet.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${SONIC_AGENT_ENV_FILE:-$PROJECT_ROOT/backend/.env}"
DATA_DIR="${SONIC_AGENT_DATA_DIR:-$PROJECT_ROOT/nn-ios-platform-data}"
LOG_FILE="${SONIC_AGENT_LOG_FILE:-$PROJECT_ROOT/sonic-agent.log}"
PID_FILE="${SONIC_AGENT_PID_FILE:-$DATA_DIR/sonic-agent.pid}"

load_agent_env() {
  if [ ! -f "$ENV_FILE" ]; then
    return
  fi

  while IFS='=' read -r key value; do
    case "$key" in
      SONIC_AGENT_*|SONIC_API_PROXY_TARGET|SONIC_API_BASE)
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
  done < <(grep -E '^(SONIC_AGENT_|SONIC_API_PROXY_TARGET=|SONIC_API_BASE=)' "$ENV_FILE" || true)
}

is_process_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
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

if pgrep -f "sonic.*agent" 2>/dev/null | grep -v "^$$$" >/dev/null 2>&1; then
  echo "Sonic Agent appears to be running already."
  exit 0
fi

AGENT_DIR="${SONIC_AGENT_DIR:-}"
AGENT_CMD="${SONIC_AGENT_CMD:-}"

prepare_agent_dir() {
  local prepare_script="$PROJECT_ROOT/scripts/prepare-sonic-agent.sh"
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
elif [ -n "$AGENT_DIR" ] && [ -x "$AGENT_DIR/start.sh" ]; then
  echo "Starting Sonic Agent from $AGENT_DIR/start.sh..."
  pushd "$AGENT_DIR" >/dev/null
  nohup ./start.sh > "$LOG_FILE" 2>&1 &
  popd >/dev/null
elif [ -n "$AGENT_DIR" ] && find "$AGENT_DIR" -maxdepth 4 -type f -name 'sonic-agent*.jar' | head -n 1 | grep -q .; then
  AGENT_JAR="$(find "$AGENT_DIR" -maxdepth 4 -type f -name 'sonic-agent*.jar' | head -n 1)"
  API_BASE="${SONIC_AGENT_API_BASE:-${SONIC_API_PROXY_TARGET:-${SONIC_API_BASE:-http://127.0.0.1:8094}}}"
  echo "Starting Sonic Agent jar: $AGENT_JAR"
  pushd "$AGENT_DIR" >/dev/null
  nohup java -jar "$AGENT_JAR" --server.host="$API_BASE" > "$LOG_FILE" 2>&1 &
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
  echo "  sh scripts/prepare-sonic-agent.sh"
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
