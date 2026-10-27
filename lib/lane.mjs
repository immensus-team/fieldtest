// The loop runs two lanes at once: PR work (fix rounds, cards, causes) and exploration (explore,
// revise, group builds). Each lane has its own demo server and Playwright port so the two never
// share a running app. The lane follows its async work through AsyncLocalStorage; processes the
// lane starts get its ports in the environment (sessions start the demo with bin/demo-server.mjs).
import { AsyncLocalStorage } from "node:async_hooks";

export const LANES = {
  pr: { name: "pr", label: "PR", demoPort: 3200, e2ePort: 3100 },
  explore: { name: "explore", label: "탐색", demoPort: 3210, e2ePort: 3110 },
};

const store = new AsyncLocalStorage();

export const inLane = (lane, fn) => store.run(lane, fn);
export const currentLane = () => store.getStore() ?? null;

export function laneEnv() {
  const lane = currentLane();
  return lane ? { FIELDTEST_LANE: lane.name, FIELDTEST_DEMO_PORT: String(lane.demoPort), E2E_PORT: String(lane.e2ePort) } : {};
}

export function demoPort() {
  return currentLane()?.demoPort ?? Number(process.env.FIELDTEST_DEMO_PORT ?? LANES.pr.demoPort);
}
