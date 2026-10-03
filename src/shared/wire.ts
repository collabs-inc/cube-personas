import type { AgentRecord, JsonRpcMessage } from "./agent-protocol";
import type { Harness, Persona, PersonaState, Worker, WorkspaceTree } from "./types";

export interface VerbMap {
  "personas:list": { args: Record<string, never>; result: Persona[] };
  "persona:create": { args: { harness: Harness }; result: Persona };
  "persona:rename": { args: { id: string; name: string }; result: null };
  "persona:delete": { args: { id: string }; result: { contextFolder: string } };
  "persona:open": {
    args: { id: string; sinceSeq?: number };
    /** `records` follow on from `startSeq`: only the log's trailing window is ever sent. */
    result: { records: AgentRecord[]; startSeq: number; seq: number; state: PersonaState; activePrompt: string | null };
  };
  /** A prompt, a `session/cancel`, or a permission response, as Cube's `agent:send`. */
  "persona:send": { args: { id: string; message: JsonRpcMessage }; result: null };
  "persona:restart": { args: { id: string }; result: null };
  "persona:mark-read": { args: { id: string }; result: null };
  "workers:list": { args: { personaId: string }; result: Worker[] };
  /** `data` is the trailing output, UTF-8, at most 256 KiB. */
  "worker:attach": { args: { id: string }; result: { data: string; exited: boolean } };
  /** `worker:output` for a worker reaches only the sockets attached to it; this ends that. */
  "worker:detach": { args: { id: string }; result: null };
  "worker:input": { args: { id: string; data: string }; result: null };
  "worker:resize": { args: { id: string; cols: number; rows: number }; result: null };
  "worker:stop": { args: { id: string }; result: null };
  "workspace:get": { args: { personaId: string }; result: WorkspaceTree };
  "repos:get": { args: { personaId: string }; result: { text: string } };
  "repos:set": { args: { personaId: string; text: string }; result: null };
  "files:list": { args: { personaId: string; path: string }; result: { entries: { name: string; dir: boolean }[] } };
  "files:read": { args: { personaId: string; path: string }; result: { text: string; truncated: boolean } };
}

export type Verb = keyof VerbMap;
export type VerbArgs<V extends Verb> = VerbMap[V]["args"];
export type VerbResult<V extends Verb> = VerbMap[V]["result"];

export interface EventMap {
  "personas:changed": { personas: Persona[] };
  "workers:changed": { personaId: string; workers: Worker[] };
  "persona:frame": { id: string; record: AgentRecord };
  "persona:state": { id: string; state: PersonaState; activePrompt: string | null };
  "worker:output": { id: string; data: string };
  "worker:exit": { id: string; exitCode: number | null };
  "reports:changed": { personaId: string };
}

export type EventName = keyof EventMap;

export type WireRequest = { t: "req"; id: number; verb: Verb; args: unknown };
export type WireResponse =
  | { t: "res"; id: number; ok: true; result: unknown }
  | { t: "res"; id: number; ok: false; error: string };
export type WireEvent = { t: "evt"; name: EventName; payload: unknown };
export type WireMessage = WireRequest | WireResponse | WireEvent;

const VERBS: ReadonlySet<string> = new Set<Verb>([
  "personas:list", "persona:create", "persona:rename", "persona:delete", "persona:open", "persona:send",
  "persona:restart", "persona:mark-read", "workers:list", "worker:attach", "worker:detach", "worker:input", "worker:resize",
  "worker:stop", "workspace:get", "repos:get", "repos:set", "files:list", "files:read",
]);
const EVENTS: ReadonlySet<string> = new Set<EventName>([
  "personas:changed", "workers:changed", "persona:frame", "persona:state", "worker:output", "worker:exit",
  "reports:changed",
]);

export function encode(msg: WireMessage): string {
  return JSON.stringify(msg);
}

export function decode(text: string): WireMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  if (o.t === "req") {
    if (typeof o.id !== "number" || typeof o.verb !== "string" || !VERBS.has(o.verb)) return null;
    return { t: "req", id: o.id, verb: o.verb as Verb, args: o.args };
  }
  if (o.t === "res") {
    if (typeof o.id !== "number") return null;
    if (o.ok === true && "result" in o) return { t: "res", id: o.id, ok: true, result: o.result };
    if (o.ok === false && typeof o.error === "string") return { t: "res", id: o.id, ok: false, error: o.error };
    return null;
  }
  if (o.t === "evt") {
    if (typeof o.name !== "string" || !EVENTS.has(o.name)) return null;
    return { t: "evt", name: o.name as EventName, payload: o.payload };
  }
  return null;
}
