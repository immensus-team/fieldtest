// Accounts and paths of this install. setup/install.sh writes /etc/fieldtest/install.json; the code
// never names a person or a path of its own (design §4.2).
import { readFileSync } from "node:fs";

export const INSTALL_FILE = process.env.FIELDTEST_INSTALL ?? "/etc/fieldtest/install.json";

const DEFAULTS = {
  name: "fieldtest",
  human: "fieldtest",
  agent: "fieldtest-agent",
  code: "/srv/fieldtest/code",
  data: "/srv/fieldtest/data",
  runtime: "/srv/fieldtest/runtime",
  mirror: "/srv/fieldtest/mirror.git",
  // Human-owned: the approved recipe, its history, the real keys and the wizard's state. Outside the
  // agent-owned data directory, so the agent can read them but never replace them (design §7.2).
  approved: "/srv/fieldtest/approved",
  // The human's clone of the target repo, in the human's 700 home: branches go to GitHub from here,
  // and the agent must not reach its hooks or config.
  clone: "/home/fieldtest/clone",
  webPort: 4310,
};

export function readInstall(file = INSTALL_FILE) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { ...DEFAULTS };
    throw e;
  }
  try {
    return { ...DEFAULTS, ...JSON.parse(text) };
  } catch (e) {
    throw new Error(`install.json을 읽지 못했습니다 (${file}): ${e.message}`);
  }
}
