#!/bin/bash

# Prepare the standard Sonic Agent directory on the fixed build Mac.
# This script creates a stable runtime directory and local instructions. It does
# not create a fake start.sh because the platform would then treat the Agent as
# installed and try to launch a placeholder.

set -e

AGENT_DIR="${SONIC_AGENT_DIR:-/Users/a1/工作/sonic-agent}"
API_BASE="${SONIC_AGENT_API_BASE:-http://127.0.0.1:8094}"
PACKAGE_PATH="${1:-${SONIC_AGENT_PACKAGE:-}}"
PACKAGE_URL="${SONIC_AGENT_PACKAGE_URL:-}"
GITHUB_LATEST_API="${SONIC_AGENT_GITHUB_LATEST_API:-https://api.github.com/repos/SonicCloudOrg/sonic-agent/releases/latest}"
AUTO_DOWNLOAD="${SONIC_AGENT_AUTO_DOWNLOAD:-true}"

mkdir -p "$AGENT_DIR"

resolve_github_latest_package_url() {
  if [ -n "$PACKAGE_URL" ] || [ "$AUTO_DOWNLOAD" = "false" ]; then
    return 0
  fi

  if find "$AGENT_DIR" -maxdepth 4 -type f \( -name 'sonic-agent*.zip' -o -name 'sonic-agent*.tar.gz' -o -name 'sonic-agent*.tgz' -o -name 'sonic-agent*.jar' \) | head -n 1 | grep -q .; then
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi

  local arch pattern release_json resolved_url
  arch="$(uname -m)"
  case "$arch" in
    arm64|aarch64)
      pattern='macosx_arm64'
      ;;
    x86_64|amd64)
      pattern='macosx_x86_64'
      ;;
    *)
      echo "WARN: unsupported macOS arch for Sonic Agent auto download: $arch"
      return 0
      ;;
  esac

  release_json="$(mktemp /tmp/sonic-agent-release.XXXXXX.json)"
  if ! curl -fL --connect-timeout 10 --retry 2 "$GITHUB_LATEST_API" -o "$release_json"; then
    echo "WARN: failed to query Sonic Agent GitHub release: $GITHUB_LATEST_API"
    rm -f "$release_json"
    return 0
  fi

  if command -v python3 >/dev/null 2>&1; then
    resolved_url="$(python3 - "$release_json" "$pattern" <<'PY'
import json
import sys

path, pattern = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

for asset in data.get("assets", []):
    name = asset.get("name", "")
    url = asset.get("browser_download_url", "")
    if pattern in name and name.endswith(".zip") and url:
        print(url)
        break
PY
)"
  else
    resolved_url="$(grep -o "https://github.com/SonicCloudOrg/sonic-agent/releases/download/[^\"]*${pattern}[^\"]*\\.zip" "$release_json" | head -n 1)"
  fi

  rm -f "$release_json"

  if [ -n "$resolved_url" ]; then
    PACKAGE_URL="$resolved_url"
    echo "Resolved Sonic Agent package for $arch: $PACKAGE_URL"
  else
    echo "WARN: no Sonic Agent macOS package found for $arch in latest GitHub release."
  fi
}

download_package_if_configured() {
  if [ -z "$PACKAGE_URL" ]; then
    return 0
  fi

  local filename
  filename="$(basename "${PACKAGE_URL%%\?*}")"
  if [ -z "$filename" ] || [ "$filename" = "/" ] || [ "$filename" = "." ]; then
    filename="sonic-agent-package"
  fi

  local target="$AGENT_DIR/$filename"
  if [ -f "$target" ]; then
    echo "Sonic Agent package already exists: $target"
    PACKAGE_PATH="$target"
    return 0
  fi

  echo "Downloading Sonic Agent package:"
  echo "  $PACKAGE_URL"
  echo "  -> $target"

  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 2 --connect-timeout 10 "$PACKAGE_URL" -o "$target"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$target" "$PACKAGE_URL"
  else
    echo "ERROR: curl or wget is required to download SONIC_AGENT_PACKAGE_URL." >&2
    exit 2
  fi

  PACKAGE_PATH="$target"
}

install_package_if_present() {
  local package="$PACKAGE_PATH"

  if [ -z "$package" ]; then
    package="$(find "$AGENT_DIR" -maxdepth 2 -type f \( -name 'sonic-agent*.zip' -o -name 'sonic-agent*.tar.gz' -o -name 'sonic-agent*.tgz' -o -name 'sonic-agent*.jar' \) | head -n 1)"
  fi

  if [ -z "$package" ]; then
    return 0
  fi

  if [ ! -f "$package" ]; then
    echo "WARN: Sonic Agent package not found: $package"
    return 0
  fi

  case "$package" in
    *.zip)
      echo "Installing Sonic Agent package: $package"
      unzip -oq "$package" -d "$AGENT_DIR"
      ;;
    *.tar.gz|*.tgz)
      echo "Installing Sonic Agent package: $package"
      tar -xzf "$package" -C "$AGENT_DIR"
      ;;
    *.jar)
      echo "Found Sonic Agent jar: $package"
      ;;
    *)
      echo "WARN: unsupported Sonic Agent package type: $package"
      ;;
  esac

  if [ -f "$AGENT_DIR/start.sh" ]; then
    chmod +x "$AGENT_DIR/start.sh"
  fi
}

