// Adapted from cube-computer: src/windows/app/src/items/agent/transcript-store.test.ts
import { beforeEach, describe, expect, test } from "vitest";
import type { AgentOpenResult, AgentRecord, JsonRpcMessage } from "../../../src/shared/agent-protocol";
import {
  MAX_BUFFERED_RECORDS,
  abortOpen,
  applyFrame,
  applyOpen,
  beginOpen,
  clientKeyOf,
  getTranscript,
  nextRequestId,
  resetTranscript,
  resetTranscriptStore,
  subscribe,
  useTranscript,
} from "../../../src/web/agent/transcript-store";
import { EMPTY_TRANSCRIPT, promptRequest } from "../../../src/web/agent/transcript";

function upd(seq: number, text: string): AgentRecord {
  const message: JsonRpcMessage = {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  };
  return { dir: "out", seq, message };
}

function prompt(seq: number, id: string): AgentRecord {
  return { dir: "in", seq, message: promptRequest(id, "s1", [{ type: "text", text: "hi" }]) };
}

function openResult(patch: Partial<AgentOpenResult> = {}): AgentOpenResult {
  return { sessionId: "s1", seq: 0, reset: false, records: [], ...patch };
}

/** Marks an item as opened with nothing in it, the way a first attach does. */
function open(itemId: string, patch: Partial<AgentOpenResult> = {}): void {
  applyOpen(itemId, openResult(patch));
}

/** The agent's text across every turn, which is all these tests care about. */
function textOf(itemId: string): string {
  return getTranscript(itemId)
    .turns.flatMap((turn) => turn.blocks.map((b) => (b.kind === "text" ? b.text : "")))
    .join("");
}

beforeEach(() => resetTranscriptStore());

test("bounded live replay restores prompt correlation before buffered completion", () => {
  const token = beginOpen("live");
  applyFrame("live", { dir: "out", seq: 5000002, message: { jsonrpc: "2.0", id: "client:active", result: { stopReason: "end_turn" } } });
  applyOpen("live", openResult({ reset: true, seq: 5000001, records: [upd(5000001, "Still working")], activePrompt: { id: "client:active" } }), token);
  expect(getTranscript("live").turns.at(-1)?.id).toBe("client:active");
  expect(getTranscript("live").turns.at(-1)?.end).toBe("end_turn");
  expect(getTranscript("live").running).toBe(false);
});

test("bounded live replay enables running while historical load replay stays idle", () => {
  open("live", { reset: true, seq: 5000001, records: [upd(5000001, "Still working")], activePrompt: { id: 17 } });
  expect(getTranscript("live").running).toBe(true);
  expect(getTranscript("live").turns.at(-1)?.id).toBe("17");
  open("history", { reset: true, seq: 5000001, records: [upd(5000001, "Historical text")], activePrompt: null });
  expect(getTranscript("history").running).toBe(false);
  expect(getTranscript("history").turns.at(-1)?.id).toBe("replay-0");
  open("legacy", { reset: true, seq: 2, records: [prompt(1, "old:1"), upd(2, "Legacy live")] });
  expect(getTranscript("legacy").running).toBe(true);
});

describe("transcript store", () => {
  test("an item nobody has opened reads as the empty transcript, by identity", () => {
    expect(getTranscript("i1")).toBe(EMPTY_TRANSCRIPT);
  });

  test("applyOpen folds a replay in, and reset:true replaces what was there", () => {
    applyOpen("i1", openResult({ seq: 2, records: [prompt(1, "c:1"), upd(2, "old")] }));
    expect(textOf("i1")).toBe("old");
    expect(getTranscript("i1").seq).toBe(2);

    applyOpen("i1", openResult({ seq: 1, reset: true, records: [upd(1, "fresh")] }));
    expect(textOf("i1")).toBe("fresh");
    expect(getTranscript("i1").seq).toBe(1);
  });

  test("a second applyOpen with reset:false appends only the delta", () => {
    applyOpen("i1", openResult({ seq: 2, records: [upd(1, "a"), upd(2, "b")] }));
    applyOpen("i1", openResult({ seq: 4, records: [upd(2, "b"), upd(3, "c"), upd(4, "d")] }));
    expect(textOf("i1")).toBe("abcd");
    expect(getTranscript("i1").seq).toBe(4);
  });

  test("applyOpen advances the cursor to the reply's seq even when it carries no records", () => {
    applyOpen("i1", openResult({ seq: 800 }));
    expect(getTranscript("i1").seq).toBe(800);
  });

  test("applyFrame folds one record in; a record at or below the cursor is a no-op", () => {
    applyOpen("i1", openResult({ seq: 5, records: [upd(5, "a")] }));
    const before = getTranscript("i1");

    applyFrame("i1", upd(5, "dup"));
    applyFrame("i1", upd(4, "older"));
    expect(getTranscript("i1")).toBe(before);

    applyFrame("i1", upd(6, "b"));
    expect(textOf("i1")).toBe("ab");
  });

  test("transcripts are per item", () => {
    open("i1");
    open("i2");
    applyFrame("i1", upd(1, "one"));
    applyFrame("i2", upd(1, "two"));
    expect(textOf("i1")).toBe("one");
    expect(textOf("i2")).toBe("two");
  });

  test("resetTranscript drops the item back to empty", () => {
    applyOpen("i1", openResult({ seq: 1, records: [upd(1, "a")] }));
    resetTranscript("i1");
    expect(getTranscript("i1")).toBe(EMPTY_TRANSCRIPT);
  });
});

