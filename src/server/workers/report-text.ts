// Adapted from cube-computer: src/main/cubed/personas/terminal-reports.ts and src/main/cubed/attention/adapters.ts
//
// What a worker said at the end of its turn. A pty carries screen bytes, and
// scraping ANSI out of a scrollback to guess what an agent said is not
// evidence, so a report is built from the one structured thing each harness
// hands its hook:
//
// - codex gives the whole final message to `notify` as `last-assistant-message`;
// - claude's `Stop` payload names a `transcript_path`, so the message is read
//   back out of its own JSONL log.
//
// Both are private formats of another product, so every failure degrades to
// `messageUnavailable: true`: a report that says the turn ended and admits it
// could not recover the words. An empty report would be indistinguishable
// from an agent that said nothing.
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { Harness } from "../../shared/types";

export const MAX_REPORT_TEXT_BYTES = 4096;

/** A transcript grows without bound; its final turn is at the end of it. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

// Codex also notifies for its private title-generation thread; its synthetic
// prompt identifies it even in a truncated payload.
const CODEX_TITLE_PROMPT = "Generate a concise, single-line task title of at most 36 characters and under five words where possible.";
const CODEX_TITLE_PATTERN = /"input-messages"\s*:\s*\[\s*"Generate a concise, single-line task title of at most 36 characters and under five words where possible\./;

export interface PayloadReport {
  kind: "turn-ended" | "other";
  text: string;
  messageUnavailable: boolean;
  sessionId: string | null;
}

interface Fields {
  hookEventName: string | null;
  type: string | null;
  sessionId: string | null;
  threadId: string | null;
  transcriptPath: string | null;
  lastAssistantMessage: string | null;
  internalTitle: boolean;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** One string field out of JSON that may have been cut short. */
function pick(text: string, key: string): string | null {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  if (!match) return null;
  try {
    return str(JSON.parse(`"${match[1]}"`));
  } catch {
    return null;
  }
}

/**
 * A parsed payload, or the raw text of one the hook cut at its byte cap. The
 * fields needed come first in both harnesses' payloads, so a truncated one
 * still yields them by pattern — except codex's message, which is the
 * payload's bulk: half a message is worse than none.
 */
function fieldsOf(payload: unknown): Fields {
  if (typeof payload === "string") {
    return {
      hookEventName: pick(payload, "hook_event_name"),
      type: pick(payload, "type"),
      sessionId: pick(payload, "session_id"),
      threadId: pick(payload, "thread-id"),
      transcriptPath: pick(payload, "transcript_path"),
      lastAssistantMessage: null,
      internalTitle: CODEX_TITLE_PATTERN.test(payload),
    };
  }
  const json = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const inputs = json["input-messages"];
  return {
    hookEventName: str(json.hook_event_name),
    type: str(json.type),
    sessionId: str(json.session_id),
    threadId: str(json["thread-id"]),
    transcriptPath: str(json.transcript_path),
    lastAssistantMessage: str(json["last-assistant-message"]),
    internalTitle: Array.isArray(inputs) && typeof inputs[0] === "string" && inputs[0].startsWith(CODEX_TITLE_PROMPT),
  };
}

/**
 * Only a regular file is read: opening a FIFO or a device named by a payload
 * could block this worker's report queue forever. O_NONBLOCK covers a path
 * swapped between the stat and the open.
 */
async function tail(path: string): Promise<string> {
  if (!(await stat(path)).isFile()) throw new Error("not a regular file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a regular file");
    const { size } = info;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const { buffer, bytesRead } = await handle.read({
      buffer: Buffer.alloc(Math.min(size, TRANSCRIPT_TAIL_BYTES)), position: start,
    });
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } =>
      !!block && typeof block === "object"
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * Claude's transcript is one JSON object per line. Scanning backwards finds
 * the turn that just ended without parsing the whole history, and a first
 * line cut by the tail read simply fails to parse and is skipped.
 */
export function lastAssistantMessage(transcript: string): string {
  const lines = transcript.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let entry: { type?: unknown; message?: { role?: unknown; content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    const isAssistant = entry.type === "assistant" || entry.message?.role === "assistant";
    if (!isAssistant) continue;
    const text = textOfContent(entry.message?.content);
    // A tool-use-only assistant entry has no text; keep walking back.
    if (text.trim()) return text;
  }
  return "";
}

/** Truncates on a code-point boundary, so a cut never yields U+FFFD. */
export function capReportText(text: string, max = MAX_REPORT_TEXT_BYTES): string {
  if (Buffer.byteLength(text) <= max) return text;
  let out = "";
  let remaining = max;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (bytes > remaining) break;
    out += char;
    remaining -= bytes;
  }
  return out;
}

const OTHER: PayloadReport = { kind: "other", text: "", messageUnavailable: false, sessionId: null };

function ended(text: string, sessionId: string | null): PayloadReport {
  const capped = capReportText(text);
  return { kind: "turn-ended", text: capped, messageUnavailable: capped === "", sessionId };
}

export async function reportFromPayload(harness: Harness, payload: unknown): Promise<PayloadReport> {
  const fields = fieldsOf(payload);
  if (harness === "claude") {
    if (fields.hookEventName !== "Stop") return OTHER;
    let text = "";
    if (fields.transcriptPath) {
      try {
        text = lastAssistantMessage(await tail(fields.transcriptPath));
      } catch {
        text = "";
      }
    }
    return ended(text, fields.sessionId);
  }
  if (fields.type !== "agent-turn-complete" || fields.internalTitle) return OTHER;
  return ended(fields.lastAssistantMessage ?? "", fields.threadId);
}
