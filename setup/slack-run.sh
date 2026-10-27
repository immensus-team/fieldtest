#!/bin/bash
# `fieldtest slack` entry. systemd keeps it running as the human user: it holds the Slack Socket Mode
# connection that receives button clicks.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
cd "$DATA"
export PATH="$RUNTIME/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec node "$TOOL/bin/fieldtest.mjs" slack
