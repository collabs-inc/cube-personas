// Adapted from cube-computer: src/main/cubed/mcp/protocol.ts
//
// The MCP subset the app speaks: initialize, tools/list, tools/call, and
// notifications. Pure — no HTTP, no app state — so the whole surface is
// testable without a socket. A tool that throws (an unknown tool included)
// answers `isError` inside a RESULT rather than a JSON-RPC error: that is
// what puts the failure in the agent's transcript as a tool outcome it can
// react to, instead of a transport fault its MCP client swallows. Only a
// UserFacingError's sentence reaches the transcript; anything else (a raw
// Node error naming a state path, say) is handed to `unexpected` and the
// persona reads GENERIC_FAILURE.
import { GENERIC_FAILURE, UserFacingError } from "../errors";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tools one persona may call: discovery and invocation, already bound to that persona. */
export interface McpToolSet {
  list(): ToolDescriptor[];
  call(name: string, args: unknown): Promise<unknown>;
}

export interface McpDispatchResult {
  status: number;
  body: unknown | null;
}

interface Incoming {
  jsonrpc?: unknown;
  id?: string | number;
  method?: unknown;
  params?: unknown;
}

const ok = (id: string | number, result: unknown): McpDispatchResult =>
  ({ status: 200, body: { jsonrpc: "2.0", id, result } });

const fail = (id: string | number, code: number, message: string): McpDispatchResult =>
  ({ status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } });

export async function dispatchMcp(
  message: unknown, tools: McpToolSet, unexpected: (error: unknown) => void = () => {},
): Promise<McpDispatchResult> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return { status: 200, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } } };
  }
  const { id, method, params } = message as Incoming;
  if (typeof method !== "string") {
    return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid Request" } } };
  }
  // No id at all is a notification: accepted, never answered.
  if (id === undefined) return { status: 202, body: null };

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "personas", version: "1" },
    });
  }
  if (method === "tools/list") {
    return ok(id, { tools: tools.list() });
  }
  if (method === "tools/call") {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const args = typeof p.arguments === "object" && p.arguments !== null ? p.arguments : {};
    try {
      const value = await tools.call(String(p.name), args);
      return ok(id, { content: [{ type: "text", text: JSON.stringify(value ?? null) }] });
    } catch (err) {
      if (!(err instanceof UserFacingError)) unexpected(err);
      const text = err instanceof UserFacingError ? err.message : GENERIC_FAILURE;
      return ok(id, { content: [{ type: "text", text }], isError: true });
    }
  }
  return fail(id, -32601, `Unknown method ${method}`);
}
