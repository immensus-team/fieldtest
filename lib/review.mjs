// Server-side PR review (design §10). Codex review on GitHub has to be switched on per repo in the
// ChatGPT settings, which no API does, so the installer's own Codex login reviews each PR head here:
// watch (human) queues a request, the agent loop writes the result, watch posts it to the PR.
// `codex review` (CLI 0.162.1) prints text only, so the review runs through runCodex with a JSON schema.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { commentPr, postReviewComment, prInlineComments } from "./github.mjs";
import { writeTemp } from "./publish.mjs";
import { listTickets, readJson, ticketDir, writeJson } from "./store.mjs";

export const REVIEW_MARKER = "<!-- fieldtest-review -->";

const dir = (id) => join(ticketDir(id), "pr-reviews");
const file = (id, head, kind) => join(dir(id), `${head}${kind}.json`);

// Asks the agent loop for a review of this head. False when it was already asked.
export function queueReview(t, head) {
  const f = file(t.id, head, ".request");
  if (existsSync(f)) return false;
  mkdirSync(dir(t.id), { recursive: true });
  writeJson(f, { id: t.id, number: t.pr.number, head, at: new Date().toISOString() });
  return true;
}

// Requests for PRs still in review: a merged or closed PR's request would hold the lane for nothing.
export function pendingReviews(tickets = listTickets()) {
  const out = [];
  for (const t of tickets) {
    if (!["pr-review", "final-review"].includes(t.status) || !existsSync(dir(t.id))) continue;
    for (const f of readdirSync(dir(t.id))) {
      const head = f.match(/^(.+)\.request\.json$/)?.[1];
      if (head && !existsSync(file(t.id, head, ""))) out.push({ id: t.id, head });
    }
  }
  return out;
}

function write(id, head, kind, value) {
  mkdirSync(dir(id), { recursive: true });
  writeJson(file(id, head, kind), { at: new Date().toISOString(), ...value });
}

export const reviewResult = (id, head) => readJson(file(id, head, ""), null);
export const writeReviewResult = (id, head, result) => write(id, head, "", { head, ...result });
export const postedReview = (id, head) => readJson(file(id, head, ".posted"), null);
export const writePosted = (id, head, posted) => write(id, head, ".posted", posted);

export const REVIEW_TRIES = 3;

// One more failed try at reviewing `head`. The third ends it: the result says the review failed, the
// PR goes to the human's final review with that note, and the lane moves on.
export function reviewFailed(id, head, error) {
  const f = file(id, head, ".request");
  const req = readJson(f, {});
  const failures = (req.failures ?? 0) + 1;
  writeJson(f, { ...req, failures, error });
  if (failures < REVIEW_TRIES) return false;
  writeReviewResult(id, head, { failed: error, summary: "", findings: [] });
  return true;
}

// Lines a review comment can sit on: the right side (context and added lines) of every hunk.
export function rightLines(diff) {
  const lines = new Map();
  let path = null;
  let n = 0;
  for (const l of diff.split("\n")) {
    const head = l.match(/^diff --git a\/.+ b\/(.+)$/);
    if (head) {
      path = head[1];
      lines.set(path, new Set());
      continue;
    }
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      n = Number(hunk[1]);
      continue;
    }
    if (!path || l.startsWith("+++") || l.startsWith("---") || l.startsWith("-") || l.startsWith("\\")) continue;
    if (l.startsWith("+") || l.startsWith(" ")) lines.get(path).add(n++);
  }
  return lines;
}

// Where each finding can be posted: on its line, on its file, or only in the summary comment.
export function anchorFindings(findings, diff) {
  const lines = rightLines(diff);
  return findings.map((f) => ({ ...f, anchor: lines.get(f.path)?.has(f.line) ? "line" : lines.has(f.path) ? "file" : "summary" }));
}

