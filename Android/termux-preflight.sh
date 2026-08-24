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
STATUS_FILE="$RUNTIME_DIR/preflight.status"
STORAGE_HEALTH_FILE="$RUNTIME_DIR/storage-health.json"
NEON_RUNTIME_STATUS_PATH="$(nv_get_env_value "$ENV_FILE" NUVILOVIEW_RUNTIME_STATUS_PATH)"
[[ -n "$NEON_RUNTIME_STATUS_PATH" ]] || NEON_RUNTIME_STATUS_PATH="data/runtime/neon-runtime-health.json"
[[ "$NEON_RUNTIME_STATUS_PATH" == /* ]] || NEON_RUNTIME_STATUS_PATH="$PROJECT_ROOT/${NEON_RUNTIME_STATUS_PATH#./}"
BOOT_WRAPPER="${TERMUX_BOOT_DIR:-$HOME/.termux/boot}/nuviloview.sh"

WARNINGS=()
FAILURES=()
DETAILS=()
NODE_PATH=""

add_warn() { WARNINGS+=("$1"); }
add_fail() { FAILURES+=("$1"); }
add_detail() { DETAILS+=("$1"); }

mkdir -p -- "$RUNTIME_DIR" "$LOG_DIR" 2>/dev/null || {
  printf 'FAIL: Android runtime/log directory cannot be created.\n' >&2
  exit 1
}
chmod 700 -- "$RUNTIME_DIR" "$LOG_DIR" 2>/dev/null || true

if ! nv_is_termux; then
  add_fail "not_running_inside_termux"
fi
if ! nv_project_is_private "$PROJECT_ROOT"; then
  add_fail "project_is_in_android_shared_storage"
fi
if [[ ! -d "$PROJECT_ROOT" ]]; then
  add_fail "project_directory_missing"
fi

for required in \
  "$PROJECT_ROOT/discord-bot.mjs" \
  "$PROJECT_ROOT/scripts/run-sync-worker.mjs" \
  "$PROJECT_ROOT/package.json" \
  "$PROJECT_ROOT/pnpm-lock.yaml" \
  "$SCRIPT_DIR/run-bot-forever.sh" \
  "$SCRIPT_DIR/run-sync-worker-forever.sh" \
  "$SCRIPT_DIR/boot-start.sh" \
  "$SCRIPT_DIR/storage-health.mjs"; do
  [[ -f "$required" ]] || add_fail "required_file_missing:$(basename -- "$required")"
done

NODE_PATH="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_PATH" ]]; then
  add_fail "node_missing"
else
  node_version="$($NODE_PATH -p 'process.versions.node' 2>/dev/null || printf 'unknown')"
  node_major="${node_version%%.*}"
  [[ "$node_major" == "24" ]] || add_fail "node_24_required"
  add_detail "node=$node_version"
  if ! "$NODE_PATH" --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE probe (value TEXT NOT NULL) STRICT");
    db.prepare("INSERT INTO probe (value) VALUES (?)").run("ok");
    const row = db.prepare("SELECT value FROM probe").get();
    db.close();
    if (row?.value !== "ok") process.exit(1);
  ' >/dev/null 2>&1; then
    add_fail "node_sqlite_unavailable"
  else
    add_detail "node_sqlite_probe=open_write_read_close_pass"
  fi
fi

pnpm_path="$(command -v pnpm 2>/dev/null || true)"
if [[ -z "$pnpm_path" ]]; then
  add_fail "pnpm_missing"
else
  pnpm_version="$(pnpm --version 2>/dev/null || printf 'unknown')"
  expected_pnpm="$(sed -nE 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@([^"]+)".*/\1/p' "$PROJECT_ROOT/package.json" | head -n 1)"
  [[ -n "$expected_pnpm" ]] || expected_pnpm="unknown"
  add_detail "pnpm=$pnpm_version expected=$expected_pnpm"
  [[ "$pnpm_version" == "$expected_pnpm" ]] || add_warn "pnpm_version_differs_from_package_manager"
fi

for command_name in ps stat nohup sed find df awk; do
  command -v "$command_name" >/dev/null 2>&1 || add_fail "command_missing:$command_name"
done

if [[ ! -f "$ENV_FILE" ]]; then
  add_warn "environment_file_missing"
else
  permission_mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || true)"
  [[ -z "$permission_mode" || "$permission_mode" == "600" ]] || add_warn "environment_permissions_should_be_600"
fi

bot_token="$(nv_get_env_value "$ENV_FILE" NUVILOVIEW_BOT_TOKEN)"
bot_client_id="$(nv_get_env_value "$ENV_FILE" NUVILOVIEW_CLIENT_ID)"
database_url="$(nv_get_env_value "$ENV_FILE" DATABASE_URL)"
[[ -n "$bot_token" ]] || add_warn "bot_token_missing_bot_will_not_start"
[[ -n "$bot_client_id" ]] || add_warn "bot_client_id_missing_bot_will_not_start"
if [[ -n "$database_url" ]]; then
  add_detail "neon=configured_runtime_probe_deferred"
else
  add_warn "neon=not_configured_bot_will_start_degraded"
fi

if [[ -f "$NEON_RUNTIME_STATUS_PATH" && -n "$NODE_PATH" ]]; then
  neon_runtime_state="$($NODE_PATH -e 'const fs=require("fs");try{const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(v.neon||"UNKNOWN"))}catch{process.stdout.write("INVALID")}' "$NEON_RUNTIME_STATUS_PATH")"
  add_detail "last_runtime_neon=$neon_runtime_state"
fi

local_enabled="$(nv_get_env_value "$ENV_FILE" LOCAL_STORAGE_ENABLED)"
local_write_enabled="$(nv_get_env_value "$ENV_FILE" LOCAL_STORAGE_WRITE_ENABLED)"
message_local_enabled="$(nv_get_env_value "$ENV_FILE" LOCAL_MESSAGE_STORAGE_ENABLED)"
worker_enabled="$(nv_get_env_value "$ENV_FILE" SYNC_WORKER_ENABLED)"
replica_enabled="$(nv_get_env_value "$ENV_FILE" SYNC_NEON_REPLICA_ENABLED)"
multi_db_enabled="$(nv_get_env_value "$ENV_FILE" MULTI_DB_SYNC_ENABLED)"

if nv_env_enabled "$message_local_enabled" &&
  { ! nv_env_enabled "$local_enabled" || ! nv_env_enabled "$local_write_enabled"; }; then
  add_fail "message_local_first_requires_writable_local_storage"
fi
if nv_env_enabled "$worker_enabled"; then
  # Worker-only configuration errors must not prevent an otherwise safe Bot
  # runner from starting. The Worker runner repeats these checks and stays off.
  nv_env_enabled "$local_enabled" || add_warn "sync_worker_requires_local_storage_worker_will_not_start"
  nv_env_enabled "$local_write_enabled" || add_warn "sync_worker_requires_writable_local_storage_worker_will_not_start"
  if nv_env_enabled "$multi_db_enabled"; then
    if nv_env_enabled "$(nv_get_env_value "$ENV_FILE" SYNC_SUPABASE_ENABLED)"; then
      [[ -n "$(nv_get_env_value "$ENV_FILE" SUPABASE_DATABASE_URL)" ]] || add_warn "supabase_credentials_missing_provider_degraded"
    else
      add_warn "required_supabase_replica_disabled"
    fi
    if nv_env_enabled "$(nv_get_env_value "$ENV_FILE" SYNC_TURSO_ENABLED)"; then
      [[ -n "$(nv_get_env_value "$ENV_FILE" TURSO_DATABASE_URL)" && -n "$(nv_get_env_value "$ENV_FILE" TURSO_AUTH_TOKEN)" ]] || add_warn "turso_credentials_missing_provider_degraded"
    else
      add_warn "required_turso_replica_disabled"
    fi
  else
    nv_env_enabled "$replica_enabled" || add_warn "sync_worker_requires_replica_flag_worker_will_not_start"
    [[ -n "$database_url" ]] || add_warn "sync_worker_requires_database_url_worker_will_not_start"
  fi
else
  add_detail "sync_worker=disabled"
fi

if [[ -n "$NODE_PATH" && -f "$ENV_FILE" && -f "$SCRIPT_DIR/storage-health.mjs" ]]; then
  if "$NODE_PATH" "--env-file=$ENV_FILE" "$SCRIPT_DIR/storage-health.mjs" "$PROJECT_ROOT" > "$STORAGE_HEALTH_FILE.tmp" 2>/dev/null; then
    mv -- "$STORAGE_HEALTH_FILE.tmp" "$STORAGE_HEALTH_FILE"
  else
    mv -- "$STORAGE_HEALTH_FILE.tmp" "$STORAGE_HEALTH_FILE" 2>/dev/null || true
    add_fail "sqlite_health_check_failed"
  fi
  if [[ -f "$STORAGE_HEALTH_FILE" ]]; then
    storage_status="$($NODE_PATH -e 'const fs=require("fs");const p=process.argv[1];try{const v=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(String(v.status||"UNKNOWN"))}catch{process.stdout.write("INVALID")}' "$STORAGE_HEALTH_FILE")"
    add_detail "sqlite=$storage_status"
    [[ "$storage_status" != "UNHEALTHY" && "$storage_status" != "INVALID" ]] || add_fail "sqlite_unhealthy"
  fi
fi

disk_warn="$(nv_positive_integer "$ENV_FILE" ANDROID_DISK_WARN_BYTES 2147483648 1 9223372036854775807)"
disk_critical="$(nv_positive_integer "$ENV_FILE" ANDROID_DISK_CRITICAL_BYTES 536870912 1 9223372036854775807)"
disk_free="$(nv_disk_free_bytes "$PROJECT_ROOT" 2>/dev/null || true)"
if [[ -z "$disk_free" ]]; then
  add_warn "disk_free_unknown"
else
  add_detail "disk_free_bytes=$disk_free"
  if (( disk_free <= disk_critical )); then
    add_fail "disk_free_critical"
  elif (( disk_free <= disk_warn )); then
    add_warn "disk_free_low"
  fi
fi

if nv_network_route_available; then
  add_detail "network_route=available"
else
  network_status=$?
  if (( network_status == 1 )); then
    add_warn "network_route_unavailable"
  else
    add_detail "network_route=unknown"
  fi
fi

if command -v termux-wake-lock >/dev/null 2>&1; then
  add_detail "wake_lock_command=available"
else
  add_warn "wake_lock_command_unavailable"
fi
if [[ -x "$BOOT_WRAPPER" ]]; then
  add_detail "termux_boot=installed"
else
  add_warn "termux_boot_wrapper_not_installed"
fi

overall="PASS"
(( ${#WARNINGS[@]} > 0 )) && overall="WARN"
(( ${#FAILURES[@]} > 0 )) && overall="FAIL"

{
  printf 'OVERALL=%s\n' "$overall"
  printf 'WARN_COUNT=%s\n' "${#WARNINGS[@]}"
  printf 'FAIL_COUNT=%s\n' "${#FAILURES[@]}"
  printf 'CHECKED_AT=%s\n' "$(nv_timestamp)"
} > "$STATUS_FILE"

printf 'NuviloView Termux Preflight: %s\n' "$overall"
for detail in "${DETAILS[@]}"; do printf '  INFO %s\n' "$detail"; done
for warning in "${WARNINGS[@]}"; do printf '  WARN %s\n' "$warning"; done
for failure in "${FAILURES[@]}"; do printf '  FAIL %s\n' "$failure"; done

[[ "$overall" != "FAIL" ]]