describe("transcript store — frames before any open", () => {
  test("a stray frame for an unopened item is buffered, not folded against nothing", () => {
    applyFrame("i1", upd(900, "live"));
    expect(getTranscript("i1")).toBe(EMPTY_TRANSCRIPT);

    // The reply is a delta (reset:false) covering everything up to 900:
    // had the frame been folded, this whole replay would be dropped.
    applyOpen("i1", openResult({ seq: 900, records: [upd(100, "replayed"), upd(900, "live")] }));
    expect(textOf("i1")).toBe("replayedlive");
    expect(getTranscript("i1").seq).toBe(900);
  });

  test("after a reset the item goes back to buffering until the next open lands", () => {
    open("i1");
    applyFrame("i1", upd(1, "a"));
    resetTranscript("i1");

    applyFrame("i1", upd(2, "buffered"));
    expect(getTranscript("i1")).toBe(EMPTY_TRANSCRIPT);

    open("i1");
    expect(textOf("i1")).toBe("buffered");
  });
});

describe("transcript store — frames racing an open", () => {
  test("a frame that arrives during an open is buffered and drained after it", () => {
    open("i1");
    beginOpen("i1");
    applyFrame("i1", upd(900, "live"));
    expect(textOf("i1")).toBe(""); // nothing applied out of order

    applyOpen("i1", openResult({ seq: 800, records: [upd(800, "replayed")] }));
    expect(textOf("i1")).toBe("replayedlive");
    expect(getTranscript("i1").seq).toBe(900);
  });

  test("a buffered frame already inside the reply is dropped", () => {
    beginOpen("i1");
    applyFrame("i1", upd(700, "dup"));
    applyFrame("i1", upd(900, "live"));

    applyOpen("i1", openResult({ seq: 800, records: [upd(700, "replayed")] }));
    expect(textOf("i1")).toBe("replayedlive");
  });

  test("a buffered frame below a records-less reply's own cursor is dropped too", () => {
    beginOpen("i1");
    applyFrame("i1", upd(700, "dup"));
    applyOpen("i1", openResult({ seq: 800 }));
    expect(textOf("i1")).toBe("");
    expect(getTranscript("i1").seq).toBe(800);
  });

  test("buffering is per item", () => {
    open("i2");
    beginOpen("i1");
    applyFrame("i2", upd(1, "other"));
    expect(textOf("i2")).toBe("other"); // i2 has no open in flight

    applyOpen("i1", openResult({ seq: 1, records: [upd(1, "first")] }));
    applyFrame("i1", upd(2, "after"));
    expect(textOf("i1")).toBe("firstafter");
  });

  test("resetTranscript abandons an open in flight and its buffer", () => {
    beginOpen("i1");
    applyFrame("i1", upd(900, "stale"));
    resetTranscript("i1");

    applyOpen("i1", openResult({ seq: 1, records: [upd(1, "fresh")] }));
    expect(textOf("i1")).toBe("fresh");
  });
});

describe("transcript store — a failed open (abortOpen)", () => {
  test("an aborted open releases the buffer and folds what it held", () => {
    applyOpen("i1", openResult({ seq: 1, records: [upd(1, "a")] }));

    const token = beginOpen("i1");
    applyFrame("i1", upd(2, "during"));
    abortOpen("i1", token); // agent:open rejected — a sleeping machine, say
    expect(textOf("i1")).toBe("aduring");

    applyFrame("i1", upd(3, "after"));
    expect(textOf("i1")).toBe("aduringafter");
  });

  test("without an abort the buffer would swallow every later frame", () => {
    applyOpen("i1", openResult({ seq: 1, records: [upd(1, "a")] }));
    beginOpen("i1");
    applyFrame("i1", upd(2, "lost"));
    applyFrame("i1", upd(3, "lost too"));
    expect(textOf("i1")).toBe("a"); // the failure path this documents
  });

  test("aborting an open that never landed keeps its frames buffered for the next one", () => {
    const token = beginOpen("i1");
    applyFrame("i1", upd(900, "live"));
    abortOpen("i1", token);
    expect(getTranscript("i1")).toBe(EMPTY_TRANSCRIPT);

    applyOpen("i1", openResult({ seq: 800, records: [upd(800, "replayed")] }));
    expect(textOf("i1")).toBe("replayedlive");
  });

  test("a stale token aborts nothing", () => {
    open("i1");
    const first = beginOpen("i1");
    beginOpen("i1");
    applyFrame("i1", upd(2, "during"));
    abortOpen("i1", first);
    expect(textOf("i1")).toBe(""); // still buffered by the newer open
  });
});

