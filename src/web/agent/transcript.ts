// Adapted from cube-computer: src/windows/app/src/items/agent/transcript.ts
/**
 * The conversation a replayed ACP stream adds up to — this view's xterm.
 *
 * The server logs a persona's whole JSON-RPC pipe and hands a page the
 * trailing window of it (`persona:open`) plus every later record
 * (`persona:frame`). Nothing on that wire is UI state: it is one flat,
 * ordered list of requests, responses and notifications, in both
 * directions. This module is the pure function that folds that list back
 * into a conversation, so a reload, a remount, a second client and a
 * mid-session attach all land on exactly the same transcript — the reducer
 * is the only thing that decides what the stream MEANS, and it decides it
 * the same way every time.
 *
 * Purity is the whole contract: no clock, no randomness, no mutation of
 * the transcript passed in. A synthetic turn's id counts turns rather than
 * minting one, so replaying the same records twice is byte-identical.
 *
 * `seq` is the log cursor of the last record folded in. A record at or
 * below it is a duplicate — the frame that arrived while `persona:open` was
 * in flight and was also inside the reply — and is dropped, identity
 * included, so a store can compare by reference.
 *
 * What it deliberately does not know: which adapter produced the stream.
 * The recorded adapters (see test/web/agent/fixtures) differ in
 * request-id shape, in what their handshake results carry, and in how much
 * of the spec they use, so every read here is defensive and narrow —
 * unknown methods and unknown `session/update` variants are no-ops that
 * still advance the cursor rather than errors.
 */
import type {
  AuthMethod,
  AvailableCommand,
  ContentBlock,
  Implementation,
  PermissionOption,
  PlanEntry,
  PromptCapabilities,
  SessionMode,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  Usage,
} from "@agentclientprotocol/sdk";
import type {
  AgentRecord,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../shared/agent-protocol";
import { isNotification, isRequest, isResponse } from "../../shared/agent-protocol";
import { normalizeSessionConfigOptions } from "./session-controls";
import type {
  LegacyModel,
  LegacyModelState,
  SessionCompactionState,
  SessionConfigOption,
  SessionControlError,
  SessionControlMethod,
  SessionControlRequest,
  SessionInfoState,
  SessionUsageState,
} from "./session-controls";

export { setConfigOptionRequest, setModelRequest } from "./session-controls";

const MAX_CONTROL_REQUESTS = 32;
const MAX_CONTROL_ERROR_CHARS = 1_000;

// -- shape ----------------------------------------------------------------

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "content"; content: ContentBlock }
  | { kind: "tool"; call: ToolCallState }
  | { kind: "plan"; entries: PlanEntry[] };

export interface ToolCallState {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  content: ToolCallContent[];
  locations: { path: string; line?: number | null }[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface Turn {
  id: string;
  startSeq?: number;
  origin?: "report";
  user: ContentBlock[];
  blocks: Block[];
  blockSeqs?: number[];
  /** null while the turn is open; a stop reason or "error" once it ends. */
  end: StopReason | "error" | null;
  error?: string;
  usage?: Usage | null;
  /** Ended by the server stopping or the adapter dying mid-turn, not by anyone's cancel. */
  interrupted?: boolean;
}

export interface PendingPermission {
  requestId: JsonRpcId;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

export interface PermissionDecision {
  requestId: JsonRpcId;
  optionId: string;
  answeredBy: string | null;
  toolTitle: string | null;
}

export interface Transcript {
  acpSessionId: string | null;
  cwd: string | null;
  loadSession: boolean | null;
  agentInfo: Implementation | null;
  promptCapabilities: PromptCapabilities | null;
  authMethods: AuthMethod[];
  turns: Turn[];
  pending: PendingPermission[];
  decisions: PermissionDecision[];
  modes: { current: string | null; available: SessionMode[] };
  models: LegacyModelState;
  configOptions: SessionConfigOption[];
  usage: SessionUsageState | null;
  sessionInfo: SessionInfoState;
  compaction: SessionCompactionState[];
  controlRequests: SessionControlRequest[];
  controlError: SessionControlError | null;
  commands: AvailableCommand[];
  running: boolean;
  seq: number;
  handshakeError: string | null;
  /** The correlated operation the adapter rejected with ACP's auth_required code. */
  authRequired: { requestId: string; prompt: ContentBlock[] | null } | null;
  /**
   * The ids of the handshake requests the server sent, so their answers can be
   * recognised without assuming an id shape (the driver that recorded the
   * fixtures used plain integers; the server uses "d:<n>").
   * sessionReady records the successful new/load reply, since a load's
   * known session id alone does not mean its initialization has finished.
   */
  handshake: { initId?: string; sessionReqId?: string; sessionReady?: boolean };
}

export const EMPTY_TRANSCRIPT: Transcript = Object.freeze({
  acpSessionId: null,
  cwd: null,
  loadSession: null,
  agentInfo: null,
  promptCapabilities: null,
  authMethods: [],
  turns: [],
  pending: [],
  decisions: [],
  modes: { current: null, available: [] },
  models: { current: null, available: [] },
  configOptions: [],
  usage: null,
  sessionInfo: { title: null, updatedAt: null },
  compaction: [],
  controlRequests: [],
  controlError: null,
  commands: [],
  running: false,
  seq: 0,
  handshakeError: null,
  authRequired: null,
  handshake: {},
}) as Transcript;

// -- outgoing messages ----------------------------------------------------

export function promptRequest(id: string, sessionId: string, prompt: ContentBlock[]): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt } };
}

