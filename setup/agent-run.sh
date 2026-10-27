#!/bin/bash
# Agent loop entry. systemd (fieldtest.service) runs it as the agent account through sudo.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
cd "$DATA"
export PATH="$RUNTIME/node/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 GIT_TERMINAL_PROMPT=0
# The agent's own rootless Docker (setup/install.sh), for recipes with services.
export XDG_RUNTIME_DIR="/run/user/$(id -u)" DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
set -a
. "$HOME/.config/fieldtest/env"
set +a
exec node "$TOOL/bin/fieldtest.mjs" run
