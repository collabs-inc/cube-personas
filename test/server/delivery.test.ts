import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { Delivery } from "../../src/server/reports/delivery";
import { ReportStore } from "../../src/server/reports/store";
import { isQuestion, wakeUpPrompt, wakeUpReasonOf } from "../../src/server/reports/wake-ups";
import type { AgentReport, PersonaState } from "../../src/shared/types";

const P1 = "11111111-2222-3333-4444-555555555555";
const P2 = "66666666-7777-8888-9999-000000000000";
let seq = 0;
const report = (over: Partial<AgentReport> = {}): AgentReport => ({
  reportId: `w1:${++seq}.json`, personaId: P1, agentId: "w1", kind: "ended", text: "Tests pass.",
  messageUnavailable: false, title: "fix-pager", cwd: "/tmp/repo", at: new Date(1_000_000 + seq).toISOString(), ...over,
});

// --- a fake clock -----------------------------------------------------------

let clock = 0;
let timers: Array<{ at: number; fn: () => void; id: number }> = [];
let nextTimer = 1;
const setTimer = (fn: () => void, ms: number) => { const id = nextTimer++; timers.push({ at: clock + ms, fn, id }); return id; };
const clearTimer = (t: unknown) => { timers = timers.filter(x => x.id !== t); };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
async function advance(ms: number): Promise<void> {
  const end = clock + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const next = timers[0];
    if (!next || next.at > end) break;
    timers.shift();
    clock = next.at;
    next.fn();
    await flush();
  }
  clock = end;
  await flush();
}

// --- a fake session -----------------------------------------------------------

interface Sent { at: number; blocks: ContentBlock[]; meta?: Record<string, unknown> }
class FakeSession {
  current: PersonaState = "ready";
  sent: Sent[] = [];
  /** Whether an accepted prompt turns the session busy (a real turn) or leaves it ready. */
  goBusy = false;
  state(): PersonaState { return this.current; }
  async prompt(blocks: ContentBlock[], meta?: Record<string, unknown>): Promise<"accepted" | "busy"> {
    if (this.current !== "ready") return "busy";
    this.sent.push({ at: clock, blocks, meta });
    if (this.goBusy) this.current = "busy";
    return "accepted";
  }
}

let dir = "";
let store: ReportStore;
let session: FakeSession;
let sessions: Map<string, FakeSession>;
let delivery: Delivery;
let lines: string[] = [];

beforeEach(async () => {
  clock = 0; timers = []; lines = [];
  dir = await mkdtemp(join(tmpdir(), "personas-delivery-"));
  store = new ReportStore(dir, (l) => lines.push(l));
  await store.load();
  session = new FakeSession();
  sessions = new Map([[P1, session]]);
  delivery = new Delivery({
    reports: store,
    sessionOf: (id) => (sessions.get(id) ?? null) as never,
    now: () => clock, setTimer, clearTimer, log: (l) => lines.push(l),
  });
});
afterEach(async () => {
  delivery.stop();
  await rm(dir, { recursive: true, force: true });
});

async function arrive(r: AgentReport): Promise<void> {
  if (await store.record(r)) delivery.notify(r.personaId);
}
const metaOf = (s: Sent) => (s.meta as { cube: Record<string, unknown> }).cube;
const wakeIds = (s: Sent) => metaOf(s)["reportIds"] as string[];

test("one report wakes an idle persona once, marked as a Cube report", async () => {
  session.goBusy = true;
  const r = report();
  await arrive(r);
  await advance(500);
  expect(session.sent).toHaveLength(1);
  const [wake] = session.sent;
  expect(metaOf(wake!)["report"]).toBe(true);
  expect(wakeIds(wake!)).toEqual([r.reportId]);
  expect((wake!.blocks[0] as { text: string }).text).toBe(wakeUpPrompt([r]));
});

test("two reports arriving 10 ms apart produce one wake carrying both", async () => {
  const a = report(); const b = report();
  await arrive(a);
  await advance(10);
  await arrive(b);
  await advance(200);
  expect(session.sent).toHaveLength(1);
  expect(wakeIds(session.sent[0]!)).toEqual([a.reportId, b.reportId]);
});

test("a report arriving while busy is delivered when the session returns to ready, not before", async () => {
  session.current = "busy";
  const r = report();
  await arrive(r);
  await advance(60_000);
  expect(session.sent).toHaveLength(0);
  session.current = "ready";
  delivery.onPersonaState(P1, "ready");
  await advance(500);
  expect(session.sent).toHaveLength(1);
  expect(wakeIds(session.sent[0]!)).toEqual([r.reportId]);
});

