// Adapted from cube-computer: src/main/cubed/mcp/http.test.ts
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MAX_MCP_BODY_BYTES, MCP_PATH, mcpHandler, type McpHandlerDeps } from "../../src/server/mcp/http";
import { deriveTicket } from "../../src/server/mcp/ticket";

const secret = Buffer.from("0123456789abcdef0123456789abcdef");
const UNAUTHORIZED = '{"error":"unauthorized"}';

const launches = new Map<string, string>([["p-1", "launch-1"]]);
const calls: Array<{ personaId: string; name: string; args: unknown }> = [];
const logged: string[] = [];

const deps: McpHandlerDeps = {
  secret,
  currentLaunch: (id) => launches.get(id) ?? null,
  tools: {
    list: () => [{ name: "ping", description: "pings", inputSchema: { type: "object", properties: {} } }],
    call: async (personaId, name, args) => {
      if (name === "leak") throw new Error("EACCES: permission denied, open '/home/u/.local/state/cube-personas/reports/p-1.json'");
      calls.push({ personaId, name, args });
      return { pong: true };
    },
  },
  log: (line) => { logged.push(line); },
};

let server: http.Server;
let base = "";
const ticket = () => deriveTicket(secret, "p-1", launches.get("p-1")!);

beforeAll(async () => {
  server = http.createServer(mcpHandler(deps));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${MCP_PATH}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}?persona=p-1`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${ticket()}`, ...headers },
  body: JSON.stringify(body),
});

