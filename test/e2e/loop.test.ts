// The whole loop against the built server on real processes: a persona
// spawns a claude worker through its MCP tools, the worker's report wakes
// the persona, an ack quiets it, an artifact is served, and the server is
// stopped (SIGTERM) and killed (SIGKILL) with everything resumed or reaped.
//
// Only processes this test started are ever signalled: the servers it
// spawned, and children those servers recorded, each checked against the
// command line this run read for it.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import WebSocket from "ws";
import type { AgentRecord, JsonRpcRequest } from "../../src/shared/agent-protocol";
import type { Persona, Worker } from "../../src/shared/types";
import type { EventName, WireEvent, WireResponse } from "../../src/shared/wire";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURES = join(ROOT, "test", "fixtures");
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";

let tmp: string;
let home: string;
let repo: string;
let stateDir: string;
let env: NodeJS.ProcessEnv;
/** Every server this test started. */
let servers: Server[];
/** Every child a server recorded, with the command line this run read for it. */
let recorded: Map<number, string>;
let clients: Client[];

interface Server {
  child: ChildProcess;
  port: number;
  output: string[];
  exited: Promise<void>;
}

class Client {
  private nextId = 1;
  private readonly waiting = new Map<number, (res: WireResponse) => void>();
  readonly events: WireEvent[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as WireResponse | WireEvent;
      if (msg.t === "res") this.waiting.get(msg.id)?.(msg);
      else this.events.push(msg);
    });
  }

  static open(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}` } });
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${verb}`)), 20_000);
      this.waiting.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      this.ws.send(JSON.stringify({ t: "req", id, verb, args }));
    });
  }

  async ok<T>(verb: string, args: unknown): Promise<T> {
    const res = await this.request(verb, args);
    if (!res.ok) throw new Error(`${verb} failed: ${res.error}`);
    return res.result as T;
  }

  async event(name: EventName, match: (payload: any) => boolean, ms = 20_000): Promise<any> {
    let found: WireEvent | undefined;
    await until(() => (found = this.events.find((e) => e.name === name && match(e.payload))) !== undefined, `a ${name} event`, ms);
    return found!.payload;
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((r) => {
      this.ws.once("close", () => r());
      this.ws.terminate();
    });
  }
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

beforeAll(() => {
  const bundle = join(ROOT, "dist", "server.js");
  const fresh = existsSync(bundle) && existsSync(join(ROOT, "dist", "web", "index.html")) && statSync(bundle).mtimeMs > newestMtime(join(ROOT, "src"));
  if (!fresh) execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe" });
}, 300_000);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "personas-e2e-"));
  home = join(tmp, "home");
  repo = join(home, "repos", "demo");
  stateDir = join(tmp, "state");
  const bin = join(tmp, "bin");
  mkdirSync(repo, { recursive: true });
  mkdirSync(bin);
  symlinkSync(join(FIXTURES, "fake-claude.mjs"), join(bin, "claude"));
  symlinkSync(join(FIXTURES, "fake-codex.mjs"), join(bin, "codex"));
  // fake-agent.mjs has no shebang: an executable that runs it with this node.
  const adapter = join(bin, "fake-agent");
  writeFileSync(adapter, `#!/bin/sh\nexec ${process.execPath} ${join(FIXTURES, "fake-agent.mjs")} "$@"\n`);
  chmodSync(adapter, 0o755);
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, HOME: home }, stdio: "ignore" });
  };
  git("init", "-q");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "--allow-empty", "-m", "start");
  env = {
    HOME: home,
    XDG_STATE_HOME: join(tmp, "xdg"),
    PERSONAS_STATE_DIR: stateDir,
    PATH: `${bin}:${SYSTEM_PATH}`,
    PERSONAS_ADAPTER_CLAUDE: adapter,
    PERSONAS_ADAPTER_CODEX: adapter,
    // A worker that outlives a killed server (it would otherwise die of the
    // terminal's hangup), so the next start has an orphan to reap.
    FAKE_CLAUDE_IGNORE_HUP: "1",
  };
  servers = [];
  recorded = new Map();
  clients = [];
});

