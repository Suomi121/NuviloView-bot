#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=Android/runtime-common.sh
source "$SCRIPT_DIR/runtime-common.sh"
DEFAULT_PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PROJECT_ROOT="${NUVILOVIEW_PROJECT_ROOT:-$DEFAULT_PROJECT_ROOT}"
ENV_FILE="${NUVILOVIEW_ENV_FILE:-$PROJECT_ROOT/.env.local}"
WORKER_FILE="$PROJECT_ROOT/scripts/run-sync-worker.mjs"
RUNTIME_DIR="${NUVILOVIEW_ANDROID_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
LOG_DIR="${NUVILOVIEW_ANDROID_LOG_DIR:-$SCRIPT_DIR/logs}"
RUNNER_LOG="$LOG_DIR/sync-worker-runner.log"
WORKER_OUTPUT_LOG="$LOG_DIR/sync-worker-output.log"
LOCK_DIR="$RUNTIME_DIR/sync-worker-runner.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"
RUNNER_PID_FILE="$RUNTIME_DIR/sync-worker-runner.pid"
WORKER_PID_FILE="$RUNTIME_DIR/sync-worker.pid"
STARTED_AT_FILE="$RUNTIME_DIR/sync-worker.started-at"
STATE_FILE="$RUNTIME_DIR/sync-worker-runner.state"
CRASH_HISTORY_FILE="$RUNTIME_DIR/sync-worker-crash-history"

MODE="forever"
SHUTDOWN_REQUESTED=0
CURRENT_WORKER_PID=""
CURRENT_SLEEP_PID=""
LOCK_ACQUIRED=0
NODE_PATH=""
NETWORK_FAILURE_SEEN=0
RESTART_DELAYS=(1 2 5 10 30 60)

usage() {
  cat <<'USAGE'
Usage: ./Android/run-sync-worker-forever.sh [option]

Options:
  --validate-only  Validate the Worker configuration without starting it.
  --once           Start the Worker once without automatic restart.
  --status         Show runner and Worker process status.
  --stop           Gracefully stop the active runner and Worker.
  --help           Show this help.
USAGE
}

case "${1:-}" in
  "") MODE="forever" ;;
  --validate-only) MODE="validate" ;;
  --once) MODE="once" ;;
  --status) MODE="status" ;;
  --stop) MODE="stop" ;;
  --help|-h) usage; exit 0 ;;
  *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
