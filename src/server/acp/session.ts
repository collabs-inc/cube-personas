// One persona's ACP conversation: its adapter on stdio pipes, the
// handshake, one reservation for every prompt, first-answer-wins for the
// adapter's questions, the file requests the server answers itself, and a
// record of every message that crossed the pipe in either direction.
//
// Request ids are namespaced so nothing on the pipe can collide: the
// server's own requests are `d:<n>`, the adapter's `a:<n>` (its business),
// a page's `<uuid>:<n>` (minted by the page). Direction in the record log is
// the pipe's: `in` was written to the adapter, `out` came from it.
//
// `exited` reports an adapter that ended without `stop()` asking it to —
// including one that dies during `start()`, which also rejects. An adapter
// the session ends itself (a stop, a failed handshake) reports no exit.
import { stat, readFile, writeFile } from "node:fs/promises";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  BUSY_MARKER, isNotification, isRequest, isResponse, MAX_PIPE_LINE_BYTES, messageTooLargeError, parseJsonRpc,
  type AgentRecord, type JsonRpcId, type JsonRpcMessage, type JsonRpcRequest, type JsonRpcResponse,
} from "../../shared/agent-protocol";
import type { Harness, PersonaState } from "../../shared/types";
import type { PipeChild, ProcessManager } from "../processes";
import type { RecordLog } from "../record-log";
import { admitPrompt, type AdmissionState } from "./admission";
import { answerClientRequest, isClientMethod, type ClientDeps } from "./client-methods";
import { codexConfigEnv } from "./codex-config";
import {
  initializeRequest, loadSessionRequest, newSessionRequest, PERMISSIVE_MODES, sessionIdFrom, setModeRequest,
  supportsHttpMcp, supportsLoadSession, type McpServerConfig,
} from "./handshake";
import { claimPermission } from "./permissions";

export interface SessionLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  harness: Harness;
  resumeSessionId: string | null;
  mcpServer: { url: string; ticket: string } | null;
  systemPromptAppend: string;
  codexDeveloperInstructions: string;
}

export interface SessionEvents {
  frame(record: AgentRecord): void;
  state(state: PersonaState, activePrompt: string | null): void;
  /** The handshake waits for it; a rejection fails the start, so a session is never used unrecorded. */
  sessionId(id: string): void | Promise<void>;
  exited(code: number | null, stderrTail: string): void;
  /** The adapter process was spawned (before the handshake), so its pid can be recorded for reaping. */
  spawned?(pid: number): void;
}

const HANDSHAKE_TIMEOUT_MS = 60_000;
const SERVER_ID_PREFIX = "d";
const START_FAILED = "The persona could not start.";

interface Waiter {
  resolve(res: JsonRpcResponse): void;
  reject(err: Error): void;
}

/** Reads statted first, so an oversized file is refused without loading it. */
const diskDeps: ClientDeps = {
  async readFile(path, maxBytes) {
    const size = await stat(path).then((s) => s.size, () => null);
    if (size !== null && size > maxBytes) throw new Error(`file too large (${size} bytes; the limit is ${maxBytes})`);
    return readFile(path, "utf8");
  },
  writeFile: (path, content) => writeFile(path, content, "utf8"),
};

export class PersonaSession {
  private child: PipeChild | null = null;
  private current: PersonaState = "stopped";
  private emittedActive: string | null = null;
  private acpSessionId: string | null = null;
  private nextId = 1;
  private active: JsonRpcId | null = null;
  private readonly waiters = new Map<string, Waiter>();
  /** Questions the adapter asked a human that nobody has answered, and every id already answered. */
  private readonly pendingQuestions = new Set<JsonRpcId>();
  /** The subset of `pendingQuestions` that are `session/request_permission`, which a cancel must answer. */
  private readonly pendingPermissions = new Set<JsonRpcId>();
  /**
   * While set, the `session/load` with this id is outstanding and the
   * conversation it replays is already in the record log from an earlier
   * run: its replayed notifications are not recorded or emitted again.
   */
  private replayLoadId: string | null = null;
  private readonly answered = new Set<JsonRpcId>();
  /** Set when the session itself ends the adapter, so its exit is not reported as a failure. */
  private ending = false;

