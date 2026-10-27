import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { currentRecipe, recipeScreensDir } from "./recipe.mjs";

// <recipe>/screens/<id>.md: a small "key: value" header between --- lines, then the mission text.
// A screen without `paths` may change what the recipe allows.
export function parseScreen(text, file = "", allowed = currentRecipe().paths.allowed) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing --- header`);
  const head = Object.fromEntries(
    m[1]
      .split("\n")
      .filter((l) => l.includes(":"))
      .map((l) => {
        const i = l.indexOf(":");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
  const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
  if (!head.id || !head.url) throw new Error(`${file}: id and url are required`);
  return {
    id: head.id,
    url: head.url,
    specs: list(head.specs),
    paths: head.paths ? list(head.paths) : allowed,
    mission: m[2].trim(),
  };
}

export function loadScreens(dir = recipeScreensDir(currentRecipe())) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseScreen(readFileSync(join(dir, f), "utf8"), f));
}

// Minimal glob: ** crosses directories, * stays inside one segment.
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file, globs) {
  return globs.some((g) => globToRegExp(g).test(file));
}

// A file is in scope when the screen allows it, the recipe allows it (the ceiling: an agent-written
// screen guide may narrow the recipe's paths, never widen them) and nothing forbids it.
export function outOfScope(files, allowed, forbidden, ceiling) {
  forbidden ??= currentRecipe().paths.forbidden;
  ceiling ??= currentRecipe().paths.allowed;
  return files.filter((f) => matchesAny(f, forbidden) || !matchesAny(f, allowed) || !matchesAny(f, ceiling));
}
