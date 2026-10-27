import type { ServerStatus } from "@/api/types";

export interface Sample {
  cpu: number;
  memory: number;
  load: number;
}

// The last 5 minutes of 5-second samples, kept while the page is open so the sparklines survive a
// switch to another view. A pause longer than 3 refreshes leaves a gap rather than joining the line.
const LIMIT = 60;
const GAP_MS = 15_000;
const samples: (Sample | null)[] = [];
let lastAt = 0;

export function record(s: ServerStatus): (Sample | null)[] {
  const at = Date.parse(s.at);
  if (at > lastAt) {
    if (lastAt && at - lastAt > GAP_MS) samples.push(null);
    const used = s.memory.totalBytes - s.memory.availableBytes;
    samples.push({ cpu: s.cpu.percent, memory: (used / s.memory.totalBytes) * 100, load: s.cpu.load[0] });
    lastAt = at;
    while (samples.length > LIMIT) samples.shift();
  }
  return [...samples];
}
