#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
RUNNER="$SCRIPT_DIR/run-bot-forever.sh"
LOG_DIR="$SCRIPT_DIR/logs"
BOOT_LOG="$LOG_DIR/boot.log"

mkdir -p -- "$LOG_DIR"
chmod 700 -- "$LOG_DIR" 2>/dev/null || true

boot_log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" >> "$BOOT_LOG"
}

if [[ ! -x "$RUNNER" ]]; then
  boot_log "Runner is not executable: $RUNNER"
  exit 1
fi

case "$PROJECT_ROOT" in
  /sdcard/*|/storage/emulated/*|/mnt/media_rw/*)
    boot_log "Start blocked because the project is in Android shared storage."
    exit 1
    ;;
esac

if command -v termux-wake-lock >/dev/null 2>&1; then
  if termux-wake-lock >> "$BOOT_LOG" 2>&1; then
    boot_log "Termux wake lock acquired."
  else
    boot_log "Warning: wake lock acquisition failed; Bot startup will continue."
  fi
else
  boot_log "Warning: termux-wake-lock is unavailable; Bot startup will continue."
fi

if "$RUNNER" --status >/dev/null 2>&1; then
  boot_log "Runner is already active; duplicate boot start was skipped."
  exit 0
fi

cd -- "$PROJECT_ROOT" || exit 1
boot_log "Starting Android NuviloView Bot runner after device boot."
nohup "$RUNNER" >> "$BOOT_LOG" 2>&1 < /dev/null &
launcher_pid=$!
boot_log "Runner launch requested with PID $launcher_pid."

sleep 2
if "$RUNNER" --status >/dev/null 2>&1; then
  boot_log "Runner status check passed."
  exit 0
fi

boot_log "Runner was not active after startup. Check bot-runner.log and bot-output.log."
exit 1
