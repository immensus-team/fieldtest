#!/usr/bin/env node
// Claude Code PreToolUse hook. Reads the event from stdin and denies tool calls that the
// runner owns (git branch/commit/push, gh) or that read .env files.
import { checkTool } from "../lib/guard.mjs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let event = {};
try {
  event = JSON.parse(raw);
} catch {}
const reason = checkTool(event.tool_name, event.tool_input);
if (reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }),
  );
}
