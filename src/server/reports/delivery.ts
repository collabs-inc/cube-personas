// Adapted from cube-computer: ReportDelivery in src/main/cubed/mcp/tools.ts and src/main/cubed/acp/queued-reports.ts
//
// Getting worker reports in front of the persona, at least once.
//
// An idle persona is woken with one prompt carrying every unacknowledged
// report (`_meta.cube.report`). A busy one is never interrupted: the reports
// wait for its next admitted prompt — a wake when it returns to `ready`, or
// the person's own prompt, which carries them in a block appended after the
// person's words (`_meta.cube.carriedReports`). The person's words are the
// subject of that turn and the reports are context for it, so they go after.
//
// Carrying is two steps: `beforeUserPrompt` only proposes the reports, and
// `carried` marks them once the session admitted that prompt, so a prompt
// refused (busy, too large, a session gone) takes nothing with it. A carried
// report is not woken while its carrying turn runs; once that turn ends it is
// an ordinary unacknowledged report again, its carry counted as one attempt.
//
// Nothing here acknowledges a report: only the persona's `ack` does. An
// accepted wake may still go unread, so an unacknowledged report is woken
// again on a backoff of 1 s doubling to 30 s, reset whenever the set of
// reports due changes or the persona is relaunched.
//
// Every prompt is measured whole, as the session will serialize it, adding
// reports oldest first until the next would not fit on one pipe line. A
// report too large to fit even alone (which report text and title caps make
// unreachable in practice) is sent as a stub: its text dropped and
// `messageUnavailable` set, so the persona still learns the worker reported
// and can acknowledge it. It is logged once.
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { MAX_PIPE_LINE_BYTES } from "../../shared/agent-protocol";
import type { AgentReport, PersonaState } from "../../shared/types";
import type { PersonaSession } from "../acp/session";
import type { ReportStore } from "./store";
import { wakeUpPrompt } from "./wake-ups";

/** What delivery needs of a persona's session. */
export type DeliverySession = Pick<PersonaSession, "state" | "prompt">;

export interface DeliveryDeps {
  reports: ReportStore;
  sessionOf(personaId: string): DeliverySession | null;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  log(line: string): void;
}

export interface UserPrompt {
  blocks: ContentBlock[];
  meta: Record<string, unknown>;
  /** The reports this prompt carries; pass them to `carried` once the session admits it. */
  carried: string[];
}

/** Reports arriving this close together share one wake. */
const BATCH_MS = 100;
/** How often a wake refused as busy is tried again, besides on `ready`. */
const BUSY_RETRY_MS = 1000;
/**
 * Stand-ins for the request id and ACP session id the session fills in, and
 * room for any `_meta` a page adds: measured generously, so a fitted prompt
 * always fits once the real values are in.
 */
const ID_STAND_IN = "x".repeat(128);
const SLACK_BYTES = 1024;

/** How long a delivery holds off the next wake: 1 s, doubling, to 30 s. */
export const backoffMs = (attempts: number): number =>
  Math.min(30_000, 1000 * 2 ** Math.min(Math.max(attempts, 1) - 1, 5));

interface PersonaDelivery {
  batch: unknown;
  retry: unknown;
  /** The last delivery (a wake, or a carry): which reports were due, how many tries, and when. */
  wake: { signature: string; attempts: number; at: number } | null;
  /** Reports carried by a person's prompt whose turn is still running. */
  carried: Set<string>;
  /** A wake's `prompt()` has not settled yet. */
  sending: boolean;
}

/** The pipe line `session.prompt` / `session.send` would write, in bytes. */
function lineBytes(blocks: ContentBlock[], meta: Record<string, unknown>): number {
  const request = {
    jsonrpc: "2.0", id: ID_STAND_IN, method: "session/prompt",
    params: { sessionId: ID_STAND_IN, prompt: blocks, _meta: meta },
  };
  return Buffer.byteLength(JSON.stringify(request), "utf8") + 1 + SLACK_BYTES;
}

const signatureOf = (reports: readonly AgentReport[]): string => reports.map(r => r.reportId).join("\n");

/** A stub's title is cut as a worker title is; a cwd longer than any real path is dropped. */
const STUB_TITLE_CHARS = 60;
const STUB_CWD_BYTES = 4096;

export class Delivery {
  private readonly personas = new Map<string, PersonaDelivery>();
  /**
   * Per persona, per pending report id, what is sent for it: itself, or a
   * stub when it cannot fit alone (null: not even that). Holds only reports
   * still pending: `due` drops the rest each time it runs.
   */
  private readonly sendable = new Map<string, Map<string, AgentReport | null>>();
  private closed = false;

  constructor(private readonly deps: DeliveryDeps) {}

