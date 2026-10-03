// The app put together. Start: load state → end what a previous run left
// running → listen → resume personas → resume workers → drain the spool.
// Close: refuse new spawns → stop the spool and delivery → end workers and
// personas together (rows kept, so the next start resumes them) → end
// anything else this run started → stop listening. The whole close is
// bounded (see STOP_CHILDREN_BOUND_MS).
//
// The listener opens before personas resume, not last: an adapter connects
// to its MCP server during its handshake (claude-agent-acp lists the tools
// then), so a persona resumed before the port answers would run without its
// tools. The page's socket is attached before the listener opens, so a
// page connecting during resume sees every state change.
import type http from "node:http";
import { homedir } from "node:os";
import type { AddressInfo } from "node:net";
import { allowedRoots, artifactHandler } from "./files";
import { acquireStateLock, type StateLock } from "./lock";
import { createHttpServer } from "./http";
import { mcpHandler } from "./mcp/http";
import { McpTools, type WorkerOps } from "./mcp/tools";
import { contextFolderOf, stateDir } from "./paths";
import { Personas, SHUTTING_DOWN } from "./personas";
import { ProcessManager } from "./processes";
import { listRepos } from "./repos";
import { Delivery } from "./reports/delivery";
import { ReportStore } from "./reports/store";
import { UserFacingError } from "./errors";
import { attachSocket } from "./socket";
import { assertPersonaId, StateStore } from "./state";
import { Spool } from "./workers/spool";
import { Workers } from "./workers/workers";

const DEFAULT_PORT = 4870;
/**
 * A shutdown is bounded as a whole, about 6.5 s at worst, so a supervisor's
 * stop grace is not outlived with children still running: workers and
 * adapters are stopped together (a 3 s TERM grace, then SIGKILL) within
 * STOP_CHILDREN_BOUND_MS, then anything left gets a short grace and SIGKILL
 * within FINAL_KILL_BOUND_MS.
 */
const STOP_CHILDREN_BOUND_MS = 4500;
const FINAL_KILL_BOUND_MS = 2000;
const FINAL_KILL_GRACE_MS = 500;

export interface AppServices {
  state: StateStore;
  processes: ProcessManager;
  personas: Personas;
  workers: Workers;
  reports: ReportStore;
  delivery: Delivery;
  server: http.Server;
  /** After a report is recorded or acknowledged, with its persona's id. */
  onReportsChanged(cb: (personaId: string) => void): void;
}

export interface App {
  port: number;
  close(): Promise<void>;
  /** The running pieces, for the socket routes and for tests. */
  services: AppServices;
}

