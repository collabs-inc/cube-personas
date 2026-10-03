// Adapted from cube-computer: src/main/cubed/acp/fake-agent.mjs
//
// A scripted ACP agent, for tests only. Real adapters (claude, codex,
// opencode) never asked for `fs/read_text_file` or emitted
// `session/request_permission` in the recorded sessions
// (test/web/agent/fixtures) — they narrate
// their own reads as `session/update` tool calls — so this is the ONLY
// thing that exercises the server's client-method and human-permission
// paths. It is therefore written to the ACP shapes rather than to
// whatever the server happens to accept.
//
// Contract: one JSON-RPC message per line on stdout, nothing else ever;
// every request it makes of the client carries an `"a:<n>"` id (its own
// namespace, distinct from the server's `"d:<n>"` and a page's
// `"<uuid>:<n>"`); it exits when stdin closes.
//
// Prompts it understands, by the leading text of the first text block that
// is not a carried-reports block:
//   read:<path>      fs/read_text_file, then echo the content as a chunk
//   ask:<title>      session/request_permission (allow|deny), then name the pick
//   run:<shell>      terminal/create + wait_for_exit + output + release
//   title:<text>     a session_info_update notification
//   edit:<p>,<p>...  one edit tool call over those paths, reported in partial
//                    updates, completed, then its completion sent again
//   mcp:<tool> <json> call the session's first HTTP MCP server, then echo the result
//   crash:<text>     write <text> to stderr and exit with code 3
//   env:<NAME>       echo that environment variable as a chunk
//   mcp-config       echo the session's HTTP MCP server config as JSON
// Anything else answers `end_turn` and says nothing.
//
// `session/load` replays the conversation's history the way real adapters
// do, before replying: one `session/update` per line of
// `<cwd>/.fake-agent-replay.jsonl`, each line an `update` object.
//
// `FAKE_AGENT_NO_HTTP_MCP=1` makes `initialize` advertise no HTTP MCP support;
// `FAKE_AGENT_REJECT_MODE=1` makes `session/set_mode` answer an error.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

let nextId = 1;
/** Ids of requests this agent has sent, awaiting the client's response. */
const pending = new Map();
/** First HTTP MCP server configured for each created or loaded session. */
const mcpServers = new Map();
/** Last requested mode per session, exposed through ACP current_mode_update. */
const sessionModes = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

