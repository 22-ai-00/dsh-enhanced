#!/usr/bin/env bash

# Shared implementation for install-local.sh and install-npm.sh.
# This file is sourced by the two public entrypoints; do not execute it directly.

DSH_ENHANCED_DEFAULT_DSH_VERSION='0.1.0-rc.8'
DSH_ENHANCED_DEFAULT_PNPM_VERSION='11.7.0'
DSH_ENHANCED_CORE_PLUGIN_SLUGS=(
  'personal-assistant'
  # Read-only capability discovery and owner-approved staging are part of the
  # safe local core.  This adds no network client, daemon, or mutation tool to
  # an Agent; activation remains an owner-only local CLI action.
  'plugin-control-plane'
)

DSH_ENHANCED_LARK_PLUGIN_SLUGS=(
  'assistant-delivery'
  'credentials-keychain'
  'lark-channel'
)

DSH_ENHANCED_SUPERVISED_GROWTH_PLUGIN_SLUGS=(
  'traex-acp-provider'
  'assistant-evolution'
)

# This is retained only for users deliberately migrating an old all-in-one
# profile.  New installs choose a small scenario and add optional bundles only
# when the corresponding capability is needed.
DSH_ENHANCED_LEGACY_FULL_PLUGIN_SLUGS=(
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

Install a minimal, runnable dsh-enhanced personal-assistant scenario.

Options:
  --profile <name>          DSH profile (default: web)
  --scenario <name>         auto, core, lark, supervised, or full (default: auto)
  --mode <mode>             standard or supervised-growth (default: standard)
  --with <add-on>           Add coding, traex, health, heartbeat, events, or bridge (repeatable)
  --ack-existing-automations
                            Acknowledge active jobs may run when its scheduler is enabled
  --lark <mode>             auto, keep, configure, or skip (default: auto)
  --agent-tools <mode>      allow, preserve, or disable (default: preserve)
  --permission <preset>     preserve, workspace-write, auto, or danger-full-access (default: preserve)
  --confirm-dangerous-full-access
                            Required together with --permission danger-full-access
  --model-route <mode>      auto, verify, or skip (default: auto; a verify call may incur model cost)
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

Agent tool modes:
  allow      Authorize all tools mounted for local foreground Agents and for the
             exact preset/workspace/external Delivery identity, including dynamic
             skill/plugin tools. This is reachability, not installation.
  preserve   Leave any existing setup-managed tool rules exactly as they are.
  disable    Remove the setup-managed external Agent tool rules.

Scenarios:
  core       Local Web/direct core plus read-only plugin discovery.  No channel, daemon, or scheduler.
  lark       Core plus durable Delivery, OS credential storage, and Feishu/Lark onboarding.
  supervised Lark plus TraeX and approval-gated behavioural evolution. Requires a resident service.
  full       Compatibility migration set containing every previous default top-level bundle.
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

dsh_enhanced_validate_permission_default() {
  local settings_path="$1"
  [[ -f "$settings_path" ]] || return 0
  local preset
  preset="$(awk '
    BEGIN { in_permission = 0; permission_count = 0; value_count = 0; invalid = 0; value = "" }
    /^[[:space:]]*($|#)/ { next }
    /^[^[:space:]]/ {
      in_permission = 0
      if ($0 ~ /^permission[[:space:]]*:[[:space:]]*($|#)/) {
        permission_count += 1
        in_permission = 1
        next
      }
      if ($0 ~ /^permission[[:space:]]*:/ || $0 ~ /^["\047]permission["\047][[:space:]]*:/) invalid = 1
      next
    }
    in_permission && /^[[:space:]]+defaultPreset[[:space:]]*:[[:space:]]*/ {
      value_count += 1
      line = $0
      sub(/^[[:space:]]+defaultPreset[[:space:]]*:[[:space:]]*/, "", line)
      sub(/[[:space:]]+#.*$/, "", line)
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      value = line
    }
    in_permission && /^[[:space:]]+["\047]defaultPreset["\047][[:space:]]*:/ { invalid = 1 }
    END {
      if (invalid || permission_count > 1 || value_count > 1 || (value_count == 1 && value == "")) {
        print "__unparseable__"
      } else if (value_count == 0) {
        print "__absent__"
      } else {
        if ((value ~ /^".*"$/) || (value ~ /^\047.*\047$/)) value = substr(value, 2, length(value) - 2)
        print value
      }
    }
  ' "$settings_path")" || {
    dsh_enhanced_fail 2 "无法读取现有权限设置：$settings_path；不会覆盖用户设置。"
    return $?
  }
  case "$preset" in
    __absent__|workspace-write|auto|danger-full-access) return 0 ;;
    __unparseable__)
      dsh_enhanced_fail 2 "无法安全解析 $settings_path 中的 permission.defaultPreset；不会覆盖用户设置。"
      return $?
      ;;
    *)
      dsh_enhanced_fail 2 "现有 permission.defaultPreset=$preset 不受三档配置支持；不会覆盖用户设置。请先显式改为 workspace-write、auto 或 danger-full-access。"
      return $?
      ;;
  esac
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

dsh_enhanced_choose_scenario() {
  local configured="$1"
  printf '\n选择部署场景：\n' >&2
  printf '  1) 仅本机核心（推荐：安全、可立即通过 Web/direct 使用）\n' >&2
  if [[ "$configured" == '1' ]]; then
    printf '  2) 保留已配置的飞书常驻助理\n' >&2
  else
    printf '  2) 飞书/Lark 常驻助理（需要 owner onboarding）\n' >&2
  fi
  printf '  3) 受监督成长（飞书 + TraeX + owner 审批）\n' >&2
  printf '请选择 [1]：' >&2
  local choice
  IFS= read -r choice
  case "$choice" in
    ''|'1') printf 'core' ;;
    '2') printf 'lark' ;;
    '3') printf 'supervised' ;;
    *) return 2 ;;
  esac
}

