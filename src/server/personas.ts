// The personas: each one's row, its record log, and the ACP session its
// adapter runs in. A persona's adapter runs in its context folder with the
// persona instructions and the app's MCP server, reached with a ticket bound
// to the current launch, so a relaunch revokes the previous adapter's ticket.
//
// Session events arrive from the session of the CURRENT launch only: a
// session replaced by a restart, ended by a delete or stopped for shutdown
// is ignored, so a late event can never overwrite the newer state.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  isNotification, isRequest, isResponse, type AgentRecord, type JsonRpcId, type JsonRpcMessage,
} from "../shared/agent-protocol";
import type { Harness, Persona, PersonaState } from "../shared/types";
import { PersonaSession } from "./acp/session";
import { seedContextFolder } from "./context-folder";
import { NO_SUCH_PERSONA, SHUTTING_DOWN, UserFacingError } from "./errors";
import { PERSONA_INSTRUCTION, personaArtifactInstruction } from "./instructions";
import { deriveTicket } from "./mcp/ticket";
import { appRoot, contextFolderOf } from "./paths";
import type { ProcessManager } from "./processes";
import { RecordLog } from "./record-log";
import type { Delivery } from "./reports/delivery";
import type { ReportStore } from "./reports/store";
import { assertPersonaId, type StateStore } from "./state";
import type { Workers } from "./workers/workers";

export const START_FAILED = "This persona could not start. Restart starts it again.";
export const RESUME_FAILED = "This persona could not be resumed. Restart starts it again.";
export const EXITED_UNEXPECTEDLY = "This persona stopped unexpectedly. Restart starts it again.";
export const NOT_RUNNING = "This persona is not running. Restart starts it again.";
export { SHUTTING_DOWN };
const MAX_NAME_CHARS = 80;
/** How often, and for how long, an adapter's command line is re-read until it settles after exec. */
const CMDLINE_POLL_MS = 50;
const CMDLINE_POLL_FOR_MS = 3000;

export interface PersonasDeps {
  state: StateStore;
  processes: ProcessManager;
  workers: Workers;
  reports: ReportStore;
  delivery: Delivery;
  /** The environment adapters run in; also where the test-only adapter overrides are read. */
  env: NodeJS.ProcessEnv;
  /** The port the app listens on, for the persona's MCP URL. */
  port(): number;
  log(line: string): void;
}

export interface OpenResult {
  /** The records after `startSeq`, up to `seq`. */
  records: AgentRecord[];
  /**
   * The seq `records` follow on from: the cursor the page sent, or, when the
   * page sent none or one older than what memory holds, where the trailing
   * window begins. A page whose cursor differs replaces its transcript.
   */
  startSeq: number;
  seq: number;
  state: PersonaState;
  activePrompt: string | null;
}

interface Entry {
  log: RecordLog;
  /** Follows the log's prompts and answers, so a cut-off turn is known without rereading the log. */
  prompts: PromptTracker;
  /** The current launch's session; null before the first launch and after a failed one. */
  session: PersonaSession | null;
  /** The current launch, whose ticket the MCP route accepts; null whenever no adapter should hold one. */
  launchId: string | null;
  /** True while the current launch's `start()` settles: its failure is reported once, by `launch()`. */
  launching: boolean;
  /** Set when deletion begins. */
  removed: boolean;
}

type LaunchMode = "start" | "resume";

export class Personas {
  private readonly entries = new Map<string, Entry>();
  private readonly changeListeners: Array<(personas: Persona[]) => void> = [];
  private readonly frameListeners: Array<(id: string, record: AgentRecord) => void> = [];
  private readonly stateListeners: Array<(id: string, state: PersonaState, activePrompt: string | null) => void> = [];
  private closing = false;

  constructor(private readonly deps: PersonasDeps) {}

  onChange(cb: (personas: Persona[]) => void): void { this.changeListeners.push(cb); }
  onFrame(cb: (id: string, record: AgentRecord) => void): void { this.frameListeners.push(cb); }
  onState(cb: (id: string, state: PersonaState, activePrompt: string | null) => void): void { this.stateListeners.push(cb); }

  list(): Persona[] {
    return this.deps.state.personas();
  }

