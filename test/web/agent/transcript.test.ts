// Adapted from cube-computer: src/windows/app/src/items/agent/transcript.test.ts
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRecord, JsonRpcMessage } from "../../../src/shared/agent-protocol";
import {
  EMPTY_TRANSCRIPT,
  cancelNotification,
  permissionResponse,
  promptRequest,
  reduceRecord,
  reduceRecords,
  setModeRequest,
} from "../../../src/web/agent/transcript";
import type { Transcript } from "../../../src/web/agent/transcript";
import type { ContentBlock, PlanEntry, ToolCallContent } from "@agentclientprotocol/sdk";
import type { SessionConfigOption } from "../../../src/web/agent/session-controls";

// -- record builders ------------------------------------------------------

function inn(seq: number, message: JsonRpcMessage): AgentRecord {
  return { dir: "in", seq, message };
}

function out(seq: number, message: JsonRpcMessage): AgentRecord {
  return { dir: "out", seq, message };
}

/** An `out` `session/update` notification carrying `update`. */
function upd(seq: number, update: Record<string, unknown>): AgentRecord {
  return out(seq, { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update } });
}

function text(t: string): Record<string, unknown> {
  return { type: "text", text: t };
}

function reduce(records: AgentRecord[], from: Transcript = EMPTY_TRANSCRIPT): Transcript {
  return reduceRecords(from, records, false);
}

/** A transcript with one open prompt turn (id "c:1"), running. */
function withOpenTurn(seq = 1): Transcript {
  return reduce([inn(seq, promptRequest("c:1", "s1", [{ type: "text", text: "hi" }]))]);
}

describe("reduceRecord — handshake (semantic 1)", () => {
  test("initialize's response sets loadSession; session/new's sets acpSessionId and modes", () => {
    const t = reduce([
      inn(1, { jsonrpc: "2.0", id: "d:1", method: "initialize", params: {} }),
      out(2, { jsonrpc: "2.0", id: "d:1", result: { agentCapabilities: { loadSession: true } } }),
      inn(3, { jsonrpc: "2.0", id: "d:2", method: "session/new", params: { cwd: "/tmp" } }),
      out(4, {
        jsonrpc: "2.0",
        id: "d:2",
        result: {
          sessionId: "acp-1",
          modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Manual" }] },
        },
      }),
    ]);
    expect(t.loadSession).toBe(true);
    expect(t.acpSessionId).toBe("acp-1");
    expect(t.modes.current).toBe("default");
    expect(t.modes.available).toEqual([{ id: "default", name: "Manual" }]);
    expect(t.handshakeError).toBeNull();
    expect(t.seq).toBe(4);
  });

  test("session/load retains its request sessionId and cwd when the adapter omits them", () => {
    const t = reduce([
      inn(1, {
        jsonrpc: "2.0",
        id: 2,
        method: "session/load",
        params: { sessionId: "acp-1", cwd: "/native/repo" },
      }),
      out(2, { jsonrpc: "2.0", id: 2, result: { configOptions: [] } }),
    ]);
    expect(t.acpSessionId).toBe("acp-1");
    expect(t.cwd).toBe("/native/repo");
  });

  test("a control response cannot finish a pending session/load handshake", () => {
    const loading = reduce([
      inn(1, { jsonrpc: "2.0", id: "load:1", method: "session/load", params: { sessionId: "s1" } }),
      inn(2, setModeRequest("mode:1", "s1", "plan")),
      out(3, { jsonrpc: "2.0", id: "mode:1", result: { modes: { currentModeId: "plan" } } }),
    ]);
    expect(loading.controlRequests).toEqual([]);
    expect(loading.modes.current).toBe("plan");
    expect(loading.handshake.sessionReady).toBe(false);

    const ready = reduce([
      out(4, { jsonrpc: "2.0", id: "load:1", result: {} }),
    ], loading);
    expect(ready.handshake.sessionReady).toBe(true);
    expect(ready.acpSessionId).toBe("s1");
  });

  test("initialize preserves agent identity, prompt capabilities, and auth methods", () => {
    const t = reduce([
      inn(1, { jsonrpc: "2.0", id: "d:1", method: "initialize", params: {} }),
      out(2, {
        jsonrpc: "2.0",
        id: "d:1",
        result: {
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } },
          agentInfo: { name: "test-agent", title: "Test Agent", version: "1.2.3" },
          authMethods: [{ id: "login", name: "Log in" }],
        },
      }),
    ]);
    expect(t.agentInfo).toEqual({ name: "test-agent", title: "Test Agent", version: "1.2.3" });
    expect(t.promptCapabilities).toEqual({ image: true, embeddedContext: true });
    expect(t.authMethods).toEqual([{ id: "login", name: "Log in" }]);
  });

  test("loadSession is false when the agent does not advertise it", () => {
    const t = reduce([
      inn(1, { jsonrpc: "2.0", id: "d:1", method: "initialize", params: {} }),
      out(2, { jsonrpc: "2.0", id: "d:1", result: { agentCapabilities: {} } }),
    ]);
    expect(t.loadSession).toBe(false);
  });

  test("an error response to a handshake request sets handshakeError", () => {
    const t = reduce([
      inn(1, { jsonrpc: "2.0", id: "d:2", method: "session/load", params: {} }),
      out(2, { jsonrpc: "2.0", id: "d:2", error: { code: -32603, message: "no such session" } }),
    ]);
    expect(t.handshakeError).toBe("no such session");
    expect(t.acpSessionId).toBeNull();
  });

  for (const method of ["initialize", "session/new", "session/load"]) {
    test(`${method} auth-required response records an authentication block`, () => {
      const t = reduce([
        inn(1, { jsonrpc: "2.0", id: "d:2", method, params: {} }),
        out(2, { jsonrpc: "2.0", id: "d:2", error: { code: -32000, message: "Authentication required" } }),
      ]);
      expect(t.authRequired).toEqual({ requestId: "d:2", prompt: null });
    });
  }
});

