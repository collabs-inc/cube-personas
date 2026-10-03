import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Persona, Worker } from "../shared/types";

const PERSONA_ID = /^[0-9a-f-]{36}$/i;

/** Ids become path segments; refuse anything that could leave the state directory. */
export function assertPersonaId(id: string): void {
  if (!PERSONA_ID.test(id)) throw new Error("Invalid persona id.");
}

const SECRET_BYTES = 32;

/** The app's durable state: persona and worker tables, the HMAC secret and per-id directories. */
export class StateStore {
  private personaMap = new Map<string, Persona>();
  private workerMap = new Map<string, Worker>();
  private secretBytes: Buffer | null = null;
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string, private readonly log: (line: string) => void) {}

  async load(): Promise<void> {
    try { await mkdir(this.dir, { recursive: true, mode: 0o700 }); }
    catch { throw new Error(`Cannot create the state directory ${this.dir}.`); }
    for (const sub of ["records", "scrollback", "reports", "attention"]) {
      await mkdir(join(this.dir, sub), { recursive: true, mode: 0o700 });
    }
    this.personaMap = new Map((await this.readTable("personas.json", "personas", isPersona)).map(p => [p.id, p]));
    this.workerMap = new Map((await this.readTable("workers.json", "workers", isWorker)).map(w => [w.id, w]));
    this.secretBytes = await this.loadSecret();
  }

  personas(): Persona[] { return [...this.personaMap.values()]; }
  workers(): Worker[] { return [...this.workerMap.values()]; }

  /** A failed save rolls the row back in memory (see `rollBack`) and rethrows. */
  async putPersona(p: Persona): Promise<void> {
    assertPersonaId(p.id);
    const before = this.personaMap.get(p.id);
    this.personaMap.set(p.id, p);
    try {
      await this.persist("personas.json", () => this.personas());
    } catch (err) {
      rollBack(this.personaMap, before, p);
      throw err;
    }
  }

  async removePersona(id: string): Promise<void> {
    assertPersonaId(id);
    this.personaMap.delete(id);
    await this.persist("personas.json", () => this.personas());
  }

  /** A failed save rolls the row back in memory (see `rollBack`) and rethrows. */
  async putWorker(w: Worker): Promise<void> {
    const before = this.workerMap.get(w.id);
    this.workerMap.set(w.id, w);
    try {
      await this.persist("workers.json", () => this.workers());
    } catch (err) {
      rollBack(this.workerMap, before, w);
      throw err;
    }
  }

  async removeWorker(id: string): Promise<void> {
    this.workerMap.delete(id);
    await this.persist("workers.json", () => this.workers());
  }

  async removeWorkersOf(personaId: string): Promise<void> {
    for (const w of this.workers()) if (w.personaId === personaId) this.workerMap.delete(w.id);
    await this.persist("workers.json", () => this.workers());
  }

  secret(): Buffer {
    if (!this.secretBytes) throw new Error("State is not loaded.");
    return this.secretBytes;
  }

  recordsDir(personaId: string): string {
    assertPersonaId(personaId);
    return join(this.dir, "records", personaId);
  }

  scrollbackPath(workerId: string): string {
    assertPersonaId(workerId);
    return join(this.dir, "scrollback", workerId);
  }

  reportsDir(): string { return join(this.dir, "reports"); }
  spoolDir(): string { return join(this.dir, "attention"); }

  /**
   * A table's rows. A file that does not parse as an array is set aside as
   * `<name>.corrupt`; one that parses but holds rows of the wrong shape keeps
   * the good rows and drops the rest, with one line naming what was lost.
   */
  private async readTable<T>(name: string, what: string, valid: (row: unknown) => row is T): Promise<T[]> {
    const file = join(this.dir, name);
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
      if (!Array.isArray(value)) throw new Error("not an array");
    } catch {
      await rename(file, `${file}.corrupt`);
      this.log(`State file ${name} could not be read; ${what} were lost and it was kept as ${name}.corrupt.`);
      return [];
    }
    const rows = value as unknown[];
    const kept = rows.filter(valid);
    if (kept.length < rows.length) {
      const lost = rows.filter((row) => !valid(row)).map(idOf);
      this.log(`State file ${name} had ${lost.length} unreadable row${lost.length === 1 ? "" : "s"} (${lost.join(", ")}); they were dropped.`);
    }
    return kept;
  }

  private async loadSecret(): Promise<Buffer> {
    const file = join(this.dir, "secret");
    try {
      const existing = await readFile(file);
      if (existing.length === SECRET_BYTES) return existing;
      await rename(file, `${file}.corrupt`);
      this.log("State file secret had the wrong length; it was kept as secret.corrupt and a new one was made.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const fresh = randomBytes(SECRET_BYTES);
    await this.writeAtomic(file, fresh, 0o600);
    return fresh;
  }

  /** Serializes writes per file; each write snapshots the table when it runs. */
  private persist(name: string, snapshot: () => unknown): Promise<void> {
    const previous = this.queues.get(name) ?? Promise.resolve();
    const next = previous.catch(() => undefined)
      .then(() => this.writeAtomic(join(this.dir, name), JSON.stringify(snapshot(), null, 2), 0o600));
    this.queues.set(name, next);
    return next;
  }

  private async writeAtomic(file: string, data: string | Buffer, mode: number): Promise<void> {
    const tmp = join(dirname(file), `.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, data, { mode });
      await rename(tmp, file);
    } finally { await rm(tmp, { force: true }); }
  }
}

const HARNESSES = new Set(["claude", "codex"]);
const PERSONA_STATES = new Set(["starting", "ready", "busy", "stopped", "failed"]);
const WORKER_STATES = new Set(["running", "idle", "exited"]);

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && PERSONA_ID.test(v);
const str = (v: unknown): boolean => typeof v === "string";
const strOrNull = (v: unknown): boolean => v === null || typeof v === "string";
const pidOrNull = (v: unknown): boolean => v === null || (Number.isInteger(v) && (v as number) > 0);

/** A row named in the log by its id when it has a readable one. */
function idOf(row: unknown): string {
  return isRow(row) && typeof row.id === "string" ? JSON.stringify(row.id.slice(0, 64)) : "no id";
}

function isPersona(v: unknown): v is Persona {
  return isRow(v) && isId(v.id) && strOrNull(v.name) && HARNESSES.has(v.harness as string) && str(v.createdAt)
    && strOrNull(v.acpSessionId) && strOrNull(v.launchId) && pidOrNull(v.pid) && strOrNull(v.cmdline)
    && PERSONA_STATES.has(v.state as string) && (v.failure === undefined || str(v.failure)) && typeof v.unread === "boolean";
}

function isWorker(v: unknown): v is Worker {
  return isRow(v) && isId(v.id) && isId(v.personaId) && HARNESSES.has(v.harness as string) && str(v.cwd) && str(v.title)
    && strOrNull(v.sessionId) && str(v.launchId) && pidOrNull(v.pid) && strOrNull(v.cmdline)
    && WORKER_STATES.has(v.state as string) && (v.exitCode === undefined || typeof v.exitCode === "number")
    && str(v.createdAt) && strOrNull(v.lastReportId);
}

/**
 * Undoes a row change whose save failed, so memory never holds what disk
 * refused and a later save cannot persist it after all. Rows put since were
 * built from the failed one, so the undo is per field: each field the failed
 * put changed is restored wherever the row still holds the failed value. It
 * runs before the next queued save takes its snapshot.
 */
function rollBack<T extends { id: string }>(map: Map<string, T>, before: T | undefined, failed: T): void {
  const now = map.get(failed.id);
  if (now === undefined) return;
  if (before === undefined) {
    if (now === failed) map.delete(failed.id);
    return;
  }
  const prev = before as Record<string, unknown>;
  const bad = failed as Record<string, unknown>;
  const next: Record<string, unknown> = { ...(now as Record<string, unknown>) };
  for (const key of new Set([...Object.keys(prev), ...Object.keys(bad)])) {
    if (bad[key] === prev[key] || next[key] !== bad[key]) continue;
    if (key in prev) next[key] = prev[key];
    else delete next[key];
  }
  map.set(failed.id, next as T);
}
