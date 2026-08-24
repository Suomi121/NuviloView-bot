#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PROJECT_ROOT="${NUVILOVIEW_PROJECT_ROOT:-$DEFAULT_PROJECT_ROOT}"
ENV_FILE="${NUVILOVIEW_ENV_FILE:-$PROJECT_ROOT/.env.local}"
BOT_FILE="$PROJECT_ROOT/discord-bot.mjs"
TOKEN_CHECK_FILE="$PROJECT_ROOT/scripts/token-leak-check.mjs"
RUNTIME_DIR="${NUVILOVIEW_ANDROID_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
LOG_DIR="${NUVILOVIEW_ANDROID_LOG_DIR:-$SCRIPT_DIR/logs}"
RUNNER_LOG="$LOG_DIR/bot-runner.log"
BOT_OUTPUT_LOG="$LOG_DIR/bot-output.log"
TOKEN_CHECK_LOG="$LOG_DIR/token-leak-check.log"
BOOT_LOG="$LOG_DIR/boot.log"
LOCK_DIR="$RUNTIME_DIR/runner.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"
RUNNER_PID_FILE="$RUNTIME_DIR/runner.pid"
BOT_PID_FILE="$RUNTIME_DIR/bot.pid"
STARTED_AT_FILE="$RUNTIME_DIR/started-at"
STATE_FILE="$RUNTIME_DIR/bot-runner.state"
CRASH_HISTORY_FILE="$RUNTIME_DIR/bot-crash-history"

MAX_LOG_SIZE_BYTES=$((10 * 1024 * 1024))
LOG_RETENTION_DAYS=14
STABLE_RUN_SECONDS=300
SESSION_LIMIT_FALLBACK_SECONDS=900
MAXIMUM_SESSION_LIMIT_WAIT_SECONDS=86400
RESTART_DELAYS=(5 15 30 60 120 300 600 900)
LEASE_CONTENDED_EXIT_CODE=20
LEASE_LOST_EXIT_CODE=21
LEASE_CONFIGURATION_EXIT_CODE=22
LEASE_DATABASE_EXIT_CODE=23
LEASE_CONTENTION_DELAY_SECONDS=300
LEASE_RECOVERY_DELAY_SECONDS=60

MODE="forever"
SHUTDOWN_REQUESTED=0
CURRENT_BOT_PID=""
CURRENT_SLEEP_PID=""
LOCK_ACQUIRED=0
SESSION_LIMIT_SEEN=0
SESSION_LIMIT_RESET_AT=""
BOT_LOGIN_REPORTED=0
NETWORK_FAILURE_SEEN=0
NODE_PATH=""
SECRETS=()