dsh_enhanced_choose_model_route_mode() {
  printf '\n是否发送一次固定的最小请求来验证模型 route？这可能消耗 API 配额或订阅额度。\n' >&2
  printf '  1) 现在验证（推荐：首次接入模型后）\n' >&2
  printf '  2) 跳过，稍后执行安装器的 --model-route verify\n' >&2
  printf '请选择 [2]：' >&2
  local choice
  IFS= read -r choice
  case "$choice" in
    '1') printf 'verify' ;;
    ''|'2') printf 'skip' ;;
    *) return 2 ;;
  esac
}

dsh_enhanced_verify_model_route() {
  local mode="$1"
  local dry_run="$2"
  if [[ "$mode" == 'skip' ]]; then
    printf '模型 route：未发送请求；可稍后运行安装器并加 --model-route verify。\n'
    return 0
  fi
  if [[ "$dry_run" == '1' ]]; then
    printf '模型 route：将通过 DSH headless profile 发送一次固定的最小验证请求。\n'
    dsh_enhanced_print_command dsh --profile headless 'Reply with exactly DSH_ROUTE_READY and nothing else.'
    return 0
  fi

  printf '模型 route：正在发送最小验证请求。\n'
  local response
  if ! response="$(dsh --profile headless 'Reply with exactly DSH_ROUTE_READY and nothing else.' 2>&1)"; then
    printf '%s\n' "$response" >&2
    dsh_enhanced_fail 1 '模型 route 验证失败。请先在 DSH 中配置并登录可用模型，然后重新运行 --model-route verify。'
    return $?
  fi
  if [[ "$response" != *'DSH_ROUTE_READY'* ]]; then
    printf '%s\n' "$response" >&2
    dsh_enhanced_fail 1 '模型 route 没有返回预期的就绪标记；不会把当前部署标记为可用。'
    return $?
  fi
  printf '模型 route 验证通过。\n'
}