/**
 * The answer to a `session/request_permission`. The outcome is NESTED —
 * `result.outcome.outcome` — which is what the spec's
 * `RequestPermissionResponse` actually is; `null` is the user dismissing
 * the prompt rather than choosing an option.
 */
export function permissionResponse(requestId: JsonRpcId, optionId: string | null): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: requestId,
    result: { outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId } },
  };
}

export function cancelNotification(sessionId: string): JsonRpcNotification {
  return { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } };
}

export function setModeRequest(id: string, sessionId: string, modeId: string): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "session/set_mode", params: { sessionId, modeId } };
}

// -- reducer --------------------------------------------------------------

/** Folds one record in. Pure; a record at or below the cursor returns `t` itself. */
export function reduceRecord(t: Transcript, r: AgentRecord): Transcript {
  if (r.seq <= t.seq) return t;
  const next = { ...applyMessage(t, r), seq: r.seq };
  if (next.turns !== t.turns) next.turns = next.turns.map((turn, index) => {
    const previous = t.turns[index];
    if (turn === previous) return turn;
    return { ...turn, blockSeqs: turn.blocks.map((_, blockIndex) => previous?.blockSeqs?.[blockIndex] ?? r.seq) };
  });
  if (next.turns.length > t.turns.length) {
    next.turns = next.turns.map((turn, index) =>
      index === next.turns.length - 1 ? { ...turn, startSeq: r.seq } : turn);
  }
  return next;
}

/** Folds a replay in. `reset` (a ring that rolled) starts from empty. */
export function reduceRecords(t: Transcript, rs: AgentRecord[], reset: boolean): Transcript {
  let acc = reset ? EMPTY_TRANSCRIPT : t;
  for (const r of rs) acc = reduceRecord(acc, r);
  return acc;
}

function applyMessage(t: Transcript, r: AgentRecord): Transcript {
  const m = r.message;
  // `in` is what the page or the server wrote to the adapter, `out` what the
  // adapter wrote back — the same message method means different things
  // depending on which way it went.
  if (isRequest(m)) return r.dir === "in" ? applyClientRequest(t, m) : applyAgentRequest(t, m);
  if (isResponse(m)) return r.dir === "out" ? applyAgentResponse(t, m) : applyClientResponse(t, m);
  if (isNotification(m)) return r.dir === "out" ? applyAgentNotification(t, m) : t;
  return t;
}

// -- requests the client sent ---------------------------------------------

function applyClientRequest(t: Transcript, m: JsonRpcRequest): Transcript {
  const key = keyOf(m.id);
  const params = asRecord(m.params);
  switch (m.method) {
    case "initialize":
      return { ...t, handshake: { ...t.handshake, initId: key } };
    case "session/new": {
      const cwd = params?.["cwd"];
      return {
        ...t,
        cwd: typeof cwd === "string" ? cwd : t.cwd,
        handshake: { ...t.handshake, sessionReqId: key, sessionReady: false },
      };
    }
    case "session/load": {
      const cwd = params?.["cwd"];
      const sessionId = params?.["sessionId"];
      return {
        ...t,
        acpSessionId: typeof sessionId === "string" ? sessionId : t.acpSessionId,
        cwd: typeof cwd === "string" ? cwd : t.cwd,
        handshake: { ...t.handshake, sessionReqId: key, sessionReady: false },
      };
    }
    case "session/prompt": {
      const prompt = params?.["prompt"];
      const user = Array.isArray(prompt) ? prompt.map(contentBlockOf).filter(isDefined) : [];
      const cube = asRecord(asRecord(params?.["_meta"])?.["cube"]);
      // A wake-up and a check-in are both the server speaking, never the user.
      const fromCube = cube?.["report"] === true || cube?.["checkIn"] === true;
      const origin = fromCube ? { origin: "report" as const } : {};
      return { ...t, turns: [...t.turns, { id: key, user, ...origin, blocks: [], end: null }], running: true };
    }
    case "session/set_config_option":
    case "session/set_mode":
    case "session/set_model": {
      const request = controlRequestOf(key, m.method, params);
      if (!request) return t;
      const withoutDuplicate = t.controlRequests.filter((pending) => pending.requestId !== key);
      return {
        ...t,
        controlRequests: [...withoutDuplicate, request].slice(-MAX_CONTROL_REQUESTS),
        controlError: null,
      };
    }
    // session/cancel is a notification, not a request; the prompt's own
    // response (stopReason "cancelled") is what ends the turn.
    default:
      return t;
  }
}

