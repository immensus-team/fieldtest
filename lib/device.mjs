// Device logins for the setup wizard (design §5.1): gh as the human, Claude and Codex as the agent.
// Each runs in a pseudo-terminal (bin/login-pty.py answers the terminal queries gh waits on and keeps lines
// wide enough for Claude's sign-in address); the page polls the screen for the link and the code.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, INSTALL, TOOL_DIR } from "./config.mjs";
import { run } from "./exec.mjs";
import { screenText } from "./vt.mjs";

export function parseDevice(kind, text) {
  if (kind === "gh") {
    const code = text.match(/one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1];
    return code ? { url: "https://github.com/login/device", code } : null;
  }
  if (kind === "codex") {
    const url = text.match(/https:\/\/auth\.openai\.com\/codex\/device\S*/)?.[0];
    const code = text.match(/one-time code[^\n]*\n\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})/)?.[1];
    return url && code ? { url, code } : null;
  }
  // claude setup-token: the address may still wrap; its lines run until the first blank line.
  const at = text.search(/https:\/\/claude\.(?:ai|com)\/\S*oauth\/authorize/);
  if (at === -1) return null;
  const url = text.slice(at).split(/\n\s*\n/)[0].replace(/\s+/g, "");
  return { url, code: null };
}

export const parseToken = (text) => text.match(/sk-ant-oat[\w-]+/)?.[0] ?? null;

// The agent's own PATH: the pinned Node and Claude's installer location in its home.
const asAgent = (cmd) => ["sudo", "-n", "-u", INSTALL.agent, "-H", "env", `PATH=${INSTALL.runtime}/node/bin:/usr/local/bin:/usr/bin:/bin`, "sh", "-c", 'PATH="$HOME/.local/bin:$PATH"; exec "$@"', "sh", ...cmd];

const COMMANDS = {
  gh: () => ["gh", "auth", "login", "--web", "-h", "github.com", "-p", "https"],
  codex: () => asAgent(["codex", "login", "--device-auth"]),
  claude: () => asAgent(["claude", "setup-token"]),
};

const sessions = new Map();

export function startLogin(kind) {
  // Pressing start again replaces the earlier login of the same kind.
  for (const [old, s] of sessions) {
    if (s.kind !== kind) continue;
    s.child.kill("SIGTERM");
    rmSync(s.log, { force: true });
    sessions.delete(old);
  }
  const id = randomBytes(8).toString("hex");
  // In the human's 700 config folder, never the shared data directory: Claude's token passes through.
  const dir = join(CONFIG_DIR, "logins");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = join(dir, `${kind}-${id}.log`);
  const child = spawn("python3", ["-I", join(TOOL_DIR, "bin", "login-pty.py"), log, ...COMMANDS[kind]()], {
    // gh would otherwise try to open a browser on the server.
    env: { ...process.env, BROWSER: "true", GH_PROMPT_DISABLED: "1" },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const s = { kind, log, child, exit: null, saved: false };
  child.on("exit", (code) => (s.exit = code ?? -1));
  sessions.set(id, s);
  // gh asks for Enter before it opens the browser; the code is already on screen.
  if (kind === "gh") setTimeout(() => child.stdin.write("\r"), 1500).unref();
  return { id };
}

// Claude prints the token once: it goes to the agent's env file (600) and is checked with one call.
async function saveClaudeToken(token) {
  const write = await run("sudo", ["-n", "-u", INSTALL.agent, "-H", "sh", "-c", 'umask 077 && mkdir -p ~/.config/fieldtest && printf "CLAUDE_CODE_OAUTH_TOKEN=%s\\n" "$(cat)" > ~/.config/fieldtest/env'], { input: token });
  if (write.code !== 0) return `토큰 저장 실패: ${write.stderr.trim()}`;
  const [cmd, ...args] = asAgent(["sh", "-c", '. ~/.config/fieldtest/env && export CLAUDE_CODE_OAUTH_TOKEN && claude -p "reply with ok" --max-turns 1']);
  const check = await run(cmd, args, { timeoutMs: 120_000 });
  return check.code === 0 ? null : `토큰 확인 실패: ${(check.stderr || check.stdout).trim().split("\n")[0]}`;
}

export async function loginStatus(id) {
  const s = sessions.get(id);
  if (!s) return { state: "failed", error: "로그인 세션이 없습니다. 다시 시작하세요." };
  if (s.final) return s.final;
  const status = await readStatus(s);
  // A finished login's screen (with Claude's token in it) is not kept.
  if (status.state === "done" || status.state === "failed") {
    s.final = status;
    rmSync(s.log, { force: true });
  }
  return status;
}

async function readStatus(s) {
  const text = existsSync(s.log) ? screenText(readFileSync(s.log, "utf8")) : "";
  const shown = parseDevice(s.kind, text) ?? {};
  if (s.kind === "claude") {
    const token = parseToken(text);
    if (token && !s.saved) {
      s.saved = true;
      s.error = await saveClaudeToken(token);
    }
    if (s.saved) return s.error ? { state: "failed", error: s.error } : { state: "done" };
    if (s.exit !== null) return { state: "failed", error: text.split("\n").filter(Boolean).at(-1) ?? "종료됨" };
    return shown.url ? { state: "needs-code", url: shown.url } : { state: "starting" };
  }
  if (s.exit === 0) return { state: "done" };
  if (s.exit !== null) return { state: "failed", error: text.split("\n").filter(Boolean).at(-1) ?? `종료 코드 ${s.exit}` };
  return shown.code ? { state: "waiting", ...shown } : { state: "starting" };
}

// The code Claude's sign-in page shows, typed into setup-token.
export function sendLoginCode(id, code) {
  const s = sessions.get(id);
  if (!s || s.exit !== null) return false;
  s.child.stdin.write(`${code.trim()}\r`);
  return true;
}
