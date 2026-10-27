import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { timed } from "./check-times.mjs";
import { MAX_CHANGED_FILES, MAX_CHANGED_LINES, REPRO_PASSES, TIMEOUTS } from "./config.mjs";
import { git, gitOut, run } from "./exec.mjs";
import { currentRecipe, fill } from "./recipe.mjs";
import { matchesAny, outOfScope } from "./screens.mjs";

const TEST_FILE = /(^|\/)(e2e\/.+\.ts|.+\.(spec|test)\.[cm]?[jt]sx?)$/;
const DISABLE = /\b(test|it|describe)\.(skip|only|fixme)\b|\btest\.fail\b|\.skip\(|\.only\(/;

// Ways to quiet a check instead of fixing the code. Checked on added lines only.
const BYPASS_ANY = [
  [/biome-ignore/, "biome-ignore"],
  [/@ts-ignore/, "@ts-ignore"],
  [/@ts-expect-error/, "@ts-expect-error"],
  [/@ts-nocheck/, "@ts-nocheck"],
  [/\sas any\b/, "as any"],
];
const BYPASS_TEST = [
  [/waitForTimeout\(/, "waitForTimeout("],
  [/force:\s*true/, "force: true"],
  [/\btest\.slow\(/, "test.slow("],
  [/setTimeout\(/, "setTimeout("],
  [/describe\.configure\([^)]*timeout/, "test.describe.configure timeout"],
];

// Parses `git diff --name-status` output.
export function parseNameStatus(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status[0], path: rest[rest.length - 1], from: rest.length > 1 ? rest[0] : null };
    });
}

// Splits a unified diff into per-file added and removed lines.
export function parseDiff(text) {
  const files = {};
  let current = null;
  for (const line of text.split("\n")) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      current = files[header[2]] = { added: [], removed: [] };
      continue;
    }
    if (!current || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return files;
}

const count = (lines, re) => lines.filter((l) => re.test(l)).length;

// Blocks the usual ways to make a failing check pass without fixing the code.
// `explained` turns weakened assertions in existing tests into a note for the reviewer;
// deleting or disabling tests is never allowed.
export function testTampering(changes, diff, { explained = false } = {}) {
  const blocking = [];
  const notes = [];
  for (const c of changes) {
    if (c.status === "D" && TEST_FILE.test(c.path)) blocking.push(`테스트 파일 삭제: ${c.path}`);
    if (/-snapshots\//.test(c.path) && c.status !== "A") blocking.push(`시각 기준 이미지 변경: ${c.path}`);
    const d = diff[c.path];
    if (!d || !TEST_FILE.test(c.path)) continue;
    if (count(d.added, DISABLE) > count(d.removed, DISABLE)) blocking.push(`테스트 비활성화(.skip/.only/.fixme): ${c.path}`);
    if (c.status === "M") {
      const lost = count(d.removed, /\bexpect\(/) - count(d.added, /\bexpect\(/);
      if (lost > 0) (explained ? notes : blocking).push(`기존 테스트의 expect ${lost}개 감소: ${c.path}`);
    }
  }
  for (const c of changes) {
    const d = diff[c.path];
    if (!d) continue;
    const rules = TEST_FILE.test(c.path) ? [...BYPASS_ANY, ...BYPASS_TEST] : BYPASS_ANY;
    for (const [re, label] of rules) {
      if (d.added.some((l) => re.test(l))) (explained ? notes : blocking).push(`새 줄에 ${label}: ${c.path}`);
    }
  }
  return { blocking, notes };
}

// A proof spec shows the fix (fails before, passes after) and leaves the candidate once the review
// passes. Tests that stay are counted like code: a free new file per fix filled the suite with 110
// one-bug specs in nine days (2026-10-25).
// Paths come from the recipe: e2e.dir is the Playwright test directory, unit.pattern the unit tests.
export const e2eDir = () => `${currentRecipe().e2e.dir.replace(/\/+$/, "")}/`;
export const proofDir = () => `${e2eDir()}proof/`;
const isSpec = (path) => path.startsWith(e2eDir()) && /\.spec\.[cm]?[jt]sx?$/.test(path);
const isUnitTest = (path) => {
  const unit = currentRecipe().unit;
  return Boolean(unit) && matchesAny(path, [unit.pattern]);
};
const isProof = (c) => c.status === "A" && c.path.startsWith(proofDir()) && isSpec(c.path);

// Files changed and lines added+removed, not counting proof specs.
export function changeSize(changes, diff) {
  const kept = changes.filter((c) => !isProof(c));
  const lines = kept.reduce((n, c) => n + (diff[c.path] ? diff[c.path].added.length + diff[c.path].removed.length : 0), 0);
  return { files: kept.length, lines };
}

// The tests a functional fix brings, by where they live.
export function reproTests(changes) {
  const live = changes.filter((c) => c.status === "A" || c.status === "M");
  return {
    proof: live.filter(isProof).map((c) => c.path),
    newSpecs: live.filter((c) => c.status === "A" && isSpec(c.path) && !isProof(c)).map((c) => c.path),
    changedSpecs: live.filter((c) => c.status === "M" && isSpec(c.path)).map((c) => c.path),
    unit: live.filter((c) => isUnitTest(c.path)).map((c) => c.path),
  };
}

// `playwright test --list` lines: "  [chromium] › file.spec.ts:12:5 › describe › title".
export function parseTestList(text) {
  return text
    .split("\n")
    .map((line) => line.match(/^\s*\[[^\]]+\] › (.+?):(\d+):\d+ › (.+?)\s*$/))
    .filter(Boolean)
    .map(([, file, line, title]) => ({ file, line: Number(line), title }));
}

// Locations (`file:line`) of tests in `after` whose titles `before` does not have.
export function addedTests(before, after) {
  const known = new Set(before.map((t) => `${t.file} › ${t.title}`));
  return [...new Set(after.filter((t) => !known.has(`${t.file} › ${t.title}`)).map((t) => `${t.file}:${t.line}`))];
}

export const SINGLE_LIMITS = { files: MAX_CHANGED_FILES, lines: MAX_CHANGED_LINES };

export function oversized(size, limits = SINGLE_LIMITS) {
  if (size.files > limits.files) return `변경 파일 ${size.files}개가 상한 ${limits.files}개를 넘는다`;
  if (size.lines > limits.lines) return `변경 ${size.lines}줄(테스트 포함, proof spec 제외)이 상한 ${limits.lines}줄을 넘는다`;
  return null;
}

export async function changesSince(wt, base) {
  const changes = parseNameStatus(await gitOut(wt, ["diff", "--name-status", "-M", base, "HEAD"]));
  const diff = parseDiff((await git(wt, ["diff", "-M", base, "HEAD"])).stdout);
  return { changes, diff };
}

// The recipe's install commands in order; the first failure is the result.
export async function install(wt, logFile) {
  let r = { code: 0, stdout: "", stderr: "" };
  for (const command of currentRecipe().install) {
    r = await run("/bin/sh", ["-c", command], { cwd: wt, logFile, timeoutMs: TIMEOUTS.install });
    if (r.code !== 0) return r;
  }
  return r;
}

// The two lanes share one process and one machine. Each check alone (a cold next dev, the test
// suite, next build) takes most of its cores, so the lanes run them one at a time. A check's timeout
// starts when it runs, not while it waits.
let checkQueue = Promise.resolve();

export function oneAtATime(fn) {
  const next = checkQueue.then(fn);
  checkQueue = next.catch(() => {});
  return next;
}

const quote = (arg) => `'${String(arg).replace(/'/g, "'\\''")}'`;
// Repo paths as the command running in `cwd` sees them.
export const relativeTo = (cwd, files) => files.map((f) => posix.relative(cwd, f.replace(/(:\d+)$/, "")) + (f.match(/(:\d+)$/)?.[1] ?? ""));
const checkEnv = () => ({ ...process.env, NEXT_TELEMETRY_DISABLED: "1" });

export function playwright(wt, args, logFile, timeoutMs) {
  const { e2e } = currentRecipe();
  return run("/bin/sh", ["-c", `${e2e.playwright} test ${args.map(quote).join(" ")} --project=${quote(e2e.project)}`], {
    cwd: join(wt, e2e.cwd),
    env: checkEnv(),
    logFile,
    timeoutMs,
  });
}

// `targets` are spec paths, optionally with `:line` to run only the tests there.
export function e2e(wt, targets, logFile) {
  return oneAtATime(() => playwright(wt, [...relativeTo(currentRecipe().e2e.cwd, targets), "--retries=0"], logFile, TIMEOUTS.e2e));
}

// The tests Playwright finds in these specs, without starting the app.
async function listTests(wt, specs, logFile) {
  const r = await playwright(wt, [...relativeTo(currentRecipe().e2e.cwd, specs), "--list"], logFile, TIMEOUTS.install);
  return parseTestList(r.stdout ?? "");
}

export function unitTests(wt, files, logFile) {
  const { unit } = currentRecipe();
  const command = fill(unit.run, { files: relativeTo(unit.cwd, files).map(quote).join(" ") });
  return oneAtATime(() => run("/bin/sh", ["-c", command], { cwd: join(wt, unit.cwd), logFile, timeoutMs: TIMEOUTS.e2e }));
}

// One recipe check ({name, command, cwd?}) at the worktree root or its cwd.
export function repoCheck(wt, { name, command, cwd = "." }, logFile) {
  return oneAtATime(() =>
    timed(name, logFile, () => run("/bin/sh", ["-c", command], { cwd: join(wt, cwd), env: checkEnv(), logFile, timeoutMs: TIMEOUTS.check })),
  );
}

export const checksOf = (stage) => currentRecipe().checks.filter((c) => c.stage === stage);

function step(steps, name, ok, detail = "") {
  steps.push({ name, ok, detail: ok ? "" : detail });
  return ok;
}

// Runs the gate on a committed candidate. Stops at the first failure, cheapest checks first.
// `full` adds the recipe's full checks; PR fix rounds leave them to CI.
export async function runGate({ wt, base, baseWt, screen, kind, explainedTests, newSpecReason, logFile, full = true, limits }) {
  const steps = [];
  const { changes, diff } = await changesSince(wt, base);
  const files = changes.map((c) => c.path);
  let needsHuman = null;
  let proof = [];
  const result = () => ({ ok: steps.every((s) => s.ok), steps, files, notes, needsHuman, proof });
  let notes = [];

  if (!step(steps, "변경 있음", files.length > 0, "변경된 파일이 없다")) return result();

  const tamper = testTampering(changes, diff, { explained: Boolean(explainedTests) });
  notes = tamper.notes;
  if (!step(steps, "기존 테스트 보호", tamper.blocking.length === 0, tamper.blocking.join("\n"))) return result();

  // Too large to review well: a human decides, no retry.
  const tooBig = oversized(changeSize(changes, diff), limits);
  if (!step(steps, "변경 크기", !tooBig, tooBig ?? "")) {
    needsHuman = tooBig;
    return result();
  }

  const outside = outOfScope(files, screen.paths, screen.forbidden, screen.ceiling);
  if (!step(steps, "변경 범위", outside.length === 0, outside.join("\n"))) return result();

  for (const c of checksOf("fast")) {
    const r = await repoCheck(wt, c, logFile);
    if (!step(steps, c.name, r.code === 0, tailOf(r))) return result();
  }

  const repro = reproTests(changes);
  if (kind === "functional") {
    proof = repro.proof;
    const any = repro.proof.length + repro.newSpecs.length + repro.changedSpecs.length + repro.unit.length > 0;
    if (!step(steps, "재현 테스트 추가", any, "기능 결함인데 재현 테스트(unit test, 기존 spec에 더한 test, proof spec)가 없다")) return result();
    if (!step(steps, "새 spec 파일 이유", !repro.newSpecs.length || Boolean(newSpecReason), `proof/ 밖에 새 spec 파일을 만들었는데 newSpecReason이 없다: ${repro.newSpecs.join(", ")}`)) return result();
    // Tests already in a changed spec say nothing about this defect; only the added ones run.
    const before = repro.changedSpecs.length ? await listTests(baseWt, repro.changedSpecs, logFile) : [];
    // Copy every new e2e file (specs and their helpers), changed specs and the unit tests onto the base tree.
    const copied = changes.filter((c) => (c.status === "A" && c.path.startsWith(e2eDir())) || repro.changedSpecs.includes(c.path) || repro.unit.includes(c.path));
    for (const c of copied) {
      mkdirSync(dirname(join(baseWt, c.path)), { recursive: true });
      cpSync(join(wt, c.path), join(baseWt, c.path));
    }
    const added = repro.changedSpecs.length ? addedTests(before, await listTests(baseWt, repro.changedSpecs, logFile)) : [];
    if (!step(steps, "기존 spec에 더한 test", !repro.changedSpecs.length || added.length > 0 || repro.unit.length + repro.proof.length + repro.newSpecs.length > 0, `바꾼 spec에 새 test가 없다: ${repro.changedSpecs.join(", ")}`)) return result();
    const targets = [...repro.proof, ...repro.newSpecs, ...added.map((t) => `${e2eDir()}${t}`)];
    const runAll = async (tree) => {
      const outs = [];
      if (targets.length) outs.push(await e2e(tree, targets, logFile));
      if (repro.unit.length) outs.push(await unitTests(tree, repro.unit, logFile));
      return outs;
    };
    const onBase = await runAll(baseWt);
    const failedOnBase = onBase.every((r) => r.code !== 0);
    if (!step(steps, "재현 테스트가 base에서 실패", failedOnBase, "고치기 전 코드에서도 통과하는 재현 테스트가 있다. 결함을 재현하지 못한다.")) return result();
    // The reviewer checks that the tests failed on the defect's assertion, not on a missing name or import.
    notes.push(`재현 테스트의 base 실패 출력:\n${onBase.map(tailOf).join("\n")}`);
    if (repro.proof.length) notes.push(`proof spec은 검토가 끝나면 후보에서 빠진다: ${repro.proof.join(", ")}`);
    for (let i = 1; i <= REPRO_PASSES; i++) {
      const outs = await runAll(wt);
      const bad = outs.find((r) => r.code !== 0);
      if (!step(steps, `재현 테스트 통과 ${i}/${REPRO_PASSES}`, !bad, bad ? tailOf(bad) : "")) return result();
    }
  }

  // A screen names its specs without the extension: whichever of these exists in the repo.
  const related = screen.specs.flatMap((s) => [".spec.ts", ".spec.tsx", ".spec.js", ".spec.mjs"].map((ext) => `${e2eDir()}${s}${ext}`)).filter((s) => existsSync(join(wt, s)));
  if (related.length) {
    const r = await e2e(wt, related, logFile);
    if (!step(steps, "관련 e2e", r.code === 0, tailOf(r))) return result();
  }

  if (full) {
    for (const c of checksOf("full")) {
      const r = await repoCheck(wt, c, logFile);
      if (!step(steps, c.name, r.code === 0, tailOf(r))) return result();
    }
  }
  return result();
}

export function tailOf(r) {
  if (r.code === 0) return "";
  const text = `${r.stdout}\n${r.stderr}`.trim();
  return (r.timedOut ? "시간 초과\n" : "") + text.slice(-3000);
}

export function gateSummary(gate) {
  return gate.steps.map((s) => `- ${s.ok ? "통과" : "실패"}: ${s.name}${s.detail ? `\n  ${s.detail.replace(/\n/g, "\n  ")}` : ""}`).join("\n");
}

// The local Codex review's leftovers: minor findings and what it could not check. Blocking findings
// never reach a ticket, so these are what a person still needs to know.
export function reviewLines(review) {
  if (!review) return "";
  const minor = (review.findings ?? []).filter((f) => f.severity !== "blocking");
  return [
    `- 판정: ${review.verdict === "pass" ? "통과" : review.verdict}`,
    `- 사소한 지적:${minor.length ? "" : " 없음"}`,
    ...minor.map((f) => `  - ${f.title}`),
    `- 확인하지 못한 범위: ${review.notChecked?.trim() || "없음"}`,
  ].join("\n");
}

export function hasShots(dir) {
  if (!existsSync(dir)) return { before: 0, after: 0 };
  const files = readdirSync(dir);
  return {
    before: files.filter((f) => f.startsWith("before-")).length,
    after: files.filter((f) => f.startsWith("after-")).length,
  };
}

export function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
