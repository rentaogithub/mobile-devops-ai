#!/usr/bin/env bash
# Compatibility entry for existing Jenkins jobs. All execution lives in scripts/ios.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec /bin/bash "${SCRIPT_DIR}/../ios/ios-quality.sh" "$@"
