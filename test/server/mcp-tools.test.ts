import { describe, expect, test } from "vitest";
import { McpTools, type WorkerOps } from "../../src/server/mcp/tools";
import { dispatchMcp } from "../../src/server/mcp/protocol";
import { UserFacingError } from "../../src/server/errors";
import type { AgentReport, RepoEntry, Worker } from "../../src/shared/types";

function worker(id: string, personaId: string): Worker {
  return {
    id, personaId, harness: "claude", cwd: "/repos/a", title: "Fix it", sessionId: null, launchId: `l-${id}`,
    pid: 10, cmdline: "claude", state: "running", createdAt: "2026-10-03T00:00:00.000Z", lastReportId: null,
  };
}

const REPORT: AgentReport = {
  reportId: "w-1:a.json", personaId: "p-1", agentId: "w-1", kind: "ended", text: "Done.", messageUnavailable: false,
  title: "Fix it", cwd: "/repos/a", at: "2026-10-03T00:01:00.000Z",
};

function setup() {
  const events: string[] = [];
  const workers = [worker("w-1", "p-1"), worker("w-2", "p-2")];
  const ops: WorkerOps = {
    spawn: async (personaId, args) => { events.push(`spawn ${personaId} ${JSON.stringify(args)}`); return { agentId: "w-3", status: "accepted" }; },
    list: (personaId) => { events.push(`list ${personaId}`); return workers.filter((w) => w.personaId === personaId); },
    latestReport: (agentId) => (agentId === "w-1" ? REPORT : null),
    send: async (personaId, agentId, prompt) => { events.push(`send ${personaId} ${agentId} ${prompt}`); return { status: "accepted" }; },
    stop: async (personaId, agentId) => { events.push(`stop ${personaId} ${agentId}`); return { status: "stopped" }; },
  };
  const repos: RepoEntry[] = [{ path: "/repos/a", name: "a", known: true }];
  const tools = new McpTools({
    workers: ops,
    repos: async (personaId) => { events.push(`repos ${personaId}`); return repos; },
    ack: async (personaId, ids) => { events.push(`ack ${personaId} ${ids.join(",")}`); },
  });
  return { tools, events, repos, ops };
}

