import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RecordLog } from "../../src/server/record-log";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "personas-records-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const msg = (n: number) => ({ jsonrpc: "2.0" as const, method: "m", params: { n } });

describe("RecordLog", () => {
  test("appends in order with seq from 1, and since() returns only later records", async () => {
    const log = new RecordLog(dir);
    await log.open();
    expect(log.seq()).toBe(0);
    const a = log.append("in", msg(1));
    const b = log.append("out", msg(2));
    const c = log.append("out", msg(3));
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(b).toEqual({ seq: 2, dir: "out", message: msg(2) });
    expect(log.seq()).toBe(3);
    expect(log.since(0).map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(log.since(1)).toEqual([b, c]);
    expect(log.since(3)).toEqual([]);
    const lines = readFileSync(join(dir, "log.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines.map((l) => JSON.parse(l))).toEqual([a, b, c]);
  });

  test("reopening continues seq and keeps the earlier records", async () => {
    const first = new RecordLog(dir);
    await first.open();
    first.append("in", msg(1));
    first.append("out", msg(2));
    const second = new RecordLog(dir);
    await second.open();
    expect(second.seq()).toBe(2);
    expect(second.append("in", msg(3)).seq).toBe(3);
    expect(second.since(0).map((r) => r.message)).toEqual([msg(1), msg(2), msg(3)]);
  });

  test("a torn last line is dropped on open, and the next append lands on its own line", async () => {
    const first = new RecordLog(dir);
    await first.open();
    first.append("in", msg(1));
    first.append("out", msg(2));
    appendFileSync(join(dir, "log.jsonl"), '{"seq":3,"dir":"out","mess');
    const second = new RecordLog(dir);
    await second.open();
    expect(second.seq()).toBe(2);
    expect(second.since(0).map((r) => r.seq)).toEqual([1, 2]);
    second.append("out", msg(9));
    const third = new RecordLog(dir);
    await third.open();
    expect(third.since(0).map((r) => r.message)).toEqual([msg(1), msg(2), msg(9)]);
  });

  test("memory keeps a trailing window by count; the file keeps everything", async () => {
    const log = new RecordLog(dir, { maxRecords: 3 });
    await log.open();
    for (let n = 1; n <= 10; n++) log.append("out", msg(n));
    expect(log.seq()).toBe(10);
    expect(log.windowStart()).toBe(7);
    expect(log.since(0).map((r) => r.seq)).toEqual([8, 9, 10]);
    expect(log.since(9).map((r) => r.seq)).toEqual([10]);
    expect(readFileSync(join(dir, "log.jsonl"), "utf8").trimEnd().split("\n")).toHaveLength(10);
    const again = new RecordLog(dir, { maxRecords: 3 });
    await again.open();
    expect(again.windowStart()).toBe(7);
    expect(again.since(0).map((r) => r.seq)).toEqual([8, 9, 10]);
    expect(again.append("in", msg(11)).seq).toBe(11);
  });

  test("memory keeps a trailing window by bytes, and always the newest record", async () => {
    const log = new RecordLog(dir, { maxBytes: 200 });
    await log.open();
    for (let n = 1; n <= 10; n++) log.append("out", msg(n));
    const kept = log.since(0);
    const bytes = kept.reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r)) + 1, 0);
    expect(bytes).toBeLessThanOrEqual(200);
    expect(kept.at(-1)!.seq).toBe(10);
    expect(log.windowStart()).toBe(kept[0]!.seq - 1);
    const big = log.append("out", { jsonrpc: "2.0", method: "m", params: { text: "x".repeat(1000) } });
    expect(log.since(0)).toEqual([big]);
    expect(log.windowStart()).toBe(10);
  });

  test("observe sees every record, on open and on append, including those memory dropped", async () => {
    const first = new RecordLog(dir, { maxRecords: 2 });
    await first.open();
    for (let n = 1; n <= 5; n++) first.append("out", msg(n));
    const seen: number[] = [];
    const second = new RecordLog(dir, { maxRecords: 2, observe: (r) => seen.push(r.seq) });
    await second.open();
    second.append("in", msg(6));
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("a log larger than one read chunk opens whole, with lines split across chunks", async () => {
    const first = new RecordLog(dir);
    await first.open();
    for (let n = 1; n <= 3000; n++) first.append("out", { jsonrpc: "2.0", method: "m", params: { n, pad: "y".repeat(50) } });
    const second = new RecordLog(dir);
    await second.open();
    expect(second.seq()).toBe(3000);
    expect(second.since(2998).map((r) => r.seq)).toEqual([2999, 3000]);
  });
});
