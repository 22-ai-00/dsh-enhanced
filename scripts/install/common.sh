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
  # Ordinary authenticated owner conversations should learn bounded T1
  # preferences without forcing a personal deployment to opt into the
  # Health/Heartbeat/Recovery operations stack.
  'preference-learning'
)

DSH_ENHANCED_SUPERVISED_GROWTH_PLUGIN_SLUGS=(
  'assistant-evolution'
  'assistant-evaluation'
  'assistant-growth-experiments'
  'assistant-heartbeat'
  'assistant-health'
  'assistant-recovery'
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
  --model <mode>            auto, configure, or skip (default: auto) — configure the deployment default model
  --model-provider <route>  Provider route to configure (deepseek-official, a custom gateway name, or traex-agent)
  --model-name <id>         Model id for the selected provider route
  --model-base-url <url>    Custom OpenAI-compatible gateway base URL (custom provider only)
  --model-api <protocol>    openai-completions (default), openai-responses, or anthropic-messages (custom provider only)
  --model-display-name <s>  Optional human label for a custom provider route
  --dsh-version <version>   DSH version to ensure (default: ${DSH_ENHANCED_DEFAULT_DSH_VERSION})
  --no-service              Do not install or restart the platform resident service
  --yes                     Choose the safe default without the installer menu
  --dry-run                 Print the complete plan without changing the machine
  -h, --help                Show this help
EOF
  if [[ "$source_mode" == 'npm' ]]; then
    cat <<'EOF'
  --plugin-version <value>  Version/tag applied to every @dsh-enhanced package (default: installer release)
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
  Capabilities are additive: core ⊂ lark ⊂ supervised.
  core       Local Web/direct core plus read-only plugin discovery.  No channel, daemon, or scheduler.
  lark       Core plus durable Delivery, bounded automatic preference learning,
             OS credential storage, and Feishu/Lark onboarding.
  supervised Lark plus Evaluation, deterministic Recovery, Health gates, and risk-tiered evolution.
             Recovery is model-free; TraeX remains an optional foreground model route (`--with traex`).
             Requires a resident service and installs content-free Health/bootstrap gates.
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
  printf '\n选择部署场景（能力逐档叠加：core ⊂ lark ⊂ supervised）：\n' >&2
  printf '  1) 仅本机核心（推荐：安全、可立即通过 Web/direct 使用）\n' >&2
  if [[ "$configured" == '1' ]]; then
    printf '  2) 保留已配置的飞书常驻助理\n' >&2
  else
    printf '  2) 飞书/Lark 常驻助理（需要 owner onboarding）\n' >&2
  fi
  printf '  3) 分级自治成长（飞书 + Recovery；低风险自动，高影响 owner 审批）\n' >&2
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

# Detect whether the effective profile already resolves a usable default model.
# We inspect the composed config rather than only settings.yaml so that a
# deployment relying on the built-in deepseek-official default is not treated as
# unconfigured; a route is "configured" when a provider/model pair resolves and
# the referenced credential is present in settings/.credentials.yaml/env.
dsh_enhanced_model_is_configured() {
  local profile="$1"
  local dsh_home="$2"
  local config
  config="$(dsh --profile "$profile" --dump-config 2>/dev/null)" || return 1
  printf '%s' "$config" | awk '
    BEGIN { in_adm = 0; provider = ""; model = "" }
    /^- id:/ { in_adm = 0 }
    /^- id:[[:space:]]+agent-default-model[[:space:]]*$/ { in_adm = 1; next }
    in_adm && /^[[:space:]]+provider:[[:space:]]+/ {
      line = $0; sub(/^[[:space:]]+provider:[[:space:]]+/, "", line); sub(/[[:space:]]+$/, "", line); provider = line
    }
    in_adm && /^[[:space:]]+model:[[:space:]]+/ {
      line = $0; sub(/^[[:space:]]+model:[[:space:]]+/, "", line); sub(/[[:space:]]+$/, "", line); model = line
    }
    END { exit !(provider != "" && model != "") }
  ' || return 1
}

dsh_enhanced_choose_model_mode() {
  local configured="$1"
  if [[ "$configured" == '1' ]]; then
    printf '\n检测到当前 profile 已能解析默认模型：\n' >&2
    printf '  1) 保留当前模型配置（推荐）\n' >&2
    printf '  2) 重新配置默认模型（DeepSeek 官方或自定义 OpenAI 兼容网关）\n' >&2
    printf '请选择 [1]：' >&2
    local choice
    IFS= read -r choice
    case "$choice" in
      ''|'1') printf 'skip' ;;
      '2') printf 'configure' ;;
      *) return 2 ;;
    esac
  else
    printf '\n当前 profile 尚未配置可用的默认模型：\n' >&2
    printf '  1) 现在配置默认模型（推荐）\n' >&2
    printf '  2) 稍后手动配置（编辑 settings.yaml 或运行 dsh-model-setup）\n' >&2
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

