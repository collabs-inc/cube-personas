import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { argReportScript, MAX_REPORT_BYTES, stdinReportCommand } from "../../src/server/workers/hooks";
import { Spool } from "../../src/server/workers/spool";

const LAUNCH = "0f2c9a52-7d0e-4d2f-9a51-3c1f0e8b6a11";
const dirs: string[] = [];
const spools: Spool[] = [];

function spoolDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "personas-spool-"));
  dirs.push(dir);
  return dir;
}

function start(dir: string, onReport: (launchId: string, payload: unknown, file: string) => void, log = vi.fn()): Spool {
  const spool = new Spool(dir, onReport, log);
  spools.push(spool);
  spool.start();
  return spool;
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(() => {
  for (const s of spools.splice(0)) s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Spool", () => {
  test("a payload written by the real stdin one-liner arrives once, then is deleted", async () => {
    const dir = spoolDir();
    const seen: Array<[string, unknown, string]> = [];
    start(dir, (l, p, f) => seen.push([l, p, f]));
    const out = execFileSync("sh", ["-c", stdinReportCommand(dir, LAUNCH)], { input: JSON.stringify({ hook_event_name: "Stop", session_id: "s" }) });
    expect(out.length).toBe(0);
    await until(() => seen.length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe(LAUNCH);
    expect(seen[0]![1]).toEqual({ hook_event_name: "Stop", session_id: "s" });
    expect(seen[0]![2]).toMatch(new RegExp(`^${LAUNCH}\\.[0-9A-Za-z]+\\.json$`));
    await until(() => readdirSync(dir).length === 0);
  });

  test("a payload handed as $1 to the codex notify script arrives", async () => {
    const dir = spoolDir();
    const seen: unknown[] = [];
    start(dir, (_l, p) => seen.push(p));
    execFileSync("sh", ["-c", argReportScript(dir, LAUNCH), "cube-attention", JSON.stringify({ type: "agent-turn-complete" })]);
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ type: "agent-turn-complete" });
  });

  test("files already present at start are drained", async () => {
    const dir = spoolDir();
    writeFileSync(join(dir, `${LAUNCH}.abc123.json`), "{\"a\":1}");
    const seen: unknown[] = [];
    start(dir, (_l, p) => seen.push(p));
    expect(seen).toEqual([{ a: 1 }]);
  });

  test("a junk file is removed with one log line and reaches nobody", async () => {
    const dir = spoolDir();
    const seen: unknown[] = [];
    const log = vi.fn();
    start(dir, (_l, p) => seen.push(p), log);
    writeFileSync(join(dir, `${LAUNCH}.junk01.json`), "not json {");
    await until(() => readdirSync(dir).length === 0);
    expect(seen).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("a payload the hook cut at its byte cap reaches onReport as its raw text", async () => {
    const dir = spoolDir();
    const seen: unknown[] = [];
    start(dir, (_l, p) => seen.push(p));
    const big = JSON.stringify({ type: "agent-turn-complete", "last-assistant-message": "x".repeat(MAX_REPORT_BYTES) });
    execFileSync("sh", ["-c", argReportScript(dir, LAUNCH), "cube-attention", big]);
    await until(() => seen.length === 1);
    expect(typeof seen[0]).toBe("string");
    expect((seen[0] as string).length).toBe(MAX_REPORT_BYTES);
  });

  test("a handler that throws leaves its file and is not retried this run", async () => {
    const dir = spoolDir();
    const log = vi.fn();
    let calls = 0;
    const spool = start(dir, () => { calls++; throw new Error("boom"); }, log);
    writeFileSync(join(dir, `${LAUNCH}.abc124.json`), "{}");
    await until(() => calls === 1);
    spool.drain();
    spool.drain();
    expect(calls).toBe(1);
    expect(readdirSync(dir)).toEqual([`${LAUNCH}.abc124.json`]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("a handler that rejects leaves its file", async () => {
    const dir = spoolDir();
    const log = vi.fn();
    let calls = 0;
    start(dir, async () => { calls++; throw new Error("boom"); }, log);
    writeFileSync(join(dir, `${LAUNCH}.abc125.json`), "{}");
    await until(() => log.mock.calls.length === 1);
    expect(calls).toBe(1);
    expect(readdirSync(dir)).toEqual([`${LAUNCH}.abc125.json`]);
  });

  test("a file stays until its handler settles, is handed out once meanwhile, and goes when it resolves", async () => {
    const dir = spoolDir();
    let release!: () => void;
    let calls = 0;
    const spool = start(dir, () => { calls++; return new Promise<void>((r) => { release = r; }); });
    writeFileSync(join(dir, `${LAUNCH}.abc126.json`), "{}");
    await until(() => calls === 1);
    spool.drain();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(1);
    expect(readdirSync(dir)).toEqual([`${LAUNCH}.abc126.json`]);
    release();
    await until(() => readdirSync(dir).length === 0);
    expect(calls).toBe(1);
  });

  test("a hung handler's file survives a stop, so the next start redelivers it", async () => {
    const dir = spoolDir();
    let calls = 0;
    const first = start(dir, () => { calls++; return new Promise<void>(() => {}); });
    writeFileSync(join(dir, `${LAUNCH}.abc127.json`), "{\"a\":2}");
    await until(() => calls === 1);
    first.stop();
    const seen: unknown[] = [];
    start(dir, (_l, p) => { seen.push(p); });
    expect(seen).toEqual([{ a: 2 }]);
    await until(() => readdirSync(dir).length === 0);
  });
});
