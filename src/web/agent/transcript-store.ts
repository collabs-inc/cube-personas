// Adapted from cube-computer: src/windows/app/src/items/agent/transcript-store.ts
/**
 * Where a persona's transcript lives between renders.
 *
 * Module level, keyed by id, deliberately outside React: a pane can unmount
 * and remount (a view switch, an error boundary) without the conversation
 * being re-read from the server, and without the log cursor going
 * backwards. State that survives a remount cannot live in component state.
 *
 * `subscribe`/`getTranscript` are the `useSyncExternalStore` pair the rest
 * of the app's stores use; `useTranscript` is the hook over them. The store
 * keeps identity stable when nothing changed, so an unchanged transcript
 * never re-renders.
 *
 * ORDERING is the thing this file exists to get right. `persona:open`
 * returns a replay AND a cursor, but frames keep arriving while that round
 * trip is in flight, and a frame is only safe to fold in once the replay it
 * belongs after has landed. Two situations need the same treatment, and both
 * would otherwise corrupt the transcript:
 *
 *  - **during an open**: a frame folded in ahead of the replay would be
 *    fine, but every replayed record behind its cursor would then be dropped
 *    by the reducer's own `seq` guard, losing the conversation;
 *  - **before any open**: the server broadcasts frames for every persona, so
 *    a stray frame at seq 900 for one this page has not opened would leave a
 *    one-block transcript at cursor 900, and the later open reply (a delta)
 *    would then be discarded wholesale.
 *
 * So a frame is folded in only for a transcript whose `applyOpen` has landed
 * and has no open in flight; otherwise it is BUFFERED. `applyOpen` folds the
 * reply and then drains the buffer through the same reducer, which drops
 * exactly what the reply already covered (`seq <= result.seq`) and applies
 * the rest. The buffer is bounded (`MAX_BUFFERED_RECORDS`): past that it
 * drops its oldest and marks the transcript, so the NEXT reply is treated as
 * authoritative (folded as a reset) rather than stitched onto a transcript
 * with a hole in it.
 *
 * The lifecycle a caller must follow:
 *
 *   const token = beginOpen(id);
 *   try { applyOpen(id, await api.request("persona:open", ...), token); }
 *   catch { abortOpen(id, token); }   // MANDATORY
 *
 * `abortOpen` is not optional politeness: an open rejects for entirely
 * normal reasons (a dropped socket, a server restarting), and without it the
 * buffer stays installed and every later frame is swallowed for the life of
 * the page. It replays what it holds through the normal fold: for a
 * transcript that has been opened before, the frames land; for one that has
 * not, they stay buffered for the open that eventually succeeds.
 *
 * `beginOpen` returns a GENERATION token because two opens can overlap (a
 * remount racing a reconnect). Only the latest generation's `applyOpen` or
 * `abortOpen` acts; a stale reply is ignored rather than applied, since its
 * records are a subset of the newer one's and a stale reset would throw away
 * everything folded in since.
 *
 * Client request ids: `clientKeyOf(id)` mints one uuid per transcript and
 * `nextRequestId(id)` counts within it ("<uuid>:<n>"). The server emits
 * "d:<n>" and the adapter "a:<n>", so the uuid is what keeps two pages on
 * one persona from colliding. The counter survives `resetTranscript` on
 * purpose: an id is never reused for a second request.
 */
import { useSyncExternalStore } from "react";
import type { AgentOpenResult, AgentRecord } from "../../shared/agent-protocol";
import { EMPTY_TRANSCRIPT, reduceRecord, reduceRecords, restoreActivePrompt } from "./transcript";
import type { Transcript } from "./transcript";

/**
 * How many records may wait for an open before the buffer starts dropping
 * its oldest. Generous — a slow open on a busy session is a few hundred
 * frames — but finite, because an item whose open never resolves must not
 * grow without bound.
 */
export const MAX_BUFFERED_RECORDS = 2048;

const transcripts = new Map<string, Transcript>();
/** Frames that cannot be folded yet: an open is in flight, or none has landed. */
const buffers = new Map<string, AgentRecord[]>();
/** The generation of the open in flight, if any. */
const openTokens = new Map<string, number>();
/** Items whose `applyOpen` has landed — the only ones a frame folds into directly. */
const opened = new Set<string>();
/** Items whose buffer overflowed: the next reply is authoritative, holes and all. */
const needsReset = new Set<string>();
const clientKeys = new Map<string, string>();
const requestCounters = new Map<string, number>();
const subscribers = new Set<() => void>();

let generation = 0;

function notify(): void {
  for (const callback of subscribers) callback();
}

function commit(itemId: string, next: Transcript): void {
  if (getTranscript(itemId) === next) return;
  transcripts.set(itemId, next);
  notify();
}

/** The item's transcript, or the shared empty one — stable by identity. */
export function getTranscript(itemId: string): Transcript {
  return transcripts.get(itemId) ?? EMPTY_TRANSCRIPT;
}

