#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
ENV_FILE="$PROJECT_ROOT/.env.local"
RUNTIME_DIR="$SCRIPT_DIR/runtime"
LOG_DIR="$SCRIPT_DIR/logs"

fail() {
  printf 'Setup error: %s\n' "$1" >&2
  exit 1
}

if [[ -z "${TERMUX_VERSION:-}" && "${PREFIX:-}" != *"com.termux"* ]]; then
  fail "This setup script must be run inside Android Termux."
fi

case "$PROJECT_ROOT" in
  /sdcard/*|/storage/emulated/*|/mnt/media_rw/*)
    fail "Move the repository under the Termux private home before configuring .env.local."
    ;;
esac

missing_packages=()
command -v node >/dev/null 2>&1 || missing_packages+=(nodejs-lts)
command -v git >/dev/null 2>&1 || missing_packages+=(git)
command -v ps >/dev/null 2>&1 || missing_packages+=(procps)
command -v stat >/dev/null 2>&1 || missing_packages+=(coreutils)
command -v nohup >/dev/null 2>&1 || missing_packages+=(coreutils)
command -v sed >/dev/null 2>&1 || missing_packages+=(sed)
command -v find >/dev/null 2>&1 || missing_packages+=(findutils)

if (( ${#missing_packages[@]} > 0 )); then
  printf 'Install required Termux packages, then run setup again:\n\n  pkg update\n  pkg install %s\n' "${missing_packages[*]}" >&2
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major != 24 )); then
  fail "Node.js 24.x is required by the project. Install a matching Termux Node.js package."
fi

expected_pnpm="$(sed -nE 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@([^"]+)".*/\1/p' "$PROJECT_ROOT/package.json" | head -n 1)"
[[ -n "$expected_pnpm" ]] || fail "package.json does not declare packageManager pnpm version."
current_pnpm="$(pnpm --version 2>/dev/null || true)"
if [[ "$current_pnpm" != "$expected_pnpm" ]]; then
  printf 'Activating the project-declared pnpm %s (current: %s)...\n' "$expected_pnpm" "${current_pnpm:-missing}"
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
    corepack prepare "pnpm@$expected_pnpm" --activate
  elif command -v npm >/dev/null 2>&1; then
    npm install --global "pnpm@$expected_pnpm"
  else
    fail "Neither corepack nor npm is available. Install pnpm $expected_pnpm and rerun setup."
  fi
fi

mkdir -p -- "$RUNTIME_DIR" "$LOG_DIR"
chmod 700 -- \
  "$SCRIPT_DIR/boot-start.sh" \
  "$SCRIPT_DIR/install-termux-boot.sh" \
  "$SCRIPT_DIR/run-bot-forever.sh" \
  "$SCRIPT_DIR/run-sync-worker-forever.sh" \
  "$SCRIPT_DIR/setup-termux.sh" \
  "$SCRIPT_DIR/status-nuviloview.sh" \
  "$SCRIPT_DIR/stop-nuviloview.sh" \
  "$SCRIPT_DIR/termux-preflight.sh"
chmod 700 -- "$RUNTIME_DIR" "$LOG_DIR"

if [[ -f "$ENV_FILE" ]]; then
  chmod 600 -- "$ENV_FILE"
  printf '.env.local found in the Termux private project directory; permissions set to 600.\n'
else
  printf 'Warning: %s does not exist yet. Create it inside this private project directory; do not place it in shared storage.\n' "$ENV_FILE" >&2
fi

cd -- "$PROJECT_ROOT"
printf 'Installing project dependencies with the existing pnpm lockfile...\n'
pnpm install --filter nuviloview-oem --frozen-lockfile

printf '\nTermux setup completed. Next commands:\n'
printf '  cd %q\n' "$PROJECT_ROOT"
printf '  ./Android/termux-preflight.sh\n'
printf '  ./Android/install-termux-boot.sh\n'
printf '  ./Android/boot-start.sh\n'
printf '  ./Android/status-nuviloview.sh\n'
