#!/usr/bin/env bash
set -euo pipefail

if [ -z "${BASH_VERSION:-}" ]; then
  echo "ERROR: please run this script with bash: bash scripts/jenkins/sync-nn-ios-platform-service-job.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$PROJECT_ROOT/backend/.env}"
CONFIG_TEMPLATE="${CONFIG_TEMPLATE:-$SCRIPT_DIR/nn-ios-platform-service-config.xml}"

read_env() {
  local key="$1"
  if [ -f "$ENV_FILE" ]; then
    grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
  fi
}

JENKINS_BASE_URL="${JENKINS_BASE_URL:-$(read_env JENKINS_BASE_URL)}"
JENKINS_PLATFORM_SERVICE_JOB="${JENKINS_PLATFORM_SERVICE_JOB:-$(read_env JENKINS_PLATFORM_SERVICE_JOB)}"
JENKINS_USER="${JENKINS_USER:-$(read_env JENKINS_USER)}"
JENKINS_TOKEN="${JENKINS_TOKEN:-$(read_env JENKINS_TOKEN)}"

JENKINS_BASE_URL="${JENKINS_BASE_URL:-http://127.0.0.1:8080}"
JENKINS_PLATFORM_SERVICE_JOB="${JENKINS_PLATFORM_SERVICE_JOB:-nn-ios-platform-service}"
JENKINS_BASE_URL="${JENKINS_BASE_URL%/}"

if [ ! -f "$CONFIG_TEMPLATE" ]; then
  echo "ERROR: Jenkins job config template not found: $CONFIG_TEMPLATE" >&2
  exit 1
fi

COOKIE_FILE="$(mktemp /tmp/jenkins-platform-service-cookie.XXXXXX)"
CRUMB_FILE="$(mktemp /tmp/jenkins-platform-service-crumb.XXXXXX.json)"
CONFIG_FILE="$(mktemp /tmp/jenkins-platform-service-config.XXXXXX.xml)"
RESPONSE_FILE="$(mktemp /tmp/jenkins-platform-service-response.XXXXXX.txt)"
trap 'rm -f "$COOKIE_FILE" "$CRUMB_FILE" "$CONFIG_FILE" "$RESPONSE_FILE"' EXIT

python3 - "$CONFIG_TEMPLATE" "$CONFIG_FILE" "$PROJECT_ROOT" <<'PY'
import html
import sys
from pathlib import Path

template_path, output_path, project_root = sys.argv[1:]
template = Path(template_path).read_text(encoding="utf-8")
placeholder = "__NN_IOS_PLATFORM_DIR__"
if template.count(placeholder) != 1:
    raise SystemExit(f"ERROR: expected exactly one {placeholder} placeholder")
Path(output_path).write_text(
    template.replace(placeholder, html.escape(project_root, quote=False)),
    encoding="utf-8",
)
PY

curl_args=(-sS)
if [ -n "${JENKINS_USER:-}" ] && [ -n "${JENKINS_TOKEN:-}" ]; then
  curl_args+=(-u "${JENKINS_USER}:${JENKINS_TOKEN}")
fi

echo "Jenkins: $JENKINS_BASE_URL"
echo "Job: $JENKINS_PLATFORM_SERVICE_JOB"
echo "Platform directory: $PROJECT_ROOT"

job_api="$JENKINS_BASE_URL/job/$JENKINS_PLATFORM_SERVICE_JOB/api/json"
job_status="$(curl "${curl_args[@]}" -o /dev/null -w "%{http_code}" "$job_api" || true)"
if [ "$job_status" = "000" ] || [ -z "$job_status" ]; then
  echo "ERROR: cannot connect Jenkins job API: $job_api" >&2
  exit 1
fi

crumb_header=""
if curl "${curl_args[@]}" -c "$COOKIE_FILE" "$JENKINS_BASE_URL/crumbIssuer/api/json" -o "$CRUMB_FILE"; then
  crumb_header="$(python3 -c "import json; d=json.load(open('$CRUMB_FILE')); print(d.get('crumbRequestField','Jenkins-Crumb') + ': ' + d.get('crumb',''))" 2>/dev/null || true)"
fi

post_args=("${curl_args[@]}" -b "$COOKIE_FILE" -o "$RESPONSE_FILE" -w "%{http_code}" -X POST -H "Content-Type: application/xml; charset=UTF-8")
if [ -n "$crumb_header" ]; then
  post_args+=(-H "$crumb_header")
fi

if [ "$job_status" = "200" ]; then
  echo "Updating existing Jenkins job..."
  http_status="$(curl "${post_args[@]}" --data-binary "@$CONFIG_FILE" "$JENKINS_BASE_URL/job/$JENKINS_PLATFORM_SERVICE_JOB/config.xml" || echo "curl_failed")"
else
  echo "Creating Jenkins job..."
  http_status="$(curl "${post_args[@]}" --data-binary "@$CONFIG_FILE" "$JENKINS_BASE_URL/createItem?name=$JENKINS_PLATFORM_SERVICE_JOB" || echo "curl_failed")"
fi

if [ "$http_status" = "200" ] || [ "$http_status" = "201" ] || [ "$http_status" = "302" ]; then
  echo "Jenkins job synced: $JENKINS_BASE_URL/job/$JENKINS_PLATFORM_SERVICE_JOB/"
  exit 0
fi

echo "ERROR: Jenkins job sync failed, HTTP $http_status" >&2
python3 -c "from pathlib import Path; import re; s=Path('$RESPONSE_FILE').read_text(errors='replace'); text=re.sub(r'<[^>]+>',' ',s); text=re.sub(r'\\s+',' ',text).strip(); print(text[:1200])" >&2
if [ -z "${JENKINS_USER:-}" ] || [ -z "${JENKINS_TOKEN:-}" ]; then
  echo "HINT: current request has no Jenkins API credentials. Set JENKINS_USER and JENKINS_TOKEN, then rerun this script." >&2
fi
exit 1
