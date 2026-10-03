// Adapted from cube-computer: src/main/cubed/mcp/protocol.test.ts
import { describe, expect, test } from "vitest";
import { GENERIC_FAILURE, UserFacingError } from "../../src/server/errors";
import { dispatchMcp, MCP_PROTOCOL_VERSION, type McpToolSet } from "../../src/server/mcp/protocol";

const echo: McpToolSet = {
  list: () => [{
    name: "echo",
    description: "echoes",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  }],
  call: async (name, args) => {
    if (name === "boom") throw new UserFacingError("nope");
    if (name === "raw") throw new Error("EACCES: permission denied, open '/state/cube-personas/secret'");
    if (name !== "echo") throw new UserFacingError(`Unknown tool ${name}.`);
    return { said: (args as { text?: unknown }).text };
  },
};

describe("dispatchMcp", () => {
  test("initialize answers with the protocol version and tool capability", async () => {
    const r = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, echo);
    expect(r.status).toBe(200);
    expect((r.body as any).result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect((r.body as any).result.capabilities.tools).toBeDefined();
  });

  test("tools/list names every tool with its schema", async () => {
    const r = await dispatchMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, echo);
    expect((r.body as any).result.tools[0].name).toBe("echo");
    expect((r.body as any).result.tools[0].inputSchema.required).toEqual(["text"]);
  });

  test("tools/call returns the handler's value as text content", async () => {
    const r = await dispatchMcp(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } },
      echo,
    );
    expect((r.body as any).result.content[0].type).toBe("text");
    expect(JSON.parse((r.body as any).result.content[0].text)).toEqual({ said: "hi" });
    expect((r.body as any).result.isError).toBeFalsy();
  });

  test("a UserFacingError answers isError with its sentence rather than a transport error", async () => {
    const r = await dispatchMcp(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom", arguments: {} } },
      echo,
    );
    expect(r.status).toBe(200);
    expect((r.body as any).result.isError).toBe(true);
    expect((r.body as any).result.content[0].text).toContain("nope");
  });

  test("any other error is replaced by the generic sentence and handed to unexpected", async () => {
    const seen: unknown[] = [];
    const r = await dispatchMcp(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "raw", arguments: {} } },
      echo, (error) => { seen.push(error); },
    );
    expect((r.body as any).result).toEqual({ content: [{ type: "text", text: GENERIC_FAILURE }], isError: true });
    expect(GENERIC_FAILURE).toBe("That did not work. Try again.");
    expect((seen[0] as Error).message).toContain("/state/cube-personas/secret");
  });

  test("an unknown tool is an error result, an unknown method a JSON-RPC error", async () => {
    const unknownTool = await dispatchMcp(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } }, echo,
    );
    expect((unknownTool.body as any).result).toEqual({ content: [{ type: "text", text: "Unknown tool nope." }], isError: true });
    const unknownMethod = await dispatchMcp({ jsonrpc: "2.0", id: 6, method: "resources/list" }, echo);
    expect((unknownMethod.body as any).error.code).toBe(-32601);
  });

  test("a notification is accepted with no body", async () => {
    const r = await dispatchMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, echo);
    expect(r).toEqual({ status: 202, body: null });
  });

  test("a non-object message is a parse-level error", async () => {
    const r = await dispatchMcp("nonsense", echo);
    expect((r.body as any).error.code).toBe(-32600);
  });
});