  /** True for a persona that exists and is not being deleted. */
  exists(id: string): boolean {
    return this.find(id) !== undefined && this.entries.get(id)?.removed !== true;
  }

  sessionOf(id: string): PersonaSession | null {
    return this.entries.get(id)?.session ?? null;
  }

  /** The launch whose MCP ticket is valid now, or null. */
  currentLaunch(id: string): string | null {
    return this.entries.get(id)?.launchId ?? null;
  }

  isShuttingDown(): boolean {
    return this.closing;
  }

  /** From now on nothing new is spawned: creates, restarts and resumes are refused. */
  beginShutdown(): void {
    this.closing = true;
  }

  async create(harness: Harness): Promise<Persona> {
    this.assertOpen();
    if (harness !== "claude" && harness !== "codex") throw new UserFacingError('harness must be "claude" or "codex".');
    const id = randomUUID();
    assertPersonaId(id);
    await seedContextFolder(contextFolderOf(id));
    const prompts = new PromptTracker();
    const log = new RecordLog(this.deps.state.recordsDir(id), { observe: (r) => prompts.observe(r) });
    await log.open();
    const persona: Persona = {
      id, name: null, harness, createdAt: new Date().toISOString(), acpSessionId: null, launchId: null,
      pid: null, cmdline: null, state: "starting", unread: false,
    };
    this.entries.set(id, { log, prompts, session: null, launchId: null, launching: false, removed: false });
    await this.deps.state.putPersona(persona);
    this.changed();
    // The page opens the persona at once and follows its state; a failed start is shown on the row.
    void this.launch(id, "start");
    return persona;
  }

  async rename(id: string, name: string): Promise<void> {
    this.row(id);
    if (typeof name !== "string") throw new UserFacingError("A name must be text.");
    const trimmed = Array.from(name.trim()).slice(0, MAX_NAME_CHARS).join("");
    await this.patch(id, { name: trimmed === "" ? null : trimmed }, true);
  }

  /** Stops the persona and its workers and removes everything of it except its context folder. */
  async delete(id: string): Promise<{ contextFolder: string }> {
    this.row(id);
    const entry = this.entries.get(id);
    const session = entry?.session ?? null;
    if (entry) {
      entry.removed = true;
      entry.launchId = null;
      entry.session = null;
    }
    await session?.stop();
    const workers = this.deps.workers.list(id);
    for (const w of workers) {
      await this.deps.workers.stop(id, w.id).catch((err) => this.deps.log(`persona ${id}: stopping worker ${w.id} failed: ${String(err)}`));
    }
    await this.deps.state.removeWorkersOf(id);
    // A worker whose spawn landed while this ran has no row now: end it too.
    await this.deps.workers.stopOrphans();
    await this.deps.state.removePersona(id);
    this.entries.delete(id);
    this.deps.delivery.forget(id);
    this.changed();
    const leftovers = [
      rm(this.deps.state.recordsDir(id), { recursive: true, force: true }),
      ...workers.map((w) => rm(this.deps.state.scrollbackPath(w.id), { force: true })),
      this.deps.reports.removePersona(id),
    ];
    for (const result of await Promise.allSettled(leftovers)) {
      if (result.status === "rejected") this.deps.log(`persona ${id}: could not remove its saved data: ${String(result.reason)}`);
    }
    return { contextFolder: contextFolderOf(id) };
  }

  open(id: string, sinceSeq?: number): OpenResult {
    const row = this.row(id);
    const entry = this.entry(id);
    const since = typeof sinceSeq === "number" && Number.isInteger(sinceSeq) && sinceSeq > 0 ? sinceSeq : 0;
    // Only the trailing window is sent: the rest stays on disk.
    const startSeq = Math.max(since, entry.log.windowStart());
    return {
      records: entry.log.since(startSeq),
      startSeq,
      seq: entry.log.seq(),
      state: row.state,
      activePrompt: entry.session?.activePrompt() ?? null,
    };
  }

