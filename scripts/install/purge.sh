#!/usr/bin/env bash
set -euo pipefail

# scripts/install/purge.sh — DSH enhanced 插件集合的彻底卸载（单文件救机脚本）。
#
# 这是 mutable-main 运维脚本（始终取 main 分支最新版本），不是 install-npm.sh
# 那样的供应链引导路径，因此不做 release pin/sha256 校验。
#
# 优先委托全局 dsh-rsi（随插件集合一起安装，实现完整、带单测）；
# 机器上没有 dsh-rsi 时（崩溃后/手动删过），使用本文件内联的精简实现：
# 先自动停用受管常驻服务 → 停服后复检残留进程（可证明归属本 home 的 dsh 进程交互/--yes
# 终止，无法证明归属的 fail-closed）→ tar.gz 备份 → 删除 profile/DSH home/生命周期残留
# → 清理外部凭据 → 可选卸载全局 host。local checkout 源码绝不删除。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/purge.sh \
#     | bash -s -- --yes
#   bash purge.sh [--dsh-home PATH] [--profile NAME] [--no-backup] [--keep-keychain]
#                 [--remove-host] [--dry-run] [--yes] [-h|--help]

PURGE_DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PURGE_PROFILE=''
PURGE_BACKUP='1'
PURGE_KEEP_KEYCHAIN='0'
PURGE_REMOVE_HOST='0'
PURGE_DRY_RUN='0'
PURGE_ASSUME_YES='0'

purge_usage() {
  cat <<'EOF'
用法：purge.sh [选项]

彻底卸载 DSH enhanced 插件集合（默认先备份 ~/.dsh 再删除）。

选项：
  --dsh-home <path>   DSH home（默认 $DSH_HOME，否则 ~/.dsh）
  --profile <name>    仅清除单个 profile（默认全量清除整个 DSH home）
  --no-backup         删除前不生成 tar.gz 备份
  --keep-keychain     保留 macOS Keychain / Linux Secret Service 受管凭据
  --remove-host       同时卸载全局 @deepseek-ai/dsh（仅全量；默认保留）
  --dry-run           只打印将执行的动作，不做任何修改
  --yes               跳过交互确认；自动终止已证明归属本 home 的残留 dsh 进程
  -h, --help          显示本帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsh-home)
      [[ $# -ge 2 ]] || { printf 'purge.sh: --dsh-home 需要一个值。\n' >&2; exit 2; }
      PURGE_DSH_HOME="$2"; shift 2 ;;
    --profile)
      [[ $# -ge 2 ]] || { printf 'purge.sh: --profile 需要一个值。\n' >&2; exit 2; }
      PURGE_PROFILE="$2"; shift 2 ;;
    --no-backup) PURGE_BACKUP='0'; shift ;;
    --keep-keychain) PURGE_KEEP_KEYCHAIN='1'; shift ;;
    --remove-host) PURGE_REMOVE_HOST='1'; shift ;;
    --dry-run) PURGE_DRY_RUN='1'; shift ;;
    --yes|-y) PURGE_ASSUME_YES='1'; shift ;;
    -h|--help) purge_usage; exit 0 ;;
    --) shift; break ;;
    *) printf 'purge.sh: 无法识别的参数：%s（用 -h 查看用法）\n' "$1" >&2; exit 2 ;;
  esac
done

# 完整实现始终以 dsh-rsi 为准。全局 bin 可能不在 PATH（手动删过 PATH / 用别的 node prefix），
# 因此按多路径定位，兼容新旧包名（@dsh-enhanced/dsh-rsi-cli 与 @dsh-enhanced/rsi-cli）；
# 只有所有路径都找不到时才降级到内联实现。
purge_locate_rsi() {
  local purge_prefix purge_cand purge_prefix_js
  purge_prefix="$(npm prefix -g 2>/dev/null || true)"
  for purge_cand in \
    "$(command -v dsh-rsi 2>/dev/null || true)" \
    "${purge_prefix:+$purge_prefix/bin/dsh-rsi}"; do
    [[ -n "$purge_cand" && -e "$purge_cand" ]] && { printf '%s\n' "$purge_cand"; return 0; }
  done
  # .js 入口（包名路径）：需用 node 执行。
  for purge_prefix_js in \
    "${purge_prefix:+$purge_prefix/lib/node_modules/@dsh-enhanced/dsh-rsi-cli/bin/dsh-rsi.js}" \
    "${purge_prefix:+$purge_prefix/lib/node_modules/@dsh-enhanced/rsi-cli/bin/dsh-rsi.js}"; do
    [[ -n "$purge_prefix_js" && -e "$purge_prefix_js" ]] && { printf 'node %s\n' "$purge_prefix_js"; return 0; }
  done
  return 1
}

