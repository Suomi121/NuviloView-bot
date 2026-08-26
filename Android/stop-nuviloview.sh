#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=Android/runtime-common.sh
source "$SCRIPT_DIR/runtime-common.sh"
RUNTIME_DIR="${NUVILOVIEW_ANDROID_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
BOT_RUNNER="$SCRIPT_DIR/run-bot-forever.sh"
WORKER_RUNNER="$SCRIPT_DIR/run-sync-worker-forever.sh"
BOOT_LOCK_DIR="$RUNTIME_DIR/boot.lock"
BOOT_LOCK_PID_FILE="$BOOT_LOCK_DIR/pid"
WAKE_LOCK_MARKER="$RUNTIME_DIR/wake-lock.acquired"
status=0

boot_pid="$(nv_read_pid "$BOOT_LOCK_PID_FILE")"
if [[ -n "$boot_pid" ]] && nv_pid_matches "$boot_pid" "Android/boot-start.sh"; then
  printf 'Stopping active boot supervisor PID %s...\n' "$boot_pid"
  kill -TERM "$boot_pid" 2>/dev/null || true
  for _ in {1..10}; do
    nv_pid_matches "$boot_pid" "Android/boot-start.sh" || break
    sleep 1
  done
fi

# Preserve the requested order while ensuring a failure does not skip the
# independent Worker shutdown.
"$BOT_RUNNER" --stop || status=1
"$WORKER_RUNNER" --stop || status=1

boot_pid="$(nv_read_pid "$BOOT_LOCK_PID_FILE")"
if [[ -z "$boot_pid" ]] || ! nv_pid_matches "$boot_pid" "Android/boot-start.sh"; then
  rm -f -- "$BOOT_LOCK_PID_FILE" 2>/dev/null || true
  rmdir -- "$BOOT_LOCK_DIR" 2>/dev/null || true
fi

if command -v termux-wake-unlock >/dev/null 2>&1; then
  if termux-wake-unlock >/dev/null 2>&1; then
    printf 'Termux wake lock released.\n'
    rm -f -- "$WAKE_LOCK_MARKER" 2>/dev/null || true
  else
    printf 'Warning: wake lock release failed.\n' >&2
    status=1
  fi
else
  printf 'Warning: termux-wake-unlock is unavailable.\n' >&2
  rm -f -- "$WAKE_LOCK_MARKER" 2>/dev/null || true
fi

printf 'NuviloView Termux stop completed.\n'
exit "$status"
