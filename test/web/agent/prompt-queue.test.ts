// Adapted from cube-computer: src/windows/app/src/items/agent/prompt-queue.test.ts
import { describe, expect, test } from "vitest";
import { PromptQueue } from "../../../src/web/agent/prompt-queue";

const prompt = (text: string) => [{ type: "text" as const, text }];

describe("client-owned prompt queue", () => {
  test("holds one initial setup prompt until the fresh conversation first connects", () => {
    const queue = new PromptQueue();
    const id = queue.addInitial(prompt("configure the preview"));

    queue.observe([], false);
    expect(queue.getSnapshot().pausedReason).toBeNull();
    expect(queue.claim("before-connect")).toBeNull();

    queue.observe([], true);
    expect(queue.claim("first-turn")?.blocks).toEqual(prompt("configure the preview"));
    queue.accepted();
    expect(queue.getSnapshot().entries).toHaveLength(0);
    expect(queue.addInitial(prompt("duplicate"))).toBeNull();
    expect(id).toBe("queued-1");
  });

  test("the initial-connect exception never resumes an interrupted ordinary queue", () => {
    const queue = new PromptQueue();
    queue.add(prompt("ordinary follow-up"));

    queue.observe([], false);
    queue.observe([], true);

    expect(queue.getSnapshot().pausedReason).toMatch(/interrupted/i);
    expect(queue.claim("surprise-send")).toBeNull();
  });

  test("waits for the active turn, claims once, and waits for the sent turn before the next", () => {
    const queue = new PromptQueue();
    queue.add(prompt("first"), "active");
    queue.add(prompt("second"), "active");
    expect(queue.claim("request-1")).toBeNull();
    queue.observe([{ id: "active", end: "end_turn" }], true);
    expect(queue.claim("request-1")?.blocks).toEqual(prompt("first"));
    expect(queue.claim("duplicate")).toBeNull();
    queue.accepted();
    expect(queue.getSnapshot().entries).toHaveLength(1);
    expect(queue.claim("too-early")).toBeNull();
    queue.observe([{ id: "request-1", end: null }], true);
    expect(queue.claim("still-too-early")).toBeNull();
    queue.observe([{ id: "request-1", end: "end_turn" }], true);
    expect(queue.claim("request-2")?.blocks).toEqual(prompt("second"));
  });

  test("failed send keeps the message and requires explicit retry", () => {
    const queue = new PromptQueue();
    queue.add(prompt("keep me"));
    queue.claim("r1");
    queue.failed("Connection lost");
    expect(queue.getSnapshot().entries[0]?.blocks).toEqual(prompt("keep me"));
    expect(queue.claim("r2")).toBeNull();
    queue.resume();
    expect(queue.claim("r3")?.blocks).toEqual(prompt("keep me"));
  });

  test("cancel or disconnect pauses queued work instead of surprising the user", () => {
    const queue = new PromptQueue();
    queue.add(prompt("later"), "active");
    queue.observe([{ id: "active", end: "cancelled" }], true);
    expect(queue.getSnapshot().pausedReason).toBeTruthy();
    expect(queue.claim("no")).toBeNull();
    queue.resume();
    queue.observe([], false);
    queue.observe([], true);
    expect(queue.claim("still-no")).toBeNull();
    queue.resume();
    expect(queue.claim("yes")?.blocks).toEqual(prompt("later"));
  });

  test("removal and editing do not touch a message already being sent", () => {
    const queue = new PromptQueue();
    const first = queue.add(prompt("first"));
    const second = queue.add(prompt("second"));
    queue.claim("r1");
    expect(queue.remove(first)).toBeNull();
    expect(queue.remove(second)?.blocks).toEqual(prompt("second"));
    queue.accepted();
    expect(queue.getSnapshot().entries).toHaveLength(0);
  });

  test("a terminated session releases its obsolete turn after explicit continuation", () => {
    const queue = new PromptQueue();
    queue.add(prompt("finish after resume"), "dead-session-turn");
    queue.interrupt("Agent stopped");
    expect(queue.claim("premature")).toBeNull();
    queue.observe([], true);
    queue.resume();
    expect(queue.claim("new-session-turn")?.blocks).toEqual(prompt("finish after resume"));
  });

  test("separate clients never acquire each other's local queue", () => {
    const client = new PromptQueue();
    const other = new PromptQueue();
    client.add(prompt("mine"));
    expect(other.claim("foreign")).toBeNull();
    expect(client.claim("local")?.blocks).toEqual(prompt("mine"));
  });

  test("removing all paused work starts a fresh queue for a later turn", () => {
    const queue = new PromptQueue();
    const id = queue.add(prompt("obsolete"), "cancelled-turn");
    queue.pause("Stopped by user");
    queue.remove(id);
    queue.add(prompt("new follow-up"), "new-turn");
    queue.observe([{ id: "new-turn", end: "end_turn" }], true);
    expect(queue.claim("next")?.blocks).toEqual(prompt("new follow-up"));
  });

  test("a message refused as busy goes back first in line without pausing the queue", () => {
    const queue = new PromptQueue();
    queue.add(prompt("first"));
    queue.add(prompt("second"));
    expect(queue.claim("try-1")?.blocks).toEqual(prompt("first"));
    queue.release();
    expect(queue.getSnapshot()).toMatchObject({ pausedReason: null, awaitingTurnId: null, sendingId: null });
    expect(queue.getSnapshot().entries).toHaveLength(2);
    expect(queue.claim("try-2")?.blocks).toEqual(prompt("first"));
  });
});
