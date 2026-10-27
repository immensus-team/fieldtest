// Slack DM between the install's fieldtest bot and the human. Each ticket that reaches the human gets one
// message with buttons (진행, 거절, 수정); later states go to its thread. The human decides with the
// buttons (거절 and 수정 open a box for the reason or the new requirement) or with a thread reply
// (진행, 거절 <이유>, 수정 <내용>).
//
// Two processes, both as the human user:
// - `fieldtest slack` (systemd, always on) holds the Socket Mode connection. It only receives button
//   clicks and form submissions, writes them to a queue and wakes `fieldtest watch`.
// - `fieldtest watch` runs the queued and replied commands with the human's GitHub login, the same
//   functions as the terminal CLI, and keeps the messages up to date.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readCard } from "./card.mjs";
import { CONFIG_DIR, INSTALL, TOOL_DIR } from "./config.mjs";
import { run } from "./exec.mjs";
import * as human from "./human.mjs";
import { HUMAN_WAITING, STATUS_LABEL, listTickets, readJson, readTicket, severityOf, writeJson } from "./store.mjs";
import { autoFinal, buttonsFor, failureSummary } from "./view.mjs";

export { buttonsFor, failureSummary };

const ENV_FILE = join(CONFIG_DIR, "slack.env");
const MAP_FILE = join(CONFIG_DIR, "slack-map.json");
export const QUEUE_DIR = join(CONFIG_DIR, "slack-queue");
// One line per command run from the queue or a thread reply: what the dashboard shows as the result.
export const COMMANDS_FILE = join(CONFIG_DIR, "commands.jsonl");

const TERMINAL = ["merged", "rejected", "closed"];
// Finished tickets keep their thread open for commands this long, so a late reply still gets an answer.
const CLOSED_THREAD_MS = 24 * 60 * 60 * 1000;

function env() {
  if (!existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    readFileSync(ENV_FILE, "utf8")
      .split("\n")
      .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()]),
  );
}

export function slackConfigured() {
  const e = env();
  return Boolean(e.SLACK_BOT_TOKEN && e.SLACK_USER_ID);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

async function api(method, params = {}, token = env().SLACK_BOT_TOKEN) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, typeof v === "string" ? v : JSON.stringify(v));
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body,
    });
    if (res.status === 429) {
      await sleep(Number(res.headers.get("retry-after") ?? 1) * 1000);
      continue;
    }
    const json = await res.json();
    if (!json.ok) throw new Error(`Slack ${method}: ${json.error}${json.response_metadata?.messages ? ` ${json.response_metadata.messages.join("; ")}` : ""}`);
    return json;
  }
  throw new Error(`Slack ${method}: rate limited`);
}

function loadMap() {
  return readJson(MAP_FILE, { tickets: {} });
}

async function channelOf(map) {
  if (!map.channel) map.channel = (await api("conversations.open", { users: env().SLACK_USER_ID })).channel.id;
  return map.channel;
}

// The Slack app of this install (design §11): made by the installer from setup/slack-manifest.json.
export function slackManifest(installName = INSTALL.name) {
  const m = JSON.parse(readFileSync(join(TOOL_DIR, "setup", "slack-manifest.json"), "utf8"));
  const name = `fieldtest · ${installName}`;
  m.display_information.name = name;
  m.features.bot_user.display_name = name;
  return m;
}