  constructor(
    private readonly log: RecordLog,
    private readonly processes: ProcessManager,
    private readonly events: SessionEvents,
  ) {}

  state(): PersonaState {
    return this.current;
  }

  activePrompt(): string | null {
    return this.active === null ? null : String(this.active);
  }

  /** Spawn, `initialize` → `session/load` or `session/new` → `session/set_mode`, then "ready". */
  async start(launch: SessionLaunch): Promise<void> {
    if (this.child !== null) throw new Error("The persona is already running.");
    this.ending = false;
    this.nextId = 1;
    this.acpSessionId = null;
    this.pendingQuestions.clear();
    this.pendingPermissions.clear();
    this.answered.clear();
    this.replayLoadId = null;
    const hadHistory = this.log.seq() > 0;
    this.setState("starting", null);

    const env = launch.harness === "codex"
      ? { ...launch.env, ...(await codexConfigEnv(launch.env, launch.codexDeveloperInstructions)) }
      : launch.env;
    const child = this.processes.spawnPipe({ command: launch.command, args: launch.args, cwd: launch.cwd, env });
    this.child = child;
    if (child.pid > 0) this.events.spawned?.(child.pid);
    child.onLine((line) => this.receive(line));
    child.onExit((code) => this.exited(child, code));

    try {
      await this.handshake(launch, hadHistory);
    } catch (err) {
      this.replayLoadId = null;
      console.warn(`persona adapter ${launch.command}: handshake failed: ${err instanceof Error ? err.message : String(err)}`);
      if (this.child === child) {
        this.ending = true;
        await child.kill();
      }
      this.setState("failed", null);
      throw new Error(START_FAILED);
    }
    this.setState("ready", null);
  }

  /** From the page: a prompt, a `session/cancel`, or the answer to one of the adapter's questions. */
  async send(message: JsonRpcMessage): Promise<void> {
    if (isRequest(message)) {
      // The page's ids are `<uuid>:<n>`; these two prefixes belong to the server and the adapter.
      if (/^[da]:/.test(String(message.id))) throw new Error("The page cannot use a d: or a: request id.");
      if (message.method !== "session/prompt") throw new Error(`The page cannot send ${message.method}.`);
      const params = { ...(message.params as Record<string, unknown> | undefined), sessionId: this.acpSessionId };
      const admission = admitPrompt({ state: this.admissionState() });
      if (!admission.ok) throw new Error(`${BUSY_MARKER}: ${admission.reason}`);
      this.reserve({ ...message, params });
      return;
    }
    if (isResponse(message)) {
      const line = this.fitted(message);
      const child = this.child;
      if (child === null) return;
      if (claimPermission({ answered: this.answered, pending: this.pendingQuestions }, message.id) !== "answered") return;
      this.pendingQuestions.delete(message.id);
      this.pendingPermissions.delete(message.id);
      this.writeLine(child, message, line);
      return;
    }
    if (message.method !== "session/cancel") throw new Error(`The page cannot send ${message.method}.`);
    const line = this.fitted(message);
    const child = this.child;
    if (child === null) return;
    this.writeLine(child, message, line);
    this.cancelPermissions(child);
  }

