// Each persona's workers, as the server last said.
//
// A persona's list is fetched when something first asks for it, kept current
// by `workers:changed`, and fetched again after a reconnect.
import { useCallback, useSyncExternalStore } from "react";
import type { Worker } from "../../shared/types";
import { getApi, type Api } from "../api";

const NONE: readonly Worker[] = Object.freeze([]);

const byPersona = new Map<string, readonly Worker[]>();
const requested = new Set<string>();
let attached: { api: Api; detach(): void } | null = null;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of [...subscribers]) cb();
}

function adopt(personaId: string, workers: readonly Worker[]): void {
  byPersona.set(personaId, workers);
  notify();
}

function fetchWorkers(api: Api, personaId: string): void {
  api.request("workers:list", { personaId }).then((workers) => adopt(personaId, workers), (err: unknown) => {
    console.warn("[workers] workers:list failed:", err instanceof Error ? err.message : err);
  });
}

function attach(): Api {
  const api = getApi();
  if (attached?.api === api) return api;
  attached?.detach();
  requested.clear();
  const offs = [
    api.on("workers:changed", ({ personaId, workers }) => adopt(personaId, workers)),
    api.onReconnect(() => { for (const personaId of requested) fetchWorkers(api, personaId); }),
  ];
  attached = { api, detach: () => { for (const off of offs) off(); } };
  return api;
}

function want(personaId: string): void {
  const api = attach();
  if (requested.has(personaId)) return;
  requested.add(personaId);
  fetchWorkers(api, personaId);
}

export function getWorkers(personaId: string): readonly Worker[] {
  return byPersona.get(personaId) ?? NONE;
}

export function useWorkers(personaId: string): readonly Worker[] {
  const subscribe = useCallback((cb: () => void) => {
    want(personaId);
    subscribers.add(cb);
    return () => { subscribers.delete(cb); };
  }, [personaId]);
  return useSyncExternalStore(subscribe, () => getWorkers(personaId));
}

/** Test-only: forgets everything and detaches from the connection. */
export function resetWorkersStore(): void {
  attached?.detach();
  attached = null;
  byPersona.clear();
  requested.clear();
}