test("an unacknowledged wake is re-sent at 1, 2, 4 … 30 s; acknowledge stops it", async () => {
  await arrive(report());
  await advance(200);
  expect(session.sent).toHaveLength(1);
  const first = session.sent[0]!.at;
  await advance(150_000);
  const gaps = session.sent.slice(1).map((s, i) => s.at - session.sent[i]!.at);
  expect(gaps.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
  expect(first).toBeLessThan(200);

  await store.acknowledge(P1, wakeIds(session.sent[0]!));
  delivery.notify(P1);
  const count = session.sent.length;
  await advance(120_000);
  expect(session.sent).toHaveLength(count);
  expect(timers).toEqual([]);
});

test("a ready state inside the backoff does not re-send early", async () => {
  await arrive(report());
  await advance(200);
  delivery.onPersonaState(P1, "ready");
  await advance(500);
  expect(session.sent).toHaveLength(1);
});

test("a new report resets the backoff and the next wake carries every unacknowledged report", async () => {
  const a = report();
  await arrive(a);
  await advance(200);
  await advance(1000 + 2000 + 4000); // three re-sends, backoff now 8 s
  const before = session.sent.length;
  const b = report();
  await arrive(b);
  await advance(200);
  expect(session.sent).toHaveLength(before + 1);
  expect(wakeIds(session.sent.at(-1)!)).toEqual([a.reportId, b.reportId]);
  await advance(1000);
  expect(session.sent).toHaveLength(before + 2);
});

/** What the wiring does: prepare, let the session admit the prompt (it turns busy), then commit the carry. */
function sendUserPrompt(user: ContentBlock[]) {
  const out = delivery.beforeUserPrompt(P1, user);
  session.current = "busy";
  delivery.onPersonaState(P1, "busy");
  delivery.carried(P1, out.carried);
  return out;
}

test("a user prompt carries pending reports after the user's text, suppressed only while its turn runs", async () => {
  session.current = "busy";
  const r = report();
  await arrive(r);
  await advance(200);
  session.current = "ready";
  const user: ContentBlock[] = [{ type: "text", text: "actually, do the docs first" }];
  const out = sendUserPrompt(user);
  expect(out.blocks[0]).toEqual(user[0]);
  expect(out.blocks).toHaveLength(2);
  const block = out.blocks[1] as { text: string; _meta: unknown };
  expect(block.text).toBe(wakeUpPrompt([r]));
  expect(block._meta).toEqual({ cube: { carriedReports: [r.reportId] } });
  expect(out.meta).toEqual({ cube: { carriedReports: [r.reportId] } });
  expect(out.carried).toEqual([r.reportId]);

  // While the carrying turn runs, nothing is woken for it, even past the busy retries.
  const carriedAt = clock;
  await advance(5000);
  expect(session.sent).toHaveLength(0);
  expect(delivery.beforeUserPrompt(P1, user)).toEqual({ blocks: user, meta: {}, carried: [] });

  // The turn ends unacknowledged: ordinary backoff redelivery, the carry counting as attempt 1.
  session.current = "ready";
  delivery.onPersonaState(P1, "ready");
  await advance(200);
  expect(session.sent).toHaveLength(1);
  expect(wakeIds(session.sent[0]!)).toEqual([r.reportId]);
  expect(session.sent[0]!.at - carriedAt).toBeGreaterThanOrEqual(1000);
  await advance(2000);
  expect(session.sent.map(s => s.at - session.sent[0]!.at)).toEqual([0, 2000]);
});

test("a carry ended by a stop is due again on the next launch", async () => {
  const r = report();
  await store.record(r);
  sendUserPrompt([{ type: "text", text: "go" }]);
  delivery.onLaunchChanged(P1);
  session.current = "ready";
  await advance(200);
  expect(session.sent.map(wakeIds)).toEqual([[r.reportId]]);
});

test("a user prompt with nothing pending passes through untouched", () => {
  const user: ContentBlock[] = [{ type: "text", text: "hello" }];
  expect(delivery.beforeUserPrompt(P1, user)).toEqual({ blocks: user, meta: {}, carried: [] });
});

test("beforeUserPrompt marks nothing: a prompt the session refused loses no report", async () => {
  session.current = "busy";
  const r = report();
  await arrive(r);
  const user: ContentBlock[] = [{ type: "text", text: "hello" }];
  expect(delivery.beforeUserPrompt(P1, user).carried).toEqual([r.reportId]); // proposed, then refused
  session.current = "ready";
  delivery.onPersonaState(P1, "ready");
  await advance(200);
  expect(wakeIds(session.sent[0]!)).toEqual([r.reportId]);
});

test("carried after the turn already ended marks nothing", async () => {
  const r = report();
  await store.record(r);
  const out = delivery.beforeUserPrompt(P1, [{ type: "text", text: "go" }]);
  delivery.carried(P1, out.carried); // the session is ready: its turn is over
  await advance(200);
  expect(session.sent.map(wakeIds)).toEqual([[r.reportId]]);
});

test("reports that arrive during a carrying turn are woken after it, never repeating the carried one alone", async () => {
  const a = report();
  await store.record(a);
  sendUserPrompt([{ type: "text", text: "go" }]);
  const b = report();
  await arrive(b);
  await advance(5000);
  expect(session.sent).toHaveLength(0);
  session.current = "ready";
  delivery.onPersonaState(P1, "ready");
  await advance(200);
  expect(session.sent.map(wakeIds)).toEqual([[a.reportId, b.reportId]]);
});

const MAX = 1024 * 1024;
const lineOf = (blocks: ContentBlock[], meta: Record<string, unknown>) =>
  Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: "u".repeat(64), method: "session/prompt",
    params: { sessionId: "s".repeat(64), prompt: blocks, _meta: meta } }), "utf8") + 1;

