#!/usr/bin/env bash
set -euo pipefail

# These values are rewritten together by release-version.mjs during
# `release:prepare`.
# A remote `curl | bash` invocation therefore fetches every executable helper
# from one tagged release and refuses changed payloads before it executes any.
DSH_ENHANCED_PINNED_RELEASE_REF='v0.1.32'
DSH_ENHANCED_PINNED_COMMON_SHA256='c3c605287d898f6eb157e6f83f97df2668e303a2927c867e1f99824c99c38901'
DSH_ENHANCED_PINNED_LIFECYCLE_CONFIG_SHA256='e5af0ac77c275c3577aef7353e024504b51880c7d4a092ba041a67e609d01465'
DSH_ENHANCED_PINNED_LIFECYCLE_PROFILE_SHA256='3c1763ec58e16339c99b73124487edac10b9af3b7c0d1a5e4be529e94ef89ef0'
DSH_ENHANCED_PINNED_VERIFIED_HOST_RANGE='>=0.1.2-rc.1 <0.2.0'
DSH_ENHANCED_PINNED_HOST_VERSION='0.1.5-rc.1'

# The local checkout and the remote fallback both use an exact supported Host.
# The remote fallback intentionally stays on the released ref above until
# release:prepare updates this ref and digest together.
# Override with --plugin-version or DSH_ENHANCED_VERSION using an exact version
# or dist-tag. The pinned ref, SHA-256, and host range above stay aligned with
# the fixed release used by the remote fallback.

SCRIPT_DIRECTORY=''
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fi

INSTALLER_CURRENT_UID="$(id -u)"
INSTALLER_STAT_RESULT=''
INSTALLER_LAST_IDENTITY=''
TEMPORARY_PARENT=''
TEMPORARY_PARENT_IDENTITY=''
TEMPORARY_DIRECTORY=''
TEMPORARY_DIRECTORY_IDENTITY=''
COMMON_DOWNLOAD_IDENTITY=''
LIFECYCLE_CONFIG_DOWNLOAD_IDENTITY=''
LIFECYCLE_PROFILE_DOWNLOAD_IDENTITY=''

installer_stat() {
  local target_path="$1"
  if INSTALLER_STAT_RESULT="$(LC_ALL=C stat -c '%d:%i:%u:%a:%h:%F' "$target_path" 2>/dev/null)"; then
    return 0
  fi
  if INSTALLER_STAT_RESULT="$(LC_ALL=C stat -f '%d:%i:%u:%Op:%l:%HT' "$target_path" 2>/dev/null)"; then
    return 0
  fi
  printf 'dsh-enhanced installer: 无法安全检查临时路径 %s。\n' "$target_path" >&2
  return 1
}

