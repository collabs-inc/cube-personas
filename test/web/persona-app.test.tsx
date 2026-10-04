// @vitest-environment happy-dom
// @vitest-environment-options {"width": 1600, "settings": {"disableIframePageLoading": true}}
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentRecord, JsonRpcMessage } from "../../src/shared/agent-protocol";
import type { Persona, PersonaState, Worker, WorkspaceTree } from "../../src/shared/types";
import type { EventMap, EventName, Verb, VerbArgs, VerbResult } from "../../src/shared/wire";
import { setApi, type Api, type ApiStatus } from "../../src/web/api";
import { App } from "../../src/web/App";
import { Conversation } from "../../src/web/agent/Conversation";
import { resetTranscriptStore } from "../../src/web/agent/transcript-store";
import { resetPromptQueueStore } from "../../src/web/agent/prompt-queue";
import { resetComposerDraftStore } from "../../src/web/agent/composer-state";
import { resetPersonasStore } from "../../src/web/stores/personas";
import { resetWorkersStore } from "../../src/web/stores/workers";
import { COLUMN_MIN_PX, DEFAULT_COLUMN_WEIGHTS, readWeights, resizeColumns } from "../../src/web/persona/geometry";
import { RELOAD_DEBOUNCE_MS } from "../../src/web/persona/WorkspaceList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// -- xterm stand-ins (happy-dom has no canvas) ------------------------------

const xterm = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    written: string[] = [];
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    disposed = false;
    dataListeners: Array<(data: string) => void> = [];
    resizeListeners: Array<(size: { cols: number; rows: number }) => void> = [];
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      FakeTerminal.instances.push(this);
    }
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    write(data: string): void { this.written.push(data); }
    reset(): void { this.written.push("<reset>"); }
    onData(cb: (data: string) => void) { this.dataListeners.push(cb); return { dispose: () => {} }; }
    onResize(cb: (size: { cols: number; rows: number }) => void) { this.resizeListeners.push(cb); return { dispose: () => {} }; }
    dispose(): void { this.disposed = true; }
    type(data: string): void { for (const cb of this.dataListeners) cb(data); }
  }
  class FakeFitAddon {
    fit(): void {}
    proposeDimensions() { return { cols: 80, rows: 24 }; }
  }
  return { FakeTerminal, FakeFitAddon };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xterm.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xterm.FakeFitAddon }));

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

  callsOf<V extends Verb>(verb: V): Array<VerbArgs<V>> {
    return this.calls.filter((call) => call.verb === verb).map((call) => call.args as VerbArgs<V>);
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

  listenerCount(name: EventName): number { return this.listeners.get(name)?.size ?? 0; }

  reconnect(): void { for (const cb of [...this.reconnects]) cb(); }
  status(): ApiStatus { return "open"; }
  onStatus(): () => void { return () => {}; }
  onReconnect(cb: () => void): () => void {
    this.reconnects.add(cb);
    return () => { this.reconnects.delete(cb); };
  }
  close(): void {}
}

// -- fixtures ---------------------------------------------------------------

function persona(id: string, name: string, extra: Partial<Persona> = {}): Persona {
  return {
    id, name, harness: "claude", createdAt: `2026-10-03T00:00:0${id.slice(-1)}Z`, acpSessionId: `acp-${id}`, launchId: "l1",
    pid: 10, cmdline: "adapter", state: "ready", unread: false, ...extra,
  };
}

function worker(id: string, personaId: string, extra: Partial<Worker> = {}): Worker {
  return {
    id, personaId, harness: "claude", cwd: "/repos/app", title: "Fix the login form", sessionId: "s1", launchId: "w-l1",
    pid: 20, cmdline: "claude", state: "running", createdAt: "t", lastReportId: null, ...extra,
  };
}

const CONTEXT = "/home/u/.cube/personas/p1";