dsh_enhanced_check_web_port_available() {
  local port="$1"
  if ! [[ "$port" =~ ^[0-9]{1,5}$ ]] || (( port < 1 || port > 65535 )); then
    dsh_enhanced_fail 2 'Web 端口必须是 1..65535。'
    return $?
  fi
  if ! node -e "const net=require('node:net'); const port=Number(process.argv[1]); const server=net.createServer(); server.once('error', error => { process.stderr.write(String(error.message)); process.exit(1) }); server.listen({host:'127.0.0.1',port,exclusive:true}, () => server.close(() => process.exit(0)))" "$port"; then
    dsh_enhanced_fail 1 "Web 端口 127.0.0.1:$port 已被占用；请先停止冲突服务或为该 profile 配置独立端口。"
    return $?
  fi
  printf 'doctor：Web 端口 127.0.0.1:%s 可用。\n' "$port"
}

# The installer calls this before creating a brand-new profile and after it has
# composed the final profile.  It deliberately never starts an Agent or sends a
# model request; model readiness is an explicit separate choice.
dsh_enhanced_doctor() {
  local phase="$1"
  local profile="$2"
  local dsh_home="$3"
  local port="$4"
  local require_service="${5:-0}"
  case "$phase" in
    preflight)
      dsh_enhanced_check_web_port_available "$port"
      return $?
      ;;
    postflight) ;;
    *)
      dsh_enhanced_fail 2 "doctor 不支持的阶段：$phase"
      return $?
      ;;
  esac
  if ! dsh --profile "$profile" --dump-config >/dev/null; then
    dsh_enhanced_fail 1 "doctor：profile $profile 无法组合。"
    return $?
  fi
  local patch_path="$dsh_home/profiles/$profile/cordis.patch.yml"
  if ! dsh_enhanced_lark_is_configured "$patch_path"; then
    if [[ "$require_service" == '1' ]]; then
      dsh_enhanced_fail 1 "doctor：profile $profile 未配置已启用的飞书 channel，不能验证常驻服务。"
      return $?
    fi
    printf 'doctor：profile 配置可组合；未启用飞书常驻服务。\n'
    return 0
  fi
  if [[ "$require_service" != '1' ]]; then
    printf 'doctor：profile 配置可组合；飞书服务状态可用 doctor.sh --require-service 复查。\n'
    return 0
  fi
  case "$(uname -s)" in
    Linux)
      if ! systemctl --user is-active --quiet "dsh-profile-$profile.service"; then
        dsh_enhanced_fail 1 "doctor：systemd 服务 dsh-profile-$profile.service 未运行。"
        return $?
      fi
      if command -v loginctl >/dev/null 2>&1 && ! loginctl show-user "${USER:-}" -p Linger --value 2>/dev/null | grep -qx 'yes'; then
        dsh_enhanced_fail 1 "doctor：systemd user service 在注销后不会保持；运行 loginctl enable-linger ${USER:-<user>} 后重试。"
        return $?
      fi
      ;;
    Darwin)
      if ! launchctl print "gui/$(id -u)/ai.deepseek.dsh.profile.$profile" >/dev/null 2>&1; then
        dsh_enhanced_fail 1 "doctor：launchd 服务 ai.deepseek.dsh.profile.$profile 未注册。"
        return $?
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      if ! schtasks.exe /Query /TN "DSH profile $profile" >/dev/null 2>&1; then
        dsh_enhanced_fail 1 "doctor：Windows 计划任务 DSH profile $profile 未注册。"
        return $?
      fi
      ;;
  esac
  printf 'doctor：profile、channel 与常驻服务均已通过检查。\n'
}

dsh_enhanced_apply_permission_choice() {
  local preset="$1"
  local confirmed="$2"
  local profile="$3"
  local dsh_home="$4"
  local dry_run="$5"

  if [[ "$preset" == 'preserve' ]]; then
    printf '权限默认值：保留现有 Settings；新 profile 使用 bundle 的 workspace-write 安全默认值。\n'
    return 0
  fi
  if [[ "$preset" == 'danger-full-access' && "$confirmed" != '1' ]]; then
    dsh_enhanced_fail 2 '--permission danger-full-access 需要同时传入 --confirm-dangerous-full-access。'
    return $?
  fi
  local setup_bin="$dsh_home/profiles/$profile/node_modules/.bin/dsh-permission-setup"
  if [[ "$dry_run" != '1' && ! -x "$setup_bin" ]]; then
    dsh_enhanced_fail 1 "找不到安装后的 dsh-permission-setup：$setup_bin"
    return $?
  fi
  printf '权限默认值：显式设置为 %s。\n' "$preset"
  dsh_enhanced_run "$dry_run" "$setup_bin" --dsh-home "$dsh_home" --preset "$preset"
}

