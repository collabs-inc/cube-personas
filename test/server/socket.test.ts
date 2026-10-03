import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { startApp, type App } from "../../src/server/app";
import { hostAllowed, originMatches } from "../../src/server/http";
import { isRequest, isResponse, type AgentRecord, type JsonRpcRequest } from "../../src/shared/agent-protocol";
import type { Persona, Worker } from "../../src/shared/types";
import type { EventName, WireEvent, WireResponse } from "../../src/shared/wire";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";
const ENV_KEYS = ["PERSONAS_ALLOWED_HOSTS", "HOME", "XDG_STATE_HOME", "PERSONAS_STATE_DIR", "PATH", "PORT", "PERSONAS_ADAPTER_CLAUDE", "PERSONAS_ADAPTER_CODEX"];
/** What the stand-in claude prints before it becomes the fake claude: more than the 256 KiB kept. */
const FLOOD_BYTES = 300 * 1024;

let root: string;
let home: string;
let repo: string;
let stateDir: string;
let savedEnv: Record<string, string | undefined>;
let apps: App[];
let clients: Client[];

class Client {
  private nextId = 1;
  private readonly waiting = new Map<number, (res: WireResponse) => void>();
  readonly events: WireEvent[] = [];
  readonly raw: string[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const text = data.toString();
      this.raw.push(text);
      const msg = JSON.parse(text) as WireResponse | WireEvent;
      if (msg.t === "res") this.waiting.get(msg.id)?.(msg);
      else this.events.push(msg);
    });
  }

  static open(port: number, path = "/ws", headers: Record<string, string> = {}): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
      ws.once("open", () => {
        const client = new Client(ws);
        clients.push(client);
        resolve(client);
      });
      ws.once("error", reject);
    });
  }

  request(verb: string, args: unknown): Promise<WireResponse> {
    const id = this.nextId++;
    return this.send({ t: "req", id, verb, args }, id);
  }

  send(frame: unknown, id: number): Promise<WireResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to request ${id}`)), 20_000);
      this.waiting.set(id, (res) => { clearTimeout(timer); resolve(res); });
      this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    });
  }

  async ok<T>(verb: string, args: unknown): Promise<T> {
    const res = await this.request(verb, args);
    if (!res.ok) throw new Error(`${verb} failed: ${res.error}`);
    return res.result as T;
  }

  async event(name: EventName, match: (payload: any) => boolean = () => true, ms = 20_000): Promise<any> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.events.find((e) => e.name === name && match(e.payload));
      if (found) return found.payload;
      if (Date.now() > deadline) throw new Error(`no ${name} event`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((r) => { this.ws.once("close", () => r()); this.ws.close(); });
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "personas-socket-"));
  home = join(root, "home");
  const bin = join(root, "bin");
  repo = join(root, "repo");
  stateDir = join(root, "state");
  for (const d of [home, bin, repo]) mkdirSync(d);
  // A claude that floods its terminal first, then behaves as the fake claude.
  writeFileSync(join(bin, "claude"), `#!/bin/sh\n${process.execPath} -e 'process.stdout.write("x".repeat(${FLOOD_BYTES}) + "END-OF-FLOOD")'\nexec ${process.execPath} ${join(FIXTURES, "fake-claude.mjs")} "$@"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  symlinkSync(join(FIXTURES, "fake-codex.mjs"), join(bin, "codex"));
  execFileSync("git", ["init", "-q", repo]);
  const adapter = join(root, "fake-adapter");
  writeFileSync(adapter, `#!/bin/sh\nexec ${process.execPath} ${join(FIXTURES, "fake-agent.mjs")} "$@"\n`);
  chmodSync(adapter, 0o755);
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    HOME: home,
    XDG_STATE_HOME: join(root, "xdg"),
    PERSONAS_STATE_DIR: stateDir,
    PATH: [bin, SYSTEM_PATH].join(":"),
    PORT: "0",
    PERSONAS_ADAPTER_CLAUDE: adapter,
    PERSONAS_ADAPTER_CODEX: adapter,
  });
  apps = [];
  clients = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const c of clients) await c.close();
  for (const app of apps) await app.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