function tree(personaId: string, workers: Worker[] = []): WorkspaceTree {
  return {
    repos: [{
      root: "/repos/app", name: "app", known: true, stale: false,
      checkouts: [{
        root: "/repos/app", branch: "main",
        workers: workers.filter((w) => w.personaId === personaId),
        artifacts: [{ path: "/repos/app/report.html", name: "report.html" }],
      }],
    }],
    contextFolder: { path: CONTEXT, artifacts: [
      { path: `${CONTEXT}/plan.html`, name: "plan.html" },
      { path: `${CONTEXT}/Q3 plan & notes #2.html`, name: "Q3 plan & notes #2.html" },
    ] },
  };
}

let seq = 0;
const inn = (message: JsonRpcMessage): AgentRecord => ({ dir: "in", seq: ++seq, message });
const out = (message: JsonRpcMessage): AgentRecord => ({ dir: "out", seq: ++seq, message });

function conversationWith(text: string): AgentRecord[] {
  return [
    inn({ jsonrpc: "2.0", id: "d:1", method: "initialize", params: { protocolVersion: 1, clientCapabilities: { terminal: false } } }),
    out({ jsonrpc: "2.0", id: "d:1", result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }),
    inn({ jsonrpc: "2.0", id: "d:2", method: "session/new", params: { cwd: CONTEXT, mcpServers: [] } }),
    out({ jsonrpc: "2.0", id: "d:2", result: { sessionId: "acp-p1" } }),
    inn({ jsonrpc: "2.0", id: "u:1", method: "session/prompt", params: { sessionId: "acp-p1", prompt: [{ type: "text", text: "Where is the plan?" }] } }),
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-p1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } }),
    out({ jsonrpc: "2.0", id: "u:1", result: { stopReason: "end_turn" } }),
  ];
}

// -- harness ----------------------------------------------------------------

let api: FakeApi;
let container: HTMLDivElement;
let root: Root;
let personas: Persona[];
let workers: Worker[];

function setUp(list: Persona[], workerList: Worker[] = [], records: Record<string, AgentRecord[]> = {}): void {
  personas = list;
  workers = workerList;
  api.handle("personas:list", () => personas);
  api.handle("workers:list", ({ personaId }) => workers.filter((w) => w.personaId === personaId));
  api.handle("persona:open", ({ id }) => ({
    records: records[id] ?? [], startSeq: 0, seq: records[id]?.at(-1)?.seq ?? 0,
    state: (personas.find((p) => p.id === id)?.state ?? "ready") as PersonaState, activePrompt: null,
  }));
  api.handle("persona:mark-read", () => null);
  api.handle("workspace:get", ({ personaId }) => tree(personaId, workers));
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(): Promise<void> {
  await act(async () => { root.render(<App />); });
  await flush();
}

async function emit<E extends EventName>(name: E, payload: EventMap[E]): Promise<void> {
  await act(async () => { api.emit(name, payload); });
  await flush();
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error("nothing to click");
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
}

function button(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => !b.closest("[hidden], [inert]") && b.textContent?.trim() === text);
}

function shown<T extends HTMLElement = HTMLElement>(selector: string): T | undefined {
  return [...container.querySelectorAll<T>(selector)].find((element) => !element.closest("[hidden], [inert]"));
}

function avatars(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button.persona-switch")];
}

beforeEach(() => {
  seq = 0;
  xterm.FakeTerminal.instances = [];
  localStorage.clear();
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
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  window.history.replaceState(null, "", "/");
});

// -- tests ------------------------------------------------------------------

test("with no personas the page shows one New persona button, which creates a claude persona and opens it", async () => {
  setUp([]);
  api.handle("persona:create", ({ harness }) => {
    const created = persona("p1", "Ada", { harness });
    personas = [created];
    return created;
  });
  await mount();

  expect(container.querySelector(".personas-empty")).not.toBeNull();
  expect(avatars()).toHaveLength(0);
  await click(button("New persona"));
  expect(api.callsOf("persona:create")).toEqual([{ harness: "claude" }]);

  await emit("personas:changed", { personas });
  expect(container.querySelector(".personas-empty")).toBeNull();
  expect(avatars()).toHaveLength(1);
  expect(avatars()[0]!.getAttribute("aria-pressed")).toBe("true");
  expect(localStorage.getItem("personas:selected")).toBe("p1");
});