/** `$PORT`, where 0 means any free port; 4870 when unset (development only). */
function portFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a port number, not "${raw}".`);
  return port;
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** `processes` lets the caller reach the children too (main's crash handler does); one is made when absent. */
export async function startApp(opts: { processes?: ProcessManager } = {}): Promise<App> {
  const env = process.env;
  const log = (line: string): void => console.warn(line);
  const requestedPort = portFromEnv(env);

  const processes = opts.processes ?? new ProcessManager();
  // Before anything reads the state: a second server on the same folder would reap the first's children.
  const lock = acquireStateLock(stateDir(), { cmdlineOf: (pid) => processes.cmdlineOf(pid) });
  const parts: Parts = {};
  try {
    return await assemble({ env, log, requestedPort, processes, lock, parts });
  } catch (err) {
    // A start that failed part-way still ends everything it spawned: no App exists for main to close.
    parts.personas?.beginShutdown();
    parts.spool?.stop();
    parts.delivery?.stop();
    await stopChildren(parts.workers, parts.personas, log);
    await boundedKillAll(processes, log);
    parts.closeSockets?.();
    if (parts.server?.listening) await closeServer(parts.server);
    lock.release();
    throw err;
  }
}

/** What a start has put together so far, for a failed start to take apart. */
interface Parts {
  personas?: Personas;
  workers?: Workers;
  delivery?: Delivery;
  spool?: Spool;
  server?: http.Server;
  closeSockets?: () => void;
}

/** Waits for `work`, but at most `ms`. */
async function bounded(work: Promise<unknown>, ms: number): Promise<void> {
  let bound: NodeJS.Timeout | undefined;
  await Promise.race([
    work,
    new Promise<void>((r) => {
      bound = setTimeout(r, ms);
    }),
  ]);
  clearTimeout(bound);
}

/**
 * Stops workers and adapters together, recording nothing: rows keep their
 * state so the next start resumes them. Both mark themselves closing before
 * they kill, so a worker or adapter ended by the kill below records no exit.
 */
async function stopChildren(workers: Workers | undefined, personas: Personas | undefined, log: (line: string) => void): Promise<void> {
  await bounded(Promise.all([
    workers?.close().catch((e) => log(`shutdown: stopping workers failed (${(e as Error).message})`)),
    personas?.close().catch((e) => log(`shutdown: stopping personas failed (${(e as Error).message})`)),
  ]), STOP_CHILDREN_BOUND_MS);
}

async function boundedKillAll(processes: ProcessManager, log: (line: string) => void): Promise<void> {
  await bounded(
    processes.killAll(FINAL_KILL_GRACE_MS).catch((err) => log(`shutdown: ending children failed (${(err as Error).message})`)),
    FINAL_KILL_BOUND_MS,
  );
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function assemble(ctx: {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  requestedPort: number;
  processes: ProcessManager;
  lock: StateLock;
  parts: Parts;
}): Promise<App> {
  const { env, log, requestedPort, processes, lock, parts } = ctx;
  const state = new StateStore(stateDir(), log);
  await state.load();

  // Before anything is resumed: a surviving orphan worker's hook would
  // otherwise be attributed to its relaunch (launch ids persist).
  const recorded = [...state.personas(), ...state.workers()]
    .filter((r): r is typeof r & { pid: number; cmdline: string } => r.pid !== null && r.cmdline !== null)
    .map((r) => ({ pid: r.pid, cmdline: r.cmdline }));
  const reaped = await processes.reapOrphans(recorded);
  if (reaped > 0) log(`Ended ${reaped} process${reaped === 1 ? "" : "es"} a previous run left running.`);

  const reports = new ReportStore(state.reportsDir(), log);
  await reports.load();
  let port = requestedPort;
  // `personas` is assigned below, before anything can call `sessionOf` or `personaAlive`.
  let personas!: Personas;
  const workers = new Workers({
    processes, state, env, latestReport: (id) => reports.latestFor(id), log,
    personaAlive: (id) => personas.exists(id) && !personas.isShuttingDown(),
  });
  parts.workers = workers;
  const delivery = new Delivery({
    reports,
    sessionOf: (id) => personas.sessionOf(id),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    log,
  });
  parts.delivery = delivery;
  personas = new Personas({ state, processes, workers, reports, delivery, env, port: () => port, log });
  parts.personas = personas;

  const reportsChangedListeners: Array<(personaId: string) => void> = [];
  const reportsChanged = (personaId: string): void => {
    for (const cb of reportsChangedListeners) {
      try {
        cb(personaId);
      } catch (err) {
        log(`a reports listener failed: ${String(err)}`);
      }
    }
  };
  // Registered before workers resume, whose interrupted reports arrive through it.
  // Bounded work: the report is stored durably, delivery is only nudged.
  workers.onReport(async (report) => {
    if (!personas.exists(report.personaId)) return;
    await reports.record(report);
    delivery.notify(report.personaId);
    reportsChanged(report.personaId);
  });

  const workerOps: WorkerOps = {
    spawn: (personaId, args) => {
      if (personas.isShuttingDown()) return Promise.reject(new UserFacingError(SHUTTING_DOWN));
      return workers.spawn(personaId, args);
    },
    list: (personaId) => workers.list(personaId),
    latestReport: (agentId) => workers.latestReport(agentId),
    send: (personaId, agentId, prompt) => workers.send(personaId, agentId, prompt),
    stop: (personaId, agentId) => workers.stop(personaId, agentId),
  };
  const tools = new McpTools({
    workers: workerOps,
    repos: (personaId) => {
      assertPersonaId(personaId);
      return listRepos(homedir(), contextFolderOf(personaId));
    },
    ack: async (personaId, ids) => {
      await reports.acknowledge(personaId, ids);
      delivery.notify(personaId);
      reportsChanged(personaId);
    },
  });
  const mcp = mcpHandler({ secret: state.secret(), currentLaunch: (id) => personas.currentLaunch(id), tools, log });
  const artifact = artifactHandler({
    exists: (id) => personas.exists(id),
    roots: (id) => allowedRoots(id, workers.list(id)),
  });
  const server = createHttpServer({ mcp, extra: [["GET", "/artifact", artifact]] });
  parts.server = server;
  const services: AppServices = {
    state, processes, personas, workers, reports, delivery, server,
    onReportsChanged: (cb) => { reportsChangedListeners.push(cb); },
  };
  const closeSockets = attachSocket(server, services);
  parts.closeSockets = closeSockets;
  port = await listen(server, requestedPort);

  await personas.resumeAll();
  // A claude worker resumed before claude wrote its session file has nothing
  // to resume: `claude --resume` exits and the worker ends `exited`. Accepted.
  await workers.resumeAll();
  // A fresh spool each start: one keeps the files a failed handler left until the next start.
  const spool = new Spool(state.spoolDir(), (launchId, payload, file) => workers.handleHookReport(launchId, payload, file), log);
  parts.spool = spool;
  spool.start();

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      personas.beginShutdown();
      spool.stop();
      delivery.stop();
      await stopChildren(workers, personas, log);
      await boundedKillAll(processes, log);
      closeSockets();
      await closeServer(server);
      lock.release();
    })();
    return closing;
  };

  return { port, close, services };
}
