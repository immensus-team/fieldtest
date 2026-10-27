#!/bin/bash
# `fieldtest watch` entry. a systemd timer runs it as the human user every minute.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
cd "$DATA"
export PATH="$RUNTIME/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec node "$TOOL/bin/fieldtest.mjs" watch
