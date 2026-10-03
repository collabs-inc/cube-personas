// Adapted from cube-computer: src/main/cubed/attention/spool.ts
//
// The directory worker hooks drop their payloads into, drained in arrival
// order. A directory rather than a socket because a hook is a one-line shell
// command — no helper binary, no client to authenticate. It is owner-only,
// and a payload can do nothing but report one worker's turn: it names a
// launch id, and one the app does not know is ignored.
import { chmodSync, closeSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { MAX_REPORT_BYTES } from "./hooks";

/** `<launchId>.<random>.json`, renamed into place by the hook. */
const REPORT_NAME = /^([0-9A-Za-z-]{8,64})\.([0-9A-Za-z]+)\.json$/;
/** The same name before `mv`, so a hook that died between `mktemp` and the rename is still reaped. */
const TEMP_NAME = /^[0-9A-Za-z-]{8,64}\.[0-9A-Za-z]+$/;
const TEMP_MAX_AGE_MS = 60_000;
const SWEEP_MS = 2_000;

export class Spool {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scheduled = false;
  /** Files handed to `onReport` whose handling has not settled: claimed, so no drain hands them out twice. */
  private readonly taken = new Set<string>();

  /**
   * `onReport` receives the parsed payload — or, for a payload the hook cut
   * at its byte cap so it no longer parses, the raw text, which still
   * carries the leading fields (report-text.ts reads them by pattern).
   * The file is deleted only once the returned promise resolves, so a crash
   * mid-handling redelivers it on the next start (report ids make that
   * harmless). One whose handler throws or rejects is left in place and not
   * retried until the next start.
   */
  constructor(
    private readonly dir: string,
    private readonly onReport: (launchId: string, payload: unknown, file: string) => void | Promise<unknown>,
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  start(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { chmodSync(this.dir, 0o700); } catch { /* best effort */ }
    try {
      this.watcher = watch(this.dir, () => this.schedule());
      this.watcher.unref?.();
      this.watcher.on("error", () => { this.watcher?.close(); this.watcher = null; });
    } catch {
      // The sweep below still drains; a watch only makes it prompt.
    }
    this.timer = setInterval(() => this.drain(), SWEEP_MS);
    this.timer.unref?.();
    this.drain();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.timer) this.drain();
    });
  }

  /** Claims each file synchronously, so a watch event and a sweep can never hand one file out twice. */
  drain(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    const now = Date.now();
    const reports: Array<{ name: string; launchId: string; mtime: bigint }> = [];
    for (const name of names) {
      const path = join(this.dir, name);
      let stat;
      try {
        stat = statSync(path, { bigint: true });
      } catch {
        continue;
      }
      const match = REPORT_NAME.exec(name);
      if (!match) {
        if (TEMP_NAME.test(name) && now - Number(stat.mtimeMs) > TEMP_MAX_AGE_MS) this.unlink(path);
        continue;
      }
      reports.push({ name, launchId: match[1]!, mtime: stat.mtimeNs });
    }
    // mtime first: temp names are random.
    reports.sort((a, b) => (a.mtime < b.mtime ? -1 : a.mtime > b.mtime ? 1 : a.name.localeCompare(b.name)));

    for (const report of reports) {
      if (this.taken.has(report.name)) continue;
      const path = join(this.dir, report.name);
      const text = this.read(path);
      if (text === null) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        if (Buffer.byteLength(text) < MAX_REPORT_BYTES) {
          this.log(`spool: removed ${report.name}, which is not a report`);
          this.unlink(path);
          continue;
        }
        payload = text;
      }
      this.taken.add(report.name);
      const failed = (err: unknown): void => {
        this.log(`spool: report ${report.name} could not be handled and is kept for the next start: ${String(err)}`);
      };
      let handled: void | Promise<unknown>;
      try {
        handled = this.onReport(report.launchId, payload, report.name);
      } catch (err) {
        failed(err);
        continue;
      }
      Promise.resolve(handled).then(() => {
        this.unlink(path);
        this.taken.delete(report.name);
      }, failed);
    }
  }

  private read(path: string): string | null {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return null;
    }
    try {
      const buffer = Buffer.alloc(MAX_REPORT_BYTES);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, length).toString("utf8");
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  private unlink(path: string): void {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}
