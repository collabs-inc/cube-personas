// Every child the server starts goes through here: ACP adapters on plain
// stdio pipes, workers on ptys. Each child leads its own process group
// (pipes are spawned `detached`; node-pty `setsid`s its child), so a kill
// signals the whole group and takes grandchildren with it — and so killing
// the server's own group does NOT reach them. That is why `killAll()` must
// run before the server exits, and why `reapOrphans()` exists for a server
// that died without running it.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import * as pty from "node-pty";
import { MAX_PIPE_LINE_BYTES } from "../shared/agent-protocol";

const KILL_GRACE_MS = 3000;
const POLL_MS = 25;
const STDERR_TAIL_BYTES = 8192;

export interface PipeChild {
  pid: number;
  /** Writes one line to the child's stdin; a trailing newline is added when missing. */
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): Promise<void>;
  stderrTail(): string;
}

export interface PtyChild {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): Promise<void>;
}

function signal(target: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
}

/** True while any process is in group `pgid` (a zombie leader counts until it is reaped). */
function groupExists(pgid: number): boolean {
  return signal(-pgid, 0);
}

/**
 * Field 22 of `/proc/<pid>/stat`, the process's start time in clock ticks
 * since boot: together with the pid it names one process for the life of
 * the system. Null where there is no /proc, or no such process.
 */
export function procStartTime(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the command name (which may itself hold spaces and parens) start at field 3.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** How often a group that outlived its leader is checked for having emptied. */
const LINGER_POLL_MS = 1000;

/** True while `pid` runs and has not yet ended (a zombie has ended). */
function isRunning(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
    } catch {
      return false;
    }
  }
  return signal(pid, 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
  return true;
}

/**
 * SIGTERM to the group a managed child leads, up to 3 s for the leader to be
 * reaped and the group to empty, then SIGKILL to whatever is left.
 *
 * Only ever the GROUP is signalled, never the bare pid, and only while the
 * group still exists: a group id cannot be handed to a new process while any
 * member holds it, so a live group is still ours. Once the child has been
 * reaped and its group is empty, nothing is sent — that pid may already
 * belong to an unrelated process. Where /proc exists, the leader's start
 * time recorded at spawn is checked too (`ours`): a pid that now names a
 * different process means the group emptied and its number was reissued,
 * even for a moment, so nothing is sent.
 */
async function killGroup(pid: number, reaped: () => boolean, ours: () => boolean, graceMs = KILL_GRACE_MS): Promise<void> {
  if (pid <= 0) return;
  const done = () => (reaped() && !groupExists(pid)) || !ours();
  const send = (sig: NodeJS.Signals) => {
    if (groupExists(pid) && ours()) signal(-pid, sig);
  };
  if (done()) return;
  send("SIGTERM");
  if (await waitFor(done, graceMs)) return;
  send("SIGKILL");
  await waitFor(done, KILL_GRACE_MS);
}

/**
 * Ends a previous run's child, signalling it only while it is still running
 * the recorded command line — checked again immediately before each signal,
 * so a pid that exits and is handed to another program mid-grace is spared.
 * Returns false when the first check already fails.
 */
