#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIRECTORY=''
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fi

TEMPORARY_DIRECTORY=''
cleanup_installer_library() {
  if [[ -n "$TEMPORARY_DIRECTORY" ]]; then
    rm -f "$TEMPORARY_DIRECTORY/common.sh"
    rmdir "$TEMPORARY_DIRECTORY" 2>/dev/null || true
  fi
}
trap cleanup_installer_library EXIT

if [[ -n "$SCRIPT_DIRECTORY" && -r "$SCRIPT_DIRECTORY/common.sh" ]]; then
  # shellcheck source=./common.sh
  source "$SCRIPT_DIRECTORY/common.sh"
else
  TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/dsh-enhanced-install.XXXXXX")"
  INSTALL_BASE_URL="${DSH_ENHANCED_INSTALL_BASE_URL:-https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$INSTALL_BASE_URL/common.sh" -o "$TEMPORARY_DIRECTORY/common.sh"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$INSTALL_BASE_URL/common.sh" -O "$TEMPORARY_DIRECTORY/common.sh"
  else
    printf 'dsh-enhanced installer: 远程安装需要 curl 或 wget。\n' >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  source "$TEMPORARY_DIRECTORY/common.sh"
fi

dsh_enhanced_install npm '' "$@"
