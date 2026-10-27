#!/usr/bin/env node
// Sessions call this from inside their worktree:  node demo-server.mjs start|stop|status
import { demoPid, demoUrl, startDemo, stopDemo } from "../lib/demo.mjs";
import { currentRecipe } from "../lib/recipe.mjs";

// The loop passes its lane's port as FIELDTEST_DEMO_PORT.
const DEMO_URL = demoUrl();

const cmd = process.argv[2];
if (cmd === "start") {
  const r = await startDemo(process.cwd());
  if (r.already) console.log(`이미 실행 중: ${DEMO_URL}`);
  else if (r.ok) console.log(`실행됨: ${DEMO_URL}${currentRecipe().start.ready}  (로그: ${r.log})`);
  else {
    const what = { services: "서비스(docker compose)가 뜨지 않았다", seed: "시드 명령이 실패했다", start: `${currentRecipe().start.timeoutSec}초 안에 뜨지 않았다` }[r.stage];
    console.error(`${what}. 로그: ${r.log}`);
    process.exit(1);
  }
} else if (cmd === "stop") console.log(stopDemo() ? "멈춤" : "실행 중이 아님");
else if (cmd === "status") console.log(demoPid() ? `실행 중: ${DEMO_URL}` : "실행 중이 아님");
else {
  console.error("usage: demo-server.mjs start|stop|status");
  process.exit(2);
}
