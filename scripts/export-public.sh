#!/bin/bash
# Writes the public tree (HEAD without private paths) to <out> and checks it: exit 0 only with no hits.
#   bash scripts/export-public.sh <out>
set -euo pipefail
OUT=${1:?usage: export-public.sh <out>}
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
PRIVATE_PATHS=(private docs/specs docs/plans)
rm -rf "$OUT"
mkdir -p "$OUT"
git -C "$ROOT" archive HEAD | tar -x -C "$OUT"
for p in "${PRIVATE_PATHS[@]}"; do rm -rf "${OUT:?}/$p"; done
rmdir "$OUT/docs" 2>/dev/null || true
node "$ROOT/scripts/leak-check.mjs" "$OUT" --patterns "$ROOT/private/leak-patterns.txt"
