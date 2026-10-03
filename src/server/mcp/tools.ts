// Adapted from cube-computer: src/main/cubed/mcp/tools.ts and src/main/cubed/ops/agent-ops.ts
//
// The six tools a persona calls through POST /mcp. Ownership is decided by
// the persona id the ticket authenticated, never by a caller argument: a
// worker that belongs to another persona is indistinguishable from one that
// does not exist. There is no operation id, so a retried spawn_agent can
// start a second worker. Any call may carry `ack` to acknowledge reports;
// it is applied before the tool runs.
import { isAbsolute } from "node:path";
import type { AgentReport, RepoEntry, Worker } from "../../shared/types";
import { UserFacingError } from "../errors";
import type { ToolDescriptor } from "./protocol";

export type { ToolDescriptor } from "./protocol";

export interface WorkerOps {
  spawn(personaId: string, args: { harness: string; cwd: string; prompt?: string }): Promise<{ agentId: string; status: "accepted" }>;
  list(personaId: string): Worker[];
  latestReport(agentId: string): AgentReport | null;
  send(personaId: string, agentId: string, prompt: string): Promise<{ status: "accepted" }>;
  stop(personaId: string, agentId: string): Promise<{ status: "stopped" }>;
}

export interface McpToolsDeps {
  workers: WorkerOps;
  repos: (personaId: string) => Promise<RepoEntry[]>;
  /** Acknowledges these report ids for the persona; ids that are not its own are its concern to ignore. */
  ack: (personaId: string, ids: string[]) => Promise<void>;
}

type Args = Record<string, unknown>;

interface Tool extends ToolDescriptor {
  run(personaId: string, args: Args): Promise<unknown>;
}

const WORKER_HARNESSES = new Set(["claude", "codex"]);

const ACK_PROPERTY = {
  type: "array", items: { type: "string" }, description: "Report ids you have received; stops their redelivery.",
};

function stringArg(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new UserFacingError(`${name} must be a non-empty string.`);
  return value;
}

function agentView(worker: Worker, report: AgentReport | null) {
  return { id: worker.id, harness: worker.harness, cwd: worker.cwd, title: worker.title, state: worker.state, latestReport: report };
}

export class McpTools {
  private readonly tools: Tool[];

  constructor(private readonly deps: McpToolsDeps) {
    const ownedWorker = (personaId: string, args: Args): Worker => {
      const id = stringArg(args, "agentId");
      const worker = deps.workers.list(personaId).find((w) => w.id === id && w.personaId === personaId);
      if (!worker) throw new UserFacingError("No such agent.");
      return worker;
    };
    const AGENT_ID = { agentId: { type: "string" } };
    this.tools = [
      {
        name: "list_repos",
        description: "The git repositories one level under ~/repos plus every repository in your context folder's "
          + "Repositories list, with absolute paths; known: true marks the ones on that list.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        run: async (personaId) => ({ repos: await deps.repos(personaId) }),
      },
      {
        name: "spawn_agent",
        description: "Spawn a worker in an absolute cwd inside a git checkout. The worker opens as a terminal running "
          + "the harness (claude or codex); supply a prompt to give it its objective on launch. Returns the worker's "
          + "id at once. A retried spawn_agent can start a second worker, so after a call that returned no answer, "
          + "check list_agents before trying again.",
        inputSchema: {
          type: "object",
          properties: { harness: { type: "string", enum: ["claude", "codex"] }, cwd: { type: "string" }, prompt: { type: "string" } },
          required: ["harness", "cwd"],
          additionalProperties: false,
        },
        run: async (personaId, args) => {
          const harness = args.harness;
          if (harness === "opencode") throw new UserFacingError("opencode cannot be a worker: it runs no hook to report through.");
          if (typeof harness !== "string" || !WORKER_HARNESSES.has(harness)) throw new UserFacingError('harness must be "claude" or "codex".');
          const cwd = args.cwd;
          if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new UserFacingError("cwd must be an absolute path inside a git checkout.");
          const prompt = args.prompt === undefined ? undefined : stringArg(args, "prompt");
          return deps.workers.spawn(personaId, { harness, cwd, ...(prompt === undefined ? {} : { prompt }) });
        },
      },
      {
        name: "list_agents",
        description: "The agents you have spawned, with their current state and latest report.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        run: async (personaId) => ({
          agents: deps.workers.list(personaId)
            .filter((w) => w.personaId === personaId)
            .map((w) => agentView(w, deps.workers.latestReport(w.id))),
        }),
      },
      {
        name: "check_agent",
        description: "Current state and latest report for one of your agents.",
        inputSchema: { type: "object", properties: AGENT_ID, required: ["agentId"], additionalProperties: false },
        run: async (personaId, args) => {
          const worker = ownedWorker(personaId, args);
          return agentView(worker, deps.workers.latestReport(worker.id));
        },
      },
      {
        name: "send_to_agent",
        description: "Send a follow-up prompt to a worker. It is typed into the worker's terminal, so acceptance "
          + "does not mean the worker was idle; prefer waiting for a report first.",
        inputSchema: {
          type: "object", properties: { ...AGENT_ID, prompt: { type: "string" } },
          required: ["agentId", "prompt"], additionalProperties: false,
        },
        run: async (personaId, args) => {
          const worker = ownedWorker(personaId, args);
          return deps.workers.send(personaId, worker.id, stringArg(args, "prompt"));
        },
      },
      {
        name: "stop_agent",
        description: "Stop a worker's running process. The worker stays listed.",
        inputSchema: { type: "object", properties: AGENT_ID, required: ["agentId"], additionalProperties: false },
        run: async (personaId, args) => deps.workers.stop(personaId, ownedWorker(personaId, args).id),
      },
    ];
  }

  list(): ToolDescriptor[] {
    return this.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema: {
        ...inputSchema,
        properties: { ...(inputSchema.properties as Record<string, unknown>), ack: ACK_PROPERTY },
      },
    }));
  }

  async call(personaId: string, name: string, args: unknown): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new UserFacingError(`Unknown tool ${name}.`);
    const { ack, ...request } = (typeof args === "object" && args !== null && !Array.isArray(args) ? args : {}) as Args;
    if (ack !== undefined) {
      if (!Array.isArray(ack) || !ack.every((id) => typeof id === "string")) throw new UserFacingError("ack must be an array of report ids.");
      await this.deps.ack(personaId, ack);
    }
    return tool.run(personaId, request);
  }
}