# Interactively collect the model route into the caller's named variables.  UI
# goes to stderr; nothing here echoes the API key.  Reads only the provider,
# model, base URL, api, and display-name; the secret is prompted separately and
# handed to dsh-model-setup through the environment, never as an argument.
dsh_enhanced_prompt_model_route() {
  local provider_var="$1"
  local model_var="$2"
  local base_url_var="$3"
  local api_var="$4"
  local display_var="$5"
  local traex_command=''
  traex_command="$(dsh_enhanced_detect_traex_command || true)"
  printf '\n配置默认模型：\n' >&2
  printf '  1) DeepSeek 官方（deepseek-official，只需 API Key）\n' >&2
  printf '  2) 自定义 OpenAI 兼容网关（provider + base URL + API Key）\n' >&2
  if [[ -n "$traex_command" ]]; then
    printf '  3) 本机 TraeX（traex-agent，复用已登录的 %s，无需 API Key）\n' "$traex_command" >&2
  fi
  printf '请选择 [1]：' >&2
  local kind
  IFS= read -r kind
  case "$kind" in
    ''|'1')
      printf -v "$provider_var" '%s' 'deepseek-official'
      printf 'DeepSeek 模型 [deepseek-v4-flash]：' >&2
      local model
      IFS= read -r model
      printf -v "$model_var" '%s' "${model:-deepseek-v4-flash}"
      printf -v "$base_url_var" '%s' ''
      printf -v "$api_var" '%s' ''
      printf -v "$display_var" '%s' ''
      ;;
    '2')
      printf 'Provider route 名称（如 super-relay）：' >&2
      local provider
      IFS= read -r provider
      if [[ -z "$provider" || "$provider" == 'deepseek-official' ]]; then
        dsh_enhanced_fail 2 '自定义网关需要一个不同于 deepseek-official 的 provider route 名称。'
        return $?
      fi
      if dsh_enhanced_is_agent_route "$provider"; then
        dsh_enhanced_fail 2 "$provider 是本机 agent route，请在菜单中选择 TraeX 选项，而不是自定义网关。"
        return $?
      fi
      printf -v "$provider_var" '%s' "$provider"
      printf '模型 id（如 glm5.2）：' >&2
      local model
      IFS= read -r model
      if [[ -z "$model" ]]; then
        dsh_enhanced_fail 2 '自定义网关需要一个模型 id。'
        return $?
      fi
      printf -v "$model_var" '%s' "$model"
      printf 'Base URL（如 https://gateway.example/v1）：' >&2
      local base_url
      IFS= read -r base_url
      if [[ "$base_url" != http://* && "$base_url" != https://* ]]; then
        dsh_enhanced_fail 2 'Base URL 必须以 http:// 或 https:// 开头。'
        return $?
      fi
      printf -v "$base_url_var" '%s' "$base_url"
      printf 'API 协议 [openai-completions]（可选 openai-responses、anthropic-messages）：' >&2
      local api
      IFS= read -r api
      case "${api:-openai-completions}" in
        openai-completions|openai-responses|anthropic-messages) printf -v "$api_var" '%s' "${api:-openai-completions}" ;;
        *) dsh_enhanced_fail 2 'API 协议只能是 openai-completions、openai-responses 或 anthropic-messages。'; return $? ;;
      esac
      printf '显示名（可选，直接回车跳过）：' >&2
      local display
      IFS= read -r display
      printf -v "$display_var" '%s' "$display"
      ;;
    '3')
      if [[ -z "$traex_command" ]]; then
        dsh_enhanced_fail 2 '本机未检测到 traex/trae-cli，无法选择 TraeX。'
        return $?
      fi
      # An agent route needs no model id, base URL, api, or display name; the
      # coding agent owns its own model catalog and credentials.
      printf -v "$provider_var" '%s' 'traex-agent'
      printf -v "$model_var" '%s' ''
      printf -v "$base_url_var" '%s' ''
      printf -v "$api_var" '%s' ''
      printf -v "$display_var" '%s' ''
      ;;
    *)
      return 2
      ;;
  esac
}