// Slack's "Create New App" with the manifest filled in. manifest_json is not in Slack's docs, so the
// setup page shows the manifest text next to the link.
export const manifestUrl = (manifest) => `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;

// The first person who DMs the bot owns this install's notifications: their id is saved and they get a
// confirmation. Anyone after that is ignored.
export async function claimOwner(event) {
  if (env().SLACK_USER_ID || event.bot_id || event.subtype || !event.user) return false;
  appendFileSync(ENV_FILE, `${readFileSync(ENV_FILE, "utf8").endsWith("\n") ? "" : "\n"}SLACK_USER_ID=${event.user}\n`);
  await post(event.channel, `fieldtest · ${INSTALL.name} 연결됨. 사람이 결정할 티켓과 오류를 이 DM으로 알립니다.`);
  return true;
}

function post(channel, text, extra = {}) {
  return api("chat.postMessage", { channel, text, unfurl_links: false, unfurl_media: false, ...extra });
}

// For `fieldtest doctor`: the token works and the DM with the human opens.
export async function slackAuth() {
  if (!slackConfigured()) throw new Error(`${ENV_FILE}에 SLACK_BOT_TOKEN과 SLACK_USER_ID가 없다`);
  if (!env().SLACK_APP_TOKEN) throw new Error(`${ENV_FILE}에 SLACK_APP_TOKEN(Socket Mode)이 없다`);
  const auth = await api("auth.test");
  const map = loadMap();
  const channel = await channelOf(map);
  writeJson(MAP_FILE, map);
  return { team: auth.team, user: auth.user, channel };
}

// Slack splits a message over 4,000 characters, which breaks a code block, so a log goes out as a few
// shorter blocks. The end of a log holds the failure: only that part is posted, newest block last.
const LOG_CHUNK = 3_500;
const LOG_CHUNKS = 3;

export function logBlocks(log) {
  // Escaped first: Slack counts &lt; as four characters.
  let rest = escape(log.replaceAll("```", "'''").trimEnd());
  const chunks = [];
  while (rest && chunks.length < LOG_CHUNKS) {
    let cut = Math.max(0, rest.length - LOG_CHUNK);
    const nl = rest.indexOf("\n", cut);
    const amp = rest.lastIndexOf("&", cut);
    // Start at a line when one begins soon enough, and never inside an escape.
    if (cut > 0 && nl !== -1 && nl - cut < 500) cut = nl + 1;
    else if (amp !== -1 && cut - amp < 5 && !rest.slice(amp, cut).includes(";")) cut = amp;
    chunks.unshift(rest.slice(cut));
    rest = rest.slice(0, cut);
  }
  if (rest) chunks[0] = `…\n${chunks[0]}`;
  return chunks.map((c) => `\`\`\`\n${c}\n\`\`\``);
}

// Top-level DM for events that belong to no ticket (main broken, loop failing). A log goes to its thread.
export async function slackNotice(text, { log } = {}) {
  if (!slackConfigured()) throw new Error(`${ENV_FILE}에 SLACK_BOT_TOKEN과 SLACK_USER_ID가 없다`);
  const map = loadMap();
  const channel = await channelOf(map);
  const msg = await post(channel, escape(`[${INSTALL.name}] ${text}`));
  writeJson(MAP_FILE, map);
  for (const block of log ? logBlocks(log) : []) await post(channel, block, { thread_ts: msg.ts });
}

// A ticket event the human should see (PR checks stuck): its thread, also shown in the DM.
export async function slackTicketNotice(id, text) {
  if (!slackConfigured()) throw new Error(`${ENV_FILE}에 SLACK_BOT_TOKEN과 SLACK_USER_ID가 없다`);
  const map = loadMap();
  const channel = await channelOf(map);
  const ts = map.tickets[id]?.ts;
  await post(channel, escape(ts ? text : `[${INSTALL.name}] ${id}: ${text}`), ts ? { thread_ts: ts, reply_broadcast: true } : {});
  writeJson(MAP_FILE, map);
}

// ---------- messages ----------

const link = (url, label) => (url ? `<${url}|${label}>` : null);
const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const plain = (text) => ({ type: "plain_text", text });

export function statusLabel(t) {
  if (t.status === "grouped") return "묶음 처리 중";
  if (t.status === "proposal") return "제안 승인 대기";
  return t.status === "needs-human" ? "판단 필요" : (STATUS_LABEL[t.status] ?? t.status);
}

// Small gray line under the buttons.
export function commandHint(t) {
  switch (t.status) {
    case "awaiting":
      return "스레드에 `진행` · `거절 <이유>` · `수정 <요구사항>`으로 답장해도 됩니다.";
    case "needs-human":
      return "진행할 후보가 없습니다. `수정`으로 방향을 주거나 `거절`하면 됩니다.";
    case "proposal":
      return "제안서를 읽고 `진행`을 누르면 에이전트가 구현해 후보를 만듭니다. 방향은 `수정 <요구사항>`, 필요 없으면 `거절 <이유>`로 보내면 됩니다.";
    case "final-review":
      return "PR을 검토하고 `머지`를 누르면 squash merge합니다. 고칠 점은 `수정`으로, merge하지 않고 닫으려면 `거절`로 보내면 됩니다.";
    default:
      return TERMINAL.includes(t.status) ? "종료된 티켓입니다." : "자동으로 진행 중이라 지금은 명령을 받지 않습니다.";
  }
}

// One color per severity.
const SEVERITY_MARK = { high: "🔴", medium: "🟡", low: "🟢" };


function reasonOf(t) {
  if (t.reviseNote) return `재구현 실패: ${failureSummary(t.reviseNote)}`;
  if (t.status === "needs-human") return t.needsHumanReason;
  return TERMINAL.includes(t.status) ? t.rejectReason : t.prNote;
}

const BUTTONS = {
  approve: {
    text: "진행",
    style: "primary",
    confirm: { title: plain("진행할까요?"), text: plain("이 수정으로 PR을 만들고 CI와 Codex 리뷰를 진행합니다."), confirm: plain("진행"), deny: plain("취소") },
  },
  reject: { text: "거절", style: "danger" },
  revise: { text: "수정" },
  // The reviewer's suggested fix (reviseAdvice), sent as the 수정 direction without typing.
  adopt: {
    text: "추천대로 수정",
    style: "primary",
    confirm: { title: plain("추천대로 수정할까요?"), text: plain("검토에서 추천한 방향으로 다시 구현합니다."), confirm: plain("수정"), deny: plain("취소") },
  },
  merge: {
    text: "머지",
    style: "primary",
    confirm: {
      title: plain("머지할까요?"),
      text: plain("PR을 main에 squash merge합니다. main보다 뒤에 있으면 최신 main에 맞추고, CI 실패나 Codex 지적은 자동 수정 라운드로 고친 뒤 merge합니다. 고치지 못하면 멈추고 알립니다."),
      confirm: plain("머지"),
      deny: plain("취소"),
    },
  },
};

// 진행 on a proposal builds its spec; no PR is made yet.
const APPROVE_PROPOSAL = {
  ...BUTTONS.approve,
  confirm: { ...BUTTONS.approve.confirm, text: plain("이 제안서대로 에이전트가 구현해 후보를 만듭니다. 후보가 나오면 다시 승인을 요청합니다.") },
};

function actionsBlock(t, keys) {
  return {
    type: "actions",
    block_id: "decide",
    elements: keys.map((key) => {
      const { text, style, confirm } = t.status === "proposal" && key === "approve" ? APPROVE_PROPOSAL : BUTTONS[key];
      return { type: "button", action_id: key, value: t.id, text: plain(text), ...(style ? { style } : {}), ...(confirm ? { confirm } : {}) };
    }),
  };
}


// Title in large type, ticket id, severity, status and links in small type, then the card summary,
// the reason when there is one, the buttons and a small hint.
export function parentBlocks(t, { pending, summary } = {}) {
  const severity = severityOf(t);
  const meta = [`[${INSTALL.name}]`, `*${t.id}*`, severity && `${SEVERITY_MARK[severity] ?? ""} ${severity}`.trim(), `*${statusLabel(t)}*`, prLink(t)];
  const blocks = [
    { type: "header", block_id: "title", text: { type: "plain_text", text: clip(t.title, 145), emoji: true } },
    { type: "context", block_id: "meta", elements: [{ type: "mrkdwn", text: meta.filter(Boolean).join("   ·   ") }] },
  ];
  if (summary) blocks.push({ type: "section", block_id: "summary", text: { type: "mrkdwn", text: `📌 ${escape(summary)}` } });
  const group = groupLine(t);
  if (group) blocks.push({ type: "context", block_id: "group", elements: [{ type: "mrkdwn", text: group }] });
  const why = reasonOf(t);
  if (why) blocks.push({ type: "section", block_id: "why", text: { type: "mrkdwn", text: `> ⚠️ ${escape(clip(why.split("\n")[0], 400))}` } });
  const routeText = routeLine(t);
  if (routeText) blocks.push({ type: "context", block_id: "route", elements: [{ type: "mrkdwn", text: routeText }] });
  if (t.autoMerge && !t.autoMerge.auto && !pending) {
    blocks.push({ type: "context", block_id: "merging", elements: [{ type: "mrkdwn", text: "⏳ 자동 머지 중입니다. 최신 main에 맞추고, 문제가 있으면 고친 뒤 CI가 통과하면 merge합니다." }] });
  }
  if (pending) {
    blocks.push({ type: "context", block_id: "pending", elements: [{ type: "mrkdwn", text: `⏳ ${pending} 요청을 받았습니다. 곧 처리합니다.` }] });
    blocks.push({ type: "divider" });
    return blocks;
  }
  const buttons = buttonsFor(t);
  if (buttons.length) blocks.push(actionsBlock(t, buttons));
  blocks.push({ type: "context", block_id: "hint", elements: [{ type: "mrkdwn", text: commandHint(t) }] });
  // Consecutive ticket messages from the bot otherwise run together.
  blocks.push({ type: "divider" });
  return blocks;
}

// Box that asks for the reason (거절) or the new requirement (수정) before the command is queued.
export function commandModal(t, verb, where) {
  const reject = verb === "거절";
  const final = t.status === "final-review";
  const label = reject ? "거절 이유" : final ? "PR에서 고칠 점" : "새 요구사항";
  const hint = reject
    ? final
      ? "PR을 merge하지 않고 닫은 뒤 티켓을 종료합니다. 이유는 다음 탐색에서 같은 문제를 다시 올리지 않는 데 씁니다."
      : "티켓을 닫습니다. 이유는 다음 탐색에서 같은 문제를 다시 올리지 않는 데 씁니다."
    : final
      ? "에이전트가 같은 PR에 수정 commit을 올립니다. Codex 리뷰와 CI를 다시 거쳐 최종 검토로 돌아옵니다."
      : "에이전트가 이전 수정을 버리고 이 요구사항대로 처음부터 다시 구현합니다.";
  return {
    type: "modal",
    callback_id: "quality_command",
    // A box opened from a thread note keeps the ticket's thread and the note text, so the request is
    // answered in the ticket thread and the note (not the ticket message) shows "received".
    private_metadata: JSON.stringify({ id: t.id, verb, channel: where.channel, ts: where.ts, ...(where.thread ? { thread: where.thread, noteText: where.noteText } : {}) }),
    title: plain(`${t.id} ${verb}`),
    submit: plain(verb),
    close: plain("취소"),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${escape(t.title)}*\n${hint}` } },
      {
        type: "input",
        block_id: "arg",
        label: plain(label),
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          // A revise starts from the reviewer's suggestion; the human edits it or replaces it.
          ...(!reject && !final && t.reviseAdvice ? { initial_value: clip(t.reviseAdvice, 2900) } : {}),
        },
      },
    ],
  };
}

// Thread note for a status change. `broadcast` also shows it in the DM so the human gets notified.
// The PR that fixed the ticket: another PR when several tickets were fixed together.
function prLink(t) {
  const pr = t.resolvedBy ?? t.pr;
  return pr ? link(pr.url, `PR #${pr.number}`) : null;
}

// Which tickets a group took over, or which group took this ticket over.
// Whether the ticket goes on its own (lib/route.mjs), or why the human decides.
export function routeLine(t) {
  if (t.autoMerge?.auto && t.status === "merged") return "🤖 자동 머지 기준을 충족해 사람 확인 없이 merge했습니다.";
  if (t.autoMerge?.final && t.status === "merged") return "🤖 남은 문제가 없어 최종 검토 없이 merge했습니다.";
  if (!t.route || TERMINAL.includes(t.status)) return null;
  if (t.route.auto) return "🤖 자동 진행: 사람 확인 없이 PR을 만들고, CI와 Codex 리뷰를 통과하면 merge합니다.";
  return HUMAN_WAITING.includes(t.status) ? `👤 사람 확인 이유: ${escape(t.route.reasons.join(", "))}` : null;
}

export function groupLine(t) {
  if (t.group) return `🔗 같은 원인 ${t.group.members.length}건 묶음: ${t.group.members.join(", ")}`;
  if (t.status === "grouped") return `🔗 ${t.groupId} 묶음에서 함께 고칩니다`;
  return null;
}

// The reviewer's suggested fix under a failure note, for 추천대로 수정.
function adviceText(t) {
  return t.reviseAdvice ? `\n\n*추천 수정 방향*\n${escape(clip(t.reviseAdvice, 600))}` : "";
}

export function statusNote(t) {
  const pr = t.pr ? link(t.pr.url, `PR #${t.pr.number}`) : "";
  // A failed revise returns the ticket to where it was, with the reason; it is not a new candidate.
  if (t.reviseNote && ["awaiting", "needs-human", "proposal"].includes(t.status)) {
    const back = {
      awaiting: "이전 후보로 돌아왔습니다. `진행`을 누르면 이전 후보로 PR을 만듭니다.",
      proposal: "제안서로 돌아왔습니다. `진행`을 누르면 다시 구현합니다.",
    }[t.status] ?? "이전 상태로 돌아왔습니다.";
    return {
      text: `재구현 실패: ${escape(clip(failureSummary(t.reviseNote), 400))}\n${back}${adviceText(t)}`,
      broadcast: true,
      ask: true,
      ...(t.reviseAdvice ? { buttons: ["adopt", "revise"] } : {}),
    };
  }
  switch (t.status) {
    case "awaiting":
      return { text: "새 후보가 준비됐습니다. 진행 여부를 정하면 됩니다.", broadcast: true, ask: true };
    case "proposal":
      return { text: "새 기능 제안서가 준비됐습니다. 코드는 아직 없습니다. 제안서를 보고 진행 여부를 정하면 됩니다.", broadcast: true, ask: true };
    case "needs-human":
      return {
        text: `판단이 필요합니다: ${escape(clip(t.needsHumanReason ?? "", 400))}${adviceText(t)}`,
        broadcast: true,
        ask: true,
        ...(t.reviseAdvice ? { buttons: ["adopt", "revise"] } : {}),
      };
    case "revising":
      return { text: "에이전트가 다시 구현합니다." };
    // A group waiting for the human took in more tickets of its cause and is built again.
    case "grouping":
      return { text: `같은 원인의 결함이 더 나와 ${t.group?.members.length ?? "여러"}건으로 묶음을 다시 만듭니다.` };
    case "grouped":
      return { text: `같은 원인의 결함과 묶어 ${t.groupId}에서 함께 고칩니다. 진행 여부는 ${t.groupId} 메시지에서 정하면 됩니다.`, broadcast: true };
    case "pr-review":
      return { text: `${pr} Codex 리뷰와 CI를 기다립니다.` };
    case "pr-fixing":
      return { text: `${pr} 수정 라운드 ${t.pr.round + 1}을 시작합니다.` };
    // final-review without a note means Codex found nothing on the latest head and every required check passed.
    case "final-review":
      if (t.prNote) {
        return {
          text: `⚠️ ${pr} 자동 처리가 끝났지만 남은 문제가 있습니다.\n남은 문제: ${escape(t.prNote)}\nPR을 확인하고 merge하거나 \`수정\`으로 고칠 점을 보내면 됩니다. merge하지 않고 닫으려면 \`거절\`을 보내면 됩니다.`,
          broadcast: true,
          ask: true,
        };
      }
      if (t.autoMerge?.auto || (autoFinal(t) && t.route?.auto)) return { text: `🤖 ${pr} CI와 Codex 리뷰를 통과했습니다. 자동 머지 기준을 다시 확인하고 이어서 merge합니다.` };
      if (t.autoMerge?.final || (autoFinal(t) && !t.autoMerge)) return { text: `🤖 ${pr} CI와 Codex 리뷰를 통과했습니다. 심각도가 high가 아니라 최종 검토 없이 이어서 merge합니다.` };
      // A merge the human already asked for continues after the fix round, so there is nothing to press.
      if (t.autoMerge) return { text: `🔧 ${pr} 수정을 마쳤고 CI와 Codex 리뷰를 통과했습니다. 이어서 merge합니다.` };
      return {
        text: `✅ ${pr} 머지 준비가 완료되었습니다. CI와 Codex 리뷰를 모두 통과했습니다.\nPR을 확인하고 \`머지\`를 누르면 squash merge합니다. 고칠 점은 \`수정\`으로 보내면 됩니다.`,
        broadcast: true,
        ask: true,
        buttons: ["merge", "revise", "reject"],
      };
    case "merged":
      if (t.resolvedBy) return { text: `${prLink(t)}에서 함께 해결했습니다. 티켓을 종료합니다.`, broadcast: true };
      if (t.autoMerge?.auto) return { text: `🤖 ${prLink(t)} 사람 확인 없이 자동 merge했습니다. 티켓을 종료합니다.`, broadcast: true };
      if (t.autoMerge?.final) return { text: `🤖 ${prLink(t)} 최종 검토 없이 자동 merge했습니다. 티켓을 종료합니다.`, broadcast: true };
      return { text: "merge됐습니다. 티켓을 종료합니다.", broadcast: true };
    case "rejected":
      return { text: "거절했습니다. 티켓을 종료합니다." };
    case "closed":
      return { text: "PR이 닫혔습니다. 티켓을 종료합니다." };
    default:
      return null; // pr-push only lasts until the next watch run
  }
}

const noteSection = (text) => ({ type: "section", text: { type: "mrkdwn", text } });

// Slack carries only what the human must act on, and failures (2026-10-24, too many messages). A
// ticket gets its message once it waits for the human; the automatic route and progress stay on the
// dashboard. An awaiting candidate counts once watch has judged its route.
export function asksHuman(t) {
  if (t.status === "awaiting") return t.route?.attempt === t.attempt && !t.route.auto;
  return t.status === "needs-human" || buttonsFor(t).length > 0;
}

// One message per ticket once it needs the human. Afterwards the message is edited in place (Slack
// does not notify edits), and a thread note is posted only when the human has something to do.
export async function syncSlack(tickets = listTickets(), { log = console.log } = {}) {
  if (!slackConfigured()) return { skipped: "slack.env 없음" };
  const map = loadMap();
  const channel = await channelOf(map);
  let created = 0;
  let noted = 0;
  for (const t of tickets) {
    const entry = map.tickets[t.id];
    if (!entry && !asksHuman(t)) continue;
    try {
      const blocks = parentBlocks(t, { summary: readCard(t.id)?.summary });
      const render = JSON.stringify(blocks);
      const text = `${t.id} ${statusLabel(t)}: ${t.title}`;
      if (!entry) {
        const msg = await post(channel, text, { blocks });
        map.tickets[t.id] = { ts: msg.ts, status: t.status, render };
        created++;
      } else {
        if (entry.render !== render) {
          await api("chat.update", { channel, ts: entry.ts, text, blocks });
          entry.render = render;
        }
        if (entry.status !== t.status) {
          // A button on an earlier note (머지) no longer applies once the status moved on.
          if (entry.note) {
            await api("chat.update", { channel, ts: entry.note.ts, text: entry.note.text, blocks: [noteSection(entry.note.text)] }).catch(() => {});
            entry.note = null;
          }
          const note = statusNote(t);
          if (note?.ask) {
            const blocks = note.buttons ? [noteSection(note.text), actionsBlock(t, note.buttons)] : undefined;
            const msg = await post(channel, note.text, { thread_ts: entry.ts, reply_broadcast: note.broadcast ?? false, blocks });
            if (note.buttons) entry.note = { ts: msg.ts, text: note.text };
            noted++;
          }
          entry.status = t.status;
        }
      }
      writeJson(MAP_FILE, map);
    } catch (e) {
      log(`slack ${t.id}: ${e.message}`);
    }
  }
  return { created, noted };
}

// ---------- commands ----------

// Slack escapes &, < and > and wraps links as <url|label>.
export function slackToPlain(text) {
  return String(text ?? "")
    .replace(/<([^>|]+)\|([^>]+)>/g, "$1")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

// "진행"(or "승인"), "거절 이유", "수정 내용", optionally led by a ticket id ("QA-0003 진행").
export function parseCommand(text) {
  const m = slackToPlain(text).match(/^(?:(QA-\d+)\s*[:,]?\s+)?(진행|승인|거절|수정|머지)(?:(?:\s+|\s*[:：]\s*)([\s\S]*))?$/i);
  if (!m) return null;
  return { id: m[1]?.toUpperCase() ?? null, verb: m[2] === "진행" ? "승인" : m[2], arg: (m[3] ?? "").trim() };
}

// Picks the CLI action for the ticket's current status, or explains why the command doesn't apply.
export function route(t, cmd) {
  const now = `현재 상태: ${statusLabel(t)}`;
  if (cmd.verb === "승인") {
    if (["awaiting", "proposal"].includes(t.status)) return { run: "approve" };
    if (t.status === "needs-human") return { error: "진행할 후보가 없습니다. `수정`으로 방향을 주거나 `거절`하면 됩니다." };
    return { error: `승인 대기 티켓에만 쓸 수 있습니다. ${now}` };
  }
  if (cmd.verb === "머지") {
    if (t.status === "final-review") return { run: "merge" };
    return { error: `최종 검토 중인 PR에만 쓸 수 있습니다. ${now}` };
  }
  if (cmd.verb === "거절") {
    if (!cmd.arg) return { error: "거절 이유를 함께 적어야 합니다. 예: `거절 이미 다른 PR에서 고침`" };
    if (["awaiting", "needs-human", "proposal", "final-review"].includes(t.status)) return { run: "reject", arg: cmd.arg };
    return { error: `승인 대기, 판단 필요, 최종 검토 티켓에만 쓸 수 있습니다. ${now}` };
  }
  if (!cmd.arg) return { error: "고칠 내용을 함께 적어야 합니다. 예: `수정 Y축 글자 크기를 X축과 맞추기`" };
  if (["awaiting", "needs-human", "proposal"].includes(t.status)) return { run: "revise", arg: cmd.arg };
  if (t.status === "final-review") return { run: "feedback", arg: cmd.arg };
  return { error: `자동으로 진행 중이라 지금은 받을 수 없습니다. ${now}. 최종 검토로 오면 다시 보내면 됩니다.` };
}

const ACTIONS = {
  approve: (id) => human.approve(id),
  reject: (id, arg) => human.reject(id, arg),
  revise: (id, arg) => human.revise(id, arg),
  feedback: (id, arg) => human.feedback(id, arg),
  merge: (id) => human.merge(id),
};

const HELP = "명령을 알아듣지 못했습니다. 티켓 메시지의 버튼을 누르거나, 스레드에 `진행`, `거절 <이유>`, `수정 <내용>` 중 하나로 답하면 됩니다. 스레드 밖에서는 `QA-0003 진행`처럼 티켓 번호를 앞에 붙이면 됩니다.";

const fromHuman = (m) => m.user === env().SLACK_USER_ID && !m.subtype && !m.bot_id;
const newer = (a, b) => (Number(a) > Number(b) ? a : b);

function threadOpen(t) {
  if (!t) return false;
  if (!TERMINAL.includes(t.status)) return true;
  return Date.now() - Date.parse(t.updatedAt ?? 0) < CLOSED_THREAD_MS;
}

// Button clicks and form submissions written by `fieldtest slack`, oldest first. Each file is removed
// before its command runs, so a crash never runs it twice.
// Taken commands stay as .running until their result is recorded, so the dashboard shows them as
// received for the whole run. One left over at the start is from a watch run that died midway.
function takeQueue() {
  if (!existsSync(QUEUE_DIR)) return [];
  const files = readdirSync(QUEUE_DIR).sort();
  for (const f of files.filter((f) => f.endsWith(".running"))) {
    const item = readJson(join(QUEUE_DIR, f), null);
    if (item) recordCommand({ id: item.id, verb: item.verb, arg: item.arg ?? "", source: item.source ?? "slack", ok: false, message: "watch가 처리하던 중 멈춤. 다시 보내 주세요." });
    rmSync(join(QUEUE_DIR, f), { force: true });
  }
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const running = join(QUEUE_DIR, `${f}.running`);
      renameSync(join(QUEUE_DIR, f), running);
      const item = readJson(running, null);
      if (!item) rmSync(running, { force: true });
      return item && { ...item, file: running };
    })
    .filter(Boolean);
}

// Runs the human's new commands: queued button clicks, then replies in ticket threads and top-level
// DMs. Read positions are saved before a command runs, so a crash never runs the same command twice.
export async function slackCommands({ log = console.log } = {}) {
  if (!slackConfigured()) return 0;
  const map = loadMap();
  const channel = await channelOf(map);
  const inbox = [];

  if (!map.read) map.read = String(Date.now() / 1000);
  const top = await api("conversations.history", { channel, oldest: map.read, limit: 100 });
  for (const m of top.messages ?? []) {
    map.read = newer(m.ts, map.read);
    if (fromHuman(m) && (!m.thread_ts || m.thread_ts === m.ts)) inbox.push({ at: Number(m.ts), m, thread: m.ts, id: null });
  }
  const tickets = Object.fromEntries(listTickets().map((t) => [t.id, t]));
  for (const [id, entry] of Object.entries(map.tickets)) {
    if (!threadOpen(tickets[id])) continue;
    const since = entry.read ?? entry.ts;
    const r = await api("conversations.replies", { channel, ts: entry.ts, oldest: since, limit: 200 });
    for (const m of r.messages ?? []) {
      if (m.ts === entry.ts || Number(m.ts) <= Number(since)) continue;
      entry.read = newer(m.ts, entry.read ?? since);
      if (fromHuman(m)) inbox.push({ at: Number(m.ts), m, thread: entry.ts, id });
    }
  }
  writeJson(MAP_FILE, map);

  // Taken after the Slack reads, so a Slack error leaves dashboard commands queued for the next run.
  for (const q of takeQueue()) inbox.push({ at: q.at, thread: q.thread, id: q.id, source: q.source ?? "slack", file: q.file, cmd: { id: q.id, verb: q.verb, arg: q.arg ?? "" } });
  inbox.sort((a, b) => a.at - b.at);
  const touched = new Set();
  for (const item of inbox) {
    const say = (text) => post(channel, text, { thread_ts: item.thread });
    const record = (cmd, ok, message) => cmd && recordCommand({ id: cmd.id ?? item.id, verb: cmd.verb, arg: cmd.arg, source: item.source ?? "slack", ok, message });
    try {
      if (item.m) await api("reactions.add", { channel, timestamp: item.m.ts, name: "eyes" }).catch(() => {});
      const cmd = item.cmd ?? parseCommand(item.m.text);
      const id = cmd?.id ?? item.id;
      if (!cmd) {
        await say(HELP);
        continue;
      }
      if (!id) {
        await say("어느 티켓인지 알 수 없습니다. 티켓 메시지의 버튼을 누르거나 `QA-0003 진행`처럼 번호를 붙이면 됩니다.");
        continue;
      }
      touched.add(id);
      const t = readTicket(id);
      if (!t) {
        record({ ...cmd, id }, false, "티켓이 없습니다");
        await say(`${id}: 티켓이 없습니다.`);
        continue;
      }
      const plan = route(t, cmd);
      if (plan.error) {
        record({ ...cmd, id }, false, plan.error);
        await say(`⚠️ ${id}: ${plan.error}`);
        continue;
      }
      log(`slack: ${id} ${plan.run}`);
      const result = await ACTIONS[plan.run](id, plan.arg);
      record({ ...cmd, id }, true, result);
      await say(`✅ ${escape(result)}`);
    } catch (e) {
      record(item.cmd ?? parseCommand(item.m?.text ?? ""), false, e.message.split("\n")[0]);
      log(`slack 명령 실패: ${e.message}`);
      await say(`⚠️ 실패: ${escape(clip(e.message.split("\n")[0], 400))}`).catch(() => {});
    } finally {
      if (item.file) rmSync(item.file, { force: true });
    }
  }
  // Redraw these messages on the next sync: buttons for the new status, or back after a failed command.
  if (touched.size) {
    const fresh = loadMap();
    for (const id of touched) if (fresh.tickets[id]) fresh.tickets[id].render = null;
    writeJson(MAP_FILE, fresh);
  }
  return inbox.length;
}

// ---------- Socket Mode (`fieldtest slack`) ----------

function recordCommand(entry) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  appendFileSync(COMMANDS_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

// Runs the queued commands now instead of at the next minute.
export function wakeWatch() {
  return run("systemctl", ["--user", "start", "--no-block", "fieldtest-watch.service"]);
}

// The ticket's Slack message, so a dashboard command's result lands in the same thread.
export function threadOf(id) {
  return loadMap().tickets[id]?.ts;
}

// Queued commands come from Slack buttons (source "slack") and the dashboard (source "web").
export function enqueue(item) {
  mkdirSync(QUEUE_DIR, { recursive: true });
  writeJson(join(QUEUE_DIR, `${Date.now()}-${process.pid}.json`), { at: Date.now() / 1000, ...item });
}

const VERB_LABEL = { 승인: "진행", 거절: "거절", 수정: "수정", 머지: "머지" };

// Queues the command, swaps the buttons for a "received" line so it isn't sent twice, and wakes
// watch so the command runs now instead of at the next minute.
async function accept({ channel, ts, thread, noteText }, id, verb, arg) {
  enqueue({ id, verb, arg, thread: thread ?? ts, source: "slack" });
  const t = readTicket(id);
  const pending = { type: "context", block_id: "pending", elements: [{ type: "mrkdwn", text: `⏳ ${VERB_LABEL[verb]} 요청을 받았습니다. 곧 처리합니다.` }] };
  // A thread note (머지 under "머지 준비 완료") keeps its text; the ticket's own message is redrawn.
  const update = noteText
    ? { text: noteText, blocks: [noteSection(noteText), pending] }
    : t && { text: `${id} ${statusLabel(t)}: ${t.title}`, blocks: parentBlocks(t, { pending: VERB_LABEL[verb], summary: readCard(id)?.summary }) };
  if (update) await api("chat.update", { channel, ts, ...update }).catch((e) => console.error(`[${now()}] ${e.message}`));
  await wakeWatch();
  console.log(`[${now()}] ${id} ${verb} 접수`);
}

export async function onInteraction(p) {
  if (p.user?.id !== env().SLACK_USER_ID) return;
  if (p.type === "block_actions") {
    const action = p.actions?.[0];
    const t = action?.value ? readTicket(action.value) : null;
    if (!t) return;
    const where = { channel: p.channel?.id ?? p.container?.channel_id, ts: p.message?.ts ?? p.container?.message_ts };
    const inThread = p.message?.thread_ts && p.message.thread_ts !== p.message.ts;
    if (inThread) Object.assign(where, { thread: p.message.thread_ts, noteText: p.message.text });
    if (action.action_id === "approve") return accept(where, t.id, "승인", "");
    if (action.action_id === "merge") return accept(where, t.id, "머지", "");
    if (action.action_id === "adopt") return t.reviseAdvice ? accept(where, t.id, "수정", t.reviseAdvice) : undefined;
    const verb = action.action_id === "reject" ? "거절" : "수정";
    await api("views.open", { trigger_id: p.trigger_id, view: commandModal(t, verb, where) });
    return;
  }
  if (p.type === "view_submission" && p.view?.callback_id === "quality_command") {
    const meta = JSON.parse(p.view.private_metadata);
    const arg = p.view.state?.values?.arg?.value?.value?.trim() ?? "";
    await accept(meta, meta.id, meta.verb, arg);
  }
}

// Holds one Socket Mode connection and reconnects when Slack closes it (it refreshes connections
// every few hours). Each envelope is acknowledged first: Slack waits at most 3 seconds.
export async function serve() {
  if (!env().SLACK_BOT_TOKEN || !env().SLACK_APP_TOKEN) throw new Error(`${ENV_FILE}에 SLACK_BOT_TOKEN, SLACK_APP_TOKEN이 필요하다`);
  for (;;) {
    try {
      const { url } = await api("apps.connections.open", {}, env().SLACK_APP_TOKEN);
      await new Promise((resolve) => {
        const ws = new WebSocket(url);
        ws.addEventListener("message", (ev) => {
          let msg;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            return;
          }
          if (msg.type === "hello") console.log(`[${now()}] Socket Mode 연결됨`);
          if (msg.type === "disconnect") ws.close();
          if (!msg.envelope_id) return;
          ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
          if (msg.type === "interactive") onInteraction(msg.payload).catch((e) => console.error(`[${now()}] 처리 실패: ${e.message}`));
          const event = msg.type === "events_api" ? msg.payload?.event : null;
          if (event?.type === "message" && event.channel_type === "im") claimOwner(event).catch((e) => console.error(`[${now()}] 소유자 등록 실패: ${e.message}`));
        });
        ws.addEventListener("close", resolve);
        ws.addEventListener("error", () => ws.close());
      });
    } catch (e) {
      console.error(`[${now()}] 연결 실패: ${e.message}`);
    }
    await sleep(5000);
  }
}
