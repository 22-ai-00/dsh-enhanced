#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 ]]; then
  printf 'dsh-enhanced restart: 只接受一个可选的 profile 参数，例如：%s web\n' "$0" >&2
  exit 2
fi

PROFILE="${1:-web}"
if [[ ! "$PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  printf 'dsh-enhanced restart: profile 名称不合法。\n' >&2
  exit 2
fi

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIRECTORY/../.." && pwd -P)"
DRY_RUN="${DSH_ENHANCED_DRY_RUN:-0}"
PLATFORM="${DSH_ENHANCED_PLATFORM_OVERRIDE:-$(uname -s)}"

case "$PLATFORM" in
  Darwin|darwin) SERVICE_KIND='launchd' ;;
  Linux|linux) SERVICE_KIND='systemd' ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT|windows|win32) SERVICE_KIND='windows' ;;
  *)
    printf 'dsh-enhanced restart: 不支持的操作系统：%s\n' "$PLATFORM" >&2
    exit 1
    ;;
esac

if [[ "$DRY_RUN" == '1' ]]; then
  printf '  $ cd %q\n' "$REPOSITORY_ROOT"
  printf '  $ pnpm build\n'
  if [[ "$SERVICE_KIND" == 'launchd' ]]; then
    printf '  $ launchctl kickstart -k %q\n' "gui/$(id -u)/ai.deepseek.dsh.profile.$PROFILE"
  elif [[ "$SERVICE_KIND" == 'systemd' ]]; then
    printf '  $ systemctl --user restart %q\n' "dsh-profile-$PROFILE.service"
  else
    printf '  $ schtasks.exe /End /TN %q\n' "DSH profile $PROFILE"
    printf '  $ schtasks.exe /Run /TN %q\n' "DSH profile $PROFILE"
  fi
  exit 0
fi

if ! command -v pnpm >/dev/null 2>&1; then
  printf 'dsh-enhanced restart: 找不到 pnpm；请先运行本地一键安装脚本。\n' >&2
  exit 1
fi

(cd "$REPOSITORY_ROOT" && pnpm build)
if [[ "$SERVICE_KIND" == 'launchd' ]]; then
  TARGET="gui/$(id -u)/ai.deepseek.dsh.profile.$PROFILE"
  if ! launchctl print "$TARGET" >/dev/null 2>&1; then
    printf 'dsh-enhanced restart: 常驻服务尚未安装：%s\n' "$TARGET" >&2
    exit 1
  fi
  launchctl kickstart -k "$TARGET"
elif [[ "$SERVICE_KIND" == 'systemd' ]]; then
  TARGET="dsh-profile-$PROFILE.service"
  if ! systemctl --user status "$TARGET" >/dev/null 2>&1; then
    printf 'dsh-enhanced restart: systemd user service 尚未安装：%s\n' "$TARGET" >&2
    exit 1
  fi
  systemctl --user restart "$TARGET"
else
  TARGET="DSH profile $PROFILE"
  schtasks.exe /Query /TN "$TARGET" >/dev/null
  schtasks.exe /End /TN "$TARGET" >/dev/null 2>&1 || true
  schtasks.exe /Run /TN "$TARGET" >/dev/null
fi
printf 'DSH profile %s 已重建插件并重启。\n' "$PROFILE"
