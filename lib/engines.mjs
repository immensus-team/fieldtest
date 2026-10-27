import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLAYWRIGHT_MCP, TOOL_DIR, paths, settings } from "./config.mjs";
import { demoCdp } from "./demo.mjs";
import { run } from "./exec.mjs";
import { currentRecipe, currentRecipeDir } from "./recipe.mjs";

export function loadSchema(name) {
  return JSON.parse(readFileSync(join(paths.schemas, `${name}.json`), "utf8"));
}

const LOGIN = {
  none: () => "로그인이 필요 없다.",
  form: (r) => `실행기가 시드한 계정(${r.login.account.user})으로 로그인하는 init page를 Playwright MCP 브라우저에 미리 걸어 두었다. 다시 로그인하지 않는다.`,
  "init-page": (r) => `실행기가 \`${r.login.initPage}\`를 Playwright MCP 브라우저의 init page로 미리 걸어 두었다. 새 페이지마다 적용된다. 이 응답을 직접 다시 만들지 않는다.`,
};

// What every prompt may name about the target repo, from the approved recipe.
export function recipeVars(r = currentRecipe()) {
  const commands = (list) => list.map((c) => `\`${c.command}\``).join(", ") || "없음";
  const e2e = `${r.e2e.dir.replace(/\/+$/, "")}/`;
  return {
    productName: r.product.name,
    productSummary: r.product.summary,
    role: r.product.role,
    baseBranch: r.baseBranch,
    appRoot: r.app.root,
    e2eDir: e2e,
    proofDir: `${e2e}proof/`,
    e2eCwd: r.e2e.cwd,
    playwright: r.e2e.playwright,
    unitPattern: r.unit?.pattern ?? "없음. 이 레포는 unit test를 재현 테스트로 쓰지 않는다",
    fastChecks: commands(r.checks.filter((c) => c.stage === "fast")),
    allChecks: commands(r.checks),
    guideDocs: r.explore.guideDocs ?? "AGENTS.md, CLAUDE.md, CONTRIBUTING.md 중 있는 것",
    productDocs: r.explore.productDocs ?? "README와 docs/",
    startCommand: r.start.command,
    servicesText: r.services ? `먼저 docker compose(\`${r.services.compose}\`)로 서비스를 띄우고 시드를 넣는다. 데모 서버가 함께 처리한다.` : "",
    loginText: LOGIN[r.login.kind](r),
    installText: commands(r.install.map((command) => ({ command }))),
    appNotes: r.explore.notes ?? "",
    e2eNotes: r.e2e.notes ? `${r.e2e.notes.replace(/\s+$/, "")}\n` : "",
  };
}

// {{priority}} and {{demo}} pull in the shared prompt files; their own slots are filled with the rest.
// Recipe values fill any slot the caller leaves out.
export function renderPrompt(name, given) {
  // The first bootstrap runs before any recipe exists; its prompt names everything itself.
  const vars = { ...(existsSync(join(currentRecipeDir(), "recipe.json")) ? recipeVars() : {}), ...given };
  const shared = (file) => readFileSync(join(paths.prompts, `${file}.md`), "utf8").trim();
  const text = readFileSync(join(paths.prompts, `${name}.md`), "utf8")
    .replace("{{priority}}", () => shared("priority"))
    .replace("{{demo}}", () => shared("demo"));
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`prompt ${name}: missing {{${key}}}`);
    return String(vars[key]);
  });
}

// initPage (lib/demo.mjs loginInit) applies the recipe's login on every page. An Electron app has no
// browser of ours: the MCP attaches to its windows over CDP and the app's own login applies.
export function mcpArgs(shotsDir, initPage, cdp = demoCdp()) {
  if (cdp) return [PLAYWRIGHT_MCP, "--cdp-endpoint", cdp, "--output-dir", shotsDir];
  // Linux arm64 has no Google Chrome, the MCP default; setup/start.sh installs the bundled Chromium.
  return [PLAYWRIGHT_MCP, "--browser", "chromium", "--headless", "--isolated", "--output-dir", shotsDir, ...(initPage ? ["--init-page", initPage] : [])];
}

