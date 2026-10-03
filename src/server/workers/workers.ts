// Adapted from cube-computer: src/main/cubed/ops/agent-ops.ts (spawn_agent, send_to_agent, stop_agent) and src/main/cubed/personas/terminal-reports.ts
//
// A persona's workers: one pty each, running the real `claude` or `codex`
// with the attention hook, the permission-skip flag and the artifact
// instruction (argv.ts). A turn's end reaches the app through the hook spool
// (spool.ts → handleHookReport), which this turns into an `ended` report; a
// pty's exit becomes an `exited` report. Reports are emitted, not stored:
// the report store and delivery listen through onReport.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { AgentReport, Harness, Worker } from "../../shared/types";
import { NO_SUCH_PERSONA, SHUTTING_DOWN, UserFacingError } from "../errors";
import type { WorkerOps } from "../mcp/tools";
import type { ProcessManager, PtyChild } from "../processes";
import { Scrollback } from "../scrollback";
import type { StateStore } from "../state";
import { ARTIFACT_INSTRUCTION } from "../instructions";
import { withConfigFileInstructions } from "../acp/codex-config";
import { workerArgv } from "./argv";
import { reportFromPayload } from "./report-text";

const execFileAsync = promisify(execFile);

const CWD_REFUSAL = "cwd must be an absolute path inside a git checkout.";
const OPENCODE_REFUSAL = "opencode cannot be a worker: it runs no hook to report through.";
const NO_SUCH_AGENT = "No such agent.";
const NOT_RUNNING = "This agent is not running.";
const TITLE_CHARS = 60;
const COLS = 120;
const ROWS = 32;
/** Codex treats Enter inside its paste burst (120 ms after the last character) as a newline. */
const CODEX_ENTER_DELAY_MS = 300;
/** How often, and for how long, a worker's command line is re-read until it has exec'd. */
const CMDLINE_RETRY_MS = 250;
const CMDLINE_RETRY_FOR_MS = 5000;

export interface WorkersDeps {
  processes: ProcessManager;
  state: StateStore;
  /** The environment workers run in; its PATH is where `claude` and `codex` are looked up. */
  env?: NodeJS.ProcessEnv;
  /** The latest report for a worker (the report store's); defaults to the last one emitted in this run. */
  latestReport?: (agentId: string) => AgentReport | null;
  log?: (line: string) => void;
  /**
   * Whether a persona may still have workers: it exists, is not being
   * deleted, and the server is not shutting down. Checked again after every
   * await in a spawn, so a delete or a shutdown that lands meanwhile wins.
   * Defaults to always.
   */
  personaAlive?: (personaId: string) => boolean;
}

interface Live {
  child: PtyChild;
  /** Unique per launch; names the launch's exit report. */
  generation: string;
}

export class Workers implements WorkerOps {
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;
  private readonly live = new Map<string, Live>();
  private readonly scrollbacks = new Map<string, Scrollback>();
  private readonly latest = new Map<string, AgentReport>();
  /** Report ids already handled, so one spool file never yields two reports. */
  private readonly handled = new Set<string>();
  /** Per-worker queue, so a turn report still reading its transcript precedes a later exit. */
  private readonly chains = new Map<string, Promise<void>>();
  /**
   * Codex's rule: persona inputs (the launch prompt, each send_to_agent) not
   * yet answered by a reported turn. Kept per worker, not per launch, so a
   * turn whose notify lands after the pty exited still reports; counted, so
   * a second send typed before the first turn's report is processed is not
   * swallowed by it.
   */
  private readonly personaInputs = new Map<string, number>();
  /** Per-worker queue of send_to_agent writes, so codex's delayed Enter never interleaves two prompts. */
  private readonly typing = new Map<string, Promise<void>>();
  private readonly changeListeners: Array<() => void> = [];
  private readonly outputListeners: Array<(id: string, data: string) => void> = [];
  private readonly reportListeners: Array<(report: AgentReport) => void | Promise<void>> = [];
  private closing = false;

