#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec /usr/bin/env bash "$0" "$@"
fi

set -euo pipefail

# Jenkins nn-auto-quality job entry script.
# The stable default path is local Mac + USB iPhone. Sonic remains optional and
# can be integrated by a downstream script later, but platform startup and QA no
# longer depend on a Sonic Server/Web stack.

SOURCE_BUILD_NUMBER="${SOURCE_BUILD_NUMBER:-}"
BRANCH="${BRANCH:-}"
COMMIT_HASH="${COMMIT_HASH:-}"
APP_VERSION="${APP_VERSION:-}"
PACKAGE_URL="${PACKAGE_URL:-}"
XCARCHIVE_PATH="${XCARCHIVE_PATH:-}"
ARCHIVE_URL="${ARCHIVE_URL:-}"
TEST_SUITE="${TEST_SUITE:-smoke}"
REQUESTED_TEST_SUITE="${REQUESTED_TEST_SUITE:-${TEST_SUITE}}"
DEVICE_POOL="${DEVICE_POOL:-ios-default}"
DEVICE_POOL_LABEL="${DEVICE_POOL_LABEL:-${DEVICE_POOL}}"
if [ "${RUN_MONKEY:-}" = "1" ] || [[ "${QA_RUNNER_MODE:-}" == *"monkey"* ]] || [[ "${QUALITY_RUNNER:-}" == *"monkey"* ]] || [[ "${DEVICE_POOL_LABEL}" == *"suite:monkey"* ]]; then
  REQUESTED_TEST_SUITE="monkey"
fi
DEVICE_POOL_LABEL_DISPLAY="${DEVICE_POOL_LABEL// \[suite:monkey\]/}"
DEVICE_UDID="${DEVICE_UDID:-${DEVICE_SELECTOR:-}}"
DEVICE_CLOUD="${DEVICE_CLOUD:-LocalMac}"
APP_BUNDLE_ID="${APP_BUNDLE_ID:-com.nndev.im}"
DETECTED_BUNDLE_ID=""
DETECTED_EXECUTABLE_NAME=""
DETECTED_SHORT_VERSION=""
DETECTED_BUNDLE_VERSION=""
IPA_SHA256=""
IPA_MD5=""
DEVICE_IOS_VERSION=""

export PATH="$HOME/.local/bin:$HOME/Library/Python/3.9/bin:$HOME/Library/Python/3.10/bin:$HOME/Library/Python/3.11/bin:$HOME/Library/Python/3.12/bin:$HOME/Library/Python/3.13/bin:$HOME/Library/Python/3.14/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

WORKSPACE_DIR="${WORKSPACE:-$(pwd)}"
RESULT_NAME="${SOURCE_BUILD_NUMBER:-unknown}-${REQUESTED_TEST_SUITE}"
if [ -n "${BUILD_NUMBER:-}" ]; then
  RESULT_NAME="qa-${BUILD_NUMBER}-${RESULT_NAME}"
fi
RESULT_DIR="${WORKSPACE_DIR}/quality-results/${RESULT_NAME}"
REPORT_FILE="${RESULT_DIR}/junit.xml"
META_FILE="${RESULT_DIR}/metadata.json"
SUMMARY_FILE="${RESULT_DIR}/summary.json"
PROGRESS_FILE="${RESULT_DIR}/quality-progress.json"
LOG_FILE="${RESULT_DIR}/quality.log"
IPA_FILE="${RESULT_DIR}/app.ipa"
INSTALL_CACHE_DIR="${WORKSPACE_DIR}/quality-cache/install"
SCREENSHOT_FILE="${RESULT_DIR}/screenshot.png"
DEVICE_LOG_FILE="${RESULT_DIR}/device.log"
PROCESS_FILE="${RESULT_DIR}/processes.json"
MONKEY_REPORT_FILE="${RESULT_DIR}/monkey-report.json"
PERFORMANCE_SAMPLE_FILE="${RESULT_DIR}/performance-samples.jsonl"
PERFORMANCE_TRACE_FILE="${RESULT_DIR}/performance.trace"
PERFORMANCE_TRACE_ARCHIVE_FILE="${RESULT_DIR}/performance.trace.zip"
CRASH_REPORT_DIR="${RESULT_DIR}/crash-reports"
LAUNCH_METHOD=""
LAUNCH_STARTED_AT_MS=""
LAUNCH_FINISHED_AT_MS=""
LAUNCH_DURATION_MS=""
COLD_START_READY_MS=""
COLD_START_WAIT_SECONDS="${COLD_START_WAIT_SECONDS:-5}"
COLD_START_DETECT_SCREEN="${COLD_START_DETECT_SCREEN:-1}"
COLD_START_READY_TIMEOUT_SECONDS="${COLD_START_READY_TIMEOUT_SECONDS:-45}"
COLD_START_READY_POLL_SECONDS="${COLD_START_READY_POLL_SECONDS:-0.5}"
COLD_START_READY_MIN_ELEMENTS="${COLD_START_READY_MIN_ELEMENTS:-8}"
COLD_START_READY_TEXT="${COLD_START_READY_TEXT:-}"
INSTALL_TIMEOUT_SECONDS="${INSTALL_TIMEOUT_SECONDS:-180}"
SKIP_INSTALL_IF_SAME="${SKIP_INSTALL_IF_SAME:-1}"
WDA_URL="${WDA_URL:-http://127.0.0.1:8100}"
WDA_AUTO_START="${WDA_AUTO_START:-1}"
WDA_AUTO_INSTALL="${WDA_AUTO_INSTALL:-1}"
WDA_BIND_HOST="${WDA_BIND_HOST:-127.0.0.1}"
WDA_PROJECT_PATH="${WDA_PROJECT_PATH:-${WDA_PROJECT:-}}"
WDA_SCHEME="${WDA_SCHEME:-WebDriverAgentRunner}"
WDA_START_TIMEOUT_SECONDS="${WDA_START_TIMEOUT_SECONDS:-300}"
WDA_DEVELOPMENT_TEAM="${WDA_DEVELOPMENT_TEAM:-${QA_WDA_DEVELOPMENT_TEAM:-LX4548D2Q6}}"
WDA_BUNDLE_ID="${WDA_BUNDLE_ID:-${QA_WDA_BUNDLE_ID:-com.nndev.WebDriverAgentRunner}}"
WDA_DERIVED_DATA_PATH="${WDA_DERIVED_DATA_PATH:-${RESULT_DIR}/wda-derived-data}"
WDA_XCODEBUILD_EXTRA_ARGS="${WDA_XCODEBUILD_EXTRA_ARGS:-}"
MONKEY_RUNTIME_WDA_URL="${WDA_URL}"
WDA_READY_ERROR=""
MONKEY_EVENT_COUNT="${MONKEY_EVENT_COUNT:-30}"
MONKEY_DURATION_SECONDS="${MONKEY_DURATION_SECONDS:-14400}"
MONKEY_INTERVAL_SECONDS="${MONKEY_INTERVAL_SECONDS:-0.35}"
MONKEY_MAX_REPORTED_EVENTS="${MONKEY_MAX_REPORTED_EVENTS:-1000}"
MONKEY_BACK_INTERVAL_EVENTS="${MONKEY_BACK_INTERVAL_EVENTS:-25}"
MONKEY_STUCK_EVENTS="${MONKEY_STUCK_EVENTS:-18}"
MONKEY_STUCK_CHECK_INTERVAL_EVENTS="${MONKEY_STUCK_CHECK_INTERVAL_EVENTS:-10}"
MONKEY_BACK_ACTION_PROBABILITY="${MONKEY_BACK_ACTION_PROBABILITY:-0.12}"
MONKEY_BACK_TAP_PROBABILITY="${MONKEY_BACK_TAP_PROBABILITY:-0.35}"
MONKEY_AVOID_TOP_BAR="${MONKEY_AVOID_TOP_BAR:-1}"
MONKEY_HEARTBEAT_INTERVAL_SECONDS="${MONKEY_HEARTBEAT_INTERVAL_SECONDS:-10}"
MONKEY_WDA_MAX_RECOVERIES="${MONKEY_WDA_MAX_RECOVERIES:-8}"
MONKEY_WDA_RECOVERY_SLEEP_SECONDS="${MONKEY_WDA_RECOVERY_SLEEP_SECONDS:-12}"
MONKEY_WDA_RESTART_TIMEOUT_SECONDS="${MONKEY_WDA_RESTART_TIMEOUT_SECONDS:-120}"
MONKEY_FORBIDDEN_TEXTS="${MONKEY_FORBIDDEN_TEXTS:-debug,Debug,DEBUG,调试,调试工具,日志,控制台,FLEX,Doraemon,DoraemonKit,DoraemonEntryWindow,DoKit,Dokit,www.dokit.cn}"
MONKEY_FORBIDDEN_PAGE_TEXTS="${MONKEY_FORBIDDEN_PAGE_TEXTS:-DoKit,Dokit,www.dokit.cn,DoraemonEntryWindow}"
MONKEY_FORBIDDEN_REGION_RATIO="${MONKEY_FORBIDDEN_REGION_RATIO:-0.78,0.18,1.0,0.72}"
MONKEY_FORBIDDEN_PADDING="${MONKEY_FORBIDDEN_PADDING:-16}"
MONKEY_SEED="${MONKEY_SEED:-}"
MONKEY_STATUS="skipped"
MONKEY_MESSAGE=""
MONKEY_EXECUTED_EVENTS="0"
PERFORMANCE_SAMPLING="${PERFORMANCE_SAMPLING:-1}"
PERFORMANCE_SAMPLER="${PERFORMANCE_SAMPLER:-auto}"
PERFORMANCE_SAMPLE_TYPES="${PERFORMANCE_SAMPLE_TYPES:-cpu,memory,fps}"
PERFORMANCE_XCTRACE_TEMPLATE="${PERFORMANCE_XCTRACE_TEMPLATE:-Activity Monitor}"
PERF_COLD_START_WARN_MS="${PERF_COLD_START_WARN_MS:-8000}"
PERF_COLD_START_SLOW_MS="${PERF_COLD_START_SLOW_MS:-15000}"
PERF_CPU_AVG_WARN="${PERF_CPU_AVG_WARN:-80}"
PERF_MEMORY_PEAK_WARN_MB="${PERF_MEMORY_PEAK_WARN_MB:-1500}"
PERF_FPS_AVG_WARN="${PERF_FPS_AVG_WARN:-45}"
PERF_FPS_MIN_WARN="${PERF_FPS_MIN_WARN:-20}"

mkdir -p "${RESULT_DIR}"
rm -f "${RESULT_DIR}/wda-xcodebuild.pid" "${RESULT_DIR}/wda-iproxy.pid" "${RESULT_DIR}/performance-sampler.pid" "${RESULT_DIR}/performance-xctrace.pid"

cleanup_started_processes() {
  local pid_file pid
  for pid_file in "${RESULT_DIR}/wda-xcodebuild.pid" "${RESULT_DIR}/wda-iproxy.pid" "${RESULT_DIR}/performance-sampler.pid" "${RESULT_DIR}/performance-xctrace.pid"; do
    if [ ! -f "${pid_file}" ]; then
      continue
    fi
    pid="$(cat "${pid_file}" 2>/dev/null || true)"
    if [ -n "${pid}" ] && kill -0 "${pid}" >/dev/null 2>&1; then
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" >/dev/null 2>&1 || true
    fi
    rm -f "${pid_file}"
  done
}

trap cleanup_started_processes EXIT

log() {
  echo "$@" | tee -a "${LOG_FILE}"
}

log_return_func() {
  echo "$@" | tee -a "${LOG_FILE}" >&2
}

write_quality_progress() {
  local status="$1"
  local phase="${2:-}"
  local message="${3:-}"
  local percent="${4:-}"
  local executed="${5:-}"
  local elapsed="${6:-}"
  local remaining="${7:-}"
  python3 - "$PROGRESS_FILE" "$status" "$phase" "$message" "$percent" "$executed" "$elapsed" "$remaining" \
    "${MONKEY_EVENT_COUNT:-30}" "${MONKEY_DURATION_SECONDS:-0}" <<'PY' || true
import json
import os
import sys
import time

(
    progress_file,
    status,
    phase,
    message,
    percent,
    executed,
    elapsed,
    remaining,
    requested_events,
    requested_duration,
) = sys.argv[1:11]

def to_int(value, default=0):
    try:
        return int(float(value))
    except Exception:
        return default

def to_float(value, default=0.0):
    try:
        return float(value)
    except Exception:
        return default

def optional_int(value):
    if value == "":
        return None
    return to_int(value, 0)

def keep_or_int(value, current, default=0):
    if value == "":
        return to_int(current, default)
    return to_int(value, default)

def keep_or_optional_int(value, current):
    if value == "":
        return current
    return optional_int(value)

data = {}
if os.path.exists(progress_file):
    try:
        with open(progress_file, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}

current_percent = to_float(data.get("progressPercent"), 0.0)
if percent == "":
    next_percent = current_percent
else:
    next_percent = round(max(0.0, min(100.0, to_float(percent, 0.0))), 2)
if status == "running":
    next_percent = max(current_percent, next_percent)

data.update({
    "status": status,
    "phase": phase,
    "message": message,
    "updatedAt": int(time.time() * 1000),
    "elapsedSeconds": keep_or_int(elapsed, data.get("elapsedSeconds"), 0),
    "remainingSeconds": keep_or_optional_int(remaining, data.get("remainingSeconds")),
    "executedEvents": keep_or_int(executed, data.get("executedEvents"), 0),
    "requestedEvents": to_int(requested_events, 30),
    "requestedDurationSeconds": to_int(requested_duration, 0),
    "progressPercent": next_percent,
    "lastAction": data.get("lastAction"),
    "recentPerformance": data.get("recentPerformance") or {"sampleCount": 0, "cpu": None, "memoryMB": None, "fps": None},
})

tmp_path = f"{progress_file}.tmp"
os.makedirs(os.path.dirname(progress_file), exist_ok=True)
with open(tmp_path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
os.replace(tmp_path, progress_file)
PY
}

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

now_ms() {
  python3 -c 'import time; print(int(time.time() * 1000))'
}

mark_launch_finished() {
  local method="$1"
  LAUNCH_FINISHED_AT_MS="$(now_ms)"
  if [ -n "${LAUNCH_STARTED_AT_MS}" ]; then
    LAUNCH_DURATION_MS=$((LAUNCH_FINISHED_AT_MS - LAUNCH_STARTED_AT_MS))
  fi
  LAUNCH_METHOD="${method}"
  log "启动命令耗时: ${LAUNCH_DURATION_MS:-0}ms (${method})"
}

run_with_timeout() {
  local timeout_seconds="$1"
  shift
  python3 - "$timeout_seconds" "$@" <<'PY'
import subprocess
import sys

timeout = int(float(sys.argv[1]))
cmd = sys.argv[2:]
try:
    proc = subprocess.run(cmd, timeout=timeout)
    sys.exit(proc.returncode)
except subprocess.TimeoutExpired:
    print(f"命令超时({timeout}s): {' '.join(cmd)}", file=sys.stderr)
    sys.exit(124)
PY
}

compute_ipa_hashes() {
  if [ ! -s "${IPA_FILE}" ]; then
    return 1
  fi
  local hashes
  hashes="$(python3 - "${IPA_FILE}" <<'PY'
import hashlib
import sys

path = sys.argv[1]
sha256 = hashlib.sha256()
md5 = hashlib.md5()
with open(path, "rb") as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        sha256.update(chunk)
        md5.update(chunk)
print(sha256.hexdigest() + " " + md5.hexdigest())
PY
)"
  IPA_SHA256="${hashes%% *}"
  IPA_MD5="${hashes##* }"
}

write_report() {
  local failures="$1"
  local message="${2:-}"
  if [ "${failures}" = "0" ]; then
    cat > "${REPORT_FILE}" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="local-ios-quality" tests="1" failures="0" errors="0" skipped="0">
  <testcase classname="quality.${REQUESTED_TEST_SUITE}" name="Local iOS quality gate"/>
</testsuite>
XML
    return
  fi

  local escaped
  escaped="$(xml_escape "${message}")"
  cat > "${REPORT_FILE}" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="local-ios-quality" tests="1" failures="1" errors="0" skipped="0">
  <testcase classname="quality.preflight" name="Local iOS quality gate">
    <failure message="${escaped}">${escaped}</failure>
  </testcase>
</testsuite>
XML
}

fail() {
  local message="$1"
  log "ERROR: ${message}"
  if type stop_performance_sampling >/dev/null 2>&1; then
    stop_performance_sampling || true
  fi
  write_quality_progress "failed" "failed" "${message}" "" "${MONKEY_EXECUTED_EVENTS:-}" "" ""
  write_summary "failed" "${message}" || true
  write_standard_monkey_outputs || true
  write_report 1 "${message}"
  exit 1
}

install_with_devicectl() {
  if ! command -v xcrun >/dev/null 2>&1 || ! xcrun devicectl --help >/dev/null 2>&1; then
    log "未找到 xcrun devicectl，无法使用 devicectl 兜底安装。"
    return 1
  fi
  if ! command -v unzip >/dev/null 2>&1; then
    log "未找到 unzip，无法从 IPA 解出 .app 给 devicectl 安装。"
    return 1
  fi

  local app_extract_dir app_path devicectl_install_log bundle_id
  app_extract_dir="${RESULT_DIR}/devicectl-install-app"
  devicectl_install_log="${RESULT_DIR}/devicectl-install.log"
  bundle_id="${DETECTED_BUNDLE_ID:-${APP_BUNDLE_ID:-}}"
  rm -rf "${app_extract_dir}"
  mkdir -p "${app_extract_dir}"
  if ! unzip -q "${IPA_FILE}" 'Payload/*.app/*' -d "${app_extract_dir}" >/dev/null 2>&1; then
    log "解包 IPA 失败，无法使用 devicectl 兜底安装。"
    return 1
  fi
  app_path="$(find "${app_extract_dir}/Payload" -maxdepth 1 -type d -name '*.app' -print -quit 2>/dev/null || true)"
  if [ -z "${app_path}" ] || [ ! -d "${app_path}" ]; then
    log "IPA 中未找到 Payload/*.app，无法使用 devicectl 兜底安装。"
    return 1
  fi

  log "使用 devicectl 安装 App: ${app_path}"
  if xcrun devicectl device install app --device "${SELECTED_DEVICE}" --timeout "${INSTALL_TIMEOUT_SECONDS}" "${app_path}" 2>&1 | tee "${devicectl_install_log}" | tee -a "${LOG_FILE}"; then
    return 0
  fi
  if [ -n "${bundle_id}" ]; then
    log "devicectl 安装失败，尝试卸载 ${bundle_id} 后重试安装。"
    xcrun devicectl device uninstall app --device "${SELECTED_DEVICE}" --timeout 60 "${bundle_id}" 2>&1 | tee -a "${LOG_FILE}" || true
    sleep 2
    if xcrun devicectl device install app --device "${SELECTED_DEVICE}" --timeout "${INSTALL_TIMEOUT_SECONDS}" "${app_path}" 2>&1 | tee -a "${LOG_FILE}"; then
      return 0
    fi
  fi
  log "devicectl 安装失败，日志: ${devicectl_install_log}"
  return 1
}