describe("transcript store — overlapping opens (generation tokens)", () => {
  test("a superseded open's reply is ignored; the newest one wins", () => {
    const first = beginOpen("i1");
    const second = beginOpen("i1");

    applyOpen("i1", openResult({ seq: 5, reset: true, records: [upd(5, "stale") ] }), first);
    expect(getTranscript("i1")).toBe(EMPTY_TRANSCRIPT);

    applyOpen("i1", openResult({ seq: 6, reset: true, records: [upd(6, "current")] }), second);
    expect(textOf("i1")).toBe("current");
  });

  test("frames keep buffering while the stale reply is ignored, and land with the live one", () => {
    const first = beginOpen("i1");
    const second = beginOpen("i1");
    applyFrame("i1", upd(9, "live"));

    applyOpen("i1", openResult({ seq: 5, records: [upd(5, "stale")] }), first);
    applyOpen("i1", openResult({ seq: 8, records: [upd(8, "replayed")] }), second);
    expect(textOf("i1")).toBe("replayedlive");
  });

  test("applyOpen with no token still applies (the caller kept no generation)", () => {
    beginOpen("i1");
    applyOpen("i1", openResult({ seq: 1, records: [upd(1, "a")] }));
    applyFrame("i1", upd(2, "b"));
    expect(textOf("i1")).toBe("ab");
  });
});

describe("transcript store — a buffer that overflows", () => {
  test("the oldest frames are dropped and the next reply is treated as authoritative", () => {
    applyOpen("i1", openResult({ seq: 1, records: [upd(1, "old")] }));
    const token = beginOpen("i1");

    // One more than the cap: the first buffered frame is dropped.
    for (let seq = 2; seq <= MAX_BUFFERED_RECORDS + 2; seq++) {
      applyFrame("i1", upd(seq, seq === 2 ? "dropped" : seq === MAX_BUFFERED_RECORDS + 2 ? "last" : ""));
    }

    applyOpen("i1", openResult({ seq: 1, records: [] }), token);
    // "old" is gone because the reply replaced a transcript with a hole in
    // it, and "dropped" is gone because the buffer shed it.
    expect(textOf("i1")).toBe("last");
    expect(getTranscript("i1").seq).toBe(MAX_BUFFERED_RECORDS + 2);
  });

  test("a buffer that stays under the cap is not treated as a reset", () => {
    applyOpen("i1", openResult({ seq: 1, records: [upd(1, "old")] }));
    const token = beginOpen("i1");
    applyFrame("i1", upd(2, "new"));
    applyOpen("i1", openResult({ seq: 1, records: [] }), token);
    expect(textOf("i1")).toBe("oldnew");
  });
});

describe("transcript store — subscribers", () => {
  test("subscribers fire on change, not on a no-op, and stop after unsubscribe", () => {
    open("i1");
    let fired = 0;
    const unsubscribe = subscribe(() => void fired++);

    applyFrame("i1", upd(1, "a"));
    expect(fired).toBe(1);

    applyFrame("i1", upd(1, "a")); // duplicate seq
    expect(fired).toBe(1);

    beginOpen("i1");
    applyFrame("i1", upd(9, "buffered"));
    expect(fired).toBe(1); // buffered, not applied

    applyOpen("i1", openResult({ seq: 5 }));
    expect(fired).toBe(2); // one notification for the open and its drain

    resetTranscript("i1");
    expect(fired).toBe(3);

    unsubscribe();
    open("i1");
    applyFrame("i1", upd(20, "b"));
    expect(fired).toBe(3);
  });

  test("an aborted open notifies once for the frames it releases", () => {
    open("i1");
    let fired = 0;
    const unsubscribe = subscribe(() => void fired++);
    const token = beginOpen("i1");
    applyFrame("i1", upd(1, "a"));
    applyFrame("i1", upd(2, "b"));
    expect(fired).toBe(0);

    abortOpen("i1", token);
    expect(fired).toBe(1);
    expect(textOf("i1")).toBe("ab");
    unsubscribe();
  });
});

describe("transcript store — client request ids", () => {
  test("clientKeyOf mints one uuid per item and keeps it", () => {
    const first = clientKeyOf("i1");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(clientKeyOf("i1")).toBe(first);
    expect(clientKeyOf("i2")).not.toBe(first);
  });

  test("nextRequestId counts within that item's namespace", () => {
    const key = clientKeyOf("i1");
    expect(nextRequestId("i1")).toBe(`${key}:1`);
    expect(nextRequestId("i1")).toBe(`${key}:2`);
    expect(nextRequestId("i2")).toBe(`${clientKeyOf("i2")}:1`);
    expect(nextRequestId("i1")).toBe(`${key}:3`);
  });

  test("a reset transcript keeps the namespace, so an id is never reused", () => {
    const key = clientKeyOf("i1");
    expect(nextRequestId("i1")).toBe(`${key}:1`);
    resetTranscript("i1");
    expect(clientKeyOf("i1")).toBe(key);
    expect(nextRequestId("i1")).toBe(`${key}:2`);
  });
});

describe("transcript store — React binding", () => {
  test("useTranscript is a hook over the same store", () => {
    expect(typeof useTranscript).toBe("function");
  });
});
