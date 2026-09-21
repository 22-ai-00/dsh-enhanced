#!/usr/bin/env bash
set -euo pipefail

# scripts/install/purge.sh — DSH enhanced 插件集合的彻底卸载（单文件救机脚本）。
#
# 这是 mutable-main 运维脚本（始终取 main 分支最新版本），不是 install-npm.sh
# 那样的供应链引导路径，因此不做 release pin/sha256 校验。
#
# 优先委托全局 dsh-rsi（随插件集合一起安装，实现完整、带单测）；
# 机器上没有 dsh-rsi 时（崩溃后/手动删过），使用本文件内联的精简实现：
# 进程静止检查 → 停服注销 → tar.gz 备份 → 删除 profile/DSH home/生命周期残留
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
  --yes               跳过交互确认
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

# 完整实现始终以 dsh-rsi 为准：找到就直接委托，参数原样透传。
if command -v dsh-rsi >/dev/null 2>&1; then
  purge_rsi_args=(--dsh-home "$PURGE_DSH_HOME")
  [[ -n "$PURGE_PROFILE" ]] && purge_rsi_args+=(--profile "$PURGE_PROFILE")
  [[ "$PURGE_BACKUP" == '0' ]] && purge_rsi_args+=(--no-backup)
  [[ "$PURGE_KEEP_KEYCHAIN" == '1' ]] && purge_rsi_args+=(--keep-keychain)
  [[ "$PURGE_REMOVE_HOST" == '1' ]] && purge_rsi_args+=(--remove-host)
  [[ "$PURGE_DRY_RUN" == '1' ]] && purge_rsi_args+=(--dry-run)
  purge_rsi_args+=(--yes)
  exec dsh-rsi purge "${purge_rsi_args[@]+"${purge_rsi_args[@]}"}"
fi

printf 'purge.sh: 未找到全局 dsh-rsi，使用内联精简实现（建议日后安装插件集合获得完整 dsh-rsi）。\n' >&2

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

# --- 2. 进程静止检查（不代用户 kill） ---
for purge_p in "${PURGE_PROFILES[@]+"${PURGE_PROFILES[@]}"}"; do
  # [-]-profile 技巧使模式不以 - 开头，BSD/procps pgrep 均无需 --。
  if purge_matches="$(pgrep -f "[-]-profile $purge_p" 2>/dev/null || true)"; then
    purge_active=''
    while IFS= read -r purge_pid; do
      [[ -n "$purge_pid" ]] || continue
      purge_cmd="$(ps -p "$purge_pid" -o command= 2>/dev/null || printf 'PID %s' "$purge_pid")"
      case "$purge_cmd" in
        *dsh-rsi*|*rsi-cli*|*purge.sh*) ;;
        *) purge_active="$purge_active  PID $purge_pid: $purge_cmd"$'\n' ;;
      esac
    done <<< "$purge_matches"
    if [[ -n "$purge_active" ]]; then
      printf 'purge.sh: 以下 profile host 仍在运行，请先停用服务后再 purge：\n%s' "$purge_active" >&2
      exit 1
    fi
  fi
done

# --- 3. 停服注销 ---
for purge_p in "${PURGE_PROFILES[@]+"${PURGE_PROFILES[@]}"}"; do
  if [[ "$PURGE_PLATFORM" == 'darwin' ]]; then
    purge_label="ai.deepseek.dsh.profile.$purge_p"
    purge_plist="$HOME/Library/LaunchAgents/$purge_label.plist"
    # 未注册 label 时 bootout 返回非零，属预期。
    purge_run launchctl bootout "gui/$(id -u)/$purge_label" || true
    [[ -e "$purge_plist" ]] && purge_run rm -f "$purge_plist"
  else
    purge_unit="dsh-profile-$purge_p.service"
    purge_unit_path="$HOME/.config/systemd/user/$purge_unit"
    # 未注册/不存在的 unit 会让 systemctl 往 stderr 打噪音；这两步尽力而为，返回值不检查。
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
  // 工具未安装（spawn ENOENT）：无法证明凭据已删除，fail-closed 中止，文件保留。
  if (result.error && result.error.code === 'ENOENT') {
    console.error(`  找不到凭据工具 ${args[0]}，无法清理：${label}（可安装 libsecret 后重试，或加 --keep-keychain）`);
    failures += 1;
    continue;
  }
  // macOS security 条目不存在退出码 44；secret-tool 无稳定码，按 stderr 文案判定。
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
# 注意：上面凭据清理若返回 3，set -e 会使脚本在此之前退出。
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
  # 报告 local checkout（符号链接目标），但绝不删除源码。
  if [[ -d "$PURGE_DSH_HOME/profiles" ]]; then
    while IFS= read -r -d '' purge_link; do
      purge_target="$(readlink "$purge_link" || true)"
      [[ -n "$purge_target" ]] && printf 'local checkout 源码保留（确认无用可手工 rm -rf）：%s\n' "$purge_target"
    done < <(find "$PURGE_DSH_HOME/profiles" -type l -path '*/node_modules/@dsh-enhanced/*' -print0 2>/dev/null || true)
  fi
  purge_home_parent="$(dirname "$PURGE_DSH_HOME")"
  purge_home_base="$(basename "$PURGE_DSH_HOME")"
  purge_run rm -rf "$PURGE_DSH_HOME"
  # home 外生命周期事务/失败诊断/home 锁
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
  purge_global_prefix="$(npm prefix --global 2>/dev/null || printf 'unknown')"
  printf '全局 host：%s（将卸载 @deepseek-ai/dsh）\n' "$purge_global_prefix"
  purge_run npm uninstall --global @deepseek-ai/dsh
fi

printf 'purge.sh: 完成。如需重装：重跑 install-npm.sh / install-local.sh。\n'
