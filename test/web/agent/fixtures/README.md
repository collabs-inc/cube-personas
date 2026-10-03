<!-- Adapted from cube-computer: src/main/cubed/acp/fixtures/README.md -->
# Recorded ACP sessions

Real ACP sessions recorded against three adapters, used by `test/web/agent/transcript.test.ts` to check that the conversation reducer folds what real adapters send:

- `claude.ndjson`: `@agentclientprotocol/claude-agent-acp` 0.74.0
- `codex.ndjson`: `@agentclientprotocol/codex-acp` 1.10.0
- `opencode.ndjson`: `opencode acp` 1.18.26

## Format

One line per message, prefixed with its direction: `in ` is what the recording driver wrote to the adapter's stdin, `out ` is what the adapter wrote to its stdout. Every `in` and `out` line is exactly one JSON-RPC message. A few `meta ` lines (the driver's own notes: the working directory, a process exit) and `err ` lines (the adapter's stderr) are kept for context; the reducer test skips both.

## What each session does

Each adapter ran in a fresh temporary directory holding one `hello.txt` ("The first line is the password." / "Second line is filler."). The driver sent `initialize` (protocol version 1, with `fs` and `terminal` client capabilities), `session/new`, and one `session/prompt` asking the agent to read `hello.txt` and reply with its first line. Then, in a second process of the same adapter, it sent a fresh `initialize` and `session/load` of the first session's id.

The driver used plain integer request ids, not the `"d:<n>"` and `"<uuid>:<n>"` ids the app uses, so the reducer must key off message content rather than id shape.

## What they show

- All three adapters advertise `loadSession: true`, and all three replay a loaded session's history as `session/update` notifications sent before the `session/load` response.
- None of them asked the client to read a file (`fs/read_text_file`) or for permission (`session/request_permission`): each read `hello.txt` with its own tool and narrated it as a `tool_call` / `tool_call_update` pair with `kind: "read"`. Those paths are covered by the fake agent in `test/fixtures/fake-agent.mjs` instead.
- None of them sent a plan update for this prompt.
- Their `session/new` and `session/load` results carry much more than `sessionId` (modes, config options, models), differently per adapter; codex's `session/load` result has no `sessionId` at all. The server reads these results narrowly for that reason.
- codex sends an `_auth/status_update` notification, a method outside the ACP spec, which a client ignores.

## Trimming

The recordings were trimmed before being committed: slash-command lists, config-option pickers and model lists were cut to a few entries, and account details (the codex account object, usage quotas, rate-limit state) were removed. The `meta` lines that repeated a result already on its `out` line were dropped. Nothing else was changed.
