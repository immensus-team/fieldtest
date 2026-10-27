#!/bin/bash
# `fieldtest web` entry. systemd keeps the dashboard running as the human user on 127.0.0.1:4310.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
cd "$DATA"
export PATH="$RUNTIME/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec node "$TOOL/bin/fieldtest.mjs" web