async function killRecorded(pid: number, still: () => boolean): Promise<boolean> {
  const send = (sig: NodeJS.Signals): boolean => {
    if (!still()) return false;
    // Recorded children led their own groups; signalling the group ends their descendants too.
    // A process that does not lead a group is signalled alone, right after the check above.
    if (!signal(-pid, sig)) signal(pid, sig);
    return true;
  };
  if (!send("SIGTERM")) return false;
  if (await waitFor(() => !isRunning(pid), KILL_GRACE_MS)) return true;
  send("SIGKILL");
  await waitFor(() => !isRunning(pid), KILL_GRACE_MS);
  return true;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** Calls listeners added before and after the event: an exit that already happened still reaches a late `onExit`. */
class ExitSignal {
  private code: number | null | undefined = undefined;
  private listeners: Array<(code: number | null) => void> = [];
  get fired(): boolean {
    return this.code !== undefined;
  }
  add(cb: (code: number | null) => void): void {
    if (this.code !== undefined) queueMicrotask(() => cb(this.code as number | null));
    else this.listeners.push(cb);
  }
  fire(code: number | null): void {
    if (this.code !== undefined) return;
    this.code = code;
    for (const cb of this.listeners.splice(0)) cb(code);
  }
}

/** Splits a byte stream on `\n`, dropping (with one log line each) any line longer than MAX_PIPE_LINE_BYTES. */
class LineSplitter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private dropping = false;

  constructor(
    private readonly emit: (line: string) => void,
    private readonly label: string,
  ) {}

  push(chunk: Buffer): void {
    let at = 0;
    while (at < chunk.length) {
      const nl = chunk.indexOf(0x0a, at);
      const end = nl === -1 ? chunk.length : nl;
      const piece = chunk.subarray(at, end);
      if (!this.dropping) {
        if (this.pendingBytes + piece.length > MAX_PIPE_LINE_BYTES) {
          console.warn(`${this.label}: dropped an output line over ${MAX_PIPE_LINE_BYTES} bytes`);
          this.dropping = true;
          this.pending = [];
          this.pendingBytes = 0;
        } else if (piece.length > 0) {
          this.pending.push(Buffer.from(piece));
          this.pendingBytes += piece.length;
        }
      }
      if (nl === -1) return;
      if (!this.dropping) {
        let line = Buffer.concat(this.pending).toString("utf8");
        if (line.endsWith("\r")) line = line.slice(0, -1);
        this.emit(line);
      }
      this.pending = [];
      this.pendingBytes = 0;
      this.dropping = false;
      at = nl + 1;
    }
  }
}

interface Tracked {
  pid: number;
  /** The leader's start time, read at spawn (null where unavailable). */
  startTime: string | null;
  /** True once the leader has been waited for: from then on its pid may be reused. */
  reaped(): boolean;
}

export interface ProcessManagerOptions {
  /** Reads a process's start time; tests replace it to simulate a reissued pid. */
  startTimeOf?: (pid: number) => string | null;
}

export class ProcessManager {
  private readonly children = new Set<Tracked>();
  private readonly startTimeOf: (pid: number) => string | null;
  /** Runs while a tracked group has outlived its leader, dropping it as soon as it empties. */
  private lingerTimer: NodeJS.Timeout | null = null;

  constructor(opts: ProcessManagerOptions = {}) {
    this.startTimeOf = opts.startTimeOf ?? procStartTime;
  }

  /** How many children (or groups that outlived them) this manager would still signal. */
  trackedCount(): number {
    return this.children.size;
  }

