// Checks the environment for whichever user runs it. The agent user must lack GitHub write access
// and must not read the human's secrets; the human user must have gh and the clone.
import { accessSync, constants, existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { DATA_DIR, INSTALL, MIRROR, paths, settings } from "./config.mjs";
import { run } from "./exec.mjs";
import { loadRecipe, repoSlug } from "./recipe.mjs";

async function homeOf(user) {
  const r = await run("getent", ["passwd", user]);
  return r.code === 0 ? r.stdout.trim().split(":")[5] : `/home/${user}`;
}

// What the agent must not read: the human's GitHub login and Slack tokens.
const humanSecrets = (home) => [join(home, ".config", "gh", "hosts.yml"), join(home, ".config", "fieldtest", "slack.env")];

function readable(file) {
  try {
    accessSync(file, constants.R_OK);
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

function writable(dir) {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function slackCheck() {
  const { slackAuth } = await import("./slack.mjs");
  try {
    const r = await slackAuth();
    return { ok: true, detail: `${r.team} · ${r.user} → DM ${r.channel}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

export async function doctor() {
  const user = userInfo().username;
  const agent = user === INSTALL.agent;
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok, detail });

  check("Node 24", process.versions.node.startsWith("24."), process.versions.node);
  let recipe = null;
  try {
    recipe = loadRecipe();
  } catch (e) {
    check("레시피", false, e.message.split("\n")[0]);
  }
  if (recipe) check("레시피", true, `${recipe.repo} (${recipe.app.kind})`);
  check("데이터 디렉터리 쓰기", writable(DATA_DIR), DATA_DIR);

  if (agent) {
    for (const bin of ["claude", "codex", "npx", "docker"]) {
      const r = await run(bin, ["--version"]);
      check(`${bin} 실행`, r.code === 0, r.stdout.trim().split("\n")[0]);
    }
    check("Claude 장기 토큰", Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN), "CLAUDE_CODE_OAUTH_TOKEN");
    check("에이전트 clone", existsSync(join(paths.repo, ".git")), paths.repo);
    const gh = await run("gh", ["auth", "status"]);
    check("gh 로그인 없음", gh.code !== 0, gh.code === 0 ? "gh가 로그인되어 있다" : "");
    const github = await run("git", ["ls-remote", `https://github.com/${repoSlug()}.git`, "HEAD"], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    check("GitHub 직접 접근 불가", github.code !== 0, github.code === 0 ? "GitHub를 읽을 수 있다" : "");
    if (existsSync(paths.repo)) {
      // A real push: --dry-run never writes to a local-path remote, so it can't test permissions.
      const push = await run("git", ["push", "origin", "HEAD:refs/heads/fieldtest-doctor-probe"], { cwd: paths.repo });
      check("미러로 push 불가", push.code !== 0, push.code === 0 ? "push가 됐다. 미러 권한을 확인한다" : "");
    }
    const codex = await run("codex", ["login", "status"]);
    check("Codex 로그인", codex.code === 0, (codex.stdout || codex.stderr).trim().split("\n")[0]);
    const humanHome = await homeOf(INSTALL.human);
    for (const f of humanSecrets(humanHome)) check(`읽기 불가: ${f}`, !readable(f));
    let homeListable = true;
    try {
      readdirSync(humanHome);
    } catch {
      homeListable = false;
    }
    check("사람 계정 홈 목록 읽기 불가", !homeListable, `chmod 700 ${humanHome}`);
    // The agent runs on its prompts alone; the human's personal instructions must not reach it.
    const personal = [join(homedir(), ".claude", "CLAUDE.md"), join(homedir(), ".codex", "AGENTS.md")].filter((f) => existsSync(f));
    check("개인 지침 없음", personal.length === 0, personal.join(", "));
  } else {
    const gh = await run("gh", ["auth", "status"]);
    check("gh 로그인", gh.code === 0);
    const clone = settings().myClone;
    check("내 clone", existsSync(join(clone, ".git")), clone);
    check("티켓 디렉터리 쓰기", writable(paths.tickets), paths.tickets);
    check("미러", existsSync(join(MIRROR, "HEAD")), MIRROR);
    const slack = await slackCheck();
    check("Slack 봇", slack.ok, slack.detail);
  }

  for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  return results.every((r) => r.ok);
}
