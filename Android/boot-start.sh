#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=Android/runtime-common.sh
source "$SCRIPT_DIR/runtime-common.sh"
DEFAULT_PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PROJECT_ROOT="${NUVILOVIEW_PROJECT_ROOT:-$DEFAULT_PROJECT_ROOT}"
ENV_FILE="${NUVILOVIEW_ENV_FILE:-$PROJECT_ROOT/.env.local}"
RUNTIME_DIR="${NUVILOVIEW_ANDROID_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
LOG_DIR="${NUVILOVIEW_ANDROID_LOG_DIR:-$SCRIPT_DIR/logs}"
BOOT_LOG="$LOG_DIR/termux-boot.log"
BOOT_LOCK_DIR="$RUNTIME_DIR/boot.lock"
BOOT_LOCK_PID_FILE="$BOOT_LOCK_DIR/pid"
BOT_RUNNER="$SCRIPT_DIR/run-bot-forever.sh"
WORKER_RUNNER="$SCRIPT_DIR/run-sync-worker-forever.sh"
PREFLIGHT="$SCRIPT_DIR/termux-preflight.sh"
WAKE_LOCK_MARKER="$RUNTIME_DIR/wake-lock.acquired"
LOCK_ACQUIRED=0

mkdir -p -- "$RUNTIME_DIR" "$LOG_DIR" 2>/dev/null || {
  printf 'Unable to create the Android runtime/log directory.\n' >&2
  exit 1
}
chmod 700 -- "$RUNTIME_DIR" "$LOG_DIR" 2>/dev/null || true
nv_load_redaction_secrets "$ENV_FILE"

boot_log() { nv_log "$BOOT_LOG" "$1"; }

# shellcheck disable=SC2329 # Invoked by the EXIT trap.
cleanup() {
  if (( LOCK_ACQUIRED == 1 )); then
    rm -f -- "$BOOT_LOCK_PID_FILE" 2>/dev/null || true
    rmdir -- "$BOOT_LOCK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

acquire_boot_lock() {
  local existing_pid
  if mkdir -- "$BOOT_LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$BOOT_LOCK_PID_FILE"
    LOCK_ACQUIRED=1
    return 0
  fi
  existing_pid="$(nv_read_pid "$BOOT_LOCK_PID_FILE")"
  if [[ -n "$existing_pid" ]] && nv_pid_matches "$existing_pid" "Android/boot-start.sh"; then
    boot_log "Another boot-start is already running (PID $existing_pid); duplicate request skipped."
    printf 'NuviloView boot-start is already running.\n'
    return 1
  fi
  rm -f -- "$BOOT_LOCK_PID_FILE" 2>/dev/null || true
  rmdir -- "$BOOT_LOCK_DIR" 2>/dev/null || {
    boot_log "A stale boot lock could not be recovered."
    return 1
  }
  mkdir -- "$BOOT_LOCK_DIR" 2>/dev/null || return 1
  printf '%s\n' "$$" > "$BOOT_LOCK_PID_FILE"
  LOCK_ACQUIRED=1
  boot_log "Recovered a stale boot-start lock."
}

rotate_boot_log() {
  local max_bytes retention_days
  max_bytes="$(nv_positive_integer "$ENV_FILE" ANDROID_RUNNER_LOG_MAX_BYTES 10485760 1024 1073741824)"
  retention_days="$(nv_positive_integer "$ENV_FILE" ANDROID_RUNNER_LOG_RETENTION_DAYS 14 1 365)"
  nv_rotate_log "$BOOT_LOG" "$LOG_DIR" "$max_bytes" "$retention_days"
}

start_runner() {
  local label="$1" runner="$2" launcher_pid
  if "$runner" --status >/dev/null 2>&1; then
    boot_log "$label runner is already active; duplicate start skipped."
    return 0
  fi
  boot_log "Starting $label runner."
  nohup "$runner" >> "$BOOT_LOG" 2>&1 < /dev/null &
  launcher_pid=$!
  boot_log "$label runner launch requested with PID $launcher_pid."
  sleep 2
  if "$runner" --status >/dev/null 2>&1; then
    boot_log "$label runner status check passed."
    return 0
  fi
  boot_log "$label runner is not active after startup; it remains isolated from the other runtime."
  return 1
}

rotate_boot_log
acquire_boot_lock || exit 0

if ! nv_project_is_private "$PROJECT_ROOT"; then
  boot_log "Boot blocked because the project is in Android shared storage."
  exit 1
fi
for required in "$PREFLIGHT" "$BOT_RUNNER" "$WORKER_RUNNER"; do
  if [[ ! -x "$required" ]]; then
    boot_log "Required executable is unavailable: $required"
    exit 1
  fi
done

initial_delay="$(nv_positive_integer "$ENV_FILE" ANDROID_BOOT_INITIAL_DELAY_SECONDS 5 0 300)"
if (( initial_delay > 0 )); then
  boot_log "Waiting ${initial_delay}s for Android storage initialization."
  sleep "$initial_delay"
fi

if command -v termux-wake-lock >/dev/null 2>&1; then
  if termux-wake-lock >/dev/null 2>&1; then
    printf '%s\n' "$(nv_timestamp)" > "$WAKE_LOCK_MARKER"
    boot_log "Termux wake lock acquired."
  else
    boot_log "Wake lock acquisition failed; runtime startup will continue."
  fi
else
  boot_log "termux-wake-lock is unavailable; runtime startup will continue."
fi

preflight_attempts="$(nv_positive_integer "$ENV_FILE" ANDROID_BOOT_PREFLIGHT_ATTEMPTS 6 1 30)"
preflight_delay="$(nv_positive_integer "$ENV_FILE" ANDROID_BOOT_PREFLIGHT_DELAY_SECONDS 5 1 300)"
preflight_ok=0
for ((attempt = 1; attempt <= preflight_attempts; attempt += 1)); do
  if "$PREFLIGHT" >> "$BOOT_LOG" 2>&1; then
    preflight_ok=1
    break
  fi
  boot_log "Preflight attempt $attempt/$preflight_attempts failed."
  (( attempt < preflight_attempts )) && sleep "$preflight_delay"
done
if (( preflight_ok == 0 )); then
  boot_log "Critical preflight checks failed; neither runner was launched."
  exit 1
fi

bot_ok=0
worker_ok=0
start_runner "Bot" "$BOT_RUNNER" && bot_ok=1

if nv_env_enabled "$(nv_get_env_value "$ENV_FILE" SYNC_WORKER_ENABLED)"; then
  start_runner "Sync Worker" "$WORKER_RUNNER" && worker_ok=1
else
  worker_ok=1
  boot_log "Sync Worker is disabled; this is a normal configuration and the Bot remains independent."
fi

if (( bot_ok == 1 && worker_ok == 1 )); then
  boot_log "NuviloView Termux runtime startup completed successfully."
  printf 'NuviloView Termux runtime started.\n'
else
  boot_log "NuviloView Termux runtime startup completed in DEGRADED state (bot=$bot_ok worker=$worker_ok)."
  printf 'NuviloView Termux runtime started in DEGRADED state.\n'
fi

# A missing/offline Neon connection may degrade a legacy Bot domain or open the
# Sync circuit, but it never makes this short-lived Boot supervisor loop forever.
exit 0
