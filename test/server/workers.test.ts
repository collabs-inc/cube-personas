import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentReport, Worker } from "../../src/shared/types";
import { ProcessManager } from "../../src/server/processes";
import { StateStore } from "../../src/server/state";
import { Spool } from "../../src/server/workers/spool";
import { Workers } from "../../src/server/workers/workers";
import { UserFacingError } from "../../src/server/errors";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const PERSONA = "11111111-2222-4333-8444-555555555555";
// Only system directories after the fixtures: the real claude and codex live elsewhere.
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";

interface Rig {
  root: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  state: StateStore;
  processes: ProcessManager;
  workers: Workers;
  spool: Spool;
  reports: AgentReport[];
  logs: string[];
}

let rig: Rig;

async function makeRig(pathDirs?: string[]): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "personas-workers-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  for (const d of [home, bin, repo]) mkdirSync(d);
  symlinkSync(join(FIXTURES, "fake-claude.mjs"), join(bin, "claude"));
  symlinkSync(join(FIXTURES, "fake-codex.mjs"), join(bin, "codex"));
  execFileSync("git", ["init", "-q", repo]);
  mkdirSync(join(repo, "sub"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(root, "xdg"),
    PERSONAS_STATE_DIR: join(root, "state"),
    PATH: [...(pathDirs ?? [bin]), SYSTEM_PATH].join(":"),
  };
  const logs: string[] = [];
  const state = new StateStore(join(root, "state"), (l) => logs.push(l));
  await state.load();
  const processes = new ProcessManager();
  const workers = new Workers({ processes, state, env, log: (l) => logs.push(l) });
  const reports: AgentReport[] = [];
  workers.onReport((r) => { reports.push(r); });
  const spool = new Spool(state.spoolDir(), (l, p, f) => workers.handleHookReport(l, p, f), (l) => logs.push(l));
  spool.start();
  return { root, repo, env, state, processes, workers, spool, reports, logs };
}

