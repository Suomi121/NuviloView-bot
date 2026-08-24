#!/usr/bin/env bash
# shellcheck disable=SC2016 # JavaScript snippets use their own template strings.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=Android/runtime-common.sh
source "$SCRIPT_DIR/runtime-common.sh"
DEFAULT_PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PROJECT_ROOT="${NUVILOVIEW_PROJECT_ROOT:-$DEFAULT_PROJECT_ROOT}"
ENV_FILE="${NUVILOVIEW_ENV_FILE:-$PROJECT_ROOT/.env.local}"
RUNTIME_DIR="${NUVILOVIEW_ANDROID_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
BOOT_WRAPPER="${TERMUX_BOOT_DIR:-$HOME/.termux/boot}/nuviloview.sh"
BOT_RUNNER_PID_FILE="$RUNTIME_DIR/runner.pid"
BOT_PID_FILE="$RUNTIME_DIR/bot.pid"
BOT_STATE_FILE="$RUNTIME_DIR/bot-runner.state"
WORKER_RUNNER_PID_FILE="$RUNTIME_DIR/sync-worker-runner.pid"
WORKER_PID_FILE="$RUNTIME_DIR/sync-worker.pid"
WORKER_STATE_FILE="$RUNTIME_DIR/sync-worker-runner.state"
STORAGE_HEALTH_FILE="$RUNTIME_DIR/storage-health.json"
WAKE_LOCK_MARKER="$RUNTIME_DIR/wake-lock.acquired"
NEON_RUNTIME_STATUS_PATH="$(nv_get_env_value "$ENV_FILE" NUVILOVIEW_RUNTIME_STATUS_PATH)"
[[ -n "$NEON_RUNTIME_STATUS_PATH" ]] || NEON_RUNTIME_STATUS_PATH="data/runtime/neon-runtime-health.json"
[[ "$NEON_RUNTIME_STATUS_PATH" == /* ]] || NEON_RUNTIME_STATUS_PATH="$PROJECT_ROOT/${NEON_RUNTIME_STATUS_PATH#./}"

process_status() {
  local label="$1" pid_file="$2" marker="$3" state_file="${4:-}" pid state=""
  pid="$(nv_read_pid "$pid_file")"
  [[ -n "$state_file" ]] && state="$(nv_read_state "$state_file")"
  if [[ -n "$pid" ]] && nv_pid_matches "$pid" "$marker"; then
    [[ -n "$state" && "$state" != "UNKNOWN" ]] && state=", state $state"
    printf '%s: RUNNING (PID %s%s)\n' "$label" "$pid" "$state"
  else
    [[ -n "$state" && "$state" != "UNKNOWN" ]] && state=" ($state)"
    printf '%s: STOPPED%s\n' "$label" "$state"
  fi
}

printf 'NuviloView Termux Runtime\n'
process_status "Bot Runner" "$BOT_RUNNER_PID_FILE" "run-bot-forever.sh" "$BOT_STATE_FILE"
process_status "Bot" "$BOT_PID_FILE" "discord-bot.mjs"

if [[ -f "$NEON_RUNTIME_STATUS_PATH" ]] && command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const neon = value.neon ?? "UNKNOWN";
      const configured = value.messageStorageConfiguredMode ?? "UNKNOWN";
      const messageStorage = value.messageStorage ??
        (configured === "LEGACY_NEON" && neon !== "AVAILABLE" ? "UNAVAILABLE" : configured);
      console.log(`Runtime Mode: ${value.runtimeMode ?? "UNKNOWN"}`);
      console.log(`Neon: ${neon}`);
      console.log(`Message Storage: ${messageStorage}`);
      console.log(`Cross-Host Leadership: ${value.crossHostLeadership ?? "UNKNOWN"}`);
      const degraded = Array.isArray(value.degradedFeatures) ? value.degradedFeatures : [];
      console.log(`Degraded Features: ${degraded.length ? degraded.join(", ") : "None"}`);
    } catch { console.log("Runtime Mode: UNKNOWN (invalid runtime status)"); }
  ' "$NEON_RUNTIME_STATUS_PATH"
else
  printf 'Runtime Mode: UNKNOWN\nNeon: UNKNOWN\nMessage Storage: UNKNOWN\nCross-Host Leadership: UNKNOWN\n'
fi

if nv_env_enabled "$(nv_get_env_value "$ENV_FILE" SYNC_WORKER_ENABLED)"; then
  process_status "Sync Worker Runner" "$WORKER_RUNNER_PID_FILE" "run-sync-worker-forever.sh" "$WORKER_STATE_FILE"
  process_status "Sync Worker" "$WORKER_PID_FILE" "scripts/run-sync-worker.mjs"
else
  printf 'Sync Worker Runner: DISABLED\nSync Worker: DISABLED\n'
fi

metrics_path="$(nv_get_env_value "$ENV_FILE" SYNC_METRICS_PATH)"
[[ -n "$metrics_path" ]] || metrics_path="./data/runtime/sync-worker-health.json"
[[ "$metrics_path" == /* ]] || metrics_path="$PROJECT_ROOT/${metrics_path#./}"
if [[ -f "$metrics_path" ]] && command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      console.log(`Sync Health: ${value.workerStatus ?? "UNKNOWN"}`);
      console.log(`Circuit: ${value.circuitState ?? value.circuit?.state ?? "UNKNOWN"}`);
      console.log(`Pending: ${Number(value.pendingCount ?? 0)}`);
      console.log(`Dead Letter: ${Number(value.deadLetterCount ?? 0)}`);
      console.log(`Last Successful Sync: ${value.lastSyncSuccess ?? "Never"}`);
    } catch { console.log("Sync Health: UNKNOWN (invalid metrics)"); }
  ' "$metrics_path"
else
  printf 'Sync Health: UNKNOWN (no metrics yet)\nCircuit: UNKNOWN\nPending: UNKNOWN\nDead Letter: UNKNOWN\n'
fi

if [[ -f "$STORAGE_HEALTH_FILE" ]] && command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      console.log(`SQLite: ${value.status ?? "UNKNOWN"}`);
      console.log(`SQLite Size: ${Number(value.databaseBytes ?? 0)} bytes`);
      console.log(`WAL Size: ${Number(value.walBytes ?? 0)} bytes`);
    } catch { console.log("SQLite: UNKNOWN (invalid health snapshot)"); }
  ' "$STORAGE_HEALTH_FILE"
else
  printf 'SQLite: UNKNOWN (run termux-preflight.sh)\n'
fi

disk_free="$(nv_disk_free_bytes "$PROJECT_ROOT" 2>/dev/null || true)"
printf 'Free Disk: %s\n' "${disk_free:-UNKNOWN}"
[[ -f "$WAKE_LOCK_MARKER" ]] && printf 'Wake Lock: ACTIVE (last acquisition succeeded)\n' || printf 'Wake Lock: NOT ACTIVE\n'
[[ -x "$BOOT_WRAPPER" ]] && printf 'Boot Integration: INSTALLED\n' || printf 'Boot Integration: NOT INSTALLED\n'