// The comments a Codex review JSON turns into: P0 and P1 only (what blocks a merge, as Codex on GitHub
// reports), anchored to the diff.
export function reviewFindings(json, diff) {
  const blocking = json.findings.filter((f) => f.priority === "P0" || f.priority === "P1");
  return anchorFindings(
    blocking.map((f) => ({ path: f.path, line: f.line, body: `**${f.priority}** ${f.title}\n\n${f.body}` })),
    diff,
  );
}

const rejected = (e) => /\b422\b|Unprocessable/i.test(e.message);

// Posts the agent's result for `head`: one comment per finding the diff can hold, and a summary
// comment with the rest. A line GitHub rejects (its diff differs from the local one) goes on the file,
// then into the summary. Progress is saved per comment, so a failed run resumes without posting twice.
// Returns the inline comment ids, which the fix rounds answer.
export async function postReview(t, head, { post = postReviewComment, comment = commentPr } = {}) {
  const result = reviewResult(t.id, head);
  const progress = readJson(file(t.id, head, ".progress"), { done: {}, rest: [] });
  const save = () => write(t.id, head, ".progress", progress);
  if (result.failed) {
    await comment(t.pr.number, writeTemp("review.md", `**fieldtest 리뷰 (Codex)** \`${head.slice(0, 7)}\`: 서버 리뷰를 ${REVIEW_TRIES}번 시도했지만 실패했습니다.\n\n${result.failed}\n\n${REVIEW_MARKER}\n`));
    writePosted(t.id, head, { ids: [], failed: result.failed });
    return [];
  }
  for (const [i, f] of result.findings.entries()) {
    if (i in progress.done) continue;
    const body = `${f.body}\n\n${REVIEW_MARKER}`;
    let id = null;
    for (const line of f.anchor === "line" ? [f.line, null] : f.anchor === "file" ? [null] : []) {
      try {
        id = (await post(t.pr.number, { commit: head, path: f.path, line, body })).id;
        break;
      } catch (e) {
        if (!rejected(e)) throw e;
      }
    }
    if (id === null) progress.rest.push(f);
    progress.done[i] = id;
    save();
  }
  const ids = Object.values(progress.done).filter((id) => id !== null);
  const rest = progress.rest;
  const lines = [`**fieldtest 리뷰 (Codex)** \`${head.slice(0, 7)}\`: ${result.summary}`];
  if (!result.findings.length) lines.push("", "지적 없음.");
  if (rest.length) lines.push("", "diff 밖을 가리킨 참고 지적:", ...rest.map((f) => `- \`${f.path}:${f.line}\` ${f.body.split("\n")[0]}`));
  await comment(t.pr.number, writeTemp("review.md", `${lines.join("\n")}\n\n${REVIEW_MARKER}\n`));
  writePosted(t.id, head, { ids });
  return ids;
}

// Done once the review of `head` is on the PR. Findings are its inline comments nobody answered yet:
// the fix round replies to each (fixed, accepted risk or disagreed), from the same GitHub account.
export async function reviewState(t, head, { inline } = {}) {
  const posted = postedReview(t.id, head);
  if (!posted) return { done: false, findings: [] };
  if (posted.failed) return { done: true, findings: [], failed: posted.failed };
  const comments = inline ?? (await prInlineComments(t.pr.number));
  const answered = new Set(comments.filter((c) => c.in_reply_to_id).map((c) => c.in_reply_to_id));
  const findings = comments
    .filter((c) => posted.ids.includes(c.id) && !answered.has(c.id))
    .map((c) => ({ id: c.id, path: c.path, line: c.line ?? c.original_line, body: c.body }));
  return { done: true, findings };
}

// What watch calls for a PR head: ask for the review, post it when the agent wrote it, then its state.
export async function reviewOf(t, head) {
  if (!postedReview(t.id, head)) {
    if (!reviewResult(t.id, head)) {
      queueReview(t, head);
      return { done: false, findings: [] };
    }
    await postReview(t, head);
  }
  return reviewState(t, head);
}