// -- responses the adapter sent -------------------------------------------

function applyAgentResponse(t: Transcript, m: JsonRpcResponse): Transcript {
  const key = keyOf(m.id);
  let next = t;
  const promptIndex = openTurnIndexById(t.turns, key);
  const handshakeResponse = key === t.handshake.initId || key === t.handshake.sessionReqId;

  if (m.error) {
    if (handshakeResponse) {
      next = { ...next, handshakeError: m.error.message };
    }
    if (m.error.code === -32000 && (handshakeResponse || promptIndex >= 0)) {
      next = {
        ...next,
        authRequired: {
          requestId: key,
          prompt: promptIndex >= 0 ? next.turns[promptIndex]!.user : null,
        },
      };
    }
  } else {
    if (key === t.handshake.initId) next = applyInitializeResult(next, m.result);
    if (key === t.handshake.sessionReqId && asRecord(m.result)) {
      next = applySessionResult(next, m.result);
      next = { ...next, handshake: { ...next.handshake, sessionReady: true } };
    }
  }

  next = applyControlResponse(next, key, m);

  const index = openTurnIndexById(next.turns, key);
  if (index < 0) return next;
  return endTurn(next, index, m);
}

function applyInitializeResult(t: Transcript, result: unknown): Transcript {
  const record = asRecord(result);
  const capabilities = asRecord(record?.["agentCapabilities"]);
  if (!record) return { ...t, loadSession: false };
  return {
    ...t,
    loadSession: capabilities?.["loadSession"] === true,
    agentInfo: implementationOf(record["agentInfo"]),
    promptCapabilities: promptCapabilitiesOf(capabilities?.["promptCapabilities"]),
    authMethods: authMethodsOf(record["authMethods"]),
  };
}

/**
 * `session/new` and `session/load` answer with far more than the spec's
 * minimum, and differ between adapters — codex's `session/load` result has
 * no `sessionId` at all — so each field is taken only when it is there and
 * the previous value survives when it is not.
 */
function applySessionResult(t: Transcript, result: unknown): Transcript {
  const record = asRecord(result);
  if (!record) return t;
  let next = t;
  const sessionId = record["sessionId"];
  if (typeof sessionId === "string") next = { ...next, acpSessionId: sessionId };
  if (Array.isArray(record["configOptions"])) {
    next = { ...next, configOptions: normalizeSessionConfigOptions(record["configOptions"]) };
  }
  const modes = asRecord(record["modes"]);
  if (modes) {
    const current = modes["currentModeId"];
    const available = modes["availableModes"];
    next = {
      ...next,
      modes: {
        current: typeof current === "string" ? current : next.modes.current,
        available: Array.isArray(available) ? available.map(sessionModeOf).filter(isDefined) : next.modes.available,
      },
    };
  }
  const models = legacyModelsOf(record["models"]);
  if (models) next = { ...next, models };
  return next;
}

function endTurn(t: Transcript, index: number, m: JsonRpcResponse): Transcript {
  const turns = t.turns.slice();
  const turn = turns[index];
  if (!turn) return t;
  if (m.error) {
    turns[index] = { ...turn, end: "error", error: m.error.message };
  } else {
    const result = asRecord(m.result);
    const stopReason = result?.["stopReason"];
    const usage = usageOf(result?.["usage"]);
    const interrupted = asRecord(asRecord(result?.["_meta"])?.["cube"])?.["interrupted"] === true;
    turns[index] = {
      ...turn,
      end: typeof stopReason === "string" ? (stopReason as StopReason) : "end_turn",
      ...(usage ? { usage } : {}),
      ...(interrupted ? { interrupted: true } : {}),
    };
  }
  // A turn that has ended is not waiting on anyone: the agent will not
  // act on an answer to a permission it asked for inside it (a cancel
  // ends the turn with the request still open), so the prompts go with it.
  return { ...t, turns, running: false, pending: t.pending.length > 0 ? [] : t.pending };
}

