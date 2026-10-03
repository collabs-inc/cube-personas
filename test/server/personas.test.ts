import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startApp, type App } from "../../src/server/app";
import { RESUME_FAILED, SHUTTING_DOWN } from "../../src/server/personas";
import { ProcessManager } from "../../src/server/processes";
import { Workers } from "../../src/server/workers/workers";
import { BUSY_MARKER, isRequest, isResponse, type AgentRecord, type JsonRpcRequest } from "../../src/shared/agent-protocol";
import type { Persona, Worker } from "../../src/shared/types";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
// Only system directories after the fixtures: the real claude and codex live elsewhere.
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";
const ENV_KEYS = ["HOME", "XDG_STATE_HOME", "PERSONAS_STATE_DIR", "PATH", "PORT", "PERSONAS_ADAPTER_CLAUDE", "PERSONAS_ADAPTER_CODEX"];

let root: string;
let home: string;
let repo: string;
let stateDir: string;
let adapter: string;
let savedEnv: Record<string, string | undefined>;
let apps: App[];
/** Processes this test file started itself (the orphan stand-ins). */
let ours: ChildProcess[];
let logs: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "personas-app-"));
  home = join(root, "home");
  const bin = join(root, "bin");
  repo = join(root, "repo");
  stateDir = join(root, "state");
  for (const d of [home, bin, repo]) mkdirSync(d);
  symlinkSync(join(FIXTURES, "fake-claude.mjs"), join(bin, "claude"));
  symlinkSync(join(FIXTURES, "fake-codex.mjs"), join(bin, "codex"));
  execFileSync("git", ["init", "-q", repo]);
  // The adapter override names an executable; the fixture is a module, so wrap it.
  adapter = join(root, "fake-adapter");
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
  ours = [];
  logs = [];
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => { logs.push(String(line)); });
});

