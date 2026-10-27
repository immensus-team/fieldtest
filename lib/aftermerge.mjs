// Follows main after watch merged PRs. Every merge commit gets main's own push `ci` run, which also
// runs the browser suite, so it checks a PR merged while behind main together with the PRs merged
// before it. A failure holds further auto-merges until main passes again and names the merges that
// may have caused it.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.mjs";
import { mainCiRun, newestMainCiRun } from "./github.mjs";
import { readJson, writeJson } from "./store.mjs";

const KEEP_MERGES = 50;
const file = () => join(paths.run, "after-merge.json");
const now = () => new Date().toISOString();

function save(s) {
  mkdirSync(paths.run, { recursive: true });
  writeJson(file(), s);
}

export const readAfterMerge = () => readJson(file(), { merges: [], broken: null });

export function recordMerge({ ticket, pr, sha }) {
  const s = readAfterMerge();
  s.merges = [...s.merges, { ticket, pr, sha, at: now(), ci: null }].slice(-KEEP_MERGES);
  save(s);
}

// For a failed main `ci`: that merge and the merges since the last one whose `ci` passed.
export function ciSuspects(merges, i) {
  let j = i;
  while (j > 0 && merges[j - 1].ci !== "success") j--;
  return merges.slice(j, i + 1);
}

const label = (m) => `${m.ticket} #${m.pr}`;

// Adds new failures to `broken`. Several merges failing for one cause stay one incident.
export function noteFailures(s) {
  s.merges.forEach((m, i) => {
    if (m.ci !== "failure" || m.reported) return;
    m.reported = true;
    const suspects = ciSuspects(s.merges, i).map(label);
    if (!s.broken) s.broken = { sha: m.sha, url: m.ciUrl, suspects, at: now(), notified: false };
    else s.broken.suspects = [...new Set([...s.broken.suspects, ...suspects])];
  });
}

export function describeBroken(b) {
  return `머지 후 main CI 실패 (${b.sha.slice(0, 7)}). 원인 후보: ${b.suspects.join(", ")}`;
}

// One watch pass. `notify(text, {name, log})` returns whether the message went out.
export async function followMain({ notify }) {
  const s = readAfterMerge();
  for (const m of s.merges) {
    if (m.ci) continue;
    const r = await mainCiRun(m.sha);
    if (r?.status === "completed") Object.assign(m, { ci: r.conclusion === "success" ? "success" : "failure", ciUrl: r.url });
  }
  noteFailures(s);
  if (s.broken && recovered(await newestMainCiRun())) {
    const was = s.broken;
    s.broken = null;
    if (was.notified) await notify(`✅ main 검사가 다시 통과했습니다. 멈췄던 자동 머지를 이어서 진행합니다.`, { name: `main-ok-${was.at}`, log: describeBroken(was) });
  }
  if (s.broken && !s.broken.notified) {
    s.broken.notified = await notify(`🚨 ${describeBroken(s.broken)}. 자동 머지를 멈췄습니다. main이 다시 통과하면 이어서 진행합니다.`, {
      name: `main-after-merge-${s.broken.at}`,
      log: `${describeBroken(s.broken)}\n실패한 run: ${s.broken.url ?? "(없음)"}`,
    });
  }
  save(s);
  return s;
}

// A failure clears when the newest main commit passes `ci`: a newer merge, or a rerun of the failed
// run when the failure was flaky. Nothing merges while the hold lasts, so a rerun is often the only
// way out (2026-10-22: a flaky WebKit spec held the queue). An older commit's success never counts.
export function recovered(run) {
  return run?.status === "completed" && run.conclusion === "success";
}