if purge_rsi_found="$(purge_locate_rsi)"; then
  purge_rsi_args=(--dsh-home "$PURGE_DSH_HOME")
  [[ -n "$PURGE_PROFILE" ]] && purge_rsi_args+=(--profile "$PURGE_PROFILE")
  [[ "$PURGE_BACKUP" == '0' ]] && purge_rsi_args+=(--no-backup)
  [[ "$PURGE_KEEP_KEYCHAIN" == '1' ]] && purge_rsi_args+=(--keep-keychain)
  [[ "$PURGE_REMOVE_HOST" == '1' ]] && purge_rsi_args+=(--remove-host)
  [[ "$PURGE_DRY_RUN" == '1' ]] && purge_rsi_args+=(--dry-run)
  purge_rsi_args+=(--yes)
  # shellcheck disable=SC2086
  set -- $purge_rsi_found
  exec "$@" purge "${purge_rsi_args[@]+"${purge_rsi_args[@]}"}"
fi

printf 'purge.sh: 未找到全局 dsh-rsi（已查 PATH、npm prefix bin 与新旧包名路径），使用内联精简实现（建议日后安装插件集合获得完整 dsh-rsi）。\n' >&2

case "$(uname -s)" in
  Darwin) PURGE_PLATFORM='darwin' ;;
  Linux) PURGE_PLATFORM='linux' ;;
  *) printf 'purge.sh: 仅支持 macOS 与 Linux，当前平台：%s\n' "$(uname -s)" >&2; exit 1 ;;
esac

if [[ -n "$PURGE_PROFILE" && "$PURGE_REMOVE_HOST" == '1' ]]; then
  printf 'purge.sh: --remove-host 只能在全量 purge（不指定 --profile）时使用。\n' >&2
  exit 2
fi
if [[ ! -d "$PURGE_DSH_HOME" ]]; then
  printf 'purge.sh: DSH home 不存在：%s（没有可清除的内容）。\n' "$PURGE_DSH_HOME"
  exit 0
fi
if [[ -n "$PURGE_PROFILE" && ! -d "$PURGE_DSH_HOME/profiles/$PURGE_PROFILE" ]]; then
  printf 'purge.sh: profile 不存在：%s（DSH home：%s）\n' "$PURGE_PROFILE" "$PURGE_DSH_HOME" >&2
  exit 1
fi