write_start_script_if_possible() {
  if [ -x "$AGENT_DIR/start.sh" ]; then
    return 0
  fi

  if ! find "$AGENT_DIR" -maxdepth 4 -type f -name 'sonic-agent*.jar' | head -n 1 | grep -q .; then
    return 0
  fi

  cat > "$AGENT_DIR/start.sh" <<EOF
#!/bin/bash

set -e
cd "\$(dirname "\$0")"

AGENT_JAR="\$(find . -maxdepth 4 -type f -name 'sonic-agent*.jar' | head -n 1)"
AGENT_HOST="\${SONIC_AGENT_HOST:-\${CURRENT_DEVICE_IP:-\${SONIC_HOST:-127.0.0.1}}}"
SERVER_HOST="\${SONIC_AGENT_SERVER_HOST:-\${SONIC_HOST:-127.0.0.1}}"
SERVER_PORT="\${SONIC_AGENT_SERVER_PORT:-3002}"
AGENT_KEY="\${SONIC_AGENT_KEY:-}"

if [ -z "\$AGENT_JAR" ]; then
  echo "No sonic-agent*.jar found in \$(pwd)" >&2
  exit 1
fi

AGENT_ARGS=(
  --sonic.agent.host="\$AGENT_HOST" \
  --sonic.server.host="\$SERVER_HOST" \
  --sonic.server.port="\$SERVER_PORT"
)
if [ -n "\$AGENT_KEY" ]; then
  AGENT_ARGS+=(--sonic.agent.key="\$AGENT_KEY")
fi

exec java -jar "\$AGENT_JAR" "\${AGENT_ARGS[@]}"
EOF

  chmod +x "$AGENT_DIR/start.sh"
  echo "Generated Sonic Agent start script: $AGENT_DIR/start.sh"
}

resolve_github_latest_package_url
download_package_if_configured
install_package_if_present
write_start_script_if_possible

cat > "$AGENT_DIR/INSTALL_PACKAGE_HERE.txt" <<EOF
Put the real Sonic Agent runtime package in this directory.

The platform can auto-start the Agent only after one of these files exists:

  $AGENT_DIR/start.sh
  $AGENT_DIR/sonic-agent*.jar

This marker file is safe to delete after the real package is installed.
EOF

cat > "$AGENT_DIR/start.sh.template" <<EOF
#!/bin/bash

# Copy this file to start.sh only after the real Sonic Agent package is present.
# Example:
#   cp start.sh.template start.sh
#   chmod +x start.sh
#
# Then replace the command below with the actual Agent startup command from
# your Sonic Agent package.

set -e
cd "\$(dirname "\$0")"

echo "Replace start.sh.template with the real Sonic Agent startup command." >&2
exit 1
EOF

cat > "$AGENT_DIR/README.nn-ios-platform.md" <<EOF
# Sonic Agent for nn-ios-platform

This directory is reserved for the Sonic Agent runtime on the fixed Mac. The
prepare script only creates the directory and instructions. It does not install
the real Sonic Agent package.

Expected startup entries:

- \`$AGENT_DIR/start.sh\`
- or \`$AGENT_DIR/sonic-agent*.jar\`

Recommended backend/.env:

\`\`\`env
SONIC_AGENT_AUTO_START=true
SONIC_AGENT_DIR=$AGENT_DIR
SONIC_AGENT_AUTO_DOWNLOAD=true
SONIC_AGENT_GITHUB_LATEST_API=$GITHUB_LATEST_API
SONIC_AGENT_PACKAGE_URL=
SONIC_AGENT_CMD=
SONIC_AGENT_API_BASE=$API_BASE
\`\`\`

If your Agent package has an extra nested directory, point \`SONIC_AGENT_DIR\`
to the nested directory that contains \`start.sh\` or \`sonic-agent*.jar\`.
EOF

echo "Sonic Agent directory prepared: $AGENT_DIR"
if [ -n "$PACKAGE_URL" ]; then
  echo "Sonic Agent package URL: $PACKAGE_URL"
fi
echo "If a sonic-agent zip/tar/jar is placed in this directory, this script installs or detects it automatically."
echo "If sonic-agent*.jar exists and start.sh is missing, this script generates start.sh automatically."
echo
echo "Expected files:"
echo "  $AGENT_DIR/start.sh"
echo "  $AGENT_DIR/sonic-agent*.jar"
echo
echo "Current Sonic Agent directory files:"
find "$AGENT_DIR" -maxdepth 2 -mindepth 1 -print | sed 's/^/  /' || true
echo

if [ -x "$AGENT_DIR/start.sh" ]; then
  echo "OK: found executable start.sh"
elif find "$AGENT_DIR" -maxdepth 4 -type f -name 'sonic-agent*.jar' | head -n 1 | grep -q .; then
  echo "OK: found sonic-agent jar"
else
  echo "MISSING: no executable start.sh or sonic-agent*.jar found yet."
  echo "Put the real Sonic Agent release package into this directory, then run:"
  echo "  sh scripts/sonic/sonic.sh agent"
fi