describe("McpTools", () => {
  test("tools/list names exactly the six tools, each accepting an optional ack", async () => {
    const { tools } = setup();
    const r = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      list: () => tools.list(), call: (name, args) => tools.call("p-1", name, args),
    });
    const listed = (r.body as any).result.tools as Array<{ name: string; description: string; inputSchema: any }>;
    expect(listed.map((t) => t.name)).toEqual(["list_repos", "spawn_agent", "list_agents", "check_agent", "send_to_agent", "stop_agent"]);
    for (const tool of listed) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.description).not.toMatch(/operationId/);
      expect(tool.inputSchema.properties.ack).toEqual(expect.objectContaining({ type: "array", items: { type: "string" } }));
      expect(tool.inputSchema.required ?? []).not.toContain("ack");
    }
    const spawn = listed.find((t) => t.name === "spawn_agent")!;
    expect(spawn.inputSchema.required).toEqual(["harness", "cwd"]);
    expect(spawn.inputSchema.properties.harness.enum).toEqual(["claude", "codex"]);
    expect(spawn.description).toMatch(/retr/i);
  });

  test("list_repos answers the persona's repositories", async () => {
    const { tools, events, repos } = setup();
    expect(await tools.call("p-1", "list_repos", {})).toEqual({ repos });
    expect(events).toEqual(["repos p-1"]);
  });

  test("spawn_agent refuses opencode with the opencode sentence", async () => {
    const { tools, events } = setup();
    await expect(tools.call("p-1", "spawn_agent", { harness: "opencode", cwd: "/repos/a" }))
      .rejects.toThrow("opencode cannot be a worker: it runs no hook to report through.");
    expect(events).toEqual([]);
  });

  test("spawn_agent refuses a relative or missing cwd", async () => {
    const { tools, events } = setup();
    for (const cwd of ["repos/a", "./a", "", undefined]) {
      await expect(tools.call("p-1", "spawn_agent", { harness: "claude", cwd }))
        .rejects.toThrow("cwd must be an absolute path inside a git checkout.");
    }
    expect(events).toEqual([]);
  });

  test("spawn_agent passes the persona and arguments to the workers", async () => {
    const { tools, events } = setup();
    expect(await tools.call("p-1", "spawn_agent", { harness: "codex", cwd: "/repos/a", prompt: "Go" }))
      .toEqual({ agentId: "w-3", status: "accepted" });
    expect(events).toEqual([`spawn p-1 ${JSON.stringify({ harness: "codex", cwd: "/repos/a", prompt: "Go" })}`]);
  });

  test("ack on any tool acknowledges before running it", async () => {
    for (const [name, args] of [
      ["list_repos", {}], ["list_agents", {}], ["check_agent", { agentId: "w-1" }],
      ["spawn_agent", { harness: "claude", cwd: "/repos/a" }], ["send_to_agent", { agentId: "w-1", prompt: "more" }],
      ["stop_agent", { agentId: "w-1" }],
    ] as const) {
      const { tools, events } = setup();
      await tools.call("p-1", name, { ...args, ack: ["r-1", "r-2"] });
      expect(events[0]).toBe("ack p-1 r-1,r-2");
      expect(events.length).toBeGreaterThan(1);
    }
  });

  test("a malformed ack is refused before anything runs", async () => {
    const { tools, events } = setup();
    await expect(tools.call("p-1", "list_agents", { ack: "r-1" })).rejects.toThrow("ack must be an array of report ids.");
    await expect(tools.call("p-1", "list_agents", { ack: [1] })).rejects.toThrow("ack must be an array of report ids.");
    expect(events).toEqual([]);
  });

  test("list_agents and check_agent show the persona's own workers with their latest report", async () => {
    const { tools } = setup();
    const view = { id: "w-1", harness: "claude", cwd: "/repos/a", title: "Fix it", state: "running", latestReport: REPORT };
    expect(await tools.call("p-1", "list_agents", {})).toEqual({ agents: [view] });
    expect(await tools.call("p-1", "check_agent", { agentId: "w-1" })).toEqual(view);
  });

  test("check_agent, send_to_agent and stop_agent for another persona's worker answer No such agent.", async () => {
    const { tools, events } = setup();
    await expect(tools.call("p-1", "check_agent", { agentId: "w-2" })).rejects.toThrow("No such agent.");
    await expect(tools.call("p-1", "send_to_agent", { agentId: "w-2", prompt: "hi" })).rejects.toThrow("No such agent.");
    await expect(tools.call("p-1", "stop_agent", { agentId: "w-2" })).rejects.toThrow("No such agent.");
    await expect(tools.call("p-1", "check_agent", { agentId: "w-404" })).rejects.toThrow("No such agent.");
    expect(events.filter((e) => !e.startsWith("list "))).toEqual([]);
  });

  test("send_to_agent and stop_agent reach the persona's own worker", async () => {
    const { tools, events } = setup();
    expect(await tools.call("p-1", "send_to_agent", { agentId: "w-1", prompt: "more" })).toEqual({ status: "accepted" });
    expect(await tools.call("p-1", "stop_agent", { agentId: "w-1" })).toEqual({ status: "stopped" });
    expect(events.filter((e) => !e.startsWith("list "))).toEqual(["send p-1 w-1 more", "stop p-1 w-1"]);
  });

  test("send_to_agent refuses an empty prompt", async () => {
    const { tools } = setup();
    await expect(tools.call("p-1", "send_to_agent", { agentId: "w-1", prompt: "" })).rejects.toThrow("prompt must be a non-empty string.");
  });

  test("a dependency failure naming a state path reaches the persona as the generic sentence", async () => {
    const leak = new Error("EACCES: permission denied, open '/state/cube-personas/reports/p-1.json'");
    const tools = new McpTools({
      workers: setup().ops,
      repos: async () => { throw leak; },
      ack: async () => { throw leak; },
    });
    for (const args of [{}, { ack: ["r-1"] }]) {
      const seen: unknown[] = [];
      const r = await dispatchMcp(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_repos", arguments: args } },
        { list: () => tools.list(), call: (name, a) => tools.call("p-1", name, a) },
        (error) => { seen.push(error); },
      );
      expect((r.body as any).result).toEqual({ content: [{ type: "text", text: "That did not work. Try again." }], isError: true });
      expect(seen).toEqual([leak]);
    }
  });

  test("this layer's own refusals are UserFacingErrors", async () => {
    const { tools } = setup();
    await expect(tools.call("p-1", "nope", {})).rejects.toBeInstanceOf(UserFacingError);
    await expect(tools.call("p-1", "check_agent", { agentId: "w-2" })).rejects.toBeInstanceOf(UserFacingError);
    await expect(tools.call("p-1", "spawn_agent", { harness: "opencode", cwd: "/a" })).rejects.toBeInstanceOf(UserFacingError);
    await expect(tools.call("p-1", "spawn_agent", { harness: "claude", cwd: "a" })).rejects.toBeInstanceOf(UserFacingError);
  });

  test("an unknown tool is an MCP error result naming it", async () => {
    const { tools, events } = setup();
    const r = await dispatchMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "answer_permission", arguments: { ack: ["r-1"] } } },
      { list: () => tools.list(), call: (name, args) => tools.call("p-1", name, args) },
    );
    expect((r.body as any).result).toEqual({ content: [{ type: "text", text: "Unknown tool answer_permission." }], isError: true });
    expect(events).toEqual([]);
  });
});