test("the empty state follows ?theme=dark", async () => {
  window.history.replaceState(null, "", "/?theme=dark");
  setUp([]);
  await mount();
  expect(container.querySelector(".personas-empty")).not.toBeNull();
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

test("New's menu creates a codex persona", async () => {
  setUp([persona("p1", "Ada")]);
  api.handle("persona:create", ({ harness }) => persona("p2", "Bea", { harness }));
  await mount();

  await click(container.querySelector("button[aria-label='More ways to create a persona']"));
  await click(button("New Codex persona"));
  expect(api.callsOf("persona:create")).toEqual([{ harness: "codex" }]);
});

test("the persona list names each persona in creation order, and selecting one shows its conversation", async () => {
  setUp([persona("p2", "Bea", { createdAt: "2026-10-03T00:00:09Z" }), persona("p1", "Ada", { createdAt: "2026-10-03T00:00:01Z" })]);
  await mount();

  expect(avatars().map((a) => a.getAttribute("aria-label"))).toEqual(["Ada", "Bea"]);
  expect(avatars().map((a) => a.textContent?.trim())).toEqual(["Ada", "Bea"]);
  // The first persona shows until another is picked.
  expect(api.callsOf("persona:open").at(-1)).toEqual({ id: "p1" });
  expect(container.querySelector(".persona-welcome-name")?.textContent).toBe("Ada");

  await click(avatars()[1]);
  expect(api.callsOf("persona:open").at(-1)).toEqual({ id: "p2" });
  expect(shown(".persona-welcome-name")?.textContent).toBe("Bea");
  expect(localStorage.getItem("personas:selected")).toBe("p2");
});

test("the remembered selection is restored", async () => {
  localStorage.setItem("personas:selected", "p2");
  setUp([persona("p1", "Ada"), persona("p2", "Bea")]);
  await mount();
  expect(avatars()[1]!.getAttribute("aria-pressed")).toBe("true");
});

test("a busy persona's avatar has the working class and an unread one the unread class", async () => {
  setUp([persona("p1", "Ada"), persona("p2", "Bea", { state: "busy" }), persona("p3", "Cy", { unread: true })]);
  await mount();

  const [ada, bea, cy] = avatars().map((a) => a.querySelector(".persona-avatar")!);
  expect(ada!.classList.contains("persona-avatar-working")).toBe(false);
  expect(bea!.classList.contains("persona-avatar-working")).toBe(true);
  expect(cy!.classList.contains("persona-avatar-unread")).toBe(true);

  await emit("persona:state", { id: "p1", state: "busy", activePrompt: "u:1" });
  expect(avatars()[0]!.querySelector(".persona-avatar")!.classList.contains("persona-avatar-working")).toBe(true);
});

test("the shown persona is marked read, and again when a new reply arrives while it is shown", async () => {
  setUp([persona("p1", "Ada", { unread: true }), persona("p2", "Bea", { unread: true })]);
  await mount();
  expect(api.callsOf("persona:mark-read")).toEqual([{ id: "p1" }]);

  personas = [persona("p1", "Ada", { unread: false }), persona("p2", "Bea", { unread: true })];
  await emit("personas:changed", { personas });
  expect(api.callsOf("persona:mark-read")).toEqual([{ id: "p1" }]);

  personas = [persona("p1", "Ada", { unread: true }), persona("p2", "Bea", { unread: true })];
  await emit("personas:changed", { personas });
  expect(api.callsOf("persona:mark-read")).toEqual([{ id: "p1" }, { id: "p1" }]);
});

test("picking a worker mounts a terminal that receives worker:attach data, then live output, and sends keystrokes", async () => {
  const w = worker("w1", "p1");
  setUp([persona("p1", "Ada")], [w]);
  api.handle("worker:attach", () => ({ data: "earlier output\r\n", exited: false }));
  api.handle("worker:input", () => null);
  api.handle("worker:resize", () => null);
  await mount();

  const row = container.querySelector<HTMLButtonElement>("button[data-worker-id='w1']");
  expect(row?.textContent).toContain("Fix the login form");
  expect(container.querySelectorAll(".persona-column")).toHaveLength(2);
  const collection = container.querySelector(".persona-list-surface")!;
  expect(collection.closest("[hidden]")).toBeNull();
  await click(row);

  expect(collection.closest("[hidden]")).not.toBeNull();
  expect(shown("[aria-label='Workspace'] .worker-terminal")).toBeDefined();

  expect(api.callsOf("worker:attach")).toEqual([{ id: "w1" }]);
  const term = xterm.FakeTerminal.instances.at(-1)!;
  expect(term.written).toContain("earlier output\r\n");
  expect(container.querySelector(".worker-terminal")).not.toBeNull();
  expect(api.callsOf("worker:resize")[0]).toEqual({ id: "w1", cols: 80, rows: 24 });

  await emit("worker:output", { id: "w1", data: "more" });
  await emit("worker:output", { id: "w2", data: "someone else's" });
  expect(term.written.at(-1)).toBe("more");

  await act(async () => { term.type("y\r"); });
  expect(api.callsOf("worker:input")).toEqual([{ id: "w1", data: "y\r" }]);

  await emit("worker:exit", { id: "w1", exitCode: 3 });
  expect(container.querySelector(".worker-terminal-exit")?.textContent).toBe("Exited with code 3.");

  await click(shown("button[aria-label='Back to workspace list']"));
  expect(collection.closest("[hidden]")).toBeNull();
  expect(shown(".worker-terminal")).toBeUndefined();
});

test("a worker row shows its state and the first line of its latest report", async () => {
  const w = { ...worker("w1", "p1", { state: "idle" }), latestReport: "Login form fixed.\nDetails follow." };
  setUp([persona("p1", "Ada")], [w]);
  await mount();
  const row = container.querySelector("button[data-worker-id='w1']")!;
  expect(row.querySelector(".persona-worker-dot")?.getAttribute("data-state")).toBe("idle");
  expect(row.querySelector(".persona-worker-report")?.textContent).toBe("Login form fixed.");
});

test("the workspace list refreshes on workers:changed, reports:changed and the persona's turn ending", async () => {
  setUp([persona("p1", "Ada")]);
  await mount();
  const reads = (): number => api.callsOf("workspace:get").length;
  const settle = async (): Promise<void> => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, RELOAD_DEBOUNCE_MS + 50)); });
    await flush();
  };
  const first = reads();

  workers = [worker("w1", "p1")];
  await emit("workers:changed", { personaId: "p1", workers });
  await settle();
  expect(reads()).toBe(first + 1);
  expect(container.querySelector("button[data-worker-id='w1']")).not.toBeNull();

  await emit("workers:changed", { personaId: "other", workers: [] });
  await settle();
  expect(reads()).toBe(first + 1);

  await emit("reports:changed", { personaId: "p1" });
  await settle();
  expect(reads()).toBe(first + 2);

  await emit("persona:state", { id: "p1", state: "busy", activePrompt: "u:1" });
  expect(reads()).toBe(first + 2);
  await emit("persona:state", { id: "p1", state: "ready", activePrompt: null });
  expect(reads()).toBe(first + 3);
});

