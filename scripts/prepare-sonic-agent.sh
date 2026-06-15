#!/bin/bash

# Prepare the standard Sonic Agent directory on the fixed build Mac.
# This script does not download a vendor package automatically because Sonic
# Agent release packages are usually managed internally. It creates the expected
# directory and a local README so the platform startup script can use a stable
# path after the real Agent package is placed there.

set -e

AGENT_DIR="${SONIC_AGENT_DIR:-/Users/a1/工作/sonic-agent}"
API_BASE="${SONIC_AGENT_API_BASE:-http://127.0.0.1:8094}"

mkdir -p "$AGENT_DIR"

cat > "$AGENT_DIR/README.nn-ios-platform.md" <<EOF
# Sonic Agent for nn-ios-platform

This directory is reserved for the Sonic Agent runtime on the fixed Mac.

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
  echo "Put the Sonic Agent release package into this directory, then run:"
  echo "  sh scripts/start-sonic-agent.sh"
fi

