// Adapted from cube-computer: packages/shared/src/agent-protocol.ts
//
// The shape of a persona's conversation as the server logs it and the page
// receives it: JSON-RPC 2.0 messages, each recorded with its direction and
// seq. Deliberately JSON-RPC-generic: the page's reducer and the server's
// ACP session are the two places that know what the methods MEAN; this file
// only knows what a message IS.

export type JsonRpcId = string | number;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRequest(m: unknown): m is JsonRpcRequest {
  return isRecordLike(m) && typeof m.method === "string" && ("id" in m) && m.id !== null && m.id !== undefined;
}

export function isNotification(m: unknown): m is JsonRpcNotification {
  return isRecordLike(m) && typeof m.method === "string" && !("id" in m);
}

export function isResponse(m: unknown): m is JsonRpcResponse {
  return isRecordLike(m) && !("method" in m) && ("id" in m) && ("result" in m || "error" in m);
}

/** One line of the pipe as a message, or null for anything that is not JSON-RPC 2.0. */
export function parseJsonRpc(text: string): JsonRpcMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecordLike(parsed) || parsed.jsonrpc !== "2.0") return null;
  if (isRequest(parsed) || isNotification(parsed) || isResponse(parsed)) return parsed;
  return null;
}

/** One logged message: which way it crossed the adapter's pipe ("in" to it, "out" from it), its seq, and the message. */
export interface AgentRecord {
  dir: "in" | "out";
  seq: number;
  message: JsonRpcMessage;
}

/** What the page's transcript store folds in on an open: the records, the log's last seq, and whether they replace what it holds. */
export interface AgentOpenResult {
  sessionId: string;
  seq: number;
  /** `records` replace the transcript rather than extend it. */
  reset: boolean;
  records: AgentRecord[];
  /** The turn running at this boundary; null means idle. */
  activePrompt?: { id: JsonRpcId } | null;
}

/** Marks a prompt admission refusal; the following detail identifies its state. */
export const BUSY_MARKER = "agent:busy";

/**
 * The largest single line either side may put on an adapter's pipe. Every
 * line is one record in the log and one frame to every open page, so one
 * unbounded line would be held, written and sent whole. 1 MiB is far above
 * any real prompt: a phone photo is the only thing that ever approaches it,
 * and the composer downscales those before they get here.
 */
export const MAX_PIPE_LINE_BYTES = 1024 * 1024;

/**
 * Marks the refusal of a message over MAX_PIPE_LINE_BYTES. The rest is
 * written for the person; the page strips this prefix and shows it.
 */
export const MESSAGE_TOO_LARGE_PREFIX = "message-too-large: ";

/** The one wording for that refusal, so both sides of the pipe say it the same way. */
export function messageTooLargeError(bytes: number): Error {
  return new Error(
    `${MESSAGE_TOO_LARGE_PREFIX}This message is ${Math.round(bytes / 1024)} KB; the limit is `
    + `${MAX_PIPE_LINE_BYTES / 1024} KB. Try a smaller attachment.`,
  );
}

/** A file attached to a prompt, as bytes. */
export interface AgentFilePayload {
  contentBase64: string;
  mime: string;
  filename: string;
}
