// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { connect, LOST_CONNECTION, type SocketLike } from "../../src/web/api";

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: Array<{ id: number; verb: string; args: unknown }> = [];
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(JSON.parse(data) as { id: number; verb: string; args: unknown }); }
  close(): void { this.drop(); }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  drop(): void { this.readyState = 3; this.onclose?.({}); }
  reply(id: number, result: unknown): void { this.onmessage?.({ data: JSON.stringify({ t: "res", id, ok: true, result }) }); }
  fail(id: number, error: string): void { this.onmessage?.({ data: JSON.stringify({ t: "res", id, ok: false, error }) }); }
  event(name: string, payload: unknown): void { this.onmessage?.({ data: JSON.stringify({ t: "evt", name, payload }) }); }
}

let sockets: FakeSocket[];
const createSocket = (url: string): FakeSocket => {
  const socket = new FakeSocket(url);
  sockets.push(socket);
  return socket;
};
const last = (): FakeSocket => sockets.at(-1)!;

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("resolves a relative URL against the page and switches to ws:", () => {
  const api = connect("/ws", { createSocket });
  expect(last().url).toBe(`ws://${window.location.host}/ws`);
  api.close();
});

test("a request answered by the server resolves, an error rejects with its sentence", async () => {
  const api = connect("/ws", { createSocket });
  last().open();
  const listed = api.request("personas:list", {});
  const renamed = api.request("persona:rename", { id: "p1", name: "" });
  const [first, second] = last().sent;
  expect(first).toMatchObject({ verb: "personas:list", args: {} });
  last().reply(first!.id, []);
  last().fail(second!.id, "A name cannot be empty.");
  await expect(listed).resolves.toEqual([]);
  await expect(renamed).rejects.toThrow("A name cannot be empty.");
  api.close();
});

test("events reach their listeners until unsubscribed", () => {
  const api = connect("/ws", { createSocket });
  last().open();
  const seen: unknown[] = [];
  const off = api.on("persona:state", (payload) => seen.push(payload));
  last().event("persona:state", { id: "p1", state: "busy", activePrompt: "d:1" });
  off();
  last().event("persona:state", { id: "p1", state: "ready", activePrompt: null });
  expect(seen).toEqual([{ id: "p1", state: "busy", activePrompt: "d:1" }]);
  api.close();
});

test("reconnects with backoff from 0.5 s doubling to 5 s, and reports each reopen", async () => {
  const api = connect("/ws", { createSocket });
  const statuses: string[] = [];
  api.onStatus((status) => statuses.push(status));
  let reconnects = 0;
  api.onReconnect(() => { reconnects += 1; });
  last().open();
  expect(reconnects).toBe(0);

  const delays: number[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = sockets.length;
    last().drop();
    let waited = 0;
    while (sockets.length === before) { await vi.advanceTimersByTimeAsync(100); waited += 100; }
    delays.push(waited);
  }
  expect(delays).toEqual([500, 1000, 2000, 4000, 5000, 5000]);

  last().open();
  expect(reconnects).toBe(1);
  expect(api.status()).toBe("open");
  expect(statuses.slice(0, 4)).toEqual(["open", "closed", "connecting", "closed"]);

  // A successful open resets the backoff.
  const before = sockets.length;
  last().drop();
  await vi.advanceTimersByTimeAsync(500);
  expect(sockets.length).toBe(before + 1);
  api.close();
});

test("a request made while closed waits for the reconnect and is then sent", async () => {
  const api = connect("/ws", { createSocket });
  last().open();
  last().drop();
  const pending = api.request("workers:list", { personaId: "p1" });
  await vi.advanceTimersByTimeAsync(500);
  expect(last().sent).toEqual([]);
  last().open();
  expect(last().sent[0]).toMatchObject({ verb: "workers:list", args: { personaId: "p1" } });
  last().reply(last().sent[0]!.id, []);
  await expect(pending).resolves.toEqual([]);
  api.close();
});

test("a request waiting more than 30 s rejects with the lost-connection sentence", async () => {
  const api = connect("/ws", { createSocket });
  const pending = api.request("personas:list", {});
  const settled = expect(pending).rejects.toThrow(LOST_CONNECTION);
  await vi.advanceTimersByTimeAsync(29_999);
  await vi.advanceTimersByTimeAsync(1);
  await settled;
  expect(LOST_CONNECTION).toBe("Lost the connection to Personas.");
  api.close();
});

test("a request in flight when the socket drops is rejected, never resent", async () => {
  const api = connect("/ws", { createSocket });
  last().open();
  const first = last();
  const pending = api.request("persona:send", { id: "p1", message: { jsonrpc: "2.0", method: "session/cancel", params: {} } });
  first.drop();
  await expect(pending).rejects.toThrow(LOST_CONNECTION);
  await vi.advanceTimersByTimeAsync(500);
  last().open();
  expect(last().sent).toEqual([]);
  api.close();
});
