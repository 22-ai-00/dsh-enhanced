#!/usr/bin/env bash

# Shared implementation for install-local.sh and install-npm.sh.
# This file is sourced by the two public entrypoints; do not execute it directly.

DSH_ENHANCED_DEFAULT_DSH_VERSION='0.1.0-rc.8'
DSH_ENHANCED_DEFAULT_PNPM_VERSION='11.7.0'
DSH_ENHANCED_PLUGIN_SLUGS=(
  'coding-subscription-provider'
  'traex-acp-provider'
  'personal-assistant'
  'assistant-delivery'
  'credentials-keychain'
  'lark-channel'
  'memory-wiki-bridge'
  'assistant-heartbeat'
  'event-triggers'
  'assistant-health'
)

dsh_enhanced_usage() {
  local source_mode="$1"
  cat <<EOF
Usage: $(basename "$0") [options]

Install the complete dsh-enhanced Web personal-assistant deployment set.

Options:
  --profile <name>          DSH profile (default: web)
  --lark <mode>             auto, keep, configure, or skip (default: auto)
  --dsh-version <version>   DSH version to ensure (default: ${DSH_ENHANCED_DEFAULT_DSH_VERSION})
  --no-service              Do not install or restart the macOS resident service
  --yes                     Choose the safe default without the installer menu
  --dry-run                 Print the complete plan without changing the machine
  -h, --help                Show this help
EOF
  if [[ "$source_mode" == 'npm' ]]; then
    cat <<'EOF'
  --plugin-version <value>  Version/tag applied to every @dsh-enhanced package (default: latest)
EOF
  fi
  cat <<'EOF'

Feishu modes:
  auto       Keep an existing enabled bot; otherwise start configuration.
  keep       Keep the current bot and only restart its resident service.
  configure  Select an existing app or create a new app, then overwrite the channel binding.
  skip       Preserve any current channel configuration and do no Feishu/service work.
EOF
}

dsh_enhanced_fail() {
  local status="$1"
  shift
  printf 'dsh-enhanced installer: %s\n' "$*" >&2
  return "$status"
}

dsh_enhanced_print_command() {
  printf '  $'
  printf ' %q' "$@"
  printf '\n'
}

dsh_enhanced_run() {
  local dry_run="$1"
  shift
  if [[ "$dry_run" == '1' ]]; then
    dsh_enhanced_print_command "$@"
    return 0
  fi
  "$@"
}

dsh_enhanced_refresh_global_path() {
  local prefix
  prefix="$(npm prefix --global 2>/dev/null)" || return 1
  if [[ -d "$prefix/bin" ]]; then
    case ":$PATH:" in
      *":$prefix/bin:"*) ;;
      *) PATH="$prefix/bin:$PATH"; export PATH ;;
    esac
  fi
}

dsh_enhanced_require_node() {
  if ! command -v node >/dev/null 2>&1; then
    dsh_enhanced_fail 1 '需要 Node.js 22.19+ 或 24+；请先安装 Node.js。'
    return $?
  fi
  if ! node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit((major === 22 && minor >= 19) || major >= 24 ? 0 : 1)"; then
    dsh_enhanced_fail 1 "当前 Node.js $(node --version) 不兼容；需要 22.19+ 或 24+。"
    return $?
  fi
  if ! command -v npm >/dev/null 2>&1; then
    dsh_enhanced_fail 1 '找不到 npm；请安装包含 npm 的 Node.js 发行版。'
    return $?
  fi
}