afterEach(async () => {
  for (const app of apps) await app.close();
  for (const child of ours) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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

async function stop(app: App): Promise<void> {
  await app.close();
  apps.splice(apps.indexOf(app), 1);
}

async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function isRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

const cmdline = (pid: number): string => readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0$/, "").split("\0").join(" ");

function prompt(text: string): JsonRpcRequest {
  return { jsonrpc: "2.0", id: `${randomUUID()}:1`, method: "session/prompt", params: { prompt: [{ type: "text", text }] } };
}

/** Sends a page prompt, waiting out a turn the server is running (a wake) as the page's queue would. */
async function sendWhenReady(app: App, id: string, message: JsonRpcRequest): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await app.services.personas.send(id, message);
      return;
    } catch (err) {
      if (!(err as Error).message.startsWith(BUSY_MARKER) || Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

const personaRow = (app: App, id: string): Persona => app.services.state.personas().find((p) => p.id === id)!;
const workerRows = (app: App): Worker[] => app.services.state.workers();
const records = (app: App, id: string): AgentRecord[] => app.services.personas.open(id).records;

/** The reply text the fake agent gave to the prompt with this id. */
function replyTo(app: App, personaId: string, promptId: string | number): string | null {
  const all = records(app, personaId);
  const at = all.findIndex((r) => r.dir === "in" && isRequest(r.message) && r.message.id === promptId);
  if (at < 0) return null;
  const end = all.findIndex((r, i) => i > at && r.dir === "out" && isResponse(r.message) && r.message.id === promptId);
  if (end < 0) return null;
  return all.slice(at, end)
    .map((r) => (r.message as { params?: { update?: { content?: { text?: string } } } }).params?.update?.content?.text ?? "")
    .join("");
}

function wakes(app: App, id: string): AgentRecord[] {
  return records(app, id).filter((r) => r.dir === "in" && isRequest(r.message) && r.message.method === "session/prompt"
    && (r.message.params as { _meta?: { cube?: { report?: boolean } } })._meta?.cube?.report === true);
}

describe("Personas and the app", () => {
  test("create, spawn a worker, deliver and acknowledge its report, survive two restarts, delete", async () => {
    let app = await start();
    const { personas } = app.services;
    const persona = await personas.create("claude");
    expect(persona.state).toBe("starting");
    await until(() => personaRow(app, persona.id).state === "ready", "the persona to be ready");
    const folder = join(home, ".cube", "personas", persona.id);
    expect(existsSync(join(folder, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(folder, "notes"))).toBe(true);
    await until(() => personaRow(app, persona.id).cmdline !== null, "the adapter's command line");
    const adapterPid = personaRow(app, persona.id).pid!;
    expect(personaRow(app, persona.id).cmdline).toContain("fake-agent.mjs");

    const spawnPrompt = prompt(`mcp:spawn_agent ${JSON.stringify({ harness: "claude", cwd: repo, prompt: "hi" })}`);
    await sendWhenReady(app, persona.id, spawnPrompt);
    await until(() => replyTo(app, persona.id, spawnPrompt.id) !== null, "the spawn_agent turn");
    const spawned = JSON.parse(replyTo(app, persona.id, spawnPrompt.id)!) as { agentId: string; status: string };
    expect(spawned.status).toBe("accepted");
    expect(workerRows(app).map((w) => w.id)).toEqual([spawned.agentId]);
    // The reply arrived while nobody had marked it read.
    expect(personaRow(app, persona.id).unread).toBe(true);
    await personas.markRead(persona.id);
    expect(personaRow(app, persona.id).unread).toBe(false);

    // The worker's report wakes the persona.
    await until(() => wakes(app, persona.id).length > 0, "a report wake");
    const pending = app.services.reports.pending(persona.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ agentId: spawned.agentId, kind: "ended", text: "done: hi" });
    const reportId = pending[0]!.reportId;

    const ackPrompt = prompt(`mcp:list_agents ${JSON.stringify({ ack: [reportId] })}`);
    await sendWhenReady(app, persona.id, ackPrompt);
    await until(() => replyTo(app, persona.id, ackPrompt.id) !== null, "the list_agents turn");
    expect(app.services.reports.pending(persona.id)).toEqual([]);
    const listed = JSON.parse(replyTo(app, persona.id, ackPrompt.id)!) as { agents: Array<{ id: string }> };
    expect(listed.agents.map((a) => a.id)).toEqual([spawned.agentId]);

    const before = records(app, persona.id);
    const worker = workerRows(app)[0]!;
    expect(worker.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const workerPid = worker.pid!;
    await stop(app);
    expect(isRunning(adapterPid)).toBe(false);
    expect(isRunning(workerPid)).toBe(false);

    // First restart: the whole conversation, the persona resumed, the worker resumed on its session.
    app = await start();
    expect(records(app, persona.id).slice(0, before.length)).toEqual(before);
    await until(() => personaRow(app, persona.id).state === "ready", "the resumed persona");
    const resumeLoad = records(app, persona.id).find((r) => r.seq > before.length && isRequest(r.message) && r.message.method === "session/load");
    expect(resumeLoad).toBeDefined();
    await until(() => workerRows(app)[0]?.pid != null, "the resumed worker");
    const resumedPid = workerRows(app)[0]!.pid!;
    await until(() => cmdline(resumedPid).includes(`--resume ${worker.sessionId}`), "claude --resume in the worker's argv");
    expect(workerRows(app)).toHaveLength(1);
    // Resuming again in the same run starts nothing twice.
    const launch = app.services.personas.currentLaunch(persona.id);
    const resumedAdapterPid = personaRow(app, persona.id).pid;
    await app.services.personas.resumeAll();
    expect(app.services.personas.currentLaunch(persona.id)).toBe(launch);
    expect(personaRow(app, persona.id).pid).toBe(resumedAdapterPid);
    await app.services.workers.resumeAll();
    expect(workerRows(app)).toHaveLength(1);
    expect(workerRows(app)[0]!.pid).toBe(resumedPid);

    // Second immediate restart: still one worker, resumed again.
    await stop(app);
    app = await start();
    expect(workerRows(app)).toHaveLength(1);
    await until(() => workerRows(app)[0]?.pid != null && workerRows(app)[0]!.pid !== resumedPid, "the worker resumed again");
    const againPid = workerRows(app)[0]!.pid!;
    await until(() => cmdline(againPid).includes(`--resume ${worker.sessionId}`), "claude --resume again");
    await until(() => personaRow(app, persona.id).state === "ready", "the persona resumed again");

    // Delete: everything but the context folder goes.
    const { contextFolder } = await app.services.personas.delete(persona.id);
    expect(contextFolder).toBe(folder);
    expect(existsSync(join(folder, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(stateDir, "records", persona.id))).toBe(false);
    expect(existsSync(join(stateDir, "reports", persona.id))).toBe(false);
    expect(existsSync(join(stateDir, "scrollback", worker.id))).toBe(false);
    expect(app.services.state.personas()).toEqual([]);
    expect(workerRows(app)).toEqual([]);
    expect(JSON.parse(readFileSync(join(stateDir, "personas.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(stateDir, "workers.json"), "utf8"))).toEqual([]);
    await until(() => !isRunning(againPid), "the deleted persona's worker to end");
    expect(() => app.services.personas.open(persona.id)).toThrow("No such persona.");
  }, 120_000);

  test("a turn cut off by a stop is closed as interrupted; an idle worker comes back idle; a failed resume stops the persona", async () => {
    let app = await start();
    const persona = await app.services.personas.create("claude");
    await until(() => personaRow(app, persona.id).state === "ready", "the persona to be ready");
    const spawnPrompt = prompt(`mcp:spawn_agent ${JSON.stringify({ harness: "codex", cwd: repo })}`);
    await sendWhenReady(app, persona.id, spawnPrompt);
    await until(() => replyTo(app, persona.id, spawnPrompt.id) !== null, "the spawn_agent turn");
    const worker = workerRows(app)[0]!;
    expect(worker).toMatchObject({ harness: "codex", state: "idle", sessionId: null });

    // A turn that waits on a permission answer is still running when the server stops.
    const held = prompt("ask:hold");
    await sendWhenReady(app, persona.id, held);
    await until(() => personaRow(app, persona.id).state === "busy", "the held turn");
    await stop(app);

    app = await start();
    const closing = records(app, persona.id).find((r) => r.dir === "out" && isResponse(r.message) && r.message.id === held.id);
    expect(closing?.message).toMatchObject({
      result: { stopReason: "cancelled", _meta: { cube: { interrupted: true, messageUnavailable: true } } },
    });
    await until(() => personaRow(app, persona.id).state === "ready", "the resumed persona");
    await until(() => workerRows(app)[0]?.pid != null, "the codex worker relaunched");
    const relaunched = workerRows(app)[0]!;
    expect(relaunched.state).toBe("idle");
    await until(() => cmdline(relaunched.pid!).includes("codex"), "codex in the argv");
    expect(cmdline(relaunched.pid!)).not.toContain("resume");
    expect(app.services.reports.pending(persona.id)).toEqual([]);

    // An adapter that cannot start: the persona is stopped with the resume sentence, its conversation kept.
    const kept = records(app, persona.id).length;
    await stop(app);
    process.env.PERSONAS_ADAPTER_CLAUDE = join(root, "missing-adapter");
    app = await start();
    await until(() => personaRow(app, persona.id).state === "stopped", "the failed resume");
    expect(personaRow(app, persona.id).failure).toBe(RESUME_FAILED);
    expect(app.services.personas.currentLaunch(persona.id)).toBeNull();
    expect(records(app, persona.id).length).toBeGreaterThanOrEqual(kept);
    expect(app.services.personas.list().map((p) => p.id)).toEqual([persona.id]);

    // Restart starts it again once the adapter is back.
    process.env.PERSONAS_ADAPTER_CLAUDE = adapter;
    await app.services.personas.restart(persona.id);
    expect(personaRow(app, persona.id).state).toBe("ready");
    expect(personaRow(app, persona.id).failure).toBeUndefined();
  }, 120_000);

  test("start ends a previous run's recorded children whose command line still matches, and spares the rest", async () => {
    const spawnSleep = (): ChildProcess => {
      const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
      ours.push(child);
      return child;
    };
    const orphan = spawnSleep();
    const reused = spawnSleep();
    await until(() => cmdline(orphan.pid!) === "sleep 300" && cmdline(reused.pid!) === "sleep 300", "the stand-ins to exec");
    const personaId = randomUUID();
    mkdirSync(stateDir, { recursive: true });
    const row: Persona = {
      id: personaId, name: null, harness: "claude", createdAt: new Date().toISOString(), acpSessionId: null,
      launchId: randomUUID(), pid: orphan.pid!, cmdline: "sleep 300", state: "failed", unread: false,
    };
    const workerRow: Worker = {
      id: randomUUID(), personaId, harness: "claude", cwd: repo, title: "w", sessionId: null, launchId: randomUUID(),
      pid: reused.pid!, cmdline: "claude --session-id x", state: "exited", createdAt: new Date().toISOString(), lastReportId: null,
    };
    writeFileSync(join(stateDir, "personas.json"), JSON.stringify([row]));
    writeFileSync(join(stateDir, "workers.json"), JSON.stringify([workerRow]));

    const app = await start();
    expect(isRunning(orphan.pid!)).toBe(false);
    expect(isRunning(reused.pid!)).toBe(true);
    expect(personaRow(app, personaId)).toMatchObject({ state: "failed", pid: null, cmdline: null, launchId: null });
  }, 60_000);

  test("a start that fails after personas resumed ends their adapters, and the next start runs", async () => {
    const first = await start();
    const persona = await first.services.personas.create("claude");
    await until(() => personaRow(first, persona.id).state === "ready", "the persona to be ready");
    await stop(first);

    const spawnPipe = vi.spyOn(ProcessManager.prototype, "spawnPipe");
    const resume = vi.spyOn(Workers.prototype, "resumeAll").mockRejectedValueOnce(new Error("boom"));
    await expect(startApp()).rejects.toThrow("boom");
    const pids = spawnPipe.mock.results.map((r) => (r.value as { pid: number }).pid);
    expect(pids).toHaveLength(1);
    expect(isRunning(pids[0]!)).toBe(false);
    resume.mockRestore();

    const again = await start();
    await until(() => personaRow(again, persona.id).state === "ready", "the persona to resume");
  });

  test("a first open sends only the log's trailing window; a cut-off turn older than it is still closed", async () => {
    let app = await start();
    const persona = await app.services.personas.create("claude");
    await until(() => personaRow(app, persona.id).state === "ready", "the persona to be ready");
    await stop(app);
    // A turn whose prompt is followed by more updates than memory keeps, cut off before its answer.
    const file = join(stateDir, "records", persona.id, "log.jsonl");
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    let seq = JSON.parse(lines.at(-1)!).seq as number;
    const cut = prompt("long");
    const extra = [JSON.stringify({ seq: ++seq, dir: "in", message: cut })];
    for (let n = 0; n < 6000; n++) {
      extra.push(JSON.stringify({ seq: ++seq, dir: "out", message: { jsonrpc: "2.0", method: "session/update", params: { n } } }));
    }
    writeFileSync(file, readFileSync(file, "utf8") + extra.join("\n") + "\n");

    app = await start();
    await until(() => personaRow(app, persona.id).state === "ready", "the persona to resume");
    const opened = app.services.personas.open(persona.id);
    expect(opened.records.length).toBeLessThanOrEqual(5000);
    expect(opened.startSeq).toBeGreaterThan(0);
    expect(opened.records[0]!.seq).toBe(opened.startSeq + 1);
    expect(opened.records.at(-1)!.seq).toBe(opened.seq);
    const closing = opened.records.find((r) => r.dir === "out" && isResponse(r.message) && r.message.id === cut.id);
    expect(closing?.message).toMatchObject({ result: { stopReason: "cancelled", _meta: { cube: { interrupted: true } } } });
    // A cursor older than the window gets the window; one inside it gets what follows.
    expect(app.services.personas.open(persona.id, 1).startSeq).toBe(opened.startSeq);
    expect(app.services.personas.open(persona.id, opened.seq - 1).records.map((r) => r.seq)).toEqual([opened.seq]);
    expect(readFileSync(file, "utf8").trimEnd().split("\n").length).toBeGreaterThanOrEqual(seq);
  }, 60_000);

  test("a shutdown with an adapter and a worker that both ignore SIGTERM finishes within 7 s", async () => {
    const stubborn = join(root, "stubborn-adapter");
    writeFileSync(stubborn, `#!/bin/sh\ntrap '' TERM\nexec ${process.execPath} ${join(FIXTURES, "fake-agent.mjs")} "$@"\n`);
    chmodSync(stubborn, 0o755);
    process.env.PERSONAS_ADAPTER_CLAUDE = stubborn;
    const bin = join(root, "bin");
    rmSync(join(bin, "claude"));
    writeFileSync(join(bin, "claude"), `#!/bin/sh\ntrap '' TERM\nexec ${process.execPath} ${join(FIXTURES, "fake-claude.mjs")} "$@"\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const app = await start();
    const persona = await app.services.personas.create("claude");
    await until(() => personaRow(app, persona.id).state === "ready", "the persona to be ready");
    await app.services.workers.spawn(persona.id, { harness: "claude", cwd: repo });
    await until(() => workerRows(app)[0]?.pid != null, "the worker's pid");
    const pids = [personaRow(app, persona.id).pid!, workerRows(app)[0]!.pid!];
    const began = Date.now();
    await stop(app);
    expect(Date.now() - began).toBeLessThan(7000);
    for (const pid of pids) expect(isRunning(pid)).toBe(false);
    // Nothing was recorded as ended: the next start resumes both.
    expect(workerRows(app)[0]!.state).not.toBe("exited");
  }, 60_000);

  test("an adapter session whose id cannot be saved fails the start instead of running unrecorded", async () => {
    const app = await start();
    const { state } = app.services;
    const put = state.putPersona.bind(state);
    vi.spyOn(state, "putPersona").mockImplementation(async (p) => {
      if (p.acpSessionId !== null) throw new Error("disk full");
      return put(p);
    });
    const spawnPipe = vi.spyOn(app.services.processes, "spawnPipe");
    const persona = await app.services.personas.create("claude");
    await until(() => personaRow(app, persona.id).state === "failed", "the failed start");
    expect(personaRow(app, persona.id).failure).toBe("This persona could not start. Restart starts it again.");
    expect(personaRow(app, persona.id).acpSessionId).toBeNull();
    const pid = (spawnPipe.mock.results[0]!.value as { pid: number }).pid;
    await until(() => !isRunning(pid), "the adapter to be ended");
  });

  test("an adapter's stderr reaches the log with any bearer ticket cut out", async () => {
    const app = await start();
    const persona = await app.services.personas.create("claude");
    await until(() => personaRow(app, persona.id).state === "ready", "the persona to be ready");
    const ticket = "ab".repeat(32);
    await sendWhenReady(app, persona.id, prompt(`crash:mcp config {"Authorization":"Bearer ${ticket}"}`));
    await until(() => logs.some((l) => l.includes("adapter exited with code 3")), "the exit line");
    const line = logs.find((l) => l.includes("adapter exited with code 3"))!;
    expect(line).not.toContain(ticket);
    expect(line).toContain("Bearer [redacted]");
  });

  test("a state row of the wrong shape is dropped with one line, and the rest still loads", async () => {
    mkdirSync(stateDir, { recursive: true });
    const good: Worker = {
      id: randomUUID(), personaId: randomUUID(), harness: "claude", cwd: repo, title: "w", sessionId: null,
      launchId: randomUUID(), pid: null, cmdline: null, state: "exited", createdAt: new Date().toISOString(), lastReportId: null,
    };
    writeFileSync(join(stateDir, "workers.json"), JSON.stringify([null, {}, { ...good, id: "../x" }, good]));
    writeFileSync(join(stateDir, "personas.json"), JSON.stringify([{ id: randomUUID(), state: 7 }]));
    const app = await start();
    expect(workerRows(app).map((w) => w.id)).toEqual([good.id]);
    expect(app.services.personas.list()).toEqual([]);
    expect(logs.filter((l) => l.includes("workers.json"))).toHaveLength(1);
    expect(logs.filter((l) => l.includes("personas.json"))).toHaveLength(1);
  });

  test("once shutdown begins, nothing new is spawned", async () => {
    const app = await start();
    app.services.personas.beginShutdown();
    await expect(app.services.personas.create("claude")).rejects.toThrow(SHUTTING_DOWN);
    expect(app.services.state.personas()).toEqual([]);
  });
});
