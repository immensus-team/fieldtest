// Which tickets go from ticket to merge without the human (2026-10-21). Chosen from the first 69
// merged tickets: the human changed the result for high severity (product calls), visual fixes and
// copy (taste), and grouped fixes touch shared code. A small functional fix with a repro spec of low
// or medium severity merged as the agent left it. Everything else keeps both human decisions.
// The limits are the recipe's autoRoute; a repo without one (null) sends every ticket to the human.
import { currentRecipe } from "./recipe.mjs";

// Copy the human reads on screen: text in the UI's script, or for Latin-script UIs a string literal or
// JSX text with a word in it.
const SCRIPT = { ko: /[ㄱ-ㆎ가-힣]/, ja: /[ぁ-んァ-ン一-龯]/, zh: /[一-龯]/ };
const LITERAL = /(["'`])[^"'`]*\p{L}{2,}[^"'`]*\1|>[^<>{}]*\p{L}{2,}[^<>{}]*</u;

// Source files of a unified diff (specs and tests left out) with their changed lines, and whether a
// changed line carries on-screen copy.
export function sourceChanges(patch, recipe = currentRecipe()) {
  const e2e = `${recipe.e2e.dir.replace(/\/+$/, "")}/`;
  const isSpec = (path) => path.startsWith(e2e) || /\.test\.[cm]?[jt]sx?$/.test(path);
  const copy = SCRIPT[recipe.uiLanguage] ?? LITERAL;
  const files = [];
  let file = null;
  for (const line of patch.split("\n")) {
    const head = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
    if (head) {
      file = isSpec(head[2]) ? null : { path: head[2], lines: 0, copy: false };
      if (file) files.push(file);
      continue;
    }
    if (!file || line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      file.lines++;
      if (copy.test(line.slice(1))) file.copy = true;
    }
  }
  return files;
}

// { auto, reasons }: reasons say why the human decides, empty when the ticket goes on its own.
// patch is the candidate's diff, or the PR's diff before an automatic merge.
export function routeOf(t, patch, recipe = currentRecipe()) {
  const rule = recipe.autoRoute;
  if (!rule) return { auto: false, reasons: ["이 레포는 자동 경로 규칙이 없음"] };
  const reasons = [];
  if (t.status === "needs-human") reasons.push("판단 필요");
  if (t.severity === "high") reasons.push("심각도 high");
  if (t.group) reasons.push("묶음 수정");
  else if (t.kind !== "functional") reasons.push("시각 수정");
  if (t.humanTouched) reasons.push("사람이 수정을 요청함");
  // Whether an improvement is worth having is the human's call (design, 2026-10-24).
  if (t.track === "improve") reasons.push("개선 티켓");
  if (t.track === "propose") reasons.push("기능 제안");
  const files = sourceChanges(patch, recipe);
  const lines = files.reduce((n, f) => n + f.lines, 0);
  if (files.length > rule.files) reasons.push(`소스 ${files.length}파일 (자동 상한 ${rule.files})`);
  if (lines > rule.lines) reasons.push(`소스 ${lines}줄 (자동 상한 ${rule.lines})`);
  const copy = rule.copyCheck ? files.filter((f) => f.copy).map((f) => f.path.split("/").pop()) : [];
  if (copy.length) reasons.push(`화면 문구 변경 (${copy.join(", ")})`);
  return { auto: reasons.length === 0, reasons };
}
