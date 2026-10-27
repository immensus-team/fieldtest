import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Command,
  CommandRequest,
  ExploreInfo,
  LogLine,
  Overview,
  PrStatus,
  ServerStatus,
  SessionDetail,
  TicketDetail,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readError(res: Response) {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // Not JSON.
  }
  return `서버 응답 ${res.status}`;
}

export async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { Accept: "application/json" } });
  } catch {
    throw new ApiError(0, "네트워크 오류로 응답을 받지 못했습니다");
  }
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as T;
}

export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => getJson<Overview>("/api/overview"),
    refetchInterval: 5000,
  });
}

export function useTicket(id: string | null) {
  return useQuery({
    queryKey: ["ticket", id],
    queryFn: () => getJson<TicketDetail>(`/api/tickets/${encodeURIComponent(id ?? "")}`),
    enabled: !!id,
    refetchInterval: 5000,
  });
}

export function usePrStatus(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ["pr", id],
    queryFn: () => getJson<PrStatus>(`/api/tickets/${encodeURIComponent(id)}/pr`),
    enabled,
    refetchInterval: 30000,
    staleTime: 25000,
  });
}

export function useLogs(source: LogLine["source"], ticket: string, limit = 300) {
  const params = new URLSearchParams({ source, limit: String(limit) });
  if (ticket) params.set("ticket", ticket);
  return useQuery({
    queryKey: ["logs", source, ticket, limit],
    queryFn: () => getJson<LogLine[]>(`/api/logs?${params}`),
    refetchInterval: 5000,
    placeholderData: (previous) => previous,
  });
}

export function useExplore() {
  return useQuery({
    queryKey: ["explore"],
    queryFn: () => getJson<ExploreInfo>("/api/explore"),
    refetchInterval: 15000,
  });
}

export function useSession(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ["session", id],
    queryFn: () => getJson<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
    enabled,
    refetchInterval: 15000,
  });
}

export function useCommands(limit = 100) {
  return useQuery({
    queryKey: ["commands", limit],
    queryFn: () => getJson<Command[]>(`/api/commands?limit=${limit}`),
    refetchInterval: 5000,
  });
}

let token: Promise<string> | null = null;

function sessionToken() {
  token ??= getJson<{ token: string }>("/api/session")
    .then((body) => body.token)
    .catch((error) => {
      token = null;
      throw error;
    });
  return token;
}

// POST with the session token. Returns the parsed JSON body (null when there is none).
export async function postJson<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const send = async () =>
    fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Fieldtest-Token": await sessionToken() },
      body: JSON.stringify(body),
    });
  let res: Response;
  try {
    res = await send();
    // The server makes a new token on restart; fetch it once more.
    if (res.status === 401 || res.status === 403) {
      token = null;
      res = await send();
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, "네트워크 오류로 응답을 받지 못했습니다");
  }
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function postCommand(id: string, request: CommandRequest) {
  await postJson(`/api/tickets/${encodeURIComponent(id)}/commands`, request);
}

export function useSendCommand(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CommandRequest) => postCommand(id, request),
    // Returning the refetch keeps the button pending until the card shows the received command.
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["ticket", id] }),
        client.invalidateQueries({ queryKey: ["overview"] }),
        client.invalidateQueries({ queryKey: ["commands"] }),
      ]),
  });
}

// Only while the 서버 view is open and not paused; the last good sample stays on screen if one fails.
export function useServer(live: boolean) {
  return useQuery({
    queryKey: ["server"],
    queryFn: () => getJson<ServerStatus>("/api/server"),
    refetchInterval: live ? 5000 : false,
    placeholderData: (previous) => previous,
  });
}