  /** New reports may be pending for this persona. */
  notify(personaId: string): void {
    if (this.closed) return;
    const p = this.entry(personaId);
    if (p.batch !== null) return;
    p.batch = this.deps.setTimer(() => {
      p.batch = null;
      this.attempt(personaId);
    }, BATCH_MS);
  }

  /**
   * The persona's session changed state. Anything but `busy` ends the turn a
   * person's prompt carried reports on, so they become due again. A return to
   * `ready` retries after the batch window, so a prompt the person queued
   * while it was busy (sent by the page the moment it sees `ready`) is
   * admitted first and carries the reports itself.
   */
  onPersonaState(personaId: string, state: PersonaState): void {
    if (this.closed || state === "busy") return;
    this.personas.get(personaId)?.carried.clear();
    if (state === "ready") this.notify(personaId);
  }

  /** The persona was relaunched: the backoff and anything carried start over. */
  onLaunchChanged(personaId: string): void {
    if (this.closed) return;
    const p = this.entry(personaId);
    p.carried.clear();
    p.wake = null;
    this.notify(personaId);
  }

  /**
   * The person's prompt with the pending reports not already riding on a
   * running turn appended after their words, as many as fit on the line.
   * Marks nothing: call `carried` with the returned ids once the session
   * admitted the prompt.
   */
  beforeUserPrompt(personaId: string, blocks: ContentBlock[]): UserPrompt {
    const untouched: UserPrompt = { blocks, meta: {}, carried: [] };
    if (this.closed) return untouched;
    let best = untouched;
    const included: AgentReport[] = [];
    for (const report of this.due(personaId)) {
      const candidate = this.userPromptWith(blocks, [...included, report]);
      if (lineBytes(candidate.blocks, candidate.meta) > MAX_PIPE_LINE_BYTES) break;
      included.push(report);
      best = candidate;
    }
    return best;
  }

  /**
   * The session admitted a person's prompt carrying these reports. They are
   * not woken while its turn runs, and the carry counts as a delivery for the
   * backoff that follows. A turn that has already ended marks nothing.
   */
  carried(personaId: string, ids: string[]): void {
    if (this.closed || !ids.length) return;
    if (this.deps.sessionOf(personaId)?.state() !== "busy") {
      this.notify(personaId);
      return;
    }
    const p = this.entry(personaId);
    const signature = signatureOf(this.due(personaId));
    const attempts = p.wake?.signature === signature ? p.wake.attempts : 0;
    p.wake = { signature, attempts: attempts + 1, at: this.deps.now() };
    for (const id of ids) p.carried.add(id);
  }

  stop(): void {
    this.closed = true;
    for (const p of this.personas.values()) {
      if (p.batch !== null) this.deps.clearTimer(p.batch);
      if (p.retry !== null) this.deps.clearTimer(p.retry);
    }
    this.personas.clear();
  }

  // --- internals ---------------------------------------------------------

  private entry(personaId: string): PersonaDelivery {
    let p = this.personas.get(personaId);
    if (!p) {
      p = { batch: null, retry: null, wake: null, carried: new Set(), sending: false };
      this.personas.set(personaId, p);
    }
    return p;
  }

  /** Pending reports not riding on a running turn, each as it can be sent. */
  private due(personaId: string): AgentReport[] {
    const carried = this.personas.get(personaId)?.carried;
    const pending = this.deps.reports.pending(personaId);
    // Forget what was worked out for reports no longer pending (acknowledged or removed).
    const known = this.sendable.get(personaId);
    if (known) {
      const ids = new Set(pending.map(r => r.reportId));
      for (const id of known.keys()) if (!ids.has(id)) known.delete(id);
      if (known.size === 0) this.sendable.delete(personaId);
    }
    const out: AgentReport[] = [];
    for (const r of pending) {
      if (carried?.has(r.reportId)) continue;
      const sendable = this.sendableOf(personaId, r);
      if (sendable !== null) out.push(sendable);
    }
    return out;
  }

  /** Forgets everything held for a deleted persona. */
  forget(personaId: string): void {
    const p = this.personas.get(personaId);
    if (p) {
      for (const timer of [p.batch, p.retry]) if (timer !== null) this.deps.clearTimer(timer);
      this.personas.delete(personaId);
    }
    this.sendable.delete(personaId);
  }

  /** How many reports' sendable forms are held, across personas (for tests). */
  heldCount(): number {
    let n = 0;
    for (const m of this.sendable.values()) n += m.size;
    return n;
  }