parse_installer_stat() {
  local stat_result="$1"
  IFS=: read -r INSTALLER_STAT_DEVICE INSTALLER_STAT_INODE INSTALLER_STAT_UID \
    INSTALLER_STAT_MODE INSTALLER_STAT_LINKS INSTALLER_STAT_TYPE <<<"$stat_result"
  if [[ ! "$INSTALLER_STAT_DEVICE" =~ ^[0-9]+$
    || ! "$INSTALLER_STAT_INODE" =~ ^[0-9]+$
    || ! "$INSTALLER_STAT_UID" =~ ^[0-9]+$
    || ! "$INSTALLER_STAT_MODE" =~ ^[0-7]{3,7}$
    || ! "$INSTALLER_STAT_LINKS" =~ ^[0-9]+$ ]]; then
    printf 'dsh-enhanced installer: 无法解析临时路径元数据；拒绝继续。\n' >&2
    return 1
  fi
  # GNU %a already omits the type bits. BSD %Op includes them, so mask both
  # representations to the permission, set-id, and sticky bits.
  INSTALLER_STAT_MODE_VALUE=$(( (8#$INSTALLER_STAT_MODE) & 07777 ))
  INSTALLER_LAST_IDENTITY="$INSTALLER_STAT_DEVICE:$INSTALLER_STAT_INODE"
}

installer_stat_is_directory() {
  case "$INSTALLER_STAT_TYPE" in
    directory|Directory) return 0 ;;
  esac
  return 1
}

installer_stat_is_regular_file() {
  case "$INSTALLER_STAT_TYPE" in
    'regular file'|'regular empty file'|'Regular File') return 0 ;;
  esac
  return 1
}

validate_temporary_ancestor() {
  local ancestor_path="$1"
  local system_temp_path="$2"
  installer_stat "$ancestor_path" || return $?
  parse_installer_stat "$INSTALLER_STAT_RESULT" || return $?
  if ! installer_stat_is_directory; then
    printf 'dsh-enhanced installer: 临时目录祖先不是目录：%s。\n' "$ancestor_path" >&2
    return 1
  fi
  if [[ "$ancestor_path" == "$system_temp_path" ]]; then
    if [[ "$INSTALLER_STAT_UID" != '0' || "$INSTALLER_STAT_MODE_VALUE" -ne 1023 ]]; then
      printf 'dsh-enhanced installer: 系统临时目录必须由 root 拥有且权限为 01777：%s。\n' "$ancestor_path" >&2
      return 1
    fi
    return 0
  fi
  if [[ "$INSTALLER_STAT_UID" != '0' && "$INSTALLER_STAT_UID" != "$INSTALLER_CURRENT_UID" ]]; then
    printf 'dsh-enhanced installer: 临时目录祖先所有者不受信任：%s。\n' "$ancestor_path" >&2
    return 1
  fi
  if (( (INSTALLER_STAT_MODE_VALUE & 0022) != 0 )); then
    printf 'dsh-enhanced installer: 临时目录祖先可被其他用户写入：%s。\n' "$ancestor_path" >&2
    return 1
  fi
}

validate_temporary_parent() {
  local parent_path="$1"
  local expected_identity="${2:-}"
  local system_temp_path="$3"
  local ancestor_path
  local parent_identity

  if [[ "$parent_path" != /* || -L "$parent_path" ]]; then
    printf 'dsh-enhanced installer: TMPDIR 必须是绝对、非符号链接路径。\n' >&2
    return 1
  fi
  ancestor_path="$parent_path"
  while :; do
    validate_temporary_ancestor "$ancestor_path" "$system_temp_path" || return $?
    if [[ "$ancestor_path" == "$parent_path" ]]; then
      parent_identity="$INSTALLER_LAST_IDENTITY"
      if [[ "$parent_path" != "$system_temp_path" && "$INSTALLER_STAT_UID" != "$INSTALLER_CURRENT_UID" ]]; then
        printf 'dsh-enhanced installer: TMPDIR 必须由当前用户拥有：%s。\n' "$parent_path" >&2
        return 1
      fi
    fi
    [[ "$ancestor_path" == '/' ]] && break
    ancestor_path="$(dirname "$ancestor_path")"
  done
  INSTALLER_LAST_IDENTITY="$parent_identity"
  if [[ -n "$expected_identity" && "$INSTALLER_LAST_IDENTITY" != "$expected_identity" ]]; then
    printf 'dsh-enhanced installer: TMPDIR 在安装期间被替换；拒绝继续。\n' >&2
    return 1
  fi
}

select_temporary_parent() {
  local requested_parent="${TMPDIR:-/tmp}"
  local canonical_parent
  local system_temp_path

  if [[ "$requested_parent" != /* ]]; then
    printf 'dsh-enhanced installer: TMPDIR 必须是绝对路径。\n' >&2
    return 1
  fi
  while [[ "$requested_parent" != '/' && "$requested_parent" == */ ]]; do
    requested_parent="${requested_parent%/}"
  done
  # macOS exposes /tmp as the conventional symlink to /private/tmp. Resolve
  # that one system alias, then validate only the canonical directory below.
  if [[ -L "$requested_parent" && "$requested_parent" != '/tmp' ]]; then
    printf 'dsh-enhanced installer: TMPDIR 不能是符号链接：%s。\n' "$requested_parent" >&2
    return 1
  fi
  canonical_parent="$(cd -P "$requested_parent" 2>/dev/null && pwd -P)" || {
    printf 'dsh-enhanced installer: TMPDIR 不存在或不可访问：%s。\n' "$requested_parent" >&2
    return 1
  }
  system_temp_path="$(cd -P /tmp 2>/dev/null && pwd -P)" || {
    printf 'dsh-enhanced installer: 无法解析系统临时目录 /tmp。\n' >&2
    return 1
  }
  if [[ "$canonical_parent" != "$requested_parent" && "$requested_parent" != '/tmp' ]]; then
    printf 'dsh-enhanced installer: TMPDIR 必须是 canonical 路径：%s。\n' "$requested_parent" >&2
    return 1
  fi
  if [[ -L "$canonical_parent" ]]; then
    printf 'dsh-enhanced installer: canonical TMPDIR 不能是符号链接：%s。\n' "$canonical_parent" >&2
    return 1
  fi
  TEMPORARY_PARENT="$canonical_parent"
  validate_temporary_parent "$TEMPORARY_PARENT" '' "$system_temp_path" || return $?
  TEMPORARY_PARENT_IDENTITY="$INSTALLER_LAST_IDENTITY"
  INSTALLER_SYSTEM_TEMP_PATH="$system_temp_path"
}

validate_temporary_directory() {
  local expected_identity="${1:-}"
  local expected_mode="${2:-}"
  local canonical_directory
  if [[ -z "$TEMPORARY_DIRECTORY" || -L "$TEMPORARY_DIRECTORY" ]]; then
    printf 'dsh-enhanced installer: 临时工作目录路径不安全；拒绝继续。\n' >&2
    return 1
  fi
  if [[ "$TEMPORARY_PARENT" == '/' ]]; then
    if [[ "$TEMPORARY_DIRECTORY" != /dsh-enhanced-install.* ]]; then
      printf 'dsh-enhanced installer: 临时工作目录不在已验证的 TMPDIR 中；拒绝继续。\n' >&2
      return 1
    fi
  elif [[ "$TEMPORARY_DIRECTORY" != "$TEMPORARY_PARENT"/dsh-enhanced-install.* ]]; then
    printf 'dsh-enhanced installer: 临时工作目录不在已验证的 TMPDIR 中；拒绝继续。\n' >&2
    return 1
  fi
  canonical_directory="$(cd -P "$TEMPORARY_DIRECTORY" 2>/dev/null && pwd -P)" || {
    printf 'dsh-enhanced installer: 临时工作目录不可访问；拒绝继续。\n' >&2
    return 1
  }
  if [[ "$canonical_directory" != "$TEMPORARY_DIRECTORY" ]]; then
    printf 'dsh-enhanced installer: 临时工作目录不是 canonical 路径；拒绝继续。\n' >&2
    return 1
  fi
  installer_stat "$TEMPORARY_DIRECTORY" || return $?
  parse_installer_stat "$INSTALLER_STAT_RESULT" || return $?
  if ! installer_stat_is_directory || [[ "$INSTALLER_STAT_UID" != "$INSTALLER_CURRENT_UID" ]]; then
    printf 'dsh-enhanced installer: 临时工作目录类型或所有者不安全；拒绝继续。\n' >&2
    return 1
  fi
  if (( (INSTALLER_STAT_MODE_VALUE & 0077) != 0 )); then
    printf 'dsh-enhanced installer: 临时工作目录不能向 group/other 开放。\n' >&2
    return 1
  fi
  if [[ -n "$expected_mode" && "$INSTALLER_STAT_MODE_VALUE" -ne "$expected_mode" ]]; then
    printf 'dsh-enhanced installer: 临时工作目录权限在安装期间发生变化；拒绝继续。\n' >&2
    return 1
  fi
  if [[ -n "$expected_identity" && "$INSTALLER_LAST_IDENTITY" != "$expected_identity" ]]; then
    printf 'dsh-enhanced installer: 临时工作目录在安装期间被替换；拒绝继续。\n' >&2
    return 1
  fi
}

validate_installer_asset_path() {
  local asset_path="$1"
  local expected_identity="${2:-}"
  local expected_mode="${3:-}"
  if [[ -L "$asset_path" ]]; then
    printf 'dsh-enhanced installer: 临时安装资产不能是符号链接：%s。\n' "$asset_path" >&2
    return 1
  fi
  installer_stat "$asset_path" || return $?
  parse_installer_stat "$INSTALLER_STAT_RESULT" || return $?
  if ! installer_stat_is_regular_file \
    || [[ "$INSTALLER_STAT_UID" != "$INSTALLER_CURRENT_UID" ]] \
    || [[ "$INSTALLER_STAT_LINKS" != '1' ]]; then
    printf 'dsh-enhanced installer: 临时安装资产必须是当前用户拥有的普通单链接文件：%s。\n' "$asset_path" >&2
    return 1
  fi
  if (( (INSTALLER_STAT_MODE_VALUE & 0077) != 0 )); then
    printf 'dsh-enhanced installer: 临时安装资产不能向 group/other 开放：%s。\n' "$asset_path" >&2
    return 1
  fi
  if [[ -n "$expected_mode" && "$INSTALLER_STAT_MODE_VALUE" -ne "$expected_mode" ]]; then
    printf 'dsh-enhanced installer: 临时安装资产权限不安全：%s。\n' "$asset_path" >&2
    return 1
  fi
  if [[ -n "$expected_identity" && "$INSTALLER_LAST_IDENTITY" != "$expected_identity" ]]; then
    printf 'dsh-enhanced installer: 临时安装资产在校验期间被替换：%s。\n' "$asset_path" >&2
    return 1
  fi
}

set_installer_asset_identity() {
  local asset_name="$1"
  local asset_identity="$2"
  case "$asset_name" in
    common.sh) COMMON_DOWNLOAD_IDENTITY="$asset_identity" ;;
    lifecycle-config.mjs) LIFECYCLE_CONFIG_DOWNLOAD_IDENTITY="$asset_identity" ;;
    lifecycle-profile.mjs) LIFECYCLE_PROFILE_DOWNLOAD_IDENTITY="$asset_identity" ;;
    *) return 1 ;;
  esac
}

