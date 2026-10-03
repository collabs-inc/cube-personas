// Adapted from cube-computer: src/main/cubed/acp/capabilities.ts
//
// The client methods the server answers ITSELF on the persona's behalf:
// reading and writing text files. They are answered whether or not any
// page is attached — a persona keeps working while every tab is closed.
// Terminals are not offered (`initialize` advertises `terminal: false`), so
// a `terminal/*` request, like any other method this file does not know,
// is answered `-32601`. Everything touching the disk is behind
// `ClientDeps` so this file stays pure; session.ts wires the real one in.
import { isAbsolute } from "node:path";
import { MAX_PIPE_LINE_BYTES } from "../../shared/agent-protocol";
import type { JsonRpcRequest, JsonRpcResponse } from "../../shared/agent-protocol";
import type { ReadTextFileRequest, WriteTextFileRequest } from "@agentclientprotocol/sdk";

export interface ClientDeps {
  /**
   * Reads a text file, refusing one larger than `maxBytes` rather than
   * loading it — the answer travels back to the adapter as ONE line on its
   * stdin, and a line over MAX_PIPE_LINE_BYTES cannot be sent.
   */
  readFile(path: string, maxBytes: number): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export const UNKNOWN_METHOD = -32601;
const CLIENT_FAILURE = -32000;

/** The largest file `fs/read_text_file` will read: the pipe's own line cap. */
export const MAX_READ_FILE_BYTES = MAX_PIPE_LINE_BYTES;

/** Methods the server answers itself; any other adapter request is a human's to answer. */
export function isClientMethod(method: string): boolean {
  return method.startsWith("fs/") || method.startsWith("terminal/");
}

function lineWindow(content: string, line: number | null | undefined, limit: number | null | undefined): string {
  if (line == null && limit == null) return content;
  const lines = content.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit == null ? lines.length : Math.min(lines.length, start + limit);
  const slice = lines.slice(start, end);
  return slice.length && end < lines.length ? `${slice.join("\n")}\n` : slice.join("\n");
}

function absolutePath(path: unknown): string {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("path must be absolute");
  return path;
}

async function answer(req: JsonRpcRequest, deps: ClientDeps): Promise<unknown> {
  const p = (req.params ?? {}) as Record<string, unknown>;
  switch (req.method) {
    case "fs/read_text_file": {
      const a = p as unknown as ReadTextFileRequest;
      const content = await deps.readFile(absolutePath(a.path), MAX_READ_FILE_BYTES);
      return { content: lineWindow(content, a.line, a.limit) };
    }
    case "fs/write_text_file": {
      const a = p as unknown as WriteTextFileRequest;
      if (typeof a.content !== "string") throw new Error("content must be a string");
      await deps.writeFile(absolutePath(a.path), a.content);
      return {};
    }
    default:
      throw Object.assign(new Error(`unknown method ${req.method}`), { code: UNKNOWN_METHOD });
  }
}

export async function answerClientRequest(req: JsonRpcRequest, deps: ClientDeps): Promise<JsonRpcResponse> {
  try {
    return { jsonrpc: "2.0", id: req.id, result: await answer(req, deps) };
  } catch (err) {
    const code = (err as { code?: number }).code === UNKNOWN_METHOD ? UNKNOWN_METHOD : CLIENT_FAILURE;
    return { jsonrpc: "2.0", id: req.id, error: { code, message: err instanceof Error ? err.message : String(err) } };
  }
}
