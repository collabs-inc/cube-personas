// Adapted from cube-computer: src/windows/app/src/items/agent/prompt-queue.ts
import { useSyncExternalStore } from "react";
import type { ContentBlock } from "@agentclientprotocol/sdk";

export interface QueuedPrompt { id: string; blocks: ContentBlock[] }
export interface QueueSnapshot {
  entries: QueuedPrompt[];
  pausedReason: string | null;
  awaitingTurnId: string | null;
  sendingId: string | null;
}

/** Client-local by design. Acquiring a message is synchronous and atomic,
 * so two mounted views of one item cannot send it twice. A successful
 * send is not a finished turn: hold its request id until the replay stream
 * reports the result before releasing the next message. */
export class PromptQueue {
  private snapshot: QueueSnapshot = { entries: [], pausedReason: null, awaitingTurnId: null, sendingId: null };
  private listeners = new Set<() => void>();
  private counter = 0;
  private initialAdded = false;
  private awaitingFirstConnection = false;
  getSnapshot = (): QueueSnapshot => this.snapshot;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(patch: Partial<QueueSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  add(blocks: ContentBlock[], waitForTurnId?: string): string {
    if (this.snapshot.entries.length >= 20) throw new Error("The queue is full. Send or remove a message first.");
    const id = `queued-${++this.counter}`;
    this.update({
      entries: [...this.snapshot.entries, { id, blocks }],
      awaitingTurnId: this.snapshot.awaitingTurnId ?? waitForTurnId ?? null,
    });
    return id;
  }
  /**
   * Adds the one bootstrap prompt for a newly created conversation. It may
   * wait through the adapter's initial offline render, but cannot be claimed
   * until the first real connection and can never be added twice.
   */
  addInitial(blocks: ContentBlock[]): string | null {
    if (
      this.initialAdded
      || this.counter !== 0
      || this.snapshot.entries.length > 0
      || this.snapshot.awaitingTurnId !== null
      || this.snapshot.sendingId !== null
    ) return null;
    this.initialAdded = true;
    this.awaitingFirstConnection = true;
    return this.add(blocks);
  }
  remove(id: string): QueuedPrompt | null {
    if (id === this.snapshot.sendingId) return null;
    const entry = this.snapshot.entries.find((candidate) => candidate.id === id);
    if (!entry) return null;
    const entries = this.snapshot.entries.filter((candidate) => candidate.id !== id);
    this.update({ entries, ...(entries.length === 0 && this.snapshot.sendingId === null ? { pausedReason: null, awaitingTurnId: null } : {}) });
    return entry;
  }
  pause(reason: string): void {
    if (this.snapshot.entries.length > 0 && this.snapshot.pausedReason !== reason) this.update({ pausedReason: reason });
  }
  /** A terminated adapter cannot finish its outstanding request. A network
   * interruption alone must keep that request, since replay may still finish it. */
  interrupt(reason: string): void {
    this.awaitingFirstConnection = false;
    if (this.snapshot.awaitingTurnId !== null || (this.snapshot.entries.length > 0 && this.snapshot.pausedReason !== reason)) {
      this.update({ awaitingTurnId: null, pausedReason: this.snapshot.entries.length > 0 ? reason : this.snapshot.pausedReason });
    }
  }
  resume(): void { if (this.snapshot.pausedReason !== null) this.update({ pausedReason: null }); }
  observe(turns: { id: string; end: string | null }[], online: boolean): void {
    if (!online) {
      const untouchedInitial = this.awaitingFirstConnection
        && turns.length === 0
        && this.snapshot.entries.length > 0
        && this.snapshot.awaitingTurnId === null
        && this.snapshot.sendingId === null;
      if (!untouchedInitial) {
        this.awaitingFirstConnection = false;
        this.pause("Connection interrupted. Review the queue before continuing.");
      }
    } else if (this.awaitingFirstConnection) {
      this.awaitingFirstConnection = false;
      this.update({});
    }
    const awaited = this.snapshot.awaitingTurnId;
    if (awaited === null) return;
    const turn = turns.find((candidate) => candidate.id === awaited);
    if (!turn || turn.end === null) return;
    this.update({
      awaitingTurnId: null,
      pausedReason: turn.end === "end_turn" ? this.snapshot.pausedReason : "The agent stopped. Review the queue before continuing.",
    });
  }
  claim(requestId: string): QueuedPrompt | null {
    const state = this.snapshot;
    if (this.awaitingFirstConnection || state.pausedReason || state.awaitingTurnId || state.sendingId) return null;
    const first = state.entries[0];
    if (!first) return null;
    this.update({ sendingId: first.id, awaitingTurnId: requestId });
    return first;
  }
  accepted(): void {
    this.update({ entries: this.snapshot.entries.filter((entry) => entry.id !== this.snapshot.sendingId), sendingId: null });
  }
  /** The claimed message was refused because the agent was busy: it stays first in line, unpaused, for the next chance. */
  release(): void {
    if (this.snapshot.sendingId === null) return;
    this.update({ sendingId: null, awaitingTurnId: null });
  }
  failed(reason: string): void {
    this.update({ sendingId: null, awaitingTurnId: null, pausedReason: reason });
  }
}

const queues = new Map<string, PromptQueue>();
export function promptQueueFor(itemId: string): PromptQueue {
  let queue = queues.get(itemId);
  if (!queue) { queue = new PromptQueue(); queues.set(itemId, queue); }
  return queue;
}
export function usePromptQueue(itemId: string): QueueSnapshot {
  const queue = promptQueueFor(itemId);
  return useSyncExternalStore(queue.subscribe, queue.getSnapshot);
}

export function resetPromptQueueStore(): void { queues.clear(); }