dsh_enhanced_ensure_dsh() {
  local requested_version="$1"
  local dry_run="$2"
  local current_version=''
  printf 'DSH 目标：@deepseek-ai/dsh@%s\n' "$requested_version"
  if [[ "$dry_run" == '1' ]]; then
    dsh_enhanced_print_command npm install --global "@deepseek-ai/dsh@$requested_version"
    return 0
  fi
  if command -v dsh >/dev/null 2>&1; then
    current_version="$(dsh --version 2>/dev/null || true)"
  fi
  if [[ "$current_version" == "$requested_version" ]]; then
    printf 'DSH 已安装且版本匹配：%s\n' "$current_version"
    return 0
  fi
  if [[ -n "$current_version" ]]; then
    printf 'DSH 当前版本为 %s，正在切换到 %s。\n' "$current_version" "$requested_version"
  else
    printf '未检测到 DSH，正在安装。\n'
  fi
  npm install --global "@deepseek-ai/dsh@$requested_version"
  hash -r
  dsh_enhanced_refresh_global_path || true
  if ! command -v dsh >/dev/null 2>&1; then
    dsh_enhanced_fail 1 'DSH 已安装但 dsh 不在 PATH；请把 npm global bin 目录加入 PATH 后重试。'
    return $?
  fi
  current_version="$(dsh --version 2>/dev/null || true)"
  if [[ "$current_version" != "$requested_version" ]]; then
    dsh_enhanced_fail 1 "DSH 版本校验失败：得到 ${current_version:-unknown}，期望 $requested_version。"
    return $?
  fi
}

dsh_enhanced_ensure_pnpm() {
  local dry_run="$1"
  local current_version=''
  printf 'pnpm 目标：%s\n' "$DSH_ENHANCED_DEFAULT_PNPM_VERSION"
  if [[ "$dry_run" == '1' ]]; then
    dsh_enhanced_print_command npm install --global "pnpm@$DSH_ENHANCED_DEFAULT_PNPM_VERSION"
    return 0
  fi
  if command -v pnpm >/dev/null 2>&1; then
    current_version="$(pnpm --version 2>/dev/null || true)"
  fi
  if [[ "$current_version" == "$DSH_ENHANCED_DEFAULT_PNPM_VERSION" ]]; then
    return 0
  fi
  npm install --global "pnpm@$DSH_ENHANCED_DEFAULT_PNPM_VERSION"
  hash -r
  dsh_enhanced_refresh_global_path || true
  current_version="$(pnpm --version 2>/dev/null || true)"
  if [[ "$current_version" != "$DSH_ENHANCED_DEFAULT_PNPM_VERSION" ]]; then
    dsh_enhanced_fail 1 "pnpm 版本校验失败：得到 ${current_version:-unknown}，期望 $DSH_ENHANCED_DEFAULT_PNPM_VERSION。"
    return $?
  fi
}

dsh_enhanced_lark_is_configured() {
  local patch_path="$1"
  [[ -f "$patch_path" ]] || return 1
  awk '
    BEGIN { in_lark = 0; enabled = 0; app_id = 0 }
    /^- id:[[:space:]]+dsh-enhanced-lark-channel[[:space:]]*$/ { in_lark = 1; next }
    in_lark && /^- id:/ { in_lark = 0 }
    in_lark && /^[[:space:]]+enabled:[[:space:]]+true[[:space:]]*$/ { enabled = 1 }
    in_lark && /^[[:space:]]+appId:[[:space:]]+cli_[0-9a-fA-F]{16}[[:space:]]*$/ { app_id = 1 }
    END { exit !(enabled && app_id) }
  ' "$patch_path"
}

dsh_enhanced_choose_lark_mode() {
  local configured="$1"
  if [[ "$configured" == '1' ]]; then
    printf '\n检测到当前 profile 已启用飞书 Bot：\n' >&2
    printf '  1) 保留当前应用，只重启常驻服务（推荐）\n' >&2
    printf '  2) 选择已有应用或创建新应用，并覆盖当前 channel 配置\n' >&2
    printf '  3) 本次跳过飞书和服务处理\n' >&2
    printf '请选择 [1]：' >&2
    local choice
    IFS= read -r choice
    case "$choice" in
      ''|'1') printf 'keep' ;;
      '2') printf 'configure' ;;
      '3') printf 'skip' ;;
      *) return 2 ;;
    esac
  else
    printf '\n当前 profile 尚未配置飞书 Bot：\n' >&2
    printf '  1) 现在选择已有应用或创建新应用（推荐）\n' >&2
    printf '  2) 本次跳过飞书配置\n' >&2
    printf '请选择 [1]：' >&2
    local choice
    IFS= read -r choice
    case "$choice" in
      ''|'1') printf 'configure' ;;
      '2') printf 'skip' ;;
      *) return 2 ;;
    esac
  fi
}

