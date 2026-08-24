#!/usr/bin/env bash

# Shared, side-effect-free helpers for the Android/Termux runtime scripts.
# This file is sourced by the runners and must never print secret values.

NV_SECRETS=()

nv_timestamp() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

nv_trim_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

nv_get_env_value() {
  local env_file="$1" requested_name="$2"
  local line name value first last
  [[ -f "$env_file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      name="${BASH_REMATCH[1]}"
      [[ "$name" == "$requested_name" ]] || continue
      value="$(nv_trim_value "${BASH_REMATCH[2]}")"
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
  done < "$env_file"
}

nv_env_enabled() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

nv_positive_integer() {
  local env_file="$1" name="$2" fallback="$3" minimum="$4" maximum="$5"
  local value="${!name:-}"
  [[ -n "$value" ]] || value="$(nv_get_env_value "$env_file" "$name")"
  [[ -n "$value" ]] || value="$fallback"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < minimum || value > maximum )); then
    value="$fallback"
  fi
  printf '%s' "$value"
}

nv_load_redaction_secrets() {
  local env_file="$1" line name value database_password first last
  NV_SECRETS=()
  [[ -f "$env_file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      name="${BASH_REMATCH[1]}"
      case "$name" in
        *TOKEN*|*SECRET*|*PASSWORD*|*API_KEY*|DATABASE_URL)
          value="$(nv_trim_value "${BASH_REMATCH[2]}")"
          if (( ${#value} >= 2 )); then
            first="${value:0:1}"
            last="${value: -1}"
            if [[ ( "$first" == '"' && "$last" == '"' ) || ( "$first" == "'" && "$last" == "'" ) ]]; then
              value="${value:1:${#value}-2}"
            fi
          fi
          (( ${#value} >= 8 )) && NV_SECRETS+=("$value")
          if [[ "$name" == "DATABASE_URL" && "$value" =~ ^[^:]+://[^:]+:([^@]+)@ ]]; then
            database_password="${BASH_REMATCH[1]}"
            (( ${#database_password} >= 8 )) && NV_SECRETS+=("$database_password")
          fi
          ;;
      esac
    fi
  done < "$env_file"
}

nv_redact_line() {
  local safe_line="$1" secret prefix suffix
  for secret in "${NV_SECRETS[@]}"; do
    [[ -n "$secret" && "$secret" != "[REDACTED]" ]] || continue
    while [[ "$safe_line" == *"$secret"* ]]; do
      prefix="${safe_line%%"$secret"*}"
      suffix="${safe_line#*"$secret"}"
      safe_line="${prefix}[REDACTED]${suffix}"
    done
  done
  safe_line="$(printf '%s' "$safe_line" | sed -E 's#(postgres(ql)?://[^:/[:space:]]+:)[^@/[:space:]]+@#\1[REDACTED]@#g')"
  printf '%s' "$safe_line"
}

nv_log() {
  local path="$1" message="$2"
  printf '[%s] %s\n' "$(nv_timestamp)" "$(nv_redact_line "$message")" >> "$path"
}

nv_rotate_log() {
  local path="$1" log_dir="$2" max_bytes="$3" retention_days="$4"
  local name extension base size archive
  name="$(basename -- "$path")"
  extension="${name##*.}"
  base="${name%.*}"
  if [[ -f "$path" ]]; then
    size="$(wc -c < "$path" 2>/dev/null || printf '0')"
    if [[ "$size" =~ ^[0-9]+$ ]] && (( size >= max_bytes )); then
      archive="$log_dir/${base}-$(date '+%Y%m%d-%H%M%S').${extension}"
      mv -- "$path" "$archive"
    fi
  fi
  find "$log_dir" -maxdepth 1 -type f -name "${base}-*.${extension}" -mtime "+$retention_days" -delete 2>/dev/null || true
}

nv_read_pid() {
  local path="$1" value=""
  [[ -f "$path" ]] && IFS= read -r value < "$path"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] && printf '%s' "$value"
}

nv_pid_alive() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null
}

nv_process_command() {
  local pid="$1"
  if [[ -r "/proc/$pid/cmdline" ]]; then
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true
  else
    ps -p "$pid" -o args= 2>/dev/null || true
  fi
}

nv_pid_matches() {
  local pid="$1" marker="$2" command_line
  nv_pid_alive "$pid" || return 1
  command_line="$(nv_process_command "$pid")"
  [[ "$command_line" == *"$marker"* ]]
}

nv_project_is_private() {
  case "$1" in
    /sdcard/*|/storage/emulated/*|/mnt/media_rw/*) return 1 ;;
    *) return 0 ;;
  esac
}

nv_is_termux() {
  [[ -n "${TERMUX_VERSION:-}" || "${PREFIX:-}" == *"com.termux"* || "${NUVILOVIEW_ALLOW_NON_TERMUX_TEST:-}" == "1" ]]
}

nv_disk_free_bytes() {
  local path="$1" blocks
  blocks="$(df -Pk "$path" 2>/dev/null | awk 'NR==2 {print $4}')"
  [[ "$blocks" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$((blocks * 1024))"
}

nv_network_route_available() {
  if command -v ip >/dev/null 2>&1; then
    ip route get 1.1.1.1 >/dev/null 2>&1
    return $?
  fi
  # Lack of the optional low-cost route command is unknown, not offline.
  return 2
}

nv_write_state() {
  local path="$1" state="$2"
  printf '%s %s\n' "$state" "$(nv_timestamp)" > "$path"
}

nv_read_state() {
  local path="$1" value="UNKNOWN"
  if [[ -f "$path" ]]; then
    IFS=' ' read -r value _ < "$path" || value="UNKNOWN"
  fi
  printf '%s' "$value"
}
