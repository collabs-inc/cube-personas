// The page's one connection to the server: requests and events over `/ws`,
// in `wire.ts`'s framing.
//
// The socket comes back on its own when it drops, backing off from 0.5 s to
// 5 s. A request made while it is down waits for it (30 s at most). A request
// already in flight when it drops is failed, not resent: the server may have
// acted on it, and resending a prompt could send it twice. `onReconnect` is
// how a view learns that the events it missed in between must be read again.
import { decode, encode, type EventMap, type EventName, type Verb, type VerbArgs, type VerbResult } from "../shared/wire";

export type ApiStatus = "connecting" | "open" | "closed";

export interface Api {
  request<V extends Verb>(verb: V, args: VerbArgs<V>): Promise<VerbResult<V>>;
  on<E extends EventName>(name: E, cb: (payload: EventMap[E]) => void): () => void;
  status(): ApiStatus;
  onStatus(cb: (status: ApiStatus) => void): () => void;
  /** Every reopen after the first open. */
  onReconnect(cb: () => void): () => void;
  close(): void;
}

export const LOST_CONNECTION = "Lost the connection to Personas.";
export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 5000;
export const REQUEST_WAIT_MS = 30_000;

/** The subset of the browser's WebSocket this file uses, so a test can supply its own. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ConnectOptions {
  createSocket?: (url: string) => SocketLike;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

interface Waiting {
  send(): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;

function socketUrl(url: string): string {
  if (/^wss?:/i.test(url)) return url;
  const resolved = new URL(url, window.location.href);
  resolved.protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
  return resolved.toString();
}

export function connect(url = "/ws", options: ConnectOptions = {}): Api {
  const createSocket = options.createSocket ?? ((target: string) => new WebSocket(target) as unknown as SocketLike);
  const target = socketUrl(url);
  const listeners = new Map<EventName, Set<(payload: never) => void>>();
  const statusListeners = new Set<(status: ApiStatus) => void>();
  const reconnectListeners = new Set<() => void>();
  const pending = new Map<number, Pending>();
  const waiting = new Set<Waiting>();
  let nextId = 1;
  let current: ApiStatus = "connecting";
  let socket: SocketLike | null = null;
  let opened = false;
  let closedForGood = false;
  let backoff = RECONNECT_MIN_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (status: ApiStatus): void => {
    if (current === status) return;
    current = status;
    for (const cb of [...statusListeners]) cb(status);
  };

  const open = (): void => {
    retryTimer = null;
    setStatus("connecting");
    const ws = createSocket(target);
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      backoff = RECONNECT_MIN_MS;
      const again = opened;
      opened = true;
      setStatus("open");
      for (const entry of [...waiting]) {
        clearTimeout(entry.timer);
        waiting.delete(entry);
        entry.send();
      }
      if (again) for (const cb of [...reconnectListeners]) cb();
    };
    ws.onmessage = (event) => {
      if (socket !== ws || typeof event.data !== "string") return;
      const message = decode(event.data);
      if (message === null) return;
      if (message.t === "res") {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.ok) request.resolve(message.result);
        else request.reject(new Error(message.error));
      } else if (message.t === "evt") {
        for (const cb of [...(listeners.get(message.name) ?? [])]) (cb as (payload: unknown) => void)(message.payload);
      }
    };
    ws.onerror = () => { /* onclose follows and does the work */ };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      for (const request of pending.values()) request.reject(new Error(LOST_CONNECTION));
      pending.clear();
      setStatus("closed");
      if (closedForGood) return;
      retryTimer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    };
  };

  const send = (verb: Verb, args: unknown, entry: Pending): void => {
    const id = nextId++;
    pending.set(id, entry);
    try {
      socket!.send(encode({ t: "req", id, verb, args }));
    } catch {
      pending.delete(id);
      entry.reject(new Error(LOST_CONNECTION));
    }
  };

  open();

  return {
    request<V extends Verb>(verb: V, args: VerbArgs<V>): Promise<VerbResult<V>> {
      return new Promise<VerbResult<V>>((resolve, reject) => {
        const entry: Pending = { resolve: resolve as (value: unknown) => void, reject };
        if (closedForGood) { reject(new Error(LOST_CONNECTION)); return; }
        if (socket !== null && socket.readyState === OPEN && current === "open") { send(verb, args, entry); return; }
        const wait: Waiting = {
          send: () => send(verb, args, entry),
          reject,
          timer: setTimeout(() => {
            waiting.delete(wait);
            reject(new Error(LOST_CONNECTION));
          }, REQUEST_WAIT_MS),
        };
        waiting.add(wait);
      });
    },
    on(name, cb) {
      let set = listeners.get(name);
      if (!set) { set = new Set(); listeners.set(name, set); }
      set.add(cb as (payload: never) => void);
      return () => { set.delete(cb as (payload: never) => void); };
    },
    status: () => current,
    onStatus(cb) {
      statusListeners.add(cb);
      return () => { statusListeners.delete(cb); };
    },
    onReconnect(cb) {
      reconnectListeners.add(cb);
      return () => { reconnectListeners.delete(cb); };
    },
    close() {
      closedForGood = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      for (const entry of waiting) { clearTimeout(entry.timer); entry.reject(new Error(LOST_CONNECTION)); }
      waiting.clear();
      socket?.close();
    },
  };
}

let shared: Api | null = null;

/** The page's connection, opened on first use. */
export function getApi(): Api {
  shared ??= connect();
  return shared;
}

/** Replaces the page's connection — a test's fake, or null to open a fresh one on next use. */
export function setApi(api: Api | null): void {
  shared = api;
}
