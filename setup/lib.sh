# Sourced by the setup and service scripts: accounts and paths of this install (design §4.2).
# Missing file or keys fall back to the new-install defaults, the same ones lib/install.mjs uses.
INSTALL=${FIELDTEST_INSTALL:-/etc/fieldtest/install.json}
cfg() { jq -r --arg d "$2" ".$1 // \$d" "$INSTALL" 2>/dev/null || echo "$2"; }
NAME=$(cfg name fieldtest)
HUMAN=$(cfg human fieldtest)
AGENT=$(cfg agent fieldtest-agent)
TOOL=$(cfg code /srv/fieldtest/code)
DATA=$(cfg data /srv/fieldtest/data)
APPROVED=$(cfg approved /srv/fieldtest/approved)
RUNTIME=$(cfg runtime /srv/fieldtest/runtime)
MIRROR=$(cfg mirror /srv/fieldtest/mirror.git)
CLONE=$(cfg clone /home/fieldtest/clone)
WEB_PORT=$(cfg webPort 4310)
# systemctl --user from a sudo shell (`sudo -iu fieldtest ...`) has no session to find the user manager.
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