dsh_enhanced_apply_lark() {
  local mode="$1"
  local profile="$2"
  local dsh_home="$3"
  local configured="$4"
  local manage_service="$5"
  local dry_run="$6"
  local agent_tools="${7:-preserve}"
  local setup_bin="$dsh_home/profiles/$profile/node_modules/.bin/dsh-lark-setup"
  local agent_tools_flag=()
  case "$agent_tools" in
    allow) agent_tools_flag=(--allow-agent-tools) ;;
    disable) agent_tools_flag=(--disable-agent-tools) ;;
  esac

  case "$mode" in
    keep)
      if [[ "$configured" != '1' ]]; then
        dsh_enhanced_fail 2 '没有可保留的飞书配置；请使用 --lark configure 或 --lark skip。'
        return $?
      fi
      printf '\n飞书处理：保留当前应用配置。\n'
      if [[ "$dry_run" != '1' && ! -x "$setup_bin" ]]; then
        dsh_enhanced_fail 1 "找不到安装后的 dsh-lark-setup：$setup_bin"
        return $?
      fi
      # Refresh only the policy layer from the existing channel binding before
      # any restart; this path never reopens app/credential/owner onboarding.
      if [[ ${#agent_tools_flag[@]} -gt 0 ]]; then
        dsh_enhanced_run "$dry_run" "$setup_bin" --profile "$profile" --refresh-agent-policy \
          "${agent_tools_flag[@]}" || return $?
      fi
      if [[ "$manage_service" == '1' ]]; then
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
        dsh_enhanced_run "$dry_run" "$setup_bin" --profile "$profile" "${agent_tools_flag[@]+"${agent_tools_flag[@]}"}"
      else
        dsh_enhanced_run "$dry_run" "$setup_bin" --profile "$profile" --no-service "${agent_tools_flag[@]+"${agent_tools_flag[@]}"}"
      fi
      ;;
    skip)
      printf '\n飞书处理：本次跳过；现有配置不会被修改。\n'
      if [[ ${#agent_tools_flag[@]} -gt 0 ]]; then
        if [[ "$dry_run" != '1' && ! -x "$setup_bin" ]]; then
          dsh_enhanced_fail 1 "找不到安装后的 dsh-lark-setup：$setup_bin"
          return $?
        fi
        # Agent reachability is independent of channel onboarding. In skip
        # mode this only edits installer-managed Policy rules; it does not
        # enable or alter the Lark row and never installs/restarts a service.
        dsh_enhanced_run "$dry_run" "$setup_bin" --profile "$profile" --refresh-agent-policy \
          "${agent_tools_flag[@]}" || return $?
      fi
      ;;
    *)
      dsh_enhanced_fail 2 "不支持的飞书模式：$mode"
      return $?
      ;;
  esac
}

dsh_enhanced_apply_supervised_growth() {
  local profile="$1"
  local dsh_home="$2"
  local acknowledge="$3"
  local dry_run="$4"
  local setup_bin="$dsh_home/profiles/$profile/node_modules/.bin/dsh-supervised-growth-setup"
  local args=(--profile "$profile" --timeout-ms 300000)
  if [[ "$acknowledge" == '1' ]]; then args+=(--ack-existing-automations); fi

  printf '\nsupervised-growth：飞书 onboarding 完成后，正在运行有界且可审计的激活器。\n'
  if [[ "$dry_run" != '1' && ! -x "$setup_bin" ]]; then
    dsh_enhanced_fail 1 "找不到安装后的 dsh-supervised-growth-setup：$setup_bin"
    return $?
  fi
  dsh_enhanced_run "$dry_run" "$setup_bin" "${args[@]}"
}

dsh_enhanced_install() {
  local source_mode="$1"
  local repo_root="$2"
  shift 2

  local profile="${DSH_ENHANCED_PROFILE:-web}"
  local scenario='auto'
  local scenario_explicit='0'
  local deployment_mode='standard'
  local deployment_mode_explicit='0'
  local lark_mode='auto'
  local agent_tools_mode='preserve'
  local permission_preset='preserve'
  local confirm_dangerous_full_access='0'
  local model_route_mode='auto'
  local web_port="${DSH_ENHANCED_WEB_PORT:-3080}"
  local dsh_version="${DSH_VERSION:-$DSH_ENHANCED_DEFAULT_DSH_VERSION}"
  local plugin_version="${DSH_ENHANCED_VERSION:-latest}"
  local manage_service='1'
  local ack_existing_automations='0'
  local assume_yes='0'
  local dry_run='0'
  local add_ons=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --profile)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--profile 需要一个值。'; return $?; }
        profile="$2"
        shift 2
        ;;
      --scenario)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--scenario 需要一个值。'; return $?; }
        scenario="$2"
        scenario_explicit='1'
        shift 2
        ;;
      --mode)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--mode 需要一个值。'; return $?; }
        deployment_mode="$2"
        deployment_mode_explicit='1'
        shift 2
        ;;
      --with)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--with 需要一个值。'; return $?; }
        add_ons+=("$2")
        shift 2
        ;;
      --lark)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--lark 需要一个值。'; return $?; }
        lark_mode="$2"
        shift 2
        ;;
      --agent-tools)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--agent-tools 需要一个值。'; return $?; }
        agent_tools_mode="$2"
        shift 2
        ;;
      --permission)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--permission 需要一个值。'; return $?; }
        permission_preset="$2"
        shift 2
        ;;
      --confirm-dangerous-full-access)
        confirm_dangerous_full_access='1'
        shift
        ;;
      --model-route)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--model-route 需要一个值。'; return $?; }
        model_route_mode="$2"
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
      --ack-existing-automations)
        ack_existing_automations='1'
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
  case "$scenario" in auto|core|lark|supervised|full) ;; *)
    dsh_enhanced_fail 2 '--scenario 只能是 auto、core、lark、supervised 或 full。'
    return $?
  esac
  case "$deployment_mode" in standard|supervised-growth) ;; *)
    dsh_enhanced_fail 2 '--mode 只能是 standard 或 supervised-growth。'
    return $?
  esac
  case "$agent_tools_mode" in allow|preserve|disable) ;; *)
    dsh_enhanced_fail 2 '--agent-tools 只能是 allow、preserve 或 disable。'
    return $?
  esac
  case "$permission_preset" in preserve|workspace-write|auto|danger-full-access) ;; *)
    dsh_enhanced_fail 2 '--permission 只能是 preserve、workspace-write、auto 或 danger-full-access。'
    return $?
  esac
  if [[ "$permission_preset" == 'danger-full-access' && "$confirm_dangerous_full_access" != '1' ]]; then
    dsh_enhanced_fail 2 '--permission danger-full-access 需要同时传入 --confirm-dangerous-full-access。'
    return $?
  fi
  case "$model_route_mode" in auto|verify|skip) ;; *)
    dsh_enhanced_fail 2 '--model-route 只能是 auto、verify 或 skip。'
    return $?
  esac
  if [[ -z "$dsh_version" || "$dsh_version" == -* ]]; then
    dsh_enhanced_fail 2 'DSH 版本值不合法。'
    return $?
  fi
  if ! [[ "$web_port" =~ ^[0-9]{1,5}$ ]] || (( web_port < 1 || web_port > 65535 )); then
    dsh_enhanced_fail 2 'DSH_ENHANCED_WEB_PORT 必须是 1..65535。'
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

  if [[ ! -d "$dsh_home/profiles/$profile" ]]; then
    printf '\n安装前诊断：\n'
    if [[ "$dry_run" == '1' ]]; then
      printf 'doctor：将检查 Web 端口 127.0.0.1:%s 是否可用。\n' "$web_port"
    else
      dsh_enhanced_doctor preflight "$profile" "$dsh_home" "$web_port" || return $?
    fi
  fi
  dsh_enhanced_validate_permission_default "$dsh_home/settings.yaml" || return $?

  local existing_patch_path="$dsh_home/profiles/$profile/cordis.patch.yml"
  local existing_lark_configured='0'
  if dsh_enhanced_lark_is_configured "$existing_patch_path"; then existing_lark_configured='1'; fi

  # Keep the legacy --mode surface working, but make it an alias for the
  # explicit supervised scenario.  A scenario is selected before any package
  # is installed, so a fresh non-interactive machine never falls into an app
  # creation prompt or gains optional services by accident.
  if [[ "$deployment_mode" == 'supervised-growth' ]]; then
    if [[ "$scenario_explicit" == '1' && "$scenario" != 'supervised' ]]; then
      dsh_enhanced_fail 2 '--mode supervised-growth 只能与 --scenario supervised 一起使用。'
      return $?
    fi
    scenario='supervised'
  fi
  if [[ "$scenario" == 'auto' ]]; then
    if [[ "$lark_mode" == 'configure' || "$lark_mode" == 'keep' || "$existing_lark_configured" == '1' ]]; then
      scenario='lark'
    elif [[ "$assume_yes" == '1' || ! -t 0 || ! -t 1 ]]; then
      scenario='core'
    else
      scenario="$(dsh_enhanced_choose_scenario "$existing_lark_configured")" || {
        dsh_enhanced_fail 2 '部署场景选项无效。'
        return $?
      }
    fi
  fi
  if [[ "$scenario" == 'supervised' ]]; then
    if [[ "$deployment_mode_explicit" == '1' && "$deployment_mode" != 'supervised-growth' ]]; then
      dsh_enhanced_fail 2 '--scenario supervised 需要 --mode supervised-growth（或省略 --mode）。'
      return $?
    fi
    deployment_mode='supervised-growth'
  fi
  if [[ "$scenario" == 'core' && ( "$lark_mode" == 'configure' || "$lark_mode" == 'keep' ) ]]; then
    dsh_enhanced_fail 2 'core 场景不包含飞书；请改用 --scenario lark 或 --scenario supervised。'
    return $?
  fi
  if [[ "$deployment_mode" == 'supervised-growth' && "$lark_mode" == 'skip' ]]; then
    dsh_enhanced_fail 2 'supervised-growth 需要飞书 onboarding；不能与 --lark skip 一起使用。'
    return $?
  fi
  if [[ "$deployment_mode" == 'supervised-growth' && "$manage_service" != '1' ]]; then
    dsh_enhanced_fail 2 'supervised-growth 需要常驻服务；不能与 --no-service 一起使用。'
    return $?
  fi
  if [[ "$deployment_mode" == 'standard' && "$ack_existing_automations" == '1' ]]; then
    dsh_enhanced_fail 2 '--ack-existing-automations 仅适用于 --mode supervised-growth。'
    return $?
  fi
  if [[ "$scenario" == 'core' && "$agent_tools_mode" != 'preserve' ]]; then
    dsh_enhanced_fail 2 'core 场景没有飞书策略管理器；请先使用 --scenario lark，或保留 --agent-tools preserve。'
    return $?
  fi

  printf '安装来源：%s\n' "$source_mode"
  printf '目标 profile：%s\n' "$profile"
  printf '部署场景：%s\n' "$scenario"
  if [[ "$deployment_mode" != 'standard' ]]; then
    printf '部署模式：%s\n' "$deployment_mode"
  fi
  printf 'Agent 工具授权：%s\n' "$agent_tools_mode"
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

  local selected_slugs=()
  local slug
  local existing_slug
  dsh_enhanced_append_slug() {
    local candidate="$1"
    for existing_slug in "${selected_slugs[@]}"; do
      [[ "$existing_slug" == "$candidate" ]] && return 0
    done
    selected_slugs+=("$candidate")
  }
  for slug in "${DSH_ENHANCED_CORE_PLUGIN_SLUGS[@]}"; do dsh_enhanced_append_slug "$slug"; done
  case "$scenario" in
    lark)
      for slug in "${DSH_ENHANCED_LARK_PLUGIN_SLUGS[@]}"; do dsh_enhanced_append_slug "$slug"; done
      ;;
    supervised)
      for slug in "${DSH_ENHANCED_LARK_PLUGIN_SLUGS[@]}"; do dsh_enhanced_append_slug "$slug"; done
      for slug in "${DSH_ENHANCED_SUPERVISED_GROWTH_PLUGIN_SLUGS[@]}"; do dsh_enhanced_append_slug "$slug"; done
      ;;
    full)
      # Keep the modern safe core (including the discovery control plane) and
      # add every bundle that used to be selected by the legacy all-in-one
      # installer.
      for slug in "${DSH_ENHANCED_LEGACY_FULL_PLUGIN_SLUGS[@]}"; do dsh_enhanced_append_slug "$slug"; done
      ;;
  esac
  for slug in "${add_ons[@]}"; do
    case "$slug" in
      coding) dsh_enhanced_append_slug 'coding-subscription-provider' ;;
      traex) dsh_enhanced_append_slug 'traex-acp-provider' ;;
      health) dsh_enhanced_append_slug 'assistant-health' ;;
      heartbeat) dsh_enhanced_append_slug 'assistant-heartbeat' ;;
      events) dsh_enhanced_append_slug 'event-triggers' ;;
      bridge) dsh_enhanced_append_slug 'memory-wiki-bridge' ;;
      *)
        dsh_enhanced_fail 2 "不支持的 --with add-on：$slug；可选 coding、traex、health、heartbeat、events、bridge。"
        return $?
        ;;
    esac
  done

  local targets=()
  for slug in "${selected_slugs[@]}"; do
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

  printf '\n将安装以下顶层 bundle：\n'
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
  dsh_enhanced_apply_permission_choice "$permission_preset" "$confirm_dangerous_full_access" \
    "$profile" "$dsh_home" "$dry_run" || return $?

  local patch_path="$dsh_home/profiles/$profile/cordis.patch.yml"
  local lark_configured='0'
  if dsh_enhanced_lark_is_configured "$patch_path"; then lark_configured='1'; fi
  if [[ "$scenario" == 'core' ]]; then
    lark_mode='skip'
    printf '\n飞书处理：core 场景未安装 channel，已跳过。\n'
  elif [[ "$lark_mode" == 'auto' ]]; then
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
  if [[ "$scenario" != 'core' ]]; then
    dsh_enhanced_apply_lark "$lark_mode" "$profile" "$dsh_home" "$lark_configured" "$manage_service" "$dry_run" "$agent_tools_mode" || return $?
  fi
  if [[ "$deployment_mode" == 'supervised-growth' ]]; then
    dsh_enhanced_apply_supervised_growth "$profile" "$dsh_home" "$ack_existing_automations" "$dry_run" || return $?
  fi

  if [[ "$model_route_mode" == 'auto' ]]; then
    if [[ "$assume_yes" == '1' || ! -t 0 || ! -t 1 ]]; then
      model_route_mode='skip'
    else
      model_route_mode="$(dsh_enhanced_choose_model_route_mode)" || {
        dsh_enhanced_fail 2 '模型 route 验证选项无效。'
        return $?
      }
    fi
  fi
  dsh_enhanced_verify_model_route "$model_route_mode" "$dry_run" || return $?

  printf '\n最终 profile 自检：\n'
  if [[ "$dry_run" == '1' ]]; then
    dsh_enhanced_print_command dsh --profile "$profile" --dump-config
  else
    dsh --profile "$profile" --dump-config >/dev/null
    printf '最终 profile 配置校验通过。\n'
  fi
  printf '安装后健康检查：\n'
  if [[ "$dry_run" == '1' ]]; then
    printf 'doctor：将验证 profile 可以组合；飞书服务可用 doctor.sh --require-service 复查。\n'
  else
    dsh_enhanced_doctor postflight "$profile" "$dsh_home" "$web_port" || return $?
  fi

  printf '\n安装流程完成。\n'
  printf '检查配置：dsh --profile %s --dump-config\n' "$profile"
  if [[ "$scenario" == 'core' ]]; then
    printf '立即使用：dsh --profile %s\n' "$profile"
  fi
  if [[ "$manage_service" == '1' && "$lark_mode" != 'skip' ]]; then
    printf '查看日志：tail -f %s/logs/%s-host.error.log\n' "$dsh_home" "$profile"
  fi
}