  constructor(private readonly deps: WorkersDeps) {
    this.env = deps.env ?? process.env;
    this.log = deps.log ?? ((line) => console.warn(line));
  }

  onChange(cb: () => void): void { this.changeListeners.push(cb); }
  onOutput(cb: (id: string, data: string) => void): void { this.outputListeners.push(cb); }
  /** A listener may return a promise; a hook payload's spool file is kept until every listener has settled successfully. */
  onReport(cb: (report: AgentReport) => void | Promise<void>): void { this.reportListeners.push(cb); }

  list(personaId: string): Worker[] {
    return this.deps.state.workers().filter((w) => w.personaId === personaId);
  }

  latestReport(agentId: string): AgentReport | null {
    return this.deps.latestReport?.(agentId) ?? this.latest.get(agentId) ?? null;
  }

  async spawn(personaId: string, args: { harness: string; cwd: string; prompt?: string }): Promise<{ agentId: string; status: "accepted" }> {
    if (args.harness === "opencode") throw new UserFacingError(OPENCODE_REFUSAL);
    if (args.harness !== "claude" && args.harness !== "codex") throw new UserFacingError('harness must be "claude" or "codex".');
    const harness: Harness = args.harness;
    await this.assertCheckout(args.cwd);
    const command = this.resolve(harness);
    const codexInstructions = harness === "codex" ? await this.codexInstructions() : undefined;
    this.assertAlive(personaId);
    const prompt = args.prompt ?? null;
    // A claude session id is minted here, but recorded only once a
    // conversation exists to resume: a launch with no prompt has none until
    // its first turn ends, and its Stop payload records it then.
    const sessionId = harness === "claude" ? randomUUID() : null;
    const worker: Worker = {
      id: randomUUID(),
      personaId,
      harness,
      cwd: args.cwd,
      title: titleOf(prompt, harness),
      sessionId: prompt !== null ? sessionId : null,
      launchId: randomUUID(),
      pid: null,
      cmdline: null,
      state: prompt !== null ? "running" : "idle",
      createdAt: new Date().toISOString(),
      lastReportId: null,
    };
    this.scrollbacks.set(worker.id, new Scrollback(this.deps.state.scrollbackPath(worker.id)));
    await this.deps.state.putWorker(worker);
    this.changed();
    try {
      // The row is the persona's now: a delete that began meanwhile removes it with the rest.
      this.assertAlive(personaId);
      this.launch(worker, command, { prompt, sessionId, resume: false, codexInstructions });
    } catch (err) {
      this.log(`worker ${worker.id}: could not start ${harness}: ${String(err)}`);
      await this.update(worker.id, { state: "exited", pid: null, cmdline: null });
      throw err;
    }
    return { agentId: worker.id, status: "accepted" };
  }

  async send(personaId: string, agentId: string, prompt: string): Promise<{ status: "accepted" }> {
    const worker = this.owned(personaId, agentId);
    if (!this.live.has(agentId)) throw new UserFacingError(NOT_RUNNING);
    // A pty has no admission control: there is nothing to ask whether the
    // harness is mid-turn, so this always reports accepted.
    const typed = (this.typing.get(agentId) ?? Promise.resolve()).then(async () => {
      const live = this.live.get(agentId);
      if (!live) return;
      this.personaInputs.set(agentId, (this.personaInputs.get(agentId) ?? 0) + 1);
      void this.update(agentId, { state: "running" });
      if (worker.harness === "codex") {
        live.child.write(prompt);
        await new Promise((r) => setTimeout(r, CODEX_ENTER_DELAY_MS));
        live.child.write("\r");
      } else {
        live.child.write(`${prompt}\r`);
      }
    });
    // One failed write must not reject every later send to this worker.
    this.typing.set(agentId, typed.catch(() => {}));
    await typed;
    return { status: "accepted" };
  }

  async stop(personaId: string, agentId: string): Promise<{ status: "stopped" }> {
    this.owned(personaId, agentId);
    await this.live.get(agentId)?.child.kill();
    return { status: "stopped" };
  }

