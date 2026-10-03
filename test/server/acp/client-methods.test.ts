// Adapted from cube-computer: src/main/cubed/acp/capabilities.test.ts
import { describe, expect, test } from "vitest";
import { answerClientRequest, isClientMethod, MAX_READ_FILE_BYTES, type ClientDeps } from "../../../src/server/acp/client-methods";

function deps(overrides: Partial<ClientDeps> = {}): ClientDeps {
  return {
    readFile: async () => "line1\nline2\nline3\n",
    writeFile: async () => {},
    ...overrides,
  };
}
const req = (id: number, method: string, params: unknown) => ({ jsonrpc: "2.0" as const, id, method, params });

describe("answerClientRequest", () => {
  test("fs/read_text_file returns the whole file, or a line window, under the pipe's byte cap", async () => {
    let cap = 0;
    const d = deps({ readFile: async (_p, max) => { cap = max; return "line1\nline2\nline3\n"; } });
    expect((await answerClientRequest(req(1, "fs/read_text_file", { sessionId: "s", path: "/a" }), d)).result)
      .toEqual({ content: "line1\nline2\nline3\n" });
    expect(cap).toBe(MAX_READ_FILE_BYTES);
    expect((await answerClientRequest(req(2, "fs/read_text_file", { sessionId: "s", path: "/a", line: 2, limit: 1 }), d)).result)
      .toEqual({ content: "line2\n" });
  });

  test("fs/write_text_file writes and answers an empty object", async () => {
    const writes: [string, string][] = [];
    const d = deps({ writeFile: async (p, c) => { writes.push([p, c]); } });
    const res = await answerClientRequest(req(3, "fs/write_text_file", { sessionId: "s", path: "/b", content: "x" }), d);
    expect(writes).toEqual([["/b", "x"]]);
    expect(res).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  test("a relative path is refused for both reads and writes, without touching the disk", async () => {
    let touched = false;
    const d = deps({
      readFile: async () => { touched = true; return ""; },
      writeFile: async () => { touched = true; },
    });
    const read = await answerClientRequest(req(4, "fs/read_text_file", { sessionId: "s", path: "notes/a.md" }), d);
    const write = await answerClientRequest(req(5, "fs/write_text_file", { sessionId: "s", path: "../b", content: "x" }), d);
    expect(read.error).toEqual({ code: -32000, message: "path must be absolute" });
    expect(write.error).toEqual({ code: -32000, message: "path must be absolute" });
    expect(touched).toBe(false);
  });

  test("terminals are not offered: every terminal/* method is -32601", async () => {
    for (const method of ["terminal/create", "terminal/output", "terminal/wait_for_exit", "terminal/kill", "terminal/release"]) {
      expect((await answerClientRequest(req(6, method, { sessionId: "s" }), deps())).error?.code).toBe(-32601);
    }
  });

  test("a dep failure is a -32000 error response, an unknown method -32601", async () => {
    const d = deps({ readFile: async () => { throw new Error("ENOENT"); } });
    const res = await answerClientRequest(req(9, "fs/read_text_file", { sessionId: "s", path: "/nope" }), d);
    expect(res.error?.code).toBe(-32000);
    expect(res.error?.message).toMatch(/ENOENT/);
    expect((await answerClientRequest(req(10, "fs/nope", {}), deps())).error?.code).toBe(-32601);
  });

  test("fs/* and terminal/* are the server's to answer; anything else is a human's", () => {
    expect(isClientMethod("fs/read_text_file")).toBe(true);
    expect(isClientMethod("terminal/create")).toBe(true);
    expect(isClientMethod("session/request_permission")).toBe(false);
  });
});
