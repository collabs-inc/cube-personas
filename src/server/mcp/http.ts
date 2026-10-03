// Adapted from cube-computer: src/main/cubed/mcp/http.ts
//
// POST /mcp?persona=<id>, on the app's own loopback listener. Only loopback
// peers without an Origin header may reach the ticket check: adapters are
// local processes and never set Origin, while a browser always does. Every
// authentication failure — a remote peer, an Origin, an unknown persona, a
// stale or wrong ticket — answers the same 401 body, so the route never
// reveals which personas exist.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Handler } from "../http";
import { dispatchMcp } from "./protocol";
import { verifyTicket } from "./ticket";
import type { McpTools } from "./tools";

export const MCP_PATH = "/mcp";
export const MAX_MCP_BODY_BYTES = 1024 * 1024;

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const UNAUTHORIZED = { error: "unauthorized" };

export interface McpHandlerDeps {
  secret: Buffer;
  /** The persona's current launch id, or null when it is not running. */
  currentLaunch(personaId: string): string | null;
  tools: Pick<McpTools, "list" | "call">;
  log(line: string): void;
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const declared = Number(req.headers["content-length"] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_MCP_BODY_BYTES) return null;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_MCP_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Why a request is refused before it reaches a tool, or null when it is authenticated. */
function refusal(req: IncomingMessage, deps: McpHandlerDeps, personaId: string): string | null {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return "a non-loopback peer";
  if (req.headers.origin !== undefined) return "a request with an Origin header";
  const header = req.headers.authorization ?? "";
  const ticket = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const launch = deps.currentLaunch(personaId);
  if (launch === null || !verifyTicket(deps.secret, personaId, launch, ticket)) return "a request without a current ticket";
  return null;
}

export function mcpHandler(deps: McpHandlerDeps): Handler {
  return async (req, res) => {
    try {
      const personaId = new URL(req.url ?? "/", "http://localhost").searchParams.get("persona") ?? "";
      const why = refusal(req, deps, personaId);
      if (why !== null) {
        deps.log(`MCP refused ${why}.`);
        send(res, 401, UNAUTHORIZED);
        return;
      }
      if (req.method !== "POST") {
        send(res, 405, { error: "method-not-allowed" });
        return;
      }
      const raw = await readBody(req);
      if (raw === null) {
        send(res, 413, { error: "payload-too-large" });
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        send(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      const result = await dispatchMcp(message, {
        list: () => deps.tools.list(),
        call: (name, args) => deps.tools.call(personaId, name, args),
      }, (error) => {
        deps.log(`MCP tool call failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (result.body === null) send(res, result.status);
      else send(res, result.status, result.body);
    } catch {
      // A disconnected upload rejects the request iterator; contain it at the
      // HTTP boundary rather than leaving an unhandled rejection.
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) res.destroy();
      else send(res, 500, { error: "internal-server-error" });
    }
  };
}
