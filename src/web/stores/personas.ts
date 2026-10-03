// Which personas exist and what state each is in, as the server last said.
//
// Listed once when the first component subscribes, kept current by
// `personas:changed`, and listed again after a reconnect (changes made while
// the socket was down were never broadcast to this page). A persona's
// `state` and `activePrompt` move faster than the list — every turn — so they
// arrive separately on `persona:state` and are held beside the list.
import { useSyncExternalStore } from "react";
import type { Persona, PersonaState } from "../../shared/types";
import { getApi, type Api } from "../api";

export interface PersonaStatus {
  state: PersonaState;
  activePrompt: string | null;
}

export interface PersonasSnapshot {
  personas: Persona[];
  /** False until the first list has arrived. */
  loaded: boolean;
  status: Record<string, PersonaStatus>;
}

const EMPTY: PersonasSnapshot = { personas: [], loaded: false, status: {} };

let snapshot: PersonasSnapshot = EMPTY;
let attached: { api: Api; detach(): void } | null = null;
const subscribers = new Set<() => void>();

function commit(next: PersonasSnapshot): void {
  snapshot = next;
  for (const cb of [...subscribers]) cb();
}

function adoptList(personas: Persona[]): void {
  const status: Record<string, PersonaStatus> = {};
  for (const persona of personas) {
    const held = snapshot.status[persona.id];
    // The list carries the state but not the active prompt; keep the one held
    // while the state agrees.
    status[persona.id] = { state: persona.state, activePrompt: held?.state === persona.state ? held.activePrompt : null };
  }
  commit({ personas, loaded: true, status });
}

function list(api: Api): void {
  api.request("personas:list", {}).then(adoptList, (err: unknown) => {
    console.warn("[personas] personas:list failed:", err instanceof Error ? err.message : err);
  });
}

function attach(): void {
  const api = getApi();
  if (attached?.api === api) return;
  attached?.detach();
  const offs = [
    api.on("personas:changed", ({ personas }) => adoptList(personas)),
    api.on("persona:state", ({ id, state, activePrompt }) => setPersonaStatus(id, { state, activePrompt })),
    api.onReconnect(() => list(api)),
  ];
  attached = { api, detach: () => { for (const off of offs) off(); } };
  list(api);
}

export function subscribe(cb: () => void): () => void {
  attach();
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

export function getSnapshot(): PersonasSnapshot {
  return snapshot;
}

/** A persona's state from a `persona:state` event or a `persona:open` reply. */
export function setPersonaStatus(id: string, status: PersonaStatus): void {
  const held = snapshot.status[id];
  if (held?.state === status.state && held.activePrompt === status.activePrompt) return;
  const personas = snapshot.personas.map((persona) =>
    persona.id === id && persona.state !== status.state ? { ...persona, state: status.state } : persona);
  commit({ ...snapshot, personas, status: { ...snapshot.status, [id]: status } });
}

export function usePersonas(): PersonasSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function usePersona(id: string): Persona | undefined {
  return useSyncExternalStore(subscribe, () => snapshot.personas.find((persona) => persona.id === id));
}

export function usePersonaStatus(id: string): PersonaStatus | undefined {
  return useSyncExternalStore(subscribe, () => snapshot.status[id]);
}

/** Test-only: forgets everything and detaches from the connection. */
export function resetPersonasStore(): void {
  attached?.detach();
  attached = null;
  snapshot = EMPTY;
}
