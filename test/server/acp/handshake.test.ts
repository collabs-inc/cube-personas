// Adapted from cube-computer: src/main/cubed/acp/handshake.test.ts
import { describe, expect, test } from "vitest";
import {
  initializeRequest, loadSessionRequest, newSessionRequest, PERMISSIVE_MODES, sessionIdFrom, setModeRequest,
  supportsHttpMcp, supportsLoadSession,
} from "../../../src/server/acp/handshake";

describe("handshake", () => {
  test("initialize advertises fs and no terminal at protocol 1", () => {
    expect(initializeRequest("d:1")).toEqual({
      jsonrpc: "2.0", id: "d:1", method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: "cube-personas", version: "1" },
      },
    });
  });

  test("session/new and session/load carry cwd and empty mcpServers", () => {
    expect(newSessionRequest("d:2", "/r", []).params).toEqual({ cwd: "/r", mcpServers: [] });
    expect(loadSessionRequest("d:3", "s-1", "/r", []).params).toEqual({ sessionId: "s-1", cwd: "/r", mcpServers: [] });
  });

  test("an adapter-specific _meta rides both session requests, and is absent when there is none", () => {
    const meta = { systemPrompt: { append: "write artifacts as HTML" } };
    expect(newSessionRequest("d:2", "/r", [], meta).params).toEqual({ cwd: "/r", mcpServers: [], _meta: meta });
    expect(loadSessionRequest("d:3", "s-1", "/r", [], meta).params).toEqual({
      sessionId: "s-1", cwd: "/r", mcpServers: [], _meta: meta,
    });
    // Absent rather than `_meta: undefined`: an adapter that branches on the key's presence must see none.
    expect("_meta" in (newSessionRequest("d:4", "/r", []).params as object)).toBe(false);
    expect("_meta" in (loadSessionRequest("d:5", "s-1", "/r", []).params as object)).toBe(false);
  });

  test("a persona's session carries its tool server with a bearer ticket", () => {
    const servers = [{
      type: "http" as const,
      name: "personas",
      url: "http://127.0.0.1:4870/mcp?persona=p-1",
      headers: [{ name: "Authorization", value: "Bearer abc" }],
    }];
    expect(newSessionRequest("d:2", "/home/u", servers).params).toEqual({ cwd: "/home/u", mcpServers: servers });
    // session/load carries it too, or a resumed persona loses its tools.
    expect(loadSessionRequest("d:3", "s-1", "/home/u", servers).params).toEqual({
      sessionId: "s-1", cwd: "/home/u", mcpServers: servers,
    });
  });

  test("session/set_mode names the session and the mode; each harness has a permissive one", () => {
    expect(setModeRequest("d:4", "s-1", PERMISSIVE_MODES.claude)).toEqual({
      jsonrpc: "2.0", id: "d:4", method: "session/set_mode", params: { sessionId: "s-1", modeId: "bypassPermissions" },
    });
    expect(PERMISSIVE_MODES.codex).toBe("agent-full-access");
  });

  test("reads the adapter's http MCP capability", () => {
    const yes = { jsonrpc: "2.0" as const, id: "d:1", result: { agentCapabilities: { mcpCapabilities: { http: true } } } };
    const no = { jsonrpc: "2.0" as const, id: "d:1", result: { agentCapabilities: { mcpCapabilities: { http: false } } } };
    expect(supportsHttpMcp(yes)).toBe(true);
    expect(supportsHttpMcp(no)).toBe(false);
    expect(supportsHttpMcp({ jsonrpc: "2.0", id: "d:1", result: {} })).toBe(false);
  });

  test("reads the session id and loadSession capability", () => {
    expect(sessionIdFrom({ jsonrpc: "2.0", id: "d:2", result: { sessionId: "abc" } })).toBe("abc");
    expect(sessionIdFrom({ jsonrpc: "2.0", id: "d:2", error: { code: 1, message: "no" } })).toBeNull();
    expect(supportsLoadSession({ jsonrpc: "2.0", id: "d:1", result: { agentCapabilities: { loadSession: true } } })).toBe(true);
    expect(supportsLoadSession({ jsonrpc: "2.0", id: "d:1", result: {} })).toBe(false);
  });
});