/** A server whose handler sees `address` as the peer, as a request over another interface would. */
async function withPeer(address: string, run: (url: string) => Promise<void>): Promise<void> {
  const handle = mcpHandler(deps);
  const remote = http.createServer((req, res) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: address });
    void handle(req, res);
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(remote.address() as AddressInfo).port}${MCP_PATH}`);
  } finally {
    remote.closeAllConnections();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
  }
}

describe("mcp http", () => {
  test("a non-loopback peer gets the 401 body, even with a valid ticket", async () => {
    await withPeer("203.0.113.1", async (url) => {
      const res = await fetch(`${url}?persona=p-1`, {
        method: "POST", headers: { authorization: `Bearer ${ticket()}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe(UNAUTHORIZED);
    });
  });

  test("an IPv6 loopback peer and its mapped IPv4 form are admitted", async () => {
    for (const address of ["::1", "::ffff:127.0.0.1"]) {
      await withPeer(address, async (url) => {
        const res = await fetch(`${url}?persona=p-1`, {
          method: "POST", headers: { authorization: `Bearer ${ticket()}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        expect(res.status).toBe(200);
      });
    }
  });

  test("a request with an Origin gets the 401 body, even with a valid ticket", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "http://127.0.0.1:4870" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(UNAUTHORIZED);
  });

  test("answers a request with JSON, calling tools as the persona the ticket names", async () => {
    const list = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(list.status).toBe(200);
    expect(list.headers.get("content-type")).toContain("application/json");
    expect((await list.json() as any).result.tools[0].name).toBe("ping");
    calls.length = 0;
    const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: { a: 1 } } });
    expect(JSON.parse((await call.json() as any).result.content[0].text)).toEqual({ pong: true });
    expect(calls).toEqual([{ personaId: "p-1", name: "ping", args: { a: 1 } }]);
  });

  test("accepts a notification with 202 and no body", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("GET is 405 after authentication — this server never streams", async () => {
    const res = await fetch(`${base}?persona=p-1`, { headers: { authorization: `Bearer ${ticket()}` } });
    expect(res.status).toBe(405);
    const anonymous = await fetch(`${base}?persona=p-1`);
    expect(anonymous.status).toBe(401);
  });

  test("a wrong ticket, a wrong persona and a missing header all get the one 401 body", async () => {
    const wrongTicket = await fetch(`${base}?persona=p-1`, {
      method: "POST", headers: { authorization: "Bearer nope" }, body: "{}",
    });
    // Same ticket, different persona: the id is inside the HMAC.
    const wrongPersona = await fetch(`${base}?persona=p-2`, {
      method: "POST", headers: { authorization: `Bearer ${ticket()}` }, body: "{}",
    });
    const missing = await fetch(`${base}?persona=p-1`, { method: "POST", body: "{}" });
    for (const res of [wrongTicket, wrongPersona, missing]) {
      expect(res.status).toBe(401);
      expect(await res.text()).toBe(UNAUTHORIZED);
    }
  });

  test("a ticket for an old launch is refused once currentLaunch changes", async () => {
    const old = ticket();
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${old}` })).status).toBe(200);
    launches.set("p-1", "launch-2");
    try {
      const stale = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${old}` });
      expect(stale.status).toBe(401);
      expect(await stale.text()).toBe(UNAUTHORIZED);
      expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
    } finally {
      launches.set("p-1", "launch-1");
    }
  });

  test("the log names why a request was refused, never the ticket or secret", async () => {
    logged.length = 0;
    await post({}, { origin: "https://example.com" });
    expect(logged).toEqual(["MCP refused a request with an Origin header."]);
    for (const line of logged) {
      expect(line).not.toContain(ticket());
      expect(line).not.toContain(secret.toString("hex"));
    }
  });

  test("a dependency's raw error reaches the log, and the persona sees only the generic sentence", async () => {
    logged.length = 0;
    const res = await post({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "leak", arguments: {} } });
    const body = await res.json() as any;
    expect(body.result).toEqual({ content: [{ type: "text", text: "That did not work. Try again." }], isError: true });
    expect(JSON.stringify(body)).not.toContain("cube-personas");
    expect(logged).toEqual(["MCP tool call failed: EACCES: permission denied, open '/home/u/.local/state/cube-personas/reports/p-1.json'"]);
  });

  test("an oversized body is refused without being parsed", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(MAX_MCP_BODY_BYTES + 10) } });
    expect(res.status).toBe(413);
  });

  test("unparseable JSON is a parse error, not a crash", async () => {
    const res = await fetch(`${base}?persona=p-1`, {
      method: "POST", headers: { authorization: `Bearer ${ticket()}` }, body: "{not json",
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).error.code).toBe(-32700);
  });

  test("a chunked body exceeding the byte limit returns 413", async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request(`${base}?persona=p-1`, {
        method: "POST", headers: { authorization: `Bearer ${ticket()}` },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      // No Content-Length: exercise the streaming limit, including UTF-8 bytes.
      req.write('"');
      req.end("é".repeat(MAX_MCP_BODY_BYTES / 2) + '"');
    });
    expect(status).toBe(413);
  });

  test("an interrupted upload does not leave an unhandled rejection", async () => {
    let sawData!: () => void;
    let sawClose!: () => void;
    const data = new Promise<void>((resolve) => { sawData = resolve; });
    const closed = new Promise<void>((resolve) => { sawClose = resolve; });
    const handle = mcpHandler(deps);
    const interrupted = http.createServer((req, res) => {
      req.once("data", sawData);
      req.once("close", sawClose);
      void handle(req, res);
    });
    await new Promise<void>((resolve) => interrupted.listen(0, "127.0.0.1", resolve));
    const port = (interrupted.address() as AddressInfo).port;
    const req = http.request(`http://127.0.0.1:${port}${MCP_PATH}?persona=p-1`, {
      method: "POST", headers: { authorization: `Bearer ${ticket()}` },
    });
    req.on("error", () => {}); // The client deliberately resets the socket.
    try {
      req.write('{"partial":');
      await data;
      req.destroy();
      await closed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
    } finally {
      req.destroy();
      interrupted.closeAllConnections();
      await new Promise<void>((resolve) => interrupted.close(() => resolve()));
    }
  });
});