  /** The report itself when a wake carrying it alone fits on one line; else a stub without its text. */
  private sendableOf(personaId: string, report: AgentReport): AgentReport | null {
    let held = this.sendable.get(personaId);
    const known = held?.get(report.reportId);
    if (known !== undefined) return known;
    const fits = (r: AgentReport): boolean => {
      const alone = this.wakeWith([r]);
      return lineBytes(alone.blocks, alone.meta) <= MAX_PIPE_LINE_BYTES;
    };
    let result: AgentReport | null = report;
    if (!fits(report)) {
      const stub: AgentReport = {
        ...report,
        text: "",
        messageUnavailable: true,
        title: Array.from(report.title).slice(0, STUB_TITLE_CHARS).join(""),
        cwd: Buffer.byteLength(report.cwd) > STUB_CWD_BYTES ? "" : report.cwd,
      };
      result = fits(stub) ? stub : null;
      this.deps.log(result
        ? `Worker report ${report.reportId} for persona ${personaId} is too large to deliver; it is sent without its message.`
        : `Worker report ${report.reportId} for persona ${personaId} is too large to deliver and was skipped.`);
    }
    if (!held) {
      held = new Map();
      this.sendable.set(personaId, held);
    }
    held.set(report.reportId, result);
    return result;
  }

  private userPromptWith(blocks: ContentBlock[], reports: AgentReport[]): UserPrompt {
    const ids = reports.map(r => r.reportId);
    const block = { type: "text", text: wakeUpPrompt(reports), _meta: { cube: { carriedReports: ids } } } as ContentBlock;
    return { blocks: [...blocks, block], meta: { cube: { carriedReports: ids } }, carried: ids };
  }

  private wakeWith(reports: AgentReport[]): { blocks: ContentBlock[]; meta: Record<string, unknown> } {
    return {
      blocks: [{ type: "text", text: wakeUpPrompt(reports) }],
      meta: { cube: { report: true, reportIds: reports.map(r => r.reportId) } },
    };
  }

  /** Oldest first while they fit (every due report fits alone: `due` sends a stub for one that does not). */
  private fittedWake(due: readonly AgentReport[]): AgentReport[] {
    const included: AgentReport[] = [];
    for (const report of due) {
      const wake = this.wakeWith([...included, report]);
      if (lineBytes(wake.blocks, wake.meta) > MAX_PIPE_LINE_BYTES) break;
      included.push(report);
    }
    return included;
  }

  private attempt(personaId: string): void {
    if (this.closed) return;
    const p = this.entry(personaId);
    if (p.sending) return; // its settlement schedules the next try
    const due = this.due(personaId);
    const session = due.length ? this.deps.sessionOf(personaId) : null;
    if (!due.length || !session) {
      // Nothing to send, or not running (its next launch calls `onLaunchChanged`).
      this.clearRetry(p);
      // A carrying turn's reports are only out of sight: keep the backoff its carry started.
      if (!due.length && !p.carried.size) p.wake = null;
      return;
    }
    const signature = signatureOf(due);
    let attempts = 0;
    if (p.wake?.signature === signature) {
      const wait = p.wake.at + backoffMs(p.wake.attempts) - this.deps.now();
      if (wait > 0) {
        this.scheduleRetry(personaId, p, wait);
        return;
      }
      attempts = p.wake.attempts;
    }
    const state = session.state();
    if (state === "stopped" || state === "failed") {
      // Not running: its next launch calls `onLaunchChanged`.
      this.clearRetry(p);
      return;
    }
    if (state !== "ready") {
      this.scheduleRetry(personaId, p, BUSY_RETRY_MS);
      return;
    }
    const reports = this.fittedWake(due);
    if (!reports.length) return;
    const at = this.deps.now();
    const wake = this.wakeWith(reports);
    p.sending = true;
    session.prompt(wake.blocks, wake.meta).then(
      (result) => {
        p.sending = false;
        if (this.closed) return;
        if (result === "accepted") {
          p.wake = { signature, attempts: attempts + 1, at };
          this.scheduleRetry(personaId, p, backoffMs(attempts + 1));
        } else {
          this.scheduleRetry(personaId, p, BUSY_RETRY_MS);
        }
      },
      (error: unknown) => {
        p.sending = false;
        if (this.closed) return;
        this.deps.log(`Waking persona ${personaId} with worker reports failed: ${error instanceof Error ? error.message : String(error)}`);
        // Counted as an attempt, so a failure that repeats backs off too.
        p.wake = { signature, attempts: attempts + 1, at };
        this.scheduleRetry(personaId, p, backoffMs(attempts + 1));
      },
    );
  }

  private scheduleRetry(personaId: string, p: PersonaDelivery, ms: number): void {
    this.clearRetry(p);
    p.retry = this.deps.setTimer(() => {
      p.retry = null;
      this.attempt(personaId);
    }, ms);
  }

  private clearRetry(p: PersonaDelivery): void {
    if (p.retry === null) return;
    this.deps.clearTimer(p.retry);
    p.retry = null;
  }
}