install_ipa() {
  if should_skip_install; then
    write_quality_progress "running" "install" "检测到相同 IPA 指纹，跳过重复安装" 12
    return 0
  fi

  log "安装 IPA..."
  write_quality_progress "running" "install" "安装 IPA..." 10
  local install_status=0
  run_with_timeout "${INSTALL_TIMEOUT_SECONDS}" "${TIDEVICE_CMD}" --udid "${SELECTED_DEVICE}" install "${IPA_FILE}" 2>&1 | tee -a "${LOG_FILE}" || install_status=${PIPESTATUS[0]}
  if [ "${install_status}" = "0" ]; then
    record_install_cache
    return 0
  fi

  if [ "${install_status}" = "124" ]; then
    log "tidevice 安装 IPA 超时(${INSTALL_TIMEOUT_SECONDS}s)，尝试使用 Xcode devicectl 兜底安装。"
  else
    log "tidevice 安装 IPA 失败(exit=${install_status})，尝试使用 Xcode devicectl 兜底安装。"
  fi
  if install_with_devicectl; then
    record_install_cache
    return 0
  fi
  return 1
}

write_summary() {
  local status="$1"
  local message="${2:-}"
  python3 - "$SUMMARY_FILE" \
    "$status" "$message" "${SOURCE_BUILD_NUMBER:-}" "${BRANCH:-}" "${COMMIT_HASH:-}" "${APP_VERSION:-}" \
    "${REQUESTED_TEST_SUITE:-${TEST_SUITE:-}}" "${DEVICE_POOL:-}" "${DEVICE_POOL_LABEL_DISPLAY:-${DEVICE_POOL_LABEL:-}}" "${SELECTED_DEVICE:-}" "${LAUNCH_BUNDLE_ID:-}" \
    "${DETECTED_BUNDLE_ID:-}" "${LAUNCH_METHOD:-}" "${LAUNCH_DURATION_MS:-}" "${COLD_START_READY_MS:-}" "${COLD_START_WAIT_SECONDS:-}" \
	    "${MONKEY_STATUS:-}" "${MONKEY_MESSAGE:-}" "${MONKEY_EXECUTED_EVENTS:-}" "${MONKEY_EVENT_COUNT:-}" "${MONKEY_RUNTIME_WDA_URL:-${WDA_URL:-}}" \
	    "${RESULT_DIR:-}" "${SCREENSHOT_FILE:-}" "${DEVICE_LOG_FILE:-}" "${PROCESS_FILE:-}" "${MONKEY_REPORT_FILE:-}" "${PERFORMANCE_SAMPLE_FILE:-}" "${PERFORMANCE_TRACE_ARCHIVE_FILE:-}" "${PERFORMANCE_TRACE_FILE:-}" "${CRASH_REPORT_DIR:-}" \
	    "${PERF_COLD_START_WARN_MS:-8000}" "${PERF_COLD_START_SLOW_MS:-15000}" "${PERF_CPU_AVG_WARN:-80}" "${PERF_MEMORY_PEAK_WARN_MB:-1500}" "${PERF_FPS_AVG_WARN:-45}" "${PERF_FPS_MIN_WARN:-20}" <<'PY'
import json
import os
import re
import sys

summary_path = sys.argv[1]
(
    status,
    message,
    source_build_number,
    branch,
    commit_hash,
    app_version,
    test_suite,
    device_pool,
    device_pool_label,
    device_udid,
    launch_bundle_id,
    detected_bundle_id,
    launch_method,
    launch_duration_ms,
    cold_start_ready_ms,
    cold_start_wait_seconds,
    monkey_status,
    monkey_message,
    monkey_executed_events,
    monkey_event_count,
    wda_url,
    result_dir,
    screenshot_file,
    device_log_file,
    process_file,
    monkey_report_file,
    performance_sample_file,
    performance_trace_archive_file,
    performance_trace_file,
    crash_report_dir,
    cold_start_warn_ms,
    cold_start_slow_ms,
    cpu_avg_warn,
    memory_peak_warn_mb,
    fps_avg_warn,
    fps_min_warn,
) = sys.argv[2:38]

def to_int(value):
    try:
        return int(value)
    except Exception:
        return None

def rel(path):
    if not path:
        return ""
    try:
        return os.path.relpath(path, result_dir)
    except Exception:
        return path

def read_text(path, limit_bytes=2 * 1024 * 1024):
    if not path or not os.path.exists(path):
        return ""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > limit_bytes:
                f.seek(max(0, size - limit_bytes))
            return f.read().decode("utf-8", errors="replace")
    except Exception:
        return ""

def analyze_exceptions(device_log_path, quality_log_path, bundle_id):
    patterns = [
        ("crash", re.compile(r"\b(crash|crashed|fatal signal|segmentation fault|SIGABRT|SIGSEGV)\b", re.I)),
        ("exception", re.compile(r"\b(NSException|uncaught exception|terminating app|Fatal error|Assertion failed)\b", re.I)),
        ("watchdog", re.compile(r"\b(watchdog|0x8badf00d|main thread.*hang|hang detected)\b", re.I)),
        ("memory", re.compile(r"\b(jetsam|out of memory|memory pressure|EXC_RESOURCE|OOM)\b", re.I)),
        ("error", re.compile(r"\b(error|ERROR|failed|Failed)\b")),
    ]
    text = "\n".join([read_text(device_log_path), read_text(quality_log_path)])
    bundle_id = bundle_id or ""
    counts = {name: 0 for name, _pattern in patterns}
    samples = []
    seen = set()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if bundle_id and bundle_id not in line and not any(token in line for token in ("NNIM", "SpringBoard", "ReportCrash", "JetsamEvent")):
            continue
        matched = []
        for name, pattern in patterns:
            if pattern.search(line):
                counts[name] += 1
                matched.append(name)
        if matched:
            compact = re.sub(r"\s+", " ", line)[:500]
            if compact not in seen and len(samples) < 8:
                samples.append({"type": matched[0], "message": compact})
                seen.add(compact)
    severity = "passed"
    if counts["crash"] or counts["exception"] or counts["watchdog"] or counts["memory"]:
        severity = "failed"
    elif counts["error"]:
        severity = "warning"
    return {
        "severity": severity,
        "crashCount": counts["crash"],
        "exceptionCount": counts["exception"],
        "watchdogCount": counts["watchdog"],
        "memoryIssueCount": counts["memory"],
        "errorCount": counts["error"],
        "samples": samples,
    }

def analyze_crash_reports(crash_dir, bundle_id):
    files = []
    samples = []
    if not crash_dir or not os.path.isdir(crash_dir):
        return {
            "count": 0,
            "files": files,
            "samples": samples,
        }

    bundle_id = bundle_id or ""
    for root, _dirs, names in os.walk(crash_dir):
        for name in names:
            if not re.search(r"\.(ips|crash|log)$", name, re.I):
                continue
            full_path = os.path.join(root, name)
            text = read_text(full_path, limit_bytes=512 * 1024)
            if bundle_id and bundle_id not in text and bundle_id not in name:
                continue
            rel_path = rel(full_path)
            files.append(rel_path)
            if len(samples) >= 5:
                continue
            proc = re.search(r"^(?:Process|procName):\s*(.+)$", text, re.M)
            exception = re.search(r"^(?:Exception Type|exception):\s*(.+)$", text, re.M)
            reason = re.search(r"^(?:Exception Reason|Termination Reason|reason):\s*(.+)$", text, re.M)
            crashed_thread = re.search(r"^(?:Crashed Thread|crashedThread):\s*(.+)$", text, re.M)
            samples.append({
                "file": rel_path,
                "process": proc.group(1).strip()[:160] if proc else "",
                "exception": exception.group(1).strip()[:160] if exception else "",
                "reason": reason.group(1).strip()[:240] if reason else "",
                "crashedThread": crashed_thread.group(1).strip()[:80] if crashed_thread else "",
            })
    files.sort()
    return {
        "count": len(files),
        "files": files[:20],
        "samples": samples,
    }

def to_float(value, default=None):
    try:
        if value is None or value == "":
            return default
        return float(value)
    except Exception:
        return default

def analyze_performance(launch_ms, cold_ms, monkey_report_path, thresholds):
    def grade_start(value):
        if value is None:
            return "unknown"
        if value <= thresholds["coldStartWarnMs"]:
            return "good"
        if value <= thresholds["coldStartSlowMs"]:
            return "warning"
        return "slow"

    monkey_duration_ms = None
    monkey_events = None
    monkey_events_per_minute = None
    monkey_status = ""
    if monkey_report_path and os.path.exists(monkey_report_path):
        try:
            report = json.load(open(monkey_report_path, encoding="utf-8"))
            monkey_duration_ms = report.get("durationMs")
            monkey_events = report.get("executedEvents")
            monkey_status = str(report.get("status") or "")
            if monkey_duration_ms and monkey_events is not None:
                minutes = max(float(monkey_duration_ms) / 60000.0, 0.001)
                monkey_events_per_minute = round(float(monkey_events) / minutes, 2)
        except Exception:
            pass

    return {
        "launchDurationMs": launch_ms,
        "coldStartReadyMs": cold_ms,
        "coldStartGrade": grade_start(cold_ms),
        "monkeyDurationMs": monkey_duration_ms,
        "monkeyExecutedEvents": monkey_events,
        "monkeyEventsPerMinute": monkey_events_per_minute,
        "monkeyStatus": monkey_status,
    }

def build_performance_conclusions(performance, samples, thresholds):
    issues = []
    cold_ms = performance.get("coldStartReadyMs")
    if cold_ms is not None:
        if cold_ms > thresholds["coldStartSlowMs"]:
            issues.append({"severity": "failed", "metric": "coldStartReadyMs", "message": f"首屏耗时 {cold_ms}ms，超过慢启动阈值 {thresholds['coldStartSlowMs']}ms"})
        elif cold_ms > thresholds["coldStartWarnMs"]:
            issues.append({"severity": "warning", "metric": "coldStartReadyMs", "message": f"首屏耗时 {cold_ms}ms，超过预警阈值 {thresholds['coldStartWarnMs']}ms"})

    cpu_avg = ((samples or {}).get("cpu") or {}).get("avg")
    if cpu_avg is not None and cpu_avg > thresholds["cpuAvgWarn"]:
        issues.append({"severity": "warning", "metric": "cpu.avg", "message": f"CPU 平均 {cpu_avg}%，超过阈值 {thresholds['cpuAvgWarn']}%"})

    mem_max = ((samples or {}).get("memoryMB") or {}).get("max")
    if mem_max is not None and mem_max > thresholds["memoryPeakWarnMB"]:
        issues.append({"severity": "warning", "metric": "memory.max", "message": f"内存峰值 {mem_max}MB，超过阈值 {thresholds['memoryPeakWarnMB']}MB"})

    fps_avg = ((samples or {}).get("fps") or {}).get("avg")
    if fps_avg is not None and fps_avg < thresholds["fpsAvgWarn"]:
        issues.append({"severity": "warning", "metric": "fps.avg", "message": f"FPS 平均 {fps_avg}，低于阈值 {thresholds['fpsAvgWarn']}"})

    fps_min = ((samples or {}).get("fps") or {}).get("min")
    if fps_min is not None and fps_min < thresholds["fpsMinWarn"]:
        issues.append({"severity": "warning", "metric": "fps.min", "message": f"FPS 最低 {fps_min}，低于阈值 {thresholds['fpsMinWarn']}"})

    severity = "passed"
    if any(item["severity"] == "failed" for item in issues):
        severity = "failed"
    elif issues:
        severity = "warning"
    return {
        "severity": severity,
        "issues": issues,
    }

def collect_numbers(value, path=""):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from collect_numbers(child, f"{path}.{key}" if path else str(key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from collect_numbers(child, f"{path}.{index}" if path else str(index))
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        yield path.lower(), float(value)

def summarize_series(values):
    if not values:
        return {"avg": None, "max": None, "min": None}
    return {
        "avg": round(sum(values) / len(values), 2),
        "max": round(max(values), 2),
        "min": round(min(values), 2),
    }

def analyze_performance_samples(path):
    cpu_values = []
    memory_values = []
    fps_values = []
    sample_count = 0
    if not path or not os.path.exists(path):
        return {
            "sampleCount": 0,
            "cpu": summarize_series(cpu_values),
            "memoryMB": summarize_series(memory_values),
            "fps": summarize_series(fps_values),
        }
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except Exception:
                    continue
                sample_count += 1
                for key_path, number in collect_numbers(item):
                    if "cpu" in key_path and 0 <= number <= 1000:
                        cpu_values.append(number)
                    elif "fps" in key_path and 0 <= number <= 240:
                        fps_values.append(number)
                    elif any(token in key_path for token in ("memory", "mem", "resident", "rss")) and number > 0:
                        memory_values.append(number / 1024 / 1024 if number > 1024 * 1024 else number)
    except Exception:
        pass
    return {
        "sampleCount": sample_count,
        "cpu": summarize_series(cpu_values),
        "memoryMB": summarize_series(memory_values),
        "fps": summarize_series(fps_values),
    }

data = {
    "status": status,
    "message": message,
    "sourceBuildNumber": source_build_number,
    "branch": branch,
    "commitHash": commit_hash,
    "appVersion": app_version,
    "testSuite": test_suite,
    "devicePool": device_pool,
    "devicePoolLabel": device_pool_label,
    "deviceUdid": device_udid,
    "bundleId": launch_bundle_id,
    "detectedBundleId": detected_bundle_id,
    "launchMethod": launch_method,
    "launchDurationMs": to_int(launch_duration_ms),
    "coldStartReadyMs": to_int(cold_start_ready_ms),
    "coldStartWaitSeconds": to_int(cold_start_wait_seconds),
    "monkeyStatus": monkey_status,
    "monkeyMessage": monkey_message,
    "monkeyExecutedEvents": to_int(monkey_executed_events),
    "monkeyEventCount": to_int(monkey_event_count),
    "wdaUrl": wda_url,
    "artifacts": {
        "screenshot": rel(screenshot_file) if os.path.exists(screenshot_file) else "",
        "deviceLog": rel(device_log_file) if os.path.exists(device_log_file) else "",
	        "processes": rel(process_file) if os.path.exists(process_file) else "",
        "monkeyReport": rel(monkey_report_file) if os.path.exists(monkey_report_file) else "",
        "performanceSamples": rel(performance_sample_file) if os.path.exists(performance_sample_file) else "",
        "performanceTrace": rel(performance_trace_archive_file) if os.path.exists(performance_trace_archive_file) else "",
        "crashReports": rel(crash_report_dir) if os.path.isdir(crash_report_dir) else "",
	        "junit": "junit.xml",
        "qualityLog": "quality.log",
    },
}
thresholds = {
    "coldStartWarnMs": to_float(cold_start_warn_ms, 8000),
    "coldStartSlowMs": to_float(cold_start_slow_ms, 15000),
    "cpuAvgWarn": to_float(cpu_avg_warn, 80),
    "memoryPeakWarnMB": to_float(memory_peak_warn_mb, 1500),
    "fpsAvgWarn": to_float(fps_avg_warn, 45),
    "fpsMinWarn": to_float(fps_min_warn, 20),
}
data["exceptionAnalysis"] = analyze_exceptions(device_log_file, os.path.join(result_dir, "quality.log"), launch_bundle_id or detected_bundle_id)
data["exceptionAnalysis"]["crashReports"] = analyze_crash_reports(crash_report_dir, launch_bundle_id or detected_bundle_id)
if data["exceptionAnalysis"]["crashReports"].get("count", 0) > 0:
    data["exceptionAnalysis"]["severity"] = "failed"
    data["exceptionAnalysis"]["crashCount"] = max(data["exceptionAnalysis"].get("crashCount") or 0, data["exceptionAnalysis"]["crashReports"]["count"])
data["performanceAnalysis"] = analyze_performance(
    data.get("launchDurationMs"),
    data.get("coldStartReadyMs"),
    monkey_report_file,
    thresholds,
)
data["performanceAnalysis"]["samples"] = analyze_performance_samples(performance_sample_file)
data["performanceAnalysis"]["thresholds"] = thresholds
data["performanceAnalysis"]["conclusion"] = build_performance_conclusions(
    data["performanceAnalysis"],
    data["performanceAnalysis"].get("samples"),
    thresholds,
)
with open(summary_path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
PY
}

write_standard_monkey_outputs() {
  python3 - "$SUMMARY_FILE" "$RESULT_DIR" "$BUILD_NUMBER" <<'PY'
import html
import json
import os
import sys
import time

summary_path, result_dir, build_number = sys.argv[1:4]

def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default

def write_json(path, value):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)

def issue(issue_type, severity, title, fingerprint, refs=None, count=1, screen=""):
    return {
        "id": f"issue_{len(issues) + 1:03d}",
        "type": issue_type,
        "severity": severity,
        "title": title,
        "fingerprint": fingerprint or title,
        "is_new": False,
        "count": count,
        "screen": screen,
        "first_seen_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "artifact_refs": refs or {},
    }

summary = read_json(summary_path, {})
progress = read_json(os.path.join(result_dir, "quality-progress.json"), {})
issues = []

exception = summary.get("exceptionAnalysis") or {}
crash_reports = exception.get("crashReports") or {}
for sample in crash_reports.get("samples") or []:
    title = sample.get("exception") or sample.get("process") or sample.get("file") or "Crash report"
    issues.append(issue(
        "crash",
        "blocker",
        title,
        "|".join(str(x) for x in ["crash", sample.get("process"), sample.get("exception"), sample.get("reason")] if x),
        {"stack": sample.get("file", "")},
    ))

if (exception.get("memoryIssueCount") or 0) > 0:
    issues.append(issue("oom", "blocker", "疑似 OOM / Jetsam", "oom|memory", {"deviceLog": "device.log"}, exception.get("memoryIssueCount") or 1))

if (exception.get("watchdogCount") or 0) > 0:
    issues.append(issue("stuck", "blocker", "疑似卡死 / Watchdog", "stuck|watchdog", {"deviceLog": "device.log"}, exception.get("watchdogCount") or 1))

for item in ((summary.get("performanceAnalysis") or {}).get("conclusion") or {}).get("issues") or []:
    severity = "blocker" if item.get("severity") == "failed" else "warning"
    issues.append(issue(
        "performance",
        severity,
        item.get("message") or item.get("metric") or "性能异常",
        "|".join(str(x) for x in ["performance", item.get("metric"), item.get("message")] if x),
        {"performance": summary.get("artifacts", {}).get("performanceSamples", "")},
    ))

blocker_count = sum(1 for item in issues if item.get("severity") == "blocker")
warning_count = sum(1 for item in issues if item.get("severity") == "warning")
status = "success"
if summary.get("status") == "failed" or blocker_count > 0:
    status = "failed"
elif warning_count > 0 or (summary.get("performanceAnalysis", {}).get("conclusion", {}).get("severity") == "warning"):
    status = "unstable"

duration_seconds = None
monkey_duration_ms = (summary.get("performanceAnalysis") or {}).get("monkeyDurationMs")
if isinstance(monkey_duration_ms, (int, float)):
    duration_seconds = int(monkey_duration_ms / 1000)

result = {
    "schema_version": "quality.task.result.v1",
    "task_id": f"jenkins:nn-auto-quality:{build_number}" if build_number else "",
    "task_type": "ios_monkey" if summary.get("testSuite") == "monkey" else f"ios_{summary.get('testSuite') or 'quality'}",
    "status": status,
    "passed": status == "success",
    "project_id": "nn-ios",
    "app": {
        "name": "NNIM",
        "bundle_id": summary.get("bundleId") or summary.get("detectedBundleId") or "",
        "version": summary.get("appVersion") or "",
        "build": summary.get("sourceBuildNumber") or "",
        "branch": summary.get("branch") or "",
        "commit": summary.get("commitHash") or "",
    },
    "device": {
        "udid": summary.get("deviceUdid") or "",
        "pool": summary.get("devicePool") or "",
        "pool_label": summary.get("devicePoolLabel") or "",
    },
    "monkey": {
        "status": summary.get("monkeyStatus") or "",
        "message": summary.get("monkeyMessage") or "",
        "duration_seconds": duration_seconds,
        "executed_actions": summary.get("monkeyExecutedEvents") or 0,
        "requested_actions": summary.get("monkeyEventCount") or 0,
        "events_per_minute": (summary.get("performanceAnalysis") or {}).get("monkeyEventsPerMinute"),
        "seed": summary.get("monkeySeed") or "",
    },
    "quality_gate": {
        "passed": status == "success",
        "blocker_count": blocker_count,
        "warning_count": warning_count,
        "rules": {
            "max_new_crash": 0,
            "max_oom": 0,
            "max_blocker_stuck": 0,
            "max_critical_white_screen": 0,
        },
    },
    "metrics": {
        "launch_duration_ms": summary.get("launchDurationMs"),
        "cold_start_ready_ms": summary.get("coldStartReadyMs"),
        "crash_count": summary.get("exceptionAnalysis", {}).get("crashCount", 0),
        "oom_count": summary.get("exceptionAnalysis", {}).get("memoryIssueCount", 0),
        "stuck_count": summary.get("exceptionAnalysis", {}).get("watchdogCount", 0),
        "white_screen_count": 0,
        "performance": summary.get("performanceAnalysis") or {},
    },
    "issues": issues,
    "artifacts": {
        **(summary.get("artifacts") or {}),
        "result": "result.json",
        "issues": "issues.json",
        "summaryMarkdown": "summary.md",
        "reportHtml": "report.html",
    },
    "progress": progress,
    "message": summary.get("message") or "",
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
}

write_json(os.path.join(result_dir, "result.json"), result)
write_json(os.path.join(result_dir, "issues.json"), {"task_id": result["task_id"], "issues": issues})

summary_lines = [
    f"# iOS Monkey 质检结果",
    "",
    f"- 任务: {result['task_id'] or '-'}",
    f"- 结果: {status}",
    f"- App: {result['app']['version'] or '-'} build {result['app']['build'] or '-'}",
    f"- Bundle ID: {result['app']['bundle_id'] or '-'}",
    f"- 设备: {result['device']['udid'] or '-'} / {result['device']['pool_label'] or result['device']['pool'] or '-'}",
    f"- 执行: {result['monkey']['executed_actions']} 次，{duration_seconds or 0} 秒",
    f"- Crash: {result['metrics']['crash_count']}，OOM: {result['metrics']['oom_count']}，卡死: {result['metrics']['stuck_count']}",
    "",
    "## 结论",
    result["message"] or "-",
]
if issues:
    summary_lines.extend(["", "## 问题列表"])
    for item in issues[:20]:
        summary_lines.append(f"- [{item['severity']}] {item['type']}: {item['title']}")
with open(os.path.join(result_dir, "summary.md"), "w", encoding="utf-8") as f:
    f.write("\n".join(summary_lines) + "\n")

issue_rows = "\n".join(
    f"<tr><td>{html.escape(item['severity'])}</td><td>{html.escape(item['type'])}</td><td>{html.escape(item['title'])}</td><td><code>{html.escape(item['fingerprint'])}</code></td></tr>"
    for item in issues
) or "<tr><td colspan='4'>无阻断问题</td></tr>"
report_html = f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>iOS Monkey 质检报告</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 24px; color: #1f2328; }}
    h1 {{ margin-bottom: 8px; }}
    .meta {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin: 16px 0; }}
    .card {{ border: 1px solid #d0d7de; border-radius: 6px; padding: 12px; }}
    table {{ border-collapse: collapse; width: 100%; margin-top: 12px; }}
    th, td {{ border: 1px solid #d0d7de; padding: 8px; text-align: left; vertical-align: top; }}
    th {{ background: #f6f8fa; }}
    code {{ white-space: pre-wrap; word-break: break-word; }}
  </style>
</head>
<body>
  <h1>iOS Monkey 质检报告</h1>
  <p>{html.escape(result['message'])}</p>
  <div class="meta">
    <div class="card"><strong>结果</strong><br />{html.escape(status)}</div>
    <div class="card"><strong>操作次数</strong><br />{result['monkey']['executed_actions']}</div>
    <div class="card"><strong>执行时长</strong><br />{duration_seconds or 0}s</div>
    <div class="card"><strong>Crash / OOM / 卡死</strong><br />{result['metrics']['crash_count']} / {result['metrics']['oom_count']} / {result['metrics']['stuck_count']}</div>
  </div>
  <h2>问题列表</h2>
  <table><thead><tr><th>级别</th><th>类型</th><th>标题</th><th>Fingerprint</th></tr></thead><tbody>{issue_rows}</tbody></table>
</body>
</html>
"""
with open(os.path.join(result_dir, "report.html"), "w", encoding="utf-8") as f:
    f.write(report_html)
PY
}

find_tidevice() {
  if command -v tidevice >/dev/null 2>&1; then
    command -v tidevice
    return
  fi
  local candidate
  for candidate in \
    "$HOME/.local/bin/tidevice" \
    "$HOME/Library/Python/3.9/bin/tidevice" \
    "$HOME/Library/Python/3.10/bin/tidevice" \
    "$HOME/Library/Python/3.11/bin/tidevice" \
    "$HOME/Library/Python/3.12/bin/tidevice" \
    "$HOME/Library/Python/3.13/bin/tidevice" \
    "$HOME/Library/Python/3.14/bin/tidevice"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
  if command -v python3 >/dev/null 2>&1 && python3 -m tidevice version >/dev/null 2>&1; then
    echo "python3 -m tidevice"
    return
  fi
  echo ""
}

select_device() {
  local tidevice_cmd="$1"
  if [ -n "${DEVICE_UDID}" ]; then
    echo "${DEVICE_UDID}"
    return
  fi

  # tidevice list can print a table header. Pick the first real iOS UDID.
  ${tidevice_cmd} list 2>/dev/null | awk '
    NR == 1 && ($1 == "UDID" || $1 == "SerialNumber") { next }
    $1 ~ /^[0-9A-Fa-f-]{25,}$/ { print $1; exit }
  '
}

detect_device_ios_version() {
  local tidevice_cmd="$1"
  local udid="$2"
  if [ -z "${udid}" ]; then
    return 1
  fi
  "${tidevice_cmd}" list 2>/dev/null | awk -v udid="${udid}" '
    NR == 1 && ($1 == "UDID" || $1 == "SerialNumber") { next }
    $1 == udid && NF >= 2 { print $(NF - 1); exit }
  '
}

ios_major_version() {
  local version="$1"
  case "${version}" in
    [0-9]*)
      printf '%s\n' "${version%%.*}"
      ;;
    *)
      printf '0\n'
      ;;
  esac
}

download_ipa() {
  local source_url="$1"
  if [ -z "${source_url}" ]; then
    return 1
  fi
  case "${source_url}" in
    http://*|https://*)
      curl -L --fail --connect-timeout 15 --max-time 600 -o "${IPA_FILE}" "${source_url}"
      ;;
    file://*)
      cp "${source_url#file://}" "${IPA_FILE}"
      ;;
    /*)
      cp "${source_url}" "${IPA_FILE}"
      ;;
    *)
      return 1
      ;;
  esac
  [ -s "${IPA_FILE}" ] || return 1
  if command -v unzip >/dev/null 2>&1; then
    unzip -l "${IPA_FILE}" 'Payload/*.app/*' >/dev/null 2>&1 || return 2
  fi
  return 0
}

read_bundle_id_from_plist() {
  local plist_path="$1"
  if [ -z "${plist_path}" ] || [ ! -f "${plist_path}" ]; then
    return 1
  fi
  if [ -x /usr/libexec/PlistBuddy ]; then
    /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${plist_path}" 2>/dev/null && return
  fi
  python3 -c 'import plistlib, sys; print(plistlib.load(open(sys.argv[1], "rb")).get("CFBundleIdentifier", ""))' "${plist_path}" 2>/dev/null
}

read_executable_name_from_plist() {
  local plist_path="$1"
  if [ -z "${plist_path}" ] || [ ! -f "${plist_path}" ]; then
    return 1
  fi
  if [ -x /usr/libexec/PlistBuddy ]; then
    /usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${plist_path}" 2>/dev/null && return
  fi
  python3 -c 'import plistlib, sys; print(plistlib.load(open(sys.argv[1], "rb")).get("CFBundleExecutable", ""))' "${plist_path}" 2>/dev/null
}

read_short_version_from_plist() {
  local plist_path="$1"
  if [ -z "${plist_path}" ] || [ ! -f "${plist_path}" ]; then
    return 1
  fi
  if [ -x /usr/libexec/PlistBuddy ]; then
    /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${plist_path}" 2>/dev/null && return
  fi
  python3 -c 'import plistlib, sys; print(plistlib.load(open(sys.argv[1], "rb")).get("CFBundleShortVersionString", ""))' "${plist_path}" 2>/dev/null
}

read_bundle_version_from_plist() {
  local plist_path="$1"
  if [ -z "${plist_path}" ] || [ ! -f "${plist_path}" ]; then
    return 1
  fi
  if [ -x /usr/libexec/PlistBuddy ]; then
    /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${plist_path}" 2>/dev/null && return
  fi
  python3 -c 'import plistlib, sys; print(plistlib.load(open(sys.argv[1], "rb")).get("CFBundleVersion", ""))' "${plist_path}" 2>/dev/null
}

read_bundle_id_from_app() {
  local app_path="$1"
  read_bundle_id_from_plist "${app_path}/Info.plist"
}

detect_bundle_id_from_ipa() {
  if [ ! -s "${IPA_FILE}" ] || ! command -v unzip >/dev/null 2>&1; then
    return 1
  fi
  local tmp_dir plist_path bundle_id executable_name short_version bundle_version
  tmp_dir="$(mktemp -d "${RESULT_DIR}/ipa-info.XXXXXX")"
  unzip -q "${IPA_FILE}" 'Payload/*.app/Info.plist' -d "${tmp_dir}" >/dev/null 2>&1 || {
    rm -rf "${tmp_dir}"
    return 1
  }
  plist_path="$(find "${tmp_dir}/Payload" -path '*.app/Info.plist' -type f 2>/dev/null | head -n 1)"
  bundle_id="$(read_bundle_id_from_plist "${plist_path}" 2>/dev/null || true)"
  executable_name="$(read_executable_name_from_plist "${plist_path}" 2>/dev/null || true)"
  short_version="$(read_short_version_from_plist "${plist_path}" 2>/dev/null || true)"
  bundle_version="$(read_bundle_version_from_plist "${plist_path}" 2>/dev/null || true)"
  rm -rf "${tmp_dir}"
  if [ -n "${executable_name}" ]; then
    DETECTED_EXECUTABLE_NAME="${executable_name}"
  fi
  if [ -n "${short_version}" ]; then
    DETECTED_SHORT_VERSION="${short_version}"
  fi
  if [ -n "${bundle_version}" ]; then
    DETECTED_BUNDLE_VERSION="${bundle_version}"
  fi
  if [ -n "${bundle_id}" ]; then
    DETECTED_BUNDLE_ID="${bundle_id}"
    return 0
  fi
  return 1
}

package_ipa_from_xcarchive() {
  local archive_path="$1"
  if [ -z "${archive_path}" ] || [ ! -d "${archive_path}" ]; then
    return 1
  fi

  local app_path
  app_path="$(find "${archive_path}/Products/Applications" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -n 1)"
  if [ -z "${app_path}" ] || [ ! -d "${app_path}" ]; then
    return 1
  fi
  DETECTED_BUNDLE_ID="$(read_bundle_id_from_app "${app_path}" 2>/dev/null || true)"
  DETECTED_EXECUTABLE_NAME="$(read_executable_name_from_plist "${app_path}/Info.plist" 2>/dev/null || true)"
  DETECTED_SHORT_VERSION="$(read_short_version_from_plist "${app_path}/Info.plist" 2>/dev/null || true)"
  DETECTED_BUNDLE_VERSION="$(read_bundle_version_from_plist "${app_path}/Info.plist" 2>/dev/null || true)"

  local payload_dir="${RESULT_DIR}/Payload"
  rm -rf "${payload_dir}" "${IPA_FILE}"
  mkdir -p "${payload_dir}"
  cp -R "${app_path}" "${payload_dir}/"
  (
    cd "${RESULT_DIR}"
    zip -qry "${IPA_FILE}" Payload
  )
  [ -s "${IPA_FILE}" ]
}

install_cache_file() {
  local bundle_id="$1"
  printf '%s/%s/%s.json\n' "${INSTALL_CACHE_DIR}" "${SELECTED_DEVICE}" "${bundle_id}"
}

record_install_cache() {
  local bundle_id="${DETECTED_BUNDLE_ID:-${APP_BUNDLE_ID:-}}"
  if [ -z "${bundle_id}" ] || [ -z "${IPA_SHA256}" ]; then
    return 0
  fi

  local cache_file
  cache_file="$(install_cache_file "${bundle_id}")"
  mkdir -p "$(dirname "${cache_file}")"
  python3 - "${cache_file}" \
    "${SELECTED_DEVICE}" "${bundle_id}" "${DETECTED_SHORT_VERSION:-}" "${DETECTED_BUNDLE_VERSION:-}" \
    "${IPA_SHA256}" "${IPA_MD5}" "${SOURCE_BUILD_NUMBER:-}" "${BRANCH:-}" "${COMMIT_HASH:-}" "${APP_VERSION:-}" <<'PY'
import json
import time
import sys

(
    cache_file,
    device_udid,
    bundle_id,
    short_version,
    bundle_version,
    sha256,
    md5,
    source_build_number,
    branch,
    commit_hash,
    app_version,
) = sys.argv[1:12]

data = {
    "deviceUdid": device_udid,
    "bundleId": bundle_id,
    "shortVersion": short_version,
    "bundleVersion": bundle_version,
    "sha256": sha256,
    "md5": md5,
    "sourceBuildNumber": source_build_number,
    "branch": branch,
    "commitHash": commit_hash,
    "appVersion": app_version,
    "installedAt": int(time.time()),
}
with open(cache_file, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
PY
  log "已记录安装指纹缓存: ${cache_file}"
}

should_skip_install() {
  if [ "${SKIP_INSTALL_IF_SAME}" != "1" ]; then
    return 1
  fi

  local bundle_id="${DETECTED_BUNDLE_ID:-${APP_BUNDLE_ID:-}}"
  if [ -z "${bundle_id}" ] || [ -z "${DETECTED_SHORT_VERSION}" ] || [ -z "${DETECTED_BUNDLE_VERSION}" ] || [ -z "${IPA_SHA256}" ]; then
    log "未读取到当前 IPA 的完整版本/指纹信息，继续安装。"
    return 1
  fi

  local installed_info installed_short installed_build
  installed_info="${RESULT_DIR}/installed-app-${bundle_id}.json"
  rm -f "${installed_info}"

  if command -v xcrun >/dev/null 2>&1 && xcrun devicectl --help >/dev/null 2>&1; then
    xcrun devicectl device info apps --device "${SELECTED_DEVICE}" --json-output "${installed_info}" >/dev/null 2>&1 || true
    if [ -s "${installed_info}" ]; then
      installed_short="$(python3 - "${installed_info}" "${bundle_id}" version <<'PY'
import json
import sys

path, bundle_id, key = sys.argv[1:4]
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception:
    sys.exit(1)

def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)

for item in walk(data):
    if item.get("bundleIdentifier") == bundle_id:
        print(item.get(key, "") or "")
        sys.exit(0)
sys.exit(1)
PY
)" || installed_short=""
      installed_build="$(python3 - "${installed_info}" "${bundle_id}" bundleVersion <<'PY'
import json
import sys

path, bundle_id, key = sys.argv[1:4]
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception:
    sys.exit(1)

def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)

for item in walk(data):
    if item.get("bundleIdentifier") == bundle_id:
        print(item.get(key, "") or "")
        sys.exit(0)
sys.exit(1)
PY
)" || installed_build=""
    fi
  fi

  if [ -z "${installed_short}" ]; then
    installed_short="$(${TIDEVICE_CMD} --udid "${SELECTED_DEVICE}" appinfo "${bundle_id}" 2>/dev/null | python3 - CFBundleShortVersionString <<'PY'
import ast
import sys

key = sys.argv[1]
text = sys.stdin.read()
try:
    data = ast.literal_eval(text)
except Exception:
    sys.exit(1)
print(data.get(key, "") or "")
PY
)" || installed_short=""
    installed_build="$(${TIDEVICE_CMD} --udid "${SELECTED_DEVICE}" appinfo "${bundle_id}" 2>/dev/null | python3 - CFBundleVersion <<'PY'
import ast
import sys

key = sys.argv[1]
text = sys.stdin.read()
try:
    data = ast.literal_eval(text)
except Exception:
    sys.exit(1)
print(data.get(key, "") or "")
PY
)" || installed_build=""
  fi

  if [ -z "${installed_short}" ]; then
    log "设备上未读取到 ${bundle_id} 的已安装版本，继续安装。"
    return 1
  fi

  if [ "${installed_short}" != "${DETECTED_SHORT_VERSION}" ]; then
    log "设备已安装 ${bundle_id} 版本 ${installed_short:-N/A}，当前包版本 ${DETECTED_SHORT_VERSION}，继续安装。"
    return 1
  fi

  if [ -n "${DETECTED_BUNDLE_VERSION}" ] && [ "${installed_build}" != "${DETECTED_BUNDLE_VERSION}" ]; then
    log "设备已安装 ${bundle_id} build ${installed_build:-N/A}，当前包 build ${DETECTED_BUNDLE_VERSION}，继续安装。"
    return 1
  fi

  local cache_file cached_line cached_sha256 cached_md5 cached_short cached_build
  cache_file="$(install_cache_file "${bundle_id}")"
  if [ ! -f "${cache_file}" ]; then
    log "设备已安装版本一致，但未找到安装指纹缓存，继续安装一次以建立 hash 基线。"
    return 1
  fi
  cached_line="$(python3 - "${cache_file}" <<'PY'
import json
import sys

try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(1)

print(
    data.get("sha256", "") or "",
    data.get("md5", "") or "",
    data.get("shortVersion", "") or "",
    data.get("bundleVersion", "") or "",
    sep="\t",
)
PY
)" || cached_line=""
  IFS=$'\t' read -r cached_sha256 cached_md5 cached_short cached_build <<< "${cached_line}"

  if [ "${cached_sha256}" != "${IPA_SHA256}" ]; then
    log "设备已安装版本一致，但 IPA SHA256 与安装缓存不一致，继续安装。"
    return 1
  fi
  if [ -n "${IPA_MD5}" ] && [ "${cached_md5}" != "${IPA_MD5}" ]; then
    log "设备已安装版本一致，但 IPA MD5 与安装缓存不一致，继续安装。"
    return 1
  fi
  if [ "${cached_short}" != "${DETECTED_SHORT_VERSION}" ] || [ "${cached_build}" != "${DETECTED_BUNDLE_VERSION}" ]; then
    log "设备已安装版本一致，但安装缓存版本信息不一致，继续安装。"
    return 1
  fi

  log "设备已安装相同包且 IPA 指纹一致，跳过安装: ${bundle_id} ${DETECTED_SHORT_VERSION} (${DETECTED_BUNDLE_VERSION}), sha256=${IPA_SHA256}"
  return 0
}

launch_app() {
  local bundle_id="$1"
  local launch_output="${RESULT_DIR}/launch-${bundle_id}.log"
  local devicectl_output="${RESULT_DIR}/devicectl-launch-${bundle_id}.log"

  log "启动 App: ${bundle_id}"

  if command -v xcrun >/dev/null 2>&1 && xcrun devicectl --help >/dev/null 2>&1; then
    LAUNCH_STARTED_AT_MS="$(now_ms)"
    if xcrun devicectl device process launch --device "${SELECTED_DEVICE}" "${bundle_id}" 2>&1 | tee "${devicectl_output}" | tee -a "${LOG_FILE}"; then
      mark_launch_finished "devicectl"
      return 0
    fi
    if grep -q 'must be paired\|RemotePairingError' "${devicectl_output}" 2>/dev/null; then
      log "devicectl 提示设备未配对，尝试执行 CoreDevice 配对。请保持 iPhone 解锁，并在设备上确认信任。"
      xcrun devicectl manage pair --device "${SELECTED_DEVICE}" 2>&1 | tee -a "${LOG_FILE}" || true
      log "重新尝试使用 devicectl 启动 App。"
      LAUNCH_STARTED_AT_MS="$(now_ms)"
      if xcrun devicectl device process launch --device "${SELECTED_DEVICE}" "${bundle_id}" 2>&1 | tee -a "${LOG_FILE}"; then
        mark_launch_finished "devicectl"
        return 0
      fi
      log "devicectl 仍无法连接设备。请在打包机 Jenkins 用户环境执行：xcrun devicectl manage pair --device ${SELECTED_DEVICE}"
    fi
    log "devicectl 启动失败，尝试使用 tidevice 启动。"
  else
    log "未找到 xcrun devicectl，尝试使用 tidevice 启动。"
  fi

  LAUNCH_STARTED_AT_MS="$(now_ms)"
  if ${TIDEVICE_CMD} --udid "${SELECTED_DEVICE}" launch "${bundle_id}" >"${launch_output}" 2>&1; then
    cat "${launch_output}" | tee -a "${LOG_FILE}"
    mark_launch_finished "tidevice"
    return 0
  fi

  if grep -q 'DeveloperImage not found\|InvalidService' "${launch_output}" 2>/dev/null; then
    log "tidevice 启动受 DeveloperImage 限制，已记录到 ${launch_output}。"
  else
    log "tidevice 启动失败，原因：$(tail -n 3 "${launch_output}" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  fi

  return 1
}

capture_wda_screenshot() {
  if ! check_wda_ready "${MONKEY_RUNTIME_WDA_URL:-${WDA_URL}}"; then
    return 1
  fi
  python3 - "${MONKEY_RUNTIME_WDA_URL:-${WDA_URL}}" "${SCREENSHOT_FILE}" <<'PY'
import base64
import json
import sys
import urllib.error
import urllib.request

base_url = sys.argv[1].rstrip("/")
output_path = sys.argv[2]

def request(method, path, payload=None, timeout=8):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base_url + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        return json.loads(body) if body else {}

def value_of(response):
    return response.get("value", response)

def write_png(encoded):
    if not encoded:
        raise RuntimeError("empty screenshot")
    with open(output_path, "wb") as f:
        f.write(base64.b64decode(encoded))

try:
    write_png(value_of(request("GET", "/screenshot", timeout=10)))
    sys.exit(0)
except Exception:
    pass

session_id = ""
try:
    session_response = request("POST", "/session", {"capabilities": {"alwaysMatch": {}, "firstMatch": [{}]}}, timeout=15)
    value = value_of(session_response)
    session_id = session_response.get("sessionId") or (value.get("sessionId") if isinstance(value, dict) else "")
    if not session_id:
        raise RuntimeError(f"missing sessionId: {session_response}")
    write_png(value_of(request("GET", f"/session/{session_id}/screenshot", timeout=10)))
    sys.exit(0)
finally:
    if session_id:
        try:
            request("DELETE", f"/session/{session_id}", timeout=5)
        except Exception:
            pass
PY
}

wait_cold_start_ready() {
  if [ -z "${LAUNCH_STARTED_AT_MS}" ]; then
    log "未记录启动开始时间，跳过冷启动首屏耗时检测。"
    return 1
  fi

  if [ "${COLD_START_DETECT_SCREEN}" != "1" ]; then
    log "等待基础启动稳定..."
    sleep "${COLD_START_WAIT_SECONDS}"
    local ready_at_ms
    ready_at_ms="$(now_ms)"
    COLD_START_READY_MS=$((ready_at_ms - LAUNCH_STARTED_AT_MS))
    log "冷启动稳定耗时: ${COLD_START_READY_MS}ms (启动命令 ${LAUNCH_DURATION_MS:-N/A}ms + 稳定等待 ${COLD_START_WAIT_SECONDS}s)"
    return 0
  fi

  log "等待 App 首屏内容出现..."
  if ! check_wda_ready "${MONKEY_RUNTIME_WDA_URL:-${WDA_URL}}"; then
    log "WDA 不可访问，无法检测首屏内容，退回固定等待 ${COLD_START_WAIT_SECONDS}s。"
    sleep "${COLD_START_WAIT_SECONDS}"
    local fallback_ready_at_ms
    fallback_ready_at_ms="$(now_ms)"
    COLD_START_READY_MS=$((fallback_ready_at_ms - LAUNCH_STARTED_AT_MS))
    log "冷启动稳定耗时: ${COLD_START_READY_MS}ms (WDA 不可用，固定等待兜底)"
    return 0
  fi

  local parsed status ready_ms reason source_size
  parsed="$(python3 - "${MONKEY_RUNTIME_WDA_URL:-${WDA_URL}}" "${LAUNCH_STARTED_AT_MS}" "${COLD_START_READY_TIMEOUT_SECONDS}" "${COLD_START_READY_POLL_SECONDS}" "${COLD_START_READY_MIN_ELEMENTS}" "${COLD_START_READY_TEXT}" <<'PY'
import json
import re
import sys
import time
import urllib.request

wda_url, launch_started_ms, timeout_seconds, poll_seconds, min_elements, ready_text = sys.argv[1:7]
wda_url = wda_url.rstrip("/")
launch_started_ms = int(float(launch_started_ms or "0"))
timeout_seconds = max(1.0, float(timeout_seconds or "45"))
poll_seconds = max(0.1, float(poll_seconds or "0.5"))
min_elements = max(1, int(float(min_elements or "8")))
ready_text = ready_text or ""
session_id = ""

def request(method, path, payload=None, timeout=8):
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{wda_url}{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        return json.loads(body) if body else {}

def value_of(response):
    return response.get("value", response)

def get_session_id(response):
    value = value_of(response)
    return response.get("sessionId") or (value.get("sessionId") if isinstance(value, dict) else "") or ""

def source_ready(source):
    if not source:
        return False, "empty_source"
    if ready_text and ready_text in source:
        return True, f"matched_text:{ready_text}"
    element_count = source.count("XCUIElementType")
    if element_count < min_elements:
        return False, f"elements:{element_count}"
    text_values = re.findall(r'(?:name|label|value)="([^"]+)"', source)
    visible_text_count = sum(1 for value in text_values if value.strip())
    has_content_widget = any(token in source for token in (
        "XCUIElementTypeStaticText",
        "XCUIElementTypeButton",
        "XCUIElementTypeTextField",
        "XCUIElementTypeSearchField",
        "XCUIElementTypeTable",
        "XCUIElementTypeCollectionView",
        "XCUIElementTypeScrollView",
        "XCUIElementTypeImage",
    ))
    if has_content_widget and (visible_text_count >= 2 or element_count >= min_elements * 2):
        return True, f"ui_source:elements={element_count},texts={visible_text_count}"
    return False, f"elements={element_count},texts={visible_text_count}"

try:
    request("GET", "/status", timeout=5)
    session_response = request("POST", "/session", {"capabilities": {"alwaysMatch": {}, "firstMatch": [{}]}}, timeout=15)
    session_id = get_session_id(session_response)
    if not session_id:
        raise RuntimeError(f"WDA did not return sessionId: {session_response}")

    deadline = time.time() + timeout_seconds
    last_reason = "not_checked"
    last_source_size = 0
    while time.time() <= deadline:
        source_response = request("GET", f"/session/{session_id}/source", timeout=8)
        source = str(value_of(source_response) or "")
        last_source_size = len(source)
        ready, reason = source_ready(source)
        last_reason = reason
        if ready:
            ready_ms = int(time.time() * 1000) - launch_started_ms
            print("\t".join(["ok", str(ready_ms), reason, str(last_source_size)]))
            sys.exit(0)
        time.sleep(poll_seconds)
    ready_ms = int(time.time() * 1000) - launch_started_ms
    print("\t".join(["timeout", str(ready_ms), last_reason, str(last_source_size)]))
    sys.exit(2)
except Exception as exc:
    ready_ms = int(time.time() * 1000) - launch_started_ms
    print("\t".join(["error", str(ready_ms), str(exc).replace("\t", " ").replace("\n", " "), "0"]))
    sys.exit(1)
finally:
    if session_id:
        try:
            request("DELETE", f"/session/{session_id}", timeout=5)
        except Exception:
            pass
PY
)" || true

  IFS=$'\t' read -r status ready_ms reason source_size <<< "${parsed}"
  if [ -n "${ready_ms}" ] && [[ "${ready_ms}" =~ ^[0-9]+$ ]]; then
    COLD_START_READY_MS="${ready_ms}"
  else
    local error_ready_at_ms
    error_ready_at_ms="$(now_ms)"
    COLD_START_READY_MS=$((error_ready_at_ms - LAUNCH_STARTED_AT_MS))
  fi

  if [ "${status}" = "ok" ]; then
    log "冷启动首屏耗时: ${COLD_START_READY_MS}ms (启动命令 ${LAUNCH_DURATION_MS:-N/A}ms，检测=${reason}，source=${source_size} bytes)"
  elif [ "${status}" = "timeout" ]; then
    log "冷启动首屏检测超时: ${COLD_START_READY_MS}ms (未确认首屏内容，最后状态=${reason}，source=${source_size} bytes)"
  else
    log "冷启动首屏检测失败: ${COLD_START_READY_MS}ms (${reason:-unknown})"
  fi
}

capture_screenshot() {
  local screenshot_log="${RESULT_DIR}/screenshot-error.log"
  log "采集启动截图..."

  if capture_wda_screenshot >"${screenshot_log}" 2>&1; then
    log "截图: ${SCREENSHOT_FILE}"
    return 0
  fi
  if [ -s "${screenshot_log}" ]; then
    log "WDA 截图失败，尝试使用系统工具兜底。原因：$(tail -n 3 "${screenshot_log}" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  fi

  if ${TIDEVICE_CMD} --udid "${SELECTED_DEVICE}" screenshot "${SCREENSHOT_FILE}" >"${screenshot_log}" 2>&1; then
    log "截图: ${SCREENSHOT_FILE}"
    return 0
  fi
  if grep -q 'DeveloperImage not found\|Invalid service\|InvalidService' "${screenshot_log}" 2>/dev/null; then
    log "tidevice 截图受 DeveloperImage 限制，已记录到 ${screenshot_log}。"
  else
    log "tidevice 截图失败，原因：$(tail -n 3 "${screenshot_log}" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  fi

  if command -v idevicescreenshot >/dev/null 2>&1; then
    log "尝试使用 idevicescreenshot 采集截图..."
    if idevicescreenshot -u "${SELECTED_DEVICE}" "${SCREENSHOT_FILE}" >>"${screenshot_log}" 2>&1; then
      log "截图: ${SCREENSHOT_FILE}"
      return 0
    fi
    if grep -q 'DeveloperImage not found\|Invalid service\|InvalidService' "${screenshot_log}" 2>/dev/null; then
      log "idevicescreenshot 截图受 DeveloperImage 限制，已记录到 ${screenshot_log}。"
    else
      log "idevicescreenshot 截图失败，原因：$(tail -n 3 "${screenshot_log}" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
    fi
  else
    log "未安装 idevicescreenshot，无法使用 libimobiledevice 截图兜底。可在打包机安装：brew install libimobiledevice"
  fi

  log "截图采集失败，跳过。"
  return 1
}

capture_device_log() {
  log "采集设备日志..."
  : > "${DEVICE_LOG_FILE}"
  if ! ${TIDEVICE_CMD} --udid "${SELECTED_DEVICE}" syslog > "${DEVICE_LOG_FILE}" 2>&1 &
  then
    log "设备日志采集启动失败，跳过。"
    return 1
  fi
  local syslog_pid=$!
  sleep 8
  kill "${syslog_pid}" >/dev/null 2>&1 || true
  wait "${syslog_pid}" >/dev/null 2>&1 || true
  if [ -s "${DEVICE_LOG_FILE}" ]; then
    log "设备日志: ${DEVICE_LOG_FILE}"
    return 0
  fi
  log "设备日志为空，跳过。"
  return 1
}

start_performance_sampling() {
  if [ "${PERFORMANCE_SAMPLING}" != "1" ]; then
    log "性能采样已关闭。"
    return 0
  fi
  if [ -z "${LAUNCH_BUNDLE_ID:-}" ]; then
    log "未确定 Bundle ID，跳过性能采样。"
    return 0
  fi
  local sampler ios_major
  sampler="${PERFORMANCE_SAMPLER}"
  ios_major="$(ios_major_version "${DEVICE_IOS_VERSION}")"
  if [ "${sampler}" = "auto" ]; then
    if [ "${ios_major}" -ge 17 ] 2>/dev/null; then
      sampler="xctrace"
    else
      sampler="tidevice"
    fi
  fi
  log "性能采样器: ${sampler} (配置=${PERFORMANCE_SAMPLER}, iOS=${DEVICE_IOS_VERSION:-unknown})"

  case "${sampler}" in
    xctrace)
      if start_xctrace_sampling; then
        return 0
      fi
      log "xctrace 性能采样启动失败，尝试 tidevice perf 兜底。"
      start_tidevice_performance_sampling || true
      return 0
      ;;
    tidevice)
      if start_tidevice_performance_sampling; then
        return 0
      fi
      log "tidevice perf 性能采样启动失败，尝试 xctrace 兜底。"
      start_xctrace_sampling || true
      return 0
      ;;
    *)
      log "未知 PERFORMANCE_SAMPLER=${PERFORMANCE_SAMPLER}，按 auto 策略使用 xctrace。"
      start_xctrace_sampling || true
      return 0
      ;;
  esac
}

start_tidevice_performance_sampling() {
  if [ -z "${TIDEVICE_CMD:-}" ] || [ ! -x "${TIDEVICE_CMD}" ]; then
    log "未找到 tidevice，无法使用 tidevice perf。"
    return 1
  fi

  local perf_pid_file="${RESULT_DIR}/performance-sampler.pid"
  : > "${PERFORMANCE_SAMPLE_FILE}"
  log "启动性能采样: ${PERFORMANCE_SAMPLE_TYPES} -> ${PERFORMANCE_SAMPLE_FILE}"
  (
    "${TIDEVICE_CMD}" --udid "${SELECTED_DEVICE}" perf -B "${LAUNCH_BUNDLE_ID}" -o "${PERFORMANCE_SAMPLE_TYPES}" --json >>"${PERFORMANCE_SAMPLE_FILE}" 2>>"${LOG_FILE}"
  ) &
  echo $! > "${perf_pid_file}"
  sleep 1
  if ! kill -0 "$(cat "${perf_pid_file}")" >/dev/null 2>&1; then
    log "tidevice 性能采样启动失败。"
    rm -f "${perf_pid_file}"
    return 1
  fi
  return 0
}

resolve_app_pid_with_devicectl() {
  if ! command -v xcrun >/dev/null 2>&1; then
    return 1
  fi
  local processes_json
  processes_json="${RESULT_DIR}/devicectl-processes.json"
  if ! xcrun devicectl device info processes --device "${SELECTED_DEVICE}" --json-output "${processes_json}" --quiet >>"${LOG_FILE}" 2>&1; then
    return 1
  fi
  python3 - "$processes_json" "${DETECTED_EXECUTABLE_NAME:-}" "${LAUNCH_BUNDLE_ID:-}" <<'PY'
import json
import sys

path, executable_name, bundle_id = sys.argv[1:4]
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception:
    data = {}
items = data.get("result", {}).get("runningProcesses", [])
matches = []
for item in items:
    exe = str(item.get("executable") or "")
    pid = item.get("processIdentifier")
    if not pid:
        continue
    if executable_name and f"/{executable_name}.app/{executable_name}" in exe:
        matches.append((pid, exe))
    elif executable_name and exe.endswith(f"/{executable_name}"):
        matches.append((pid, exe))
    elif bundle_id and bundle_id in exe:
        matches.append((pid, exe))
if matches:
    print(matches[-1][0])
PY
}

start_xctrace_sampling() {
  if ! command -v xcrun >/dev/null 2>&1 || ! xcrun --find xctrace >/dev/null 2>&1; then
    log "未找到 xctrace，跳过 xctrace 性能采样。"
    return 1
  fi
  local app_pid xctrace_pid_file xctrace_log
  app_pid="$(resolve_app_pid_with_devicectl || true)"
  if [ -z "${app_pid}" ]; then
    log "未能通过 devicectl 获取 App PID，跳过 xctrace 性能采样。"
    return 1
  fi
  xctrace_pid_file="${RESULT_DIR}/performance-xctrace.pid"
  xctrace_log="${RESULT_DIR}/performance-xctrace.log"
  rm -rf "${PERFORMANCE_TRACE_FILE}"
  rm -f "${PERFORMANCE_TRACE_ARCHIVE_FILE}"
  : > "${xctrace_log}"
  log "启动 xctrace 性能采样: template=${PERFORMANCE_XCTRACE_TEMPLATE}, pid=${app_pid} -> ${PERFORMANCE_TRACE_FILE}"
  if [ "${MONKEY_DURATION_SECONDS:-0}" != "0" ]; then
    (
      xcrun xctrace record --template "${PERFORMANCE_XCTRACE_TEMPLATE}" --device "${SELECTED_DEVICE}" --attach "${app_pid}" --time-limit "${MONKEY_DURATION_SECONDS}s" --output "${PERFORMANCE_TRACE_FILE}" --no-prompt >>"${xctrace_log}" 2>&1
    ) &
  else
    (
      xcrun xctrace record --template "${PERFORMANCE_XCTRACE_TEMPLATE}" --device "${SELECTED_DEVICE}" --attach "${app_pid}" --output "${PERFORMANCE_TRACE_FILE}" --no-prompt >>"${xctrace_log}" 2>&1
    ) &
  fi
  echo $! > "${xctrace_pid_file}"
  sleep 2
  if ! kill -0 "$(cat "${xctrace_pid_file}")" >/dev/null 2>&1 && [ ! -d "${PERFORMANCE_TRACE_FILE}" ]; then
    log "xctrace 性能采样启动失败，详情见 ${xctrace_log}。"
    rm -f "${xctrace_pid_file}"
    return 1
  fi
  return 0
}

package_performance_trace() {
  if [ ! -d "${PERFORMANCE_TRACE_FILE}" ]; then
    return 1
  fi
  rm -f "${PERFORMANCE_TRACE_ARCHIVE_FILE}"
  if command -v ditto >/dev/null 2>&1; then
    ditto -c -k --keepParent "${PERFORMANCE_TRACE_FILE}" "${PERFORMANCE_TRACE_ARCHIVE_FILE}" >/dev/null 2>&1 || true
  elif command -v zip >/dev/null 2>&1; then
    (
      cd "${RESULT_DIR}" && zip -qry "$(basename "${PERFORMANCE_TRACE_ARCHIVE_FILE}")" "$(basename "${PERFORMANCE_TRACE_FILE}")"
    ) || true
  fi
  [ -s "${PERFORMANCE_TRACE_ARCHIVE_FILE}" ]
}

export_xctrace_performance_samples() {
  if [ ! -d "${PERFORMANCE_TRACE_FILE}" ]; then
    return 1
  fi
  if [ -s "${PERFORMANCE_SAMPLE_FILE}" ]; then
    return 0
  fi
  if ! command -v xcrun >/dev/null 2>&1 || ! xcrun --find xctrace >/dev/null 2>&1; then
    return 1
  fi
  local export_xml="${RESULT_DIR}/performance-xctrace-process-live.xml"
  local export_log="${RESULT_DIR}/performance-xctrace-export.log"
  local toc_xml="${RESULT_DIR}/performance-xctrace-toc.xml"
  local exported=0
  : > "${export_log}"

  for attempt in 1 2 3 4 5; do
    rm -f "${export_xml}"
    {
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] export attempt ${attempt}: activity-monitor-process-live"
      xcrun xctrace export --input "${PERFORMANCE_TRACE_FILE}" --xpath "/trace-toc/run[@number='1']/data/table[@schema='activity-monitor-process-live']" --output "${export_xml}"
    } >>"${export_log}" 2>&1
    if [ -s "${export_xml}" ]; then
      exported=1
      break
    fi

    rm -f "${export_xml}"
    {
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] export attempt ${attempt}: fallback schema lookup"
      xcrun xctrace export --input "${PERFORMANCE_TRACE_FILE}" --xpath "//table[@schema='activity-monitor-process-live']" --output "${export_xml}"
    } >>"${export_log}" 2>&1
    if [ -s "${export_xml}" ]; then
      exported=1
      break
    fi

    sleep $((attempt * 2))
  done

  if [ "${exported}" != "1" ]; then
    rm -f "${toc_xml}"
    xcrun xctrace export --input "${PERFORMANCE_TRACE_FILE}" --toc --output "${toc_xml}" >>"${export_log}" 2>&1 || true
    log "xctrace 性能数据导出失败。"
    log "xctrace 导出日志: ${export_log}"
    return 1
  fi
  python3 - "${export_xml}" "${PERFORMANCE_SAMPLE_FILE}" <<'PY'
import json
import sys
import xml.etree.ElementTree as ET

xml_path, output_path = sys.argv[1:3]
id_values = {}

def numeric(value):
    if value is None:
        return None
    try:
        return float(str(value).replace(",", "").strip())
    except Exception:
        return None

def value_of(element):
    if element is None:
        return None
    ref = element.attrib.get("ref")
    if ref:
        return id_values.get(ref)
    text = (element.text or "").strip()
    value = text if text != "" else None
    element_id = element.attrib.get("id")
    if element_id:
        id_values[element_id] = value
    return value

try:
    root = ET.parse(xml_path).getroot()
except Exception:
    root = ET.Element("empty")

rows = []
for row in root.iter("row"):
    values = [value_of(child) for child in list(row)]
    if len(values) < 11:
        continue
    start_ns = numeric(values[0])
    cpu = numeric(values[6])
    memory_bytes = numeric(values[10])
    if start_ns is None or (cpu is None and memory_bytes is None):
        continue
    sample = {
        "timeSeconds": round(start_ns / 1_000_000_000, 2),
        "source": "xctrace.activity-monitor-process-live",
    }
    if cpu is not None:
        sample["cpu"] = round(cpu, 2)
    if memory_bytes is not None:
        sample["memoryBytes"] = int(memory_bytes)
    rows.append(sample)

with open(output_path, "w", encoding="utf-8") as f:
    for item in rows:
        f.write(json.dumps(item, ensure_ascii=False) + "\n")

print(len(rows))
PY
  local sample_count
  sample_count="$(wc -l < "${PERFORMANCE_SAMPLE_FILE}" 2>/dev/null | tr -d ' ' || echo 0)"
  if [ "${sample_count:-0}" -gt 0 ]; then
    log "xctrace 已导出性能采样: ${PERFORMANCE_SAMPLE_FILE} (${sample_count} 条)"
    return 0
  fi
  log "xctrace 未导出可用性能采样。"
  return 1
}

stop_performance_sampling() {
  local perf_pid_file="${RESULT_DIR}/performance-sampler.pid"
  if [ ! -f "${perf_pid_file}" ]; then
    stop_xctrace_sampling || true
    return 0
  fi
  local pid
  pid="$(cat "${perf_pid_file}" 2>/dev/null || true)"
  if [ -n "${pid}" ] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill "${pid}" >/dev/null 2>&1 || true
    wait "${pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${perf_pid_file}"
  if [ -s "${PERFORMANCE_SAMPLE_FILE}" ]; then
    log "性能采样: ${PERFORMANCE_SAMPLE_FILE}"
  else
    log "性能采样为空，可能设备不支持 tidevice perf 或采样时间过短。"
  fi
  stop_xctrace_sampling || true
}

stop_xctrace_sampling() {
  local xctrace_pid_file="${RESULT_DIR}/performance-xctrace.pid"
  if [ ! -f "${xctrace_pid_file}" ]; then
    return 0
  fi
  local pid
  pid="$(cat "${xctrace_pid_file}" 2>/dev/null || true)"
  if [ -n "${pid}" ] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill -INT "${pid}" >/dev/null 2>&1 || true
    wait "${pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${xctrace_pid_file}"
  if [ -d "${PERFORMANCE_TRACE_FILE}" ]; then
    local waited=0
    while [ "${waited}" -lt 30 ]; do
      if [ -d "${PERFORMANCE_TRACE_FILE}/Trace1.run" ] && [ -s "${PERFORMANCE_TRACE_FILE}/form.template" ]; then
        break
      fi
      sleep 1
      waited=$((waited + 1))
    done
  fi
  if [ -d "${PERFORMANCE_TRACE_FILE}" ]; then
    export_xctrace_performance_samples || true
    if package_performance_trace; then
      log "xctrace 性能采样: ${PERFORMANCE_TRACE_ARCHIVE_FILE}"
    else
      log "xctrace 性能采样已生成，但打包失败: ${PERFORMANCE_TRACE_FILE}"
    fi
  else
    log "xctrace 性能采样未生成 trace。"
  fi
}

collect_crash_reports() {
  mkdir -p "${CRASH_REPORT_DIR}"
  log "采集崩溃报告..."
  local crash_log="${RESULT_DIR}/crashreport-collect.log"
  : > "${crash_log}"
  local status=1
  if "${TIDEVICE_CMD}" --udid "${SELECTED_DEVICE}" crashreport -o "${CRASH_REPORT_DIR}" >>"${crash_log}" 2>&1; then
    status=0
  elif "${TIDEVICE_CMD}" --udid "${SELECTED_DEVICE}" crashreport "${CRASH_REPORT_DIR}" >>"${crash_log}" 2>&1; then
    status=0
  fi
  if [ "${status}" != "0" ]; then
    log "崩溃报告采集失败或当前 tidevice 不支持 crashreport，已记录到 ${crash_log}。"
    return 1
  fi
  local count
  count="$(find "${CRASH_REPORT_DIR}" -type f \( -name '*.ips' -o -name '*.crash' -o -name '*.log' \) 2>/dev/null | wc -l | tr -d ' ')"
  log "崩溃报告: ${CRASH_REPORT_DIR} (${count:-0} 个文件)"
  return 0
}

check_process_alive() {
  local bundle_id="$1"
  local executable_name="${2:-}"
  if ! command -v xcrun >/dev/null 2>&1 || ! xcrun devicectl --help >/dev/null 2>&1; then
    log "未找到 devicectl，跳过进程存活检查。"
    return 2
  fi

  log "检查 App 进程存活..."
  rm -f "${PROCESS_FILE}"
  if ! xcrun devicectl device info processes --device "${SELECTED_DEVICE}" --json-output "${PROCESS_FILE}" >/dev/null 2>&1; then
    log "进程列表采集失败，跳过进程存活检查。"
    return 2
  fi
  if grep -q "${bundle_id}" "${PROCESS_FILE}" 2>/dev/null; then
    log "进程存活: ${bundle_id}"
    return 0
  fi
  if [ -n "${executable_name}" ] && python3 - "${PROCESS_FILE}" "${executable_name}" <<'PY'
import json
import os
import sys
from urllib.parse import unquote, urlparse

path, expected = sys.argv[1:3]
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception:
    sys.exit(1)

def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)

def basename(value):
    if not isinstance(value, str) or not value:
        return ""
    if value.startswith("file://"):
        parsed = urlparse(value)
        value = unquote(parsed.path)
    return os.path.basename(value.rstrip("/"))

for item in walk(data):
    candidates = [
        item.get("name"),
        item.get("executableName"),
        item.get("executable"),
        item.get("path"),
    ]
    if any(candidate == expected or basename(candidate) == expected for candidate in candidates):
        sys.exit(0)
sys.exit(1)
PY
  then
    log "进程存活: ${executable_name}"
    return 0
  fi
  log "未在进程列表中确认 App 进程，可能是 devicectl 进程输出未包含 Bundle ID 或 App 启动后进入短生命周期。"
  return 1
}

wda_url_part() {
  local part="$1"
  python3 - "$WDA_URL" "$part" <<'PY'
import sys
from urllib.parse import urlparse

parsed = urlparse(sys.argv[1])
part = sys.argv[2]
if part == "host":
    print(parsed.hostname or "127.0.0.1")
elif part == "port":
    if parsed.port:
        print(parsed.port)
    elif parsed.scheme == "https":
        print(443)
    else:
        print(80)
PY
}

check_wda_ready_url() {
  local url_to_check="${1:-${WDA_URL}}"
  python3 - "$url_to_check" <<'PY'
import json
import sys
import urllib.request

url = sys.argv[1].rstrip("/")
try:
    with urllib.request.urlopen(f"{url}/status", timeout=3) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        if 200 <= resp.status < 500:
            try:
                json.loads(body or "{}")
            except Exception:
                pass
            sys.exit(0)
except Exception:
    pass
sys.exit(1)
PY
}

check_wda_ready() {
  check_wda_ready_url "${1:-${WDA_URL}}"
}

is_local_wda_host() {
  local host
  host="$(wda_url_part host)"
  case "${host}" in
    127.*|localhost|::1)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

start_iproxy() {
  local port="$1"
  local log_file="$2"
  local host="${WDA_BIND_HOST}"
  local help_text

  if is_local_wda_host; then
    host="127.0.0.1"
  fi

  help_text="$(iproxy --help 2>&1 || true)"
  if [ "${host}" = "127.0.0.1" ] || [ "${host}" = "localhost" ]; then
    log "启动 iproxy: 127.0.0.1:${port} -> device:8100"
    iproxy -u "${SELECTED_DEVICE}" "${port}:8100" >>"${log_file}" 2>&1
    return
  fi

  if printf '%s' "${help_text}" | grep -q -- '--source'; then
    log "启动 iproxy: ${host}:${port} -> device:8100"
    iproxy -u "${SELECTED_DEVICE}" -s "${host}" "${port}:8100" >>"${log_file}" 2>&1
    return
  fi

  log "启动 iproxy: ${host}:${port} -> device:8100"
  iproxy -u "${SELECTED_DEVICE}" -l "${host}" "${port}" 8100 >>"${log_file}" 2>&1
}

find_wda_project() {
  if [ -n "${WDA_PROJECT_PATH}" ] && [ -d "${WDA_PROJECT_PATH}" ]; then
    printf '%s\n' "${WDA_PROJECT_PATH}"
    return
  fi

  local candidates=(
    "${HOME}/工作/sonic-agent/WebDriverAgent/WebDriverAgent.xcodeproj"
    "${HOME}/工作/sonic-agent/sonic-ios-webdriveragent/WebDriverAgent.xcodeproj"
    "${HOME}/工作/sonic-agent/plugins/WebDriverAgent/WebDriverAgent.xcodeproj"
    "${HOME}/工作/sonic-agent/plugins/sonic-ios-webdriveragent/WebDriverAgent.xcodeproj"
    "${HOME}/sonic-agent/WebDriverAgent/WebDriverAgent.xcodeproj"
    "${HOME}/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj"
    "${HOME}/.appium/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj"
    "/opt/homebrew/lib/node_modules/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj"
    "/opt/homebrew/lib/node_modules/appium/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj"
    "/usr/local/lib/node_modules/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj"
    "/usr/local/lib/node_modules/appium/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -d "${candidate}" ]; then
      printf '%s\n' "${candidate}"
      return
    fi
  done

  local roots=(
    "${HOME}/工作/sonic-agent"
    "${HOME}/sonic-agent"
    "${HOME}/.appium"
    "/opt/homebrew/lib/node_modules/appium"
    "/usr/local/lib/node_modules/appium"
  )
  local root found
  for root in "${roots[@]}"; do
    if [ ! -d "${root}" ]; then
      continue
    fi
    found="$(find "${root}" -type d -name WebDriverAgent.xcodeproj -print -quit 2>/dev/null || true)"
    if [ -n "${found}" ]; then
      printf '%s\n' "${found}"
      return
    fi
  done
}

prepare_wda_project() {
  if [ "${WDA_AUTO_INSTALL}" != "1" ]; then
    log_return_func "WDA_AUTO_INSTALL=${WDA_AUTO_INSTALL}，跳过自动准备 WDA。"
    return 1
  fi

  if [ -s "${HOME}/.nvm/nvm.sh" ]; then
    # Jenkins 非交互 shell 通常不会加载 nvm，这里只在需要 Appium 时补一次。
    # shellcheck disable=SC1090
    . "${HOME}/.nvm/nvm.sh" >/dev/null 2>&1 || true
    nvm use --lts >/dev/null 2>&1 || nvm use default >/dev/null 2>&1 || true
  fi

  export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

  log_return_func "尝试自动准备 WebDriverAgent：安装/检测 Appium XCUITest Driver。"
  if ! command -v appium >/dev/null 2>&1; then
    if command -v npx >/dev/null 2>&1; then
      log_return_func "未找到 appium，尝试通过 npx 安装 XCUITest Driver。"
      if ! npx -y appium driver install xcuitest >>"${LOG_FILE}" 2>&1; then
        log_return_func "npx 安装 XCUITest Driver 失败，继续尝试 npm install -g appium。"
      fi
      local prepared
      prepared="$(find_wda_project)"
      if [ -n "${prepared}" ]; then
        printf '%s\n' "${prepared}"
        return 0
      fi
    fi
    if ! command -v npm >/dev/null 2>&1; then
      log_return_func "未找到 appium 或 npm，无法自动安装 Appium XCUITest Driver。"
      return 1
    fi
    log_return_func "未找到 appium，尝试 npm install -g appium。"
    if ! npm install -g appium >>"${LOG_FILE}" 2>&1; then
      log_return_func "安装 appium 失败，请在打包机 Jenkins 用户下手动执行：npm install -g appium"
      return 1
    fi
  fi

  if command -v appium >/dev/null 2>&1; then
    log_return_func "检查 Appium XCUITest Driver..."
    appium driver list --installed >>"${LOG_FILE}" 2>&1 || true
    if ! appium driver list --installed 2>/dev/null | grep -qi "xcuitest"; then
      log_return_func "未检测到 XCUITest Driver，尝试 appium driver install xcuitest。"
      if ! appium driver install xcuitest >>"${LOG_FILE}" 2>&1; then
        log_return_func "安装 XCUITest Driver 失败，请在打包机 Jenkins 用户下手动执行：appium driver install xcuitest"
        return 1
      fi
    fi
  fi

  find_wda_project
}

ensure_wda_ready() {
  if check_wda_ready "${WDA_URL}"; then
    MONKEY_RUNTIME_WDA_URL="${WDA_URL}"
    log "WDA 已可访问: ${MONKEY_RUNTIME_WDA_URL}"
    write_quality_progress "running" "wda" "WDA 已可访问" 1.4
    return 0
  fi

  log "WDA 当前不可访问: ${WDA_URL}"
  write_quality_progress "running" "wda" "WDA 当前不可访问，准备自动启动" 1.1
  if [ "${WDA_AUTO_START}" != "1" ]; then
    log "WDA_AUTO_START=${WDA_AUTO_START}，跳过自动启动 WDA。"
    WDA_READY_ERROR="WDA 不可访问且已关闭自动启动：${WDA_URL}"
    return 1
  fi

  local wda_project
  wda_project="$(find_wda_project)"
  if [ -z "${wda_project}" ]; then
    log "未找到 WebDriverAgent.xcodeproj，开始自动准备 WDA。"
    wda_project="$(prepare_wda_project || true)"
    if [ -z "${wda_project}" ]; then
      log "仍未找到 WebDriverAgent.xcodeproj，无法自动启动 WDA。"
      log "可通过 Jenkins 参数 WDA_PROJECT_PATH 指定 WebDriverAgent.xcodeproj，例如 Appium XCUITest Driver 自带的 WDA 工程。"
      WDA_READY_ERROR="未找到 WebDriverAgent.xcodeproj，无法自动启动 WDA。请先执行 sh scripts/sonic/sonic.sh monkey-setup，或配置 WDA_PROJECT_PATH。"
      return 1
    fi
  fi

  if ! command -v xcodebuild >/dev/null 2>&1; then
    log "未找到 xcodebuild，无法自动启动 WDA。"
    WDA_READY_ERROR="未找到 xcodebuild，无法自动启动 WDA。请确认 Jenkins 用户可访问 Xcode 命令行工具。"
    return 1
  fi

  local wda_port wda_log iproxy_log iproxy_pid_file wda_pid_file
  wda_port="$(wda_url_part port)"
  wda_log="${RESULT_DIR}/wda-xcodebuild.log"
  iproxy_log="${RESULT_DIR}/wda-iproxy.log"
  iproxy_pid_file="${RESULT_DIR}/wda-iproxy.pid"
  wda_pid_file="${RESULT_DIR}/wda-xcodebuild.pid"
  : > "${wda_log}"
  : > "${iproxy_log}"

  log "准备启动 WDA: project=${wda_project}, scheme=${WDA_SCHEME}, device=${SELECTED_DEVICE}, url=${WDA_URL}, derivedData=${WDA_DERIVED_DATA_PATH}"
  write_quality_progress "running" "wda" "准备启动 WebDriverAgentRunner" 1.2

  if command -v iproxy >/dev/null 2>&1; then
    if ! pgrep -f "iproxy.*${wda_port}.*8100" >/dev/null 2>&1; then
      (
        start_iproxy "${wda_port}" "${iproxy_log}"
      ) &
      echo $! > "${iproxy_pid_file}"
      sleep 1
      if ! kill -0 "$(cat "${iproxy_pid_file}")" >/dev/null 2>&1; then
        log "iproxy 启动失败，无法把 WDA 暴露到 ${WDA_URL}。"
        log "请检查 iproxy 日志：${iproxy_log}"
        WDA_READY_ERROR="iproxy 启动失败，无法监听 ${WDA_URL}。请查看 wda-iproxy.log。"
        return 1
      fi
    else
      log "检测到已有 iproxy 监听 ${wda_port}，复用。"
    fi
  else
    log "未找到 iproxy，将依赖 WDA_URL 本身可访问。建议安装 libimobiledevice：brew install libimobiledevice。"
  fi

  if ! pgrep -f "xcodebuild.*${WDA_SCHEME}.*${SELECTED_DEVICE}" >/dev/null 2>&1; then
    log "启动 WebDriverAgentRunner..."
    local xcodebuild_args=(
      -project "${wda_project}"
      -scheme "${WDA_SCHEME}"
      -destination "id=${SELECTED_DEVICE}"
      -derivedDataPath "${WDA_DERIVED_DATA_PATH}"
      -allowProvisioningUpdates
    )
    local xcodebuild_settings=("CODE_SIGN_STYLE=Automatic")
    if [ -n "${WDA_DEVELOPMENT_TEAM}" ]; then
      xcodebuild_settings+=("DEVELOPMENT_TEAM=${WDA_DEVELOPMENT_TEAM}")
    fi
    if [ -n "${WDA_BUNDLE_ID}" ]; then
      xcodebuild_settings+=("PRODUCT_BUNDLE_IDENTIFIER=${WDA_BUNDLE_ID}")
    fi
    if [ -n "${WDA_XCODEBUILD_EXTRA_ARGS}" ]; then
      log "WDA 额外 xcodebuild 参数: ${WDA_XCODEBUILD_EXTRA_ARGS}"
    fi
    (
      # shellcheck disable=SC2086
      xcodebuild "${xcodebuild_args[@]}" "${xcodebuild_settings[@]}" ${WDA_XCODEBUILD_EXTRA_ARGS} test >>"${wda_log}" 2>&1
    ) &
    echo $! > "${wda_pid_file}"
  else
    log "检测到已有 WebDriverAgentRunner xcodebuild 进程，复用。"
  fi

  local attempt max_attempts xcodebuild_pid
  max_attempts=$((WDA_START_TIMEOUT_SECONDS / 2))
  if [ "${max_attempts}" -lt 1 ]; then
    max_attempts=1
  fi
  for attempt in $(seq 1 "${max_attempts}"); do
    if check_wda_ready "${WDA_URL}"; then
      MONKEY_RUNTIME_WDA_URL="${WDA_URL}"
      log "WDA 启动成功: ${MONKEY_RUNTIME_WDA_URL}"
      write_quality_progress "running" "wda" "WDA 启动成功" 1.4
      return 0
    fi
    if [ -f "${wda_pid_file}" ]; then
      xcodebuild_pid="$(cat "${wda_pid_file}" 2>/dev/null || true)"
      if [ -n "${xcodebuild_pid}" ] && ! kill -0 "${xcodebuild_pid}" >/dev/null 2>&1; then
        log "WDA xcodebuild 已退出，但 WDA 仍不可访问。"
        break
      fi
    fi
    if [ $((attempt % 15)) -eq 0 ]; then
      log "等待 WDA 启动中... ${attempt}/${max_attempts}"
    fi
    sleep 2
  done

  log "WDA 自动启动后仍不可访问: ${WDA_URL}"
  log "WDA xcodebuild 日志: ${wda_log}"
  log "WDA iproxy 日志: ${iproxy_log}"
  if [ -f "${wda_pid_file}" ]; then
    xcodebuild_pid="$(cat "${wda_pid_file}" 2>/dev/null || true)"
    if [ -n "${xcodebuild_pid}" ] && kill -0 "${xcodebuild_pid}" >/dev/null 2>&1; then
      log "WDA xcodebuild 仍在运行，可能首次编译较慢。可通过 WDA_START_TIMEOUT_SECONDS 增大等待时间。"
    fi
  fi
  if [ -f "${wda_log}" ]; then
    log "---- WDA xcodebuild 日志尾部 ----"
    tail -80 "${wda_log}" | tee -a "${LOG_FILE}" || true
    log "---- WDA xcodebuild 日志尾部结束 ----"
  fi
  if [ -f "${iproxy_log}" ]; then
    log "---- WDA iproxy 日志尾部 ----"
    tail -40 "${iproxy_log}" | tee -a "${LOG_FILE}" || true
    log "---- WDA iproxy 日志尾部结束 ----"
  fi
  WDA_READY_ERROR="WDA 启动后仍不可访问：${WDA_URL}。请查看 Jenkins 控制台中的 WDA xcodebuild / iproxy 日志尾部。常见原因是 WDA 签名/Team 配置失败、设备未信任开发者、首次编译超时或 iproxy 未正确监听 ${WDA_BIND_HOST}:${wda_port}。"
  return 1
}

run_monkey_test() {
  rm -f "${MONKEY_REPORT_FILE}"
  if [ "${MONKEY_DURATION_SECONDS:-0}" != "0" ]; then
    log "开始 Monkey 测试: 持续 ${MONKEY_DURATION_SECONDS} 秒，WDA=${WDA_URL}"
  else
    log "开始 Monkey 测试: ${MONKEY_EVENT_COUNT} 次随机操作，WDA=${WDA_URL}"
  fi
  write_quality_progress "running" "monkey" "准备 Monkey 测试环境" 1.5
  if ! ensure_wda_ready; then
    local message
    message="${WDA_READY_ERROR:-WDA 准备失败：${WDA_URL} 不可访问。}"
    python3 - "$MONKEY_REPORT_FILE" "$WDA_URL" "$MONKEY_EVENT_COUNT" "$MONKEY_DURATION_SECONDS" "$message" <<'PY'
import json
import sys
report_file, wda_url, event_count, duration_seconds, message = sys.argv[1:6]
with open(report_file, "w", encoding="utf-8") as f:
    json.dump({
        "status": "failed",
        "message": message,
        "wdaUrl": wda_url,
        "requestedEvents": int(event_count or "30"),
        "requestedDurationSeconds": int(float(duration_seconds or "0")),
        "executedEvents": 0,
        "events": [],
    }, f, ensure_ascii=False, indent=2)
PY
    return 1
  fi
  local monkey_wda_project monkey_wda_port
  monkey_wda_project="$(find_wda_project || true)"
  monkey_wda_port="$(wda_url_part port)"
  export MONKEY_WDA_MAX_RECOVERIES MONKEY_WDA_RECOVERY_SLEEP_SECONDS MONKEY_WDA_RESTART_TIMEOUT_SECONDS
  export MONKEY_WDA_PROJECT_PATH="${monkey_wda_project}"
  export MONKEY_WDA_PORT="${monkey_wda_port}"
  export MONKEY_WDA_BIND_HOST="${WDA_BIND_HOST}"
  export MONKEY_WDA_SELECTED_DEVICE="${SELECTED_DEVICE}"
  export MONKEY_WDA_SCHEME="${WDA_SCHEME}"
  export MONKEY_WDA_DERIVED_DATA_PATH="${WDA_DERIVED_DATA_PATH}"
  export MONKEY_WDA_DEVELOPMENT_TEAM="${WDA_DEVELOPMENT_TEAM}"
  export MONKEY_WDA_BUNDLE_ID="${WDA_BUNDLE_ID}"
  export MONKEY_WDA_XCODEBUILD_EXTRA_ARGS="${WDA_XCODEBUILD_EXTRA_ARGS}"
  export MONKEY_WDA_IPROXY_LOG="${RESULT_DIR}/wda-iproxy.log"
  export MONKEY_WDA_XCODEBUILD_LOG="${RESULT_DIR}/wda-xcodebuild.log"
  export MONKEY_WDA_IPROXY_PID_FILE="${RESULT_DIR}/wda-iproxy.pid"
  export MONKEY_WDA_XCODEBUILD_PID_FILE="${RESULT_DIR}/wda-xcodebuild.pid"
  python3 - "$MONKEY_RUNTIME_WDA_URL" "$MONKEY_EVENT_COUNT" "$MONKEY_DURATION_SECONDS" "$MONKEY_INTERVAL_SECONDS" "$MONKEY_SEED" "$MONKEY_REPORT_FILE" "$MONKEY_MAX_REPORTED_EVENTS" "$MONKEY_BACK_INTERVAL_EVENTS" "$MONKEY_STUCK_EVENTS" "$MONKEY_STUCK_CHECK_INTERVAL_EVENTS" "$MONKEY_BACK_ACTION_PROBABILITY" "$MONKEY_BACK_TAP_PROBABILITY" "$MONKEY_AVOID_TOP_BAR" "$MONKEY_HEARTBEAT_INTERVAL_SECONDS" "$MONKEY_FORBIDDEN_TEXTS" "$MONKEY_FORBIDDEN_PAGE_TEXTS" "$MONKEY_FORBIDDEN_REGION_RATIO" "$MONKEY_FORBIDDEN_PADDING" "$PROGRESS_FILE" "$PERFORMANCE_SAMPLE_FILE" <<'PY'
import hashlib
import json
import os
import random
import re
import shlex
import socket
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

wda_url, event_count, duration_seconds, interval_seconds, seed, report_file, max_reported_events, back_interval_events, stuck_events, stuck_check_interval_events, back_action_probability, back_tap_probability, avoid_top_bar, heartbeat_interval_seconds, forbidden_texts, forbidden_page_texts, forbidden_region_ratio, forbidden_padding, progress_file, performance_sample_file = sys.argv[1:21]
wda_url = wda_url.rstrip("/")
event_count = max(1, int(event_count or "30"))
duration_seconds = max(0.0, float(duration_seconds or "0"))
interval_seconds = max(0, float(interval_seconds or "0.35"))
max_reported_events = max(0, int(max_reported_events or "1000"))
back_interval_events = max(0, int(float(back_interval_events or "25")))
stuck_events = max(0, int(float(stuck_events or "18")))
stuck_check_interval_events = max(1, int(float(stuck_check_interval_events or "5")))
back_action_probability = min(max(0.0, float(back_action_probability or "0.12")), 1.0)
back_tap_probability = min(max(0.0, float(back_tap_probability or "0.35")), 1.0)
avoid_top_bar = str(avoid_top_bar or "1") == "1"
heartbeat_interval_seconds = max(0.0, float(heartbeat_interval_seconds or "60"))
forbidden_terms = [item.strip() for item in (forbidden_texts or "").split(",") if item.strip()]
forbidden_terms_lower = [item.lower() for item in forbidden_terms]
forbidden_page_terms = [item.strip() for item in (forbidden_page_texts or "").split(",") if item.strip()]
forbidden_page_terms_lower = [item.lower() for item in forbidden_page_terms]
forbidden_padding = max(0, int(float(forbidden_padding or "16")))
random.seed(seed or None)
max_wda_recoveries = max(0, int(float(os.environ.get("MONKEY_WDA_MAX_RECOVERIES", "5"))))
recovery_sleep_seconds = max(0.0, float(os.environ.get("MONKEY_WDA_RECOVERY_SLEEP_SECONDS", "3")))
restart_timeout_seconds = max(30.0, float(os.environ.get("MONKEY_WDA_RESTART_TIMEOUT_SECONDS", "120")))
wda_project_path = os.environ.get("MONKEY_WDA_PROJECT_PATH", "")
wda_port = os.environ.get("MONKEY_WDA_PORT", "8100")
wda_bind_host = os.environ.get("MONKEY_WDA_BIND_HOST", "127.0.0.1") or "127.0.0.1"
selected_device = os.environ.get("MONKEY_WDA_SELECTED_DEVICE", "")
wda_scheme = os.environ.get("MONKEY_WDA_SCHEME", "WebDriverAgentRunner")
wda_derived_data_path = os.environ.get("MONKEY_WDA_DERIVED_DATA_PATH", "")
wda_development_team = os.environ.get("MONKEY_WDA_DEVELOPMENT_TEAM", "")
wda_bundle_id = os.environ.get("MONKEY_WDA_BUNDLE_ID", "")
wda_xcodebuild_extra_args = os.environ.get("MONKEY_WDA_XCODEBUILD_EXTRA_ARGS", "")
wda_iproxy_log = os.environ.get("MONKEY_WDA_IPROXY_LOG", "")
wda_xcodebuild_log = os.environ.get("MONKEY_WDA_XCODEBUILD_LOG", "")
wda_iproxy_pid_file = os.environ.get("MONKEY_WDA_IPROXY_PID_FILE", "")
wda_xcodebuild_pid_file = os.environ.get("MONKEY_WDA_XCODEBUILD_PID_FILE", "")

events = []
session_id = ""
width = 390
height = 844
safe_top = 96
tap_safe_top = 96
safe_bottom = 80
safe_left = 20
safe_right = 20

def request(method, path, payload=None, timeout=8):
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{wda_url}{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        return json.loads(body) if body else {}

def is_recoverable_wda_error(exc):
    message = str(exc)
    if isinstance(exc, (TimeoutError, socket.timeout, urllib.error.URLError)):
        return True
    recoverable_tokens = (
        "timed out",
        "Connection refused",
        "Connection reset by peer",
        "Broken pipe",
        "Remote end closed connection",
        "Errno 54",
        "Errno 57",
        "Errno 60",
        "Errno 61",
    )
    if any(token in message for token in recoverable_tokens):
        return True
    if isinstance(exc, urllib.error.HTTPError) and exc.code >= 500:
        return True
    return False

def value_of(response):
    return response.get("value", response)

def get_session_id(response):
    value = value_of(response)
    return (
        response.get("sessionId")
        or (value.get("sessionId") if isinstance(value, dict) else "")
        or ""
    )

def create_session():
    session_response = request("POST", "/session", {"capabilities": {"alwaysMatch": {}, "firstMatch": [{}]}}, timeout=15)
    next_session_id = get_session_id(session_response)
    if not next_session_id:
        raise RuntimeError(f"WDA did not return sessionId: {session_response}")
    try:
        request("POST", f"/session/{next_session_id}/appium/settings", {"settings": {"waitForIdleTimeout": 1}}, timeout=5)
    except Exception:
        pass
    return next_session_id

def read_pid(path):
    if not path:
        return None
    try:
        text = open(path, encoding="utf-8").read().strip()
        pid = int(text)
        return pid if pid > 0 else None
    except Exception:
        return None

def terminate_pid(pid):
    if not pid:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        return
    deadline_kill = time.time() + 5
    while time.time() < deadline_kill:
        try:
            os.kill(pid, 0)
        except Exception:
            return
        time.sleep(0.2)
    try:
        os.kill(pid, signal.SIGKILL)
    except Exception:
        pass

def terminate_pid_file(path):
    pid = read_pid(path)
    terminate_pid(pid)
    if path:
        try:
            os.remove(path)
        except Exception:
            pass

def pkill_pattern(pattern):
    if not pattern:
        return
    try:
        subprocess.run(["pkill", "-f", pattern], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except Exception:
        pass

def wait_wda_status(timeout_seconds):
    deadline_wait = time.time() + timeout_seconds
    last_error = ""
    while time.time() < deadline_wait:
        try:
            request("GET", "/status", timeout=4)
            return True, ""
        except Exception as exc:
            last_error = str(exc)[:200]
            time.sleep(2)
    return False, last_error

def start_iproxy_process():
    if not selected_device or not wda_port:
        raise RuntimeError("缺少设备 UDID 或 WDA 端口，无法重启 iproxy")
    host = "127.0.0.1" if wda_bind_host in ("", "127.0.0.1", "localhost", "::1") else wda_bind_host
    if host in ("127.0.0.1", "localhost"):
        args = ["iproxy", "-u", selected_device, f"{wda_port}:8100"]
    else:
        args = ["iproxy", "-u", selected_device, "-s", host, f"{wda_port}:8100"]
    log_handle = open(wda_iproxy_log, "ab") if wda_iproxy_log else subprocess.DEVNULL
    proc = subprocess.Popen(args, stdout=log_handle, stderr=subprocess.STDOUT)
    if wda_iproxy_pid_file:
        with open(wda_iproxy_pid_file, "w", encoding="utf-8") as f:
            f.write(str(proc.pid))
    return proc

def start_xcodebuild_process():
    if not wda_project_path or not os.path.isdir(wda_project_path):
        raise RuntimeError("未找到 WebDriverAgent.xcodeproj，无法重启 WDA")
    if not selected_device:
        raise RuntimeError("缺少设备 UDID，无法重启 WDA")
    args = [
        "xcodebuild",
        "-project", wda_project_path,
        "-scheme", wda_scheme,
        "-destination", f"id={selected_device}",
    ]
    if wda_derived_data_path:
        args.extend(["-derivedDataPath", wda_derived_data_path])
    args.append("-allowProvisioningUpdates")
    args.append("CODE_SIGN_STYLE=Automatic")
    if wda_development_team:
        args.append(f"DEVELOPMENT_TEAM={wda_development_team}")
    if wda_bundle_id:
        args.append(f"PRODUCT_BUNDLE_IDENTIFIER={wda_bundle_id}")
    if wda_xcodebuild_extra_args:
        args.extend(shlex.split(wda_xcodebuild_extra_args))
    args.append("test")
    log_handle = open(wda_xcodebuild_log, "ab") if wda_xcodebuild_log else subprocess.DEVNULL
    proc = subprocess.Popen(args, stdout=log_handle, stderr=subprocess.STDOUT)
    if wda_xcodebuild_pid_file:
        with open(wda_xcodebuild_pid_file, "w", encoding="utf-8") as f:
            f.write(str(proc.pid))
    return proc

def hard_restart_wda(event):
    global session_id
    event["hardRestart"] = True
    print("Monkey WDA hard restart: restarting iproxy and WebDriverAgentRunner", flush=True)
    write_progress("running", "WDA 连接中断，正在重启 WDA 通道", event)
    terminate_pid_file(wda_iproxy_pid_file)
    terminate_pid_file(wda_xcodebuild_pid_file)
    if wda_port:
        pkill_pattern(rf"iproxy.*{re.escape(str(wda_port))}.*8100")
    if selected_device:
        pkill_pattern(rf"xcodebuild.*{re.escape(wda_scheme)}.*{re.escape(selected_device)}")
    time.sleep(2)
    try:
        start_iproxy_process()
        start_xcodebuild_process()
    except Exception as exc:
        event["hardRestartError"] = str(exc)[:300]
        print(f"Monkey WDA hard restart failed to start: {event['hardRestartError']}", flush=True)
        return False
    ok, error = wait_wda_status(restart_timeout_seconds)
    event["hardRestartReady"] = ok
    if error:
        event["hardRestartStatusError"] = error
    if not ok:
        print(f"Monkey WDA hard restart timeout: {error}", flush=True)
        return False
    try:
        if session_id:
            request("DELETE", f"/session/{session_id}", timeout=2)
    except Exception:
        pass
    try:
        session_id = create_session()
        refresh_window_metrics(session_id)
        event["sessionReset"] = True
        print("Monkey WDA hard restart succeeded", flush=True)
        write_progress("running", "WDA 已重启，Monkey 继续执行", event)
        return True
    except Exception as exc:
        event["sessionReset"] = False
        event["sessionError"] = str(exc)[:200]
        print(f"Monkey WDA hard restart session reset failed: {event['sessionError']}", flush=True)
        return False

def refresh_window_metrics(session):
    global width, height, safe_top, tap_safe_top, safe_bottom, safe_left, safe_right
    size_response = request("GET", f"/session/{session}/window/size", timeout=8)
    size = value_of(size_response)
    width = int(size.get("width") or 390) if isinstance(size, dict) else 390
    height = int(size.get("height") or 844) if isinstance(size, dict) else 844
    safe_top = max(60, height // 12)
    tap_safe_top = max(safe_top, 96) if avoid_top_bar else safe_top
    safe_bottom = max(80, height // 10)
    safe_left = max(20, width // 20)
    safe_right = max(20, width // 20)

def recover_wda_session(reason, recovery_index):
    global session_id
    event = {
        "index": report.get("executedEvents", 0) + 1,
        "type": "wdaRecover",
        "reason": str(reason)[:300],
        "recoveryIndex": recovery_index,
    }
    record_event(event)
    print(f"Monkey WDA recovery {recovery_index}/{max_wda_recoveries}: {event['reason']}", flush=True)
    write_progress("running", f"WDA 短暂超时，正在恢复 {recovery_index}/{max_wda_recoveries}", event)
    if recovery_sleep_seconds:
        time.sleep(recovery_sleep_seconds)
    status_ok = False
    try:
        request("GET", "/status", timeout=4)
        status_ok = True
    except Exception as exc:
        event["statusProbe"] = "timeout"
        event["statusError"] = str(exc)[:200]
        print(f"Monkey WDA recovery {recovery_index}: status still busy, will retry later", flush=True)
        write_progress("running", f"WDA 仍忙，等待下一轮恢复 {recovery_index}/{max_wda_recoveries}", event)
    if not status_ok:
        if recovery_index >= 2:
            hard_restart_wda(event)
        return session_id
    try:
        if session_id:
            request("DELETE", f"/session/{session_id}", timeout=2)
    except Exception:
        pass
    try:
        session_id = create_session()
        refresh_window_metrics(session_id)
        event["sessionReset"] = True
    except Exception as exc:
        event["sessionReset"] = False
        event["sessionError"] = str(exc)[:200]
        print(f"Monkey WDA recovery {recovery_index}: session reset failed, keep old session", flush=True)
        if recovery_index >= 2:
            hard_restart_wda(event)
    return session_id

def pointer_actions(points):
    actions = []
    first = points[0]
    actions.append({"type": "pointerMove", "duration": 0, "x": first[0], "y": first[1]})
    actions.append({"type": "pointerDown", "button": 0})
    for x, y, duration in points[1:]:
        actions.append({"type": "pointerMove", "duration": duration, "x": x, "y": y})
    actions.append({"type": "pointerUp", "button": 0})
    return {
        "actions": [
            {
                "type": "pointer",
                "id": "finger1",
                "parameters": {"pointerType": "touch"},
                "actions": actions,
            }
        ]
    }

def tap(session, x, y):
    try:
        request("POST", f"/session/{session}/wda/tap/0", {"x": x, "y": y}, timeout=8)
    except Exception:
        request("POST", f"/session/{session}/actions", pointer_actions([(x, y), (x, y, 80)]), timeout=8)

def point_in_rect(x, y, rect):
    left, top, right, bottom = rect
    return left <= x <= right and top <= y <= bottom

def parse_ratio_regions(width, height):
    regions = []
    for raw_region in (forbidden_region_ratio or "").split(";"):
        values = [item.strip() for item in raw_region.split(",") if item.strip()]
        if len(values) != 4:
            continue
        try:
            left, top, right, bottom = [float(item) for item in values]
        except ValueError:
            continue
        if max(left, top, right, bottom) <= 1.0:
            rect = (
                int(left * width),
                int(top * height),
                int(right * width),
                int(bottom * height),
            )
        else:
            rect = (int(left), int(top), int(right), int(bottom))
        regions.append(expand_rect(rect, width, height, forbidden_padding))
    return regions

def expand_rect(rect, width, height, padding):
    left, top, right, bottom = rect
    return (
        max(0, left - padding),
        max(0, top - padding),
        min(width, right + padding),
        min(height, bottom + padding),
    )

def forbidden_regions_from_source(source, width, height):
    regions = []
    if not source or not forbidden_terms:
        return regions
    for match in re.finditer(r'<[^>]+>', source):
        node = match.group(0)
        node_lower = node.lower()
        if not any(term in node_lower for term in forbidden_terms_lower):
            continue
        x_match = re.search(r'\bx="([0-9.]+)"', node)
        y_match = re.search(r'\by="([0-9.]+)"', node)
        width_match = re.search(r'\bwidth="([0-9.]+)"', node)
        height_match = re.search(r'\bheight="([0-9.]+)"', node)
        if not (x_match and y_match and width_match and height_match):
            continue
        x = int(float(x_match.group(1)))
        y = int(float(y_match.group(1)))
        node_width = int(float(width_match.group(1)))
        node_height = int(float(height_match.group(1)))
        if node_width <= 0 or node_height <= 0:
            continue
        regions.append(expand_rect((x, y, x + node_width, y + node_height), width, height, forbidden_padding))
    return regions

def get_source(session):
    try:
        return str(value_of(request("GET", f"/session/{session}/source", timeout=6)) or "")
    except Exception:
        return ""

def get_forbidden_regions(session, width, height):
    source = get_source(session)
    regions = parse_ratio_regions(width, height)
    regions.extend(forbidden_regions_from_source(source, width, height))
    return regions, source

def get_forbidden_regions_from_source(source, width, height):
    regions = parse_ratio_regions(width, height)
    regions.extend(forbidden_regions_from_source(source, width, height))
    return regions

def is_forbidden_page(source):
    if not source or not forbidden_page_terms_lower:
        return False
    source_lower = source.lower()
    return any(term in source_lower for term in forbidden_page_terms_lower)

def text_attr(node, attr):
    match = re.search(rf'\b{attr}="([^"]*)"', node)
    return match.group(1).strip() if match else ""

def summarize_source(source, limit=8):
    if not source:
        return {}
    texts = []
    classes = []
    for match in re.finditer(r'<[^>]+>', source):
        node = match.group(0)
        node_type = text_attr(node, "type")
        if node_type and node_type not in classes:
            classes.append(node_type)
        for attr in ("label", "name", "value"):
            text = text_attr(node, attr)
            if not text or len(text) > 80:
                continue
            if text.lower() in ("true", "false"):
                continue
            if text not in texts:
                texts.append(text)
        if len(texts) >= limit:
            break
    return {
        "text": texts[:limit],
        "nodeTypes": classes[:6],
    }

def current_page_context(source):
    if not source:
        return {}
    return {
        "fingerprint": hashlib.sha1(source.encode("utf-8", errors="ignore")).hexdigest(),
        "summary": summarize_source(source),
    }

def record_event(event, source=""):
    now = time.time()
    event["startedAtMs"] = int(now * 1000)
    event["elapsedSeconds"] = round(now - started_at, 3)
    context = current_page_context(source)
    if context:
        event["page"] = context
    events.append(event)
    return event

def safe_random_point(left, top, right, bottom, forbidden_regions):
    left = min(left, right)
    top = min(top, bottom)
    for _ in range(40):
        x = random.randint(left, right)
        y = random.randint(top, bottom)
        if not any(point_in_rect(x, y, rect) for rect in forbidden_regions):
            return x, y, False
    return random.randint(left, right), random.randint(top, bottom), True

def swipe(session, width, height, forbidden_regions=None):
    forbidden_regions = forbidden_regions or []
    edge = max(24, min(width, height) // 12)
    start_x, start_y, fallback = safe_random_point(edge, edge * 2, max(edge, width - edge), max(edge * 2, height - edge * 2), forbidden_regions)
    delta_x = random.choice([-1, 1]) * random.randint(width // 5, max(width // 5, width // 2))
    delta_y = random.choice([-1, 1]) * random.randint(height // 6, max(height // 6, height // 3))
    end_x = min(max(edge, start_x + delta_x), width - edge)
    end_y = min(max(edge, start_y + delta_y), height - edge)
    request("POST", f"/session/{session}/actions", pointer_actions([(start_x, start_y), (end_x, end_y, 280)]), timeout=8)
    return start_x, start_y, end_x, end_y, fallback

def edge_back_swipe(session, width, height):
    y = random.randint(max(100, height // 5), max(120, height - max(120, height // 5)))
    start_x = max(6, width // 80)
    end_x = min(width - 18, max(width // 2, int(width * 0.72)))
    request("POST", f"/session/{session}/actions", pointer_actions([(start_x, y), (end_x, y, 420)]), timeout=8)
    return start_x, y, end_x, y

def tap_back_region(session, width, safe_top):
    x = random.randint(max(12, width // 30), max(44, width // 5))
    y = random.randint(max(44, safe_top - 20), max(64, safe_top + 18))
    tap(session, x, y)
    return x, y

def is_system_permission_alert(source):
    if not source:
        return False
    source_lower = source.lower()
    return (
        "xcuielementtypealert" in source_lower
        or "想访问你的" in source
        or "would like to access" in source_lower
        or "would like to send you notifications" in source_lower
    )

def dismiss_system_alert(session, width, height):
    try:
        request("POST", f"/session/{session}/alert/dismiss", {}, timeout=5)
        return {"method": "alertDismiss"}
    except Exception:
        pass
    # iOS 权限弹窗的拒绝按钮通常在左侧，兜底点击弹窗左按钮区域。
    x = max(40, int(width * 0.28))
    y = max(120, int(height * 0.62))
    tap(session, x, y)
    return {"method": "tapApprox", "x": x, "y": y}

def ui_fingerprint(session):
    source = get_source(session)
    if not source:
        return ""
    return hashlib.sha1(source.encode("utf-8", errors="ignore")).hexdigest()

def collect_numbers(value, path=""):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from collect_numbers(child, f"{path}.{key}" if path else str(key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from collect_numbers(child, f"{path}.{index}" if path else str(index))
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        yield path.lower(), float(value)

def summarize_recent_performance(path, max_lines=200):
    result = {"sampleCount": 0, "cpu": None, "memoryMB": None, "fps": None}
    if not path or not os.path.exists(path):
        return result
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()[-max_lines:]
    except Exception:
        return result
    cpu_values = []
    memory_values = []
    fps_values = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except Exception:
            continue
        result["sampleCount"] += 1
        for key_path, number in collect_numbers(item):
            if "cpu" in key_path and 0 <= number <= 1000:
                cpu_values.append(number)
            elif "fps" in key_path and 0 <= number <= 240:
                fps_values.append(number)
            elif any(token in key_path for token in ("memory", "mem", "resident", "rss")) and number > 0:
                memory_values.append(number / 1024 / 1024 if number > 1024 * 1024 else number)
    if cpu_values:
        result["cpu"] = round(sum(cpu_values) / len(cpu_values), 2)
    if memory_values:
        result["memoryMB"] = round(max(memory_values), 2)
    if fps_values:
        result["fps"] = round(sum(fps_values) / len(fps_values), 2)
    return result

def write_progress(status, message="", last_action=None):
    if not progress_file:
        return
    now = time.time()
    elapsed = int(now - started_at)
    remaining = max(0, int(deadline - now)) if deadline is not None else None
    if duration_seconds > 0:
        percent = round(min(100, max(0, (elapsed / duration_seconds) * 100)), 2)
        if status == "running":
            percent = max(0.1, percent)
    else:
        percent = round(min(100, (report.get("executedEvents", 0) / max(event_count, 1)) * 100), 2)
    payload = {
        "status": status,
        "phase": "monkey",
        "message": message,
        "updatedAt": int(now * 1000),
        "elapsedSeconds": elapsed,
        "remainingSeconds": remaining,
        "executedEvents": report.get("executedEvents", 0),
        "requestedEvents": event_count,
        "requestedDurationSeconds": int(duration_seconds),
        "progressPercent": percent,
        "lastAction": last_action or (events[-1] if events else None),
        "recentPerformance": summarize_recent_performance(performance_sample_file),
    }
    tmp_path = f"{progress_file}.tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, progress_file)
    except Exception:
        pass

started_at = time.time()
deadline = started_at + duration_seconds if duration_seconds > 0 else None
report = {
    "status": "failed",
    "message": "",
    "wdaUrl": wda_url,
    "requestedEvents": event_count,
    "requestedDurationSeconds": int(duration_seconds),
    "rules": {
        "backIntervalEvents": back_interval_events,
        "stuckEvents": stuck_events,
        "stuckCheckIntervalEvents": stuck_check_interval_events,
        "backActionProbability": back_action_probability,
        "backTapProbability": back_tap_probability,
        "avoidTopBar": avoid_top_bar,
        "heartbeatIntervalSeconds": heartbeat_interval_seconds,
        "forbiddenTexts": forbidden_terms,
        "forbiddenRegionRatio": forbidden_region_ratio,
        "forbiddenPadding": forbidden_padding,
    },
    "executedEvents": 0,
    "events": events,
}
write_progress("running", "Monkey 测试初始化")

try:
    request("GET", "/status", timeout=5)
    session_id = create_session()
    refresh_window_metrics(session_id)
    last_fingerprint = ""
    same_page_events = 0
    last_heartbeat_at = time.time()
    forbidden_regions = parse_ratio_regions(width, height)
    last_forbidden_refresh_index = -999
    wda_recoveries = 0

    index = 0
    while True:
        if deadline is not None:
            if time.time() >= deadline:
                break
        elif index >= event_count:
            break

        try:
            current_source = ""
            should_refresh_source = index - last_forbidden_refresh_index >= stuck_check_interval_events
            if should_refresh_source:
                current_source = get_source(session_id)
                forbidden_regions = get_forbidden_regions_from_source(current_source, width, height)
                last_forbidden_refresh_index = index
            if stuck_events and current_source:
                fingerprint = hashlib.sha1(current_source.encode("utf-8", errors="ignore")).hexdigest()
                if fingerprint == last_fingerprint:
                    same_page_events += stuck_check_interval_events
                else:
                    same_page_events = 0
                    last_fingerprint = fingerprint

            reason = "random"
            action = ""

            if is_system_permission_alert(current_source):
                reason = "systemPermissionAlert"
                detail = dismiss_system_alert(session_id, width, height)
                record_event({
                    "index": index + 1,
                    "type": "dismissAlert",
                    "reason": reason,
                    **detail,
                }, current_source)
                same_page_events = 0
                last_fingerprint = ""
            elif is_forbidden_page(current_source):
                reason = "forbiddenPage"
                start_x, start_y, end_x, end_y = edge_back_swipe(session_id, width, height)
                action = "edgeBack"
                record_event({
                    "index": index + 1,
                    "type": action,
                    "reason": reason,
                    "startX": start_x,
                    "startY": start_y,
                    "endX": end_x,
                    "endY": end_y,
                }, current_source)
                same_page_events = 0
                last_fingerprint = ""
            elif stuck_events and same_page_events >= stuck_events:
                reason = f"stuck:{same_page_events}"
                if random.random() < 0.65:
                    start_x, start_y, end_x, end_y = edge_back_swipe(session_id, width, height)
                    action = "edgeBack"
                    record_event({
                        "index": index + 1,
                        "type": action,
                        "reason": reason,
                        "startX": start_x,
                        "startY": start_y,
                        "endX": end_x,
                        "endY": end_y,
                    }, current_source)
                else:
                    x, y = tap_back_region(session_id, width, safe_top)
                    action = "tapBack"
                    record_event({"index": index + 1, "type": action, "reason": reason, "x": x, "y": y}, current_source)
                same_page_events = 0
                last_fingerprint = ""
            elif back_interval_events and index > 0 and index % back_interval_events == 0:
                reason = f"interval:{back_interval_events}"
                if random.random() < back_tap_probability:
                    x, y = tap_back_region(session_id, width, safe_top)
                    action = "tapBack"
                    record_event({"index": index + 1, "type": action, "reason": reason, "x": x, "y": y}, current_source)
                else:
                    start_x, start_y, end_x, end_y = edge_back_swipe(session_id, width, height)
                    action = "edgeBack"
                    record_event({
                        "index": index + 1,
                        "type": action,
                        "reason": reason,
                        "startX": start_x,
                        "startY": start_y,
                        "endX": end_x,
                        "endY": end_y,
                    }, current_source)
            elif random.random() < back_action_probability:
                reason = "probability"
                if random.random() < back_tap_probability:
                    x, y = tap_back_region(session_id, width, safe_top)
                    action = "tapBack"
                    record_event({"index": index + 1, "type": action, "reason": reason, "x": x, "y": y}, current_source)
                else:
                    start_x, start_y, end_x, end_y = edge_back_swipe(session_id, width, height)
                    action = "edgeBack"
                    record_event({
                        "index": index + 1,
                        "type": action,
                        "reason": reason,
                        "startX": start_x,
                        "startY": start_y,
                        "endX": end_x,
                        "endY": end_y,
                    }, current_source)
            elif random.random() < 0.72:
                x, y, fallback = safe_random_point(
                    safe_left,
                    tap_safe_top,
                    max(safe_left, width - safe_right),
                    max(tap_safe_top, height - safe_bottom),
                    forbidden_regions,
                )
                tap(session_id, x, y)
                record_event({
                    "index": index + 1,
                    "type": "tap",
                    "x": x,
                    "y": y,
                    "forbiddenRegions": len(forbidden_regions),
                    "usedFallbackPoint": fallback,
                }, current_source)
            else:
                start_x, start_y, end_x, end_y, fallback = swipe(session_id, width, height, forbidden_regions)
                record_event({
                    "index": index + 1,
                    "type": "swipe",
                    "startX": start_x,
                    "startY": start_y,
                    "endX": end_x,
                    "endY": end_y,
                    "forbiddenRegions": len(forbidden_regions),
                    "usedFallbackPoint": fallback,
                }, current_source)
            wda_recoveries = 0
        except Exception as exc:
            if not is_recoverable_wda_error(exc):
                raise
            wda_recoveries += 1
            if wda_recoveries > max_wda_recoveries:
                raise RuntimeError(f"WDA 连续 {max_wda_recoveries} 次恢复失败，最后错误：{exc}") from exc
            recover_wda_session(exc, wda_recoveries)
            same_page_events = 0
            last_fingerprint = ""
            last_forbidden_refresh_index = -999
            continue
        report["executedEvents"] = index + 1
        now = time.time()
        if heartbeat_interval_seconds and now - last_heartbeat_at >= heartbeat_interval_seconds:
            elapsed = int(now - started_at)
            remaining_text = ""
            if deadline is not None:
                remaining_text = f", remaining={max(0, int(deadline - now))}s"
            print(f"Monkey heartbeat: executed={report['executedEvents']}, elapsed={elapsed}s{remaining_text}", flush=True)
            write_progress("running", "Monkey 测试运行中")
            last_heartbeat_at = now
        if max_reported_events and len(events) > max_reported_events:
            del events[:len(events) - max_reported_events]
        index += 1
        if deadline is not None:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            time.sleep(min(interval_seconds, remaining))
        else:
            time.sleep(interval_seconds)

    report["status"] = "passed"
    if deadline is not None:
        report["message"] = f"Monkey completed {report['executedEvents']} random events in {int(duration_seconds)} seconds"
    else:
        report["message"] = f"Monkey completed {event_count} random events"
    write_progress("passed", report["message"])
except Exception as exc:
    message = str(exc)
    if (
        "Connection refused" in message
        or "Connection reset by peer" in message
        or "Broken pipe" in message
        or "Remote end closed connection" in message
        or "Errno 54" in message
        or "Errno 57" in message
        or "Errno 60" in message
        or "Errno 61" in message
        or "timed out" in message
    ):
        message = (
            f"WDA 连接不稳定：{wda_url}。脚本已尝试自动恢复，"
            f"仍失败时请检查 WebDriverAgent、iproxy、USB 连接和设备锁屏状态。原始错误：{message}"
        )
    report["message"] = message
    write_progress("failed", message)
finally:
    if session_id:
        try:
            request("DELETE", f"/session/{session_id}", timeout=5)
        except Exception:
            pass
    report["durationMs"] = int((time.time() - started_at) * 1000)
    with open(report_file, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

print(report["message"])
sys.exit(0 if report["status"] == "passed" else 1)
PY
}

load_monkey_result() {
  if [ ! -f "${MONKEY_REPORT_FILE}" ]; then
    return
  fi
  local parsed
  parsed="$(python3 - "$MONKEY_REPORT_FILE" <<'PY'
import json
import sys

try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    data = {}

print("\t".join([
    str(data.get("status") or ""),
    str(data.get("message") or "").replace("\t", " ").replace("\n", " "),
    str(data.get("executedEvents") or "0"),
]))
PY
)"
  IFS=$'\t' read -r MONKEY_STATUS MONKEY_MESSAGE MONKEY_EXECUTED_EVENTS <<< "${parsed}"
}

url_decode() {
  local value="$1"
  python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.argv[1]))' "$value" 2>/dev/null || printf '%s\n' "$value"
}

resolve_xcarchive_path() {
  if [ -n "${XCARCHIVE_PATH}" ] && [ -d "${XCARCHIVE_PATH}" ]; then
    printf '%s\n' "${XCARCHIVE_PATH}"
    return
  fi

  case "${ARCHIVE_URL}" in
    smb://*/Archives/*.xcarchive*)
      local relative decoded candidate
      relative="${ARCHIVE_URL#smb://*/Archives/}"
      decoded="$(url_decode "${relative}")"
      candidate="${HOME}/Library/Developer/Xcode/Archives/${decoded}"
      if [ -d "${candidate}" ]; then
        printf '%s\n' "${candidate}"
        return
      fi
      ;;
  esac
}

[[ -n "${SOURCE_BUILD_NUMBER}" ]] || fail "SOURCE_BUILD_NUMBER is required"
[[ -n "${TEST_SUITE}" ]] || fail "TEST_SUITE is required"
[[ -n "${DEVICE_POOL}" ]] || fail "DEVICE_POOL is required"

cat > "${META_FILE}" <<JSON
{
  "sourceBuildNumber": "${SOURCE_BUILD_NUMBER}",
  "branch": "${BRANCH}",
  "commitHash": "${COMMIT_HASH}",
  "appVersion": "${APP_VERSION}",
  "packageUrl": "${PACKAGE_URL}",
  "xcarchivePath": "${XCARCHIVE_PATH}",
  "archiveUrl": "${ARCHIVE_URL}",
  "testSuite": "${REQUESTED_TEST_SUITE}",
  "devicePool": "${DEVICE_POOL}",
  "devicePoolLabel": "${DEVICE_POOL_LABEL_DISPLAY}",
  "deviceUdid": "${DEVICE_UDID}",
  "deviceCloud": "${DEVICE_CLOUD}",
  "runner": "local-ios-device"
}
JSON

log "========================================"
log "本机 iOS 真机自动质检"
log "========================================"
log "源构建: ${SOURCE_BUILD_NUMBER}"
log "分支: ${BRANCH:-N/A}"
log "Commit: ${COMMIT_HASH:-N/A}"
log "APP版本: ${APP_VERSION:-N/A}"
log "测试套件: ${REQUESTED_TEST_SUITE}"
if [ "${REQUESTED_TEST_SUITE}" != "${TEST_SUITE}" ]; then
  log "Jenkins TEST_SUITE: ${TEST_SUITE}"
fi
log "执行模式: QUALITY_RUNNER=${QUALITY_RUNNER:-N/A}, QA_RUNNER_MODE=${QA_RUNNER_MODE:-N/A}, RUN_MONKEY=${RUN_MONKEY:-0}"
log "设备池: ${DEVICE_POOL_LABEL_DISPLAY} (${DEVICE_POOL})"
log "指定设备: ${DEVICE_UDID:-自动选择第一台 USB iPhone}"
log "包地址: ${PACKAGE_URL:-${ARCHIVE_URL:-N/A}}"
log "xcarchive: ${XCARCHIVE_PATH:-N/A}"
write_quality_progress "running" "prepare" "准备质检任务" 0.1
RESOLVED_XCARCHIVE_PATH="$(resolve_xcarchive_path)"
if [ -n "${RESOLVED_XCARCHIVE_PATH}" ] && [ "${RESOLVED_XCARCHIVE_PATH}" != "${XCARCHIVE_PATH}" ]; then
  log "解析到本地 xcarchive: ${RESOLVED_XCARCHIVE_PATH}"
fi

TIDEVICE_CMD="$(find_tidevice)"
if [ -z "${TIDEVICE_CMD}" ]; then
  fail "未找到 tidevice。请在打包机 Jenkins 用户下安装：python3 -m pipx install tidevice，或 python3 -m pip install --user tidevice。若已安装，请确认 Jenkins 用户 PATH 包含 \$HOME/.local/bin。当前 PATH=${PATH}"
fi

log "tidevice: ${TIDEVICE_CMD}"
log "当前连接设备:"
${TIDEVICE_CMD} list | tee -a "${LOG_FILE}" || true
write_quality_progress "running" "device" "检测 USB 真机" 0.2

SELECTED_DEVICE="$(select_device "${TIDEVICE_CMD}")"
if [ -z "${SELECTED_DEVICE}" ]; then
  fail "未发现 USB 连接的 iPhone。请确认真机已连接打包机并完成信任。"
fi
log "使用设备: ${SELECTED_DEVICE}"
DEVICE_IOS_VERSION="$(detect_device_ios_version "${TIDEVICE_CMD}" "${SELECTED_DEVICE}" || true)"
log "设备 iOS 版本: ${DEVICE_IOS_VERSION:-unknown}"
write_quality_progress "running" "device" "已选择设备 ${SELECTED_DEVICE}" 0.3

write_quality_progress "running" "package" "获取 IPA 包" 0.4
download_status=0
download_ipa "${PACKAGE_URL}" || download_status=$?
if [ "${download_status}" != "0" ] && [ -n "${RESOLVED_XCARCHIVE_PATH}" ]; then
  log "PACKAGE_URL 不可用，尝试从 xcarchive Products 生成临时 IPA: ${RESOLVED_XCARCHIVE_PATH}"
  download_status=0
  package_ipa_from_xcarchive "${RESOLVED_XCARCHIVE_PATH}" || download_status=$?
fi
if [ "${download_status}" != "0" ] && [ -n "${ARCHIVE_URL}" ] && [ "${ARCHIVE_URL}" != "${PACKAGE_URL}" ]; then
  log "PACKAGE_URL 不可用，尝试 ARCHIVE_URL: ${ARCHIVE_URL}"
  download_status=0
  download_ipa "${ARCHIVE_URL}" || download_status=$?
fi
if [ "${download_status}" = "2" ]; then
  file_desc="$(file "${IPA_FILE}" 2>/dev/null || true)"
  fail "下载到的文件不是有效 IPA，可能 PACKAGE_URL 是蒲公英页面短链而不是直接下载地址。PACKAGE_URL=${PACKAGE_URL:-N/A} ARCHIVE_URL=${ARCHIVE_URL:-N/A} 文件信息=${file_desc:-N/A}"
elif [ "${download_status}" != "0" ]; then
  fail "无法获取 IPA。请确保 Jenkins 传入 PACKAGE_URL，且该地址可被打包机下载。ARCHIVE_URL=${ARCHIVE_URL:-N/A}"
fi
compute_ipa_hashes || fail "计算 IPA 指纹失败：${IPA_FILE}"
detect_bundle_id_from_ipa || true
log "IPA: ${IPA_FILE}"
if [ -n "${DETECTED_BUNDLE_ID}" ]; then
  log "检测到安装包 Bundle ID: ${DETECTED_BUNDLE_ID}"
fi
if [ -n "${DETECTED_EXECUTABLE_NAME}" ]; then
  log "检测到安装包可执行名: ${DETECTED_EXECUTABLE_NAME}"
fi
if [ -n "${DETECTED_SHORT_VERSION}" ] || [ -n "${DETECTED_BUNDLE_VERSION}" ]; then
  log "检测到安装包版本: ${DETECTED_SHORT_VERSION:-N/A} (${DETECTED_BUNDLE_VERSION:-N/A})"
fi
log "检测到安装包指纹: sha256=${IPA_SHA256}, md5=${IPA_MD5}"
write_quality_progress "running" "package" "IPA 包已就绪" 0.8

if ! install_ipa; then
  fail "安装 IPA 失败：tidevice 未能完成安装，devicectl 兜底安装也失败。请确认 iPhone 已解锁、已信任此电脑、USB 连接稳定，并查看 ${LOG_FILE}。"
fi
write_quality_progress "running" "install" "IPA 安装完成" 1.0

LAUNCH_BUNDLE_ID="${APP_BUNDLE_ID:-${DETECTED_BUNDLE_ID}}"
if [ -n "${APP_BUNDLE_ID}" ] && [ -n "${DETECTED_BUNDLE_ID}" ] && [ "${APP_BUNDLE_ID}" != "${DETECTED_BUNDLE_ID}" ]; then
  log "配置的 APP_BUNDLE_ID=${APP_BUNDLE_ID} 与安装包 Bundle ID=${DETECTED_BUNDLE_ID} 不一致，按配置启动。"
fi

if [ "${COLD_START_DETECT_SCREEN}" = "1" ]; then
  log "预热 WDA，用于冷启动首屏内容检测..."
  write_quality_progress "running" "wda" "预热 WDA，用于冷启动检测" 1.1
  if ! ensure_wda_ready; then
    log "WDA 预热失败，冷启动耗时将退回固定等待兜底：${WDA_READY_ERROR:-unknown}"
  fi
fi

if [ -n "${LAUNCH_BUNDLE_ID}" ]; then
  write_quality_progress "running" "launch" "启动 App" 1.5
  if ! launch_app "${LAUNCH_BUNDLE_ID}"; then
    fail "安装成功但启动失败：${LAUNCH_BUNDLE_ID}。如果日志包含 DeveloperImage not found，请在打包机安装匹配当前 iOS 版本的 Xcode，或确认 xcrun devicectl 可用。"
  fi
fi

write_quality_progress "running" "coldStart" "等待首屏内容稳定" 1.6
wait_cold_start_ready || true
write_quality_progress "running" "coldStart" "首屏内容已稳定" 1.8
write_quality_progress "running" "performance" "启动性能采样" 1.9
start_performance_sampling || true

process_status=0
check_process_alive "${LAUNCH_BUNDLE_ID}" "${DETECTED_EXECUTABLE_NAME}" || process_status=$?
if [ "${REQUESTED_TEST_SUITE}" = "monkey" ] || [ "${RUN_MONKEY:-}" = "1" ] || [[ "${QA_RUNNER_MODE:-}" == *"monkey"* ]] || [[ "${QUALITY_RUNNER:-}" == *"monkey"* ]]; then
  monkey_status=0
  run_monkey_test || monkey_status=$?
  load_monkey_result
  if [ "${MONKEY_DURATION_SECONDS:-0}" != "0" ]; then
    log "Monkey 结果: ${MONKEY_STATUS:-unknown}，执行 ${MONKEY_EXECUTED_EVENTS:-0} 次，时长 ${MONKEY_DURATION_SECONDS} 秒，${MONKEY_MESSAGE:-}"
  else
    log "Monkey 结果: ${MONKEY_STATUS:-unknown}，执行 ${MONKEY_EXECUTED_EVENTS:-0}/${MONKEY_EVENT_COUNT} 次，${MONKEY_MESSAGE:-}"
  fi
  if [ "${monkey_status}" != "0" ]; then
    fail "Monkey 测试失败：${MONKEY_MESSAGE:-请确认 WDA 已启动并可访问 ${WDA_URL}}"
  fi
fi
stop_performance_sampling || true
capture_screenshot || true
capture_device_log || true
collect_crash_reports || true
if [ "${process_status}" = "1" ]; then
  log "警告: 启动后未确认 App 进程：${LAUNCH_BUNDLE_ID}。本次已完成安装和启动，按启动成功通过。"
fi

if [ "${MONKEY_STATUS}" = "passed" ]; then
  if [ "${MONKEY_DURATION_SECONDS:-0}" != "0" ]; then
    write_summary "passed" "安装、启动、Monkey 测试完成，冷启动首屏耗时 ${COLD_START_READY_MS:-N/A}ms，Monkey 持续 ${MONKEY_DURATION_SECONDS} 秒，执行 ${MONKEY_EXECUTED_EVENTS} 次通过"
  else
    write_summary "passed" "安装、启动、Monkey 测试完成，冷启动首屏耗时 ${COLD_START_READY_MS:-N/A}ms，Monkey ${MONKEY_EXECUTED_EVENTS}/${MONKEY_EVENT_COUNT} 次通过"
  fi
elif [ -n "${COLD_START_READY_MS}" ]; then
  write_summary "passed" "安装、启动完成，冷启动首屏耗时 ${COLD_START_READY_MS}ms，已采集可用日志"
else
  write_summary "passed" "安装、启动完成，已采集可用日志"
fi
if [ "${MONKEY_STATUS}" != "passed" ]; then
  write_quality_progress "passed" "complete" "质检完成" 100 "${MONKEY_EXECUTED_EVENTS:-0}" 0 0
fi
write_report 0
write_standard_monkey_outputs || true
log "质检结果目录: ${RESULT_DIR}"
log "JUnit报告: ${REPORT_FILE}"
log "质检摘要: ${SUMMARY_FILE}"
log "标准结果: ${RESULT_DIR}/result.json"
log "标准问题: ${RESULT_DIR}/issues.json"
log "HTML报告: ${RESULT_DIR}/report.html"