test("a user prompt is measured whole: escaped reports never push it over the pipe line", async () => {
  // Quotes and backslashes double on each JSON level: a per-report estimate undercounts them.
  for (let i = 0; i < 400; i++) await store.record(report({ text: '"\\'.repeat(1300) }));
  const user: ContentBlock[] = [{ type: "text", text: "u".repeat(700 * 1024) }];
  const out = delivery.beforeUserPrompt(P1, user);
  expect(out.carried.length).toBeGreaterThan(0);
  expect(lineOf(out.blocks, out.meta)).toBeLessThanOrEqual(MAX);
  // Oldest first, a prefix of what is pending.
  expect(out.carried).toEqual(store.pending(P1).slice(0, out.carried.length).map(r => r.reportId));
});

test("a user prompt with no room left carries nothing", async () => {
  await store.record(report());
  const user: ContentBlock[] = [{ type: "text", text: "u".repeat(MAX - 1700) }];
  expect(delivery.beforeUserPrompt(P1, user)).toEqual({ blocks: user, meta: {}, carried: [] });
});

test("a wake carries as many reports as fit on one line; the rest follow", async () => {
  for (let i = 0; i < 400; i++) await store.record(report({ text: '"\\'.repeat(1300) }));
  delivery.notify(P1);
  await advance(200);
  const first = session.sent[0]!;
  expect(lineOf(first.blocks, first.meta!)).toBeLessThanOrEqual(MAX);
  const n = wakeIds(first).length;
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan(400);
  await store.acknowledge(P1, wakeIds(first));
  delivery.notify(P1);
  await advance(200);
  expect(wakeIds(session.sent[1]!)[0]).toBe(store.pending(P1)[0]!.reportId);
});

test("a report too large for any wake is delivered as a stub without its message, logged once", async () => {
  const huge = report({ title: "t".repeat(MAX), text: "x".repeat(MAX) });
  const small = report();
  await arrive(huge);
  await arrive(small);
  await advance(200);
  expect(session.sent.map(wakeIds)).toEqual([[huge.reportId, small.reportId]]);
  const sent = JSON.stringify(session.sent[0]!.blocks);
  expect(sent.length).toBeLessThan(MAX);
  expect(sent).toContain('\\"messageUnavailable\\":true');
  expect(sent).toContain(`\\"title\\":\\"${"t".repeat(60)}\\"`);
  await store.acknowledge(P1, [huge.reportId, small.reportId]);
  delivery.notify(P1);
  await advance(120_000);
  expect(session.sent).toHaveLength(1);
  expect(lines.filter(l => l.includes(huge.reportId))).toHaveLength(1);
  expect(timers).toEqual([]);
});

test("what delivery works out per report is dropped once the report is acknowledged, or its persona forgotten", async () => {
  const a = report();
  const b = report();
  await arrive(a);
  await arrive(b);
  await advance(200);
  expect(delivery.heldCount()).toBe(2);
  await store.acknowledge(P1, [a.reportId]);
  delivery.notify(P1);
  await advance(200);
  expect(delivery.heldCount()).toBe(1);
  delivery.forget(P1);
  expect(delivery.heldCount()).toBe(0);
  expect(timers).toEqual([]);
});

