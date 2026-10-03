// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentRecord, JsonRpcMessage } from "../../src/shared/agent-protocol";
import { BUSY_MARKER } from "../../src/shared/agent-protocol";
import type { Persona, PersonaState, Worker } from "../../src/shared/types";
import type { EventMap, EventName, Verb, VerbArgs, VerbResult } from "../../src/shared/wire";
import { setApi, type Api, type ApiStatus } from "../../src/web/api";
import { Conversation } from "../../src/web/agent/Conversation";
import { resetTranscriptStore } from "../../src/web/agent/transcript-store";
import { resetPromptQueueStore } from "../../src/web/agent/prompt-queue";
import { resetComposerDraftStore } from "../../src/web/agent/composer-state";
import { resetPersonasStore } from "../../src/web/stores/personas";
import { resetWorkersStore } from "../../src/web/stores/workers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// -- a fake connection ------------------------------------------------------

type Handler<V extends Verb> = (args: VerbArgs<V>) => VerbResult<V> | Promise<VerbResult<V>>;

class FakeApi implements Api {
  readonly calls: Array<{ verb: Verb; args: unknown }> = [];
  private readonly handlers = new Map<Verb, (args: unknown) => unknown>();
  private readonly listeners = new Map<EventName, Set<(payload: never) => void>>();
  private readonly reconnects = new Set<() => void>();

  handle<V extends Verb>(verb: V, handler: Handler<V>): void {
    this.handlers.set(verb, handler as (args: unknown) => unknown);
  }

  sends(): JsonRpcMessage[] {
    return this.calls.filter((call) => call.verb === "persona:send")
      .map((call) => (call.args as VerbArgs<"persona:send">).message);
  }

  async request<V extends Verb>(verb: V, args: VerbArgs<V>): Promise<VerbResult<V>> {
    this.calls.push({ verb, args });
    const handler = this.handlers.get(verb);
    if (!handler) throw new Error(`no fake handler for ${verb}`);
    return await handler(args) as VerbResult<V>;
  }

  on<E extends EventName>(name: E, cb: (payload: EventMap[E]) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) { set = new Set(); this.listeners.set(name, set); }
    set.add(cb as (payload: never) => void);
    return () => { set.delete(cb as (payload: never) => void); };
  }

  emit<E extends EventName>(name: E, payload: EventMap[E]): void {
    for (const cb of [...(this.listeners.get(name) ?? [])]) (cb as (payload: EventMap[E]) => void)(payload);
  }

  reconnect(): void {
    for (const cb of [...this.reconnects]) cb();
  }

  status(): ApiStatus { return "open"; }
  onStatus(): () => void { return () => {}; }
  onReconnect(cb: () => void): () => void {
    this.reconnects.add(cb);
    return () => { this.reconnects.delete(cb); };
  }
  close(): void {}
}

// -- records ----------------------------------------------------------------

let seq = 0;
const inn = (message: JsonRpcMessage): AgentRecord => ({ dir: "in", seq: ++seq, message });
const out = (message: JsonRpcMessage): AgentRecord => ({ dir: "out", seq: ++seq, message });

function handshake(): AgentRecord[] {
  return [
    inn({ jsonrpc: "2.0", id: "d:1", method: "initialize", params: { protocolVersion: 1, clientCapabilities: { terminal: false } } }),
    out({ jsonrpc: "2.0", id: "d:1", result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } } }),
    inn({ jsonrpc: "2.0", id: "d:2", method: "session/new", params: { cwd: "/home/u/.cube/personas/p1", mcpServers: [] } }),
    out({ jsonrpc: "2.0", id: "d:2", result: { sessionId: "acp-1" } }),
  ];
}

function prompt(id: string, text: string, meta?: Record<string, unknown>): AgentRecord {
  return inn({
    jsonrpc: "2.0", id, method: "session/prompt",
    params: { sessionId: "acp-1", prompt: [{ type: "text", text }], ...(meta ? { _meta: meta } : {}) },
  });
}

function chunk(text: string): AgentRecord {
  return out({
    jsonrpc: "2.0", method: "session/update",
    params: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });
}

