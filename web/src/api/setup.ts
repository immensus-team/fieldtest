import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getJson, postJson } from "./client";

export const STEP_IDS = ["server", "github", "repo", "claude", "codex", "slack", "bootstrap", "recipe", "start"] as const;
export type StepId = (typeof STEP_IDS)[number];

export type StepState = { done: boolean; at: string | null; info: Record<string, unknown> };

export type RecipeState = {
  phase?: "bootstrap" | "repair";
  stage?: string;
  failedStage?: string | null;
  attempt?: number;
  error?: string | null;
  realKeys?: { name: string; why: string }[];
  needsE2eSetup?: boolean;
  awaitingApproval?: string[] | null;
  at?: string;
};

export type SetupState = {
  name: string;
  steps: Record<StepId, StepState>;
  current: StepId | null;
  order: StepId[];
  recipe: RecipeState;
};

export type ServerCheck = { name: string; ok: boolean; detail: string };

export type LoginStatus =
  | { state: "starting" }
  | { state: "waiting"; url: string; code: string }
  | { state: "needs-code"; url: string }
  | { state: "done" }
  | { state: "failed"; error: string };

export type Repo = { name: string; private: boolean; push: boolean; base: string; pushedAt: string };

export type RecipeSummary = {
  hash: string;
  repo: string;
  product: { name: string; summary: string; role: string };
  app: { kind: string; root: string };
  install: string[];
  services: { compose: string } | null;
  seed: string[];
  start: { command: string; ready: string };
  login: { kind: string; user: string | null };
  journeys: string[];
  checks: { name: string; command: string; stage: string }[];
  paths: { allowed: string[]; forbidden: string[] };
  screens: { id: string; url: string; mission: string; shot: string | null }[];
};

export function useSetupState() {
  return useQuery({ queryKey: ["setup"], queryFn: () => getJson<SetupState>("/api/setup/state"), refetchInterval: 2000 });
}

// Mutations that change the wizard's state read it again once they settle.
function useSetupMutation<I, O>(fn: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => client.invalidateQueries({ queryKey: ["setup"] }) });
}

export const useServerCheck = () => useSetupMutation(() => postJson<{ checks: ServerCheck[] }>("/api/setup/server"));
export const useStartLogin = (step: "github" | "claude" | "codex") =>
  useSetupMutation(() => postJson<{ id: string | null; done?: boolean }>(`/api/setup/${step}/start`));
export const useSendLoginCode = (id: string | null) => useSetupMutation((code: string) => postJson(`/api/setup/login/${id}/code`, { code }));

export function useLogin(id: string | null) {
  return useQuery({
    queryKey: ["login", id],
    queryFn: () => getJson<LoginStatus>(`/api/setup/login/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.state === "done" || q.state.data?.state === "failed" ? false : 2000),
  });
}

export const useRepos = (enabled: boolean) => useQuery({ queryKey: ["repos"], queryFn: () => getJson<Repo[]>("/api/setup/repos"), enabled, staleTime: 60_000 });
export const useChooseRepo = () => useSetupMutation((repo: string) => postJson<{ repo: string; base: string }>("/api/setup/repo", { repo }));

export const useSlackManifest = () => useQuery({ queryKey: ["slack-manifest"], queryFn: () => getJson<{ manifest: unknown; url: string }>("/api/setup/slack/manifest") });
export const useSaveSlack = () => useSetupMutation((tokens: { botToken: string; appToken: string }) => postJson<{ team: string; bot: string }>("/api/setup/slack", tokens));
export const useSkipSlack = () => useSetupMutation(() => postJson("/api/setup/slack/skip"));
export const useSlackStatus = (enabled: boolean) =>
  useQuery({ queryKey: ["slack-status"], queryFn: () => getJson<{ tokens: boolean; owner: boolean }>("/api/setup/slack"), enabled, refetchInterval: 2000 });

export const useStartBootstrap = () =>
  useSetupMutation((input: { feedback?: string; skipKeys?: string[] } | undefined) => postJson<{ started: boolean }>("/api/setup/bootstrap", input ?? {}));
export const useBootstrap = () =>
  useQuery({ queryKey: ["bootstrap"], queryFn: () => getJson<{ state: RecipeState; running: boolean; log: string }>("/api/setup/bootstrap"), refetchInterval: 2000 });
export const useSaveSecrets = () => useSetupMutation((values: Record<string, string>) => postJson("/api/setup/secrets", { values }));

export const useRecipe = (enabled: boolean) => useQuery({ queryKey: ["recipe-draft"], queryFn: () => getJson<RecipeSummary>("/api/setup/recipe"), enabled });
export const useRecipeAction = () =>
  useSetupMutation((input: { action: "start"; hash: string } | { action: "revise"; feedback: string }) => postJson("/api/setup/recipe", input));

export const useStartServices = () => useSetupMutation(() => postJson("/api/setup/start"));
export const useReopen = () => useSetupMutation((step: StepId) => postJson(`/api/setup/step/${step}/reopen`));
