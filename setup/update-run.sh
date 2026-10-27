#!/bin/bash
# `fieldtest update` entry. A systemd timer runs it as the human user every hour.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
cd "$DATA"
export PATH="$RUNTIME/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec node "$TOOL/bin/fieldtest.mjs" update