test("a burst of worker and report changes is read once", async () => {
  setUp([persona("p1", "Ada")]);
  await mount();
  const reads = (): number => api.callsOf("workspace:get").length;
  const first = reads();
  for (let n = 0; n < 5; n++) await emit("workers:changed", { personaId: "p1", workers });
  await emit("reports:changed", { personaId: "p1" });
  expect(reads()).toBe(first);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, RELOAD_DEBOUNCE_MS + 50)); });
  await flush();
  expect(reads()).toBe(first + 1);
});

test("picking an artifact renders a sandboxed iframe whose src names the persona and the path", async () => {
  setUp([persona("p1", "Ada")]);
  await mount();
  // happy-dom reports, on the worker's own stderr, the frame it was told not
  // to load; the framed page is not under test.
  const quiet = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  await click(container.querySelector("button[data-artifact-path='/repos/app/report.html']"));
  quiet.mockRestore();
  const frame = container.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups allow-modals");
  const src = new URL(frame.getAttribute("src")!, "http://page.invalid/");
  expect(src.pathname).toBe("/artifact");
  expect(src.searchParams.get("persona")).toBe("p1");
  expect(src.searchParams.get("path")).toBe("/repos/app/report.html");
  expect(frame.getAttribute("src")!.startsWith("/artifact?")).toBe(true);
});

