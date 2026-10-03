// Adapted from cube-computer: src/windows/app/src/items/agent/agent-item-logic.test.ts
import { describe, expect, test } from "vitest";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import {
  MAX_DIFF_LINES,
  composerBlocks,
  filterCommands,
  foldRuns,
  shouldStickToBottom,
  unifiedLines,
} from "../../../src/web/agent/agent-item-logic";
import type { Block, ToolCallState } from "../../../src/web/agent/transcript";

function call(over: Partial<ToolCallState> = {}): ToolCallState {
  return {
    toolCallId: over.toolCallId ?? "t1",
    title: over.title ?? "",
    kind: over.kind ?? "other",
    status: over.status ?? "completed",
    content: over.content ?? [],
    locations: over.locations ?? [],
  };
}

function tool(over: Partial<ToolCallState> = {}): Block {
  return { kind: "tool", call: call(over) };
}

describe("shouldStickToBottom", () => {
  test("sticks while the viewport is at the bottom", () => {
    expect(shouldStickToBottom(800, 1000, 200)).toBe(true);
  });

  test("sticks within the 40px slack", () => {
    expect(shouldStickToBottom(770, 1000, 200)).toBe(true);
  });

  test("releases once the user has scrolled further up", () => {
    expect(shouldStickToBottom(600, 1000, 200)).toBe(false);
  });

  test("a column shorter than its viewport is always at the bottom", () => {
    expect(shouldStickToBottom(0, 100, 400)).toBe(true);
  });
});

describe("foldRuns", () => {
  test("text blocks stay their own segments", () => {
    const segments = foldRuns([
      { kind: "text", text: "hello" },
      { kind: "text", text: "there" },
    ]);
    expect(segments).toEqual([
      { kind: "text", text: "hello" },
      { kind: "text", text: "there" },
    ]);
  });

  test("a contiguous run of thoughts and tools folds into one activity segment", () => {
    const blocks: Block[] = [
      { kind: "thought", text: "thinking" },
      tool({ toolCallId: "a", kind: "read", title: "a.ts" }),
      tool({ toolCallId: "b", kind: "read", title: "b.ts" }),
      tool({ toolCallId: "c", kind: "read", title: "c.ts" }),
      tool({ toolCallId: "d", kind: "execute", title: "npm test" }),
      { kind: "text", text: "done" },
    ];
    const segments = foldRuns(blocks);
    expect(segments.length).toBe(2);
    const activity = segments[0]!;
    expect(activity.kind).toBe("activity");
    if (activity.kind !== "activity") throw new Error("unreachable");
    expect(activity.blocks.length).toBe(5);
    expect(activity.summary).toBe("Thought · Read 3 files · Ran npm test");
    expect(segments[1]).toEqual({ kind: "text", text: "done" });
  });

  test("text between two runs splits them", () => {
    const segments = foldRuns([
      tool({ toolCallId: "a", kind: "read", title: "a.ts" }),
      { kind: "text", text: "mid" },
      tool({ toolCallId: "b", kind: "read", title: "b.ts" }),
    ]);
    expect(segments.map((s) => s.kind)).toEqual(["activity", "text", "activity"]);
  });

  test("structured assistant content remains a first-class segment between folded runs", () => {
    const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
    const segments = foldRuns([
      tool({ toolCallId: "a", kind: "read", title: "a.ts" }),
      { kind: "content", content: image },
      tool({ toolCallId: "b", kind: "read", title: "b.ts" }),
    ]);
    expect(segments.map((segment) => segment.kind)).toEqual(["activity", "content", "activity"]);
    expect(segments[1]).toEqual({ kind: "content", content: image });
  });

  test("a folded activity summary exposes live and failed tool counts", () => {
    const segments = foldRuns([
      tool({ toolCallId: "a", kind: "execute", title: "build", status: "in_progress" }),
      tool({ toolCallId: "b", kind: "execute", title: "test", status: "failed" }),
    ]);
    const activity = segments[0]!;
    if (activity.kind !== "activity") throw new Error("expected an activity segment");
    expect(activity.running).toBe(1);
    expect(activity.failed).toBe(1);
  });

  test("a plan is its own segment and never joins a run", () => {
    const segments = foldRuns([
      tool({ toolCallId: "a", kind: "read", title: "a.ts" }),
      { kind: "plan", entries: [{ content: "step", priority: "high", status: "pending" }] },
      tool({ toolCallId: "b", kind: "read", title: "b.ts" }),
    ]);
    expect(segments.map((s) => s.kind)).toEqual(["activity", "plan", "activity"]);
  });

  test("a run of only thoughts still reads as one", () => {
    const segments = foldRuns([{ kind: "thought", text: "hmm" }]);
    const first = segments[0]!;
    if (first.kind !== "activity") throw new Error("expected an activity segment");
    expect(first.summary).toBe("Thought");
  });

  test("an untitled tool falls back to its kind rather than an empty phrase", () => {
    const segments = foldRuns([tool({ kind: "execute", title: "" })]);
    const first = segments[0]!;
    if (first.kind !== "activity") throw new Error("expected an activity segment");
    expect(first.summary).toBe("Ran a command");
  });

  test("a long title is trimmed so the status line stays one line", () => {
    const segments = foldRuns([tool({ kind: "execute", title: "x".repeat(200) })]);
    const first = segments[0]!;
    if (first.kind !== "activity") throw new Error("expected an activity segment");
    expect(first.summary.length).toBeLessThan(80);
    expect(first.summary.endsWith("…")).toBe(true);
  });
});