usage() {
  cat <<'USAGE'
Usage: ./Android/run-bot-forever.sh [option]

Options:
  --validate-only  Validate the Termux host without starting the Bot.
  --once           Start the Bot once without automatic restart.
  --status         Show runner and Bot process status.
  --stop           Gracefully stop the active runner and Bot.
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

if (( $# > 1 )); then
  printf 'Only one option may be specified.\n' >&2
  usage >&2
  exit 2
fi

timestamp() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

trim_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

get_env_value() {
  local requested_name="$1"
  local line name value first last
  [[ -f "$ENV_FILE" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      name="${BASH_REMATCH[1]}"
      [[ "$name" == "$requested_name" ]] || continue
      value="$(trim_value "${BASH_REMATCH[2]}")"
      if (( ${#value} >= 2 )); then
        first="${value:0:1}"
        last="${value: -1}"
        if [[ ( "$first" == '"' && "$last" == '"' ) || ( "$first" == "'" && "$last" == "'" ) ]]; then
          value="${value:1:${#value}-2}"
        fi
      fi
      printf '%s' "$value"
      return 0
    fi
  done < "$ENV_FILE"
}

bounded_integer() {
  local name="$1" fallback="$2" minimum="$3" maximum="$4" value
  value="${!name:-}"
  [[ -n "$value" ]] || value="$(get_env_value "$name")"
  [[ -n "$value" ]] || value="$fallback"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < minimum || value > maximum )); then
    value="$fallback"
  fi
  printf '%s' "$value"
}

write_state() {
  printf '%s %s\n' "$1" "$(timestamp)" > "$STATE_FILE"
}

load_redaction_secrets() {
  SECRETS=()
  [[ -f "$ENV_FILE" ]] || return 0
  local line name value database_password
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      name="${BASH_REMATCH[1]}"
      case "$name" in
        *TOKEN*|*SECRET*|*PASSWORD*|*API_KEY*|DATABASE_URL)
          value="$(get_env_value "$name")"
          if (( ${#value} >= 8 )); then
            SECRETS+=("$value")
          fi
          if [[ "$name" == "DATABASE_URL" && "$value" =~ ^[^:]+://[^:]+:([^@]+)@ ]]; then
            database_password="${BASH_REMATCH[1]}"
            if (( ${#database_password} >= 8 )); then
              SECRETS+=("$database_password")
            fi
          fi
          ;;
      esac
    fi
  done < "$ENV_FILE"
}

redact_line() {
  local safe_line="$1"
  local secret prefix suffix
  for secret in "${SECRETS[@]}"; do
    [[ -n "$secret" ]] || continue
    [[ "$secret" == "[REDACTED]" ]] && continue
    while [[ "$safe_line" == *"$secret"* ]]; do
      prefix="${safe_line%%"$secret"*}"
      suffix="${safe_line#*"$secret"}"
      safe_line="${prefix}[REDACTED]${suffix}"
    done
  done
  safe_line="$(printf '%s' "$safe_line" | sed -E 's#(postgres(ql)?://[^:/[:space:]]+:)[^@/[:space:]]+@#\1[REDACTED]@#g')"
  printf '%s' "$safe_line"
}

write_runner_log() {
  local safe_message
  safe_message="$(redact_line "$1")"
  printf '[%s] %s\n' "$(timestamp)" "$safe_message" >> "$RUNNER_LOG"
}

write_error() {
  write_runner_log "$1"
  printf '%s\n' "$1" >&2
}

rotate_log() {
  local path="$1"
  local name extension base size archive
  name="$(basename -- "$path")"
  extension="${name##*.}"
  base="${name%.*}"
  if [[ -f "$path" ]]; then
    size="$(wc -c < "$path" 2>/dev/null || printf '0')"
    if [[ "$size" =~ ^[0-9]+$ ]] && (( size >= MAX_LOG_SIZE_BYTES )); then
      archive="$LOG_DIR/${base}-$(date '+%Y%m%d-%H%M%S').${extension}"
      mv -- "$path" "$archive"
    fi
  fi
  find "$LOG_DIR" -maxdepth 1 -type f -name "${base}-*.${extension}" -mtime "+$LOG_RETENTION_DAYS" -delete 2>/dev/null || true
}

rotate_logs() {
  rotate_log "$RUNNER_LOG"
  rotate_log "$BOT_OUTPUT_LOG"
  rotate_log "$TOKEN_CHECK_LOG"
  rotate_log "$BOOT_LOG"
}

read_pid_file() {
  local path="$1"
  local value=""
  [[ -f "$path" ]] && IFS= read -r value < "$path"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] && printf '%s' "$value"
}

process_command() {
  local pid="$1"
  if [[ -r "/proc/$pid/cmdline" ]]; then
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true
  else
    ps -p "$pid" -o args= 2>/dev/null || true
  fi
}

pid_is_alive() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null
}

is_runner_process() {
  local pid="$1" command_line
  pid_is_alive "$pid" || return 1
  command_line="$(process_command "$pid")"
  [[ "$command_line" == *"run-bot-forever.sh"* ]]
}

is_bot_process() {
  local pid="$1" command_line
  pid_is_alive "$pid" || return 1
  command_line="$(process_command "$pid")"
  [[ "$command_line" == *"discord-bot.mjs"* ]]
}

clear_stale_lock() {
  rm -f -- "$LOCK_PID_FILE" 2>/dev/null || true
  rmdir -- "$LOCK_DIR" 2>/dev/null || return 1
}

acquire_lock() {
  local existing_pid=""
  if mkdir -- "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_PID_FILE"
    printf '%s\n' "$$" > "$RUNNER_PID_FILE"
    LOCK_ACQUIRED=1
    return 0
  fi

  existing_pid="$(read_pid_file "$LOCK_PID_FILE")"
  if [[ -n "$existing_pid" ]] && is_runner_process "$existing_pid"; then
    write_error "Another NuviloView Bot runner is already active (PID $existing_pid)."
    return 1
  fi

  if ! clear_stale_lock; then
    write_error "The runner lock exists but could not be verified or removed: $LOCK_DIR"
    return 1
  fi
  if ! mkdir -- "$LOCK_DIR" 2>/dev/null; then
    write_error "Another runner acquired the lock while stale-lock recovery was in progress."
    return 1
  fi
  printf '%s\n' "$$" > "$LOCK_PID_FILE"
  printf '%s\n' "$$" > "$RUNNER_PID_FILE"
  LOCK_ACQUIRED=1
  write_runner_log "Recovered a stale runner lock."
}

# shellcheck disable=SC2329 # Invoked from the EXIT-trap cleanup path.
release_lock() {
  if (( LOCK_ACQUIRED == 1 )); then
    rm -f -- "$LOCK_PID_FILE" "$RUNNER_PID_FILE" 2>/dev/null || true
    rmdir -- "$LOCK_DIR" 2>/dev/null || true
    LOCK_ACQUIRED=0
  fi
}

show_status() {
  local runner_pid bot_pid started latest state
  runner_pid="$(read_pid_file "$RUNNER_PID_FILE")"
  bot_pid="$(read_pid_file "$BOT_PID_FILE")"
  started="unknown"
  state="UNKNOWN"
  [[ -f "$STARTED_AT_FILE" ]] && IFS= read -r started < "$STARTED_AT_FILE"
  [[ -f "$STATE_FILE" ]] && IFS=' ' read -r state _ < "$STATE_FILE"
  if [[ -n "$runner_pid" ]] && is_runner_process "$runner_pid"; then
    printf 'Runner: running (PID %s, state %s)\n' "$runner_pid" "$state"
  else
    printf 'Runner: stopped (state %s)\n' "$state"
  fi
  if [[ -n "$bot_pid" ]] && is_bot_process "$bot_pid"; then
    printf 'Bot: running (PID %s)\n' "$bot_pid"
  else
    printf 'Bot: stopped\n'
  fi
  printf 'Started: %s\n' "$started"
  if [[ -f "$RUNNER_LOG" ]]; then
    latest="$(tail -n 1 "$RUNNER_LOG" 2>/dev/null || true)"
    printf 'Latest log: %s\n' "$(redact_line "$latest")"
  else
    printf 'Latest log: none\n'
  fi
  [[ -n "$runner_pid" ]] && is_runner_process "$runner_pid"
}

stop_runner() {
  local runner_pid bot_pid
  runner_pid="$(read_pid_file "$RUNNER_PID_FILE")"
  if [[ -z "$runner_pid" ]] || ! is_runner_process "$runner_pid"; then
    bot_pid="$(read_pid_file "$BOT_PID_FILE")"
    if [[ -n "$bot_pid" ]] && is_bot_process "$bot_pid"; then
      printf 'Runner is not active, but a verified Bot process remains. Sending SIGTERM to Bot PID %s.\n' "$bot_pid"
      kill -TERM "$bot_pid" 2>/dev/null || true
    else
      printf 'NuviloView Bot runner is not running.\n'
    fi
    rm -f -- "$RUNNER_PID_FILE" "$BOT_PID_FILE" "$STARTED_AT_FILE" 2>/dev/null || true
    clear_stale_lock 2>/dev/null || true
    return 0
  fi

  printf 'Stopping NuviloView Bot runner PID %s...\n' "$runner_pid"
  kill -TERM "$runner_pid" 2>/dev/null || true
  for _ in {1..30}; do
    is_runner_process "$runner_pid" || break
    sleep 1
  done
  if is_runner_process "$runner_pid"; then
    printf 'Runner did not stop within 30 seconds. Check %s before retrying.\n' "$RUNNER_LOG" >&2
    return 1
  fi
  printf 'NuviloView Bot runner stopped.\n'
}

validate_private_storage() {
  case "$PROJECT_ROOT" in
    /sdcard/*|/storage/emulated/*|/mnt/media_rw/*)
      write_error "The project is in Android shared storage. Move it under the Termux private home before using secrets."
      return 1
      ;;
  esac
}

validate_configuration() {
  local failed=0 name value node_major permission_mode

  if [[ -z "${TERMUX_VERSION:-}" && "${PREFIX:-}" != *"com.termux"* && "${NUVILOVIEW_ALLOW_NON_TERMUX_TEST:-}" != "1" ]]; then
    write_error "This runner is intended for Android Termux."
    failed=1
  fi
  validate_private_storage || failed=1

  NODE_PATH="$(command -v node 2>/dev/null || true)"
  if [[ -z "$NODE_PATH" ]]; then
    write_error "Missing required command: node"
    failed=1
  else
    node_major="$($NODE_PATH -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
    if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major != 24 )); then
      write_error "Node.js 24.x is required by this project's engines setting."
      failed=1
    fi
    if ! "$NODE_PATH" --help 2>/dev/null | grep -q -- '--env-file'; then
      write_error "This Node.js build does not support --env-file."
      failed=1
    fi
  fi

  for name in git pnpm sed find ps; do
    if ! command -v "$name" >/dev/null 2>&1; then
      write_error "Missing required command: $name"
      failed=1
    fi
  done

  for name in "$ENV_FILE" "$BOT_FILE" "$TOKEN_CHECK_FILE" "$PROJECT_ROOT/package.json" "$PROJECT_ROOT/pnpm-lock.yaml"; do
    if [[ ! -f "$name" ]]; then
      write_error "Missing required file: $name"
      failed=1
    fi
  done

  if [[ -f "$ENV_FILE" ]]; then
    # Neon-backed domains now enter explicit DEGRADED mode when DATABASE_URL is
    # missing or unreachable. Discord identity remains mandatory; the runner
    # must not silently invent credentials or enable Local-First flags.
    for name in NUVILOVIEW_CLIENT_ID NUVILOVIEW_BOT_TOKEN; do
      value="$(get_env_value "$name")"
      if [[ -z "$value" ]]; then
        write_error "Missing Bot runtime environment variable: $name"
        failed=1
      fi
    done
    if [[ -z "$(get_env_value DATABASE_URL)" ]]; then
      write_runner_log "DATABASE_URL is not configured; Bot will start in explicit DEGRADED local-only mode."
      printf 'Warning: DATABASE_URL is not configured; Cloud-only features will be unavailable.\n' >&2
    fi
    permission_mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || true)"
    if [[ -n "$permission_mode" && "$permission_mode" != "600" ]]; then
      write_runner_log ".env.local permissions are $permission_mode; chmod 600 is recommended."
      printf 'Warning: .env.local permissions are %s; run chmod 600 .env.local.\n' "$permission_mode" >&2
    fi
  fi

  if [[ ! -f "$PROJECT_ROOT/node_modules/discord.js/package.json" || ! -f "$PROJECT_ROOT/node_modules/@neondatabase/serverless/package.json" ]]; then
    write_error "Bot dependencies are missing. Run pnpm install --frozen-lockfile."
    failed=1
  fi

  if ! touch "$RUNTIME_DIR/.write-test" "$LOG_DIR/.write-test" 2>/dev/null; then
    write_error "Android runtime or log directory is not writable."
    failed=1
  else
    rm -f -- "$RUNTIME_DIR/.write-test" "$LOG_DIR/.write-test"
  fi

  (( failed == 0 ))
}

run_token_leak_check() {
  local temporary_log="$RUNTIME_DIR/token-check.$$" status line
  : > "$temporary_log"
  (
    cd -- "$PROJECT_ROOT" || exit 1
    "$NODE_PATH" "$TOKEN_CHECK_FILE"
  ) > "$temporary_log" 2>&1
  status=$?
  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '[%s] %s\n' "$(timestamp)" "$(redact_line "$line")" >> "$TOKEN_CHECK_LOG"
  done < "$temporary_log"
  rm -f -- "$temporary_log"
  if (( status != 0 )); then
    write_error "Token leak check failed with exit code $status. Bot start was blocked."
    return "$status"
  fi
  return 0
}

record_bot_line() {
  local raw_line="$1" safe_line reset_candidate
  safe_line="$(redact_line "$raw_line")"
  printf '[%s] %s\n' "$(timestamp)" "$safe_line" >> "$BOT_OUTPUT_LOG"

  if [[ "$raw_line" == *"Not enough sessions remaining"* || "$raw_line" == *"Session Start Limit"* || "$raw_line" == *"session start limit"* ]]; then
    SESSION_LIMIT_SEEN=1
  fi
  if [[ "$raw_line" =~ resets[[:space:]]+at[[:space:]]+([^[:space:]]+) ]]; then
    reset_candidate="${BASH_REMATCH[1]%,}"
    SESSION_LIMIT_RESET_AT="$reset_candidate"
  fi
  if (( BOT_LOGIN_REPORTED == 0 )) && [[ "$raw_line" == *"bot logged in as"* ]]; then
    BOT_LOGIN_REPORTED=1
    write_runner_log "Bot reported a successful Discord login."
  fi
  if [[ "$raw_line" =~ ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ECONNRESET|ECONNREFUSED|getaddrinfo|[Nn]etwork[[:space:]]+unreachable|fetch[[:space:]]+failed ]]; then
    NETWORK_FAILURE_SEEN=1
  fi
}

# shellcheck disable=SC2329 # Invoked from the EXIT-trap cleanup path.
terminate_current_bot() {
  if [[ -n "$CURRENT_BOT_PID" ]] && is_bot_process "$CURRENT_BOT_PID"; then
    write_runner_log "Sending SIGTERM to Bot PID $CURRENT_BOT_PID."
    kill -TERM "$CURRENT_BOT_PID" 2>/dev/null || true
    for _ in {1..20}; do
      is_bot_process "$CURRENT_BOT_PID" || break
      sleep 1
    done
    if is_bot_process "$CURRENT_BOT_PID"; then
      write_runner_log "Bot PID $CURRENT_BOT_PID did not stop after 20 seconds; sending SIGKILL to prevent an orphan process."
      kill -KILL "$CURRENT_BOT_PID" 2>/dev/null || true
    fi
  fi
}

# shellcheck disable=SC2329 # Invoked by the SIGINT/SIGTERM traps.
request_shutdown() {
  local signal_name="$1"
  if (( SHUTDOWN_REQUESTED == 0 )); then
    SHUTDOWN_REQUESTED=1
    write_runner_log "Runner received $signal_name and is shutting down."
  fi
  if [[ -n "$CURRENT_SLEEP_PID" ]] && pid_is_alive "$CURRENT_SLEEP_PID"; then
    kill -TERM "$CURRENT_SLEEP_PID" 2>/dev/null || true
  fi
  if [[ -n "$CURRENT_BOT_PID" ]] && is_bot_process "$CURRENT_BOT_PID"; then
    kill -TERM "$CURRENT_BOT_PID" 2>/dev/null || true
  fi
}

# shellcheck disable=SC2329 # Invoked by the EXIT trap.
cleanup() {
  local exit_code=$?
  terminate_current_bot
  rm -f -- "$BOT_PID_FILE" "$STARTED_AT_FILE" 2>/dev/null || true
  release_lock
  exit "$exit_code"
}

sleep_interruptibly() {
  local delay="$1"
  sleep "$delay" &
  CURRENT_SLEEP_PID=$!
  wait "$CURRENT_SLEEP_PID" 2>/dev/null || true
  CURRENT_SLEEP_PID=""
}

session_limit_delay() {
  local now_epoch reset_epoch delay
  delay=$SESSION_LIMIT_FALLBACK_SECONDS
  if [[ -n "$SESSION_LIMIT_RESET_AT" ]]; then
    now_epoch="$(date +%s)"
    reset_epoch="$(date -d "$SESSION_LIMIT_RESET_AT" +%s 2>/dev/null || printf '0')"
    if [[ "$reset_epoch" =~ ^[0-9]+$ ]] && (( reset_epoch > now_epoch )); then
      delay=$((reset_epoch - now_epoch + 60))
      (( delay > MAXIMUM_SESSION_LIMIT_WAIT_SECONDS )) && delay=$MAXIMUM_SESSION_LIMIT_WAIT_SECONDS
    fi
  fi
  printf '%s' "$delay"
}

restart_delay() {
  local failure_count="$1" index
  index=$((failure_count - 1))
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

run_bot_once() {
  local bot_output_fd exit_code
  SESSION_LIMIT_SEEN=0
  SESSION_LIMIT_RESET_AT=""
  BOT_LOGIN_REPORTED=0
  NETWORK_FAILURE_SEEN=0
  write_runner_log "Starting NuviloView Bot with NUVILOVIEW_BOT_TOKEN."

  coproc NUVILO_BOT_PROCESS {
    cd -- "$PROJECT_ROOT" || exit 1
    exec "$NODE_PATH" "--env-file=$ENV_FILE" "$BOT_FILE" 2>&1
  }
  CURRENT_BOT_PID="$NUVILO_BOT_PROCESS_PID"
  bot_output_fd="${NUVILO_BOT_PROCESS[0]}"
  printf '%s\n' "$CURRENT_BOT_PID" > "$BOT_PID_FILE"
  write_state "RUNNING"
  write_runner_log "Bot process started with PID $CURRENT_BOT_PID."

  while IFS= read -r -u "$bot_output_fd" raw_line || [[ -n "${raw_line:-}" ]]; do
    record_bot_line "${raw_line:-}"
  done
  wait "$CURRENT_BOT_PID" 2>/dev/null
  exit_code=$?
  rm -f -- "$BOT_PID_FILE"
  CURRENT_BOT_PID=""
  return "$exit_code"
}

mkdir -p -- "$RUNTIME_DIR" "$LOG_DIR"
chmod 700 -- "$RUNTIME_DIR" "$LOG_DIR" 2>/dev/null || true
load_redaction_secrets
rotate_logs

if [[ "$MODE" == "status" ]]; then
  show_status
  exit $?
fi
if [[ "$MODE" == "stop" ]]; then
  stop_runner
  exit $?
fi

trap 'request_shutdown SIGINT' INT
trap 'request_shutdown SIGTERM' TERM
trap cleanup EXIT

if ! acquire_lock; then
  exit 1
fi

if ! validate_configuration; then
  write_state "INVALID"
  write_error "Runner validation failed. Bot was not started."
  exit 1
fi
load_redaction_secrets

run_token_leak_check
initial_token_check_status=$?
if (( initial_token_check_status != 0 )); then
  exit "$initial_token_check_status"
fi

if [[ "$MODE" == "validate" ]]; then
  write_state "READY"
  write_runner_log "Runner validation passed with required environment variables configured."
  printf 'Validation passed. The Bot was not started.\n'
  exit 0
fi

printf '%s\n' "$(timestamp)" > "$STARTED_AT_FILE"
write_state "STARTING"
write_runner_log "Android Bot runner started in $MODE mode. Runner PID $$; logs retained for $LOG_RETENTION_DAYS days."

consecutive_quick_failures=0
restart_count=0
while (( SHUTDOWN_REQUESTED == 0 )); do
  rotate_logs
  if ! validate_configuration; then
    if [[ "$MODE" == "once" ]]; then
      exit 1
    fi
    write_state "DEGRADED"
    write_runner_log "Configuration became invalid. Retrying validation in 60 seconds; the independent Sync Worker is unaffected."
    sleep_interruptibly 60
    continue
  fi
  load_redaction_secrets
  if ! run_token_leak_check; then
    if [[ "$MODE" == "once" ]]; then
      exit 1
    fi
    write_runner_log "Token leak validation failed. Retrying in 60 seconds without starting the Bot."
    sleep_interruptibly 60
    continue
  fi

  run_started_epoch="$(date +%s)"
  run_bot_once
  bot_exit_code=$?
  run_seconds=$(($(date +%s) - run_started_epoch))
  restart_count=$((restart_count + 1))
  write_runner_log "Bot stopped with exit code $bot_exit_code after $run_seconds seconds. Restart count: $restart_count."

  if (( SHUTDOWN_REQUESTED == 1 )); then
    break
  fi
  if [[ "$MODE" == "once" ]]; then
    write_runner_log "Once mode completed; automatic restart is disabled."
    exit "$bot_exit_code"
  fi

  if (( SESSION_LIMIT_SEEN == 1 )); then
    delay_seconds="$(session_limit_delay)"
    write_runner_log "Discord Session Start Limit detected. Waiting $delay_seconds seconds before the next connection attempt."
    sleep_interruptibly "$delay_seconds"
    continue
  fi

  if (( bot_exit_code == LEASE_CONTENDED_EXIT_CODE )); then
    write_runner_log "Another host owns the distributed Bot lease. Waiting $LEASE_CONTENTION_DELAY_SECONDS seconds without contacting Discord."
    sleep_interruptibly "$LEASE_CONTENTION_DELAY_SECONDS"
    continue
  fi

  if (( bot_exit_code == LEASE_CONFIGURATION_EXIT_CODE )); then
    write_runner_log "Distributed singleton configuration is invalid. Automatic restart is stopped until configuration is corrected."
    exit "$bot_exit_code"
  fi

  if (( bot_exit_code == LEASE_LOST_EXIT_CODE || bot_exit_code == LEASE_DATABASE_EXIT_CODE )); then
    write_state "DEGRADED"
    write_runner_log "Distributed lease safety stopped the Bot with exit code $bot_exit_code. Waiting $LEASE_RECOVERY_DELAY_SECONDS seconds before retrying."
    sleep_interruptibly "$LEASE_RECOVERY_DELAY_SECONDS"
    continue
  fi

  if (( NETWORK_FAILURE_SEEN == 1 )); then
    delay_seconds="$(bounded_integer BOT_RUNNER_NETWORK_RETRY_SECONDS 60 10 3600)"
    write_state "DEGRADED"
    write_runner_log "Network failure detected; waiting $delay_seconds seconds before retrying without counting a crash storm."
    sleep_interruptibly "$delay_seconds"
    continue
  fi

  stable_seconds="$(bounded_integer BOT_RUNNER_STABLE_SECONDS "$STABLE_RUN_SECONDS" 1 86400)"
  crash_limit="$(bounded_integer BOT_RUNNER_CRASH_LIMIT 5 2 100)"
  crash_window="$(bounded_integer BOT_RUNNER_CRASH_WINDOW_SECONDS 300 10 86400)"
  cooldown_seconds="$(bounded_integer BOT_RUNNER_CRASH_COOLDOWN_SECONDS 900 10 86400)"
  if (( run_seconds >= stable_seconds )); then
    consecutive_quick_failures=0
    : > "$CRASH_HISTORY_FILE"
    delay_seconds=5
    write_runner_log "The previous run was stable; restart backoff was reset."
  else
    consecutive_quick_failures=$((consecutive_quick_failures + 1))
    crash_count="$(record_crash_and_count "$(date +%s)" "$crash_window")"
    if (( crash_count >= crash_limit )); then
      write_state "COOLDOWN"
      write_runner_log "Bot crash storm detected ($crash_count crashes in ${crash_window}s); cooling down for ${cooldown_seconds}s."
      sleep_interruptibly "$cooldown_seconds"
      : > "$CRASH_HISTORY_FILE"
      consecutive_quick_failures=0
      continue
    fi
    delay_seconds="$(restart_delay "$consecutive_quick_failures")"
  fi
  write_state "DEGRADED"
  write_runner_log "Restarting in $delay_seconds seconds after quick failure count $consecutive_quick_failures."
  sleep_interruptibly "$delay_seconds"
done

write_state "STOPPED"
write_runner_log "Android Bot runner stopped cleanly."
exit 0
