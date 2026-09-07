#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=./common.sh
source "$SCRIPT_DIRECTORY/common.sh"

PROFILE='web'
PHASE='postflight'
REQUIRE_SERVICE='0'
REQUIRE_ISOLATION='0'
PORT="${DSH_ENHANCED_WEB_PORT:-3080}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--profile 需要一个值。'; exit $?; }
      PROFILE="$2"; shift 2 ;;
    --preflight) PHASE='preflight'; shift ;;
    --require-service) REQUIRE_SERVICE='1'; shift ;;
    --require-isolation) REQUIRE_ISOLATION='1'; shift ;;
    --port)
      [[ $# -ge 2 ]] || { dsh_enhanced_fail 2 '--port 需要一个值。'; exit $?; }
      PORT="$2"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: doctor.sh [--profile <name>] [--preflight] [--port <1..65535>] [--require-service | --require-isolation]

Without --preflight, verifies that a profile composes; profiles without an
enabled Lark Channel are also foreground-activated.  --require-service verifies
the configured Lark resident service and Linux logout persistence.
--require-isolation checks the installed finite isolation grant, paired owner
and a temporary Docker probe without starting another Host or renewing grants.
It does not verify model, Goal, Policy or external Actions readiness.
EOF
      exit 0 ;;
    *) dsh_enhanced_fail 2 "未知参数：$1"; exit $? ;;
  esac
done

if [[ ! "$PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  dsh_enhanced_fail 2 'profile 名称不合法。'
  exit $?
fi
DSH_HOME_PATH="${DSH_HOME:-$HOME/.dsh}"
if [[ "$DSH_HOME_PATH" != /* ]]; then
  dsh_enhanced_fail 2 'DSH_HOME 必须是绝对路径。'
  exit $?
fi
if [[ "$REQUIRE_ISOLATION" == '1' ]]; then
  if [[ "$PHASE" != 'postflight' || "$REQUIRE_SERVICE" == '1' ]]; then
    dsh_enhanced_fail 2 '--require-isolation 不能与 --preflight 或 --require-service 同用。'
    exit $?
  fi
  dsh_enhanced_doctor_isolation "$PROFILE" "$DSH_HOME_PATH"
else
  dsh_enhanced_doctor "$PHASE" "$PROFILE" "$DSH_HOME_PATH" "$PORT" "$REQUIRE_SERVICE"
fi
