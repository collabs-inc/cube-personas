// The browser's one connection: a WebSocket at /ws carrying requests and
// replies for every verb in wire.ts, and every event broadcast to every
// open socket — except `worker:output`, which goes only to the sockets
// attached to that worker (worker:attach until worker:detach). Arguments come from the page and are typed `unknown` until a
// handler has checked them; a bad one is answered with a sentence. A
// handler's failure reaches the page only as one plain sentence — a
// UserFacingError's, the session's own refusals the composer acts on, or a
// generic one (the real error is logged). What is sent never carries a
// command line (a worker's names the state directory), adapter stderr, a
// ticket or a secret.
import type http from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { BUSY_MARKER, MESSAGE_TOO_LARGE_PREFIX, type JsonRpcMessage } from "../shared/agent-protocol";
import type { Persona, Worker } from "../shared/types";
import { decode, encode, type EventMap, type EventName, type Verb, type VerbMap } from "../shared/wire";
import type { AppServices } from "./app";
import { readRepoBlockText, writeRepoBlockText } from "./context-folder";
import { GENERIC_FAILURE, NO_SUCH_PERSONA, UserFacingError } from "./errors";
import { allowedRoots, listFolder, readTextFile, TOO_BROAD_ROOT, tooBroadRoot } from "./files";
import { hostAllowed, originMatches } from "./http";
import { contextFolderOf } from "./paths";
import { workspaceOf } from "./workspace";

/** A prompt with an image is the largest frame the page sends; the session refuses lines over 1 MiB itself. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** A page this far behind on its socket is dropped; it reconnects and replays from what it holds. */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const MAX_NAME_BYTES = 4096;
const MAX_TERMINAL_SIZE = 1000;

const NO_SUCH_AGENT = "No such agent.";
const UNKNOWN_REQUEST = "Unknown request.";
const ABSOLUTE_LINES = "Each line must be an absolute path.";

type Args = Record<string, unknown>;
type Handlers = { [V in Verb]: (args: Args, ws: WebSocket) => Promise<VerbMap[V]["result"]> | VerbMap[V]["result"] };

/** Persona rows as the page sees them: no command line. */
const pagePersona = (p: Persona): Persona => ({ ...p, cmdline: null });
/** Worker rows as the page sees them: no command line (a worker's names the state directory). */
const pageWorker = (w: Worker): Worker => ({ ...w, cmdline: null });

function bad(what: string): UserFacingError {
  return new UserFacingError(`That request needs ${what}.`);
}

function text(args: Args, key: string, what: string): string {
  const value = args[key];
  if (typeof value !== "string") throw bad(what);
  return value;
}

