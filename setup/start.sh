#!/bin/bash
# Mirror, clone, install and systemd registration. Runs as the human account (install.json), no root:
#   bash setup/start.sh prepare <owner/repo>   # setup wizard step 2: mirror and agent clone only
#   bash setup/start.sh                        # after the recipe is approved: install, start (or restart)
#   bash setup/start.sh stop
# GitHub access stays with the human: a mirror owned by the human is the agent's only source.
set -euo pipefail
# Files the human account makes here (mirror, clone, dashboard build) must not be writable by the
# agent, which shares the staff group.
umask 022
. "$(dirname "$0")/lib.sh"
cd "$DATA"
AGENT_HOME=$(getent passwd "$AGENT" | cut -d: -f6)
AS_AGENT=(sudo -n -u "$AGENT" -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 GIT_TERMINAL_PROMPT=0 "PATH=$RUNTIME/node/bin:$AGENT_HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
UNITS=$HOME/.config/systemd/user
WORKERS=(fieldtest-watch.timer fieldtest.service fieldtest-update.timer)
# Slack runs only once its owner is set; an install that skipped Slack has no tokens.
SLACK_ENV=$HOME/.config/fieldtest/slack.env
if grep -q '^SLACK_USER_ID=.' "$SLACK_ENV" 2>/dev/null; then WORKERS+=(fieldtest-slack.service); fi

step() { printf '\n== %s\n' "$*"; }

# The loop, watch and Slack. fieldtest-web stays up: the setup wizard runs this script from inside it,
# and stopping it would kill the script with it.
stop_workers() {
  systemctl --user stop fieldtest.service fieldtest-slack.service fieldtest-watch.timer fieldtest-watch.service 2>/dev/null || true
}

# The mirror (human) and the agent's clone of it for <owner/repo>. Another repo replaces both.
prepare() {
  local repo_url="https://github.com/$1.git"
  step "GitHub 미러 $MIRROR (내 소유, 에이전트는 읽기만)"
  if [ -d "$MIRROR" ] && [ "$(git --git-dir "$MIRROR" remote get-url origin)" != "$repo_url" ]; then
    rm -rf "$MIRROR"
    "${AS_AGENT[@]}" rm -rf "$DATA/repo"
  fi
  [ -d "$MIRROR" ] || git clone --quiet --mirror "$repo_url" "$MIRROR"
  git --git-dir "$MIRROR" remote update --prune >/dev/null
  chmod -R go-w "$MIRROR"

  step "에이전트 clone $DATA/repo (origin = 미러)"
  "${AS_AGENT[@]}" git config --global --get-all safe.directory 2>/dev/null | grep -qx "$MIRROR" || "${AS_AGENT[@]}" git config --global --add safe.directory "$MIRROR"
  [ -d "$DATA/repo/.git" ] || "${AS_AGENT[@]}" git clone --quiet "$MIRROR" "$DATA/repo"
  "${AS_AGENT[@]}" git -C "$DATA/repo" remote set-url origin "$MIRROR"
  "${AS_AGENT[@]}" git -C "$DATA/repo" config user.name "fieldtest agent"
  "${AS_AGENT[@]}" git -C "$DATA/repo" config user.email "agent@fieldtest.invalid"
  "${AS_AGENT[@]}" git -C "$DATA/repo" fetch --quiet --prune origin
  "${AS_AGENT[@]}" git -C "$DATA/repo" remote set-head origin --auto >/dev/null

  step "내 clone $CLONE (agent의 commit을 bundle로 받아 GitHub에 push하는 곳)"
  if [ -d "$CLONE" ] && [ "$(git -C "$CLONE" remote get-url origin)" != "$repo_url" ]; then rm -rf "$CLONE"; fi
  [ -d "$CLONE/.git" ] || git clone --quiet "$repo_url" "$CLONE"
  # Commits published as the human (Vercel and rulesets check the author): the GitHub account's name and
  # its no-reply address.
  git -C "$CLONE" config user.name "$(gh api user --jq '.name // .login')"
  git -C "$CLONE" config user.email "$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')"
}

case "${1:-start}" in
  stop)
    stop_workers
    systemctl --user stop fieldtest-web.service 2>/dev/null || true
    echo "멈췄다."
    exit 0
    ;;
  prepare)
    [ -n "${2:-}" ] || { echo "usage: start.sh prepare <owner/repo>" >&2; exit 2; }
    prepare "$2"
    exit 0
    ;;
esac

RECIPE=$APPROVED/recipe/recipe.json
[ -s "$RECIPE" ] || { echo "승인된 실행 지침($RECIPE)이 없다. 설치 마법사에서 레포를 고르고 실행 지침을 승인한다." >&2; exit 1; }
BASE=$(jq -r .baseBranch "$RECIPE")
INSTALL_CMDS=$(jq -r '.install | join(" && ")' "$RECIPE")
E2E_CWD=$(jq -r .e2e.cwd "$RECIPE")
PLAYWRIGHT=$(jq -r .e2e.playwright "$RECIPE")
prepare "$(jq -r .repo "$RECIPE")"