// PreToolUse hook that denies git branch/commit/push, gh and .env reads. A backstop: the runner
// still owns commits and the agent user has no GitHub write access.
export function guardSettings() {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(TOOL_DIR, "bin", "guard-hook.mjs"))}`;
  return { hooks: { PreToolUse: [{ matcher: "Bash|Read|Grep", hooks: [{ type: "command", command }] }] } };
}

// Claude Code, used for implementation and PR fixes.
// What a session is doing, from one stream-json event: its latest tool call in words, or null.
export function activityOf(event, cwd) {
  if (event?.type !== "assistant") return null;
  const call = (event.message?.content ?? []).findLast((c) => c.type === "tool_use");
  if (!call) return null;
  const input = call.input ?? {};
  const file = (f = "") => (f.startsWith(`${cwd}/`) ? f.slice(cwd.length + 1) : f.split("/").slice(-2).join("/"));
  const browser = call.name.match(/^mcp__playwright__browser_(\w+)$/)?.[1];
  if (browser === "navigate") return `브라우저: ${input.url} 열기`;
  if (browser === "take_screenshot") return "브라우저: 스크린샷";
  if (browser) return `브라우저: ${browser.replaceAll("_", " ")}`;
  switch (call.name) {
    case "Bash":
      return `명령 실행: ${String(input.command ?? "").split("\n")[0].slice(0, 160)}`;
    case "Read":
      return `파일 읽기: ${file(input.file_path)}`;
    case "Write":
      return `파일 쓰기: ${file(input.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `파일 수정: ${file(input.file_path)}`;
    case "Glob":
    case "Grep":
      return `코드 검색: ${input.pattern}`;
    case "TodoWrite":
      return input.todos?.find((t) => t.status === "in_progress")?.activeForm ?? null;
    default:
      return call.name;
  }
}

// A stdout handler for stream-json: whole lines only, however the chunks split them.
export function activityStream(cwd, onActivity) {
  let rest = "";
  return (chunk) => {
    const lines = (rest + chunk.toString()).split("\n");
    rest = lines.pop();
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const text = activityOf(event, cwd);
      if (text) onActivity(text);
    }
  };
}

// With onActivity, the session streams its events (stream-json) so the caller can show its progress.
// The last line is the same result message either way.
export async function runClaude({ cwd, prompt, schema, model, shotsDir, logFile, timeoutMs, initPage, onActivity }) {
  mkdirSync(shotsDir, { recursive: true });
  const mcpFile = join(shotsDir, "..", "mcp.json");
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["-y", ...mcpArgs(shotsDir, initPage)] } } }));
  const settingsFile = join(shotsDir, "..", "claude-settings.json");
  writeFileSync(settingsFile, JSON.stringify(guardSettings()));
  const args = [
    "-p",
    ...(onActivity ? ["--output-format", "stream-json", "--verbose"] : ["--output-format", "json"]),
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    mcpFile,
    "--settings",
    settingsFile,
    "--json-schema",
    JSON.stringify(schema),
  ];
  if (model) args.push("--model", model);
  const r = await run("claude", args, { cwd, input: prompt, timeoutMs, logFile, onStdout: onActivity && activityStream(cwd, onActivity) });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {}
  if (r.code !== 0 || !parsed || parsed.is_error || !parsed.structured_output) {
    return { ok: false, error: describeFailure("claude", r, parsed?.result ?? parsed?.subtype) };
  }
  return { ok: true, json: parsed.structured_output, usage: { costUsd: parsed.total_cost_usd, turns: parsed.num_turns } };
}

// Claude Code with no tools and no MCP: text in, structured JSON out. Used for ticket cards.
export async function runClaudePlain({ cwd, prompt, schema, model, logFile, timeoutMs }) {
  const args = ["-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--tools", "", "--json-schema", JSON.stringify(schema)];
  if (model) args.push("--model", model);
  const r = await run("claude", args, { cwd, input: prompt, timeoutMs, logFile });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {}
  if (r.code !== 0 || !parsed || parsed.is_error || !parsed.structured_output) {
    return { ok: false, error: describeFailure("claude", r, parsed?.result ?? parsed?.subtype) };
  }
  return { ok: true, json: parsed.structured_output };
}

// Codex CLI, used for the local adversarial review.
export async function runCodex({ cwd, prompt, schemaName, model, shotsDir, logFile, timeoutMs, initPage }) {
  mkdirSync(shotsDir, { recursive: true });
  const outFile = join(shotsDir, "..", "codex-result.json");
  const toml = (v) => JSON.stringify(v);
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "-C",
    cwd,
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-schema",
    join(paths.schemas, `${schemaName}.json`),
    "-o",
    outFile,
    "-c",
    `mcp_servers.playwright.command=${toml("npx")}`,
    "-c",
    `mcp_servers.playwright.args=${toml(["-y", ...mcpArgs(shotsDir, initPage)])}`,
    "-c",
    `model_reasoning_effort=${toml(settings().codexEffort)}`,
  ];
  if (model) args.push("-m", model);
  args.push("-");
  const r = await run("codex", args, { cwd, input: prompt, timeoutMs, logFile });
  let json = null;
  try {
    json = JSON.parse(readFileSync(outFile, "utf8"));
  } catch {}
  if (r.code !== 0 || !json) return { ok: false, error: describeFailure("codex", r) };
  const usage = r.stdout
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find((e) => e?.type === "turn.completed")?.usage;
  return { ok: true, json, usage };
}

function describeFailure(engine, r, detail) {
  if (r.timedOut) return `${engine}: 시간 초과`;
  const text = `${detail ?? ""}\n${r.stderr}\n${r.stdout}`.trim();
  return `${engine} 실패 (exit ${r.code}): ${text.slice(-1500)}`;
}
