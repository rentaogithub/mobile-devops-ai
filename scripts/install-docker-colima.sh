#!/bin/bash

# Install a lightweight Docker runtime for the build Mac.
# This installs Docker CLI + Docker Compose + Colima instead of Docker Desktop.

set -e

COLIMA_CPU="${COLIMA_CPU:-4}"
COLIMA_MEMORY="${COLIMA_MEMORY:-8}"
COLIMA_DISK="${COLIMA_DISK:-80}"

log() {
  echo "==> $*"
}

warn() {
  echo "WARN: $*" >&2
}

ensure_command_line_tools() {
  if xcode-select -p >/dev/null 2>&1; then
    return
  fi

  warn "Xcode Command Line Tools 未安装。"
  warn "请先执行: xcode-select --install"
  exit 1
}

ensure_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    return
  fi

  log "安装 Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi

  if ! command -v brew >/dev/null 2>&1; then
    warn "Homebrew 安装完成，但当前 shell 未找到 brew。请重新打开终端后再执行本脚本。"
    exit 1
  fi
}

ensure_brew_package() {
  local package="$1"
  if brew list "$package" >/dev/null 2>&1; then
    log "$package 已安装"
    return
  fi

  log "安装 $package..."
  brew install "$package"
}

start_colima() {
  if colima status >/dev/null 2>&1; then
    log "Colima 已运行"
  else
    log "启动 Colima: cpu=$COLIMA_CPU memory=${COLIMA_MEMORY}GiB disk=${COLIMA_DISK}GiB"
    colima start --cpu "$COLIMA_CPU" --memory "$COLIMA_MEMORY" --disk "$COLIMA_DISK"
  fi

  docker context use colima >/dev/null 2>&1 || true
}

verify_docker() {
  log "验证 Docker..."
  docker version
  docker compose version
  docker run --rm hello-world >/tmp/nn-ios-platform-docker-hello.log
  log "Docker 验证通过"
}

main() {
  ensure_command_line_tools
  ensure_homebrew

  brew update
  ensure_brew_package docker
  ensure_brew_package docker-compose
  ensure_brew_package colima

  start_colima
  verify_docker

  cat <<'EOF'

Docker/Colima 已安装并启动。

可使用 docker compose 管理所需的容器服务。
EOF
}

main "$@"