purge_run() {
  if [[ "$PURGE_DRY_RUN" == '1' ]]; then
    printf '  [dry-run] $'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# --- 交互确认（--yes / 非交互终端跳过由调用方负责；这里要求显式输入 purge） ---
if [[ "$PURGE_ASSUME_YES" != '1' && "$PURGE_DRY_RUN" != '1' ]]; then
  if [[ -t 0 ]]; then
    if [[ -n "$PURGE_PROFILE" ]]; then
      purge_target_desc="profile $PURGE_PROFILE"
    else
      purge_target_desc="整个 DSH home（$PURGE_DSH_HOME）"
    fi
    printf '即将彻底删除 %s，且默认先备份。输入 purge 后回车继续：' "$purge_target_desc"
    read -r PURGE_ANSWER
    [[ "$PURGE_ANSWER" == 'purge' ]] || { printf '已取消。\n'; exit 1; }
  else
    printf 'purge.sh: 非交互环境需要 --yes 才会执行真实删除。\n' >&2
    exit 2
  fi
fi

# --- 1. 枚举目标 profile ---
PURGE_PROFILES=()
if [[ -n "$PURGE_PROFILE" ]]; then
  PURGE_PROFILES=("$PURGE_PROFILE")
elif [[ -d "$PURGE_DSH_HOME/profiles" ]]; then
  for purge_entry in "$PURGE_DSH_HOME"/profiles/*; do
    [[ -d "$purge_entry" ]] || continue
    PURGE_PROFILES+=("$(basename "$purge_entry")")
  done
fi

# --- 2. 先停用并注销受管常驻服务（受管 host 自动停，不再阻塞用户） ---
for purge_p in "${PURGE_PROFILES[@]+"${PURGE_PROFILES[@]}"}"; do
  if [[ "$PURGE_PLATFORM" == 'darwin' ]]; then
    purge_label="ai.deepseek.dsh.profile.$purge_p"
    purge_plist="$HOME/Library/LaunchAgents/$purge_label.plist"
    purge_run launchctl bootout "gui/$(id -u)/$purge_label" || true
    [[ -e "$purge_plist" ]] && purge_run rm -f "$purge_plist"
  else
    purge_unit="dsh-profile-$purge_p.service"
    purge_unit_path="$HOME/.config/systemd/user/$purge_unit"
    purge_run systemctl --user disable --now "$purge_unit" 2>/dev/null || true
    purge_run systemctl --user reset-failed "$purge_unit" 2>/dev/null || true
    # fail-closed：仅当文件内容确为受管 renderer unit 才删除。
    if [[ -f "$purge_unit_path" ]] \
      && grep -q 'DeepSeek Harness profile' "$purge_unit_path" \
      && grep -q -- "--profile $purge_p " "$purge_unit_path" \
      && grep -q -- '--no-open' "$purge_unit_path"; then
      purge_run rm -f "$purge_unit_path"
      [[ -d "$purge_unit_path.d" ]] && purge_run rm -rf "$purge_unit_path.d"
    elif [[ -f "$purge_unit_path" ]]; then
      printf 'purge.sh: 服务文件内容非受管 unit，保留：%s\n' "$purge_unit_path" >&2
    fi
    if [[ "$PURGE_DRY_RUN" != '1' ]]; then systemctl --user daemon-reload 2>/dev/null || true; fi
  fi
done

# --- 3. 停服后复检残留进程，分类终止 ---
# self(dsh-rsi/purge.sh) 跳过；proven=命令行带 --profile 且是 dsh 操作，可终止；
# foreign=命令行带 --profile 但无法证明是 dsh 操作 → fail-closed，绝不自动杀。
PURGE_TERMINATE_PIDS=()
purge_foreign_list=''
for purge_p in "${PURGE_PROFILES[@]+"${PURGE_PROFILES[@]}"}"; do
  if purge_matches="$(pgrep -f "[-]-profile $purge_p" 2>/dev/null || true)"; then
    while IFS= read -r purge_pid; do
      [[ -n "$purge_pid" ]] || continue
      purge_cmd="$(ps -p "$purge_pid" -o command= 2>/dev/null || printf 'PID %s' "$purge_pid")"
      case "$purge_cmd" in
        *dsh-rsi*|*rsi-cli*|*purge.sh*) continue ;;
      esac
      if printf '%s' "$purge_cmd" | grep -qE '(^|[[:space:]])(dsh|dsh-rsi)([[:space:]]|$)|dsh[[:space:]]+plugin'; then
        PURGE_TERMINATE_PIDS+=("$purge_pid")
      else
        purge_foreign_list="$purge_foreign_list  PID $purge_pid: $purge_cmd"$'\n'
      fi
    done <<< "$purge_matches"
  fi
done

if [[ -n "$purge_foreign_list" ]]; then
  printf 'purge.sh: 发现无法证明归属本 DSH home 的进程，为避免误杀已中止（请手工确认后再 purge）：\n%s' "$purge_foreign_list" >&2
  exit 1
fi

# 终止 proven 残留进程：先 TERM，轮询 5 秒，仍在则 KILL；复检时重新验证命令行含 dsh，防 PID reuse。
purge_terminate_procs() {
  local purge_deadline purge_alive purge_now cmd
  [[ "${#PURGE_TERMINATE_PIDS[@]}" -eq 0 ]] && return 0
  [[ "$PURGE_DRY_RUN" == '1' ]] && return 0
  kill -TERM "${PURGE_TERMINATE_PIDS[@]}" 2>/dev/null || true
  purge_deadline=$((SECONDS + 5))
  while (( SECONDS < purge_deadline )); do
    purge_alive=()
    for purge_pid in "${PURGE_TERMINATE_PIDS[@]}"; do
      if ps -p "$purge_pid" -o command= >/dev/null 2>&1; then purge_alive+=("$purge_pid"); fi
    done
    [[ "${#purge_alive[@]}" -eq 0 ]] && return 0
    sleep 0.2
  done
  purge_now=()
  for purge_pid in "${PURGE_TERMINATE_PIDS[@]}"; do
    cmd="$(ps -p "$purge_pid" -o command= 2>/dev/null || true)"
    [[ -n "$cmd" ]] && printf '%s' "$cmd" | grep -q 'dsh' && purge_now+=("$purge_pid")
  done
  [[ "${#purge_now[@]}" -gt 0 ]] && kill -KILL "${purge_now[@]}" 2>/dev/null || true
}

if [[ "${#PURGE_TERMINATE_PIDS[@]}" -gt 0 ]]; then
  printf 'purge.sh: 发现以下指向本 profile 的残留 dsh 进程（可能正在执行 plugin 操作）：\n'
  for purge_pid in "${PURGE_TERMINATE_PIDS[@]}"; do
    printf '  PID %s: %s\n' "$purge_pid" "$(ps -p "$purge_pid" -o command= 2>/dev/null || true)"
  done
  if [[ "$PURGE_DRY_RUN" == '1' ]]; then
    printf '  [dry-run] 不实际终止上述进程。\n'
  elif [[ "$PURGE_ASSUME_YES" == '1' ]]; then
    purge_terminate_procs
  elif [[ -t 0 ]]; then
    printf '终止这些进程并继续 purge？输入 yes 继续，其它取消：'
    read -r purge_kill_ans
    [[ "$purge_kill_ans" == 'yes' ]] || { printf '已取消。\n'; exit 1; }
    purge_terminate_procs
  else
    printf 'purge.sh: 非交互环境下发现残留 dsh 进程，需 --yes 自动终止，已中止。\n' >&2
    exit 1
  fi
  # 终止后复检：确认这些 PID 已退出（或身份已变），避免在锁残留状态下备份。
  for purge_pid in "${PURGE_TERMINATE_PIDS[@]}"; do
    if ps -p "$purge_pid" -o command= >/dev/null 2>&1; then
      printf 'purge.sh: PID %s 未能终止，已中止（备份前请手工确认）。\n' "$purge_pid" >&2
      exit 1
    fi
  done
fi

# --- 4. 备份（单 profile 也备份整个 home） ---
PURGE_ARCHIVE=''
if [[ "$PURGE_BACKUP" == '1' ]]; then
  purge_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  PURGE_ARCHIVE="$HOME/dsh-purge-backup-$purge_stamp.tar.gz"
  purge_parent="$(dirname "$PURGE_DSH_HOME")"
  purge_base="$(basename "$PURGE_DSH_HOME")"
  purge_run tar -czf "$PURGE_ARCHIVE" -C "$purge_parent" "$purge_base"
  if [[ "$PURGE_DRY_RUN" != '1' ]]; then
    chmod 600 "$PURGE_ARCHIVE"
    [[ -s "$PURGE_ARCHIVE" ]] || { printf 'purge.sh: 备份归档为空，已中止：%s\n' "$PURGE_ARCHIVE" >&2; exit 1; }
    printf '备份：%s\n' "$PURGE_ARCHIVE"
  else
    printf '备份：将生成 %s\n' "$PURGE_ARCHIVE"
  fi
else
  printf '备份：已跳过（--no-backup）\n'
fi

# --- 5. 外部凭据（journal 权威反查；node 随全局 dsh 必然存在） ---
if [[ "$PURGE_KEEP_KEYCHAIN" != '1' ]]; then
  if ! command -v node >/dev/null 2>&1; then
    printf 'purge.sh: 找不到 node，跳过外部凭据清理；文件仍会删除，凭据请稍后用 dsh-rsi purge 复查。\n' >&2
  else
    PURGE_DSH_HOME="$PURGE_DSH_HOME" PURGE_WANT_PROFILE="$PURGE_PROFILE" \
    PURGE_PLATFORM="$PURGE_PLATFORM" PURGE_DRY_RUN="$PURGE_DRY_RUN" node <<'PURGE_NODE'
const { spawnSync } = require('node:child_process');
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const home = process.env.PURGE_DSH_HOME;
const want = process.env.PURGE_WANT_PROFILE || '';
const dryRun = process.env.PURGE_DRY_RUN === '1';
const profilesDir = join(home, 'profiles');
let profiles = want ? [want] : [];
if (!want) {
  try { profiles = readdirSync(profilesDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { profiles = []; }
}
const suffixes = ['.lark-setup.journal.json', '.lark-credential-cleanup.json'];
const found = new Map();
for (const profile of profiles) {
  let files = [];
  try { files = readdirSync(join(profilesDir, profile)); } catch { continue; }
  for (const file of files) {
    if (!suffixes.some(s => file.endsWith(s))) continue;
    let parsed;
    try { parsed = JSON.parse(readFileSync(join(profilesDir, profile, file), 'utf8')); } catch { continue; }
    const locators = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.locators) ? parsed.locators : []);
    for (const loc of locators) {
      if (!loc || (loc.provider !== 'macos-keychain' && loc.provider !== 'linux-secret-service')) continue;
      if (typeof loc.service !== 'string' || typeof loc.account !== 'string') continue;
      if (!loc.service.startsWith('dsh/')) continue;
      if (want && !loc.service.startsWith(`dsh/lark/${profile}/`)) continue;
      found.set(`${loc.provider}\0${loc.service}\0${loc.account}`, loc);
    }
  }
}
let failures = 0;
for (const loc of found.values()) {
  const label = `${loc.provider}:${loc.service} (account=${loc.account})`;
  if (dryRun) { console.log(`  [dry-run] 删除凭据 ${label}`); continue; }
  const args = loc.provider === 'macos-keychain'
    ? ['/usr/bin/security', 'delete-generic-password', '-s', loc.service, '-a', loc.account]
    : ['secret-tool', 'clear', 'service', loc.service, 'account', loc.account];
  const result = spawnSync(args[0], args.slice(1));
  const status = result.status;
  const stderr = (result.stderr || '').toString();
  if (result.error && result.error.code === 'ENOENT') {
    console.error(`  找不到凭据工具 ${args[0]}，无法清理：${label}（可安装 libsecret 后重试，或加 --keep-keychain）`);
    failures += 1;
    continue;
  }
  const absent = status === 44 || /not found|no such|could not be found/i.test(stderr);
  if (status === 0 || absent) {
    console.log(`  凭据已删除（或本不存在）：${label}`);
  } else {
    failures += 1;
    console.error(`  凭据删除失败：${label}: ${stderr.trim() || 'exit ' + status}`);
  }
}
if (failures > 0) { console.error(`purge.sh: ${failures} 条凭据删除失败。`); process.exit(3); }
PURGE_NODE
  fi
fi

# --- 6. 删除文件（凭据先清，失败则中止，避免文件没了却无法再反查凭据） ---
if [[ -n "$PURGE_PROFILE" ]]; then
  purge_run rm -rf "$PURGE_DSH_HOME/profiles/$PURGE_PROFILE"
  purge_run rm -f "$PURGE_DSH_HOME/logs/$PURGE_PROFILE-host.log" "$PURGE_DSH_HOME/logs/$PURGE_PROFILE-host.error.log"
  purge_home_base="$(basename "$PURGE_DSH_HOME")"
  purge_home_parent="$(dirname "$PURGE_DSH_HOME")"
  purge_failed_prefix="$purge_home_base.dsh-enhanced-transaction.failed-$PURGE_PROFILE-"
  if [[ -d "$purge_home_parent" ]]; then
    for purge_diag in "$purge_home_parent"/$purge_failed_prefix*; do
      [[ -e "$purge_diag" ]] || continue
      purge_run rm -rf "$purge_diag"
    done
  fi
else
  if [[ -d "$PURGE_DSH_HOME/profiles" ]]; then
    while IFS= read -r -d '' purge_link; do
      purge_target="$(readlink "$purge_link" || true)"
      [[ -n "$purge_target" ]] && printf 'local checkout 源码保留（确认无用可手工 rm -rf）：%s\n' "$purge_target"
    done < <(find "$PURGE_DSH_HOME/profiles" -type l -path '*/node_modules/@dsh-enhanced/*' -print0 2>/dev/null || true)
  fi
  purge_home_parent="$(dirname "$PURGE_DSH_HOME")"
  purge_home_base="$(basename "$PURGE_DSH_HOME")"
  purge_run rm -rf "$PURGE_DSH_HOME"
  for purge_residual in \
      "$purge_home_parent/$purge_home_base.dsh-enhanced-transaction" \
      "$purge_home_parent/$purge_home_base.dsh-enhanced-lifecycle.lock"; do
    [[ -e "$purge_residual" ]] && purge_run rm -rf "$purge_residual"
  done
  for purge_diag in "$purge_home_parent/$purge_home_base.dsh-enhanced-transaction.failed-"*; do
    [[ -e "$purge_diag" ]] || continue
    purge_run rm -rf "$purge_diag"
  done
fi

# --- 7. 可选卸载全局 host ---
if [[ "$PURGE_REMOVE_HOST" == '1' ]]; then
  purge_global_prefix="$(npm prefix -g 2>/dev/null || printf 'unknown')"
  printf '全局 host：%s（将卸载 @deepseek-ai/dsh）\n' "$purge_global_prefix"
  purge_run npm uninstall --global @deepseek-ai/dsh
fi

printf 'purge.sh: 完成。如需重装：重跑 install-npm.sh / install-local.sh。\n'