/** Clears a completed sign-in gate without discarding the conversation replay or its cursor. */
export function clearAuthRequired(itemId: string): void {
  const current = getTranscript(itemId);
  if (current.authRequired === null) return;
  commit(itemId, { ...current, authRequired: null, handshakeError: null });
}

/**
 * Call before awaiting `agent:open`. Frames until the matching
 * `applyOpen`/`abortOpen` are buffered, not applied. The returned token
 * identifies this open: pass it back so a reply that lost a race is
 * ignored instead of overwriting a newer one.
 */
export function beginOpen(itemId: string): number {
  const token = ++generation;
  openTokens.set(itemId, token);
  if (!buffers.has(itemId)) buffers.set(itemId, []);
  return token;
}

/**
 * Folds an `agent:open` reply in and drains whatever arrived while it was
 * in flight. The cursor is carried to `result.seq` even when the reply
 * held no records, so a buffered frame the reply already covered is
 * dropped rather than applied twice. A reply from a superseded open (an
 * older `token`) is ignored.
 */
export function applyOpen(itemId: string, result: AgentOpenResult, token?: number): void {
  if (isStale(itemId, token)) return;
  openTokens.delete(itemId);

  const buffered = buffers.get(itemId) ?? [];
  buffers.delete(itemId);
  // A buffer that overflowed has a hole in it; the reply is the only
  // complete account left, so it replaces rather than extends.
  const reset = result.reset || needsReset.has(itemId);
  needsReset.delete(itemId);
  opened.add(itemId);

  let next = reduceRecords(getTranscript(itemId), result.records, reset);
  next = restoreActivePrompt(next, result.activePrompt);
  if (next.seq < result.seq) next = { ...next, seq: result.seq };
  for (const record of buffered) next = reduceRecord(next, record);
  commit(itemId, next);
}

/**
 * The `catch` half of `beginOpen` — an open that failed. Drops the
 * in-flight state and replays what the buffer holds through the normal
 * fold, so frames are not lost when the machine was merely asleep. For an
 * item that has never had a reply land there is still no baseline to fold
 * against, so its frames stay buffered for the open that succeeds.
 */
export function abortOpen(itemId: string, token?: number): void {
  if (isStale(itemId, token)) return;
  openTokens.delete(itemId);
  if (!opened.has(itemId)) return;

  const buffered = buffers.get(itemId) ?? [];
  buffers.delete(itemId);
  let next = getTranscript(itemId);
  for (const record of buffered) next = reduceRecord(next, record);
  commit(itemId, next);
}

/** Folds one `agent:frame` in, or buffers it until an open lands. */
export function applyFrame(itemId: string, record: AgentRecord): void {
  if (openTokens.has(itemId) || !opened.has(itemId)) {
    bufferRecord(itemId, record);
    return;
  }
  commit(itemId, reduceRecord(getTranscript(itemId), record));
}

/**
 * Forgets the item's conversation — a respawn, or an item being closed.
 * Any open in flight is abandoned with it and the item goes back to
 * needing a reply before frames fold; the request-id namespace is kept so
 * ids stay unique across the session that replaces this one.
 */
export function resetTranscript(itemId: string): void {
  buffers.delete(itemId);
  openTokens.delete(itemId);
  opened.delete(itemId);
  needsReset.delete(itemId);
  if (!transcripts.has(itemId)) return;
  transcripts.delete(itemId);
  notify();
}

export function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => void subscribers.delete(callback);
}

/** Subscribes a component to one item's transcript. */
export function useTranscript(itemId: string): Transcript {
  return useSyncExternalStore(subscribe, () => getTranscript(itemId));
}

/** This client's id namespace for `itemId` — minted once, kept for the item's life. */
export function clientKeyOf(itemId: string): string {
  const existing = clientKeys.get(itemId);
  if (existing) return existing;
  const key = uuid();
  clientKeys.set(itemId, key);
  return key;
}

/** The next JSON-RPC request id for `itemId`: "<uuid>:<n>", monotonic per item. */
export function nextRequestId(itemId: string): string {
  const n = (requestCounters.get(itemId) ?? 0) + 1;
  requestCounters.set(itemId, n);
  return `${clientKeyOf(itemId)}:${n}`;
}

/** An open that a later `beginOpen` superseded — its reply is no longer the truth. */
function isStale(itemId: string, token: number | undefined): boolean {
  if (token === undefined) return false;
  return openTokens.get(itemId) !== token;
}

function bufferRecord(itemId: string, record: AgentRecord): void {
  const buffer = buffers.get(itemId) ?? [];
  buffer.push(record);
  if (buffer.length > MAX_BUFFERED_RECORDS) {
    buffer.shift();
    needsReset.add(itemId);
  }
  buffers.set(itemId, buffer);
}

function uuid(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  // Only reached where crypto is unavailable; the shape is what matters,
  // since collisions across two clients are what the namespace prevents.
  const hex = (n: number): string =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/** Test-only: forgets every item's transcript, buffer and id namespace. */
export function resetTranscriptStore(): void {
  transcripts.clear();
  buffers.clear();
  openTokens.clear();
  opened.clear();
  needsReset.clear();
  clientKeys.clear();
  requestCounters.clear();
  notify();
}