esac
(( $# <= 1 )) || { printf 'Only one option may be specified.\n' >&2; exit 2; }

mkdir -p -- "$RUNTIME_DIR" "$LOG_DIR" 2>/dev/null || {
  printf 'Unable to create the Android runtime/log directory.\n' >&2
  exit 1
}
chmod 700 -- "$RUNTIME_DIR" "$LOG_DIR" 2>/dev/null || true
nv_load_redaction_secrets "$ENV_FILE"

log() {
  nv_log "$RUNNER_LOG" "$1"
}

rotate_logs() {
  local max_bytes retention_days
  max_bytes="$(nv_positive_integer "$ENV_FILE" ANDROID_RUNNER_LOG_MAX_BYTES 10485760 1024 1073741824)"
  retention_days="$(nv_positive_integer "$ENV_FILE" ANDROID_RUNNER_LOG_RETENTION_DAYS 14 1 365)"
  nv_rotate_log "$RUNNER_LOG" "$LOG_DIR" "$max_bytes" "$retention_days"
  nv_rotate_log "$WORKER_OUTPUT_LOG" "$LOG_DIR" "$max_bytes" "$retention_days"
}

is_runner_process() {
  nv_pid_matches "$1" "run-sync-worker-forever.sh"
}

is_worker_process() {
  nv_pid_matches "$1" "scripts/run-sync-worker.mjs"
}

worker_enabled() {
  nv_env_enabled "$(nv_get_env_value "$ENV_FILE" SYNC_WORKER_ENABLED)"
}

clear_stale_lock() {
  rm -f -- "$LOCK_PID_FILE" 2>/dev/null || true
  rmdir -- "$LOCK_DIR" 2>/dev/null
}

acquire_lock() {
  local existing_pid
  if mkdir -- "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_PID_FILE"
    printf '%s\n' "$$" > "$RUNNER_PID_FILE"
    LOCK_ACQUIRED=1
    return 0
  fi
  existing_pid="$(nv_read_pid "$LOCK_PID_FILE")"
  if [[ -n "$existing_pid" ]] && is_runner_process "$existing_pid"; then
    log "Another Sync Worker runner is already active (PID $existing_pid)."
    return 1
  fi
  if ! clear_stale_lock 2>/dev/null; then
    log "The Sync Worker runner lock could not be verified or recovered."
    return 1
  fi
  mkdir -- "$LOCK_DIR" 2>/dev/null || return 1
  printf '%s\n' "$$" > "$LOCK_PID_FILE"
  printf '%s\n' "$$" > "$RUNNER_PID_FILE"
  LOCK_ACQUIRED=1
  log "Recovered a stale Sync Worker runner lock."
}

# shellcheck disable=SC2329 # Invoked from the EXIT-trap cleanup path.
release_lock() {
  if (( LOCK_ACQUIRED == 1 )); then
    rm -f -- "$LOCK_PID_FILE" "$RUNNER_PID_FILE" 2>/dev/null || true
    rmdir -- "$LOCK_DIR" 2>/dev/null || true
    LOCK_ACQUIRED=0
  fi
}

validate_configuration() {
  local failed=0 name node_major permission_mode multi_db_enabled
  if ! nv_is_termux; then
    log "This runner is intended for Android Termux."
    failed=1
  fi
  if ! nv_project_is_private "$PROJECT_ROOT"; then
    log "The project is in Android shared storage and cannot safely hold secrets."
    failed=1
  fi
  NODE_PATH="$(command -v node 2>/dev/null || true)"
  if [[ -z "$NODE_PATH" ]]; then
    log "Missing required command: node"
    failed=1
  else
    node_major="$($NODE_PATH -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0')"
    [[ "$node_major" == "24" ]] || { log "Node.js 24.x is required."; failed=1; }
    "$NODE_PATH" --input-type=module -e 'import("node:sqlite")' >/dev/null 2>&1 || {
      log "This Node.js build does not provide node:sqlite."
      failed=1
    }
  fi
  for name in "$ENV_FILE" "$WORKER_FILE" "$PROJECT_ROOT/package.json" "$PROJECT_ROOT/node_modules/pg/package.json"; do
    [[ -f "$name" ]] || { log "Missing required file: $name"; failed=1; }
  done
  if [[ -f "$ENV_FILE" ]]; then
    permission_mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || true)"
    [[ -z "$permission_mode" || "$permission_mode" == "600" ]] || log ".env.local permissions should be 600."
  fi
  if worker_enabled; then
    multi_db_enabled="$(nv_get_env_value "$ENV_FILE" MULTI_DB_SYNC_ENABLED)"
    nv_env_enabled "$(nv_get_env_value "$ENV_FILE" LOCAL_STORAGE_ENABLED)" || {
      log "LOCAL_STORAGE_ENABLED must be true while the Worker is enabled."
      failed=1
    }
    nv_env_enabled "$(nv_get_env_value "$ENV_FILE" LOCAL_STORAGE_WRITE_ENABLED)" || {
      log "LOCAL_STORAGE_WRITE_ENABLED must be true while the Worker is enabled."
      failed=1
    }
    if nv_env_enabled "$multi_db_enabled"; then
      if nv_env_enabled "$(nv_get_env_value "$ENV_FILE" SYNC_SUPABASE_ENABLED)"; then
        [[ -n "$(nv_get_env_value "$ENV_FILE" SUPABASE_DATABASE_URL)" ]] ||
          log "Supabase is enabled without SUPABASE_DATABASE_URL; only that Provider will remain degraded."
      else
        log "Required Supabase replica is disabled; Cloud Complete will remain pending."
      fi
      if nv_env_enabled "$(nv_get_env_value "$ENV_FILE" SYNC_TURSO_ENABLED)"; then
        [[ -n "$(nv_get_env_value "$ENV_FILE" TURSO_DATABASE_URL)" && -n "$(nv_get_env_value "$ENV_FILE" TURSO_AUTH_TOKEN)" ]] ||
          log "Turso is enabled without complete credentials; only that Provider will remain degraded."
        [[ -f "$PROJECT_ROOT/node_modules/@tursodatabase/serverless/package.json" ]] || {
          log "Missing @tursodatabase/serverless dependency for enabled Turso Provider."
          failed=1
        }
      else
        log "Required Turso replica is disabled; Cloud Complete will remain pending."
      fi
    else
      nv_env_enabled "$(nv_get_env_value "$ENV_FILE" SYNC_NEON_REPLICA_ENABLED)" || {
        log "SYNC_NEON_REPLICA_ENABLED must be true while the legacy Worker is enabled."
        failed=1
      }
      [[ -n "$(nv_get_env_value "$ENV_FILE" DATABASE_URL)" ]] || {
        log "DATABASE_URL is required only while the legacy Sync Worker is enabled."
        failed=1
      }
    fi
  fi
  (( failed == 0 ))
}

show_status() {
  local runner_pid worker_pid started state latest
  if ! worker_enabled; then
    printf 'Sync Worker Runner: DISABLED\nSync Worker: DISABLED\n'
    return 0
  fi
  runner_pid="$(nv_read_pid "$RUNNER_PID_FILE")"
  worker_pid="$(nv_read_pid "$WORKER_PID_FILE")"
  state="$(nv_read_state "$STATE_FILE")"
  started="unknown"
  [[ -f "$STARTED_AT_FILE" ]] && IFS= read -r started < "$STARTED_AT_FILE"
  if [[ -n "$runner_pid" ]] && is_runner_process "$runner_pid"; then
    printf 'Sync Worker Runner: RUNNING (PID %s, state %s)\n' "$runner_pid" "$state"
  else
    printf 'Sync Worker Runner: STOPPED (state %s)\n' "$state"
  fi
  if [[ -n "$worker_pid" ]] && is_worker_process "$worker_pid"; then
    printf 'Sync Worker: RUNNING (PID %s)\n' "$worker_pid"
  else
    printf 'Sync Worker: STOPPED\n'
  fi
  printf 'Started: %s\n' "$started"
  if [[ -f "$RUNNER_LOG" ]]; then
    latest="$(tail -n 1 "$RUNNER_LOG" 2>/dev/null || true)"
    printf 'Latest log: %s\n' "$(nv_redact_line "$latest")"
  fi
  [[ -n "$runner_pid" ]] && is_runner_process "$runner_pid"
}

stop_runner() {
  local runner_pid worker_pid
  runner_pid="$(nv_read_pid "$RUNNER_PID_FILE")"
  if [[ -n "$runner_pid" ]] && is_runner_process "$runner_pid"; then
    printf 'Stopping Sync Worker runner PID %s...\n' "$runner_pid"
    kill -TERM "$runner_pid" 2>/dev/null || true
    for _ in {1..30}; do
      is_runner_process "$runner_pid" || break
      sleep 1
    done
    if is_runner_process "$runner_pid"; then
      printf 'Sync Worker runner did not stop within 30 seconds.\n' >&2
      return 1
    fi
  else
    worker_pid="$(nv_read_pid "$WORKER_PID_FILE")"
    if [[ -n "$worker_pid" ]] && is_worker_process "$worker_pid"; then
      printf 'Stopping orphaned Sync Worker PID %s...\n' "$worker_pid"
      kill -TERM "$worker_pid" 2>/dev/null || true
    else
      printf 'Sync Worker runner is not running.\n'
    fi
    rm -f -- "$RUNNER_PID_FILE" "$WORKER_PID_FILE" "$STARTED_AT_FILE" 2>/dev/null || true
    clear_stale_lock 2>/dev/null || true
  fi
}

# shellcheck disable=SC2329 # Invoked from the EXIT-trap cleanup path.
terminate_current_worker() {
  if [[ -n "$CURRENT_WORKER_PID" ]] && is_worker_process "$CURRENT_WORKER_PID"; then
    log "Sending SIGTERM to Sync Worker PID $CURRENT_WORKER_PID."
    kill -TERM "$CURRENT_WORKER_PID" 2>/dev/null || true
    for _ in {1..30}; do
      is_worker_process "$CURRENT_WORKER_PID" || break
      sleep 1
    done
    if is_worker_process "$CURRENT_WORKER_PID"; then
      log "Sync Worker did not stop after 30 seconds; sending SIGKILL as the final orphan-prevention measure."
      kill -KILL "$CURRENT_WORKER_PID" 2>/dev/null || true
    fi
  fi
}

# shellcheck disable=SC2329 # Invoked by SIGINT/SIGTERM traps.
request_shutdown() {
  local signal_name="$1"
  if (( SHUTDOWN_REQUESTED == 0 )); then
    SHUTDOWN_REQUESTED=1
    log "Sync Worker runner received $signal_name and is shutting down."
  fi
  [[ -n "$CURRENT_SLEEP_PID" ]] && nv_pid_alive "$CURRENT_SLEEP_PID" && kill -TERM "$CURRENT_SLEEP_PID" 2>/dev/null || true
  [[ -n "$CURRENT_WORKER_PID" ]] && is_worker_process "$CURRENT_WORKER_PID" && kill -TERM "$CURRENT_WORKER_PID" 2>/dev/null || true
}

# shellcheck disable=SC2329 # Invoked by the EXIT trap.
cleanup() {
  local exit_code=$?
  terminate_current_worker
  rm -f -- "$WORKER_PID_FILE" "$STARTED_AT_FILE" 2>/dev/null || true
  release_lock
  exit "$exit_code"
}

sleep_interruptibly() {
  sleep "$1" &
  CURRENT_SLEEP_PID=$!
  wait "$CURRENT_SLEEP_PID" 2>/dev/null || true
  CURRENT_SLEEP_PID=""
}

restart_delay() {
  local failures="$1" index
  index=$((failures - 1))
  (( index < 0 )) && index=0
  (( index >= ${#RESTART_DELAYS[@]} )) && index=$((${#RESTART_DELAYS[@]} - 1))
  printf '%s' "${RESTART_DELAYS[$index]}"
}

record_crash_and_count() {
  local now="$1" window="$2" temporary="$CRASH_HISTORY_FILE.$$" timestamp_value count=0
  : > "$temporary"
  if [[ -f "$CRASH_HISTORY_FILE" ]]; then
    while IFS= read -r timestamp_value; do
      if [[ "$timestamp_value" =~ ^[0-9]+$ ]] && (( now - timestamp_value <= window )); then
        printf '%s\n' "$timestamp_value" >> "$temporary"
        count=$((count + 1))
      fi
    done < "$CRASH_HISTORY_FILE"
  fi
  printf '%s\n' "$now" >> "$temporary"
  count=$((count + 1))
  mv -- "$temporary" "$CRASH_HISTORY_FILE"
  printf '%s' "$count"
}

run_worker_once() {
  local output_fd exit_code raw_line
  NETWORK_FAILURE_SEEN=0
  log "Starting the local Outbox Sync Worker."
  coproc NV_SYNC_WORKER_PROCESS {
    cd -- "$PROJECT_ROOT" || exit 1
    exec "$NODE_PATH" "--env-file=$ENV_FILE" "$WORKER_FILE" 2>&1
  }
  CURRENT_WORKER_PID="$NV_SYNC_WORKER_PROCESS_PID"
  output_fd="${NV_SYNC_WORKER_PROCESS[0]}"
  printf '%s\n' "$CURRENT_WORKER_PID" > "$WORKER_PID_FILE"
  nv_write_state "$STATE_FILE" "RUNNING"
  log "Sync Worker started with PID $CURRENT_WORKER_PID."
  while IFS= read -r -u "$output_fd" raw_line || [[ -n "${raw_line:-}" ]]; do
    printf '[%s] %s\n' "$(nv_timestamp)" "$(nv_redact_line "${raw_line:-}")" >> "$WORKER_OUTPUT_LOG"
    if [[ "$raw_line" =~ ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ECONNRESET|ECONNREFUSED|getaddrinfo|[Nn]etwork[[:space:]]+unreachable|fetch[[:space:]]+failed ]]; then
      NETWORK_FAILURE_SEEN=1
    fi
  done
  wait "$CURRENT_WORKER_PID" 2>/dev/null
  exit_code=$?
  rm -f -- "$WORKER_PID_FILE"
  CURRENT_WORKER_PID=""
  return "$exit_code"
}

rotate_logs
if [[ "$MODE" == "status" ]]; then show_status; exit $?; fi
if [[ "$MODE" == "stop" ]]; then stop_runner; exit $?; fi

if ! worker_enabled; then
  nv_write_state "$STATE_FILE" "DISABLED"
  log "Sync Worker is disabled by SYNC_WORKER_ENABLED; no process was started."
  printf 'Sync Worker is disabled.\n'
  exit 0
fi

trap 'request_shutdown SIGINT' INT
trap 'request_shutdown SIGTERM' TERM
trap cleanup EXIT

acquire_lock || exit 1
if ! validate_configuration; then
  nv_write_state "$STATE_FILE" "INVALID"
  printf 'Sync Worker validation failed. See %s.\n' "$RUNNER_LOG" >&2
  exit 1
fi
if [[ "$MODE" == "validate" ]]; then
  nv_write_state "$STATE_FILE" "READY"
  printf 'Sync Worker validation passed.\n'
  exit 0
fi

printf '%s\n' "$(nv_timestamp)" > "$STARTED_AT_FILE"
nv_write_state "$STATE_FILE" "STARTING"
log "Android Sync Worker runner started in $MODE mode with PID $$."

quick_failures=0
restart_count=0
while (( SHUTDOWN_REQUESTED == 0 )); do
  rotate_logs
  if ! validate_configuration; then
    [[ "$MODE" == "once" ]] && exit 1
    nv_write_state "$STATE_FILE" "DEGRADED"
    log "Worker configuration is invalid; retrying in 60 seconds without affecting the Bot."
    sleep_interruptibly 60
    continue
  fi
  nv_load_redaction_secrets "$ENV_FILE"
  run_started_epoch="$(date +%s)"
  run_worker_once
  worker_exit_code=$?
  now_epoch="$(date +%s)"
  run_seconds=$((now_epoch - run_started_epoch))
  restart_count=$((restart_count + 1))
  log "Sync Worker stopped with exit code $worker_exit_code after $run_seconds seconds. Restart count: $restart_count."

  (( SHUTDOWN_REQUESTED == 1 )) && break
  if [[ "$MODE" == "once" ]]; then exit "$worker_exit_code"; fi

  if (( NETWORK_FAILURE_SEEN == 1 )); then
    delay_seconds="$(nv_positive_integer "$ENV_FILE" SYNC_RUNNER_NETWORK_RETRY_SECONDS 60 10 3600)"
    nv_write_state "$STATE_FILE" "DEGRADED"
    log "Network failure detected; waiting $delay_seconds seconds before retrying without affecting the Bot."
    sleep_interruptibly "$delay_seconds"
    continue
  fi

  stable_seconds="$(nv_positive_integer "$ENV_FILE" SYNC_RUNNER_STABLE_SECONDS 300 1 86400)"
  crash_limit="$(nv_positive_integer "$ENV_FILE" SYNC_RUNNER_CRASH_LIMIT 5 2 100)"
  crash_window="$(nv_positive_integer "$ENV_FILE" SYNC_RUNNER_CRASH_WINDOW_SECONDS 300 10 86400)"
  cooldown_seconds="$(nv_positive_integer "$ENV_FILE" SYNC_RUNNER_CRASH_COOLDOWN_SECONDS 900 10 86400)"
  if (( run_seconds >= stable_seconds )); then
    quick_failures=0
    : > "$CRASH_HISTORY_FILE"
    delay_seconds=1
    log "The previous Worker run was stable; restart backoff was reset."
  else
    quick_failures=$((quick_failures + 1))
    crash_count="$(record_crash_and_count "$now_epoch" "$crash_window")"
    if (( crash_count >= crash_limit )); then
      nv_write_state "$STATE_FILE" "COOLDOWN"
      log "Worker crash storm detected ($crash_count crashes in ${crash_window}s); cooling down for ${cooldown_seconds}s."
      sleep_interruptibly "$cooldown_seconds"
      : > "$CRASH_HISTORY_FILE"
      quick_failures=0
      continue
    fi
    delay_seconds="$(restart_delay "$quick_failures")"
  fi
  nv_write_state "$STATE_FILE" "DEGRADED"
  log "Restarting only the Sync Worker in $delay_seconds seconds after quick failure count $quick_failures."
  sleep_interruptibly "$delay_seconds"
done

nv_write_state "$STATE_FILE" "STOPPED"
log "Android Sync Worker runner stopped cleanly."
exit 0
