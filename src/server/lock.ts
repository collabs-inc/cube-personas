// One server per state folder. Two servers sharing one would each reap the
// other's live children at start (their recorded command lines match), resume
// the same sessions twice, and overwrite each other's tables. The lock is a
// file created exclusively, holding the holder's pid, command line, start
// time and working directory. One whose pid is dead, or now names a process
// with a different command line, start time or working directory, is stale
// and taken over.
//
// The command line alone is not enough: it is `node dist/server.js`, the same
// for every app built from the same template, and after a reboot pids are
// handed out again in nearly the same order, so a stale lock's pid can belong
// to another app's server. The start time (Linux, /proc/<pid>/stat) tells two
// processes with one pid apart; the working directory (/proc/<pid>/cwd) tells
// two apps apart. Where neither can be read (macOS), only the pid and command
// line are compared: a stale lock whose pid now runs another `node
// dist/server.js` is then refused until that process ends or the lock is
// removed by hand.
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { procStartTime } from "./processes";

export const STATE_IN_USE = "Another Personas server is using this state folder.";

const LOCK_NAME = "lock";
const ATTEMPTS = 3;

interface Holder {
  pid: number;
  cmdline: string | null;
  startTime: string | null;
  cwd: string | null;
}

export interface LockProbes {
  /** A process's command line; null when it does not exist. */
  cmdlineOf(pid: number): string | null;
  /** A process's start time; null where it cannot be read. */
  startTimeOf?(pid: number): string | null;
  /** A process's working directory; null where it cannot be read. */
  cwdOf?(pid: number): string | null;
}

function procCwd(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

export interface StateLock {
  /** Removes the lock, but only while it is still this process's. */
  release(): void;
}

function readHolder(file: string): Holder | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const { pid, cmdline, startTime, cwd } = value as Record<string, unknown>;
    if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
    const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
    return { pid: pid as number, cmdline: str(cmdline), startTime: str(startTime), cwd: str(cwd) };
  } catch {
    return null;
  }
}

/**
 * Takes the state folder's lock, or throws `STATE_IN_USE` when a live server
 * holds it. `cmdlineOf` reads a process's command line (null when it does not
 * exist), and is how a pid reused by another program is told apart.
 */
export function acquireStateLock(dir: string, probes: LockProbes): StateLock {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, LOCK_NAME);
  const startTimeOf = probes.startTimeOf ?? procStartTime;
  const cwdOf = probes.cwdOf ?? procCwd;
  const describe = (pid: number): Holder => ({ pid, cmdline: probes.cmdlineOf(pid), startTime: startTimeOf(pid), cwd: cwdOf(pid) });
  const self = describe(process.pid);
  /**
   * The holder still runs: same command line, and wherever this platform
   * can read them, the same start time and working directory. A lock that
   * lacks a field this platform can read cannot be verified, so it is stale.
   */
  const live = (holder: Holder): boolean => {
    if (holder.pid === process.pid || holder.cmdline === null) return false;
    const now = describe(holder.pid);
    if (now.cmdline !== holder.cmdline) return false;
    if (self.startTime !== null && now.startTime !== holder.startTime) return false;
    if (self.cwd !== null && now.cwd !== holder.cwd) return false;
    return true;
  };
  // Written whole to a private name, then linked into place: the link fails
  // if a lock exists, so a lock is never seen half-written.
  const tmp = join(dir, `.lock.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(self), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        linkSync(tmp, file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const holder = readHolder(file);
        if (holder !== null && live(holder)) {
          throw new Error(STATE_IN_USE);
        }
        // Stale: its holder is gone, or its pid now belongs to another program.
        // Re-read right before removing it, so a lock another server took meanwhile is left alone.
        const again = readHolder(file);
        if (again?.pid !== holder?.pid) continue;
        try {
          unlinkSync(file);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        continue;
      }
      return lockFor(file);
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
  throw new Error(STATE_IN_USE);
}

function lockFor(file: string): StateLock {
  return {
    release() {
      const holder = readHolder(file);
      if (holder?.pid !== process.pid) return;
      try {
        unlinkSync(file);
      } catch {}
    },
  };
}