test("the repositories dialog loads the text, saves it with repos:set, and shows a refusal inline", async () => {
  setUp([persona("p1", "Ada")]);
  api.handle("repos:get", () => ({ text: "- /repos/app" }));
  let refuse = true;
  api.handle("repos:set", () => {
    if (refuse) throw new Error("/nope is not a folder on this machine.");
    return null;
  });
  await mount();

  await click(button("Repositories"));
  const textarea = container.querySelector<HTMLTextAreaElement>("[role='dialog'] textarea")!;
  expect(textarea.value).toBe("- /repos/app");

  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea, "- /repos/app\n- /nope");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Save"));
  expect(api.callsOf("repos:set")).toEqual([{ personaId: "p1", text: "- /repos/app\n- /nope" }]);
  expect(container.querySelector("[role='dialog'] [role='alert']")?.textContent).toBe("/nope is not a folder on this machine.");

  refuse = false;
  await click(button("Save"));
  expect(container.querySelector("[role='dialog']")).toBeNull();
});

test("the context folder lists files, expands directories, and opens a file read-only", async () => {
  setUp([persona("p1", "Ada")]);
  api.handle("files:list", ({ path }) => path === CONTEXT
    ? { entries: [{ name: "notes", dir: true }, { name: "AGENTS.md", dir: false }] }
    : { entries: [{ name: "today.md", dir: false }] });
  api.handle("files:read", ({ path }) => ({ text: `contents of ${path}`, truncated: path.endsWith("today.md") }));
  await mount();

  await click(button("Context folder"));
  expect(api.callsOf("files:list")).toEqual([{ personaId: "p1", path: CONTEXT }]);
  await click(button("notes"));
  expect(api.callsOf("files:list").at(-1)).toEqual({ personaId: "p1", path: `${CONTEXT}/notes` });

  await click(button("AGENTS.md"));
  expect(container.querySelector(".file-view-text")?.textContent).toBe(`contents of ${CONTEXT}/AGENTS.md`);
  expect(container.textContent).not.toContain("Showing the first 1 MB.");

  await click(container.querySelector("button[aria-label='Back to the context folder']"));
  // Returning to context keeps expansion and refreshes the visible directories.
  expect(button("today.md")).toBeDefined();
  expect(api.callsOf("files:list")).toHaveLength(4);
  await click(button("today.md"));
  expect(container.textContent).toContain("Showing the first 1 MB.");
  await click(shown("button[aria-label='Back to the context folder']"));
  await click(shown("button[aria-label='Back to workspace list']"));
  expect(shown(".persona-tree")).toBeDefined();
});

test("retained files and expanded context directories refresh when shown again", async () => {
  setUp([persona("p1", "Ada"), persona("p2", "Bea")]);
  let revision = 1;
  api.handle("files:list", ({ path }) => path === CONTEXT
    ? { entries: [{ name: "notes", dir: true }] }
    : { entries: [{ name: "today.md", dir: false }, ...(revision > 1 ? [{ name: "new.md", dir: false }] : [])] });
  api.handle("files:read", () => ({ text: `revision ${revision}`, truncated: false }));
  await mount();
  await click(button("Context folder"));
  await click(button("notes"));
  const context = shown(".context-folder");
  await click(button("today.md"));
  expect(shown(".file-view-text")?.textContent).toBe("revision 1");
  revision = 2;
  await click(shown("button[aria-label='Back to the context folder']"));
  expect(shown(".context-folder")).toBe(context);
  expect(button("new.md")).toBeDefined();
  await click(button("today.md"));
  expect(shown(".file-view-text")?.textContent).toBe("revision 2");
  await click(avatars()[1]);
  revision = 3;
  await click(avatars()[0]);
  expect(shown(".file-view-text")?.textContent).toBe("revision 3");
});