/** Sends a request and resolves with the whole response object. */
function ask(method, params, id = `a:${nextId++}`) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function chunk(sessionId, text) {
  notify("session/update", {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
}

/**
 * The prompt's own text. The block the server appends to carry queued
 * worker reports (tagged `_meta.cube.carriedReports`) is context, not the
 * command, so it is skipped.
 */
function promptText(params) {
  const blocks = Array.isArray(params?.prompt) ? params.prompt : [];
  return blocks
    .filter((b) => b && b.type === "text" && !b._meta?.cube?.carriedReports)
    .map((b) => String(b.text ?? ""))
    .join("");
}

async function handlePrompt(msg) {
  const sessionId = msg.params?.sessionId;
  const text = promptText(msg.params);

  // Durable conversation fixture for full-process cold recovery tests.
  if (text.startsWith("remember:")) {
    writeFileSync(".fake-acp-fact.json", JSON.stringify({ sessionId, fact: text.slice(9) }));
    reply(msg.id, { stopReason: "end_turn" });
    return;
  }
  if (text === "recall") {
    const saved = JSON.parse(readFileSync(".fake-acp-fact.json", "utf8"));
    chunk(sessionId, saved.sessionId === sessionId ? saved.fact : "wrong-conversation");
    reply(msg.id, { stopReason: "end_turn" });
    return;
  }

  if (text === "mcp-config") {
    chunk(sessionId, JSON.stringify(mcpServers.get(sessionId) ?? null));
    reply(msg.id, { stopReason: "end_turn" });
    return;
  }

  if (text.startsWith("env:")) {
    chunk(sessionId, process.env[text.slice("env:".length)] ?? "");
    reply(msg.id, { stopReason: "end_turn" });
    return;
  }

  if (text.startsWith("crash:")) {
    process.stderr.write(`${text.slice("crash:".length)}\n`, () => process.exit(3));
    return;
  }

  if (text.startsWith("mcp:")) {
    try {
      const server = mcpServers.get(sessionId);
      if (!server) throw new Error("no HTTP MCP server configured");
      const match = /^mcp:(\S+)\s+([\s\S]+)$/.exec(text);
      if (!match) throw new Error("expected mcp:<toolName> <json-arguments>");
      const args = JSON.parse(match[2]);
      const headers = new Headers((server.headers ?? []).map(({ name, value }) => [name, value]));
      headers.set("content-type", "application/json");
      const response = await fetch(server.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0", id: `a:${nextId++}`, method: "tools/call",
          params: { name: match[1], arguments: args },
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const res = await response.json();
      const content = Array.isArray(res?.result?.content) ? res.result.content : [];
      const texts = content.filter((b) => b?.type === "text" && typeof b.text === "string");
      chunk(sessionId, texts.length ? texts.map((b) => b.text).join("\n") : JSON.stringify(res));
    } catch (error) {
      chunk(sessionId, `error:MCP ${error.message ?? String(error)}`);
    }
    reply(msg.id, { stopReason: "end_turn" });
    return;
  }

  if (text.startsWith("read:")) {
    const res = await ask("fs/read_text_file", { sessionId, path: text.slice("read:".length) });
    chunk(sessionId, res.result ? String(res.result.content) : `error:${res.error?.message ?? "?"}`);
    reply(msg.id, { stopReason: "end_turn" });
    return;
  }

  if (text.startsWith("ask:") || text.startsWith("ask-id:")) {
    const explicitId = text.startsWith("ask-id:") ? JSON.parse(text.slice("ask-id:".length)) : undefined;
    const res = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "call-1", title: text.slice("ask:".length), kind: "execute", status: "pending" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    }, explicitId);
    const outcome = res.result?.outcome;
    chunk(sessionId, `chose:${outcome?.outcome === "selected" ? outcome.optionId : "cancelled"}`);
    reply(msg.id, { stopReason: "end_turn" });
    return;
  }

  if (text.startsWith("run:")) {
    const created = await ask("terminal/create", {
      sessionId,
      command: "sh",
      args: ["-c", text.slice("run:".length)],
    });
    const terminalId = created.result?.terminalId;
    if (terminalId === undefined) {
      chunk(sessionId, `error:${created.error?.message ?? "no terminalId"}`);
      reply(msg.id, { stopReason: "end_turn" });
      return;
    }
    await ask("terminal/wait_for_exit", { sessionId, terminalId });
    const out = await ask("terminal/output", { sessionId, terminalId });
    chunk(sessionId, `output:${out.result?.output ?? ""}`);
    await ask("terminal/release", { sessionId, terminalId });
    reply(msg.id, { stopReason: "end_turn" });
    return;
  }

  if (text.startsWith("edit:")) {
    const [first, ...rest] = text.slice("edit:".length).split(",");
    const toolCallId = `edit-${nextId++}`;
    const update = (fields) =>
      notify("session/update", { sessionId, update: { toolCallId, ...fields } });
    update({
      sessionUpdate: "tool_call", title: "Edit", kind: "edit", status: "pending",
      locations: [{ path: first }],
    });
    update({ sessionUpdate: "tool_call_update", locations: rest.map((path) => ({ path })) });
    update({ sessionUpdate: "tool_call_update", status: "completed" });
    update({ sessionUpdate: "tool_call_update", status: "completed" });
    reply(msg.id, { stopReason: "end_turn" });
    return;
  }

  if (text.startsWith("title:")) {
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "session_info_update", title: text.slice("title:".length) },
    });
    reply(msg.id, { stopReason: "end_turn" });
    return;
  }

  reply(msg.id, { stopReason: "end_turn" });
}

function replayHistory(sessionId, cwd) {
  const file = typeof cwd === "string" ? join(cwd, ".fake-agent-replay.jsonl") : null;
  if (file === null || !existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() !== "") notify("session/update", { sessionId, update: JSON.parse(line) });
  }
}

function handle(msg) {
  // A response to something this agent asked for.
  if (msg.method === undefined && msg.id !== undefined) {
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
    return;
  }
  switch (msg.method) {
    case "initialize":
      reply(msg.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: process.env.FAKE_AGENT_NO_HTTP_MCP !== "1" } },
      });
      return;
    case "session/new":
      mcpServers.set("fake-session-1", msg.params?.mcpServers?.find((s) => s.type === "http"));
      reply(msg.id, { sessionId: "fake-session-1" });
      return;
    case "session/load":
      replayHistory(msg.params?.sessionId, msg.params?.cwd);
      mcpServers.set(msg.params?.sessionId, msg.params?.mcpServers?.find((s) => s.type === "http"));
      reply(msg.id, { sessionId: msg.params?.sessionId });
      return;
    case "session/set_mode":
      if (process.env.FAKE_AGENT_REJECT_MODE === "1") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown mode" } });
        return;
      }
      // The scripted adapter accepts any mode; it has no permission policy
      // of its own. Keep the requested mode observable on the protocol stream.
      sessionModes.set(msg.params?.sessionId, msg.params?.modeId);
      notify("session/update", {
        sessionId: msg.params?.sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: sessionModes.get(msg.params?.sessionId) },
      });
      reply(msg.id, {});
      return;
    case "session/prompt":
      void handlePrompt(msg);
      return;
    default:
      // Notifications and anything unrecognized: silence, by design.
      return;
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    // Never echo malformed input to stdout — stdout is protocol only.
    process.stderr.write(`fake-agent: unparseable line: ${line.slice(0, 200)}\n`);
    return;
  }
  handle(msg);
});
rl.on("close", () => process.exit(0));
