#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIRECTORY/../.." && pwd -P)"

# shellcheck source=./common.sh
source "$SCRIPT_DIRECTORY/common.sh"
dsh_enhanced_install local "$REPOSITORY_ROOT" "$@"