  /**
   * From the page: a prompt, a `session/cancel` or a permission answer. A
   * prompt carries the reports delivery proposes, appended after the
   * person's words; they are marked carried only once the session admits it.
   */
  async send(id: string, message: JsonRpcMessage): Promise<void> {
    const row = this.row(id);
    const session = this.entry(id).session;
    if (session === null || row.state === "stopped" || row.state === "failed") throw new UserFacingError(NOT_RUNNING);
    if (!isRequest(message) || message.method !== "session/prompt") {
      await session.send(message);
      return;
    }
    const params = isObject(message.params) ? message.params : {};
    const blocks = Array.isArray(params.prompt) ? (params.prompt as ContentBlock[]) : [];
    const proposal = this.deps.delivery.beforeUserPrompt(id, blocks);
    const meta = mergeMeta(params._meta, proposal.meta);
    await session.send({
      ...message,
      params: { ...params, prompt: proposal.blocks, ...(meta === undefined ? {} : { _meta: meta }) },
    });
    this.deps.delivery.carried(id, proposal.carried);
  }

  /** Ends the current adapter, if any, and starts a new one on the same conversation. */
  async restart(id: string): Promise<void> {
    this.assertOpen();
    this.row(id);
    const entry = this.entry(id);
    const old = entry.session;
    entry.session = null;
    entry.launchId = null;
    await old?.stop();
    await this.launch(id, "start");
  }

  async markRead(id: string): Promise<void> {
    if (!this.row(id).unread) return;
    await this.patch(id, { unread: false }, true);
  }

  /**
   * After a start: loads every persona's record log and resumes each one
   * recorded as running, on its stored ACP session. One already loaded in
   * this run is skipped, so calling this twice starts nothing twice.
   */
  async resumeAll(): Promise<void> {
    const launches: Array<Promise<void>> = [];
    for (const row of this.deps.state.personas()) {
      if (this.entries.has(row.id)) continue;
      let log: RecordLog;
      const prompts = new PromptTracker();
      try {
        log = new RecordLog(this.deps.state.recordsDir(row.id), { observe: (r) => prompts.observe(r) });
        await log.open();
      } catch (err) {
        this.deps.log(`persona ${row.id}: its conversation could not be read: ${String(err)}`);
        continue;
      }
      this.entries.set(row.id, { log, prompts, session: null, launchId: null, launching: false, removed: false });
      // The previous run's adapter was reaped before this; its pid and ticket mean nothing now.
      const running = row.state === "starting" || row.state === "ready" || row.state === "busy";
      if (!running) {
        if (row.pid !== null || row.cmdline !== null || row.launchId !== null) await this.patch(row.id, { pid: null, cmdline: null, launchId: null });
        continue;
      }
      launches.push(this.launch(row.id, "resume"));
    }
    await Promise.all(launches);
  }