step "의존성과 Playwright 브라우저 (실행 지침의 설치 명령)"
"${AS_AGENT[@]}" bash -c "cd '$DATA/repo' && git checkout --quiet --detach 'origin/$BASE' && $INSTALL_CMDS && cd '$E2E_CWD' && $PLAYWRIGHT install chromium"
# The Playwright inside PLAYWRIGHT_MCP (lib/config.mjs) needs its own Chromium build. Update both together.
"${AS_AGENT[@]}" bash -c "cd ~ && npx -y playwright@1.64.0-alpha-1790635538000 install chromium"

if ! "${AS_AGENT[@]}" test -s "$AGENT_HOME/.config/fieldtest/env"; then
  echo
  echo "준비는 끝났다. 에이전트의 Claude 로그인 정보가 없어 systemd 등록은 하지 않았다."
  echo "설치 마법사의 Claude 단계를 마친 뒤 이 스크립트를 다시 실행한다."
  exit 0
fi

step "systemd (내 계정의 user unit 네 개)"
mkdir -p "$UNITS"
cat > "$UNITS/fieldtest.service" <<UNIT
[Unit]
Description=fieldtest agent loop (as $AGENT)

[Service]
WorkingDirectory=$DATA
ExecStart=/usr/bin/sudo -n -u $AGENT -H /bin/bash $TOOL/setup/agent-run.sh
Restart=always
RestartSec=60
LimitNOFILE=65536
StandardOutput=append:$DATA/run/loop.log
StandardError=append:$DATA/run/loop.log

[Install]
WantedBy=default.target
UNIT
cat > "$UNITS/fieldtest-watch.service" <<UNIT
[Unit]
Description=fieldtest watch (Slack commands, GitHub)

[Service]
Type=oneshot
WorkingDirectory=$DATA
ExecStart=/bin/bash $TOOL/setup/watch-run.sh
StandardOutput=append:$DATA/run/watch.log
StandardError=append:$DATA/run/watch.log
UNIT
cat > "$UNITS/fieldtest-watch.timer" <<UNIT
[Unit]
Description=Run fieldtest watch every minute

[Timer]
OnActiveSec=0
OnUnitInactiveSec=60
AccuracySec=1s

[Install]
WantedBy=timers.target
UNIT
# New release tags (lib/update.mjs). The service runs this script itself, so stop_workers leaves it alone.
cat > "$UNITS/fieldtest-update.service" <<UNIT
[Unit]
Description=fieldtest update to the newest release tag

[Service]
Type=oneshot
WorkingDirectory=$DATA
ExecStart=/bin/bash $TOOL/setup/update-run.sh
TimeoutStartSec=4h
StandardOutput=append:$DATA/run/update.log
StandardError=append:$DATA/run/update.log
UNIT
cat > "$UNITS/fieldtest-update.timer" <<UNIT
[Unit]
Description=Check for a new fieldtest release every hour

[Timer]
OnBootSec=15min
OnUnitActiveSec=1h
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
UNIT
cat > "$UNITS/fieldtest-slack.service" <<UNIT
[Unit]
Description=fieldtest Slack Socket Mode

[Service]
WorkingDirectory=$DATA
ExecStart=/bin/bash $TOOL/setup/slack-run.sh
Restart=always
RestartSec=30
StandardOutput=append:$DATA/run/slack.log
StandardError=append:$DATA/run/slack.log

[Install]
WantedBy=default.target
UNIT
cat > "$UNITS/fieldtest-web.service" <<UNIT
[Unit]
Description=fieldtest dashboard on 127.0.0.1:$WEB_PORT

[Service]
WorkingDirectory=$DATA
ExecStart=/bin/bash $TOOL/setup/web-run.sh
Restart=always
RestartSec=30
StandardOutput=append:$DATA/run/web.log
StandardError=append:$DATA/run/web.log

[Install]
WantedBy=default.target
UNIT
step "관리 사이트 빌드"
(cd "$TOOL/web" && PATH="$RUNTIME/node/bin:$PATH" npm ci --no-audit --no-fund && PATH="$RUNTIME/node/bin:$PATH" npm run build)
chmod -R go-w "$TOOL/web"
stop_workers
systemctl --user daemon-reload
systemctl --user enable --now "${WORKERS[@]}"
[[ " ${WORKERS[*]} " == *" fieldtest-slack.service "* ]] || systemctl --user disable fieldtest-slack.service 2>/dev/null || true
systemctl --user enable fieldtest-web.service
# From the wizard (FIELDTEST_FROM_WEB) the running dashboard already serves this code; a restart here
# would end this script. From a terminal (an update), restart it last.
[ -n "${FIELDTEST_FROM_WEB:-}" ] || systemctl --user restart fieldtest-web.service
echo "시작했다. 상태: $TOOL/bin/fieldtest status   관리 사이트: http://127.0.0.1:$WEB_PORT   로그: $DATA/run/loop.log, $DATA/run/watch.log, $DATA/run/slack.log, $DATA/run/web.log"