test("Delete asks first, and calls persona:delete only on confirm", async () => {
  setUp([persona("p1", "Ada"), persona("p2", "Bea")]);
  api.handle("persona:delete", () => ({ contextFolder: CONTEXT }));
  await mount();

  await click(container.querySelector("button[aria-label='Actions for Ada']"));
  await click(button("Delete"));
  const dialog = container.querySelector("[role='dialog']")!;
  expect(dialog.textContent).toContain(`Delete this persona? Its conversation and workers end. Its files stay in ${CONTEXT}.`);
  await click(button("Cancel"));
  expect(api.callsOf("persona:delete")).toEqual([]);
  expect(container.querySelector("[role='dialog']")).toBeNull();

  await click(container.querySelector("button[aria-label='Actions for Ada']"));
  await click(button("Delete"));
  await click(container.querySelector("[role='dialog'] button.persona-dialog-danger"));
  expect(api.callsOf("persona:delete")).toEqual([{ id: "p1" }]);
});

test("Rename from an avatar's menu calls persona:rename", async () => {
  setUp([persona("p1", "Ada")]);
  api.handle("persona:rename", () => null);
  await mount();

  await click(container.querySelector("button[aria-label='Actions for Ada']"));
  await click(button("Rename"));
  const input = container.querySelector<HTMLInputElement>("[role='dialog'] input")!;
  expect(input.value).toBe("Ada");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, "Ada Lovelace");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Save"));
  expect(api.callsOf("persona:rename")).toEqual([{ id: "p1", name: "Ada Lovelace" }]);
});

test("a file path in the chat opens in the file view", async () => {
  setUp([persona("p1", "Ada")], [], { p1: conversationWith("It is in `notes/plan.md` now.") });
  api.handle("files:read", ({ path }) => ({ text: `read ${path}`, truncated: false }));
  await mount();

  const link = container.querySelector<HTMLAnchorElement>(".agent-markdown-path-link");
  expect(link?.textContent).toBe("notes/plan.md");
  await click(link);
  expect(api.callsOf("files:read")).toEqual([{ personaId: "p1", path: `${CONTEXT}/notes/plan.md` }]);
  expect(container.querySelector(".file-view-text")?.textContent).toBe(`read ${CONTEXT}/notes/plan.md`);
  expect(shown(".persona-tree")).toBeUndefined();
  await click(shown("button[aria-label='Back to workspace list']"));
  expect(shown(".persona-tree")).toBeDefined();
});

test("Conversation calls onOpenPath with a path link's target", async () => {
  setUp([persona("p1", "Ada")], [], { p1: conversationWith("See `src/app.ts`.") });
  const opened: string[] = [];
  await act(async () => { root.render(<Conversation personaId="p1" onOpenPath={(path) => opened.push(path)} />); });
  await flush();
  await click(container.querySelector(".agent-markdown-path-link"));
  expect(opened).toEqual(["src/app.ts"]);
});

