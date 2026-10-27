import { useSyncExternalStore } from "react";

// One shared 1-second clock so every live timer ticks together.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const fn of listeners) fn();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useNow() {
  return useSyncExternalStore(subscribe, () => now);
}

function toMs(iso: string | null | undefined) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// "8초", "12분 4초", "1시간 3분", "2일 4시간"
export function formatDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 ${m % 60}분`;
  return `${Math.floor(h / 24)}일 ${h % 24}시간`;
}

export function elapsed(since: string | null | undefined, at: number) {
  const ms = toMs(since);
  return ms === null ? null : formatDuration(at - ms);
}

// "방금", "3분 전", "2시간 후"
export function relative(iso: string | null | undefined, at: number) {
  const ms = toMs(iso);
  if (ms === null) return "기록 없음";
  const diff = at - ms;
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  let text: string;
  if (s < 10) return "방금";
  if (s < 60) text = `${Math.floor(s)}초`;
  else if (s < 3600) text = `${Math.floor(s / 60)}분`;
  else if (s < 86400) text = `${Math.floor(s / 3600)}시간`;
  else text = `${Math.floor(s / 86400)}일`;
  return future ? `${text} 후` : `${text} 전`;
}

export function isPast(iso: string | null | undefined, at: number) {
  const ms = toMs(iso);
  return ms === null || ms <= at;
}

const clock = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const dateTime = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function clockTime(iso: string | null | undefined) {
  const ms = toMs(iso);
  return ms === null ? "--:--:--" : clock.format(ms);
}

export function shortDateTime(iso: string | null | undefined) {
  const ms = toMs(iso);
  return ms === null ? "-" : dateTime.format(ms);
}

export function msOf(iso: string | null | undefined) {
  return toMs(iso);
}
