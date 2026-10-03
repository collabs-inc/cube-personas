import { afterEach, beforeEach, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPersonaId, StateStore } from "../../src/server/state";
import type { Persona, Worker } from "../../src/shared/types";

let base = "";
let lines: string[] = [];
const log = (line: string) => { lines.push(line); };
beforeEach(async () => { lines = []; base = await mkdtemp(join(tmpdir(), "personas-state-")); });
afterEach(async () => { await chmod(join(base, "locked"), 0o700).catch(() => undefined); await rm(base, { recursive: true, force: true }); });

const ID = "11111111-2222-3333-4444-555555555555";
const persona = (id = ID): Persona => ({
  id, name: null, harness: "claude", createdAt: "2026-10-03T00:00:00.000Z", acpSessionId: null,
  launchId: null, pid: null, cmdline: null, state: "ready", unread: false,
});
const worker = (id: string): Worker => ({
  id, personaId: ID, harness: "claude", cwd: "/tmp", title: "w", sessionId: null, launchId: "l",
  pid: null, cmdline: null, state: "idle", createdAt: "2026-10-03T00:00:00.000Z", lastReportId: null,
});
const mode = async (p: string) => (await stat(p)).mode & 0o777;

test("first load creates the secret (0600) and the directories (0700)", async () => {
  const dir = join(base, "state");
  const store = new StateStore(dir, log);
  await store.load();
  expect(await mode(join(dir, "secret"))).toBe(0o600);
  expect((await readFile(join(dir, "secret"))).length).toBe(32);
  expect(store.secret().equals(await readFile(join(dir, "secret")))).toBe(true);
  for (const sub of ["records", "scrollback", "reports", "attention"]) expect(await mode(join(dir, sub))).toBe(0o700);
  const again = new StateStore(dir, log);
  await again.load();
  expect(again.secret().equals(store.secret())).toBe(true);
  expect((await readdir(dir)).filter(n => n.endsWith(".tmp"))).toEqual([]);
});

test("a persona survives a new store", async () => {
  const dir = join(base, "state");
  const a = new StateStore(dir, log);
  await a.load();
  await a.putPersona(persona());
  const b = new StateStore(dir, log);
  await b.load();
  expect(b.personas()).toEqual([persona()]);
  await b.removePersona(ID);
  const c = new StateStore(dir, log);
  await c.load();
  expect(c.personas()).toEqual([]);
});

test("a corrupt personas.json is set aside, the store loads empty and logs one line", async () => {
  const dir = join(base, "state");
  await new StateStore(dir, log).load();
  await writeFile(join(dir, "personas.json"), "{");
  const b = new StateStore(dir, log);
  await b.load();
  expect(b.personas()).toEqual([]);
  expect(await readFile(join(dir, "personas.json.corrupt"), "utf8")).toBe("{");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("personas.json");
});

test("concurrent putWorker calls both persist, and removeWorkersOf drops a persona's workers", async () => {
  const dir = join(base, "state");
  const a = new StateStore(dir, log);
  await a.load();
  const w1 = "aaaaaaaa-0000-0000-0000-000000000001";
  const w2 = "aaaaaaaa-0000-0000-0000-000000000002";
  await Promise.all([a.putWorker(worker(w1)), a.putWorker(worker(w2))]);
  const b = new StateStore(dir, log);
  await b.load();
  expect(b.workers().map(w => w.id).sort()).toEqual([w1, w2]);
  await b.removeWorkersOf(ID);
  const c = new StateStore(dir, log);
  await c.load();
  expect(c.workers()).toEqual([]);
});

test("the state directory cannot be created under an unwritable parent, and the error names it", async () => {
  if (process.getuid?.() === 0) return; // root ignores permission bits
  const parent = join(base, "locked");
  await mkdir(parent);
  await chmod(parent, 0o500);
  const dir = join(parent, "state");
  await expect(new StateStore(dir, log).load()).rejects.toThrow(dir);
});

test("ids that become paths must be UUID-shaped", async () => {
  const store = new StateStore(join(base, "state"), log);
  await store.load();
  expect(store.recordsDir(ID)).toBe(join(base, "state", "records", ID));
  expect(store.scrollbackPath(ID)).toBe(join(base, "state", "scrollback", ID));
  for (const bad of ["../x", "", "a/b", ID + "/..", "x".repeat(36)]) {
    expect(() => assertPersonaId(bad)).toThrow();
    expect(() => store.recordsDir(bad)).toThrow();
    expect(() => store.scrollbackPath(bad)).toThrow();
    await expect(store.removePersona(bad)).rejects.toThrow();
  }
});

test("a persona save that fails leaves memory as disk has it, and a later save does not persist the refused value", async () => {
  const dir = join(base, "locked");
  const store = new StateStore(dir, log);
  await store.load();
  await store.putPersona(persona());
  await chmod(dir, 0o500);
  await expect(store.putPersona({ ...persona(), acpSessionId: "unsaved" })).rejects.toThrow();
  expect(store.personas()[0]!.acpSessionId).toBeNull();
  await chmod(dir, 0o700);
  await store.putPersona({ ...store.personas()[0]!, state: "busy" });
  const again = new StateStore(dir, log);
  await again.load();
  expect(again.personas()).toEqual([{ ...persona(), state: "busy" }]);
});

test("a row built on a failed save loses only the refused field", async () => {
  const dir = join(base, "locked");
  const store = new StateStore(dir, log);
  await store.load();
  await store.putPersona(persona());
  await chmod(dir, 0o500);
  const failing = store.putPersona({ ...persona(), acpSessionId: "unsaved" });
  // Built from memory while the first save is still in flight, as Personas.patch does.
  const derived = store.putPersona({ ...store.personas()[0]!, pid: 42 });
  await expect(failing).rejects.toThrow();
  await expect(derived).rejects.toThrow();
  expect(store.personas()[0]).toEqual(persona());
  await chmod(dir, 0o700);
});

test("a new persona whose first save fails is not kept in memory", async () => {
  const dir = join(base, "locked");
  const store = new StateStore(dir, log);
  await store.load();
  await chmod(dir, 0o500);
  await expect(store.putPersona(persona())).rejects.toThrow();
  expect(store.personas()).toEqual([]);
  await chmod(dir, 0o700);
});