test("resizing the conversation leaves one usable workspace and remembers their proportions", async () => {
  const next = resizeColumns(DEFAULT_COLUMN_WEIGHTS, -10_000, 1500);
  expect(next[0] / 5 * 1500).toBeCloseTo(COLUMN_MIN_PX);
  expect(next[1] / 5 * 1500).toBeCloseTo(1500 - COLUMN_MIN_PX);

  setUp([persona("p1", "Ada")]);
  await mount();
  const columns = [...container.querySelectorAll<HTMLElement>(".persona-column")];
  expect(columns.map((c) => c.style.flexGrow)).toEqual(["2", "3"]);
  expect(container.querySelectorAll("[role='separator']")).toHaveLength(1);
  const handle = container.querySelector<HTMLElement>("[role='separator']")!;
  await act(async () => { handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  const stored = JSON.parse(localStorage.getItem("personas:weights")!) as number[];
  expect(stored).toHaveLength(2);
  expect(stored[0]).toBeGreaterThan(2);
});

test("old three-column preferences fold the list and picked widths into the workspace", () => {
  localStorage.setItem("personas:weights", "[3,2,4]");
  expect(readWeights()).toEqual([3, 6]);
  localStorage.setItem("personas:weights", "[0,2]");
  expect(readWeights()).toEqual([2, 3]);
});

test("an artifact path with spaces, & and # survives the iframe's src", async () => {
  setUp([persona("p1", "Ada")]);
  await mount();
  const path = `${CONTEXT}/Q3 plan & notes #2.html`;
  const quiet = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await click(container.querySelector(`button[data-artifact-path='${path}']`));
  quiet.mockRestore();
  const src = new URL(container.querySelector("iframe")!.getAttribute("src")!, "http://page.invalid/");
  expect(src.searchParams.get("path")).toBe(path);
  expect(src.searchParams.get("persona")).toBe("p1");
  expect(src.hash).toBe("");
});

test("visited workers stay live across workspace and persona navigation, then detach on deletion", async () => {
  setUp([persona("p1", "Ada"), persona("p2", "Bea")], [worker("w1", "p1"), worker("w2", "p1", { title: "Second" })]);
  api.handle("worker:attach", ({ id }) => ({ data: `${id} output`, exited: false }));
  api.handle("worker:resize", () => null);
  api.handle("worker:detach", () => null);
  await mount();
  const before = api.listenerCount("worker:output");

  await click(container.querySelector("button[data-worker-id='w1']"));
  const first = xterm.FakeTerminal.instances.at(-1)!;
  expect(api.listenerCount("worker:output")).toBe(before + 1);

  await click(shown("button[aria-label='Back to workspace list']"));
  await click(container.querySelector("button[data-worker-id='w2']"));
  const second = xterm.FakeTerminal.instances.at(-1)!;
  expect(first.disposed).toBe(false);
  expect(second).not.toBe(first);
  expect(second.written).toContain("w2 output");
  expect(api.listenerCount("worker:output")).toBe(before + 2);

  await click(avatars()[1]);
  expect(second.disposed).toBe(false);
  expect(shown(".worker-terminal")).toBeUndefined();
  await emit("worker:output", { id: "w1", data: "while away" });
  expect(first.written.at(-1)).toBe("while away");
  await click(avatars()[0]);
  await click(shown("button[aria-label='Back to workspace list']"));
  await click(container.querySelector("button[data-worker-id='w1']"));
  expect(xterm.FakeTerminal.instances).toHaveLength(2);
  expect(api.callsOf("worker:attach")).toEqual([{ id: "w1" }, { id: "w2" }]);

  personas = [personas[1]!];
  await emit("personas:changed", { personas });
  expect(first.disposed).toBe(true);
  expect(second.disposed).toBe(true);
  expect(api.listenerCount("worker:output")).toBe(0);
  expect(api.callsOf("worker:detach")).toEqual([{ id: "w1" }, { id: "w2" }]);
});

test("switching personas preserves the conversation draft and the artifact iframe DOM", async () => {
  setUp([persona("p1", "Ada"), persona("p2", "Bea")]);
  await mount();
  const draft = shown<HTMLTextAreaElement>(".agent-composer-input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(draft, "Keep this draft");
    draft.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const quiet = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await click(container.querySelector("button[data-artifact-path='/repos/app/report.html']"));
  quiet.mockRestore();
  const frame = shown("iframe")!;
  await click(shown("button[aria-label='Back to workspace list']"));
  expect(frame.isConnected).toBe(true);
  expect(frame.closest("[hidden][inert]")).not.toBeNull();
  await click(container.querySelector("button[data-artifact-path='/repos/app/report.html']"));
  expect(shown("iframe")).toBe(frame);

  await click(avatars()[1]);
  expect(shown("iframe")).toBeUndefined();
  expect(draft.closest("[hidden][inert]")).not.toBeNull();
  await click(avatars()[0]);
  expect(shown("iframe")).toBe(frame);
  expect(shown(".agent-composer-input")).toBe(draft);
  expect(draft.value).toBe("Keep this draft");
  expect(api.callsOf("persona:open")).toEqual([{ id: "p1" }, { id: "p2" }]);
});

/** The selectors in PersonaView.css whose rule sets an overflow (happy-dom loads no stylesheet). */
function overflowSelectors(): string[] {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/web/persona/PersonaView.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/(^|;|\s)overflow(-x|-y)?\s*:/.test(match[2]!)) selectors.push(...match[1]!.split(",").map((part) => part.trim()).filter(Boolean));
  }
  return selectors;
}

test("the switcher's menus sit outside every element that sets an overflow, fixed at their trigger", async () => {
  setUp([persona("p1", "Ada")]);
  await mount();
  const selectors = overflowSelectors();
  expect(selectors).toContain(".persona-switch-strip");

  for (const trigger of ["button[aria-label='Actions for Ada']", "button[aria-label='More ways to create a persona']"]) {
    await click(container.querySelector(trigger));
    const menu = container.querySelector<HTMLElement>("[role='menu']")!;
    expect(menu).not.toBeNull();
    expect(menu.style.position).toBe("fixed");
    for (let node = menu.parentElement; node; node = node.parentElement) {
      for (const selector of selectors) expect(node.matches(selector), `${selector} clips the menu`).toBe(false);
    }
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(container.querySelector("[role='menu']")).toBeNull();
  }
});

test("pressing an open menu's trigger closes it rather than reopening it; a press elsewhere closes it too", async () => {
  setUp([persona("p1", "Ada")]);
  await mount();
  const trigger = container.querySelector<HTMLButtonElement>("button[aria-label='Actions for Ada']")!;
  const press = async (element: Element): Promise<void> => {
    await act(async () => { element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await click(element);
  };

  await press(trigger);
  expect(container.querySelector("[role='menu']")).not.toBeNull();
  await press(trigger);
  expect(container.querySelector("[role='menu']")).toBeNull();

  await press(trigger);
  await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
  expect(container.querySelector("[role='menu']")).toBeNull();
});

test("a persona menu near the bottom of the list opens fully inside the viewport", async () => {
  setUp([persona("p1", "Ada")]);
  await mount();
  const trigger = container.querySelector<HTMLElement>("button[aria-label='Actions for Ada']")!;
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === trigger) return new DOMRect(window.innerWidth - 30, window.innerHeight - 30, 24, 26);
    if (this.getAttribute("role") === "menu") return new DOMRect(0, 0, 188, 72);
    return new DOMRect();
  });
  try {
    await click(trigger);
    const menu = container.querySelector<HTMLElement>("[role='menu']")!;
    expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(menu.style.top) + 72).toBeLessThanOrEqual(window.innerHeight - 8);
    expect(parseFloat(menu.style.left) + 188).toBeLessThanOrEqual(window.innerWidth - 8);
    await click(button("Rename"));
    expect(shown("[role='dialog']")).toBeDefined();
  } finally { rect.mockRestore(); }
});

test("a relative chat path waits for the workspace instead of opening a relative path", async () => {
  setUp([persona("p1", "Ada")], [], { p1: conversationWith("It is in `notes/plan.md` now.") });
  api.handle("workspace:get", () => new Promise<WorkspaceTree>(() => {}));
  api.handle("files:read", () => ({ text: "", truncated: false }));
  await mount();

  await click(container.querySelector(".agent-markdown-path-link"));
  expect(api.callsOf("files:read")).toEqual([]);
  expect(shown("[aria-label='Workspace']")?.textContent).toContain("Still loading this persona's files.");
});