afterEach(async () => {
  // Before the servers go: what they saved, so a failure mid-test cannot leak
  // a child (the fake worker ignores hangups). Signalled below only while its
  // command line is still the one that was saved.
  for (const row of [...personaRows(), ...workerRows()]) {
    if (row.pid !== null && row.cmdline !== null && !recorded.has(row.pid)) recorded.set(row.pid, row.cmdline);
  }
  for (const c of clients) await c.close();
  for (const s of servers) {
    if (s.child.exitCode === null && s.child.signalCode === null) {
      s.child.kill("SIGTERM");
      await Promise.race([s.exited, sleep(5000)]);
      if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill("SIGKILL");
    }
  }
  for (const [pid, cmdline] of recorded) {
    if (cmdlineOf(pid) === cmdline) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Polls an asynchronous check one call at a time. */
async function untilAsync(cond: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

function cmdlineOf(pid: number): string | null {
  try {
    const parts = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    if (parts.at(-1) === "") parts.pop();
    return parts.length === 0 ? null : parts.join(" ");
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers signal 0 but has an empty command line.
  return cmdlineOf(pid) !== null;
}

/** Live processes running this run's claude (its path is in this run's temp folder). */
function liveFakeClaudes(): number[] {
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = cmdlineOf(Number(entry));
    if (cmdline?.includes(`${join(tmp, "bin", "claude")} `)) found.push(Number(entry));
  }
  return found;
}

async function startServer(): Promise<Server> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "dist", "server.js")], {
    cwd: ROOT,
    env: { ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout!.on("data", (d) => output.push(String(d)));
  child.stderr!.on("data", (d) => output.push(String(d)));
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const server: Server = { child, port, output, exited };
  servers.push(server);
  await until(() => output.join("").includes("Personas listening on"), `the server to listen (output: ${output.join("")})`, 15_000);
  return server;
}

function readTable<T>(name: string): T[] {
  try {
    return JSON.parse(readFileSync(join(stateDir, name), "utf8")) as T[];
  } catch {
    return [];
  }
}
const personaRows = (): Persona[] => readTable<Persona>("personas.json");
const workerRows = (): Worker[] => readTable<Worker>("workers.json");

/** Waits until every row with a pid also has its command line saved, then records them with what /proc says now. */
async function recordChildren(): Promise<Array<{ pid: number; cmdline: string }>> {
  let rows: Array<{ pid: number | null; cmdline: string | null }> = [];
  await until(() => {
    rows = [...personaRows(), ...workerRows()].filter((r) => r.pid !== null);
    return rows.every((r) => r.cmdline !== null);
  }, "every child's command line to be saved");
  const out: Array<{ pid: number; cmdline: string }> = [];
  for (const r of rows) {
    const cmdline = cmdlineOf(r.pid!);
    expect(cmdline, `recorded pid ${r.pid} is running what was saved`).toBe(r.cmdline);
    recorded.set(r.pid!, cmdline!);
    out.push({ pid: r.pid!, cmdline: cmdline! });
  }
  return out;
}

function prompt(text: string): JsonRpcRequest {
  return { jsonrpc: "2.0", id: `${randomUUID()}:1`, method: "session/prompt", params: { prompt: [{ type: "text", text }] } };
}

const frames = (client: Client, id: string): AgentRecord[] =>
  client.events.filter((e) => e.name === "persona:frame" && (e.payload as any).id === id).map((e) => (e.payload as any).record as AgentRecord);

const answered = (records: AgentRecord[], id: string | number): boolean =>
  records.some((r) => r.dir === "out" && (r.message as any).result !== undefined && (r.message as any).id === id);

/** The text the persona answered a prompt with: its message chunks between the prompt and its answer. */
function replyText(records: AgentRecord[], promptId: string | number): string {
  const start = records.findIndex((r) => r.dir === "in" && (r.message as any).method === "session/prompt" && (r.message as any).id === promptId);
  let text = "";
  for (const r of records.slice(start + 1)) {
    const m = r.message as any;
    if (r.dir === "out" && m.id === promptId && m.result !== undefined) break;
    const update = m.params?.update;
    if (r.dir === "out" && m.method === "session/update" && update?.sessionUpdate === "agent_message_chunk") text += update.content?.text ?? "";
  }
  return text;
}

const reportIdsOf = (record: AgentRecord): string[] => (record.message as any).params._meta.cube.reportIds as string[];

function isWake(record: AgentRecord): boolean {
  const m = record.message as any;
  return record.dir === "in" && m.method === "session/prompt" && m.params?._meta?.cube?.report === true;
}

/** Sends a prompt, retrying while the persona is busy with another turn, and waits for its answer. */
async function promptAndWait(client: Client, personaId: string, text: string): Promise<JsonRpcRequest> {
  for (;;) {
    const message = prompt(text);
    const res = await client.request("persona:send", { id: personaId, message });
    if (res.ok) {
      await until(() => answered(frames(client, personaId), message.id), `an answer to "${text}"`);
      return message;
    }
    if (!/busy/i.test(res.error)) throw new Error(`persona:send failed: ${res.error}`);
    await sleep(100);
  }
}

async function stopped(server: Server, ms: number): Promise<void> {
  await Promise.race([server.exited, sleep(ms).then(() => { throw new Error(`the server did not exit within ${ms} ms`); })]);
}

test("the whole loop: spawn, report, ack, artifact, stop, restart, kill, reap", async () => {
  // --- first run: a persona spawns a worker whose report wakes it --------------
  let server = await startServer();
  let client = await Client.open(server.port);
  const persona = await client.ok<Persona>("persona:create", { harness: "claude" });
  await client.event("persona:state", (p) => p.id === persona.id && p.state === "ready");

  const spawnText = `mcp:spawn_agent ${JSON.stringify({ harness: "claude", cwd: repo, prompt: "build it" })}`;
  await promptAndWait(client, persona.id, spawnText);
  let workers: Worker[] = [];
  await untilAsync(async () => {
    workers = await client.ok<Worker[]>("workers:list", { personaId: persona.id });
    return workers.length > 0;
  }, "a worker in workers:list");
  expect(workers).toHaveLength(1);
  const worker = workers[0]!;
  expect(worker.cwd).toBe(repo);

  await until(() => frames(client, persona.id).some((r) => isWake(r) && JSON.stringify(r.message).includes("done: ")), "a wake carrying the report", 10_000);
  const wake = frames(client, persona.id).find(isWake)!;
  const reportIds = reportIdsOf(wake);
  expect(reportIds.length).toBeGreaterThan(0);

  // The control: unacknowledged, the same report is woken again (backoff starts at 1 s).
  await until(
    () => frames(client, persona.id).filter((r) => isWake(r) && reportIdsOf(r).includes(reportIds[0]!)).length >= 2,
    "the unacknowledged report to be woken again",
    5000,
  );

  const ackPrompt = await promptAndWait(client, persona.id, `mcp:list_agents ${JSON.stringify({ ack: reportIds })}`);
  const ackReply = replyText(frames(client, persona.id), ackPrompt.id);
  expect(ackReply).not.toMatch(/^error:/);
  expect(ackReply).toContain(worker.id);
  const wakesAfterAck = frames(client, persona.id).filter(isWake).length;
  await sleep(3000);
  expect(frames(client, persona.id).filter(isWake).length).toBe(wakesAfterAck);

  const html = "<!doctype html><title>demo</title><p>built</p>\n";
  writeFileSync(join(repo, "result.html"), html);
  const artifact = await fetch(`http://127.0.0.1:${server.port}/artifact?persona=${persona.id}&path=${encodeURIComponent(join(repo, "result.html"))}`);
  expect(artifact.status).toBe(200);
  expect(await artifact.text()).toBe(html);

  // --- SIGTERM: every child ends with the server --------------------------------
  const firstChildren = await recordChildren();
  const firstWorker = workerRows().find((w) => w.id === worker.id)!;
  expect(firstWorker.sessionId).not.toBeNull();
  expect(firstChildren.find((c) => c.pid === firstWorker.pid)!.cmdline).toContain(`--session-id ${firstWorker.sessionId}`);
  expect(firstChildren.length).toBe(2); // the adapter and the worker
  const { seq: seqBefore } = await client.ok<{ seq: number }>("persona:open", { id: persona.id });
  await client.close();
  server.child.kill("SIGTERM");
  const termAt = Date.now();
  await stopped(server, 5000);
  await until(() => firstChildren.every((c) => !alive(c.pid)), "every recorded child to be gone", Math.max(0, 5000 - (Date.now() - termAt)));

  // --- second run: the conversation is back and the worker resumes ---------------
  server = await startServer();
  client = await Client.open(server.port);
  const opened = await client.ok<{ records: AgentRecord[]; seq: number }>("persona:open", { id: persona.id });
  expect(opened.seq).toBeGreaterThanOrEqual(seqBefore);
  expect(JSON.stringify(opened.records)).toContain("mcp:spawn_agent");
  expect(opened.records.some(isWake)).toBe(true);
  await until(() => {
    const row = workerRows().find((w) => w.id === worker.id);
    return row?.pid != null && row.cmdline !== null && row.cmdline.includes(`--resume ${firstWorker.sessionId}`);
  }, "the worker to run again with --resume");
  const resumed = workerRows().find((w) => w.id === worker.id)!;
  expect(alive(resumed.pid!)).toBe(true);
  expect(cmdlineOf(resumed.pid!)).toContain(`--resume ${firstWorker.sessionId}`);
  expect(liveFakeClaudes()).toEqual([resumed.pid]);
  await untilAsync(
    async () => (await client.ok<{ state: string }>("persona:open", { id: persona.id, sinceSeq: opened.seq })).state === "ready",
    "the persona to be ready again",
  );
  // The report was acknowledged before the stop: the restart must not wake the persona with it again.
  await sleep(3000);
  expect(frames(client, persona.id).filter(isWake)).toEqual([]);
  const sinceRestart = await client.ok<{ records: AgentRecord[] }>("persona:open", { id: persona.id, sinceSeq: opened.seq });
  expect(sinceRestart.records.filter(isWake)).toEqual([]);

  // --- SIGKILL: the next start reaps the orphan and runs exactly one worker -------
  const secondChildren = await recordChildren();
  const orphan = secondChildren.find((c) => c.pid === resumed.pid)!;
  expect(orphan).toBeDefined();
  await client.close();
  server.child.kill("SIGKILL");
  await stopped(server, 5000);
  await sleep(300);
  expect(alive(orphan.pid), "the killed server's worker outlives it").toBe(true);

  server = await startServer();
  await until(() => !alive(orphan.pid), "the orphaned worker to be reaped", 10_000);
  expect(server.output.join("")).toContain("Ended 1 process a previous run left running.");
  await until(() => {
    const row = workerRows().find((w) => w.id === worker.id);
    return row?.pid != null && row.pid !== orphan.pid && row.cmdline !== null;
  }, "the worker to run again");
  const third = workerRows().find((w) => w.id === worker.id)!;
  recorded.set(third.pid!, cmdlineOf(third.pid!) ?? "");
  expect(workerRows()).toHaveLength(1);
  expect(liveFakeClaudes()).toEqual([third.pid]);

  server.child.kill("SIGTERM");
  await stopped(server, 5000);
  await until(() => !alive(third.pid!), "the last worker to be gone", 5000);
}, 120_000);