describe("reduceRecord — turns (semantic 2)", () => {
  test("an `in` session/prompt opens a turn and sets running", () => {
    const t = withOpenTurn();
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.id).toBe("c:1");
    expect(t.turns[0]?.user).toEqual([{ type: "text", text: "hi" }]);
    expect(t.turns[0]?.blocks).toEqual([]);
    expect(t.turns[0]?.end).toBeNull();
    expect(t.running).toBe(true);
  });
});

describe("reduceRecord — replay user chunks (semantic 3)", () => {
  test("a user_message_chunk with no open turn opens a synthetic replay turn", () => {
    const t = reduce([upd(1, { sessionUpdate: "user_message_chunk", content: text("read hello.txt") })]);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.id).toBe("replay-0");
    expect(t.turns[0]?.user).toEqual([{ type: "text", text: "read hello.txt" }]);
  });

  test("a second user_message_chunk appends to the open replay turn's user", () => {
    const t = reduce([
      upd(1, { sessionUpdate: "user_message_chunk", content: text("read ") }),
      upd(2, { sessionUpdate: "user_message_chunk", content: text("hello.txt") }),
    ]);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.user).toEqual([
      { type: "text", text: "read " },
      { type: "text", text: "hello.txt" },
    ]);
  });

  test("a user_message_chunk after the replay turn has blocks opens a new replay turn", () => {
    const t = reduce([
      upd(1, { sessionUpdate: "user_message_chunk", content: text("first") }),
      upd(2, { sessionUpdate: "agent_message_chunk", content: text("answer") }),
      upd(3, { sessionUpdate: "user_message_chunk", content: text("second") }),
    ]);
    expect(t.turns).toHaveLength(2);
    expect(t.turns[1]?.id).toBe("replay-1");
    expect(t.turns[1]?.user).toEqual([{ type: "text", text: "second" }]);
  });

  test("a user_message_chunk during a live prompt turn is dropped (the turn already holds it)", () => {
    const t = reduce([upd(2, { sessionUpdate: "user_message_chunk", content: text("hi") })], withOpenTurn());
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.user).toEqual([{ type: "text", text: "hi" }]);
    expect(t.seq).toBe(2);
  });
});

describe("reduceRecord — message chunks (semantic 4)", () => {
  test("agent_message_chunks coalesce into one text block", () => {
    const t = reduce(
      [
        upd(2, { sessionUpdate: "agent_message_chunk", content: text("The") }),
        upd(3, { sessionUpdate: "agent_message_chunk", content: text(" first line") }),
      ],
      withOpenTurn(),
    );
    expect(t.turns[0]?.blocks).toEqual([{ kind: "text", text: "The first line" }]);
  });

  test("agent_thought_chunks coalesce into a thought block, separate from text", () => {
    const t = reduce(
      [
        upd(2, { sessionUpdate: "agent_thought_chunk", content: text("hmm") }),
        upd(3, { sessionUpdate: "agent_thought_chunk", content: text("...") }),
        upd(4, { sessionUpdate: "agent_message_chunk", content: text("done") }),
      ],
      withOpenTurn(),
    );
    expect(t.turns[0]?.blocks).toEqual([
      { kind: "thought", text: "hmm..." },
      { kind: "text", text: "done" },
    ]);
  });

  test("non-text content blocks retain their structured content", () => {
    const image = { type: "image", data: "x", mimeType: "image/png" } satisfies ContentBlock;
    const resource = {
      type: "resource",
      resource: { uri: "file:///x", text: "source" },
    } satisfies ContentBlock;
    const t = reduce(
      [
        upd(2, { sessionUpdate: "agent_message_chunk", content: text("look:") }),
        upd(3, { sessionUpdate: "agent_message_chunk", content: image }),
        upd(4, { sessionUpdate: "agent_message_chunk", content: resource }),
      ],
      withOpenTurn(),
    );
    expect(t.turns[0]?.blocks).toEqual([
      { kind: "text", text: "look:" },
      { kind: "content", content: image },
      { kind: "content", content: resource },
    ]);
  });

  test("a chunk after the turn ended opens a synthetic turn rather than reopening it", () => {
    const t = reduce(
      [
        upd(2, { sessionUpdate: "agent_message_chunk", content: text("done") }),
        out(3, { jsonrpc: "2.0", id: "c:1", result: { stopReason: "end_turn" } }),
        upd(4, { sessionUpdate: "agent_message_chunk", content: text("late") }),
      ],
      withOpenTurn(),
    );
    expect(t.turns).toHaveLength(2);
    expect(t.turns[0]?.blocks).toEqual([{ kind: "text", text: "done" }]);
    expect(t.turns[1]?.id).toBe("replay-1");
    expect(t.turns[1]?.blocks).toEqual([{ kind: "text", text: "late" }]);
    expect(t.turns[0]?.end).toBe("end_turn");
  });

  test("a chunk with no open turn opens a synthetic turn (a mid-transcript start)", () => {
    const t = reduce([upd(1, { sessionUpdate: "agent_message_chunk", content: text("hi") })]);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.id).toBe("replay-0");
    expect(t.turns[0]?.user).toEqual([]);
    expect(t.turns[0]?.blocks).toEqual([{ kind: "text", text: "hi" }]);
  });
});