get_installer_asset_identity() {
  local asset_name="$1"
  case "$asset_name" in
    common.sh) INSTALLER_ASSET_IDENTITY="$COMMON_DOWNLOAD_IDENTITY" ;;
    lifecycle-config.mjs) INSTALLER_ASSET_IDENTITY="$LIFECYCLE_CONFIG_DOWNLOAD_IDENTITY" ;;
    lifecycle-profile.mjs) INSTALLER_ASSET_IDENTITY="$LIFECYCLE_PROFILE_DOWNLOAD_IDENTITY" ;;
    *) return 1 ;;
  esac
}

cleanup_installer_library() {
  if [[ -n "$TEMPORARY_DIRECTORY" ]]; then
    if ! validate_temporary_directory "$TEMPORARY_DIRECTORY_IDENTITY"; then
      printf 'dsh-enhanced installer: 临时工作目录身份已变化；跳过不安全的清理。\n' >&2
      return
    fi
    chmod u+w "$TEMPORARY_DIRECTORY" 2>/dev/null || true
    rm -f "$TEMPORARY_DIRECTORY/common.sh.download"
    rm -f "$TEMPORARY_DIRECTORY/lifecycle-config.mjs.download"
    rm -f "$TEMPORARY_DIRECTORY/lifecycle-profile.mjs.download"
    rm -f "$TEMPORARY_DIRECTORY/common.sh"
    rm -f "$TEMPORARY_DIRECTORY/lifecycle-config.mjs"
    rm -f "$TEMPORARY_DIRECTORY/lifecycle-profile.mjs"
    rmdir "$TEMPORARY_DIRECTORY" 2>/dev/null || true
  fi
}
trap cleanup_installer_library EXIT