// -- requests the adapter sent (and the client's answers) ------------------

function applyAgentRequest(t: Transcript, m: JsonRpcRequest): Transcript {
  if (m.method !== "session/request_permission") return t;
  const requestId = m.id;
  if (t.pending.some((p) => p.requestId === requestId)) return t;
  const params = asRecord(m.params);
  const options = params?.["options"];
  const toolCall = asRecord(params?.["toolCall"]) ?? { toolCallId: "" };
  const pending: PendingPermission = {
    requestId,
    toolCall: {
      ...toolCall,
      ...(hasOwn(toolCall, "content") && toolCall["content"] !== null
        ? { content: normalizeToolContent(toolCall["content"]) }
        : {}),
    } as ToolCallUpdate,
    options: Array.isArray(options) ? (options as PermissionOption[]) : [],
  };
  return { ...t, pending: [...t.pending, pending] };
}

/**
 * Anything the client wrote back that carries an id: the permission answer
 * (this page's, or another page's — the server broadcasts both), or a
 * machine-side `fs/*` reply whose id matches nothing pending.
 */
function applyClientResponse(t: Transcript, m: JsonRpcResponse): Transcript {
  const key = m.id;
  const pending = t.pending.find((p) => p.requestId === key);
  if (!pending) return t;
  const result = m.result as { outcome?: { outcome?: unknown; optionId?: unknown }; _meta?: { cube?: { answeredBy?: unknown } } } | undefined;
  const selected = result?.outcome?.outcome === "selected" && typeof result.outcome.optionId === "string";
  const answeredBy = result?._meta?.cube?.answeredBy;
  return {
    ...t, pending: t.pending.filter((p) => p.requestId !== key),
    decisions: selected ? [...t.decisions, {
      requestId: key, optionId: result.outcome!.optionId as string,
      answeredBy: typeof answeredBy === "string" ? answeredBy : null,
      toolTitle: pending.toolCall.title ?? null,
    }] : t.decisions,
  };
}

function controlRequestOf(
  requestId: string,
  method: SessionControlMethod,
  params: Record<string, unknown> | undefined,
): SessionControlRequest | undefined {
  if (!params) return undefined;
  if (method === "session/set_config_option") {
    const configId = params["configId"];
    const value = params["value"];
    if (typeof configId !== "string" || (typeof value !== "string" && typeof value !== "boolean")) return undefined;
    return { requestId, method, configId, value };
  }
  const value = params[method === "session/set_mode" ? "modeId" : "modelId"];
  return typeof value === "string" ? { requestId, method, configId: null, value } : undefined;
}

function applyControlResponse(t: Transcript, requestId: string, response: JsonRpcResponse): Transcript {
  const request = t.controlRequests.find((pending) => pending.requestId === requestId);
  if (!request) return t;
  let next: Transcript = {
    ...t,
    controlRequests: t.controlRequests.filter((pending) => pending.requestId !== requestId),
  };
  if (response.error) {
    return {
      ...next,
      controlError: { ...request, message: response.error.message.slice(0, MAX_CONTROL_ERROR_CHARS) },
    };
  }
  next = { ...next, controlError: null };
  return applySessionResult(next, response.result);
}

// -- session/update -------------------------------------------------------

function applyAgentNotification(t: Transcript, m: JsonRpcNotification): Transcript {
  if (m.method !== "session/update") return t;
  const update = asRecord(asRecord(m.params)?.["update"]);
  if (!update) return t;
  return applySessionUpdate(t, update);
}

