// Adapted from cube-computer: src/main/cubed/acp/handshake.ts
//
// The session handshake requests and how the server reads their replies.
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from "../../shared/agent-protocol";
import type { Harness } from "../../shared/types";

export const ACP_PROTOCOL_VERSION = 1;

export interface McpServerConfig {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

/**
 * The permission preset for a persona's session. Harnesses gate MCP tools
 * behind the same prompt as everything else, and a persona that must ask
 * before each `spawn_agent` cannot run while the human is away.
 */
export const PERMISSIVE_MODES: Readonly<Record<Harness, string>> = {
  claude: "bypassPermissions",
  codex: "agent-full-access",
};

/** Files are answered by the server; terminals are not offered at all. */
export function initializeRequest(id: JsonRpcId): JsonRpcRequest {
  return {
    jsonrpc: "2.0", id, method: "initialize",
    params: {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: "cube-personas", version: "1" },
    },
  };
}

/**
 * `meta` is the adapter-specific extension ACP reserves for exactly this:
 * the caller's `_meta`, sent only when there is one. Claude's adapter reads
 * `_meta.systemPrompt`; every other adapter ignores an unknown key, and an
 * absent key is what an adapter that branches on its presence must see.
 */
export function newSessionRequest(
  id: JsonRpcId, cwd: string, servers: readonly McpServerConfig[], meta?: Record<string, unknown>,
): JsonRpcRequest {
  return {
    jsonrpc: "2.0", id, method: "session/new",
    params: { cwd, mcpServers: servers, ...(meta === undefined ? {} : { _meta: meta }) },
  };
}

export function loadSessionRequest(
  id: JsonRpcId, sessionId: string, cwd: string, servers: readonly McpServerConfig[], meta?: Record<string, unknown>,
): JsonRpcRequest {
  return {
    jsonrpc: "2.0", id, method: "session/load",
    params: { sessionId, cwd, mcpServers: servers, ...(meta === undefined ? {} : { _meta: meta }) },
  };
}

export function setModeRequest(id: JsonRpcId, sessionId: string, modeId: string): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "session/set_mode", params: { sessionId, modeId } };
}

/** Read narrowly: codex-acp's `session/load` reply carries no `sessionId` at all. */
export function sessionIdFrom(res: JsonRpcResponse): string | null {
  const result = res.result as { sessionId?: unknown } | undefined;
  return typeof result?.sessionId === "string" ? result.sessionId : null;
}

export function supportsLoadSession(res: JsonRpcResponse): boolean {
  const result = res.result as { agentCapabilities?: { loadSession?: unknown } } | undefined;
  return result?.agentCapabilities?.loadSession === true;
}

export function supportsHttpMcp(res: JsonRpcResponse): boolean {
  const result = res.result as { agentCapabilities?: { mcpCapabilities?: { http?: unknown } } } | undefined;
  return result?.agentCapabilities?.mcpCapabilities?.http === true;
}