download_installer_asset() {
  local asset_name="$1"
  local asset_destination="$TEMPORARY_DIRECTORY/$asset_name.download"
  validate_temporary_directory "$TEMPORARY_DIRECTORY_IDENTITY" 448 || return $?
  if [[ -e "$asset_destination" || -L "$asset_destination" ]]; then
    printf 'dsh-enhanced installer: 临时安装资产路径已存在：%s。\n' "$asset_destination" >&2
    return 1
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$INSTALL_BASE_URL/$asset_name" -o "$asset_destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$INSTALL_BASE_URL/$asset_name" -O "$asset_destination"
  else
    printf 'dsh-enhanced installer: 远程安装需要 curl 或 wget。\n' >&2
    return 1
  fi
  validate_temporary_directory "$TEMPORARY_DIRECTORY_IDENTITY" 448 || return $?
  validate_installer_asset_path "$asset_destination" || return $?
  set_installer_asset_identity "$asset_name" "$INSTALLER_LAST_IDENTITY"
}

installer_asset_sha256() {
  local asset_path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$asset_path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$asset_path" | awk '{print $1}'
  else
    printf 'dsh-enhanced installer: 无法验证远程安装器；需要 sha256sum 或 shasum。\n' >&2
    return 1
  fi
}

verify_installer_asset() {
  local asset_name="$1"
  local expected_sha256="$2"
  local actual_sha256
  get_installer_asset_identity "$asset_name" || return $?
  validate_temporary_directory "$TEMPORARY_DIRECTORY_IDENTITY" 448 || return $?
  validate_installer_asset_path "$TEMPORARY_DIRECTORY/$asset_name.download" "$INSTALLER_ASSET_IDENTITY" || return $?
  actual_sha256="$(installer_asset_sha256 "$TEMPORARY_DIRECTORY/$asset_name.download")" || return $?
  validate_temporary_directory "$TEMPORARY_DIRECTORY_IDENTITY" 448 || return $?
  validate_installer_asset_path "$TEMPORARY_DIRECTORY/$asset_name.download" "$INSTALLER_ASSET_IDENTITY" || return $?
  if [[ "$actual_sha256" != "$expected_sha256" ]]; then
    printf 'dsh-enhanced installer: 远程 %s 完整性校验失败；拒绝执行。\n' "$asset_name" >&2
    return 1
  fi
}

