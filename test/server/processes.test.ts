import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { ProcessManager } from "../../src/server/processes";

// Every long-lived process this suite starts sleeps for this exact duration,
// so the leak check below can find ours and nothing else on the machine.
const MARK = `60.${process.pid}${Math.floor(Math.random() * 1e6)}`;
const SLEEP = `sleep ${MARK}`;

const managers: ProcessManager[] = [];
const rawChildren: ChildProcess[] = [];

/** A raw `sleep <MARK>` this test owns; afterEach ends it only if it is still that process. */
function rawSleep(): ChildProcess {
  const p = spawn("sleep", [MARK], { detached: true, stdio: "ignore" });
  rawChildren.push(p);
  return p;
}

function manager(): ProcessManager {
  const m = new ProcessManager();
  managers.push(m);
  return m;
}

/** Alive and not a zombie (a zombie has already ended; it just awaits its reaper). */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

/** Pids of live (non-zombie) processes whose command line contains this suite's marker. */
function markedPids(): number[] {
  const out: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").join(" ");
      if (cmd.includes(MARK) && alive(Number(name))) out.push(Number(name));
    } catch {}
  }
  return out;
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.killAll()));
  for (const p of rawChildren.splice(0)) {
    // Already ended (and maybe reaped, its pid free for reuse): leave that pid alone.
    if (p.exitCode !== null || p.signalCode !== null || p.pid === undefined) continue;
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${p.pid}/cmdline`, "utf8");
    } catch {}
    if (cmd.includes(MARK)) p.kill("SIGKILL");
  }
});

afterAll(async () => {
  expect(await until(() => markedPids().length === 0, 2000)).toBe(true);
});

const env = { ...process.env };

describe("pipe children", () => {
  test("round-trip lines and report the exit code", async () => {
    const pm = manager();
    const script =
      "const rl=require('readline').createInterface({input:process.stdin});" +
      "rl.on('line',l=>{if(l==='quit'){process.stderr.write('bye');process.exit(7)}console.log('echo:'+l)})";
    const child = pm.spawnPipe({ command: process.execPath, args: ["-e", script], cwd: process.cwd(), env });
    expect(child.pid).toBeGreaterThan(0);
    const lines: string[] = [];
    const exited = new Promise<number | null>((r) => child.onExit(r));
    child.onLine((l) => lines.push(l));
    child.write('{"a":1}');
    child.write("two");
    await until(() => lines.length === 2, 3000);
    expect(lines).toEqual(['echo:{"a":1}', "echo:two"]);
    child.write("quit");
    expect(await exited).toBe(7);
    expect(child.stderrTail()).toBe("bye");
  });

  test("a line over 1 MiB is dropped with a log line, and the next line still arrives", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pm = manager();
      const script = "process.stdout.write('x'.repeat(1100000)+'\\nsmall\\n')";
      const child = pm.spawnPipe({ command: process.execPath, args: ["-e", script], cwd: process.cwd(), env });
      const lines: string[] = [];
      child.onLine((l) => lines.push(l));
      await new Promise((r) => child.onExit(r));
      expect(lines).toEqual(["small"]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("kill() ends a child that ignores SIGTERM within 4 s", async () => {
    const pm = manager();
    const child = pm.spawnPipe({ command: "sh", args: ["-c", `trap '' TERM; ${SLEEP}`], cwd: process.cwd(), env });
    await until(() => markedPids().length > 0, 2000);
    const start = Date.now();
    await child.kill();
    expect(Date.now() - start).toBeLessThan(4000);
    expect(alive(child.pid)).toBe(false);
    expect(await until(() => markedPids().length === 0, 500)).toBe(true);
  }, 10_000);
});

test("kill() and killAll() on a child that already exited send no signal", async () => {
  const pm = manager();
  const child = pm.spawnPipe({ command: process.execPath, args: ["-e", ""], cwd: process.cwd(), env });
  await new Promise((r) => child.onExit(r));
  const kill = vi.spyOn(process, "kill");
  try {
    await child.kill();
    await pm.killAll();
    const signalled = kill.mock.calls.filter(([, sig]) => sig !== 0);
    expect(signalled).toEqual([]);
  } finally {
    kill.mockRestore();
  }
});

describe("pty children", () => {
  test("deliver output, accept input and exit", async () => {
    const pm = manager();
    const child = pm.spawnPty({
      command: "sh",
      args: ["-c", "printf hi; read x; echo got:$x"],
      cwd: process.cwd(),
      env,
      cols: 80,
      rows: 24,
    });
    let out = "";
    child.onData((d) => (out += d));
    const exited = new Promise<number | null>((r) => child.onExit(r));
    expect(await until(() => out.includes("hi"), 3000)).toBe(true);
    child.resize(100, 30);
    child.write("abc\r");
    expect(await exited).toBe(0);
    expect(out).toContain("got:abc");
  });

  test("killAll() ends a pty child and the grandchild that would otherwise survive", async () => {
    const pm = manager();
    // The grandchild ignores SIGHUP, so the pty's hang-up alone would not end it.
    const child = pm.spawnPty({
      command: "sh",
      args: ["-c", `trap '' HUP; ${SLEEP} & wait`],
      cwd: process.cwd(),
      env,
      cols: 80,
      rows: 24,
    });
    expect(await until(() => markedPids().some((p) => p !== child.pid), 3000)).toBe(true);
    const grandchild = markedPids().find((p) => p !== child.pid)!;
    await pm.killAll();
    expect(alive(child.pid)).toBe(false);
    expect(await until(() => !alive(grandchild), 1000)).toBe(true);
  }, 10_000);
});

describe("cmdlineOf and reapOrphans", () => {
  test("cmdlineOf joins argv with spaces, and is null for a pid that does not exist", () => {
    const pm = manager();
    const p = rawSleep();
    expect(pm.cmdlineOf(p.pid!)).toBe(SLEEP);
    expect(pm.cmdlineOf(2 ** 22 + 1)).toBeNull();
  });

  test("ends a recorded orphan whose cmdline matches and leaves one whose cmdline does not", async () => {
    const pm = manager();
    const match = rawSleep();
    const other = rawSleep();
    await until(() => pm.cmdlineOf(match.pid!) === SLEEP && pm.cmdlineOf(other.pid!) === SLEEP, 2000);
    const reaped = await pm.reapOrphans([
      { pid: match.pid!, cmdline: SLEEP },
      { pid: other.pid!, cmdline: "claude --resume something-else" },
    ]);
    expect(reaped).toBe(1);
    expect(await until(() => !alive(match.pid!), 1000)).toBe(true);
    expect(alive(other.pid!)).toBe(true);
  }, 10_000);
});

describe("a group number that may have been reissued", () => {
  test("a group that outlived its leader is forgotten within about a second of emptying", async () => {
    const pm = manager();
    // The leader exits at once; the backgrounded sleep keeps the group alive.
    const child = pm.spawnPipe({ command: "sh", args: ["-c", `${SLEEP} </dev/null >/dev/null 2>&1 & exit 0`], cwd: process.cwd(), env });
    await new Promise((r) => child.onExit(r));
    expect(await until(() => markedPids().length === 1, 2000)).toBe(true);
    expect(pm.trackedCount()).toBe(1);
    // This test started the straggler, so it may end it.
    process.kill(markedPids()[0]!, "SIGKILL");
    expect(await until(() => pm.trackedCount() === 0, 2500)).toBe(true);
  }, 10_000);

  test("a leader pid whose start time changed is never signalled", async () => {
    let fake: string | null = "100";
    const pmFake = new ProcessManager({ startTimeOf: () => fake });
    managers.push(pmFake);
    const child = pmFake.spawnPipe({ command: "sleep", args: [MARK], cwd: process.cwd(), env });
    await until(() => markedPids().includes(child.pid), 2000);
    // As though the group emptied and its number now names another process.
    fake = "200";
    const kill = vi.spyOn(process, "kill");
    try {
      await pmFake.killAll();
      expect(kill.mock.calls.filter(([, sig]) => sig !== 0)).toEqual([]);
    } finally {
      kill.mockRestore();
    }
    expect(alive(child.pid)).toBe(true);
    expect(pmFake.trackedCount()).toBe(0);
    process.kill(-child.pid, "SIGKILL");
    await until(() => !alive(child.pid), 2000);
  }, 10_000);
});
