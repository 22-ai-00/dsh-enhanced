#!/usr/bin/env bash
set -euo pipefail

# These two values are rewritten by release-version.mjs during `release:prepare`.
# A remote `curl | bash` invocation therefore fetches common.sh from one tagged
# release and refuses a changed payload before it executes it.
DSH_ENHANCED_PINNED_RELEASE_REF='v0.1.11'
DSH_ENHANCED_PINNED_COMMON_SHA256='7ccc1cea3d48e1e1e5ee754be868ccf81eda960d289c8620109c4e24ab0fd57e'

# Recursive npm publication is not atomic. Default every bundle to the exact
# release that contains this installer so `latest` cannot compose old and new
# internal Host seams while a unified release is still being published.
if [[ -z "${DSH_ENHANCED_VERSION:-}" ]]; then
  DSH_ENHANCED_VERSION="${DSH_ENHANCED_PINNED_RELEASE_REF#v}"
fi

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
  INSTALL_RELEASE_REF="${DSH_ENHANCED_INSTALL_REF:-$DSH_ENHANCED_PINNED_RELEASE_REF}"
  INSTALL_COMMON_SHA256="${DSH_ENHANCED_INSTALL_COMMON_SHA256:-$DSH_ENHANCED_PINNED_COMMON_SHA256}"
  if [[ ! "$INSTALL_RELEASE_REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'dsh-enhanced installer: 远程安装 ref 必须是固定的 vX.Y.Z 发布标签。\n' >&2
    exit 2
  fi
  if [[ ! "$INSTALL_COMMON_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    printf 'dsh-enhanced installer: 远程 common.sh SHA-256 无效。\n' >&2
    exit 2
  fi
  INSTALL_BASE_URL="${DSH_ENHANCED_INSTALL_BASE_URL:-https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/$INSTALL_RELEASE_REF/scripts/install}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$INSTALL_BASE_URL/common.sh" -o "$TEMPORARY_DIRECTORY/common.sh"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$INSTALL_BASE_URL/common.sh" -O "$TEMPORARY_DIRECTORY/common.sh"
  else
    printf 'dsh-enhanced installer: 远程安装需要 curl 或 wget。\n' >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_COMMON_SHA256="$(sha256sum "$TEMPORARY_DIRECTORY/common.sh" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL_COMMON_SHA256="$(shasum -a 256 "$TEMPORARY_DIRECTORY/common.sh" | awk '{print $1}')"
  else
    printf 'dsh-enhanced installer: 无法验证远程安装器；需要 sha256sum 或 shasum。\n' >&2
    exit 1
  fi
  if [[ "$ACTUAL_COMMON_SHA256" != "$INSTALL_COMMON_SHA256" ]]; then
    printf 'dsh-enhanced installer: 远程 common.sh 完整性校验失败；拒绝执行。\n' >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  source "$TEMPORARY_DIRECTORY/common.sh"
fi

dsh_enhanced_install npm '' "$@"