  spawnPipe(opts: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }): PipeChild {
    const proc = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pid = proc.pid ?? -1;
    const exit = new ExitSignal();
    const lineListeners: Array<(line: string) => void> = [];
    const splitter = new LineSplitter((line) => {
      for (const cb of lineListeners) cb(line);
    }, `${opts.command} (pid ${pid})`);
    let stderr = Buffer.alloc(0);

    proc.stdout.on("data", (chunk: Buffer) => splitter.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      const joined = Buffer.concat([stderr, chunk]);
      stderr = joined.length > STDERR_TAIL_BYTES ? Buffer.from(joined.subarray(joined.length - STDERR_TAIL_BYTES)) : joined;
    });
    // A child that dies mid-write raises EPIPE on stdin; its exit is reported through onExit instead.
    proc.stdin.on("error", () => {});
    // "close" comes after stdout has drained, so every line precedes the exit.
    proc.on("close", (code) => exit.fire(code));
    // "exit" means node has reaped the child; "close" can follow later, after stdio drains.
    let reaped = false;
    proc.on("exit", () => {
      reaped = true;
    });
    proc.on("error", (err) => {
      if (pid === -1) {
        reaped = true;
        console.warn(`could not start ${opts.command}: ${err.message}`);
        exit.fire(null);
      }
    });

    const tracked: Tracked = { pid, startTime: this.startTimeOf(pid), reaped: () => reaped };
    const child: PipeChild = {
      pid,
      write(line) {
        if (exit.fired || !proc.stdin.writable) return;
        proc.stdin.write(line.endsWith("\n") ? line : line + "\n");
      },
      onLine(cb) {
        lineListeners.push(cb);
      },
      onExit(cb) {
        exit.add(cb);
      },
      kill: () => this.end(tracked),
      stderrTail: () => stderr.toString("utf8"),
    };
    this.track(tracked, exit);
    return child;
  }

  spawnPty(opts: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    cols: number;
    rows: number;
  }): PtyChild {
    const term = pty.spawn(opts.command, opts.args, {
      name: "xterm-256color",
      cwd: opts.cwd,
      env: stringEnv(opts.env),
      cols: opts.cols,
      rows: opts.rows,
    });
    const pid = term.pid;
    const exit = new ExitSignal();
    term.onExit(({ exitCode, signal: sig }) => exit.fire(sig ? null : exitCode));

    // node-pty reports the exit after waiting for the child, so a fired exit means reaped.
    const tracked: Tracked = { pid, startTime: this.startTimeOf(pid), reaped: () => exit.fired };
    const child: PtyChild = {
      pid,
      write(data) {
        if (!exit.fired) term.write(data);
      },
      resize(cols, rows) {
        if (!exit.fired) term.resize(cols, rows);
      },
      onData(cb) {
        term.onData(cb);
      },
      onExit(cb) {
        exit.add(cb);
      },
      kill: () => this.end(tracked),
    };
    this.track(tracked, exit);
    return child;
  }

  /** `/proc/<pid>/cmdline` joined by spaces (`ps` where there is no /proc); null where unavailable. */
  cmdlineOf(pid: number): string | null {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (process.platform === "linux") {
      try {
        const parts = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        if (parts.at(-1) === "") parts.pop();
        return parts.length === 0 ? null : parts.join(" ");
      } catch {
        return null;
      }
    }
    try {
      const out = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out === "" ? null : out;
    } catch {
      return null;
    }
  }

  /**
   * Ends children a previous run recorded as running, but only those still
   * alive whose command line is still exactly what was recorded: a pid the
   * system has since handed to some other program is left alone.
   */
  async reapOrphans(recorded: Array<{ pid: number; cmdline: string }>): Promise<number> {
    const ended = await Promise.all(
      recorded.map((r) => killRecorded(r.pid, () => isRunning(r.pid) && this.cmdlineOf(r.pid) === r.cmdline)),
    );
    return ended.filter(Boolean).length;
  }

  /**
   * Ends every child this manager started that has not already been ended,
   * allowing each `graceMs` after SIGTERM before SIGKILL.
   */
  async killAll(graceMs = KILL_GRACE_MS): Promise<void> {
    this.sweep();
    await Promise.all([...this.children].map((c) => this.end(c, graceMs)));
  }

  /**
   * For a crash: SIGTERM to every tracked group still ours, synchronously,
   * with no wait. The process is about to exit and cannot await anything.
   */
  terminateAllSync(): void {
    for (const c of this.children) {
      if (this.ours(c) && groupExists(c.pid)) signal(-c.pid, "SIGTERM");
    }
  }

  /**
   * Whether `tracked`'s group is still the one this manager started. Where
   * start times are readable: a leader pid that is gone leaves the group to
   * its remaining members, and a group number cannot be reissued while any
   * member holds it; a leader pid that names a process with a different
   * start time (or any process at all once ours was reaped, when no start
   * time was read) means the number was reissued.
   */
  private ours(tracked: Tracked): boolean {
    const now = this.startTimeOf(tracked.pid);
    if (now === null) return true;
    if (tracked.startTime !== null) return now === tracked.startTime;
    return !tracked.reaped();
  }

  /** Drops every child whose group is gone or no longer ours; stops the poll once none linger. */
  private sweep(): void {
    for (const c of this.children) {
      if ((c.reaped() && !groupExists(c.pid)) || !this.ours(c)) this.children.delete(c);
    }
    const lingering = [...this.children].some((c) => c.reaped());
    if (!lingering && this.lingerTimer !== null) {
      clearInterval(this.lingerTimer);
      this.lingerTimer = null;
    }
  }

  private track(tracked: Tracked, exit: ExitSignal): void {
    if (tracked.pid <= 0) return;
    this.children.add(tracked);
    // Forget a child once it and its whole group are gone. A group that
    // outlives its leader stays tracked so killAll still reaches it, and is
    // polled so it is forgotten within a second of emptying: once empty,
    // its number may be handed to an unrelated group.
    exit.add(() => {
      this.sweep();
      if (this.children.has(tracked) && this.lingerTimer === null) {
        this.lingerTimer = setInterval(() => this.sweep(), LINGER_POLL_MS);
        this.lingerTimer.unref();
      }
    });
  }

  private async end(tracked: Tracked, graceMs = KILL_GRACE_MS): Promise<void> {
    await killGroup(tracked.pid, tracked.reaped, () => this.ours(tracked), graceMs);
    this.children.delete(tracked);
    this.sweep();
  }
}
