#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=./common.sh
source "$SCRIPT_DIRECTORY/common.sh"

PROFILE='web'
PHASE='postflight'
REQUIRE_SERVICE='0'
REQUIRE_ISOLATION='0'
JSON_OUTPUT='0'
PORT="${DSH_RAY_WEB_PORT:-3080}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || { dsh_ray_fail 2 '--profile 需要一个值。'; exit $?; }
      PROFILE="$2"; shift 2 ;;
    --preflight) PHASE='preflight'; shift ;;
    --require-service) REQUIRE_SERVICE='1'; shift ;;
    --require-isolation) REQUIRE_ISOLATION='1'; shift ;;
    --json) JSON_OUTPUT='1'; shift ;;
    --port)
      [[ $# -ge 2 ]] || { dsh_ray_fail 2 '--port 需要一个值。'; exit $?; }
      PORT="$2"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: doctor.sh [--profile <name>] [--preflight] [--port <1..65535>] [--require-service | --require-isolation] [--json]

Without --preflight, verifies that a profile composes and reports live host,
credentials, coding agent auth (`traex`/`agy`), autonomy readiness and OS
prerequisites; profiles without an enabled Lark Channel are foreground-activated.
--require-service verifies the configured Lark resident service and Linux
logout persistence. --require-isolation checks the installed finite isolation
grant and paired owner without starting another Host or renewing grants.
--json emits the structured `dsh-ray doctor --json` report without secrets.
EOF
      exit 0 ;;
    *) dsh_ray_fail 2 "未知参数：$1"; exit $? ;;
  esac
done

if [[ ! "$PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  dsh_ray_fail 2 'profile 名称不合法。'
  exit $?
fi
DSH_HOME_PATH="${DSH_HOME:-$HOME/.dsh}"
if [[ "$DSH_HOME_PATH" != /* ]]; then
  dsh_ray_fail 2 'DSH_HOME 必须是绝对路径。'
  exit $?
fi
if [[ "$JSON_OUTPUT" == '1' && ( "$PHASE" != 'postflight' || "$REQUIRE_ISOLATION" == '1' ) ]]; then
  dsh_ray_fail 2 '--json 不能与 --preflight 或 --require-isolation 同用。'
  exit $?
fi
dsh_ray_prepend_bound_host_bin "$DSH_HOME_PATH"
if [[ "$JSON_OUTPUT" == '1' ]]; then
  CLI_ENTRY="$SCRIPT_DIRECTORY/../../packages/dsh-ray/bin/dsh-ray.js"
  if [[ -f "$CLI_ENTRY" && -f "$SCRIPT_DIRECTORY/../../packages/dsh-ray/lib/index.js" ]] && command -v node >/dev/null 2>&1; then
    exec node "$CLI_ENTRY" --dsh-home "$DSH_HOME_PATH" doctor --profile "$PROFILE" --json
  fi
  if command -v dsh-ray >/dev/null 2>&1; then
    exec dsh-ray --dsh-home "$DSH_HOME_PATH" doctor --profile "$PROFILE" --json
  fi
  dsh_ray_fail 1 'doctor --json 需要已构建的 dsh-ray 或 packages/dsh-ray/bin/dsh-ray.js。'
  exit $?
fi
if [[ "$REQUIRE_ISOLATION" == '1' ]]; then
  if [[ "$PHASE" != 'postflight' || "$REQUIRE_SERVICE" == '1' ]]; then
    dsh_ray_fail 2 '--require-isolation 不能与 --preflight 或 --require-service 同用。'
    exit $?
  fi
  dsh_ray_doctor_isolation "$PROFILE" "$DSH_HOME_PATH"
else
  dsh_ray_doctor "$PHASE" "$PROFILE" "$DSH_HOME_PATH" "$PORT" "$REQUIRE_SERVICE"
  if [[ "$PHASE" == 'postflight' ]]; then
    dsh_ray_doctor_live_summary "$PROFILE" "$DSH_HOME_PATH"
  fi
fi