async function until(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const row = (id: string): Worker => rig.state.workers().find((w) => w.id === id)!;

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(UserFacingError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

beforeEach(async () => {
  rig = await makeRig();
});

afterEach(async () => {
  rig.spool.stop();
  await rig.workers.close();
  await rig.processes.killAll();
  rmSync(rig.root, { recursive: true, force: true });
});

describe("Workers", () => {
  test("a claude worker spawned with a prompt reports once and records its session id", async () => {
    const { agentId, status } = await rig.workers.spawn(PERSONA, { harness: "claude", cwd: join(rig.repo, "sub"), prompt: "fix the tests\nthen push" });
    expect(status).toBe("accepted");
    await until(() => rig.reports.length === 1, "the first report");
    await sleep(500);
    expect(rig.reports).toHaveLength(1);
    const report = rig.reports[0]!;
    expect(report).toMatchObject({
      personaId: PERSONA, agentId, kind: "ended", text: "done: fix the tests\nthen push",
      messageUnavailable: false, title: "fix the tests", cwd: join(rig.repo, "sub"),
    });
    expect(report.reportId).toMatch(new RegExp(`^${agentId}:[^:]+\\.json$`));
    const w = row(agentId);
    expect(w.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(w.state).toBe("idle");
    expect(w.lastReportId).toBe(report.reportId);
    expect(w.pid).toBeGreaterThan(0);
    expect(w.cmdline).toContain(join(rig.root, "bin", "claude"));
    expect(w.cmdline).toContain(`--session-id ${w.sessionId}`);
    expect(rig.workers.latestReport(agentId)).toEqual(report);
    expect(rig.workers.attach(agentId).data).toContain("fake-claude");
  });

  test("a long first line is cut at 60 characters for the title; no prompt titles it by harness", async () => {
    const long = "a".repeat(80);
    const { agentId } = await rig.workers.spawn(PERSONA, { harness: "claude", cwd: rig.repo, prompt: long });
    expect(row(agentId).title).toBe("a".repeat(60));
    const idle = await rig.workers.spawn(PERSONA, { harness: "codex", cwd: rig.repo });
    expect(row(idle.agentId).title).toBe("codex");
    expect(row(idle.agentId).state).toBe("idle");
  });

  test("a codex worker's first turn reports: its launch prompt counts as input", async () => {
    const { agentId } = await rig.workers.spawn(PERSONA, { harness: "codex", cwd: rig.repo, prompt: "audit" });
    await until(() => rig.reports.length === 1, "the codex report");
    expect(rig.reports[0]).toMatchObject({ agentId, kind: "ended", text: "done: audit", messageUnavailable: false });
    expect(row(agentId).sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row(agentId).cmdline).toContain(join(rig.root, "bin", "codex"));
  });

  test("a codex turn after only the person's own typing does not report", async () => {
    const { agentId } = await rig.workers.spawn(PERSONA, { harness: "codex", cwd: rig.repo });
    await until(() => rig.workers.attach(agentId).data.includes("ready"), "the codex banner");
    rig.workers.input(agentId, "just looking\r");
    // The dropped turn still tells the app codex's thread id.
    await until(() => row(agentId).sessionId !== null, "the thread id");
    await sleep(300);
    expect(rig.reports).toEqual([]);
  });

  test("send produces a second report, for claude and for codex", async () => {
    const claude = await rig.workers.spawn(PERSONA, { harness: "claude", cwd: rig.repo, prompt: "one" });
    await until(() => rig.reports.length === 1, "claude's first report");
    expect(await rig.workers.send(PERSONA, claude.agentId, "two")).toEqual({ status: "accepted" });
    expect(row(claude.agentId).state).toBe("running");
    await until(() => rig.reports.length === 2, "claude's second report");
    expect(rig.reports[1]).toMatchObject({ agentId: claude.agentId, kind: "ended", text: "done: two" });
    expect(rig.reports[1]!.reportId).not.toBe(rig.reports[0]!.reportId);

    const codex = await rig.workers.spawn(PERSONA, { harness: "codex", cwd: rig.repo, prompt: "three" });
    await until(() => rig.reports.length === 3, "codex's first report");
    // The person's typing does not count; the persona's send does.
    rig.workers.input(codex.agentId, "mine\r");
    await sleep(500);
    expect(rig.reports).toHaveLength(3);
    await rig.workers.send(PERSONA, codex.agentId, "four");
    await until(() => rig.reports.length === 4, "codex's second report");
    expect(rig.reports[3]).toMatchObject({ agentId: codex.agentId, text: "done: four" });
  });

  test("a codex turn whose notify lands after the pty exited still reports after persona input", async () => {
    const { agentId } = await rig.workers.spawn(PERSONA, { harness: "codex", cwd: rig.repo });
    await until(() => rig.workers.attach(agentId).data.includes("ready"), "the banner");
    // Hold the spool so the payload is handled only once the exit has been seen.
    rig.spool.stop();
    await rig.workers.send(PERSONA, agentId, "final: wrap up");
    await until(() => row(agentId).state === "exited", "the exit");
    rig.spool.start();
    await until(() => rig.reports.length === 2, "both reports");
    expect(rig.reports.map((r) => r.kind).sort()).toEqual(["ended", "exited"]);
    expect(rig.reports.find((r) => r.kind === "ended")).toMatchObject({ agentId, text: "done: wrap up" });
  });

  test("a hook payload's spool file stays while a report listener has not settled, or after one throws", async () => {
    const spoolFiles = () => readdirSync(rig.state.spoolDir()).filter((n) => n.endsWith(".json"));
    let hung = 0;
    rig.workers.onReport((r) => {
      if (r.text === "done: hang") { hung++; return new Promise<void>(() => {}); }
      if (r.text === "done: throw") throw new Error("listener failed");
    });
    await rig.workers.spawn(PERSONA, { harness: "claude", cwd: rig.repo, prompt: "hang" });
    await until(() => hung === 1, "the hung listener");
    await sleep(300);
    expect(spoolFiles()).toHaveLength(1);

    await rig.workers.spawn(PERSONA, { harness: "claude", cwd: rig.repo, prompt: "throw" });
    await until(() => rig.reports.some((r) => r.text === "done: throw"), "the throwing listener");
    await sleep(300);
    expect(spoolFiles()).toHaveLength(2);

    await rig.workers.spawn(PERSONA, { harness: "claude", cwd: rig.repo, prompt: "fine" });
    await until(() => rig.reports.some((r) => r.text === "done: fine"), "the settled listener");
    await sleep(300);
    expect(spoolFiles()).toHaveLength(2);
  });

  test("a persona send typed in the middle of a codex turn reports its own turn too", async () => {
    const { agentId } = await rig.workers.spawn(PERSONA, { harness: "codex", cwd: rig.repo });
    await until(() => rig.workers.attach(agentId).data.includes("ready"), "the banner");
    await rig.workers.send(PERSONA, agentId, "slow: alpha");
    // Fully typed while turn alpha still runs, well before alpha's notify.
    await rig.workers.send(PERSONA, agentId, "beta");
    expect(rig.reports).toEqual([]);
    await until(() => rig.reports.length === 2, "both turns' reports");
    expect(rig.reports.map((r) => r.text)).toEqual(["done: alpha", "done: beta"]);
    // With the credit used up, a turn the person types does not report.
    rig.workers.input(agentId, "mine\r");
    await sleep(800);
    expect(rig.reports).toHaveLength(2);
  });

  test("concurrent sends to a codex worker are typed one after the other", async () => {
    const { agentId } = await rig.workers.spawn(PERSONA, { harness: "codex", cwd: rig.repo });
    await until(() => rig.workers.attach(agentId).data.includes("ready"), "the banner");
    await Promise.all([rig.workers.send(PERSONA, agentId, "alpha"), rig.workers.send(PERSONA, agentId, "beta")]);
    await until(() => rig.reports.length === 2, "two reports");
    expect(rig.reports.map((r) => r.text)).toEqual(["done: alpha", "done: beta"]);
  });

  test("a worker that prints nothing still gets its command line recorded", async () => {
    const workers = new Workers({ processes: rig.processes, state: rig.state, env: { ...rig.env, FAKE_CODEX_SILENT: "1" }, log: () => {} });
    try {
      const { agentId } = await workers.spawn(PERSONA, { harness: "codex", cwd: rig.repo });
      await until(() => row(agentId).cmdline !== null, "the command line", 6000);
      expect(row(agentId).cmdline).toContain(join(rig.root, "bin", "codex"));
      expect(workers.attach(agentId).data).toBe("");
    } finally {
      await workers.close();
    }
  });

  test("stop yields one exited report and leaves the worker listed", async () => {
    const { agentId } = await rig.workers.spawn(PERSONA, { harness: "claude", cwd: rig.repo });
    const changes: number[] = [];
    rig.workers.onChange(() => changes.push(Date.now()));
    expect(await rig.workers.stop(PERSONA, agentId)).toEqual({ status: "stopped" });
    await until(() => rig.reports.length === 1, "the exit report");
    expect(rig.reports[0]).toMatchObject({ agentId, kind: "exited", text: "", messageUnavailable: true });
    expect(row(agentId)).toMatchObject({ state: "exited", pid: null });
    expect(rig.workers.list(PERSONA).map((w) => w.id)).toEqual([agentId]);
    expect(rig.workers.attach(agentId).exited).toBe(true);
    expect(changes.length).toBeGreaterThan(0);
    await sleep(200);
    expect(rig.reports).toHaveLength(1);
  });

  test("typing exit ends the worker with its exit code", async () => {
    const { agentId } = await rig.workers.spawn(PERSONA, { harness: "codex", cwd: rig.repo });
    await until(() => rig.workers.attach(agentId).data.includes("ready"), "the banner");
    rig.workers.input(agentId, "exit\r");
    await until(() => rig.reports.length === 1, "the exit report");
    expect(rig.reports[0]).toMatchObject({ kind: "exited", exitCode: 0 });
    expect(row(agentId).exitCode).toBe(0);
  });

  test("refusals are the exact sentences", async () => {
    const plain = join(rig.root, "plain");
    mkdirSync(plain);
    const CWD = "cwd must be an absolute path inside a git checkout.";
    expect(await refusal(rig.workers.spawn(PERSONA, { harness: "claude", cwd: plain }))).toBe(CWD);
    expect(await refusal(rig.workers.spawn(PERSONA, { harness: "claude", cwd: join(rig.root, "missing") }))).toBe(CWD);
    expect(await refusal(rig.workers.spawn(PERSONA, { harness: "claude", cwd: "repo" }))).toBe(CWD);
    expect(await refusal(rig.workers.spawn(PERSONA, { harness: "opencode", cwd: rig.repo })))
      .toBe("opencode cannot be a worker: it runs no hook to report through.");
    expect(await refusal(rig.workers.send(PERSONA, "nope", "hi"))).toBe("No such agent.");
    expect(await refusal(rig.workers.stop("99999999-2222-4333-8444-555555555555", "nope"))).toBe("No such agent.");
    expect(rig.state.workers()).toEqual([]);
  });

  test("a harness missing from PATH is not available", async () => {
    const empty = join(rig.root, "empty-bin");
    mkdirSync(empty);
    const workers = new Workers({ processes: rig.processes, state: rig.state, env: { ...rig.env, PATH: `${empty}:${SYSTEM_PATH}` }, log: () => {} });
    expect(await refusal(workers.spawn(PERSONA, { harness: "claude", cwd: rig.repo }))).toBe("claude is not available on this machine.");
    expect(await refusal(workers.spawn(PERSONA, { harness: "codex", cwd: rig.repo }))).toBe("codex is not available on this machine.");
  });

  test("close leaves rows resumable; resumeAll resumes, relaunches idle, reports an interrupted turn, and never duplicates", async () => {
    const claude = await rig.workers.spawn(PERSONA, { harness: "claude", cwd: rig.repo, prompt: "first" });
    const codex = await rig.workers.spawn(PERSONA, { harness: "codex", cwd: rig.repo });
    await until(() => rig.reports.length === 1 && row(claude.agentId).cmdline !== null && row(codex.agentId).cmdline !== null, "both started");
    const sessionId = row(claude.agentId).sessionId!;
    const oldPid = row(claude.agentId).pid;
    // Mark claude mid-turn, as a server stopped during its turn would leave it.
    await rig.state.putWorker({ ...row(claude.agentId), state: "running" });
    rig.spool.stop();
    await rig.workers.close();
    expect(row(claude.agentId).state).toBe("running");
    expect(row(codex.agentId).state).toBe("idle");
    expect(rig.reports).toHaveLength(1);

    const workers = new Workers({ processes: rig.processes, state: rig.state, env: rig.env, log: () => {} });
    const reports: AgentReport[] = [];
    workers.onReport((r) => { reports.push(r); });
    rig.workers = workers;
    await workers.resumeAll();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ agentId: claude.agentId, kind: "interrupted", text: "", messageUnavailable: true });
    await until(() => row(claude.agentId).cmdline !== null && row(codex.agentId).cmdline !== null, "both relaunched");
    expect(row(claude.agentId).pid).not.toBe(oldPid);
    expect(row(claude.agentId).cmdline).toContain(`--resume ${sessionId}`);
    expect(row(claude.agentId).state).toBe("idle");
    expect(row(codex.agentId).cmdline).not.toContain(" resume ");
    expect(workers.attach(claude.agentId).data).toContain("fake-claude");

    const pids = rig.state.workers().map((w) => w.pid);
    await workers.resumeAll();
    expect(rig.state.workers().map((w) => w.pid)).toEqual(pids);
    expect(reports).toHaveLength(1);
  });

  test("a codex worker keeps the user's own developer_instructions ahead of the artifact instruction", async () => {
    const codexHome = join(rig.root, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), 'developer_instructions = "Always answer in French."\n');
    rig.env.CODEX_HOME = codexHome;
    const { agentId } = await rig.workers.spawn(PERSONA, { harness: "codex", cwd: rig.repo });
    await until(() => (row(agentId)?.cmdline ?? null) !== null, "the codex command line");
    const cmd = row(agentId).cmdline!;
    const at = cmd.indexOf("developer_instructions=");
    expect(at).toBeGreaterThan(-1);
    expect(cmd.slice(at)).toMatch(/^developer_instructions="Always answer in French\.\\n\\n/);
  });

  test("another persona's worker is no such agent", async () => {
    const { agentId } = await rig.workers.spawn(PERSONA, { harness: "claude", cwd: rig.repo });
    const other = "99999999-2222-4333-8444-555555555555";
    expect(await refusal(rig.workers.send(other, agentId, "hi"))).toBe("No such agent.");
    expect(rig.workers.list(other)).toEqual([]);
  });
});

describe("a persona deleted, or the server stopping, while a worker spawns", () => {
  function gated(alive: () => boolean): Workers {
    return new Workers({ processes: rig.processes, state: rig.state, env: rig.env, log: (l) => rig.logs.push(l), personaAlive: alive });
  }

  test("a persona deleted during the checkout check gets no row and no pty", async () => {
    let alive = true;
    const workers = gated(() => alive);
    const ptys = vi.spyOn(rig.processes, "spawnPty");
    const spawning = workers.spawn(PERSONA, { harness: "claude", cwd: rig.repo, prompt: "hi" });
    alive = false;
    expect(await refusal(spawning)).toBe("No such persona.");
    expect(rig.state.workers()).toEqual([]);
    expect(ptys).not.toHaveBeenCalled();
    await workers.close();
  });

  test("a shutdown that begins during the checkout check spawns nothing", async () => {
    const workers = gated(() => true);
    const ptys = vi.spyOn(rig.processes, "spawnPty");
    const spawning = workers.spawn(PERSONA, { harness: "claude", cwd: rig.repo, prompt: "hi" });
    await workers.close();
    expect(await refusal(spawning)).toBe("Personas is shutting down.");
    expect(ptys).not.toHaveBeenCalled();
  });

  test("stopOrphans ends a live worker whose row is gone", async () => {
    const { agentId } = await rig.workers.spawn(PERSONA, { harness: "claude", cwd: rig.repo });
    await until(() => (row(agentId)?.pid ?? null) !== null, "the worker's pid");
    const pid = row(agentId).pid!;
    await rig.state.removeWorkersOf(PERSONA);
    await rig.workers.stopOrphans();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("resumeAll removes a row whose persona no longer exists, and launches nothing for it", async () => {
    const { agentId } = await rig.workers.spawn(PERSONA, { harness: "claude", cwd: rig.repo });
    await rig.workers.close();
    const ptys = vi.spyOn(rig.processes, "spawnPty");
    const workers = gated(() => false);
    await workers.resumeAll();
    expect(rig.state.workers().find((w) => w.id === agentId)).toBeUndefined();
    expect(ptys).not.toHaveBeenCalled();
    expect(rig.logs.some((l) => l.includes("its persona no longer exists"))).toBe(true);
    await workers.close();
  });
});
