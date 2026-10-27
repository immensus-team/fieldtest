#!/bin/bash
# One-time setup of a fieldtest server (Ubuntu 24.04, arm64 or x64). Run as root:
#   sudo bash setup/install.sh base --name <install name> [--human <account>]
# CloudFormation runs it from UserData (setup/ec2.yaml). Everything after it happens in the setup
# wizard at http://127.0.0.1:4310 (fieldtest-web), opened through an SSM or SSH tunnel.
set -euo pipefail

usage() { echo "usage: sudo bash $0 base --name <install name> [--human <account>]" >&2; exit 2; }
[ "${1:-}" = base ] || usage
shift
NAME=""
HUMAN=fieldtest
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME=$2; shift 2 ;;
    --human) HUMAN=$2; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$NAME" =~ ^[a-z0-9-]{1,32}$ ]] || { echo "--name은 영문 소문자·숫자·-, 32자 이하다" >&2; exit 2; }

AGENT=fieldtest-agent
ROOT=/srv/fieldtest
TOOL=$ROOT/code
DATA=$ROOT/data
RUNTIME=$ROOT/runtime
MIRROR=$ROOT/mirror.git
APPROVED=$ROOT/approved
HUMAN_HOME=/home/$HUMAN
CLONE=$HUMAN_HOME/clone
AGENT_HOME=/home/$AGENT
NODE_VERSION=24.20.0
declare -A NODE_SHA256=(
  [arm64]=5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7
  [x64]=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2
)
CODEX_VERSION=0.162.1
PLAYWRIGHT_VERSION=1.63.0
# The Playwright inside the pinned Playwright MCP (lib/config.mjs PLAYWRIGHT_MCP) needs its own Chromium build.
MCP_PLAYWRIGHT_VERSION=1.64.0-alpha-1790635538000

step() { printf '\n== %s\n' "$*"; }
[ -d "$TOOL/.git" ] || { echo "$TOOL에 fieldtest 저장소가 없다. git clone https://github.com/immensus-team/fieldtest $TOOL 뒤 다시 실행한다." >&2; exit 1; }

step "패키지 (gh, Docker, Xvfb, Python)"
install -d -m 0755 /etc/apt/keyrings
[ -f /etc/apt/sources.list.d/github-cli.list ] || {
  curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
}
[ -f /etc/apt/sources.list.d/docker.list ] || {
  curl -fsSL -o /etc/apt/keyrings/docker.asc https://download.docker.com/linux/ubuntu/gpg
  chmod go+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
}
apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -y -q git gh curl xz-utils jq rsync unzip ripgrep build-essential fonts-noto-cjk \
  iptables-persistent python3 uidmap dbus-user-session xvfb \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras
# Checks and e2e runs leave temp folders (fixtures, browser profiles); 2 days keeps the disk flat.
printf 'D /tmp 1777 root root 2d\n' > /etc/tmpfiles.d/tmp.conf

step "계정: $HUMAN(사람), $AGENT(에이전트)"
getent group staff >/dev/null || groupadd staff
id "$HUMAN" >/dev/null 2>&1 || useradd -m -d "$HUMAN_HOME" -s /bin/bash -g staff "$HUMAN"
id "$AGENT" >/dev/null 2>&1 || useradd -m -d "$AGENT_HOME" -s /bin/bash -g staff "$AGENT"
chmod 700 "$HUMAN_HOME" "$AGENT_HOME"
# Services of both run without a login session: the human's web/watch/slack, the agent's rootless Docker.
loginctl enable-linger "$HUMAN" "$AGENT"
printf '%s ALL=(%s) NOPASSWD: ALL\n' "$HUMAN" "$AGENT" > /etc/sudoers.d/fieldtest
chmod 440 /etc/sudoers.d/fieldtest
visudo -cf /etc/sudoers.d/fieldtest

step "에이전트는 인스턴스 메타데이터(IAM 자격 증명)에 접근하지 못한다"
iptables -C OUTPUT -d 169.254.169.254 -m owner --uid-owner "$AGENT" -j REJECT 2>/dev/null ||
  iptables -A OUTPUT -d 169.254.169.254 -m owner --uid-owner "$AGENT" -j REJECT
netfilter-persistent save

step "설치 설정 /etc/fieldtest/install.json"
install -d -m 0755 /etc/fieldtest
jq -n --arg name "$NAME" --arg human "$HUMAN" --arg agent "$AGENT" --arg code "$TOOL" --arg data "$DATA" \
  --arg runtime "$RUNTIME" --arg mirror "$MIRROR" --arg approved "$APPROVED" --arg clone "$CLONE" \
  '{name: $name, human: $human, agent: $agent, code: $code, data: $data, runtime: $runtime, mirror: $mirror, approved: $approved, clone: $clone, webPort: 4310}' \
  > /etc/fieldtest/install.json

step "디렉터리: 코드·승인(사람 소유), 데이터(에이전트 소유)"
chown -R "$HUMAN":staff "$TOOL"
chmod -R go-w "$TOOL"
chown "$HUMAN":staff "$ROOT"
chmod 0755 "$ROOT"
mkdir -p "$DATA"/{tickets,runs,worktrees.noindex,run,base-checks}
chown -R "$AGENT":staff "$DATA"
find "$DATA" -type d -exec chmod 2775 {} +
# The approved recipe, its history, the real keys and the wizard's state: the agent reads, never
# replaces (design §7.2). Outside $DATA, which the agent owns.
install -d -o "$HUMAN" -g staff -m 0755 "$APPROVED"