test("a wake the session rejects backs off instead of retrying every second", async () => {
  let calls = 0;
  session.prompt = async () => { calls++; throw new Error("pipe closed"); };
  await arrive(report());
  await advance(200 + 1000 + 2000 + 4000);
  expect(calls).toBe(4);
  expect(lines.filter(l => l.includes("pipe closed"))).toHaveLength(4);
});

test("record of a duplicate id returns false and wakes nothing", async () => {
  const r = report();
  await arrive(r);
  await advance(200);
  await store.acknowledge(P1, [r.reportId]);
  expect(await store.record(r)).toBe(false);
  delivery.notify(P1);
  await advance(60_000);
  expect(session.sent).toHaveLength(1);
});

test("a persona with no session is not woken until its launch changes", async () => {
  sessions.delete(P1);
  const r = report();
  await arrive(r);
  await advance(60_000);
  sessions.set(P1, session);
  delivery.onLaunchChanged(P1);
  await advance(200);
  expect(wakeIds(session.sent[0]!)).toEqual([r.reportId]);
});

test("each persona is woken with its own reports only", async () => {
  const other = new FakeSession();
  sessions.set(P2, other);
  const mine = report();
  const theirs = report({ personaId: P2, agentId: "w9" });
  await arrive(mine);
  await arrive(theirs);
  await advance(200);
  expect(session.sent.map(wakeIds)).toEqual([[mine.reportId]]);
  expect(other.sent.map(wakeIds)).toEqual([[theirs.reportId]]);
});

test("stop cancels every timer and later calls do nothing", async () => {
  await arrive(report());
  delivery.stop();
  expect(timers).toEqual([]);
  delivery.notify(P1);
  delivery.onPersonaState(P1, "ready");
  delivery.onLaunchChanged(P1);
  await advance(60_000);
  expect(session.sent).toHaveLength(0);
});

// --- wake-up text -------------------------------------------------------------

test("each kind of report is a wake-up reason", () => {
  expect(wakeUpReasonOf(report())).toBe("ended");
  expect(wakeUpReasonOf(report({ kind: "exited" }))).toBe("exited");
  // A turn cut off by a server stop is told apart from a finished one.
  expect(wakeUpReasonOf(report({ kind: "interrupted", messageUnavailable: true, text: "Done?" }))).toBe("interrupted");
  expect(wakeUpReasonOf(report({ text: "Done.\n\nShould I also update the docs?" }))).toBe("question");
  expect(wakeUpReasonOf(report({ text: "Was it the cache? Yes. Fixed." }))).toBe("ended");
  expect(wakeUpReasonOf(report({ kind: "exited", text: "Where did the socket go?" }))).toBe("exited");
});

test("isQuestion reads the last non-empty line, past trailing emphasis and quotes", () => {
  for (const q of ["Which branch?", "Which branch?  \n\n", "**Which branch?**", "“Which branch?”", "*Merge now?* "]) {
    expect(isQuestion(q)).toBe(true);
  }
  for (const n of ["**?**", "Which branch? (claude/fix or main)", "Shipped it.", "", "?"]) {
    expect(isQuestion(n)).toBe(false);
  }
});

test("one wake-up is one prompt naming every report in it, with the ack sentence and the JSON payload", () => {
  const a = report({ reportId: "r1" });
  const b = report({ reportId: "r2", agentId: "w2", title: "docs", text: "Which file?" });
  const c = report({ reportId: "r3", agentId: "w3", title: "", kind: "exited" });
  const d = report({ reportId: "r4", title: "migrate", kind: "interrupted", text: "", messageUnavailable: true });
  const prompt = wakeUpPrompt([a, b, c, d]);
  expect(prompt).toContain("- migrate was cut off by a restart; its last message is unavailable\n");
  expect(prompt.startsWith("Worker reports. Acknowledge received reportId values with ack on your next tool call.\n")).toBe(true);
  expect(prompt).toContain("- fix-pager finished\n");
  expect(prompt).toContain("- docs is asking you something\n");
  expect(prompt).toContain("- w3 stopped\n");
  const payload = JSON.parse(prompt.slice(prompt.indexOf("{"))) as { reports: AgentReport[] };
  expect(payload.reports.map(r => r.reportId)).toEqual(["r1", "r2", "r3", "r4"]);
  expect(() => wakeUpPrompt([])).toThrow("a wake-up needs at least one report");
});