  /** Stops every adapter for a server shutdown WITHOUT recording it: rows keep their state so the next start resumes them. */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.entries.values()].map(async (entry) => {
      const session = entry.session;
      entry.launchId = null;
      await session?.stop().catch((err) => this.deps.log(`persona adapter: stopping failed: ${String(err)}`));
    }));
  }

  // --- internals ---------------------------------------------------------

  /** Never throws: a failure lands on the row as one state change and one sentence. */
  private async launch(id: string, mode: LaunchMode): Promise<void> {
    const entry = this.entries.get(id);
    const row = this.find(id);
    if (!entry || !row || entry.removed || this.closing) return;
    this.closeCutOffTurn(id, entry);
    const launchId = randomUUID();
    // Assigned before any event can fire: the session's events check it is still the current one.
    let session!: PersonaSession;
    const current = (): boolean => entry.session === session && !entry.removed;
    session = new PersonaSession(entry.log, this.deps.processes, {
      frame: (record) => {
        if (!current()) return;
        this.emitFrame(id, record);
        if (isReply(record) && this.find(id)?.unread === false) void this.patch(id, { unread: true });
      },
      state: (state, activePrompt) => {
        if (!current() || this.closing) return;
        if (entry.launching && state === "failed") return;
        void this.patch(id, state === "failed" ? { state } : { state, failure: undefined });
        this.emitState(id, state, activePrompt);
        this.deps.delivery.onPersonaState(id, state);
      },
      // Saved before the session is used: a session whose id is not on disk
      // would be replaced by a fresh one at the next start, silently.
      sessionId: async (sessionId) => {
        if (!current() || this.find(id)?.acpSessionId === sessionId) return;
        await this.patch(id, { acpSessionId: sessionId }, true);
      },
      exited: (code, stderrTail) => {
        if (!current()) return;
        // The stderr tail goes to the server log, never to the page, but the
        // log is shown to the person: a bearer ticket an adapter printed is cut out.
        const tail = stderrTail ? redactTickets(stderrTail.slice(-2000)) : "";
        this.deps.log(`persona ${id}: adapter exited with code ${code}${tail ? `; its stderr ended: ${tail}` : ""}`);
        if (entry.launching) return;
        entry.launchId = null;
        this.closeCutOffTurn(id, entry);
        // The session's "failed" state follows and keeps this sentence.
        void this.patch(id, { failure: EXITED_UNEXPECTEDLY, launchId: null, pid: null, cmdline: null });
      },
      spawned: (pid) => {
        // A delete or a shutdown that came while the launch was still preparing: end what it spawned.
        if (!current() || this.closing) void session.stop();
        else this.recordAdapter(id, pid, current);
      },
    });
    entry.session = session;
    entry.launchId = launchId;
    entry.launching = true;
    await this.patch(id, { launchId, pid: null, cmdline: null, failure: undefined });
    this.deps.delivery.onLaunchChanged(id);

    const folder = contextFolderOf(id);
    const instructions = `${PERSONA_INSTRUCTION}\n\n${personaArtifactInstruction(folder)}`;
    let failed = false;
    try {
      await seedContextFolder(folder);
      if (!current() || this.closing) return;
      await session.start({
        command: this.adapterCommand(row.harness),
        args: [],
        cwd: folder,
        env: this.deps.env,
        harness: row.harness,
        // A persona that never finished a handshake has no session to load: it starts a
        // fresh one, and whatever its log holds stays.
        resumeSessionId: row.acpSessionId,
        mcpServer: {
          url: `http://127.0.0.1:${this.deps.port()}/mcp?persona=${id}`,
          ticket: deriveTicket(this.deps.state.secret(), id, launchId),
        },
        systemPromptAppend: instructions,
        codexDeveloperInstructions: instructions,
      });
    } catch (err) {
      failed = true;
      this.deps.log(`persona ${id}: ${mode === "resume" ? "resume" : "start"} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (entry.session === session) entry.launching = false;
    if (!failed || !current() || this.closing) return;
    const state: PersonaState = mode === "resume" ? "stopped" : "failed";
    entry.session = null;
    entry.launchId = null;
    await this.patch(id, { state, failure: mode === "resume" ? RESUME_FAILED : START_FAILED, launchId: null, pid: null, cmdline: null });
    this.emitState(id, state, null);
    this.deps.delivery.onPersonaState(id, state);
  }

  /**
   * A turn the log shows a prompt for but no answer to was cut off (by a
   * stop, a crash, or an adapter that died). The log is given a closing
   * answer for it — `cancelled`, marked interrupted with its message
   * unavailable — so the conversation shows the turn as ended. It is a
   * record only: nothing is written to an adapter.
   */
  private closeCutOffTurn(id: string, entry: Entry): void {
    const cutOff = entry.prompts.cutOff();
    if (cutOff === null) return;
    const record = entry.log.append("out", {
      jsonrpc: "2.0",
      id: cutOff,
      result: { stopReason: "cancelled", _meta: { cube: { interrupted: true, messageUnavailable: true } } },
    });
    this.emitFrame(id, record);
  }

  /**
   * Records the adapter's pid at once and its command line once it has
   * settled after exec (the same on two reads, and not the server's own
   * fork), so a later start can reap it only while it still runs this.
   */
  private recordAdapter(id: string, pid: number, current: () => boolean): void {
    void this.patch(id, { pid, cmdline: null });
    const parent = this.deps.processes.cmdlineOf(process.pid);
    const deadline = Date.now() + CMDLINE_POLL_FOR_MS;
    let previous: string | null = null;
    const timer = setInterval(() => {
      if (!current() || Date.now() > deadline) {
        clearInterval(timer);
        return;
      }
      const cmdline = this.deps.processes.cmdlineOf(pid);
      if (cmdline !== null && cmdline !== parent && cmdline === previous) {
        clearInterval(timer);
        void this.patch(id, { cmdline });
        return;
      }
      previous = cmdline;
    }, CMDLINE_POLL_MS);
    timer.unref();
  }

  private adapterCommand(harness: Harness): string {
    const override = harness === "claude" ? this.deps.env.PERSONAS_ADAPTER_CLAUDE : this.deps.env.PERSONAS_ADAPTER_CODEX;
    if (override) return override;
    return join(appRoot(), "node_modules", ".bin", harness === "claude" ? "claude-agent-acp" : "codex-acp");
  }

  private assertOpen(): void {
    if (this.closing) throw new UserFacingError(SHUTTING_DOWN);
  }

  private find(id: string): Persona | undefined {
    return this.deps.state.personas().find((p) => p.id === id);
  }

  /** The persona's row; ids come from the page, so anything malformed is simply not a persona. */
  private row(id: string): Persona {
    try {
      assertPersonaId(id);
    } catch {
      throw new UserFacingError(NO_SUCH_PERSONA);
    }
    const row = this.find(id);
    if (!row || this.entries.get(id)?.removed) throw new UserFacingError(NO_SUCH_PERSONA);
    return row;
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry || entry.removed) throw new UserFacingError(NO_SUCH_PERSONA);
    return entry;
  }

  /**
   * Read-modify-write, synchronous up to putPersona (which takes the new row
   * at once). `failure: undefined` in the patch clears the failure. A failed
   * save is logged, or with `strict` rethrown.
   */
  private async patch(id: string, patch: Partial<Persona>, strict = false): Promise<void> {
    const current = this.find(id);
    if (!current || this.entries.get(id)?.removed) return;
    const next: Persona = { ...current, ...patch };
    if ("failure" in patch && patch.failure === undefined) delete next.failure;
    try {
      await this.deps.state.putPersona(next);
    } catch (err) {
      this.deps.log(`persona ${id}: could not save its state: ${String(err)}`);
      if (strict) throw err;
    }
    this.changed();
  }

  private changed(): void {
    const personas = this.list();
    for (const cb of this.changeListeners) this.safely(() => cb(personas));
  }

  private emitFrame(id: string, record: AgentRecord): void {
    for (const cb of this.frameListeners) this.safely(() => cb(id, record));
  }

  private emitState(id: string, state: PersonaState, activePrompt: string | null): void {
    for (const cb of this.stateListeners) this.safely(() => cb(id, state, activePrompt));
  }

  private safely(run: () => void): void {
    try {
      run();
    } catch (err) {
      this.deps.log(`a persona listener failed: ${String(err)}`);
    }
  }
}

/**
 * The log's last `session/prompt` and whether an answer to it has followed,
 * fed every record as the log reads and appends it. A prompt with no answer
 * after it is a cut-off turn.
 */
class PromptTracker {
  private last: { id: JsonRpcId; answered: boolean } | null = null;

  observe({ dir, message }: AgentRecord): void {
    if (dir === "in" && isRequest(message) && message.method === "session/prompt") {
      this.last = { id: message.id, answered: false };
    } else if (dir === "out" && isResponse(message) && this.last !== null && String(message.id) === String(this.last.id)) {
      this.last.answered = true;
    }
  }

  cutOff(): JsonRpcId | null {
    return this.last !== null && !this.last.answered ? this.last.id : null;
  }
}

/** Replaces every MCP bearer ticket (64 hex characters) in `text`. */
export function redactTickets(text: string): string {
  return text.replace(/(Bearer\s+)[0-9a-f]{64}/gi, "$1[redacted]");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A chunk of the persona's reply, as the adapter sent it (replays are never recorded). */
function isReply(record: AgentRecord): boolean {
  const message = record.message;
  if (record.dir !== "out" || !isNotification(message) || message.method !== "session/update") return false;
  const update = isObject(message.params) ? message.params.update : undefined;
  return isObject(update) && update.sessionUpdate === "agent_message_chunk";
}

/** The page's `_meta` with delivery's merged in, `cube` merged key by key; the page's own keys survive. */
function mergeMeta(page: unknown, ours: Record<string, unknown>): Record<string, unknown> | undefined {
  if (Object.keys(ours).length === 0) return isObject(page) ? page : undefined;
  if (!isObject(page)) return ours;
  const cube = isObject(page.cube) && isObject(ours.cube) ? { ...page.cube, ...ours.cube } : ours.cube ?? page.cube;
  return { ...page, ...ours, ...(cube === undefined ? {} : { cube }) };
}
