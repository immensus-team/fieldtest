import { must, run } from "./exec.mjs";
import { baseBranch, currentRecipe, repoSlug } from "./recipe.mjs";

const R = () => ["--repo", repoSlug()];

async function ghJson(args) {
  return JSON.parse((await must("gh", args)).stdout);
}

// `gh api --paginate --jq '.[]'` prints one compact object per line.
async function ghApiList(path) {
  const r = await must("gh", ["api", "--paginate", path, "--jq", ".[]"]);
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function prView(n) {
  return ghJson(["pr", "view", String(n), ...R(), "--json", "number,state,isDraft,headRefOid,headRefName,mergeable,mergeStateStatus,url,body"]);
}

export async function prDiff(n) {
  return (await must("gh", ["pr", "diff", String(n), ...R()])).stdout;
}

export function prListByHead(branch) {
  return ghJson(["pr", "list", ...R(), "--head", branch, "--state", "all", "--json", "number,url,state,headRefOid"]);
}

export function openPrsWithFiles() {
  return ghJson(["pr", "list", ...R(), "--state", "open", "--limit", "100", "--json", "number,title,headRefName,files"]);
}

// Inline review comments of a PR, replies included.
export function prInlineComments(n) {
  return ghApiList(`repos/${repoSlug()}/pulls/${n}/comments`);
}

// One review comment on `commit`: on `line` (right side), or on the whole file when line is null.
export async function postReviewComment(n, { commit, path, line, body }) {
  const where = line ? { line, side: "RIGHT" } : { subject_type: "file" };
  const r = await must("gh", ["api", "-X", "POST", `repos/${repoSlug()}/pulls/${n}/comments`, "--input", "-"], { input: JSON.stringify({ body, commit_id: commit, path, ...where }) });
  return JSON.parse(r.stdout);
}

// Status check names the main branch rules require (e.g. "ci", "desktop (cargo check)").
export async function requiredContexts() {
  const rules = await ghJson(["api", `repos/${repoSlug()}/rules/branches/${baseBranch()}`]);
  return rules.filter((r) => r.type === "required_status_checks").flatMap((r) => r.parameters.required_status_checks.map((c) => c.context));
}

// Decides from the reported checks and the required names. A required check that hasn't been
// reported yet (like the "ci" job, which starts after test and e2e) counts as pending.
// A run that a newer run of the same workflow cancelled (a push while it ran) is not a failure.
// Only the newest run of a workflow counts: the draft PR's run skips every job, and its skipped `ci`
// would pass the PR while the ready run's `ci` has not been reported yet.
const runOf = (c) => Number(c.link?.match(/\/actions\/runs\/(\d+)/)?.[1] ?? 0);

export function judgeChecks(checks, required) {
  const newest = new Map();
  for (const c of checks) if (c.workflow) newest.set(c.workflow, Math.max(newest.get(c.workflow) ?? 0, runOf(c)));
  const all = checks.filter((c) => !c.workflow || !runOf(c) || runOf(c) === newest.get(c.workflow));
  const list = all.filter((c) => c.bucket !== "cancel" || !all.some((o) => o.workflow === c.workflow && o.bucket !== "cancel" && o.startedAt > c.startedAt));
  const reported = new Map(list.map((c) => [c.name, c]));
  const missing = required.filter((name) => !reported.has(name));
  const relevant = required.length ? required.map((name) => reported.get(name)).filter(Boolean) : list;
  const failed = list.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
  // A failed required check brings the failed jobs of its workflow along, since `ci` only names the job
  // that failed. Other failures, such as the Vercel preview, don't block a merge or start a fix round.
  const workflows = new Set(relevant.filter((c) => failed.includes(c)).map((c) => c.workflow));
  return {
    pending: missing.length > 0 || relevant.length === 0 || relevant.some((c) => c.bucket === "pending"),
    failing: failed.filter((c) => workflows.has(c.workflow)),
    optional: failed.filter((c) => !workflows.has(c.workflow)),
    missing,
  };
}

// One entry of the PR's status check rollup in the shape judgeChecks reads (the fields and buckets of
// `gh pr checks --json`). The rollup lists every run; `gh pr checks` keeps one check per name, and
// kept the draft run's skipped `ci` over the ready run's passed one (#430, 2026-10-23).
export function checkOfRollup(c) {
  if (c.__typename === "StatusContext") {
    const bucket = c.state === "SUCCESS" ? "pass" : ["FAILURE", "ERROR"].includes(c.state) ? "fail" : "pending";
    return { name: c.context, state: c.state, bucket, link: c.targetUrl, workflow: "", startedAt: c.startedAt, description: c.description ?? "" };
  }
  const conclusion = c.status === "COMPLETED" ? c.conclusion : null;
  const bucket = !conclusion
    ? "pending"
    : ["SUCCESS", "NEUTRAL"].includes(conclusion)
      ? "pass"
      : conclusion === "SKIPPED"
        ? "skipping"
        : conclusion === "CANCELLED"
          ? "cancel"
          : "fail";
  return { name: c.name, state: conclusion ?? c.status, bucket, link: c.detailsUrl, workflow: c.workflowName ?? "", startedAt: c.startedAt, description: "" };
}

export async function requiredChecks(n) {
  const pr = await ghJson(["pr", "view", String(n), ...R(), "--json", "statusCheckRollup"]);
  return judgeChecks(pr.statusCheckRollup.map(checkOfRollup), await requiredContexts());
}

export async function failedLog(check) {
  const job = check.link?.match(/\/job\/(\d+)/)?.[1];
  if (!job) return "";
  const r = await run("gh", ["run", "view", "--job", job, "--log-failed", ...R()]);
  return r.stdout.split("\n").slice(-150).join("\n");
}

export function replyToComment(n, commentId, body) {
  return must("gh", ["api", "-X", "POST", `repos/${repoSlug()}/pulls/${n}/comments/${commentId}/replies`, "-f", `body=${body}`]);
}

export function commentPr(n, bodyFile) {
  return must("gh", ["pr", "comment", String(n), ...R(), "--body-file", bodyFile]);
}

export function editPrBody(n, bodyFile) {
  return must("gh", ["pr", "edit", String(n), ...R(), "--body-file", bodyFile]);
}

export async function createDraftPr({ branch, title, bodyFile }) {
  const r = await must("gh", ["pr", "create", ...R(), "--draft", "--base", baseBranch(), "--head", branch, "--title", title, "--body-file", bodyFile]);
  const url = r.stdout.trim().split("\n").pop();
  return { url, number: Number(url.match(/\/pull\/(\d+)/)[1]) };
}

// Commits on main the PR head does not have yet.
export async function behindMain(head) {
  return Number((await must("gh", ["api", `repos/${repoSlug()}/compare/${baseBranch()}...${head}`, "--jq", ".behind_by"])).stdout.trim());
}

// Squash only (the main ruleset allows nothing else). --match-head-commit refuses if the head moved
// after the human looked at it.
export function mergeSquash(n, head) {
  return must("gh", ["pr", "merge", String(n), ...R(), "--squash", "--match-head-commit", head]);
}

// The commit a squash merge put on main.
export async function mergeCommit(n) {
  return (await must("gh", ["pr", "view", String(n), ...R(), "--json", "mergeCommit", "--jq", ".mergeCommit.oid"])).stdout.trim();
}

const RUN_FIELDS = "databaseId,headSha,status,conclusion,url,createdAt";

// The base branch's own CI run for one commit (the push run of recipe.ci.workflow), or null before it
// shows up. A repo without push CI (ci: null) has none.
export async function mainCiRun(sha) {
  const ci = currentRecipe().ci;
  if (!ci) return null;
  const runs = await ghJson(["run", "list", ...R(), "--workflow", ci.workflow, "--event", "push", "--commit", sha, "--limit", "1", "--json", RUN_FIELDS]);
  return runs[0] ?? null;
}

// The CI push run of the newest base commit, finished or not. A rerun keeps its place.
export async function newestMainCiRun() {
  const ci = currentRecipe().ci;
  if (!ci) return null;
  const runs = await ghJson(["run", "list", ...R(), "--workflow", ci.workflow, "--event", "push", "--branch", baseBranch(), "--limit", "1", "--json", RUN_FIELDS]);
  return runs[0] ?? null;
}

export function closePr(n, comment) {
  return must("gh", ["pr", "close", String(n), ...R(), "--comment", comment]);
}

// The draft head's own ci run (every job skipped) must end before the PR turns ready. Started together,
// it can cancel the ready_for_review run in the same concurrency group and leave `ci` skipped, which
// the ruleset does not accept. After the timeout the PR turns ready anyway.
export async function waitDraftCi(head, timeoutMs = 5 * 60 * 1000) {
  const ci = currentRecipe().ci;
  if (!ci) return;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const runs = await ghJson(["run", "list", ...R(), "--workflow", ci.workflow, "--commit", head, "--json", "status"]);
    if (runs.length && runs.every((r) => r.status === "completed")) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

export function markReady(n) {
  return must("gh", ["pr", "ready", String(n), ...R()]);
}

// Replaces the text between two HTML comment markers, or appends the block when missing.
export function replaceBlock(body, name, content) {
  const start = `<!-- quality:${name} -->`;
  const end = `<!-- /quality:${name} -->`;
  const block = `${start}\n${content}\n${end}`;
  const i = body.indexOf(start);
  const j = body.indexOf(end);
  if (i !== -1 && j > i) return body.slice(0, i) + block + body.slice(j + end.length);
  return `${body.trimEnd()}\n\n${block}\n`;
}
