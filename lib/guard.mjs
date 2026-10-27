// Rules for the Claude PreToolUse hook. A backstop only: the runner still owns commits
// (commitSquashed/restoreCandidate) and the agent user has no GitHub write access.

// git subcommands a session may run. Everything else is denied, so aliases or `git config`
// tricks can't reach commit/push through another name.
const GIT_ALLOWED = new Set(["status", "diff", "log", "show", "blame", "ls-files", "grep", "merge-base", "rev-parse", "restore", "merge"]);

// Splits on shell separators. Quoted `bash -c "..."` bodies stay inside a segment, and the
// git/gh search below runs on every segment, so hidden commands are still found.
function segments(command) {
  return command.split(/&&|\|\||[;|\n`]|\$\(/);
}

// Finds each `git ...` invocation and returns its subcommand and the rest of the segment.
function gitCalls(segment) {
  const calls = [];
  const re = /(?:^|[\s"'(=/])git((?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?|-[a-zA-Z]))*)\s+([\w-]+)([^]*)/g;
  for (let m = re.exec(segment); m; m = re.exec(segment)) {
    calls.push({ sub: m[2], rest: m[3] });
    re.lastIndex = m.index + 4;
  }
  return calls;
}

const ENV_FILE = /(?:^|[\s'"/=:])\.env(?:\.(?!example\b)[\w.-]+)?(?=$|[\s'"`;|&)*>])/;

export function isEnvPath(path) {
  if (!path) return false;
  const name = String(path).split("/").pop();
  return /^\.env(\..+)?$/.test(name) && name !== ".env.example";
}

export function checkBash(command) {
  for (const seg of segments(command)) {
    for (const { sub, rest } of gitCalls(seg)) {
      if (sub === "merge") {
        if (!/--no-commit\b/.test(rest)) return "git merge는 --no-commit으로만 실행한다. commit은 실행기가 한다.";
        continue;
      }
      if (!GIT_ALLOWED.has(sub)) return `git ${sub}는 이 실행에서 쓸 수 없다. branch·commit·push는 실행기가 맡는다.`;
    }
    if (/(?:^|[\s"'(=/])gh\s/.test(seg) || /(?:^|[\s"'(=/])gh$/.test(seg.trim())) return "gh는 이 실행에서 쓸 수 없다. GitHub 작업은 실행기가 맡는다.";
  }
  if (ENV_FILE.test(command)) return ".env 파일은 읽을 수 없다. .env.example만 허용한다.";
  return null;
}

// Returns a deny reason or null for one PreToolUse event.
export function checkTool(toolName, input = {}) {
  if (toolName === "Bash") return checkBash(String(input.command ?? ""));
  if (toolName === "Read" && isEnvPath(input.file_path)) return ".env 파일은 읽을 수 없다. .env.example만 허용한다.";
  if (toolName === "Grep" && (isEnvPath(input.path) || /\.env(?!\.example)/.test(String(input.glob ?? "")))) {
    return ".env 파일은 검색할 수 없다. .env.example만 허용한다.";
  }
  return null;
}
