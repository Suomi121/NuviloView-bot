#!/usr/bin/env bash
# shellcheck disable=SC2016 # Generated wrapper retains its own runtime variables.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=Android/runtime-common.sh
source "$SCRIPT_DIR/runtime-common.sh"
PROJECT_ROOT="${NUVILOVIEW_PROJECT_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd -P)}"
BOOT_DIR="${TERMUX_BOOT_DIR:-$HOME/.termux/boot}"
WRAPPER="$BOOT_DIR/nuviloview.sh"

if ! nv_is_termux; then
  printf 'This installer must be run inside Android Termux.\n' >&2
  exit 1
fi
if ! nv_project_is_private "$PROJECT_ROOT"; then
  printf 'The project must be stored under the Termux private home.\n' >&2
  exit 1
fi

if [[ "${1:-}" == "--remove" ]]; then
  if [[ -f "$WRAPPER" ]]; then
    rm -f -- "$WRAPPER"
    printf 'Removed Termux:Boot wrapper: %s\n' "$WRAPPER"
  else
    printf 'Termux:Boot wrapper is already absent.\n'
  fi
  exit 0
fi
[[ $# -eq 0 ]] || { printf 'Usage: ./Android/install-termux-boot.sh [--remove]\n' >&2; exit 2; }

[[ -x "$SCRIPT_DIR/boot-start.sh" ]] || {
  printf 'boot-start.sh is missing or not executable. Run setup-termux.sh first.\n' >&2
  exit 1
}
mkdir -p -- "$BOOT_DIR"
chmod 700 -- "$BOOT_DIR" 2>/dev/null || true
temporary="$BOOT_DIR/.nuviloview.sh.$$"
{
  printf '#!/usr/bin/env bash\n'
  printf 'PROJECT_ROOT=%q\n' "$PROJECT_ROOT"
  printf 'if [[ ! -x "$PROJECT_ROOT/Android/boot-start.sh" ]]; then exit 0; fi\n'
  printf 'mkdir -p -- "$PROJECT_ROOT/Android/logs"\n'
  printf 'exec "$PROJECT_ROOT/Android/boot-start.sh" >> "$PROJECT_ROOT/Android/logs/termux-boot.log" 2>&1\n'
} > "$temporary"
chmod 700 -- "$temporary"

if [[ -f "$WRAPPER" ]] && cmp -s -- "$temporary" "$WRAPPER"; then
  rm -f -- "$temporary"
  chmod 700 -- "$WRAPPER"
  printf 'Termux:Boot wrapper is already current: %s\n' "$WRAPPER"
else
  mv -f -- "$temporary" "$WRAPPER"
  printf 'Installed Termux:Boot wrapper: %s\n' "$WRAPPER"
fi

printf 'Open the Termux:Boot app once, then reboot Android manually to test real boot integration.\n'