function applySessionUpdate(t: Transcript, u: Record<string, unknown>): Transcript {
  switch (u["sessionUpdate"]) {
    // A chunk with no content block at all is malformed: it becomes a
    // no-op rather than an empty (or "[content]") block, but the record
    // still advances the cursor.
    case "user_message_chunk": {
      const content = contentBlockOf(u["content"]);
      return content ? applyUserChunk(t, content) : t;
    }
    case "agent_message_chunk": {
      const content = contentBlockOf(u["content"]);
      return content ? appendChunk(t, "text", content) : t;
    }
    case "agent_thought_chunk": {
      const content = contentBlockOf(u["content"]);
      return content ? appendChunk(t, "thought", content) : t;
    }
    case "tool_call":
      return pushToolCall(t, u as unknown as ToolCallish);
    case "tool_call_update":
      return mergeToolCall(t, u as unknown as ToolCallUpdate);
    case "plan":
      return setPlan(t, Array.isArray(u["entries"]) ? (u["entries"] as PlanEntry[]) : []);
    case "available_commands_update":
      return {
        ...t,
        commands: Array.isArray(u["availableCommands"])
          ? u["availableCommands"].map(availableCommandOf).filter(isDefined)
          : [],
      };
    case "current_mode_update": {
      const current = u["currentModeId"];
      return typeof current === "string" ? { ...t, modes: { ...t.modes, current } } : t;
    }
    case "config_option_update":
      return Array.isArray(u["configOptions"])
        ? { ...t, configOptions: normalizeSessionConfigOptions(u["configOptions"]) }
        : t;
    case "usage_update":
      return applyUsageUpdate(t, u);
    case "session_info_update":
      return applySessionInfoUpdate(t, u);
    case "compaction_update":
      return applyCompactionUpdate(t, u);
    case "compaction_summary_chunk":
      return applyCompactionSummaryChunk(t, u);
    // plan_update/plan_removed stay unhandled because this client does not
    // advertise the plan capability. Future variants are deterministic no-ops.
    default:
      return t;
  }
}

function applyUsageUpdate(t: Transcript, update: Record<string, unknown>): Transcript {
  const used = finiteNonnegativeNumber(update["used"]);
  const size = finiteNonnegativeNumber(update["size"]);
  if (used === undefined || size === undefined) return t;
  const costRecord = asRecord(update["cost"]);
  const amount = finiteNonnegativeNumber(costRecord?.["amount"]);
  const currency = costRecord?.["currency"];
  const cost = amount !== undefined && typeof currency === "string" ? { amount, currency } : null;
  return { ...t, usage: { used, size, cost } };
}

function applySessionInfoUpdate(t: Transcript, update: Record<string, unknown>): Transcript {
  let sessionInfo = t.sessionInfo;
  const title = update["title"];
  if (hasOwn(update, "title") && (title === null || typeof title === "string")) {
    sessionInfo = { ...sessionInfo, title };
  }
  const updatedAt = update["updatedAt"];
  if (hasOwn(update, "updatedAt") && (updatedAt === null || typeof updatedAt === "string")) {
    sessionInfo = { ...sessionInfo, updatedAt };
  }
  return sessionInfo === t.sessionInfo ? t : { ...t, sessionInfo };
}

function applyCompactionUpdate(t: Transcript, update: Record<string, unknown>): Transcript {
  const compactionId = update["compactionId"];
  const status = update["status"];
  if (typeof compactionId !== "string" || compactionId === "" || typeof status !== "string") return t;
  const index = t.compaction.findIndex((entry) => entry.compactionId === compactionId);
  const previous = index < 0 ? undefined : t.compaction[index];
  let summary = previous?.summary ?? [];
  if (hasOwn(update, "summary")) {
    const rawSummary = update["summary"];
    if (rawSummary === null) summary = [];
    else if (Array.isArray(rawSummary)) summary = rawSummary.map(contentBlockOf).filter(isDefined);
  }
  let error = previous?.error ?? null;
  if (hasOwn(update, "error")) {
    const rawError = update["error"];
    if (rawError === null || typeof rawError === "string") error = rawError;
  }
  const entry: SessionCompactionState = { compactionId, status, summary, error };
  const compaction = t.compaction.slice();
  if (index < 0) compaction.push(entry);
  else compaction[index] = entry;
  return { ...t, compaction };
}

function applyCompactionSummaryChunk(t: Transcript, update: Record<string, unknown>): Transcript {
  const compactionId = update["compactionId"];
  const content = contentBlockOf(update["content"]);
  if (typeof compactionId !== "string" || !content) return t;
  const index = t.compaction.findIndex((entry) => entry.compactionId === compactionId);
  const previous = index < 0 ? undefined : t.compaction[index];
  if (!previous) return t;
  const compaction = t.compaction.slice();
  compaction[index] = { ...previous, summary: [...previous.summary, content] };
  return { ...t, compaction };
}

/**
 * A `user_message_chunk` only ever means something with no live prompt
 * turn: it is `session/load` replaying the history. During a turn this
 * client itself opened, the turn already holds the user's own prompt, so
 * the echo is dropped rather than duplicated.
 */
function applyUserChunk(t: Transcript, content: ContentBlock): Transcript {
  const index = openTurnIndex(t.turns);
  const open = index < 0 ? undefined : t.turns[index];
  if (open) {
    // A turn this client opened already carries the user's own prompt.
    if (!isReplayTurn(open)) return t;
    // A replay turn with no output yet is still collecting its prompt.
    if (open.blocks.length === 0) {
      const turns = t.turns.slice();
      turns[index] = { ...open, user: [...open.user, content] };
      return { ...t, turns };
    }
  }
  // Nothing open, or the open replay turn has already answered: this chunk
  // starts the next replayed turn.
  return { ...t, turns: [...t.turns, { ...syntheticTurn(t.turns.length), user: [content] }] };
}

