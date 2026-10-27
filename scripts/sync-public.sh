#!/bin/bash
# Brings a clone of the public repo up to date with this repo's public tree, after the leak check.
#   bash scripts/sync-public.sh <public clone> "<commit message>"
# Commits there only when the check finds nothing; pushing stays a separate, deliberate step.
set -euo pipefail
PUBLIC=${1:?usage: sync-public.sh <public clone> "<message>"}
MESSAGE=${2:?usage: sync-public.sh <public clone> "<message>"}
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
OUT=$(mktemp -d)
bash "$ROOT/scripts/export-public.sh" "$OUT"
rsync -a --delete --exclude .git "$OUT/" "$PUBLIC/"
rm -rf "$OUT"
git -C "$PUBLIC" add -A
if git -C "$PUBLIC" diff --cached --quiet; then
  echo "바뀐 것 없음"
else
  git -C "$PUBLIC" commit -q -m "$MESSAGE"
  git -C "$PUBLIC" log --oneline -1
fi