function ended(id: string): AgentRecord {
  return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

const PERSONA: Persona = {
  id: "p1", name: "Ada", harness: "claude", createdAt: "t", acpSessionId: "acp-1", launchId: "l1",
  pid: 10, cmdline: "adapter", state: "ready", unread: false,
};

// -- harness ----------------------------------------------------------------

let api: FakeApi;
let container: HTMLDivElement;
let root: Root;

function setUp(records: AgentRecord[], state: PersonaState, activePrompt: string | null = null): void {
  api.handle("personas:list", () => [{ ...PERSONA, state }]);
  api.handle("workers:list", () => [] as Worker[]);
  api.handle("persona:open", ({ sinceSeq }) => {
    const after = records.filter((record) => record.seq > (sinceSeq ?? 0));
    return { records: after, startSeq: sinceSeq ?? 0, seq: records.at(-1)?.seq ?? 0, state, activePrompt };
  });
  api.handle("persona:send", () => null);
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(): Promise<void> {
  await act(async () => { root.render(<Conversation personaId="p1" />); });
  await flush();
}

async function emit<E extends EventName>(name: E, payload: EventMap[E]): Promise<void> {
  await act(async () => { api.emit(name, payload); });
  await flush();
}

function type(value: string): void {
  const input = container.querySelector<HTMLTextAreaElement>("textarea.agent-composer-input");
  if (!input) throw new Error("composer textarea missing");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter(): Promise<void> {
  const input = container.querySelector<HTMLTextAreaElement>("textarea.agent-composer-input")!;
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await flush();
}

function promptTexts(): string[] {
  return api.sends().flatMap((message) => {
    if (!("method" in message) || message.method !== "session/prompt") return [];
    const blocks = (message.params as { prompt: Array<{ type: string; text?: string }> }).prompt;
    return blocks.map((block) => block.text ?? "");
  });
}

beforeEach(() => {
  seq = 0;
  api = new FakeApi();
  setApi(api);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setApi(null);
  resetTranscriptStore();
  resetPromptQueueStore();
  resetComposerDraftStore();
  resetPersonasStore();
  resetWorkersStore();
  document.documentElement.classList.remove("dark");
  window.history.replaceState(null, "", "/");
});

// -- tests ------------------------------------------------------------------

test("records replayed by persona:open render as turns", async () => {
  setUp([...handshake(), prompt("u:1", "What is on the board?"), chunk("Two workers are building."), ended("u:1")], "ready");
  await mount();

  expect(api.calls.find((call) => call.verb === "persona:open")?.args).toEqual({ id: "p1" });
  expect(container.querySelector("[aria-label='User message']")?.textContent).toContain("What is on the board?");
  expect(container.querySelector("[aria-label='Assistant message']")?.textContent).toContain("Two workers are building.");
});

test("a live persona:frame with an agent_message_chunk appends text to the turn", async () => {
  const records = [...handshake(), prompt("u:1", "Status?")];
  setUp(records, "busy", "u:1");
  await mount();
  expect(container.querySelector("[aria-label='Typing']")).not.toBeNull();

  await emit("persona:frame", { id: "p1", record: chunk("All quiet. ") });
  await emit("persona:frame", { id: "p1", record: chunk("Nothing running.") });
  await emit("persona:frame", { id: "p1", record: ended("u:1") });
  await emit("persona:state", { id: "p1", state: "ready", activePrompt: null });

  expect(container.querySelector("[aria-label='Assistant message']")?.textContent).toContain("All quiet. Nothing running.");
  expect(container.querySelector("[aria-label='Typing']")).toBeNull();
});

test("a frame for another persona is ignored", async () => {
  setUp([...handshake(), prompt("u:1", "Hi"), ended("u:1")], "ready");
  await mount();
  await emit("persona:frame", { id: "p2", record: { ...chunk("not mine"), seq: 99 } });
  expect(container.textContent).not.toContain("not mine");
});

test("a reconnect reopens from the last record held", async () => {
  const records = [...handshake(), prompt("u:1", "Hi"), ended("u:1")];
  setUp(records, "ready");
  await mount();
  records.push(prompt("u:2", "Missed while away"), chunk("Caught up."), ended("u:2"));
  await act(async () => { api.reconnect(); });
  await flush();

  const opens = api.calls.filter((call) => call.verb === "persona:open").map((call) => call.args);
  expect(opens).toEqual([{ id: "p1" }, { id: "p1", sinceSeq: 6 }]);
  expect(container.textContent).toContain("Missed while away");
  expect(container.textContent).toContain("Caught up.");
});

test("a reconnect whose cursor is older than the server's window replaces the transcript", async () => {
  const records = [...handshake(), prompt("u:1", "Long ago"), ended("u:1")];
  setUp(records, "ready");
  await mount();
  // Far more happened while away than the server keeps in memory: it sends its window, starting later.
  seq = 500;
  const windowed = [prompt("u:9", "Recent question"), chunk("Recent answer."), ended("u:9")];
  api.handle("persona:open", () => ({ records: windowed, startSeq: 500, seq: 503, state: "ready" as PersonaState, activePrompt: null }));
  await act(async () => { api.reconnect(); });
  await flush();

  expect(container.textContent).not.toContain("Long ago");
  expect(container.textContent).toContain("Recent answer.");
});

test("a server log that restarted below the page's cursor is read again from the start", async () => {
  const records = [...handshake(), prompt("u:1", "Before the reset"), chunk("Old answer."), ended("u:1")];
  setUp(records, "ready");
  await mount();
  seq = 0;
  const fresh = [...handshake(), prompt("u:1", "After the reset"), ended("u:1")];
  api.handle("persona:open", ({ sinceSeq }) => ({
    records: fresh.filter((r) => r.seq > (sinceSeq ?? 0)), startSeq: sinceSeq ?? 0, seq: fresh.length,
    state: "ready" as PersonaState, activePrompt: null,
  }));
  await act(async () => { api.reconnect(); });
  await flush();

  const opens = api.calls.filter((call) => call.verb === "persona:open").map((call) => call.args);
  expect(opens).toEqual([{ id: "p1" }, { id: "p1", sinceSeq: 7 }, { id: "p1" }]);
  expect(container.textContent).not.toContain("Before the reset");
  expect(container.textContent).toContain("After the reset");
  await emit("persona:frame", { id: "p1", record: prompt("u:2", "Live again.") });
  expect(container.textContent).toContain("Live again.");
});

test("a prompt sent while the persona is busy is queued and sent once persona:state is ready", async () => {
  const records = [...handshake(), prompt("d:3", "Worker reports. Acknowledge.\n{\"reports\":[]}", { cube: { report: true } })];
  setUp(records, "busy", "d:3");
  await mount();

  type("And then deploy it");
  await pressEnter();
  expect(promptTexts()).toEqual([]);
  expect(container.querySelector(".agent-queue")?.textContent).toContain("1 queued message");
  expect(container.querySelector(".agent-queue-label")?.textContent).toBe("And then deploy it");

  await emit("persona:frame", { id: "p1", record: ended("d:3") });
  expect(promptTexts()).toEqual([]);
  await emit("persona:state", { id: "p1", state: "ready", activePrompt: null });

  expect(promptTexts()).toEqual(["And then deploy it"]);
  expect(container.querySelector("textarea.agent-composer-input")?.textContent ?? "").toBe("");
});

test("a send refused as busy stays queued and goes out when persona:state is ready", async () => {
  setUp([...handshake(), prompt("u:1", "Hi"), ended("u:1")], "ready");
  let refuse = true;
  api.handle("persona:send", () => {
    if (refuse) throw new Error(`${BUSY_MARKER}: busy`);
    return null;
  });
  await mount();

  type("Ship it");
  await pressEnter();
  expect(promptTexts()).toEqual(["Ship it"]);
  expect(container.querySelector(".agent-queue-label")?.textContent).toBe("Ship it");
  expect(container.querySelector("[role='alert']")).toBeNull();
  expect(container.querySelector<HTMLTextAreaElement>("textarea.agent-composer-input")!.value).toBe("");

  refuse = false;
  await emit("persona:state", { id: "p1", state: "busy", activePrompt: "d:4" });
  await emit("persona:state", { id: "p1", state: "ready", activePrompt: null });

  expect(promptTexts()).toEqual(["Ship it", "Ship it"]);
  expect(container.querySelector(".agent-queue")).toBeNull();
});

test("a turn with _meta.cube.report shows a Cube report, not the user's bubble", async () => {
  const report = "Worker reports. Acknowledge received reportId values with ack on your next tool call.\n"
    + "- build finished\n"
    + JSON.stringify({ reports: [{ reportId: "r1", agentId: "w1", kind: "ended", text: "done: tests pass", title: "build" }] });
  setUp([...handshake(), prompt("d:3", report, { cube: { report: true, reportIds: ["r1"] } }), chunk("Noted."), ended("d:3")], "ready");
  await mount();

  expect(container.querySelector("[aria-label='Cube report']")?.textContent).toContain("Cube report");
  expect(container.textContent).toContain("build reported — done: tests pass");
  expect(container.querySelector("[aria-label='User message']")).toBeNull();
});

test("a permission request renders a card whose click sends one response", async () => {
  const records = [
    ...handshake(),
    prompt("u:1", "Delete the branch"),
    out({
      jsonrpc: "2.0", id: "a:1", method: "session/request_permission",
      params: {
        sessionId: "acp-1",
        toolCall: { toolCallId: "t1", title: "git branch -D old", kind: "execute", status: "pending" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    }),
  ];
  setUp(records, "busy", "u:1");
  await mount();

  const allow = container.querySelector<HTMLButtonElement>(".agent-permission-allow");
  expect(allow).not.toBeNull();
  await act(async () => { allow!.click(); });
  await flush();
  await act(async () => { allow!.click(); });
  await flush();

  expect(api.sends()).toEqual([
    { jsonrpc: "2.0", id: "a:1", result: { outcome: { outcome: "selected", optionId: "allow" } } },
  ]);
});

test("the theme attribute follows ?theme=dark", async () => {
  window.history.replaceState(null, "", "/?theme=dark");
  setUp([...handshake()], "ready");
  await mount();
  expect(document.documentElement.classList.contains("dark")).toBe(true);

  act(() => root.unmount());
  root = createRoot(container);
  window.history.replaceState(null, "", "/?theme=light");
  await mount();
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});
