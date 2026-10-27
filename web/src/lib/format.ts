const GB = 1024 ** 3;
const MB = 1024 ** 2;

// "3.5GB", "812MB"
export function bytes(n: number | null | undefined) {
  if (n == null) return "–";
  if (n >= GB) return `${(n / GB).toFixed(n >= 100 * GB ? 0 : 1)}GB`;
  return `${Math.round(n / MB)}MB`;
}

export function percentOf(part: number, whole: number) {
  return whole > 0 ? (part / whole) * 100 : 0;
}

export type Level = "ok" | "warn" | "critical";

// Memory and disk: past 85% the next build may not fit; past 95% it will not.
export function usageLevel(percent: number): Level {
  return percent >= 95 ? "critical" : percent >= 85 ? "warn" : "ok";
}