dsh_enhanced_apply_lark() {
  local mode="$1"
  local profile="$2"
  local dsh_home="$3"
  local configured="$4"
  local manage_service="$5"
  local dry_run="$6"
  local setup_bin="$dsh_home/profiles/$profile/node_modules/.bin/dsh-lark-setup"

  case "$mode" in
    keep)
      if [[ "$configured" != '1' ]]; then
        dsh_enhanced_fail 2 '没有可保留的飞书配置；请使用 --lark configure 或 --lark skip。'
        return $?
      fi
      printf '\n飞书处理：保留当前应用配置。\n'
      if [[ "$manage_service" == '1' ]]; then
        if [[ "$dry_run" != '1' && ! -x "$setup_bin" ]]; then
          dsh_enhanced_fail 1 "找不到安装后的 dsh-lark-setup：$setup_bin"
          return $?
        fi
        dsh_enhanced_run "$dry_run" "$setup_bin" --profile "$profile" --install-service
      else
        printf '已按 --no-service 跳过常驻服务重启。\n'
      fi
      ;;
    configure)
      printf '\n飞书处理：选择已有应用或创建新应用，并覆盖当前 channel 配置。\n'
      if [[ "$dry_run" != '1' ]]; then
        if [[ ! -t 0 || ! -t 1 ]]; then
          dsh_enhanced_fail 1 '飞书向导需要交互式终端；请直接运行脚本，或使用 --lark skip。'
          return $?
        fi
        if [[ ! -x "$setup_bin" ]]; then
          dsh_enhanced_fail 1 "找不到安装后的 dsh-lark-setup：$setup_bin"
          return $?
        fi
      fi
      if [[ "$manage_service" == '1' ]]; then
        dsh_enhanced_run "$dry_run" "$setup_bin" --profile "$profile"
      else
        dsh_enhanced_run "$dry_run" "$setup_bin" --profile "$profile" --no-service
      fi
      ;;
    skip)
      printf '\n飞书处理：本次跳过；现有配置不会被修改。\n'
      ;;
    *)
      dsh_enhanced_fail 2 "不支持的飞书模式：$mode"
      return $?
      ;;
  esac
}