seal_installer_asset() {
  local asset_name="$1"
  local source_path="$TEMPORARY_DIRECTORY/$asset_name.download"
  local destination_path="$TEMPORARY_DIRECTORY/$asset_name"
  get_installer_asset_identity "$asset_name" || return $?
  validate_temporary_directory "$TEMPORARY_DIRECTORY_IDENTITY" 448 || return $?
  validate_installer_asset_path "$source_path" "$INSTALLER_ASSET_IDENTITY" || return $?
  if [[ -e "$destination_path" || -L "$destination_path" ]]; then
    printf 'dsh-enhanced installer: 已校验安装资产的目标路径已存在：%s。\n' "$destination_path" >&2
    return 1
  fi
  mv "$source_path" "$destination_path"
  chmod 0400 "$destination_path"
  validate_temporary_directory "$TEMPORARY_DIRECTORY_IDENTITY" 448 || return $?
  validate_installer_asset_path "$destination_path" "$INSTALLER_ASSET_IDENTITY" 256
}

INSTALL_OPERATION='install'
INSTALL_EXPECTS_OPERATION='0'
for INSTALL_ARGUMENT in "$@"; do
  if [[ "$INSTALL_EXPECTS_OPERATION" == '1' ]]; then
    INSTALL_OPERATION="$INSTALL_ARGUMENT"
    INSTALL_EXPECTS_OPERATION='0'
  elif [[ "$INSTALL_ARGUMENT" == '--operation' ]]; then
    INSTALL_EXPECTS_OPERATION='1'
  fi
done
INSTALL_NEEDS_LIFECYCLE_HELPERS='0'
case "$INSTALL_OPERATION" in
  upgrade|uninstall) INSTALL_NEEDS_LIFECYCLE_HELPERS='1' ;;
esac

if [[ -n "$SCRIPT_DIRECTORY" && -r "$SCRIPT_DIRECTORY/common.sh" ]]; then
  # shellcheck source=./common.sh
  source "$SCRIPT_DIRECTORY/common.sh"
