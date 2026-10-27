// Before/after screenshot pairs, shared by the dashboard and the PR body.
import { basename } from "node:path";

const SHOT_WORDS = { light: "라이트", dark: "다크" };

// Pairs before-<variant>.png with after-<variant>.png, narrow screens first, light before dark.
export function shotRows(names) {
  const rows = new Map();
  for (const name of names) {
    const m = basename(name).match(/^(before|after)-(.+)\.png$/);
    if (!m) continue;
    const row = rows.get(m[2]) ?? { variant: m[2] };
    row[m[1]] = name;
    rows.set(m[2], row);
  }
  const width = (v) => Number(v.match(/\d+/)?.[0] ?? Number.MAX_SAFE_INTEGER);
  const dark = (v) => (/dark/.test(v) ? 1 : 0);
  return [...rows.values()]
    .sort((a, b) => width(a.variant) - width(b.variant) || dark(a.variant) - dark(b.variant) || a.variant.localeCompare(b.variant))
    .map((r) => ({ ...r, label: r.variant.split("-").map((w) => (/^\d+$/.test(w) ? `${w}px` : (SHOT_WORDS[w] ?? w))).join(" · ") }));
}