dsh_enhanced_install() {
  local source_mode="$1"
  local repo_root="$2"
  shift 2

  local profile="${DSH_ENHANCED_PROFILE:-web}"
  local lark_mode='auto'
  local dsh_version="${DSH_VERSION:-$DSH_ENHANCED_DEFAULT_DSH_VERSION}"
  local plugin_version="${DSH_ENHANCED_VERSION:-latest}"
  local manage_service='1'
  local assume_yes='0'
  local dry_run='0'

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --profile)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--profile 需要一个值。'; return $?; }
        profile="$2"
        shift 2
        ;;
      --lark)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--lark 需要一个值。'; return $?; }
        lark_mode="$2"
        shift 2
        ;;
      --dsh-version)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--dsh-version 需要一个值。'; return $?; }
        dsh_version="$2"
        shift 2
        ;;
      --plugin-version)
        if [[ "$source_mode" != 'npm' ]]; then
          dsh_enhanced_fail 2 '--plugin-version 只适用于 npm 安装脚本。'
          return $?
        fi
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--plugin-version 需要一个值。'; return $?; }
        plugin_version="$2"
        shift 2
        ;;
      --no-service)
        manage_service='0'
        shift
        ;;
      --yes)
        assume_yes='1'
        shift
        ;;
      --dry-run)
        dry_run='1'
        shift
        ;;
      -h|--help)
        dsh_enhanced_usage "$source_mode"
        return 0
        ;;
      *)
        dsh_enhanced_fail 2 "未知参数：$1"
        return $?
        ;;
    esac
  done

  if [[ ! "$profile" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
    dsh_enhanced_fail 2 'profile 名称不合法；只能包含字母、数字、点、下划线和连字符。'
    return $?
  fi
  case "$lark_mode" in auto|keep|configure|skip) ;; *)
    dsh_enhanced_fail 2 '--lark 只能是 auto、keep、configure 或 skip。'
    return $?
  esac
  if [[ -z "$dsh_version" || "$dsh_version" == -* ]]; then
    dsh_enhanced_fail 2 'DSH 版本值不合法。'
    return $?
  fi
  if [[ "$source_mode" == 'npm' && ( -z "$plugin_version" || "$plugin_version" == -* ) ]]; then
    dsh_enhanced_fail 2 '插件版本值不合法。'
    return $?
  fi

  local dsh_home="${DSH_HOME:-$HOME/.dsh}"
  if [[ "$dsh_home" != /* ]]; then
    dsh_enhanced_fail 2 'DSH_HOME 必须是绝对路径。'
    return $?
  fi
  if [[ "$source_mode" == 'local' ]]; then
    if [[ ! -f "$repo_root/package.json" || ! -d "$repo_root/plugins" ]]; then
      dsh_enhanced_fail 1 "无法识别 dsh-enhanced 仓库根目录：$repo_root"
      return $?
    fi
  fi

  printf '安装来源：%s\n' "$source_mode"
  printf '目标 profile：%s\n' "$profile"
  printf 'DSH_HOME：%s\n\n' "$dsh_home"

  if [[ "$dry_run" != '1' ]]; then
    dsh_enhanced_require_node || return $?
  fi
  dsh_enhanced_ensure_dsh "$dsh_version" "$dry_run" || return $?

  if [[ "$source_mode" == 'local' ]]; then
    dsh_enhanced_ensure_pnpm "$dry_run" || return $?
    printf '\n准备并构建当前仓库：\n'
    if [[ "$dry_run" == '1' ]]; then
      dsh_enhanced_print_command pnpm --dir "$repo_root" install
      dsh_enhanced_print_command pnpm --dir "$repo_root" build
    else
      (cd "$repo_root" && pnpm install && pnpm build)
    fi
  fi

  local targets=()
  local slug
  for slug in "${DSH_ENHANCED_PLUGIN_SLUGS[@]}"; do
    if [[ "$source_mode" == 'local' ]]; then
      local plugin_path="$repo_root/plugins/$slug"
      if [[ ! -f "$plugin_path/package.json" ]]; then
        dsh_enhanced_fail 1 "缺少本地插件：$plugin_path"
        return $?
      fi
      targets+=("$plugin_path")
    else
      targets+=("@dsh-enhanced/$slug@$plugin_version")
    fi
  done

  printf '\n将安装以下顶层 bundle（core 由 personal-assistant 提供）：\n'
  printf '  - %s\n' "${targets[@]}"
  printf '\n安装到 DSH profile：\n'
  dsh_enhanced_run "$dry_run" dsh plugin --profile "$profile" add "${targets[@]}" || return $?
  printf '\n校验组合后的 profile：\n'
  if [[ "$dry_run" == '1' ]]; then
    dsh_enhanced_print_command dsh --profile "$profile" --dump-config
  else
    dsh --profile "$profile" --dump-config >/dev/null
    printf 'profile 配置校验通过。\n'
  fi

  local patch_path="$dsh_home/profiles/$profile/cordis.patch.yml"
  local lark_configured='0'
  if dsh_enhanced_lark_is_configured "$patch_path"; then lark_configured='1'; fi
  if [[ "$lark_mode" == 'auto' ]]; then
    if [[ "$assume_yes" == '1' ]]; then
      if [[ "$lark_configured" == '1' ]]; then lark_mode='keep'; else lark_mode='configure'; fi
    elif [[ -t 0 && -t 1 ]]; then
      lark_mode="$(dsh_enhanced_choose_lark_mode "$lark_configured")" || {
        dsh_enhanced_fail 2 '飞书选项无效。'
        return $?
      }
    elif [[ "$lark_configured" == '1' ]]; then
      lark_mode='keep'
    else
      dsh_enhanced_fail 2 '非交互环境无法选择飞书应用；请显式使用 --lark configure 或 --lark skip。'
      return $?
    fi
  fi
  dsh_enhanced_apply_lark "$lark_mode" "$profile" "$dsh_home" "$lark_configured" "$manage_service" "$dry_run" || return $?

  printf '\n安装流程完成。\n'
  printf '检查配置：dsh --profile %s --dump-config\n' "$profile"
  if [[ "$manage_service" == '1' && "$lark_mode" != 'skip' ]]; then
    printf '查看日志：tail -f %s/logs/%s-host.error.log\n' "$dsh_home" "$profile"
  fi
}
