import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { acquireStateLock, STATE_IN_USE } from "../../src/server/lock";
import { ProcessManager, procStartTime } from "../../src/server/processes";

const MARK = `61.${process.pid}${Math.floor(Math.random() * 1e6)}`;
const pm = new ProcessManager();
const cmdlineOf = (pid: number) => pm.cmdlineOf(pid);
const probes = { cmdlineOf };
const cwdOf = (pid: number): string | null => { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } };
/** The lock a live holder would have written about itself. */
const lockOf = (pid: number) => ({ pid, cmdline: cmdlineOf(pid), startTime: procStartTime(pid), cwd: cwdOf(pid) });
let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "personas-lock-"));
});
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

async function holder(): Promise<ChildProcess> {
  const c = spawn("sleep", [MARK], { stdio: "ignore" });
  children.push(c);
  const deadline = Date.now() + 2000;
  while (cmdlineOf(c.pid!) !== `sleep ${MARK}` && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return c;
}

test("takes a free lock, records this process, and release removes it", () => {
  const lock = acquireStateLock(dir, probes);
  const recorded = JSON.parse(readFileSync(join(dir, "lock"), "utf8"));
  expect(recorded).toEqual(lockOf(process.pid));
  expect(recorded.startTime).toMatch(/^\d+$/);
  expect(recorded.cwd).toBe(process.cwd());
  lock.release();
  expect(existsSync(join(dir, "lock"))).toBe(false);
});

test("refuses while a live holder still runs its recorded command line", async () => {
  const c = await holder();
  writeFileSync(join(dir, "lock"), JSON.stringify(lockOf(c.pid!)));
  expect(() => acquireStateLock(dir, probes)).toThrow(STATE_IN_USE);
  expect(JSON.parse(readFileSync(join(dir, "lock"), "utf8")).pid).toBe(c.pid);
});

test("takes over a lock whose pid now runs a different command line", async () => {
  const c = await holder();
  writeFileSync(join(dir, "lock"), JSON.stringify({ pid: c.pid, cmdline: "node dist/server.js" }));
  acquireStateLock(dir, probes);
  expect(JSON.parse(readFileSync(join(dir, "lock"), "utf8")).pid).toBe(process.pid);
});

test("takes over a lock whose holder is dead, and one that is unreadable", async () => {
  const c = await holder();
  const pid = c.pid!;
  c.kill("SIGKILL");
  await new Promise((r) => c.once("exit", r));
  writeFileSync(join(dir, "lock"), JSON.stringify({ pid, cmdline: `sleep ${MARK}` }));
  acquireStateLock(dir, probes);
  expect(JSON.parse(readFileSync(join(dir, "lock"), "utf8")).pid).toBe(process.pid);
  writeFileSync(join(dir, "lock"), "{not json");
  acquireStateLock(dir, probes);
  expect(JSON.parse(readFileSync(join(dir, "lock"), "utf8")).pid).toBe(process.pid);
});

test("takes over a lock whose pid now belongs to another process with the same command line", async () => {
  // As after a reboot: the recorded pid was handed to another app's server, started later.
  const c = await holder();
  writeFileSync(join(dir, "lock"), JSON.stringify({ ...lockOf(c.pid!), startTime: "1" }));
  acquireStateLock(dir, probes);
  expect(JSON.parse(readFileSync(join(dir, "lock"), "utf8")).pid).toBe(process.pid);
});

test("takes over a lock whose pid runs the same command line from another folder", async () => {
  const c = await holder();
  writeFileSync(join(dir, "lock"), JSON.stringify({ ...lockOf(c.pid!), cwd: "/some/other/app" }));
  acquireStateLock(dir, probes);
  expect(JSON.parse(readFileSync(join(dir, "lock"), "utf8")).pid).toBe(process.pid);
});

test("without start times or folders (macOS) a matching command line alone is live", async () => {
  const c = await holder();
  const blind = { cmdlineOf, startTimeOf: () => null, cwdOf: () => null };
  writeFileSync(join(dir, "lock"), JSON.stringify({ pid: c.pid, cmdline: `sleep ${MARK}`, startTime: null, cwd: null }));
  expect(() => acquireStateLock(dir, blind)).toThrow(STATE_IN_USE);
});