async function start(): Promise<App> {
  const app = await startApp();
  apps.push(app);
  return app;
}

async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function prompt(text: string): JsonRpcRequest {
  return { jsonrpc: "2.0", id: `${randomUUID()}:1`, method: "session/prompt", params: { prompt: [{ type: "text", text }] } };
}

const answered = (records: AgentRecord[], id: string | number): boolean =>
  records.some((r) => r.dir === "out" && isResponse(r.message) && r.message.id === id);

async function readyPersona(client: Client): Promise<Persona> {
  const persona = await client.ok<Persona>("persona:create", { harness: "claude" });
  await client.event("persona:state", (p) => p.id === persona.id && p.state === "ready");
  return persona;
}

/** Sends a prompt over the socket and waits until its answer is in the conversation. */
async function turn(client: Client, app: App, id: string, text: string): Promise<void> {
  const message = prompt(text);
  await until(() => app.services.state.personas().find((p) => p.id === id)?.state === "ready", "a ready persona");
  await client.ok("persona:send", { id, message });
  await until(() => answered(app.services.personas.open(id).records, message.id), `the answer to "${text}"`);
}

/** A request with headers fetch will not let a test set (Host). */
function raw(port: number, method: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("hostAllowed and originMatches", () => {
  test("loopback names, .cube.site names and listed hosts only", () => {
    const env = { PERSONAS_ALLOWED_HOSTS: "box.lan:8080,other.lan" };
    for (const host of ["127.0.0.1", "127.0.0.1:4870", "localhost:1", "LOCALHOST:2", "[::1]:4870", "x.cube.site", "a.b.cube.site:443", "box.lan:8080", "other.lan", "other.lan:3"]) {
      expect({ host, ok: hostAllowed(host, env) }).toEqual({ host, ok: true });
    }
    for (const host of [undefined, "", "evil.example", "cube.site", ".cube.site", "x.cube.site.evil.example", "box.lan:9090", "evil.com@127.0.0.1", "127.0.0.1:4870/x", "2130706433", "0.0.0.0:4870"]) {
      expect({ host, ok: hostAllowed(host, env) }).toEqual({ host, ok: false });
    }
  });

  test("an absent Origin passes; a present one must name the Host exactly", () => {
    expect(originMatches(undefined, "127.0.0.1:1")).toBe(true);
    expect(originMatches("http://127.0.0.1:1", "127.0.0.1:1")).toBe(true);
    expect(originMatches("https://X.cube.site", "x.cube.site")).toBe(true);
    expect(originMatches("null", "127.0.0.1:1")).toBe(false);
    expect(originMatches("http://127.0.0.1:2", "127.0.0.1:1")).toBe(false);
    expect(originMatches("not a url", "127.0.0.1:1")).toBe(false);
    expect(originMatches("http://127.0.0.1:1", undefined)).toBe(false);
  });
});

describe("the browser socket", () => {
  test("personas:list is empty on a fresh start", async () => {
    const app = await start();
    const client = await Client.open(app.port);
    expect(await client.request("personas:list", {})).toMatchObject({ ok: true, result: [] });
  });

  test("persona:create broadcasts personas:changed to every open socket", async () => {
    const app = await start();
    const a = await Client.open(app.port);
    const b = await Client.open(app.port);
    const persona = await a.ok<Persona>("persona:create", { harness: "claude" });
    const changed = await b.event("personas:changed", (p) => p.personas.some((x: Persona) => x.id === persona.id));
    expect(changed.personas).toHaveLength(1);
    await b.event("persona:state", (p) => p.id === persona.id && p.state === "ready");
    // The adapter's command line is the server's own business.
    await until(() => app.services.state.personas()[0]!.cmdline !== null, "the adapter's command line");
    const listed = await b.ok<Persona[]>("personas:list", {});
    expect(listed[0]!.cmdline).toBeNull();
  });

  test("persona:open with sinceSeq after a reconnect returns only the later records, in order", async () => {
    const app = await start();
    let client = await Client.open(app.port);
    const persona = await readyPersona(client);
    await turn(client, app, persona.id, "first");
    const held = await client.ok<{ records: AgentRecord[]; seq: number }>("persona:open", { id: persona.id });
    expect(held.records.length).toBeGreaterThan(0);
    expect(held.seq).toBe(held.records.at(-1)!.seq);
    await client.close();

    // While the page is away the conversation moves on.
    const other = await Client.open(app.port);
    await turn(other, app, persona.id, "second");

    client = await Client.open(app.port);
    const later = await client.ok<{ records: AgentRecord[]; seq: number; state: string; activePrompt: string | null }>(
      "persona:open", { id: persona.id, sinceSeq: held.seq },
    );
    const all = app.services.personas.open(persona.id).records;
    expect(later.records.length).toBeGreaterThan(0);
    expect(later.records).toEqual(all.filter((r) => r.seq > held.seq));
    expect(later.records.map((r) => r.seq)).toEqual([...later.records.map((r) => r.seq)].sort((x, y) => x - y));
    expect(later.records.some((r) => r.dir === "in" && isRequest(r.message) && r.message.method === "session/prompt")).toBe(true);
    expect(later.seq).toBe(all.at(-1)!.seq);
    expect(later.state).toBe("ready");
    expect(later.activePrompt).toBeNull();
  });

  test("worker:attach returns at most 262144 bytes, the trailing output", async () => {
    const app = await start();
    const client = await Client.open(app.port);
    const persona = await readyPersona(client);
    const { agentId } = await app.services.workers.spawn(persona.id, { harness: "claude", cwd: repo });
    await client.event("workers:changed", (p) => p.personaId === persona.id && p.workers.some((w: Worker) => w.id === agentId));
    await until(() => app.services.workers.attach(agentId).data.includes("ready"), "the worker's banner");
    const attached = await client.ok<{ data: string; exited: boolean }>("worker:attach", { id: agentId });
    expect(Buffer.byteLength(attached.data, "utf8")).toBeLessThanOrEqual(262144);
    expect(Buffer.byteLength(attached.data, "utf8")).toBeGreaterThan(200 * 1024);
    expect(attached.data).toContain("END-OF-FLOOD");
    expect(attached.exited).toBe(false);

    // The attach reply is read and sent in one tick: output that follows it
    // on the socket is never also inside it, and none falls between.
    const before = client.raw.length;
    const again = client.request("worker:attach", { id: agentId });
    app.services.workers.input(agentId, "between\r");
    const reattached = await again;
    expect(reattached.ok).toBe(true);
    const after = client.raw.slice(before);
    const replyAt = after.findIndex((f) => f.includes('"t":"res"'));
    expect(after.slice(0, replyAt).some((f) => f.includes('"worker:output"'))).toBe(false);

    // Typing reaches the worker; its output is broadcast.
    expect(await client.ok("worker:input", { id: agentId, data: "hello\r" })).toBeNull();
    await client.event("worker:output", (p) => p.id === agentId && String(p.data).includes("hello"));
    // Its turn's report is recorded and announced; the workspace shows its text.
    await client.event("reports:changed", (p) => p.personaId === persona.id);
    const tree = await client.ok<{ repos: Array<{ checkouts: Array<{ workers: Array<{ id: string; latestReport?: string | null }> }> }> }>(
      "workspace:get", { personaId: persona.id },
    );
    expect(tree.repos[0]!.checkouts[0]!.workers).toEqual([expect.objectContaining({ id: agentId, latestReport: "done: hello", cmdline: null })]);

    // The worker's command line names the state directory: never sent to the page.
    await until(() => app.services.state.workers()[0]!.cmdline !== null, "the worker's command line");
    const listed = await client.ok<Worker[]>("workers:list", { personaId: persona.id });
    expect(listed.map((w) => w.id)).toEqual([agentId]);
    expect(client.raw.join("\n")).not.toContain(stateDir);

    expect(await client.ok("worker:stop", { id: agentId })).toBeNull();
    const exit = await client.event("worker:exit", (p) => p.id === agentId);
    expect(exit).toHaveProperty("exitCode");
  });

  test("worker:output reaches only sockets attached to that worker, until they detach", async () => {
    const app = await start();
    const watcher = await Client.open(app.port);
    const bystander = await Client.open(app.port);
    const persona = await readyPersona(watcher);
    const { agentId } = await app.services.workers.spawn(persona.id, { harness: "claude", cwd: repo });
    await until(() => app.services.workers.attach(agentId).data.includes("ready"), "the worker's banner");
    await watcher.ok("worker:attach", { id: agentId });
    app.services.workers.input(agentId, "first\r");
    await watcher.event("worker:output", (p) => p.id === agentId && String(p.data).includes("first"));
    expect(bystander.events.some((e) => e.name === "worker:output")).toBe(false);

    expect(await watcher.ok("worker:detach", { id: agentId })).toBeNull();
    const seen = watcher.events.length;
    app.services.workers.input(agentId, "second\r");
    await until(() => app.services.workers.attach(agentId).data.includes("second"), "the second echo");
    await new Promise((r) => setTimeout(r, 200));
    expect(watcher.events.slice(seen).some((e) => e.name === "worker:output")).toBe(false);
    expect(bystander.events.some((e) => e.name === "worker:output")).toBe(false);
  });

  test("an unknown verb, bad arguments and a failing handler answer ok:false with one sentence", async () => {
    const app = await start();
    const client = await Client.open(app.port);
    expect(await client.request("persona:explode", {})).toEqual({ t: "res", id: 1, ok: false, error: "Unknown request." });
    const bad = await client.request("persona:rename", { id: 42 });
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { error: string }).error).toMatch(/^[A-Z][^\n]*\.$/);
    expect(await client.request("persona:open", { id: randomUUID() })).toMatchObject({ ok: false, error: "No such persona." });
    expect(await client.request("persona:open", { id: "../../etc" })).toMatchObject({ ok: false, error: "No such persona." });
    expect(await client.request("workspace:get", { personaId: randomUUID() })).toMatchObject({ ok: false, error: "No such persona." });
    expect(await client.request("worker:attach", { id: randomUUID() })).toMatchObject({ ok: false, error: "No such agent." });
    expect(await client.request("files:read", { personaId: randomUUID(), path: "/etc/passwd" })).toMatchObject({ ok: false });
    expect(await client.request("personas:list", null)).toMatchObject({ ok: true });

    // Malformed frames are ignored; the socket stays usable.
    client.ws.send("not json");
    client.ws.send(JSON.stringify({ t: "evt", name: "nope" }));
    expect(await client.request("personas:list", {})).toMatchObject({ ok: true, result: [] });
  });

  test("workspace, repos and files verbs answer for a persona", async () => {
    const app = await start();
    const client = await Client.open(app.port);
    const persona = await readyPersona(client);
    const folder = join(home, ".cube", "personas", persona.id);
    expect(await client.ok("repos:set", { personaId: persona.id, text: `${repo}\n` })).toBeNull();
    expect(await client.ok("repos:get", { personaId: persona.id })).toEqual({ text: repo });
    expect(await client.request("repos:set", { personaId: persona.id, text: "relative/path" }))
      .toMatchObject({ ok: false, error: "Each line must be an absolute path." });
    for (const broad of ["/", home, `${home}/`]) {
      expect(await client.request("repos:set", { personaId: persona.id, text: `${repo}\n${broad}\n` }))
        .toMatchObject({ ok: false, error: "The filesystem root and your home folder cannot be listed as repositories." });
    }
    expect(await client.ok("repos:get", { personaId: persona.id })).toEqual({ text: repo });
    writeFileSync(join(repo, "board.html"), "<h1>b</h1>");
    const tree = await client.ok<{ repos: Array<{ root: string; checkouts: Array<{ artifacts: unknown[] }> }>; contextFolder: { path: string } }>(
      "workspace:get", { personaId: persona.id },
    );
    expect(tree.repos.map((r) => r.root)).toEqual([repo]);
    expect(tree.repos[0]!.checkouts[0]!.artifacts).toEqual([{ path: join(repo, "board.html"), name: "board.html" }]);
    expect(tree.contextFolder.path).toBe(folder);
    const listed = await client.ok<{ entries: Array<{ name: string }> }>("files:list", { personaId: persona.id, path: folder });
    expect(listed.entries.map((e) => e.name)).toContain("AGENTS.md");
    const read = await client.ok<{ text: string; truncated: boolean }>("files:read", { personaId: persona.id, path: join(repo, "board.html") });
    expect(read).toEqual({ text: "<h1>b</h1>", truncated: false });
    expect(await client.request("files:read", { personaId: persona.id, path: "/etc/passwd" }))
      .toMatchObject({ ok: false, error: "That file is not available." });

    const res = await fetch(`http://127.0.0.1:${app.port}/artifact?persona=${persona.id}&path=${encodeURIComponent(join(repo, "board.html"))}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>b</h1>");
  });

  test("an upgrade on any other path, or from an opaque origin, is refused", async () => {
    const app = await start();
    await expect(Client.open(app.port, "/other")).rejects.toThrow();
    await expect(Client.open(app.port, "/ws", { Origin: "null" })).rejects.toThrow();
  });

  test("cross-site and rebinding pages are refused: the upgrade, GET / and /artifact", async () => {
    const app = await start();
    const p = app.port;
    // A page on another site opening the raw port.
    await expect(Client.open(p, "/ws", { Origin: "http://evil.example" })).rejects.toThrow();
    // DNS rebinding: the attacker's own name, pointed at 127.0.0.1, with a matching Origin.
    const evil = { Host: `evil.example:${p}`, Origin: `http://evil.example:${p}` };
    await expect(Client.open(p, "/ws", evil)).rejects.toThrow();
    expect(await raw(p, "GET", "/", evil)).toEqual({ status: 403, body: "This address is not allowed." });
    expect(await raw(p, "GET", `/artifact?persona=${randomUUID()}&path=/etc/passwd`, { Host: `evil.example:${p}` }))
      .toEqual({ status: 403, body: "This address is not allowed." });
    // A request that can change something needs a matching Origin even on an allowed Host.
    expect(await raw(p, "POST", "/health", { Host: `127.0.0.1:${p}`, Origin: "http://evil.example" }))
      .toEqual({ status: 403, body: "This origin is not allowed." });
    // POST /mcp keeps its own rules: not this guard's refusal.
    expect((await raw(p, "POST", "/mcp?persona=x", { Host: `evil.example:${p}` })).body).not.toBe("This address is not allowed.");
  });

  test("the gate's own addresses are admitted: loopback, a .cube.site name, and PERSONAS_ALLOWED_HOSTS", async () => {
    process.env.PERSONAS_ALLOWED_HOSTS = "box.lan:8080, other.lan";
    const app = await start();
    const p = app.port;
    for (const [host, origin] of [
      [`127.0.0.1:${p}`, `http://127.0.0.1:${p}`],
      [`localhost:${p}`, `http://localhost:${p}`],
      ["x.cube.site", "https://x.cube.site"],
      ["box.lan:8080", "http://box.lan:8080"],
    ] as const) {
      const client = await Client.open(p, "/ws", { Host: host, Origin: origin });
      expect(await client.request("personas:list", {})).toMatchObject({ ok: true });
      expect((await raw(p, "GET", "/health", { Host: host })).status).toBe(200);
    }
    // No Origin at all: not a browser, admitted.
    const plain = await Client.open(p, "/ws", { Host: `127.0.0.1:${p}` });
    expect(await plain.request("personas:list", {})).toMatchObject({ ok: true });
    expect((await raw(p, "GET", "/health", { Host: "box.lan:9999" })).status).toBe(403);
  });
});