step "Node $NODE_VERSION, pnpm, Codex $CODEX_VERSION → $RUNTIME/node"
ARCH=$(dpkg --print-architecture)
case "$ARCH" in arm64) NODE_ARCH=arm64 ;; amd64) NODE_ARCH=x64 ;; *) echo "지원하지 않는 CPU: $ARCH" >&2; exit 1 ;; esac
if [ "$("$RUNTIME/node/bin/node" -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  echo "${NODE_SHA256[$NODE_ARCH]}  $tmp/node.tar.xz" | sha256sum -c -
  mkdir -p "$RUNTIME"
  rm -rf "$RUNTIME/node"
  tar -xJf "$tmp/node.tar.xz" -C "$tmp"
  mv "$tmp/node-v$NODE_VERSION-linux-$NODE_ARCH" "$RUNTIME/node"
  rm -rf "$tmp"
fi
PATH="$RUNTIME/node/bin:$PATH" corepack enable --install-directory "$RUNTIME/node/bin" pnpm
PATH="$RUNTIME/node/bin:$PATH" npm install -g --no-fund --no-audit "@openai/codex@$CODEX_VERSION"
chown -R root:root "$RUNTIME"
chmod -R go-w "$RUNTIME"

AS_AGENT=(sudo -u "$AGENT" -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "PATH=$RUNTIME/node/bin:$AGENT_HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
AS_HUMAN=(sudo -u "$HUMAN" -H env "PATH=$RUNTIME/node/bin:/usr/bin:/bin:/usr/sbin:/sbin")

step "브라우저: Playwright $PLAYWRIGHT_VERSION 의존 패키지, MCP용 Chromium"
PATH="$RUNTIME/node/bin:$PATH" npx -y "playwright@$PLAYWRIGHT_VERSION" install-deps chromium
"${AS_AGENT[@]}" bash -c "cd ~ && npx -y playwright@$MCP_PLAYWRIGHT_VERSION install chromium"

step "Claude Code ($AGENT)"
[ -x "$AGENT_HOME/.local/bin/claude" ] || "${AS_AGENT[@]}" bash -c 'cd "$HOME" && curl -fsSL https://claude.ai/install.sh | bash'
"${AS_AGENT[@]}" "$AGENT_HOME/.local/bin/claude" --version
# The agent runs on its prompts alone: no personal instructions in its home.
"${AS_AGENT[@]}" mkdir -p "$AGENT_HOME/.codex" "$AGENT_HOME/.claude" "$AGENT_HOME/.config/fieldtest"
"${AS_AGENT[@]}" chmod 700 "$AGENT_HOME/.config/fieldtest"

step "Docker rootless ($AGENT 전용). docker 그룹은 root와 같은 권한이라 쓰지 않는다"
systemctl disable --now docker.service docker.socket
rm -f /var/run/docker.sock
AGENT_UID=$(id -u "$AGENT")
systemctl start "user@$AGENT_UID.service"
sudo -u "$AGENT" -H env XDG_RUNTIME_DIR="/run/user/$AGENT_UID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$AGENT_UID/bus" \
  dockerd-rootless-setuptool.sh install
sudo -u "$AGENT" -H env XDG_RUNTIME_DIR="/run/user/$AGENT_UID" DOCKER_HOST="unix:///run/user/$AGENT_UID/docker.sock" docker info --format '{{.ServerVersion}}'

ln -sf "$TOOL/bin/fieldtest" /usr/local/bin/fieldtest

step "설치 마법사 (fieldtest-web, $HUMAN의 user unit)"
"${AS_HUMAN[@]}" bash -c "umask 022 && cd '$TOOL/web' && npm ci --no-audit --no-fund && npm run build"
chmod -R go-w "$TOOL/web"
HUMAN_UID=$(id -u "$HUMAN")
systemctl start "user@$HUMAN_UID.service"
install -d -o "$HUMAN" -g staff -m 0700 "$HUMAN_HOME/.config" "$HUMAN_HOME/.config/fieldtest" "$HUMAN_HOME/.config/systemd" "$HUMAN_HOME/.config/systemd/user"
cat > "$HUMAN_HOME/.config/systemd/user/fieldtest-web.service" <<UNIT
[Unit]
Description=fieldtest dashboard and setup wizard on 127.0.0.1:4310

[Service]
WorkingDirectory=$DATA
ExecStart=/bin/bash $TOOL/setup/web-run.sh
Restart=always
RestartSec=10
StandardOutput=append:$DATA/run/web.log
StandardError=append:$DATA/run/web.log

[Install]
WantedBy=default.target
UNIT
chown "$HUMAN":staff "$HUMAN_HOME/.config/systemd/user/fieldtest-web.service"
sudo -u "$HUMAN" XDG_RUNTIME_DIR="/run/user/$HUMAN_UID" systemctl --user daemon-reload
sudo -u "$HUMAN" XDG_RUNTIME_DIR="/run/user/$HUMAN_UID" systemctl --user enable --now fieldtest-web.service

echo
echo "base 완료. 터널을 열고 http://127.0.0.1:4310 에서 설치 마법사를 진행한다."