  /** The trailing output for a terminal attaching, and whether the worker's process has ended. */
  attach(id: string): { data: string; exited: boolean } {
    if (!this.row(id)) throw new UserFacingError(NO_SUCH_AGENT);
    return { data: this.scrollbacks.get(id)?.text() ?? "", exited: !this.live.has(id) };
  }

  /** The person's own typing: never counted as the persona's input. */
  input(id: string, data: string): void {
    this.live.get(id)?.child.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
    this.live.get(id)?.child.resize(cols, rows);
  }

  /**
   * After a restart: relaunch every worker recorded as running or idle. One
   * with a session id resumes it; one without opens idle with nothing typed.
   * A worker recorded mid-turn first gets an `interrupted` report. A worker
   * already live in this run is skipped, so calling this twice is harmless.
   */
  async resumeAll(): Promise<void> {
    for (const worker of this.deps.state.workers()) {
      if (!this.scrollbacks.has(worker.id)) {
        try {
          const scrollback = new Scrollback(this.deps.state.scrollbackPath(worker.id));
          await scrollback.load().catch((err) => this.log(`worker ${worker.id}: saved output unreadable: ${String(err)}`));
          this.scrollbacks.set(worker.id, scrollback);
        } catch (err) {
          this.log(`worker ${String(worker.id).slice(0, 64)}: skipped: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }
      if (worker.state === "exited" || this.live.has(worker.id)) continue;
      if (!this.alive(worker.personaId)) {
        // Its persona is gone: nothing would show it, and nothing could stop it.
        this.log(`worker ${worker.id}: its persona no longer exists; its row was removed.`);
        await this.deps.state.removeWorker(worker.id).catch((err) => this.log(`worker ${worker.id}: could not remove its row: ${String(err)}`));
        continue;
      }
      if (worker.state === "running") {
        const reportId = `${worker.id}:interrupted:${worker.lastReportId ?? "launch"}`;
        if (!this.handled.has(reportId)) {
          this.handled.add(reportId);
          try {
            await this.emit(this.report(worker, reportId, "interrupted", "", true), { state: "idle" });
          } catch (err) {
            this.log(`worker ${worker.id}: interrupted report failed: ${String(err)}`);
          }
        }
      }
      try {
        const command = this.resolve(worker.harness);
        if (!isDirectory(worker.cwd)) throw new Error("its checkout is gone");
        const sessionId = worker.harness === "claude" ? (worker.sessionId ?? randomUUID()) : worker.sessionId;
        const codexInstructions = worker.harness === "codex" ? await this.codexInstructions() : undefined;
        await this.update(worker.id, { state: "idle" });
        this.launch(this.row(worker.id)!, command, { prompt: null, sessionId, resume: worker.sessionId !== null, codexInstructions });
      } catch (err) {
        this.log(`worker ${worker.id}: could not be resumed: ${err instanceof Error ? err.message : String(err)}`);
        await this.update(worker.id, { state: "exited", pid: null, cmdline: null });
      }
    }
  }

  /**
   * The spool's callback. A payload names its worker by launch id; one for a
   * launch this app does not know is ignored.
   */
  handleHookReport(launchId: string, payload: unknown, file: string): Promise<void> {
    const worker = this.deps.state.workers().find((w) => w.launchId === launchId);
    if (!worker) return Promise.resolve();
    const reportId = `${worker.id}:${file}`;
    if (this.handled.has(reportId)) return Promise.resolve();
    this.handled.add(reportId);
    return this.enqueue(worker.id, async () => {
      const parsed = await reportFromPayload(worker.harness, payload);
      if (parsed.kind !== "turn-ended") return;
      const current = this.row(worker.id);
      if (!current) return;
      const patch: Partial<Worker> = {};
      if (parsed.sessionId && parsed.sessionId !== current.sessionId) patch.sessionId = parsed.sessionId;
      if (current.state === "running") patch.state = "idle";
      // Codex reports a turn only after the persona's own input since the last one.
      const inputs = this.personaInputs.get(worker.id) ?? 0;
      if (current.harness === "codex" && inputs === 0) {
        if (Object.keys(patch).length > 0) await this.update(worker.id, patch, true);
        return;
      }
      // Exactly one credit per reported turn. Credit left over from sends
      // codex merged into one turn (or an aborted turn) can let a later turn
      // the person typed report; that is accepted over ever losing a
      // persona send's report.
      this.personaInputs.set(worker.id, Math.max(0, inputs - 1));
      await this.emit(this.report(current, reportId, "ended", parsed.text, parsed.messageUnavailable), patch);
    });
  }

  /** Ends every live worker whose row is gone (its persona was deleted while it spawned). */
  async stopOrphans(): Promise<void> {
    const orphans = [...this.live.entries()].filter(([id]) => !this.row(id));
    await Promise.all(orphans.map(([, l]) => l.child.kill()));
  }

  /**
   * Ends every live worker for a server shutdown WITHOUT recording their
   * exits: their rows stay running or idle so the next start resumes them.
   */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.live.values()].map((l) => l.child.kill()));
    await Promise.all([...this.scrollbacks.values()].map((s) => s.flush().catch(() => {})));
    // Bounded: a report listener that never settles must not hold up shutdown.
    await Promise.race([Promise.all([...this.chains.values()]), new Promise((r) => setTimeout(r, 1000).unref())]);
  }

  /** Codex's `-c developer_instructions=` replaces the user's own value, so it restates it first. */
  private codexInstructions(): Promise<string> {
    return withConfigFileInstructions(this.env, ARTIFACT_INSTRUCTION, { readFile: (p) => readFile(p, "utf8"), warn: this.log });
  }

  private launch(
    worker: Worker,
    command: string,
    opts: { prompt: string | null; sessionId: string | null; resume: boolean; codexInstructions?: string },
  ): void {
    const { args } = workerArgv({
      harness: worker.harness, spoolDir: this.deps.state.spoolDir(), launchId: worker.launchId, ...opts,
    });
    const child = this.deps.processes.spawnPty({ command, args, cwd: worker.cwd, env: this.env, cols: COLS, rows: ROWS });
    const live: Live = { child, generation: randomUUID() };
    this.personaInputs.set(worker.id, opts.prompt !== null ? 1 : 0);
    this.live.set(worker.id, live);
    let scrollback = this.scrollbacks.get(worker.id);
    if (!scrollback) {
      scrollback = new Scrollback(this.deps.state.scrollbackPath(worker.id));
      this.scrollbacks.set(worker.id, scrollback);
    }
    const output = scrollback;

    // node-pty's forked child shows the server's own argv until it execs,
    // so the command line is read on first output and re-read every 250 ms
    // for up to 5 s until it no longer looks like the server's fork.
    const parent = this.deps.processes.cmdlineOf(process.pid);
    let recorded = false;
    const recordCmdline = (): void => {
      if (recorded || this.live.get(worker.id) !== live) return;
      const cmdline = this.deps.processes.cmdlineOf(child.pid);
      if (cmdline === null || cmdline === parent) return;
      recorded = true;
      void this.update(worker.id, { cmdline });
    };
    const retryUntil = Date.now() + CMDLINE_RETRY_FOR_MS;
    const retry = setInterval(() => {
      recordCmdline();
      if (recorded || Date.now() >= retryUntil || this.live.get(worker.id) !== live) clearInterval(retry);
    }, CMDLINE_RETRY_MS);
    retry.unref();

    child.onData((data) => {
      output.push(data);
      recordCmdline();
      for (const cb of this.outputListeners) cb(worker.id, data);
    });
    child.onExit((code) => {
      clearInterval(retry);
      this.exited(worker.id, live, code);
    });
    void this.update(worker.id, { pid: child.pid, cmdline: null });
  }

  private exited(id: string, live: Live, code: number | null): void {
    if (this.live.get(id) !== live) return;
    this.live.delete(id);
    void this.scrollbacks.get(id)?.flush().catch((err) => this.log(`worker ${id}: could not save output: ${String(err)}`));
    if (this.closing) return;
    const exit: Partial<Worker> = { state: "exited", pid: null, cmdline: null, ...(code === null ? {} : { exitCode: code }) };
    // A failure is logged by the chain; an exit has no spool file to keep.
    this.enqueue(id, async () => {
      const worker = this.row(id);
      if (!worker) return;
      const report = this.report(worker, `${id}:exit:${live.generation}`, "exited", "", true);
      await this.emit(code === null ? report : { ...report, exitCode: code }, exit);
    }).catch(() => {});
  }

  private report(worker: Worker, reportId: string, kind: AgentReport["kind"], text: string, messageUnavailable: boolean): AgentReport {
    return {
      reportId, personaId: worker.personaId, agentId: worker.id, kind, text, messageUnavailable,
      title: worker.title, cwd: worker.cwd, at: new Date().toISOString(),
    };
  }

  private async emit(report: AgentReport, patch: Partial<Worker>): Promise<void> {
    this.latest.set(report.agentId, report);
    await this.update(report.agentId, { ...patch, lastReportId: report.reportId }, true);
    const results = await Promise.allSettled(this.reportListeners.map(async (cb) => cb(report)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw new Error(`a report listener failed: ${String(failed.reason)}`);
  }

  /**
   * Runs `task` after the worker's earlier ones. The returned promise
   * rejects when the task fails (so the spool keeps the payload); the chain
   * itself logs and continues.
   */
  private enqueue(id: string, task: () => Promise<void>): Promise<void> {
    const run = (this.chains.get(id) ?? Promise.resolve()).then(task);
    this.chains.set(id, run.catch((err) => this.log(`worker ${id}: report failed: ${String(err)}`)));
    return run;
  }

  /**
   * Read-modify-write is synchronous up to putWorker, which takes the new
   * row at once. A failed save is logged, or with `strict` rethrown.
   */
  private async update(id: string, patch: Partial<Worker>, strict = false): Promise<void> {
    const current = this.row(id);
    if (!current) return;
    const next: Worker = { ...current, ...patch };
    if (patch.state !== undefined && patch.state !== "exited") delete next.exitCode;
    try {
      await this.deps.state.putWorker(next);
    } catch (err) {
      this.log(`worker ${id}: could not save its state: ${String(err)}`);
      if (strict) throw err;
    }
    this.changed();
  }

  private changed(): void {
    for (const cb of this.changeListeners) {
      try {
        cb();
      } catch (err) {
        this.log(`change listener failed: ${String(err)}`);
      }
    }
  }

  private row(id: string): Worker | undefined {
    return this.deps.state.workers().find((w) => w.id === id);
  }

  private alive(personaId: string): boolean {
    return !this.closing && (this.deps.personaAlive?.(personaId) ?? true);
  }

  private assertAlive(personaId: string): void {
    if (this.closing) throw new UserFacingError(SHUTTING_DOWN);
    if (!(this.deps.personaAlive?.(personaId) ?? true)) throw new UserFacingError(NO_SUCH_PERSONA);
  }

  private owned(personaId: string, id: string): Worker {
    const worker = this.row(id);
    if (!worker || worker.personaId !== personaId) throw new UserFacingError(NO_SUCH_AGENT);
    return worker;
  }

  private async assertCheckout(cwd: string): Promise<void> {
    if (typeof cwd !== "string" || !isAbsolute(cwd) || !isDirectory(cwd)) throw new UserFacingError(CWD_REFUSAL);
    try {
      await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { env: this.env, timeout: 10_000 });
    } catch {
      throw new UserFacingError(CWD_REFUSAL);
    }
  }

  /** The harness's absolute path on PATH. */
  private resolve(harness: Harness): string {
    for (const dir of (this.env.PATH ?? "").split(":")) {
      if (!isAbsolute(dir)) continue;
      const candidate = join(dir, harness);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    throw new UserFacingError(`${harness} is not available on this machine.`);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The prompt's first line, cut at 60 characters, or the harness name. */
function titleOf(prompt: string | null, harness: Harness): string {
  const first = (prompt ?? "").split(/\r?\n/)[0]!.trim();
  return first ? Array.from(first).slice(0, TITLE_CHARS).join("") : harness;
}