else
  umask 077
  select_temporary_parent
  TEMPORARY_DIRECTORY="$(mktemp -d "${TEMPORARY_PARENT%/}/dsh-enhanced-install.XXXXXX")"
  chmod 0700 "$TEMPORARY_DIRECTORY"
  validate_temporary_directory '' 448
  TEMPORARY_DIRECTORY_IDENTITY="$INSTALLER_LAST_IDENTITY"
  validate_temporary_parent "$TEMPORARY_PARENT" "$TEMPORARY_PARENT_IDENTITY" "$INSTALLER_SYSTEM_TEMP_PATH"
  validate_temporary_directory "$TEMPORARY_DIRECTORY_IDENTITY" 448
  INSTALL_RELEASE_REF="${DSH_ENHANCED_INSTALL_REF:-$DSH_ENHANCED_PINNED_RELEASE_REF}"
  INSTALL_COMMON_SHA256="${DSH_ENHANCED_INSTALL_COMMON_SHA256:-$DSH_ENHANCED_PINNED_COMMON_SHA256}"
  INSTALL_LIFECYCLE_CONFIG_SHA256="${DSH_ENHANCED_INSTALL_LIFECYCLE_CONFIG_SHA256:-$DSH_ENHANCED_PINNED_LIFECYCLE_CONFIG_SHA256}"
  INSTALL_LIFECYCLE_PROFILE_SHA256="${DSH_ENHANCED_INSTALL_LIFECYCLE_PROFILE_SHA256:-$DSH_ENHANCED_PINNED_LIFECYCLE_PROFILE_SHA256}"
  if [[ ! "$INSTALL_RELEASE_REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'dsh-enhanced installer: 远程安装 ref 必须是固定的 vX.Y.Z 发布标签。\n' >&2
    exit 2
  fi
  if [[ ! "$INSTALL_COMMON_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    printf 'dsh-enhanced installer: 远程 common.sh SHA-256 无效。\n' >&2
    exit 2
  fi
  if [[ "$INSTALL_NEEDS_LIFECYCLE_HELPERS" == '1' ]]; then
    if [[ ! "$INSTALL_LIFECYCLE_CONFIG_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
      printf 'dsh-enhanced installer: 远程 lifecycle-config.mjs SHA-256 无效。\n' >&2
      exit 2
    fi
    if [[ ! "$INSTALL_LIFECYCLE_PROFILE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
      printf 'dsh-enhanced installer: 远程 lifecycle-profile.mjs SHA-256 无效。\n' >&2
      exit 2
    fi
    if [[ "$INSTALL_LIFECYCLE_CONFIG_SHA256" == '0000000000000000000000000000000000000000000000000000000000000000'
      || "$INSTALL_LIFECYCLE_PROFILE_SHA256" == '0000000000000000000000000000000000000000000000000000000000000000' ]]; then
      printf 'dsh-enhanced installer: 固定发布未包含已校验的 lifecycle helper；拒绝远程 upgrade/uninstall。\n' >&2
      exit 1
    fi
  fi
  INSTALL_BASE_URL="${DSH_ENHANCED_INSTALL_BASE_URL:-https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/$INSTALL_RELEASE_REF/scripts/install}"
  download_installer_asset common.sh
  verify_installer_asset common.sh "$INSTALL_COMMON_SHA256"
  if [[ "$INSTALL_NEEDS_LIFECYCLE_HELPERS" == '1' ]]; then
    download_installer_asset lifecycle-config.mjs
    download_installer_asset lifecycle-profile.mjs
    verify_installer_asset lifecycle-config.mjs "$INSTALL_LIFECYCLE_CONFIG_SHA256"
    verify_installer_asset lifecycle-profile.mjs "$INSTALL_LIFECYCLE_PROFILE_SHA256"
  fi

  seal_installer_asset common.sh
  if [[ "$INSTALL_NEEDS_LIFECYCLE_HELPERS" == '1' ]]; then
    seal_installer_asset lifecycle-config.mjs
    seal_installer_asset lifecycle-profile.mjs
  fi
  chmod 0500 "$TEMPORARY_DIRECTORY"
  validate_temporary_parent "$TEMPORARY_PARENT" "$TEMPORARY_PARENT_IDENTITY" "$INSTALLER_SYSTEM_TEMP_PATH"
  validate_temporary_directory "$TEMPORARY_DIRECTORY_IDENTITY" 320
  validate_installer_asset_path "$TEMPORARY_DIRECTORY/common.sh" "$COMMON_DOWNLOAD_IDENTITY" 256
  if [[ "$INSTALL_NEEDS_LIFECYCLE_HELPERS" == '1' ]]; then
    validate_installer_asset_path "$TEMPORARY_DIRECTORY/lifecycle-config.mjs" "$LIFECYCLE_CONFIG_DOWNLOAD_IDENTITY" 256
    validate_installer_asset_path "$TEMPORARY_DIRECTORY/lifecycle-profile.mjs" "$LIFECYCLE_PROFILE_DOWNLOAD_IDENTITY" 256
  fi
  DSH_ENHANCED_VERIFIED_HOST_RANGE="$DSH_ENHANCED_PINNED_VERIFIED_HOST_RANGE"
  export DSH_ENHANCED_VERIFIED_HOST_RANGE
  export DSH_ENHANCED_PINNED_HOST_VERSION
  # shellcheck source=/dev/null
  source "$TEMPORARY_DIRECTORY/common.sh"
fi

dsh_enhanced_install npm '' "$@"