  /**
   * ACP: after `session/cancel` the client answers every outstanding
   * permission request `cancelled`, or an adapter blocked on one never ends
   * its turn. Each claims its id, so a racing page answer still loses or wins
   * exactly once.
   */
  private cancelPermissions(child: PipeChild): void {
    for (const id of [...this.pendingPermissions]) {
      if (claimPermission({ answered: this.answered, pending: this.pendingQuestions }, id) !== "answered") continue;
      this.pendingQuestions.delete(id);
      this.pendingPermissions.delete(id);
      const reply: JsonRpcResponse = { jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } };
      this.writeLine(child, reply, JSON.stringify(reply));
    }
  }

  /** From the server (a wake): accepted only when ready, never queued. */
  async prompt(blocks: ContentBlock[], meta?: Record<string, unknown>): Promise<"accepted" | "busy"> {
    if (!admitPrompt({ state: this.admissionState() }).ok) return "busy";
    this.reserve({
      jsonrpc: "2.0",
      id: this.mintId(),
      method: "session/prompt",
      params: { sessionId: this.acpSessionId, prompt: blocks, ...(meta === undefined ? {} : { _meta: meta }) },
    });
    return "accepted";
  }

  /** Ends the adapter; the session settles on "stopped" and reports no exit. */
  async stop(): Promise<void> {
    const child = this.child;
    if (child !== null) {
      this.ending = true;
      await child.kill();
      // The exit callback runs from the child's close event; make sure it has.
      await new Promise<void>((resolve) => child.onExit(() => resolve()));
    }
    if (this.current !== "stopped") this.setState("stopped", null);
  }

  // --- internals ---------------------------------------------------------

  private admissionState(): AdmissionState {
    if (this.child === null) return "dead";
    if (this.current === "starting") return "handshaking";
    if (this.current !== "ready" || this.active !== null) return "busy";
    return "ready";
  }

  /**
   * Admission has already passed. No await between it, the reservation and
   * the synchronous write, so a competing sender sees the active id at once.
   */
  private reserve(request: JsonRpcRequest): void {
    const line = this.fitted(request);
    this.active = request.id;
    this.writeLine(this.child!, request, line);
    this.setState("busy", this.activePrompt());
  }

  private async handshake(launch: SessionLaunch, hadHistory: boolean): Promise<void> {
    const init = await this.request((id) => initializeRequest(id));
    if (init.error) throw new Error(`initialize: ${init.error.message}`);

    const servers = this.mcpServers(launch, init);
    const meta = launch.harness === "claude" && launch.systemPromptAppend !== ""
      ? { systemPrompt: { append: launch.systemPromptAppend } }
      : undefined;
    const resume = launch.resumeSessionId;
    if (resume !== null && !supportsLoadSession(init)) throw new Error("the adapter cannot load a saved session");
    const session = await this.request((id) => {
      if (resume === null) return newSessionRequest(id, launch.cwd, servers, meta);
      if (hadHistory) this.replayLoadId = id;
      return loadSessionRequest(id, resume, launch.cwd, servers, meta);
    });
    if (session.error) throw new Error(`${resume !== null ? "session/load" : "session/new"}: ${session.error.message}`);
    // A `session/load` reply legitimately carries no id (codex-acp): the conversation keeps the one it named.
    const sessionId = sessionIdFrom(session) ?? resume;
    if (sessionId === null) throw new Error("session/new: the reply named no session");
    this.acpSessionId = sessionId;
    await this.events.sessionId(sessionId);

    const modeId = PERMISSIVE_MODES[launch.harness];
    try {
      const reply = await this.request((id) => setModeRequest(id, sessionId, modeId));
      if (reply.error) throw new Error(reply.error.message);
    } catch (err) {
      console.warn(`persona adapter: permission mode ${modeId} unavailable; keeping the default mode: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private mcpServers(launch: SessionLaunch, init: JsonRpcResponse): McpServerConfig[] {
    if (launch.mcpServer === null) return [];
    if (!supportsHttpMcp(init)) {
      console.warn(`persona adapter ${launch.command}: no HTTP MCP support advertised; the persona runs without its tools`);
      return [];
    }
    return [{
      type: "http",
      name: "personas",
      url: launch.mcpServer.url,
      headers: [{ name: "Authorization", value: `Bearer ${launch.mcpServer.ticket}` }],
    }];
  }

  private mintId(): string {
    return `${SERVER_ID_PREFIX}:${this.nextId++}`;
  }

  /** One of the server's own requests, resolved by the adapter's response to its id. */
  private request(build: (id: string) => JsonRpcRequest): Promise<JsonRpcResponse> {
    const child = this.child;
    if (child === null) return Promise.reject(new Error("the adapter is not running"));
    const request = build(this.mintId());
    const key = String(request.id);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error(`no reply to ${request.method} in ${HANDSHAKE_TIMEOUT_MS} ms`));
      }, HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
      this.waiters.set(key, {
        resolve: (res) => { clearTimeout(timer); resolve(res); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.writeLine(child, request, JSON.stringify(request));
    });
  }

  /** The message as one line, refused when over the pipe's line cap. */
  private fitted(message: JsonRpcMessage): string {
    const line = JSON.stringify(message);
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes > MAX_PIPE_LINE_BYTES) throw messageTooLargeError(bytes);
    return line;
  }

  /**
   * Records, emits, then writes: the record always precedes anything the
   * adapter says in reply. The recorded copy never carries the MCP ticket;
   * the adapter gets the real line.
   */
  private writeLine(child: PipeChild, message: JsonRpcMessage, line: string): void {
    this.events.frame(this.log.append("in", withoutTicket(message)));
    child.write(line);
  }

  private receive(line: string): void {
    if (line.trim() === "") return;
    const message = parseJsonRpc(line);
    if (message === null) {
      console.warn(`persona adapter: ignored a stdout line that is not JSON-RPC: ${line.slice(0, 200)}`);
      return;
    }
    const replayed = this.replayLoadId !== null && isNotification(message);
    if (!replayed) this.events.frame(this.log.append("out", message));

    if (isResponse(message)) {
      if (String(message.id) === this.replayLoadId) this.replayLoadId = null;
      const waiter = this.waiters.get(String(message.id));
      if (waiter) {
        this.waiters.delete(String(message.id));
        waiter.resolve(message);
        return;
      }
      if (this.active !== null && String(message.id) === String(this.active)) this.endTurn();
      return;
    }
    if (!isRequest(message)) return;
    if (!isClientMethod(message.method)) {
      // A human's to answer: the page sees it as a frame and answers through `send`.
      this.pendingQuestions.add(message.id);
      if (message.method === "session/request_permission") this.pendingPermissions.add(message.id);
      return;
    }
    this.answerClientMethod(message);
  }

  private answerClientMethod(request: JsonRpcRequest): void {
    const child = this.child;
    void answerClientRequest(request, diskDeps).then((response) => {
      if (this.child !== child || child === null) return; // the adapter that asked is gone
      let line = JSON.stringify(response);
      let reply: JsonRpcResponse = response;
      if (Buffer.byteLength(line, "utf8") + 1 > MAX_PIPE_LINE_BYTES) {
        reply = { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Response too large" } };
        line = JSON.stringify(reply);
      }
      this.writeLine(child, reply, line);
    }).catch((err: unknown) => {
      console.warn(`persona adapter: failed to answer ${request.method}: ${String(err)}`);
    });
  }

  /** A turn's response ends it, and with it every question asked during it. */
  private endTurn(): void {
    this.active = null;
    this.pendingQuestions.clear();
    this.pendingPermissions.clear();
    if (this.current === "busy") this.setState("ready", null);
  }

  private exited(child: PipeChild, code: number | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.active = null;
    this.pendingQuestions.clear();
    this.pendingPermissions.clear();
    for (const [key, waiter] of this.waiters) {
      this.waiters.delete(key);
      waiter.reject(new Error(`the adapter exited (code ${code})`));
    }
    if (this.ending) return;
    this.events.exited(code, child.stderrTail());
    this.setState("failed", null);
  }

  private setState(state: PersonaState, activePrompt: string | null): void {
    if (this.current === state && this.emittedActive === activePrompt) return;
    this.current = state;
    this.emittedActive = activePrompt;
    this.events.state(state, activePrompt);
  }
}

/** The recorded copy of a `session/new` or `session/load`: every MCP server's Authorization header value redacted. */
function withoutTicket(message: JsonRpcMessage): JsonRpcMessage {
  if (!isRequest(message) || (message.method !== "session/new" && message.method !== "session/load")) return message;
  const params = message.params as { mcpServers?: McpServerConfig[] } | undefined;
  if (!Array.isArray(params?.mcpServers) || params.mcpServers.length === 0) return message;
  return {
    ...message,
    params: {
      ...params,
      mcpServers: params.mcpServers.map((server) => ({
        ...server,
        headers: server.headers.map((h) =>
          h.name.toLowerCase() === "authorization" ? { name: h.name, value: "Bearer [redacted]" } : h),
      })),
    },
  };
}
