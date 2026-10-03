import { afterEach, beforeEach, expect, test } from "vitest";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportStore } from "../../src/server/reports/store";
import type { AgentReport } from "../../src/shared/types";

let dir = "";
let lines: string[] = [];
const log = (line: string) => { lines.push(line); };
beforeEach(async () => { lines = []; dir = await mkdtemp(join(tmpdir(), "personas-reports-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const P1 = "11111111-2222-3333-4444-555555555555";
const P2 = "66666666-7777-8888-9999-000000000000";
const report = (over: Partial<AgentReport> = {}): AgentReport => ({
  reportId: "w1:a.json", personaId: P1, agentId: "w1", kind: "ended", text: "Tests pass.",
  messageUnavailable: false, title: "fix-pager", cwd: "/tmp/repo", at: "2026-10-03T12:00:00.000Z", ...over,
});

test("record stores a report once; a duplicate id returns false", async () => {
  const store = new ReportStore(dir, log);
  await store.load();
  expect(await store.record(report())).toBe(true);
  expect(await store.record(report({ text: "changed" }))).toBe(false);
  expect(store.pending(P1).map(r => r.text)).toEqual(["Tests pass."]);
});

test("pending is per persona, oldest first, and survives a reload", async () => {
  const store = new ReportStore(dir, log);
  await store.load();
  await store.record(report({ reportId: "w1:b", at: "2026-10-03T12:00:02.000Z" }));
  await store.record(report({ reportId: "w1:a", at: "2026-10-03T12:00:01.000Z" }));
  await store.record(report({ reportId: "w9:a", personaId: P2, agentId: "w9" }));
  expect(store.pending(P1).map(r => r.reportId)).toEqual(["w1:a", "w1:b"]);
  expect(store.pending(P2).map(r => r.reportId)).toEqual(["w9:a"]);

  const again = new ReportStore(dir, log);
  await again.load();
  expect(again.pending(P1).map(r => r.reportId)).toEqual(["w1:a", "w1:b"]);
  expect(await again.record(report({ reportId: "w1:a" }))).toBe(false);
  expect(lines).toEqual([]);
});

test("acknowledge removes a report from pending, durably", async () => {
  const store = new ReportStore(dir, log);
  await store.load();
  await store.record(report({ reportId: "r1" }));
  await store.record(report({ reportId: "r2" }));
  await store.acknowledge(P1, ["r1"]);
  expect(store.pending(P1).map(r => r.reportId)).toEqual(["r2"]);

  const again = new ReportStore(dir, log);
  await again.load();
  expect(again.pending(P1).map(r => r.reportId)).toEqual(["r2"]);
});

test("one persona cannot acknowledge another persona's report, nor an unknown id", async () => {
  const store = new ReportStore(dir, log);
  await store.load();
  await store.record(report({ reportId: "mine" }));
  await store.record(report({ reportId: "theirs", personaId: P2, agentId: "w9" }));
  await store.acknowledge(P1, ["theirs", "nonsense", "mine"]);
  expect(store.pending(P1)).toEqual([]);
  expect(store.pending(P2).map(r => r.reportId)).toEqual(["theirs"]);

  const again = new ReportStore(dir, log);
  await again.load();
  expect(again.pending(P2).map(r => r.reportId)).toEqual(["theirs"]);
});

test("latestFor names an agent's newest report, acknowledged or not", async () => {
  const store = new ReportStore(dir, log);
  await store.load();
  expect(store.latestFor("w1")).toBeNull();
  await store.record(report({ reportId: "r1", at: "2026-10-03T12:00:01.000Z", text: "first" }));
  await store.record(report({ reportId: "r2", at: "2026-10-03T12:00:02.000Z", text: "second" }));
  await store.record(report({ reportId: "x", agentId: "w2", at: "2026-10-03T12:00:03.000Z" }));
  await store.acknowledge(P1, ["r2"]);
  expect(store.latestFor("w1")?.text).toBe("second");
});

test("returned reports are copies: mutating one does not change the store", async () => {
  const store = new ReportStore(dir, log);
  await store.load();
  await store.record(report());
  store.pending(P1)[0]!.text = "tampered";
  store.latestFor("w1")!.text = "tampered";
  expect(store.pending(P1)[0]!.text).toBe("Tests pass.");
});

test("an unreadable report file is kept as .corrupt with one log line, and the rest load", async () => {
  const store = new ReportStore(dir, log);
  await store.load();
  await store.record(report({ reportId: "good" }));
  const personaDir = join(dir, (await readdir(dir)).find(n => n !== "acknowledged.json")!);
  await writeFile(join(personaDir, "broken.json"), "{not json");

  const again = new ReportStore(dir, log);
  await again.load();
  expect(again.pending(P1).map(r => r.reportId)).toEqual(["good"]);
  expect(await readdir(personaDir)).toContain("broken.json.corrupt");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("broken.json");
});

test("unreadable acknowledgements are kept as .corrupt and the reports come back pending", async () => {
  const store = new ReportStore(dir, log);
  await store.load();
  await store.record(report({ reportId: "r1" }));
  await store.acknowledge(P1, ["r1"]);
  await writeFile(join(dir, "acknowledged.json"), "[oops");

  const again = new ReportStore(dir, log);
  await again.load();
  expect(again.pending(P1).map(r => r.reportId)).toEqual(["r1"]);
  expect(await readFile(join(dir, "acknowledged.json.corrupt"), "utf8")).toBe("[oops");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("acknowledged.json");
});

test("a record whose write fails is not claimed: retrying it stores it", async () => {
  const store = new ReportStore(dir, log);
  await store.load();
  await chmod(dir, 0o500);
  try {
    await expect(store.record(report())).rejects.toThrow();
  } finally { await chmod(dir, 0o700); }
  expect(store.pending(P1)).toEqual([]);
  expect(await store.record(report())).toBe(true);
  const again = new ReportStore(dir, log);
  await again.load();
  expect(again.pending(P1).map(r => r.reportId)).toEqual(["w1:a.json"]);
});

test("load on a missing directory starts empty", async () => {
  const store = new ReportStore(join(dir, "absent"), log);
  await store.load();
  expect(store.pending(P1)).toEqual([]);
  expect(await store.record(report())).toBe(true);
});
