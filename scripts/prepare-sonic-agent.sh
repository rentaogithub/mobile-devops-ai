#!/bin/bash

# Prepare the standard Sonic Agent directory on the fixed build Mac.
# This script creates a stable runtime directory and local instructions. It does
# not create a fake start.sh because the platform would then treat the Agent as
# installed and try to launch a placeholder.

set -e

AGENT_DIR="${SONIC_AGENT_DIR:-/Users/a1/工作/sonic-agent}"
API_BASE="${SONIC_AGENT_API_BASE:-http://127.0.0.1:8094}"
PACKAGE_PATH="${1:-${SONIC_AGENT_PACKAGE:-}}"

mkdir -p "$AGENT_DIR"

install_package_if_present() {
  local package="$PACKAGE_PATH"

  if [ -z "$package" ]; then
    package="$(find "$AGENT_DIR" -maxdepth 1 -type f \( -name 'sonic-agent*.zip' -o -name 'sonic-agent*.tar.gz' -o -name 'sonic-agent*.tgz' -o -name 'sonic-agent*.jar' \) | head -n 1)"
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

  if ! ls "$AGENT_DIR"/sonic-agent*.jar >/dev/null 2>&1; then
    return 0
  fi

  cat > "$AGENT_DIR/start.sh" <<EOF
#!/bin/bash

set -e
cd "\$(dirname "\$0")"

AGENT_JAR="\$(ls sonic-agent*.jar | head -n 1)"
API_BASE="\${SONIC_AGENT_API_BASE:-$API_BASE}"

if [ -z "\$AGENT_JAR" ]; then
  echo "No sonic-agent*.jar found in \$(pwd)" >&2
  exit 1
fi

exec java -jar "\$AGENT_JAR" --server.host="\$API_BASE"
EOF

  chmod +x "$AGENT_DIR/start.sh"
  echo "Generated Sonic Agent start script: $AGENT_DIR/start.sh"
}

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
SONIC_AGENT_CMD=
SONIC_AGENT_API_BASE=$API_BASE
\`\`\`

If your Agent package has an extra nested directory, point \`SONIC_AGENT_DIR\`
to the nested directory that contains \`start.sh\` or \`sonic-agent*.jar\`.
EOF

echo "Sonic Agent directory prepared: $AGENT_DIR"
echo "If a sonic-agent zip/tar/jar is placed in this directory, this script installs or detects it automatically."
echo "If sonic-agent*.jar exists and start.sh is missing, this script generates start.sh automatically."
echo
echo "Expected files:"
echo "  $AGENT_DIR/start.sh"
echo "  $AGENT_DIR/sonic-agent*.jar"
echo

if [ -x "$AGENT_DIR/start.sh" ]; then
  echo "OK: found executable start.sh"
elif ls "$AGENT_DIR"/sonic-agent*.jar >/dev/null 2>&1; then
  echo "OK: found sonic-agent jar"
else
  echo "MISSING: no executable start.sh or sonic-agent*.jar found yet."
  echo "Put the real Sonic Agent release package into this directory, then run:"
  echo "  sh scripts/start-sonic-agent.sh"
fi