# Detect a locally installed TraeX / TRAE CLI executable so the model prompt can
# offer it as a zero-key default-model route.  Prints the resolved command name
# on stdout and returns 0 when found; returns 1 otherwise.
dsh_enhanced_detect_traex_command() {
  local candidate
  for candidate in traex trae-cli; do
    if command -v "$candidate" >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# The agent route (TraeX) is served by a local coding agent, not an API key.
# Mirror model-setup.ts's AGENT_ROUTES so the shell can branch without Node.
dsh_enhanced_is_agent_route() {
  [[ "$1" == 'traex-agent' ]]
}

# Ensure the provider bundle backing an agent route is installed into the
# profile before we enable and resolve it.  The flag path pre-selects the slug
# with every other bundle; this covers interactive selection made after the main
# install, and is a no-op when the bundle is already present.
dsh_enhanced_ensure_agent_bundle() {
  local provider="$1"
  local profile="$2"
  local dsh_home="$3"
  local source_mode="$4"
  local repo_root="$5"
  local plugin_version="$6"
  local dry_run="$7"
  dsh_enhanced_is_agent_route "$provider" || return 0
  local slug='traex-acp-provider'
  if [[ "$dry_run" != '1' && -d "$dsh_home/profiles/$profile/node_modules/@dsh-enhanced/$slug" ]]; then
    return 0
  fi
  local target
  if [[ "$source_mode" == 'local' ]]; then
    target="$repo_root/plugins/$slug"
    if [[ ! -f "$target/package.json" ]]; then
      dsh_enhanced_fail 1 "缺少本地插件：$target"
      return $?
    fi
  else
    target="@dsh-enhanced/$slug@$plugin_version"
  fi
  printf '\n为 traex-agent 安装 provider bundle：\n'
  dsh_enhanced_run "$dry_run" dsh plugin --profile "$profile" add "$target"
}


# Resolve how to invoke dsh-model-setup for a profile.  pnpm normally links a
# `.bin/dsh-model-setup` shim, but that shim is absent on profiles installed
# before the bin existed, and its exec bit can be lost on some layouts.  Prefer
# the shim, then fall back to running a provider package's bin script with node
# (which needs no exec bit and resolves the shared implementation the same way).
# Prints the launcher tokens, one per line; returns non-zero when none is found.
dsh_enhanced_resolve_model_setup() {
  local profile="$1"
  local dsh_home="$2"
  local base="$dsh_home/profiles/$profile/node_modules"
  local shim="$base/.bin/dsh-model-setup"
  if [[ -x "$shim" ]]; then
    printf '%s\n' "$shim"
    return 0
  fi
  local candidate
  for candidate in \
    "$base/@dsh-enhanced/personal-assistant/bin/dsh-model-setup.js" \
    "$base/@dsh-enhanced/assistant-policy/bin/dsh-model-setup.js"; do
    if [[ -f "$candidate" ]]; then
      printf 'node\n%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Restart an already-installed resident service so it reloads a just-changed
# profile/settings (e.g. a newly selected default model or enabled route). This
# only restarts; it never installs a unit. A missing unit is not fatal here —
# the Feishu step installs/starts it — so we warn and continue.
dsh_enhanced_restart_resident_service() {
  local profile="$1"
  local dry_run="$2"
  local platform="${DSH_ENHANCED_PLATFORM_OVERRIDE:-$(uname -s)}"
  case "$platform" in
    Darwin|darwin)
      local target="gui/$(id -u)/ai.deepseek.dsh.profile.$profile"
      if [[ "$dry_run" == '1' ]]; then
        printf '常驻服务：将重启以加载新模型配置。\n'
        dsh_enhanced_print_command launchctl kickstart -k "$target"
        return 0
      fi
      if launchctl print "$target" >/dev/null 2>&1; then
        printf '常驻服务：重启以加载新模型配置。\n'
        launchctl kickstart -k "$target" || printf '常驻服务：重启失败；请手动重启后再验证。\n'
      fi
      ;;
    Linux|linux)
      local target="dsh-profile-$profile.service"
      if [[ "$dry_run" == '1' ]]; then
        printf '常驻服务：将重启以加载新模型配置。\n'
        dsh_enhanced_print_command systemctl --user restart "$target"
        return 0
      fi
      if command -v systemctl >/dev/null 2>&1 && systemctl --user cat "$target" >/dev/null 2>&1; then
        printf '常驻服务：重启以加载新模型配置。\n'
        systemctl --user restart "$target" || printf '常驻服务：重启失败；请手动运行 systemctl --user restart %s。\n' "$target"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT|windows|win32)
      local target="DSH profile $profile"
      if [[ "$dry_run" == '1' ]]; then
        printf '常驻服务：将重启以加载新模型配置。\n'
        dsh_enhanced_print_command schtasks.exe /End /TN "$target"
        dsh_enhanced_print_command schtasks.exe /Run /TN "$target"
        return 0
      fi
      if schtasks.exe /Query /TN "$target" >/dev/null 2>&1; then
        printf '常驻服务：重启以加载新模型配置。\n'
        schtasks.exe /End /TN "$target" >/dev/null 2>&1 || true
        schtasks.exe /Run /TN "$target" >/dev/null 2>&1 || printf '常驻服务：重启失败；请手动重启计划任务。\n'
      fi
      ;;
  esac
}

