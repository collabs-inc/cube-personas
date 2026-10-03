import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PersonaSession, type SessionLaunch } from "../../src/server/acp/session";
import { ProcessManager } from "../../src/server/processes";
import { RecordLog } from "../../src/server/record-log";
import {
  BUSY_MARKER, isNotification, isRequest, isResponse, type AgentRecord, type JsonRpcMessage, type JsonRpcRequest,
} from "../../src/shared/agent-protocol";
import type { PersonaState } from "../../src/shared/types";

const FAKE_AGENT = fileURLToPath(new URL("../fixtures/fake-agent.mjs", import.meta.url));

interface Harnessed {
  session: PersonaSession;
  log: RecordLog;
  frames: AgentRecord[];
  states: Array<{ state: PersonaState; activePrompt: string | null }>;
  sessionIds: string[];
  exits: Array<{ code: number | null; stderrTail: string }>;
}

let tmp: string;
let workdir: string;
let processes: ProcessManager;
let sessions: PersonaSession[];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "acp-session-"));
  workdir = join(tmp, "work");
  await import("node:fs/promises").then((fs) => fs.mkdir(workdir));
  processes = new ProcessManager();
  sessions = [];
});

afterEach(async () => {
  for (const s of sessions) await s.stop();
  await processes.killAll();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

function launch(overrides: Partial<SessionLaunch> = {}, env: NodeJS.ProcessEnv = {}): SessionLaunch {
  return {
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: workdir,
    env: { PATH: process.env.PATH, HOME: tmp, ...env },
    harness: "claude",
    resumeSessionId: null,
    mcpServer: { url: "http://127.0.0.1:4870/mcp?persona=p-1", ticket: "t1cket" },
    systemPromptAppend: "You are a persona.",
    codexDeveloperInstructions: "You are a codex persona.",
    ...overrides,
  };
}

async function make(): Promise<Harnessed> {
  const log = new RecordLog(join(tmp, "log"));
  await log.open();
  const h: Harnessed = { session: undefined as never, log, frames: [], states: [], sessionIds: [], exits: [] };
  h.session = new PersonaSession(log, processes, {
    frame: (record) => h.frames.push(record),
    state: (state, activePrompt) => h.states.push({ state, activePrompt }),
    sessionId: (id) => { h.sessionIds.push(id); },
    exited: (code, stderrTail) => h.exits.push({ code, stderrTail }),
  });
  sessions.push(h.session);
  return h;
}

async function started(overrides: Partial<SessionLaunch> = {}, env: NodeJS.ProcessEnv = {}): Promise<Harnessed> {
  const h = await make();
  await h.session.start(launch(overrides, env));
  return h;
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function pagePrompt(id: string, text: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0", id, method: "session/prompt",
    params: { sessionId: "fake-session-1", prompt: [{ type: "text", text }] },
  };
}

function sent(h: Harnessed, method: string): JsonRpcRequest & { params?: any } {
  const record = h.log.since(0).find((r) => r.dir === "in" && isRequest(r.message) && r.message.method === method);
  if (!record) throw new Error(`no ${method} was sent`);
  return record.message as never;
}

function chunks(h: Harnessed): string[] {
  return h.log.since(0).flatMap((r) => {
    const m = r.message;
    if (r.dir !== "out" || !isNotification(m) || m.method !== "session/update") return [];
    const update = (m.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update;
    return update?.sessionUpdate === "agent_message_chunk" ? [String(update.content?.text)] : [];
  });
}

const turnEnded = (h: Harnessed, id: string) =>
  h.log.since(0).some((r) => r.dir === "out" && isResponse(r.message) && r.message.id === id);

describe("PersonaSession", () => {
  test("start handshakes to ready and emits the new session id", async () => {
    const h = await started();
    expect(h.session.state()).toBe("ready");
    expect(h.session.activePrompt()).toBeNull();
    expect(h.sessionIds).toEqual(["fake-session-1"]);
    expect(h.states.map((s) => s.state)).toEqual(["starting", "ready"]);

    const init = sent(h, "initialize");
    expect(init.id).toBe("d:1");
    expect(init.params.clientCapabilities).toEqual({ fs: { readTextFile: true, writeTextFile: true }, terminal: false });
    const created = sent(h, "session/new");
    expect(created.params.cwd).toBe(workdir);
    // Claude receives the persona's text as an append to its preset, never a replacement.
    expect(created.params._meta).toEqual({ systemPrompt: { append: "You are a persona." } });
    expect(sent(h, "session/set_mode").params).toEqual({ sessionId: "fake-session-1", modeId: "bypassPermissions" });
  });

  test("every message in either direction is recorded and emitted as a frame, in order", async () => {
    const h = await started();
    await h.session.send(pagePrompt("u1:1", "hello"));
    await waitFor(() => h.session.state() === "ready" && turnEnded(h, "u1:1"));
    const records = h.log.since(0);
    expect(h.frames).toEqual(records);
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i + 1));
    // The server's requests are d:<n>.
    const ids = records.filter((r) => r.dir === "in" && isRequest(r.message)).map((r) => (r.message as { id: unknown }).id);
    expect(ids).toEqual(["d:1", "d:2", "d:3", "u1:1"]);
  });

  test("mcpServers carries the URL and the bearer ticket to the adapter, but never into the log or frames", async () => {
    const h = await started();
    // What was recorded.
    expect(sent(h, "session/new").params.mcpServers).toEqual([{
      type: "http", name: "personas", url: "http://127.0.0.1:4870/mcp?persona=p-1",
      headers: [{ name: "Authorization", value: "Bearer [redacted]" }],
    }]);
    expect(JSON.stringify(h.frames)).not.toContain("t1cket");
    expect(readFileSync(join(tmp, "log", "log.jsonl"), "utf8")).not.toContain("t1cket");
    // What the adapter received (the fake echoing it puts it in the log, so this comes last).
    await h.session.send(pagePrompt("u1:1", "mcp-config"));
    await waitFor(() => turnEnded(h, "u1:1"));
    expect(JSON.parse(chunks(h)[0]!)).toEqual({
      type: "http", name: "personas", url: "http://127.0.0.1:4870/mcp?persona=p-1",
      headers: [{ name: "Authorization", value: "Bearer t1cket" }],
    });
  });

  test("a resumed session's recorded session/load carries no ticket either", async () => {
    const h = await started({ resumeSessionId: "old-session" });
    expect(sent(h, "session/load").params.mcpServers[0].headers).toEqual([{ name: "Authorization", value: "Bearer [redacted]" }]);
    expect(JSON.stringify(h.frames)).not.toContain("t1cket");
    expect(readFileSync(join(tmp, "log", "log.jsonl"), "utf8")).not.toContain("t1cket");
  });

  test("mcpServers is empty, with one log line, when the adapter does not advertise HTTP MCP", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = await started({}, { FAKE_AGENT_NO_HTTP_MCP: "1" });
    expect(sent(h, "session/new").params.mcpServers).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain("t1cket");
    expect(h.session.state()).toBe("ready");
  });

  test("a prompt is accepted, recorded before its end_turn response, and moves busy → ready", async () => {
    const h = await started();
    await h.session.send(pagePrompt("u1:1", "hello"));
    await waitFor(() => turnEnded(h, "u1:1") && h.session.state() === "ready");
    const records = h.log.since(0);
    const promptAt = records.findIndex((r) => r.dir === "in" && isRequest(r.message) && r.message.id === "u1:1");
    const endAt = records.findIndex((r) => r.dir === "out" && isResponse(r.message) && r.message.id === "u1:1");
    expect(promptAt).toBeGreaterThan(-1);
    expect(endAt).toBeGreaterThan(promptAt);
    expect((records[endAt]!.message as { result: unknown }).result).toEqual({ stopReason: "end_turn" });
    expect(h.states.slice(-2)).toEqual([{ state: "busy", activePrompt: "u1:1" }, { state: "ready", activePrompt: null }]);
    expect(h.session.activePrompt()).toBeNull();
  });

  test("a second prompt while busy rejects with BUSY_MARKER, and a server prompt answers busy", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = await started();
    // `ask:` holds the turn open until someone answers.
    await h.session.send(pagePrompt("u1:1", "ask:Allow?"));
    expect(h.session.state()).toBe("busy");
    expect(h.session.activePrompt()).toBe("u1:1");
    await expect(h.session.send(pagePrompt("u1:2", "hello"))).rejects.toThrow(BUSY_MARKER);
    expect(await h.session.prompt([{ type: "text", text: "wake" }])).toBe("busy");
    // Neither reached the adapter or the log.
    expect(h.log.since(0).filter((r) => isRequest(r.message) && r.message.method === "session/prompt")).toHaveLength(1);
  });

  test("ask: emits a permission request and the first of two answers wins", async () => {
    const h = await started();
    await h.session.send(pagePrompt("u1:1", "ask:Allow?"));
    await waitFor(() => h.frames.some((f) => isRequest(f.message) && f.message.method === "session/request_permission"));
    const question = h.frames.find((f) => isRequest(f.message) && f.message.method === "session/request_permission")!;
    expect(question.dir).toBe("out");
    const id = (question.message as { id: string }).id;
    expect(id).toMatch(/^a:\d+$/);
    const answer = (optionId: string): JsonRpcMessage =>
      ({ jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId } } });
    await h.session.send(answer("allow"));
    await h.session.send(answer("deny"));
    await waitFor(() => turnEnded(h, "u1:1"));
    expect(chunks(h)).toEqual(["chose:allow"]);
    expect(h.log.since(0).filter((r) => r.dir === "in" && isResponse(r.message) && r.message.id === id)).toHaveLength(1);
  });

  test("session/cancel answers a pending permission cancelled, the turn ends, and a later answer is dropped", async () => {
    const h = await started();
    await h.session.send(pagePrompt("u1:1", "ask:Allow?"));
    await waitFor(() => h.frames.some((f) => isRequest(f.message) && f.message.method === "session/request_permission"));
    const id = (h.frames.find((f) => isRequest(f.message) && f.message.method === "session/request_permission")!.message as { id: string }).id;
    await h.session.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "fake-session-1" } });
    await waitFor(() => turnEnded(h, "u1:1") && h.session.state() === "ready");
    expect(chunks(h)).toEqual(["chose:cancelled"]);
    const before = h.log.seq();
    await h.session.send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId: "allow" } } });
    expect(h.log.seq()).toBe(before);
    const answers = h.log.since(0).filter((r) => r.dir === "in" && isResponse(r.message) && r.message.id === id);
    expect(answers.map((r) => r.message)).toEqual([{ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } }]);
  });

  test("a page message using the server's or the adapter's id namespace is refused", async () => {
    const h = await started();
    await expect(h.session.send(pagePrompt("d:9", "hello"))).rejects.toThrow("The page cannot use a d: or a: request id.");
    await expect(h.session.send(pagePrompt("a:9", "hello"))).rejects.toThrow("The page cannot use a d: or a: request id.");
    expect(h.session.state()).toBe("ready");
    expect(h.log.since(0).some((r) => isRequest(r.message) && r.message.method === "session/prompt")).toBe(false);
  });

  test("an answer to a question nobody asked is dropped", async () => {
    const h = await started();
    const before = h.log.seq();
    await h.session.send({ jsonrpc: "2.0", id: "a:99", result: { outcome: { outcome: "cancelled" } } });
    expect(h.log.seq()).toBe(before);
  });

  test("read:<file> is answered from disk", async () => {
    const file = join(workdir, "hello.txt");
    writeFileSync(file, "The first line is the password.\nSecond line.\n");
    const h = await started();
    await h.session.send(pagePrompt("u1:1", `read:${file}`));
    await waitFor(() => turnEnded(h, "u1:1"));
    expect(chunks(h)).toEqual(["The first line is the password.\nSecond line.\n"]);
    const reply = h.log.since(0).find((r) => r.dir === "in" && isResponse(r.message) && String(r.message.id).startsWith("a:"));
    expect(reply).toBeDefined();
  });

  test("a relative read is refused, and a terminal request is -32601", async () => {
    const h = await started();
    await h.session.send(pagePrompt("u1:1", "read:hello.txt"));
    await waitFor(() => turnEnded(h, "u1:1"));
    await h.session.send(pagePrompt("u1:2", "run:echo hi"));
    await waitFor(() => turnEnded(h, "u1:2"));
    expect(chunks(h)).toEqual(["error:path must be absolute", "error:unknown method terminal/create"]);
    const errors = h.log.since(0).flatMap((r) =>
      r.dir === "in" && isResponse(r.message) && r.message.error ? [r.message.error.code] : []);
    expect(errors).toEqual([-32000, -32601]);
  });

  test("session/cancel from the page reaches the adapter", async () => {
    const h = await started();
    await h.session.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "fake-session-1" } });
    expect(h.log.since(0).at(-1)).toMatchObject({ dir: "in", message: { method: "session/cancel" } });
  });

  test("other page messages are refused", async () => {
    const h = await started();
    await expect(h.session.send({ jsonrpc: "2.0", id: "u1:1", method: "session/new", params: {} })).rejects.toThrow();
  });

  test("a server prompt carries its _meta, is accepted, and is namespaced d:<n>", async () => {
    const h = await started();
    expect(await h.session.prompt([{ type: "text", text: "wake" }], { cube: { report: ["r1"] } })).toBe("accepted");
    expect(h.session.activePrompt()).toBe("d:4");
    const req = sent(h, "session/prompt");
    expect(req.id).toBe("d:4");
    expect(req.params).toEqual({
      sessionId: "fake-session-1", prompt: [{ type: "text", text: "wake" }], _meta: { cube: { report: ["r1"] } },
    });
    await waitFor(() => h.session.state() === "ready");
  });

  test("resuming over a log that already holds the conversation does not record the replay again", async () => {
    const updates = [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier question" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier answer" } },
    ];
    writeFileSync(join(workdir, ".fake-agent-replay.jsonl"), updates.map((u) => JSON.stringify(u)).join("\n") + "\n");
    const h = await make();
    // The earlier run's copy of the conversation.
    for (const update of updates) {
      h.log.append("out", { jsonrpc: "2.0", method: "session/update", params: { sessionId: "old-session", update } });
    }
    await h.session.start(launch({ resumeSessionId: "old-session" }));
    expect(h.session.state()).toBe("ready");
    const copies = (text: string) => h.log.since(0).filter((r) => JSON.stringify(r.message).includes(text)).length;
    expect(copies("earlier question")).toBe(1);
    expect(copies("earlier answer")).toBe(1);
    expect(JSON.stringify(h.frames)).not.toContain("earlier");
    // The load and its reply are recorded, and so is everything after it.
    const load = sent(h, "session/load");
    expect(h.log.since(0).some((r) => r.dir === "out" && isResponse(r.message) && r.message.id === load.id)).toBe(true);
    expect(h.log.since(0).some((r) => JSON.stringify(r.message).includes("current_mode_update"))).toBe(true);
    await h.session.send(pagePrompt("u1:1", "hello"));
    await waitFor(() => turnEnded(h, "u1:1"));
  });

  test("start with resumeSessionId sends session/load and, over an empty log, records the replay as frames", async () => {
    const updates = [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier question" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier answer" } },
    ];
    writeFileSync(join(workdir, ".fake-agent-replay.jsonl"), updates.map((u) => JSON.stringify(u)).join("\n") + "\n");
    const h = await started({ resumeSessionId: "old-session" });
    expect(h.session.state()).toBe("ready");
    expect(h.sessionIds).toEqual(["old-session"]);
    const load = sent(h, "session/load");
    expect(load.params).toMatchObject({ sessionId: "old-session", cwd: workdir });
    expect(h.log.since(0).some((r) => isRequest(r.message) && r.message.method === "session/new")).toBe(false);
    const replayed = h.frames.flatMap((f) =>
      isNotification(f.message) && f.message.method === "session/update"
        ? [(f.message.params as { update: unknown }).update] : []);
    expect(replayed.slice(0, 2)).toEqual(updates);
    const loadReplyAt = h.frames.findIndex((f) => isResponse(f.message) && f.message.id === load.id);
    const lastReplayAt = h.frames.findIndex((f) =>
      isNotification(f.message) && JSON.stringify(f.message).includes("earlier answer"));
    expect(lastReplayAt).toBeLessThan(loadReplyAt);
  });

  test("the adapter exiting emits exited with its stderr tail and state failed", async () => {
    const h = await started();
    await h.session.send(pagePrompt("u1:1", "crash:the adapter fell over"));
    await waitFor(() => h.exits.length > 0);
    expect(h.exits).toEqual([{ code: 3, stderrTail: "the adapter fell over\n" }]);
    expect(h.session.state()).toBe("failed");
    expect(h.session.activePrompt()).toBeNull();
    expect(h.states.at(-1)).toEqual({ state: "failed", activePrompt: null });
    await expect(h.session.send(pagePrompt("u1:2", "hello"))).rejects.toThrow(BUSY_MARKER);
    expect(await h.session.prompt([{ type: "text", text: "wake" }])).toBe("busy");
  });

  test("an adapter that cannot start fails start, with state failed", async () => {
    const h = await make();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(h.session.start(launch({ command: join(tmp, "missing-adapter") }))).rejects.toThrow();
    expect(h.session.state()).toBe("failed");
    expect(warn).toHaveBeenCalled();
  });

  test("stop ends the adapter, settles on stopped and reports no exit", async () => {
    const h = await started();
    await h.session.stop();
    expect(h.session.state()).toBe("stopped");
    expect(h.states.at(-1)).toEqual({ state: "stopped", activePrompt: null });
    expect(h.exits).toEqual([]);
  });

  test("a set_mode failure is logged and the session still becomes ready", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = await started({}, { FAKE_AGENT_REJECT_MODE: "1" });
    expect(h.session.state()).toBe("ready");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("bypassPermissions"))).toBe(true);
  });

  test("codex receives its instructions in CODEX_CONFIG, its own permissive mode, and no _meta", async () => {
    const h = await started({ harness: "codex" }, { CODEX_CONFIG: JSON.stringify({ model: "m" }) });
    expect("_meta" in sent(h, "session/new").params).toBe(false);
    expect(sent(h, "session/set_mode").params.modeId).toBe("agent-full-access");
    await h.session.send(pagePrompt("u1:1", "env:CODEX_CONFIG"));
    await waitFor(() => turnEnded(h, "u1:1"));
    expect(JSON.parse(chunks(h)[0]!)).toEqual({ model: "m", developer_instructions: "You are a codex persona." });
  });

  test("a claude adapter receives no CODEX_CONFIG", async () => {
    const h = await started();
    await h.session.send(pagePrompt("u1:1", "env:CODEX_CONFIG"));
    await waitFor(() => turnEnded(h, "u1:1"));
    expect(chunks(h)).toEqual([""]);
  });

  test("the record log on disk holds what was emitted", async () => {
    const h = await started();
    const lines = readFileSync(join(tmp, "log", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual(h.frames);
  });
});
