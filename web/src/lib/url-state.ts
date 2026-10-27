import { useCallback, useSyncExternalStore } from "react";

// The open ticket (?t=QA-0019) and the view (?v=commands) live in the URL so a reload keeps them.
const EVENT = "fieldtest-url";

function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(EVENT, listener);
  };
}

export function useUrlParam(name: string): [string | null, (value: string | null) => void] {
  const value = useSyncExternalStore(subscribe, () =>
    new URLSearchParams(window.location.search).get(name),
  );
  const set = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(window.location.search);
      if (params.get(name) === next) return;
      if (next === null) params.delete(name);
      else params.set(name, next);
      const search = params.toString();
      window.history.pushState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
      window.dispatchEvent(new Event(EVENT));
    },
    [name],
  );
  return [value, set];
}

export function useOpenTicket() {
  return useUrlParam("t");
}