function appendChunk(t: Transcript, kind: "text" | "thought", content: ContentBlock): Transcript {
  const record = asRecord(content);
  const text = record?.["type"] === "text" && typeof record["text"] === "string" ? record["text"] : undefined;
  return withOpenTurn(t, (turn) => {
    const blocks = turn.blocks.slice();
    const last = blocks[blocks.length - 1];
    if (text !== undefined && last && last.kind === kind) {
      blocks[blocks.length - 1] = textBlock(kind, last.text + text);
    } else if (text !== undefined) {
      blocks.push(textBlock(kind, text));
    } else {
      blocks.push({ kind: "content", content });
    }
    return { ...turn, blocks };
  });
}

/** A `tool_call` or a `tool_call_update`: every field but the id is optional AND nullable. */
interface ToolCallish {
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: { path: string; line?: number | null }[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

function pushToolCall(t: Transcript, u: ToolCallish): Transcript {
  // No id is no call: it could never be updated, and it would collide
  // with the next id-less one on every merge.
  if (typeof u.toolCallId !== "string" || u.toolCallId === "") return t;
  return withOpenTurn(t, (turn) => ({ ...turn, blocks: [...turn.blocks, { kind: "tool", call: toolStateOf(u) }] }));
}

/**
 * Merges the fields an update carries into the call it names, searching
 * every turn latest first — an adapter may update a tool call long after
 * the turn that opened it, and a `session/load` replay re-uses the same
 * tool call ids as the live turn did, so the most recent one wins. An
 * unknown id is a call this client never saw open (it attached mid-turn),
 * so it becomes a block of its own.
 */
function mergeToolCall(t: Transcript, u: ToolCallUpdate): Transcript {
  for (let ti = t.turns.length - 1; ti >= 0; ti--) {
    const turn = t.turns[ti];
    if (!turn) continue;
    for (let bi = turn.blocks.length - 1; bi >= 0; bi--) {
      const block = turn.blocks[bi];
      if (!block || block.kind !== "tool" || block.call.toolCallId !== u.toolCallId) continue;
      const blocks = turn.blocks.slice();
      blocks[bi] = { kind: "tool", call: mergeToolState(block.call, u) };
      const turns = t.turns.slice();
      turns[ti] = { ...turn, blocks };
      return { ...t, turns };
    }
  }
  return pushToolCall(t, u);
}

function setPlan(t: Transcript, entries: PlanEntry[]): Transcript {
  return withOpenTurn(t, (turn) => {
    const index = turn.blocks.findIndex((b) => b.kind === "plan");
    const blocks = turn.blocks.slice();
    if (index < 0) blocks.push({ kind: "plan", entries });
    else blocks[index] = { kind: "plan", entries };
    return { ...turn, blocks };
  });
}

// -- turn helpers ---------------------------------------------------------

/**
 * Runs `fn` against the open turn, opening a synthetic one first when
 * there is none: a client that attaches mid-conversation, or a
 * `session/load` whose replay starts with agent output rather than the
 * prompt, still has somewhere to put what it is given.
 */
function withOpenTurn(t: Transcript, fn: (turn: Turn) => Turn): Transcript {
  const turns = t.turns.slice();
  let index = openTurnIndex(turns);
  if (index < 0) {
    turns.push(syntheticTurn(turns.length));
    index = turns.length - 1;
  }
  const turn = turns[index];
  if (!turn) return t;
  turns[index] = fn(turn);
  return { ...t, turns };
}

/** Only the last turn can be open — an ended turn never reopens. */
function openTurnIndex(turns: Turn[]): number {
  const last = turns[turns.length - 1];
  return last && last.end === null ? turns.length - 1 : -1;
}

function openTurnIndexById(turns: Turn[], id: string): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn && turn.end === null && turn.id === id) return i;
  }
  return -1;
}

/** Reconcile the server's active turn after folding its bounded replay. */
export function restoreActivePrompt(t: Transcript, active: { id: JsonRpcId } | null | undefined): Transcript {
  if (active === undefined) return t; // Not reported: keep what the records say.
  if (active === null) return t.running ? { ...t, running: false, pending: [] } : t;
  const id = keyOf(active.id);
  if (openTurnIndexById(t.turns, id) >= 0) return { ...t, running: true };
  const turns = [...t.turns];
  const last = turns.at(-1);
  if (last && last.end === null && isReplayTurn(last)) turns[turns.length - 1] = { ...last, id };
  else turns.push({ id, user: [], blocks: [], end: null });
  return { ...t, turns, running: true };
}

