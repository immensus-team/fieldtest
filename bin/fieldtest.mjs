#!/usr/bin/env node
import { parseArgs } from "node:util";

// The human and the agent accounts (install.json) share the data directory through the staff group,
// so every command creates group-writable files and directories.
process.umask(0o002);

const HELP = `fieldtest <command>

에이전트 사용자
  run                      24시간 루프 (systemd가 실행)
  bootstrap [--feedback "..."]   실행 지침을 만들거나 고치고 검증 (설치 마법사가 실행)

내 사용자
  watch                    Slack 명령, PR 상태 확인·push·답글 (systemd timer가 1분마다 실행)
  slack                    Slack 버튼 수신 (Socket Mode, systemd가 계속 실행)
  web                      관리 사이트와 설치 마법사 http://127.0.0.1:4310 (systemd가 계속 실행)
  status                   루프 상태, 승인 대기 수, 최근 실행
  list                     티켓 목록
  show <id> [--open]       티켓, 스크린샷, 같은 파일을 바꾸는 열린 PR
  approve <id>             Ready PR 생성
  reject <id> --reason "..."
  revise <id> --feedback "..." [--engine claude|codex] [--model <id>]
  feedback <id> --feedback "..."   최종 검토 중인 PR에 수정 요청
  merge <id>               최종 검토 중인 PR을 squash merge (main보다 뒤면 맞추고 다시 검토)
  resolve <id...> --pr <n> 다른 PR(merge된 것)로 함께 해결된 티켓을 해결 완료로 종료
  recipe show              수리 상태와 초안의 변경(지금 → 초안), 초안 hash
  recipe repair [--feedback "..."]   실행 지침 수리를 다시 요청
  recipe key <이름>        실제 키 저장 (값은 표준 입력)
  recipe approve --hash <h>  검증된 실행 지침 초안 승인 (recipe show의 hash, 게이트 항목을 바꾼 수리)
  update [--now]           새 릴리스 태그로 업데이트 (systemd timer가 1시간마다 실행, --now는 작업을 기다리지 않음)
  doctor                   실행 환경 점검`;

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    reason: { type: "string" },
    feedback: { type: "string" },
    engine: { type: "string" },
    model: { type: "string" },
    open: { type: "boolean" },
    pr: { type: "string" },
    hash: { type: "string" },
    repo: { type: "string" },
    base: { type: "string" },
    "skip-keys": { type: "string" },
    now: { type: "boolean" },
  },
});
const id = positionals[0]?.toUpperCase();

try {
  switch (command) {
    case "run":
      await (await import("../lib/agent.mjs")).loop();
      break;
    case "update": {
      // The timer and a manual --now must not swap the code under each other.
      const { acquireLock } = await import("../lib/lock.mjs");
      const { paths } = await import("../lib/config.mjs");
      if (!acquireLock(`${paths.run}/update.lock`)) throw new Error("다른 업데이트가 돌고 있다");
      const r = await (await import("../lib/update.mjs")).update({ now: Boolean(values.now) });
      console.log(JSON.stringify(r));
      break;
    }
    case "bootstrap": {
      // One bootstrap at a time: two would rewrite the same draft and share one worktree.
      const { acquireLock } = await import("../lib/lock.mjs");
      const { paths } = await import("../lib/config.mjs");
      if (!acquireLock(`${paths.run}/bootstrap.lock`)) throw new Error("다른 부트스트랩이 돌고 있다");
      const r = await (await import("../lib/bootstrap.mjs")).bootstrap({
        feedback: values.feedback ?? null,
        repo: values.repo ?? null,
        base: values.base ?? null,
        skipKeys: values["skip-keys"]?.split(",").filter(Boolean) ?? [],
      });
      console.log(JSON.stringify(r, null, 2));
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case "recipe": {
      const b = await import("../lib/bootstrap.mjs");
      const { paths } = await import("../lib/config.mjs");
      const { loadRecipe, recipeChanges } = await import("../lib/recipe.mjs");
      if (positionals[0] === "repair") {
        b.requestRepair(values.feedback ?? "사람이 수리를 다시 요청함");
        console.log("수리를 요청했다. 루프의 탐색 lane이 다음 차례에 수리한다.");
      } else if (positionals[0] === "key") {
        const name = positionals[1];
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name ?? "")) throw new Error("recipe key <이름>: 값은 표준 입력으로 받는다");
        const { readFileSync } = await import("node:fs");
        b.writeSecrets({ [name]: readFileSync(0, "utf8").trim() });
        console.log(`${name} 저장. 다시 수리하려면 fieldtest recipe repair`);
      } else if (positionals[0] === "approve") {
        if (!values.hash) throw new Error("recipe approve --hash <hash>: recipe show로 초안과 hash를 먼저 확인한다");
        console.log(JSON.stringify(b.promoteDraft({ approved: true, hash: values.hash })));
      } else {
        const approved = loadRecipe(paths.recipe);
        const draft = (() => {
          try {
            return { hash: b.draftHash(), recipe: loadRecipe(paths.recipeDraft) };
          } catch {
            return null;
          }
        })();
        const changes = draft ? recipeChanges(approved, draft.recipe) : null;
        const diff = changes && Object.fromEntries([...changes.gate, ...changes.other].map((k) => [k, { 지금: approved[k], 초안: draft.recipe[k] }]));
        console.log(JSON.stringify({ state: b.readRecipeState(), draft: draft && { hash: draft.hash, gate: changes.gate, diff } }, null, 2));
      }
      break;
    }
    case "watch":
      await (await import("../lib/watch.mjs")).watch();
      break;
    case "slack":
      await (await import("../lib/slack.mjs")).serve();
      break;
    case "web":
      (await import("../lib/web.mjs")).serve();
      break;
    case "doctor":
      process.exitCode = (await (await import("../lib/doctor.mjs")).doctor()) ? 0 : 1;
      break;
    case "status":
    case "list":
    case "show":
    case "approve":
    case "reject":
    case "revise":
    case "merge":
    case "resolve":
    case "feedback": {
      const human = await import("../lib/human.mjs");
      if (command !== "status" && command !== "list" && !id) throw new Error(`${command}: 티켓 id가 필요하다`);
      if (command === "status") await human.status();
      else if (command === "list") human.list();
      else if (command === "show") await human.show(id, { open: values.open });
      else if (command === "approve") console.log(await human.approve(id));
      else if (command === "reject") console.log(await human.reject(id, values.reason));
      else if (command === "revise") console.log(human.revise(id, values.feedback, { engine: values.engine, model: values.model }));
      else if (command === "merge") console.log(await human.merge(id));
      else if (command === "resolve")
        for (const each of positionals) console.log(await human.resolve(each.toUpperCase(), Number(values.pr)));
      else console.log(human.feedback(id, values.feedback));
      break;
    }
    default:
      console.log(HELP);
      process.exitCode = command ? 2 : 0;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