describe("reduceRecord — defensive content parsing", () => {
  const malformed = [
    null, [], 7, {}, { type: "text" }, { type: "text", text: {} },
    { type: "image", data: "bytes" }, { type: "audio", data: 4, mimeType: "audio/wav" },
    { type: "resource" }, { type: "resource", resource: null },
    { type: "resource", resource: { uri: "file:///x" } },
    { type: "resource", resource: { uri: 4, text: "source" } },
    { type: "resource", resource: { uri: "file:///x", text: {}, blob: "bytes" } },
    { type: "resource_link", uri: "file:///x" },
    { type: "resource_link", uri: "file:///x", name: "x", title: {} },
  ];
  const valid: ContentBlock[] = [
    { type: "text", text: "hello" },
    { type: "image", data: "bytes", mimeType: "image/png" },
    { type: "audio", data: "bytes", mimeType: "audio/wav" },
    { type: "resource", resource: { uri: "file:///x", text: "source" } },
    { type: "resource", resource: { uri: "file:///x", blob: "bytes", mimeType: null } },
    { type: "resource_link", uri: "file:///x", name: "x", title: null },
    { type: "future_content", payload: { arbitrary: true } } as unknown as ContentBlock,
  ];

  test("malformed known message blocks are ignored before creating transcript turns", () => {
    for (const sessionUpdate of ["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]) {
      const records = malformed.map((content, index) => upd(index + 1, { sessionUpdate, content }));
      const t = reduce(records);
      expect(t.turns).toEqual([]);
      expect(t.seq).toBe(records.length);
    }
  });

  test("prompt content drops malformed entries and retains media, resources, and future blocks", () => {
    const t = reduce([inn(1, {
      jsonrpc: "2.0", id: "p", method: "session/prompt", params: { prompt: [...malformed, ...valid] },
    })]);
    expect(t.turns[0]?.user).toEqual(valid);
  });

  test("compaction summaries validate both snapshots and streamed chunks", () => {
    const t = reduce([
      upd(1, { sessionUpdate: "compaction_update", compactionId: "c", status: "running", summary: [...malformed, ...valid] }),
      ...malformed.map((content, index) => upd(index + 2, { sessionUpdate: "compaction_summary_chunk", compactionId: "c", content })),
    ]);
    expect(t.compaction[0]?.summary).toEqual(valid);
  });

  const malformedToolContent = [
    null, [], 4, {}, { type: "content" }, { type: "content", content: null },
    { type: "content", content: { type: "resource" } },
    { type: "diff", path: "/x", newText: {} },
    { type: "diff", path: "/x", newText: "after", oldText: {} },
    { type: "terminal", terminalId: null },
  ];
  const validToolContent: ToolCallContent[] = [
    ...valid.map((content): ToolCallContent => ({ type: "content", content })),
    { type: "diff", path: "/x", newText: "after", oldText: null },
    { type: "terminal", terminalId: "term-1" },
    { type: "future_tool_content", payload: null } as unknown as ToolCallContent,
  ];

  for (const sessionUpdate of ["tool_call", "tool_call_update"]) {
    test(`${sessionUpdate} removes invalid tool content entries before storing them`, () => {
      const t = reduce([
        upd(1, { sessionUpdate: "tool_call", toolCallId: "t", content: [] }),
        upd(2, { sessionUpdate, toolCallId: "t", content: [...malformedToolContent, ...validToolContent] }),
      ]);
      const block = t.turns[0]?.blocks.at(-1);
      expect(block?.kind === "tool" && block.call.content).toEqual(validToolContent);
    });
  }

  test("permission requests validate tool content at the same boundary", () => {
    const t = reduce([out(1, {
      jsonrpc: "2.0", id: "permission", method: "session/request_permission",
      params: { toolCall: { toolCallId: "t", content: [...malformedToolContent, ...validToolContent] }, options: [] },
    })]);
    expect(t.pending[0]?.toolCall.content).toEqual(validToolContent);
  });
});

describe("reduceRecord — tool calls (semantic 5)", () => {
  test("tool_call pushes a tool block with defaults for everything omitted", () => {
    const t = reduce([upd(2, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read File" })], withOpenTurn());
    expect(t.turns[0]?.blocks).toEqual([
      {
        kind: "tool",
        call: { toolCallId: "t1", title: "Read File", kind: "other", status: "pending", content: [], locations: [] },
      },
    ]);
  });

  test("tool_call_update merges only the fields it carries", () => {
    const t = reduce(
      [
        upd(2, {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Read File",
          kind: "read",
          rawInput: { file_path: "/tmp/hello.txt" },
        }),
        upd(3, { sessionUpdate: "tool_call_update", toolCallId: "t1", title: null, kind: null, status: "in_progress" }),
        upd(4, {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          content: [{ type: "content", content: text("first line") }],
          locations: [{ path: "/tmp/hello.txt", line: 1 }],
          rawOutput: "first line",
        }),
      ],
      withOpenTurn(),
    );
    const block = t.turns[0]?.blocks[0];
    expect(block?.kind).toBe("tool");
    expect(block?.kind === "tool" && block.call).toEqual({
      toolCallId: "t1",
      title: "Read File",
      kind: "read",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "first line" } }],
      locations: [{ path: "/tmp/hello.txt", line: 1 }],
      rawInput: { file_path: "/tmp/hello.txt" },
      rawOutput: "first line",
    });
  });

  test("tool_call_update searches every turn, latest first", () => {
    const t = reduce(
      [
        upd(2, { sessionUpdate: "tool_call", toolCallId: "t1", title: "old" }),
        out(3, { jsonrpc: "2.0", id: "c:1", result: { stopReason: "end_turn" } }),
        inn(4, promptRequest("c:2", "s1", [{ type: "text", text: "again" }])),
        upd(5, { sessionUpdate: "tool_call", toolCallId: "t1", title: "new" }),
        upd(6, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
      ],
      withOpenTurn(),
    );
    const first = t.turns[0]?.blocks[0];
    const second = t.turns[1]?.blocks[0];
    expect(first?.kind === "tool" && first.call.status).toBe("pending");
    expect(second?.kind === "tool" && second.call.status).toBe("completed");
  });

  test("a tool_call_update for an unknown id pushes a new tool block", () => {
    const t = reduce([upd(2, { sessionUpdate: "tool_call_update", toolCallId: "ghost", title: "Ran" })], withOpenTurn());
    const block = t.turns[0]?.blocks[0];
    expect(block?.kind === "tool" && block.call).toEqual({
      toolCallId: "ghost",
      title: "Ran",
      kind: "other",
      status: "pending",
      content: [],
      locations: [],
    });
  });

  test("a tool_call with no open turn opens a synthetic turn", () => {
    const t = reduce([upd(1, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read" })]);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.id).toBe("replay-0");
    expect(t.turns[0]?.blocks).toHaveLength(1);
  });
});

describe("reduceRecord — plan (semantic 6)", () => {
  test("plan pushes a plan block, and a second plan replaces it", () => {
    const entries: PlanEntry[] = [{ content: "step one", priority: "high", status: "pending" }];
    const later: PlanEntry[] = [{ content: "step one", priority: "high", status: "completed" }];
    const t = reduce(
      [
        upd(2, { sessionUpdate: "plan", entries }),
        upd(3, { sessionUpdate: "agent_message_chunk", content: text("working") }),
        upd(4, { sessionUpdate: "plan", entries: later }),
      ],
      withOpenTurn(),
    );
    const plans = (t.turns[0]?.blocks ?? []).filter((b) => b.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.kind === "plan" && plans[0].entries).toEqual(later);
  });

  test("plan_update and plan_removed are unhandled no-ops that still advance seq", () => {
    const base = reduce([upd(2, { sessionUpdate: "plan", entries: [] })], withOpenTurn());
    const t = reduce(
      [
        upd(3, { sessionUpdate: "plan_update", planId: "p1", content: { entries: [] } }),
        upd(4, { sessionUpdate: "plan_removed", planId: "p1" }),
      ],
      base,
    );
    expect(t.turns[0]?.blocks).toEqual(base.turns[0]?.blocks ?? []);
    expect(t.seq).toBe(4);
  });
});

describe("reduceRecord — commands and modes (semantic 7)", () => {
  test("available_commands_update replaces commands; current_mode_update sets the current mode", () => {
    const commands = [{ name: "deep-research", description: "think hard", input: null }];
    const t = reduce([
      upd(1, { sessionUpdate: "available_commands_update", availableCommands: commands }),
      upd(2, { sessionUpdate: "current_mode_update", currentModeId: "accept-edits" }),
    ]);
    expect(t.commands).toEqual(commands);
    expect(t.modes.current).toBe("accept-edits");
  });
});

describe("reduceRecord — session configuration", () => {
  const initial = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "fast",
    options: [{ value: "fast", name: "Fast" }],
  } satisfies SessionConfigOption;
  const replacement = {
    id: "telemetry",
    name: "Telemetry",
    type: "boolean",
    currentValue: false,
  } satisfies SessionConfigOption;

  test("session results and config updates are full replacements", () => {
    const t = reduce([
      inn(1, { jsonrpc: "2.0", id: "d:2", method: "session/new", params: { cwd: "/repo" } }),
      out(2, { jsonrpc: "2.0", id: "d:2", result: { sessionId: "s1", configOptions: [initial] } }),
      upd(3, { sessionUpdate: "config_option_update", configOptions: [replacement] }),
    ]);
    expect(t.cwd).toBe("/repo");
    expect(t.configOptions).toEqual([replacement]);
  });

  test("malformed replacement data cannot crash or erase known-good controls", () => {
    const seeded = reduce([
      inn(1, { jsonrpc: "2.0", id: "d:2", method: "session/new", params: {} }),
      out(2, { jsonrpc: "2.0", id: "d:2", result: { sessionId: "s1", configOptions: [initial] } }),
    ]);
    const afterNonArray = reduce([
      upd(3, { sessionUpdate: "config_option_update", configOptions: "broken" }),
    ], seeded);
    expect(afterNonArray.configOptions).toEqual([initial]);
    const t = reduce([
      upd(4, {
        sessionUpdate: "config_option_update",
        configOptions: [{ id: "future", name: "Future", type: "number", currentValue: 1 }],
      }),
    ], afterNonArray);
    expect(t.configOptions).toEqual([]);
    expect(t.seq).toBe(4);
  });

  test("a config request stays pending until a correlated success supplies authoritative state", () => {
    const pending = reduce([
      inn(1, {
        jsonrpc: "2.0",
        id: "c:7",
        method: "session/set_config_option",
        params: { sessionId: "s1", configId: "telemetry", type: "boolean", value: false },
      }),
      out(2, { jsonrpc: "2.0", id: "other", result: { configOptions: [initial] } }),
    ]);
    expect(pending.controlRequests).toEqual([
      {
        requestId: "c:7",
        method: "session/set_config_option",
        configId: "telemetry",
        value: false,
      },
    ]);
    const t = reduce([
      out(3, { jsonrpc: "2.0", id: "c:7", result: { configOptions: [replacement] } }),
    ], pending);
    expect(t.controlRequests).toEqual([]);
    expect(t.controlError).toBeNull();
    expect(t.configOptions).toEqual([replacement]);
  });

  test("a correlated control error clears pending state and retains one bounded visible error", () => {
    const request = (id: string, configId: string) =>
      inn(1, {
        jsonrpc: "2.0",
        id,
        method: "session/set_config_option",
        params: { sessionId: "s1", configId, value: "x" },
      });
    const first = reduce([
      request("c:1", "model"),
      out(2, { jsonrpc: "2.0", id: "c:1", error: { code: -32602, message: "unsupported model" } }),
    ]);
    expect(first.controlRequests).toEqual([]);
    expect(first.controlError).toEqual({
      requestId: "c:1",
      method: "session/set_config_option",
      configId: "model",
      value: "x",
      message: "unsupported model",
    });

    const second = reduce([
      inn(3, {
        jsonrpc: "2.0",
        id: "c:2",
        method: "session/set_model",
        params: { sessionId: "s1", modelId: "legacy" },
      }),
      out(4, { jsonrpc: "2.0", id: "c:2", error: { code: -1, message: "second error" } }),
    ], first);
    expect(second.controlError?.message).toBe("second error");
    expect(second.controlError?.method).toBe("session/set_model");
  });

  test("legacy model state is isolated and replaced from observed adapter results", () => {
    const t = reduce([
      inn(1, { jsonrpc: "2.0", id: "d:2", method: "session/new", params: {} }),
      out(2, {
        jsonrpc: "2.0",
        id: "d:2",
        result: {
          sessionId: "s1",
          models: {
            currentModelId: "legacy-2",
            availableModels: [
              { modelId: "legacy-1", name: "Legacy One" },
              { modelId: 9, name: "Malformed" },
              { modelId: "legacy-2", name: "Legacy Two", description: "Selected" },
            ],
          },
        },
      }),
    ]);
    expect(t.models).toEqual({
      current: "legacy-2",
      available: [
        { id: "legacy-1", name: "Legacy One" },
        { id: "legacy-2", name: "Legacy Two", description: "Selected" },
      ],
    });
  });

  test("pending controls and visible error text stay bounded under malformed traffic", () => {
    const requests = Array.from({ length: 35 }, (_, index) =>
      inn(index + 1, {
        jsonrpc: "2.0",
        id: `c:${index}`,
        method: "session/set_mode",
        params: { sessionId: "s1", modeId: `mode-${index}` },
      }),
    );
    const pending = reduce(requests);
    expect(pending.controlRequests).toHaveLength(32);
    expect(pending.controlRequests[0]?.requestId).toBe("c:3");

    const message = "x".repeat(1_200);
    const failed = reduce(
      [out(36, { jsonrpc: "2.0", id: "c:34", error: { code: -1, message } })],
      pending,
    );
    expect(failed.controlError?.message).toHaveLength(1_000);
  });
});

describe("reduceRecord — session telemetry and compaction", () => {
  test("usage updates replace cumulative values instead of summing them", () => {
    const t = reduce([
      upd(1, { sessionUpdate: "usage_update", used: 10, size: 100 }),
      upd(2, {
        sessionUpdate: "usage_update",
        used: 12,
        size: 100,
        cost: { amount: 0.25, currency: "USD" },
      }),
    ]);
    expect(t.usage).toEqual({ used: 12, size: 100, cost: { amount: 0.25, currency: "USD" } });
  });

  test("session info applies partial updates and explicit null clears", () => {
    const t = reduce([
      upd(1, { sessionUpdate: "session_info_update", title: "First", updatedAt: "2026-09-05T10:00:00Z" }),
      upd(2, { sessionUpdate: "session_info_update", title: null }),
    ]);
    expect(t.sessionInfo).toEqual({ title: null, updatedAt: "2026-09-05T10:00:00Z" });
  });

  test("compaction updates upsert by id and summary chunks append without mutation", () => {
    const t = reduce([
      upd(1, { sessionUpdate: "compaction_update", compactionId: "cmp-1", status: "in_progress" }),
      upd(2, { sessionUpdate: "compaction_summary_chunk", compactionId: "cmp-1", content: text("first") }),
      upd(3, {
        sessionUpdate: "compaction_update",
        compactionId: "cmp-2",
        status: "failed",
        error: "too large",
      }),
      upd(4, { sessionUpdate: "compaction_update", compactionId: "cmp-1", status: "completed" }),
    ]);
    expect(t.compaction).toEqual([
      { compactionId: "cmp-1", status: "completed", summary: [{ type: "text", text: "first" }], error: null },
      { compactionId: "cmp-2", status: "failed", summary: [], error: "too large" },
    ]);
  });
});

describe("reduceRecord — turn end (semantic 8)", () => {
  test("a response matching the open turn ends it and clears running", () => {
    const t = reduce([out(2, { jsonrpc: "2.0", id: "c:1", result: { stopReason: "end_turn" } })], withOpenTurn());
    expect(t.turns[0]?.end).toBe("end_turn");
    expect(t.turns[0]?.error).toBeUndefined();
    expect(t.running).toBe(false);
  });

  test("an error response ends the turn as \"error\" with its message", () => {
    const t = reduce(
      [out(2, { jsonrpc: "2.0", id: "c:1", error: { code: -32000, message: "adapter died" } })],
      withOpenTurn(),
    );
    expect(t.turns[0]?.end).toBe("error");
    expect(t.turns[0]?.error).toBe("adapter died");
    expect(t.running).toBe(false);
  });

  test("an ACP auth-required prompt response records an authentication block", () => {
    const t = reduce(
      [out(2, { jsonrpc: "2.0", id: "c:1", error: { code: -32000, message: "Authentication required" } })],
      withOpenTurn(),
    );
    expect(t.authRequired).toEqual({ requestId: "c:1", prompt: [{ type: "text", text: "hi" }] });
  });

  test("authentication words in a non-auth error do not create an authentication block", () => {
    const t = reduce(
      [out(2, { jsonrpc: "2.0", id: "c:1", error: { code: -32603, message: "User said authentication required" } })],
      withOpenTurn(),
    );
    expect(t.authRequired).toBeNull();
  });

  test("a cancelled prompt ends the turn with stopReason cancelled", () => {
    const t = reduce(
      [
        inn(2, cancelNotification("s1")),
        out(3, { jsonrpc: "2.0", id: "c:1", result: { stopReason: "cancelled" } }),
      ],
      withOpenTurn(),
    );
    expect(t.turns[0]?.end).toBe("cancelled");
    expect(t.running).toBe(false);
  });

  test("a turn the server closed as interrupted keeps the flag; a plain cancel does not get it", () => {
    const t = reduce(
      [out(3, { jsonrpc: "2.0", id: "c:1", result: { stopReason: "cancelled", _meta: { cube: { interrupted: true, messageUnavailable: true } } } })],
      withOpenTurn(),
    );
    expect(t.turns[0]).toMatchObject({ end: "cancelled", interrupted: true });
    const plain = reduce([out(3, { jsonrpc: "2.0", id: "c:1", result: { stopReason: "cancelled" } })], withOpenTurn());
    expect(plain.turns[0]?.interrupted).toBeUndefined();
  });

  test("a prompt response preserves optional per-turn usage", () => {
    const usage = { totalTokens: 7, inputTokens: 4, outputTokens: 3 };
    const t = reduce(
      [out(2, { jsonrpc: "2.0", id: "c:1", result: { stopReason: "end_turn", usage } })],
      withOpenTurn(),
    );
    expect(t.turns[0]?.usage).toEqual(usage);
  });
});

describe("reduceRecord — permissions (semantic 9)", () => {
  const request = {
    jsonrpc: "2.0" as const,
    id: "d:7",
    method: "session/request_permission",
    params: {
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "Write file" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  };

  for (const answeredBy of [null, "c-1"]) {
    test(`keeps the selected option and attribution for ${answeredBy ?? "human"} through turn end and replay`, () => {
      const response = { jsonrpc: "2.0" as const, id: 0, result: {
        outcome: { outcome: "selected", optionId: "allow" },
        ...(answeredBy === null ? {} : { _meta: { cube: { answeredBy } } }),
      } };
      const records = [out(2, { ...request, id: 0 }), inn(3, response), inn(4, response),
        out(5, { jsonrpc: "2.0" as const, id: "c:1", result: { stopReason: "end_turn" } })];
      const t = reduce(records, withOpenTurn());
      expect(t.pending).toEqual([]);
      expect(t.decisions).toEqual([{ requestId: 0, optionId: "allow", answeredBy, toolTitle: "Write file" }]);
      expect(reduce(records, t).decisions).toEqual(t.decisions);
    });
  }

  test("cancelled and unrelated responses do not invent a selected option", () => {
    expect(reduce([out(2, request), inn(3, permissionResponse("d:7", null))], withOpenTurn()).decisions).toEqual([]);
    expect(reduce([inn(2, permissionResponse("missing", "allow"))], withOpenTurn()).decisions).toEqual([]);
  });

  test("an `out` session/request_permission pushes to pending", () => {
    const t = reduce([out(2, request)], withOpenTurn());
    expect(t.pending).toHaveLength(1);
    expect(t.pending[0]?.requestId).toBe("d:7");
    expect(t.pending[0]?.toolCall).toEqual({ toolCallId: "t1", title: "Write file" });
    expect(t.pending[0]?.options).toHaveLength(2);
  });

  test("permission IDs preserve numeric zero and distinguish the same string on replay", () => {
    const records = [out(2, { ...request, id: 0 }), out(3, { ...request, id: "0" }),
      out(4, { ...request, id: 0 }), inn(5, permissionResponse("0", "reject"))];
    const t = reduce(records, withOpenTurn());
    expect(t.pending.map((p) => p.requestId)).toEqual([0]);
    for (const option of ["allow", "reject", null]) {
      const response = permissionResponse(t.pending[0]!.requestId, option);
      expect(response.id).toBe(0);
      expect(response.result).toEqual({ outcome: option === null
        ? { outcome: "cancelled" } : { outcome: "selected", optionId: option } });
      expect(reduce([...records, inn(6, response)], withOpenTurn()).pending).toEqual([]);
    }
  });

  test("the client's `in` response with that id removes it from pending", () => {
    const t = reduce(
      [out(2, request), inn(3, permissionResponse("d:7", "allow"))],
      withOpenTurn(),
    );
    expect(t.pending).toEqual([]);
  });

  test("a response for a different id leaves pending alone", () => {
    const t = reduce([out(2, request), inn(3, permissionResponse("d:9", "allow"))], withOpenTurn());
    expect(t.pending).toHaveLength(1);
  });

  test("ending the turn clears every pending permission — nobody is waiting any more", () => {
    const t = reduce(
      [out(2, request), out(3, { jsonrpc: "2.0", id: "c:1", result: { stopReason: "cancelled" } })],
      withOpenTurn(),
    );
    expect(t.pending).toEqual([]);
    expect(t.turns[0]?.end).toBe("cancelled");
  });

  test("an errored turn clears them too", () => {
    const t = reduce(
      [out(2, request), out(3, { jsonrpc: "2.0", id: "c:1", error: { code: -1, message: "died" } })],
      withOpenTurn(),
    );
    expect(t.pending).toEqual([]);
  });
});

describe("reduceRecord — malformed updates", () => {
  test("a chunk with no content block is a no-op that still advances seq", () => {
    const before = withOpenTurn();
    const user = reduceRecord(before, upd(2, { sessionUpdate: "user_message_chunk" }));
    const agent = reduceRecord(before, upd(3, { sessionUpdate: "agent_message_chunk", content: null }));
    expect(user.turns).toEqual(before.turns);
    expect(user.seq).toBe(2);
    expect(agent.turns).toEqual(before.turns);
    expect(agent.seq).toBe(3);
  });

  test("a tool call with no toolCallId is a no-op that still advances seq", () => {
    const before = withOpenTurn();
    const t = reduceRecord(before, upd(2, { sessionUpdate: "tool_call", title: "nameless" }));
    expect(t.turns).toEqual(before.turns);
    expect(t.seq).toBe(2);
  });
});

describe("reduceRecord — cancel (semantic 10)", () => {
  test("an `in` session/cancel changes nothing but the cursor", () => {
    const before = withOpenTurn();
    const t = reduceRecord(before, inn(2, cancelNotification("s1")));
    expect(t.turns).toEqual(before.turns);
    expect(t.running).toBe(true);
    expect(t.seq).toBe(2);
  });
});

describe("reduceRecord — cursor (semantic 11)", () => {
  test("every applied record advances seq", () => {
    const t = reduce([upd(5, { sessionUpdate: "current_mode_update", currentModeId: "m" })]);
    expect(t.seq).toBe(5);
  });

  test("a record at or below the cursor is ignored", () => {
    const base = reduce([upd(5, { sessionUpdate: "agent_message_chunk", content: text("a") })]);
    const dup = reduceRecord(base, upd(5, { sessionUpdate: "agent_message_chunk", content: text("a") }));
    const old = reduceRecord(dup, upd(4, { sessionUpdate: "agent_message_chunk", content: text("a") }));
    expect(old).toBe(base);
    expect(old.turns[0]?.blocks).toEqual([{ kind: "text", text: "a" }]);
  });

  test("an unknown session/update variant is a no-op that still advances seq", () => {
    const before = withOpenTurn();
    const t = reduceRecord(before, upd(2, { sessionUpdate: "future_update", value: 10 }));
    expect(t.turns).toEqual(before.turns);
    expect(t.seq).toBe(2);
  });

  test("an unknown method is a no-op that still advances seq", () => {
    const t = reduceRecord(EMPTY_TRANSCRIPT, out(3, { jsonrpc: "2.0", method: "_auth/status_update", params: {} }));
    expect(t).toEqual({ ...EMPTY_TRANSCRIPT, seq: 3 });
  });

  test("reduceRecords with reset restarts from EMPTY_TRANSCRIPT", () => {
    const before = reduce([
      inn(1, promptRequest("c:1", "s1", [{ type: "text", text: "hi" }])),
      upd(2, { sessionUpdate: "agent_message_chunk", content: text("a") }),
    ]);
    const t = reduceRecords(before, [upd(1, { sessionUpdate: "current_mode_update", currentModeId: "m" })], true);
    expect(t.turns).toEqual([]);
    expect(t.running).toBe(false);
    expect(t.modes.current).toBe("m");
    expect(t.seq).toBe(1);
  });
});

describe("reduceRecord — purity", () => {
  test("the input transcript is never mutated", () => {
    const before = withOpenTurn();
    const snapshot = structuredClone(before);
    reduceRecord(before, upd(2, { sessionUpdate: "agent_message_chunk", content: text("a") }));
    reduceRecord(before, upd(3, { sessionUpdate: "tool_call", toolCallId: "t", title: "T" }));
    reduceRecord(before, out(4, { jsonrpc: "2.0", id: "c:1", result: { stopReason: "end_turn" } }));
    expect(before).toEqual(snapshot);
  });

  test("the same records reduce to the same transcript twice (no clock, no randomness)", () => {
    const records = [
      inn(1, promptRequest("c:1", "s1", [{ type: "text", text: "hi" }])),
      upd(2, { sessionUpdate: "agent_message_chunk", content: text("a") }),
      out(3, { jsonrpc: "2.0", id: "c:1", result: { stopReason: "end_turn" } }),
      upd(4, { sessionUpdate: "user_message_chunk", content: text("again") }),
    ];
    expect(reduce(records)).toEqual(reduce(records));
  });
});

describe("message builders", () => {
  test("promptRequest", () => {
    expect(promptRequest("c:1", "s1", [{ type: "text", text: "hi" }])).toEqual({
      jsonrpc: "2.0",
      id: "c:1",
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] },
    });
  });

  test("permissionResponse builds the nested outcome shape", () => {
    expect(permissionResponse("d:7", "allow")).toEqual({
      jsonrpc: "2.0",
      id: "d:7",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    expect(permissionResponse("d:7", null)).toEqual({
      jsonrpc: "2.0",
      id: "d:7",
      result: { outcome: { outcome: "cancelled" } },
    });
  });

  test("cancelNotification carries no id", () => {
    const message = cancelNotification("s1");
    expect(message).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
    expect("id" in message).toBe(false);
  });

  test("setModeRequest", () => {
    expect(setModeRequest("c:2", "s1", "accept-edits")).toEqual({
      jsonrpc: "2.0",
      id: "c:2",
      method: "session/set_mode",
      params: { sessionId: "s1", modeId: "accept-edits" },
    });
  });
});

// -- recorded fixtures ----------------------------------------------------
//
// The three real adapter recordings (fixtures/README.md). Each is one
// prompt turn in one process followed by a `session/load` replay in a
// second process, so each reduces to two turns: the prompt's own, and the
// replay's synthetic one. The driver's integer request ids are deliberately
// not the shape the server emits — the reducer must key off content, not id
// shape.

const FIXTURE_DIR = join(import.meta.dirname, "fixtures");

function loadFixture(name: string): AgentRecord[] {
  const lines = readFileSync(join(FIXTURE_DIR, `${name}.ndjson`), "utf8").split("\n");
  const records: AgentRecord[] = [];
  let seq = 0;
  for (const line of lines) {
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const dir = line.slice(0, space);
    if (dir !== "in" && dir !== "out") continue; // meta/err are the driver's own commentary
    records.push({ dir, seq: ++seq, message: JSON.parse(line.slice(space + 1)) as JsonRpcMessage });
  }
  return records;
}

describe("recorded adapter fixtures", () => {
  const expectedConfigIds = {
    claude: ["mode", "model", "effort", "agent"],
    codex: ["mode", "collaboration_mode", "model", "reasoning_effort", "fast-mode"],
    opencode: ["model", "mode"],
  } as const;

  for (const name of ["claude", "codex", "opencode"] as const) {
    test(`${name} preserves its advertised controls and settles its replay`, () => {
      const records = loadFixture(name);
      expect(records.length).toBeGreaterThan(10);
      const t = reduceRecords(EMPTY_TRANSCRIPT, records, true);

      expect(t.turns).toHaveLength(2);
      expect(t.running).toBe(false);
      expect(t.handshakeError).toBeNull();
      expect(t.loadSession).toBe(true);
      expect(t.acpSessionId).not.toBeNull();
      expect(t.pending).toEqual([]);
      expect(t.seq).toBe(records[records.length - 1]?.seq ?? -1);
      expect(t.configOptions.map((option) => option.id)).toEqual([...expectedConfigIds[name]]);
      expect(t.agentInfo?.name).toBeTruthy();
      expect(t.promptCapabilities).not.toBeNull();
      expect(t.cwd).toContain(`/tmp/acp-spike-${name}-`);

      // Turn 1 is the prompt: the driver's text, an answered tool call, an answer.
      const prompt = t.turns[0];
      expect(prompt?.end).toBe("end_turn");
      expect(prompt?.user[0]).toMatchObject({ type: "text" });
      const tool = prompt?.blocks.find((b) => b.kind === "tool");
      expect(tool?.kind === "tool" && tool.call.status).toBe("completed");
      expect(tool?.kind === "tool" && tool.call.kind).toBe("read");
      const answer = prompt?.blocks.find((b) => b.kind === "text");
      expect(answer?.kind === "text" && answer.text).toContain("first line is the password");

      // Turn 2 is session/load's replay, opened synthetically because the
      // prompt turn had already ended.
      const replay = t.turns[1];
      expect(replay?.id).toBe("replay-1");
      expect(replay?.user).not.toEqual([]);
      expect(replay?.blocks.some((b) => b.kind === "tool")).toBe(true);
      expect(replay?.end).toBeNull();

      // Every adapter announces its slash commands at least once.
      expect(t.commands.length).toBeGreaterThan(0);
      expect(t.usage?.used).toBeGreaterThan(0);
    });
  }

  test("a fixture replayed twice (a reset re-open) lands on the same transcript", () => {
    const records = loadFixture("opencode");
    const once = reduceRecords(EMPTY_TRANSCRIPT, records, true);
    const twice = reduceRecords(once, records, true);
    expect(twice).toEqual(once);
  });
});

test("a wake prompt is marked machine-originated, and an ordinary prompt is not", () => {
  const wake = reduceRecord(EMPTY_TRANSCRIPT, inn(1, {
    jsonrpc: "2.0", id: "d:9", method: "session/prompt",
    params: { sessionId: "s", prompt: [{ type: "text", text: "agent a-1 finished" }],
      _meta: { cube: { report: true, reportIds: ["r-1"] } } },
  }));
  expect(wake.turns.at(-1)!.origin).toBe("report");
  const typed = reduceRecord(EMPTY_TRANSCRIPT, inn(2, {
    jsonrpc: "2.0", id: "u:1", method: "session/prompt",
    params: { sessionId: "s", prompt: [{ type: "text", text: "hello" }] },
  }));
  expect(typed.turns.at(-1)!.origin).toBeUndefined();
});
test("a check-in prompt is marked machine-originated like a wake", () => {
  const checkIn = reduceRecord(EMPTY_TRANSCRIPT, inn(1, {
    jsonrpc: "2.0", id: "check-in:1", method: "session/prompt",
    params: { sessionId: "s", prompt: [{ type: "text", text: "How are your workers doing?" }],
      _meta: { cube: { checkIn: true } } },
  }));
  expect(checkIn.turns.at(-1)!.origin).toBe("report");
});
test("a turn records the seq of the request that opened it", () => {
  const record = inn(42, promptRequest("u1", "s", [{ type: "text", text: "hi" }]));
  const t = reduceRecord(EMPTY_TRANSCRIPT, record);
  expect(t.turns[0]?.startSeq).toBe(42);
  expect(reduceRecord(t, out(43, {
    jsonrpc: "2.0", id: "u1", result: { stopReason: "end_turn" },
  })).turns[0]?.startSeq).toBe(42);
  expect(EMPTY_TRANSCRIPT.turns).toEqual([]);
});