function syntheticTurn(index: number): Turn {
  return { id: `replay-${index}`, user: [], blocks: [], end: null };
}

function isReplayTurn(turn: Turn): boolean {
  return turn.id.startsWith("replay-");
}

function textBlock(kind: "text" | "thought", text: string): Block {
  return kind === "text" ? { kind: "text", text } : { kind: "thought", text };
}

/** Validate fields consumed by rendering/search, retaining opaque future block types. */
function contentBlockOf(value: unknown): ContentBlock | undefined {
  const record = asRecord(value);
  if (!record || typeof record["type"] !== "string") return undefined;
  switch (record["type"]) {
    case "text":
      if (typeof record["text"] !== "string") return undefined;
      break;
    case "image":
    case "audio":
      if (typeof record["data"] !== "string" || typeof record["mimeType"] !== "string") return undefined;
      break;
    case "resource_link":
      if (typeof record["uri"] !== "string" || typeof record["name"] !== "string") return undefined;
      if (!["title", "description", "mimeType"].every((key) => optionalString(record[key]))) return undefined;
      break;
    case "resource": {
      const resource = asRecord(record["resource"]);
      if (!resource || typeof resource["uri"] !== "string" || !optionalString(resource["mimeType"])) return undefined;
      if (typeof resource["text"] !== "string" && typeof resource["blob"] !== "string") return undefined;
      // Renderers discriminate embedded text with `"text" in resource`.
      if (hasOwn(resource, "text") && typeof resource["text"] !== "string") return undefined;
      if (hasOwn(resource, "blob") && typeof resource["blob"] !== "string") return undefined;
      break;
    }
  }
  return record as ContentBlock;
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function normalizeToolContent(value: unknown): ToolCallContent[] {
  if (!Array.isArray(value)) return [];
  return value.map(toolContentOf).filter(isDefined);
}

function toolContentOf(value: unknown): ToolCallContent | undefined {
  const record = asRecord(value);
  if (!record || typeof record["type"] !== "string") return undefined;
  switch (record["type"]) {
    case "content":
      if (!contentBlockOf(record["content"])) return undefined;
      break;
    case "diff":
      if (typeof record["path"] !== "string" || typeof record["newText"] !== "string" || !optionalString(record["oldText"])) return undefined;
      break;
    case "terminal":
      if (typeof record["terminalId"] !== "string") return undefined;
      break;
  }
  return record as ToolCallContent;
}

function toolStateOf(u: ToolCallish): ToolCallState {
  const state: ToolCallState = {
    toolCallId: u.toolCallId,
    title: typeof u.title === "string" ? u.title : "",
    kind: typeof u.kind === "string" ? u.kind : "other",
    status: typeof u.status === "string" ? u.status : "pending",
    content: normalizeToolContent(u.content),
    locations: normalizeToolLocations(u.locations),
  };
  if (hasOwn(u, "rawInput")) state.rawInput = u.rawInput;
  if (hasOwn(u, "rawOutput")) state.rawOutput = u.rawOutput;
  return state;
}

/** Every field is optional AND nullable on the wire; null means "unchanged". */
function mergeToolState(call: ToolCallState, u: ToolCallUpdate): ToolCallState {
  const next: ToolCallState = {
    toolCallId: call.toolCallId,
    title: typeof u.title === "string" ? u.title : call.title,
    kind: typeof u.kind === "string" ? u.kind : call.kind,
    status: typeof u.status === "string" ? u.status : call.status,
    content: Array.isArray(u.content) ? normalizeToolContent(u.content) : call.content,
    locations: Array.isArray(u.locations) ? normalizeToolLocations(u.locations) : call.locations,
  };
  const raw = u as ToolCallUpdate & { rawInput?: unknown; rawOutput?: unknown };
  if (hasOwn(raw, "rawInput")) next.rawInput = raw.rawInput;
  else if (hasOwn(call, "rawInput")) next.rawInput = call.rawInput;
  if (hasOwn(raw, "rawOutput")) next.rawOutput = raw.rawOutput;
  else if (hasOwn(call, "rawOutput")) next.rawOutput = call.rawOutput;
  return next;
}

// -- reading untyped wire values ------------------------------------------

function implementationOf(value: unknown): Implementation | null {
  const record = asRecord(value);
  if (!record || typeof record["name"] !== "string" || typeof record["version"] !== "string") return null;
  const title = record["title"];
  return {
    name: record["name"],
    version: record["version"],
    ...(title === null || typeof title === "string" ? { title } : {}),
  };
}

function promptCapabilitiesOf(value: unknown): PromptCapabilities | null {
  const record = asRecord(value);
  if (!record) return null;
  const capabilities: PromptCapabilities = {};
  if (typeof record["image"] === "boolean") capabilities.image = record["image"];
  if (typeof record["audio"] === "boolean") capabilities.audio = record["audio"];
  if (typeof record["embeddedContext"] === "boolean") capabilities.embeddedContext = record["embeddedContext"];
  return capabilities;
}

function authMethodsOf(value: unknown): AuthMethod[] {
  if (!Array.isArray(value)) return [];
  const methods: AuthMethod[] = [];
  for (const candidate of value) {
    const record = asRecord(candidate);
    if (!record || typeof record["id"] !== "string" || typeof record["name"] !== "string") continue;
    const description = record["description"];
    if (record["type"] === "terminal") {
      const args = Array.isArray(record["args"])
        ? record["args"].filter((arg): arg is string => typeof arg === "string")
        : undefined;
      const envRecord = asRecord(record["env"]);
      const env = envRecord
        ? Object.fromEntries(Object.entries(envRecord).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : undefined;
      methods.push({
        type: "terminal",
        id: record["id"],
        name: record["name"],
        ...(description === null || typeof description === "string" ? { description } : {}),
        ...(args ? { args } : {}),
        ...(env ? { env } : {}),
      });
    } else if (record["type"] === undefined || record["type"] === "agent") {
      methods.push({
        id: record["id"],
        name: record["name"],
        ...(description === null || typeof description === "string" ? { description } : {}),
      });
    }
  }
  return methods;
}

function sessionModeOf(value: unknown): SessionMode | undefined {
  const record = asRecord(value);
  if (!record || typeof record["id"] !== "string" || typeof record["name"] !== "string") return undefined;
  const description = record["description"];
  return {
    id: record["id"],
    name: record["name"],
    ...(description === null || typeof description === "string" ? { description } : {}),
  };
}

function availableCommandOf(value: unknown): AvailableCommand | undefined {
  const record = asRecord(value);
  if (!record || typeof record["name"] !== "string" || typeof record["description"] !== "string") return undefined;
  const input = asRecord(record["input"]);
  return {
    name: record["name"],
    description: record["description"],
    ...(record["input"] === null
      ? { input: null }
      : input && typeof input["hint"] === "string"
        ? { input: { hint: input["hint"] } }
        : {}),
  };
}

function legacyModelsOf(value: unknown): LegacyModelState | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const current = record["currentModelId"];
  const rawAvailable = record["availableModels"];
  if (!Array.isArray(rawAvailable)) return undefined;
  const available: LegacyModel[] = [];
  for (const candidate of rawAvailable) {
    const model = asRecord(candidate);
    if (!model || typeof model["modelId"] !== "string" || typeof model["name"] !== "string") continue;
    const description = model["description"];
    available.push({
      id: model["modelId"],
      name: model["name"],
      ...(description === null || typeof description === "string" ? { description } : {}),
    });
  }
  return { current: typeof current === "string" ? current : null, available };
}

function usageOf(value: unknown): Usage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const totalTokens = finiteNonnegativeNumber(record["totalTokens"]);
  const inputTokens = finiteNonnegativeNumber(record["inputTokens"]);
  const outputTokens = finiteNonnegativeNumber(record["outputTokens"]);
  if (totalTokens === undefined || inputTokens === undefined || outputTokens === undefined) return undefined;
  const usage: Usage = { totalTokens, inputTokens, outputTokens };
  for (const key of ["thoughtTokens", "cachedReadTokens", "cachedWriteTokens"] as const) {
    const amount = record[key];
    if (amount === null) usage[key] = null;
    else {
      const normalized = finiteNonnegativeNumber(amount);
      if (normalized !== undefined) usage[key] = normalized;
    }
  }
  return usage;
}

function normalizeToolLocations(value: unknown): { path: string; line?: number | null }[] {
  if (!Array.isArray(value)) return [];
  const locations: { path: string; line?: number | null }[] = [];
  for (const candidate of value) {
    const record = asRecord(candidate);
    if (!record || typeof record["path"] !== "string") continue;
    const line = record["line"];
    locations.push({
      path: record["path"],
      ...(line === null || (typeof line === "number" && Number.isFinite(line)) ? { line } : {}),
    });
  }
  return locations;
}

function finiteNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Ids are compared as strings: an adapter may answer 3 where it was sent "3". */
function keyOf(id: JsonRpcId): string {
  return String(id);
}