describe("unifiedLines", () => {
  test("an unchanged line is context, a replaced one is a remove then an add", () => {
    expect(unifiedLines("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "context", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "B" },
      { kind: "context", text: "c" },
    ]);
  });

  test("a pure insertion carries no removes", () => {
    expect(unifiedLines("a\nc", "a\nb\nc")).toEqual([
      { kind: "context", text: "a" },
      { kind: "add", text: "b" },
      { kind: "context", text: "c" },
    ]);
  });

  test("a created file (no oldText) is all additions", () => {
    expect(unifiedLines(null, "x\ny")).toEqual([
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ]);
  });

  test("identical text produces only context", () => {
    expect(unifiedLines("same", "same")).toEqual([{ kind: "context", text: "same" }]);
  });

  test("output is capped and says so", () => {
    const long = Array.from({ length: MAX_DIFF_LINES + 500 }, (_, i) => `line ${i}`).join("\n");
    const lines = unifiedLines("", long);
    expect(lines.length).toBe(MAX_DIFF_LINES + 1);
    expect(lines[lines.length - 1]).toEqual({ kind: "truncated", text: "… truncated" });
  });
});

describe("composerBlocks", () => {
  test("plain text becomes one text block", () => {
    expect(composerBlocks("hello  ", [])).toEqual([{ type: "text", text: "hello" }]);
  });

  test("images follow the text as base64 image blocks", () => {
    expect(composerBlocks("look", [{ data: "AAA", mimeType: "image/png" }])).toEqual([
      { type: "text", text: "look" },
      { type: "image", data: "AAA", mimeType: "image/png" },
    ]);
  });

  test("an image with no text sends on its own", () => {
    expect(composerBlocks("   ", [{ data: "AAA", mimeType: "image/png" }])).toEqual([
      { type: "image", data: "AAA", mimeType: "image/png" },
    ]);
  });

  test("nothing to say is nothing to send", () => {
    expect(composerBlocks("   \n ", [])).toEqual([]);
  });
});

describe("filterCommands", () => {
  const commands: AvailableCommand[] = [
    { name: "compact", description: "Compact the conversation" },
    { name: "clear", description: "Clear it" },
    { name: "review", description: "Review a PR" },
  ];

  test("a leading slash offers every command", () => {
    expect(filterCommands("/", commands).map((c) => c.name)).toEqual(["compact", "clear", "review"]);
  });

  test("typing narrows by prefix", () => {
    expect(filterCommands("/c", commands).map((c) => c.name)).toEqual(["compact", "clear"]);
  });

  test("no slash, no popover", () => {
    expect(filterCommands("compact", commands)).toEqual([]);
  });

  test("a slash followed by an argument is no longer a command search", () => {
    expect(filterCommands("/review 12", commands)).toEqual([]);
  });

  test("a slash that matches nothing offers nothing", () => {
    expect(filterCommands("/zzz", commands)).toEqual([]);
  });
});