# Run dsh-model-setup with the resolved route.  For an API-key route the key is
# read from the environment (DSH_ENHANCED_MODEL_API_KEY or the derived credential
# reference); in an interactive terminal we offer a hidden prompt and export it
# only for the child process.  When no key is available we still write the route
# selection and tell the owner where to supply the secret, rather than failing
# the install.  For an agent route (TraeX) there is no key: we write the default
# selection and enable the route bundle row in this profile's patch layer.
dsh_enhanced_apply_model() {
  local profile="$1"
  local dsh_home="$2"
  local provider="$3"
  local model="$4"
  local base_url="$5"
  local api="$6"
  local display_name="$7"
  local dry_run="$8"
  # Resolve the launcher once: the pnpm .bin shim when present, else `node
  # <package>/bin/dsh-model-setup.js`.  In dry-run we cannot inspect an
  # unrealized profile, so display the canonical shim path for the plan.
  local setup_launcher=()
  local setup_display="$dsh_home/profiles/$profile/node_modules/.bin/dsh-model-setup"
  if [[ "$dry_run" != '1' ]]; then
    # `mapfile` from a process substitution always exits 0, so capture the
    # resolver output and treat an empty result as the failure signal.
    local resolved_launcher=()
    mapfile -t resolved_launcher < <(dsh_enhanced_resolve_model_setup "$profile" "$dsh_home")
    if [[ ${#resolved_launcher[@]} -eq 0 ]]; then
      dsh_enhanced_fail 1 "找不到安装后的 dsh-model-setup（既无 .bin/dsh-model-setup，也无 personal-assistant/assistant-policy 的 bin 脚本）：$dsh_home/profiles/$profile"
      return $?
    fi
    setup_launcher=("${resolved_launcher[@]}")
    setup_display="${setup_launcher[*]}"
  fi

  local args=(--dsh-home "$dsh_home" --provider "$provider")
  [[ -n "$model" ]] && args+=(--model "$model")
  [[ -n "$base_url" ]] && args+=(--base-url "$base_url")
  [[ -n "$api" ]] && args+=(--api "$api")
  [[ -n "$display_name" ]] && args+=(--display-name "$display_name")

  printf '\n模型配置：provider=%s' "$provider"
  [[ -n "$model" ]] && printf ' model=%s' "$model"
  printf '\n'

  # Agent route (TraeX): no API key.  Write the default selection and flip the
  # route bundle row to enabled in this profile's patch layer.
  if dsh_enhanced_is_agent_route "$provider"; then
    args+=(--enable-in-profile "$profile")
    if [[ "$dry_run" == '1' ]]; then
      printf '模型配置：将写入 settings.yaml 并在 profile %s 的 patch 层启用 traex-acp-provider（无需 API Key）。\n' "$profile"
      dsh_enhanced_print_command "$setup_display" "${args[@]}"
      return 0
    fi
    "${setup_launcher[@]}" "${args[@]}" || return $?
    # A live login is required for the route to actually serve; probe it as a
    # non-fatal hint so a not-yet-logged-in TraeX does not fail the install.
    local traex_command=''
    traex_command="$(dsh_enhanced_detect_traex_command || true)"
    if [[ -n "$traex_command" ]]; then
      if ! "$traex_command" login status >/dev/null 2>&1; then
        printf '模型配置提示：%s 尚未确认登录；请在同一用户下运行 `%s login` 后再使用 traex-agent。\n' \
          "$traex_command" "$traex_command"
      fi
    else
      printf '模型配置提示：未在 PATH 找到 traex/trae-cli；请安装并登录后再使用 traex-agent。\n'
    fi
    return 0
  fi

  # Decide whether a key is (or can be made) available for this run.
  local have_key='0'
  local key_env_var='DSH_ENHANCED_MODEL_API_KEY'
  local derived_ref
  derived_ref="$(dsh_enhanced_derive_api_key_env "$provider")"
  if [[ -n "${!key_env_var:-}" || -n "${!derived_ref:-}" ]]; then
    have_key='1'
  fi

  if [[ "$dry_run" == '1' ]]; then
    if [[ "$have_key" == '1' ]]; then
      printf '模型配置：将写入 settings.yaml 并把环境中的 API Key 存入 .credentials.yaml。\n'
      dsh_enhanced_print_command "$setup_display" "${args[@]}" --store-key
    else
      printf '模型配置：将写入 settings.yaml；未检测到 API Key，稍后请设置 %s 或编辑 .credentials.yaml。\n' "$derived_ref"
      dsh_enhanced_print_command "$setup_display" "${args[@]}"
    fi
    return 0
  fi

  # Offer a hidden key prompt only in an interactive terminal and only when the
  # environment does not already carry one.  The value is exported solely for
  # the setup child and unset immediately afterwards; it never enters argv.
  if [[ "$have_key" != '1' && -t 0 && -t 1 ]]; then
    printf '为 %s 输入 API Key（直接回车跳过存储）：' "$derived_ref" >&2
    local secret=''
    IFS= read -rs secret || secret=''
    printf '\n' >&2
    if [[ -n "$secret" ]]; then
      DSH_ENHANCED_MODEL_API_KEY="$secret" "${setup_launcher[@]}" "${args[@]}" --store-key
      local status=$?
      unset secret
      return $status
    fi
  fi

  if [[ "$have_key" == '1' ]]; then
    "${setup_launcher[@]}" "${args[@]}" --store-key
  else
    "${setup_launcher[@]}" "${args[@]}"
    printf '模型配置：未存储 API Key；请设置环境变量 %s 或编辑 %s/.credentials.yaml 后再验证。\n' \
      "$derived_ref" "$dsh_home"
  fi
}

# Mirror deriveApiKeyEnv() in model-setup.ts so the shell can tell whether a
# credential reference is already present without launching Node.
dsh_enhanced_derive_api_key_env() {
  local provider="$1"
  if [[ "$provider" == 'deepseek-official' ]]; then
    printf 'DEEPSEEK_API_KEY'
    return 0
  fi
  local identifier
  identifier="$(printf '%s' "$provider" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')"
  [[ "$identifier" =~ ^[A-Z_] ]] || identifier="_$identifier"
  case "$identifier" in
    *_API_KEY) printf '%s' "$identifier" ;;
    *) printf '%s_API_KEY' "$identifier" ;;
  esac
}

dsh_enhanced_verify_model_route() {
  local mode="$1"
  local dry_run="$2"
  local profile="$3"
  local dsh_home="$4"
  if [[ "$mode" == 'skip' ]]; then
    printf '模型 route：未发送请求；可稍后运行安装器并加 --model-route verify。\n'
    return 0
  fi

  # The effective default provider is the settings.yaml user-layer selection,
  # which wins over any composed value at runtime.  An agent route (TraeX) only
  # has its adapter in the profile that enabled its bundle, and it never accepts
  # a headless one-shot prompt, so verify it structurally instead of calling a
  # model: confirm the adapter is registered in the target profile and that the
  # local agent reports a login.  This also avoids spending any model quota.
  local effective_provider
  effective_provider="$(dsh_enhanced_effective_default_provider "$dsh_home")"
  if dsh_enhanced_is_agent_route "$effective_provider"; then
    dsh_enhanced_verify_agent_route "$effective_provider" "$profile" "$dry_run"
    return $?
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

# Read the settings.yaml user-layer agent-default-model.provider, which is the
# selection the runtime actually resolves (it wins over the composed value).
# dsh-model-setup writes block-style YAML, but a hand-edited or older file may
# be flow-style (`{ agent-default-model: { provider: X, ... } }`); handle both
# so the verifier never misreads the default and picks the wrong route.
dsh_enhanced_effective_default_provider() {
  local dsh_home="$1"
  local settings_path="$dsh_home/settings.yaml"
  [[ -f "$settings_path" ]] || return 0
  local provider
  provider="$(awk '
    BEGIN { in_s = 0 }
    /^agent-default-model:[[:space:]]*$/ { in_s = 1; next }
    in_s && /^[^[:space:]]/ { in_s = 0 }
    in_s && /^[[:space:]]+provider:[[:space:]]+/ {
      line = $0; sub(/^[[:space:]]+provider:[[:space:]]+/, "", line); sub(/[[:space:]]+$/, "", line); print line; exit
    }
  ' "$settings_path")"
  if [[ -z "$provider" ]]; then
    # Flow-style fallback: match `agent-default-model: { ... provider: X ... }`
    # anywhere in the document. Kept deliberately narrow (a single unquoted
    # token) so it never guesses on complex documents.
    provider="$(grep -oE 'agent-default-model:[[:space:]]*\{[^{}]*provider:[[:space:]]*[^,}[:space:]]+' "$settings_path" \
      | grep -oE 'provider:[[:space:]]*[^,}[:space:]]+' | head -n1 \
      | sed -E 's/^provider:[[:space:]]*//')"
  fi
  printf '%s' "$provider"
}

# Verify an agent route without a model call: the adapter must be registered in
# the target profile, and the backing local agent must report a login.  Neither
# check spends model quota; both are the real prerequisites for the route.
dsh_enhanced_verify_agent_route() {
  local provider="$1"
  local profile="$2"
  local dry_run="$3"
  if [[ "$dry_run" == '1' ]]; then
    printf '模型 route：agent route %s 不发送模型请求；将校验 profile %s 已注册适配器并检查本机登录。\n' "$provider" "$profile"
    dsh_enhanced_print_command dsh --profile "$profile" --dump-config
    return 0
  fi
  printf '模型 route：agent route %s，改为结构化校验（不消耗模型额度）。\n' "$provider"

  # traex-agent is served by @dsh-enhanced/traex-acp-provider.
  local composed
  if ! composed="$(dsh --profile "$profile" --dump-config 2>&1)"; then
    printf '%s\n' "$composed" >&2
    dsh_enhanced_fail 1 "模型 route 验证失败：profile $profile 无法组合。"
    return $?
  fi
  if [[ "$composed" != *'@dsh-enhanced/traex-acp-provider'* ]]; then
    dsh_enhanced_fail 1 "模型 route 验证失败：profile $profile 未注册 traex-acp-provider 适配器；请先在该 profile 启用 traex-agent（安装器会自动启用，或运行 dsh-model-setup --provider traex-agent --enable-in-profile $profile）。"
    return $?
  fi

  local traex_command=''
  traex_command="$(dsh_enhanced_detect_traex_command || true)"
  if [[ -z "$traex_command" ]]; then
    dsh_enhanced_fail 1 '模型 route 验证失败：未在 PATH 找到 traex/trae-cli。'
    return $?
  fi
  local login_status
  if ! login_status="$("$traex_command" login status 2>&1)" || [[ "$login_status" != *'Logged in using Trae'* ]]; then
    printf '%s\n' "$login_status" >&2
    dsh_enhanced_fail 1 "模型 route 验证失败：$traex_command 未确认登录；请在同一 OS 用户下运行 \`$traex_command login\` 后重试。"
    return $?
  fi
  printf '模型 route 验证通过：traex-acp-provider 已在 profile %s 注册，且 %s 已登录。\n' "$profile" "$traex_command"
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

# A managed Linux channel promises to survive logout. Prepare that guarantee
# before opening Feishu OAuth so a missing user manager or an administrator-only
# linger policy cannot strand a successfully created cloud app. loginctl gets
# one non-interactive, unprivileged attempt. sudo is only run after a TTY user
# sees the exact fixed command and explicitly accepts it.
dsh_enhanced_confirm_sudo_linger() {
  local loginctl_path="$1"
  local current_uid="$2"
  local interaction_mode="${3:-detect}"
  if [[ "$interaction_mode" != 'force' && ( ! -t 0 || ! -t 1 ) ]]; then
    return 1
  fi
  printf '\nsystemd logout persistence 需要一次管理员授权。\n' >&2
  printf '唯一的提权动作：sudo %q enable-linger %q\n' "$loginctl_path" "$current_uid" >&2
  printf '现在通过 sudo 启用？[Y/n] ' >&2
  local choice=''
  if ! IFS= read -r choice; then return 1; fi
  case "$choice" in
    ''|y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# Never carry a PATH-selected executable across the sudo boundary. Common
# systemd distributions install these commands in one of the two root-managed
# system directories below. Other layouts can still use the printed manual
# command, but the installer will not elevate an arbitrary user-controlled
# path automatically.
dsh_enhanced_trusted_system_command() {
  local command_name="$1"
  local candidate=''
  for candidate in "/usr/bin/$command_name" "/bin/$command_name"; do
    if [[ -f "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

dsh_enhanced_prepare_linux_resident_service() {
  local dry_run="$1"
  local interaction_mode="${2:-detect}"
  case "${DSH_ENHANCED_PLATFORM_OVERRIDE:-$(uname -s)}" in
    Linux|linux) ;;
    *) return 0 ;;
  esac
  if [[ "$dry_run" == '1' ]]; then
    printf 'systemd：将在飞书授权前验证 user manager，并在无需提权时自动启用 logout persistence（lingering）。\n'
    return 0
  fi

  local loginctl_path
  local systemctl_path
  loginctl_path="$(command -v loginctl 2>/dev/null)" || {
    dsh_enhanced_fail 1 '飞书常驻服务需要 systemd-logind（找不到 loginctl）；尚未开始飞书授权。'
    return $?
  }
  systemctl_path="$(command -v systemctl 2>/dev/null)" || {
    dsh_enhanced_fail 1 '飞书常驻服务需要 systemd user manager（找不到 systemctl）；尚未开始飞书授权。'
    return $?
  }
  local current_uid
  current_uid="${EUID:-}"
  if ! [[ "$current_uid" =~ ^[0-9]+$ ]]; then
    dsh_enhanced_fail 1 '无法确定将运行飞书服务的当前 Linux UID；尚未开始飞书授权。'
    return $?
  fi

  local linger=''
  linger="$("$loginctl_path" show-user "$current_uid" --property=Linger --value 2>/dev/null || true)"
  if [[ "$linger" != 'yes' ]]; then
    printf 'systemd：正在为当前用户尝试无提权启用 logout persistence（lingering）。\n'
    if ! "$loginctl_path" --no-ask-password enable-linger "$current_uid" >/dev/null 2>&1; then
      local privileged_loginctl_path=''
      local sudo_path=''
      privileged_loginctl_path="$(dsh_enhanced_trusted_system_command loginctl 2>/dev/null || true)"
      sudo_path="$(dsh_enhanced_trusted_system_command sudo 2>/dev/null || true)"
      if [[ -z "$privileged_loginctl_path" || -z "$sudo_path" ]]; then
        dsh_enhanced_fail 1 '无法从受信任的系统目录自动执行 sudo/loginctl；请手工运行 `sudo loginctl enable-linger "$(id -u)"` 后重试。尚未开始飞书授权。'
        return $?
      fi
      if dsh_enhanced_confirm_sudo_linger "$privileged_loginctl_path" "$current_uid" "$interaction_mode"; then
        printf 'systemd：正在执行上面显示的唯一提权动作；密码由 sudo 直接读取，不会进入安装器。\n'
        if ! "$sudo_path" -- "$privileged_loginctl_path" enable-linger "$current_uid"; then
          dsh_enhanced_fail 1 'sudo 未能启用 lingering；请运行 `sudo loginctl enable-linger "$(id -u)"` 后重试。尚未开始飞书授权。'
          return $?
        fi
      else
        dsh_enhanced_fail 1 '系统要求管理员批准 lingering；请先运行 `sudo loginctl enable-linger "$(id -u)"`，再重新运行安装器。尚未开始飞书授权。'
        return $?
      fi
    fi
    linger="$("$loginctl_path" show-user "$current_uid" --property=Linger --value 2>/dev/null || true)"
    if [[ "$linger" != 'yes' ]]; then
      dsh_enhanced_fail 1 'loginctl 未确认 lingering 已启用；请运行 `sudo loginctl enable-linger "$(id -u)"` 后重试。尚未开始飞书授权。'
      return $?
    fi
    printf 'systemd：已为当前用户启用 logout persistence。\n'
  fi

  local standard_runtime_directory="/run/user/$current_uid"
  local runtime_owner=''
  if command -v stat >/dev/null 2>&1; then
    runtime_owner="$(stat -c '%u' "$standard_runtime_directory" 2>/dev/null || true)"
  fi
  if [[ -z "${XDG_RUNTIME_DIR:-}"
    && -d "$standard_runtime_directory"
    && ! -L "$standard_runtime_directory"
    && "$runtime_owner" == "$current_uid" ]]; then
    XDG_RUNTIME_DIR="$standard_runtime_directory"
    export XDG_RUNTIME_DIR
  fi
  local session_bus="$standard_runtime_directory/bus"
  local session_bus_owner=''
  if command -v stat >/dev/null 2>&1; then
    session_bus_owner="$(stat -c '%u' "$session_bus" 2>/dev/null || true)"
  fi
  if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}"
    && -S "$session_bus"
    && ! -L "$session_bus"
    && "$session_bus_owner" == "$current_uid" ]]; then
    DBUS_SESSION_BUS_ADDRESS="unix:path=$standard_runtime_directory/bus"
    export DBUS_SESSION_BUS_ADDRESS
  fi
  if ! "$systemctl_path" --user show-environment >/dev/null 2>&1; then
    dsh_enhanced_fail 1 'systemd user manager 不可连接；请以目标普通用户直接登录（不要通过 sudo/su），确认 `systemctl --user show-environment` 成功后重试。尚未开始飞书授权。'
    return $?
  fi
  printf 'systemd：user manager 与 logout persistence 已就绪。\n'
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
      if ! command -v systemctl >/dev/null 2>&1; then
        dsh_enhanced_fail 1 'doctor：找不到 systemctl，无法验证 Linux 常驻服务。'
        return $?
      fi
      if ! systemctl --user is-active --quiet "dsh-profile-$profile.service"; then
        dsh_enhanced_fail 1 "doctor：systemd 服务 dsh-profile-$profile.service 未运行。"
        return $?
      fi
      if ! command -v loginctl >/dev/null 2>&1; then
        dsh_enhanced_fail 1 'doctor：找不到 loginctl，无法验证 Linux logout persistence。'
        return $?
      fi
      if ! loginctl show-user "$EUID" --property=Linger --value 2>/dev/null | grep -qx 'yes'; then
        dsh_enhanced_fail 1 'doctor：systemd user service 在注销后不会保持；运行 `sudo loginctl enable-linger "$(id -u)"` 后重试。'
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
  local model_mode='auto'
  local model_provider=''
  local model_name=''
  local model_base_url=''
  local model_api=''
  local model_display_name=''
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
      --model)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--model 需要一个值。'; return $?; }
        model_mode="$2"
        shift 2
        ;;
      --model-provider)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--model-provider 需要一个值。'; return $?; }
        model_provider="$2"
        shift 2
        ;;
      --model-name)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--model-name 需要一个值。'; return $?; }
        model_name="$2"
        shift 2
        ;;
      --model-base-url)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--model-base-url 需要一个值。'; return $?; }
        model_base_url="$2"
        shift 2
        ;;
      --model-api)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--model-api 需要一个值。'; return $?; }
        model_api="$2"
        shift 2
        ;;
      --model-display-name)
        [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--model-display-name 需要一个值。'; return $?; }
        model_display_name="$2"
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
  case "$model_mode" in auto|configure|skip) ;; *)
    dsh_enhanced_fail 2 '--model 只能是 auto、configure 或 skip。'
    return $?
  esac
  if [[ -n "$model_api" ]]; then
    case "$model_api" in openai-completions|openai-responses|anthropic-messages) ;; *)
      dsh_enhanced_fail 2 '--model-api 只能是 openai-completions、openai-responses 或 anthropic-messages。'
      return $?
    esac
  fi
  # A custom gateway route needs a base URL; the built-in deepseek-official route
  # and local agent routes (TraeX) must not carry gateway transport fields.  Fail
  # loud before any install work.
  if dsh_enhanced_is_agent_route "$model_provider"; then
    if [[ -n "$model_base_url" || -n "$model_api" || -n "$model_display_name" ]]; then
      dsh_enhanced_fail 2 "--model-base-url/--model-api/--model-display-name 不适用于本机 agent route $model_provider。"
      return $?
    fi
  elif [[ -n "$model_provider" && "$model_provider" != 'deepseek-official' ]]; then
    if [[ -z "$model_base_url" ]]; then
      dsh_enhanced_fail 2 '自定义模型 provider 需要 --model-base-url（以 http:// 或 https:// 开头）。'
      return $?
    fi
  elif [[ -n "$model_base_url" || -n "$model_api" || -n "$model_display_name" ]]; then
    dsh_enhanced_fail 2 '--model-base-url/--model-api/--model-display-name 仅适用于自定义 provider，不能用于 deepseek-official。'
    return $?
  fi
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
  # Selecting the TraeX agent route as the default model pulls in its provider
  # bundle so the route can be enabled and resolve in the same run.  Interactive
  # selection happens after install and is handled on the spot in apply_model.
  if dsh_enhanced_is_agent_route "$model_provider"; then
    dsh_enhanced_append_slug 'traex-acp-provider'
  fi

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
    if [[ "$lark_mode" == 'configure' && "$dry_run" != '1' && ( ! -t 0 || ! -t 1 ) ]]; then
      dsh_enhanced_fail 1 '飞书向导需要交互式终端；尚未修改 lingering 或开始飞书授权。请直接运行脚本，或使用 --lark skip。'
      return $?
    fi
    if [[ "$manage_service" == '1' && "$lark_mode" != 'skip' ]]; then
      dsh_enhanced_prepare_linux_resident_service "$dry_run" || return $?
    fi
    dsh_enhanced_apply_lark "$lark_mode" "$profile" "$dsh_home" "$lark_configured" "$manage_service" "$dry_run" "$agent_tools_mode" || return $?
  fi
  if [[ "$deployment_mode" == 'supervised-growth' ]]; then
    dsh_enhanced_apply_supervised_growth "$profile" "$dsh_home" "$ack_existing_automations" "$dry_run" || return $?
  fi

  # Configure the deployment default model before offering a route check.  An
  # explicit --model-provider is a non-interactive configure; otherwise --model
  # (default auto) decides, detecting whether the composed profile already
  # resolves a usable provider/model so a returning owner is not re-prompted.
  if [[ -n "$model_provider" ]]; then
    model_mode='configure'
  fi
  local model_configured='0'
  if [[ "$dry_run" != '1' ]] && dsh_enhanced_model_is_configured "$profile" "$dsh_home"; then
    model_configured='1'
  fi
  if [[ "$model_mode" == 'auto' ]]; then
    if [[ "$assume_yes" == '1' || ! -t 0 || ! -t 1 ]]; then
      # Non-interactive runs never invent a route: keep whatever the profile
      # already composes (the built-in deepseek-official default at minimum).
      model_mode='skip'
    else
      model_mode="$(dsh_enhanced_choose_model_mode "$model_configured")" || {
        dsh_enhanced_fail 2 '模型配置选项无效。'
        return $?
      }
    fi
  fi
  if [[ "$model_mode" == 'configure' ]]; then
    if [[ -z "$model_provider" ]]; then
      if [[ "$dry_run" == '1' || ( ! -t 0 || ! -t 1 ) ]]; then
        # Without an explicit --model-provider there is nothing to write in a
        # non-interactive or dry-run configure; guide the owner to the flags.
        dsh_enhanced_fail 2 '非交互配置模型需要 --model-provider（自定义网关还需 --model-name 与 --model-base-url）。'
        return $?
      fi
      dsh_enhanced_prompt_model_route model_provider model_name model_base_url model_api model_display_name || {
        dsh_enhanced_fail 2 '模型配置输入无效。'
        return $?
      }
    fi
    # An agent route chosen interactively (or after the main install set) may
    # not have had its provider bundle selected above; ensure it is present.
    dsh_enhanced_ensure_agent_bundle "$model_provider" "$profile" "$dsh_home" \
      "$source_mode" "$repo_root" "$plugin_version" "$dry_run" || return $?
    dsh_enhanced_apply_model "$profile" "$dsh_home" "$model_provider" "$model_name" \
      "$model_base_url" "$model_api" "$model_display_name" "$dry_run" || return $?
    # A resident service is already running the pre-change profile; enabling a
    # new route (traex bundle) or changing the default model only takes effect
    # after it reloads. Restart it before the route check and postflight so both
    # observe the intended model rather than the stale one.
    if [[ "$manage_service" == '1' && "$lark_mode" != 'skip' ]]; then
      dsh_enhanced_restart_resident_service "$profile" "$dry_run" || return $?
    fi
  else
    printf '\n模型配置：本次跳过；使用 profile 已组合的默认模型。\n'
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
  dsh_enhanced_verify_model_route "$model_route_mode" "$dry_run" "$profile" "$dsh_home" || return $?

  printf '\n最终 profile 自检：\n'
  if [[ "$dry_run" == '1' ]]; then
    dsh_enhanced_print_command dsh --profile "$profile" --dump-config
  else
    dsh --profile "$profile" --dump-config >/dev/null
    printf '最终 profile 配置校验通过。\n'
  fi
  printf '安装后健康检查：\n'
  local require_service='0'
  if [[ "$manage_service" == '1' && "$lark_mode" != 'skip' ]]; then
    require_service='1'
  fi
  if [[ "$dry_run" == '1' ]]; then
    if [[ "$require_service" == '1' ]]; then
      printf 'doctor：将验证 profile、飞书 channel、常驻服务与 Linux logout persistence。\n'
    else
      printf 'doctor：将验证 profile 可以组合；飞书服务可用 doctor.sh --require-service 复查。\n'
    fi
  else
    dsh_enhanced_doctor postflight "$profile" "$dsh_home" "$web_port" "$require_service" || return $?
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