/** Returns a closer that ends every open socket (the HTTP server cannot close while one is open). */
export function attachSocket(server: http.Server, app: AppServices): () => void {
  const { personas, workers, state } = app;
  const log = (line: string): void => console.warn(line);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  /** Per socket: the workers it is attached to, counted (one page may show a worker twice). */
  const attached = new WeakMap<WebSocket, Map<string, number>>();
  const attachedTo = (ws: WebSocket, workerId: string): boolean => (attached.get(ws)?.get(workerId) ?? 0) > 0;

  const broadcast = <E extends EventName>(name: E, payload: EventMap[E], to: (ws: WebSocket) => boolean = () => true): void => {
    if (wss.clients.size === 0) return;
    const frame = encode({ t: "evt", name, payload });
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN || !to(ws)) continue;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        log("socket: a page fell too far behind and was disconnected");
        ws.terminate();
        continue;
      }
      ws.send(frame);
    }
  };

  // --- arguments -----------------------------------------------------------

  const personaId = (args: Args, key = "personaId"): string => {
    const id = args[key];
    if (typeof id !== "string" || !personas.exists(id)) throw new UserFacingError(NO_SUCH_PERSONA);
    return id;
  };
  const workerRow = (args: Args): Worker => {
    const id = args.id;
    const row = typeof id === "string" ? state.workers().find((w) => w.id === id) : undefined;
    if (!row || !personas.exists(row.personaId)) throw new UserFacingError(NO_SUCH_AGENT);
    return row;
  };
  const rootsOf = (id: string): Promise<string[]> => allowedRoots(id, workers.list(id));

  // --- one handler per verb --------------------------------------------------

  const handlers: Handlers = {
    "personas:list": () => personas.list().map(pagePersona),
    "persona:create": async (args) => {
      const harness = args.harness;
      if (harness !== "claude" && harness !== "codex") throw new UserFacingError('harness must be "claude" or "codex".');
      return pagePersona(await personas.create(harness));
    },
    "persona:rename": async (args) => {
      const name = text(args, "name", "a name");
      if (Buffer.byteLength(name) > MAX_NAME_BYTES) throw new UserFacingError("That name is too long.");
      await personas.rename(text(args, "id", "a persona id"), name);
      return null;
    },
    "persona:delete": (args) => personas.delete(text(args, "id", "a persona id")),
    "persona:open": (args) => {
      const sinceSeq = args.sinceSeq;
      if (sinceSeq !== undefined && (typeof sinceSeq !== "number" || !Number.isInteger(sinceSeq) || sinceSeq < 0)) {
        throw bad("a whole number sinceSeq");
      }
      return personas.open(text(args, "id", "a persona id"), sinceSeq);
    },
    "persona:send": async (args) => {
      const id = text(args, "id", "a persona id");
      const message = args.message;
      if (typeof message !== "object" || message === null || Array.isArray(message)) throw bad("a message");
      await personas.send(id, message as JsonRpcMessage);
      return null;
    },
    "persona:restart": async (args) => {
      await personas.restart(text(args, "id", "a persona id"));
      return null;
    },
    "persona:mark-read": async (args) => {
      await personas.markRead(text(args, "id", "a persona id"));
      return null;
    },
    "workers:list": (args) => workers.list(personaId(args)).map(pageWorker),
    // Synchronous, and answered in the same tick (see dispatch below): the
    // page drops `worker:output` while its attach is in flight, so no output
    // may land between reading the scrollback and sending the reply.
    "worker:attach": (args, ws) => {
      const id = workerRow(args).id;
      const result = workers.attach(id);
      const counts = attached.get(ws) ?? new Map<string, number>();
      counts.set(id, (counts.get(id) ?? 0) + 1);
      attached.set(ws, counts);
      return result;
    },
    "worker:detach": (args, ws) => {
      const id = args.id;
      const counts = attached.get(ws);
      if (typeof id === "string" && counts?.has(id)) {
        const left = counts.get(id)! - 1;
        if (left > 0) counts.set(id, left);
        else counts.delete(id);
      }
      return null;
    },
    "worker:input": (args) => {
      const row = workerRow(args);
      workers.input(row.id, text(args, "data", "the typed data"));
      return null;
    },
    "worker:resize": (args) => {
      const row = workerRow(args);
      const { cols, rows } = args;
      const fits = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_TERMINAL_SIZE;
      if (!fits(cols) || !fits(rows)) throw bad("a terminal size");
      workers.resize(row.id, cols, rows);
      return null;
    },
    "worker:stop": async (args) => {
      const row = workerRow(args);
      await workers.stop(row.personaId, row.id);
      return null;
    },
    "workspace:get": async (args) => {
      const id = personaId(args);
      const tree = await workspaceOf(id, workers.list(id), (agentId) => workers.latestReport(agentId));
      for (const repo of tree.repos) for (const checkout of repo.checkouts) checkout.workers = checkout.workers.map(pageWorker);
      return tree;
    },
    "repos:get": async (args) => ({ text: await readRepoBlockText(contextFolderOf(personaId(args))) }),
    "repos:set": async (args) => {
      const id = personaId(args);
      const value = text(args, "text", "the list as text");
      const lines = value.split(/\r\n|\r|\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.some((line) => !line.startsWith("/"))) throw new UserFacingError(ABSOLUTE_LINES);
      if (lines.some(tooBroadRoot)) throw new UserFacingError(TOO_BROAD_ROOT);
      await writeRepoBlockText(contextFolderOf(id), value);
      return null;
    },
    "files:list": async (args) => {
      const id = personaId(args);
      return listFolder(args.path, await rootsOf(id));
    },
    "files:read": async (args) => {
      const id = personaId(args);
      return readTextFile(args.path, await rootsOf(id));
    },
  };

  /** One sentence for the page; anything not meant for it is logged and replaced. */
  const sentenceOf = (verb: string, err: unknown): string => {
    if (err instanceof UserFacingError) return err.message;
    const message = err instanceof Error ? err.message : String(err);
    // The session's own refusals, written for the page: the composer queues on busy.
    if (message.startsWith(BUSY_MARKER) || message.startsWith(MESSAGE_TOO_LARGE_PREFIX) || message.startsWith("The page cannot ")) {
      return message;
    }
    log(`socket: ${verb} failed: ${err instanceof Error ? (err.stack ?? message) : message}`);
    return GENERIC_FAILURE;
  };

  // --- connections -------------------------------------------------------------

  wss.on("connection", (ws: WebSocket) => {
    let warned = false;
    const malformed = (): void => {
      if (warned) return;
      warned = true;
      log("socket: ignored a malformed frame from a page (further ones on this connection are not logged)");
    };
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return malformed();
      const raw = data.toString();
      const msg = decode(raw);
      if (msg === null) {
        // A request naming a verb this server does not have still gets an answer.
        const id = requestIdOf(raw);
        if (id === null) return malformed();
        return reply(ws, { t: "res", id, ok: false, error: UNKNOWN_REQUEST });
      }
      if (msg.t !== "req") return malformed();
      const args: Args = typeof msg.args === "object" && msg.args !== null && !Array.isArray(msg.args) ? (msg.args as Args) : {};
      const handler = handlers[msg.verb] as (args: Args, ws: WebSocket) => unknown;
      const answer = (value: unknown): void => reply(ws, { t: "res", id: msg.id, ok: true, result: value ?? null });
      const refuse = (err: unknown): void => reply(ws, { t: "res", id: msg.id, ok: false, error: sentenceOf(msg.verb, err) });
      let result: unknown;
      try {
        result = handler(args, ws);
      } catch (err) {
        return refuse(err);
      }
      // A synchronous handler is answered at once, ahead of any event its
      // own work may cause next (worker:attach depends on it).
      if (result instanceof Promise) result.then(answer, refuse);
      else answer(result);
    });
    ws.on("error", (err) => log(`socket: a page's connection failed (${err.message})`));
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    // Without these any page the person visits could drive the personas:
    // the Host must be an allowed address (DNS rebinding) and a browser's
    // Origin must name that same Host (cross-site; an artifact's sandboxed
    // frame sends "null").
    if (pathname !== "/ws" || !hostAllowed(req.headers.host) || !originMatches(req.headers.origin, req.headers.host)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  // --- events ------------------------------------------------------------------

  personas.onChange((list) => {
    broadcast("personas:changed", { personas: list.map(pagePersona) });
    scheduleWorkers();
  });
  personas.onFrame((id, record) => broadcast("persona:frame", { id, record }));
  personas.onState((id, personaState, activePrompt) => broadcast("persona:state", { id, state: personaState, activePrompt }));
  workers.onOutput((id, data) => broadcast("worker:output", { id, data }, (ws) => attachedTo(ws, id)));
  workers.onChange(() => scheduleWorkers());
  app.onReportsChanged((id) => broadcast("reports:changed", { personaId: id }));

  // Worker rows change often (a pid, then a command line the page never
  // sees): changes are gathered per tick and a persona's list is sent only
  // when what the page would see differs. A worker newly `exited` also
  // gets `worker:exit`.
  const sentLists = new Map<string, string>();
  const knownStates = new Map<string, Worker["state"]>();
  const snapshot = (): Map<string, Worker[]> => {
    const byPersona = new Map<string, Worker[]>();
    for (const p of personas.list()) byPersona.set(p.id, []);
    for (const w of state.workers()) byPersona.get(w.personaId)?.push(pageWorker(w));
    return byPersona;
  };
  for (const [id, list] of snapshot()) {
    sentLists.set(id, JSON.stringify(list));
    for (const w of list) knownStates.set(w.id, w.state);
  }
  let scheduled = false;
  function scheduleWorkers(): void {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      const current = snapshot();
      for (const [id, list] of current) {
        const json = JSON.stringify(list);
        if (sentLists.get(id) !== json) {
          sentLists.set(id, json);
          broadcast("workers:changed", { personaId: id, workers: list });
        }
        for (const w of list) {
          const before = knownStates.get(w.id);
          knownStates.set(w.id, w.state);
          if (w.state === "exited" && before !== "exited") {
            broadcast("worker:exit", { id: w.id, exitCode: w.exitCode ?? null });
          }
        }
      }
      for (const id of [...sentLists.keys()]) if (!current.has(id)) sentLists.delete(id);
      const present = new Set([...current.values()].flat().map((w) => w.id));
      for (const id of [...knownStates.keys()]) if (!present.has(id)) knownStates.delete(id);
    });
  }

  return () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}

function reply(ws: WebSocket, msg: Parameters<typeof encode>[0]): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
}

/** The id of a frame shaped like a request, even one decode refused. */
function requestIdOf(raw: string): number | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const o = value as Record<string, unknown>;
    return o.t === "req" && typeof o.id === "number" ? o.id : null;
  } catch {
    return null;
  }
}
